import { randomUUID } from "node:crypto";
import { rmdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "./config.ts";
import { matchesEntryType } from "./core/legacy-compat/identity.ts";
import { SUBAGENT_CONCURRENCY_LIMITS, type SubagentConcurrencyAdmission } from "./ice-subagent-concurrency.ts";
import type { IceModelCandidateSkip, IceSubagentRouteSnapshot } from "./ice-subagent-routing.ts";
import type { IceHookDispatchRecord } from "./ice-subagent-settings.ts";
import type {
	ReviewFinding,
	SubagentFailureCode,
	SubagentReportArtifact,
	SubagentReportMode,
	SubagentResult,
	SubagentUsage,
	SubagentVerification,
} from "./ice-subagents.ts";
import { redactCredentialText } from "./utils/redact.ts";

export const JOB_ENTRY_TYPE = "ice-subagent-job-v1";
export const JOB_COMPLETION_MESSAGE_TYPE = "ice-subagent-job-completion";
export const SUBAGENT_JOB_RETENTION_LIMIT = 32;
/** Default active background jobs; derived from the canonical concurrency policy. */
export const SUBAGENT_JOB_DEFAULT_CONCURRENCY = SUBAGENT_CONCURRENCY_LIMITS.bundledDefault;
/** Hard ceiling for active background jobs; shared admission may cap lower. */
export const SUBAGENT_JOB_MAX_CONCURRENCY = SUBAGENT_CONCURRENCY_LIMITS.hardCap;
export const SUBAGENT_JOB_QUEUE_LIMIT = 8;
export const SUBAGENT_JOB_OWNER_OUTPUT_BUDGET = 256 * 1024;
export const SUBAGENT_JOB_DEFAULT_OUTPUT_BYTES = 24 * 1024;
const MAX_DURABLE_DIAGNOSTIC_BYTES = 1024;
const MAX_DURABLE_SUMMARY_BYTES = 24 * 1024;
const MAX_DURABLE_VERIFICATION_REASON_BYTES = 1024;
const MAX_DURABLE_SNAPSHOT_BYTES = 64 * 1024;

export type SubagentJobStatus =
	| "created"
	| "queued"
	| "running"
	| "needs_time"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "verification_failed"
	| "interrupted";

export type TerminalSubagentJobStatus = Exclude<SubagentJobStatus, "created" | "queued" | "running" | "needs_time">;

export interface SubagentJobContract {
	capabilities?: readonly { name: string; origin: string; fingerprint: string }[];
	resourcesHash?: string;
	route?: IceSubagentRouteSnapshot;
	thinking: string;
	timeoutMs: number;
	maxOutputBytes: number;
	temperature?: number;
	topP?: number;
	tools: readonly string[];
	sourceHash?: string;
	/** Deterministic model candidates tried at admission (primary, fallback); parent is implicit. */
	modelCandidates?: readonly string[];
	/** Bounded availability reasons for candidates skipped before selection. */
	modelCandidateSkips?: readonly IceModelCandidateSkip[];
	/** Exact selected MCP tools (server/tool), if any. */
	mcpTools?: readonly string[];
}

export interface SubagentJobRecord {
	schemaVersion: 1;
	jobId: string;
	ownerSessionId: string;
	launchLeafId: string | null;
	role: string;
	model?: string;
	contract?: SubagentJobContract;
	status: SubagentJobStatus;
	createdAt: string;
	queuedAt?: string;
	queueOrder?: number;
	plannedOutputBytes?: number;
	reservedOutputBytes?: number;
	startedAt?: string;
	finishedAt?: string;
	runId?: string;
	resultRef: string;
}

export interface SubagentJobResultEnvelope {
	schemaVersion: 1;
	jobId: string;
	runId?: string;
	status: TerminalSubagentJobStatus;
	summary?: string;
	/** How the final answer was ingested; absent in snapshots persisted before this field existed. */
	reportMode?: SubagentReportMode;
	evidence?: {
		paths: readonly string[];
	};
	findings?: readonly ReviewFinding[];
	verification?: {
		verified: boolean;
		reason: string;
		/** Present for snapshots persisted after this field existed. */
		kind?: "structured" | "plain_bounds";
		structuredVerified?: boolean;
	};
	/** Optional bounded custom payload from the validated child report. */
	payload?: Readonly<Record<string, unknown>>;
	observedTurns?: number;
	/** Bounded parent-owned hook outcomes; never contains raw hook payloads. */
	hookRecords?: readonly IceHookDispatchRecord[];
	usage?: SubagentUsage;
	diagnostics: readonly {
		code: string;
		message?: string;
	}[];
	/** Runtime-owned bounded work projection preserved across report-protocol failures. */
	workArtifact?: SubagentJobWorkArtifactView;
	/** Stable local pointer for an oversized final or partial assistant capture. */
	reportArtifact?: SubagentReportArtifact;
}

export interface SubagentJobWorkArtifactView {
	schemaVersion: 1;
	observedOutputBytes: number;
	touchedPaths: readonly string[];
	candidateEvidencePaths: readonly string[];
	reportProtocol: {
		status: "valid" | "malformed" | "missing" | "truncated" | "plain";
		diagnostic?: string;
	};
	lastActivities?: readonly {
		toolName: string;
		action?: string;
		status: string;
		exitCode?: number;
		errorClass?: string;
	}[];
}

/**
 * Bounded terminal tombstone retained after full result retention expires so an
 * owner can distinguish "expired from retention" from an unknown job ID.
 */
export interface SubagentJobTombstone {
	jobId: string;
	terminalStatus: TerminalSubagentJobStatus;
	finishedAt?: string;
	expiredAt: string;
}

export interface PersistedSubagentJobSnapshot {
	schemaVersion: 1;
	sequence: number;
	job: SubagentJobRecord;
	result?: SubagentJobResultEnvelope;
}

export interface SubagentJobRunResult {
	result: SubagentResult;
	verification: SubagentVerification;
}

export interface SubagentJobInspection {
	job: Readonly<SubagentJobRecord>;
	queuePosition?: number;
	budget?: Readonly<{
		plannedOutputBytes: number;
		reservedOutputBytes: number;
		ownerReservedOutputBytes: number;
		ownerBudgetBytes: number;
		/** Present when a shared admission coordinator bounds active jobs. */
		ownerActiveJobs?: number;
		/** Number of queued jobs owned by this registry at the inspection boundary. */
		ownerQueuedJobs?: number;
		ownerActiveJobsCap?: number;
	}>;
	result?: Readonly<SubagentJobResultEnvelope>;
	/** Present when the full result expired from retention; final status stays visible. */
	tombstone?: Readonly<SubagentJobTombstone>;
}

export interface SubagentJobAccepted {
	jobId: string;
	status: "created" | "queued" | "running";
	resultRef: string;
}

export type SubagentJobFailureCode =
	| "background_job_active"
	| "queue_full"
	| "job_budget_exhausted"
	| "job_not_found"
	| "job_persistence_failure"
	| "job_invalid";

export class SubagentJobError extends Error {
	readonly code: SubagentJobFailureCode;

	constructor(code: SubagentJobFailureCode, message: string) {
		super(message);
		this.name = "SubagentJobError";
		this.code = code;
	}
}

interface SubagentJobRegistryOptions {
	ownerSessionId: string;
	persist: (snapshot: PersistedSubagentJobSnapshot) => void;
	notify: (jobId: string) => void;
	now?: () => Date;
	maxActiveJobs?: number;
	maxQueuedJobs?: number;
	maxAggregateOutputBytes?: number;
	/** Parent-owned root under which runtime report artifacts are generated. */
	reportArtifactRoot?: string;
	/** Shared permit accounting across batch and job admission; optional for legacy consumers. */
	admission?: SubagentConcurrencyAdmission;
}

interface JobState {
	job: SubagentJobRecord;
	result?: SubagentJobResultEnvelope;
}

interface LiveJob extends JobState {
	controller: AbortController;
	run: (signal: AbortSignal) => Promise<SubagentJobRunResult>;
	promise?: Promise<void>;
	requestedStop?: "cancelled" | "interrupted";
	settled?: boolean;
	/** Set while this job holds a shared admission permit; released exactly once. */
	holdsPermit?: boolean;
}

interface JobEntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

const JOB_STATUSES = new Set<SubagentJobStatus>([
	"created",
	"queued",
	"running",
	"needs_time",
	"completed",
	"failed",
	"cancelled",
	"timed_out",
	"verification_failed",
	"interrupted",
]);
const TERMINAL_STATUSES = new Set<TerminalSubagentJobStatus>([
	"completed",
	"failed",
	"cancelled",
	"timed_out",
	"verification_failed",
	"interrupted",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJobId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const redacted = redactCredentialText(value);
	const bytes = Buffer.from(redacted);
	if (bytes.length <= maxBytes) return redacted;
	let end = maxBytes;
	while (end > 0 && bytes.subarray(0, end).toString("utf8").endsWith("\ufffd")) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function boundedPath(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096 ? value : undefined;
}

function cloneUsage(usage: SubagentUsage | undefined): SubagentUsage | undefined {
	if (!usage) return undefined;
	if (
		![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.cost].every(
			(value) => Number.isFinite(value) && value >= 0,
		)
	) {
		return undefined;
	}
	return { ...usage };
}

function cloneFinding(finding: ReviewFinding): ReviewFinding | undefined {
	if (
		(finding.severity !== "low" && finding.severity !== "medium" && finding.severity !== "high") ||
		typeof finding.category !== "string" ||
		typeof finding.claim !== "string" ||
		!Array.isArray(finding.evidence) ||
		finding.evidence.length === 0 ||
		finding.evidence.length > 16
	) {
		return undefined;
	}
	const evidence = finding.evidence.map((reference) => {
		const path = isRecord(reference) ? boundedPath(reference.path) : undefined;
		return path ? { path } : undefined;
	});
	if (evidence.some((reference) => reference === undefined)) return undefined;
	const category = boundedText(finding.category, 256);
	const claim = boundedText(finding.claim, 8 * 1024);
	if (!category || !claim) return undefined;
	return {
		severity: finding.severity,
		category,
		claim,
		evidence: evidence as { path: string }[],
	};
}

function cloneFindingDeep(finding: ReviewFinding): ReviewFinding {
	const cloned = cloneFinding(finding);
	if (!cloned) throw new Error("Invalid durable review finding.");
	return Object.freeze({
		...cloned,
		evidence: Object.freeze(cloned.evidence.map((reference) => Object.freeze({ path: reference.path }))),
	}) as unknown as ReviewFinding;
}

function cloneBoundedPayload(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (!isRecord(value)) return undefined;
	const visit = (input: unknown, depth: number): unknown => {
		if (depth > 5) return "[TRUNCATED]";
		if (typeof input === "string") return redactCredentialText(input).slice(0, 8 * 1024);
		if (input === null || typeof input === "boolean") return input;
		if (typeof input === "number") return Number.isFinite(input) ? input : "[REDACTED]";
		if (Array.isArray(input)) return input.slice(0, 64).map((entry) => visit(entry, depth + 1));
		if (isRecord(input)) {
			return Object.fromEntries(
				Object.entries(input)
					.slice(0, 16)
					.map(([key, entry]) => [key.slice(0, 64), visit(entry, depth + 1)]),
			);
		}
		return "[REDACTED]";
	};
	const bounded = visit(value, 0);
	if (!isRecord(bounded)) return undefined;
	try {
		if (Buffer.byteLength(JSON.stringify(bounded)) > 16 * 1024) return undefined;
	} catch {
		return undefined;
	}
	return Object.freeze(bounded);
}

function cloneHookRecords(
	records: readonly IceHookDispatchRecord[] | undefined,
): readonly IceHookDispatchRecord[] | undefined {
	if (!records) return undefined;
	return Object.freeze(
		records.slice(0, 64).map((record) =>
			Object.freeze({
				eventId: boundedText(record.eventId, 128) ?? "unknown",
				ownerSessionId: boundedText(record.ownerSessionId, 128) ?? "unknown",
				runId: boundedText(record.runId, 128) ?? "unknown",
				...(record.attempt === 1 || record.attempt === 2 ? { attempt: record.attempt } : {}),
				hookId: boundedText(record.hookId, 128) ?? "unknown",
				event: record.event,
				outcome: record.outcome,
				required: record.required === true,
				...(boundedText(record.reason, 1024) ? { reason: boundedText(record.reason, 1024) } : {}),
				durationMs: Number.isSafeInteger(record.durationMs) && record.durationMs >= 0 ? record.durationMs : 0,
				observational: record.observational === true,
			}),
		),
	);
}

function cloneResult(result: SubagentJobResultEnvelope): SubagentJobResultEnvelope {
	const { budget: _legacyBudget, ...resultWithoutLegacyBudget } = result as SubagentJobResultEnvelope & {
		budget?: unknown;
	};
	return Object.freeze({
		...resultWithoutLegacyBudget,
		...(result.summary ? { summary: result.summary } : {}),
		...(result.evidence ? { evidence: Object.freeze({ paths: Object.freeze([...result.evidence.paths]) }) } : {}),
		...(result.findings ? { findings: Object.freeze(result.findings.map(cloneFindingDeep)) } : {}),
		...(result.verification ? { verification: Object.freeze({ ...result.verification }) } : {}),
		...(result.payload ? { payload: cloneBoundedPayload(result.payload) } : {}),
		...(result.observedTurns !== undefined ? { observedTurns: result.observedTurns } : {}),
		...(result.reportArtifact ? { reportArtifact: Object.freeze({ ...result.reportArtifact }) } : {}),
		...(cloneHookRecords(result.hookRecords) ? { hookRecords: cloneHookRecords(result.hookRecords) } : {}),
		...(result.usage ? { usage: Object.freeze({ ...result.usage }) } : {}),
		diagnostics: Object.freeze(result.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
	});
}

function cloneJob(job: SubagentJobRecord): SubagentJobRecord {
	return Object.freeze({
		...job,
		...(job.contract
			? {
					contract: Object.freeze({
						...job.contract,
						...(job.contract.route ? { route: Object.freeze({ ...job.contract.route }) } : {}),
						...(job.contract.capabilities
							? {
									capabilities: Object.freeze(
										job.contract.capabilities.map((item) => Object.freeze({ ...item })),
									),
								}
							: {}),
						tools: Object.freeze([...job.contract.tools]),
						...(job.contract.modelCandidates
							? { modelCandidates: Object.freeze([...job.contract.modelCandidates]) }
							: {}),
						...(job.contract.modelCandidateSkips
							? {
									modelCandidateSkips: Object.freeze(
										job.contract.modelCandidateSkips.map((skip) => Object.freeze({ ...skip })),
									),
								}
							: {}),
						...(job.contract.mcpTools ? { mcpTools: Object.freeze([...job.contract.mcpTools]) } : {}),
					}),
				}
			: {}),
	});
}

function cloneInspection(
	state: JobState,
	metadata?: { queuePosition?: number; budget?: SubagentJobInspection["budget"] },
): SubagentJobInspection {
	return Object.freeze({
		job: cloneJob(state.job),
		...(metadata?.queuePosition !== undefined ? { queuePosition: metadata.queuePosition } : {}),
		...(metadata?.budget ? { budget: Object.freeze({ ...metadata.budget }) } : {}),
		...(state.result ? { result: cloneResult(state.result) } : {}),
	});
}

function isTerminal(status: SubagentJobStatus): status is TerminalSubagentJobStatus {
	return TERMINAL_STATUSES.has(status as TerminalSubagentJobStatus);
}

function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function validUsage(value: unknown): value is SubagentUsage {
	if (!isRecord(value)) return false;
	return ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost"].every(
		(key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0,
	);
}

function isCanonicalFinding(value: unknown): value is ReviewFinding {
	if (
		!isRecord(value) ||
		typeof value.category !== "string" ||
		typeof value.claim !== "string" ||
		!Array.isArray(value.evidence)
	) {
		return false;
	}
	const finding = value as unknown as ReviewFinding;
	const cloned = cloneFinding(finding);
	return (
		cloned !== undefined &&
		boundedText(value.category, 256) === value.category &&
		boundedText(value.claim, 8 * 1024) === value.claim &&
		value.evidence.length >= 1 &&
		value.evidence.length <= 16 &&
		value.evidence.every((reference) => isRecord(reference) && boundedPath(reference.path) === reference.path)
	);
}

function validReportArtifact(
	value: unknown,
	reportArtifactRoot: string,
	expectedRunId?: string,
): value is SubagentReportArtifact {
	if (!isRecord(value) || value.schemaVersion !== 1) return false;
	if (
		typeof value.id !== "string" ||
		!isJobId(value.id) ||
		typeof value.path !== "string" ||
		value.path.length === 0 ||
		Buffer.byteLength(value.path) > 4096 ||
		typeof value.bytes !== "number" ||
		!Number.isSafeInteger(value.bytes) ||
		value.bytes < 1 ||
		value.bytes > 512 * 1024 ||
		typeof value.originalBytes !== "number" ||
		!Number.isSafeInteger(value.originalBytes) ||
		value.originalBytes < value.bytes ||
		typeof value.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.sha256) ||
		(value.contentType !== "text/plain" && value.contentType !== "application/json") ||
		typeof value.truncated !== "boolean"
	)
		return false;
	if (expectedRunId !== undefined && value.id !== expectedRunId) return false;
	if (!isAbsolute(value.path)) return false;
	const extension = value.contentType === "application/json" ? "json" : "txt";
	const expectedPath = join(resolve(reportArtifactRoot), value.id, `report.${extension}`);
	// Restore intentionally does not dereference this path: retention or an
	// interrupted cleanup may make a valid historical artifact unavailable.
	// Any future reader must revalidate the filesystem object immediately before use.
	return value.path === expectedPath;
}

function removeRetainedReportArtifact(
	value: SubagentReportArtifact,
	reportArtifactRoot: string,
	expectedRunId: string | undefined,
): void {
	if (!validReportArtifact(value, reportArtifactRoot, expectedRunId)) return;
	try {
		unlinkSync(value.path);
	} catch {
		return;
	}
	try {
		rmdirSync(dirname(value.path));
	} catch {
		// The artifact file is already gone; a non-empty or concurrently changed
		// run directory is retained rather than recursively deleted.
	}
}

function validWorkArtifactView(value: unknown): value is SubagentJobWorkArtifactView {
	if (!isRecord(value) || value.schemaVersion !== 1) return false;
	if (
		typeof value.observedOutputBytes !== "number" ||
		!Number.isSafeInteger(value.observedOutputBytes) ||
		value.observedOutputBytes < 0
	)
		return false;
	if (
		!Array.isArray(value.touchedPaths) ||
		value.touchedPaths.length > 64 ||
		value.touchedPaths.some((path) => boundedPath(path) === undefined)
	)
		return false;
	if (
		!Array.isArray(value.candidateEvidencePaths) ||
		value.candidateEvidencePaths.length > 16 ||
		value.candidateEvidencePaths.some((path) => boundedPath(path) === undefined)
	)
		return false;
	if (!isRecord(value.reportProtocol)) return false;
	const status = value.reportProtocol.status;
	if (
		status !== "valid" &&
		status !== "malformed" &&
		status !== "missing" &&
		status !== "truncated" &&
		status !== "plain"
	)
		return false;
	if (
		value.reportProtocol.diagnostic !== undefined &&
		boundedText(value.reportProtocol.diagnostic, MAX_DURABLE_DIAGNOSTIC_BYTES) !== value.reportProtocol.diagnostic
	)
		return false;
	if (value.lastActivities !== undefined) {
		if (!Array.isArray(value.lastActivities) || value.lastActivities.length > 12) return false;
		for (const activity of value.lastActivities) {
			if (!isRecord(activity) || typeof activity.toolName !== "string" || activity.toolName.length === 0)
				return false;
			if (Buffer.byteLength(activity.toolName) > 128) return false;
			if (activity.action !== undefined && boundedText(activity.action, 512) !== activity.action) return false;
			if (
				typeof activity.status !== "string" ||
				activity.status.length === 0 ||
				Buffer.byteLength(activity.status) > 32
			)
				return false;
			if (
				activity.exitCode !== undefined &&
				(typeof activity.exitCode !== "number" || !Number.isSafeInteger(activity.exitCode))
			)
				return false;
			if (activity.errorClass !== undefined && boundedText(activity.errorClass, 128) !== activity.errorClass)
				return false;
		}
	}
	return true;
}

function validResultEnvelope(
	value: unknown,
	jobId: string,
	reportArtifactRoot: string,
): value is SubagentJobResultEnvelope {
	if (!isRecord(value) || value.schemaVersion !== 1 || value.jobId !== jobId) return false;
	if (value.runId !== undefined && !isJobId(value.runId)) return false;
	if (typeof value.status !== "string" || !TERMINAL_STATUSES.has(value.status as TerminalSubagentJobStatus))
		return false;
	if (value.summary !== undefined && boundedText(value.summary, MAX_DURABLE_SUMMARY_BYTES) !== value.summary)
		return false;
	if (value.evidence !== undefined) {
		if (!isRecord(value.evidence) || !Array.isArray(value.evidence.paths) || value.evidence.paths.length > 64)
			return false;
		if (value.evidence.paths.some((path) => boundedPath(path) === undefined)) return false;
	}
	if (value.findings !== undefined) {
		if (!Array.isArray(value.findings) || value.findings.length > 32) return false;
		if (value.findings.some((finding) => !isCanonicalFinding(finding))) return false;
	}
	if (value.verification !== undefined) {
		if (
			!isRecord(value.verification) ||
			typeof value.verification.verified !== "boolean" ||
			boundedText(value.verification.reason, MAX_DURABLE_VERIFICATION_REASON_BYTES) !== value.verification.reason ||
			(value.verification.kind !== undefined &&
				value.verification.kind !== "structured" &&
				value.verification.kind !== "plain_bounds") ||
			(value.verification.structuredVerified !== undefined &&
				typeof value.verification.structuredVerified !== "boolean")
		) {
			return false;
		}
	}
	if (
		value.reportMode !== undefined &&
		value.reportMode !== "plain_final_turn" &&
		value.reportMode !== "structured_report"
	) {
		return false;
	}
	if (value.payload !== undefined) {
		if (!isRecord(value.payload)) return false;
		try {
			if (Buffer.byteLength(JSON.stringify(value.payload)) > 16 * 1024) return false;
		} catch {
			return false;
		}
	}
	if (
		value.observedTurns !== undefined &&
		(typeof value.observedTurns !== "number" || !Number.isSafeInteger(value.observedTurns) || value.observedTurns < 0)
	)
		return false;
	if (
		value.reportArtifact !== undefined &&
		(!validReportArtifact(value.reportArtifact, reportArtifactRoot, value.runId as string | undefined) ||
			value.runId === undefined)
	)
		return false;
	if (value.hookRecords !== undefined) {
		if (!Array.isArray(value.hookRecords) || value.hookRecords.length > 64) return false;
		if (
			value.hookRecords.some(
				(record) =>
					!isRecord(record) ||
					typeof record.eventId !== "string" ||
					(record.ownerSessionId !== undefined && typeof record.ownerSessionId !== "string") ||
					(record.runId !== undefined && typeof record.runId !== "string") ||
					(record.attempt !== undefined && record.attempt !== 1 && record.attempt !== 2) ||
					typeof record.hookId !== "string" ||
					typeof record.event !== "string" ||
					typeof record.outcome !== "string" ||
					!["continue", "deny", "ask"].includes(record.outcome) ||
					typeof record.required !== "boolean" ||
					typeof record.observational !== "boolean" ||
					typeof record.durationMs !== "number" ||
					!Number.isSafeInteger(record.durationMs) ||
					record.durationMs < 0 ||
					Buffer.byteLength(record.eventId) > 128 ||
					(record.ownerSessionId !== undefined && Buffer.byteLength(record.ownerSessionId) > 128) ||
					(record.runId !== undefined && Buffer.byteLength(record.runId) > 128) ||
					Buffer.byteLength(record.hookId) > 128 ||
					(record.reason !== undefined && boundedText(record.reason, 1024) !== record.reason),
			)
		)
			return false;
	}
	if (value.usage !== undefined && !validUsage(value.usage)) return false;
	if (value.workArtifact !== undefined && !validWorkArtifactView(value.workArtifact)) return false;
	if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 32) return false;
	return value.diagnostics.every(
		(diagnostic) =>
			isRecord(diagnostic) &&
			typeof diagnostic.code === "string" &&
			diagnostic.code.length > 0 &&
			diagnostic.code.length <= 128 &&
			(diagnostic.message === undefined ||
				boundedText(diagnostic.message, MAX_DURABLE_DIAGNOSTIC_BYTES) === diagnostic.message),
	);
}

function validJobRecord(value: unknown): value is SubagentJobRecord {
	if (!isRecord(value) || value.schemaVersion !== 1) return false;
	if (!isJobId(value.jobId) || typeof value.ownerSessionId !== "string" || value.ownerSessionId.length === 0)
		return false;
	if (value.launchLeafId !== null && !isJobId(value.launchLeafId)) return false;
	if (typeof value.role !== "string" || value.role.length === 0 || Buffer.byteLength(value.role) > 64) return false;
	if (value.model !== undefined && (typeof value.model !== "string" || Buffer.byteLength(value.model) > 512))
		return false;
	if (value.contract !== undefined) {
		const contract = value.contract;
		if (!isRecord(contract)) return false;
		if (
			contract.resourcesHash !== undefined &&
			(typeof contract.resourcesHash !== "string" || !/^[a-f0-9]{64}$/.test(contract.resourcesHash))
		)
			return false;
		if (
			contract.capabilities !== undefined &&
			(!Array.isArray(contract.capabilities) ||
				contract.capabilities.length > 48 ||
				contract.capabilities.some(
					(item) =>
						!isRecord(item) ||
						typeof item.name !== "string" ||
						item.name.length > 64 ||
						typeof item.origin !== "string" ||
						item.origin.length > 256 ||
						typeof item.fingerprint !== "string" ||
						!/^[a-f0-9]{64}$/.test(item.fingerprint),
				))
		)
			return false;
		if (contract.route !== undefined) {
			const route = contract.route;
			if (
				!isRecord(route) ||
				Object.keys(route).some((key) => !["provider", "modelId", "capabilityHash"].includes(key)) ||
				typeof route.provider !== "string" ||
				route.provider.length === 0 ||
				route.provider.length > 128 ||
				typeof route.modelId !== "string" ||
				route.modelId.length === 0 ||
				route.modelId.length > 256 ||
				typeof route.capabilityHash !== "string" ||
				!/^[a-f0-9]{64}$/.test(route.capabilityHash)
			)
				return false;
		}
		if (
			typeof contract.thinking !== "string" ||
			Buffer.byteLength(contract.thinking) > 16 ||
			(contract.temperature !== undefined &&
				(typeof contract.temperature !== "number" ||
					!Number.isFinite(contract.temperature) ||
					contract.temperature < 0 ||
					contract.temperature > 2)) ||
			(contract.topP !== undefined &&
				(typeof contract.topP !== "number" ||
					!Number.isFinite(contract.topP) ||
					contract.topP < 0 ||
					contract.topP > 1)) ||
			!["timeoutMs", "maxOutputBytes"].every(
				(key) => typeof contract[key] === "number" && Number.isSafeInteger(contract[key]) && contract[key] >= 0,
			) ||
			!Array.isArray(contract.tools) ||
			contract.tools.length > 64 ||
			contract.tools.some((tool) => typeof tool !== "string" || Buffer.byteLength(tool) > 64) ||
			(contract.sourceHash !== undefined &&
				(typeof contract.sourceHash !== "string" || Buffer.byteLength(contract.sourceHash) > 128)) ||
			(contract.modelCandidates !== undefined &&
				(!Array.isArray(contract.modelCandidates) ||
					contract.modelCandidates.length > 3 ||
					contract.modelCandidates.some(
						(candidate) =>
							typeof candidate !== "string" ||
							candidate.length === 0 ||
							candidate.length > 256 ||
							/[\s\x00-\x1f]/.test(candidate),
					))) ||
			(contract.modelCandidateSkips !== undefined &&
				(!Array.isArray(contract.modelCandidateSkips) ||
					contract.modelCandidateSkips.length > 2 ||
					contract.modelCandidateSkips.some(
						(skip) =>
							!isRecord(skip) ||
							typeof skip.reference !== "string" ||
							typeof skip.reason !== "string" ||
							Buffer.byteLength(skip.reference) > 256 ||
							Buffer.byteLength(skip.reason) > 256,
					))) ||
			(contract.mcpTools !== undefined &&
				(!Array.isArray(contract.mcpTools) ||
					contract.mcpTools.length > 16 ||
					contract.mcpTools.some(
						(tool) =>
							typeof tool !== "string" ||
							!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(tool) ||
							Buffer.byteLength(tool) > 256,
					)))
		)
			return false;
	}
	if (typeof value.status !== "string" || !JOB_STATUSES.has(value.status as SubagentJobStatus)) return false;
	const status = value.status as SubagentJobStatus;
	const queueOrder = value.queueOrder;
	const plannedOutputBytes = value.plannedOutputBytes;
	const reservedOutputBytes = value.reservedOutputBytes;
	if (!isIsoDate(value.createdAt)) return false;
	if (value.queuedAt !== undefined && !isIsoDate(value.queuedAt)) return false;
	if (
		queueOrder !== undefined &&
		(typeof queueOrder !== "number" || !Number.isSafeInteger(queueOrder) || queueOrder <= 0)
	)
		return false;
	if (
		plannedOutputBytes !== undefined &&
		(typeof plannedOutputBytes !== "number" ||
			!Number.isSafeInteger(plannedOutputBytes) ||
			plannedOutputBytes <= 0 ||
			plannedOutputBytes > SUBAGENT_JOB_OWNER_OUTPUT_BUDGET)
	)
		return false;
	if (
		reservedOutputBytes !== undefined &&
		(typeof reservedOutputBytes !== "number" ||
			!Number.isSafeInteger(reservedOutputBytes) ||
			reservedOutputBytes < 0 ||
			reservedOutputBytes > SUBAGENT_JOB_OWNER_OUTPUT_BUDGET)
	)
		return false;
	if (
		plannedOutputBytes !== undefined &&
		reservedOutputBytes !== undefined &&
		(typeof plannedOutputBytes !== "number" ||
			typeof reservedOutputBytes !== "number" ||
			reservedOutputBytes > plannedOutputBytes)
	)
		return false;
	if (value.startedAt !== undefined && !isIsoDate(value.startedAt)) return false;
	if (value.finishedAt !== undefined && !isIsoDate(value.finishedAt)) return false;
	if (value.runId !== undefined && !isJobId(value.runId)) return false;
	if ((status === "created" || status === "queued") && value.runId !== undefined) return false;
	if (status === "created" && (value.startedAt !== undefined || value.finishedAt !== undefined)) return false;
	if (status === "queued" && (value.startedAt !== undefined || value.finishedAt !== undefined)) return false;
	if (status === "running" && (value.startedAt === undefined || value.finishedAt !== undefined)) return false;
	if (
		status === "needs_time" &&
		(value.startedAt === undefined || value.finishedAt !== undefined || value.runId === undefined)
	)
		return false;
	if (
		(status === "completed" || status === "failed" || status === "timed_out" || status === "verification_failed") &&
		(value.startedAt === undefined || value.finishedAt === undefined)
	)
		return false;
	if (status === "cancelled" && value.finishedAt === undefined) return false;
	if (status === "interrupted" && value.finishedAt === undefined) return false;
	if (isTerminal(status) && reservedOutputBytes !== undefined && reservedOutputBytes !== 0) return false;
	return value.resultRef === `job:${value.jobId}`;
}

function normalizePersistedSnapshot(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const normalized: Record<string, unknown> = { ...value };
	let changed = false;
	if (isRecord(normalized.job)) {
		const job = { ...normalized.job };
		if (isRecord(job.contract)) {
			const obsoleteKeys = new Set(["maxTotalTokens", "maxTurns", "maxToolCalls"]);
			const contract = Object.fromEntries(Object.entries(job.contract).filter(([key]) => !obsoleteKeys.has(key)));
			if (Object.keys(contract).length !== Object.keys(job.contract).length) {
				job.contract = contract;
				changed = true;
			}
		}
		if (changed) normalized.job = job;
	}
	if (isRecord(normalized.result) && Object.hasOwn(normalized.result, "budget")) {
		const { budget: _legacyBudget, ...result } = normalized.result;
		normalized.result = result;
		changed = true;
	}
	return changed ? normalized : value;
}

function validSnapshot(value: unknown, reportArtifactRoot: string): value is PersistedSubagentJobSnapshot {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		typeof value.sequence !== "number" ||
		!Number.isInteger(value.sequence) ||
		value.sequence <= 0
	)
		return false;
	if (!validJobRecord(value.job)) return false;
	if (value.result !== undefined && !validResultEnvelope(value.result, value.job.jobId, reportArtifactRoot))
		return false;
	if (isTerminal(value.job.status) !== (value.result !== undefined)) return false;
	if (value.result !== undefined && value.result.status !== value.job.status) return false;
	if (
		value.result !== undefined &&
		(value.result.runId !== undefined || value.job.runId !== undefined) &&
		value.result.runId !== value.job.runId
	) {
		return false;
	}
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_DURABLE_SNAPSHOT_BYTES;
	} catch {
		return false;
	}
}

