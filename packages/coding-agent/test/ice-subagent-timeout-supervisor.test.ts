import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeIceAgentViewPresentation } from "../src/ice-agent-view-bridge.ts";
import {
	formatSubagentToolActivity,
	projectSubagentManagementState,
	SubagentRunSupervisor,
	SubagentRunSupervisorRegistry,
} from "../src/ice-subagent-timeout-supervisor.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("ICE no-lifetime subagent supervision", () => {
	it("keeps a live child running indefinitely until explicit termination", async () => {
		vi.useFakeTimers();
		const abort = vi.fn(async () => undefined);
		const stop = vi.fn(async () => "cancelled");
		const supervisor = new SubagentRunSupervisor<string>({
			runId: "run-no-lifetime",
			childSessionId: "child-1",
			abort,
			stop,
			now: () => Date.now(),
		});

		await vi.advanceTimersByTimeAsync(15 * 60_000);
		const snapshot = supervisor.getSnapshot();
		expect(snapshot.state).toBe("running");
		expect(snapshot.lifetimeDeadline).toBe(false);
		expect(snapshot.activeElapsedMs).toBe(15 * 60_000);
		expect(abort).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
	});

	it("pauses autonomous elapsed accounting during controlled wait", async () => {
		vi.useFakeTimers();
		const supervisor = new SubagentRunSupervisor<string>({
			runId: "run-controlled",
			abort: async () => undefined,
			stop: async () => "cancelled",
			now: () => Date.now(),
		});

		await vi.advanceTimersByTimeAsync(2_000);
		expect(supervisor.pauseForControlledWait()).toBe(true);
		const paused = supervisor.getSnapshot().activeElapsedMs;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(supervisor.getSnapshot().activeElapsedMs).toBe(paused);
		expect(supervisor.resumeFromControlledWait()).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(supervisor.getSnapshot()).toMatchObject({
			state: "running",
			phase: "working",
			activeElapsedMs: paused + 1_000,
			lifetimeDeadline: false,
		});
	});

	it("uses explicit stop as the only supervisor terminalizer and is idempotent", async () => {
		const abort = vi.fn(async () => undefined);
		const stop = vi.fn(async () => "cancelled-result");
		const supervisor = new SubagentRunSupervisor<string>({
			runId: "run-stop",
			abort,
			stop,
		});

		const [a, b] = await Promise.all([supervisor.stop("cancelled"), supervisor.stop("cancelled")]);
		expect(a).toBe("cancelled-result");
		expect(b).toBe("cancelled-result");
		expect(abort).toHaveBeenCalledTimes(1);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(projectSubagentManagementState(supervisor.getSnapshot())).toEqual({
			childState: "cancelled",
			terminal: true,
		});
	});

	it("settles lifecycle waiters on terminal transition and abort without leaking", async () => {
		const supervisor = new SubagentRunSupervisor<string>({
			runId: "run-wait",
			abort: async () => undefined,
			stop: async () => "cancelled",
		});
		const first = supervisor.waitForLifecycleChange();
		expect(supervisor.pendingLifecycleWaiters).toBe(1);
		supervisor.terminate("completed");
		await first;
		expect(supervisor.pendingLifecycleWaiters).toBe(0);

		const live = new SubagentRunSupervisor<string>({
			runId: "run-abort-wait",
			abort: async () => undefined,
			stop: async () => "cancelled",
		});
		const controller = new AbortController();
		const second = live.waitForLifecycleChange(controller.signal);
		expect(live.pendingLifecycleWaiters).toBe(1);
		controller.abort();
		await second;
		expect(live.pendingLifecycleWaiters).toBe(0);
		expect(live.getSnapshot().state).toBe("running");
	});

	it("retains bounded activity details and raises repeated-failure advisory only", () => {
		const supervisor = new SubagentRunSupervisor<string>({
			runId: "run-activity",
			abort: async () => undefined,
			stop: async () => "cancelled",
		});
		for (const [id, exitCode] of [
			["one", 1],
			["two", 2],
		] as const) {
			supervisor.recordActivity({
				toolCallId: id,
				toolName: "bash",
				action: "npm test",
				status: "error",
				startedAtMs: 10,
				finishedAtMs: 20,
				exitCode,
				errorClass: "command_failed",
			});
		}
		const snapshot = supervisor.getSnapshot();
		expect(snapshot.state).toBe("running");
		expect(snapshot.repeatedFailure).toEqual({ action: "npm test", count: 2 });
		expect(snapshot.lastActivities.at(-1)).toMatchObject({
			status: "error",
			exitCode: 2,
			errorClass: "command_failed",
		});
	});

	it("formats bounded activity outcomes without timeout vocabulary", () => {
		expect(
			formatSubagentToolActivity({
				toolCallId: "tool-1",
				toolName: "bash",
				action: "npm test",
				status: "error",
				startedAtMs: 10,
				finishedAtMs: 25,
				exitCode: 1,
			}),
		).toBe("error npm test · 15ms · exit 1");
	});

	it("normalizes current no-lifetime runtime attention at the view boundary", () => {
		const presentation = normalizeIceAgentViewPresentation({
			runtimeAttention: {
				phase: "working",
				state: "running",
				lifetimeDeadline: false,
				activeElapsedMs: 1234,
				observedPathCount: 0,
				lastActivities: [],
			},
		});
		expect(presentation?.runtimeAttention).toEqual({
			phase: "working",
			state: "running",
			lifetimeDeadline: false,
			activeElapsedMs: 1234,
			lastActivities: [],
		});
	});

	it("keeps historical timed_out terminal records readable without creating a live timeout path", () => {
		const supervisor = new SubagentRunSupervisor<string>({
			runId: "run-history",
			abort: async () => undefined,
			stop: async () => "cancelled",
		});
		supervisor.terminate("timed_out");
		expect(projectSubagentManagementState(supervisor.getSnapshot())).toEqual({
			childState: "timed_out",
			terminal: true,
		});
	});

	it("shuts down every registered live supervisor through explicit cancellation", async () => {
		const registry = new SubagentRunSupervisorRegistry<string>(2);
		const stopA = vi.fn(async () => "a");
		const stopB = vi.fn(async () => "b");
		registry.register(
			new SubagentRunSupervisor<string>({
				runId: "a",
				abort: async () => undefined,
				stop: stopA,
			}),
		);
		registry.register(
			new SubagentRunSupervisor<string>({
				runId: "b",
				abort: async () => undefined,
				stop: stopB,
			}),
		);
		await registry.shutdownAll();
		expect(stopA).toHaveBeenCalledTimes(1);
		expect(stopB).toHaveBeenCalledTimes(1);
		expect(registry.list()).toEqual([]);
	});
});
