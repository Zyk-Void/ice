/**
 * Subagent V2 `agent_control` tool parameters (Phase 0: schema only).
 *
 * Design: Plan/subagent-rewrite.md section 12.2. `send` with `followup` and
 * `agent({ tasks: [{ resume }] })` share one continuation primitive (D21).
 */
import { type Static, Type } from "typebox";
import { CHILD_ID_PATTERN_SOURCE } from "../contract/child-runtime-contract.ts";

export const AGENT_CONTROL_ACTIONS = [
	"status",
	"wait",
	"send",
	"resume",
	"stop",
	"delete",
	"output",
	"list",
	"agents",
] as const;
export type AgentControlAction = (typeof AGENT_CONTROL_ACTIONS)[number];

export const AGENT_SEND_DELIVERIES = ["message", "followup", "interrupt"] as const;
export type AgentSendDelivery = (typeof AGENT_SEND_DELIVERIES)[number];

export const AGENT_CONTROL_LIMITS = Object.freeze({
	maxIds: 8,
	maxMessageBytes: 64 * 1024,
	maxWaitMs: 30 * 60 * 1000,
});

const childId = Type.String({ pattern: CHILD_ID_PATTERN_SOURCE });

export const AgentControlParametersSchema = Type.Object(
	{
		action: Type.Enum(AGENT_CONTROL_ACTIONS),
		id: Type.Optional(childId),
		ids: Type.Optional(Type.Array(childId, { minItems: 1, maxItems: AGENT_CONTROL_LIMITS.maxIds })),
		message: Type.Optional(Type.String({ minLength: 1, maxLength: AGENT_CONTROL_LIMITS.maxMessageBytes })),
		delivery: Type.Optional(Type.Enum(AGENT_SEND_DELIVERIES)),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: AGENT_CONTROL_LIMITS.maxWaitMs })),
	},
	{ additionalProperties: false },
);
export type AgentControlParameters = Static<typeof AgentControlParametersSchema>;
