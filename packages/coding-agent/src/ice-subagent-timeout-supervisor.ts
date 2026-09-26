import { redactCredentialText } from "./utils/redact.ts";

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
export type SubagentSupervisorStopReason = "cancelled";

const ACTIVITY_LIMIT = 12;
const ACTIVITY_TEXT_MAX_BYTES = 512;
const REPEATED_FAILURE_THRESHOLD = 2;
/** Identical (tool + args digest) successful calls before a doom-loop advisory. */
const REPEATED_ACTION_THRESHOLD = 3;
const OBSERVED_PATHS_LIMIT = 64;

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

/**
 * Phase 4.4: advisory-only doom-loop signal — the same tool with materially
 * identical arguments succeeding repeatedly without new evidence. It never
 * stops a child; host-owned run-shape policy owns hard stops.
 */
export interface SubagentRepeatedActionAdvisory {
	readonly action: string;
	readonly count: number;
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
	/** Phase 4.1: distinct in-scope paths the child has successfully observed. */
	readonly observedPathCount: number;
	/** Phase 4.1: the most recent successful tool action, redacted and bounded. */
	readonly lastSuccessfulAction?: string;
	readonly usage?: SubagentUsageSnapshot;
}

export interface SubagentRunSupervisorSnapshot extends SubagentRuntimeAttention {
	readonly runId: string;
	readonly childSessionId?: string;
	readonly terminalStatus?: string;
}

export interface SubagentUsageSnapshot {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly cost: number;
}

/* timed_out is retained only for historical terminal records from older sessions. */
export type SubagentManagementChildState =
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "verification_failed";

const SUBAGENT_MANAGEMENT_TERMINAL_STATES: readonly SubagentManagementChildState[] = [
	"completed",
	"failed",
	"cancelled",
	"timed_out",
	"verification_failed",
];

export function projectSubagentTerminalStatus(status: string | undefined): SubagentManagementChildState {
	return status && (SUBAGENT_MANAGEMENT_TERMINAL_STATES as readonly string[]).includes(status)
		? (status as SubagentManagementChildState)
		: "completed";
}

export function projectSubagentManagementState(snapshot: SubagentRunSupervisorSnapshot): {
	childState: SubagentManagementChildState;
	terminal: boolean;
} {
	if (snapshot.state === "running") return { childState: "running", terminal: false };
	return { childState: projectSubagentTerminalStatus(snapshot.terminalStatus), terminal: true };
}

export interface SubagentRunSupervisorCallbacks<TResult> {
	readonly abort: () => Promise<void>;
	readonly stop: (reason: SubagentSupervisorStopReason) => Promise<TResult>;
	readonly onChange?: (snapshot: SubagentRunSupervisorSnapshot) => void;
}

export interface SubagentRunSupervisorOptions<TResult> extends SubagentRunSupervisorCallbacks<TResult> {
	readonly runId: string;
	readonly childSessionId?: string;
	readonly phase?: SubagentSupervisorPhase;
	readonly now?: () => number;
}

function boundedText(value: string): string {
	const redacted = redactCredentialText(value)
		.replace(/[\u0000\r\n]+/g, " ")
		.trim();
	if (Buffer.byteLength(redacted) <= ACTIVITY_TEXT_MAX_BYTES) return redacted;
	const bytes = Buffer.from(redacted);
	let end = ACTIVITY_TEXT_MAX_BYTES;
	while (end > 0 && bytes.subarray(0, end).toString("utf8").endsWith("\ufffd")) end -= 1;
	return bytes.subarray(0, end).toString("utf8");
}

function freezeActivity(activity: SubagentToolActivityDigest): SubagentToolActivityDigest {
	return Object.freeze({
		...activity,
		toolCallId: boundedText(activity.toolCallId),
		toolName: boundedText(activity.toolName),
		...(activity.action ? { action: boundedText(activity.action) } : {}),
		...(activity.path ? { path: boundedText(activity.path) } : {}),
		...(activity.argsDigest ? { argsDigest: boundedText(activity.argsDigest) } : {}),
		...(activity.exitCode !== undefined && Number.isSafeInteger(activity.exitCode)
			? { exitCode: activity.exitCode }
			: {}),
		...(activity.errorClass ? { errorClass: boundedText(activity.errorClass) } : {}),
	});
}

