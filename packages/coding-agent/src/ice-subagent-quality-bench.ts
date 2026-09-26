import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { redactCredentialText } from "./utils/redact.ts";

/**
 * Deterministic scoring library for the ICE subagent quality benchmark. The
 * module performs no provider calls: run records are measured and aggregated
 * from observed, untrusted inputs, and every rendered artifact is redacted.
 * Fixture corpora are non-secret by construction.
 */

export type QualityCaseClass =
	| "focused_lookup"
	| "cross_file_reasoning"
	| "bug_localization"
	| "review_precision"
	| "implement_verify"
	| "partial_context_recovery"
	| "long_investigation"
	| "batch_coverage"
	| "conflicting_evidence"
	| "insufficient_evidence";

const QUALITY_CASE_CLASSES: readonly QualityCaseClass[] = [
	"focused_lookup",
	"cross_file_reasoning",
	"bug_localization",
	"review_precision",
	"implement_verify",
	"partial_context_recovery",
	"long_investigation",
	"batch_coverage",
	"conflicting_evidence",
	"insufficient_evidence",
];

export interface QualityAcceptanceCriterion {
	id: string;
	requirement: string;
}

export interface QualityCaseExpectedOutcome {
	/** Deterministic checks a correct run must satisfy, in fixture-author order. */
	checks: readonly string[];
	/** Acceptance-criterion ids that a successful run must pass. */
	requiredCriterionIds: readonly string[];
	/** Ground-truth paths (relative to the fixture repo root) a correct run must cite as evidence. */
	requiredEvidencePaths: readonly string[];
	/** False when the fixture is an unsolvable trap (correct runs must report insufficient evidence). */
	solvable: boolean;
}

export interface QualityCase {
	id: string;
	class: QualityCaseClass;
	objective: string;
	acceptanceCriteria?: readonly QualityAcceptanceCriterion[];
	expectedOutcome: QualityCaseExpectedOutcome;
	/** Paths in the fixture repo (relative to the repo root) that constitute ground truth. */
	groundTruthPaths: readonly string[];
}

export interface QualityCaseManifestFile {
	schemaVersion: 1;
	/** Directory that acts as the subject repo, relative to the fixture root holding the manifest. */
	repoRoot: string;
	cases: readonly QualityCase[];
}

export interface ResolvedQualityCaseManifest {
	/** Absolute path of the subject repo used for every evidence existence check. */
	repoRoot: string;
	cases: readonly QualityCase[];
	caseById: ReadonlyMap<string, QualityCase>;
}

export type SubagentQualityVerificationKind = "structured" | "plain_bounds" | "none";

export interface SubagentQualityObservedToolCall {
	tool: string;
	/** Path referenced by the call; absolute or relative to the fixture repo root. */
	path?: string;
}

export interface SubagentQualityCriterionClaim {
	criterionId: string;
	satisfied: boolean;
}

/**
 * Raw, untrusted per-run observation. Provenance fields are recorded for every
 * run; derived quality metrics are computed by measureSubagentQualityRun.
 */
export interface SubagentQualityRunObservation {
	caseId: string;
	gitCommit: string;
	worktreePath: string;
	/** Exact provider/model route, e.g. "cx/gpt-5.6-luna". */
	modelRoute: string;
	thinkingLevel: string;
	/** Child profile/role name, e.g. "explore". */
	childProfile: string;
	taskContractHash?: string;
	contextManifestHash?: string;
	toolAllowlist: readonly string[];
	wallMs: number;
	assistantRequestCount: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	toolCallCount: number;
	parentFollowUpCount: number;
	verificationKind: SubagentQualityVerificationKind;
	/** Fraction (0..1) of required acceptance criteria the run satisfied; undefined when none were declared. */
	requiredCriterionPassRate?: number;
	/** Child-reported evidence paths; untrusted until measured against the fixture repo. */
	reportedEvidencePaths: readonly string[];
	observedToolCalls: readonly SubagentQualityObservedToolCall[];
	reviewerDefectCount?: number;
	reviewerFalsePositiveCount?: number;
	finalSuccess: boolean;
	notes?: string;
}

export interface SubagentQualityRunRecord extends SubagentQualityRunObservation {
	/** Fraction of reported evidence paths that exist in the fixture repo AND appear in observed tool calls. */
	evidencePrecision: number;
	/** Unique reported evidence paths that do not exist in the fixture repo. */
	fabricatedEvidenceCount: number;
	/** Bounded, sorted diagnostics for fabricated evidence; normalized in-repo paths or the raw escaping path. */
	fabricatedEvidencePaths: readonly string[];
}

