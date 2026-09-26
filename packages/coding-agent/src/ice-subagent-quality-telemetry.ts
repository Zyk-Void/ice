import { redactCredentialText } from "./utils/redact.ts";

/**
 * Local structural unions for subagent quality telemetry (plan 7.1). Declared here
 * instead of imported so telemetry stays decoupled from the producer modules.
 */
export type SubagentTelemetryQualityMode = "explore" | "standard" | "strict";
export type SubagentTelemetryAssuranceLevel =
	| "unverified_plain"
	| "evidence_checked"
	| "criteria_verified"
	| "verification_executed"
	| "review_verified";
export type SubagentTelemetryReportMode = "plain_final_turn" | "structured_report";
export type SubagentTelemetryReviewerOutcome = "verified" | "disagreed" | "none";

const QUALITY_MODES: readonly SubagentTelemetryQualityMode[] = ["explore", "standard", "strict"];
const ASSURANCE_LEVELS: readonly SubagentTelemetryAssuranceLevel[] = [
	"unverified_plain",
	"evidence_checked",
	"criteria_verified",
	"verification_executed",
	"review_verified",
];
const REPORT_MODES: readonly SubagentTelemetryReportMode[] = ["plain_final_turn", "structured_report"];
const REVIEWER_OUTCOMES: readonly SubagentTelemetryReviewerOutcome[] = ["verified", "disagreed", "none"];

/** Parent-facing "why this run is weak" diagnostic codes; emitted only when evidenced (plan 7.2). */
export const SUBAGENT_WEAK_RUN_DIAGNOSTIC_CODES = [
	"evidence_unverified",
	"verification_not_run",
	"context_bootstrap_empty",
	"task_brief_under_specified",
	"review_disagreement",
] as const;
export type SubagentWeakRunDiagnosticCode = (typeof SUBAGENT_WEAK_RUN_DIAGNOSTIC_CODES)[number];

/** Hard byte cap for the parent-facing rendered telemetry block. */
export const SUBAGENT_QUALITY_TELEMETRY_MAX_BYTES = 2048;

const TASK_HASH_PATTERN = /^[a-f0-9]{64}$/;
const REASONING_LEVEL_MAX_BYTES = 16;
const FINAL_STATUS_MAX_BYTES = 2048;
const TRUNCATION_MARKER = "\n[truncated]";

/** Bounded, redacted quality projection for one subagent run (plan 7.1). */
export interface SubagentQualityTelemetry {
	readonly taskContractHash?: string;
	readonly contextManifestHash?: string;
	readonly qualityMode?: SubagentTelemetryQualityMode;
	readonly assurance?: SubagentTelemetryAssuranceLevel;
	readonly reportMode?: SubagentTelemetryReportMode;
	/** Redacted reasoning setting label; at most 16 bytes. */
	readonly reasoningLevel?: string;
	readonly criteriaTotal: number;
	readonly criteriaRequired: number;
	readonly criteriaVerified: number;
	readonly unresolvedClaims: number;
	readonly evidenceCount: number;
	readonly followUpCount: number;
	readonly repeatedFailureCount: number;
	readonly reviewerUsed: boolean;
	readonly reviewerOutcome?: SubagentTelemetryReviewerOutcome;
	readonly finalStatus: string;
}

/**
 * Loose partial input for {@link buildSubagentQualityTelemetry}. Every field is
 * untrusted: values are validated, redacted, and bounded; invalid values are
 * coerced to omitted/0 and never throw.
 */
export interface SubagentQualityTelemetryInput {
	readonly taskContractHash?: unknown;
	readonly contextManifestHash?: unknown;
	/** Structural hash-bearing manifest (e.g. NormalizedSubagentRequest.contextManifest). */
	readonly contextManifest?:
		| { readonly hash?: unknown; readonly entries?: readonly { readonly identifier?: unknown }[] }
		| undefined;
	readonly qualityMode?: unknown;
	readonly assurance?: unknown;
	readonly reportMode?: unknown;
	readonly reasoningLevel?: unknown;
	readonly criteriaTotal?: unknown;
	readonly criteriaRequired?: unknown;
	readonly criteriaVerified?: unknown;
	readonly unresolvedClaims?: unknown;
	readonly evidenceCount?: unknown;
	readonly followUpCount?: unknown;
	readonly repeatedFailureCount?: unknown;
	readonly reviewerUsed?: unknown;
	readonly reviewerOutcome?: unknown;
	readonly finalStatus?: unknown;
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let usedBytes = 0;
	let end = 0;
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (usedBytes + characterBytes > maxBytes) break;
		usedBytes += characterBytes;
		end += character.length;
	}
	return text.slice(0, end);
}

function boundedRedactedText(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const redacted = redactCredentialText(value)
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.trim();
	if (!redacted) return undefined;
	return truncateUtf8(redacted, maxBytes);
}

function hexHash64(value: unknown): string | undefined {
	return typeof value === "string" && TASK_HASH_PATTERN.test(value) ? value : undefined;
}

function unionMember<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
	if (typeof value !== "string") return undefined;
	return allowed.find((candidate) => candidate === value);
}