function resultDiagnostics(
	result: SubagentResult | undefined,
	fallbackCode?: SubagentFailureCode | "output_truncated" | "job_runtime_failure",
	fallbackMessage?: string,
) {
	const diagnostics = result?.diagnostics ?? [];
	const projected: { code: string; message?: string }[] = diagnostics.slice(0, 32).map((diagnostic) => ({
		code: diagnostic.code,
		...(boundedText(diagnostic.message, MAX_DURABLE_DIAGNOSTIC_BYTES)
			? { message: boundedText(diagnostic.message, MAX_DURABLE_DIAGNOSTIC_BYTES) }
			: {}),
	}));
	if (fallbackCode) {
		projected.push({
			code: fallbackCode,
			...(fallbackMessage ? { message: boundedText(fallbackMessage, MAX_DURABLE_DIAGNOSTIC_BYTES) } : {}),
		});
	}
	return projected;
}

function projectResult(
	jobId: string,
	requestedStop: LiveJob["requestedStop"],
	runResult: SubagentJobRunResult | undefined,
	runtimeError?: unknown,
	retainedRunId?: string,
): SubagentJobResultEnvelope {
	const result = runResult?.result;
	let status: TerminalSubagentJobStatus;
	if (requestedStop) status = requestedStop;
	else if (!result) status = "failed";
	else if (result.status === "completed")
		status = runResult.verification.verified ? "completed" : "verification_failed";
	else if (result.status === "failed") status = "failed";
	else if (result.status === "cancelled") status = "cancelled";
	else if (result.status === "timed_out") status = "timed_out";
	else if (result.status === "verification_failed") status = "verification_failed";
	else status = "failed";

	const summary = boundedText(result?.summary, MAX_DURABLE_SUMMARY_BYTES);
	const trustedCompletion =
		status === "completed" && result?.status === "completed" && runResult?.verification.verified === true;
	const evidence = trustedCompletion
		? result.evidence?.paths
				.map((path) => boundedPath(path))
				.filter((path): path is string => path !== undefined)
				.slice(0, 64)
		: undefined;
	const findings = trustedCompletion
		? result.findings
				?.slice(0, 32)
				.map(cloneFinding)
				.filter((finding): finding is ReviewFinding => finding !== undefined)
		: undefined;
	const verification = runResult?.verification
		? {
				verified: runResult.verification.verified,
				reason:
					boundedText(runResult.verification.reason, MAX_DURABLE_VERIFICATION_REASON_BYTES) ??
					"Verification failed.",
				...(runResult.verification.kind !== undefined ? { kind: runResult.verification.kind } : {}),
				...(runResult.verification.structuredVerified !== undefined
					? { structuredVerified: runResult.verification.structuredVerified }
					: {}),
			}
		: undefined;
	const runtimeMessage =
		runtimeError instanceof Error ? runtimeError.message : runtimeError ? String(runtimeError) : undefined;
	const artifactView = projectWorkArtifactView(result);
	const reportArtifact = result?.reportArtifact ? Object.freeze({ ...result.reportArtifact }) : undefined;
	const hookRecords = cloneHookRecords(result?.hookRecords);
	return {
		schemaVersion: 1,
		jobId,
		...(result?.runId || retainedRunId ? { runId: result?.runId ?? retainedRunId } : {}),
		status,
		...(result?.reportMode !== undefined ? { reportMode: result.reportMode } : {}),
		...(summary ? { summary } : {}),
		...(evidence && evidence.length > 0 ? { evidence: { paths: evidence } } : {}),
		...(findings && findings.length > 0 ? { findings } : {}),
		...(verification ? { verification } : {}),
		...(cloneBoundedPayload(result?.payload) ? { payload: cloneBoundedPayload(result?.payload) } : {}),
		...(result?.observedTurns !== undefined ? { observedTurns: result.observedTurns } : {}),
		...(hookRecords ? { hookRecords } : {}),
		...(cloneUsage(result?.usage) ? { usage: cloneUsage(result?.usage) } : {}),
		...(artifactView ? { workArtifact: artifactView } : {}),
		...(reportArtifact ? { reportArtifact } : {}),
		diagnostics: resultDiagnostics(result, runtimeError ? "job_runtime_failure" : undefined, runtimeMessage),
	};
}