export type SubagentQualityBenchErrorCode =
	| "invalid_manifest"
	| "case_not_found"
	| "invalid_record"
	| "empty_corpus"
	| "credentials_required"
	| "live_not_implemented";

export class SubagentQualityBenchError extends Error {
	readonly code: SubagentQualityBenchErrorCode;

	constructor(code: SubagentQualityBenchErrorCode, message: string) {
		super(message);
		this.name = "SubagentQualityBenchError";
		this.code = code;
	}
}

/** Mirrors the sha256 hex conventions used by subagent routing and artifacts. */
export function hashQualityText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

const MAX_PATH_LENGTH = 1024;
const MAX_FIELD_LENGTH = 4096;

function isNonEmptyBoundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalCount(value: unknown): value is number | undefined {
	return value === undefined || isCount(value);
}

function isRate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isOptionalRate(value: unknown): value is number | undefined {
	return value === undefined || isRate(value);
}

interface NormalizedPath {
	/** In-repo relative path, or "" when the path escapes the repo root. */
	rel: string;
	outside: boolean;
}

/**
 * Normalizes a reported or observed path against the fixture repo root.
 * Returns undefined for empty or oversized inputs; returns an outside marker
 * for absolute paths outside the root or any ".." traversal attempt, without
 * touching the filesystem.
 */
function normalizeRepoPath(repoRoot: string, raw: string): NormalizedPath | undefined {
	if (!isNonEmptyBoundedString(raw, MAX_PATH_LENGTH)) return undefined;
	let candidate = raw.trim().replaceAll("\\", "/");
	if (candidate.length === 0) return undefined;
	if (isAbsolute(candidate)) {
		const rel = relative(repoRoot, candidate).replaceAll("\\", "/");
		if (rel === "" || rel === ".." || rel.startsWith(`../`)) return { rel: "", outside: true };
		candidate = rel;
	}
	while (candidate.startsWith("./")) candidate = candidate.slice(2);
	if (candidate.length === 0) return { rel: "", outside: true };
	const segments = candidate.split("/");
	if (segments.some((segment) => segment === ".." || segment.length === 0)) return { rel: "", outside: true };
	return { rel: segments.join("/"), outside: false };
}

function fixtureFileExists(repoRoot: string, rel: string): boolean {
	if (rel.length === 0) return false;
	try {
		return statSync(join(repoRoot, rel)).isFile();
	} catch {
		return false;
	}
}