function boundedCount(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function contextManifestHashFrom(input: SubagentQualityTelemetryInput): string | undefined {
	const direct = hexHash64(input.contextManifestHash);
	if (direct) return direct;
	const manifest = input.contextManifest;
	if (typeof manifest !== "object" || manifest === null) return undefined;
	return hexHash64(manifest.hash);
}

/**
 * Builds a frozen, bounded, redacted telemetry record. Invalid or out-of-bound
 * input is coerced conservatively (optionals omitted, counts 0) and never throws.
 */
export function buildSubagentQualityTelemetry(input: SubagentQualityTelemetryInput): SubagentQualityTelemetry {
	const taskContractHash = hexHash64(input.taskContractHash);
	const contextManifestHash = contextManifestHashFrom(input);
	const qualityMode = unionMember(QUALITY_MODES, input.qualityMode);
	const assurance = unionMember(ASSURANCE_LEVELS, input.assurance);
	const reportMode = unionMember(REPORT_MODES, input.reportMode);
	const reasoningLevel = boundedRedactedText(input.reasoningLevel, REASONING_LEVEL_MAX_BYTES);
	const reviewerOutcome = unionMember(REVIEWER_OUTCOMES, input.reviewerOutcome);
	const finalStatus = boundedRedactedText(input.finalStatus, FINAL_STATUS_MAX_BYTES) ?? "unknown";
	return Object.freeze({
		...(taskContractHash !== undefined ? { taskContractHash } : {}),
		...(contextManifestHash !== undefined ? { contextManifestHash } : {}),
		...(qualityMode !== undefined ? { qualityMode } : {}),
		...(assurance !== undefined ? { assurance } : {}),
		...(reportMode !== undefined ? { reportMode } : {}),
		...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
		criteriaTotal: boundedCount(input.criteriaTotal),
		criteriaRequired: boundedCount(input.criteriaRequired),
		criteriaVerified: boundedCount(input.criteriaVerified),
		unresolvedClaims: boundedCount(input.unresolvedClaims),
		evidenceCount: boundedCount(input.evidenceCount),
		followUpCount: boundedCount(input.followUpCount),
		repeatedFailureCount: boundedCount(input.repeatedFailureCount),
		reviewerUsed: input.reviewerUsed === true,
		...(reviewerOutcome !== undefined ? { reviewerOutcome } : {}),
		finalStatus,
	});
}

/**
 * Renders a deterministic, bounded (`<= 2 KiB`) `key: value` block for
 * parent-facing diagnostics. Undefined optionals are omitted; oversized blocks
 * are byte-truncated with a trailing marker.
 */
export function renderSubagentQualityTelemetry(telemetry: SubagentQualityTelemetry): string {
	const lines: string[] = [];
	if (telemetry.taskContractHash !== undefined) lines.push(`task contract hash: ${telemetry.taskContractHash}`);
	if (telemetry.contextManifestHash !== undefined) {
		lines.push(`context manifest hash: ${telemetry.contextManifestHash}`);
	}
	if (telemetry.qualityMode !== undefined) lines.push(`quality mode: ${telemetry.qualityMode}`);
	if (telemetry.assurance !== undefined) lines.push(`assurance: ${telemetry.assurance}`);
	if (telemetry.reportMode !== undefined) lines.push(`report mode: ${telemetry.reportMode}`);
	if (telemetry.reasoningLevel !== undefined) lines.push(`reasoning level: ${telemetry.reasoningLevel}`);
	lines.push(
		`criteria total: ${telemetry.criteriaTotal}`,
		`criteria required: ${telemetry.criteriaRequired}`,
		`criteria verified: ${telemetry.criteriaVerified}`,
		`unresolved claims: ${telemetry.unresolvedClaims}`,
		`evidence count: ${telemetry.evidenceCount}`,
		`follow-up count: ${telemetry.followUpCount}`,
		`repeated failure count: ${telemetry.repeatedFailureCount}`,
		`reviewer used: ${telemetry.reviewerUsed}`,
	);
	if (telemetry.reviewerOutcome !== undefined) lines.push(`reviewer outcome: ${telemetry.reviewerOutcome}`);
	lines.push(`final status: ${telemetry.finalStatus}`);
	let text = lines.join("\n");
	if (Buffer.byteLength(text, "utf8") > SUBAGENT_QUALITY_TELEMETRY_MAX_BYTES) {
		const budget = SUBAGENT_QUALITY_TELEMETRY_MAX_BYTES - Buffer.byteLength(TRUNCATION_MARKER, "utf8");
		text = `${truncateUtf8(text, budget)}${TRUNCATION_MARKER}`;
	}
	return text;
}

/**
 * Emits weak-run diagnostic codes (plan 7.2) in deterministic order, only when
 * the corresponding condition is evidenced by the telemetry.
 */
export function formatWeakRunDiagnostics(
	telemetry: SubagentQualityTelemetry,
): readonly SubagentWeakRunDiagnosticCode[] {
	const diagnostics: SubagentWeakRunDiagnosticCode[] = [];
	if (telemetry.evidenceCount === 0 && telemetry.qualityMode !== "explore") {
		diagnostics.push("evidence_unverified");
	}
	if (telemetry.reportMode === "structured_report" && telemetry.assurance === "unverified_plain") {
		diagnostics.push("verification_not_run");
	}
	if (telemetry.contextManifestHash === undefined) diagnostics.push("context_bootstrap_empty");
	if (telemetry.taskContractHash === undefined) diagnostics.push("task_brief_under_specified");
	if (telemetry.reviewerOutcome === "disagreed") diagnostics.push("review_disagreement");
	return Object.freeze(diagnostics);
}
