import { afterEach, describe, expect, it, vi } from "vitest";
import {
	projectSubagentManagementState,
	SubagentRunSupervisor,
	SubagentRunSupervisorRegistry,
} from "../src/subagents/runtime/supervisor.ts";

afterEach(() => {
	vi.useRealTimers();
});

function supervisor(runId: string, stopResult = runId) {
	return new SubagentRunSupervisor<string>({
		runId,
		childSessionId: `${runId}-child`,
		abort: async () => undefined,
		stop: async () => stopResult,
		now: () => Date.now(),
	});
}

describe("ICE subagent lifecycle multiplexing without lifetime timeouts", () => {
	it("keeps multiple children independently live beyond former timeout windows", async () => {
		vi.useFakeTimers();
		const first = supervisor("first");
		const second = supervisor("second");
		await vi.advanceTimersByTimeAsync(20 * 60_000);

		for (const current of [first, second]) {
			expect(current.getSnapshot()).toMatchObject({
				state: "running",
				lifetimeDeadline: false,
				activeElapsedMs: 20 * 60_000,
			});
		}
	});

	it("terminalizing one child does not affect siblings", () => {
		const first = supervisor("first");
		const second = supervisor("second");
		first.finish("done", "completed");
		expect(projectSubagentManagementState(first.getSnapshot())).toEqual({
			childState: "completed",
			terminal: true,
		});
		expect(projectSubagentManagementState(second.getSnapshot())).toEqual({
			childState: "running",
			terminal: false,
		});
	});

	it("multiplexes lifecycle waiters without polling", async () => {
		const first = supervisor("first");
		const second = supervisor("second");
		const firstWait = first.waitForLifecycleChange();
		const secondWait = second.waitForLifecycleChange();
		expect(first.pendingLifecycleWaiters).toBe(1);
		expect(second.pendingLifecycleWaiters).toBe(1);

		first.terminate("completed");
		await firstWait;
		expect(first.pendingLifecycleWaiters).toBe(0);
		expect(second.pendingLifecycleWaiters).toBe(1);

		second.terminate("failed");
		await secondWait;
		expect(second.pendingLifecycleWaiters).toBe(0);
	});

	it("explicitly stopping one child does not stop another", async () => {
		const firstAbort = vi.fn(async () => undefined);
		const firstStop = vi.fn(async () => "cancelled");
		const first = new SubagentRunSupervisor<string>({
			runId: "first",
			abort: firstAbort,
			stop: firstStop,
		});
		const second = supervisor("second");

		expect(await first.stop("cancelled")).toBe("cancelled");
		expect(firstAbort).toHaveBeenCalledTimes(1);
		expect(firstStop).toHaveBeenCalledTimes(1);
		expect(first.getSnapshot().state).toBe("terminal");
		expect(second.getSnapshot().state).toBe("running");
	});

	it("keeps controlled-wait accounting isolated per child", async () => {
		vi.useFakeTimers();
		const first = supervisor("first");
		const second = supervisor("second");
		await vi.advanceTimersByTimeAsync(1_000);
		first.pauseForControlledWait();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(first.getSnapshot().activeElapsedMs).toBe(1_000);
		expect(second.getSnapshot().activeElapsedMs).toBe(6_000);

		first.resumeFromControlledWait();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(first.getSnapshot().activeElapsedMs).toBe(2_000);
		expect(second.getSnapshot().activeElapsedMs).toBe(7_000);
	});

	it("keeps repeated failures advisory and child-local", () => {
		const first = supervisor("first");
		const second = supervisor("second");
		for (const id of ["a", "b"]) {
			first.recordActivity({
				toolCallId: id,
				toolName: "bash",
				action: "npm test",
				status: "error",
				startedAtMs: 1,
				finishedAtMs: 2,
			});
		}
		expect(first.getSnapshot().repeatedFailure).toEqual({ action: "npm test", count: 2 });
		expect(first.getSnapshot().state).toBe("running");
		expect(second.getSnapshot().repeatedFailure).toBeUndefined();
		expect(second.getSnapshot().state).toBe("running");
	});

	it("enforces registry capacity without coupling child lifecycles", () => {
		const registry = new SubagentRunSupervisorRegistry<string>(2);
		const first = supervisor("first");
		const second = supervisor("second");
		registry.register(first);
		registry.register(second);
		expect(registry.list().map((entry) => entry.runId)).toEqual(["first", "second"]);
		expect(() => registry.register(supervisor("third"))).toThrow(/capacity/);
		first.terminate("completed");
		expect(second.getSnapshot().state).toBe("running");
	});

	it("aborting a lifecycle wait does not terminate the child", async () => {
		const current = supervisor("wait-abort");
		const controller = new AbortController();
		const waiter = current.waitForLifecycleChange(controller.signal);
		controller.abort();
		await waiter;
		expect(current.pendingLifecycleWaiters).toBe(0);
		expect(current.getSnapshot().state).toBe("running");
	});
});