function assertValidManifestCase(qualityCase: QualityCase, repoRoot: string): void {
	if (!isNonEmptyBoundedString(qualityCase.id, 128) || /\s/.test(qualityCase.id)) {
		throw new SubagentQualityBenchError("invalid_manifest", `Case id is invalid: ${JSON.stringify(qualityCase.id)}.`);
	}
	if (!QUALITY_CASE_CLASSES.includes(qualityCase.class)) {
		throw new SubagentQualityBenchError("invalid_manifest", `Case ${qualityCase.id} has an unknown class.`);
	}
	if (!isNonEmptyBoundedString(qualityCase.objective, MAX_FIELD_LENGTH)) {
		throw new SubagentQualityBenchError("invalid_manifest", `Case ${qualityCase.id} has an empty objective.`);
	}
	if (qualityCase.groundTruthPaths.length === 0) {
		throw new SubagentQualityBenchError("invalid_manifest", `Case ${qualityCase.id} declares no ground truth paths.`);
	}
	const outcome = qualityCase.expectedOutcome;
	if (!outcome || typeof outcome !== "object") {
		throw new SubagentQualityBenchError("invalid_manifest", `Case ${qualityCase.id} has no expected outcome.`);
	}
	if (outcome.solvable !== true && outcome.solvable !== false) {
		throw new SubagentQualityBenchError(
			"invalid_manifest",
			`Case ${qualityCase.id} has a non-boolean solvable flag.`,
		);
	}
	if (
		outcome.checks.length === 0 ||
		outcome.checks.some((check) => !isNonEmptyBoundedString(check, MAX_FIELD_LENGTH))
	) {
		throw new SubagentQualityBenchError(
			"invalid_manifest",
			`Case ${qualityCase.id} declares no deterministic checks.`,
		);
	}
	const criterionIds = new Set((qualityCase.acceptanceCriteria ?? []).map((criterion) => criterion.id));
	if (qualityCase.acceptanceCriteria?.length && criterionIds.size !== qualityCase.acceptanceCriteria.length) {
		throw new SubagentQualityBenchError("invalid_manifest", `Case ${qualityCase.id} has duplicate criterion ids.`);
	}
	for (const requiredId of outcome.requiredCriterionIds) {
		if (!criterionIds.has(requiredId)) {
			throw new SubagentQualityBenchError(
				"invalid_manifest",
				`Case ${qualityCase.id} requires unknown criterion ${requiredId}.`,
			);
		}
	}
	const groundTruth = new Set<string>();
	for (const rawPath of qualityCase.groundTruthPaths) {
		const normalized = normalizeRepoPath(repoRoot, rawPath);
		if (!normalized || normalized.outside) {
			throw new SubagentQualityBenchError(
				"invalid_manifest",
				`Case ${qualityCase.id} ground truth path escapes the fixture repo: ${JSON.stringify(rawPath)}.`,
			);
		}
		if (!fixtureFileExists(repoRoot, normalized.rel)) {
			throw new SubagentQualityBenchError(
				"invalid_manifest",
				`Case ${qualityCase.id} ground truth path does not exist in the fixture repo: ${normalized.rel}.`,
			);
		}
		groundTruth.add(normalized.rel);
	}
	for (const rawPath of outcome.requiredEvidencePaths) {
		const normalized = normalizeRepoPath(repoRoot, rawPath);
		if (!normalized || normalized.outside || !groundTruth.has(normalized.rel)) {
			throw new SubagentQualityBenchError(
				"invalid_manifest",
				`Case ${qualityCase.id} requires evidence path outside its ground truth: ${JSON.stringify(rawPath)}.`,
			);
		}
	}
}

/** Validates a manifest and resolves its repo root against the directory holding the manifest. */
export function resolveQualityCaseManifest(
	manifest: QualityCaseManifestFile,
	fixtureRoot: string,
): ResolvedQualityCaseManifest {
	if (manifest.schemaVersion !== 1) {
		throw new SubagentQualityBenchError("invalid_manifest", "Quality case manifest schema version must be 1.");
	}
	if (!isNonEmptyBoundedString(fixtureRoot, MAX_PATH_LENGTH)) {
		throw new SubagentQualityBenchError("invalid_manifest", "Fixture root must be a bounded path.");
	}
	if (!isNonEmptyBoundedString(manifest.repoRoot, MAX_PATH_LENGTH)) {
		throw new SubagentQualityBenchError("invalid_manifest", "Manifest repoRoot must be a bounded relative path.");
	}
	const resolvedFixtureRoot = resolve(fixtureRoot);
	const repoRootPath = resolve(resolvedFixtureRoot, manifest.repoRoot);
	const repoRootRelative = relative(resolvedFixtureRoot, repoRootPath);
	if (
		repoRootRelative === "" ||
		repoRootRelative === ".." ||
		repoRootRelative.startsWith(`../`) ||
		isAbsolute(repoRootRelative)
	) {
		throw new SubagentQualityBenchError("invalid_manifest", "Manifest repoRoot must stay inside the fixture root.");
	}
	if (manifest.cases.length === 0) {
		throw new SubagentQualityBenchError("invalid_manifest", "Quality case manifest declares no cases.");
	}
	const caseById = new Map<string, QualityCase>();
	for (const qualityCase of manifest.cases) {
		assertValidManifestCase(qualityCase, repoRootPath);
		if (caseById.has(qualityCase.id)) {
			throw new SubagentQualityBenchError("invalid_manifest", `Duplicate quality case id: ${qualityCase.id}.`);
		}
		caseById.set(qualityCase.id, qualityCase);
	}
	return Object.freeze({ repoRoot: repoRootPath, cases: Object.freeze([...manifest.cases]), caseById });
}

/**
 * Pass rate over the case's required criteria only. Claims for non-required
 * criteria are ignored; missing required claims count as unsatisfied. A case
 * with no required criteria is vacuously satisfied (rate 1).
 */
