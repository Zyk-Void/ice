import { createHash } from "node:crypto";
import { redactCredentialText } from "../../utils/redact.ts";
import type { ReviewFinding, SubagentBatchTask } from "../types.ts";

/**
 * Pure batch synthesis helpers (Phase 6.1/6.4): exact duplicate sibling
 * contract detection and parent-visible synthesis metadata. No I/O and no
 * model calls; every emitted string is redacted and bounded so the output is
 * safe to embed in a parent prompt section.
 */

/** Substrings that mark a claim as hedging/negative. Checked case-insensitively. */
const NEGATIVE_POLARITY_MARKERS = ["no ", "not ", "cannot", "unable", "missing", "absent"] as const;

const CLAIM_LIMIT_CHARS = 200;
const CLAIM_TRUNCATION_SUFFIX = "...";
const MAX_CONTRADICTIONS = 32;
const MAX_SHARED_PATHS_PER_PAIR = 16;
const SECTION_LIMIT_BYTES = 4 * 1024;
const SECTION_TRUNCATION_MARKER = "\n[truncated]";

export type SubagentBatchSynthesisStatus = "completed" | "failed" | "other";

export type SubagentBatchContradictionKind = "finding_claim" | "requirement_claim";

/**
 * Structural projection of one child result accepted by
 * {@link summarizeBatchSynthesis}. A full `SubagentResult` satisfies it.
 * `claim` is kept as a plain string so both real requirement states
 * (`SubagentRequirementClaimStatus`) and arbitrary caller payloads fit.
 */
export interface SubagentBatchSynthesisItemResult {
	status?: string;
	/** Accepted for structural compatibility; synthesis projects claims, not prose summaries. */
	summary?: string;
	evidence?: { paths?: readonly string[] };
	findings?: readonly ReviewFinding[];
	requirementStates?: readonly {
		id: string;
		required: boolean;
		verified: boolean;
		claim?: string;
	}[];
}

export interface SubagentBatchSynthesisItem {
	taskId: string;
	result?: SubagentBatchSynthesisItemResult;
}

/** Bounded host-validated V2 projection accepted by the deterministic synthesizer. */
export interface V2BatchSynthesisResult {
	id: string;
	outcome: string;
	validation?: {
		paths: readonly string[];
		findings?: readonly ReviewFinding[];
		requirements: readonly {
			requirement: string;
			required: boolean;
			verified: boolean;
			claim?: string;
		}[];
	};
}

export interface SubagentBatchSynthesisCounts {
	total: number;
	completed: number;
	failed: number;
	other: number;
}

export interface SubagentBatchSynthesisCoverageRow {
	taskId: string;
	status: SubagentBatchSynthesisStatus;
	verifiedCriteria: number;
	unresolvedCriteria: number;
	evidencePathCount: number;
}

export interface SubagentBatchEvidenceOverlapPair {
	taskIdA: string;
	taskIdB: string;
	sharedPaths: string[];
}

export interface SubagentBatchContradiction {
	taskIdA: string;
	taskIdB: string;
	kind: SubagentBatchContradictionKind;
	summaryA: string;
	summaryB: string;
}

export interface SubagentBatchSynthesis {
	counts: SubagentBatchSynthesisCounts;
	coverage: SubagentBatchSynthesisCoverageRow[];
	evidenceOverlap: SubagentBatchEvidenceOverlapPair[];
	contradictions: SubagentBatchContradiction[];
}

export interface SubagentBatchDuplicatePair {
	firstId: string;
	duplicateId: string;
}

interface ContradictionCandidate {
	taskIdA: string;
	taskIdB: string;
	kind: SubagentBatchContradictionKind;
	sortKey: string;
	summaryA: string;
	summaryB: string;
}

/**
 * Detect siblings whose effective contract is exactly identical: same
 * normalized task text, same sorted scope roots and targets, same declared
 * kind and deliverable. Overlapping scopes alone are never duplicates
 * (independent second opinions are legitimate). The first occurrence of each
 * contract is kept; every later occurrence is reported as a duplicate pair.
 */
export function findExactDuplicateBatchTasks(tasks: readonly SubagentBatchTask[]): SubagentBatchDuplicatePair[] {
	const firstByContract = new Map<string, string>();
	const pairs: SubagentBatchDuplicatePair[] = [];
	for (const task of tasks) {
		const key = duplicateContractKey(task);
		const firstId = firstByContract.get(key);
		if (firstId === undefined) {
			firstByContract.set(key, task.id);
			continue;
		}
		pairs.push({ firstId, duplicateId: task.id });
	}
	return pairs;
}

