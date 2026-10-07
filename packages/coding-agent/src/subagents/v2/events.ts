/**
 * Subagent V2 lifecycle events (Plan/subagent-rewrite.md section 16.1, P9.1).
 *
 * Events are derived from ChildRegistry record changes, so the registry stays the
 * only lifecycle owner. They are published on the extension event bus channel
 * SUBAGENT_EVENT_CHANNEL with bounded metadata (no prompts, output, or secrets).
 */
import type { ChildCompletion, ChildRecord } from "../registry/registry.ts";

export const SUBAGENT_EVENT_CHANNEL = "ice:subagent";

export type SubagentLifecycleEventType =
	| "subagent_start"
	| "subagent_turn_start"
	| "subagent_turn_end"
	| "subagent_parked"
	| "subagent_revived"
	| "subagent_blocked"
	| "subagent_interrupted"
	| "subagent_end"
	| "subagent_patch"
	| "subagent_completion_queued"
	| "subagent_permission_request";

export interface SubagentLifecycleEvent {
	type: SubagentLifecycleEventType;
	childId: string;
	agent: string;
	ownerSessionId: string;
	depth: number;
	state: string;
	lastTurnOutcome?: string;
	patchState?: string;
}

/** Events implied by one record change; `previous` is undefined for a new child. */
export function lifecycleEvents(previous: ChildRecord | undefined, next: ChildRecord): SubagentLifecycleEvent[] {
	const base = {
		childId: next.id,
		agent: next.agent,
		ownerSessionId: next.ownerSessionId,
		depth: next.depth,
		state: next.state,
		...(next.lastTurnOutcome ? { lastTurnOutcome: next.lastTurnOutcome } : {}),
		...(next.patchState ? { patchState: next.patchState } : {}),
	};
	const types: SubagentLifecycleEventType[] = [];
	if (!previous) types.push("subagent_start");
	const before = previous?.state;
	if (next.state !== before) {
		if (next.state === "running") types.push("subagent_turn_start");
		if (before === "running" && next.state !== "blocked") types.push("subagent_turn_end");
		if (next.state === "parked") types.push("subagent_parked");
		if (before === "parked" && next.state === "idle") types.push("subagent_revived");
		if (next.state === "blocked") types.push("subagent_blocked");
		if (next.state === "deleted") types.push("subagent_end");
	}
	if (next.lastTurnOutcome === "interrupted" && previous?.lastTurnOutcome !== "interrupted")
		types.push("subagent_interrupted");
	if (previous && next.patchState !== previous.patchState) types.push("subagent_patch");
	return types.map((type) => ({ type, ...base }));
}

export function completionEvent(completion: ChildCompletion, depth: number): SubagentLifecycleEvent {
	return {
		type: "subagent_completion_queued",
		childId: completion.childId,
		agent: completion.agent,
		ownerSessionId: completion.ownerSessionId,
		depth,
		state: "idle",
		lastTurnOutcome: completion.outcome,
	};
}
