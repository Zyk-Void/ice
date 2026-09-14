import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../src/core/sdk.ts";
import {
	projectSubagentManagementState,
	SubagentRunSupervisor,
	SubagentRunSupervisorRegistry,
} from "../src/ice-subagent-timeout-supervisor.ts";
import {
	NativeSubagentRunner,
	normalizeSubagentRequest,
	SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS,
	type SubagentManagedHandle,
	type SubagentRequest,
	type SubagentResult,
} from "../src/ice-subagents.ts";

const tempDirs: string[] = [];
const PARENT_TOOLS = ["delegate", "read", "grep", "find", "ls"] as const;

function assistantMessage(text: string): AgentMessage {
	return { role: "assistant", content: text, stopReason: "stop" } as unknown as AgentMessage;
}

async function workspace(): Promise<{ cwd: string; agentDir: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "ice-mux-"));
	const agentDir = await mkdtemp(join(tmpdir(), "ice-mux-agent-"));
	tempDirs.push(cwd, agentDir);
	await mkdir(join(cwd, "src"));
	await writeFile(join(cwd, "src", "a.ts"), "export const a = 1;\n");
	return { cwd, agentDir };
}

/**
 * Bounded poll helper. The runner admits and settles children asynchronously, so
 * tests wait for an observable state instead of sleeping a fixed duration.
 */
async function waitFor(check: () => void, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			check();
			return;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 20));
		}
	}
}

function request(cwd: string, timeoutMs?: number): SubagentRequest {
	return {
		parentSessionId: "parent-session",
		role: "self",
		self: {
			instructions: "Inspect the scoped repository and preserve evidence.",
			capabilities: ["read", "grep", "find", "ls"],
		},
		task: "Inspect the scoped repository.",
		scope: { roots: ["src"] },
		cwd,
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
	};
}

function fauxModel(): Model<Api> {
	return { provider: "faux", id: "faux" } as Model<Api>;
}

/**
 * Minimal child session. The first prompt emits bounded tool activity and then
 * blocks, so the supervisor timeout is what releases it. Later prompts complete
 * once `completeOnPrompt` is reached, which lets a retained run finish on demand.
 */
class MultiplexChild {
	readonly sessionId: string;
	readonly model = fauxModel();
	readonly messages: AgentMessage[] = [];
	readonly promptCalls: Array<{ text: string; options?: Record<string, unknown> }> = [];
	readonly dispose = vi.fn();
	readonly extensionRunner = { hasHandlers: vi.fn(() => false), emit: vi.fn(async () => undefined) };
	readonly sessionManager: { getCwd: () => string };
	readonly getSessionStats = vi.fn(() => ({
		tokens: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 },
		cost: 0.25,
	}));
	readonly abort = vi.fn(async () => {
		this.isStreaming = false;
		this.resolveActivePrompt?.();
		this.resolveActivePrompt = undefined;
	});
	isStreaming = false;
	completeOnPrompt: number;
	/** Bounded delay before the child reports completion, so a live child is observable. */
	firstPromptDelayMs: number;

	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	private resolveActivePrompt: (() => void) | undefined;

	constructor(cwd: string, sessionId: string, completeOnPrompt = 2, firstPromptDelayMs = 0) {
		this.sessionManager = { getCwd: () => cwd };
		this.sessionId = sessionId;
		this.completeOnPrompt = completeOnPrompt;
		this.firstPromptDelayMs = firstPromptDelayMs;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private emitActivity(index: number, toolName: string, args: Record<string, unknown>): void {
		const toolCallId = `${this.sessionId}-tool-${index}`;
		this.emit({ type: "tool_execution_start", toolCallId, toolName, args } as AgentSessionEvent);
		this.emit({
			type: "tool_execution_end",
			toolCallId,
			toolName,
			result: { content: [] },
			isError: false,
		} as AgentSessionEvent);
	}

	async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
		this.promptCalls.push({ text, options });
		const call = this.promptCalls.length;
		if (call === 1) {
			this.emitActivity(1, "read", { path: "src/a.ts" });
			this.emitActivity(2, "grep", { pattern: "export", path: "src" });
		}
		if (call >= this.completeOnPrompt) {
			if (this.firstPromptDelayMs > 0) {
				await new Promise<void>((resolve) => globalThis.setTimeout(resolve, this.firstPromptDelayMs));
			}
			this.messages.push(
				assistantMessage('{"summary":"completed after extension","evidence":{"paths":["src/a.ts"]}}'),
			);
			return;
		}
		this.isStreaming = true;
		await new Promise<void>((resolve) => {
			this.resolveActivePrompt = resolve;
		});
		this.isStreaming = false;
	}
}

