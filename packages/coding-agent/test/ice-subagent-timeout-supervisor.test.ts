import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { CreateAgentSessionResult } from "../src/core/sdk.ts";
import {
	IceAgentViewBridge,
	type IceAgentViewLiveSessionControl,
	normalizeIceAgentViewPresentation,
} from "../src/ice-agent-view-bridge.ts";
import { SubagentJobRegistry, type SubagentJobRunResult } from "../src/ice-subagent-jobs.ts";
import {
	formatSubagentToolActivity,
	SubagentRunSupervisor,
	SubagentRunSupervisorRegistry,
} from "../src/ice-subagent-timeout-supervisor.ts";
import {
	createSubagentLiveSessionControl,
	NativeSubagentRunner,
	normalizeSubagentRequest,
	SubagentLiveSessionRegistry,
	type SubagentRequest,
	type SubagentResult,
} from "../src/ice-subagents.ts";
import { SubagentFooterSwitcher } from "../src/modes/interactive/components/subagent-view-switcher.ts";

const tempDirs: string[] = [];

function assistantMessage(text: string): AgentMessage {
	return { role: "assistant", content: text, stopReason: "stop" } as unknown as AgentMessage;
}

async function workspace(): Promise<{ cwd: string; agentDir: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "ice-timeout-supervisor-"));
	const agentDir = await mkdtemp(join(tmpdir(), "ice-timeout-agent-"));
	tempDirs.push(cwd, agentDir);
	await mkdir(join(cwd, "src"));
	await writeFile(join(cwd, "src", "a.ts"), "export const a = 1;\n");
	return { cwd, agentDir };
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

class ManagedTimeoutChild {
	readonly sessionId = "managed-child-session";
	readonly model = { provider: "faux", id: "faux" } as Model<Api>;
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
	completeOnPrompt = 2;
	finalMessageText = '{"summary":"completed after extension","evidence":{"paths":["src/a.ts"]}}';

	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	private resolveActivePrompt: (() => void) | undefined;

	constructor(cwd: string) {
		this.sessionManager = { getCwd: () => cwd };
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private emitActivity(index: number, toolName: string, args: Record<string, unknown>): void {
		const toolCallId = `tool-${index}`;
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
			this.emitActivity(3, "find", { pattern: "*.ts", path: "src" });
			this.emitActivity(4, "bash", { command: "printf token=secret-value && npm test", path: "." });
		}
		if (call >= this.completeOnPrompt) {
			this.messages.push(assistantMessage(this.finalMessageText));
			return;
		}
		this.isStreaming = true;
		await new Promise<void>((resolve) => {
			this.resolveActivePrompt = resolve;
		});
		this.isStreaming = false;
	}
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ICE resumable timeout supervision", () => {
	it("treats the profile timeout as a default rather than a hard ceiling", async () => {
		const { cwd, agentDir } = await workspace();
		const defaultRequest = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		const longerRequest = normalizeSubagentRequest(request(cwd, 300_000), cwd, { agentDir });
		const maximumRequest = normalizeSubagentRequest(request(cwd, 600_000), cwd, { agentDir });

		expect(defaultRequest.timeoutMs).toBe(120_000);
		expect(longerRequest.timeoutMs).toBe(300_000);
		expect(maximumRequest.timeoutMs).toBe(600_000);
	});

