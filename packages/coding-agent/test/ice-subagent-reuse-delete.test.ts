import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { CreateAgentSessionResult } from "../src/core/sdk.ts";
import { SubagentRunSupervisorRegistry } from "../src/ice-subagent-timeout-supervisor.ts";
import {
	NativeSubagentRunner,
	normalizeSubagentRequest,
	type SubagentRequest,
	type SubagentResult,
	subagentMcpToolName,
} from "../src/ice-subagents.ts";

const tempDirs: string[] = [];
const PARENT_SESSION = "parent-session";
const ACTIVE_TOOLS = ["delegate", "read", "grep", "find", "ls"] as const;
const FAUX_MODEL = { provider: "faux", id: "faux" } as Model<Api>;

function assistantMessage(text: string): AgentMessage {
	return { role: "assistant", content: text, stopReason: "stop" } as unknown as AgentMessage;
}

interface ChildGate {
	wait: Promise<void>;
	onStart: () => void;
	/** 1-based prompt index to hold open; defaults to the first turn. */
	at?: number;
}

/**
 * Minimal child session that answers every turn with a valid bounded report envelope.
 * An optional gate holds the first turn open so active-child management can be exercised.
 */
class ReusableChildSession {
	readonly sessionId = "child-session";
	readonly model = FAUX_MODEL;
	readonly messages: AgentMessage[] = [];
	readonly promptCalls: string[] = [];
	readonly dispose = vi.fn();
	readonly abort = vi.fn(async () => {
		this.isStreaming = false;
	});
	readonly getSessionStats = vi.fn(() => ({
		tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
		cost: 0.5,
	}));
	readonly extensionRunner = { hasHandlers: vi.fn(() => false), emit: vi.fn(async () => undefined) };
	readonly sessionManager: { getCwd: () => string };
	isStreaming = false;
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly cwd: string;
	private readonly gate: ChildGate | undefined;

	constructor(cwd: string, gate?: ChildGate) {
		this.cwd = cwd;
		this.gate = gate;
		this.sessionManager = { getCwd: () => this.cwd };
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		this.promptCalls.push(text);
		const gateAt = this.gate?.at ?? 1;
		if (this.gate && this.promptCalls.length === gateAt) {
			this.isStreaming = true;
			this.gate.onStart();
			await this.gate.wait;
			this.isStreaming = false;
		}
		this.messages.push(
			assistantMessage(`{"summary":"report ${this.promptCalls.length}","evidence":{"paths":["src"]}}`),
		);
	}
}

/** Child session used to verify that failed terminal runs remain history-only and deletable. */
class FailingChildSession extends ReusableChildSession {
	async prompt(text: string): Promise<void> {
		this.promptCalls.push(text);
		throw new Error("synthetic child failure");
	}
}

/**
 * Child session that exposes an `agent`, so the real session-creation path installs its
 * stream/stop policy wrappers. Used to prove that a reused session dispatches through the
 * resumed run's policy instead of the closures installed by its original run.
 */
class PolicyProbeChildSession extends ReusableChildSession {
	readonly agent: { streamFunction: () => Promise<void> } = { streamFunction: async () => undefined };
}

async function createWorkspace(): Promise<{ cwd: string; agentDir: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "ice-reuse-delete-"));
	const agentDir = await mkdtemp(join(tmpdir(), "ice-reuse-delete-agent-"));
	tempDirs.push(cwd, agentDir);
	await mkdir(join(cwd, "src"));
	return { cwd, agentDir };
}

function request(cwd: string): SubagentRequest {
	return {
		parentSessionId: PARENT_SESSION,
		role: "self",
		self: { instructions: "Inspect the scoped repository and preserve concrete evidence." },
		task: "Inspect the scoped repository.",
		scope: { roots: ["src"] },
		cwd,
	};
}

interface Harness {
	runner: NativeSubagentRunner;
	cwd: string;
	agentDir: string;
	child: ReusableChildSession;
	runId: string;
}