export function measureRequiredCriterionPassRate(
	qualityCase: QualityCase,
	claims: readonly SubagentQualityCriterionClaim[],
): number {
	const required = qualityCase.expectedOutcome.requiredCriterionIds;
	if (required.length === 0) return 1;
	const satisfied = new Set(claims.filter((claim) => claim.satisfied).map((claim) => claim.criterionId));
	let passed = 0;
	for (const criterionId of required) {
		if (satisfied.has(criterionId)) passed++;
	}
	return passed / required.length;
}

function assertValidObservation(observation: SubagentQualityRunObservation): void {
	const label = isNonEmptyBoundedString(observation.caseId, 128) ? observation.caseId : "<invalid>";
	const invalid = (field: string): SubagentQualityBenchError =>
		new SubagentQualityBenchError("invalid_record", `Run record for case ${label} has an invalid ${field}.`);
	if (!isNonEmptyBoundedString(observation.caseId, 128)) throw invalid("caseId");
	for (const field of ["gitCommit", "worktreePath", "modelRoute", "thinkingLevel", "childProfile"] as const) {
		if (!isNonEmptyBoundedString(observation[field], MAX_FIELD_LENGTH)) throw invalid(field);
	}
	if (
		!Array.isArray(observation.toolAllowlist) ||
		observation.toolAllowlist.some((tool) => typeof tool !== "string")
	) {
		throw invalid("toolAllowlist");
	}
	if (typeof observation.wallMs !== "number" || !Number.isFinite(observation.wallMs) || observation.wallMs < 0) {
		throw invalid("wallMs");
	}
	if (!isCount(observation.assistantRequestCount)) throw invalid("assistantRequestCount");
	if (!isCount(observation.toolCallCount)) throw invalid("toolCallCount");
	if (!isCount(observation.parentFollowUpCount)) throw invalid("parentFollowUpCount");
	if (!isOptionalCount(observation.inputTokens)) throw invalid("inputTokens");
	if (!isOptionalCount(observation.outputTokens)) throw invalid("outputTokens");
	if (!isOptionalCount(observation.cacheReadTokens)) throw invalid("cacheReadTokens");
	if (
		observation.verificationKind !== "structured" &&
		observation.verificationKind !== "plain_bounds" &&
		observation.verificationKind !== "none"
	) {
		throw invalid("verificationKind");
	}
	if (!isOptionalRate(observation.requiredCriterionPassRate)) throw invalid("requiredCriterionPassRate");
	if (!Array.isArray(observation.reportedEvidencePaths)) throw invalid("reportedEvidencePaths");
	if (!Array.isArray(observation.observedToolCalls)) throw invalid("observedToolCalls");
	for (const call of observation.observedToolCalls) {
		if (!call || typeof call !== "object" || !isNonEmptyBoundedString(call.tool, 128))
			throw invalid("observedToolCalls");
	}
	if (!isOptionalCount(observation.reviewerDefectCount)) throw invalid("reviewerDefectCount");
	if (!isOptionalCount(observation.reviewerFalsePositiveCount)) throw invalid("reviewerFalsePositiveCount");
	if (typeof observation.finalSuccess !== "boolean") throw invalid("finalSuccess");
	if (observation.notes !== undefined && !isNonEmptyBoundedString(observation.notes, MAX_FIELD_LENGTH)) {
		throw invalid("notes");
	}
}

/**
 * Measures a raw observation against the fixture repo: computes evidence
 * precision (fraction of unique reported evidence paths that exist on disk in
 * the fixture repo AND appear among observed tool call paths), the fabricated
 * evidence count (reported paths that do not exist in the fixture repo), and
 * returns the completed run record. An empty evidence report scores zero
 * precision. No filesystem access outside the fixture repo root occurs.
 */
