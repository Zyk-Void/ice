/** Legacy subagent types, limits, and shared constants (moved from ice-subagents.ts). */
import { createHash } from "node:crypto";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import type { TSchema } from "typebox";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import type { SubagentProfileColor } from "../ice-agent-view-bridge.ts";
import {
	type ResolvedSubagentConcurrencyPolicy,
	SUBAGENT_CONCURRENCY_LIMITS,
	type SubagentConcurrencyAdmission,
} from "./registry/admission.ts";
import type { SubagentAssuranceLevel } from "./results/assurance.ts";
import type { SubagentOutput } from "./results/output-artifacts.ts";
import type {
	SubagentQualityMode,
	SubagentTaskContract,
	SubagentTaskContractKind,
	SubagentTaskContractVerificationInput,
} from "./results/task-contract.ts";
import type { SubagentCheckInState } from "./runtime/checkin.ts";
import type { SubagentContextManifest } from "./runtime/context-bootstrap.ts";
import type { SubagentHookRuntime } from "./runtime/live-session.ts";
import type { SubagentPreflightRequirement, SubagentPreflightRequirementInput } from "./runtime/preflight.ts";
import type { IceModelCandidateSkip, IceSubagentRouteSnapshot } from "./runtime/routing.ts";
import type {
	SubagentManagementChildState,
	SubagentRetryState,
	SubagentRuntimeAttention,
	SubagentToolActivityDigest,
} from "./runtime/supervisor.ts";
import type { IceHookDispatchRecord, IceResolvedSubagentContract } from "./settings.ts";
import type { IceResolvedDelegableTool } from "./tools/adapters.ts";
import type { ObservatoryPhase } from "./ui/observatory.ts";

const DELEGATED_SHELL_ENV_KEYS = new Set([
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"LC_MONETARY",
	"LC_NUMERIC",
	"LC_TIME",
	"PATH",
	"SHELL",
	"TERM",
	"TMPDIR",
]);

export function createDelegatedShellEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(environment).filter(([key, value]) => DELEGATED_SHELL_ENV_KEYS.has(key) && value !== undefined),
	);
}

export const SUBAGENT_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number];

/** Every built-in capability a profile may request. Safe launches still clamp this to SUBAGENT_TOOL_NAMES. */
export const SUBAGENT_REQUESTED_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
export type SubagentRequestedToolName = (typeof SUBAGENT_REQUESTED_TOOL_NAMES)[number];
export type SubagentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export const SUBAGENT_PROFILE_LIMITS = {
	minTimeoutMs: 1_000,
	maxTimeoutMs: 10 * 60 * 1_000,
	minTemperature: 0,
	maxTemperature: 2,
	minTopP: 0,
	maxTopP: 1,
} as const;

/** Conservative per-call ceiling for a management `wait`; expiry is never a child timeout. */
export const SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS = 60_000;
export const SUBAGENT_MANAGED_REQUEST_LIMIT = 256;
export const SUBAGENT_MANAGEMENT_WAIT_DEFAULT_MS = 30_000;
/** Bounded number of settled detached-run terminal results retained for post-terminal management. */
export const SUBAGENT_RETAINED_RESULT_LIMIT = 32;
/**
 * Bounded retention window granted to a detached child. It is separate from the
 * supervisor extension reserve, so detaching never spends the extension budget.
 */
export const SUBAGENT_DETACH_RETENTION_MS = 2 * 60 * 1_000;

/**
 * Bounded result of an observational management action. `waitExpired` is true
 * only when the parent's management window elapsed before a child state change;
 * it never implies the child timed out.
 */
export interface SubagentManagedObservation {
	readonly runId: string;
	readonly childState: SubagentManagementChildState;
	readonly terminal: boolean;
	readonly waitExpired: boolean;
	readonly attention?: SubagentRuntimeAttention;
	readonly checkIn?: SubagentCheckInState;
	readonly result?: SubagentResult;
}

/**
 * Launch-time admission handle for a retained managed child. It is delivered
 * once, when supervision starts, so the parent can return control before the
 * initial hard timeout while the same child session keeps running.
 */
export interface SubagentManagedHandle {
	readonly runId: string;
	readonly childSessionId?: string;
}

export interface UnsafeSubagentStartupArgOptions {
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
}

function hasArg(args: readonly string[], name: string): boolean {
	return args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
}

function flagValues(args: readonly string[], name: string): Array<string | boolean> {
	const values: Array<string | boolean> = [];
	for (const arg of args) {
		if (arg === name) values.push(true);
		else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
	}
	return values;
}

function optionValues(args: readonly string[], name: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === name) {
			values.push(args[index + 1] && !args[index + 1]!.startsWith("-") ? args[index + 1]! : "");
		} else if (arg.startsWith(`${name}=`)) {
			values.push(arg.slice(name.length + 1));
		}
	}
	return values;
}

