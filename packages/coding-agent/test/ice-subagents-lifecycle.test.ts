import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { fauxAssistantMessage, registerFauxProvider } from "@zykairotis/ice-ai/compat";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import type { CreateAgentSessionResult } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { IceAgentViewBridge } from "../src/ice-agent-view-bridge.ts";
import * as iceSubagentsModule from "../src/ice-subagents.ts";
import iceSubagents, {
	NativeSubagentRunner,
	runResolvedSubagentBatch,
	runSubagentWithRecovery,
	type SubagentBatchTaskLifecycleEvent,
	type SubagentResult,
} from "../src/ice-subagents.ts";
import {
	batchResult,
	createAsyncToolHarness,
	createFauxChildRuntime,
	createNoopExtensionRunner,
	createWorkspace,
	normalizeSubagentRequest,
	registerScriptedUsageProvider,
	request,
	resolvedBatchTask,
	scriptedModelRuntime,
	tempDirs,
	testModel,
} from "./ice-subagents-harness.ts";

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ICE subagent contracts", () => {
	it("keeps manage_subagent as a control-only schema that cannot widen a retained child", async () => {
		const harness = await createAsyncToolHarness();
		const manage = harness.tools.get("manage_subagent");
		expect(manage).toBeDefined();
		const schema = manage?.parameters as { properties?: Record<string, unknown> };
		for (const field of ["model", "profile", "scope", "tools", "execution", "maxOutputBytes"]) {
			expect(schema.properties).not.toHaveProperty(field);
		}
		expect(manage?.description).toMatch(
			/preserves run ID.*model.*profile.*scope.*tool authority.*owner-scoped output artifact access/i,
		);
	});

	it("validates the phase-aware manage_subagent contract as a closed schema that rejects widening", async () => {
		const harness = await createAsyncToolHarness();
		const schema = harness.tools.get("manage_subagent")!.parameters;
		expect(schema).toMatchObject({ additionalProperties: false });
		// The combined lifecycle exposes observation/control actions alongside terminal reuse/delete actions.
		for (const action of ["inspect", "peek", "wait", "follow_up", "stop", "detach", "resume", "delete"]) {
			expect(Value.Check(schema, { runId: "run-1", action })).toBe(true);
		}
		expect(Value.Check(schema, { runId: "run-1", action: "extend", additionalMs: 60_000 })).toBe(false);
		// An action outside the closed union is rejected outright.
		expect(Value.Check(schema, { runId: "run-1", action: "recreate" })).toBe(false);
		// Widening fields are undeclared, and the closed object rejects them at the boundary.
		for (const field of ["model", "profile", "scope", "tools"]) {
			expect(Value.Check(schema, { runId: "run-1", action: "resume", [field]: {} })).toBe(false);
		}
		expect(Value.Check(schema, { runId: "run-1", action: "resume", message: "continue" })).toBe(true);
		expect(Value.Check(schema, { runId: "run-1", action: "delete" })).toBe(true);
		// waitMs stays a bounded management-wait window on the combined schema.
		const manage = harness.tools.get("manage_subagent");
		const properties = manage?.parameters as { properties?: Record<string, unknown> };
		expect(properties.properties?.waitMs).toMatchObject({
			minimum: 1,
			maximum: iceSubagentsModule.SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS,
		});
		expect(manage?.description).toMatch(/phase-aware/i);
		expect(manage?.description).toMatch(/detach retains the same live child/i);
		expect(manage?.description).toMatch(/resume continues a retained completed child/i);
		expect(manage?.description).toMatch(/details\.managed\.runId/i);
		expect(manage?.description).toMatch(/do not pass.*jobId.*resultRef.*batchId.*taskId/i);
		expect(harness.tools.get("inspect_subagent_job")?.description).toMatch(/details\.accepted\.jobId/i);
		expect(harness.tools.get("inspect_subagent_job")?.description).toMatch(/resultRef.*batchId.*taskId/i);
		expect(harness.tools.get("cancel_subagent_job")?.description).toMatch(/bare jobId/i);
	});

	it("releases managed output artifacts when resume supersedes a result or delete forgets it", async () => {
		const harness = await createAsyncToolHarness();
		const manage = harness.tools.get("manage_subagent")!;
		const readOutput = harness.tools.get("read_subagent_output")!;
		const childRequest = {
			role: "self",
			self: {
				instructions: "Inspect the approved scope and return a concise answer.",
				capabilities: ["read", "grep", "find", "ls"],
			},
			task: "Inspect the source tree.",
			scope: { roots: ["src"] },
		};
		try {
			harness.faux.setResponses([
				fauxAssistantMessage("first answer ".repeat(4_000)),
				fauxAssistantMessage("resumed answer ".repeat(4_000)),
			]);
			const accepted = await harness.tools
				.get("delegate")!
				.execute("artifact-lifecycle-launch", childRequest, undefined, undefined, harness.context);
			const runId = accepted.details.managed.runId as string;
			let firstResult: SubagentResult | undefined;
			await vi.waitFor(
				async () => {
					const observation = await manage.execute(
						"artifact-lifecycle-first",
						{ runId, action: "peek" },
						undefined,
						undefined,
						harness.context,
					);
					firstResult = observation.details.observation.result as SubagentResult | undefined;
					expect(firstResult?.status).toBe("completed");
				},
				{ timeout: 5_000, interval: 10 },
			);
			const firstArtifactId = firstResult?.output?.artifact?.id;
			if (!firstArtifactId) throw new Error("Expected the first final answer to be retained as an artifact.");
			expect(
				await readOutput.execute(
					"artifact-lifecycle-read-first",
					{ artifactId: firstArtifactId, length: 8 },
					undefined,
					undefined,
					harness.context,
				),
			).toMatchObject({ isError: false });

			const resumed = await manage.execute(
				"artifact-lifecycle-resume",
				{ runId, action: "resume", message: "Continue with a second answer." },
				undefined,
				undefined,
				harness.context,
			);
			const resumedRunId = resumed.details.result.runId as string;
			const supersededRead = await readOutput.execute(
				"artifact-lifecycle-read-superseded",
				{ artifactId: firstArtifactId, length: 8 },
				undefined,
				undefined,
				harness.context,
			);
			expect(supersededRead).toMatchObject({ isError: true });
			const resumedResult = resumed.details.result as SubagentResult;
			const resumedArtifactId = resumedResult.output?.artifact?.id;
			if (!resumedArtifactId) throw new Error("Expected the resumed final answer to be retained as an artifact.");
			expect(
				await readOutput.execute(
					"artifact-lifecycle-read-resumed",
					{ artifactId: resumedArtifactId, length: 8 },
					undefined,
					undefined,
					harness.context,
				),
			).toMatchObject({ isError: false });

			const deleted = await manage.execute(
				"artifact-lifecycle-delete",
				{ runId: resumedRunId, action: "delete" },
				undefined,
				undefined,
				harness.context,
			);
			expect(deleted).toMatchObject({
				isError: false,
				details: { action: "delete", deleted: { deleted: true } },
			});
			expect(
				await readOutput.execute(
					"artifact-lifecycle-read-deleted",
					{ artifactId: resumedArtifactId, length: 8 },
					undefined,
					undefined,
					harness.context,
				),
			).toMatchObject({ isError: true });
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("keeps an admitted child running beyond the startup deadline until explicitly cancelled", async () => {
		const cwd = await createWorkspace();
		const normalized = normalizeSubagentRequest({ ...request(cwd), timeoutMs: 20 }, cwd);
		const controller = new AbortController();
		let markPromptStarted!: () => void;
		const promptStarted = new Promise<void>((resolve) => {
			markPromptStarted = resolve;
		});
		const fakeSession = {
			sessionId: "child-real-timeout",
			model: {} as Model<Api>,
			messages: [],
			extensionRunner: createNoopExtensionRunner(),
			subscribe: vi.fn(() => vi.fn()),
			prompt: vi.fn(() => {
				markPromptStarted();
				return new Promise<void>(() => {});
			}),
			abort: vi.fn(async () => {}),
			dispose: vi.fn(),
			getSessionStats: vi.fn(() => ({
				tokens: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0 },
				cost: 0.25,
			})),
		} as unknown as CreateAgentSessionResult["session"];
		const runPromise = new NativeSubagentRunner({
			createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"], {
			signal: controller.signal,
			noLifetimeTimeout: true,
		});

		await promptStarted;
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(fakeSession.abort).not.toHaveBeenCalled();
		controller.abort();
		await expect(runPromise).resolves.toMatchObject({ status: "cancelled" });
		expect(fakeSession.abort).toHaveBeenCalledOnce();
	});

	it("cancels a native child while overflow compaction is in flight", async () => {
		const cwd = await createWorkspace();
		const agentDir = join(cwd, ".ice-agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 128, midRunCompaction: "resume" } }),
		);
		const faux = registerFauxProvider({ tokensPerSecond: 80 });
		let cancelTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			const { model, modelRuntime } = await createFauxChildRuntime(cwd, faux);
			let summaryCallStarted = false;
			const controller = new AbortController();
			const events: iceSubagentsModule.SubagentEvent[] = [];
			faux.setResponses([
				fauxAssistantMessage("partial child response", { stopReason: "length" }),
				() => {
					summaryCallStarted = true;
					return fauxAssistantMessage("x".repeat(4_000));
				},
				fauxAssistantMessage('{"summary":"must not continue","evidence":{"paths":["src"]}}'),
			]);
			const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
			const result = await new NativeSubagentRunner({ agentDir }).runResolved(normalized, ["delegate", "read"], {
				model,
				modelRuntime,
				signal: controller.signal,
				onEvent: (event) => {
					events.push(event);
					if (event.type !== "subagent_compaction_start") return;
					const cancelAfterSummaryStarts = (): void => {
						if (summaryCallStarted) {
							controller.abort();
							return;
						}
						cancelTimer = setTimeout(cancelAfterSummaryStarts, 0);
					};
					cancelTimer = setTimeout(cancelAfterSummaryStarts, 0);
				},
			});

			expect(result.status).toBe("cancelled");
			expect(faux.state.callCount).toBe(2);
			expect(events.filter((event) => event.type === "subagent_compaction_start")).toHaveLength(1);
			expect(events.filter((event) => event.type === "subagent_compaction_end")).toEqual([
				expect.objectContaining({
					type: "subagent_compaction_end",
					status: "running",
					compactionReason: "overflow",
					compactionStatus: "aborted",
					compactionWillRetry: false,
				}),
			]);
			expect(events.at(-1)?.type).toBe("subagent_cancelled");
		} finally {
			if (cancelTimer) clearTimeout(cancelTimer);
			faux.unregister();
		}
	});
	it("retains plain final answers independently of caller byte limits", async () => {
		const cwd = await createWorkspace();
		const runCase = async (rawAnswer: string) => {
			const normalized = normalizeSubagentRequest(request(cwd), cwd);
			const messages: AgentMessage[] = [];
			const fakeSession = {
				sessionId: `plain-byte-boundary-${rawAnswer.length}`,
				model: {} as Model<Api>,
				messages,
				extensionRunner: createNoopExtensionRunner(),
				subscribe: vi.fn(() => vi.fn()),
				prompt: vi.fn(async () => {
					messages.push({ role: "assistant", content: rawAnswer, stopReason: "stop" } as unknown as AgentMessage);
				}),
				abort: vi.fn(async () => {}),
				dispose: vi.fn(),
				getSessionStats: vi.fn(() => ({
					tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					cost: 0,
				})),
			} as unknown as CreateAgentSessionResult["session"];
			return new NativeSubagentRunner({
				createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
			}).runResolved(normalized, ["delegate", "read"]);
		};

		const inBudget = "🙂".repeat(250);
		const accepted = await runCase(inBudget);
		expect(Buffer.byteLength(inBudget, "utf8")).toBe(1_000);
		expect(accepted.status).toBe("completed");
		expect(accepted.summary).toBe(inBudget);
		expect(accepted.observedOutputBytes).toBe(1_000);
		expect(Buffer.byteLength(JSON.stringify(accepted), "utf8")).toBeGreaterThan(1_024);

		const overBudget = "🙂".repeat(300);
		const retained = await runCase(overBudget);
		expect(retained.status).toBe("completed");
		expect(retained.observedOutputBytes).toBe(Buffer.byteLength(overBudget, "utf8"));
		expect(retained.output).toMatchObject({
			captureStatus: "inline_complete",
			text: overBudget,
			originalBytes: Buffer.byteLength(overBudget, "utf8"),
		});
		expect(retained.summary).toBe(overBudget);
	});

	it("cancels a child cleanly while the core retry path is in backoff", async () => {
		const cwd = await createWorkspace();
		const scripted = registerScriptedUsageProvider(
			[fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })],
			{ api: "anthropic-messages" },
		);
		const settingsManager = SettingsManager.inMemory();
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 60_000 } });
		const controller = new AbortController();
		const events: iceSubagentsModule.SubagentEvent[] = [];
		try {
			const model = scripted.model;
			const modelRuntime = await scriptedModelRuntime(cwd, model);
			const normalized = normalizeSubagentRequest({ ...request(cwd), timeoutMs: 5_000 }, cwd);
			const result = await Promise.race([
				new NativeSubagentRunner({ agentDir: cwd }).runResolved(normalized, ["delegate", "read"], {
					model,
					modelRuntime,
					settingsManager,
					signal: controller.signal,
					onEvent: (event) => {
						events.push(event);
						if (event.type === "subagent_retry" && event.retry?.state === "scheduled") controller.abort();
					},
				}),
				new Promise<SubagentResult>((_, reject) =>
					setTimeout(() => reject(new Error("child did not cancel during retry backoff")), 500),
				),
			]);
			expect(result.status).toBe("cancelled");
			expect(scripted.consumed()).toBe(1);
			expect(events.some((event) => event.type === "subagent_retry")).toBe(true);
		} finally {
			controller.abort();
			scripted.unregister();
		}
	});

	it("keeps oversized running output alive until explicit cancellation", async () => {
		const cwd = await createWorkspace();
		const normalized = {
			...normalizeSubagentRequest({ ...request(cwd), timeoutMs: 1_000 }, cwd),
			reportMode: "plain_final_turn" as const,
		};
		const controller = new AbortController();
		const bridge = new IceAgentViewBridge();
		let notify: ((event: AgentSessionEvent) => void) | undefined;
		let releasePrompt!: () => void;
		const promptGate = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		let reportProgress!: () => void;
		const progress = new Promise<void>((resolve) => {
			reportProgress = resolve;
		});
		const abort = vi.fn(async () => releasePrompt());
		const fakeSession = {
			sessionId: "child-output-explicit-stop",
			model: testModel("faux", "faux"),
			messages: [],
			extensionRunner: createNoopExtensionRunner(),
			subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
				notify = listener;
				return vi.fn();
			}),
			prompt: vi.fn(async () => {
				(fakeSession.messages as unknown[]).push({ role: "assistant", content: "x".repeat(30_000) });
				notify?.({ type: "message_update" } as AgentSessionEvent);
				reportProgress();
				await promptGate;
			}),
			abort,
			dispose: vi.fn(),
			getSessionStats: vi.fn(() => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 })),
		} as unknown as CreateAgentSessionResult["session"];
		const runner = new NativeSubagentRunner({
			artifactRoot: join(cwd, "artifacts"),
			createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
			agentViewBridge: bridge,
		});
		const run = runner.runResolved(normalized, ["delegate", "read"], { signal: controller.signal });
		let settled = false;
		void run.then(() => {
			settled = true;
		});
		await progress;
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(abort).not.toHaveBeenCalled();

		controller.abort();
		const result = await run;
		expect(result.status, JSON.stringify({ diagnostics: result.diagnostics, summary: result.summary })).toBe(
			"cancelled",
		);
		expect(result.diagnostics[0]).toMatchObject({ code: "cancellation" });
		expect(abort).toHaveBeenCalledOnce();
		expect(bridge.getView(normalized.runId)).toMatchObject({
			kind: "historical-subagent",
			status: "cancelled",
			readOnly: true,
		});
	});

	it("keeps a retained child alive past the startup deadline and stops it only on explicit cancellation", async () => {
		const cwd = await createWorkspace();
		const controller = new AbortController();
		const abort = vi.fn(async () => {});
		let markPromptStarted!: () => void;
		const promptStarted = new Promise<void>((resolve) => {
			markPromptStarted = resolve;
		});
		const lifecycle: string[] = [];
		const shutdown = vi.fn(async () => {
			lifecycle.push("shutdown");
		});
		const dispose = vi.fn(() => {
			lifecycle.push("dispose");
		});
		const fakeSession = {
			sessionId: "child-no-lifetime-timeout",
			model: {} as Model<Api>,
			messages: [],
			prompt: vi.fn(() => {
				markPromptStarted();
				return new Promise<void>(() => {});
			}),
			subscribe: vi.fn(() => vi.fn()),
			abort,
			dispose,
			extensionRunner: {
				hasHandlers: vi.fn((eventType: string) => eventType === "session_shutdown"),
				emit: shutdown,
			},
		} as unknown as CreateAgentSessionResult["session"];
		const events: string[] = [];
		const runner = new NativeSubagentRunner({
			createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
		});
		const runPromise = runner.run({ ...request(cwd), timeoutMs: 5 }, ["delegate", "read"], {
			onEvent: (event) => events.push(event.type),
			signal: controller.signal,
			noLifetimeTimeout: true,
		});
		await promptStarted;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(abort).not.toHaveBeenCalled();
		controller.abort();
		const result = await runPromise;
		expect(result.status).toBe("cancelled");
		expect(abort).toHaveBeenCalledOnce();
		// Explicitly cancelled children remain history-only until the parent deletes them.
		const retained = runner.listRetainedChildren("parent-1");
		expect(retained).toEqual([expect.objectContaining({ terminalStatus: "cancelled" })]);
		expect(shutdown).not.toHaveBeenCalled();
		expect(dispose).not.toHaveBeenCalled();
		expect(events.at(-1)).toBe("subagent_cancelled");
		expect(await runner.deleteRetainedChild(retained[0]!.runId, "parent-1")).toEqual({
			runId: retained[0]!.runId,
			deleted: true,
		});
		expect(shutdown).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
		expect(dispose).toHaveBeenCalledOnce();
		expect(lifecycle).toEqual(["shutdown", "dispose"]);
	});

	it("propagates parent cancellation during a child prompt", async () => {
		const cwd = await createWorkspace();
		const abort = vi.fn(async () => {});
		const fakeSession = {
			sessionId: "child-cancelled",
			model: {} as Model<Api>,
			messages: [{ role: "assistant", content: "partial report", stopReason: "stop" }],
			extensionRunner: createNoopExtensionRunner(),
			prompt: vi.fn(() => new Promise<void>(() => {})),
			subscribe: vi.fn(() => vi.fn()),
			abort,
			dispose: vi.fn(),
		} as unknown as CreateAgentSessionResult["session"];
		const controller = new AbortController();
		const runner = new NativeSubagentRunner({
			createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
		});
		const resultPromise = runner.run({ ...request(cwd), timeoutMs: 100 }, ["delegate", "read"], {
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 5);
		const result = await resultPromise;
		expect(result.status).toBe("cancelled");
		expect(result.observedOutputBytes).toBe(Buffer.byteLength("partial report"));
		expect(abort).toHaveBeenCalledOnce();
	});

	it("suppresses a direct retry after parent cancellation before runner invocation", async () => {
		const cwd = await createWorkspace();
		const task = resolvedBatchTask(cwd, "cancelled-retry");
		const controller = new AbortController();
		let calls = 0;
		const result = await runSubagentWithRecovery(
			task.request,
			["delegate", "read"],
			(attempt) => {
				calls++;
				if (attempt === 1) {
					controller.abort();
					return Promise.resolve({
						...batchResult(task, "failed", "temporary"),
						diagnostics: [{ code: "child_runtime_failure" as const, message: "temporary", retryable: true }],
					});
				}
				return Promise.resolve(batchResult(task));
			},
			{ getStopReason: () => (controller.signal.aborted ? "cancelled" : undefined) },
		);
		expect(calls).toBe(1);
		expect(result.status).toBe("cancelled");
		expect(result.diagnostics[0]).toMatchObject({ code: "cancellation" });
		expect(result.recovery).toMatchObject({ attemptCount: 1, retried: false });
	});

	it("fail-fast aborts active work and preserves settled evidence", async () => {
		const cwd = await createWorkspace();
		const tasks = ["success", "failed", "active", "queued"].map((id) => resolvedBatchTask(cwd, id));
		const started = new Set<string>();
		const taskStates: SubagentBatchTaskLifecycleEvent[] = [];
		let fail: (() => void) | undefined;
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (task, _tools, options) => {
				const resolvedTask = tasks.find((candidate) => candidate.request.runId === task.runId)!;
				started.add(resolvedTask.id);
				if (resolvedTask.id === "success") return batchResult(resolvedTask);
				if (resolvedTask.id === "failed") {
					return new Promise<SubagentResult>((resolve) => {
						fail = () => resolve(batchResult(resolvedTask, "failed", "failed"));
					});
				}
				if (resolvedTask.id === "active") {
					return new Promise<SubagentResult>((resolve) => {
						options?.signal?.addEventListener(
							"abort",
							() => resolve(batchResult(resolvedTask, "cancelled", "aborted")),
							{ once: true },
						);
					});
				}
				throw new Error("queued worker must not launch");
			},
		};
		const batchPromise = runResolvedSubagentBatch(tasks, ["delegate", "read"], runner, {
			concurrency: 2,
			failFast: true,
			onTaskState: (event) => taskStates.push(event),
		});
		for (let attempt = 0; attempt < 20 && (!started.has("active") || !fail); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(started).toEqual(new Set(["success", "failed", "active"]));
		fail!();
		const result = await batchPromise;
		expect(result.status).toBe("partial");
		expect(result.items.map((item) => item.taskId)).toEqual(["success", "failed", "active", "queued"]);
		expect(result.items.map((item) => item.result.status)).toEqual(["completed", "failed", "cancelled", "failed"]);
		expect(result.items[0]?.verification.verified).toBe(true);
		expect(taskStates.filter((event) => event.type === "task_skipped")).toEqual([
			{
				type: "task_skipped",
				batchId: taskStates[0]?.batchId,
				taskId: "queued",
				status: "failed",
				reason: "Batch stopped after fail-fast.",
			},
		]);
		expect(started).not.toContain("queued");
	});

	it("shuts down retained subagent supervisors with the owning Ice session", async () => {
		const runnerShutdown = vi.spyOn(NativeSubagentRunner.prototype, "shutdown").mockResolvedValue(undefined);
		try {
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
			const api = {
				on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) {
					handlers.set(event, handler);
				},
				registerTool: vi.fn(),
				appendEntry: vi.fn(),
				sendMessage: vi.fn(),
			} as unknown as ExtensionAPI;
			iceSubagents(api);
			const context = {
				sessionManager: {
					getSessionId: () => "owner-shutdown",
					getEntries: () => [],
				},
			} as unknown as ExtensionContext;
			await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, context);
			await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, context);
			expect(runnerShutdown).toHaveBeenCalledOnce();
		} finally {
			runnerShutdown.mockRestore();
		}
	});
});