function createRunner(agentDir: string, children: readonly MultiplexChild[]) {
	const supervisors = new SubagentRunSupervisorRegistry<SubagentResult>();
	// Every child session created for these runs, so a test can prove a retained
	// child is never replaced and its tool authority never widens.
	const sessionOptions: CreateAgentSessionOptions[] = [];
	let index = 0;
	const runner = new NativeSubagentRunner({
		agentDir,
		supervisorRegistry: supervisors,
		createSession: async (options) => {
			const child = children[index];
			if (!child) throw new Error("No multiplex child available for this run.");
			index += 1;
			sessionOptions.push(options);
			return { session: child as unknown as AgentSession } as unknown as CreateAgentSessionResult;
		},
	});
	return { runner, supervisors, sessionOptions };
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ICE subagent timeout multiplexing", () => {
	it("projects supervisor snapshots into the bounded management vocabulary", async () => {
		vi.useFakeTimers();
		const running = new SubagentRunSupervisor<string>({
			runId: "run-projection",
			initialTimeoutMs: 1_000,
			decisionGraceMs: 5_000,
			abort: async () => {},
			resume: async () => "resumed",
			stop: async () => "stopped",
		});
		expect(projectSubagentManagementState(running.getSnapshot())).toEqual({
			childState: "running",
			terminal: false,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		expect(projectSubagentManagementState(running.getSnapshot())).toEqual({
			childState: "awaiting_extension",
			terminal: false,
		});

		// Grace expiry is a real child timeout.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(projectSubagentManagementState(running.getSnapshot())).toEqual({
			childState: "timed_out",
			terminal: true,
		});

		const completed = new SubagentRunSupervisor<string>({
			runId: "run-projection-completed",
			initialTimeoutMs: 60_000,
			abort: async () => {},
			resume: async () => "resumed",
			stop: async () => "stopped",
		});
		completed.finish("done", "completed");
		expect(projectSubagentManagementState(completed.getSnapshot())).toEqual({
			childState: "completed",
			terminal: true,
		});

		const cancelled = new SubagentRunSupervisor<string>({
			runId: "run-projection-cancelled",
			initialTimeoutMs: 60_000,
			abort: async () => {},
			resume: async () => "resumed",
			stop: async () => "stopped",
		});
		await cancelled.stop("cancelled");
		expect(projectSubagentManagementState(cancelled.getSnapshot())).toEqual({
			childState: "cancelled",
			terminal: true,
		});
	});

	it("resolves lifecycle waiters on transition, abort, and terminal without leaking", async () => {
		vi.useFakeTimers();
		const supervisor = new SubagentRunSupervisor<string>({
			runId: "run-waiters",
			initialTimeoutMs: 10_000,
			decisionGraceMs: 10_000,
			abort: async () => {},
			resume: async () => "resumed",
			stop: async () => "stopped",
		});

		// A live run registers a waiter and settles it on the timeout transition.
		const onTransition = supervisor.waitForLifecycleChange();
		expect(supervisor.pendingLifecycleWaiters).toBe(1);
		await vi.advanceTimersByTimeAsync(10_000);
		await onTransition;
		expect(supervisor.pendingLifecycleWaiters).toBe(0);
		expect(supervisor.getSnapshot().state).toBe("awaiting_extension");

		// An already-running wait unsubscribes when the parent aborts.
		await supervisor.extend(1_000);
		const controller = new AbortController();
		const onAbort = supervisor.waitForLifecycleChange(controller.signal);
		expect(supervisor.pendingLifecycleWaiters).toBe(1);
		controller.abort();
		await onAbort;
		expect(supervisor.pendingLifecycleWaiters).toBe(0);

		// A terminal transition settles any remaining waiter.
		const onTerminal = supervisor.waitForLifecycleChange();
		expect(supervisor.pendingLifecycleWaiters).toBe(1);
		supervisor.finish("done", "completed");
		await onTerminal;
		expect(supervisor.pendingLifecycleWaiters).toBe(0);
	});

	it("settles pending waiters once when a retained child is stopped", async () => {
		const supervisor = new SubagentRunSupervisor<string>({
			runId: "run-stop-once",
			initialTimeoutMs: 60_000,
			abort: async () => {},
			resume: async () => "resumed",
			stop: async () => "stopped",
		});
		const pending = supervisor.waitForLifecycleChange();
		expect(supervisor.pendingLifecycleWaiters).toBe(1);
		const stopped = supervisor.stop("cancelled");
		await pending;
		expect(supervisor.pendingLifecycleWaiters).toBe(0);
		expect(await stopped).toBe("stopped");
		expect(supervisor.getSnapshot()).toMatchObject({ state: "terminal", terminalStatus: "cancelled" });
		// Cancellation stays idempotent and cannot complete the run twice.
		expect(await supervisor.stop("cancelled")).toBe("stopped");
		expect(supervisor.getSnapshot().terminalStatus).toBe("cancelled");
	});

	it("peeks a retained child without mutating its budget or authority", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new MultiplexChild(cwd, "child-peek");
		const { runner } = createRunner(agentDir, [child]);
		const normalized = normalizeSubagentRequest(request(cwd, 25), cwd, { agentDir });

		const first = await runner.runResolved(normalized, [...PARENT_TOOLS], { model: fauxModel() });
		expect(first.status).toBe("needs_time");

		const before = runner.getRuntimeAttention(normalized.runId, normalized.parentSessionId);
		const observed = runner.peekRuntime(normalized.runId, normalized.parentSessionId);
		expect(observed?.childState).toBe("awaiting_extension");
		expect(observed?.terminal).toBe(false);
		expect(observed?.waitExpired).toBe(false);

		const after = runner.getRuntimeAttention(normalized.runId, normalized.parentSessionId);
		expect(after?.activeBudgetMs).toBe(before?.activeBudgetMs);
		expect(after?.remainingExtendableMs).toBe(before?.remainingExtendableMs);
		expect(child.promptCalls).toHaveLength(1);
	});

	it("detaches a foreground child and waits for its completion before the deadline", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new MultiplexChild(cwd, "child-wait");
		const { runner } = createRunner(agentDir, [child]);
		const normalized = normalizeSubagentRequest(request(cwd, 25), cwd, { agentDir });

		const first = await runner.runResolved(normalized, [...PARENT_TOOLS], { model: fauxModel() });
		expect(first.status).toBe("needs_time");

		const detached = runner.detachRuntime(normalized.runId, normalized.parentSessionId);
		expect(detached?.childState).toBe("running");
		expect(detached?.terminal).toBe(false);

		const observed = await runner.waitRuntime(normalized.runId, normalized.parentSessionId, 5_000);
		expect(observed.childState).toBe("completed");
		expect(observed.terminal).toBe(true);
		expect(observed.waitExpired).toBe(false);
		expect(observed.result?.status).toBe("completed");
		expect(child.promptCalls).toHaveLength(2);
	});

	it("keeps run identity stable across detach and retention", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new MultiplexChild(cwd, "child-identity");
		const { runner, sessionOptions } = createRunner(agentDir, [child]);
		const normalized = normalizeSubagentRequest(request(cwd, 25), cwd, { agentDir });

		const first = await runner.runResolved(normalized, [...PARENT_TOOLS], { model: fauxModel() });
		expect(first.status).toBe("needs_time");
		const detached = runner.detachRuntime(normalized.runId, normalized.parentSessionId);
		expect(detached?.runId).toBe(normalized.runId);

		const observed = await runner.waitRuntime(normalized.runId, normalized.parentSessionId, 5_000);
		const result = observed.result;
		expect(result?.runId).toBe(normalized.runId);
		expect(result?.childSessionId).toBe(child.sessionId);
		expect(result?.profile).toBe(first.profile);
		expect(result?.model).toBe(first.model);
		expect(result?.scopeTargets).toEqual(first.scopeTargets);
		// The retained child resumes its own session instead of a replacement.
		expect(child.promptCalls).toHaveLength(2);
		// Exactly one child session exists for the whole lifecycle, so retention
		// cannot have replaced the child or widened its effective tool authority.
		expect(sessionOptions).toHaveLength(1);
		const effectiveTools = [...(sessionOptions[0]?.tools ?? [])];
		expect(effectiveTools.length).toBeGreaterThan(0);
		for (const tool of effectiveTools) {
			expect(PARENT_TOOLS).toContain(tool as (typeof PARENT_TOOLS)[number]);
		}
	});

	it("reports management wait expiry without marking the child timed out", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new MultiplexChild(cwd, "child-expire", 9);
		const { runner } = createRunner(agentDir, [child]);
		const normalized = normalizeSubagentRequest(request(cwd, 25), cwd, { agentDir });

		const first = await runner.runResolved(normalized, [...PARENT_TOOLS], { model: fauxModel() });
		expect(first.status).toBe("needs_time");
		runner.detachRuntime(normalized.runId, normalized.parentSessionId);

		const observed = await runner.waitRuntime(normalized.runId, normalized.parentSessionId, 30);
		expect(observed.waitExpired).toBe(true);
		expect(observed.childState).toBe("running");
		expect(observed.terminal).toBe(false);
		expect(observed.result).toBeUndefined();

		// The child is still live and manageable; the expiry was the parent's window.
		const attention = runner.getRuntimeAttention(normalized.runId, normalized.parentSessionId);
		expect(attention?.state).toBe("running");
		// Stop terminalizes deterministically as cancellation: the aborted resumed
		// turn cannot downgrade an explicit parent decision into a generic failure.
		const stopped = await runner.stopRuntime(normalized.runId, normalized.parentSessionId);
		expect(stopped.status).toBe("cancelled");
		expect(runner.peekRuntime(normalized.runId, normalized.parentSessionId)?.childState).toBe("cancelled");
	});

	it("scopes peek and wait to the owning parent session", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new MultiplexChild(cwd, "child-owner");
		const { runner } = createRunner(agentDir, [child]);
		const normalized = normalizeSubagentRequest(request(cwd, 25), cwd, { agentDir });

		await runner.runResolved(normalized, [...PARENT_TOOLS], { model: fauxModel() });

		expect(runner.peekRuntime(normalized.runId, "other-session")).toBeUndefined();
		expect(runner.getRetainedManagedResult(normalized.runId, "other-session")).toBeUndefined();
		await expect(runner.waitRuntime(normalized.runId, "other-session", 1_000)).rejects.toThrow(
			/owned by this parent session/,
		);
		expect(runner.peekRuntime(normalized.runId, normalized.parentSessionId)?.childState).toBe("awaiting_extension");
	});

	it("rejects a management wait outside the bounded window", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new MultiplexChild(cwd, "child-bounds");
		const { runner } = createRunner(agentDir, [child]);
		const normalized = normalizeSubagentRequest(request(cwd, 25), cwd, { agentDir });

		await runner.runResolved(normalized, [...PARENT_TOOLS], { model: fauxModel() });

		await expect(runner.waitRuntime(normalized.runId, normalized.parentSessionId, 0)).rejects.toThrow(
			/Management wait/,
		);
		await expect(
			runner.waitRuntime(normalized.runId, normalized.parentSessionId, SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS + 1),
		).rejects.toThrow(/Management wait/);
	});

	it("multiplexes two managed children with independent completion", async () => {
		const { cwd, agentDir } = await workspace();
		const childA = new MultiplexChild(cwd, "child-a");
		const childB = new MultiplexChild(cwd, "child-b");
		const { runner } = createRunner(agentDir, [childA, childB]);
		const runA = normalizeSubagentRequest(request(cwd, 25), cwd, { agentDir });
		const runB = normalizeSubagentRequest(request(cwd, 25), cwd, { agentDir });
		expect(runA.runId).not.toBe(runB.runId);

		expect((await runner.runResolved(runA, [...PARENT_TOOLS], { model: fauxModel() })).status).toBe("needs_time");
		expect((await runner.runResolved(runB, [...PARENT_TOOLS], { model: fauxModel() })).status).toBe("needs_time");

		// Peek B without touching it, then detach and wait on A alone.
		const peekedB = runner.peekRuntime(runB.runId, runB.parentSessionId);
		expect(peekedB?.childState).toBe("awaiting_extension");
		expect(peekedB?.terminal).toBe(false);

		runner.detachRuntime(runA.runId, runA.parentSessionId);
		const waitedA = await runner.waitRuntime(runA.runId, runA.parentSessionId, 5_000);
		expect(waitedA.childState).toBe("completed");
		expect(waitedA.result?.runId).toBe(runA.runId);

		// B stays untouched while A completes.
		expect(runner.peekRuntime(runB.runId, runB.parentSessionId)?.childState).toBe("awaiting_extension");
		expect(childB.promptCalls).toHaveLength(1);

		// B completes independently once it is retained and awaited.
		runner.detachRuntime(runB.runId, runB.parentSessionId);
		const waitedB = await runner.waitRuntime(runB.runId, runB.parentSessionId, 5_000);
		expect(waitedB.childState).toBe("completed");
		expect(waitedB.result?.runId).toBe(runB.runId);
		expect(childB.promptCalls).toHaveLength(2);
	});

	it("returns a managed handle at launch and completes without the hard timeout", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new MultiplexChild(cwd, "child-launch", 1, 750);
		const { runner } = createRunner(agentDir, [child]);
		const normalized = normalizeSubagentRequest(request(cwd, 60_000), cwd, { agentDir });
		const handles: SubagentManagedHandle[] = [];

		const run = runner.runResolved(normalized, [...PARENT_TOOLS], {
			model: fauxModel(),
			onManagedHandle: (handle) => handles.push(handle),
		});
		// Admission arrives while the child is still working, far inside its budget.
		await waitFor(() => expect(handles).toHaveLength(1));
		expect(handles[0]?.runId).toBe(normalized.runId);
		expect(handles[0]?.childSessionId).toBe(child.sessionId);

		const live = runner.peekRuntime(normalized.runId, normalized.parentSessionId);
		expect(live?.childState).toBe("running");
		expect(live?.terminal).toBe(false);
		expect(child.promptCalls.length).toBeLessThanOrEqual(1);

		const observed = await runner.waitRuntime(normalized.runId, normalized.parentSessionId, 10_000);
		expect(observed.childState).toBe("completed");
		expect(observed.waitExpired).toBe(false);
		expect(observed.result?.status).toBe("completed");
		expect(observed.result?.runId).toBe(normalized.runId);
		expect(observed.result?.childSessionId).toBe(child.sessionId);
		// One admission handle and one initial task prompt: no replay, no replacement.
		expect(handles).toHaveLength(1);
		expect(child.promptCalls).toHaveLength(1);
		expect((await run).runId).toBe(normalized.runId);
	});

	it("keeps a managed child alive after the launching call abandons its promise", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new MultiplexChild(cwd, "child-abandoned-launch", 1, 400);
		const { runner } = createRunner(agentDir, [child]);
		const normalized = normalizeSubagentRequest(request(cwd, 60_000), cwd, { agentDir });
		const handles: SubagentManagedHandle[] = [];
		const published = vi.fn(async (_result: SubagentResult) => undefined);
		let launchSettled = false;
		const run = runner
			.runResolved(normalized, [...PARENT_TOOLS], {
				model: fauxModel(),
				onManagedHandle: (handle) => handles.push(handle),
				onManagedResult: published,
			})
			.finally(() => {
				launchSettled = true;
			});
		// The launching tool call returns at admission, so the caller stops awaiting
		// the run; the retained child must keep going without the launch promise.
		void run.catch(() => undefined);
		await waitFor(() => expect(handles).toHaveLength(1));
		expect(handles[0]?.runId).toBe(normalized.runId);
		expect(handles[0]?.childSessionId).toBe(child.sessionId);
		expect(launchSettled).toBe(false);
		expect(runner.peekRuntime(normalized.runId, normalized.parentSessionId)?.childState).toBe("running");
		// Nothing awaits the run promise, yet the child still finishes and publishes once.
		await waitFor(() => expect(published).toHaveBeenCalledTimes(1));
		expect(published.mock.calls[0]?.[0]).toMatchObject({ runId: normalized.runId, status: "completed" });
		const observed = runner.peekRuntime(normalized.runId, normalized.parentSessionId);
		expect(observed?.childState).toBe("completed");
		expect(observed?.terminal).toBe(true);
		expect(child.promptCalls).toHaveLength(1);
		expect(handles).toHaveLength(1);
		await run;
	});

	it("retains a running child in place without changing any budget", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new MultiplexChild(cwd, "child-inplace", 1, 750);
		const { runner, sessionOptions } = createRunner(agentDir, [child]);
		const normalized = normalizeSubagentRequest(request(cwd, 60_000), cwd, { agentDir });

		const run = runner.runResolved(normalized, [...PARENT_TOOLS], { model: fauxModel() });
		await waitFor(() =>
			expect(runner.peekRuntime(normalized.runId, normalized.parentSessionId)?.childState).toBe("running"),
		);
		const before = runner.getRuntimeAttention(normalized.runId, normalized.parentSessionId);
		const detached = runner.detachRuntime(normalized.runId, normalized.parentSessionId);
		expect(detached?.childState).toBe("running");
		const after = runner.getRuntimeAttention(normalized.runId, normalized.parentSessionId);
		expect(after?.activeBudgetMs).toBe(before?.activeBudgetMs);
		expect(after?.remainingExtendableMs).toBe(before?.remainingExtendableMs);
		expect(after?.remainingRetentionMs).toBe(before?.remainingRetentionMs);
		// Idempotent: a second detach keeps the same run and the same budgets.
		expect(runner.detachRuntime(normalized.runId, normalized.parentSessionId)?.childState).toBe("running");
		expect(sessionOptions).toHaveLength(1);

		const observed = await runner.waitRuntime(normalized.runId, normalized.parentSessionId, 10_000);
		expect(observed.childState).toBe("completed");
		expect(child.promptCalls).toHaveLength(1);
		await run;
	});

	it("resumes a detached paused child from the retention pool, not the extension reserve", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new MultiplexChild(cwd, "child-retention");
		const { runner } = createRunner(agentDir, [child]);
		const normalized = normalizeSubagentRequest(request(cwd, 25), cwd, { agentDir });

		expect((await runner.runResolved(normalized, [...PARENT_TOOLS], { model: fauxModel() })).status).toBe(
			"needs_time",
		);
		const before = runner.getRuntimeAttention(normalized.runId, normalized.parentSessionId);
		const beforeExtendable = before?.remainingExtendableMs ?? 0;
		const beforeRetention = before?.remainingRetentionMs ?? 0;
		expect(beforeExtendable).toBeGreaterThan(0);
		expect(beforeRetention).toBeGreaterThan(0);

		runner.detachRuntime(normalized.runId, normalized.parentSessionId);
		const after = runner.getRuntimeAttention(normalized.runId, normalized.parentSessionId);
		// Detach draws on its own bounded pool; the extension reserve is untouched.
		expect(after?.remainingExtendableMs).toBe(beforeExtendable);
		expect(after?.remainingRetentionMs ?? 0).toBeLessThan(beforeRetention);

		const observed = await runner.waitRuntime(normalized.runId, normalized.parentSessionId, 5_000);
		expect(observed.childState).toBe("completed");
		expect(child.promptCalls).toHaveLength(2);
	});

	it("publishes exactly one managed terminal result across detach, wait, and repeated peek", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new MultiplexChild(cwd, "child-once");
		const { runner } = createRunner(agentDir, [child]);
		const normalized = normalizeSubagentRequest(request(cwd, 25), cwd, { agentDir });
		const published = vi.fn(async (_result: SubagentResult) => undefined);

		const first = await runner.runResolved(normalized, [...PARENT_TOOLS], {
			model: fauxModel(),
			onManagedResult: published,
		});
		expect(first.status).toBe("needs_time");
		expect(published).not.toHaveBeenCalled();

		runner.detachRuntime(normalized.runId, normalized.parentSessionId);
		const observed = await runner.waitRuntime(normalized.runId, normalized.parentSessionId, 5_000);
		expect(observed.childState).toBe("completed");
		// The retained result is already observable when the terminal state is.
		expect(runner.getRetainedManagedResult(normalized.runId, normalized.parentSessionId)?.status).toBe("completed");

		// The durable observer fires exactly once; late observation cannot republish.
		await waitFor(() => expect(published).toHaveBeenCalledTimes(1));
		runner.peekRuntime(normalized.runId, normalized.parentSessionId);
		runner.getRetainedManagedResult(normalized.runId, normalized.parentSessionId);
		expect(published).toHaveBeenCalledTimes(1);
		expect(published.mock.calls[0]?.[0]).toMatchObject({ runId: normalized.runId, status: "completed" });
	});

	it("cancels a detached child deterministically with one publication and idempotent stop", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new MultiplexChild(cwd, "child-stop", 9);
		const { runner } = createRunner(agentDir, [child]);
		const normalized = normalizeSubagentRequest(request(cwd, 25), cwd, { agentDir });
		const published = vi.fn(async (_result: SubagentResult) => undefined);

		expect(
			(
				await runner.runResolved(normalized, [...PARENT_TOOLS], {
					model: fauxModel(),
					onManagedResult: published,
				})
			).status,
		).toBe("needs_time");
		runner.detachRuntime(normalized.runId, normalized.parentSessionId);

		// Two concurrent stops race the in-flight retained continuation.
		const [stopped] = await Promise.all([
			runner.stopRuntime(normalized.runId, normalized.parentSessionId),
			runner.stopRuntime(normalized.runId, normalized.parentSessionId),
		]);
		expect(stopped.status).toBe("cancelled");
		expect(runner.peekRuntime(normalized.runId, normalized.parentSessionId)?.childState).toBe("cancelled");
		expect(runner.getRetainedManagedResult(normalized.runId, normalized.parentSessionId)?.status).toBe("cancelled");
		expect(published).toHaveBeenCalledTimes(1);
		// Idempotent: stopping an already settled run reports the same cancellation.
		expect((await runner.stopRuntime(normalized.runId, normalized.parentSessionId)).status).toBe("cancelled");
		expect(published).toHaveBeenCalledTimes(1);
	});
});