function repeatedFailureKey(activity: SubagentToolActivityDigest): string {
	const action = (activity.action ?? activity.toolName).slice(0, 96);
	return `${activity.toolName}:${action}`;
}

/*
 * Observes one live child without owning its agent loop or lifetime. It records
 * bounded progress/activity/usage, supports controlled-wait accounting and
 * explicit cancellation, and publishes lifecycle changes for waiters/views.
 */
export class SubagentRunSupervisor<TResult> {
	private readonly runId: string;
	private readonly childSessionId: string | undefined;
	private readonly now: () => number;
	private readonly callbacks: SubagentRunSupervisorCallbacks<TResult>;
	private state: SubagentSupervisorState = "running";
	private phase: SubagentSupervisorPhase;
	private activeElapsedMs = 0;
	private segmentStartedAtMs: number;
	private lastProgressAtMs: number | undefined;
	private usage: SubagentUsageSnapshot | undefined;
	private terminalStatus: string | undefined;
	private terminalResult: TResult | undefined;
	private hasTerminalResult = false;
	private stopPromise: Promise<TResult> | undefined;
	private readonly activities = new Map<string, SubagentToolActivityDigest>();
	private readonly activityOrder: string[] = [];
	private readonly recentFailureCounts = new Map<string, { action: string; count: number }>();
	private readonly observedPaths = new Set<string>();
	private lastSuccessfulAction: string | undefined;
	private consecutiveIdentical: { key: string; action: string; count: number } | undefined;
	private readonly lifecycleWaiters = new Set<() => void>();
	private lastObservedState: SubagentSupervisorState = "running";

	constructor(options: SubagentRunSupervisorOptions<TResult>) {
		this.runId = boundedText(options.runId);
		this.childSessionId = options.childSessionId;
		this.now = options.now ?? Date.now;
		this.callbacks = options;
		this.phase = options.phase ?? "working";
		this.segmentStartedAtMs = this.now();
		this.publish();
	}

	getSnapshot(): SubagentRunSupervisorSnapshot {
		const currentElapsed =
			this.state === "running" && this.phase !== "controlled_wait"
				? Math.max(0, this.now() - this.segmentStartedAtMs)
				: 0;
		const activeElapsedMs = this.activeElapsedMs + currentElapsed;
		const progressAgeMs =
			this.lastProgressAtMs === undefined ? undefined : Math.max(0, this.now() - this.lastProgressAtMs);
		const repeatedFailure = this.repeatedFailureAdvisory();
		const repeatedAction = this.repeatedActionAdvisory();
		return Object.freeze({
			runId: this.runId,
			...(this.childSessionId ? { childSessionId: this.childSessionId } : {}),
			state: this.state,
			lifetimeDeadline: false as const,
			phase: this.phase,
			activeElapsedMs,
			...(progressAgeMs !== undefined ? { progressAgeMs } : {}),
			...(this.lastProgressAtMs !== undefined ? { lastProgressAtMs: this.lastProgressAtMs } : {}),
			lastActivities: Object.freeze(
				this.activityOrder
					.map((id) => this.activities.get(id))
					.filter((item): item is SubagentToolActivityDigest => item !== undefined),
			),
			...(repeatedFailure ? { repeatedFailure } : {}),
			...(repeatedAction ? { repeatedAction } : {}),
			observedPathCount: this.observedPaths.size,
			...(this.lastSuccessfulAction ? { lastSuccessfulAction: this.lastSuccessfulAction } : {}),
			...(this.usage ? { usage: this.usage } : {}),
			...(this.terminalStatus ? { terminalStatus: this.terminalStatus } : {}),
		});
	}

	get stateValue(): SubagentSupervisorState {
		return this.state;
	}

	getTerminalResult(): TResult | undefined {
		return this.hasTerminalResult ? this.terminalResult : undefined;
	}

	get pendingLifecycleWaiters(): number {
		return this.lifecycleWaiters.size;
	}

