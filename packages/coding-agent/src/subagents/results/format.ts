/** Tool-result formatting, redaction, progress publication, and call/result rendering (moved from ice-subagents.ts). */
import type { AgentToolResult, AgentToolUpdateCallback } from "@zykairotis/ice-agent-core";
import { ModelsError } from "@zykairotis/ice-ai";
import { type Component, Text, truncateToWidth, visibleWidth } from "@zykairotis/ice-tui";
import type { ToolRenderContext, ToolRenderResultOptions } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { redactCredentialText } from "../../utils/redact.ts";
import type { SubagentProfileListingDetails } from "../api/legacy-schemas.ts";
import type { WriterWorkflowStatus, WriterWorkflowToolResult } from "../isolation/writer-patch.ts";
import type { SubagentJobInspection } from "../registry/jobs.ts";
import { formatSubagentLaunchDigest } from "../runtime/batch.ts";
import type { SubagentCheckInState } from "../runtime/checkin.ts";
import { SubagentError } from "../runtime/helpers.ts";
import { evaluateSubagentPreflight, type SubagentPreflightEvaluation } from "../runtime/preflight.ts";
import { truncateSubagentOutput } from "../runtime/prompt.ts";
import { formatSubagentToolActivity, type SubagentRuntimeAttention } from "../runtime/supervisor.ts";
import { projectIceHookRecords } from "../settings.ts";
import { buildSubagentQualityTelemetry, formatWeakRunDiagnostics } from "../telemetry/quality.ts";
import {
	type NormalizedSubagentRequest,
	type ReviewBatchResult,
	type ReviewFinding,
	SUBAGENT_PRESENTATION_LIMIT_BYTES,
	type SubagentBatchResult,
	type SubagentBatchTaskLifecycleEvent,
	type SubagentEvent,
	type SubagentManagedObservation,
	type SubagentRequirementClaim,
	type SubagentResult,
	type SubagentVerification,
	type SubagentWorkArtifact,
	type WriterResult,
} from "../types.ts";
import {
	formatProgressSnapshot,
	formatToolCall,
	getProgressSnapshot,
	type ObservatoryToolName,
	progressDetails,
	type SubagentObservatoryStore,
	type SubagentProgressSnapshot,
} from "../ui/observatory.ts";
import { SUBAGENT_ASSURANCE_LEVEL_TEXT } from "./assurance.ts";
import { renderBatchSynthesisSection, summarizeBatchSynthesis } from "./batch-synthesis.ts";
import type { SubagentOutput } from "./output-artifacts.ts";
import { formatSubagentRequirementSummary, isRecord } from "./report.ts";

const BREADTH_CRITERIA_THRESHOLD = 6;
const BREADTH_SCOPE_ROOTS_THRESHOLD = 3;

/**
 * Advisory-only decomposition guidance (P2-1). Never rejects; broad delegations
 * verify less strongly than narrow ones, so say so once, briefly.
 */
export function describeSubagentDelegationBreadth(request: NormalizedSubagentRequest): string | undefined {
	const requiredCriteria = request.acceptanceCriteria.filter((criterion) => criterion.required).length;
	const scopeRootCount = request.scope.roots.length;
	const dimensions = new Set(request.acceptanceCriteria.map((criterion) => criterion.dimension).filter(Boolean));
	if (requiredCriteria >= BREADTH_CRITERIA_THRESHOLD || scopeRootCount >= BREADTH_SCOPE_ROOTS_THRESHOLD) {
		return (
			`Delegation is broad: ${requiredCriteria} required criteria across ${scopeRootCount} scope root${scopeRootCount === 1 ? "" : "s"}` +
			`${dimensions.size > 1 ? ` and ${dimensions.size} quality dimensions` : ""}. ` +
			"Consider splitting for stronger verification."
		);
	}
	return undefined;
}

/**
 * Evaluate declared preflight requirements before a child run is consumed.
 * A required failed check blocks launch without granting tools or authority.
 */
export function gateSubagentPreflight(
	normalized: NormalizedSubagentRequest,
):
	| { blocked: false; evaluation: SubagentPreflightEvaluation }
	| { blocked: true; evaluation: SubagentPreflightEvaluation } {
	if (normalized.preflight.length === 0) {
		return { blocked: false, evaluation: { checks: [], blocked: false, failedRequiredIds: [], summary: "" } };
	}
	const evaluation = evaluateSubagentPreflight(normalized.preflight, {
		cwd: normalized.cwd,
		scopeRoots: normalized.scope.roots,
	});
	return evaluation.blocked ? { blocked: true, evaluation } : { blocked: false, evaluation };
}