export function measureSubagentQualityRun(
	manifest: ResolvedQualityCaseManifest,
	observation: SubagentQualityRunObservation,
): SubagentQualityRunRecord {
	assertValidObservation(observation);
	const qualityCase = manifest.caseById.get(observation.caseId);
	if (!qualityCase) {
		throw new SubagentQualityBenchError("case_not_found", `Unknown quality case id: ${observation.caseId}.`);
	}
	const reported = new Map<string, NormalizedPath>();
	for (const rawPath of observation.reportedEvidencePaths) {
		const normalized = normalizeRepoPath(manifest.repoRoot, rawPath);
		if (!normalized) continue;
		// Escaping paths keep a bounded raw marker so fabrication stays visible.
		const key = normalized.outside ? `outside:${rawPath.trim().slice(0, 256)}` : `rel:${normalized.rel}`;
		if (!reported.has(key)) reported.set(key, normalized);
	}
	const observedPaths = new Set<string>();
	for (const call of observation.observedToolCalls) {
		const normalized = normalizeRepoPath(manifest.repoRoot, call.path ?? "");
		if (normalized && !normalized.outside && normalized.rel.length > 0) observedPaths.add(normalized.rel);
	}
	let precise = 0;
	const fabricatedPaths: string[] = [];
	for (const [key, normalized] of reported) {
		if (normalized.outside) {
			fabricatedPaths.push(key.slice("outside:".length));
			continue;
		}
		if (!fixtureFileExists(manifest.repoRoot, normalized.rel)) {
			fabricatedPaths.push(normalized.rel);
			continue;
		}
		if (observedPaths.has(normalized.rel)) precise++;
	}
	const uniqueCount = reported.size;
	return {
		...observation,
		evidencePrecision: uniqueCount === 0 ? 0 : precise / uniqueCount,
		fabricatedEvidenceCount: fabricatedPaths.length,
		fabricatedEvidencePaths: Object.freeze(fabricatedPaths.sort((left, right) => left.localeCompare(right))),
	};
}

export interface QualityBenchmarkWeights {
	/** Weight per case class; every class defaults to 1. Weights must be finite and positive. */
	byClass?: Readonly<Partial<Record<QualityCaseClass, number>>>;
}

export interface QualityBenchmarkReportHeader {
	title?: string;
	/** The only place a timestamp may appear; rendered verbatim when provided. */
	generatedAt?: string;
	baselineLabel?: string;
	currentLabel?: string;
}

export interface QualityBenchmarkRunRow {
	caseId: string;
	class: QualityCaseClass;
	verified: boolean;
	record: SubagentQualityRunRecord;
}

export interface QualityClassBreakdown {
	class: QualityCaseClass;
	runs: number;
	verifiedSuccesses: number;
	verifiedSuccessRate: number;
	meanEvidencePrecision: number;
	fabricatedEvidenceCount: number;
	meanWallMs: number;
}

export interface QualityBenchmarkAggregate {
	runs: number;
	verifiedSuccesses: number;
	/** Weighted verified-task success: class-weighted fraction of runs that verified. */
	weightedVerifiedSuccess: number;
	meanEvidencePrecision: number;
	fabricatedEvidenceCount: number;
	byClass: readonly QualityClassBreakdown[];
}

export interface QualityBenchmarkMetricComparison {
	category: string;
	baseline: number;
	current: number;
	/** current - baseline. */
	delta: number;
	regression: boolean;
}

export interface QualityBenchmarkComparisonOptions {
	/** Aggregate of the prior report to compare against. */
	baseline: QualityBenchmarkAggregate;
	/** Absolute delta beyond which a metric change is a material regression. Default 0.05. */
	threshold?: number;
}

export interface QualityBenchmarkComparison {
	threshold: number;
	comparisons: readonly QualityBenchmarkMetricComparison[];
	materialRegressions: readonly QualityBenchmarkMetricComparison[];
}

export interface QualityBenchmarkRun {
	schemaVersion: 1;
	header: QualityBenchmarkReportHeader;
	fixtureCaseCount: number;
	minEvidencePrecision: number;
	runs: readonly QualityBenchmarkRunRow[];
	aggregate: QualityBenchmarkAggregate;
	comparison?: QualityBenchmarkComparison;
}

export interface QualityBenchmarkRunOptions {
	fixture: ResolvedQualityCaseManifest;
	records: readonly SubagentQualityRunRecord[];
	header?: QualityBenchmarkReportHeader;
	weights?: QualityBenchmarkWeights;
	/** Minimum evidence precision for a run to verify. Default 1. */
	minEvidencePrecision?: number;
	comparison?: QualityBenchmarkComparisonOptions;
}

/**
 * A run verifies only when the parent marked it successful under a real
 * verification contract, every required acceptance criterion passed, and
 * evidence precision meets the configured minimum.
 */
export function isVerifiedQualityRun(record: SubagentQualityRunRecord, minEvidencePrecision: number): boolean {
	if (!record.finalSuccess) return false;
	if (record.verificationKind === "none") return false;
	if (record.requiredCriterionPassRate !== undefined && record.requiredCriterionPassRate < 1) return false;
	return record.evidencePrecision >= minEvidencePrecision;
}