function duplicateContractKey(task: SubagentBatchTask): string {
	return JSON.stringify({
		task: normalizeWhitespace(task.task),
		roots: normalizePathList(task.scope.roots),
		targets: normalizePathList(task.scope.targets),
		kind: task.kind ?? "",
		deliverable: normalizeWhitespace(task.deliverable ?? ""),
	});
}

function normalizeWhitespace(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function normalizePathList(values: readonly string[] | undefined): string {
	const normalized = (values ?? []).map((value) => normalizeWhitespace(value)).sort();
	return JSON.stringify(normalized);
}

/**
 * Build frozen, deterministic synthesis metadata for a batch: per-child
 * counts and coverage, pairwise evidence overlap, and conservative explicit
 * contradictions. Disagreement is surfaced, never averaged away.
 */
export function summarizeBatchSynthesis(items: readonly SubagentBatchSynthesisItem[]): SubagentBatchSynthesis {
	const sortedItems = [...items].sort((a, b) => compareStrings(a.taskId, b.taskId));

	const counts: SubagentBatchSynthesisCounts = { total: items.length, completed: 0, failed: 0, other: 0 };
	for (const item of sortedItems) {
		counts[classifyStatus(item.result?.status)]++;
	}

	const coverage = sortedItems.map((item): SubagentBatchSynthesisCoverageRow => {
		const states = item.result?.requirementStates ?? [];
		let verifiedCriteria = 0;
		for (const state of states) {
			if (state.verified === true) verifiedCriteria++;
		}
		return {
			taskId: item.taskId,
			status: classifyStatus(item.result?.status),
			verifiedCriteria,
			unresolvedCriteria: states.length - verifiedCriteria,
			evidencePathCount: (item.result?.evidence?.paths ?? []).length,
		};
	});

	const evidenceOverlap: SubagentBatchEvidenceOverlapPair[] = [];
	for (let i = 0; i < sortedItems.length; i++) {
		for (let j = i + 1; j < sortedItems.length; j++) {
			const a = sortedItems[i]!;
			const b = sortedItems[j]!;
			const sharedPaths = sharedPathsBetween(a, b);
			if (sharedPaths.length > 0) {
				evidenceOverlap.push({ taskIdA: a.taskId, taskIdB: b.taskId, sharedPaths });
			}
		}
	}

	const candidates: ContradictionCandidate[] = [];
	for (let i = 0; i < sortedItems.length; i++) {
		for (let j = i + 1; j < sortedItems.length; j++) {
			const a = sortedItems[i]!;
			const b = sortedItems[j]!;
			candidates.push(...findingContradictionCandidates(a, b));
			candidates.push(...requirementContradictionCandidates(a, b));
		}
	}
	candidates.sort(
		(a, b) =>
			compareStrings(a.taskIdA, b.taskIdA) ||
			compareStrings(a.taskIdB, b.taskIdB) ||
			compareStrings(a.kind, b.kind) ||
			compareStrings(a.sortKey, b.sortKey),
	);
	const contradictions = candidates.slice(0, MAX_CONTRADICTIONS).map(
		(candidate): SubagentBatchContradiction => ({
			taskIdA: boundText(candidate.taskIdA, CLAIM_LIMIT_CHARS),
			taskIdB: boundText(candidate.taskIdB, CLAIM_LIMIT_CHARS),
			kind: candidate.kind,
			summaryA: candidate.summaryA,
			summaryB: candidate.summaryB,
		}),
	);

	return deepFreeze({
		counts,
		coverage: coverage.map(
			(row): SubagentBatchSynthesisCoverageRow => ({
				taskId: boundText(row.taskId, CLAIM_LIMIT_CHARS),
				status: row.status,
				verifiedCriteria: row.verifiedCriteria,
				unresolvedCriteria: row.unresolvedCriteria,
				evidencePathCount: row.evidencePathCount,
			}),
		),
		evidenceOverlap: evidenceOverlap.map(
			(pair): SubagentBatchEvidenceOverlapPair => ({
				taskIdA: boundText(pair.taskIdA, CLAIM_LIMIT_CHARS),
				taskIdB: boundText(pair.taskIdB, CLAIM_LIMIT_CHARS),
				sharedPaths: pair.sharedPaths.map((path) => boundText(path, CLAIM_LIMIT_CHARS)),
			}),
		),
		contradictions,
	});
}

/**
 * Project V2 snapshots into the legacy pure summarizer's bounded structural input.
 * Criterion identities are task-local, so compare requirements by normalized text
 * rather than positional IDs such as `criterion-1` that can mean different things
 * in different sibling tasks.
 */
export function summarizeV2BatchSynthesis(results: readonly V2BatchSynthesisResult[]): SubagentBatchSynthesis {
	return summarizeBatchSynthesis(
		results.map((result) => ({
			taskId: result.id,
			result: {
				status: result.outcome,
				evidence: { paths: result.validation?.paths ?? [] },
				findings: result.validation?.findings,
				requirementStates: (result.validation?.requirements ?? []).map((requirement) => ({
					id: synthesisCriterionId(requirement.requirement),
					required: requirement.required,
					verified: requirement.verified,
					...(requirement.claim !== undefined ? { claim: requirement.claim } : {}),
				})),
			},
		})),
	);
}

function synthesisCriterionId(requirement: string): string {
	const normalized = redactCredentialText(requirement.trim().replace(/\s+/g, " ")).toLowerCase();
	return `criterion-${createHash("sha256").update(normalized).digest("hex")}`;
}

function classifyStatus(status: string | undefined): SubagentBatchSynthesisStatus {
	if (status === "completed") return "completed";
	if (status === "failed") return "failed";
	return "other";
}

function sharedPathsBetween(a: SubagentBatchSynthesisItem, b: SubagentBatchSynthesisItem): string[] {
	const aPaths = new Set(a.result?.evidence?.paths ?? []);
	const seen = new Set<string>();
	const shared: string[] = [];
	for (const path of b.result?.evidence?.paths ?? []) {
		if (!aPaths.has(path) || seen.has(path)) continue;
		seen.add(path);
		shared.push(path);
	}
	shared.sort();
	return shared.slice(0, MAX_SHARED_PATHS_PER_PAIR);
}

/**
 * Conservative finding-claim contradiction: both findings must be severity
 * "high" (the strongest severity in the vocabulary), share one normalized
 * category, and carry opposite polarity (exactly one claim carries a
 * hedging/negative marker). At most one candidate per category per pair.
 */
function findingContradictionCandidates(
	a: SubagentBatchSynthesisItem,
	b: SubagentBatchSynthesisItem,
): ContradictionCandidate[] {
	const aByCategory = highFindingsByCategory(a.result?.findings);
	const bByCategory = highFindingsByCategory(b.result?.findings);
	const candidates: ContradictionCandidate[] = [];
	for (const [category, aFinding] of aByCategory) {
		const bFinding = bByCategory.get(category);
		if (bFinding === undefined) continue;
		if (hasNegativePolarity(aFinding.claim) === hasNegativePolarity(bFinding.claim)) continue;
		candidates.push({
			taskIdA: a.taskId,
			taskIdB: b.taskId,
			kind: "finding_claim",
			sortKey: category,
			summaryA: summarizeFindingClaim(category, aFinding.claim),
			summaryB: summarizeFindingClaim(category, bFinding.claim),
		});
	}
	return candidates;
}

function highFindingsByCategory(findings: readonly ReviewFinding[] | undefined): Map<string, ReviewFinding> {
	const byCategory = new Map<string, ReviewFinding>();
	for (const finding of findings ?? []) {
		if (finding.severity !== "high") continue;
		const category = normalizeCategory(finding.category);
		if (!byCategory.has(category)) byCategory.set(category, finding);
	}
	return byCategory;
}

function normalizeCategory(category: string): string {
	return normalizeWhitespace(category).toLowerCase();
}

function hasNegativePolarity(claim: string): boolean {
	const lowered = claim.toLowerCase();
	return NEGATIVE_POLARITY_MARKERS.some((marker) => lowered.includes(marker));
}

function summarizeFindingClaim(category: string, claim: string): string {
	return boundText(`${category}: ${claim}`, CLAIM_LIMIT_CHARS);
}

/**
 * Requirement-claim contradiction: the same criterion id is verified by one
 * child and not verified by another. Both-unverified and both-verified pairs
 * are never contradictions.
 */
function requirementContradictionCandidates(
	a: SubagentBatchSynthesisItem,
	b: SubagentBatchSynthesisItem,
): ContradictionCandidate[] {
	const aStates = requirementStatesById(a.result?.requirementStates);
	const bStates = requirementStatesById(b.result?.requirementStates);
	const candidates: ContradictionCandidate[] = [];
	for (const [id, aState] of aStates) {
		const bState = bStates.get(id);
		if (bState === undefined) continue;
		const aVerified = aState.verified === true;
		const bVerified = bState.verified === true;
		if (aVerified === bVerified) continue;
		candidates.push({
			taskIdA: a.taskId,
			taskIdB: b.taskId,
			kind: "requirement_claim",
			sortKey: id,
			summaryA: summarizeRequirementState(id, aState),
			summaryB: summarizeRequirementState(id, bState),
		});
	}
	return candidates;
}

function requirementStatesById(
	states: readonly { id: string; required: boolean; verified: boolean; claim?: string }[] | undefined,
): Map<string, { verified: boolean; claim?: string }> {
	const byId = new Map<string, { verified: boolean; claim?: string }>();
	for (const state of states ?? []) {
		const id = state.id.trim();
		if (id.length === 0 || byId.has(id)) continue;
		byId.set(id, { verified: state.verified === true, claim: state.claim });
	}
	return byId;
}

function summarizeRequirementState(id: string, state: { verified: boolean; claim?: string }): string {
	const verified = state.verified ? "verified" : "unverified";
	const claim = typeof state.claim === "string" && state.claim.length > 0 ? ` (claim: ${state.claim})` : "";
	return boundText(`criterion ${id}: ${verified}${claim}`, CLAIM_LIMIT_CHARS);
}

function boundText(text: string, limitChars: number): string {
	const redacted = redactCredentialText(text);
	const chars = Array.from(redacted);
	if (chars.length <= limitChars) return redacted;
	const keep = Math.max(0, limitChars - CLAIM_TRUNCATION_SUFFIX.length);
	return `${chars.slice(0, keep).join("")}${CLAIM_TRUNCATION_SUFFIX}`;
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		Object.freeze(value);
		for (const key of Object.keys(value as Record<string, unknown>)) {
			deepFreeze((value as Record<string, unknown>)[key]);
		}
	}
	return value;
}