export function classifySubagentFailure(
	error: unknown,
	phase: "startup" | "runtime",
	childToolFailed = false,
): SubagentError {
	if (error instanceof SubagentError) return error;
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof ModelsError) {
		if (error.code === "auth" || error.code === "oauth") return new SubagentError("auth_missing", message);
		if (error.code === "model_source" || error.code === "model_validation") {
			return new SubagentError("model_unavailable", message);
		}
		if (!childToolFailed && phase === "startup" && error.code === "stream") {
			return new SubagentError(
				phase === "startup" ? "child_startup_failure" : "child_runtime_failure",
				message,
				true,
			);
		}
	}
	return new SubagentError(phase === "startup" ? "child_startup_failure" : "child_runtime_failure", message);
}

export function formatWriterToolResult(result: WriterResult): string {
	const text = [
		`Writer ${result.status} (${result.runId}).`,
		result.summary,
		result.workspaceIsolation === "parent"
			? "YOLO direct parent workspace: changes were made in place; no isolation, rollback, or patch proposal."
			: `Base commit: ${result.baseCommit}. Temporary worktree removed: ${result.workspaceRemoved ? "yes" : "no"}.`,
		result.patchArtifact
			? `Patch proposal: ${result.patchArtifact.patchRef} (${result.patchArtifact.changedFileCount} files, ${result.patchArtifact.patchBytes} bytes, sha256 ${result.patchArtifact.patchSha256}).`
			: "Patch proposal: none.",
		...result.diagnostics.map((diagnostic) => `Diagnostic: ${diagnostic.code}: ${diagnostic.message}`),
	].join("\n\n");
	return truncateSubagentOutput(redactCredentialText(text), 16 * 1024).text;
}

export function subagentCheckInFreshness(
	progressAgeMs: number | undefined,
	intervalMs: number,
): "fresh" | "stale" | "unknown" {
	if (progressAgeMs === undefined) return "unknown";
	return progressAgeMs <= intervalMs ? "fresh" : "stale";
}

export function formatRuntimeAttention(attention: SubagentRuntimeAttention): string {
	const activities = attention.lastActivities.slice(-3);
	return [
		`Background child is running · ${attention.phase} · ${attention.activeElapsedMs} ms active; there is no lifetime timeout.`,
		attention.progressAgeMs !== undefined ? `Last progress: ${attention.progressAgeMs} ms ago.` : undefined,
		attention.repeatedFailure
			? `Advisory: the same action failed ${attention.repeatedFailure.count} times recently ("${attention.repeatedFailure.action}"); inspect before following up.`
			: undefined,
		activities.length > 0
			? `Last ${activities.length} tool activit${activities.length === 1 ? "y" : "ies"}:\n${activities.map((activity) => `- ${formatSubagentToolActivity(activity)}`).join("\n")}`
			: "Last tool activities: none observed.",
	]
		.filter((part): part is string => part !== undefined)
		.join("\n");
}

/**
 * Render a bounded management observation. `waitExpired` describes only the
 * parent management window and is never presented as a child timeout.
 */
export function formatSubagentCheckInState(state: SubagentCheckInState | undefined): string | undefined {
	if (!state) return undefined;
	const nextDue = state.nextDueAt === undefined ? undefined : new Date(state.nextDueAt).toISOString();
	return [
		`Parent check-in: ${state.delivery} (sequence ${state.sequence}).`,
		nextDue ? `Next check-in due: ${nextDue}.` : undefined,
		state.pendingSince !== undefined
			? `Parent review pending since: ${new Date(state.pendingSince).toISOString()}.`
			: undefined,
		state.lastAcknowledgedAt !== undefined
			? `Last parent review acknowledged: ${new Date(state.lastAcknowledgedAt).toISOString()}.`
			: undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" ");
}

/** Parent-facing, pathless description of where the complete final answer lives. */
export function formatSubagentOutputReference(output: SubagentOutput | undefined): string | undefined {
	if (!output || output.captureStatus === "inline_complete") return undefined;
	if (output.captureStatus === "artifact_unavailable" || !output.artifact) {
		return `Final answer (${output.originalBytes} bytes) exceeded the inline limit and could not be retained; only the inline prefix is available.`;
	}
	const artifact = output.artifact;
	return `Complete final answer retained as output artifact ${artifact.id} (${artifact.storedBytes} of ${artifact.originalBytes} bytes stored${artifact.truncated ? ", truncated at the host storage limit" : ""}). Read it with read_subagent_output using artifactId ${artifact.id}.`;
}