function resolveWeights(weights: QualityBenchmarkWeights | undefined): Record<QualityCaseClass, number> {
	const resolved = {} as Record<QualityCaseClass, number>;
	for (const qualityClass of QUALITY_CASE_CLASSES) {
		const value = weights?.byClass?.[qualityClass];
		if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
			throw new SubagentQualityBenchError("invalid_record", `Class weight for ${qualityClass} must be positive.`);
		}
		resolved[qualityClass] = value ?? 1;
	}
	return resolved;
}

function summarizeRuns(
	rows: readonly QualityBenchmarkRunRow[],
	minEvidencePrecision: number,
	weights: Record<QualityCaseClass, number>,
): QualityBenchmarkAggregate {
	const byClassMap = new Map<QualityCaseClass, QualityClassBreakdown>();
	let verifiedWeight = 0;
	let totalWeight = 0;
	let precisionSum = 0;
	let fabricatedTotal = 0;
	for (const row of rows) {
		const verified = isVerifiedQualityRun(row.record, minEvidencePrecision);
		const weight = weights[row.class];
		totalWeight += weight;
		if (verified) verifiedWeight += weight;
		precisionSum += row.record.evidencePrecision;
		fabricatedTotal += row.record.fabricatedEvidenceCount;
		let breakdown = byClassMap.get(row.class);
		if (!breakdown) {
			breakdown = {
				class: row.class,
				runs: 0,
				verifiedSuccesses: 0,
				verifiedSuccessRate: 0,
				meanEvidencePrecision: 0,
				fabricatedEvidenceCount: 0,
				meanWallMs: 0,
			};
			byClassMap.set(row.class, breakdown);
		}
		breakdown.runs++;
		if (verified) breakdown.verifiedSuccesses++;
		breakdown.meanEvidencePrecision += row.record.evidencePrecision;
		breakdown.fabricatedEvidenceCount += row.record.fabricatedEvidenceCount;
		breakdown.meanWallMs += row.record.wallMs;
	}
	for (const breakdown of byClassMap.values()) {
		breakdown.verifiedSuccessRate = breakdown.runs === 0 ? 0 : breakdown.verifiedSuccesses / breakdown.runs;
		breakdown.meanEvidencePrecision = breakdown.runs === 0 ? 0 : breakdown.meanEvidencePrecision / breakdown.runs;
		breakdown.meanWallMs = breakdown.runs === 0 ? 0 : breakdown.meanWallMs / breakdown.runs;
	}
	const runs = rows.length;
	const verifiedSuccesses = rows.filter((row) => isVerifiedQualityRun(row.record, minEvidencePrecision)).length;
	return {
		runs,
		verifiedSuccesses,
		weightedVerifiedSuccess: totalWeight === 0 ? 0 : verifiedWeight / totalWeight,
		meanEvidencePrecision: runs === 0 ? 0 : precisionSum / runs,
		fabricatedEvidenceCount: fabricatedTotal,
		byClass: [...byClassMap.values()].sort((left, right) => left.class.localeCompare(right.class)),
	};
}

function classSuccessRate(aggregate: QualityBenchmarkAggregate, qualityClass: QualityCaseClass): number {
	const breakdown = aggregate.byClass.find((entry) => entry.class === qualityClass);
	return breakdown ? breakdown.verifiedSuccessRate : 0;
}

function buildComparison(
	baseline: QualityBenchmarkAggregate,
	current: QualityBenchmarkAggregate,
	threshold: number,
): QualityBenchmarkComparison {
	interface Metric {
		category: string;
		baseline: number;
		current: number;
		lowerIsBetter: boolean;
	}
	const metrics: Metric[] = [
		{
			category: "aggregate:weighted_verified_success",
			baseline: baseline.weightedVerifiedSuccess,
			current: current.weightedVerifiedSuccess,
			lowerIsBetter: false,
		},
		{
			category: "aggregate:mean_evidence_precision",
			baseline: baseline.meanEvidencePrecision,
			current: current.meanEvidencePrecision,
			lowerIsBetter: false,
		},
		{
			category: "aggregate:fabricated_evidence_count",
			baseline: baseline.fabricatedEvidenceCount,
			current: current.fabricatedEvidenceCount,
			lowerIsBetter: true,
		},
	];
	const classes = new Set<QualityCaseClass>([
		...baseline.byClass.map((entry) => entry.class),
		...current.byClass.map((entry) => entry.class),
	]);
	for (const qualityClass of [...classes].sort((left, right) => left.localeCompare(right))) {
		metrics.push({
			category: `class:${qualityClass}:verified_success_rate`,
			baseline: classSuccessRate(baseline, qualityClass),
			current: classSuccessRate(current, qualityClass),
			lowerIsBetter: false,
		});
	}
	const comparisons = metrics
		.map((metric) => {
			const delta = metric.current - metric.baseline;
			const regression = metric.lowerIsBetter ? delta > threshold : -delta > threshold;
			return {
				category: metric.category,
				baseline: metric.baseline,
				current: metric.current,
				delta,
				regression,
			};
		})
		.sort((left, right) => left.category.localeCompare(right.category));
	return {
		threshold,
		comparisons,
		materialRegressions: comparisons.filter((comparison) => comparison.regression),
	};
}