async function runToCompletion(options: { gate?: ChildGate } = {}): Promise<Harness> {
	const { cwd, agentDir } = await createWorkspace();
	const child = new ReusableChildSession(cwd, options.gate);
	const runner = new NativeSubagentRunner({
		agentDir,
		// Runtime management owns supervisor ownership, which the active-child guard depends on.
		supervisorRegistry: new SubagentRunSupervisorRegistry(),
		createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
	});
	const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
	const result = await runner.runResolved(normalized, [...ACTIVE_TOOLS], { model: FAUX_MODEL });
	expect(result.status).toBe("completed");
	return { runner, cwd, agentDir, child, runId: normalized.runId };
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ICE subagent reuse and delete", () => {
	it("retains a completed child instead of destroying its session", async () => {
		const { runner, child, runId } = await runToCompletion();
		expect(child.dispose).not.toHaveBeenCalled();
		expect(runner.listRetainedChildren(PARENT_SESSION)).toEqual([
			{ runId, role: "self", terminalStatus: "completed", finishedAt: expect.any(Number), resumeCount: 0 },
		]);
	});

	it("resumes a completed child in its original session with new lineage", async () => {
		const { runner, child, runId } = await runToCompletion();
		expect(child.promptCalls).toHaveLength(1);

		const resumed = await runner.resumeRuntime(runId, PARENT_SESSION, "Report the follow-up.", [...ACTIVE_TOOLS]);

		expect(resumed.status).toBe("completed");
		// The same child session object continued; only the new instruction was appended.
		expect(child.promptCalls).toHaveLength(2);
		expect(child.promptCalls[1]).toBe("Report the follow-up.");
		// Prior child history is preserved across the reuse.
		expect(child.messages).toHaveLength(2);
		// New run identity plus provenance keeps verification lineage sound.
		expect(resumed.runId).not.toBe(runId);
		expect(resumed.resumedFromRunId).toBe(runId);
		expect(resumed.profile).toBe("self");
		// The superseded handle is replaced, not duplicated.
		expect(runner.listRetainedChildren(PARENT_SESSION).map((entry) => entry.runId)).toEqual([resumed.runId]);
		expect(runner.listRetainedChildren(PARENT_SESSION)[0]?.resumeCount).toBe(1);
	});

	it("multiplexes a live child, resumes the same session, and deletes all terminal state", async () => {
		let releaseFirst!: () => void;
		const firstTurn = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstStarted!: () => void;
		const firstStartedPromise = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		let releaseSecond!: () => void;
		const secondTurn = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		let secondStarted!: () => void;
		const secondStartedPromise = new Promise<void>((resolve) => {
			secondStarted = resolve;
		});
		const { cwd, agentDir } = await createWorkspace();
		const gate: ChildGate = { wait: firstTurn, onStart: firstStarted, at: 1 };
		const child = new ReusableChildSession(cwd, gate);
		const supervisorRegistry = new SubagentRunSupervisorRegistry<SubagentResult>();
		const runner = new NativeSubagentRunner({
			agentDir,
			supervisorRegistry,
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		const runPromise = runner.runResolved(normalized, [...ACTIVE_TOOLS], { model: FAUX_MODEL });
		await firstStartedPromise;

		expect(runner.peekRuntime(normalized.runId, PARENT_SESSION)).toMatchObject({
			childState: "running",
			terminal: false,
		});
		expect(runner.detachRuntime(normalized.runId, PARENT_SESSION)).toMatchObject({
			childState: "running",
			terminal: false,
		});
		expect(await runner.waitRuntime(normalized.runId, PARENT_SESSION, 1)).toMatchObject({ waitExpired: true });
		expect(runner.peekRuntime(normalized.runId, PARENT_SESSION)).toMatchObject({
			childState: "running",
			terminal: false,
		});

		releaseFirst();
		expect((await runPromise).status).toBe("completed");
		expect(runner.peekRuntime(normalized.runId, PARENT_SESSION)).toMatchObject({
			childState: "completed",
			terminal: true,
		});
		gate.wait = secondTurn;
		gate.onStart = secondStarted;
		gate.at = 2;

		// The resumed execution keeps the original child session and gets a fresh managed handle.
		const resumePromise = runner.resumeRuntime(normalized.runId, PARENT_SESSION, "Continue the same task.", [
			...ACTIVE_TOOLS,
		]);
		await secondStartedPromise;
		expect(runner.listRetainedChildren(PARENT_SESSION)).toHaveLength(0);
		const resumedRunId = supervisorRegistry.list()[0]?.runId;
		expect(resumedRunId).toBeDefined();
		expect(runner.peekRuntime(resumedRunId!, PARENT_SESSION)).toMatchObject({
			childState: "running",
			terminal: false,
		});
		expect(runner.detachRuntime(resumedRunId!, PARENT_SESSION)).toMatchObject({
			childState: "running",
			terminal: false,
		});
		expect(await runner.waitRuntime(resumedRunId!, PARENT_SESSION, 1)).toMatchObject({ waitExpired: true });
		releaseSecond();
		expect((await resumePromise).status).toBe("completed");
		expect(resumedRunId).toBeDefined();
		expect(runner.peekRuntime(resumedRunId!, PARENT_SESSION)).toMatchObject({
			childState: "completed",
			terminal: true,
		});
		expect(await runner.deleteRetainedChild(resumedRunId!, PARENT_SESSION)).toEqual({
			runId: resumedRunId,
			deleted: true,
		});
		expect(runner.listRetainedChildren(PARENT_SESSION)).toHaveLength(0);
		expect(runner.getRetainedManagedResult(resumedRunId!, PARENT_SESSION)).toBeUndefined();
		expect(runner.peekRuntime(resumedRunId!, PARENT_SESSION)).toBeUndefined();
		expect(child.dispose).toHaveBeenCalledTimes(1);
	});

	it("deletes a retained child idempotently and releases its session", async () => {
		const { runner, child, runId } = await runToCompletion();

		expect(await runner.deleteRetainedChild(runId, PARENT_SESSION)).toEqual({ runId, deleted: true });
		expect(child.dispose).toHaveBeenCalledTimes(1);
		expect(runner.listRetainedChildren(PARENT_SESSION)).toHaveLength(0);

		// A second delete is a no-op, not an error, and does not double-dispose.
		expect(await runner.deleteRetainedChild(runId, PARENT_SESSION)).toEqual({ runId, deleted: false });
		expect(child.dispose).toHaveBeenCalledTimes(1);
	});

	it("scopes resume and delete to the owning parent session", async () => {
		const { runner, runId } = await runToCompletion();

		await expect(
			runner.resumeRuntime(runId, "other-parent", "steal the child", [...ACTIVE_TOOLS]),
		).rejects.toMatchObject({ code: "child_protocol_failure" });
		await expect(runner.deleteRetainedChild(runId, "other-parent")).rejects.toMatchObject({
			code: "child_protocol_failure",
		});

		// The real owner's retained state is untouched.
		expect(runner.listRetainedChildren(PARENT_SESSION)).toHaveLength(1);
	});

	it("fails closed on unknown, stale, or deleted handles", async () => {
		const { agentDir } = await createWorkspace();
		const runner = new NativeSubagentRunner({ agentDir });

		await expect(
			runner.resumeRuntime("missing-run", PARENT_SESSION, "hello", [...ACTIVE_TOOLS]),
		).rejects.toMatchObject({ code: "child_protocol_failure" });
		expect(await runner.deleteRetainedChild("missing-run", PARENT_SESSION)).toEqual({
			runId: "missing-run",
			deleted: false,
		});

		// A deleted handle does not resurrect through the retained registry.
		const { runner: liveRunner, runId } = await runToCompletion();
		await liveRunner.deleteRetainedChild(runId, PARENT_SESSION);
		await expect(liveRunner.resumeRuntime(runId, PARENT_SESSION, "again", [...ACTIVE_TOOLS])).rejects.toMatchObject({
			code: "child_protocol_failure",
		});
	});

	it("refuses to delete an active child and asks for stop first", async () => {
		let releaseTurn!: () => void;
		const wait = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const { cwd, agentDir } = await createWorkspace();
		const child = new ReusableChildSession(cwd, { wait, onStart: markStarted });
		const runner = new NativeSubagentRunner({
			agentDir,
			supervisorRegistry: new SubagentRunSupervisorRegistry(),
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		const runPromise = runner.runResolved(normalized, [...ACTIVE_TOOLS], { model: FAUX_MODEL });
		await started;

		await expect(runner.deleteRetainedChild(normalized.runId, PARENT_SESSION)).rejects.toThrow(
			/stop it before deleting/,
		);

		releaseTurn();
		expect((await runPromise).status).toBe("completed");
		// Once terminal it becomes deletable.
		expect(await runner.deleteRetainedChild(normalized.runId, PARENT_SESSION)).toEqual({
			runId: normalized.runId,
			deleted: true,
		});
	});

	it("bounds the resume instruction", async () => {
		const { runner, runId } = await runToCompletion();

		await expect(runner.resumeRuntime(runId, PARENT_SESSION, "   ", [...ACTIVE_TOOLS])).rejects.toMatchObject({
			code: "malformed_result",
		});
		await expect(
			runner.resumeRuntime(runId, PARENT_SESSION, "x".repeat(8 * 1024 + 1), [...ACTIVE_TOOLS]),
		).rejects.toMatchObject({ code: "malformed_result" });
		// Rejected attempts do not consume reuse budget.
		expect(runner.listRetainedChildren(PARENT_SESSION)[0]?.resumeCount).toBe(0);
	});

	it("bounds retained terminal children and evicts the oldest first", async () => {
		const { cwd, agentDir } = await createWorkspace();
		const children: ReusableChildSession[] = [];
		const runner = new NativeSubagentRunner({
			agentDir,
			supervisorRegistry: new SubagentRunSupervisorRegistry(),
			createSession: async () => {
				const child = new ReusableChildSession(cwd);
				children.push(child);
				return { session: child } as unknown as CreateAgentSessionResult;
			},
		});

		const runIds: string[] = [];
		for (let index = 0; index < 9; index += 1) {
			const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
			runIds.push(normalized.runId);
			expect((await runner.runResolved(normalized, [...ACTIVE_TOOLS], { model: FAUX_MODEL })).status).toBe(
				"completed",
			);
		}

		const retained = runner.listRetainedChildren(PARENT_SESSION);
		expect(retained).toHaveLength(8);
		expect(retained.map((entry) => entry.runId)).not.toContain(runIds[0]);
		expect(retained.at(-1)?.runId).toBe(runIds[8]);
		// The evicted session is released rather than leaked.
		expect(children[0]?.dispose).toHaveBeenCalledTimes(1);
		expect(children[8]?.dispose).not.toHaveBeenCalled();
	});

	it("stops reusing a retained child once its reuse limit is reached", async () => {
		const { runner, runId } = await runToCompletion();
		let current = runId;
		for (let cycle = 0; cycle < 8; cycle += 1) {
			const resumed = await runner.resumeRuntime(current, PARENT_SESSION, `cycle ${cycle}`, [...ACTIVE_TOOLS]);
			expect(resumed.status).toBe("completed");
			current = resumed.runId;
		}
		await expect(runner.resumeRuntime(current, PARENT_SESSION, "one too many", [...ACTIVE_TOOLS])).rejects.toThrow(
			/reuse limit/,
		);
		// Delete remains available once reuse is exhausted.
		expect(await runner.deleteRetainedChild(current, PARENT_SESSION)).toEqual({ runId: current, deleted: true });
	});

	it("fails closed before any resumed turn when authority no longer validates", async () => {
		const { runner, child, runId } = await runToCompletion();
		const promptsBefore = child.promptCalls.length;

		await expect(
			runner.resumeRuntime(runId, PARENT_SESSION, "Continue.", [...ACTIVE_TOOLS], {
				isAuthorityStillValidFor: () => false,
			}),
		).rejects.toMatchObject({ code: "capability_denied" });

		// Revocation is rejected at the reuse boundary: no resumed model turn is issued, the
		// child is not disposed, and the handle is not consumed.
		expect(child.promptCalls).toHaveLength(promptsBefore);
		expect(child.dispose).not.toHaveBeenCalled();
		expect(runner.listRetainedChildren(PARENT_SESSION)).toEqual([
			expect.objectContaining({ runId, terminalStatus: "completed", resumeCount: 0 }),
		]);

		// The handle stays usable once authority validates again.
		const resumed = await runner.resumeRuntime(runId, PARENT_SESSION, "Continue.", [...ACTIVE_TOOLS]);
		expect(resumed.status).toBe("completed");
		expect(child.promptCalls).toHaveLength(promptsBefore + 1);
	});

	it("refuses to resume when the parent no longer activates the child's tools", async () => {
		const { runner, runId } = await runToCompletion();

		// Reuse must not preserve authority the current parent policy has since removed.
		await expect(runner.resumeRuntime(runId, PARENT_SESSION, "Continue.", [])).rejects.toMatchObject({
			code: "capability_denied",
		});
		expect(runner.listRetainedChildren(PARENT_SESSION)[0]).toMatchObject({
			runId,
			terminalStatus: "completed",
			resumeCount: 0,
		});
	});

	it("reuses the retained model, profile, and authority unchanged", async () => {
		const { runner, runId } = await runToCompletion();
		const before = runner.listRetainedChildren(PARENT_SESSION)[0];

		const resumed = await runner.resumeRuntime(runId, PARENT_SESSION, "Continue.", [...ACTIVE_TOOLS]);

		// Model and profile come from the retained child, never from the resume call.
		expect(resumed.model).toBe("faux/faux");
		expect(resumed.profile).toBe(before?.role);
		expect(resumed.source).toBe("self");
		expect(runner.listRetainedChildren(PARENT_SESSION)[0]?.resumeCount).toBe(1);
	});

	it("does not consume a retained handle when resume is cancelled before startup", async () => {
		const { runner, child, runId } = await runToCompletion();
		const controller = new AbortController();
		controller.abort();
		const promptsBefore = child.promptCalls.length;

		await expect(
			runner.resumeRuntime(runId, PARENT_SESSION, "Continue.", [...ACTIVE_TOOLS], { signal: controller.signal }),
		).rejects.toMatchObject({ code: "cancellation" });
		expect(child.promptCalls).toHaveLength(promptsBefore);
		expect(runner.listRetainedChildren(PARENT_SESSION)).toEqual([
			expect.objectContaining({ runId, terminalStatus: "completed", resumeCount: 0 }),
		]);

		const resumed = await runner.resumeRuntime(runId, PARENT_SESSION, "Continue.", [...ACTIVE_TOOLS]);
		expect(resumed.status).toBe("completed");
	});

	it("does not consume a retained handle when delegation is removed before startup", async () => {
		const { runner, child, runId } = await runToCompletion();
		const promptsBefore = child.promptCalls.length;
		const withoutDelegate = ACTIVE_TOOLS.filter((tool) => tool !== "delegate");

		await expect(runner.resumeRuntime(runId, PARENT_SESSION, "Continue.", withoutDelegate)).rejects.toMatchObject({
			code: "capability_denied",
		});
		expect(child.promptCalls).toHaveLength(promptsBefore);
		expect(runner.listRetainedChildren(PARENT_SESSION)).toEqual([
			expect.objectContaining({ runId, terminalStatus: "completed", resumeCount: 0 }),
		]);

		const resumed = await runner.resumeRuntime(runId, PARENT_SESSION, "Continue.", [...ACTIVE_TOOLS]);
		expect(resumed.status).toBe("completed");
	});

	it("resumes MCP-backed retained children and fails closed after MCP authority revocation", async () => {
		const selector = "search/docs";
		let authorityCurrent = true;
		const { cwd, agentDir } = await createWorkspace();
		const child = new ReusableChildSession(cwd);
		const runner = new NativeSubagentRunner({
			agentDir,
			supervisorRegistry: new SubagentRunSupervisorRegistry(),
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const mcpRequest = request(cwd);
		mcpRequest.self = { ...mcpRequest.self!, mcp: [selector] };
		const normalized = normalizeSubagentRequest(mcpRequest, cwd, { agentDir });
		normalized.mcpAuthorizations = Object.freeze([
			{ selector, access: "read-only", parameters: Type.Object({}, { additionalProperties: false }) },
		]);
		normalized.mcpAuthorityStillValid = () => authorityCurrent;
		const mcpRuntime = {
			mcpDispatch: async () => ({ ok: true }),
			parentMcpTools: [selector],
			mcpToolAccess: new Map([[selector, "read-only" as const]]),
		};

		const first = await runner.runResolved(normalized, [...ACTIVE_TOOLS], { model: FAUX_MODEL, ...mcpRuntime });
		expect(first.status).toBe("completed");
		expect(subagentMcpToolName(selector)).not.toBe(selector);

		const resumed = await runner.resumeRuntime(normalized.runId, PARENT_SESSION, "Continue.", [...ACTIVE_TOOLS], {
			...mcpRuntime,
		});
		expect(resumed.status).toBe("completed");

		authorityCurrent = false;
		await expect(
			runner.resumeRuntime(resumed.runId, PARENT_SESSION, "Again.", [...ACTIVE_TOOLS], { ...mcpRuntime }),
		).rejects.toMatchObject({ code: "capability_denied" });
	});

	it("rejects a concurrent resume and a delete while a reuse is in flight", async () => {
		let releaseResume!: () => void;
		const resumeTurn = new Promise<void>((resolve) => {
			releaseResume = resolve;
		});
		let markResumeStarted!: () => void;
		const resumeStarted = new Promise<void>((resolve) => {
			markResumeStarted = resolve;
		});
		const { runner, child, runId } = await runToCompletion({
			gate: { wait: resumeTurn, onStart: markResumeStarted, at: 2 },
		});

		const resumePromise = runner.resumeRuntime(runId, PARENT_SESSION, "Follow-up.", [...ACTIVE_TOOLS]);
		await resumeStarted;

		// The superseded handle is claimed for the duration of the reuse, so neither a second
		// resume nor a delete may reach the session that is currently executing.
		await expect(runner.resumeRuntime(runId, PARENT_SESSION, "Again.", [...ACTIVE_TOOLS])).rejects.toThrow(
			/already resuming/,
		);
		await expect(runner.deleteRetainedChild(runId, PARENT_SESSION)).rejects.toThrow(/stop it before deleting/);

		releaseResume();
		const resumed = await resumePromise;
		expect(resumed.status).toBe("completed");
		expect(child.dispose).not.toHaveBeenCalled();
		// Exactly one terminal handle is republished, under the new execution run id.
		expect(runner.listRetainedChildren(PARENT_SESSION).map((entry) => entry.runId)).toEqual([resumed.runId]);
	});

	it("awaits retained session disposal on shutdown", async () => {
		const { runner, child } = await runToCompletion();
		await runner.shutdown();
		expect(child.dispose).toHaveBeenCalledTimes(1);
		expect(runner.listRetainedChildren(PARENT_SESSION)).toHaveLength(0);
	});

	it("dispatches a reused child's wrapped tools through the resumed run's policy", async () => {
		type WrappedTool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
		// The original run's authority always validates, so a wrapper still bound to the original run's
		// policy could never deny. Only the resumed run revokes, and only after the boundary check.
		let revoked = false;
		let releaseResume!: () => void;
		const resumeTurn = new Promise<void>((resolve) => {
			releaseResume = resolve;
		});
		let capturedTools: readonly WrappedTool[] = [];
		let createSessionCalls = 0;
		const { cwd, agentDir } = await createWorkspace();
		const child = new PolicyProbeChildSession(cwd, {
			wait: resumeTurn,
			at: 2,
			onStart: () => {
				// Authority held at the reuse boundary and is revoked once the resumed turn is running.
				revoked = true;
				releaseResume();
			},
		});
		const createSession = async (options: unknown) => {
			createSessionCalls += 1;
			capturedTools = ((options as { customTools?: unknown }).customTools ?? []) as readonly WrappedTool[];
			return { session: child } as unknown as CreateAgentSessionResult;
		};
		const runner = new NativeSubagentRunner({
			agentDir,
			supervisorRegistry: new SubagentRunSupervisorRegistry(),
			createSession,
		});
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		const first = await runner.runResolved(normalized, [...ACTIVE_TOOLS], {
			model: FAUX_MODEL,
			isAuthorityStillValid: () => true,
		});
		expect(first.status).toBe("completed");
		expect(createSessionCalls).toBe(1);

		const probe = capturedTools.find((definition) => definition.name === "read");
		expect(probe).toBeDefined();

		const resumed = await runner.resumeRuntime(normalized.runId, PARENT_SESSION, "Continue.", [...ACTIVE_TOOLS], {
			isAuthorityStillValidFor: () => !revoked,
		});
		// The reused session's own turn-stop wrapper consulted the RESUMED run's authority policy and
		// failed the run at the next safe boundary. A stale wrapper would have seen the original run's
		// always-valid authority and completed normally.
		expect(resumed.status).toBe("failed");
		expect(resumed.diagnostics?.some((diagnostic) => diagnostic.code === "capability_denied")).toBe(true);
		// Resume reused the retained session instead of rebuilding it, so `probe` is still the very
		// wrapper the original run installed.
		expect(createSessionCalls).toBe(1);
		// A revoked reuse is retained as history-only under its fresh run identity, but cannot be reused.
		expect(runner.listRetainedChildren(PARENT_SESSION)).toEqual([
			expect.objectContaining({ runId: resumed.runId, terminalStatus: "failed" }),
		]);
		expect(runner.peekRuntime(normalized.runId, PARENT_SESSION)).toBeUndefined();

		// The original wrapper now reads the resumed run's authority, which no longer validates.
		const dispatched = await probe!.execute("probe-call", { path: "src" }, undefined, undefined, undefined).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(dispatched).toMatchObject({ code: "capability_denied" });
		expect((dispatched as Error).message).toMatch(/no longer authorize this child tool dispatch/);
		await expect(
			runner.resumeRuntime(resumed.runId, PARENT_SESSION, "again", [...ACTIVE_TOOLS]),
		).rejects.toMatchObject({
			code: "child_protocol_failure",
		});
		expect(await runner.deleteRetainedChild(resumed.runId, PARENT_SESSION)).toEqual({
			runId: resumed.runId,
			deleted: true,
		});
		expect(child.dispose).toHaveBeenCalledTimes(1);
	});

	it("retains failed children as history-only entries", async () => {
		const { cwd, agentDir } = await createWorkspace();
		const child = new FailingChildSession(cwd);
		const runner = new NativeSubagentRunner({
			agentDir,
			supervisorRegistry: new SubagentRunSupervisorRegistry(),
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		const result = await runner.runResolved(normalized, [...ACTIVE_TOOLS], { model: FAUX_MODEL });

		expect(result.status).toBe("failed");
		expect(runner.listRetainedChildren(PARENT_SESSION)).toEqual([
			expect.objectContaining({ runId: normalized.runId, terminalStatus: "failed", resumeCount: 0 }),
		]);
		expect(runner.peekRuntime(normalized.runId, PARENT_SESSION)).toMatchObject({
			childState: "failed",
			terminal: true,
			result: expect.objectContaining({ status: "failed" }),
		});
		expect(() => runner.detachRuntime(normalized.runId, PARENT_SESSION)).toThrow(/already terminal/);
		await expect(
			runner.resumeRuntime(normalized.runId, PARENT_SESSION, "again", [...ACTIVE_TOOLS]),
		).rejects.toMatchObject({ code: "child_protocol_failure" });
		expect(await runner.deleteRetainedChild(normalized.runId, PARENT_SESSION)).toEqual({
			runId: normalized.runId,
			deleted: true,
		});
		expect(child.dispose).toHaveBeenCalledTimes(1);
	});

	it("stops a live child and then deletes it without a retained handle", async () => {
		let releaseTurn!: () => void;
		const wait = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const { cwd, agentDir } = await createWorkspace();
		const child = new ReusableChildSession(cwd, { wait, onStart: markStarted });
		const runner = new NativeSubagentRunner({
			agentDir,
			supervisorRegistry: new SubagentRunSupervisorRegistry(),
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		const runPromise = runner.runResolved(normalized, [...ACTIVE_TOOLS], { model: FAUX_MODEL });
		await started;

		expect((await runner.stopRuntime(normalized.runId, PARENT_SESSION)).status).toBe("cancelled");
		releaseTurn();
		expect((await runPromise).status).toBe("cancelled");

		// Cancelled children remain available for history inspection and deletion, but are never reusable.
		expect(runner.listRetainedChildren(PARENT_SESSION)).toEqual([
			expect.objectContaining({ runId: normalized.runId, terminalStatus: "cancelled" }),
		]);
		expect(runner.peekRuntime(normalized.runId, PARENT_SESSION)).toMatchObject({
			childState: "cancelled",
			terminal: true,
		});
		expect(() => runner.detachRuntime(normalized.runId, PARENT_SESSION)).toThrow(/already terminal/);
		await expect(
			runner.resumeRuntime(normalized.runId, PARENT_SESSION, "again", [...ACTIVE_TOOLS]),
		).rejects.toMatchObject({ code: "child_protocol_failure" });
		expect(await runner.deleteRetainedChild(normalized.runId, PARENT_SESSION)).toEqual({
			runId: normalized.runId,
			deleted: true,
		});
		expect(runner.peekRuntime(normalized.runId, PARENT_SESSION)).toBeUndefined();
		expect(child.dispose).toHaveBeenCalledTimes(1);
	});
});
