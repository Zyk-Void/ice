/**
 * Display-state types for subagent views (agent strip, Agent Hub inspector, agent view bridge).
 *
 * They describe progress attention and check-in state a host may attach to a live subagent view. The legacy
 * supervisor and check-in schedulers that produced them were removed with the legacy subagent system; the
 * types remain because the bridge and footer still accept and render them.
 */

export type SubagentSupervisorState = "running" | "terminal";
export type SubagentSupervisorPhase = "startup" | "working" | "wrapping_up" | "controlled_wait" | "finalization";
export type SubagentRetryStateKind = "scheduled" | "recovered" | "failed";

export interface SubagentRetryState {
	readonly state: SubagentRetryStateKind;
	readonly attempt: number;
	readonly maxAttempts: number;
	readonly delayMs?: number;
	readonly diagnostic?: string;
}

export type SubagentToolActivityOutcome = "running" | "ok" | "error" | "aborted";

export interface SubagentToolActivityDigest {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly action?: string;
	readonly status: SubagentToolActivityOutcome;
	readonly path?: string;
	/** Bounded digest of serialized tool arguments; enables identical-call detection. */
	readonly argsDigest?: string;
	readonly startedAtMs: number;
	readonly finishedAtMs?: number;
	readonly exitCode?: number;
	readonly errorClass?: string;
}

export interface SubagentRepeatedFailureAdvisory {
	readonly action: string;
	readonly count: number;
}

/** Advisory only: the same tool with materially identical arguments succeeding repeatedly. */
export interface SubagentRepeatedActionAdvisory {
	readonly action: string;
	readonly count: number;
}

export interface SubagentUsageSnapshot {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly cost: number;
}

export interface SubagentRuntimeAttention {
	readonly phase: SubagentSupervisorPhase;
	readonly state: SubagentSupervisorState;
	readonly lifetimeDeadline: false;
	readonly activeElapsedMs: number;
	readonly progressAgeMs?: number;
	readonly lastProgressAtMs?: number;
	readonly lastActivities: readonly SubagentToolActivityDigest[];
	readonly repeatedFailure?: SubagentRepeatedFailureAdvisory;
	readonly repeatedAction?: SubagentRepeatedActionAdvisory;
	/** Distinct in-scope paths the child has successfully observed. */
	readonly observedPathCount: number;
	/** The most recent successful tool action, redacted and bounded. */
	readonly lastSuccessfulAction?: string;
	readonly usage?: SubagentUsageSnapshot;
}

/* timed_out is retained only for historical terminal records from older sessions. */
export type SubagentManagementChildState =
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "verification_failed";

export type SubagentCheckInDelivery =
	| "armed"
	| "due"
	| "queued_for_parent"
	| "consumed"
	| "acknowledged"
	| "owner_unavailable";

export interface SubagentCheckInState {
	readonly delivery: SubagentCheckInDelivery;
	readonly sequence: number;
	readonly nextDueAt?: number;
	readonly pendingSince?: number;
	readonly lastAcknowledgedAt?: number;
}