export function formatManagedObservation(
	observation: SubagentManagedObservation,
	verification?: SubagentVerification,
): string {
	if (observation.result && verification) {
		const header = [`Subagent ${observation.runId} is ${observation.childState}.`];
		const checkIn = formatSubagentCheckInState(observation.checkIn);
		if (checkIn) header.push(checkIn);
		return truncateSubagentOutput(
			redactCredentialText([...header, formatToolResult(observation.result, verification)].join("\n")),
			16 * 1024,
		).text;
	}
	const lines = [`Subagent ${observation.runId} is ${observation.childState}.`];
	const checkIn = formatSubagentCheckInState(observation.checkIn);
	if (checkIn) lines.push(checkIn);
	if (observation.waitExpired) {
		lines.push(
			"Management wait expired while the child was still running; the child did not time out and remains retained.",
		);
	}
	if (observation.result) {
		lines.push(
			`Terminal result: ${observation.result.status} · ${observation.result.summary}`,
			...(observation.result.partial ? ["The result is partial; treat it as unverified evidence."] : []),
		);
		const outputReference = formatSubagentOutputReference(observation.result.output);
		if (outputReference) lines.push(outputReference);
	}
	if (observation.attention) {
		lines.push(formatRuntimeAttention(observation.attention));
		if (!observation.terminal) {
			lines.push(
				observation.attention.lifetimeDeadline === false
					? `Use manage_subagent with runId ${observation.runId} to inspect, peek, wait, follow up, or stop the same running child.`
					: `Use manage_subagent with runId ${observation.runId} to inspect, peek, wait, follow up, or stop the same retained child.`,
			);
		}
	}
	return truncateSubagentOutput(redactCredentialText(lines.join("\n")), 16 * 1024).text;
}

