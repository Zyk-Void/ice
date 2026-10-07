import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { buildChildRuntimeContract } from "../src/subagents/contract/serialize.ts";
import {
	buildRecoveryNotice,
	createChildSession,
	findInterruptedToolCalls,
	openChildSession,
} from "../src/subagents/registry/child-sessions.ts";
import {
	type ChildRecord,
	ChildRegistry,
	type ParentJournal,
	type ResidentChild,
} from "../src/subagents/registry/registry.ts";
import { buildSubagentTaskContract } from "../src/subagents/results/task-contract.ts";
import { ChildBudgetTracker } from "../src/subagents/runtime/budgets.ts";

const ID = `ag_${"a".repeat(26)}`;
const ID2 = `ag_${"b".repeat(26)}`;

class MemoryJournal implements ParentJournal {
	readonly log: Array<{ customType: string; data: unknown }> = [];
	readonly ops: string[] = [];
	durable = 0;
	failFlush = false;
	append(customType: string, data: unknown): void {
		this.log.push({ customType, data: structuredClone(data) });
		this.ops.push(`append:${customType}:${(data as { state?: string }).state ?? ""}`);
	}
	flush(): void {
		if (this.failFlush) throw new Error("disk full");
		this.durable = this.log.length;
		this.ops.push("flush");
	}
	entries() {
		return this.log;
	}
	/** Simulate a crash: only durably flushed entries survive. */
	crash(): MemoryJournal {
		const next = new MemoryJournal();
		next.log.push(...this.log.slice(0, this.durable));
		next.durable = next.log.length;
		return next;
	}
}

const accept = (registry: ChildRegistry, id = ID, owner = "s1"): ChildRecord =>
	registry.accept({
		id,
		ownerSessionId: owner,
		rootSessionId: owner,
		depth: 0,
		agent: "explore",
		description: "map auth",
		contractHash: "h",
		transcriptPath: `/t/${id}.jsonl`,
	});

function resident(log: string[] = []): ResidentChild & { disposed: boolean } {
	const handle = {
		disposed: false,
		dispose: async () => {
			handle.disposed = true;
			log.push("dispose");
		},
	};
	return handle;
}

/** Drive a freshly accepted child to idle with a resident session. */
function toIdle(registry: ChildRegistry, id = ID): ChildRecord {
	const running = registry.transition("s1", id, registry.get("s1", id).generation, "running");
	const idle = registry.transition("s1", id, running.generation, "idle", {
		turnInFlight: false,
		lastTurnOutcome: "completed",
	});
	registry.attach("s1", id, resident());
	return idle;
}