	waitForLifecycleChange(signal?: AbortSignal): Promise<void> {
		if (this.state !== "running") return Promise.resolve();
		return new Promise<void>((resolve) => {
			let settled = false;
			const settle = (): void => {
				if (settled) return;
				settled = true;
				this.lifecycleWaiters.delete(settle);
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = (): void => settle();
			if (signal) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.lifecycleWaiters.add(settle);
		});
	}

	private notifyLifecycleWaiters(): void {
		for (const waiter of [...this.lifecycleWaiters]) waiter();
	}

	setPhase(phase: SubagentSupervisorPhase): void {
		if (this.state === "terminal" || this.phase === phase) return;
		if (this.phase !== "controlled_wait") this.recordActiveElapsed();
		this.phase = phase;
		if (phase !== "controlled_wait") this.segmentStartedAtMs = this.now();
		this.publish();
	}

	markProgress(atMs = this.now()): void {
		if (!Number.isFinite(atMs)) return;
		this.lastProgressAtMs = atMs;
		this.publish();
	}

	setUsage(usage: SubagentUsageSnapshot | undefined): void {
		if (!usage) return;
		this.usage = Object.freeze({ ...usage });
		this.publish();
	}

	recordActivity(activity: SubagentToolActivityDigest): void {
		const id = boundedText(activity.toolCallId);
		if (!id) return;
		const existing = this.activities.get(id);
		const normalized = freezeActivity({
			...activity,
			toolCallId: id,
			startedAtMs: Number.isFinite(activity.startedAtMs) ? activity.startedAtMs : this.now(),
			...(activity.finishedAtMs !== undefined && Number.isFinite(activity.finishedAtMs)
				? { finishedAtMs: activity.finishedAtMs }
				: {}),
		});
		const wasError = existing?.status === "error";
		this.activities.set(id, Object.freeze({ ...existing, ...normalized }));
		if (!existing) this.activityOrder.push(id);
		while (this.activityOrder.length > ACTIVITY_LIMIT) {
			const oldest = this.activityOrder.shift();
			if (oldest) this.activities.delete(oldest);
		}
		this.trackRepeatedFailure(normalized, wasError);
		this.trackIdenticalAction(normalized);
		this.trackObservedPath(normalized);
		this.markProgress(activity.finishedAtMs ?? activity.startedAtMs);
	}

	private trackIdenticalAction(activity: SubagentToolActivityDigest): void {
		if (activity.status === "error" || activity.status === "aborted") {
			this.consecutiveIdentical = undefined;
			return;
		}
		const key = `${activity.toolName}:${activity.argsDigest ?? activity.action ?? activity.toolName}`;
		if (this.consecutiveIdentical?.key === key) {
			this.consecutiveIdentical.count += 1;
			return;
		}
		this.consecutiveIdentical = {
			key,
			action: boundedText(activity.action ?? activity.toolName),
			count: 1,
		};
	}

	private repeatedActionAdvisory(): SubagentRepeatedActionAdvisory | undefined {
		const entry = this.consecutiveIdentical;
		return entry && entry.count >= REPEATED_ACTION_THRESHOLD
			? Object.freeze({ action: entry.action, count: entry.count })
			: undefined;
	}

	private trackObservedPath(activity: SubagentToolActivityDigest): void {
		if (activity.status !== "ok") return;
		this.lastSuccessfulAction = boundedText(activity.action ?? activity.toolName);
		if (activity.path && this.observedPaths.size < OBSERVED_PATHS_LIMIT) this.observedPaths.add(activity.path);
	}

	private trackRepeatedFailure(activity: SubagentToolActivityDigest, wasAlreadyCounted: boolean): void {
		const key = repeatedFailureKey(activity);
		const current = this.recentFailureCounts.get(key);
		if (activity.status === "error") {
			if (!wasAlreadyCounted) {
				const count = (current?.count ?? 0) + 1;
				this.recentFailureCounts.set(key, { action: boundedText(activity.action ?? activity.toolName), count });
			}
			return;
		}
		if (activity.status === "ok" && current) this.recentFailureCounts.delete(key);
	}

	private repeatedFailureAdvisory(): SubagentRepeatedFailureAdvisory | undefined {
		let best: { action: string; count: number } | undefined;
		for (const entry of this.recentFailureCounts.values()) {
			if (entry.count >= REPEATED_FAILURE_THRESHOLD && (best === undefined || entry.count > best.count)) {
				best = entry;
			}
		}
		return best ? Object.freeze({ action: best.action, count: best.count }) : undefined;
	}

	finish(result: TResult, terminalStatus = "completed"): boolean {
		if (this.hasTerminalResult || this.state === "terminal") return false;
		this.recordActiveElapsed();
		this.state = "terminal";
		this.terminalStatus = terminalStatus;
		this.terminalResult = result;
		this.hasTerminalResult = true;
		this.publish();
		return true;
	}

	terminate(terminalStatus = "completed"): boolean {
		if (this.state === "terminal") return false;
		this.recordActiveElapsed();
		this.state = "terminal";
		this.terminalStatus = terminalStatus;
		this.publish();
		return true;
	}

	pauseForControlledWait(): boolean {
		if (this.state !== "running" || this.phase === "controlled_wait") return false;
		this.recordActiveElapsed();
		this.phase = "controlled_wait";
		this.publish();
		return true;
	}

	resumeFromControlledWait(): boolean {
		if (this.state !== "running" || this.phase !== "controlled_wait") return false;
		this.phase = "working";
		this.segmentStartedAtMs = this.now();
		this.publish();
		return true;
	}

	async stop(reason: SubagentSupervisorStopReason): Promise<TResult> {
		if (this.hasTerminalResult) return this.terminalResult as TResult;
		if (this.stopPromise) return this.stopPromise;
		if (this.state === "running") this.recordActiveElapsed();
		if (this.state !== "terminal") {
			this.state = "terminal";
			this.terminalStatus = "cancelled";
			this.publish();
		}
		this.stopPromise = (async (): Promise<TResult> => {
			void this.callbacks.abort().catch(() => {});
			const result = await this.callbacks.stop(reason);
			this.terminalResult = result;
			this.hasTerminalResult = true;
			return result;
		})();
		return this.stopPromise;
	}

	async shutdown(): Promise<void> {
		if (this.state === "terminal") return;
		await this.stop("cancelled");
	}

	private recordActiveElapsed(): void {
		if (this.state !== "running" || this.phase === "controlled_wait") return;
		this.activeElapsedMs += Math.max(0, this.now() - this.segmentStartedAtMs);
		this.segmentStartedAtMs = this.now();
	}

	private publish(): void {
		const stateChanged = this.lastObservedState !== this.state;
		this.lastObservedState = this.state;
		try {
			this.callbacks.onChange?.(this.getSnapshot());
		} catch {
			// Presentation observers cannot affect lifecycle state.
		}
		if (stateChanged) this.notifyLifecycleWaiters();
	}
}

export class SubagentRunSupervisorRegistry<TResult> {
	private readonly supervisors = new Map<string, SubagentRunSupervisor<TResult>>();
	private readonly maxSize: number;

