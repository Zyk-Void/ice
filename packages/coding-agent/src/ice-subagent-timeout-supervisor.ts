import { redactCredentialText } from "./utils/redact.ts";

export type SubagentSupervisorState = "running" | "awaiting_extension" | "terminal";
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
export type SubagentSupervisorStopReason = "cancelled" | "timed_out";

const ACTIVITY_LIMIT = 12;
const ACTIVITY_TEXT_MAX_BYTES = 512;
const REPEATED_FAILURE_THRESHOLD = 2;
const DEFAULT_DECISION_GRACE_MS = 120_000;
const DEFAULT_MAX_TOTAL_BUDGET_MS = 10 * 60 * 1_000;
const MIN_EXTENSION_MS = 1_000;

export interface SubagentToolActivityDigest {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly action?: string;
	readonly status: SubagentToolActivityOutcome;
	readonly path?: string;
	readonly startedAtMs: number;
	readonly finishedAtMs?: number;
	/** Bounded exit code for command-like tools; absent when unknown. */
	readonly exitCode?: number;
	/** Bounded failure class such as "command_failed"; absent on success. */
	readonly errorClass?: string;
}

export interface SubagentRepeatedFailureAdvisory {
	/** Redacted, normalized action that recently failed repeatedly. */
	readonly action: string;
	readonly count: number;
}

export interface SubagentRuntimeAttention {
	readonly phase: SubagentSupervisorPhase;
	readonly state: SubagentSupervisorState;
	readonly initialTimeoutMs: number;
	readonly activeBudgetMs: number;
	readonly activeElapsedMs: number;
	readonly totalExtendedMs: number;
	readonly extensionCount: number;
	readonly remainingExtendableMs: number;
	readonly progressAgeMs?: number;
	readonly lastProgressAtMs?: number;
	readonly decisionDeadlineAtMs?: number;
	readonly lastActivities: readonly SubagentToolActivityDigest[];
	/** Advisory only: same normalized action failed repeatedly; inspect before extending. */
	readonly repeatedFailure?: SubagentRepeatedFailureAdvisory;
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

export interface SubagentRunSupervisorCallbacks<TResult> {
	readonly abort: () => Promise<void>;
	readonly resume: () => Promise<TResult>;
	readonly stop: (reason: SubagentSupervisorStopReason) => Promise<TResult>;
	readonly onChange?: (snapshot: SubagentRunSupervisorSnapshot) => void;
}

export interface SubagentRunSupervisorOptions<TResult> extends SubagentRunSupervisorCallbacks<TResult> {
	readonly runId: string;
	readonly childSessionId?: string;
	readonly initialTimeoutMs: number;
	readonly phase?: SubagentSupervisorPhase;
	readonly maxTotalBudgetMs?: number;
	readonly decisionGraceMs?: number;
	readonly now?: () => number;
	readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
	readonly clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
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

function boundedPositiveInteger(value: number, fallback: number): number {
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function freezeActivity(activity: SubagentToolActivityDigest): SubagentToolActivityDigest {
	return Object.freeze({
		...activity,
		toolCallId: boundedText(activity.toolCallId),
		toolName: boundedText(activity.toolName),
		...(activity.action ? { action: boundedText(activity.action) } : {}),
		...(activity.path ? { path: boundedText(activity.path) } : {}),
		...(activity.exitCode !== undefined && Number.isSafeInteger(activity.exitCode)
			? { exitCode: activity.exitCode }
			: {}),
		...(activity.errorClass ? { errorClass: boundedText(activity.errorClass) } : {}),
	});
}

/** Normalization key for repeated-failure detection: tool plus redacted action head. */
function repeatedFailureKey(activity: SubagentToolActivityDigest): string {
	const action = (activity.action ?? activity.toolName).slice(0, 96);
	return `${activity.toolName}:${action}`;
}

/**
 * Owns a child execution budget without owning the child agent loop. A soft
 * timeout aborts the active turn, retains the session, and exposes a bounded
 * decision point. Terminal cleanup is supplied by the runner callback.
 */
export class SubagentRunSupervisor<TResult> {
	private readonly runId: string;
	private readonly childSessionId: string | undefined;
	private readonly initialTimeoutMs: number;
	private readonly maxTotalBudgetMs: number;
	private readonly decisionGraceMs: number;
	private readonly now: () => number;
	private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
	private readonly cancelScheduled: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
	private readonly callbacks: SubagentRunSupervisorCallbacks<TResult>;
	private state: SubagentSupervisorState = "running";
	private phase: SubagentSupervisorPhase;
	private activeBudgetMs: number;
	private activeElapsedMs = 0;
	private totalExtendedMs = 0;
	private extensionCount = 0;
	private segmentStartedAtMs: number;
	private lastProgressAtMs: number | undefined;
	private decisionDeadlineAtMs: number | undefined;
	private usage: SubagentUsageSnapshot | undefined;
	private terminalStatus: string | undefined;
	private timer: ReturnType<typeof globalThis.setTimeout> | undefined;
	private decisionTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
	private timeoutPromise: Promise<void>;
	private resolveTimeoutPromise!: () => void;
	private interruptionPromise: Promise<void> = Promise.resolve();
	private operationPromise: Promise<TResult> | undefined;
	private terminalResult: TResult | undefined;
	private hasTerminalResult = false;
	private readonly activities = new Map<string, SubagentToolActivityDigest>();
	private readonly activityOrder: string[] = [];
	private readonly recentFailureCounts = new Map<string, { action: string; count: number }>();

	constructor(options: SubagentRunSupervisorOptions<TResult>) {
		this.runId = boundedText(options.runId);
		this.childSessionId = options.childSessionId;
		this.initialTimeoutMs = boundedPositiveInteger(options.initialTimeoutMs, 1);
		this.activeBudgetMs = this.initialTimeoutMs;
		this.maxTotalBudgetMs = Math.max(
			this.initialTimeoutMs,
			boundedPositiveInteger(options.maxTotalBudgetMs ?? DEFAULT_MAX_TOTAL_BUDGET_MS, DEFAULT_MAX_TOTAL_BUDGET_MS),
		);
		this.decisionGraceMs = Math.max(
			1,
			boundedPositiveInteger(options.decisionGraceMs ?? DEFAULT_DECISION_GRACE_MS, DEFAULT_DECISION_GRACE_MS),
		);
		this.now = options.now ?? Date.now;
		this.schedule = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
		this.cancelScheduled = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer));
		this.callbacks = options;
		this.phase = options.phase ?? "working";
		this.segmentStartedAtMs = this.now();
		this.timeoutPromise = this.createTimeoutPromise();
		this.armTimer();
		this.publish();
	}

