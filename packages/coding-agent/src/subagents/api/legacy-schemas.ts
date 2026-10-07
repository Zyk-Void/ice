/** Legacy model-facing tool parameter schemas and tool types (moved from ice-subagents.ts; removed in V2 Phase 10). */
import { Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/index.ts";
import type { WriterWorkflowToolResult } from "../isolation/writer-patch.ts";
import type { SubagentJobAccepted, SubagentJobInspection } from "../registry/jobs.ts";
import {
	SUBAGENT_OUTPUT_ARTIFACT_LIMITS,
	type SubagentOutputArtifactErrorCode,
	type SubagentOutputRead,
} from "../results/output-artifacts.ts";
import { SUBAGENT_CHECKIN_INTERVAL_MS } from "../runtime/checkin.ts";
import type { SubagentToolErrorDetails } from "../runtime/helpers.ts";
import { WRITER_MAX_TIMEOUT_MS } from "../runtime/request.ts";
import type { SubagentRuntimeAttention } from "../runtime/supervisor.ts";
import {
	type ManagedBatchTaskState,
	type ManagedSubagentBatchRecord,
	type ManagedWriterInspection,
	type ReviewBatchResult,
	SUBAGENT_ACCEPTANCE_LIMITS,
	SUBAGENT_BATCH_LIMITS,
	SUBAGENT_CONTEXT_PACKET_LIMITS,
	SUBAGENT_EXECUTION_LIMITS,
	SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS,
	type SubagentBatchResult,
	type SubagentLaunchProvenance,
	type SubagentManagedHandle,
	type SubagentManagedObservation,
	type SubagentProfileSummary,
	type SubagentResult,
	type SubagentVerification,
	WRITER_PATCH_LIMITS,
	type WriterResult,
} from "../types.ts";
import type { SubagentProgressSnapshot } from "../ui/observatory.ts";

const resourceSelectionParameters = Type.Object({
	skills: Type.Optional(
		Type.Array(
			Type.String({
				minLength: 1,
				maxLength: 4096,
				description:
					"Name or path of an existing approved skill resource. This is not freeform task text; put instructions in task.",
			}),
			{ maxItems: 16, description: "Existing skill resources to load explicitly." },
		),
	),
	prompts: Type.Optional(
		Type.Array(
			Type.String({
				minLength: 1,
				maxLength: 4096,
				description:
					"Name or path of an existing prompt-template resource. Never put freeform instructions here; put them in task.",
			}),
			{ maxItems: 16, description: "Existing prompt-template resources to load explicitly." },
		),
	),
	context: Type.Optional(
		Type.Array(
			Type.String({
				minLength: 1,
				maxLength: 4096,
				description:
					"Path of an existing approved context resource. This is not freeform task text; put instructions in task/contextPacket.",
			}),
			{ maxItems: 16, description: "Existing context resources to load explicitly." },
		),
	),
});

const contextPacketItemParameters = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" }),
	kind: Type.Union([
		Type.Literal("parent_note"),
		Type.Literal("verified_fact"),
		Type.Literal("evidence_ref"),
		Type.Literal("artifact_ref"),
	]),
	content: Type.String({ minLength: 1, maxLength: SUBAGENT_CONTEXT_PACKET_LIMITS.maxItemBytes }),
});

const contextPacketParameters = Type.Object({
	items: Type.Array(contextPacketItemParameters, { maxItems: SUBAGENT_CONTEXT_PACKET_LIMITS.maxItems }),
});

const taskContractKindParameters = Type.Union([
	Type.Literal("explore"),
	Type.Literal("research"),
	Type.Literal("review"),
	Type.Literal("implement"),
	Type.Literal("verify"),
]);

const taskContractVerificationParameters = Type.Object(
	{
		mode: Type.Optional(
			Type.Union([Type.Literal("evidence"), Type.Literal("tests"), Type.Literal("review"), Type.Literal("none")]),
		),
		commands: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { minItems: 1, maxItems: 4 })),
	},
	{ additionalProperties: false },
);

