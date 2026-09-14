import { describe, expect, it } from "vitest";
import type { SubagentJobInspection, SubagentJobStatus } from "../src/ice-subagent-jobs.ts";
import {
	createObservatoryState,
	durableJobEntryKeys,
	formatCompletionInboxRows,
	formatDurableSubagentJobDetail,
	formatObservatoryRows,
	formatProgressSnapshot,
	formatToolCall,
	isDurableJobInspectable,
	normalizeProgressPath,
	OBSERVATORY_RECENT_LIMIT,
	type ObservatoryRuntimeInput,
	type ObservatoryState,
	projectDurableSubagentJob,
	projectDurableSubagentJobResult,
	projectSubagentCompletionInbox,
	reduceObservatoryEvent,
	reduceWorkflowProgress,
	type SubagentCompletionInboxSessionEntry,
	SubagentObservatoryStore,
	type SubagentProgressSnapshot,
} from "../src/ice-subagent-observatory.ts";
import type { SubagentBatchTaskLifecycleEvent, SubagentEvent, SubagentUsage } from "../src/ice-subagents.ts";

const usage: SubagentUsage = {
	inputTokens: 10,
	outputTokens: 5,
	cacheReadTokens: 2,
	cacheWriteTokens: 1,
	cost: 0.01,
};

function runtimeEvent(
	type: SubagentEvent["type"],
	status: SubagentEvent["status"],
	overrides: Omit<Partial<ObservatoryRuntimeInput>, "event"> & { event?: Partial<SubagentEvent> } = {},
): ObservatoryRuntimeInput {
	const { event: eventOverrides, ...inputOverrides } = overrides;
	return {
		streamKey: "tool-1",
		toolName: "delegate",
		nowMs: 1_000,
		cwd: "/repo",
		event: {
			type,
			runId: "run-1",
			parentSessionId: "parent-1",
			profile: "explore",
			status,
			...eventOverrides,
		} as SubagentEvent,
		...inputOverrides,
	};
}

function snapshotFor(key: string, overrides: Partial<SubagentProgressSnapshot> = {}): SubagentProgressSnapshot {
	return {
		schemaVersion: 1,
		streamKey: key,
		toolName: "delegate",
		runId: "run-1",
		role: "explore",
		status: "completed",
		phase: "completed",
		startedAtMs: 0,
		elapsedMs: 100,
		activity: [],
		attemptHistory: [],
		diagnostics: [],
		terminal: true,
		...overrides,
	};
}

function apply(state: ObservatoryState, input: ObservatoryRuntimeInput): ObservatoryState {
	return reduceObservatoryEvent(state, input);
}

function durableInspectionFor(jobId: string, status: SubagentJobStatus, queuePosition?: number): SubagentJobInspection {
	const terminal = !["created", "queued", "running"].includes(status);
	return {
		job: {
			schemaVersion: 1,
			jobId,
			ownerSessionId: "owner-a",
			launchLeafId: "leaf-a",
			role: "explore",
			model: "faux/faux",
			status,
			createdAt: "2026-01-01T00:00:00.000Z",
			...(status === "queued" ? { queuedAt: "2026-01-01T00:00:01.000Z" } : {}),
			...(status === "running" ? { startedAt: "2026-01-01T00:00:01.000Z" } : {}),
			...(terminal ? { finishedAt: "2026-01-01T00:00:02.000Z" } : {}),
			plannedOutputBytes: 24 * 1024,
			reservedOutputBytes: terminal ? 0 : 24 * 1024,
			queueOrder: queuePosition,
			resultRef: `job:${jobId}`,
		} as SubagentJobInspection["job"],
		...(queuePosition !== undefined ? { queuePosition } : {}),
		budget: {
			plannedOutputBytes: 24 * 1024,
			reservedOutputBytes: terminal ? 0 : 24 * 1024,
			ownerReservedOutputBytes: terminal ? 0 : 24 * 1024,
			ownerBudgetBytes: 256 * 1024,
		},
		...(terminal
			? {
					result: {
						schemaVersion: 1,
						jobId,
						status: status as "completed",
						summary: "task=secret transcript",
						diagnostics: [{ code: "provider_secret=hidden" }],
					},
				}
			: {}),
	} as SubagentJobInspection;
}

