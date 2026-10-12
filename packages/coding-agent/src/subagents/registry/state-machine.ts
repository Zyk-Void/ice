/**
 * Subagent V2 child lifecycle contract (Phase 0: data only).
 *
 * Design: Plan/subagent-rewrite.md sections 6.3, 11.4-11.7. Instance lifecycle
 * and per-turn outcome are separate: a completed turn normally leaves the
 * child `idle`, not terminal.
 */

export const CHILD_INSTANCE_STATES = [
	"starting",
	"running",
	"idle",
	"parked",
	"stopping",
	"blocked",
	"aborted",
	"deleted",
] as const;
export type ChildInstanceState = (typeof CHILD_INSTANCE_STATES)[number];

export const CHILD_TURN_OUTCOMES = ["completed", "failed", "cancelled", "interrupted", "budget_exhausted"] as const;
export type ChildTurnOutcome = (typeof CHILD_TURN_OUTCOMES)[number];

/**
 * Legal live transitions. `blocked` covers both a pending approval (resolves to
 * `running`) and a revival refused by current parent authority (D16; resolves
 * only by delete or a later successful revival through `parked`).
 */
export const CHILD_STATE_TRANSITIONS: Readonly<Record<ChildInstanceState, readonly ChildInstanceState[]>> =
	Object.freeze({
		starting: Object.freeze(["running", "blocked", "stopping", "aborted"] as const),
		running: Object.freeze(["idle", "blocked", "stopping", "aborted"] as const),
		idle: Object.freeze(["running", "parked", "deleted"] as const),
		parked: Object.freeze(["idle", "blocked", "deleted"] as const),
		stopping: Object.freeze(["idle", "aborted"] as const),
		blocked: Object.freeze(["running", "parked", "stopping", "deleted"] as const),
		aborted: Object.freeze(["deleted"] as const),
		deleted: Object.freeze([] as const),
	});

export function canTransitionChildState(from: ChildInstanceState, to: ChildInstanceState): boolean {
	return CHILD_STATE_TRANSITIONS[from].includes(to);
}

/**
 * Process-restart normalization (section 11.6). Live sessions do not survive a
 * restart, so every resident state parks. `turnInFlight` comes from the persisted
 * turn record: a `blocked` child may be waiting on approval mid-turn or may have
 * been refused revival with no turn at all, so state alone cannot decide it.
 * Revival re-validates authority, so a previously blocked child is not widened.
 */
export function recoverChildStateAfterRestart(
	state: ChildInstanceState,
	turnInFlight: boolean,
): { state: ChildInstanceState; interruptedTurn: boolean } {
	if (state === "aborted" || state === "deleted" || state === "parked") return { state, interruptedTurn: false };
	return { state: "parked", interruptedTurn: turnInFlight };
}