describe("subagent V2 child registry", () => {
	it("persists acceptance durably and refuses to accept when the flush fails", () => {
		const journal = new MemoryJournal();
		const registry = new ChildRegistry(journal);
		expect(accept(registry)).toMatchObject({ state: "starting", generation: 1, turnInFlight: true });
		expect(journal.ops).toEqual(["append:ice-subagent-v2-child:starting", "flush"]);
		journal.failFlush = true;
		expect(() => accept(registry, ID2)).toThrow("disk full");
		expect(() => registry.get("s1", ID2)).toThrow(/Unknown child/);
	});

	it("rejects illegal transitions, stale generations, and other owners", () => {
		const registry = new ChildRegistry(new MemoryJournal());
		const record = accept(registry);
		expect(() => registry.transition("s1", ID, record.generation, "deleted")).toThrow(/cannot go from starting/);
		const running = registry.transition("s1", ID, record.generation, "running");
		expect(() => registry.transition("s1", ID, record.generation, "idle")).toThrow(/changed since generation/);
		expect(() => registry.get("s2", ID)).toThrow(/Unknown child/);
		expect(registry.list("s2")).toEqual([]);
		expect(running.generation).toBe(2);
	});

	it("detaches before dispose when parking so no caller sees a disposing session", async () => {
		const registry = new ChildRegistry(new MemoryJournal());
		accept(registry);
		toIdle(registry);
		let seenDuringDispose: unknown = "unset";
		registry.attach("s1", ID, {
			dispose: async () => {
				seenDuringDispose = registry.resident("s1", ID);
			},
		});
		const parked = await registry.park("s1", ID);
		expect(parked.state).toBe("parked");
		expect(seenDuringDispose).toBeUndefined();
	});

	it("coalesces concurrent revivals and blocks without a handle when authority was revoked", async () => {
		const registry = new ChildRegistry(new MemoryJournal());
		accept(registry);
		toIdle(registry);
		await registry.park("s1", ID);
		let calls = 0;
		const blocked = async () => {
			calls++;
			await Promise.resolve();
			return { blocked: ['tool "edit" is no longer active in the parent'] };
		};
		const [first, second] = await Promise.all([
			registry.revive("s1", ID, blocked),
			registry.revive("s1", ID, blocked),
		]);
		expect(calls).toBe(1);
		expect(first).toBeUndefined();
		expect(second).toBeUndefined();
		expect(registry.get("s1", ID)).toMatchObject({
			state: "blocked",
			blockedReasons: ['tool "edit" is no longer active in the parent'],
		});
		const handle = resident();
		await expect(registry.revive("s1", ID, async () => ({ handle }))).resolves.toBe(handle);
		expect(registry.get("s1", ID)).toMatchObject({ state: "idle" });
		expect(registry.get("s1", ID).blockedReasons).toBeUndefined();
	});

	it("requires a stopped child before delete and tombstones durably before cleanup", async () => {
		const journal = new MemoryJournal();
		const registry = new ChildRegistry(journal);
		accept(registry);
		registry.transition("s1", ID, 1, "running");
		await expect(registry.delete("s1", ID)).rejects.toThrow(/Stop child/);
		registry.transition("s1", ID, 2, "idle", { turnInFlight: false });
		const order: string[] = [];
		registry.attach("s1", ID, resident(order));
		journal.ops.length = 0;
		await registry.delete("s1", ID, async () => {
			order.push(`cleanup after ${journal.ops.join(",")}`);
		});
		expect(order).toEqual(["dispose", "cleanup after append:ice-subagent-v2-child:deleted,flush"]);
		const restored = new ChildRegistry(journal.crash());
		restored.restore();
		expect(restored.list("s1")).toEqual([]);
	});

	it("restores after a crash: in-flight turns become interrupted, idle children park", () => {
		const journal = new MemoryJournal();
		const registry = new ChildRegistry(journal);
		accept(registry);
		registry.transition("s1", ID, 1, "running", {}, true);
		accept(registry, ID2);
		const running2 = registry.transition("s1", ID2, 1, "running");
		registry.transition("s1", ID2, running2.generation, "idle", { turnInFlight: false }, true);
		const restored = new ChildRegistry(journal.crash());
		const recovered = restored.restore();
		expect(recovered.map((record) => [record.id, record.state, record.lastTurnOutcome])).toEqual([
			[ID, "parked", "interrupted"],
			[ID2, "parked", undefined],
		]);
		expect(restored.get("s1", ID).turnInFlight).toBe(false);
	});

	it("delivers each completion at most once across restarts", () => {
		const journal = new MemoryJournal();
		const registry = new ChildRegistry(journal);
		accept(registry);
		const completion = {
			deliveryId: "d1",
			childId: ID,
			ownerSessionId: "s1",
			agent: "explore",
			outcome: "completed" as const,
			summary: "Found the token check in auth.ts:42.",
			at: 1,
		};
		registry.recordCompletion(completion);
		registry.recordCompletion(completion);
		expect(registry.pendingCompletions("s1")).toHaveLength(1);
		expect(registry.pendingCompletions("s2")).toEqual([]);
		// Crash before delivery: still pending afterwards.
		const beforeDelivery = new ChildRegistry(journal.crash());
		beforeDelivery.restore();
		expect(beforeDelivery.pendingCompletions("s1").map((entry) => entry.deliveryId)).toEqual(["d1"]);
		expect(registry.claimDelivery("s1", "d1")).toMatchObject({ deliveryId: "d1" });
		expect(registry.claimDelivery("s1", "d1")).toBeUndefined();
		const afterDelivery = new ChildRegistry(journal.crash());
		afterDelivery.restore();
		expect(afterDelivery.pendingCompletions("s1")).toEqual([]);
		expect(afterDelivery.claimDelivery("s1", "d1")).toBeUndefined();
	});

	it("waits on transitions without polling and honors the timeout", async () => {
		const registry = new ChildRegistry(new MemoryJournal());
		accept(registry);
		const waiting = registry.waitFor("s1", [ID], (record) => record.state === "idle", 10_000);
		const running = registry.transition("s1", ID, 1, "running");
		registry.transition("s1", ID, running.generation, "idle", { turnInFlight: false });
		await expect(waiting).resolves.toMatchObject({ timedOut: false, records: [{ state: "idle" }] });
		await expect(registry.waitFor("s1", [ID], (record) => record.state === "parked", 5)).resolves.toMatchObject({
			timedOut: true,
		});
		await expect(registry.waitFor("s1", [ID], (record) => record.state === "idle", 5)).resolves.toMatchObject({
			timedOut: false,
		});
	});
});