const acceptanceCriterionParameters = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" }),
		requirement: Type.String({ minLength: 1, maxLength: SUBAGENT_ACCEPTANCE_LIMITS.maxRequirementBytes }),
		required: Type.Optional(
			Type.Boolean({
				description: "Defaults to true; optional incomplete criteria stay visible without failing completion.",
			}),
		),
		evidence: Type.Optional(
			Type.Union([
				Type.Literal("path"),
				Type.Literal("test"),
				Type.Literal("behavior"),
				Type.Literal("finding"),
				Type.Literal("none"),
			]),
		),
		dimension: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: SUBAGENT_ACCEPTANCE_LIMITS.maxDimensionBytes,
				description: 'Bounded quality dimension such as "visual", "accessibility", or "performance".',
			}),
		),
	},
	{ additionalProperties: false },
);

const acceptanceCriteriaParameters = Type.Array(acceptanceCriterionParameters, {
	maxItems: SUBAGENT_ACCEPTANCE_LIMITS.maxCriteria,
	description:
		"Bounded mandatory acceptance criteria. The child must claim one requirement status per criterion; required criteria that are not satisfied fail parent verification.",
});

const preflightRequirementParameters = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
		kind: Type.Union([Type.Literal("command"), Type.Literal("path"), Type.Literal("env-present")]),
		value: Type.String({ minLength: 1, maxLength: 512 }),
		required: Type.Optional(Type.Boolean()),
	},
	{
		additionalProperties: false,
		description:
			"Parent-declared environment precondition. command probes resolve bare executable names on PATH without executing anything; path probes stay inside scope; env-present reveals only variable presence. A required failed preflight blocks launch without consuming a child run and never grants tools.",
	},
);

const preflightParameters = Type.Array(preflightRequirementParameters, {
	maxItems: 8,
});

const subagentScopeParameters = Type.Object(
	{
		roots: Type.Array(
			Type.String({
				minLength: 1,
				maxLength: 4096,
				description: "Existing directory boundaries only. Do not pass file paths here.",
			}),
			{
				minItems: 1,
				maxItems: 16,
				description: "Directories the child is authorized to inspect.",
			},
		),
		targets: Type.Optional(
			Type.Array(
				Type.String({
					minLength: 1,
					maxLength: 4096,
					description: "Existing regular files only. Use roots for directory boundaries.",
				}),
				{
					maxItems: 16,
					description: "Exact existing regular files to inspect first; targets do not expand scope authority.",
				},
			),
		),
	},
	{
		additionalProperties: false,
		description:
			"Filesystem authority boundary for the subagent. Existing directories only; roots must contain existing directories.",
	},
);

const subagentExecutionParameters = Type.Object(
	{
		model: Type.Optional(
			Type.String({
				minLength: 3,
				maxLength: 256,
				description:
					"Exact configured provider/model; requires global modelSelection.mode=configured. Omit to inherit parent.",
			}),
		),
		hooks: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" }), { maxItems: 32 })),
		thinking: Type.Optional(
			Type.Union([
				Type.Literal("off"),
				Type.Literal("minimal"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("xhigh"),
				Type.Literal("max"),
				Type.Literal("ultra"),
			]),
		),
		tools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 7 })),
		temperature: Type.Optional(
			Type.Number({
				minimum: SUBAGENT_EXECUTION_LIMITS.minTemperature,
				maximum: SUBAGENT_EXECUTION_LIMITS.maxTemperature,
			}),
		),
		topP: Type.Optional(
			Type.Number({ minimum: SUBAGENT_EXECUTION_LIMITS.minTopP, maximum: SUBAGENT_EXECUTION_LIMITS.maxTopP }),
		),
	},
	{
		additionalProperties: false,
		description:
			"Per-call execution request. Thinking never changes the model route; tools narrow profile capabilities; final-answer retention is controlled separately by fixed host limits.",
	},
);

const selfDelegationParameters = Type.Optional(
	Type.Object(
		{
			instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 16 * 1024 })),
			capabilities: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 })),
			inheritSkills: Type.Optional(Type.Boolean()),
			mcp: Type.Optional(Type.Array(Type.String({ minLength: 3, maxLength: 256 }), { minItems: 1, maxItems: 16 })),
		},
		{ additionalProperties: false },
	),
);

