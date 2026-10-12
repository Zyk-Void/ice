import { afterEach, describe, expect, test, vi } from "vitest";
import { RpcRequestTracker } from "../src/modes/rpc/rpc-request-tracker.ts";

afterEach(() => vi.useRealTimers());

describe("RPC request ownership", () => {
	test("all queued commands can cancel, but unsupported running mutations cannot", () => {
		const tracker = new RpcRequestTracker();
		const queued = tracker.begin({ id: "queued", type: "set_model", provider: "faux", modelId: "one" });
		const running = tracker.begin({ id: "running", type: "new_session" });
		running.start();
		expect(tracker.cancel("queued")).toBe(true);
		expect(queued.signal.reason).toMatchObject({ errorCode: "cancelled" });
		expect(tracker.cancel("running")).toBe(false);
		tracker.abortAll();
		expect(running.signal.aborted).toBe(false);
		queued.finish();
		running.finish();
	});
	test("targets one supported request, not neighbours or unsupported commands", () => {
		const requests = new RpcRequestTracker();
		const one = requests.begin({ id: "one", type: "bash", command: "one" });
		const two = requests.begin({ id: "two", type: "compact" });
		const query = requests.begin({ id: "query", type: "get_state" });
		query.start();
		expect(requests.cancel("missing")).toBe(false);
		expect(requests.cancel("query")).toBe(false);
		expect(requests.cancel("one")).toBe(true);
		expect(one.signal?.reason).toMatchObject({ errorCode: "cancelled" });
		expect(two.signal?.aborted).toBe(false);
		expect(requests.cancel("one")).toBe(false);
		for (const scope of [one, two, query]) scope.finish();
		expect(requests.cancel("two")).toBe(false);
	});

	test("rejects active duplicate IDs without replacing the original ownership", () => {
		const requests = new RpcRequestTracker();
		const original = requests.begin({ id: "same", type: "compact" });
		expect(() => requests.begin({ id: "same", type: "abort" })).toThrow("already uses");
		expect(requests.cancel("same")).toBe(true);
		original.finish();
		const replacement = requests.begin({ id: "same", type: "compact" });
		original.finish(); // A stale cleanup must not erase the new record.
		expect(requests.cancel("same")).toBe(true);
		replacement.finish();
	});

	test("deadlines include queue time, preserve first cancellation cause, and clean timers", async () => {
		vi.useFakeTimers();
		const requests = new RpcRequestTracker();
		const deadline = requests.begin({ id: "deadline", type: "compact", timeoutMs: 20 });
		const cancelled = requests.begin({ id: "cancelled", type: "compact", timeoutMs: 20 });
		requests.cancel("cancelled");
		await vi.advanceTimersByTimeAsync(20);
		expect(deadline.signal?.reason).toMatchObject({ errorCode: "timeout" });
		expect(cancelled.signal?.reason).toMatchObject({ errorCode: "cancelled" });
		deadline.finish();
		cancelled.finish();
		expect(vi.getTimerCount()).toBe(0);
	});

	test("omitted deadlines impose no timer and anonymous deadlines remain host-owned", async () => {
		vi.useFakeTimers();
		const requests = new RpcRequestTracker();
		const ordinary = requests.begin({ type: "compact" });
		const deadline = requests.begin({ type: "bash", command: "synthetic", timeoutMs: 20 });
		expect(vi.getTimerCount()).toBe(1);
		requests.abortAll();
		expect(ordinary.signal?.aborted).toBe(true);
		expect(deadline.signal?.reason).toMatchObject({ errorCode: "cancelled" });
		expect(vi.getTimerCount()).toBe(0);
		ordinary.finish();
		deadline.finish();
	});

	test("settlement removes the timer before it can cancel completed work", async () => {
		vi.useFakeTimers();
		const requests = new RpcRequestTracker();
		const completed = requests.begin({ id: "done", type: "navigate_tree", targetId: "entry", timeoutMs: 20 });
		completed.finish();
		await vi.advanceTimersByTimeAsync(40);
		expect(completed.signal?.aborted).toBe(false);
		expect(requests.cancel("done")).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
});
