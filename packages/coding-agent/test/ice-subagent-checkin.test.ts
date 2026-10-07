import { describe, expect, it } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import {
	SUBAGENT_CHECKIN_INTERVAL_MS,
	SUBAGENT_CHECKIN_MESSAGE_TYPE,
	type SubagentCheckInClock,
	SubagentCheckInCoordinator,
	type SubagentCheckInNotice,
} from "../src/subagents/runtime/checkin.ts";

class TestClock implements SubagentCheckInClock {
	private time = 1000;
	private nextId = 0;
	private timers = new Map<number, { at: number; callback: () => void }>();
	private microtasks: Array<() => void> = [];
	now = (): number => this.time;
	setTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
		const id = ++this.nextId;
		this.timers.set(id, { at: this.time + delayMs, callback });
		return id as unknown as ReturnType<typeof setTimeout>;
	};
	clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
		this.timers.delete(handle as unknown as number);
	};
	queueTask = (callback: () => void): void => {
		this.microtasks.push(callback);
	};
	advance(ms: number): void {
		const target = this.time + ms;
		while (true) {
			const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (!next || next[1].at > target) break;
			this.time = next[1].at;
			this.timers.delete(next[0]);
			next[1].callback();
		}
		this.time = target;
		this.flush();
	}
	flush(): void {
		while (this.microtasks.length > 0) this.microtasks.shift()?.();
	}
	get pendingTimers(): number {
		return this.timers.size;
	}
	get firstTimerCallback(): (() => void) | undefined {
		return this.timers.values().next().value?.callback;
	}
}

function createOwner(id = "owner") {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const notices: SubagentCheckInNotice[] = [];
	const sendOptions: Array<{ triggerTurn: boolean; deliverAs: string }> = [];
	const sendCustomMessage = async (
		message: { details?: unknown; customType: string },
		options: { triggerTurn: boolean; deliverAs: string },
	): Promise<void> => {
		sendOptions.push(options);
		expect(message.customType).toBe(SUBAGENT_CHECKIN_MESSAGE_TYPE);
		notices.push(message.details as SubagentCheckInNotice);
	};
	const session = {
		sessionId: id,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sendCustomMessage,
	} as unknown as AgentSession;
	const emit = (event: AgentSessionEvent): void => {
		for (const listener of listeners) listener(event);
	};
	const consume = (failed = false): void => {
		const notice = notices.at(-1);
		if (!notice) throw new Error("No notice to consume");
		emit({
			type: "message_start",
			message: {
				role: "custom",
				customType: SUBAGENT_CHECKIN_MESSAGE_TYPE,
				content: "check-in",
				display: false,
				details: notice,
				timestamp: Date.now(),
			},
		});
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: failed ? "error" : "stop",
				timestamp: Date.now(),
			},
		});
		emit({ type: "agent_settled" });
	};
	return {
		session,
		notices,
		sendOptions,
		consume,
		emit,
		get listenerCount() {
			return listeners.size;
		},
	};
}

const child = (runId: string) => ({
	runId,
	role: "reviewer",
	model: "cx/test",
	executionStatus: "running" as const,
	freshness: "unknown" as const,
});