export const delegateParameters = Type.Object(
	{
		role: Type.String({ minLength: 1, maxLength: 64 }),
		self: selfDelegationParameters,
		task: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
		scope: subagentScopeParameters,
		context: Type.Optional(Type.String({ maxLength: 8 * 1024 })),
		contextPacket: Type.Optional(contextPacketParameters),
		contextMode: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
		kind: Type.Optional(taskContractKindParameters),
		deliverable: Type.Optional(Type.String({ maxLength: 1024 })),
		constraints: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { minItems: 1, maxItems: 8 })),
		nonGoals: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { minItems: 1, maxItems: 8 })),
		verification: Type.Optional(taskContractVerificationParameters),
		checkInIntervalMs: Type.Optional(Type.Integer({ minimum: SUBAGENT_CHECKIN_INTERVAL_MS })),
		startupTimeoutMs: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 10 * 60 * 1000,
				description: "Bounds child startup only, not its lifetime.",
			}),
		),
		execution: Type.Optional(subagentExecutionParameters),
		resources: Type.Optional(resourceSelectionParameters),
		acceptanceCriteria: Type.Optional(acceptanceCriteriaParameters),
		preflight: Type.Optional(preflightParameters),
		outputSchema: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export const delegateAsyncParameters = delegateParameters;

export const listSubagentProfilesParameters = Type.Object({
	query: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
export const subagentJobParameters = Type.Object({
	jobId: Type.String({
		minLength: 1,
		maxLength: 128,
		pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
		description:
			"Bare durable job identifier from delegate_async details.accepted.jobId. Do not pass resultRef values such as job:<id>, a foreground runId, batchId, or taskId.",
	}),
});

export const readSubagentOutputParameters = Type.Object(
	{
		artifactId: Type.String({
			minLength: 36,
			maxLength: 36,
			pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
			description:
				"Opaque artifact ID from a SubagentOutput.artifact reference. Do not pass a runId, jobId, resultRef, or path.",
		}),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
		length: Type.Optional(Type.Integer({ minimum: 1, maximum: SUBAGENT_OUTPUT_ARTIFACT_LIMITS.maxReadBytes })),
	},
	{ additionalProperties: false },
);

export const manageSubagentParameters = Type.Object(
	{
		runId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" }),
		action: Type.Union([
			Type.Literal("inspect"),
			Type.Literal("peek"),
			Type.Literal("wait"),
			Type.Literal("follow_up"),
			Type.Literal("stop"),
			Type.Literal("detach"),
			Type.Literal("resume"),
			Type.Literal("delete"),
		]),
		requestId: Type.Optional(
			Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" }),
		),
		message: Type.Optional(Type.String({ minLength: 1, maxLength: 8 * 1024 })),
		waitMs: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS,
				description:
					"Bounded management wait window. Expiry reports the current state with waitExpired; it never marks the child timed_out.",
			}),
		),
	},
	{
		additionalProperties: false,
		description:
			"Inspect, peek, wait, follow up, stop, detach, resume, or delete the same ICE subagent through one owner-scoped lifecycle. Newly launched children run without a lifetime deadline and are supervised by advisory parent check-ins; elapsed time or stale progress never terminates them. Use the foreground runId returned by delegate: details.managed.runId for a live background launch, or details.result.runId for a retained terminal result. Do not pass a durable jobId, resultRef such as job:<id>, batchId, or taskId. Peek returns the latest bounded snapshot immediately; wait blocks the parent tool call for at most waitMs and reports waitExpired without changing child state. Follow-up requires a stable requestId and is rejected while a user has takeover control. Stop explicitly cancels a running child. Resume continues a retained completed child in its original session and authority; delete forgets a retained reusable session idempotently. Managed terminal observations outlive reusable sessions for peek/wait. Resume is valid only for retained completed children; delete is owner-scoped and idempotent.",
	},
);

const writerPatchFileParameters = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 4096 }),
	change: Type.Union([Type.Literal("add"), Type.Literal("modify")]),
	beforeSha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 })),
	afterSha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 })),
});