export function formatToolResult(result: SubagentResult, verification: SubagentVerification): string {
	const requirementRows = formatSubagentRequirementSummary(verification.requirementSummary);
	const artifact = result.workArtifact;
	const artifactRows =
		artifact &&
		artifact.reportProtocol.status !== "valid" &&
		artifact.reportProtocol.status !== "plain" &&
		result.status !== "needs_time"
			? [
					"Preserved work artifact (runtime-owned, unverified):",
					`report protocol: ${artifact.reportProtocol.status}${artifact.reportProtocol.diagnostic ? ` — ${artifact.reportProtocol.diagnostic}` : ""}`,
					...(artifact.touchedPaths.length > 0
						? [
								`touched paths: ${artifact.touchedPaths.slice(0, 8).join(", ")}${artifact.touchedPaths.length > 8 ? ", …" : ""}`,
							]
						: []),
					...(artifact.candidateEvidencePaths.length > 0
						? [
								`candidate evidence (unverified): ${artifact.candidateEvidencePaths.slice(0, 8).join(", ")}${artifact.candidateEvidencePaths.length > 8 ? ", …" : ""}`,
							]
						: []),
				]
			: [];
	const modeRow =
		result.reportMode === "plain_final_turn"
			? "Report mode: plain final assistant turn (no structured report or evidence verification)."
			: result.reportMode === "structured_report"
				? "Report mode: bounded structured JSON report."
				: undefined;
	const qualityModeRow =
		result.qualityMode === "explore"
			? "Quality mode: explore (evidence-limited; this result is not verified work)."
			: result.qualityMode === "standard"
				? "Quality mode: standard (evidence-backed completion expected)."
				: result.qualityMode === "strict"
					? "Quality mode: strict (acceptance criteria and verification gate apply)."
					: undefined;
	const assuranceRow = result.assurance ? `Assurance: ${SUBAGENT_ASSURANCE_LEVEL_TEXT[result.assurance]}.` : undefined;
	const weakRunCodes = formatWeakRunDiagnostics(
		buildSubagentQualityTelemetry({
			taskContractHash: result.taskContractHash,
			contextManifestHash: result.contextManifestHash,
			qualityMode: result.qualityMode,
			assurance: result.assurance,
			reportMode: result.reportMode,
			workerTier: result.semanticWorkerTier,
			routeSource: result.routeSource,
			reasoningLevel: result.reasoningLevel,
			criteriaTotal: result.requirementStates?.length,
			criteriaVerified: result.requirementStates?.filter((state) => state.verified).length,
			unresolvedClaims: verification.unresolvedClaims.length,
			evidenceCount: result.evidence?.paths?.length,
			evidenceTypes: result.evidenceTypes,
			followUpCount: result.followUpCount,
			repeatedFailureCount: result.repeatedFailureCount,
			reviewerUsed: result.reviewerUsed,
			reviewerOutcome: result.reviewerOutcome,
			finalStatus: result.status,
		}),
	);
	const weakRunRow = weakRunCodes.length > 0 ? `Weak-run diagnostics: ${weakRunCodes.join(", ")}.` : undefined;
	const reviewerGateRow =
		result.reviewerGateRecommended === true
			? "Reviewer gate recommended: run review_batch over this change before integrating it (deterministic verification alone cannot establish correctness)."
			: undefined;
	const text = [
		`Subagent ${result.status} (${result.profile}, ${result.runId}).`,
		result.summary,
		modeRow,
		qualityModeRow,
		assuranceRow,
		verification.verified
			? verification.kind === "plain_bounds"
				? "Parent verification: plain answer accepted (lineage and output bound only; no structured verification)."
				: "Parent verification: passed."
			: `Parent verification: failed. ${verification.reason}`,
		...(requirementRows.length > 0 ? [requirementRows.join("\n")] : []),
		...(artifactRows.length > 0 ? [artifactRows.join("\n")] : []),
		formatSubagentOutputReference(result.output),
		result.attention ? formatRuntimeAttention(result.attention) : undefined,
		verification.unresolvedClaims.length > 0
			? `Unresolved claims for parent synthesis: ${verification.unresolvedClaims.join(" | ")}`
			: undefined,
		formatSubagentRepairRecommendation(result, verification),
		weakRunRow,
		reviewerGateRow,
		result.truncated ? "Output was truncated; treat the report as partial evidence." : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join("\n\n");
	return truncateSubagentOutput(redactCredentialText(text), SUBAGENT_PRESENTATION_LIMIT_BYTES).text;
}

/**
 * Phase 4.2: bounded, deterministic same-session repair recommendation. The
 * parent stays responsible for deciding to send manage_subagent follow_up;
 * the runtime never relaunches or rewrites the child on its own.
 */
function formatSubagentRepairRecommendation(
	result: SubagentResult,
	verification: SubagentVerification,
): string | undefined {
	if (!verification.verified) {
		const missingRequired = (result.requirementStates ?? [])
			.filter((state) => state.required && !state.verified)
			.map((state) => state.id)
			.slice(0, 8);
		if (missingRequired.length > 0) {
			return `Recommended repair: manage_subagent follow_up asking the child to provide observed evidence for criteria ${missingRequired.join(", ")}.`;
		}
		return "Recommended repair: manage_subagent follow_up with the missing evidence or correction; accept the unresolved result if none is possible.";
	}
	return undefined;
}

export function formatSubagentJobInspection(inspection: SubagentJobInspection): string {
	const result = inspection.result;
	return redactCredentialText(
		[
			`Background subagent job ${inspection.job.status} (${inspection.job.jobId}).`,
			inspection.tombstone
				? `Expired from full retention; final status ${inspection.tombstone.terminalStatus}. Full result artifacts are no longer retained.`
				: undefined,
			inspection.queuePosition !== undefined ? `Queue position: ${inspection.queuePosition}.` : undefined,
			inspection.scheduling
				? `Admission: active=${inspection.scheduling.ownerActiveJobs}, queued=${inspection.scheduling.ownerQueuedJobs}, cap=${inspection.scheduling.ownerActiveJobsCap}.`
				: undefined,
			inspection.job.contract
				? `Accepted contract: thinking=${inspection.job.contract.thinking}, no child lifetime deadline, check-in=${inspection.job.contract.checkInIntervalMs === undefined ? "legacy interval unavailable" : `${inspection.job.contract.checkInIntervalMs}ms`}, tools=${inspection.job.contract.tools.join(",") || "none"}.`
				: undefined,
			`Result ref: ${inspection.job.resultRef}.`,
			result?.summary,
			result?.payload ? `Payload: ${JSON.stringify(result.payload)}` : undefined,
			result?.observedTurns !== undefined ? `Observed turns: ${result.observedTurns}.` : undefined,
			result?.hookRecords && result.hookRecords.length > 0
				? `Hook outcomes: ${result.hookRecords.map((record) => `${record.hookId}:${record.outcome}`).join(", ")}.`
				: undefined,
			result?.verification
				? `Verification: ${result.verification.verified ? "passed" : "failed"}. ${result.verification.reason}`
				: undefined,
			result?.workArtifact &&
			result.workArtifact.reportProtocol.status !== "valid" &&
			result.workArtifact.reportProtocol.status !== "plain"
				? [
						`Preserved work artifact: report protocol ${result.workArtifact.reportProtocol.status}${result.workArtifact.reportProtocol.diagnostic ? ` — ${result.workArtifact.reportProtocol.diagnostic}` : ""}.`,
						result.workArtifact.touchedPaths.length > 0
							? `Touched paths (observed, unverified): ${result.workArtifact.touchedPaths.slice(0, 8).join(", ")}.`
							: undefined,
					]
						.filter((part): part is string => part !== undefined)
						.join(" ")
				: undefined,
			result?.qualityMode
				? `Quality mode: ${result.qualityMode}${result.taskContractHash ? `; task contract ${result.taskContractHash.slice(0, 12)}` : ""}.`
				: undefined,
			result?.output
				? `Final output: ${result.output.captureStatus}; inline ${result.output.textBytes} bytes; original ${result.output.originalBytes} bytes${result.output.artifact ? `; artifactId=${result.output.artifact.id}; stored ${result.output.artifact.storedBytes} bytes${result.output.artifact.truncated ? ", truncated" : ""}` : "; no artifact"}. Use read_subagent_output for retained artifact content.`
				: undefined,
			result && result.diagnostics.length > 0
				? `Diagnostics: ${result.diagnostics.map((diagnostic) => diagnostic.code).join(", ")}.`
				: undefined,
		]
			.filter((part): part is string => part !== undefined)
			.join("\n\n"),
	);
}

export function formatBatchToolResult(result: SubagentBatchResult): string {
	const synthesis = summarizeBatchSynthesis(
		result.items.map((item) => ({ taskId: item.taskId, result: item.result })),
	);
	const text = [
		formatSubagentLaunchDigest(result.preflight),
		`Subagent batch ${result.status} (${result.batchId}).`,
		...result.items.map(
			(item) =>
				`Task ${item.taskId}: ${item.result.status}; verification ${formatSubagentVerificationWord(item.verification)}${formatSubagentArtifactSuffix(item.result)}.\n${item.result.summary}`,
		),
		renderBatchSynthesisSection(synthesis),
		...result.diagnostics.map((diagnostic) => `Diagnostic: ${diagnostic.code}: ${diagnostic.message}`),
	].join("\n\n");
	return truncateSubagentOutput(redactCredentialText(text), SUBAGENT_PRESENTATION_LIMIT_BYTES).text;
}

/** Phase 5.1: bounds-only verification is never presented as generic "passed". */
function formatSubagentVerificationWord(verification: SubagentVerification): string {
	if (!verification.verified) return "failed";
	return verification.kind === "plain_bounds" ? "bounds-checked only (no structured verification)" : "passed";
}

function formatSubagentArtifactSuffix(result: SubagentResult): string {
	return result.output?.artifact ? `; artifact ${result.output.artifact.id}` : "";
}

export function formatReviewBatchToolResult(result: ReviewBatchResult): string {
	const text = [
		formatSubagentLaunchDigest(result.preflight),
		`Reviewer batch ${result.status} (${result.batchId}).`,
		...result.reviewers.map((reviewer) => {
			const findings = reviewer.findings.map(
				(finding) =>
					`${finding.severity} ${finding.category}: ${finding.claim} [${finding.evidence.map((ref) => ref.path).join(", ")}]`,
			);
			return [
				`Reviewer ${reviewer.taskId} (${reviewer.dimension}; model ${reviewer.modelProvenance.resolved} via ${reviewer.modelProvenance.source}): ${reviewer.result.status}; verification ${formatSubagentVerificationWord(reviewer.verification)}${formatSubagentArtifactSuffix(reviewer.result)}.`,
				reviewer.result.summary,
				...findings,
			].join("\n");
		}),
		...result.diagnostics.map((diagnostic) => `Diagnostic: ${diagnostic.code}: ${diagnostic.message}`),
	].join("\n\n");
	return truncateSubagentOutput(redactCredentialText(text), SUBAGENT_PRESENTATION_LIMIT_BYTES).text;
}

function redactSubagentFinding(finding: ReviewFinding): ReviewFinding {
	return {
		...finding,
		category: redactCredentialText(finding.category),
		claim: redactCredentialText(finding.claim),
		evidence: finding.evidence.map((reference) => ({ path: redactCredentialText(reference.path) })),
	};
}

function redactSubagentRequirementClaim(claim: SubagentRequirementClaim): SubagentRequirementClaim {
	return {
		...claim,
		...(claim.note ? { note: redactCredentialText(claim.note) } : {}),
		...(claim.evidencePaths ? { evidencePaths: claim.evidencePaths.map((path) => redactCredentialText(path)) } : {}),
	};
}

function redactSubagentPayload(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const redact = (input: unknown): unknown => {
		if (typeof input === "string") return redactCredentialText(input);
		if (Array.isArray(input)) return input.map(redact);
		if (isRecord(input)) return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, redact(entry)]));
		return input;
	};
	return redact(value) as Readonly<Record<string, unknown>>;
}

