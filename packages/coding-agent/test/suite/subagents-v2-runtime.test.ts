import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { worktreeSnapshotRef } from "../../src/subagents/isolation/worktree.ts";
import { CHILD_INIT_ENTRY_TYPE } from "../../src/subagents/registry/child-sessions.ts";
import { CHILD_RECORD_ENTRY_TYPE } from "../../src/subagents/registry/registry.ts";
import { type IceSubagentMcpAdapter, subagentMcpToolName } from "../../src/subagents/types.ts";
import iceSubagentsV2 from "../../src/subagents/v2/extension.ts";
import { MAX_RESIDENT_CHILDREN, RETIRE_GRACE_MS, SubagentV2Runtime } from "../../src/subagents/v2/runtime.ts";
import { type ChildTurnResult, mcpDelegableTools, type V2RuntimeHost } from "../../src/subagents/v2/runtime-support.ts";
import { createV2ChildSession } from "../../src/subagents/v2/session-factory.ts";
import { resolveSubagentsV2Settings } from "../../src/subagents/v2/settings.ts";
import { CHILD_WRAP_UP_LIMITS } from "../../src/subagents/v2/turn-budget.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

interface Parent {
	session: AgentSession;
	sent: Array<{ customType: string; content: unknown }>;
	tools: string[];
}

async function setup(options: { tools?: string[]; parentFile?: string; repository?: boolean } = {}) {
	const harness = await createHarness();
	harnesses.push(harness);
	const cwd = options.repository ? join(harness.tempDir, "repo") : harness.tempDir;
	if (options.repository) {
		mkdirSync(cwd);
		execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(cwd, "a.txt"), "base\n");
		execFileSync("git", ["add", "a.txt"], { cwd });
		execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "init"], {
			cwd,
		});
		writeFileSync(join(cwd, "a.txt"), "parent wip\n");
	}
	const sessionManager = options.parentFile
		? SessionManager.open(options.parentFile)
		: SessionManager.create(cwd, join(harness.tempDir, "sessions"));
	const parent: Parent = {
		sent: [],
		tools: options.tools ?? ["read", "grep", "find", "ls", "bash", "edit", "write", "agent_patch"],
		session: undefined as unknown as AgentSession,
	};
	parent.session = {
		sessionId: sessionManager.getSessionId(),
		sessionManager,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		getActiveToolNames: () => parent.tools,
		sendCustomMessage: vi.fn(async (message: { customType: string; content: unknown }) => {
			parent.sent.push(message);
		}),
	} as unknown as AgentSession;
	const host = (overrides: Partial<V2RuntimeHost> = {}): V2RuntimeHost => ({
		getParentSession: () => parent.session,
		agentDir: join(harness.tempDir, "agent"),
		userAgentsDir: join(harness.tempDir, "agents"),
		getSettings: () => resolveSubagentsV2Settings({ projectTrusted: false }),
		isProjectTrusted: () => options.repository === true,
		getParentMode: () => "build",
		isSubYolo: () => false,
		getAdapters: () => [],
		...overrides,
	});
	return { harness, parent, sessionManager, host };
}

function transcriptOf(runtime: SubagentV2Runtime, childId: string): string {
	return readFileSync(runtime.registry.get(runtime.ownerSessionId(), childId).transcriptPath, "utf8");
}

const task = (agent: string, prompt: string) => ({ agent, description: `${agent} task`, prompt });
/** A request that still wants tools, so a budget reached here stops work instead of completing it. */
const unfinished = () => fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }), { stopReason: "toolUse" });

async function runOne(
	runtime: SubagentV2Runtime,
	agent: string,
	prompt: string,
	background = false,
): Promise<ChildTurnResult & { childId: string }> {
	const [record] = await runtime.launch([task(agent, prompt)]);
	const result = await runtime.runTurn(record!.id, prompt, { foreground: !background, background });
	return { ...result, childId: record!.id };
}