	getSnapshot(): SubagentRunSupervisorSnapshot {
		const currentElapsed =
			this.state === "running" && this.phase !== "controlled_wait"
				? Math.max(0, this.now() - this.segmentStartedAtMs)
				: 0;
		const activeElapsedMs = Math.min(this.activeBudgetMs, this.activeElapsedMs + currentElapsed);
		const progressAgeMs =
			this.lastProgressAtMs === undefined ? undefined : Math.max(0, this.now() - this.lastProgressAtMs);
		return Object.freeze({
			runId: this.runId,
			...(this.childSessionId ? { childSessionId: this.childSessionId } : {}),
			state: this.state,
			phase: this.phase,
			initialTimeoutMs: this.initialTimeoutMs,
			activeBudgetMs: this.activeBudgetMs,
			activeElapsedMs,
			totalExtendedMs: this.totalExtendedMs,
			extensionCount: this.extensionCount,
			remainingExtendableMs: Math.max(0, this.maxTotalBudgetMs - this.activeBudgetMs),
			...(progressAgeMs !== undefined ? { progressAgeMs } : {}),
			...(this.lastProgressAtMs !== undefined ? { lastProgressAtMs: this.lastProgressAtMs } : {}),
			...(this.decisionDeadlineAtMs !== undefined ? { decisionDeadlineAtMs: this.decisionDeadlineAtMs } : {}),
			lastActivities: Object.freeze(
				this.activityOrder
					.map((id) => this.activities.get(id))
					.filter((item): item is SubagentToolActivityDigest => item !== undefined),
			),
			...(this.repeatedFailureAdvisory() ? { repeatedFailure: this.repeatedFailureAdvisory() } : {}),
			...(this.usage ? { usage: this.usage } : {}),
			...(this.terminalStatus ? { terminalStatus: this.terminalStatus } : {}),
		});
	}

	get stateValue(): SubagentSupervisorState {
		return this.state;
	}

	getTimeoutPromise(): Promise<void> {
		return this.timeoutPromise;
	}

	setPhase(phase: SubagentSupervisorPhase): void {
		if (this.state === "terminal") return;
		if (this.phase === phase) return;
		this.phase = phase;
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
		this.markProgress(activity.finishedAtMs ?? activity.startedAtMs);
	}

	/**
	 * Advisory repeated-failure signal: when the same normalized action fails at
	 * least twice among recently observed activities, advise the parent to inspect
	 * before extending. This never kills or steers the child by itself.
	 */
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
		if (activity.status === "ok" && current) {
			// A success after failures resolves the advisory for that action.
			this.recentFailureCounts.delete(key);
		}
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

	async extend(additionalMs: number): Promise<TResult> {
		if (this.operationPromise) return this.operationPromise;
		if (this.state !== "awaiting_extension") {
			throw new Error(`Subagent run ${this.runId} is not awaiting an extension.`);
		}
		if (!Number.isSafeInteger(additionalMs) || additionalMs < MIN_EXTENSION_MS) {
			throw new Error(`Subagent extension must be an integer of at least ${MIN_EXTENSION_MS} ms.`);
		}
		const remaining = Math.max(0, this.maxTotalBudgetMs - this.activeBudgetMs);
		if (remaining < MIN_EXTENSION_MS)
			throw new Error(`Subagent run ${this.runId} has no extension budget remaining.`);
		if (additionalMs > remaining) {
			throw new Error(`Requested extension exceeds the remaining ${remaining} ms subagent budget.`);
		}
		this.clearDecisionTimer();
		this.state = "running";
		this.decisionDeadlineAtMs = undefined;
		this.activeBudgetMs += additionalMs;
		this.totalExtendedMs += additionalMs;
		this.extensionCount += 1;
		this.timeoutPromise = this.createTimeoutPromise();
		this.publish();
		this.operationPromise = (async () => {
			await this.interruptionPromise;
			if (this.state !== "running") throw new Error(`Subagent run ${this.runId} is no longer resumable.`);
			this.segmentStartedAtMs = this.now();
			this.armTimer();
			try {
				return await this.callbacks.resume();
			} finally {
				this.operationPromise = undefined;
			}
		})();
		return this.operationPromise;
	}