const writerPatchArtifactParameters = Type.Object({
	schemaVersion: Type.Literal(1),
	runId: Type.String({ minLength: 1, maxLength: 128 }),
	baseCommit: Type.String({ pattern: "^[0-9a-f]{40}$", minLength: 40, maxLength: 40 }),
	changedFileCount: Type.Integer({ minimum: 0, maximum: WRITER_PATCH_LIMITS.maxChangedFiles }),
	patchBytes: Type.Integer({ minimum: 0, maximum: WRITER_PATCH_LIMITS.maxPatchBytes }),
	patchSha256: Type.String({ pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 }),
	patchRef: Type.String({ minLength: 1, maxLength: 4096 }),
	files: Type.Array(writerPatchFileParameters, { maxItems: WRITER_PATCH_LIMITS.maxChangedFiles }),
});

export const writerPatchWorkflowParameters = Type.Object({
	artifact: writerPatchArtifactParameters,
});

export const delegateWriteParameters = Type.Object(
	{
		task: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
		baseCommit: Type.String({ pattern: "^[0-9a-f]{40}$", minLength: 40, maxLength: 40 }),
		scope: Type.Object({
			roots: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 16 }),
		}),
		checkInIntervalMs: Type.Optional(Type.Integer({ minimum: SUBAGENT_CHECKIN_INTERVAL_MS })),
		startupTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: WRITER_MAX_TIMEOUT_MS })),
	},
	{ additionalProperties: false },
);

const delegateBatchTaskParameters = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" }),
		role: Type.String({ minLength: 1, maxLength: 64 }),
		self: selfDelegationParameters,
		task: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
		scope: subagentScopeParameters,
		context: Type.Optional(Type.String({ maxLength: 8 * 1024 })),
		contextPacket: Type.Optional(contextPacketParameters),
		contextMode: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
		kind: Type.Optional(taskContractKindParameters),
		deliverable: Type.Optional(Type.String({ maxLength: 1024 })),
		constraints: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { minItems: 1, maxItems: 8 })),
		nonGoals: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { minItems: 1, maxItems: 8 })),
		verification: Type.Optional(taskContractVerificationParameters),
		checkInIntervalMs: Type.Optional(Type.Integer({ minimum: SUBAGENT_CHECKIN_INTERVAL_MS })),
		execution: Type.Optional(subagentExecutionParameters),
		resources: Type.Optional(resourceSelectionParameters),
		acceptanceCriteria: Type.Optional(acceptanceCriteriaParameters),
		preflight: Type.Optional(preflightParameters),
		outputSchema: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export const delegateBatchParameters = Type.Object(
	{
		tasks: Type.Array(delegateBatchTaskParameters, { minItems: 1, maxItems: SUBAGENT_BATCH_LIMITS.maxTasks }),
		concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: SUBAGENT_BATCH_LIMITS.maxConcurrency })),
		failFast: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const evidenceRefParameters = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 4096 }),
});

const reviewTaskParameters = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" }),
		dimension: Type.Union([
			Type.Literal("correctness"),
			Type.Literal("security"),
			Type.Literal("tests"),
			Type.Literal("regressions"),
		]),
		task: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
		scope: subagentScopeParameters,
		evidence: Type.Optional(Type.Array(evidenceRefParameters, { maxItems: 16 })),
		context: Type.Optional(Type.String({ maxLength: 8 * 1024 })),
		contextPacket: Type.Optional(contextPacketParameters),
		contextMode: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
		checkInIntervalMs: Type.Optional(Type.Integer({ minimum: SUBAGENT_CHECKIN_INTERVAL_MS })),
		execution: Type.Optional(subagentExecutionParameters),
		resources: Type.Optional(resourceSelectionParameters),
		outputSchema: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export const reviewBatchParameters = Type.Object(
	{
		tasks: Type.Array(reviewTaskParameters, { minItems: 1, maxItems: SUBAGENT_BATCH_LIMITS.maxTasks }),
		concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: SUBAGENT_BATCH_LIMITS.maxConcurrency })),
		failFast: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const subagentBatchIdParameters = Type.Object({
	batchId: Type.String({
		minLength: 1,
		maxLength: 128,
		pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
		description: "Bare owner-scoped batchId returned by delegate_batch or review_batch.",
	}),
});

