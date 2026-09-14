import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	resolveSubagentConcurrencyPolicy,
	SUBAGENT_CONCURRENCY_LIMITS,
	SubagentConcurrencyAdmission,
} from "../src/ice-subagent-concurrency.ts";
import type { PersistedSubagentJobSnapshot, SubagentJobRunResult } from "../src/ice-subagent-jobs.ts";
import { SubagentJobRegistry } from "../src/ice-subagent-jobs.ts";
import { parseIceSettings } from "../src/ice-subagent-settings.ts";
import type { SubagentResult } from "../src/ice-subagents.ts";
import {
	normalizeSubagentRequest,
	type ResolvedSubagentBatchTask,
	runResolvedSubagentBatch,
} from "../src/ice-subagents.ts";

function completedRun(): SubagentJobRunResult {
	const result: SubagentResult = {
		runId: "run-1",
		parentSessionId: "owner-a",
		profile: "explore",
		source: "user",
		status: "completed",
		summary: "ok",
		observedOutputBytes: 2,
		partial: false,
		diagnostics: [],
		evidence: { paths: ["src/file.ts"] },
	};
	return {
		result,
		verification: {
			verified: true,
			reason: "ok",
			paths: ["src/file.ts"],
			unresolvedClaims: [],
		},
	};
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function deferredRun() {
	let settle!: (value?: SubagentJobRunResult) => void;
	const promise = new Promise<SubagentJobRunResult>((resolve) => {
		settle = (value = completedRun()) => resolve(value);
	});
	return { run: () => promise, settle };
}

function launch(registry: SubagentJobRegistry, run: (signal: AbortSignal) => Promise<SubagentJobRunResult>) {
	return (
		registry.launch as unknown as (input: {
			launchLeafId: string;
			role: string;
			model: string;
			plannedOutputBytes: number;
			run: (signal: AbortSignal) => Promise<SubagentJobRunResult>;
		}) => ReturnType<SubagentJobRegistry["launch"]>
	)({
		launchLeafId: "leaf-a",
		role: "explore",
		model: "faux/faux",
		plannedOutputBytes: 24 * 1024,
		run,
	});
}

function batchTask(cwd: string, id: string): ResolvedSubagentBatchTask {
	return {
		id,
		request: normalizeSubagentRequest(
			{
				parentSessionId: "owner-a",
				role: "self",
				task: `task ${id}`,
				scope: { roots: ["src"] },
				cwd,
				self: { instructions: "Report evidence.", capabilities: ["read"] },
			},
			cwd,
			{ agentDir: join(cwd, ".ice-agent") },
		),
	};
}

function completedBatchResult(task: ResolvedSubagentBatchTask): SubagentResult {
	return {
		runId: task.request.runId,
		childSessionId: `child-${task.request.runId}`,
		parentSessionId: task.request.parentSessionId,
		profile: task.request.role,
		source: task.request.profile.source,
		status: "completed",
		summary: "ok",
		observedOutputBytes: 2,
		partial: false,
		diagnostics: [],
		usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
		evidence: { paths: ["src"] },
	};
}

describe("resolveSubagentConcurrencyPolicy", () => {
	it("uses bundled defaults without settings", () => {
		const policy = resolveSubagentConcurrencyPolicy({});
		expect(policy.defaultConcurrency).toBe(SUBAGENT_CONCURRENCY_LIMITS.bundledDefault);
		expect(policy.maxConcurrency).toBe(SUBAGENT_CONCURRENCY_LIMITS.hardCap);
		expect(policy.sources.default).toBe("bundled");
		expect(policy.sources.max).toBe("bundled");
		expect(policy.diagnostics).toEqual([]);
	});

	it("global settings raise default and cap up to the bundled hard ceiling", () => {
		const policy = resolveSubagentConcurrencyPolicy({
			global: parseIceSettings({
				subagents: { concurrency: { default: 6, max: 6 } },
			}).subagents,
		});
		expect(policy.defaultConcurrency).toBe(6);
		expect(policy.maxConcurrency).toBe(6);
		expect(policy.sources.default).toBe("global");
		expect(policy.sources.max).toBe("global");
	});

	it("rejects a global cap above the bundled hard ceiling", () => {
		expect(() =>
			parseIceSettings({ subagents: { concurrency: { max: SUBAGENT_CONCURRENCY_LIMITS.hardCap + 1 } } }),
		).toThrowError(/max/i);
	});

	it("trusted project settings may lower but never raise global values", () => {
		const policy = resolveSubagentConcurrencyPolicy({
			global: parseIceSettings({ subagents: { concurrency: { default: 6, max: 7 } } }).subagents,
			project: parseIceSettings({ subagents: { concurrency: { default: 2, max: 3 } } }).subagents,
			projectTrusted: true,
		});
		expect(policy.defaultConcurrency).toBe(2);
		expect(policy.maxConcurrency).toBe(3);
		expect(policy.sources.default).toBe("project");
		expect(policy.sources.max).toBe("project");
	});

	it("clamps raising project values and records a diagnostic", () => {
		const policy = resolveSubagentConcurrencyPolicy({
			global: parseIceSettings({ subagents: { concurrency: { default: 2, max: 3 } } }).subagents,
			project: parseIceSettings({ subagents: { concurrency: { default: 6, max: 8 } } }).subagents,
			projectTrusted: true,
		});
		expect(policy.defaultConcurrency).toBe(2);
		expect(policy.maxConcurrency).toBe(3);
		expect(policy.diagnostics.some((d) => d.includes("cannot raise"))).toBe(true);
	});

	it("ignores untrusted project concurrency with a diagnostic", () => {
		const policy = resolveSubagentConcurrencyPolicy({
			project: parseIceSettings({ subagents: { concurrency: { default: 1, max: 1 } } }).subagents,
			projectTrusted: false,
		});
		expect(policy.defaultConcurrency).toBe(SUBAGENT_CONCURRENCY_LIMITS.bundledDefault);
		expect(policy.maxConcurrency).toBe(SUBAGENT_CONCURRENCY_LIMITS.hardCap);
		expect(policy.diagnostics.some((d) => d.includes("ignored without project trust"))).toBe(true);
	});

	it("clamps a default above the effective cap", () => {
		const policy = resolveSubagentConcurrencyPolicy({
			global: parseIceSettings({ subagents: { concurrency: { default: 8, max: 4 } } }).subagents,
		});
		expect(policy.defaultConcurrency).toBe(4);
		expect(policy.sources.default).toBe("enforced");
	});
});

describe("SubagentConcurrencyAdmission", () => {
	it("admits up to the cap and rejects over-release", () => {
		const admission = new SubagentConcurrencyAdmission(2);
		expect(admission.tryAcquire()).toBe(true);
		expect(admission.tryAcquire()).toBe(true);
		expect(admission.tryAcquire()).toBe(false);
		expect(admission.active).toBe(2);
		admission.release();
		expect(admission.active).toBe(1);
		expect(admission.tryAcquire()).toBe(true);
	});

	it("rejects out-of-range caps", () => {
		expect(() => new SubagentConcurrencyAdmission(0)).toThrowError();
		expect(() => new SubagentConcurrencyAdmission(SUBAGENT_CONCURRENCY_LIMITS.hardCap + 1)).toThrowError();
	});

	it("notifies release listeners when a permit frees up", () => {
		const admission = new SubagentConcurrencyAdmission(1);
		const wake = vi.fn();
		admission.onRelease(wake);
		expect(admission.tryAcquire()).toBe(true);
		expect(wake).not.toHaveBeenCalled();
		admission.release();
		expect(wake).toHaveBeenCalled();
	});
});

describe("shared admission across background jobs", () => {
	it("queues jobs beyond the shared cap and promotes them on release", async () => {
		const admission = new SubagentConcurrencyAdmission(2);
		const first = deferredRun();
		const second = deferredRun();
		const third = deferredRun();
		const registry = new SubagentJobRegistry({
			ownerSessionId: "owner-a",
			persist: () => {},
			notify: () => {},
			maxActiveJobs: 8,
			admission,
		});
		const a = launch(registry, first.run);
		const b = launch(registry, second.run);
		const c = launch(registry, third.run);
		expect(a.status).toBe("created");
		expect(b.status).toBe("created");
		expect(c.status).toBe("queued");
		expect(registry.inspect(c.jobId).budget).toMatchObject({
			ownerActiveJobs: 2,
			ownerQueuedJobs: 1,
			ownerActiveJobsCap: 2,
		});

		first.settle();
		await flush();
		expect(registry.inspect(c.jobId).job.status).toBe("running");

		second.settle();
		await flush();
		third.settle();
		await flush();
		await flush();
		expect(registry.inspect(c.jobId).job.status).toBe("completed");
		expect(admission.active).toBe(0);
	});

	it("retains shared permits for needs_time runs until resume and terminal settlement", async () => {
		const admission = new SubagentConcurrencyAdmission(1);
		const first = deferredRun();
		const second = deferredRun();
		const registry = new SubagentJobRegistry({
			ownerSessionId: "owner-a",
			persist: () => {},
			notify: () => {},
			maxActiveJobs: 8,
			admission,
		});
		const a = launch(registry, first.run);
		const b = launch(registry, second.run);
		expect(a.status).toBe("created");
		expect(b.status).toBe("queued");

		first.settle({
			...completedRun(),
			result: { ...completedRun().result, status: "needs_time", runId: "run-deferred" },
		});
		await flush();
		expect(registry.inspect(a.jobId).job.status).toBe("needs_time");
		expect(registry.inspect(b.jobId).job.status).toBe("queued");
		expect(admission.active).toBe(1);

		expect(registry.markManagedRunState("run-deferred", "running")).toBe(true);
		expect(registry.inspect(a.jobId).job.status).toBe("running");
		expect(registry.inspect(b.jobId).job.status).toBe("queued");
		expect(admission.active).toBe(1);

		expect(await registry.resolveManagedRun("run-deferred", completedRun())).toBe(true);
		await flush();
		expect(registry.inspect(b.jobId).job.status).toBe("running");
		expect(admission.active).toBe(1);

		second.settle();
		await flush();
		await flush();
		expect(admission.active).toBe(0);
	});

	it("releases a retained needs_time permit exactly once on cancellation", async () => {
		const admission = new SubagentConcurrencyAdmission(1);
		const first = deferredRun();
		const second = deferredRun();
		const registry = new SubagentJobRegistry({
			ownerSessionId: "owner-a",
			persist: () => {},
			notify: () => {},
			maxActiveJobs: 8,
			admission,
		});
		const a = launch(registry, first.run);
		const b = launch(registry, second.run);
		first.settle({
			...completedRun(),
			result: { ...completedRun().result, status: "needs_time", runId: "run-cancelled" },
		});
		await flush();
		await flush();
		expect(registry.inspect(a.jobId).job.status).toBe("needs_time");
		expect(registry.inspect(b.jobId).job.status).toBe("queued");
		expect(admission.active).toBe(1);

		const cancelled = await registry.cancel(a.jobId);
		expect(cancelled.job.status).toBe("cancelled");
		expect(registry.inspect(b.jobId).job.status).toBe("running");
		expect(admission.active).toBe(1);

		second.settle();
		await flush();
		await flush();
		expect(admission.active).toBe(0);
	});

	it("cancel frees the shared permit and the next queued job starts", async () => {
		const admission = new SubagentConcurrencyAdmission(1);
		const first = deferredRun();
		const second = deferredRun();
		const registry = new SubagentJobRegistry({
			ownerSessionId: "owner-a",
			persist: () => {},
			notify: () => {},
			maxActiveJobs: 8,
			admission,
		});
		const a = launch(registry, first.run);
		const b = launch(registry, second.run);
		expect(a.status).toBe("created");
		expect(b.status).toBe("queued");

		await registry.cancel(a.jobId);
		expect(admission.active).toBe(1);
		expect(registry.inspect(b.jobId).job.status).toBe("running");

		second.settle();
		await flush();
		await flush();
		expect(admission.active).toBe(0);
	});

	it("fails jobs that cannot be persisted and releases their shared permit", async () => {
		const admission = new SubagentConcurrencyAdmission(1);
		const snapshots: PersistedSubagentJobSnapshot[] = [];
		let failFirst = true;
		const registry = new SubagentJobRegistry({
			ownerSessionId: "owner-a",
			persist: (snapshot) => {
				snapshots.push(snapshot);
				if (failFirst && snapshots.length === 1) throw new Error("disk full");
			},
			notify: () => {},
			maxActiveJobs: 8,
			admission,
		});
		const first = deferredRun();
		expect(() => launch(registry, first.run)).toThrowError(/persistence/i);
		expect(admission.active).toBe(0);

		failFirst = false;
		const second = deferredRun();
		const ok = launch(registry, second.run);
		expect(ok.status).toBe("created");
		second.settle();
		await flush();
		await flush();
		expect(registry.inspect(ok.jobId).job.status).toBe("completed");
		expect(admission.active).toBe(0);
	});
});

describe("shared admission across mixed jobs and batches", () => {
	it("promotes a queued batch after a durable job releases the shared permit", async () => {
		const admission = new SubagentConcurrencyAdmission(1);
		const firstJob = deferredRun();
		const registry = new SubagentJobRegistry({
			ownerSessionId: "owner-a",
			persist: () => {},
			notify: () => {},
			maxActiveJobs: 8,
			admission,
		});
		const job = launch(registry, firstJob.run);
		const cwd = await mkdtemp(join(tmpdir(), "ice-mixed-admission-"));
		await mkdir(join(cwd, "src"));
		try {
			const task = batchTask(cwd, "batch-after-job");
			let batchStarted = false;
			let releaseBatch!: () => void;
			const batchGate = new Promise<void>((resolve) => {
				releaseBatch = resolve;
			});
			const batch = runResolvedSubagentBatch(
				[task],
				["delegate", "read"],
				{
					runResolved: async () => {
						batchStarted = true;
						await batchGate;
						return completedBatchResult(task);
					},
				},
				{ concurrency: 1, admission },
			);

			await flush();
			expect(registry.inspect(job.jobId).job.status).toBe("running");
			expect(batchStarted).toBe(false);
			expect(admission.active).toBe(1);
			firstJob.settle();
			await flush();
			expect(batchStarted).toBe(true);
			expect(admission.active).toBe(1);

			releaseBatch();
			const result = await batch;
			expect(result.status).toBe("completed");
			expect(admission.active).toBe(0);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("promotes a queued durable job after a batch releases the shared permit", async () => {
		const admission = new SubagentConcurrencyAdmission(1);
		const cwd = await mkdtemp(join(tmpdir(), "ice-mixed-admission-"));
		await mkdir(join(cwd, "src"));
		try {
			const task = batchTask(cwd, "batch-before-job");
			let releaseBatch!: () => void;
			const batchGate = new Promise<void>((resolve) => {
				releaseBatch = resolve;
			});
			const batch = runResolvedSubagentBatch(
				[task],
				["delegate", "read"],
				{
					runResolved: async () => {
						await batchGate;
						return completedBatchResult(task);
					},
				},
				{ concurrency: 1, admission },
			);
			await flush();
			expect(admission.active).toBe(1);

			const queuedJobRun = deferredRun();
			const registry = new SubagentJobRegistry({
				ownerSessionId: "owner-a",
				persist: () => {},
				notify: () => {},
				maxActiveJobs: 8,
				admission,
			});
			const job = launch(registry, queuedJobRun.run);
			expect(job.status).toBe("queued");

			releaseBatch();
			const result = await batch;
			expect(result.status).toBe("completed");
			await flush();
			// The queued job is now the sole active owner and can finish normally.
			expect(admission.active).toBe(1);
			queuedJobRun.settle();
			await flush();
			await flush();
			expect(admission.active).toBe(0);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("shared admission across concurrent batches", () => {
	it("keeps combined in-flight batch children at the shared cap", async () => {
		const admission = new SubagentConcurrencyAdmission(2);
		const cwd = await mkdtemp(join(tmpdir(), "ice-subagent-concurrency-"));
		await mkdir(join(cwd, "src"));
		try {
			const makeTask = (id: string): ResolvedSubagentBatchTask => ({
				id,
				request: normalizeSubagentRequest(
					{
						parentSessionId: "parent-1",
						role: "self",
						task: `task ${id}`,
						scope: { roots: ["src"] },
						cwd,
						self: {
							instructions: "Report evidence.",
							capabilities: ["read"],
						},
					},
					cwd,
					{ agentDir: join(cwd, ".ice-agent") },
				),
			});
			const tasksA = [makeTask("a1"), makeTask("a2")];
			const tasksB = [makeTask("b1"), makeTask("b2")];
			const allTasks = [...tasksA, ...tasksB];

			let inFlight = 0;
			let peak = 0;
			const deferreds = new Map<string, () => void>();
			const runner = {
				runResolved: async (task: { runId: string }) => {
					inFlight++;
					peak = Math.max(peak, inFlight);
					await new Promise<void>((resolve) => deferreds.set(task.runId, resolve));
					inFlight--;
					const owner = allTasks.find((candidate) => candidate.request.runId === task.runId)!;
					return {
						runId: task.runId,
						childSessionId: `child-${task.runId}`,
						parentSessionId: "parent-1",
						profile: owner.request.role,
						source: owner.request.profile.source,
						status: "completed" as const,
						summary: "ok",
						observedOutputBytes: 2,
						partial: false,
						diagnostics: [],
						usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
						evidence: { paths: ["src"] },
					};
				},
			};

			const batchA = runResolvedSubagentBatch(tasksA, ["delegate", "read"], runner, {
				admission,
			});
			// Let batch A admit its first task before batch B starts.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			const batchB = runResolvedSubagentBatch(tasksB, ["delegate", "read"], runner, {
				admission,
			});
			await new Promise<void>((resolve) => setTimeout(resolve, 0));

			// Two tasks admitted (one per batch); the rest wait on shared permits.
			expect(admission.active).toBe(2);
			for (const runId of [...deferreds.keys()]) deferreds.get(runId)!();
			// Drain: each release admits the next waiting task in the same microtask
			// cascade; settle whatever is pending until both batches finish.
			for (let round = 0; round < 6; round++) {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				for (const runId of [...deferreds.keys()]) deferreds.get(runId)!();
			}
			const [resultA, resultB] = await Promise.all([batchA, batchB]);
			expect(resultA.status).toBe("completed");
			expect(resultB.status).toBe("completed");
			expect(peak).toBe(2);
			expect(admission.active).toBe(0);
		} finally {
			// No cleanup required for the empty temp workspace.
		}
	});
});