/**
 * Render a deterministic, redacted, UTF-8-safe markdown-ish section for the
 * parent. Output never exceeds 4 KiB. Disagreements are framed as preserved
 * input for parent synthesis, never averaged away.
 */
export function renderBatchSynthesisSection(synthesis: SubagentBatchSynthesis): string {
	const counts = synthesis.counts;
	const lines: string[] = [
		"## Subagent batch synthesis",
		"",
		`children: ${counts.total} total, ${counts.completed} completed, ${counts.failed} failed, ${counts.other} other`,
		"",
		"coverage:",
	];
	if (synthesis.coverage.length === 0) {
		lines.push("- none");
	}
	for (const row of synthesis.coverage) {
		const criteria = row.verifiedCriteria + row.unresolvedCriteria;
		lines.push(
			`- ${redactCredentialText(row.taskId)}: ${row.status}; criteria ${row.verifiedCriteria}/${criteria} verified; evidence paths ${row.evidencePathCount}`,
		);
	}
	lines.push("", "evidence overlap:");
	if (synthesis.evidenceOverlap.length === 0) {
		lines.push("- none");
	}
	for (const pair of synthesis.evidenceOverlap) {
		const paths = pair.sharedPaths.map((path) => redactCredentialText(path)).join(", ");
		lines.push(
			`- ${redactCredentialText(pair.taskIdA)} <-> ${redactCredentialText(pair.taskIdB)}: ${pair.sharedPaths.length} shared paths (${paths})`,
		);
	}
	lines.push("", "contradictions (disagreement is preserved for parent synthesis; never averaged away):");
	if (synthesis.contradictions.length === 0) {
		lines.push("- none");
	}
	for (const contradiction of synthesis.contradictions) {
		const idA = redactCredentialText(contradiction.taskIdA);
		const idB = redactCredentialText(contradiction.taskIdB);
		lines.push(
			`- ${idA} <-> ${idB} [${contradiction.kind}]: "${redactCredentialText(contradiction.summaryA)}" vs "${redactCredentialText(contradiction.summaryB)}"`,
		);
	}
	return truncateSectionUtf8(`${lines.join("\n")}\n`);
}

function truncateSectionUtf8(text: string): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= SECTION_LIMIT_BYTES) return text;
	const markerBytes = Buffer.byteLength(SECTION_TRUNCATION_MARKER, "utf8");
	let end = Math.max(0, SECTION_LIMIT_BYTES - markerBytes);
	while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}${SECTION_TRUNCATION_MARKER}`;
}