/** Aggregates measured run records into a deterministic, redacted benchmark report. */
export function createQualityBenchmarkRun(options: QualityBenchmarkRunOptions): QualityBenchmarkRun {
	if (options.records.length === 0) {
		throw new SubagentQualityBenchError("empty_corpus", "Quality benchmark run requires at least one run record.");
	}
	const minEvidencePrecision = options.minEvidencePrecision ?? 1;
	if (!isRate(minEvidencePrecision)) {
		throw new SubagentQualityBenchError("invalid_record", "minEvidencePrecision must be between 0 and 1.");
	}
	const weights = resolveWeights(options.weights);
	const rows: QualityBenchmarkRunRow[] = [];
	for (const record of options.records) {
		assertValidObservation(record);
		const qualityCase = options.fixture.caseById.get(record.caseId);
		if (!qualityCase) {
			throw new SubagentQualityBenchError("case_not_found", `Unknown quality case id: ${record.caseId}.`);
		}
		rows.push({
			caseId: record.caseId,
			class: qualityCase.class,
			verified: isVerifiedQualityRun(record, minEvidencePrecision),
			record: {
				...record,
				// Report artifacts are redacted; free-text notes never carry credentials.
				...(record.notes !== undefined ? { notes: redactCredentialText(record.notes) } : {}),
			},
		});
	}
	// Stable determinism: order runs by case id, keeping input order for ties.
	const orderedRows = rows
		.map((row, index) => ({ row, index }))
		.sort((left, right) => left.row.caseId.localeCompare(right.row.caseId) || left.index - right.index)
		.map((entry) => entry.row);
	const aggregate = summarizeRuns(orderedRows, minEvidencePrecision, weights);
	const run: QualityBenchmarkRun = {
		schemaVersion: 1,
		header: options.header ?? {},
		fixtureCaseCount: options.fixture.cases.length,
		minEvidencePrecision,
		runs: orderedRows,
		aggregate,
	};
	if (options.comparison) {
		const threshold = options.comparison.threshold ?? 0.05;
		if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) {
			throw new SubagentQualityBenchError("invalid_record", "Comparison threshold must be a non-negative number.");
		}
		run.comparison = buildComparison(options.comparison.baseline, aggregate, threshold);
	}
	return run;
}

function escapeMarkdownCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\r\n", " ").replaceAll("\n", " ").replaceAll("\r", " ");
}

function formatRate(value: number): string {
	return value.toFixed(3);
}

