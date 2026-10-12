import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalBroker, type ApprovalRequest } from "../../src/subagents/permissions/approval.ts";
import { ChildBudgetTracker } from "../../src/subagents/runtime/budgets.ts";
import { budgetTokens, ChildTurnBudget, resolveTurnBudget } from "../../src/subagents/v2/turn-budget.ts";
import { createHarness } from "./harness.ts";

afterEach(() => vi.useRealTimers());

describe("V2 budget limits", () => {
	it("ignores wall-clock jumps when measuring elapsed runtime", () => {
		let elapsed = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		const wall = vi.spyOn(Date, "now").mockReturnValue(0);
		try {
			const tracker = new ChildBudgetTracker({ timeoutMs: 100 });
			wall.mockReturnValue(1_000_000);
			elapsed = 50;
			expect(tracker.check()).toEqual({ status: "ok" });
			elapsed = 100;
			expect(tracker.check()).toMatchObject({ limit: "timeoutMs", used: 100 });
		} finally {
			clock.mockRestore();
			wall.mockRestore();
		}
	});
	it.each(["maxTurns", "maxTokens", "timeoutMs"] as const)("validates and inherits %s ceilings", (key) => {
		for (const value of [0, -1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
			expect(() => resolveTurnBudget({ [key]: value })).toThrow(/positive safe integer/);
		expect(resolveTurnBudget({ [key]: 10 }, { [key]: 5 })).toEqual({ [key]: 5 });
		expect(resolveTurnBudget({ [key]: 10 }, {})).toEqual({ [key]: 10 });
		expect(() => resolveTurnBudget({ [key]: 10 }, { [key]: 11 })).toThrow(/frozen ceiling/);
	});

	it("counts uncached input, cache writes, and output but not cache reads toward maxTokens", () => {
		expect(budgetTokens({ input: 120, output: 30, cacheWrite: 50 })).toEqual({ input: 170, output: 30 });
		const cachedOnly = { input: 0, output: 0, cacheWrite: 0, cacheRead: 90_000 };
		expect(budgetTokens(cachedOnly)).toEqual({ input: 0, output: 0 });
	});

	it("snapshots limits and counts requests separately from reported usage", () => {
		const limits = { maxTurns: 2, maxTokens: 100 };
		const tracker = new ChildBudgetTracker(limits);
		limits.maxTurns = 100;
		tracker.recordRequest();
		tracker.recordUsage(20, 10);
		expect(tracker.remainingTokens()).toBe(70);
		expect(tracker.check()).toEqual({ status: "ok" });
		tracker.recordRequest();
		expect(tracker.check()).toMatchObject({ limit: "maxTurns", used: 2 });
	});

	it("restores hooks and settings and never schedules an unlimited deadline", async () => {
		const harness = await createHarness();
		const agent = harness.session.agent;
		const original = { stream: agent.streamFunction, tool: agent.beforeToolCall, stop: agent.shouldStopAfterTurn };
		const retry = harness.settingsManager.getRetrySettings();
		const compaction = harness.settingsManager.getCompactionSettings();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const baselineTimers = vi.getTimerCount();
		const unlimited = new ChildTurnBudget(harness.session, {}, () => {}, new AbortController().signal);
		try {
			expect(vi.getTimerCount()).toBe(baselineTimers);
			expect(harness.settingsManager.getRetrySettings()).toEqual(retry);
			expect(harness.settingsManager.getCompactionSettings()).toEqual(compaction);
		} finally {
			unlimited.dispose();
		}
		const bounded = new ChildTurnBudget(harness.session, { maxTurns: 2 }, () => {}, new AbortController().signal);
		try {
			expect(harness.settingsManager.getRetrySettings().enabled).toBe(false);
			expect(harness.settingsManager.getCompactionSettings().enabled).toBe(false);
		} finally {
			bounded.dispose();
		}
		expect(agent.streamFunction).toBe(original.stream);
		expect(agent.beforeToolCall).toBe(original.tool);
		expect(agent.shouldStopAfterTurn).toBe(original.stop);
		expect(harness.settingsManager.getRetrySettings()).toEqual(retry);
		expect(harness.settingsManager.getCompactionSettings()).toEqual(compaction);
		harness.cleanup();
	});

	it("re-arms long deadlines instead of exhausting at the native timer ceiling", async () => {
		const harness = await createHarness();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let now = 0;
		const timeoutMs = 2_147_483_647 + 100_000;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		const abort = vi.spyOn(harness.session, "abort");
		const budget = new ChildTurnBudget(
			harness.session,
			{ timeoutMs },
			() => {},
			new AbortController().signal,
			() => now,
		);
		try {
			now = 2_147_483_647;
			await vi.advanceTimersByTimeAsync(2_147_483_647);
			expect(abort).not.toHaveBeenCalled();
			expect(budget.exhausted()).toBeUndefined();
			expect(vi.getTimerCount()).toBe(1);
			now = timeoutMs - 1;
			await vi.advanceTimersByTimeAsync(99_999);
			expect(abort).not.toHaveBeenCalled();
			now = timeoutMs;
			await vi.advanceTimersByTimeAsync(1);
			expect(abort).toHaveBeenCalledOnce();
			expect(budget.exhausted()).toMatchObject({ limit: "timeoutMs", used: timeoutMs });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			budget.dispose();
			abort.mockRestore();
			clock.mockRestore();
			harness.cleanup();
		}
	});
});

const request: ApprovalRequest = {
	id: "approval",
	ownerSessionId: "owner",
	childId: "child",
	agent: "general",
	tool: "write",
	summary: "write a.txt",
	foreground: true,
};
describe("V2 approval cancellation", () => {
	it("stops waiting on an automated check that ignores cancellation", async () => {
		const controller = new AbortController();
		const broker = new ApprovalBroker({ automatedCheck: async () => new Promise(() => {}) });
		const waiting = broker.request(request, controller.signal);
		controller.abort();
		expect(await waiting).toMatchObject({ decision: "deny", source: "cancelled" });
		broker.dispose();
	});
	it("settles and removes a cancelled waiter even when the UI ignores abort", async () => {
		let uiSignal: AbortSignal | undefined;
		const broker = new ApprovalBroker({
			interactive: async (_request, signal) => {
				uiSignal = signal;
				return new Promise(() => {});
			},
		});
		const controller = new AbortController();
		const waiting = broker.request(request, controller.signal);
		await Promise.resolve();
		controller.abort();
		expect(await waiting).toEqual({ decision: "deny", source: "cancelled" });
		expect(uiSignal?.aborted).toBe(true);
		expect(broker.pending).toEqual([]);
		expect(broker.respond(request.id, "allow-once")).toBe(false);
		broker.dispose();
	});

	it("does not prompt a request already cancelled or cancelled during automated checks", async () => {
		const interactive = vi.fn(async () => "allow-once" as const);
		const controller = new AbortController();
		controller.abort();
		const broker = new ApprovalBroker({ interactive });
		expect(await broker.request(request, controller.signal)).toMatchObject({ source: "cancelled" });
		expect(interactive).not.toHaveBeenCalled();
		const second = new AbortController();
		const checked = new ApprovalBroker({
			interactive,
			automatedCheck: async () => {
				second.abort();
				return "allow";
			},
		});
		expect(await checked.request(request, second.signal)).toMatchObject({ source: "cancelled" });
		expect(interactive).not.toHaveBeenCalled();
		broker.dispose();
		checked.dispose();
	});
});