function redactSubagentWorkArtifact(artifact: SubagentWorkArtifact): SubagentWorkArtifact {
	return {
		...artifact,
		lastActivities: artifact.lastActivities.map((activity) => ({
			...activity,
			...(activity.action ? { action: redactCredentialText(activity.action) } : {}),
			...(activity.path ? { path: redactCredentialText(activity.path) } : {}),
		})),
		touchedPaths: artifact.touchedPaths.map((path) => redactCredentialText(path)),
		candidateEvidencePaths: artifact.candidateEvidencePaths.map((path) => redactCredentialText(path)),
		reportProtocol: {
			...artifact.reportProtocol,
			...(artifact.reportProtocol.diagnostic
				? { diagnostic: redactCredentialText(artifact.reportProtocol.diagnostic) }
				: {}),
		},
		...(artifact.requirementClaims
			? { requirementClaims: artifact.requirementClaims.map(redactSubagentRequirementClaim) }
			: {}),
	};
}

export function redactSubagentResult(result: SubagentResult): SubagentResult {
	return {
		...result,
		summary: redactCredentialText(result.summary),
		diagnostics: result.diagnostics.map((diagnostic) => ({
			...diagnostic,
			message: diagnostic.message ? redactCredentialText(diagnostic.message) : diagnostic.message,
		})),
		...(result.evidence
			? { evidence: { paths: result.evidence.paths.map((path) => redactCredentialText(path)) } }
			: {}),
		...(result.findings ? { findings: result.findings.map(redactSubagentFinding) } : {}),
		...(result.workArtifact ? { workArtifact: redactSubagentWorkArtifact(result.workArtifact) } : {}),
		...(result.requirementClaims
			? { requirementClaims: result.requirementClaims.map(redactSubagentRequirementClaim) }
			: {}),
		...(result.payload ? { payload: redactSubagentPayload(result.payload) } : {}),
		...(result.hookRecords ? { hookRecords: projectIceHookRecords(result.hookRecords) } : {}),
	};
}