	it("returns needs_time with the last three runtime-observed activities and resumes the same child", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new ManagedTimeoutChild(cwd);
		// Pins the structured extension-report contract used by typed flows.
		const normalized = {
			...normalizeSubagentRequest(request(cwd, 25), cwd, { agentDir }),
			reportMode: "structured_report",
		} as const;
		const supervisors = new SubagentRunSupervisorRegistry<SubagentResult>();
		const runner = new NativeSubagentRunner({
			agentDir,
			supervisorRegistry: supervisors,
			createSession: async () =>
				({ session: child as unknown as AgentSession }) as unknown as CreateAgentSessionResult,
		});
		const model = { provider: "faux", id: "faux" } as Model<Api>;

		const first = await runner.runResolved(normalized, ["delegate", "read", "grep", "find", "ls"], { model });
		expect(first.status).toBe("needs_time");
		expect(first.childSessionId).toBe(child.sessionId);
		expect(first.attention?.lastActivities).toHaveLength(3);
		expect(first.attention?.lastActivities.map((activity) => activity.toolName)).toEqual(["grep", "find", "bash"]);
		expect(first.attention?.lastActivities.at(-1)?.action).toContain("bash");
		expect(first.attention?.lastActivities.at(-1)?.action).not.toContain("secret-value");
		expect(child.abort).toHaveBeenCalledTimes(1);

		const extended = await runner.extendRuntime(normalized.runId, normalized.parentSessionId, 60_000);
		expect(extended).toMatchObject({
			status: "completed",
			runId: normalized.runId,
			childSessionId: child.sessionId,
			summary: "completed after extension",
		});
		expect(child.promptCalls).toHaveLength(2);
		expect(child.promptCalls[1]?.text).toContain("[ICE VOID SUBAGENT CONTINUE]");
		expect(child.promptCalls[1]?.text).not.toContain("Inspect the scoped repository.");
		expect(runner.getRuntimeAttention(normalized.runId, normalized.parentSessionId)).toBeUndefined();
	});

	it("keeps plain final-turn ingestion across a needs-time extension and uses the plain continuation prompt", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new ManagedTimeoutChild(cwd);
		child.finalMessageText = "Completed after extension in plain prose.";
		// No reportMode pin: an ordinary delegate resolves to plain final-turn ingestion.
		const normalized = normalizeSubagentRequest(request(cwd, 25), cwd, { agentDir });
		expect(normalized.reportMode).toBe("plain_final_turn");
		const supervisors = new SubagentRunSupervisorRegistry<SubagentResult>();
		const runner = new NativeSubagentRunner({
			agentDir,
			supervisorRegistry: supervisors,
			createSession: async () =>
				({ session: child as unknown as AgentSession }) as unknown as CreateAgentSessionResult,
		});
		const model = { provider: "faux", id: "faux" } as Model<Api>;

		const first = await runner.runResolved(normalized, ["delegate", "read", "grep", "find", "ls"], { model });
		expect(first.status).toBe("needs_time");
		expect(first.reportMode).toBe("plain_final_turn");

		const extended = await runner.extendRuntime(normalized.runId, normalized.parentSessionId, 60_000);
		expect(extended).toMatchObject({
			status: "completed",
			runId: normalized.runId,
			childSessionId: child.sessionId,
			reportMode: "plain_final_turn",
			summary: "Completed after extension in plain prose.",
		});
		expect(child.promptCalls).toHaveLength(2);
		expect(child.promptCalls[1]?.text).toContain("[ICE VOID SUBAGENT CONTINUE]");
		expect(child.promptCalls[1]?.text).toContain("plain final answer message in ordinary prose");
		expect(child.promptCalls[1]?.text).toContain("do not wrap it in a JSON envelope");
		expect(child.promptCalls[1]?.text).not.toContain("Return the required final bounded JSON report");
	});

	it("can interrupt a second resumed turn instead of reusing a stale abort promise", async () => {
		const { cwd, agentDir } = await workspace();
		const child = new ManagedTimeoutChild(cwd);
		child.completeOnPrompt = 3;
		const normalized = normalizeSubagentRequest(request(cwd, 20), cwd, { agentDir });
		const runner = new NativeSubagentRunner({
			agentDir,
			supervisorRegistry: new SubagentRunSupervisorRegistry<SubagentResult>(),
			createSession: async () =>
				({ session: child as unknown as AgentSession }) as unknown as CreateAgentSessionResult,
		});
		const model = { provider: "faux", id: "faux" } as Model<Api>;

		const first = await runner.runResolved(normalized, ["delegate", "read", "grep", "find", "ls"], { model });
		expect(first.status).toBe("needs_time");
		const second = await runner.extendRuntime(normalized.runId, normalized.parentSessionId, 1_000);
		expect(second.status).toBe("needs_time");
		expect(child.abort).toHaveBeenCalledTimes(2);
		const third = await runner.extendRuntime(normalized.runId, normalized.parentSessionId, 1_000);
		expect(third.status).toBe("completed");
		expect(child.promptCalls).toHaveLength(3);
	});

	it("pauses autonomous execution accounting during controlled idle and cleans an ignored attention state", async () => {
		vi.useFakeTimers();
		const abort = vi.fn(async () => undefined);
		const stop = vi.fn(async () => "stopped");
		const supervisor = new SubagentRunSupervisor<string>({
			runId: "run-controlled-idle",
			childSessionId: "child-controlled-idle",
			initialTimeoutMs: 1_000,
			decisionGraceMs: 2_000,
			abort,
			resume: async () => "resumed",
			stop,
		});

		expect(supervisor.pauseForControlledWait()).toBe(true);
		const pausedElapsedMs = supervisor.getSnapshot().activeElapsedMs;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(supervisor.getSnapshot()).toMatchObject({ state: "running", phase: "controlled_wait" });
		expect(supervisor.getSnapshot().activeElapsedMs).toBe(pausedElapsedMs);
		expect(abort).not.toHaveBeenCalled();

		expect(supervisor.resumeFromControlledWait()).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(supervisor.getSnapshot().state).toBe("awaiting_extension");
		expect(abort).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(supervisor.getSnapshot()).toMatchObject({ state: "terminal", terminalStatus: "timed_out" });
		expect(stop).toHaveBeenCalledWith("timed_out");
	});

	it("keeps durable async jobs nonterminal while the retained run needs time", async () => {
		const registry = new SubagentJobRegistry({
			ownerSessionId: "parent-session",
			persist: () => undefined,
			notify: () => undefined,
		});
		const needsTimeResult: SubagentResult = {
			runId: "run-async-needs-time",
			parentSessionId: "parent-session",
			profile: "explore",
			source: "user",
			status: "needs_time",
			summary: "Awaiting extension.",
			observedOutputBytes: 0,
			partial: true,
			diagnostics: [{ code: "timeout", message: "Awaiting extension." }],
		};
		const needsTimeRun: SubagentJobRunResult = {
			result: needsTimeResult,
			verification: { verified: false, reason: "pending", paths: [], unresolvedClaims: [] },
		};
		const accepted = registry.launch({
			launchLeafId: "leaf-async",
			role: "explore",
			model: "faux/faux",
			plannedOutputBytes: 1024,
			run: async () => needsTimeRun,
		});

		await vi.waitFor(() => expect(registry.inspect(accepted.jobId, "parent-session").job.status).toBe("needs_time"));
		const paused = registry.inspect(accepted.jobId, "parent-session");
		expect(paused.job.runId).toBe(needsTimeResult.runId);
		expect(paused.result).toBeUndefined();
		expect(registry.markManagedRunState(needsTimeResult.runId, "running")).toBe(true);
		expect(registry.inspect(accepted.jobId, "parent-session").job.status).toBe("running");

		const completed: SubagentJobRunResult = {
			result: {
				...needsTimeResult,
				status: "completed",
				summary: "Finished after extension.",
				partial: false,
				diagnostics: [],
				evidence: { paths: ["src/a.ts"] },
			},
			verification: { verified: true, reason: "verified", paths: ["/tmp/src/a.ts"], unresolvedClaims: [] },
		};
		expect(await registry.resolveManagedRun(needsTimeResult.runId, completed)).toBe(true);
		expect(registry.inspect(accepted.jobId, "parent-session")).toMatchObject({
			job: { status: "completed", runId: needsTimeResult.runId },
			result: { summary: "Finished after extension." },
		});
		await registry.shutdown();
	});

	it("lets the expanded agent shelf extend or stop a selected needs-time child without switching views", async () => {
		const parent = {
			sessionId: "parent-session",
			messages: [],
			isStreaming: false,
			model: { provider: "faux", id: "faux" },
			sessionManager: { getCwd: () => "/repo" },
		} as unknown as AgentSession;
		const child = {
			sessionId: "child-session",
			messages: [],
			isStreaming: false,
			model: { provider: "faux", id: "faux" },
			sessionManager: { getCwd: () => "/repo" },
			prompt: vi.fn(),
		} as unknown as AgentSession;
		const baseControl = createSubagentLiveSessionControl(child);
		baseControl.markAwaitingExtension?.();
		const extendRuntime = vi.fn(async () => undefined);
		const stopRuntime = vi.fn(async () => undefined);
		const control: IceAgentViewLiveSessionControl = {
			...baseControl,
			getRuntimeAttention: () => ({
				state: "awaiting_extension",
				phase: "working",
				initialTimeoutMs: 120_000,
				activeBudgetMs: 120_000,
				activeElapsedMs: 120_000,
				totalExtendedMs: 0,
				extensionCount: 0,
				remainingExtendableMs: 480_000,
				lastActivities: [],
			}),
			extendRuntime,
			stopRuntime,
		};
		const live = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(parent);
		bridge.connectLiveSessions(live);
		const release = live.register({
			runId: "run-needs-time-ui",
			role: "explore",
			taskId: "repo-map",
			session: child,
			control,
		});
		bridge.requestDisplay("run-needs-time-ui");
		const requestRender = vi.fn();
		const switcher = new SubagentFooterSwitcher(
			{ requestRender } as never,
			{} as never,
			{ matches: () => false } as never,
			bridge,
			vi.fn(),
			true,
		);

		switcher.handleInput("e");
		expect(extendRuntime).toHaveBeenCalledWith(60_000);
		expect(bridge.getDisplayedId()).toBe("run-needs-time-ui");
		switcher.handleInput("x");
		expect(stopRuntime).toHaveBeenCalledOnce();
		expect(bridge.getDisplayedId()).toBe("run-needs-time-ui");

		switcher.dispose();
		release();
	});
});