export function normalizeUnsafeSubagentStartupArgs(
	args: readonly string[],
	options: UnsafeSubagentStartupArgOptions,
): string[] {
	const unsafeArgs = args.filter((arg) => arg === "--sub-yolo" || arg.startsWith("--sub-yolo="));
	const externalArgs = args.filter((arg) => arg === "--allow-external" || arg.startsWith("--allow-external="));
	if (unsafeArgs.length === 0 && externalArgs.length === 0) return [...args];
	for (const externalArg of externalArgs) {
		const externalValue = externalArg === "--allow-external" ? true : externalArg.slice("--allow-external=".length);
		if (externalValue !== true && externalValue !== "true") {
			throw new Error("--allow-external must be a boolean true flag");
		}
	}
	if (externalArgs.length > 1) throw new Error("Duplicate --allow-external flags are not allowed.");
	for (const unsafeArg of unsafeArgs) {
		const unsafeValue = unsafeArg === "--sub-yolo" ? true : unsafeArg.slice("--sub-yolo=".length);
		if (unsafeValue !== true && unsafeValue !== "true") {
			throw new Error("--sub-yolo must be a boolean true flag");
		}
	}
	if (unsafeArgs.length > 1) throw new Error("Duplicate --sub-yolo flags are not allowed.");
	const outputModes = optionValues(args, "--mode");
	const printFlags = args.filter((arg) => arg === "--print" || arg === "-p");
	if ((outputModes.length > 1 && outputModes.every((mode) => mode === outputModes[0])) || printFlags.length > 1) {
		throw new Error("Duplicate output mode flags are not allowed.");
	}
	const rpcMode = outputModes.length === 1 && outputModes[0] === "rpc";
	// Only --sub-yolo needs a live parent; --allow-external alone runs headless and MCP approvals fail closed there.
	const unsafe = unsafeArgs.length > 0;
	if (unsafe && (!options.stdinIsTTY || !options.stdoutIsTTY) && !rpcMode) {
		throw new Error(
			"Unsafe subagent host execution requires an interactive TUI or explicit RPC mode and is unavailable in print, JSON, or headless mode.",
		);
	}
	const modeValues = optionValues(args, "--ice-mode");
	if (modeValues.length > 1 && modeValues.every((mode) => mode === modeValues[0])) {
		throw new Error("Duplicate --ice-mode flags are not allowed.");
	}
	if (modeValues.length === 0 || modeValues.some((mode) => mode !== "build")) {
		throw new Error(
			unsafe
				? "Unsafe subagent host execution requires explicit --ice-mode build."
				: "--allow-external requires explicit --ice-mode build.",
		);
	}
	if (unsafe) {
		const bashValues = flagValues(args, "--ice-allow-bash");
		if (bashValues.length === 0 || bashValues.some((value) => value !== true && value !== "true")) {
			throw new Error("Unsafe subagent host execution requires --ice-allow-bash.");
		}
		if (bashValues.length > 1) throw new Error("Duplicate --ice-allow-bash flags are not allowed.");
	}
	if (hasArg(args, "--no-approve") || hasArg(args, "-na")) {
		throw new Error(
			unsafe
				? "Unsafe subagent host execution is incompatible with --no-approve."
				: "--allow-external is incompatible with --no-approve.",
		);
	}
	if (unsafe && (hasArg(args, "--print") || hasArg(args, "-p") || (outputModes.length > 0 && !rpcMode))) {
		throw new Error(
			"Unsafe subagent host execution requires an interactive TUI or explicit RPC mode and is unavailable in print, JSON, or headless mode.",
		);
	}
	const normalized = args.map((arg) => {
		if (arg === "--sub-yolo") return "--sub-yolo=true";
		if (arg === "--ice-allow-bash") return "--ice-allow-bash=true";
		if (arg === "--allow-external") return "--allow-external=true";
		return arg;
	});
	return normalized;
}

export const WRITER_TOOL_NAMES = ["read", "grep", "find", "ls", "write", "edit"] as const;
export type WriterToolName = (typeof WRITER_TOOL_NAMES)[number];

/**
 * `timed_out` and `needs_time` remain in the shared status vocabulary only
 * for historical/persisted compatibility. Current managed launches do not
 * emit either status after admission; startup deadline expiry is a failed
 * startup with a timeout diagnostic.
 */
export type SubagentStatus =
	| "created"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "needs_time"
	| "verification_failed";

export type SubagentFailureCode =
	| "unknown_profile"
	| "untrusted_profile"
	| "untrusted_resource"
	| "invalid_scope"
	| "invalid_request"
	| "invalid_resource"
	| "capability_denied"
	| "model_unavailable"
	| "auth_missing"
	| "child_startup_failure"
	| "child_runtime_failure"
	| "child_protocol_failure"
	| "timeout"
	| "cancellation"
	| "output_truncated"
	| "malformed_result"
	| "report_protocol_failure"
	| "preflight_failed"
	| "verification_failure"
	| "batch_budget_exhausted"
	| "batch_admission_exhausted"
	| "follow_up_budget_exhausted"
	| "provider_option_unsupported"
	| "writer_precondition"
	| "writer_workspace_failure"
	| "writer_patch_failure"
	| "integration_conflict"
	| "rollback_conflict"
	| "unsafe_parent_workspace";

export type SubagentProfileSource = "user" | "project" | "self";

export type SubagentProfileKind = "file" | "self";

/**
 * Parent-owned MCP capability metadata. The adapter, not a server description,
 * decides whether a selector is safe for a delegated child.
 */
export type IceSubagentMcpToolAccess = "read-only" | "mutation" | "unknown";

export interface IceSubagentMcpToolAuthorization {
	selector: string;
	access: IceSubagentMcpToolAccess;
	/** Actual installed tool schema. Required by public delegation admission. */
	parameters?: TSchema;
	description?: string;
}

/**
 * Optional host integration seam for an installed MCP adapter. ICE does
 * not discover servers, open connections, or authenticate on a child's
 * behalf. The host supplies an authorization snapshot and parent-owned
 * dispatch function instead.
 */