export function redactWriterResult(result: WriterResult): WriterResult {
	return {
		...result,
		summary: redactCredentialText(result.summary),
		diagnostics: result.diagnostics.map((diagnostic) => ({
			...diagnostic,
			message: diagnostic.message ? redactCredentialText(diagnostic.message) : diagnostic.message,
		})),
	};
}

export function redactSubagentVerification(verification: SubagentVerification): SubagentVerification {
	return {
		...verification,
		reason: redactCredentialText(verification.reason),
		paths: verification.paths.map((path) => redactCredentialText(path)),
		unresolvedClaims: verification.unresolvedClaims.map((claim) => redactCredentialText(claim)),
	};
}

export function redactSubagentBatchResult(result: SubagentBatchResult): SubagentBatchResult {
	return {
		...result,
		items: result.items.map((item) => ({
			...item,
			result: redactSubagentResult(item.result),
			verification: redactSubagentVerification(item.verification),
		})),
		diagnostics: result.diagnostics.map((diagnostic) => ({
			...diagnostic,
			message: diagnostic.message ? redactCredentialText(diagnostic.message) : diagnostic.message,
		})),
	};
}

export function redactReviewBatchResult(result: ReviewBatchResult): ReviewBatchResult {
	return {
		...result,
		reviewers: result.reviewers.map((reviewer) => ({
			...reviewer,
			findings: reviewer.findings.map(redactSubagentFinding),
			result: redactSubagentResult(reviewer.result),
			verification: redactSubagentVerification(reviewer.verification),
		})),
		diagnostics: result.diagnostics.map((diagnostic) => ({
			...diagnostic,
			message: diagnostic.message ? redactCredentialText(diagnostic.message) : diagnostic.message,
		})),
	};
}