export type DelegateWriteTool = ToolDefinition<
	typeof delegateWriteParameters,
	| { accepted: { runId: string; resultRef: string; baseCommit: string; workspaceIsolation: "worktree" | "parent" } }
	| { result: WriterResult; progress?: SubagentProgressSnapshot }
	| SubagentToolErrorDetails
	| undefined
>;
export type WriterPatchWorkflowTool = ToolDefinition<
	typeof writerPatchWorkflowParameters,
	WriterWorkflowToolResult | undefined
>;
type DelegateToolResult =
	| {
			result: SubagentResult;
			verification: SubagentVerification;
			launch: SubagentLaunchProvenance;
			progress?: SubagentProgressSnapshot;
	  }
	| {
			managed: SubagentManagedHandle;
			observation?: SubagentManagedObservation;
			launch: SubagentLaunchProvenance;
	  }
	| SubagentToolErrorDetails;
export type DelegateTool = ToolDefinition<typeof delegateParameters, DelegateToolResult | undefined>;

export type DelegateAsyncTool = ToolDefinition<
	typeof delegateAsyncParameters,
	{ accepted: SubagentJobAccepted; launch: SubagentLaunchProvenance } | SubagentToolErrorDetails | undefined
>;
export interface SubagentProfileListingDetails {
	profiles: SubagentProfileSummary[];
	query?: string;
	queryMatched?: boolean;
	suggestions?: string[];
	availableProfileNames?: string[];
	diagnostic?: string;
}

export type ListSubagentProfilesTool = ToolDefinition<
	typeof listSubagentProfilesParameters,
	SubagentProfileListingDetails | undefined
>;
export type SubagentJobTool = ToolDefinition<
	typeof subagentJobParameters,
	{ inspection: SubagentJobInspection } | undefined
>;
export type ReadSubagentOutputTool = ToolDefinition<
	typeof readSubagentOutputParameters,
	{ output: SubagentOutputRead } | { error: { code: SubagentOutputArtifactErrorCode; message: string } } | undefined
>;
export type ManageSubagentTool = ToolDefinition<
	typeof manageSubagentParameters,
	| {
			action: "inspect" | "peek" | "wait" | "follow_up" | "stop" | "detach" | "resume" | "delete";
			resumedFromRunId?: string;
			deleted?: { runId: string; deleted: boolean };
			runId: string;
			attention?: SubagentRuntimeAttention;
			observation?: SubagentManagedObservation;
			writer?: ManagedWriterInspection;
			result?: SubagentResult;
			followUp?: { runId: string; status: "queued" | "duplicate" };
	  }
	| SubagentToolErrorDetails
	| undefined
>;

type ManagedBatchAccepted = {
	accepted: {
		batchId: string;
		resultRef: string;
		tasks: Array<{ taskId: string; runId: string; role: string; model: string }>;
	};
	progress?: SubagentProgressSnapshot;
};
export type ManagedBatchInspection = {
	batchId: string;
	kind: "batch" | "review";
	state: ManagedSubagentBatchRecord["state"];
	acceptedAt: number;
	tasks: ManagedBatchTaskState[];
	result?: SubagentBatchResult | ReviewBatchResult;
};
export type DelegateBatchTool = ToolDefinition<
	typeof delegateBatchParameters,
	| ManagedBatchAccepted
	| { result: SubagentBatchResult; progress?: SubagentProgressSnapshot }
	| SubagentToolErrorDetails
	| undefined
>;
export type ReviewBatchTool = ToolDefinition<
	typeof reviewBatchParameters,
	| ManagedBatchAccepted
	| { result: ReviewBatchResult; progress?: SubagentProgressSnapshot }
	| SubagentToolErrorDetails
	| undefined
>;
export type InspectSubagentBatchTool = ToolDefinition<
	typeof subagentBatchIdParameters,
	{ inspection: ManagedBatchInspection } | SubagentToolErrorDetails | undefined
>;
export type CancelSubagentBatchTool = ToolDefinition<
	typeof subagentBatchIdParameters,
	{ inspection: ManagedBatchInspection } | SubagentToolErrorDetails | undefined
>;
