/**
 * Subagent V2 optional child budgets (Plan/subagent-rewrite.md section 13.4, P5.10).
 *
 * Budgets are opt-in: an absent limit is unlimited and there is no default
 * lifetime timeout. When a limit is reached the runner stops ordinary work,
 * may run one bounded wrap-up turn with tools restricted, and records the turn
 * outcome `budget_exhausted`. Usage is observational and never grants authority.
 */

import { performance } from "node:perf_hooks";

export interface ChildBudgetLimits {
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
}

export type BudgetState =
	| { status: "ok" }
	| { status: "exhausted"; limit: keyof ChildBudgetLimits; used: number; max: number };

export class ChildBudgetTracker {
	private readonly limits: ChildBudgetLimits;
	private readonly startedAt: number;
	private readonly now: () => number;
	private turns = 0;
	private tokens = 0;
	private wrapUpUsed = false;

	constructor(limits: ChildBudgetLimits, now: () => number = () => performance.now()) {
		this.limits = { ...limits };
		this.now = now;
		this.startedAt = now();
	}

	recordTurn(inputTokens: number, outputTokens: number): void {
		this.recordRequest();
		this.recordUsage(inputTokens, outputTokens);
	}

	recordRequest(): void {
		this.turns += 1;
	}

	recordUsage(inputTokens: number, outputTokens: number): void {
		this.tokens += Math.max(0, inputTokens) + Math.max(0, outputTokens);
	}

	remainingTokens(): number | undefined {
		return this.limits.maxTokens === undefined ? undefined : Math.max(0, this.limits.maxTokens - this.tokens);
	}

	/** Checked before every model turn and tool call. */
	check(): BudgetState {
		const { maxTurns, maxTokens, timeoutMs } = this.limits;
		if (maxTurns !== undefined && this.turns >= maxTurns)
			return { status: "exhausted", limit: "maxTurns", used: this.turns, max: maxTurns };
		if (maxTokens !== undefined && this.tokens >= maxTokens)
			return { status: "exhausted", limit: "maxTokens", used: this.tokens, max: maxTokens };
		const elapsed = this.now() - this.startedAt;
		if (timeoutMs !== undefined && elapsed >= timeoutMs)
			return { status: "exhausted", limit: "timeoutMs", used: elapsed, max: timeoutMs };
		return { status: "ok" };
	}

	/** One bounded wrap-up turn is allowed after exhaustion; later requests are refused. */
	claimWrapUp(): boolean {
		if (this.check().status === "ok" || this.wrapUpUsed) return false;
		this.wrapUpUsed = true;
		return true;
	}
}

export function budgetExhaustedMessage(state: Extract<BudgetState, { status: "exhausted" }>): string {
	return `Budget ${state.limit} reached (${state.used}/${state.max}). Stop working and give a brief final report of what you completed, what remains, and what you verified. Do not call tools.`;
}