export function redactWriterWorkflowResult(result: WriterWorkflowToolResult): WriterWorkflowToolResult {
	return {
		...result,
		...(result.preview !== undefined ? { preview: redactCredentialText(result.preview) } : {}),
		...(result.changedPaths ? { changedPaths: result.changedPaths.map((path) => redactCredentialText(path)) } : {}),
		...(result.message !== undefined ? { message: redactCredentialText(result.message) } : {}),
	};
}

export function formatWriterWorkflowResult(result: WriterWorkflowToolResult): string {
	const lines = [`Writer patch ${result.status}.`];
	if (result.artifact) {
		lines.push(`Run: ${result.artifact.runId}`);
		lines.push(`Base: ${result.artifact.baseCommit}`);
		lines.push(`Files: ${result.artifact.files.map((file) => file.path).join(", ") || "none"}`);
		lines.push(`Patch: ${result.artifact.patchBytes} bytes, sha256 ${result.artifact.patchSha256}`);
	}
	if (result.preview !== undefined) {
		lines.push(`Preview: ${result.previewBytes ?? 0} bytes${result.previewTruncated ? " (truncated)" : ""}`);
		lines.push(result.preview);
	}
	if (result.changedPaths && result.changedPaths.length > 0) lines.push(`Changed: ${result.changedPaths.join(", ")}`);
	if (result.verification) lines.push(`Verifier: ${result.verification.status}`);
	if (result.message) lines.push(`Detail: ${result.message}`);
	if (result.status === "rejected") {
		lines.push("Rejection is a non-durable parent decision; the immutable artifact remains reusable.");
	}
	return truncateSubagentOutput(redactCredentialText(lines.join("\n")), 48 * 1024).text;
}

export function writerWorkflowFailure(status: WriterWorkflowStatus, error: unknown): WriterWorkflowToolResult {
	return redactWriterWorkflowResult({
		status,
		message: error instanceof Error ? error.message : String(error),
	});
}

export function writerIntegrationFailure(error: unknown): WriterWorkflowToolResult {
	if (error instanceof SubagentError) {
		if (error.code === "rollback_conflict") return writerWorkflowFailure("rollback_conflict", error);
		if (error.code === "verification_failure") return writerWorkflowFailure("verification_failed", error);
	}
	return writerWorkflowFailure("integration_conflict", error);
}

export function emitObservatoryUpdate<TDetails>(
	onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
	partialResult: AgentToolResult<TDetails>,
): void {
	try {
		onUpdate?.(partialResult);
	} catch {
		// Observability consumers are non-authoritative and must not affect execution.
	}
}

export function publishRuntimeProgress<TDetails>(
	store: SubagentObservatoryStore,
	toolCallId: string,
	toolName: ObservatoryToolName,
	cwd: string,
	event: SubagentEvent,
	onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
): SubagentProgressSnapshot | undefined {
	const streamKey = event.taskId ? `${toolCallId}/${event.taskId}` : toolCallId;
	const snapshot = store.applyRuntime({
		streamKey,
		toolName,
		event,
		cwd,
		model: event.model,
		taskId: event.taskId,
		attempt: event.attempt,
		currentPath: event.path,
	});
	if (snapshot) {
		emitObservatoryUpdate(onUpdate, {
			content: [{ type: "text", text: formatProgressSnapshot(snapshot) }],
			details: progressDetails(snapshot) as TDetails,
		});
	}
	return snapshot;
}

export function publishWorkflowProgress<TDetails>(
	store: SubagentObservatoryStore,
	streamKey: string,
	toolName: ObservatoryToolName,
	input: Omit<Parameters<SubagentObservatoryStore["applyWorkflow"]>[0], "streamKey" | "toolName">,
	onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
): SubagentProgressSnapshot | undefined {
	const snapshot = store.applyWorkflow({ ...input, streamKey, toolName });
	if (snapshot) {
		emitObservatoryUpdate(onUpdate, {
			content: [{ type: "text", text: formatProgressSnapshot(snapshot) }],
			details: progressDetails(snapshot) as TDetails,
		});
	}
	return snapshot;
}

export function publishBatchTaskProgress<TDetails>(
	store: SubagentObservatoryStore,
	aggregateStreamKey: string,
	toolName: ObservatoryToolName,
	event: SubagentBatchTaskLifecycleEvent,
	onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
): void {
	const snapshot = store.applyBatchTaskLifecycle({ aggregateStreamKey, toolName, event });
	if (snapshot) {
		emitObservatoryUpdate(onUpdate, {
			content: [{ type: "text", text: formatProgressSnapshot(snapshot) }],
			details: progressDetails(snapshot) as TDetails,
		});
	}
}