function completionEntry(
	jobId: string,
	status: string,
	resultRef: string,
	timestamp: string,
	overrides: Partial<SubagentCompletionInboxSessionEntry> = {},
): SubagentCompletionInboxSessionEntry {
	return {
		type: "custom_message",
		customType: "ice-subagent-job-completion",
		timestamp,
		details: { jobId, status, resultRef },
		content: "safe metadata",
		...overrides,
	};
}

describe("subagent observatory reducer", () => {
	it("tracks lifecycle, current child tool, usage, and normalized path", () => {
		let state = createObservatoryState();
		state = apply(state, runtimeEvent("subagent_created", "created", { nowMs: 1_000 }));
		state = apply(state, runtimeEvent("subagent_started", "running", { nowMs: 1_100, model: "cx/gpt-5.6-luna" }));
		state = apply(
			state,
			runtimeEvent("subagent_tool_start", "running", {
				nowMs: 1_500,
				currentPath: "/repo/src/ice-subagents.ts",
				event: { toolName: "edit" },
			}),
		);
		state = apply(state, runtimeEvent("subagent_completed", "completed", { nowMs: 2_000, usage }));

		expect(state.active).toHaveLength(0);
		expect(state.recent).toHaveLength(1);
		expect(state.recent[0]).toMatchObject({
			model: "cx/gpt-5.6-luna",
			status: "completed",
			currentTool: "edit",
			currentPath: "src/ice-subagents.ts",
			elapsedMs: 1_000,
			usage,
		});
	});

	it("keeps batch children independent", () => {
		let state = createObservatoryState();
		state = apply(
			state,
			runtimeEvent("subagent_started", "running", { streamKey: "batch/task-a", taskId: "task-a" }),
		);
		state = apply(
			state,
			runtimeEvent("subagent_started", "running", {
				streamKey: "batch/task-b",
				taskId: "task-b",
				event: { runId: "run-b", profile: "review" },
			}),
		);
		state = apply(
			state,
			runtimeEvent("subagent_completed", "completed", { streamKey: "batch/task-a", taskId: "task-a" }),
		);

		expect(state.active.map((entry) => entry.taskId)).toEqual(["task-b"]);
		expect(state.recent.map((entry) => entry.taskId)).toEqual(["task-a"]);
	});

	it("preserves retry history while replacing the active attempt", () => {
		let state = createObservatoryState();
		state = apply(state, runtimeEvent("subagent_started", "running", { attempt: 1, nowMs: 1_000 }));
		state = apply(
			state,
			runtimeEvent("subagent_failed", "failed", {
				attempt: 1,
				nowMs: 1_200,
				event: { runId: "run-1", status: "failed" },
			}),
		);
		state = apply(
			state,
			runtimeEvent("subagent_started", "running", {
				attempt: 2,
				nowMs: 1_300,
				event: { runId: "run-2" },
			}),
		);

		expect(state.recent).toHaveLength(0);
		expect(state.active[0]).toMatchObject({ runId: "run-2", attempt: 2, status: "running" });
		expect(state.active[0]?.attemptHistory).toEqual([{ attempt: 1, runId: "run-1", status: "failed" }]);
	});

	it("ignores stale nonterminal events after terminal completion", () => {
		let state = createObservatoryState();
		state = apply(state, runtimeEvent("subagent_completed", "completed", { nowMs: 2_000 }));
		state = apply(
			state,
			runtimeEvent("subagent_tool_start", "running", {
				nowMs: 2_100,
				event: { toolName: "read" },
			}),
		);

		expect(state.active).toHaveLength(0);
		expect(state.recent[0]?.status).toBe("completed");
		expect(state.recent[0]?.currentTool).toBeUndefined();
	});

	it("evicts terminal runs oldest-first", () => {
		let state = createObservatoryState();
		for (let index = 0; index < OBSERVATORY_RECENT_LIMIT + 2; index++) {
			state = reduceWorkflowProgress(state, {
				streamKey: `tool-${index}`,
				toolName: "delegate",
				runId: `run-${index}`,
				phase: "proposal_ready",
				status: "completed",
				nowMs: index,
			});
		}

		expect(state.recent).toHaveLength(OBSERVATORY_RECENT_LIMIT);
		expect(state.recent[0]?.runId).toBe("run-2");
		expect(state.recent[state.recent.length - 1]?.runId).toBe(`run-${OBSERVATORY_RECENT_LIMIT + 1}`);
	});

	it("keeps integrate workflow active after inspection until integration completes", () => {
		let state = createObservatoryState();
		state = reduceWorkflowProgress(state, {
			streamKey: "integrate-1",
			toolName: "integrate_writer_patch",
			runId: "writer-1",
			phase: "inspected",
			status: "running",
			nowMs: 1,
		});
		expect(state.active[0]).toMatchObject({ phase: "inspected", status: "running", terminal: false });
		state = reduceWorkflowProgress(state, {
			streamKey: "integrate-1",
			toolName: "integrate_writer_patch",
			runId: "writer-1",
			phase: "applying",
			status: "running",
			nowMs: 2,
		});
		state = reduceWorkflowProgress(state, {
			streamKey: "integrate-1",
			toolName: "integrate_writer_patch",
			runId: "writer-1",
			phase: "verifying",
			status: "running",
			nowMs: 3,
		});
		state = reduceWorkflowProgress(state, {
			streamKey: "integrate-1",
			toolName: "integrate_writer_patch",
			runId: "writer-1",
			phase: "integrated",
			status: "completed",
			nowMs: 4,
		});
		expect(state.active).toHaveLength(0);
		expect(state.recent[0]).toMatchObject({ phase: "integrated", status: "completed", terminal: true });
	});

	it("isolates throwing observatory listeners from state reduction", () => {
		const store = new SubagentObservatoryStore();
		store.subscribe(() => {
			throw new Error("ui render failed");
		});
		expect(() =>
			store.applyWorkflow({
				streamKey: "run-throwing-listener",
				toolName: "delegate",
				phase: "running",
				status: "running",
				nowMs: 1,
			}),
		).not.toThrow();
		expect(store.getState().active[0]).toMatchObject({ streamKey: "run-throwing-listener" });
	});

	it("normalizes repo-relative paths and drops outside paths", () => {
		expect(normalizeProgressPath("/repo", "src/file.ts")).toBe("src/file.ts");
		expect(normalizeProgressPath("/repo", "/repo/src/file.ts")).toBe("src/file.ts");
		expect(normalizeProgressPath("/repo", "/tmp/writer-worktree/src/file.ts")).toBeUndefined();
		expect(normalizeProgressPath("/repo", "../secrets.txt")).toBeUndefined();
	});

	it("renders deterministic calls, rows, and store notifications", () => {
		expect(formatToolCall("delegate", { role: "explore", task: "secret transcript" })).toBe("delegate explore");
		expect(formatToolCall("delegate_batch", { tasks: [{ id: "one" }, { id: "two" }] })).toBe(
			"delegate_batch 2 tasks",
		);
		expect(formatToolCall("delegate_write", { task: "edit" })).toBe("delegate_write isolated worktree");

		const state = reduceWorkflowProgress(createObservatoryState(), {
			streamKey: "writer-1",
			toolName: "delegate_write",
			runId: "a81c7f00",
			role: "writer",
			model: "cx/gpt-5.6-luna",
			phase: "proposal_ready",
			status: "completed",
			changedFileCount: 3,
			artifactReady: true,
			nowMs: 24_000,
		});
		const rows = formatObservatoryRows(state, 0, new Set(["writer-1"]));
		expect(rows.join("\n")).toContain(">✓ a81c7f delegate_write completed 0:00");
		expect(rows.join("\n")).toContain("model cx/gpt-5.6-luna");
		expect(rows.join("\n")).not.toContain("secret transcript");

		const store = new SubagentObservatoryStore();
		let notifications = 0;
		const unsubscribe = store.subscribe(() => notifications++);
		store.applyWorkflow({ streamKey: "run-1", toolName: "delegate", phase: "running", status: "running", nowMs: 1 });
		unsubscribe();
		store.applyWorkflow({
			streamKey: "run-1",
			toolName: "delegate",
			phase: "completed",
			status: "completed",
			nowMs: 2,
		});
		expect(notifications).toBe(1);
		expect(store.getState().recent[0]?.status).toBe("completed");
	});

	it("projects queued batch tasks and typed aggregate counts", () => {
		const store = new SubagentObservatoryStore();
		store.applyWorkflow({
			streamKey: "batch-call",
			toolName: "delegate_batch",
			role: "batch",
			phase: "created",
			status: "running",
			batchCounts: {
				total: 3,
				queued: 0,
				starting: 0,
				running: 0,
				completed: 0,
				failed: 0,
				cancelled: 0,
				timedOut: 0,
			},
			nowMs: 1,
		});
		const lifecycle: readonly SubagentBatchTaskLifecycleEvent[] = [
			{ type: "task_queued", batchId: "batch-1", taskId: "task-a", role: "explore", index: 0 },
			{ type: "task_queued", batchId: "batch-1", taskId: "task-b", role: "review", index: 1 },
			{ type: "task_queued", batchId: "batch-1", taskId: "task-c", role: "review", index: 2 },
			{ type: "task_admitted", batchId: "batch-1", taskId: "task-b", role: "review", index: 1 },
			{
				type: "task_skipped",
				batchId: "batch-1",
				taskId: "task-c",
				status: "failed",
				reason: "Batch budget cannot reserve this task.",
			},
		];
		for (const [index, event] of lifecycle.entries()) {
			store.applyBatchTaskLifecycle({
				aggregateStreamKey: "batch-call",
				toolName: "delegate_batch",
				event,
				nowMs: index + 2,
			});
		}
		store.applyRuntime({
			streamKey: "batch-call/task-b",
			toolName: "delegate_batch",
			nowMs: 7,
			cwd: "/repo",
			event: {
				type: "subagent_tool_start",
				runId: "run-b",
				parentSessionId: "parent-1",
				profile: "review",
				status: "running",
				toolName: "read",
				path: "src/ice-subagents.ts",
				taskId: "task-b",
				batchId: "batch-1",
			},
		});

		const state = store.getState();
		const rows = formatObservatoryRows(state, 0, new Set(), [], [], new Set(["run-b"]), "run-b");
		const text = rows.join("\n");
		expect(state.active[0]?.batchCounts).toEqual({
			total: 3,
			queued: 1,
			starting: 0,
			running: 1,
			completed: 0,
			failed: 1,
			cancelled: 0,
			timedOut: 0,
		});
		expect(text).toContain("task-a");
		expect(text).toContain("task-b review running");
		expect(text).toContain("read src/ice-subagents.ts");
		expect(text).toContain("→ attach");
		expect(text).toContain("← viewing");
		expect(text).toContain("task-c review failed");
		expect(text).toContain("3 tasks");
		expect(text.indexOf("task-a")).toBeLessThan(text.indexOf("task-b"));
		expect(text.indexOf("task-b")).toBeLessThan(text.indexOf("task-c"));
		expect(text.match(/→ attach/g)).toHaveLength(1);
	});

	it("truncates multibyte display paths on UTF-8 boundaries", () => {
		const path = normalizeProgressPath("/repo", `src/a${"é".repeat(300)}`);
		expect(path).toBeDefined();
		expect(Buffer.byteLength(path!, "utf8")).toBeLessThanOrEqual(512);
		expect(path).not.toContain("�");
	});

	it("renders bounded redacted progress without transcript content", () => {
		const text = formatProgressSnapshot(
			snapshotFor("tool-1", {
				model: "cx/gpt-5.6-luna",
				currentPath: "src/ice-subagents.ts",
				summary: "api_key=secret-value",
				changedFileCount: 3,
				artifactReady: true,
			}),
		);

		expect(text).toContain("cx/gpt-5.6-luna");
		expect(text).toContain("src/ice-subagents.ts");
		expect(text).toContain("3 files");
		expect(text).not.toContain("secret-value");
		expect(text).not.toContain("api_key");
	});

	it("projects durable jobs as bounded metadata without result bodies", () => {
		const source = durableInspectionFor("job-secret", "completed");
		const projected = projectDurableSubagentJob({
			...source,
			job: { ...source.job, role: "explore\nrow", model: "faux\tmodel", resultRef: "job:job-secret\nrow" },
		});
		expect(projected).toMatchObject({
			jobId: "job-secret",
			status: "completed",
			role: "explore row",
			model: "faux model",
			plannedOutputBytes: 24 * 1024,
			resultRef: "job:job-secret row",
		});
		expect(JSON.stringify(projected)).not.toContain("task=secret transcript");
		expect(JSON.stringify(projected)).not.toContain("provider_secret=hidden");
		expect(Object.isFrozen(projected)).toBe(true);
	});

	it("projects and formats bounded terminal durable results without raw content", () => {
		const source = durableInspectionFor("job-result", "completed");
		const detail = projectDurableSubagentJobResult({
			...source,
			job: { ...source.job, resultRef: "job:job-result\u0007" },
			result: {
				...source.result!,
				status: "completed",
				summary:
					"\x1b[31mVerified summary\x1b[0m api_key=secret-value \x1b]8;;https://example.invalid\x07linked\x1b]8;;\x07 \x07 \\\\server\\share\\secret.txt",
				evidence: {
					paths: [
						"src/foo.ts",
						"/tmp/secret.txt",
						"../context.txt",
						"https://example.invalid/file",
						"file:///tmp/file.ts",
					],
				},
				findings: [
					{
						severity: "high",
						category: "security",
						claim: "\x1b[31mCredential claim\x1b[0m token=secret-value",
						evidence: [{ path: "src/foo.ts" }],
					},
				],
				verification: { verified: true, reason: "verified" },
				diagnostics: [{ code: "runtime\u0007", message: "\x1b[31m/tmp/secret.txt\x1b[0m" }],
			},
		});
		const text = formatDurableSubagentJobDetail(detail!).join("\n");

		expect(detail).toMatchObject({
			jobId: "job-result",
			status: "completed",
			model: "faux/faux",
			resultRef: "job:job-result",
			summary: expect.stringContaining("Verified summary"),
			evidence: ["src/foo.ts"],
			verification: { verified: true },
		});
		expect(text).toContain("Summary");
		expect(text).toContain("src/foo.ts");
		expect(text).toContain("security");
		expect(text).toContain("VERIFIED");
		expect(text).not.toContain("secret-value");
		expect(text).not.toContain("/tmp/");
		expect(text).not.toContain("../context.txt");
		expect(text).not.toContain("https://example.invalid");
		expect(text).not.toContain("file:///tmp/file.ts");
		expect(text).not.toContain("server\\share");
		expect(text.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
		expect(text).not.toContain("\x1b");
		expect(Buffer.byteLength(detail!.summary ?? "", "utf8")).toBeLessThanOrEqual(24 * 1024);
	});

	it("allows inspection only for terminal durable statuses", () => {
		expect(
			["created", "queued", "running"].some((status) => isDurableJobInspectable(status as SubagentJobStatus)),
		).toBe(false);
		expect(
			["completed", "failed", "cancelled", "timed_out", "verification_failed", "interrupted"].every((status) =>
				isDurableJobInspectable(status as SubagentJobStatus),
			),
		).toBe(true);
	});

	it("formats every terminal status and empty results safely", () => {
		for (const status of ["failed", "cancelled", "timed_out", "verification_failed", "interrupted"] as const) {
			const source = durableInspectionFor(`job-${status}`, status);
			const detail = projectDurableSubagentJobResult({ ...source, result: undefined });
			const text = formatDurableSubagentJobDetail(detail!).join("\n");
			expect(text).toContain(`status: ${status}`);
			expect(text).not.toContain("VERIFIED");
		}
	});

	it("projects only valid persisted completion metadata", () => {
		const completed = projectDurableSubagentJob(durableInspectionFor("job-completed", "completed"));
		const failed = projectDurableSubagentJob(durableInspectionFor("job-failed", "failed"));
		const queued = projectDurableSubagentJob(durableInspectionFor("job-queued", "queued", 1));
		const entries: SubagentCompletionInboxSessionEntry[] = [
			completionEntry("unknown", "completed", "job:unknown", "2026-01-01T00:00:00.000Z"),
			completionEntry("job-completed", "completed", completed.resultRef, "2026-01-01T00:00:01.000Z", {
				content: "api_key=leaked transcript /tmp/secret.txt",
			}),
			completionEntry("job-queued", "queued", queued.resultRef, "2026-01-01T00:00:02.000Z"),
			completionEntry("job-failed", "failed", "job:wrong-ref", "2026-01-01T00:00:03.000Z"),
			completionEntry("job-failed", "failed", failed.resultRef, "2026-01-01T00:00:04.000Z"),
			completionEntry("job-completed", "failed", completed.resultRef, "2026-01-01T00:00:05.000Z"),
			completionEntry("job-failed", "failed", failed.resultRef, "2026-01-01T00:00:06.000Z", {
				customType: "other-message",
			}),
		];
		const inbox = projectSubagentCompletionInbox(entries, [completed, failed, queued]);

		expect(inbox.map((item) => item.jobId)).toEqual(["job-failed", "job-completed"]);
		expect(inbox[0]).toMatchObject({
			status: "failed",
			role: "explore",
			model: "faux/faux",
			resultRef: failed.resultRef,
			notifiedAt: "2026-01-01T00:00:04.000Z",
		});
		expect(JSON.stringify(inbox)).not.toContain("api_key");
		expect(JSON.stringify(inbox)).not.toContain("leaked transcript");
		expect(Object.isFrozen(inbox)).toBe(true);
		expect(Object.isFrozen(inbox[0])).toBe(true);
	});

	it("deduplicates newest completions and caps the inbox at 32 items", () => {
		const jobs = Array.from({ length: 40 }, (_, index) =>
			projectDurableSubagentJob(durableInspectionFor(`job-${index}`, "completed")),
		);
		const entries = jobs.map((job, index) =>
			completionEntry(
				job.jobId,
				job.status,
				job.resultRef,
				`2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
			),
		);
		const inbox = projectSubagentCompletionInbox(entries, jobs);

		expect(inbox).toHaveLength(32);
		expect(inbox[0]?.jobId).toBe("job-39");
		expect(inbox[inbox.length - 1]?.jobId).toBe("job-8");
		expect(new Set(inbox.map((item) => item.jobId)).size).toBe(32);
		expect(inbox.every((item) => Object.isFrozen(item))).toBe(true);
	});

	it("formats the completion inbox after noninteractive durable rows", () => {
		const job = projectDurableSubagentJob(durableInspectionFor("job-completed", "completed"));
		const inbox = projectSubagentCompletionInbox(
			[completionEntry(job.jobId, job.status, job.resultRef, "2026-01-01T00:00:01.000Z")],
			[job],
		);
		const rows = formatObservatoryRows(createObservatoryState(), 0, new Set(), [job], inbox);
		const text = rows.join("\n");

		expect(text).toContain("BACKGROUND RECENT");
		expect(text).toContain("COMPLETION INBOX");
		expect(text.indexOf("COMPLETION INBOX")).toBeGreaterThan(text.indexOf("BACKGROUND RECENT"));
		expect(formatCompletionInboxRows(inbox).every((row) => !row.startsWith(">"))).toBe(true);
		expect(durableJobEntryKeys([job])).toEqual([job.jobId]);
	});

	it("renders active, FIFO queued, and terminal durable sections deterministically", () => {
		const jobs = [
			projectDurableSubagentJob(durableInspectionFor("job-terminal", "interrupted")),
			projectDurableSubagentJob(durableInspectionFor("a-queued-2", "queued", 2)),
			projectDurableSubagentJob(durableInspectionFor("job-running", "running")),
			projectDurableSubagentJob(durableInspectionFor("b-queued-1", "queued", 1)),
			projectDurableSubagentJob(durableInspectionFor("job-completed", "completed")),
		];
		const rows = formatObservatoryRows(createObservatoryState(), 0, new Set(["b-queued-1"]), jobs);
		const text = rows.join("\n");

		expect(text).toContain("BACKGROUND ACTIVE");
		expect(text).toContain("BACKGROUND QUEUED");
		expect(text).toContain("BACKGROUND RECENT");
		expect(text).toContain("● job-ru explore running");
		expect(text.indexOf("b-queu")).toBeLessThan(text.indexOf("a-queu"));
		expect(text).toContain("… b-queu explore queued q#1");
		expect(text).toContain("✓ job-co explore completed");
		expect(text).toContain("✗ job-te explore interrupted");
		expect(text).not.toContain("task=secret transcript");
	});
});
