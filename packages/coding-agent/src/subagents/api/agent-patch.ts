/**
 * Subagent V2 `agent_patch` tool parameters (Phase 0: schema only).
 *
 * Design: Plan/subagent-rewrite.md sections 12.3 and 14. Valid only for a
 * child whose frozen contract uses `isolation: "worktree"`. `apply` is a parent
 * mutation and goes through the parent evaluator and mode gate like `edit`.
 */
import { type Static, Type } from "typebox";
import { CHILD_ID_PATTERN_SOURCE } from "../contract/child-runtime-contract.ts";

export const AGENT_PATCH_ACTIONS = ["inspect", "apply", "reject"] as const;
export type AgentPatchAction = (typeof AGENT_PATCH_ACTIONS)[number];

export const AgentPatchParametersSchema = Type.Object(
	{
		id: Type.String({ pattern: CHILD_ID_PATTERN_SOURCE }),
		action: Type.Union(AGENT_PATCH_ACTIONS.map((action) => Type.Literal(action))),
	},
	{ additionalProperties: false },
);
export type AgentPatchParameters = Static<typeof AgentPatchParametersSchema>;