export function renderObservatoryCall(
	toolName: ObservatoryToolName,
	args: unknown,
	theme: Theme,
	context: ToolRenderContext,
): Component {
	const text = formatToolCall(toolName, args);
	const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	component.setText(theme.fg("accent", text));
	return component;
}

export function renderObservatoryResult<TDetails>(
	result: AgentToolResult<TDetails>,
	_options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): Component {
	const snapshot = getProgressSnapshot(result.details);
	const text = snapshot
		? formatProgressSnapshot(snapshot)
		: result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
	const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	component.setText(theme.fg(context.isError ? "error" : "success", text));
	return component;
}

function profileListingText(value: unknown): string {
	return typeof value === "string" ? redactCredentialText(value).replaceAll(/\s+/g, " ").trim() : "";
}

function padVisible(text: string, width: number): string {
	const truncated = truncateToWidth(text, Math.max(0, width), "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export function renderSubagentProfileCall(args: unknown, theme: Theme, context: ToolRenderContext): Component {
	const query = isRecord(args) && typeof args.query === "string" ? profileListingText(args.query) : "";
	const text = query ? `list_subagent_profiles · query: ${query}` : "list_subagent_profiles";
	const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	component.setText(theme.fg("accent", text));
	return component;
}

export function renderSubagentProfileResult(
	result: AgentToolResult<SubagentProfileListingDetails | undefined>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): Component {
	const details = isRecord(result.details) ? result.details : undefined;
	const profiles = details && Array.isArray(details.profiles) ? details.profiles.filter(isRecord) : [];
	const query = details ? profileListingText(details.query) : "";
	const queryMatched = details?.queryMatched;
	const lines: string[] = [];
	if (query && queryMatched === false) {
		lines.push(`No profile matched "${query}" · this does not mean the registry is empty.`);
		const suggestions =
			details && Array.isArray(details.suggestions)
				? details.suggestions.filter((value): value is string => typeof value === "string")
				: [];
		if (suggestions.length > 0) lines.push(`Suggestions: ${suggestions.slice(0, 8).join(", ")}`);
		const available =
			details && Array.isArray(details.availableProfileNames)
				? details.availableProfileNames.filter((value): value is string => typeof value === "string")
				: [];
		if (available.length > 0)
			lines.push(`Available: ${available.slice(0, 12).join(", ")}${available.length > 12 ? ", …" : ""}`);
	} else if (details) {
		const availableCount = profiles.filter((profile) => profile.availability === "available").length;
		lines.push(
			`list_subagent_profiles · ${profiles.length} profile${profiles.length === 1 ? "" : "s"} · ${availableCount} available for this invocation`,
		);
		const names = profiles
			.map((profile) => profileListingText(profile.name))
			.filter(Boolean)
			.slice(0, 32);
		if (names.length > 0) lines.push(names.join(", "));
		if (options.expanded) {
			const maxNameWidth = Math.min(
				20,
				Math.max(4, ...profiles.map((profile) => profileListingText(profile.name).length)),
			);
			for (const profile of profiles.slice(0, 64)) {
				const name = padVisible(profileListingText(profile.name), maxNameWidth);
				const source = padVisible(profileListingText(profile.source), 8);
				const availability = padVisible(profileListingText(profile.availability), 14);
				const tools = Array.isArray(profile.effectiveTools)
					? profile.effectiveTools.filter((tool): tool is string => typeof tool === "string").join(" ")
					: "";
				lines.push(`${name}  ${source}  ${availability}  ${tools}`.trimEnd());
				if (profile.effectiveModel) lines.push(`  model: ${profileListingText(profile.effectiveModel)}`);
				if (profile.fallbackModel) lines.push(`  fallback: ${profileListingText(profile.fallbackModel)}`);
				for (const skip of profile.modelCandidateSkips ?? [])
					lines.push(`  skipped ${profileListingText(skip.reference)}: ${profileListingText(skip.reason)}`);
			}
		}
		if (typeof details.diagnostic === "string" && details.diagnostic.trim())
			lines.push(profileListingText(details.diagnostic));
	} else {
		lines.push(
			result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n") || "Profile listing unavailable.",
		);
	}
	const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	component.setText(theme.fg(context.isError ? "error" : "success", lines.join("\n")));
	return component;
}