describe("subagent V2 child session files", () => {
	const temps: string[] = [];
	afterEach(() => {
		for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("writes the contract durably under the parent session and verifies it on reopen", () => {
		const dir = mkdtempSync(join(tmpdir(), "ice-v2-child-"));
		temps.push(dir);
		const contract = buildChildRuntimeContract({
			id: ID,
			ownerSessionId: "parent-1",
			rootSessionId: "parent-1",
			depth: 0,
			agent: { name: "explore", source: "builtin", sourceHash: "h", resolvedDefinitionHash: "r" },
			prompt: { system: "Explore.", contextFiles: false, resourceHashes: [] },
			model: { provider: "cx", model: "gpt-6-luna", thinking: "medium" },
			capabilities: {
				tools: [{ name: "read", access: "read-only" }],
				permissionRules: [],
				scopeRoots: ["."],
				mcpServers: [],
				spawns: [],
				maxDepth: 0,
				subYolo: false,
				agentMode: "plan",
				parentMode: "build",
				worktree: false,
			},
			result: { acceptance: [], taskContract: buildSubagentTaskContract("Map auth.") },
			budgets: { startupTimeoutMs: 1000 },
			isolation: { mode: "none" },
		});
		const created = createChildSession({ parentSessionDir: dir, parentSessionId: "parent-1", contract, cwd: dir });
		expect(created.transcriptPath.startsWith(join(dir, "subagents", "parent-1"))).toBe(true);
		const reopened = openChildSession(created.transcriptPath, created.contractHash);
		expect(reopened.contract).toEqual(contract);
		expect(reopened.sessionManager.getSessionId()).toBe(ID);
		expect(() => openChildSession(created.transcriptPath, "0".repeat(64))).toThrow(/does not match the registry/);
	});

	it("finds tool calls cut off by a crash and never suggests replaying them", () => {
		const entry = (message: unknown, id: string): SessionEntry =>
			({ type: "message", id, parentId: null, timestamp: "t", message }) as SessionEntry;
		const entries = [
			entry({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash" }] }, "1"),
			entry({ role: "toolResult", toolCallId: "c1" }, "2"),
			entry(
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "c2", name: "edit" },
						{ type: "toolCall", id: "c3", name: "bash" },
					],
				},
				"3",
			),
			entry({ role: "toolResult", toolCallId: "c2" }, "4"),
		];
		const interrupted = findInterruptedToolCalls(entries);
		expect(interrupted).toEqual([{ id: "c3", name: "bash" }]);
		expect(buildRecoveryNotice(interrupted)).toMatch(/not replayed: bash \(c3\)/);
	});
});

describe("subagent V2 child budgets", () => {
	it("is unlimited by default and exhausts on the first limit reached", () => {
		let now = 0;
		expect(new ChildBudgetTracker({}, () => now).check()).toEqual({ status: "ok" });
		const tracker = new ChildBudgetTracker({ maxTurns: 2, maxTokens: 1000, timeoutMs: 50 }, () => now);
		tracker.recordTurn(100, 50);
		expect(tracker.check().status).toBe("ok");
		expect(tracker.claimWrapUp()).toBe(false);
		tracker.recordTurn(100, 50);
		expect(tracker.check()).toEqual({ status: "exhausted", limit: "maxTurns", used: 2, max: 2 });
		expect(tracker.claimWrapUp()).toBe(true);
		expect(tracker.claimWrapUp()).toBe(false);
		const timed = new ChildBudgetTracker({ timeoutMs: 50 }, () => now);
		now = 60;
		expect(timed.check()).toMatchObject({ status: "exhausted", limit: "timeoutMs" });
	});
});