function formatMetricValue(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function formatDelta(value: number): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function formatOptionalCount(value: number | undefined): string {
	return value === undefined ? "-" : String(value);
}

function formatMs(value: number): string {
	return Number.isInteger(value) ? `${String(value)}.0` : value.toFixed(1);
}

const RUN_PROVENANCE_LABELS: readonly (keyof SubagentQualityRunRecord)[] = [
	"gitCommit",
	"worktreePath",
	"modelRoute",
	"thinkingLevel",
	"childProfile",
	"taskContractHash",
	"contextManifestHash",
	"toolAllowlist",
	"wallMs",
	"assistantRequestCount",
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"toolCallCount",
	"parentFollowUpCount",
	"verificationKind",
	"requiredCriterionPassRate",
	"evidencePrecision",
	"fabricatedEvidenceCount",
	"reviewerDefectCount",
	"reviewerFalsePositiveCount",
	"finalSuccess",
	"notes",
];

function renderProvenanceValue(record: SubagentQualityRunRecord, field: keyof SubagentQualityRunRecord): string {
	const value = record[field];
	switch (field) {
		case "toolAllowlist":
			return escapeMarkdownCell((value as readonly string[]).join(", "));
		case "wallMs":
			return formatMs(value as number);
		case "requiredCriterionPassRate":
			return value === undefined ? "-" : formatRate(value as number);
		case "evidencePrecision":
			return formatRate(value as number);
		case "reviewerDefectCount":
		case "reviewerFalsePositiveCount":
			return formatOptionalCount(value as number | undefined);
		case "finalSuccess":
			return String(value);
		default:
			return value === undefined || value === null ? "-" : escapeMarkdownCell(String(value));
	}
}

/** Deterministic markdown renderer: sorted orders, fixed number formats, no implicit timestamps. */
export function renderQualityBenchmarkMarkdown(run: QualityBenchmarkRun): string {
	const lines: string[] = [];
	lines.push(`# ${run.header.title ?? "ICE subagent quality benchmark"}`);
	lines.push("");
	lines.push(`- fixture cases: ${run.fixtureCaseCount}`);
	lines.push(`- runs: ${run.aggregate.runs}`);
	lines.push(`- weighted verified-task success: ${formatRate(run.aggregate.weightedVerifiedSuccess)}`);
	lines.push(`- min evidence precision: ${formatRate(run.minEvidencePrecision)}`);
	if (run.header.generatedAt !== undefined) lines.push(`- generatedAt: ${run.header.generatedAt}`);
	if (run.header.baselineLabel !== undefined) lines.push(`- baseline: ${run.header.baselineLabel}`);
	if (run.header.currentLabel !== undefined) lines.push(`- current: ${run.header.currentLabel}`);
	lines.push("");
	lines.push("## Run provenance");
	for (const [index, row] of run.runs.entries()) {
		lines.push("");
		lines.push(`### run ${index + 1}: ${row.caseId} (${row.class}) - verified: ${row.verified ? "yes" : "no"}`);
		lines.push("");
		lines.push("| Field | Value |");
		lines.push("| --- | --- |");
		for (const field of RUN_PROVENANCE_LABELS) {
			lines.push(`| ${field} | ${renderProvenanceValue(row.record, field)} |`);
		}
	}
	lines.push("");
	lines.push("## Aggregate by class");
	lines.push("");
	lines.push("| Class | Runs | Verified | Success rate | Mean precision | Fabricated |");
	lines.push("| --- | --- | --- | --- | --- | --- |");
	for (const breakdown of run.aggregate.byClass) {
		lines.push(
			`| ${breakdown.class} | ${breakdown.runs} | ${breakdown.verifiedSuccesses} | ${formatRate(breakdown.verifiedSuccessRate)} | ${formatRate(breakdown.meanEvidencePrecision)} | ${breakdown.fabricatedEvidenceCount} |`,
		);
	}
	if (run.comparison) {
		lines.push("");
		lines.push("## Regression comparison");
		lines.push("");
		lines.push(`threshold: ${formatRate(run.comparison.threshold)}`);
		lines.push("");
		lines.push("| Category | Baseline | Current | Delta | Material regression |");
		lines.push("| --- | --- | --- | --- | --- |");
		for (const comparison of run.comparison.comparisons) {
			lines.push(
				`| ${comparison.category} | ${formatMetricValue(comparison.baseline)} | ${formatMetricValue(comparison.current)} | ${formatDelta(comparison.delta)} | ${comparison.regression ? "yes" : "no"} |`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** Deterministic JSON serializer; the report object is built with fixed key order. */
export function serializeQualityBenchmarkJson(run: QualityBenchmarkRun): string {
	return `${JSON.stringify(run, null, "\t")}\n`;
}

/**
 * Fail-closed gate for live baseline attempts. CI cannot reach it: the live
 * describe block only runs when ICE_QUALITY_BENCH_LIVE=1 is set explicitly.
 */
export function beginQualityBenchLiveBaseline(options: { modelRoute?: string }): void {
	if (!isNonEmptyBoundedString(options.modelRoute, 256)) {
		throw new SubagentQualityBenchError(
			"credentials_required",
			"Live quality baseline requires an explicit model route (set ICE_QUALITY_BENCH_LIVE_MODEL) and configured provider credentials; no provider calls were made.",
		);
	}
	throw new SubagentQualityBenchError(
		"live_not_implemented",
		`The live model-backed baseline for ${options.modelRoute} is not implemented yet; no provider calls were made.`,
	);
}