/**
 * Project the runtime-owned work artifact into the durable envelope when the
 * final report failed the protocol. Verified completions do not need it.
 */
function projectWorkArtifactView(result: SubagentResult | undefined): SubagentJobWorkArtifactView | undefined {
	const artifact = result?.workArtifact;
	if (!artifact || result?.status === "completed") return undefined;
	const boundedPaths = (paths: readonly string[], limit: number): string[] =>
		paths
			.map((path) => boundedPath(path))
			.filter((path): path is string => path !== undefined)
			.slice(0, limit);
	return {
		schemaVersion: 1,
		observedOutputBytes:
			typeof artifact.observedOutputBytes === "number" && Number.isSafeInteger(artifact.observedOutputBytes)
				? Math.max(0, artifact.observedOutputBytes)
				: 0,
		touchedPaths: boundedPaths(artifact.touchedPaths, 64),
		candidateEvidencePaths: boundedPaths(artifact.candidateEvidencePaths, 16),
		reportProtocol: {
			status: artifact.reportProtocol.status,
			...(artifact.reportProtocol.diagnostic
				? {
						diagnostic:
							boundedText(artifact.reportProtocol.diagnostic, MAX_DURABLE_DIAGNOSTIC_BYTES) ?? undefined,
					}
				: {}),
		},
		...(artifact.lastActivities.length > 0
			? {
					lastActivities: artifact.lastActivities.slice(-12).map((activity) => ({
						toolName: activity.toolName.slice(0, 128),
						...(activity.action ? { action: boundedText(activity.action, 512) } : {}),
						status: activity.status.slice(0, 32),
						...(activity.exitCode !== undefined ? { exitCode: activity.exitCode } : {}),
						...(activity.errorClass ? { errorClass: boundedText(activity.errorClass, 128) } : {}),
					})),
				}
			: {}),
	};
}