export interface IceSubagentMcpAdapter {
	/** Optional identity of a host adapter behind a proxy; replacement revokes captured dispatch. */
	getIdentity?: () => object | undefined;
	listAuthorizedTools(): readonly IceSubagentMcpToolAuthorization[];
	dispatch(server: string, tool: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export const parentMcpAdapters = new WeakMap<object, IceSubagentMcpAdapter>();

/** Trusted parent extension seam. Registration never creates a server connection or authenticates. */
export function registerIceSubagentMcpAdapter(owner: object, adapter: IceSubagentMcpAdapter): () => void {
	if (parentMcpAdapters.has(owner)) throw new Error("Duplicate parent MCP adapter registration.");
	if (typeof adapter.listAuthorizedTools !== "function" || typeof adapter.dispatch !== "function")
		throw new Error("Invalid MCP adapter.");
	parentMcpAdapters.set(owner, adapter);
	return () => {
		if (parentMcpAdapters.get(owner) === adapter) parentMcpAdapters.delete(owner);
	};
}

export function subagentMcpToolName(selector: string): string {
	const label = selector.replace(/[^A-Za-z0-9]/g, "_").slice(0, 40);
	return `mcp_${label}_${createHash("sha256").update(selector).digest("hex").slice(0, 12)}`;
}

export type SubagentProfileAvailability = "available" | "limited" | "requires_yolo" | "invalid" | "untrusted";

export const SUBAGENT_PROFILE_TAG_LIMITS = {
	maxTags: 8,
	maxTagBytes: 32,
} as const;

export interface SubagentProfile {
	name: string;
	description: string;
	systemPrompt: string;
	/** W08/W10: optional bounded discoverability tags; never authority or executable content. */
	tags?: readonly string[];
	hooks?: readonly string[];
	/** Capabilities requested by the profile; authority is derived for each invocation. */
	requestedTools: readonly string[];
	/** Compatibility alias for callers written before requested/effective capabilities were split. */
	tools: readonly string[];
	thinkingLevel: SubagentThinkingLevel;
	timeoutMs: number;
	temperature?: number;
	topP?: number;
	/** Appearance-only semantic theme token; it never affects authority. */
	color?: SubagentProfileColor;
	/** Discovery-only flag; direct explicit role resolution remains allowed. */
	hidden?: boolean;
	resources?: SubagentResourceSelection;
	unsafeHostExec?: boolean;
	requestedModel?: string;
	/** Effective fallback model from the file agent; parent model is the final candidate. */
	fallbackModel?: string;
	/** Explicit parent-owned adapter IDs requested by this profile; default none. */
	adapterIds?: readonly string[];
	/** Selected MCP tools (server/tool), validated at admission; default none. */
	mcpTools?: readonly string[];
	/** Self-delegation marker; file agents omit this. */
	selfDelegated?: boolean;
	modelPolicy: "inherit-parent";
	diagnostics?: readonly string[];
}

export interface ResolvedSubagentProfile extends SubagentProfile {
	source: SubagentProfileSource;
	sourcePath: string;
	canonicalPath: string;
	sourceHash: string;
}

export interface SubagentProfileSummary {
	name: string;
	description: string;
	source: SubagentProfileSource;
	sourcePath: string;
	/** W08: stable discoverability metadata; bounded tags, never executable resources. */
	tags?: readonly string[];
	effectiveThinkingLevel?: SubagentThinkingLevel;
	effectiveCheckInIntervalMs?: number;
	effectiveTimeoutMs?: number;
	requestedTemperature?: number;
	effectiveTemperature?: number;
	requestedTopP?: number;
	effectiveTopP?: number;
	color?: SubagentProfileColor;
	effectiveSettingSources?: Readonly<{
		thinking: string;
		checkInIntervalMs: string;
		timeoutMs: string;
		temperature: string;
		topP: string;
	}>;
	profileDiagnostics?: readonly string[];
	unsafeHostExec: boolean;
	/** Capabilities declared by the profile, not capabilities granted to this invocation. */
	requestedTools: readonly string[];
	/** Capabilities granted under the listing invocation's effective policy. */
	effectiveTools: readonly string[];
	effectiveModel?: string;
	modelCandidateSkips?: readonly IceModelCandidateSkip[];
	effectiveMcpTools?: readonly string[];
	/** Adapter IDs requested by the profile; they are not authority by themselves. */
	requestedAdapters?: readonly string[];
	/** Adapter IDs admitted from the current parent registration/policy snapshot. */
	effectiveAdapters?: readonly string[];
	/** Compatibility alias for older consumers. */
	tools: readonly string[];
	availability: SubagentProfileAvailability;
	diagnostics?: readonly string[];
	requestedModel?: string;
	fallbackModel?: string;
	mcpTools?: readonly string[];
	selfDelegated?: boolean;
}

export type SubagentResourceKind = "skill" | "prompt" | "context";

export interface SubagentResourceSelection {
	skills?: string[];
	prompts?: string[];
	context?: string[];
}

export interface SubagentResourceProvenance {
	kind: SubagentResourceKind;
	name: string;
	source: SubagentProfileSource;
	sourcePath: string;
	canonicalPath: string;
	sourceHash: string;
}

export interface ResolvedSubagentResources {
	skills: SubagentResourceProvenance[];
	prompts: SubagentResourceProvenance[];
	context: SubagentResourceProvenance[];
}

/** Parent-facing presentation cap for single and aggregate subagent tool results. */
export const SUBAGENT_PRESENTATION_LIMIT_BYTES = 64 * 1024;

export const SUBAGENT_BATCH_LIMITS = {
	maxTasks: 8,
	defaultConcurrency: SUBAGENT_CONCURRENCY_LIMITS.bundledDefault,
	maxConcurrency: SUBAGENT_CONCURRENCY_LIMITS.hardCap,
	maxManagedBatches: 16,
	retainedManagedBatches: 32,
} as const;

export const SUBAGENT_PROFILE_ALIASES: Readonly<Record<string, string>> = Object.freeze({});

export const SUBAGENT_PROFILES: Readonly<Record<string, SubagentProfile>> = Object.freeze({});

/** File agents and self-delegation only; the hardcoded specialist catalog was removed. */
export function isBundledSubagentProfileName(_name: string): boolean {
	return false;
}

export interface SubagentScope {
	roots: string[];
	targets?: string[];
}

export const SUBAGENT_SCOPE_FIELD = "scope.roots";
export const SUBAGENT_SCOPE_TARGET_FIELD = "scope.targets";
export const SUBAGENT_SCOPE_ROOT_HINT =
	'scope.roots accepts existing directories only. For the current workspace, prefer scope.roots:["."]. Use relative subdirectories when narrower scope is sufficient. To inspect a specific file, use its parent directory as a root and identify the file in scope.targets or the task. Do not reconstruct the absolute cwd when "." is sufficient.';
export const SUBAGENT_SCOPE_TARGET_HINT =
	"scope.targets accepts existing regular files only and narrows the directory authority granted by scope.roots.";
export const SUBAGENT_SCOPE_TOOL_GUIDANCE =
	'scope.roots accepts existing directories only. For the current workspace, prefer scope.roots:["."] and use relative subdirectories when narrower scope is sufficient. To focus a file, use its parent directory in scope.roots and the file in scope.targets or task text. Do not reconstruct the absolute cwd when "." is sufficient.';
export const SUBAGENT_INTERNAL_REPORT_GUIDANCE =
	"Typed child runs (output schema, acceptance criteria, review batches) use the runtime's internal bounded structured final-report protocol; describe the task normally and do not ask the child to format its work as JSON. Ordinary delegations answer in plain prose; the runtime ingests the child's natural final assistant turn directly.";

export const SUBAGENT_DELEGATION_POLICY_GUIDELINES: readonly string[] = [
	"Do not delegate a simple single task: when the whole job is one straightforward piece of work you can do directly with your own tools, do it yourself instead of launching a subagent.",
	"Delegate only when the work fans out to two or more children (delegate_batch or concurrent background delegate launches).",
	"Brief every child as a zero-context collaborator: a child sees no parent conversation history, so a terse task string produces shallow work. State the objective and why it matters, not just the command to run.",
	"Include what you already know in the brief: relevant file paths with line hints, verified facts, approaches already tried or ruled out, and constraints discovered so far. Do not delegate understanding you already have.",
	"State the exact deliverable and response form: what the child must return, which evidence paths support it, and what to do when evidence is insufficient (report uncertainty; never fill gaps with plausible invention).",
	"State how to verify when possible: the command, test, or check that establishes the work is done, and tell the child to run it when it has the tools to do so.",
	"Tell the child what not to do: name non-goals, out-of-scope files, and forbidden actions explicitly; scope.roots grants authority, the brief defines intent.",
	"Keep sibling scopes independent so children cannot conflict, and perform synthesis yourself in the parent: children return evidence and findings, the parent reconciles disagreements and draws conclusions.",
];

export const SUBAGENT_CONTEXT_PACKET_LIMITS = {
	maxItems: 16,
	maxItemBytes: 32 * 1024,
	maxTotalBytes: 256 * 1024,
} as const;

export type SubagentContextItemKind = "parent_note" | "verified_fact" | "evidence_ref" | "artifact_ref";

export interface SubagentContextItemInput {
	id: string;
	kind: SubagentContextItemKind;
	content: string;
}

export interface SubagentContextItem extends SubagentContextItemInput {
	readonly bytes: number;
}

export interface SubagentContextPacketInput {
	items: readonly SubagentContextItemInput[];
}

export interface SubagentContextPacket {
	readonly items: readonly SubagentContextItem[];
	readonly totalBytes: number;
}

export type SubagentContextMode = "fresh" | "fork";

export const SUBAGENT_FORK_CONTEXT_LIMITS = {
	maxMessages: 64,
	maxMessageBytes: 32 * 1024,
	maxTotalBytes: 256 * 1024,
} as const;

export const SUBAGENT_HANDOFF_CONTEXT_LIMITS = {
	maxTotalBytes: 256 * 1024,
} as const;

export const SUBAGENT_REPORT_LIMITS = {
	maxEvidencePaths: 64,
	maxEvidencePathBytes: 4096,
} as const;

/** Fixed parser/input safety bound, independent of child execution and parent display size. */
export const SUBAGENT_REPORT_PARSER_LIMITS = {
	maxBytes: 24 * 1024,
} as const;

/**
 * How a child run's final answer is ingested. Plain runs ingest the natural
 * final assistant turn directly; typed flows (output schema, acceptance
 * criteria, review batches) keep the strict bounded JSON report protocol.
 */
export type SubagentReportMode = "plain_final_turn" | "structured_report";

export const SUBAGENT_WRAP_UP_LIMITS = {
	wallReserveRatio: 0.2,
	minimumWallReserveMs: 1_000,
	maximumWallReserveMs: 10_000,
} as const;

export const SUBAGENT_REPORT_ARTIFACT_LIMITS = {
	maxBytes: 512 * 1024,
	inlineSummaryBytes: 8 * 1024,
} as const;

/** Bounded final-report protocol states. A malformed report is never a verified completion. */
export type SubagentReportProtocolStatus = "valid" | "malformed" | "missing" | "truncated" | "plain";

/** Child claim for one parent acceptance criterion inside the hidden final-report protocol. */
export type SubagentRequirementClaimStatus = "satisfied" | "partial" | "blocked" | "failed" | "not_attempted";

export interface SubagentRequirementClaim {
	id: string;
	status: SubagentRequirementClaimStatus;
	note?: string;
	evidencePaths?: string[];
}

export interface SubagentReportArtifact {
	schemaVersion: 1;
	id: string;
	path: string;
	bytes: number;
	originalBytes: number;
	sha256: string;
	contentType: "text/plain" | "application/json";
	truncated: boolean;
}

/**
 * Runtime-owned bounded projection of what a child actually did. It is derived
 * from observed runtime activity, never from model-claimed content, and it
 * survives report-protocol failures so useful work is not silently discarded.
 */
export interface SubagentWorkArtifact {
	schemaVersion: 1;
	runId: string;
	childSessionId?: string;
	profile: string;
	startedAtMs: number;
	finishedAtMs?: number;
	lastActivities: readonly SubagentToolActivityDigest[];
	observedOutputBytes: number;
	/** Paths observed from child write/edit tool activity inside the approved scope. */
	touchedPaths: readonly string[];
	/** Unverified report-claimed or report-extracted paths; never trusted evidence. */
	candidateEvidencePaths: readonly string[];
	reportProtocol: {
		status: SubagentReportProtocolStatus;
		diagnostic?: string;
	};
	requirementClaims?: readonly SubagentRequirementClaim[];
}

export type SubagentAcceptanceEvidenceKind = "path" | "test" | "behavior" | "finding" | "none";

export interface SubagentAcceptanceCriterionInput {
	id: string;
	requirement: string;
	/** Defaults to true; optional incomplete criteria stay visible without failing completion. */
	required?: boolean;
	evidence?: SubagentAcceptanceEvidenceKind;
	/** Bounded quality dimension such as "visual", "accessibility", or "performance". */
	dimension?: string;
}

export interface SubagentAcceptanceCriterion {
	id: string;
	requirement: string;
	required: boolean;
	evidence: SubagentAcceptanceEvidenceKind;
	dimension?: string;
}

export type SubagentOutputSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

/** Restricted local JSON schema used only for a bounded nested result payload. */
export interface SubagentOutputSchemaNode {
	readonly type: SubagentOutputSchemaType;
	readonly properties?: Readonly<Record<string, SubagentOutputSchemaNode>>;
	readonly required?: readonly string[];
	readonly items?: SubagentOutputSchemaNode;
	readonly additionalProperties?: false;
}

export const SUBAGENT_OUTPUT_SCHEMA_LIMITS = {
	maxSchemaBytes: 8 * 1024,
	maxDepth: 5,
	maxNodes: 64,
	maxPropertiesPerObject: 16,
	maxRequiredProperties: 16,
	maxPropertyNameBytes: 64,
	maxPayloadBytes: 16 * 1024,
	maxArrayItems: 64,
	maxStringBytes: 8 * 1024,
} as const;

export const SUBAGENT_ACCEPTANCE_LIMITS = {
	maxCriteria: 16,
	maxIdBytes: 64,
	maxRequirementBytes: 1024,
	maxAggregateBytes: 16 * 1024,
	maxDimensionBytes: 32,
} as const;

export interface SubagentRequirementState {
	id: string;
	required: boolean;
	dimension?: string;
	/** Parent-verified state. Absent claims count as missing, never as satisfied. */
	claim?: SubagentRequirementClaimStatus;
	verified: boolean;
	note?: string;
}

export interface SanitizedForkMessage {
	readonly index: number;
	readonly role: "user" | "assistant" | "summary";
	readonly content: string;
	readonly bytes: number;
}

export interface SubagentForkDropped {
	readonly thinking: number;
	readonly toolCalls: number;
	readonly toolResults: number;
	readonly images: number;
	readonly custom: number;
	readonly empty: number;
}

export interface SubagentForkContext {
	readonly mode: SubagentContextMode;
	readonly sourceSessionId?: string;
	readonly sourceLeafId?: string;
	readonly messages: readonly SanitizedForkMessage[];
	readonly totalBytes: number;
	readonly dropped: SubagentForkDropped;
}

export interface SubagentForkContextSource {
	getSessionId(): string;
	getLeafId(): string | null;
	buildSessionContext(): { messages: readonly AgentMessage[] };
}

/**
 * W12: shared optional per-call execution overrides. Every field is a request
 * that must be validated and enforced by the runtime; prompt text alone never
 * satisfies an output bound or tool restriction. `model` stays deferred pending
 * the W19 routing decision; exact parent-model inheritance remains the default.
 */
export interface SubagentExecutionOverrideInput {
	model?: string;
	/** Optional approved hook IDs; empty selects no optional hooks. */
	hooks?: string[];
	thinking?: SubagentThinkingLevel;
	tools?: string[];
	temperature?: number;
	topP?: number;
}

export interface SubagentExecutionContract {
	thinking: SubagentThinkingLevel;
	tools: readonly string[] | undefined;
	temperature?: number;
	topP?: number;
}

export const SUBAGENT_EXECUTION_LIMITS = {
	minTemperature: 0,
	maxTemperature: 2,
	minTopP: 0,
	maxTopP: 1,
} as const;

/** Fixed bound for each delegated external-tool response, independent of final-answer retention. */
export const SUBAGENT_DELEGABLE_TOOL_OUTPUT_MAX_BYTES = 24 * 1024;

export interface SubagentRequest {
	parentSessionId: string;
	role: string;
	task: string;
	scope: SubagentScope;
	cwd?: string;
	context?: string;
	contextPacket?: SubagentContextPacketInput;
	contextMode?: SubagentContextMode;
	/** Optional semantic delegation kind; defaults to "explore" for legacy calls. */
	kind?: SubagentTaskContractKind;
	/** Optional explicit deliverable statement; defaults to a kind-specific sentence. */
	deliverable?: string;
	/** Optional explicit constraints; bounded and redacted, never authority. */
	constraints?: readonly string[];
	/** Optional explicit non-goals; scope authority is unchanged. */
	nonGoals?: readonly string[];
	/** Optional declarative verification hints; commands are never auto-executed. */
	verification?: SubagentTaskContractVerificationInput;
	checkInIntervalMs?: number;
	timeoutMs?: number;
	execution?: SubagentExecutionOverrideInput;
	resources?: SubagentResourceSelection;
	acceptanceCriteria?: SubagentAcceptanceCriterionInput[];
	preflight?: SubagentPreflightRequirementInput[];
	/** Optional restricted local schema for a bounded nested `payload` result. */
	outputSchema?: Record<string, unknown>;
	/** Self-delegation inputs: parent instruction snapshot source, never bundled roles. */
	self?: SelfDelegationInput;
}

export interface SelfDelegationInput {
	/** Bounded task-specific addition. The actual parent instruction snapshot remains authoritative. */
	instructions?: string;
	/** Eligible parent tool identities, narrowed at admission and dispatch. */
	capabilities?: readonly string[];
	/** Explicitly inherit the parent's currently loaded, hash-checked skill files. Default false. */
	inheritSkills?: boolean;
	/** Explicit MCP server/tool selection; never ambient connection or credential inheritance. */
	mcp?: readonly string[];
}

export interface WriterRequest {
	parentSessionId: string;
	task: string;
	scope: SubagentScope;
	baseCommit: string;
	cwd?: string;
	timeoutMs?: number;
}

export interface NormalizedWriterRequest extends Omit<WriterRequest, "scope" | "cwd" | "timeoutMs"> {
	scope: { roots: string[] };
	cwd: string;
	timeoutMs: number;
	allowExternal: boolean;
}

export interface WriterLaunchPreflight {
	parentRoot: string;
	parentHead: string;
	baseCommit: string;
	statusPorcelain: string;
}

export interface WriterWorkspace {
	parentRoot: string;
	root: string;
	baseCommit: string;
	cleanup: () => Promise<void>;
}

export type WriterResultStatus = "completed" | "failed" | "cancelled" | "timed_out";

export const WRITER_PATCH_LIMITS = {
	maxChangedFiles: 32,
	maxPatchBytes: 512 * 1024,
} as const;
export const WRITER_PATCH_PREVIEW_LIMIT_BYTES = 32 * 1024;

export interface WriterPatchFile {
	path: string;
	change: "add" | "modify" | "delete";
	beforeSha256?: string;
	afterSha256?: string;
}

export interface WriterPatchArtifact {
	schemaVersion: 1;
	runId: string;
	baseCommit: string;
	changedFileCount: number;
	patchBytes: number;
	patchSha256: string;
	patchRef: string;
	files: WriterPatchFile[];
}

export type ReadonlyWriterPatchArtifact = Readonly<Omit<WriterPatchArtifact, "files">> & {
	files: readonly Readonly<WriterPatchFile>[];
};

export interface WriterResult {
	runId: string;
	parentSessionId: string;
	status: WriterResultStatus;
	workspaceIsolation?: "worktree" | "parent";
	summary: string;
	baseCommit: string;
	observedOutputBytes: number;
	output?: SubagentOutput;
	workspaceRemoved: boolean;
	diagnostics: SubagentDiagnostic[];
	patchArtifact?: WriterPatchArtifact;
	usage?: SubagentUsage;
}

export interface NormalizedSubagentRequest
	extends Omit<
		SubagentRequest,
		| "role"
		| "scope"
		| "cwd"
		| "timeoutMs"
		| "execution"
		| "resources"
		| "context"
		| "contextPacket"
		| "contextMode"
		| "checkInIntervalMs"
		| "acceptanceCriteria"
		| "preflight"
		| "outputSchema"
	> {
	runId: string;
	role: string;
	agentKind: "file" | "self";
	contextMode: SubagentContextMode;
	checkInIntervalMs: number;
	hookIds?: readonly string[];
	requestedModel?: string;
	fallbackModel?: string;
	selectedMcpTools?: readonly string[];
	/** Profile-selected parent adapter IDs; never serialized as executable authority. */
	selectedAdapterIds?: readonly string[];
	mcpAuthorizations?: readonly IceSubagentMcpToolAuthorization[];
	mcpAuthorityStillValid?: () => boolean;
	/** In-process adapters are never serialized; durable jobs store fingerprints only. */
	delegatedTools?: readonly IceResolvedDelegableTool[];
	inheritedSkills?: boolean;
	/** Review tasks remain read-only even when the parent has host authority. */
	readOnlyReview?: boolean;
	routeSnapshot?: IceSubagentRouteSnapshot;
	/** Parent-owned in-process recovery seam; never serialized into a durable job. */
	resolveStartupFallback?: (retryRequest: NormalizedSubagentRequest) => Model<Api>;
	retryModel?: Model<Api>;
	modelCandidates?: readonly string[];
	modelCandidateSkips?: readonly IceModelCandidateSkip[];
	profile: ResolvedSubagentProfile;
	scope: { roots: string[]; targets?: string[] };
	cwd: string;
	timeoutMs: number;
	/** W12–W18: enforced execution contract actually applied by the runner. */
	execution: SubagentExecutionContract;
	/** W13: whether execution.thinking came from an explicit caller override. */
	executionThinkingExplicit: boolean;
	/** W14: caller subset after profile/mode eligibility; dispatch re-checks denial. */
	requestedTools: readonly string[] | undefined;
	/** W06: deny-first tool restrictions from trusted settings layers. */
	deniedTools: readonly string[];
	/** Resolved settings and provenance frozen before launch admission. */
	iceContract: IceResolvedSubagentContract;
	contextPacket: SubagentContextPacket;
	forkContext: SubagentForkContext;
	resources: ResolvedSubagentResources;
	projectTrusted: boolean;
	allowExternal: boolean;
	acceptanceCriteria: readonly SubagentAcceptanceCriterion[];
	preflight: readonly SubagentPreflightRequirement[];
	outputSchema?: SubagentOutputSchemaNode;
	/** Resolved at normalization; typed flows force the structured report protocol. */
	reportMode: SubagentReportMode;
	/** Host-owned delegation semantics derived at normalization; never authority. */
	taskContract: SubagentTaskContract;
	qualityMode: SubagentQualityMode;
	taskContractHash: string;
	/** Phase 2: hash-verified instruction/orientation manifest for the approved scope. */
	contextManifest?: SubagentContextManifest;
	/** Phase 7.1 semantic worker tier derived from the task kind. */
	semanticWorkerTier?: "mechanical" | "judgment";
	/** Phase 7.1 route provenance for quality diagnosis. */
	routeSource: "explicit" | "tier" | "parent";
}

export interface SubagentBatchTask {
	id: string;
	role: string;
	task: string;
	scope: SubagentScope;
	context?: string;
	contextPacket?: SubagentContextPacketInput;
	contextMode?: SubagentContextMode;
	kind?: SubagentTaskContractKind;
	deliverable?: string;
	constraints?: readonly string[];
	nonGoals?: readonly string[];
	verification?: SubagentTaskContractVerificationInput;
	checkInIntervalMs?: number;
	timeoutMs?: number;
	execution?: SubagentExecutionOverrideInput;
	resources?: SubagentResourceSelection;
	acceptanceCriteria?: SubagentAcceptanceCriterionInput[];
	preflight?: SubagentPreflightRequirementInput[];
	outputSchema?: Record<string, unknown>;
}

export interface ReviewerModelProvenance {
	source: "parent" | "call";
	resolved: string;
}

export interface ResolvedSubagentBatchTask {
	id: string;
	request: NormalizedSubagentRequest;
	model?: Model<Api>;
	modelProvenance?: ReviewerModelProvenance;
	hookRuntime?: SubagentHookRuntime;
}

export interface SubagentUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
}

export interface SubagentDiagnostic {
	code:
		| SubagentFailureCode
		| "output_truncated"
		| "output_artifact_truncated"
		| "output_artifact_unavailable"
		| "output_artifact_integrity_failure"
		| "report_spilled"
		| "report_artifact_failure";
	message: string;
	retryable?: boolean;
}

export const REVIEW_DIMENSIONS = ["correctness", "security", "tests", "regressions"] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

export interface EvidenceRef {
	path: string;
}

export interface ReviewFinding {
	severity: "low" | "medium" | "high";
	category: string;
	claim: string;
	evidence: EvidenceRef[];
}

export interface ReviewTask {
	id: string;
	dimension: ReviewDimension;
	task: string;
	scope: SubagentScope;
	evidence?: EvidenceRef[];
	context?: string;
	contextPacket?: SubagentContextPacketInput;
	contextMode?: SubagentContextMode;
	checkInIntervalMs?: number;
	timeoutMs?: number;
	execution?: SubagentExecutionOverrideInput;
	resources?: SubagentResourceSelection;
	outputSchema?: Record<string, unknown>;
}

export interface ResolvedReviewTask extends ResolvedSubagentBatchTask {
	dimension: ReviewDimension;
}

export interface SubagentEvidence {
	paths: string[];
}

export interface SubagentRun {
	runId: string;
	parentSessionId: string;
	childSessionId?: string;
	profile: SubagentProfile["name"];
	status: SubagentStatus;
}

export type SubagentAttemptNumber = 1 | 2;

export interface SubagentAttemptSummary {
	attempt: SubagentAttemptNumber;
	status: SubagentStatus;
	failureCode?: SubagentDiagnostic["code"];
	observedOutputBytes: number;
}

export interface SubagentRecoveryMetadata {
	attemptCount: SubagentAttemptNumber;
	retried: boolean;
	totalObservedOutputBytes: number;
	attempts: readonly SubagentAttemptSummary[];
}

export interface SubagentResult {
	/** Observed selected provider/model identity, including approved startup fallback. */
	model?: string;
	/** Native runner attestation that no child session or tool effects occurred. */
	retrySafeStartup?: boolean;
	modelCandidateSkips?: readonly IceModelCandidateSkip[];
	runId: string;
	parentSessionId: string;
	childSessionId?: string;
	profile: SubagentProfile["name"];
	source: SubagentProfileSource;
	status: SubagentStatus;
	summary: string;
	observedOutputBytes: number;
	partial: boolean;
	/** Stage 3 reuse provenance: the retained run this execution continues. */
	resumedFromRunId?: string;
	/** Present only for a retained, nonterminal timeout-attention result. */
	attention?: SubagentRuntimeAttention;
	truncated?: boolean;
	diagnostics: SubagentDiagnostic[];
	usage?: SubagentUsage;
	recovery?: SubagentRecoveryMetadata;
	evidence?: SubagentEvidence;
	findings?: ReviewFinding[];
	scopeTargets?: string[];
	/** Runtime-owned bounded projection of observed work; survives report-protocol failures. */
	workArtifact?: SubagentWorkArtifact;
	/** Bounded final-answer projection and optional owner-scoped artifact reference. */
	output?: SubagentOutput;
	/** Child claims for parent acceptance criteria; untrusted until parent-verified. */
	requirementClaims?: readonly SubagentRequirementClaim[];
	/** Parent-verified requirement states; present when acceptance criteria were declared. */
	requirementStates?: readonly SubagentRequirementState[];
	/** Optional bounded payload validated against the caller's restricted local schema. */
	payload?: Readonly<Record<string, unknown>>;
	/** Bounded actual Ice turn count observed by the child runner. */
	observedTurns?: number;
	/** Redacted bounded hook dispatch projection for parent inspection. */
	hookRecords?: readonly IceHookDispatchRecord[];
	/** How the final answer was ingested; plain mode performs no structured verification. */
	reportMode?: SubagentReportMode;
	/** Host-derived semantic completion class promised for this delegation. */
	qualityMode?: SubagentQualityMode;
	/** Deterministic hash of the normalized task contract for telemetry/replay. */
	taskContractHash?: string;
	/** Deterministic hash of the context manifest for telemetry/replay. */
	contextManifestHash?: string;
	/** Phase 5: descriptive assurance level derived from runtime-observed state. */
	assurance?: SubagentAssuranceLevel;
	/** Resolved reasoning level applied to this run (Phase 3.3 provenance). */
	reasoningLevel?: string;
	/** Phase 4.3: host-owned count of distinct follow-ups accepted for this run. */
	followUpCount?: number;
	/** Bounded count of the strongest repeated-failure advisory observed at settle. */
	repeatedFailureCount?: number;
	/** Phase 5.5: whether this run went through the read-only reviewer gate. */
	reviewerUsed?: boolean;
	reviewerOutcome?: "verified" | "disagreed";
	/** Phase 5.5: task policy recommends a review_batch gate before integration. */
	reviewerGateRecommended?: boolean;
	/** Phase 7.1 semantic worker tier and route provenance. */
	semanticWorkerTier?: "mechanical" | "judgment";
	routeSource?: "explicit" | "tier" | "parent";
	/** Runtime-owned evidence-type counts; no raw evidence payloads. */
	evidenceTypes?: {
		path: number;
		command: number;
		artifact: number;
		diff: number;
		blocked: number;
	};
}

export interface SubagentVerification {
	verified: boolean;
	reason: string;
	paths: string[];
	unresolvedClaims: string[];
	/**
	 * Explicit verification contract: "structured" means the strict JSON report
	 * pipeline (schema/evidence/payload) ran; "plain_bounds" means only lineage,
	 * status, and the output bound were checked. Absent in legacy producers.
	 */
	kind?: "structured" | "plain_bounds";
	/** True only when structured-report verification succeeded; never implied by plain text. */
	structuredVerified?: boolean;
	/** Bounded per-criterion verification detail; present when acceptance criteria were declared. */
	requirementSummary?: SubagentRequirementSummary;
}

export interface SubagentRequirementSummary {
	readonly total: number;
	readonly required: number;
	readonly requiredSatisfied: number;
	readonly states: readonly SubagentRequirementState[];
	/** True when required visual/quality criteria remain unmet while functional checks passed. */
	readonly visualAcceptancePending: boolean;
}

export interface SubagentLaunchProvenance {
	profile: Pick<
		ResolvedSubagentProfile,
		"name" | "source" | "sourcePath" | "canonicalPath" | "sourceHash" | "unsafeHostExec" | "color"
	>;
	resources: ResolvedSubagentResources;
	projectTrusted: boolean;
	allowExternal: boolean;
	model?: string;
	modelProvenance?: ReviewerModelProvenance;
	modelCandidates?: readonly string[];
	modelCandidateSkips?: readonly IceModelCandidateSkip[];
	mcpTools?: readonly string[];
	/** Explicit profile adapter selectors captured at launch. */
	adapterIds?: readonly string[];
	scopeRoots: string[];
	scopeTargets: string[];
	checkIn: { intervalMs: number; source: string };
	execution: {
		thinking: SubagentThinkingLevel;
		timeoutMs: number;
		temperature?: number;
		topP?: number;
		tools?: readonly string[];
		sources: {
			thinking: string;
			timeoutMs: string;
			temperature: string;
			topP: string;
		};
		restrictionsApplied: readonly string[];
	};
	settingsDiagnostics: readonly string[];
	deniedTools: readonly string[];
	outputSchema?: { schemaBytes: number; maxPayloadBytes: number };
}

export interface SubagentLaunchPreflightTask {
	taskId: string;
	role: string;
	cwd: string;
	model: {
		resolved?: string;
		source: "parent" | "call";
		candidates?: readonly string[];
		skipped?: readonly IceModelCandidateSkip[];
	};
	mcpTools?: readonly string[];
	/** Explicit profile adapter selectors, if any. */
	adapterIds?: readonly string[];
	scopeRoots: string[];
	scopeTargets: string[];
	tools: string[];
	resources: {
		skills: string[];
		prompts: string[];
		context: string[];
	};
	execution: {
		thinking: SubagentThinkingLevel;
		timeoutMs: number;
		temperature?: number;
		topP?: number;
		tools: readonly string[] | undefined;
	};
	outputSchema?: { schemaBytes: number; maxPayloadBytes: number };
	resourceProvenance: {
		skills: Array<Pick<SubagentResourceProvenance, "kind" | "name" | "source" | "canonicalPath" | "sourceHash">>;
		prompts: Array<Pick<SubagentResourceProvenance, "kind" | "name" | "source" | "canonicalPath" | "sourceHash">>;
		context: Array<Pick<SubagentResourceProvenance, "kind" | "name" | "source" | "canonicalPath" | "sourceHash">>;
	};
	contextPacket: {
		itemCount: number;
		totalBytes: number;
		items: Array<{ id: string; kind: SubagentContextItemKind; bytes: number }>;
	};
	forkContext: {
		mode: SubagentContextMode;
		sourceSessionId?: string;
		sourceLeafId?: string;
		messageCount: number;
		totalBytes: number;
		dropped: SubagentForkDropped;
	};
	contextBudget: {
		packetBytes: number;
		forkBytes: number;
		totalBytes: number;
		maxBytes: number;
	};
	projectTrusted: boolean;
}

export interface SubagentLaunchPreflight {
	batchId?: string;
	taskCount: number;
	concurrency: number;
	recovery: {
		maxAttempts: 1 | 2;
		sameModel: boolean;
		retryableFailures: readonly "explicit_transient_startup"[];
	};
	tasks: SubagentLaunchPreflightTask[];
}

export type SubagentBatchStatus = "completed" | "partial" | "failed" | "cancelled" | "timed_out";

export type AggregateUsage = SubagentUsage;

export interface SubagentBatchItemResult {
	taskId: string;
	launch: SubagentLaunchProvenance;
	result: SubagentResult;
	verification: SubagentVerification;
}

export type BatchItemResult = SubagentBatchItemResult;
export type LaunchProvenance = SubagentLaunchProvenance;

export interface SubagentBatchResult {
	batchId: string;
	status: SubagentBatchStatus;
	preflight: SubagentLaunchPreflight;
	items: SubagentBatchItemResult[];
	usage: AggregateUsage;
	diagnostics: SubagentDiagnostic[];
}

export interface ReviewerResult {
	taskId: string;
	dimension: ReviewDimension;
	findings: ReviewFinding[];
	verification: SubagentVerification;
	result: SubagentResult;
	launch: SubagentLaunchProvenance;
	modelProvenance: ReviewerModelProvenance;
}

export interface ReviewBatchResult {
	batchId: string;
	status: SubagentBatchStatus;
	preflight: SubagentLaunchPreflight;
	reviewers: ReviewerResult[];
	usage: AggregateUsage;
	diagnostics: SubagentDiagnostic[];
}

type ManagedBatchTaskStatus = "queued" | "admitted" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface ManagedBatchTaskState {
	taskId: string;
	runId: string;
	role: string;
	model: string;
	status: ManagedBatchTaskStatus;
	checkIn?: SubagentCheckInState;
	currentTool?: string;
	currentPath?: string;
}

export interface ManagedSubagentBatchRecord {
	readonly batchId: string;
	readonly ownerSessionId: string;
	readonly kind: "batch" | "review";
	readonly acceptedAt: number;
	readonly tasks: Map<string, ManagedBatchTaskState>;
	readonly controller: AbortController;
	readonly outputArtifactIds: Set<string>;
	state: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
	completion?: Promise<SubagentBatchResult | ReviewBatchResult>;
	result?: SubagentBatchResult | ReviewBatchResult;
}

export type ManagedWriterInspection = {
	runId: string;
	state: "starting" | "running" | WriterResultStatus;
	waitExpired?: boolean;
	acceptedAt: number;
	baseCommit: string;
	workspaceIsolation: "worktree" | "parent";
	phase: ObservatoryPhase;
	currentTool?: string;
	currentPath?: string;
	lastProgressAt?: number;
	checkIn?: SubagentCheckInState;
	result?: WriterResult;
};

export interface ManagedWriterRecord extends ManagedWriterInspection {
	ownerSessionId: string;
	controller: AbortController;
	completion?: Promise<WriterResult>;
}

export interface SubagentBatchRunOptions {
	batchId?: string;
	/** Return admitted child handles without waiting for the aggregate result. */
	managedBackground?: boolean;
	/** Owner integration arms periodic check-ins after each child session is admitted. */
	onManagedHandle?: (task: ResolvedSubagentBatchTask, handle: SubagentManagedHandle) => void;
	/** Called exactly once after each child's terminal result or launch failure. */
	onChildTerminal?: (task: ResolvedSubagentBatchTask, result?: SubagentResult) => void;
	concurrency?: number;
	/** Canonical resolved concurrency policy; defaults to bundled batch limits. */
	concurrencyPolicy?: ResolvedSubagentConcurrencyPolicy;
	/** Shared admission coordinator across batch and background-job execution. */
	admission?: SubagentConcurrencyAdmission;
	modelRuntime?: ModelRuntime;
	/** Parent-resolved retry policy copied into each isolated child session. */
	settingsManager?: SettingsManager;
	unsafeHostExec?: boolean;
	failFast?: boolean;
	signal?: AbortSignal;
	onEvent?: (event: SubagentEvent) => void;
	onTaskState?: (event: SubagentBatchTaskLifecycleEvent) => void;
	isAuthorityStillValid?: (
		request: NormalizedSubagentRequest,
		hookRuntime?: SubagentHookRuntime,
	) => boolean | Promise<boolean>;
}

export type SubagentBatchTaskLifecycleEvent =
	| {
			type: "task_queued";
			batchId: string;
			taskId: string;
			role: string;
			index: number;
	  }
	| {
			type: "task_admitted";
			batchId: string;
			taskId: string;
			role: string;
			index: number;
	  }
	| {
			type: "task_skipped";
			batchId: string;
			taskId: string;
			status: "failed" | "cancelled" | "timed_out";
			reason: string;
	  };

export type SubagentCompactionReason = "manual" | "threshold" | "overflow";
export type SubagentCompactionStatus = "started" | "completed" | "aborted" | "failed";

export interface SubagentEvent {
	type:
		| "subagent_created"
		| "subagent_started"
		| "subagent_progress"
		| "subagent_tool_start"
		| "subagent_tool_end"
		| "subagent_compaction_start"
		| "subagent_compaction_end"
		| "subagent_retry"
		| "subagent_wrap_up"
		| "subagent_completed"
		| "subagent_failed"
		| "subagent_cancelled"
		| "subagent_timed_out";
	runId: string;
	parentSessionId: string;
	childSessionId?: string;
	profile: SubagentProfile["name"];
	color?: SubagentProfileColor;
	status: SubagentStatus;
	toolName?: string;
	toolCallId?: string;
	path?: string;
	attention?: SubagentRuntimeAttention;
	retry?: SubagentRetryState;
	model?: string;
	taskId?: string;
	attempt?: 1 | 2;
	batchId?: string;
	/** Bounded child compaction lifecycle metadata; summary contents are never projected. */
	compactionReason?: SubagentCompactionReason;
	compactionStatus?: SubagentCompactionStatus;
	compactionWillRetry?: boolean;
}
