/** Per-admitted-task budgets around the ordinary Ice loop; no alternate model loop. */
import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "@zykairotis/ice-ai/compat";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	type BudgetState,
	budgetExhaustedMessage,
	type ChildBudgetLimits,
	ChildBudgetTracker,
} from "../runtime/budgets.ts";

/**
 * Tokens a `maxTokens` budget counts: uncached input, cache writes, and output.
 * Cache reads are excluded: they re-read already-processed context, are large and
 * cheap, and would exhaust a budget long before the child did new work. They stay
 * visible in usage reporting.
 */
export function budgetTokens(usage: Pick<AssistantMessage["usage"], "input" | "output" | "cacheWrite">): {
	input: number;
	output: number;
} {
	return { input: usage.input + usage.cacheWrite, output: usage.output };
}

export const CHILD_WRAP_UP_LIMITS = Object.freeze({ timeoutMs: 30_000, maxTokens: 1024 });
type ExhaustedBudget = Extract<BudgetState, { status: "exhausted" }>;

/** Renewal can narrow a frozen ceiling, never remove or raise it. */
export function resolveTurnBudget(frozen: ChildBudgetLimits, renewal?: ChildBudgetLimits): ChildBudgetLimits {
	const limits: ChildBudgetLimits = {};
	for (const key of ["maxTurns", "maxTokens", "timeoutMs"] as const) {
		const value = renewal?.[key] ?? frozen[key];
		if (value !== undefined) {
			if (!Number.isSafeInteger(value) || value < 1 || (frozen[key] !== undefined && value > frozen[key]!))
				throw new Error(`Budget ${key} must be a positive safe integer within the frozen ceiling.`);
			limits[key] = value;
		}
	}
	return limits;
}

export class ChildTurnBudget {
	private readonly session: AgentSession;
	private readonly tracker: ChildBudgetTracker;
	private readonly signal: AbortSignal;
	private readonly restore: () => void;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private exhaustion: ExhaustedBudget | undefined;
	private wrappingUp = false;
	private wrapRequests = 0;
	private wrapTimedOut = false;

	constructor(
		session: AgentSession,
		limits: ChildBudgetLimits,
		authorize: () => void,
		signal: AbortSignal,
		now?: () => number,
	) {
		this.session = session;
		this.signal = signal;
		this.tracker = new ChildBudgetTracker(limits, now);
		const agent = session.agent;
		const stream = agent.streamFunction;
		const beforeTool = agent.beforeToolCall;
		const stop = agent.shouldStopAfterTurn;
		const seen = new WeakSet<AssistantMessage>();
		const recordUsage = (message: AssistantMessage) => {
			if (this.wrappingUp || seen.has(message)) return;
			seen.add(message);
			const usage = message.usage;
			const counted = budgetTokens(usage);
			this.tracker.recordUsage(counted.input, counted.output);
		};
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") recordUsage(event.message);
		});
		agent.streamFunction = (model, context, options) => {
			authorize();
			this.signal.throwIfAborted();
			if (this.wrapTimedOut) throw new Error("Budget wrap-up deadline reached.");
			if (options?.signal?.aborted) throw new Error("Child request was cancelled.");
			if (this.wrappingUp) {
				if (this.wrapRequests++ > 0) throw new Error("Only one budget wrap-up request is allowed.");
				return stream(
					model,
					{ ...context, tools: [] },
					{
						...options,
						maxTokens: Math.min(options?.maxTokens ?? model.maxTokens, CHILD_WRAP_UP_LIMITS.maxTokens),
					},
				);
			}
			this.assertOrdinaryWork();
			this.tracker.recordRequest();
			const remaining = this.tracker.remainingTokens();
			return stream(
				model,
				context,
				remaining === undefined
					? options
					: {
							...options,
							maxTokens: Math.min(options?.maxTokens ?? model.maxTokens, remaining),
						},
			);
		};
		agent.beforeToolCall = async (context, signal) => {
			recordUsage(context.assistantMessage);
			this.assertOrdinaryWork();
			return beforeTool?.(context, signal);
		};
		agent.shouldStopAfterTurn = async (context, signal) => {
			recordUsage(context.message);
			if (this.wrappingUp || this.exhausted()) return true;
			return (await stop?.(context, signal)) ?? false;
		};
		// Avoid automatic recovery/summary requests outside the task budget. These
		// are transient child-local overrides, restored before the next task.
		const retry = session.settingsManager.getRetrySettings();
		const compaction = session.settingsManager.getCompactionSettings();
		const explicit = Object.keys(limits).length > 0;
		if (explicit)
			session.settingsManager.applyOverrides({ retry: { enabled: false }, compaction: { enabled: false } });
		this.restore = () => {
			unsubscribe();
			agent.streamFunction = stream;
			agent.beforeToolCall = beforeTool;
			agent.shouldStopAfterTurn = stop;
			if (explicit)
				session.settingsManager.applyOverrides({
					retry: { enabled: retry.enabled },
					compaction: { enabled: compaction.enabled },
				});
		};
		if (limits.timeoutMs !== undefined) {
			const timeoutMs = limits.timeoutMs;
			const deadline = performance.now() + timeoutMs;
			const arm = () => {
				const remaining = deadline - performance.now();
				if (remaining > 0) {
					this.timer = setTimeout(arm, Math.min(Math.ceil(remaining), 2_147_483_647));
					return;
				}
				this.exhaustion ??= { status: "exhausted", limit: "timeoutMs", used: timeoutMs, max: timeoutMs };
				void session.abort().catch(() => {});
			};
			arm();
		}
	}

	exhausted(): ExhaustedBudget | undefined {
		const state = this.tracker.check();
		if (state.status === "exhausted") this.exhaustion ??= state;
		return this.exhaustion;
	}

	assertOrdinaryWork(): void {
		this.signal.throwIfAborted();
		if (this.wrappingUp) throw new Error("Tools are disabled during budget wrap-up.");
		const state = this.exhausted();
		if (state) throw new Error(budgetExhaustedMessage(state));
	}

	async wrapUp(signal: AbortSignal): Promise<string | undefined> {
		const state = this.exhausted();
		if (!state || signal.aborted || this.wrappingUp) return undefined;
		// The runtime timer can exhaust even when an injected test clock has not advanced.
		// wrapRequests independently enforces one request in both cases.
		this.wrappingUp = true;
		if (this.timer) clearTimeout(this.timer);
		const tools = this.session.getActiveToolNames();
		this.session.clearQueue();
		this.session.setActiveToolsByName([]);
		this.timer = setTimeout(() => {
			this.wrapTimedOut = true;
			void this.session.abort().catch(() => {});
		}, CHILD_WRAP_UP_LIMITS.timeoutMs);
		try {
			await this.session.prompt(budgetExhaustedMessage(state), {
				expandPromptTemplates: false,
				source: "extension",
			});
			const last = this.session.messages.at(-1);
			if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted"))
				return last.errorMessage ?? "Budget wrap-up was interrupted.";
		} catch (error) {
			return `Budget wrap-up failed: ${String(error)}`;
		} finally {
			this.session.clearQueue();
			this.session.setActiveToolsByName(tools);
		}
		return undefined;
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.restore();
	}
}
