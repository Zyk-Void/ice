/**
 * Subagent V2 `agent` tool parameters (Phase 0: schema only).
 *
 * Design: Plan/subagent-rewrite.md section 12.1. One tool launches new
 * children (single or batch, foreground or background) and continues existing
 * ones through `resume`. A resumed task cannot override the frozen runtime
 * contract; that rule is enforced at preflight (P6.2), not by this schema.
 */
import { type Static, Type } from "typebox";
import { CHILD_NAME_PATTERN_SOURCE, CHILD_REF_PATTERN_SOURCE } from "../contract/child-runtime-contract.ts";
import { AGENT_ISOLATION_MODES, AGENT_NAME_PATTERN, AGENT_THINKING_LEVELS } from "../definitions/schema.ts";

export const AGENT_TOOL_LIMITS = Object.freeze({
	maxTasks: 8,
	maxDescriptionChars: 120,
	maxPromptBytes: 64 * 1024,
	maxAcceptanceItems: 16,
	maxAcceptanceChars: 1024,
	maxScopeEntries: 32,
	/** Matches the current SUBAGENT_CONTEXT_PACKET_LIMITS; that constant moves here in Phase 1. */
	maxContextItems: 16,
	maxContextItemBytes: 32 * 1024,
});

export const AGENT_CONTEXT_ITEM_KINDS = ["parent_note", "verified_fact", "evidence_ref", "artifact_ref"] as const;

const positiveInt = Type.Integer({ minimum: 1 });

export const AgentTaskSchema = Type.Object(
	{
		/** Definition name for a new child; defaults to `ice.subagents.defaultAgent`. Not allowed with `resume`. */
		agent: Type.Optional(Type.String({ pattern: AGENT_NAME_PATTERN })),
		/** Existing child ID to continue with a new turn. */
		/** Short name to refer to a new child later (for example `auth-review`); unique among this session's children. */
		name: Type.Optional(Type.String({ pattern: CHILD_NAME_PATTERN_SOURCE })),
		resume: Type.Optional(Type.String({ pattern: CHILD_REF_PATTERN_SOURCE })),
		description: Type.String({ minLength: 1, maxLength: AGENT_TOOL_LIMITS.maxDescriptionChars }),
		prompt: Type.String({ minLength: 1, maxLength: AGENT_TOOL_LIMITS.maxPromptBytes }),
		model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		thinking: Type.Optional(Type.Enum(AGENT_THINKING_LEVELS)),
		isolation: Type.Optional(Type.Enum(AGENT_ISOLATION_MODES)),
		scope: Type.Optional(
			Type.Object(
				{
					roots: Type.Array(Type.String({ minLength: 1 }), {
						minItems: 1,
						maxItems: AGENT_TOOL_LIMITS.maxScopeEntries,
					}),
					targets: Type.Optional(
						Type.Array(Type.String({ minLength: 1 }), { maxItems: AGENT_TOOL_LIMITS.maxScopeEntries }),
					),
				},
				{ additionalProperties: false },
			),
		),
		outputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		acceptance: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: AGENT_TOOL_LIMITS.maxAcceptanceChars }), {
				maxItems: AGENT_TOOL_LIMITS.maxAcceptanceItems,
			}),
		),
		context: Type.Optional(
			Type.Array(
				Type.Object(
					{
						id: Type.String({ minLength: 1, maxLength: 64 }),
						kind: Type.Enum(AGENT_CONTEXT_ITEM_KINDS),
						content: Type.String({ minLength: 1, maxLength: AGENT_TOOL_LIMITS.maxContextItemBytes }),
					},
					{ additionalProperties: false },
				),
				{ maxItems: AGENT_TOOL_LIMITS.maxContextItems },
			),
		),
		maxTurns: Type.Optional(positiveInt),
		maxTokens: Type.Optional(positiveInt),
		timeoutMs: Type.Optional(positiveInt),
	},
	{ additionalProperties: false },
);
export type AgentTaskInput = Static<typeof AgentTaskSchema>;

export const AgentToolParametersSchema = Type.Object(
	{
		tasks: Type.Array(AgentTaskSchema, { minItems: 1, maxItems: AGENT_TOOL_LIMITS.maxTasks }),
		/** Return child IDs immediately; completion arrives as a `subagent_completed` follow-up. */
		background: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
export type AgentToolParameters = Static<typeof AgentToolParametersSchema>;