describe("owner-scoped subagent check-ins", () => {
	it("rejects a shorter interval and never treats stale or overdue progress as terminal", () => {
		const clock = new TestClock();
		const owner = createOwner();
		const coordinator = new SubagentCheckInCoordinator("owner", () => owner.session, clock);
		expect(() => coordinator.arm("r", 119_999, () => child("r"))).toThrow("at least 120000");
		coordinator.arm("r", SUBAGENT_CHECKIN_INTERVAL_MS, () => ({ ...child("r"), freshness: "stale" }));
		clock.advance(119_999);
		expect(owner.notices).toHaveLength(0);
		clock.advance(1);
		expect(owner.notices).toHaveLength(1);
		expect(owner.sendOptions).toEqual([{ triggerTurn: true, deliverAs: "followUp" }]);
		expect(owner.notices[0].children[0]).toMatchObject({ executionStatus: "running", freshness: "stale" });
		expect(coordinator.getState("r")?.delivery).toBe("queued_for_parent");
		clock.advance(500_000);
		expect(owner.notices).toHaveLength(1);
		coordinator.dispose();
	});

	it("re-arms only after actual consumption and settlement, not enqueue", () => {
		const clock = new TestClock();
		const owner = createOwner();
		const coordinator = new SubagentCheckInCoordinator("owner", () => owner.session, clock);
		coordinator.arm("r", 120_000, () => child("r"));
		clock.advance(120_000);
		clock.advance(200_000);
		expect(owner.notices).toHaveLength(1);
		owner.consume();
		expect(coordinator.getState("r")).toMatchObject({
			sequence: 1,
			lastAcknowledgedAt: clock.now(),
			nextDueAt: clock.now() + 120_000,
		});
		clock.advance(119_999);
		expect(owner.notices).toHaveLength(1);
		clock.advance(1);
		expect(owner.notices).toHaveLength(2);
		expect(owner.notices[1].children[0].sequence).toBe(2);
		coordinator.dispose();
	});

	it("coalesces siblings due together and suppresses terminal and stale timer callbacks", () => {
		const clock = new TestClock();
		const owner = createOwner();
		const coordinator = new SubagentCheckInCoordinator("owner", () => owner.session, clock);
		for (let i = 0; i < 8; i++) coordinator.arm(`r${i}`, 120_000, () => child(`r${i}`));
		coordinator.terminal("r0");
		clock.advance(120_000);
		expect(owner.notices).toHaveLength(1);
		expect(owner.notices[0].children.map((item) => item.runId)).toEqual(
			Array.from({ length: 7 }, (_, i) => `r${i + 1}`),
		);
		coordinator.terminal("r1");
		owner.consume();
		expect(coordinator.getState("r1")).toBeUndefined();
		expect(clock.pendingTimers).toBe(6);
		coordinator.dispose();
		expect(clock.pendingTimers).toBe(0);
		expect(owner.listenerCount).toBe(0);
	});

	it("ignores stale timer callbacks and a child completing during snapshot construction", () => {
		const clock = new TestClock();
		const owner = createOwner();
		const coordinator = new SubagentCheckInCoordinator("owner", () => owner.session, clock);
		coordinator.arm("r", 120_000, () => child("r"));
		const oldCallback = clock.firstTimerCallback;
		coordinator.terminal("r");
		coordinator.arm("r", 120_000, () => {
			coordinator.terminal("r");
			return child("r");
		});
		oldCallback?.();
		clock.flush();
		expect(coordinator.getState("r")?.sequence).toBe(0);
		clock.advance(120_000);
		expect(owner.notices).toHaveLength(0);
		expect(coordinator.getState("r")).toBeUndefined();
		coordinator.dispose();
	});

	it("suppresses a due notice when the current runtime snapshot is terminal", () => {
		const clock = new TestClock();
		const owner = createOwner();
		const coordinator = new SubagentCheckInCoordinator("owner", () => owner.session, clock);
		coordinator.arm("r", 120_000, () => ({ ...child("r"), terminal: true }));
		clock.advance(120_000);
		expect(owner.notices).toHaveLength(0);
		expect(coordinator.getState("r")).toBeUndefined();
		coordinator.dispose();
	});

	it("does not acknowledge a new generation when an old notice settles", () => {
		const clock = new TestClock();
		const owner = createOwner();
		const coordinator = new SubagentCheckInCoordinator("owner", () => owner.session, clock);
		coordinator.arm("r", 120_000, () => child("r"));
		clock.advance(120_000);
		coordinator.terminal("r");
		coordinator.arm("r", 120_000, () => child("r"));
		owner.consume();
		expect(coordinator.getState("r")).toMatchObject({ sequence: 0, nextDueAt: clock.now() + 120_000 });
		clock.advance(120_000);
		expect(owner.notices).toHaveLength(2);
		expect(owner.notices[1].children[0].sequence).toBe(1);
		coordinator.dispose();
	});

	it("keeps one owner-only overdue marker and delivers a current snapshot when the owner returns", () => {
		const clock = new TestClock();
		const wrongOwner = createOwner("other");
		const owner = createOwner();
		let available: AgentSession | undefined = wrongOwner.session;
		let phase = "working";
		const coordinator = new SubagentCheckInCoordinator("owner", () => available, clock);
		coordinator.arm("r", 120_000, () => ({ ...child("r"), phase }));
		clock.advance(120_000);
		expect(coordinator.getState("r")?.delivery).toBe("owner_unavailable");
		clock.advance(360_000);
		expect(wrongOwner.notices).toHaveLength(0);
		phase = "finalization";
		available = owner.session;
		coordinator.flushPending();
		clock.flush();
		expect(owner.notices).toHaveLength(1);
		expect(owner.notices[0].children[0]).toMatchObject({ phase: "finalization", overdueMs: 360_000 });
		coordinator.dispose();
	});

	it("suppresses an overdue check-in after terminal completion while the owner is absent", () => {
		const clock = new TestClock();
		const owner = createOwner();
		let available: AgentSession | undefined;
		const coordinator = new SubagentCheckInCoordinator("owner", () => available, clock);
		coordinator.arm("r", 120_000, () => child("r"));
		clock.advance(120_000);
		expect(coordinator.getState("r")?.delivery).toBe("owner_unavailable");
		coordinator.terminal("r");
		available = owner.session;
		coordinator.flushPending();
		clock.flush();
		expect(owner.notices).toHaveLength(0);
		expect(coordinator.getState("r")).toBeUndefined();
		expect(clock.pendingTimers).toBe(0);
		coordinator.dispose();
	});

	it("does not acknowledge an old parent session after its owner session is replaced", () => {
		const clock = new TestClock();
		const oldOwner = createOwner();
		const newOwner = createOwner();
		let session = oldOwner.session;
		const coordinator = new SubagentCheckInCoordinator("owner", () => session, clock);
		coordinator.arm("r", 120_000, () => child("r"));
		clock.advance(120_000);
		session = newOwner.session;
		coordinator.flushPending();
		clock.flush();
		expect(oldOwner.listenerCount).toBe(0);
		expect(newOwner.notices).toHaveLength(1);
		oldOwner.consume();
		expect(coordinator.getState("r")?.lastAcknowledgedAt).toBeUndefined();
		newOwner.consume();
		expect(coordinator.getState("r")?.lastAcknowledgedAt).toBe(clock.now());
		coordinator.dispose();
	});

	it("redacts and caps untrusted child observations", () => {
		const clock = new TestClock();
		const owner = createOwner();
		const coordinator = new SubagentCheckInCoordinator("owner", () => owner.session, clock);
		coordinator.arm("r", 120_000, () => ({
			...child("r"),
			role: `Bearer super-secret ${"x".repeat(1000)}`,
			phase: `api_key=abcdef ${"y".repeat(1000)}`,
			currentPath: `token=path-secret ${"z".repeat(1000)}`,
			recentActivities: [`Bearer activity-secret ${"a".repeat(1000)}`],
		}));
		clock.advance(120_000);
		const observation = JSON.stringify(owner.notices[0]);
		expect(observation).not.toContain("super-secret");
		expect(observation).not.toContain("abcdef");
		expect(observation).not.toContain("path-secret");
		expect(observation).not.toContain("activity-secret");
		expect(observation.length).toBeLessThan(2000);
		coordinator.dispose();
	});

	it("leaves a failed parent review pending without scheduling a hot-loop retry", () => {
		const clock = new TestClock();
		const owner = createOwner();
		const coordinator = new SubagentCheckInCoordinator("owner", () => owner.session, clock);
		coordinator.arm("r", 120_000, () => child("r"));
		clock.advance(120_000);
		owner.consume(true);
		expect(coordinator.getState("r")?.delivery).toBe("due");
		clock.advance(240_000);
		coordinator.flushPending();
		clock.flush();
		expect(owner.notices).toHaveLength(1);
		coordinator.ownerOpportunity();
		clock.flush();
		expect(owner.notices).toHaveLength(2);
		coordinator.dispose();
	});
});
