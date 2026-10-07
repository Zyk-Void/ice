import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { fauxAssistantMessage, registerFauxProvider } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { KEYBINDINGS } from "../src/core/keybindings.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { CreateAgentSessionResult } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import iceSubagents, {
	NativeSubagentRunner,
	runResolvedSubagentBatch,
	SUBAGENT_FOLLOW_UP_STATE_ENTRY_TYPE,
	type SubagentBatchTaskLifecycleEvent,
	SubagentLiveSessionRegistry,
	type SubagentResult,
} from "../src/ice-subagents.ts";
import { SUBAGENT_CONCURRENCY_LIMITS } from "../src/subagents/registry/admission.ts";
import { JOB_COMPLETION_MESSAGE_TYPE, JOB_ENTRY_TYPE, SubagentJobRegistry } from "../src/subagents/registry/jobs.ts";
import { SubagentRunSupervisorRegistry } from "../src/subagents/runtime/supervisor.ts";
import {
	batchResult,
	createAsyncToolHarness,
	createNoopExtensionRunner,
	createWorkspace,
	normalizeSubagentRequest,
	request,
	resolvedBatchTask,
	tempDirs,
} from "./ice-subagents-harness.ts";

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ICE subagent contracts", () => {
	it("surfaces durable check-in state by runId and disarms it at terminal completion", async () => {
		const harness = await createAsyncToolHarness();
		let releaseChild!: () => void;
		let markChildStarted!: () => void;
		const blockedChild = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		const childStarted = new Promise<void>((resolve) => {
			markChildStarted = resolve;
		});
		const request = {
			role: "self",
			self: {
				instructions: "Inspect the approved scope and return a short answer.",
				capabilities: ["read", "grep", "find", "ls"],
			},
			task: "Inspect the source tree.",
			scope: { roots: ["src"] },
		};
		try {
			harness.faux.setResponses([
				async () => {
					markChildStarted();
					await blockedChild;
					return fauxAssistantMessage("Durable child completed.");
				},
			]);
			const accepted = await harness.tools
				.get("delegate_async")!
				.execute("durable-check-in-launch", request, undefined, undefined, harness.context);
			const jobId = accepted.details.accepted.jobId as string;
			await childStarted;
			await vi.waitFor(
				async () => {
					const inspection = await harness.tools
						.get("inspect_subagent_job")!
						.execute("durable-check-in-inspect", { jobId }, undefined, undefined, harness.context);
					expect(inspection).toMatchObject({
						details: { checkIn: { delivery: "armed", sequence: 0 } },
					});
				},
				{ timeout: 5_000, interval: 10 },
			);
			releaseChild();
			await vi.waitFor(
				async () => {
					const inspection = await harness.tools
						.get("inspect_subagent_job")!
						.execute("durable-check-in-terminal", { jobId }, undefined, undefined, harness.context);
					expect(inspection).toMatchObject({
						details: { inspection: { job: { status: "completed" } } },
					});
					expect(inspection.details.checkIn).toBeUndefined();
				},
				{ timeout: 5_000, interval: 10 },
			);
		} finally {
			releaseChild();
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("uses the correct foreground runId and durable jobId domains across real launches", async () => {
		const harness = await createAsyncToolHarness();
		const delegate = harness.tools.get("delegate")!;
		const manage = harness.tools.get("manage_subagent")!;
		const delegateAsync = harness.tools.get("delegate_async")!;
		const inspectJob = harness.tools.get("inspect_subagent_job")!;
		const childRequest = {
			role: "self",
			self: {
				instructions: "Inspect the approved scope and return a short answer.",
				capabilities: ["read", "grep", "find", "ls"],
			},
			task: "Inspect the source tree.",
			scope: { roots: ["src"] },
		};
		try {
			harness.faux.setResponses([fauxAssistantMessage("Managed child completed.")]);
			const managed = await delegate.execute("managed-launch", childRequest, undefined, undefined, harness.context);
			expect(managed).toMatchObject({ isError: false, details: { managed: { runId: expect.any(String) } } });
			const runId = managed.details.managed.runId as string;
			const peeked = await manage.execute(
				"managed-peek",
				{ runId, action: "peek" },
				undefined,
				undefined,
				harness.context,
			);
			expect(peeked).toMatchObject({ isError: false, details: { action: "peek", runId } });
			await vi.waitFor(
				async () => {
					const terminal = await manage.execute(
						"managed-terminal-peek",
						{ runId, action: "peek" },
						undefined,
						undefined,
						harness.context,
					);
					expect(terminal).toMatchObject({
						isError: false,
						details: { observation: { childState: "completed", result: { status: "completed" } } },
					});
				},
				{ timeout: 5_000, interval: 10 },
			);

			harness.faux.setResponses([fauxAssistantMessage("Managed child resumed.")]);
			const resumed = await manage.execute(
				"managed-resume",
				{ runId, action: "resume", message: "Continue with one short answer." },
				undefined,
				undefined,
				harness.context,
			);
			expect(resumed).toMatchObject({
				isError: false,
				details: { action: "resume", runId, resumedFromRunId: runId, result: { runId: expect.any(String) } },
			});
			const resumedRunId = resumed.details.result.runId as string;
			expect(resumedRunId).not.toBe(runId);
			await vi.waitFor(
				async () => {
					const terminal = await manage.execute(
						"resumed-terminal-peek",
						{ runId: resumedRunId, action: "peek" },
						undefined,
						undefined,
						harness.context,
					);
					expect(terminal).toMatchObject({
						isError: false,
						details: { observation: { childState: "completed", result: { status: "completed" } } },
					});
				},
				{ timeout: 5_000, interval: 10 },
			);
			const deleted = await manage.execute(
				"managed-delete",
				{ runId: resumedRunId, action: "delete" },
				undefined,
				undefined,
				harness.context,
			);
			expect(deleted).toMatchObject({ isError: false, details: { action: "delete", runId: resumedRunId } });

			harness.faux.setResponses([fauxAssistantMessage("Durable child completed.")]);
			const accepted = await delegateAsync.execute(
				"durable-launch",
				childRequest,
				undefined,
				undefined,
				harness.context,
			);
			expect(accepted).toMatchObject({ isError: false, details: { accepted: { jobId: expect.any(String) } } });
			const jobId = accepted.details.accepted.jobId as string;
			const resultRef = accepted.details.accepted.resultRef as string;
			expect(resultRef).toBe(`job:${jobId}`);
			await vi.waitFor(
				async () => {
					const inspection = await inspectJob.execute(
						"durable-inspect",
						{ jobId },
						undefined,
						undefined,
						harness.context,
					);
					expect(inspection).toMatchObject({
						isError: false,
						details: { inspection: { job: { jobId, status: "completed" } } },
					});
				},
				{ timeout: 5_000, interval: 10 },
			);
			const wrongForeground = await manage.execute(
				"durable-as-foreground",
				{ runId: jobId, action: "peek" },
				undefined,
				undefined,
				harness.context,
			);
			expect(wrongForeground).toMatchObject({ isError: true });
			expect(wrongForeground.content[0].text).toMatch(/foreground runId.*durable jobId/i);
			const wrongDurable = await inspectJob.execute(
				"foreground-as-durable",
				{ jobId: runId },
				undefined,
				undefined,
				harness.context,
			);
			expect(wrongDurable).toMatchObject({ isError: true });
			expect(wrongDurable.content[0].text).toMatch(/bare durable jobId.*foreground runId/i);

			harness.faux.setResponses([
				fauxAssistantMessage('{"summary":"Batch child completed.","evidence":{"paths":["src"]},"findings":[]}'),
			]);
			const batchLaunch = await harness.tools.get("delegate_batch")!.execute(
				"batch-launch",
				{
					tasks: [
						{
							id: "batch-task",
							role: "self",
							self: {
								instructions: "Inspect the approved scope and return structured evidence.",
								capabilities: ["read", "grep", "find", "ls"],
							},
							task: "Inspect the source tree.",
							scope: { roots: ["src"] },
						},
					],
				},
				undefined,
				undefined,
				harness.context,
			);
			expect(batchLaunch).toMatchObject({ isError: false, details: { accepted: { batchId: expect.any(String) } } });
			let batchInspection: { details: { inspection: { result?: unknown } } } | undefined;
			await vi.waitFor(
				async () => {
					batchInspection = await harness.tools
						.get("inspect_subagent_batch")!
						.execute(
							"batch-inspect",
							{ batchId: batchLaunch.details.accepted.batchId },
							undefined,
							undefined,
							harness.context,
						);
					expect(batchInspection!.details.inspection.result).toBeDefined();
				},
				{ timeout: 5_000, interval: 10 },
			);
			const batchResult = batchInspection!.details.inspection.result as {
				batchId: string;
				items: Array<{ taskId: string; result: { runId: string } }>;
			};
			expect(batchResult.items[0]).toMatchObject({ taskId: "batch-task", result: { runId: expect.any(String) } });
			const batchId = batchResult.batchId;
			const taskId = batchResult.items[0]!.taskId;
			const batchRunId = batchResult.items[0]!.result.runId;
			for (const runId of [batchId, taskId]) {
				const rejected = await manage.execute(
					"batch-as-foreground",
					{ runId, action: "peek" },
					undefined,
					undefined,
					harness.context,
				);
				expect(rejected).toMatchObject({ isError: true });
				expect(rejected.content[0].text).toMatch(/foreground runId.*batchId.*taskId/i);
			}
			// Managed batch children are individually manageable by their own runId.
			const managedChild = await manage.execute(
				"batch-child-peek",
				{ runId: batchRunId, action: "peek" },
				undefined,
				undefined,
				harness.context,
			);
			expect(managedChild).toMatchObject({ isError: false });
			for (const candidateJobId of [batchId, taskId, `job:${jobId}`]) {
				const rejected = await inspectJob.execute(
					"batch-as-job",
					{ jobId: candidateJobId },
					undefined,
					undefined,
					harness.context,
				);
				expect(rejected).toMatchObject({ isError: true });
				expect(rejected.content[0].text).toMatch(/bare durable jobId.*batchId.*taskId/i);
			}
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("defines a configurable explicit durable-job inspect action", () => {
		const definition = (KEYBINDINGS as Record<string, { defaultKeys?: unknown; description?: string }>)[
			"app.subagents.inspect"
		];
		expect(definition).toMatchObject({ defaultKeys: "ctrl+enter", description: expect.stringContaining("Inspect") });
	});

	it("queues owner-bound follow-up once and rejects takeover conflicts", async () => {
		const cwd = await createWorkspace();
		const normalized = normalizeSubagentRequest(request(cwd), cwd);
		const liveSessions = new SubagentLiveSessionRegistry();
		const supervisors = new SubagentRunSupervisorRegistry<SubagentResult>();
		let releasePrompt!: () => void;
		const steer = vi.fn(async (_text: string) => {});
		const fakeSession = {
			sessionId: "child-follow-up",
			model: {} as Model<Api>,
			messages: [],
			extensionRunner: createNoopExtensionRunner(),
			subscribe: vi.fn(() => vi.fn()),
			prompt: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						releasePrompt = resolve;
					}),
			),
			steer,
			abort: vi.fn(async () => {
				releasePrompt?.();
			}),
			dispose: vi.fn(),
			getSessionStats: vi.fn(() => ({
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
			})),
		} as unknown as CreateAgentSessionResult["session"];
		const persistedFollowUps: unknown[] = [];
		const runner = new NativeSubagentRunner({
			liveSessionRegistry: liveSessions,
			supervisorRegistry: supervisors,
			createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
			persistFollowUpState: (snapshot) =>
				persistedFollowUps.push({
					type: "custom",
					customType: SUBAGENT_FOLLOW_UP_STATE_ENTRY_TYPE,
					data: snapshot,
				}),
		});
		const run = runner.runResolved(normalized, ["delegate", "read"]);
		await vi.waitFor(() => expect(liveSessions.get(normalized.runId)).toBeDefined());
		const first = await runner.followUpRuntime(
			normalized.runId,
			normalized.parentSessionId,
			"follow-1",
			"clarify the report",
		);
		const duplicate = await runner.followUpRuntime(
			normalized.runId,
			normalized.parentSessionId,
			"follow-1",
			"ignored duplicate",
		);
		expect(first.status).toBe("queued");
		expect(duplicate.status).toBe("duplicate");
		expect(steer).toHaveBeenCalledWith("clarify the report");
		expect(persistedFollowUps).toHaveLength(1);
		expect(runner.restoreFollowUpState(persistedFollowUps, normalized.parentSessionId)).toBe(1);
		const restoredDuplicate = await runner.followUpRuntime(
			normalized.runId,
			normalized.parentSessionId,
			"follow-1",
			"duplicate after durable restore",
		);
		expect(restoredDuplicate.status).toBe("duplicate");
		liveSessions.get(normalized.runId)?.control?.setControlled(true);
		await expect(
			runner.followUpRuntime(normalized.runId, normalized.parentSessionId, "follow-2", "blocked by takeover"),
		).rejects.toThrow(/takeover/i);
		await runner.stopRuntime(normalized.runId, normalized.parentSessionId);
		await run;
	});

	it("publishes queued admission and FIFO promotion without fabricating child sessions", async () => {
		const cwd = await createWorkspace();
		const tasks = ["first", "second", "third"].map((id) => resolvedBatchTask(cwd, id));
		const taskStates: SubagentBatchTaskLifecycleEvent[] = [];
		const runtimeEvents: string[] = [];
		const pending = new Map<string, () => void>();
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (task, _parentTools, options) => {
				const resolvedTask = tasks.find((candidate) => candidate.request.runId === task.runId)!;
				const childSessionId = `child-${resolvedTask.id}`;
				const emit = (
					type: "subagent_created" | "subagent_started" | "subagent_completed",
					status: SubagentResult["status"],
				) => {
					options?.onEvent?.({
						type,
						runId: `run-${resolvedTask.id}`,
						parentSessionId: task.parentSessionId,
						childSessionId,
						profile: task.role,
						status,
						batchId: options?.batchId,
					});
				};
				emit("subagent_created", "created");
				emit("subagent_started", "running");
				return new Promise<SubagentResult>((resolve) => {
					pending.set(resolvedTask.id, () => {
						pending.delete(resolvedTask.id);
						emit("subagent_completed", "completed");
						resolve(batchResult(resolvedTask));
					});
				});
			},
		};
		const batchPromise = runResolvedSubagentBatch(tasks, ["delegate", "read"], runner, {
			concurrency: 1,
			onTaskState: (event) => taskStates.push(event),
			onEvent: (event) => runtimeEvents.push(`${event.taskId}:${event.type}`),
		});

		expect(taskStates.map((event) => event.type)).toEqual([
			"task_queued",
			"task_queued",
			"task_queued",
			"task_admitted",
		]);
		expect(taskStates.slice(0, 3).map((event) => event.taskId)).toEqual(["first", "second", "third"]);
		await Promise.resolve();
		expect(pending.has("first")).toBe(true);
		expect(runtimeEvents).toEqual(["first:subagent_created", "first:subagent_started"]);
		for (const event of taskStates) {
			expect(event).not.toHaveProperty("childSessionId");
			expect(event).not.toHaveProperty("runId");
		}

		pending.get("first")!();
		for (let attempt = 0; attempt < 20 && !pending.has("second"); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(taskStates.map((event) => event.type)).toEqual([
			"task_queued",
			"task_queued",
			"task_queued",
			"task_admitted",
			"task_admitted",
		]);
		expect(taskStates[taskStates.length - 1]?.taskId).toBe("second");
		pending.get("second")!();
		for (let attempt = 0; attempt < 20 && !pending.has("third"); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(taskStates[taskStates.length - 1]?.taskId).toBe("third");
		pending.get("third")!();
		await batchPromise;
		expect(runtimeEvents).toEqual([
			"first:subagent_created",
			"first:subagent_started",
			"first:subagent_completed",
			"second:subagent_created",
			"second:subagent_started",
			"second:subagent_completed",
			"third:subagent_created",
			"third:subagent_started",
			"third:subagent_completed",
		]);
	});

	it("terminalizes queued tasks on parent cancellation without launching phantom children", async () => {
		const cwd = await createWorkspace();
		const tasks = ["one", "two", "three", "four"].map((id) => resolvedBatchTask(cwd, id));
		const controller = new AbortController();
		const taskStates: SubagentBatchTaskLifecycleEvent[] = [];
		const started: string[] = [];
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (task, _parentTools, options) => {
				const resolvedTask = tasks.find((candidate) => candidate.request.runId === task.runId)!;
				started.push(resolvedTask.id);
				return new Promise<SubagentResult>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve(batchResult(resolvedTask, "cancelled", "cancelled")),
						{ once: true },
					);
				});
			},
		};
		const batchPromise = runResolvedSubagentBatch(tasks, ["delegate", "read"], runner, {
			concurrency: 2,
			signal: controller.signal,
			onTaskState: (event) => taskStates.push(event),
		});
		for (let attempt = 0; attempt < 20 && started.length < 2; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(started).toEqual(["one", "two"]);
		controller.abort();

		const result = await batchPromise;
		expect(result.items.map((item) => item.result.status)).toEqual([
			"cancelled",
			"cancelled",
			"cancelled",
			"cancelled",
		]);
		expect(taskStates.filter((event) => event.type === "task_skipped")).toEqual([
			{
				type: "task_skipped",
				batchId: taskStates[0]?.batchId,
				taskId: "three",
				status: "cancelled",
				reason: "Batch cancelled.",
			},
			{
				type: "task_skipped",
				batchId: taskStates[0]?.batchId,
				taskId: "four",
				status: "cancelled",
				reason: "Batch cancelled.",
			},
		]);
		expect(taskStates.filter((event) => event.type === "task_admitted").map((event) => event.taskId)).toEqual([
			"one",
			"two",
		]);
		expect(started).not.toContain("three");
		expect(started).not.toContain("four");
	});

	it("inspects terminal jobs from both overlays without mutating the session", async () => {
		const harness = await createAsyncToolHarness();
		const inspectSpy = vi.spyOn(SubagentJobRegistry.prototype, "inspect");
		try {
			harness.faux.setResponses([
				fauxAssistantMessage('{"summary":"inspectable fact","evidence":{"paths":["src"]}}'),
			]);
			const accepted = await harness.tools.get("delegate_async").execute(
				"async-inspect",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Inspect the source tree.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			const jobId = accepted.details.accepted.jobId as string;
			await new Promise((resolve) => setTimeout(resolve, 50));
			const entryCount = harness.entries.length;
			const messageCount = harness.sent.length;
			for (const commandName of ["agents", "subagents"]) {
				inspectSpy.mockClear();
				await harness.commands.get(commandName)!.handler("", harness.context);
				const view = harness.getOverlay() as {
					children: Array<{ render(width: number): string[] }>;
					handleInput(data: string): void;
				};
				const text = () => view.children.flatMap((child) => child.render(200)).join("\n");
				expect(text()).toContain("BACKGROUND RECENT");
				view.handleInput("enter");
				expect(text()).not.toContain("Background Job");
				view.handleInput("inspect");
				expect(text()).toContain(`Background Job ${jobId}`);
				expect(text()).toContain("inspectable fact");
				expect(inspectSpy).toHaveBeenCalledTimes(1);
				view.handleInput("enter");
				view.handleInput("inspect");
				expect(inspectSpy).toHaveBeenCalledTimes(1);
				expect(harness.entries).toHaveLength(entryCount);
				expect(harness.sent).toHaveLength(messageCount);
				view.handleInput("escape");
				expect(text()).toContain("ICE Subagents");
				expect(text()).not.toContain("Background Job");
				view.handleInput("escape");
			}
		} finally {
			inspectSpy.mockRestore();
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("blocks new admission with feature-off settings while retained jobs stay owner-inspectable", async () => {
		const disabled = SettingsManager.inMemory({ ice: { subagents: { enabled: false } } });
		const harness = await createAsyncToolHarness({ settingsManager: disabled });
		try {
			const foreground = await harness.tools.get("delegate").execute(
				"feature-off-foreground",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Inspect the source tree.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			expect(foreground).toMatchObject({ isError: true });
			expect(JSON.stringify(foreground)).toMatch(/disabled/i);
			const background = await harness.tools.get("delegate_async").execute(
				"feature-off-background",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Inspect the source tree.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			expect(background).toMatchObject({ isError: true });
			expect(JSON.stringify(background)).toMatch(/disabled/i);
			const retainedEntries: Array<Record<string, unknown>> = [
				{
					type: "custom",
					customType: JOB_ENTRY_TYPE,
					data: {
						schemaVersion: 1,
						sequence: 1,
						job: {
							schemaVersion: 1,
							jobId: "feature-off-terminal",
							ownerSessionId: "owner-a",
							launchLeafId: "leaf-a",
							role: "self",
							status: "completed",
							createdAt: "2026-01-01T00:00:00.000Z",
							startedAt: "2026-01-01T00:00:01.000Z",
							finishedAt: "2026-01-01T00:00:02.000Z",
							runId: "run-feature-off",
							queueOrder: 1,
							resultRef: "job:feature-off-terminal",
						},
						result: {
							schemaVersion: 1,
							jobId: "feature-off-terminal",
							runId: "run-feature-off",
							status: "completed",
							diagnostics: [],
						},
					},
				},
			];
			const restoreHandlers = new Map<
				string,
				(event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown
			>();
			const restoreApi = {
				on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) => {
					restoreHandlers.set(event, handler);
				},
				registerTool: vi.fn(),
				registerCommand: vi.fn(),
				appendEntry: vi.fn(),
				sendMessage: vi.fn(),
			} as unknown as ExtensionAPI;
			iceSubagents(restoreApi);
			const restoreRegisterTool = restoreApi.registerTool as unknown as ReturnType<typeof vi.fn>;
			const context = {
				...harness.context,
				sessionManager: {
					getSessionId: () => "owner-a",
					getLeafId: () => "leaf-a",
					getEntries: () => retainedEntries,
				},
			} as unknown as ExtensionContext;
			await restoreHandlers.get("session_start")!({ type: "session_start", reason: "startup" }, context);
			const restoredTools = new Map(restoreRegisterTool.mock.calls.map((call) => [call[0]?.name, call[0]]));
			const restored = await restoredTools
				.get("inspect_subagent_job")!
				.execute("inspect-feature-off", { jobId: "feature-off-terminal" }, undefined, undefined, context);
			if (restored.isError !== false) throw new Error(`feature-off inspection failed: ${JSON.stringify(restored)}`);
			expect(restored.details).toMatchObject({
				inspection: { job: { jobId: "feature-off-terminal", status: "completed" } },
			});
			const relaunch = await restoredTools.get("delegate")!.execute(
				"feature-off-relaunch",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Inspect the source tree.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				context,
			);
			expect(relaunch).toMatchObject({ isError: true });
			expect(JSON.stringify(relaunch)).toMatch(/disabled/i);
			await restoreHandlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, context);
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("reports scheduling without planned output reservations through delegate_async", async () => {
		const harness = await createAsyncToolHarness();
		try {
			harness.faux.setResponses([fauxAssistantMessage('{"summary":"reserved fact","evidence":{"paths":["src"]}}')]);
			const tool = harness.tools.get("delegate_async");
			const accepted = await tool.execute(
				"async-reservation",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Trace the model runtime.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			expect(accepted).toMatchObject({ isError: false, details: { accepted: { status: "created" } } });
			await new Promise((resolve) => setTimeout(resolve, 50));
			const inspected = await harness.tools
				.get("inspect_subagent_job")
				.execute(
					"inspect-reservation",
					{ jobId: accepted.details.accepted.jobId },
					undefined,
					undefined,
					harness.context,
				);
			expect(inspected).toMatchObject({
				details: {
					inspection: {
						scheduling: {
							ownerActiveJobs: 0,
							ownerQueuedJobs: 0,
						},
					},
				},
			});
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("ingests a natural-prose async completion as a plain final answer without a second finalization turn", async () => {
		const harness = await createAsyncToolHarness();
		try {
			harness.faux.setResponses([
				fauxAssistantMessage("The runtime loads the generated provider catalog and selects the requested model."),
			]);
			const tool = harness.tools.get("delegate_async");
			const accepted = await tool.execute(
				"async-plain",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Trace the model runtime.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			expect(accepted).toMatchObject({ isError: false, details: { accepted: { status: "created" } } });
			await new Promise((resolve) => setTimeout(resolve, 50));
			const inspected = await harness.tools
				.get("inspect_subagent_job")
				.execute(
					"inspect-plain",
					{ jobId: accepted.details.accepted.jobId },
					undefined,
					undefined,
					harness.context,
				);
			expect(inspected).toMatchObject({
				details: {
					inspection: {
						job: { status: "completed" },
						result: {
							reportMode: "plain_final_turn",
							summary: "The runtime loads the generated provider catalog and selects the requested model.",
							verification: {
								verified: true,
								kind: "plain_bounds",
								structuredVerified: false,
							},
						},
					},
				},
			});
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("accepts children beyond the default active-job concurrency into the durable FIFO queue", async () => {
		const harness = await createAsyncToolHarness();
		const names = Array.from(
			{ length: SUBAGENT_CONCURRENCY_LIMITS.bundledDefault + 1 },
			(_, index) => `child-${index + 1}`,
		);
		try {
			harness.faux.setResponses(
				names.map((name) => fauxAssistantMessage(`{"summary":"${name}","evidence":{"paths":["src"]}}`)),
			);
			const tool = harness.tools.get("delegate_async");
			const accepted = await Promise.all(
				names.map((name) =>
					tool.execute(
						`async-${name}`,
						{
							role: "self",
							self: {
								instructions: "Inspect the approved scope and report evidence.",
								capabilities: ["read", "grep", "find", "ls"],
							},
							task: `Trace ${name}.`,
							scope: { roots: ["src"] },
						},
						undefined,
						undefined,
						harness.context,
					),
				),
			);
			const statuses = accepted.map((result) => result.details.accepted.status);
			expect(statuses.filter((status) => status === "created")).toHaveLength(
				SUBAGENT_CONCURRENCY_LIMITS.bundledDefault,
			);
			expect(statuses.at(-1)).toBe("queued");
			expect(accepted.at(-1)).toMatchObject({ isError: false, details: { accepted: { status: "queued" } } });
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("suppresses a second recovery attempt when parent abort cancels an async child", async () => {
		const harness = await createAsyncToolHarness();
		const controller = new AbortController();
		const attempts: number[] = [];
		const runResolved = vi
			.spyOn(NativeSubagentRunner.prototype, "runResolved")
			.mockImplementation(async (request, _activeTools, options) => {
				attempts.push(options?.attempt ?? 0);
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return {
					runId: request.runId,
					parentSessionId: request.parentSessionId,
					childSessionId: "child-cancelled",
					profile: request.profile.name,
					source: request.profile.source,
					status: "failed" as const,
					summary: "transient failure",
					observedOutputBytes: 0,
					partial: false,
					diagnostics: [{ code: "child_runtime_failure" as const, message: "transient", retryable: true }],
				};
			});
		try {
			const context = harness.context as ExtensionContext & { signal?: AbortSignal };
			context.signal = controller.signal;
			await harness.handlers.get("agent_start")!({ type: "agent_start" }, context);
			const accepted = await harness.tools.get("delegate_async")!.execute(
				"parent-abort",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Trace the cancelled child.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				context,
			);
			controller.abort();
			await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, context);
			const inspected = await harness.tools
				.get("inspect_subagent_job")!
				.execute("inspect-abort", { jobId: accepted.details.accepted.jobId }, undefined, undefined, context);
			expect(inspected.details.inspection.job.status).toBe("cancelled");
			expect(attempts).toEqual([1]);
		} finally {
			runResolved.mockRestore();
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("accepts an async child before completion and ignores the original signal after acceptance", async () => {
		const cwd = await createWorkspace();
		const faux = registerFauxProvider();
		try {
			faux.setResponses([fauxAssistantMessage('{"summary":"async fact","evidence":{"paths":["src"]}}')]);
			const authStorage = AuthStorage.inMemory();
			await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
			const modelRuntime = await ModelRuntime.create({
				credentials: authStorage,
				modelsPath: join(cwd, "models.json"),
			});
			const model = faux.getModel();
			modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
			const entries: Array<Record<string, unknown>> = [];
			const sent: unknown[] = [];
			const registerTool = vi.fn();
			const api = {
				on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) {
					handlers.set(event, handler);
				},
				registerTool,
				appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
				sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
				getActiveTools: () => ["delegate", "read"],
			} as unknown as ExtensionAPI;
			iceSubagents(api);
			const context = {
				cwd,
				model,
				scopedModels: [],
				isProjectTrusted: () => false,
				modelRegistry: new ModelRegistry(modelRuntime),
				sessionManager: { getSessionId: () => "owner-a", getLeafId: () => "leaf-a", getEntries: () => entries },
			} as unknown as ExtensionContext;
			await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, context);
			const tool = registerTool.mock.calls.find((call) => call[0]?.name === "delegate_async")?.[0];
			const controller = new AbortController();
			const accepted = await tool.execute(
				"async-call",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Trace the model runtime.",
					scope: { roots: ["src"] },
				},
				controller.signal,
				undefined,
				context,
			);
			expect(accepted).toMatchObject({
				isError: false,
				details: { accepted: { resultRef: expect.stringMatching(/^job:/) } },
			});
			controller.abort();
			await new Promise((resolve) => setTimeout(resolve, 50));
			const inspect = registerTool.mock.calls.find((call) => call[0]?.name === "inspect_subagent_job")?.[0];
			const inspected = await inspect.execute(
				"async-inspect",
				{ jobId: accepted.details.accepted.jobId },
				undefined,
				undefined,
				context,
			);
			expect(inspected).toMatchObject({ isError: false, details: { inspection: { job: { status: "completed" } } } });
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({
				options: { triggerTurn: false },
				message: { customType: JOB_COMPLETION_MESSAGE_TYPE },
			});
			expect((sent[0] as { message: { content: string } }).message.content).not.toContain("async fact");
			await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, context);
		} finally {
			faux.unregister();
		}
	});
});