describe("subagent V2 runtime", () => {
	it("persists each child's turn usage once in its parent journal", async () => {
		const { harness, sessionManager, host } = await setup();
		harness.setResponses([fauxAssistantMessage("report"), fauxAssistantMessage("second report")]);
		const runtime = new SubagentV2Runtime(host());
		try {
			const result = await runOne(runtime, "explore", "report", true);
			const second = await runtime.continueChild(result.childId, "again", { foreground: true });
			runtime.flushCompletions();
			const restored = SessionManager.open(sessionManager.getSessionFile()!);
			const entries = restored
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "subagent_usage");
			expect(entries).toHaveLength(2);
			for (const [index, turn] of [result, second].entries()) {
				expect(turn.usage.inputTokens + turn.usage.outputTokens).toBeGreaterThan(0);
				expect(entries[index]).toMatchObject({
					data: {
						childId: result.childId,
						agent: "explore",
						usage: {
							input: turn.usage.inputTokens,
							output: turn.usage.outputTokens,
							cacheRead: turn.usage.cacheReadTokens,
							cacheWrite: turn.usage.cacheWriteTokens,
							cost: turn.usage.cost,
						},
					},
				});
			}
			// Billing must be journaled before the durable record that settles its turn.
			const all = restored.getEntries();
			for (const [index, usage] of entries.entries()) {
				const settled = all.findIndex(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === CHILD_RECORD_ENTRY_TYPE &&
						(entry.data as { usage: { turns: number } }).usage.turns === index + 1,
				);
				expect(all.indexOf(usage)).toBeLessThan(settled);
			}
		} finally {
			await runtime.shutdown();
		}
	});

	it("skips parent billing entries for zero-usage turns", async () => {
		const { harness, sessionManager, host } = await setup();
		const runtime = new SubagentV2Runtime(host());
		try {
			const [record] = await runtime.launch([task("explore", "report")]);
			const result = await runtime.runTurn(record!.id, "report", { foreground: true, signal: AbortSignal.abort() });
			expect(result.usage).toEqual({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cost: 0,
			});
			expect(harness.faux.state.callCount).toBe(0);
			expect(
				sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "subagent_usage"),
			).toEqual([]);
		} finally {
			await runtime.shutdown();
		}
	});
	it("runs a foreground child under its frozen contract and records it durably", async () => {
		const { harness, sessionManager, host } = await setup();
		writeFileSync(join(harness.tempDir, "notes.txt"), "token check lives in auth.ts:42\n");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("The token check is in auth.ts:42."),
		]);
		const runtime = new SubagentV2Runtime(host());
		const result = await runOne(runtime, "explore", "Where is the token check?");
		expect(result).toMatchObject({
			outcome: "completed",
			text: "The token check is in auth.ts:42.",
			agent: "explore",
		});
		const record = runtime.registry.get(sessionManager.getSessionId(), result.childId);
		expect(record).toMatchObject({ state: "idle", lastTurnOutcome: "completed", usage: { turns: 1 } });
		const transcript = readFileSync(record.transcriptPath, "utf8");
		expect(transcript).toContain(CHILD_INIT_ENTRY_TYPE);
		expect(transcript).toContain("auth.ts:42");
		expect(
			record.transcriptPath.startsWith(
				join(harness.tempDir, "sessions", "subagents", sessionManager.getSessionId()),
			),
		).toBe(true);
	});

	it.each(["maxTurns", "maxTokens", "cacheTokens"])("enforces %s before tools and bounds wrap-up", async (kind) => {
		const { harness, host, sessionManager, parent } = await setup();
		const ordinary = fauxAssistantMessage(fauxToolCall("write", { path: "budget.txt", content: "forbidden" }), {
			stopReason: "toolUse",
		});
		ordinary.usage = {
			...ordinary.usage,
			input: 5,
			output: 5,
			cacheRead: kind === "cacheTokens" ? 20 : 0,
			cacheWrite: 0,
		};
		const wrap = vi.fn((context, options) => {
			expect(context.tools).toEqual([]);
			expect(options.maxTokens).toBeLessThanOrEqual(CHILD_WRAP_UP_LIMITS.maxTokens);
			return fauxAssistantMessage("Budget reached; no file written.");
		});
		harness.setResponses([ordinary, wrap, fauxAssistantMessage("must not run")]);
		const runtime = new SubagentV2Runtime(host({ isSubYolo: () => true }));
		const limits = kind === "maxTurns" ? { maxTurns: 1 } : { maxTokens: kind === "cacheTokens" ? 20 : 10 };
		const [record] = await runtime.launch([{ ...task("general", "write"), ...limits }]);
		const result = await runtime.runTurn(record!.id, "write", { foreground: true, background: true });
		expect(result).toMatchObject({ outcome: "budget_exhausted", text: "Budget reached; no file written." });
		expect(existsSync(join(harness.tempDir, "budget.txt"))).toBe(false);
		expect(wrap).toHaveBeenCalledOnce();
		expect(result.usage.cacheReadTokens).toBeGreaterThanOrEqual(kind === "cacheTokens" ? 20 : 0);
		expect(runtime.registry.get(sessionManager.getSessionId(), record!.id).usage.cacheReadTokens).toBe(
			result.usage.cacheReadTokens,
		);
		expect(parent.sent).toHaveLength(1);
		expect(parent.sent[0]!.content).toContain("budget_exhausted");
		runtime.flushCompletions();
		expect(parent.sent).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(runtime.registry.get(sessionManager.getSessionId(), record!.id).lastTurnOutcome).toBe("budget_exhausted");
		await expect(runtime.continueChild(record!.id, "again", { foreground: true })).rejects.toThrow(
			/explicit permitted budget/,
		);
		await runtime.shutdown();
	});

	it("completes a task that finishes on its last allowed request and keeps the frozen ceiling", async () => {
		const { harness, host } = await setup();
		writeFileSync(join(harness.tempDir, "read.txt"), "data");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "read.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("ordinary report"),
		]);
		const runtime = new SubagentV2Runtime(host());
		const [record] = await runtime.launch([{ ...task("explore", "read"), maxTurns: 2 }]);
		// The final answer arrives on the last allowed request: the task completed within budget.
		expect(await runtime.runTurn(record!.id, "read", { foreground: true })).toMatchObject({
			outcome: "completed",
			text: "ordinary report",
		});
		expect(transcriptOf(runtime, record!.id)).toContain("data");
		await runtime.registry.park(runtime.ownerSessionId(), record!.id);
		await expect(
			runtime.continueChild(record!.id, "again", { foreground: true, budgets: { maxTurns: 3 } }),
		).rejects.toThrow(/frozen ceiling/);
		harness.setResponses([fauxAssistantMessage("renewed")]);
		expect(
			await runtime.continueChild(record!.id, "again", { foreground: true, budgets: { maxTurns: 2 } }),
		).toMatchObject({ outcome: "completed", text: "renewed" });
		await runtime.shutdown();
	});

	it("times out an in-flight request and makes one bounded tool-free wrap-up", async () => {
		const { harness, host } = await setup();
		const waiting = vi.fn(async (_context, options) => {
			await new Promise<void>((resolve) =>
				options!.signal!.addEventListener("abort", () => resolve(), { once: true }),
			);
			return fauxAssistantMessage("", { stopReason: "aborted" });
		});
		harness.setResponses([waiting, fauxAssistantMessage("timed out")]);
		const runtime = new SubagentV2Runtime(host());
		const [record] = await runtime.launch([{ ...task("explore", "wait"), timeoutMs: 25 }]);
		expect(await runtime.runTurn(record!.id, "wait", { foreground: true })).toMatchObject({
			outcome: "budget_exhausted",
			text: "timed out",
		});
		expect(waiting).toHaveBeenCalledOnce();
		await runtime.shutdown();
	});

	it("never dispatches a tool after budget expiry during approval", async () => {
		const { harness, host } = await setup();
		let now = 0;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "late.txt", content: "no" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("time exhausted"),
		]);
		const runtime = new SubagentV2Runtime(
			host({
				now: () => now,
				promptApproval: async () => {
					now = 2000;
					return "allow-once";
				},
			}),
		);
		const [record] = await runtime.launch([{ ...task("general", "write"), timeoutMs: 1000 }]);
		expect(await runtime.runTurn(record!.id, "write", { foreground: true })).toMatchObject({
			outcome: "budget_exhausted",
		});
		expect(existsSync(join(harness.tempDir, "late.txt"))).toBe(false);
		await runtime.shutdown();
	});

	it("does not execute hallucinated wrap-up tools or make another request", async () => {
		const { harness, host } = await setup();
		harness.setResponses([
			unfinished(),
			fauxAssistantMessage(fauxToolCall("write", { path: "wrap.txt", content: "no" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const runtime = new SubagentV2Runtime(host({ isSubYolo: () => true }));
		const [record] = await runtime.launch([{ ...task("general", "write"), maxTurns: 1 }]);
		expect(await runtime.runTurn(record!.id, "write", { foreground: true })).toMatchObject({
			outcome: "budget_exhausted",
		});
		expect(existsSync(join(harness.tempDir, "wrap.txt"))).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
		await runtime.shutdown();
	});

	it("lets explicit cancellation win and never starts wrap-up after stop", async () => {
		const { harness, host } = await setup();
		const waiting = vi.fn(async (_context, options) => {
			await new Promise<void>((resolve) =>
				options!.signal!.addEventListener("abort", () => resolve(), { once: true }),
			);
			return fauxAssistantMessage("", { stopReason: "aborted" });
		});
		harness.setResponses([waiting, fauxAssistantMessage("must not run")]);
		const runtime = new SubagentV2Runtime(host());
		const [record] = await runtime.launch([{ ...task("explore", "wait"), maxTurns: 1 }]);
		const running = runtime.runTurn(record!.id, "wait", { foreground: true });
		await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce());
		await runtime.stop(record!.id);
		expect(await running).toMatchObject({ outcome: "cancelled" });
		expect(harness.getPendingResponseCount()).toBe(1);
		await runtime.shutdown();
	});

	it("projects capacity, queue, and per-child run state in the overview", async () => {
		const { harness, host } = await setup();
		const settings = resolveSubagentsV2Settings({
			global: { maxConcurrent: 1, maxDepth: 2 },
			projectTrusted: false,
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waiting = vi.fn(async () => {
			await gate;
			return fauxAssistantMessage("first");
		});
		// The first child reads a file (one finished model response), then waits mid-turn.
		harness.setResponses([unfinished(), waiting, fauxAssistantMessage("second")]);
		let activity = 0;
		const runtime = new SubagentV2Runtime(host({ getSettings: () => settings, onChildActivity: () => activity++ }));
		expect(runtime.overview()).toMatchObject({
			enabled: true,
			capacity: { running: 0, queued: 0, max: 1 },
			maxDepth: 2,
			children: [],
			approvals: [],
		});
		const [first, second] = await runtime.launch([task("explore", "first"), task("explore", "second")]);
		const running = runtime.runTurn(first!.id, "first", { foreground: true });
		await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce());
		const queued = runtime.runTurn(second!.id, "second", { foreground: false, background: true });
		await vi.waitFor(() => expect(runtime.overview().capacity).toEqual({ running: 1, queued: 1, max: 1 }));
		const children = new Map(runtime.overview().children.map((child) => [child.id, child]));
		expect(children.get(first!.id)).toMatchObject({
			state: "running",
			running: true,
			background: false,
			resident: true,
			depth: 0,
			turns: 0,
		});
		// Usage of the turn in progress is visible before the turn ends.
		expect(children.get(first!.id)!.tokens).toBeGreaterThan(0);
		expect(activity).toBeGreaterThan(0);
		expect(runtime.describeChild(first!.id).join("\n")).toContain("0 turns + 1 running");
		expect(children.get(second!.id)).toMatchObject({ state: "queued", running: true, background: true });
		release();
		const firstResult = await running;
		await queued;
		expect(runtime.overview().capacity).toEqual({ running: 0, queued: 0, max: 1 });
		expect(runtime.overview().children.every((child) => !child.running)).toBe(true);
		// After the turn the live count moves into the record exactly once.
		const settled = runtime.overview().children.find((child) => child.id === first!.id)!;
		expect(settled).toMatchObject({ state: "idle", turns: 1 });
		expect(settled.tokens).toBe(firstResult.usage.inputTokens + firstResult.usage.outputTokens);
		await runtime.shutdown();
	});

	it("addresses children by unique names that survive a restart", async () => {
		const { harness, host, parent, sessionManager } = await setup();
		const runtime = new SubagentV2Runtime(host());
		const [named] = await runtime.launch([{ ...task("explore", "read"), name: "auth-review" }]);
		expect(runtime.resolveChildRef("auth-review")).toBe(named!.id);
		expect(runtime.resolveChildRef(named!.id)).toBe(named!.id);
		expect(runtime.overview().children[0]).toMatchObject({ name: "auth-review" });
		// A duplicate name fails the whole batch before anything is accepted.
		await expect(
			runtime.launch([
				{ ...task("explore", "other"), name: "fresh" },
				{ ...task("explore", "again"), name: "auth-review" },
			]),
		).rejects.toThrow(/already used/);
		await expect(
			runtime.launch([
				{ ...task("explore", "a"), name: "twin" },
				{ ...task("explore", "b"), name: "twin" },
			]),
		).rejects.toThrow(/already used/);
		expect(runtime.registry.list(runtime.ownerSessionId())).toHaveLength(1);
		expect(() => runtime.resolveChildRef("missing")).toThrow(/Names in this session: auth-review/);
		harness.setResponses([fauxAssistantMessage("named report")]);
		await runtime.runTurn(named!.id, "read", { foreground: true });
		await runtime.shutdown();
		parent.session = {
			...parent.session,
			sessionManager: SessionManager.open(sessionManager.getSessionFile()!),
		} as AgentSession;
		const restored = new SubagentV2Runtime(host());
		expect(restored.resolveChildRef("auth-review")).toBe(named!.id);
		await restored.shutdown();
	});

	it("retires a settled child after the grace period unless it is busy or displayed", async () => {
		const { harness, host } = await setup();
		let displayed: string | undefined;
		const runtime = new SubagentV2Runtime(host({ isDisplayed: (id) => id === displayed }));
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
			const done = await runOne(runtime, "explore", "first");
			const kept = await runOne(runtime, "explore", "second");
			const owner = runtime.ownerSessionId();
			displayed = kept.childId;
			await vi.advanceTimersByTimeAsync(RETIRE_GRACE_MS - 1);
			expect(runtime.registry.get(owner, done.childId).state).toBe("idle");
			await vi.advanceTimersByTimeAsync(1);
			expect(runtime.registry.get(owner, done.childId).state).toBe("parked");
			expect(runtime.registry.resident(owner, done.childId)).toBeUndefined();
			// The displayed child stays resident and is checked again later.
			expect(runtime.registry.get(owner, kept.childId).state).toBe("idle");
			displayed = undefined;
			await vi.advanceTimersByTimeAsync(RETIRE_GRACE_MS);
			expect(runtime.registry.get(owner, kept.childId).state).toBe("parked");
			// A retired child resumes with its context on the next turn.
			harness.setResponses([fauxAssistantMessage("resumed")]);
			expect(await runtime.continueChild(done.childId, "again", { foreground: true })).toMatchObject({
				outcome: "completed",
				text: "resumed",
			});
		} finally {
			vi.useRealTimers();
			await runtime.shutdown();
		}
	});

	it("does not retire a child whose next turn started within the grace period", async () => {
		const { harness, host } = await setup();
		const runtime = new SubagentV2Runtime(host());
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			harness.setResponses([
				fauxAssistantMessage("first"),
				async () => {
					await gate;
					return fauxAssistantMessage("second");
				},
			]);
			const first = await runOne(runtime, "explore", "first");
			await vi.advanceTimersByTimeAsync(RETIRE_GRACE_MS / 2);
			const second = runtime.continueChild(first.childId, "next", { foreground: true });
			await vi.advanceTimersByTimeAsync(RETIRE_GRACE_MS);
			const owner = runtime.ownerSessionId();
			expect(runtime.registry.resident(owner, first.childId)?.running).toBeDefined();
			release();
			await second;
			expect(runtime.registry.get(owner, first.childId).state).toBe("idle");
		} finally {
			vi.useRealTimers();
			await runtime.shutdown();
		}
	});

	it("removes a child that was stopped before it ever ran", async () => {
		const { harness, host } = await setup();
		const settings = resolveSubagentsV2Settings({ global: { maxConcurrent: 1 }, projectTrusted: false });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waiting = vi.fn(async () => {
			await gate;
			return fauxAssistantMessage("first");
		});
		harness.setResponses([waiting]);
		const runtime = new SubagentV2Runtime(host({ getSettings: () => settings }));
		const [first, second] = await runtime.launch([task("explore", "first"), task("explore", "second")]);
		const running = runtime.runTurn(first!.id, "first", { foreground: true });
		await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce());
		const queued = runtime.runTurn(second!.id, "second", { foreground: true });
		await vi.waitFor(() => expect(runtime.overview().capacity.queued).toBe(1));
		await runtime.stop(second!.id);
		expect(await queued).toMatchObject({ outcome: "cancelled" });
		await vi.waitFor(() => expect(runtime.overview().children.map((child) => child.id)).toEqual([first!.id]));
		release();
		await running;
		await runtime.shutdown();
	});

	it("keeps an unbudgeted child unlimited and starts the timeout only after admission", async () => {
		const { harness, host } = await setup();
		const settings = resolveSubagentsV2Settings({ global: { maxConcurrent: 1 }, projectTrusted: false });
		let now = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waiting = vi.fn(async () => {
			await gate;
			return fauxAssistantMessage("first");
		});
		harness.setResponses([waiting, fauxAssistantMessage("second")]);
		const runtime = new SubagentV2Runtime(host({ getSettings: () => settings, now: () => now }));
		const [first, second] = await runtime.launch([
			task("explore", "first"),
			{ ...task("explore", "second"), timeoutMs: 100 },
		]);
		const running = runtime.runTurn(first!.id, "first", { foreground: true });
		await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce());
		const queued = runtime.runTurn(second!.id, "second", { foreground: true });
		now = 100_000;
		release();
		expect(await running).toMatchObject({ outcome: "completed" });
		expect(await queued).toMatchObject({ outcome: "completed" });
		await runtime.shutdown();
	});

	it("bounds stalled wrap-up and preserves exhaustion when its provider fails", async () => {
		const { harness, host } = await setup();
		const waiting = vi.fn(async (_context, options) => {
			await new Promise<void>((resolve) =>
				options!.signal!.addEventListener("abort", () => resolve(), { once: true }),
			);
			return fauxAssistantMessage("", { stopReason: "aborted" });
		});
		harness.setResponses([unfinished(), waiting, fauxAssistantMessage("must not run")]);
		const runtime = new SubagentV2Runtime(host());
		const [record] = await runtime.launch([{ ...task("explore", "finish"), maxTurns: 1 }]);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const running = runtime.runTurn(record!.id, "finish", { foreground: true });
			await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce());
			await vi.advanceTimersByTimeAsync(CHILD_WRAP_UP_LIMITS.timeoutMs);
			expect(await running).toMatchObject({
				outcome: "budget_exhausted",
				error: expect.stringMatching(/interrupted|aborted/i),
			});
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			vi.useRealTimers();
			await runtime.shutdown();
		}
		harness.setResponses([
			unfinished(),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 temporary error" }),
			fauxAssistantMessage("must not retry"),
		]);
		expect(
			await runtime.continueChild(record!.id, "finish", { foreground: true, budgets: { maxTurns: 1 } }),
		).toMatchObject({ outcome: "budget_exhausted", error: "503 temporary error" });
		expect(harness.getPendingResponseCount()).toBe(1);
		await runtime.shutdown();
	});

	it("persists exhaustion across restart and denies empty or invalid renewal before revival", async () => {
		const { harness, host, parent, sessionManager } = await setup();
		harness.setResponses([unfinished(), fauxAssistantMessage("wrap")]);
		const runtime = new SubagentV2Runtime(host());
		const [record] = await runtime.launch([{ ...task("explore", "finish"), maxTurns: 1 }]);
		await runtime.runTurn(record!.id, "finish", { foreground: true });
		await runtime.shutdown();
		parent.session = {
			...parent.session,
			sessionManager: SessionManager.open(sessionManager.getSessionFile()!),
		} as AgentSession;
		const factory = vi.fn(createV2ChildSession);
		const restored = new SubagentV2Runtime(host({ createChildAgentSession: factory }));
		await expect(restored.continueChild(record!.id, "again", { foreground: true, budgets: {} })).rejects.toThrow(
			/explicit permitted budget/,
		);
		await expect(
			restored.continueChild(record!.id, "again", { foreground: true, budgets: { maxTurns: 2 } }),
		).rejects.toThrow(/frozen ceiling/);
		expect(factory).not.toHaveBeenCalled();
		harness.setResponses([unfinished(), fauxAssistantMessage("wrap renewed")]);
		expect(
			await restored.continueChild(record!.id, "again", { foreground: true, budgets: { maxTurns: 1 } }),
		).toMatchObject({ outcome: "budget_exhausted", text: "wrap renewed" });
		expect(factory).toHaveBeenCalledOnce();
		await restored.shutdown();
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid budgets (%s) before acceptance",
		async (maxTurns) => {
			const { host } = await setup();
			const factory = vi.fn(createV2ChildSession);
			const runtime = new SubagentV2Runtime(host({ createChildAgentSession: factory }));
			await expect(runtime.launch([{ ...task("explore", "finish"), maxTurns }])).rejects.toThrow(
				/positive safe integer/,
			);
			expect(factory).not.toHaveBeenCalled();
			expect(runtime.registry.list(runtime.ownerSessionId())).toEqual([]);
			await runtime.shutdown();
		},
	);

	it.each(["timeout", "stop"])("releases a held approval on %s without a user response", async (reason) => {
		const { harness, host } = await setup();
		let approvalSignal: AbortSignal | undefined;
		const approval = vi.fn(async (_request, signal) => {
			approvalSignal = signal;
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return "deny" as const;
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "held.txt", content: "no" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("timeout wrap"),
		]);
		const runtime = new SubagentV2Runtime(host({ promptApproval: approval }));
		const [record] = await runtime.launch([
			{ ...task("general", "write"), ...(reason === "timeout" ? { timeoutMs: 100 } : {}) },
		]);
		const running = runtime.runTurn(record!.id, "write", { foreground: true });
		await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
		if (reason === "stop") await runtime.stop(record!.id);
		expect(await running).toMatchObject({ outcome: reason === "timeout" ? "budget_exhausted" : "cancelled" });
		expect(approvalSignal?.aborted).toBe(true);
		expect(existsSync(join(harness.tempDir, "held.txt"))).toBe(false);
		harness.setResponses([fauxAssistantMessage("next child")]);
		expect(await runOne(runtime, "explore", "read")).toMatchObject({ outcome: "completed" });
		await runtime.shutdown();
	});

	it.each(["ordinary", "wrap-up"])(
		"prevents a late provider request after cancellation during %s preflight",
		async (phase) => {
			const { harness, host } = await setup();
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let reached!: () => void;
			const atGate = new Promise<void>((resolve) => {
				reached = resolve;
			});
			const factory = async (options: Parameters<typeof createV2ChildSession>[0]) => {
				const session = await createV2ChildSession(options);
				const prompt = session.prompt.bind(session);
				let calls = 0;
				vi.spyOn(session, "prompt").mockImplementation(async (...args) => {
					calls++;
					if (calls === (phase === "ordinary" ? 1 : 2)) {
						reached();
						await gate;
					}
					return prompt(...args);
				});
				return session;
			};
			harness.setResponses([unfinished(), fauxAssistantMessage("must not wrap")]);
			const runtime = new SubagentV2Runtime(host({ createChildAgentSession: factory }));
			const [record] = await runtime.launch([{ ...task("explore", "finish"), maxTurns: 1 }]);
			const running = runtime.runTurn(record!.id, "finish", { foreground: true });
			await atGate;
			const stopped = runtime.stop(record!.id);
			release();
			await stopped;
			expect(await running).toMatchObject({ outcome: "cancelled" });
			expect(harness.getPendingResponseCount()).toBe(phase === "ordinary" ? 2 : 1);
			await runtime.shutdown();
		},
	);

	it("prevents a late wrap-up request after its timer expires during preflight", async () => {
		const { harness, host } = await setup();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const atGate = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const factory = async (options: Parameters<typeof createV2ChildSession>[0]) => {
			const session = await createV2ChildSession(options);
			const prompt = session.prompt.bind(session);
			let calls = 0;
			vi.spyOn(session, "prompt").mockImplementation(async (...args) => {
				if (++calls === 2) {
					reached();
					await gate;
				}
				return prompt(...args);
			});
			return session;
		};
		harness.setResponses([unfinished(), fauxAssistantMessage("must not wrap")]);
		const runtime = new SubagentV2Runtime(host({ createChildAgentSession: factory }));
		const [record] = await runtime.launch([{ ...task("explore", "finish"), maxTurns: 1 }]);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const running = runtime.runTurn(record!.id, "finish", { foreground: true });
			await atGate;
			await vi.advanceTimersByTimeAsync(CHILD_WRAP_UP_LIMITS.timeoutMs);
			release();
			expect(await running).toMatchObject({
				outcome: "budget_exhausted",
				error: "Budget wrap-up deadline reached.",
			});
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			vi.useRealTimers();
			await runtime.shutdown();
		}
	});

	it("preserves foreground parent cancellation while a child factory is still launching", async () => {
		const { harness, host } = await setup();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const factory = vi.fn(async (options: Parameters<typeof createV2ChildSession>[0]) => {
			await gate;
			return createV2ChildSession(options);
		});
		const runtime = new SubagentV2Runtime(host({ createChildAgentSession: factory }));
		const launch = runtime.launch.bind(runtime);
		const run = runtime.runTurn.bind(runtime);
		const launchProxy = vi.spyOn(SubagentV2Runtime.prototype, "launch").mockImplementation(launch);
		const runProxy = vi.spyOn(SubagentV2Runtime.prototype, "runTurn").mockImplementation(run);
		const stop = runtime.stop.bind(runtime);
		const stopProxy = vi.spyOn(SubagentV2Runtime.prototype, "stop").mockImplementation(stop);
		const definitions: ToolDefinition[] = [];
		iceSubagentsV2({
			registerTool: (tool: ToolDefinition) => definitions.push(tool),
			registerFlag: () => {},
			on: () => {},
			events: {},
		} as unknown as ExtensionAPI);
		harness.setResponses([fauxAssistantMessage("must not run")]);
		try {
			const controller = new AbortController();
			const tool = definitions.find((definition) => definition.name === "agent")!;
			const executing = tool.execute(
				"parent-cancel",
				{ tasks: [task("explore", "read")] },
				controller.signal,
				undefined,
				{} as ExtensionContext,
			);
			await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
			controller.abort();
			release();
			expect(JSON.stringify(await executing)).toContain("cancelled");
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			release();
			launchProxy.mockRestore();
			runProxy.mockRestore();
			stopProxy.mockRestore();
			await runtime.shutdown();
		}
	});

	it("keeps child writes at ask and denies them without an approval channel", async () => {
		const { harness, host } = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "out.txt", content: "x" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("I could not write the file."),
		]);
		const runtime = new SubagentV2Runtime(host());
		const result = await runOne(runtime, "general", "Write out.txt");
		expect(result.outcome).toBe("completed");
		expect(existsSync(join(harness.tempDir, "out.txt"))).toBe(false);
		expect(transcriptOf(runtime, result.childId)).toContain("Permission denied: write was not approved (no-channel)");
	});

	it("lets an interactive approval or authorized sub-yolo allow child writes", async () => {
		const approved = await setup();
		approved.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "a" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const prompts: string[] = [];
		const withPrompt = new SubagentV2Runtime(
			approved.host({
				promptApproval: async (request) => {
					prompts.push(request.summary);
					return "allow-once";
				},
			}),
		);
		await runOne(withPrompt, "general", "Write a.txt");
		expect(prompts).toEqual(["write: a.txt"]);
		expect(readFileSync(join(approved.harness.tempDir, "a.txt"), "utf8")).toBe("a");

		const yolo = await setup();
		yolo.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "b.txt", content: "b" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await runOne(new SubagentV2Runtime(yolo.host({ isSubYolo: () => true })), "general", "Write b.txt");
		expect(readFileSync(join(yolo.harness.tempDir, "b.txt"), "utf8")).toBe("b");
	});

	it("refuses invalid permission settings before creating any child", async () => {
		const { host, sessionManager } = await setup();
		const factory = vi.fn(createV2ChildSession);
		const settings = resolveSubagentsV2Settings({
			global: { permissions: { deny: ["(malformed"] } },
			projectTrusted: false,
		});
		const runtime = new SubagentV2Runtime(host({ getSettings: () => settings, createChildAgentSession: factory }));
		await expect(runtime.launch([task("general", "read")])).rejects.toThrow(/Invalid parent settings/);
		expect(factory).not.toHaveBeenCalled();
		expect(runtime.registry.list(sessionManager.getSessionId())).toEqual([]);
		await runtime.shutdown();
	});

	it("refuses new launches while ice.subagents.enabled is false", async () => {
		const { host, sessionManager } = await setup();
		const factory = vi.fn(createV2ChildSession);
		const settings = resolveSubagentsV2Settings({ global: { enabled: false }, projectTrusted: false });
		const runtime = new SubagentV2Runtime(host({ getSettings: () => settings, createChildAgentSession: factory }));
		await expect(runtime.launch([task("general", "read")])).rejects.toThrow(/disabled by ice.subagents.enabled/);
		await expect(runtime.launch([])).resolves.toEqual([]);
		expect(factory).not.toHaveBeenCalled();
		expect(runtime.registry.list(sessionManager.getSessionId())).toEqual([]);
		await runtime.shutdown();
	});

	it("enforces delegation ask before any batch acceptance or child factory", async () => {
		const { sessionManager, host } = await setup();
		const settings = resolveSubagentsV2Settings({
			global: { permissions: { ask: ["agent(general)"] } },
			projectTrusted: false,
		});
		const denied = new SubagentV2Runtime(host({ getSettings: () => settings }));
		await expect(denied.launch([task("explore", "read"), task("general", "read")])).rejects.toThrow(
			/Delegation.*not approved/,
		);
		expect(denied.registry.list(sessionManager.getSessionId())).toEqual([]);
		const order: string[] = [];
		const approved = new SubagentV2Runtime(
			host({
				getSettings: () => settings,
				promptApproval: async (request) => {
					order.push(request.tool);
					return "allow-once";
				},
				createChildAgentSession: async (options) => {
					order.push("factory");
					return createV2ChildSession(options);
				},
			}),
		);
		await approved.launch([task("general", "read")]);
		expect(order).toEqual(["agent", "factory"]);
		await denied.shutdown();
		await approved.shutdown();
	});

	it.each(["policy", "mode", "invalid"])(
		"rejects a stale tool approval after parent %s revocation",
		async (change) => {
			const { harness, host } = await setup();
			let settings = resolveSubagentsV2Settings({ projectTrusted: false });
			let mode: "build" | "plan" = "build";
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const promptApproval = vi.fn(async () => {
				await gate;
				return "allow-once" as const;
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "stale.txt", content: "must not write" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("blocked"),
			]);
			const runtime = new SubagentV2Runtime(
				host({ getSettings: () => settings, getParentMode: () => mode, promptApproval }),
			);
			const running = runOne(runtime, "general", "write");
			await vi.waitFor(() => expect(promptApproval).toHaveBeenCalledOnce());
			if (change === "policy")
				settings = resolveSubagentsV2Settings({
					global: { permissions: { deny: ["write"] } },
					projectTrusted: false,
				});
			else if (change === "mode") mode = "plan";
			else
				settings = resolveSubagentsV2Settings({
					global: { permissions: { deny: ["(malformed"] } },
					projectTrusted: false,
				});
			release();
			const result = await running;
			expect(existsSync(join(harness.tempDir, "stale.txt"))).toBe(false);
			expect(transcriptOf(runtime, result.childId)).toMatch(
				/policy changed|parent switched to plan|invalid parent settings/,
			);
			await runtime.shutdown();
		},
	);

	it("disposes a session returned by a factory after owner shutdown", async () => {
		const { host } = await setup();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let dispose: ReturnType<typeof vi.spyOn> | undefined;
		const factory = vi.fn(async (options: Parameters<typeof createV2ChildSession>[0]) => {
			await gate;
			const session = await createV2ChildSession(options);
			dispose = vi.spyOn(session, "dispose");
			return session;
		});
		const runtime = new SubagentV2Runtime(host({ createChildAgentSession: factory }));
		const launch = runtime.launch([task("general", "read")]);
		const rejected = expect(launch).rejects.toThrow(/owner shut down/);
		await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
		await runtime.shutdown();
		release();
		await rejected;
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("never lets sub-yolo override a plan-mode parent or the explore agent's plan preset", async () => {
		const { harness, host } = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "c.txt", content: "c" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("blocked"),
		]);
		const runtime = new SubagentV2Runtime(host({ isSubYolo: () => true, getParentMode: () => "plan" }));
		const result = await runOne(runtime, "general", "Write c.txt");
		expect(existsSync(join(harness.tempDir, "c.txt"))).toBe(false);
		expect(transcriptOf(runtime, result.childId)).toContain(
			"Permission denied: write is not allowed for this subagent",
		);
	});

	it("delivers a background completion to the parent exactly once", async () => {
		const { harness, parent, host } = await setup();
		harness.setResponses([fauxAssistantMessage("background report")]);
		const runtime = new SubagentV2Runtime(host());
		const result = await runOne(runtime, "explore", "Summarize", true);
		expect(result.outcome).toBe("completed");
		await Promise.resolve();
		expect(parent.sent).toHaveLength(1);
		expect(parent.sent[0]).toMatchObject({ customType: "subagent_completed" });
		const content = String(parent.sent[0]!.content);
		expect(content).toContain(`continue it with resume=${result.childId}`);
		expect(content).toContain(`agent_control action=delete id=${result.childId}`);
		expect(content).toContain("No other subagents are running.");
		runtime.flushCompletions();
		expect(parent.sent).toHaveLength(1);
	});

	it.each(["x".repeat(20 * 1024), "界".repeat(7 * 1024)])(
		"bounds a long background report and gives its retained byte offset",
		async (report) => {
			const { harness, parent, host } = await setup();
			harness.setResponses([fauxAssistantMessage(report)]);
			const runtime = new SubagentV2Runtime(host());
			try {
				const result = await runOne(runtime, "explore", "Summarize", true);
				const content = String(parent.sent[0]!.content);
				const summary = content.split("Untrusted child report:\n")[1]!.split("\n\nFull result:")[0]!;
				const kept = summary.split("\n[Report truncated")[0]!;
				expect(summary).toContain(
					`[Report truncated at 16 KiB; read the full report with agent_control action=output id=${result.childId} offset=${Buffer.byteLength(kept)}]`,
				);
				expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(16 * 1024);
				expect(report.startsWith(kept)).toBe(true);
				expect(kept).not.toContain("�");
			} finally {
				await runtime.shutdown();
			}
		},
	);

	it("delivers a 10 KiB background report intact", async () => {
		const { harness, parent, host } = await setup();
		const report = "x".repeat(10 * 1024);
		harness.setResponses([fauxAssistantMessage(report)]);
		const runtime = new SubagentV2Runtime(host());
		try {
			await runOne(runtime, "explore", "Summarize", true);
			expect(parent.sent[0]!.content).toContain(report);
			expect(parent.sent[0]!.content).not.toContain("[Report truncated");
		} finally {
			await runtime.shutdown();
		}
	});

	it.each([
		{ report: "x".repeat(20 * 1024), error: undefined },
		{ report: "界".repeat(20 * 1024), error: "失敗: partial response" },
		{ report: "界".repeat(7 * 1024), error: "失敗: partial response" },
		{ report: "x".repeat(20 * 1024), error: "failure ".repeat(3 * 1024) },
	])("reads the remainder at the completion hint for inline and artifact reports", async ({ report, error }) => {
		const { harness, parent, host } = await setup();
		harness.setResponses([fauxAssistantMessage(report, error ? { stopReason: "error", errorMessage: error } : {})]);
		const runtime = new SubagentV2Runtime(host());
		try {
			const result = await runOne(runtime, "explore", "Summarize", true);
			const summary = String(parent.sent[0]!.content)
				.split("Untrusted child report:\n")[1]!
				.split("\n\nFull result:")[0]!;
			const offset = Number(summary.match(/offset=(\d+)\]/)![1]);
			const kept = summary.split("\n[Report truncated")[0]!;
			const prefix = error ? `${error}\n\n` : "";
			const retainedReport = kept.startsWith(prefix) ? kept.slice(prefix.length) : "";
			expect(offset).toBe(Buffer.byteLength(retainedReport));
			const remainder = runtime.readOutput(result.childId, { offset, length: 64 * 1024 });
			expect(retainedReport + remainder.text).toBe(report);
			expect(remainder.eof).toBe(true);
			expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(16 * 1024);
			if (!result.output?.artifact) {
				expect(() => runtime.readOutput(result.childId, { offset: -1 })).toThrow(/range/);
				expect(() => runtime.readOutput(result.childId, { offset: Buffer.byteLength(report) + 1 })).toThrow(
					/boundary/,
				);
				expect(() => runtime.readOutput(result.childId, { length: 65 * 1024 })).toThrow(/range/);
				if (report.startsWith("界")) {
					expect(() => runtime.readOutput(result.childId, { offset: 1 })).toThrow(/boundary/);
					expect(() => runtime.readOutput(result.childId, { length: 1 })).toThrow(/code point/);
				}
			}
		} finally {
			await runtime.shutdown();
		}
	});

	it("lists still-running siblings in a completion message", async () => {
		const { harness, parent, host } = await setup();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slowResponse = vi.fn(async () => {
			await gate;
			return fauxAssistantMessage("slow report");
		});
		harness.setResponses([slowResponse, fauxAssistantMessage("quick report")]);
		const runtime = new SubagentV2Runtime(host());
		const [quick, slow] = await runtime.launch([task("explore", "quick"), task("explore", "slow")]);
		const slowRun = runtime.runTurn(slow!.id, "slow", { foreground: false, background: true });
		await vi.waitFor(() => expect(slowResponse).toHaveBeenCalledOnce());
		await runtime.runTurn(quick!.id, "quick", { foreground: false, background: true });
		await Promise.resolve();
		const content = String(parent.sent.find((message) => String(message.content).includes(quick!.id))!.content);
		expect(content).toContain(`1 other subagent is still running (${slow!.id})`);
		release();
		await slowRun;
		await runtime.shutdown();
	});

	it("bounds the completion trailer with many long-named running siblings", async () => {
		const { harness, parent, host } = await setup();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slowResponse = vi.fn(async () => {
			await gate;
			return fauxAssistantMessage("slow report");
		});
		harness.setResponses([...Array.from({ length: 9 }, () => slowResponse), fauxAssistantMessage("quick report")]);
		const runtime = new SubagentV2Runtime(
			host({
				getSettings: () => resolveSubagentsV2Settings({ global: { maxConcurrent: 10 }, projectTrusted: false }),
			}),
		);
		const records = await runtime.launch(
			Array.from({ length: 10 }, (_, index) => ({
				...task("explore", "read"),
				name: `reader-${index}-${"x".repeat(31)}`,
			})),
		);
		const running = records
			.slice(0, 9)
			.map((record) => runtime.runTurn(record.id, "slow", { foreground: false, background: true }));
		try {
			await vi.waitFor(() => expect(slowResponse).toHaveBeenCalledTimes(9));
			await runtime.runTurn(records[9]!.id, "quick", { foreground: false, background: true });
			const trailer = String(parent.sent[0]!.content).split("\n\nFull result:")[1]!;
			expect(trailer).toContain("9 other subagents are still running");
			expect(trailer).toContain("and 1 more; agent_control action=list shows all");
			expect(Buffer.byteLength(trailer)).toBeLessThan(1024);
		} finally {
			release();
			await Promise.all(running);
			await runtime.shutdown();
		}
	});

	it("restores after a restart, revives under the frozen contract, and blocks when authority was revoked", async () => {
		const first = await setup();
		first.harness.setResponses([fauxAssistantMessage("first turn")]);
		const runtime = new SubagentV2Runtime(first.host());
		const { childId } = await runOne(runtime, "general", "Start");
		first.sessionManager.flushDurably();
		const parentFile = first.sessionManager.getSessionFile()!;

		// New process: same parent session file, restored registry.
		first.parent.session = {
			...first.parent.session,
			sessionManager: SessionManager.open(parentFile),
		} as AgentSession;
		const restarted = new SubagentV2Runtime(first.host());
		expect(restarted.registry.get(first.sessionManager.getSessionId(), childId)).toMatchObject({ state: "parked" });
		first.harness.setResponses([fauxAssistantMessage("second turn")]);
		const continued = await restarted.continueChild(childId, "Continue", { foreground: true });
		expect(continued).toMatchObject({ outcome: "completed", text: "second turn" });

		await restarted.registry.park(first.sessionManager.getSessionId(), childId);
		first.parent.tools = ["read", "grep", "find", "ls"];
		await expect(restarted.continueChild(childId, "Again", { foreground: true })).rejects.toThrow(
			/no longer active in the parent/,
		);
		expect(restarted.registry.get(first.sessionManager.getSessionId(), childId).state).toBe("blocked");
	});

	it("runs a worktree child from parent WIP and applies only an inspected, verified delta", async () => {
		const { harness, sessionManager, host } = await setup({ repository: true });
		const repo = sessionManager.getCwd();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "child change\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const verify = vi.fn(async () => ({ status: "passed" as const }));
		const runtime = new SubagentV2Runtime(host({ verifyPatch: verify }));
		const [record] = await runtime.launch([{ ...task("general", "write"), isolation: "worktree" }]);
		await runtime.runTurn(record!.id, "write", { foreground: true });
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("parent wip\n");
		await expect(runtime.applyPatch(record!.id)).rejects.toThrow(/Inspect this patch/);
		const inspection = runtime.inspectPatch(record!.id);
		expect(inspection.delta?.patch).toContain("-parent wip");
		expect(inspection.artifactRef).toBeTruthy();
		expect(await runtime.applyPatch(record!.id)).toMatchObject({
			status: "applied",
			verification: { status: "passed" },
		});
		expect(verify).toHaveBeenCalledOnce();
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("child change\n");
		expect(await runtime.applyPatch(record!.id)).toMatchObject({ status: "already", patchState: "applied" });
		await expect(runtime.continueChild(record!.id, "again", { foreground: true })).rejects.toThrow(/was applied/);
		await runtime.shutdown();
	});

	it("automatically removes unchanged worktrees without claiming integration", async () => {
		const { harness, host } = await setup({ repository: true });
		harness.setResponses([fauxAssistantMessage("No changes needed.")]);
		const verify = vi.fn(async () => ({ status: "passed" as const }));
		const runtime = new SubagentV2Runtime(host({ verifyPatch: verify }));
		const [record] = await runtime.launch([{ ...task("general", "inspect"), isolation: "worktree" }]);
		const worktree = SessionManager.open(record!.transcriptPath).getCwd();
		expect(await runtime.runTurn(record!.id, "inspect", { foreground: true })).toMatchObject({
			outcome: "completed",
		});
		expect(existsSync(worktree)).toBe(false);
		expect(runtime.inspectPatch(record!.id).state).toBe("unchanged");
		expect(await runtime.applyPatch(record!.id)).toMatchObject({ status: "already", patchState: "unchanged" });
		expect(verify).not.toHaveBeenCalled();
		await expect(runtime.continueChild(record!.id, "again", { foreground: true })).rejects.toThrow(/unchanged/);
		await runtime.shutdown();
	});

	it("pins inspected bytes across restart and detects artifact/worktree tampering", async () => {
		const { harness, parent, sessionManager, host } = await setup({ repository: true });
		harness.setResponses([fauxAssistantMessage("done")]);
		const runtime = new SubagentV2Runtime(host({ verifyPatch: async () => ({ status: "passed" }) }));
		const [record] = await runtime.launch([{ ...task("general", "work"), isolation: "worktree" }]);
		const child = SessionManager.open(record!.transcriptPath);
		const worktree = child.getCwd();
		writeFileSync(join(worktree, "new.txt"), "child\n");
		await runtime.runTurn(record!.id, "work", { foreground: true });
		const inspection = runtime.inspectPatch(record!.id);
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "gc", "--prune=now"], { cwd: sessionManager.getCwd() });
		expect(() =>
			execFileSync("git", ["cat-file", "-e", `${inspection.delta!.finalTree}^{tree}`], {
				cwd: sessionManager.getCwd(),
				stdio: "pipe",
			}),
		).not.toThrow();
		await runtime.shutdown();
		parent.session = {
			...parent.session,
			sessionManager: SessionManager.open(sessionManager.getSessionFile()!),
		} as AgentSession;
		const restored = new SubagentV2Runtime(host({ verifyPatch: async () => ({ status: "passed" }) }));
		expect(restored.registry.get(sessionManager.getSessionId(), record!.id).patchArtifact?.patchRef).toBe(
			inspection.artifactRef,
		);
		writeFileSync(join(worktree, "new.txt"), "changed after inspection\n");
		await expect(restored.applyPatch(record!.id)).rejects.toThrow(/changed after inspection/);
		const fresh = restored.inspectPatch(record!.id);
		chmodSync(fresh.artifactRef!, 0o600);
		writeFileSync(fresh.artifactRef!, "tampered\n");
		await expect(restored.applyPatch(record!.id)).rejects.toThrow(/bounded regular file|hash changed/);
		expect(existsSync(join(sessionManager.getCwd(), "new.txt"))).toBe(false);
		expect(restored.rejectPatch(record!.id)).toMatchObject({ status: "rejected" });
		expect(restored.rejectPatch(record!.id)).toMatchObject({ status: "already" });
		expect(() =>
			execFileSync("git", ["show-ref", "--verify", worktreeSnapshotRef(worktree)], {
				cwd: sessionManager.getCwd(),
				stdio: "pipe",
			}),
		).toThrow();
		await restored.shutdown();
	});

	it("delivers a foreground turn's completion as a follow-up after it is detached (Ctrl+B)", async () => {
		const { harness, parent, host } = await setup();
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		harness.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage("finished after detach");
			},
		]);
		const runtime = new SubagentV2Runtime(host());
		const [record] = await runtime.launch([task("explore", "Long task")]);
		const run = runtime.runTurn(record!.id, "Long task", { foreground: true });
		await vi.waitFor(() => expect(runtime.registry.get(runtime.ownerSessionId(), record!.id).state).toBe("running"));
		expect(runtime.detachToBackground([record!.id, "ag_unknown"])).toBe(1);
		expect(parent.sent).toHaveLength(0);
		finish();
		expect(await run).toMatchObject({ outcome: "completed", text: "finished after detach" });
		await vi.waitFor(() => expect(parent.sent).toHaveLength(1));
		expect(parent.sent[0]).toMatchObject({ customType: "subagent_completed" });
	});

	it("queues a background child's approval in the Hub inbox until it is answered", async () => {
		const { harness, host } = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "inbox.txt", content: "ok" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("written"),
		]);
		let runtime!: SubagentV2Runtime;
		const seen: string[] = [];
		runtime = new SubagentV2Runtime(
			host({
				hasApprovalInbox: () => true,
				onApprovalsChanged: (pending) => {
					for (const approval of pending) {
						seen.push(approval.request.summary);
						queueMicrotask(() => runtime.respondToApproval(approval.request.id, "allow-once"));
					}
				},
			}),
		);
		const result = await runOne(runtime, "general", "Write inbox.txt", true);
		expect(result.outcome).toBe("completed");
		expect(seen).toEqual(["write: inbox.txt"]);
		expect(readFileSync(join(harness.tempDir, "inbox.txt"), "utf8")).toBe("ok");
		expect(runtime.pendingApprovals()).toEqual([]);
	});

	it("finishes worktree cleanup that a crash interrupted after a terminal patch decision", async () => {
		const { harness, parent, sessionManager, host } = await setup({ repository: true });
		harness.setResponses([fauxAssistantMessage("done")]);
		const runtime = new SubagentV2Runtime(host());
		const [record] = await runtime.launch([{ ...task("general", "work"), isolation: "worktree" }]);
		const worktree = SessionManager.open(record!.transcriptPath).getCwd();
		writeFileSync(join(worktree, "a.txt"), "child\n");
		await runtime.runTurn(record!.id, "work", { foreground: true });
		runtime.inspectPatch(record!.id);
		// Crash after the durable decision, before the worktree and snapshot ref are removed.
		runtime.registry.setPatchState(sessionManager.getSessionId(), record!.id, "rejected");
		sessionManager.flushDurably();
		expect(existsSync(worktree)).toBe(true);
		parent.session = {
			...parent.session,
			sessionManager: SessionManager.open(sessionManager.getSessionFile()!),
		} as AgentSession;
		const restarted = new SubagentV2Runtime(host());
		expect(restarted.registry.get(sessionManager.getSessionId(), record!.id).patchState).toBe("rejected");
		expect(existsSync(worktree)).toBe(false);
		expect(() =>
			execFileSync("git", ["show-ref", "--verify", worktreeSnapshotRef(worktree)], {
				cwd: sessionManager.getCwd(),
				stdio: "pipe",
			}),
		).toThrow();
		await runtime.shutdown();
		await restarted.shutdown();
	});

	it("retains a pending patch after verification failure, refuses lost trust, and applies unverified without a verifier", async () => {
		const { harness, sessionManager, host } = await setup({ repository: true });
		harness.setResponses([fauxAssistantMessage("done")]);
		let trusted = true;
		let verify: V2RuntimeHost["verifyPatch"] = async () => ({ status: "failed", exitCode: 7 });
		const runtime = new SubagentV2Runtime(host({ isProjectTrusted: () => trusted, getPatchVerifier: () => verify }));
		const [record] = await runtime.launch([{ ...task("general", "work"), isolation: "worktree" }]);
		const worktree = SessionManager.open(record!.transcriptPath).getCwd();
		writeFileSync(join(worktree, "a.txt"), "child\n");
		await runtime.runTurn(record!.id, "work", { foreground: true });
		runtime.inspectPatch(record!.id);
		expect(await runtime.applyPatch(record!.id)).toMatchObject({ status: "verification_failed" });
		expect(readFileSync(join(sessionManager.getCwd(), "a.txt"), "utf8")).toBe("parent wip\n");
		expect(runtime.registry.get(sessionManager.getSessionId(), record!.id).patchState).toBe("open");
		expect(existsSync(worktree)).toBe(true);
		trusted = false;
		await expect(runtime.applyPatch(record!.id)).rejects.toThrow(/trusted build/);
		// Without a configured verifier the patch is applied like parent edits and reported unverified.
		trusted = true;
		verify = undefined;
		expect(await runtime.applyPatch(record!.id)).toMatchObject({
			status: "applied",
			unverified: true,
			writtenPaths: ["a.txt"],
		});
		expect(readFileSync(join(sessionManager.getCwd(), "a.txt"), "utf8")).toBe("child\n");
		expect(runtime.registry.get(sessionManager.getSessionId(), record!.id).patchState).toBe("applied");
		await runtime.shutdown();
	});

	it("blocks continuation while applying and preserves unresolved intent on restart", async () => {
		const { harness, host } = await setup({ repository: true });
		harness.setResponses([fauxAssistantMessage("done")]);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const verify = vi.fn(async () => {
			await gate;
			return { status: "passed" as const };
		});
		const runtime = new SubagentV2Runtime(host({ verifyPatch: verify }));
		const [record] = await runtime.launch([{ ...task("general", "work"), isolation: "worktree" }]);
		writeFileSync(join(SessionManager.open(record!.transcriptPath).getCwd(), "a.txt"), "child\n");
		await runtime.runTurn(record!.id, "work", { foreground: true });
		runtime.inspectPatch(record!.id);
		const applying = runtime.applyPatch(record!.id);
		await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
		await expect(runtime.continueChild(record!.id, "again", { foreground: true })).rejects.toThrow(/patch operation/);
		expect(() => runtime.rejectPatch(record!.id)).toThrow(/applying/);
		const restarted = new SubagentV2Runtime(host());
		const unresolved = restarted.inspectPatch(record!.id);
		expect(unresolved.state).toBe("applying");
		expect(unresolved.recoveryRef).toBeTruthy();
		expect(JSON.parse(readFileSync(unresolved.recoveryRef!, "utf8"))).toMatchObject({
			paths: [{ path: "a.txt", before: { base64: Buffer.from("parent wip\n").toString("base64") } }],
		});
		await expect(restarted.applyPatch(record!.id)).rejects.toThrow(/applying/);
		release();
		expect(await applying).toMatchObject({ status: "applied" });
		await runtime.shutdown();
	});

	it("cancels queued turns promptly and refuses patch actions during queued continuation", async () => {
		const { harness, sessionManager, host } = await setup({ repository: true });
		const settings = resolveSubagentsV2Settings({ global: { maxConcurrent: 1 }, projectTrusted: true });
		const runtime = new SubagentV2Runtime(host({ getSettings: () => settings }));
		const [first, second] = await runtime.launch([
			task("explore", "hold"),
			{ ...task("general", "work"), isolation: "worktree" },
		]);
		harness.setResponses([fauxAssistantMessage("initial")]);
		writeFileSync(join(SessionManager.open(second!.transcriptPath).getCwd(), "a.txt"), "pending child change\n");
		await runtime.runTurn(second!.id, "initial", { foreground: true });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const response = vi.fn(async () => {
			await gate;
			return fauxAssistantMessage("released");
		});
		harness.setResponses([response]);
		const running = runtime.runTurn(first!.id, "hold", { foreground: true });
		await vi.waitFor(() => expect(response).toHaveBeenCalledOnce());
		const queued = runtime.continueChild(second!.id, "queued", { foreground: true });
		expect(() => runtime.inspectPatch(second!.id)).toThrow(/still running/);
		await runtime.stop(second!.id);
		expect(await queued).toMatchObject({ outcome: "cancelled" });
		expect(runtime.registry.get(sessionManager.getSessionId(), second!.id).usage.turns).toBe(2);
		release();
		await running;
		expect(response).toHaveBeenCalledOnce();
		await runtime.shutdown();
	});

	it("blocks idle continuation after policy changes, before any model turn", async () => {
		const { harness, host } = await setup();
		let settings = resolveSubagentsV2Settings({ projectTrusted: false });
		harness.setResponses([fauxAssistantMessage("done")]);
		const runtime = new SubagentV2Runtime(host({ getSettings: () => settings }));
		const result = await runOne(runtime, "general", "initial");
		settings = resolveSubagentsV2Settings({ global: { permissions: { deny: ["write"] } }, projectTrusted: false });
		await expect(runtime.continueChild(result.childId, "again", { foreground: true })).rejects.toThrow(
			/policy changed/,
		);
		await runtime.shutdown();
	});

	it("cleans staged worktrees when a later batch task or child factory fails", async () => {
		const { sessionManager, host } = await setup({ repository: true });
		const runtime = new SubagentV2Runtime(host());
		await expect(
			runtime.launch([
				{ ...task("general", "valid"), isolation: "worktree" },
				{
					...task("general", "invalid scope"),
					isolation: "worktree",
					scope: { roots: [sessionManager.getSessionDir()] },
				},
			]),
		).rejects.toThrow(/outside the repository/);
		expect(runtime.registry.list(sessionManager.getSessionId())).toEqual([]);
		const failed = new SubagentV2Runtime(
			host({
				createChildAgentSession: async () => {
					throw new Error("factory failed");
				},
			}),
		);
		await expect(failed.launch([{ ...task("general", "work"), isolation: "worktree" }])).rejects.toThrow(
			/factory failed/,
		);
		expect(failed.registry.list(sessionManager.getSessionId())).toEqual([]);
		await runtime.shutdown();
		await failed.shutdown();
	});

	it("runs child shell commands without host credential variables", async () => {
		const { harness, host } = await setup();
		process.env.ICE_V2_TEST_SECRET_TOKEN = "leaked-value";
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "env" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			const runtime = new SubagentV2Runtime(host({ isSubYolo: () => true }));
			const result = await runOne(runtime, "general", "Print the environment");
			const transcript = transcriptOf(runtime, result.childId);
			expect(transcript).toContain("PATH=");
			expect(transcript).not.toContain("leaked-value");
			expect(transcript).not.toContain("ICE_V2_TEST_SECRET_TOKEN");
		} finally {
			delete process.env.ICE_V2_TEST_SECRET_TOKEN;
		}
	});

	it("parks the least recently used idle children beyond the resident limit", async () => {
		const { harness, sessionManager, host } = await setup();
		const runtime = new SubagentV2Runtime(host());
		const ids: string[] = [];
		for (let index = 0; index < MAX_RESIDENT_CHILDREN + 2; index++) {
			harness.setResponses([fauxAssistantMessage(`report ${index}`)]);
			ids.push((await runOne(runtime, "explore", `task ${index}`)).childId);
		}
		const owner = sessionManager.getSessionId();
		await vi.waitFor(() =>
			expect(ids.filter((id) => runtime.registry.get(owner, id).state === "parked")).toEqual(ids.slice(0, 2)),
		);
		expect(ids.slice(2).every((id) => runtime.registry.resident(owner, id) !== undefined)).toBe(true);
		harness.setResponses([fauxAssistantMessage("revived report")]);
		expect(await runtime.continueChild(ids[0]!, "again", { foreground: true })).toMatchObject({
			text: "revived report",
		});
	});

	it("rejects a missing scope target with a clear preflight error", async () => {
		const { host } = await setup();
		const runtime = new SubagentV2Runtime(host());
		await expect(
			runtime.launch([{ ...task("explore", "x"), scope: { roots: ["."], targets: ["missing.txt"] } }]),
		).rejects.toThrow("scope target missing.txt does not exist");
	});

	it("loads a definition's selected prompts and context and fails closed when they change", async () => {
		const { harness, host } = await setup();
		const agentDir = join(harness.tempDir, "agent");
		mkdirSync(join(agentDir, "prompts"), { recursive: true });
		writeFileSync(join(agentDir, "prompts", "style.md"), "PROMPT-MARKER: answer tersely.\n");
		writeFileSync(join(harness.tempDir, "notes.md"), "CONTEXT-MARKER: notes.\n");
		mkdirSync(join(harness.tempDir, "agents"), { recursive: true });
		writeFileSync(
			join(harness.tempDir, "agents", "styled.md"),
			"---\nname: styled\ndescription: d\ntools: [read]\nprompts: [style]\ncontext: [notes.md]\n---\nStyled agent.\n",
		);
		await expect(new SubagentV2Runtime(host()).launch([task("styled", "go")])).rejects.toThrow(
			/requires project trust/,
		);
		const runtime = new SubagentV2Runtime(host({ isProjectTrusted: () => true }));
		let seen = "";
		harness.setResponses([
			(context) => {
				seen = `${context.systemPrompt ?? ""}\n${JSON.stringify(context.messages)}`;
				return fauxAssistantMessage("done");
			},
		]);
		const [record] = await runtime.launch([task("styled", "go")]);
		const contract = runtime.registry.get(runtime.ownerSessionId(), record!.id);
		expect(contract.agent).toBe("styled");
		await runtime.runTurn(record!.id, "go", { foreground: true });
		expect(seen).toContain("PROMPT-MARKER");
		expect(seen).toContain("CONTEXT-MARKER");
		writeFileSync(join(agentDir, "prompts", "style.md"), "PROMPT-MARKER: changed.\n");
		const [second] = await runtime.launch([task("styled", "go")]);
		writeFileSync(join(harness.tempDir, "notes.md"), "CONTEXT-MARKER: tampered.\n");
		await expect(runtime.runTurn(second!.id, "go", { foreground: true })).rejects.toThrow(
			/cannot run: Selected context hash changed: notes.md/,
		);
	});

	it("bridges selected parent MCP tools to a child only through the parent's mcp proxy", async () => {
		const dispatch = vi.fn(async () => ({ content: [{ type: "text", text: "ISSUE-42" }] }));
		const adapter: IceSubagentMcpAdapter = {
			listAuthorizedTools: () => [
				{ selector: "github/list_issues", access: "read-only", parameters: { type: "object", properties: {} } },
				{ selector: "github/broken", access: "unknown", parameters: { type: "object", properties: {} } },
			],
			dispatch,
		};
		const { harness, parent, host } = await setup({ tools: ["read", "mcp"] });
		mkdirSync(join(harness.tempDir, "agents"), { recursive: true });
		writeFileSync(
			join(harness.tempDir, "agents", "triage.md"),
			"---\nname: triage\ndescription: d\ntools: [read]\nmcp: [github/*]\n---\nTriage.\n",
		);
		const runtime = new SubagentV2Runtime(host({ getAdapters: () => mcpDelegableTools(adapter, () => true) }));
		const toolName = subagentMcpToolName("github/list_issues");
		let toolResult = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall(toolName, {}), { stopReason: "toolUse" }),
			(context) => {
				toolResult = JSON.stringify(context.messages.at(-1));
				return fauxAssistantMessage("done");
			},
		]);
		const [record] = await runtime.launch([task("triage", "list")]);
		expect(
			runtime.registry
				.resident(runtime.ownerSessionId(), record!.id)!
				.contract.capabilities.tools.map((tool) => tool.name),
		).toEqual([toolName, "read"].sort());
		await runtime.runTurn(record!.id, "list", { foreground: true });
		expect(dispatch).toHaveBeenCalledWith("github", "list_issues", {}, expect.anything());
		expect(toolResult).toContain("ISSUE-42");
		parent.tools = ["read"];
		const [withoutProxy] = await runtime.launch([task("triage", "list")]);
		expect(
			runtime.registry
				.resident(runtime.ownerSessionId(), withoutProxy!.id)!
				.contract.capabilities.tools.map((tool) => tool.name),
		).toEqual(["read"]);
	});

	it("refuses unknown agents with the available list and launches nothing for a bad batch", async () => {
		const { sessionManager, host } = await setup();
		const runtime = new SubagentV2Runtime(host());
		await expect(runtime.launch([task("explore", "ok"), task("nope", "bad")])).rejects.toThrow(
			/Agent "nope" is not available. Available agents: explore, general, plan, review/,
		);
		expect(runtime.registry.list(sessionManager.getSessionId())).toEqual([]);
	});
});