describe("ICE timeout attention enrichment", () => {
	function activity(overrides: Partial<Parameters<SubagentRunSupervisor<string>["recordActivity"]>[0]> = {}) {
		return {
			toolCallId: "call-1",
			toolName: "bash",
			action: 'bash "npm run test:api"',
			status: "ok" as const,
			startedAtMs: 1_000,
			...overrides,
		};
	}

	it("retains bounded exit codes and error classes on failed command activity", () => {
		const supervisor = new SubagentRunSupervisor<string>({
			runId: "run-attention",
			initialTimeoutMs: 60_000,
			abort: async () => {},
			resume: async () => "resumed",
			stop: async () => "stopped",
		});
		supervisor.recordActivity(activity({ toolCallId: "call-ok", status: "ok", finishedAtMs: 1_500 }));
		supervisor.recordActivity(
			activity({
				toolCallId: "call-fail",
				status: "error",
				finishedAtMs: 2_000,
				exitCode: 1,
				errorClass: "command_failed",
			}),
		);
		const snapshot = supervisor.getSnapshot();
		const failed = snapshot.lastActivities.find((entry) => entry.toolCallId === "call-fail");
		expect(failed).toMatchObject({ status: "error", exitCode: 1, errorClass: "command_failed" });
		expect(snapshot.repeatedFailure).toBeUndefined();
	});

	it("advises inspection when the same normalized action fails twice recently", () => {
		const supervisor = new SubagentRunSupervisor<string>({
			runId: "run-repeat",
			initialTimeoutMs: 60_000,
			abort: async () => {},
			resume: async () => "resumed",
			stop: async () => "stopped",
		});
		supervisor.recordActivity(
			activity({ toolCallId: "f1", status: "error", exitCode: 1, errorClass: "command_failed" }),
		);
		expect(supervisor.getSnapshot().repeatedFailure).toBeUndefined();
		supervisor.recordActivity(
			activity({ toolCallId: "f2", status: "error", exitCode: 1, errorClass: "command_failed" }),
		);
		const advisory = supervisor.getSnapshot().repeatedFailure;
		expect(advisory).toBeDefined();
		expect(advisory?.count).toBe(2);
		expect(advisory?.action).toContain("npm run test:api");
		// A later success of the same action resolves the advisory.
		supervisor.recordActivity(activity({ toolCallId: "ok1", status: "ok" }));
		expect(supervisor.getSnapshot().repeatedFailure).toBeUndefined();
	});

	it("formats activities with the bounded outcome and exit code", () => {
		expect(
			formatSubagentToolActivity({
				toolCallId: "c",
				toolName: "bash",
				action: 'bash "npm run test:api"',
				status: "error",
				startedAtMs: 1_000,
				finishedAtMs: 2_500,
				exitCode: 1,
				errorClass: "command_failed",
			}),
		).toContain("exit 1");
	});

	it("normalizes legacy completed outcomes to ok at the bridge boundary", () => {
		const presentation = normalizeIceAgentViewPresentation({
			runtimeAttention: {
				phase: "working",
				state: "awaiting_extension",
				initialTimeoutMs: 60_000,
				activeBudgetMs: 60_000,
				activeElapsedMs: 10_000,
				totalExtendedMs: 0,
				extensionCount: 0,
				remainingExtendableMs: 60_000,
				lastActivities: [
					{
						toolCallId: "legacy-1",
						toolName: "bash",
						action: 'bash "npm run test:api"',
						status: "ok",
						startedAtMs: 1_000,
						finishedAtMs: 1_500,
					},
					{
						toolCallId: "enriched-1",
						toolName: "bash",
						action: 'bash "npm run test:api"',
						status: "error",
						startedAtMs: 2_000,
						finishedAtMs: 2_500,
						exitCode: 1,
						errorClass: "command_failed",
					},
				],
				repeatedFailure: { action: 'bash "npm run test:api"', count: 2 },
			},
		});
		const attention = presentation?.runtimeAttention;
		expect(attention?.lastActivities[0]).toMatchObject({ status: "ok" });
		expect(attention?.lastActivities[1]).toMatchObject({
			status: "error",
			exitCode: 1,
			errorClass: "command_failed",
		});
		expect(attention?.repeatedFailure).toMatchObject({ count: 2 });
	});
});