	constructor(maxSize = 16) {
		this.maxSize = Math.max(1, maxSize);
	}

	register(supervisor: SubagentRunSupervisor<TResult>): void {
		const runId = supervisor.getSnapshot().runId;
		if (!runId) throw new Error("A subagent supervisor requires a run ID.");
		if (!this.supervisors.has(runId) && this.supervisors.size >= this.maxSize) {
			throw new Error(`Subagent supervisor capacity (${this.maxSize}) is exhausted.`);
		}
		this.supervisors.set(runId, supervisor);
	}

	get(runId: string): SubagentRunSupervisor<TResult> | undefined {
		return this.supervisors.get(runId);
	}

	list(): readonly SubagentRunSupervisorSnapshot[] {
		return Object.freeze([...this.supervisors.values()].map((supervisor) => supervisor.getSnapshot()));
	}

	remove(runId: string): void {
		this.supervisors.delete(runId);
	}

	async shutdownAll(): Promise<void> {
		const supervisors = [...this.supervisors.values()];
		await Promise.allSettled(supervisors.map((supervisor) => supervisor.shutdown()));
		this.supervisors.clear();
	}
}

export function formatSubagentToolActivity(activity: SubagentToolActivityDigest): string {
	const status =
		activity.status === "error"
			? "error"
			: activity.status === "running"
				? "running"
				: activity.status === "aborted"
					? "aborted"
					: "ok";
	const duration =
		activity.finishedAtMs !== undefined ? ` · ${Math.max(0, activity.finishedAtMs - activity.startedAtMs)}ms` : "";
	const exit = activity.status === "error" && activity.exitCode !== undefined ? ` · exit ${activity.exitCode}` : "";
	return `${status} ${activity.action ? boundedText(activity.action) : boundedText(activity.toolName)}${duration}${exit}`;
}
