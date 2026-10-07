import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { fauxAssistantMessage, registerFauxProvider } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../src/core/sdk.ts";
import { IceAgentViewBridge } from "../src/ice-agent-view-bridge.ts";
import iceSubagents, {
	buildSubagentPrompt,
	NativeSubagentRunner,
	type ReviewFinding,
	resolveReviewTask,
	runResolvedReviewBatch,
	runResolvedSubagentBatch,
	SUBAGENT_BATCH_LIMITS,
	SUBAGENT_PRESENTATION_LIMIT_BYTES,
	type SubagentBatchTaskLifecycleEvent,
	SubagentLiveSessionRegistry,
	type SubagentResult,
	verifySubagentResult,
} from "../src/ice-subagents.ts";
import { SubagentRunSupervisorRegistry } from "../src/subagents/runtime/supervisor.ts";
import {
	batchResult,
	createAsyncToolHarness,
	createNativeSubagentSession,
	createNoopExtensionRunner,
	createWorkspace,
	normalizeSubagentRequest,
	request,
	resolvedBatchTask,
	resolvedReviewTask,
	tempDirs,
	verificationFixture,
} from "./ice-subagents-harness.ts";

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ICE subagent contracts", () => {
	it("keeps the parent available while accepted batch children are still running", async () => {
		const harness = await createAsyncToolHarness();
		let releaseBlockedChild!: () => void;
		let markChildStarted!: () => void;
		const blockedChild = new Promise<void>((resolve) => {
			releaseBlockedChild = resolve;
		});
		const childStarted = new Promise<void>((resolve) => {
			markChildStarted = resolve;
		});
		const instruction = "Inspect the approved scope and return a concise structured report.";
		try {
			harness.faux.setResponses([
				async () => {
					markChildStarted();
					await blockedChild;
					return fauxAssistantMessage("Delayed child completed.");
				},
				fauxAssistantMessage("Sibling completed."),
			]);
			const accepted = await harness.tools.get("delegate_batch")!.execute(
				"batch-background-prompt",
				{
					tasks: ["delayed", "sibling"].map((id) => ({
						id,
						role: "self",
						self: { instructions: instruction, capabilities: ["read", "grep", "find", "ls"] },
						task: `Inspect the source tree for ${id}.`,
						scope: { roots: ["src"] },
					})),
				},
				undefined,
				undefined,
				harness.context,
			);
			expect(accepted).toMatchObject({ isError: false, details: { accepted: { batchId: expect.any(String) } } });
			const batchId = accepted.details.accepted.batchId as string;
			await childStarted;
			const inspection = await harness.tools
				.get("inspect_subagent_batch")!
				.execute("batch-background-inspect", { batchId }, undefined, undefined, harness.context);
			expect(inspection.details.inspection.result).toBeUndefined();
			expect(inspection.details.inspection.tasks.map((task: { status: string }) => task.status)).toContain(
				"running",
			);
			expect(
				inspection.details.inspection.tasks.some(
					(task: { checkIn?: { delivery: string } }) => task.checkIn?.delivery === "armed",
				),
			).toBe(true);
			releaseBlockedChild();
			await vi.waitFor(
				async () => {
					const completed = await harness.tools
						.get("inspect_subagent_batch")!
						.execute("batch-background-completed", { batchId }, undefined, undefined, harness.context);
					expect(completed.details.inspection.result).toBeDefined();
				},
				{ timeout: 5_000, interval: 10 },
			);
		} finally {
			releaseBlockedChild();
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("retains batch output while its aggregate owner survives child deletion", async () => {
		const harness = await createAsyncToolHarness();
		const longReport = JSON.stringify({
			summary: "long structured result ".repeat(2_200),
			evidence: { paths: ["src"] },
			findings: [],
		});
		const taskInput = ["long", "short"].map((id) => ({
			id,
			role: "self",
			self: {
				instructions: "Inspect the approved scope and return structured evidence.",
				capabilities: ["read", "grep", "find", "ls"],
			},
			task: `Inspect the source tree for ${id}.`,
			scope: { roots: ["src"] },
		}));
		try {
			harness.faux.setResponses([
				fauxAssistantMessage(longReport),
				fauxAssistantMessage('{"summary":"Short result.","evidence":{"paths":["src"]},"findings":[]}'),
			]);
			const accepted = await harness.tools
				.get("delegate_batch")!
				.execute("batch-artifact-launch", { tasks: taskInput }, undefined, undefined, harness.context);
			const batchId = accepted.details.accepted.batchId as string;
			const taskRuns = accepted.details.accepted.tasks as Array<{ taskId: string; runId: string }>;
			let aggregate: { items: Array<{ taskId: string; result: SubagentResult }> } | undefined;
			let aggregateText = "";
			await vi.waitFor(
				async () => {
					const inspection = await harness.tools
						.get("inspect_subagent_batch")!
						.execute("batch-artifact-inspect", { batchId }, undefined, undefined, harness.context);
					aggregateText = inspection.content[0]?.text ?? "";
					aggregate = inspection.details.inspection.result as
						| { items: Array<{ taskId: string; result: SubagentResult }> }
						| undefined;
					expect(aggregate).toBeDefined();
					expect(aggregate?.items.some((item) => item.result.output?.artifact)).toBe(true);
				},
				{ timeout: 5_000, interval: 10 },
			);
			expect(Buffer.byteLength(aggregateText)).toBeLessThanOrEqual(SUBAGENT_PRESENTATION_LIMIT_BYTES);
			const artifactItem = aggregate?.items.find((item) => item.result.output?.artifact);
			const artifactId = artifactItem?.result.output?.artifact?.id;
			const childRunId = taskRuns.find((task) => task.taskId === artifactItem?.taskId)?.runId;
			if (!artifactId || !childRunId) throw new Error("Expected a retained batch child artifact and run handle.");
			const readOutput = harness.tools.get("read_subagent_output")!;
			expect(
				await readOutput.execute(
					"batch-artifact-read-before-delete",
					{ artifactId, length: 8 },
					undefined,
					undefined,
					harness.context,
				),
			).toMatchObject({ isError: false });

			const deleted = await harness.tools
				.get("manage_subagent")!
				.execute(
					"batch-artifact-delete-child",
					{ runId: childRunId, action: "delete" },
					undefined,
					undefined,
					harness.context,
				);
			expect(deleted).toMatchObject({ isError: false, details: { deleted: { deleted: true } } });
			expect(
				await readOutput.execute(
					"batch-artifact-read-after-delete",
					{ artifactId, length: 8 },
					undefined,
					undefined,
					harness.context,
				),
			).toMatchObject({ isError: false });
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("releases the final batch-owned output reference when its retained aggregate is evicted", async () => {
		const harness = await createAsyncToolHarness();
		const delegateBatch = harness.tools.get("delegate_batch")!;
		const inspectBatch = harness.tools.get("inspect_subagent_batch")!;
		const readOutput = harness.tools.get("read_subagent_output")!;
		const manage = harness.tools.get("manage_subagent")!;
		const longReport = JSON.stringify({
			summary: "large retained answer ".repeat(2_300),
			evidence: { paths: ["src"] },
			findings: [],
		});
		const shortReport = '{"summary":"Retained result.","evidence":{"paths":["src"]},"findings":[]}';
		const responseCount = 33 * 2;
		harness.faux.setResponses(
			Array.from({ length: responseCount }, (_, index) =>
				fauxAssistantMessage(index === 0 ? longReport : shortReport),
			),
		);
		const tasksForBatch = (index: number) =>
			["left", "right"].map((side) => ({
				id: `${side}-${index}`,
				role: "self",
				self: {
					instructions: "Inspect the approved scope and return structured evidence.",
					capabilities: ["read", "grep", "find", "ls"],
				},
				task: `Inspect the source tree for ${side}.`,
				scope: { roots: ["src"] },
			}));
		const launchAndWait = async (index: number) => {
			const accepted = await delegateBatch.execute(
				`batch-retention-launch-${index}`,
				{ tasks: tasksForBatch(index) },
				undefined,
				undefined,
				harness.context,
			);
			expect(accepted.isError).toBe(false);
			const { batchId, tasks } = accepted.details.accepted as {
				batchId: string;
				tasks: Array<{ taskId: string; runId: string }>;
			};
			let inspectionResult: { items: Array<{ taskId: string; result: SubagentResult }> } | undefined;
			await vi.waitFor(
				async () => {
					const inspection = await inspectBatch.execute(
						`batch-retention-inspect-${index}`,
						{ batchId },
						undefined,
						undefined,
						harness.context,
					);
					inspectionResult = inspection.details.inspection.result as typeof inspectionResult;
					expect(inspectionResult).toBeDefined();
				},
				{ timeout: 5_000, interval: 10 },
			);
			return { batchId, tasks, result: inspectionResult! };
		};

		try {
			const first = await launchAndWait(0);
			const artifactItem = first.result.items.find((item) => item.result.output?.artifact);
			const artifactId = artifactItem?.result.output?.artifact?.id;
			const childRunId = first.tasks.find((task) => task.taskId === artifactItem?.taskId)?.runId;
			if (!artifactId || !childRunId) throw new Error("Expected the first batch to retain a child output artifact.");
			const childDeleted = await manage.execute(
				"batch-retention-delete-child",
				{ runId: childRunId, action: "delete" },
				undefined,
				undefined,
				harness.context,
			);
			expect(childDeleted.isError).toBe(false);
			expect(
				await readOutput.execute(
					"batch-retention-read-before-eviction",
					{ artifactId, length: 8 },
					undefined,
					undefined,
					harness.context,
				),
			).toMatchObject({ isError: false });

			for (let index = 1; index < 32; index++) await launchAndWait(index);
			expect(
				await readOutput.execute(
					"batch-retention-read-while-retained",
					{ artifactId, length: 8 },
					undefined,
					undefined,
					harness.context,
				),
			).toMatchObject({ isError: false });
			await launchAndWait(32);
			const expiredRead = await readOutput.execute(
				"batch-retention-read-after-eviction",
				{ artifactId, length: 8 },
				undefined,
				undefined,
				harness.context,
			);
			expect(expiredRead).toMatchObject({ isError: true, details: { error: { code: "artifact_not_found" } } });
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	}, 30_000);

	it("keeps fork children fresh and isolates sibling snapshots", async () => {
		const cwd = await createWorkspace();
		const first = normalizeSubagentRequest({ ...request(cwd), contextMode: "fork" }, cwd, {
			parentContext: {
				getSessionId: () => "parent-1",
				getLeafId: () => "leaf-1",
				buildSessionContext: () => ({
					messages: [{ role: "user" as const, content: "first fork", timestamp: 1 }],
				}),
			},
		});
		const second = normalizeSubagentRequest({ ...request(cwd), contextMode: "fork" }, cwd, {
			parentContext: {
				getSessionId: () => "parent-2",
				getLeafId: () => "leaf-2",
				buildSessionContext: () => ({
					messages: [{ role: "user" as const, content: "second fork", timestamp: 1 }],
				}),
			},
		});
		let captured: CreateAgentSessionOptions | undefined;
		const fakeSession = { sessionId: "child-fork", messages: [] } as unknown as CreateAgentSessionResult["session"];
		await createNativeSubagentSession(
			{ request: first, parentActiveTools: ["delegate", "read"] },
			async (options) => {
				captured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		);
		expect(captured?.sessionManager?.getEntries()).toEqual([]);
		expect(buildSubagentPrompt(first)).toContain("first fork");
		expect(buildSubagentPrompt(first)).not.toContain("second fork");
		expect(buildSubagentPrompt(second)).toContain("second fork");
		expect(buildSubagentPrompt(second)).not.toContain("first fork");
	});

	it("passes selected skills through review tasks into the child loader", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		const skillPath = join(agentDir, "skills", "security-review", "SKILL.md");
		await mkdir(join(agentDir, "skills", "security-review"), { recursive: true });
		await writeFile(
			skillPath,
			"---\nname: security-review\ndescription: Security review guidance.\n---\nCheck trust boundaries.\n",
		);

		const resolved = resolveReviewTask(
			{
				id: "review-with-skill",
				dimension: "security",
				task: "Review the scoped implementation.",
				scope: { roots: ["src"] },
				resources: { skills: ["security-review"] },
			},
			"parent-1",
			cwd,
			{ agentDir },
		);
		let captured: CreateAgentSessionOptions | undefined;
		const fakeSession = {
			sessionId: "child-review-skill",
			messages: [],
		} as unknown as CreateAgentSessionResult["session"];
		await createNativeSubagentSession(
			{ request: resolved.request, parentActiveTools: ["delegate", "read"], agentDir },
			async (options) => {
				captured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		);

		expect(resolved.request.resources.skills.map((resource) => resource.name)).toEqual(["security-review"]);
		expect(captured?.resourceLoader?.getSkills().skills.map((skill) => skill.name)).toEqual(["security-review"]);
		expect(captured?.resourceLoader?.getSkills().skills[0]?.filePath).toBe(skillPath);
	});

	it("parses structured reviewer findings from a native child report", async () => {
		const cwd = await createWorkspace();
		const rawReport = JSON.stringify({
			summary: "review complete",
			evidence: { paths: ["src"] },
			findings: [
				{
					severity: "high",
					category: "security",
					claim: "The boundary is unsafe.",
					evidence: [{ path: "src" }],
				},
			],
			payload: {},
		});
		const childMessages: AgentMessage[] = [];
		const fakeSession = {
			sessionId: "child-review",
			model: {} as Model<Api>,
			messages: childMessages,
			extensionRunner: createNoopExtensionRunner(),
			subscribe: vi.fn(() => vi.fn()),
			prompt: vi.fn(async () => {
				childMessages.push({
					role: "assistant",
					content: rawReport,
					stopReason: "stop",
				} as unknown as AgentMessage);
			}),
			abort: vi.fn(async () => {}),
			dispose: vi.fn(),
			getSessionStats: vi.fn(() => ({
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
			})),
		} as unknown as CreateAgentSessionResult["session"];
		const result = await new NativeSubagentRunner({
			createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
		}).run(
			{ ...request(cwd), task: "Review security.", outputSchema: { type: "object", additionalProperties: false } },
			["delegate", "read"],
		);
		expect(result.status).toBe("completed");
		expect(result.findings).toEqual([
			{
				severity: "high",
				category: "security",
				claim: "The boundary is unsafe.",
				evidence: [{ path: "src" }],
			},
		]);
	});

	it("exposes internal batch children while live without retaining them", async () => {
		const cwd = await createWorkspace();
		const childMessages: AgentMessage[] = [];
		let markPromptStarted!: () => void;
		const promptStarted = new Promise<void>((resolve) => {
			markPromptStarted = resolve;
		});
		let releasePrompt!: () => void;
		const promptGate = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		const fakeSession = {
			sessionId: "child-internal-batch",
			model: {} as Model<Api>,
			messages: childMessages,
			sessionManager: { getCwd: () => cwd },
			extensionRunner: createNoopExtensionRunner(),
			subscribe: vi.fn(() => vi.fn()),
			prompt: vi.fn(async () => {
				markPromptStarted();
				await promptGate;
				childMessages.push({
					role: "assistant",
					content: '{"summary":"batch complete","evidence":{"paths":["src"]},"payload":{}}',
					stopReason: "stop",
				} as unknown as AgentMessage);
			}),
			abort: vi.fn(async () => {}),
			dispose: vi.fn(),
			getSessionStats: vi.fn(() => ({
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
			})),
		} as unknown as CreateAgentSessionResult["session"];
		const bridge = new IceAgentViewBridge();
		const liveSessions = new SubagentLiveSessionRegistry();
		bridge.connectLiveSessions(liveSessions);
		const runner = new NativeSubagentRunner({
			createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
			agentViewBridge: bridge,
			liveSessionRegistry: liveSessions,
			supervisorRegistry: new SubagentRunSupervisorRegistry<SubagentResult>(),
		});
		const normalized = normalizeSubagentRequest(
			{ ...request(cwd), outputSchema: { type: "object", additionalProperties: false } },
			cwd,
		);

		const runPromise = runner.runResolved(normalized, ["delegate", "read"], {
			management: "internal",
			batchId: "batch-internal",
			taskId: "task-internal",
		});
		await promptStarted;
		expect(liveSessions.list()).toHaveLength(1);
		expect(bridge.getView(normalized.runId)).toMatchObject({
			kind: "subagent",
			live: true,
			taskId: "task-internal",
		});

		releasePrompt();
		const result = await runPromise;
		expect(result.status).toBe("completed");
		expect(liveSessions.list()).toEqual([]);
		expect(bridge.getView(normalized.runId)).toBeUndefined();
		expect(runner.listRetainedChildren(normalized.parentSessionId)).toEqual([]);
	});

	it("bounds sibling concurrency and preserves input result order", async () => {
		const cwd = await createWorkspace();
		const tasks = ["api", "tests", "docs"].map((id) => resolvedBatchTask(cwd, id));
		const pending = new Map<string, () => void>();
		const events: string[] = [];
		const eventRunIds = new Set<string>();
		let active = 0;
		let maximumActive = 0;
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (task, _parentTools, options) => {
				active++;
				maximumActive = Math.max(maximumActive, active);
				options?.onEvent?.({
					type: "subagent_started",
					runId: `run-${task.role}-${task.task}`,
					parentSessionId: task.parentSessionId,
					profile: task.role,
					status: "running",
					batchId: options?.batchId,
				});
				events.push(`${options?.batchId}:${task.task}`);
				eventRunIds.add(`run-${task.role}-${task.task}`);
				return new Promise<SubagentResult>((resolve) => {
					pending.set(task.task, () => {
						pending.delete(task.task);
						active--;
						resolve(batchResult(tasks.find((candidate) => candidate.request.task === task.task)!));
					});
				});
			},
		};
		const batchPromise = runResolvedSubagentBatch(tasks, ["delegate", "read"], runner, { concurrency: 2 });
		for (let attempt = 0; attempt < 20 && pending.size < 2; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(pending.size).toBe(2);
		expect(maximumActive).toBe(2);
		pending.get(tasks[1]!.request.task)!();
		for (let attempt = 0; attempt < 20 && !pending.has(tasks[2]!.request.task); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		pending.get(tasks[2]!.request.task)!();
		pending.get(tasks[0]!.request.task)!();
		const result = await batchPromise;
		expect(result.items.map((item) => item.taskId)).toEqual(["api", "tests", "docs"]);
		expect(result.status).toBe("completed");
		expect(events.every((event) => event.startsWith(`${result.batchId}:`))).toBe(true);
		expect(eventRunIds).toHaveLength(3);
		expect(result.usage).toEqual({
			inputTokens: 3,
			outputTokens: 6,
			cacheReadTokens: 9,
			cacheWriteTokens: 12,
			cost: 1.5,
		});
	});

	it("suppresses a fail-fast sibling retry before runner invocation", async () => {
		const cwd = await createWorkspace();
		const tasks = [resolvedBatchTask(cwd, "retrying"), resolvedBatchTask(cwd, "failed")];
		const calls = new Map<string, number>();
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (request, _tools, options) => {
				const task = tasks.find((candidate) => candidate.request === request)!;
				const attempt = (calls.get(task.id) ?? 0) + 1;
				calls.set(task.id, attempt);
				if (task.id === "retrying") {
					return new Promise<SubagentResult>((resolve) => {
						const finish = () =>
							resolve({
								...batchResult(task, "failed", "temporary"),
								diagnostics: [
									{ code: "child_runtime_failure" as const, message: "temporary", retryable: true },
								],
							});
						if (options?.signal?.aborted) finish();
						else options?.signal?.addEventListener("abort", finish, { once: true });
					});
				}
				return batchResult(task, "failed", `failure-${attempt}`);
			},
		};
		const result = await runResolvedSubagentBatch(tasks, ["delegate", "read"], runner, {
			concurrency: 2,
			failFast: true,
		});
		expect(calls).toEqual(
			new Map([
				["retrying", 1],
				["failed", 1],
			]),
		);
		expect(result.items[0]?.result.status).toBe("cancelled");
		expect(result.items[0]?.result.diagnostics[0]).toMatchObject({ code: "cancellation" });
		expect(result.items).toHaveLength(2);
	});

	it("does not suppress a retry based on batch output-byte reservations", async () => {
		const cwd = await createWorkspace();
		const task = resolvedBatchTask(cwd, "budget-blocked");
		const attemptBytes = 15 * 1024;
		let calls = 0;
		const result = await runResolvedSubagentBatch([task], ["delegate", "read"], {
			runResolved: async () => {
				calls++;
				return {
					...batchResult(task, "failed"),
					childSessionId: undefined,
					partial: false,
					retrySafeStartup: true,
					observedTurns: 0,
					observedOutputBytes: attemptBytes,
					diagnostics: [{ code: "child_startup_failure" as const, message: "temporary", retryable: true }],
				};
			},
		});
		expect(calls).toBe(2);
		expect(result.items[0]?.result.diagnostics[0]?.code).toBe("child_startup_failure");
		expect(result.items[0]?.result.recovery?.totalObservedOutputBytes).toBe(attemptBytes * 2);
		expect(result).not.toHaveProperty("budget");
	});

	it("runs siblings sequentially when concurrency is one", async () => {
		const cwd = await createWorkspace();
		const tasks = ["first", "second", "third"].map((id) => resolvedBatchTask(cwd, id));
		const launchOrder: string[] = [];
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (task) => {
				const resolvedTask = tasks.find((candidate) => candidate.request.runId === task.runId)!;
				launchOrder.push(resolvedTask.id);
				return batchResult(resolvedTask);
			},
		};
		const result = await runResolvedSubagentBatch(tasks, ["delegate", "read"], runner, { concurrency: 1 });
		expect(launchOrder).toEqual(["first", "second", "third"]);
		expect(result.items.map((item) => item.taskId)).toEqual(launchOrder);
	});

	it("admits siblings without output-byte reservations while preserving concurrency", async () => {
		const cwd = await createWorkspace();
		const tasks = ["short", "blocked"].map((id) => resolvedBatchTask(cwd, id));
		let calls = 0;
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (task) => {
				calls++;
				const resolvedTask = tasks.find((candidate) => candidate.request.runId === task.runId)!;
				return batchResult(resolvedTask, "completed", calls === 1 ? "ok" : "second");
			},
		};
		const taskStates: SubagentBatchTaskLifecycleEvent[] = [];
		const batch = await runResolvedSubagentBatch(tasks, ["delegate", "read"], runner, {
			concurrency: 1,
			onTaskState: (event) => taskStates.push(event),
		});
		expect(calls).toBe(2);
		expect(batch.items.every((item) => item.result.status === "completed")).toBe(true);
		expect(batch).not.toHaveProperty("budget");
		expect(taskStates.map((event) => event.type)).toEqual([
			"task_queued",
			"task_queued",
			"task_admitted",
			"task_admitted",
		]);
		expect(taskStates.map((event) => event.taskId)).toEqual(["short", "blocked", "short", "blocked"]);
	});

	it("does not publish a batch output budget when observed bytes equal the former cap", async () => {
		const cwd = await createWorkspace();
		const tasks = [resolvedBatchTask(cwd, "observed")];
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (task) => {
				const resolvedTask = tasks.find((candidate) => candidate.request.runId === task.runId)!;
				return { ...batchResult(resolvedTask), observedOutputBytes: 1_024 };
			},
		};
		const result = await runResolvedSubagentBatch(tasks, ["delegate", "read"], runner);
		expect(result.status).toBe("completed");
		expect(result).not.toHaveProperty("budget");
	});

	it("does not reject or charge a batch when observed output exceeds the former cap", async () => {
		const cwd = await createWorkspace();
		const task = resolvedBatchTask(cwd, "overrun");
		const result = await runResolvedSubagentBatch([task], ["delegate", "read"], {
			runResolved: async () => ({
				...batchResult(task),
				observedOutputBytes: 48 * 1024,
			}),
		});
		expect(result.status).toBe("completed");
		expect(result.items[0]?.result.observedOutputBytes).toBe(48 * 1024);
		expect(result).not.toHaveProperty("budget");
	});

	it("preserves settled siblings when one worker fails", async () => {
		const cwd = await createWorkspace();
		const tasks = ["failed", "success"].map((id) => resolvedBatchTask(cwd, id));
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (task) => {
				const resolvedTask = tasks.find((candidate) => candidate.request.runId === task.runId)!;
				return batchResult(resolvedTask, resolvedTask.id === "failed" ? "failed" : "completed", resolvedTask.id);
			},
		};
		const result = await runResolvedSubagentBatch(tasks, ["delegate", "read"], runner);
		expect(result.status).toBe("partial");
		expect(result.items[0]?.result.status).toBe("failed");
		expect(result.items[1]?.verification.verified).toBe(true);
	});

	it("review fail-fast aborts an active sibling and suppresses queued work", async () => {
		const cwd = await createWorkspace();
		const tasks = [
			resolvedReviewTask(cwd, "success", "correctness"),
			resolvedReviewTask(cwd, "invalid", "security"),
			resolvedReviewTask(cwd, "active", "tests"),
			resolvedReviewTask(cwd, "queued", "regressions"),
		];
		const started = new Set<string>();
		let releaseInvalid: (() => void) | undefined;
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (task, _tools, options) => {
				const reviewTask = tasks.find((candidate) => candidate.request.runId === task.runId)!;
				started.add(reviewTask.id);
				if (reviewTask.id === "success") return batchResult(reviewTask);
				if (reviewTask.id === "invalid") {
					return new Promise<SubagentResult>((resolve) => {
						releaseInvalid = () =>
							resolve({
								...batchResult(reviewTask),
								findings: [
									{
										severity: "high",
										category: "security",
										claim: "Invalid evidence.",
										evidence: [{ path: "../outside" }],
									},
								],
							});
					});
				}
				if (reviewTask.id === "active") {
					return new Promise<SubagentResult>((resolve) => {
						options?.signal?.addEventListener(
							"abort",
							() => resolve(batchResult(reviewTask, "cancelled", "aborted")),
							{ once: true },
						);
					});
				}
				throw new Error("queued reviewer must not launch");
			},
		};
		const batchPromise = runResolvedReviewBatch(tasks, ["delegate", "read"], runner, {
			concurrency: 2,
			failFast: true,
		});
		for (let attempt = 0; attempt < 20 && !started.has("active"); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(started).toEqual(new Set(["success", "invalid", "active"]));
		releaseInvalid!();
		const result = await batchPromise;
		expect(started).not.toContain("queued");
		expect(result.status).toBe("partial");
		expect(result.reviewers.map((reviewer) => reviewer.taskId)).toEqual(["success", "invalid", "active", "queued"]);
		expect(result.reviewers.map((reviewer) => reviewer.result.status)).toEqual([
			"completed",
			"verification_failed",
			"cancelled",
			"failed",
		]);
		expect(result.reviewers[0]?.verification.verified).toBe(true);
		expect(result.reviewers[1]?.verification.verified).toBe(false);
	});

	it("resolves report mode per the ingestion matrix and forces reviewers through structured reports", async () => {
		const cwd = await createWorkspace();
		const rows = [
			{
				name: "ordinary delegate",
				buildRequest: () => request(cwd),
				expected: "plain_final_turn",
			},
			{
				name: "output-schema delegate",
				buildRequest: () => ({ ...request(cwd), outputSchema: { type: "object", additionalProperties: false } }),
				expected: "structured_report",
			},
			{
				name: "acceptance-criteria delegate",
				buildRequest: () => ({
					...request(cwd),
					acceptanceCriteria: [{ id: "check-build", requirement: "The build passes.", required: true }],
				}),
				expected: "structured_report",
			},
		] as const;
		for (const row of rows) {
			const normalized = normalizeSubagentRequest(row.buildRequest(), cwd);
			expect(normalized.reportMode, row.name).toBe(row.expected);
		}
		const handBuiltPlainReviewer = resolvedReviewTask(cwd, "forced-plain", "tests");
		expect(handBuiltPlainReviewer.request.reportMode).toBe("plain_final_turn");
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (resolved) => {
				expect(resolved.reportMode).toBe("structured_report");
				expect(resolved.readOnlyReview).toBe(true);
				return batchResult(handBuiltPlainReviewer);
			},
		};
		const result = await runResolvedReviewBatch([handBuiltPlainReviewer], ["delegate", "read"], runner);
		expect(result.reviewers[0]?.verification.verified).toBe(true);
	});

	it("cancels active and queued workers without launching new siblings", async () => {
		const cwd = await createWorkspace();
		const tasks = ["one", "two", "three", "four"].map((id) => resolvedBatchTask(cwd, id));
		const controller = new AbortController();
		const pending = new Map<string, () => void>();
		let calls = 0;
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (task, _tools, options) => {
				calls++;
				const resolvedTask = tasks.find((candidate) => candidate.request.runId === task.runId)!;
				return new Promise<SubagentResult>((resolve) => {
					const finish = () => resolve(batchResult(resolvedTask, "cancelled", "cancelled"));
					pending.set(resolvedTask.id, finish);
					options?.signal?.addEventListener("abort", finish, { once: true });
				});
			},
		};
		const batchPromise = runResolvedSubagentBatch(tasks, ["delegate", "read"], runner, {
			concurrency: 2,
			signal: controller.signal,
		});
		for (let attempt = 0; attempt < 20 && calls < 2; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		controller.abort();
		const result = await batchPromise;
		expect(calls).toBe(2);
		expect(result.status).toBe("cancelled");
		expect(result.items.every((item) => item.result.status === "cancelled")).toBe(true);
	});

	it("resolves review tasks with canonical evidence and a structured child contract", async () => {
		const cwd = await createWorkspace();
		const resolved = resolveReviewTask(
			{
				id: "security",
				dimension: "security",
				task: "Inspect the authentication boundary.",
				scope: { roots: ["src"] },
				evidence: [{ path: "src" }],
			},
			"parent-1",
			cwd,
		);
		expect(resolved.request.agentKind).toBe("self");
		expect(resolved.request.scope.roots).toEqual([join(cwd, "src")]);
		expect(resolved.request.task).toMatch(/findings/);
		expect(resolved.request.task).toContain(join(cwd, "src"));
	});

	it("rejects an invalid resolved task before any batch worker launches", async () => {
		const cwd = await createWorkspace();
		const task = resolvedBatchTask(cwd, "one");
		const calls: string[] = [];
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (request) => {
				calls.push(request.task);
				return batchResult(task);
			},
		};
		await expect(
			runResolvedSubagentBatch(
				[
					{ ...task, id: "duplicate" },
					{ ...task, id: "duplicate" },
				],
				["delegate", "read"],
				runner,
			),
		).rejects.toThrowError(/unique/i);
		expect(calls).toEqual([]);
	});

	it("rejects invalid concurrency before any batch worker launches", async () => {
		const cwd = await createWorkspace();
		const task = resolvedBatchTask(cwd, "one");
		let calls = 0;
		await expect(
			runResolvedSubagentBatch(
				[task],
				["delegate", "read"],
				{
					runResolved: async () => {
						calls++;
						return batchResult(task);
					},
				},
				{ concurrency: SUBAGENT_BATCH_LIMITS.maxConcurrency + 1 },
			),
		).rejects.toThrowError(/concurrency/i);
		expect(calls).toBe(0);
	});

	it("preserves reviewer dimensions, order, and contradictory findings", async () => {
		const cwd = await createWorkspace();
		const tasks = [
			resolvedReviewTask(cwd, "security", "security"),
			resolvedReviewTask(cwd, "correctness", "correctness"),
			resolvedReviewTask(cwd, "tests", "tests"),
		];
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (task) => {
				const reviewTask = tasks.find((candidate) => candidate.request.runId === task.runId)!;
				const claim =
					reviewTask.id === "security" ? "Authentication boundary is safe." : "Authentication boundary is risky.";
				const finding: ReviewFinding = {
					severity: reviewTask.id === "tests" ? "low" : "high",
					category: reviewTask.dimension,
					claim,
					evidence: [{ path: "src" }],
				};
				return { ...batchResult(reviewTask), findings: [finding] };
			},
		};
		const result = await runResolvedReviewBatch(tasks, ["delegate", "read"], runner, { concurrency: 2 });
		expect(result.status).toBe("completed");
		expect(result.reviewers.map((reviewer) => reviewer.taskId)).toEqual(["security", "correctness", "tests"]);
		expect(result.reviewers.map((reviewer) => reviewer.dimension)).toEqual(["security", "correctness", "tests"]);
		expect(result.reviewers.map((reviewer) => reviewer.findings[0]?.claim)).toEqual([
			"Authentication boundary is safe.",
			"Authentication boundary is risky.",
			"Authentication boundary is risky.",
		]);
		expect(result.reviewers.every((reviewer) => reviewer.verification.verified)).toBe(true);
		expect(result).not.toHaveProperty("items");
	});

	it("isolates invalid reviewer evidence without dropping valid siblings", async () => {
		const cwd = await createWorkspace();
		const tasks = [resolvedReviewTask(cwd, "valid", "correctness"), resolvedReviewTask(cwd, "invalid", "security")];
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (task) => {
				const reviewTask = tasks.find((candidate) => candidate.request.runId === task.runId)!;
				return {
					...batchResult(reviewTask),
					findings: [
						{
							severity: "medium",
							category: reviewTask.dimension,
							claim: reviewTask.id,
							evidence: [{ path: reviewTask.id === "valid" ? "src" : "../outside" }],
						},
					],
				};
			},
		};
		const result = await runResolvedReviewBatch(tasks, ["delegate", "read"], runner);
		expect(result.status).toBe("partial");
		expect(result.reviewers[0]?.verification.verified).toBe(true);
		expect(result.reviewers[1]?.verification.verified).toBe(false);
		expect(result.reviewers[0]?.findings).toHaveLength(1);
		expect(result.reviewers[1]?.findings).toEqual([]);
	});

	it("runs slow, fast, and failing siblings through the native faux provider", async () => {
		const cwd = await createWorkspace();
		const faux = registerFauxProvider();
		try {
			faux.setResponses([
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return fauxAssistantMessage('{"summary":"slow fact","evidence":{"paths":["src"]}}');
				},
				() => fauxAssistantMessage('{"summary":"fast fact","evidence":{"paths":["src"]}}'),
				() => Promise.reject(new Error("faux failure")),
			]);
			const authStorage = AuthStorage.inMemory();
			await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
			const modelRuntime = await ModelRuntime.create({
				credentials: authStorage,
				modelsPath: join(cwd, "models.json"),
			});
			const model = faux.getModel();
			modelRuntime.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				api: model.api,
				models: [model],
			});
			const tasks = ["slow", "fast", "failed"].map((id) => ({ ...resolvedBatchTask(cwd, id), model }));
			const result = await runResolvedSubagentBatch(
				tasks,
				["delegate", "read"],
				new NativeSubagentRunner({ agentDir: cwd }),
				{
					concurrency: 2,
					modelRuntime,
				},
			);
			expect(result.status).toBe("partial");
			expect(result.items.map((item) => item.result.status)).toEqual(["completed", "completed", "failed"]);
			expect(result.items.slice(0, 2).every((item) => item.verification.verified)).toBe(true);
			expect(faux.state.callCount).toBe(3);
		} finally {
			faux.unregister();
		}
	});

	it("memoizes one parent fork snapshot across forked batch siblings", async () => {
		const cwd = await createWorkspace();
		const faux = registerFauxProvider();
		const buildSessionContext = vi.fn(() => ({
			messages: [{ role: "user" as const, content: "parent context", timestamp: 1 }],
		}));
		try {
			faux.setResponses([
				fauxAssistantMessage('{"summary":"first fact","evidence":{"paths":["src"]}}'),
				fauxAssistantMessage('{"summary":"second fact","evidence":{"paths":["src"]}}'),
			]);
			const authStorage = AuthStorage.inMemory();
			await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
			const modelRuntime = await ModelRuntime.create({
				credentials: authStorage,
				modelsPath: join(cwd, "models.json"),
			});
			const model = faux.getModel();
			modelRuntime.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				api: model.api,
				models: [model],
			});
			const registerTool = vi.fn();
			iceSubagents({
				on: vi.fn(),
				getActiveTools: () => ["delegate", "read"],
				registerTool,
			} as unknown as ExtensionAPI);
			const tool = registerTool.mock.calls.find((call) => call[0]?.name === "delegate_batch")?.[0];
			const result = await tool.execute(
				"fork-batch-call",
				{
					tasks: [
						{
							id: "first",
							role: "self",
							self: {
								instructions: "Inspect the approved scope and report evidence.",
								capabilities: ["read", "grep", "find", "ls"],
							},
							task: "Trace first.",
							scope: { roots: ["src"] },
							contextMode: "fork",
						},
						{
							id: "second",
							role: "self",
							self: {
								instructions: "Inspect the approved scope and report evidence.",
								capabilities: ["read", "grep", "find", "ls"],
							},
							task: "Trace second.",
							scope: { roots: ["src"] },
							contextMode: "fork",
						},
					],
				},
				undefined,
				undefined,
				{
					cwd,
					model,
					scopedModels: [],
					isProjectTrusted: () => false,
					modelRegistry: new ModelRegistry(modelRuntime),
					sessionManager: {
						getSessionId: () => "parent-1",
						getLeafId: () => "leaf-1",
						buildSessionContext,
					},
				} as unknown as ExtensionContext,
			);
			expect(result).toMatchObject({ isError: false });
			expect(buildSessionContext).toHaveBeenCalledOnce();
		} finally {
			faux.unregister();
		}
	});

	it("exposes batch fail-fast without a caller output budget", () => {
		const registerTool = vi.fn();
		iceSubagents({ on: vi.fn(), registerTool } as unknown as ExtensionAPI);
		const tool = registerTool.mock.calls.find((call) => call[0]?.name === "delegate_batch")?.[0];
		expect(tool.parameters).toMatchObject({
			properties: {
				failFast: { type: "boolean" },
			},
		});
		expect(tool.parameters.properties.tasks.items.properties.contextPacket).toMatchObject({ type: "object" });
		expect(tool.parameters.properties).not.toHaveProperty("totalBudgetBytes");
		expect(tool.parameters.additionalProperties).toBe(false);
	});

	it("preserves bounded review claims as unresolved parent-side claims", async () => {
		const cwd = await createWorkspace();
		const { normalized, result } = verificationFixture(cwd);
		const verified = verifySubagentResult(
			{
				...result,
				findings: [
					{
						severity: "high",
						category: "security",
						claim: "The boundary needs review.",
						evidence: [{ path: "src" }],
					},
				],
			},
			normalized,
		);
		expect(verified).toMatchObject({ verified: true, unresolvedClaims: ["The boundary needs review."] });
	});
});