export class SubagentJobRegistry {
	private readonly ownerSessionId: string;
	private readonly persistSnapshot: (snapshot: PersistedSubagentJobSnapshot) => void;
	private readonly notifyCompletion: (jobId: string) => void;
	private readonly now: () => Date;
	private readonly maxActiveJobs: number;
	private readonly maxQueuedJobs: number;
	private readonly maxAggregateOutputBytes: number;
	private readonly reportArtifactRoot: string;
	private readonly admission?: SubagentConcurrencyAdmission;
	private readonly listeners = new Set<() => void>();
	private schedulerBlocked = false;
	private readonly records = new Map<string, JobState>();
	private readonly live = new Map<string, LiveJob>();
	private readonly tombstones = new Map<string, SubagentJobTombstone>();
	private readonly sequences = new Map<string, number>();
	private readonly order = new Map<string, number>();
	private orderCounter = 0;
	private reservedOutputBytes = 0;
	private pumping = false;
	private schedulerPauseDepth = 0;
	private shuttingDown = false;
	private shutdownPromise?: Promise<void>;

	constructor(options: SubagentJobRegistryOptions) {
		if (!options || typeof options.ownerSessionId !== "string" || options.ownerSessionId.length === 0) {
			throw new SubagentJobError("job_invalid", "Subagent job owner session ID must be nonempty.");
		}
		const maxActiveJobs = options.maxActiveJobs ?? SUBAGENT_JOB_DEFAULT_CONCURRENCY;
		const maxQueuedJobs = options.maxQueuedJobs ?? SUBAGENT_JOB_QUEUE_LIMIT;
		const maxAggregateOutputBytes = options.maxAggregateOutputBytes ?? SUBAGENT_JOB_OWNER_OUTPUT_BUDGET;
		const reportArtifactRoot = options.reportArtifactRoot ?? join(getAgentDir(), "artifacts", "subagent");
		if (
			typeof reportArtifactRoot !== "string" ||
			reportArtifactRoot.length === 0 ||
			Buffer.byteLength(reportArtifactRoot) > 4096
		) {
			throw new SubagentJobError("job_invalid", "Report artifact root must be a bounded path.");
		}
		if (!Number.isSafeInteger(maxActiveJobs) || maxActiveJobs < 1 || maxActiveJobs > SUBAGENT_JOB_MAX_CONCURRENCY) {
			throw new SubagentJobError(
				"job_invalid",
				`Active background job limit must be between 1 and ${SUBAGENT_JOB_MAX_CONCURRENCY}.`,
			);
		}
		if (!Number.isSafeInteger(maxQueuedJobs) || maxQueuedJobs < 0 || maxQueuedJobs > SUBAGENT_JOB_QUEUE_LIMIT) {
			throw new SubagentJobError(
				"job_invalid",
				`Queued background job limit must be between 0 and ${SUBAGENT_JOB_QUEUE_LIMIT}.`,
			);
		}
		if (
			!Number.isSafeInteger(maxAggregateOutputBytes) ||
			maxAggregateOutputBytes < 1 ||
			maxAggregateOutputBytes > SUBAGENT_JOB_OWNER_OUTPUT_BUDGET
		) {
			throw new SubagentJobError(
				"job_invalid",
				`Aggregate background output budget must be between 1 and ${SUBAGENT_JOB_OWNER_OUTPUT_BUDGET} bytes.`,
			);
		}
		this.ownerSessionId = options.ownerSessionId;
		this.persistSnapshot = options.persist;
		this.notifyCompletion = options.notify;
		this.now = options.now ?? (() => new Date());
		this.maxActiveJobs = maxActiveJobs;
		this.maxQueuedJobs = maxQueuedJobs;
		this.maxAggregateOutputBytes = maxAggregateOutputBytes;
		this.reportArtifactRoot = resolve(reportArtifactRoot);
		this.admission = options.admission;
		// Shared-admission wakeup: when a batch or another job releases a permit,
		// queued jobs may be promoted. Listeners are non-authoritative scheduling hints.
		this.admission?.onRelease(() => this.pump());
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	launch(input: {
		launchLeafId: string | null;
		role: string;
		model?: string;
		contract?: SubagentJobContract;
		plannedOutputBytes?: number;
		run: (signal: AbortSignal) => Promise<SubagentJobRunResult>;
	}): SubagentJobAccepted {
		if (this.shuttingDown) throw new SubagentJobError("job_invalid", "Subagent job registry is shutting down.");
		if (this.schedulerBlocked) {
			throw new SubagentJobError(
				"job_persistence_failure",
				"Background job scheduling is unavailable after a persistence failure.",
			);
		}
		if (typeof input.role !== "string" || input.role.length === 0 || typeof input.run !== "function") {
			throw new SubagentJobError("job_invalid", "Subagent job launch contract is invalid.");
		}
		const plannedOutputBytes = input.plannedOutputBytes ?? SUBAGENT_JOB_DEFAULT_OUTPUT_BYTES;
		if (!Number.isSafeInteger(plannedOutputBytes) || plannedOutputBytes <= 0) {
			throw new SubagentJobError("job_invalid", "Planned background output must be a positive safe integer.");
		}
		if (plannedOutputBytes > this.maxAggregateOutputBytes) {
			throw new SubagentJobError(
				"job_budget_exhausted",
				"Planned background output exceeds the owner aggregate budget.",
			);
		}
		if (this.reservedOutputBytes + plannedOutputBytes > this.maxAggregateOutputBytes) {
			throw new SubagentJobError("job_budget_exhausted", "Owner aggregate background output budget is exhausted.");
		}
		const active = this.activeCount();
		const queued = this.queuedCount();
		let admitted = active < this.maxActiveJobs;
		if (admitted && this.admission) admitted = this.admission.tryAcquire();
		const status: SubagentJobStatus = admitted ? "created" : "queued";
		if (status === "queued" && queued >= this.maxQueuedJobs) {
			throw new SubagentJobError("queue_full", "Owner background job queue is full.");
		}

		const jobId = randomUUID();
		const createdAt = this.now().toISOString();
		const queueOrder = ++this.orderCounter;
		const job: SubagentJobRecord = {
			schemaVersion: 1,
			jobId,
			ownerSessionId: this.ownerSessionId,
			launchLeafId: input.launchLeafId,
			role: input.role,
			...(input.model ? { model: input.model } : {}),
			...(input.contract ? { contract: structuredClone(input.contract) } : {}),
			status,
			createdAt,
			...(status === "queued" ? { queuedAt: createdAt } : {}),
			queueOrder,
			plannedOutputBytes,
			reservedOutputBytes: plannedOutputBytes,
			resultRef: `job:${jobId}`,
		};
		const createdState: JobState = { job };
		this.reservedOutputBytes += plannedOutputBytes;
		try {
			this.persistState(createdState);
		} catch (error) {
			this.reservedOutputBytes -= plannedOutputBytes;
			this.orderCounter--;
			if (admitted && this.admission) this.admission.release();
			throw error;
		}
		this.records.set(jobId, createdState);
		this.order.set(jobId, queueOrder);

		const live: LiveJob = {
			...createdState,
			controller: new AbortController(),
			run: input.run,
			...(admitted ? { holdsPermit: true } : {}),
		};
		this.live.set(jobId, live);
		this.publishChange();
		if (status === "created") {
			live.promise = Promise.resolve().then(() => this.start(live));
			void live.promise.catch(() => {});
		}
		return { jobId, status, resultRef: job.resultRef };
	}

	inspect(jobId: string, requesterSessionId = this.ownerSessionId): SubagentJobInspection {
		this.assertOwner(requesterSessionId);
		const state = this.records.get(jobId);
		if (state) return this.inspectionFor(state);
		// An accepted job ID must stay owner-inspectable even after its full result
		// expired from retention: report the bounded tombstone, not generic not-found.
		const tombstone = this.tombstones.get(jobId);
		if (tombstone) {
			return Object.freeze({
				job: cloneJob({
					schemaVersion: 1,
					jobId: tombstone.jobId,
					ownerSessionId: this.ownerSessionId,
					launchLeafId: null,
					role: "expired",
					status: tombstone.terminalStatus,
					createdAt: tombstone.expiredAt,
					...(tombstone.finishedAt ? { finishedAt: tombstone.finishedAt } : {}),
					resultRef: `job:${tombstone.jobId}`,
				}),
				tombstone: Object.freeze({ ...tombstone }),
			});
		}
		throw new SubagentJobError("job_not_found", "Subagent job was not found.");
	}

	async cancel(jobId: string, requesterSessionId = this.ownerSessionId): Promise<SubagentJobInspection> {
		this.assertOwner(requesterSessionId);
		const state = this.records.get(jobId);
		if (!state) throw new SubagentJobError("job_not_found", "Subagent job was not found.");
		const live = this.live.get(jobId);
		if (!live || isTerminal(state.job.status)) return this.inspectionFor(state);
		if (!live.requestedStop) live.requestedStop = "cancelled";
		if (state.job.status === "queued") {
			await this.settle(live);
			return this.inspect(jobId);
		}
		if (state.job.status === "needs_time") {
			live.controller.abort();
			await this.settle(live);
			return this.inspect(jobId);
		}
		live.controller.abort();
		await live.promise;
		return this.inspect(jobId);
	}

	async cancelSubset(jobIds: readonly string[], requesterSessionId = this.ownerSessionId): Promise<void> {
		this.assertOwner(requesterSessionId);
		const selected = [...new Set(jobIds)]
			.map((jobId) => this.live.get(jobId))
			.filter((live): live is LiveJob => live !== undefined && !live.settled && !isTerminal(live.job.status));
		if (selected.length === 0) return;

		this.schedulerPauseDepth++;
		try {
			for (const live of selected) {
				if (!live.requestedStop) live.requestedStop = "cancelled";
			}
			await Promise.all(selected.filter((live) => live.job.status === "queued").map((live) => this.settle(live)));
			const active = selected.filter(
				(live) =>
					!live.settled &&
					(live.job.status === "created" || live.job.status === "running" || live.job.status === "needs_time"),
			);
			for (const live of active) live.controller.abort();
			await Promise.all(active.filter((live) => live.job.status === "needs_time").map((live) => this.settle(live)));
			await Promise.all(
				active.filter((live) => live.job.status !== "needs_time").map((live) => live.promise ?? Promise.resolve()),
			);
		} finally {
			this.schedulerPauseDepth--;
			if (this.schedulerPauseDepth === 0) this.pump();
		}
	}

	restore(entries: readonly unknown[], deliveredJobIds: ReadonlySet<string> = new Set<string>()): string[] {
		if (this.live.size > 0) {
			throw new SubagentJobError("job_invalid", "Cannot restore subagent jobs while a worker is active.");
		}
		this.records.clear();
		this.live.clear();
		this.tombstones.clear();
		this.sequences.clear();
		this.order.clear();
		this.orderCounter = 0;
		this.reservedOutputBytes = 0;
		const latest = new Map<string, { snapshot: PersistedSubagentJobSnapshot; order: number; normalized: boolean }>();
		let entryOrder = 0;
		for (const entry of entries) {
			entryOrder++;
			if (!isRecord(entry) || entry.type !== "custom" || !matchesEntryType(entry.customType, JOB_ENTRY_TYPE))
				continue;
			const rawData = (entry as JobEntryLike).data;
			const data = normalizePersistedSnapshot(rawData);
			if (!validSnapshot(data, this.reportArtifactRoot) || data.job.ownerSessionId !== this.ownerSessionId) continue;
			const normalized = data !== rawData;
			const previous = latest.get(data.job.jobId);
			if (!previous) {
				latest.set(data.job.jobId, { snapshot: data, order: entryOrder, normalized });
				continue;
			}
			if (data.sequence < previous.snapshot.sequence) continue;
			latest.set(data.job.jobId, { snapshot: data, order: entryOrder, normalized });
		}
		for (const [jobId, value] of latest) {
			const state: JobState = {
				job: { ...value.snapshot.job },
				...(value.snapshot.result ? { result: cloneResult(value.snapshot.result) } : {}),
			};
			this.records.set(jobId, state);
			this.sequences.set(jobId, value.snapshot.sequence);
			if (value.normalized) this.persistState(state);
			const order = value.snapshot.job.queueOrder ?? value.order;
			this.order.set(jobId, order);
			this.orderCounter = Math.max(this.orderCounter, order);
		}
		const notifications: string[] = [];
		for (const state of [...this.records.values()]) {
			if (!isTerminal(state.job.status)) {
				state.job = {
					...state.job,
					status: "interrupted",
					finishedAt: this.now().toISOString(),
					reservedOutputBytes: 0,
				};
				state.result = {
					schemaVersion: 1,
					jobId: state.job.jobId,
					status: "interrupted",
					diagnostics: [
						{ code: "job_runtime_interrupted", message: "Job runtime disappeared before completion." },
					],
				};
				this.persistState(state);
			}
			if (isTerminal(state.job.status) && !deliveredJobIds.has(state.job.jobId)) notifications.push(state.job.jobId);
		}
		this.trimRetention();
		this.publishChange();
		return notifications;
	}

	list(): readonly SubagentJobInspection[] {
		const inspections = [...this.records.values()].map((state) => this.inspectionFor(state));
		const recordedIds = new Set(this.records.keys());
		for (const [jobId, tombstone] of this.tombstones) {
			if (recordedIds.has(jobId)) continue;
			inspections.push(
				Object.freeze({
					job: cloneJob({
						schemaVersion: 1,
						jobId: tombstone.jobId,
						ownerSessionId: this.ownerSessionId,
						launchLeafId: null,
						role: "expired",
						status: tombstone.terminalStatus,
						createdAt: tombstone.expiredAt,
						...(tombstone.finishedAt ? { finishedAt: tombstone.finishedAt } : {}),
						resultRef: `job:${tombstone.jobId}`,
					}),
					tombstone: Object.freeze({ ...tombstone }),
				}),
			);
		}
		return Object.freeze(inspections);
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.shuttingDown = true;
		this.shutdownPromise = this.performShutdown();
		return this.shutdownPromise;
	}

	private async performShutdown(): Promise<void> {
		const queued = [...this.live.values()].filter((live) => live.job.status === "queued");
		for (const live of queued) {
			if (!live.requestedStop) live.requestedStop = "interrupted";
			await this.settle(live);
		}
		const active = [...this.live.values()].filter(
			(live) => live.job.status === "created" || live.job.status === "running" || live.job.status === "needs_time",
		);
		for (const live of active) {
			if (!live.requestedStop) live.requestedStop = "interrupted";
			live.controller.abort();
		}
		await Promise.all(active.filter((live) => live.job.status === "needs_time").map((live) => this.settle(live)));
		await Promise.all(
			active.filter((live) => live.job.status !== "needs_time").map((live) => live.promise ?? Promise.resolve()),
		);
	}

	private assertOwner(requesterSessionId: string): void {
		if (requesterSessionId !== this.ownerSessionId) {
			throw new SubagentJobError("job_not_found", "Subagent job was not found.");
		}
	}

	private persistState(state: JobState): void {
		const sequence = (this.sequences.get(state.job.jobId) ?? 0) + 1;
		const snapshot: PersistedSubagentJobSnapshot = {
			schemaVersion: 1,
			sequence,
			job: { ...state.job },
			...(state.result ? { result: cloneResult(state.result) } : {}),
		};
		if (!validSnapshot(snapshot, this.reportArtifactRoot))
			throw new SubagentJobError("job_persistence_failure", "Subagent job snapshot is invalid or oversized.");
		try {
			this.persistSnapshot(Object.freeze(snapshot));
		} catch (error) {
			throw new SubagentJobError(
				"job_persistence_failure",
				`Subagent job persistence failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.sequences.set(state.job.jobId, sequence);
	}

	private async start(live: LiveJob): Promise<void> {
		if (live.settled) return;
		if (live.requestedStop) {
			await this.settle(live);
			return;
		}
		live.job = {
			...live.job,
			status: "running",
			startedAt: this.now().toISOString(),
		};
		this.records.set(live.job.jobId, live);
		try {
			this.persistState(live);
		} catch {
			this.failPersistence(live);
			return;
		}
		this.publishChange();
		if (live.requestedStop) {
			await this.settle(live);
			return;
		}

		let runResult: SubagentJobRunResult | undefined;
		let runtimeError: unknown;
		try {
			runResult = await live.run(live.controller.signal);
		} catch (error) {
			runtimeError = error;
		}
		await this.handleRunOutcome(live, runResult, runtimeError);
	}

	/** Keep a durable job aligned with a retained runtime supervisor. */
	markManagedRunState(runId: string, state: "running" | "needs_time"): boolean {
		const live = [...this.live.values()].find((candidate) => candidate.job.runId === runId);
		if (!live || live.settled) return false;
		if (state === "running" && live.job.status !== "needs_time") return false;
		// Retained managed runs keep their admission permit while awaiting an
		// extension. This makes needs_time an active state and prevents resumed
		// work from racing with a newly admitted sibling.
		live.job = { ...live.job, status: state, runId };
		this.records.set(live.job.jobId, live);
		this.persistState(live);
		this.publishChange();
		this.pump();
		return true;
	}

	async resolveManagedRun(runId: string, runResult: SubagentJobRunResult): Promise<boolean> {
		const live = [...this.live.values()].find((candidate) => candidate.job.runId === runId);
		if (!live || live.settled) return false;
		await this.handleRunOutcome(live, runResult);
		return true;
	}

	private async handleRunOutcome(
		live: LiveJob,
		runResult?: SubagentJobRunResult,
		runtimeError?: unknown,
	): Promise<void> {
		if (live.settled) return;
		if (!live.requestedStop && runResult?.result.status === "needs_time") {
			// The retained child remains active and owns its permit until a terminal
			// result or explicit cancellation settles it.
			live.job = {
				...live.job,
				status: "needs_time",
				runId: runResult.result.runId,
			};
			this.records.set(live.job.jobId, live);
			this.persistState(live);
			this.publishChange();
			this.pump();
			return;
		}
		await this.settle(live, runResult, runtimeError);
	}

	private async settle(live: LiveJob, runResult?: SubagentJobRunResult, runtimeError?: unknown): Promise<void> {
		if (live.settled) return;
		live.settled = true;
		if (live.holdsPermit) {
			live.holdsPermit = false;
			this.admission?.release();
		}
		const result = projectResult(live.job.jobId, live.requestedStop, runResult, runtimeError, live.job.runId);
		const reservedOutputBytes = live.job.reservedOutputBytes ?? 0;
		if (runResult?.result.runId) live.job = { ...live.job, runId: runResult.result.runId };
		live.job = {
			...live.job,
			status: result.status,
			finishedAt: this.now().toISOString(),
			reservedOutputBytes: 0,
		};
		live.result = result;
		this.releaseReservation(reservedOutputBytes);
		this.records.set(live.job.jobId, live);
		try {
			this.persistState(live);
		} catch {
			this.schedulerBlocked = true;
			this.records.set(live.job.jobId, {
				job: { ...live.job, status: "failed" },
				result: {
					schemaVersion: 1,
					jobId: live.job.jobId,
					status: "failed",
					diagnostics: [{ code: "job_persistence_failure" }],
				},
			});
			this.live.delete(live.job.jobId);
			this.publishChange();
			return;
		}
		this.live.delete(live.job.jobId);
		this.trimRetention();
		this.publishChange();
		try {
			this.notifyCompletion(live.job.jobId);
		} catch {
			// Completion delivery is advisory; durable execution state remains authoritative.
		}
		this.pump();
	}

	private failPersistence(live: LiveJob): void {
		this.schedulerBlocked = true;
		live.settled = true;
		if (live.holdsPermit) {
			live.holdsPermit = false;
			this.admission?.release();
		}
		const reservedOutputBytes = live.job.reservedOutputBytes ?? 0;
		live.job = {
			...live.job,
			status: "failed",
			finishedAt: this.now().toISOString(),
			reservedOutputBytes: 0,
		};
		this.releaseReservation(reservedOutputBytes);
		this.records.set(live.job.jobId, {
			job: live.job,
			result: {
				schemaVersion: 1,
				jobId: live.job.jobId,
				status: "failed",
				diagnostics: [{ code: "job_persistence_failure" }],
			},
		});
		this.live.delete(live.job.jobId);
		this.publishChange();
	}

	private publishChange(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// UI subscribers are non-authoritative and must not affect durable execution.
			}
		}
	}

	private releaseReservation(reserved: number): void {
		this.reservedOutputBytes = Math.max(0, this.reservedOutputBytes - reserved);
	}

	private pump(): void {
		if (this.pumping || this.shuttingDown || this.schedulerPauseDepth > 0) return;
		this.pumping = true;
		try {
			while (!this.schedulerBlocked && this.activeCount() < this.maxActiveJobs) {
				const next = this.oldestQueued();
				if (!next) break;
				if (this.admission && !next.holdsPermit) {
					if (!this.admission.tryAcquire()) break;
					next.holdsPermit = true;
				}
				next.promise = this.start(next);
				void next.promise.catch(() => {});
			}
		} finally {
			this.pumping = false;
		}
	}

	private oldestQueued(): LiveJob | undefined {
		return [...this.live.values()]
			.filter((live) => live.job.status === "queued")
			.sort((left, right) => (this.order.get(left.job.jobId) ?? 0) - (this.order.get(right.job.jobId) ?? 0))[0];
	}

	private activeCount(): number {
		return [...this.live.values()].filter(
			(live) => live.job.status === "created" || live.job.status === "running" || live.job.status === "needs_time",
		).length;
	}

	private queuedCount(): number {
		return [...this.live.values()].filter((live) => live.job.status === "queued").length;
	}

	private inspectionFor(state: JobState): SubagentJobInspection {
		const queuePosition =
			state.job.status === "queued"
				? [...this.live.values()]
						.filter((live) => live.job.status === "queued")
						.sort((left, right) => (this.order.get(left.job.jobId) ?? 0) - (this.order.get(right.job.jobId) ?? 0))
						.findIndex((live) => live.job.jobId === state.job.jobId) + 1
				: undefined;
		return cloneInspection(state, {
			...(queuePosition && queuePosition > 0 ? { queuePosition } : {}),
			budget: {
				plannedOutputBytes: state.job.plannedOutputBytes ?? 0,
				reservedOutputBytes: state.job.reservedOutputBytes ?? 0,
				ownerReservedOutputBytes: this.reservedOutputBytes,
				ownerBudgetBytes: this.maxAggregateOutputBytes,
				...(this.admission
					? {
							ownerActiveJobs: this.admission.active,
							ownerQueuedJobs: this.queuedCount(),
							ownerActiveJobsCap: Math.min(this.maxActiveJobs, this.admission.capacity),
						}
					: {}),
			},
		});
	}

	private trimRetention(): void {
		const terminal = [...this.records.keys()]
			.filter((jobId) => {
				const state = this.records.get(jobId);
				return state !== undefined && isTerminal(state.job.status);
			})
			.sort((left, right) => (this.order.get(right) ?? 0) - (this.order.get(left) ?? 0));
		for (const jobId of terminal.slice(SUBAGENT_JOB_RETENTION_LIMIT)) {
			const state = this.records.get(jobId);
			if (state) {
				if (state.result?.reportArtifact) {
					removeRetainedReportArtifact(state.result.reportArtifact, this.reportArtifactRoot, state.result.runId);
				}
				// Retention expiry is explicit, not silent: keep a bounded tombstone so
				// owner inspection can report "expired from full retention; final status X".
				this.tombstones.set(jobId, {
					jobId,
					terminalStatus: state.job.status as TerminalSubagentJobStatus,
					...(state.job.finishedAt ? { finishedAt: state.job.finishedAt } : {}),
					expiredAt: this.now().toISOString(),
				});
			}
			this.records.delete(jobId);
			this.sequences.delete(jobId);
			this.order.delete(jobId);
		}
		// Tombstones are bounded memory: evict the oldest when over capacity.
		while (this.tombstones.size > SUBAGENT_JOB_RETENTION_LIMIT) {
			const oldest = this.tombstones.keys().next().value;
			if (oldest === undefined) break;
			this.tombstones.delete(oldest);
		}
	}
}