	/** Mark a resumed run terminal after its callback has produced a final result. */
	finish(result: TResult, terminalStatus = "completed"): boolean {
		if (this.hasTerminalResult || this.state === "terminal") return false;
		if (this.state === "running") this.recordActiveElapsed();
		this.clearTimer();
		this.clearDecisionTimer();
		this.state = "terminal";
		this.decisionDeadlineAtMs = undefined;
		this.terminalStatus = terminalStatus;
		this.terminalResult = result;
		this.hasTerminalResult = true;
		this.publish();
		return true;
	}

	/** Close a run whose terminal result is owned by the runner rather than a supervisor callback. */
	terminate(terminalStatus = "completed"): boolean {
		if (this.state === "terminal") return false;
		if (this.state === "running") this.recordActiveElapsed();
		this.clearTimer();
		this.clearDecisionTimer();
		this.state = "terminal";
		this.decisionDeadlineAtMs = undefined;
		this.terminalStatus = terminalStatus;
		this.publish();
		return true;
	}

	/** Pause only the active execution clock while a controlled child waits for input. */
	pauseForControlledWait(): boolean {
		if (this.state !== "running" || this.phase === "controlled_wait") return false;
		this.recordActiveElapsed();
		this.clearTimer();
		this.phase = "controlled_wait";
		this.publish();
		return true;
	}

	/** Resume the active execution clock after controlled input is released. */
	resumeFromControlledWait(): boolean {
		if (this.state !== "running" || this.phase !== "controlled_wait") return false;
		this.phase = "working";
		this.segmentStartedAtMs = this.now();
		this.armTimer();
		this.publish();
		return true;
	}

	async stop(reason: SubagentSupervisorStopReason): Promise<TResult> {
		if (this.hasTerminalResult) return this.terminalResult as TResult;
		if (this.operationPromise) {
			void this.callbacks.abort().catch(() => {});
			return this.operationPromise;
		}
		this.clearTimer();
		this.clearDecisionTimer();
		if (this.state === "running") this.recordActiveElapsed();
		this.state = "terminal";
		this.decisionDeadlineAtMs = undefined;
		this.terminalStatus = reason === "cancelled" ? "cancelled" : "timed_out";
		this.publish();
		this.operationPromise = (async () => {
			try {
				const result = await this.callbacks.stop(reason);
				this.terminalResult = result;
				this.hasTerminalResult = true;
				return result;
			} finally {
				this.operationPromise = undefined;
			}
		})();
		return this.operationPromise;
	}

	async shutdown(): Promise<void> {
		if (this.state === "terminal") return;
		await this.stop("cancelled");
	}

	private createTimeoutPromise(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.resolveTimeoutPromise = resolve;
		});
	}

	private armTimer(): void {
		this.clearTimer();
		const remaining = Math.max(1, this.activeBudgetMs - this.activeElapsedMs);
		this.timer = this.schedule(() => {
			void this.triggerTimeout();
		}, remaining);
	}

	private async triggerTimeout(): Promise<void> {
		if (this.state !== "running") return;
		this.clearTimer();
		this.recordActiveElapsed();
		this.state = "awaiting_extension";
		this.decisionDeadlineAtMs = this.now() + this.decisionGraceMs;
		this.interruptionPromise = Promise.resolve(this.callbacks.abort()).catch(() => {});
		this.decisionTimer = this.schedule(() => {
			void this.stop("timed_out").catch(() => {});
		}, this.decisionGraceMs);
		this.resolveTimeoutPromise();
		this.publish();
		await this.interruptionPromise;
		this.publish();
	}

	private recordActiveElapsed(): void {
		if (this.state !== "running") return;
		this.activeElapsedMs = Math.min(
			this.activeBudgetMs,
			this.activeElapsedMs + Math.max(0, this.now() - this.segmentStartedAtMs),
		);
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			this.cancelScheduled(this.timer);
			this.timer = undefined;
		}
	}

	private clearDecisionTimer(): void {
		if (this.decisionTimer !== undefined) {
			this.cancelScheduled(this.decisionTimer);
			this.decisionTimer = undefined;
		}
	}

	private publish(): void {
		try {
			this.callbacks.onChange?.(this.getSnapshot());
		} catch {
			// Presentation observers cannot affect lifecycle state.
		}
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
