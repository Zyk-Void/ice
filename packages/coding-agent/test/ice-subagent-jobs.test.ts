import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	JOB_ENTRY_TYPE,
	type PersistedSubagentJobSnapshot,
	type SubagentJobContract,
	SubagentJobError,
	SubagentJobRegistry,
	type SubagentJobRunResult,
} from "../src/ice-subagent-jobs.ts";
import type { IceHookDispatchRecord } from "../src/ice-subagent-settings.ts";
import {
	type ReviewFinding,
	type SubagentResult,
	type SubagentVerification,
	writeSubagentReportArtifact,
} from "../src/ice-subagents.ts";

const TEST_REPORT_ARTIFACT_ROOT = "/tmp/ice-subagent-report-artifacts";
const registries: SubagentJobRegistry[] = [];

interface TestRegistryOptions {
	maxActiveJobs?: number;
	maxQueuedJobs?: number;
	maxAggregateOutputBytes?: number;
	reportArtifactRoot?: string;
}

function createRegistry(
	persist: (snapshot: PersistedSubagentJobSnapshot) => void = () => {},
	notify: (jobId: string) => void = () => {},
	options: TestRegistryOptions = {},
): SubagentJobRegistry {
	const registry = new SubagentJobRegistry({
		ownerSessionId: "owner-a",
		persist,
		notify,
		reportArtifactRoot: TEST_REPORT_ARTIFACT_ROOT,
		...options,
	} as ConstructorParameters<typeof SubagentJobRegistry>[0]);
	registries.push(registry);
	return registry;
}

function completedRun(ownerSessionId = "owner-a"): SubagentJobRunResult {
	const result: SubagentResult = {
		runId: "run-1",
		parentSessionId: ownerSessionId,
		profile: "explore",
		source: "user",
		status: "completed",
		summary: "Found the requested file.",
		observedOutputBytes: 28,
		partial: false,
		diagnostics: [],
		evidence: { paths: ["src/file.ts"] },
	};
	const verification: SubagentVerification = {
		verified: true,
		reason: "Observed evidence is valid.",
		paths: ["/workspace/src/file.ts"],
		unresolvedClaims: [],
	};
	return { result, verification };
}

function launch(
	registry: SubagentJobRegistry,
	run: (signal: AbortSignal) => Promise<SubagentJobRunResult>,
	plannedOutputBytes = 24 * 1024,
	contract?: SubagentJobContract,
) {
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
		plannedOutputBytes,
		...(contract ? { contract } : {}),
		run,
	});
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function deferredRun(): {
	run: (signal: AbortSignal) => Promise<SubagentJobRunResult>;
	settle: (value?: SubagentJobRunResult) => void;
} {
	let settle!: (value: SubagentJobRunResult) => void;
	let pending: SubagentJobRunResult | undefined;
	const run = vi.fn<(signal: AbortSignal) => Promise<SubagentJobRunResult>>(
		() =>
			new Promise<SubagentJobRunResult>((resolve) => {
				settle = resolve;
				if (pending) settle(pending);
			}),
	);
	return {
		run,
		settle: (value = completedRun()) => {
			if (settle) settle(value);
			else pending = value;
		},
	};
}

function persistedSnapshot(jobId: string, status: string, ownerSessionId = "owner-a"): PersistedSubagentJobSnapshot {
	const job = {
		schemaVersion: 1,
		jobId,
		ownerSessionId,
		launchLeafId: "leaf-a",
		role: "explore",
		status,
		createdAt: "2026-01-01T00:00:00.000Z",
		resultRef: `job:${jobId}`,
		...(status === "queued"
			? { queuedAt: "2026-01-01T00:00:00.100Z", queueOrder: 1, plannedOutputBytes: 24 * 1024 }
			: {}),
		...(status === "running" ? { startedAt: "2026-01-01T00:00:01.000Z", plannedOutputBytes: 24 * 1024 } : {}),
		...(status === "completed"
			? {
					startedAt: "2026-01-01T00:00:01.000Z",
					finishedAt: "2026-01-01T00:00:02.000Z",
					runId: "run-1",
					queueOrder: 1,
				}
			: {}),
	};
	return {
		schemaVersion: 1,
		sequence: 1,
		job: job as unknown as PersistedSubagentJobSnapshot["job"],
		...(status === "completed"
			? {
					result: {
						schemaVersion: 1,
						jobId,
						runId: "run-1",
						status: "completed",
						diagnostics: [],
					},
				}
			: {}),
	} as PersistedSubagentJobSnapshot;
}

afterEach(async () => {
	await Promise.all(registries.splice(0).map((registry) => registry.shutdown()));
});

describe("durable subagent jobs", () => {
	it("persists acceptance before launching and returns before the runner settles", async () => {
		const snapshots: PersistedSubagentJobSnapshot[] = [];
		let settle!: (value: SubagentJobRunResult) => void;
		const run = vi.fn(
			() =>
				new Promise<SubagentJobRunResult>((resolve) => {
					settle = resolve;
				}),
		);
		const registry = createRegistry((snapshot) => snapshots.push(snapshot));

		const accepted = launch(registry, run);
		expect(accepted.status).toBe("created");
		expect(accepted.resultRef).toBe(`job:${accepted.jobId}`);
		expect(run).not.toHaveBeenCalled();
		expect(snapshots.map((snapshot) => snapshot.job.status)).toEqual(["created"]);

		await flush();
		expect(run).toHaveBeenCalledOnce();
		expect(registry.inspect(accepted.jobId).job.status).toBe("running");

		settle(completedRun());
		await flush();
		expect(registry.inspect(accepted.jobId).job.status).toBe("completed");
		expect(snapshots.map((snapshot) => snapshot.job.status)).toEqual(["created", "running", "completed"]);
	});

	it("persists the accepted execution contract and bounded custom result data", async () => {
		const snapshots: PersistedSubagentJobSnapshot[] = [];
		const hookRecord = {
			eventId: "event-1",
			hookId: "policy",
			event: "subagent.beforeLaunch",
			outcome: "continue",
			required: true,
			durationMs: 2,
			observational: false,
		} as IceHookDispatchRecord;
		const registry = createRegistry((snapshot) => snapshots.push(snapshot));
		const accepted = launch(
			registry,
			async () => ({
				...completedRun(),
				result: {
					...completedRun().result,
					payload: { severity: "high" },
					observedTurns: 2,
					hookRecords: [hookRecord],
				},
			}),
			24 * 1024,
			{
				thinking: "high",
				timeoutMs: 120_000,
				maxTurns: 8,
				maxToolCalls: 16,
				maxOutputBytes: 24 * 1024,
				temperature: 0.2,
				topP: 0.8,
				tools: ["read"],
				sourceHash: "a".repeat(64),
			},
		);
		await flush();
		const inspection = registry.inspect(accepted.jobId);
		expect(inspection.job.contract).toMatchObject({
			thinking: "high",
			maxTurns: 8,
			temperature: 0.2,
			topP: 0.8,
			tools: ["read"],
		});
		expect(inspection.result).toMatchObject({
			status: "completed",
			payload: { severity: "high" },
			observedTurns: 2,
			hookRecords: [{ hookId: "policy", outcome: "continue" }],
		});
		expect(snapshots.at(-1)?.job.contract?.sourceHash).toBe("a".repeat(64));

		const trusted = structuredClone(snapshots.at(-1)!);
		const invalidSampling = structuredClone(trusted);
		invalidSampling.sequence += 1;
		invalidSampling.job.contract!.temperature = 2.1;
		const restored = createRegistry();
		restored.restore(
			[trusted, invalidSampling].map((snapshot) => ({ type: "custom", customType: JOB_ENTRY_TYPE, data: snapshot })),
		);
		expect(restored.inspect(accepted.jobId).job.contract).toMatchObject({ temperature: 0.2, topP: 0.8 });
	});

	it("persists a bounded token budget only under its immutable contract", async () => {
		const snapshots: PersistedSubagentJobSnapshot[] = [];
		const registry = createRegistry((snapshot) => snapshots.push(snapshot));
		const contract: SubagentJobContract = {
			thinking: "medium",
			timeoutMs: 120_000,
			maxTurns: 12,
			maxToolCalls: 40,
			maxOutputBytes: 24 * 1024,
			maxTotalTokens: 20_000,
			tools: [],
		};
		const run = completedRun();
		run.result.budget = {
			maxTotalTokens: 20_000,
			workPhaseLimit: 18_000,
			reportReserveTokens: 2_000,
			chargedTokens: 12,
			remainingTokens: 19_988,
			inputTokens: 5,
			outputTokens: 6,
			cacheReadTokens: 9,
			cacheWriteTokens: 1,
			overshootTokens: 0,
			accounting: "estimated",
			exhausted: false,
			hardCap: "aggregate-soft",
		};
		const accepted = launch(registry, async () => run, 24 * 1024, contract);
		await flush();
		expect(registry.inspect(accepted.jobId).result?.budget).toMatchObject({
			maxTotalTokens: 20_000,
			chargedTokens: 12,
			remainingTokens: 19_988,
		});
		expect(snapshots.at(-1)?.result?.budget?.maxTotalTokens).toBe(20_000);
	});

	it("refuses newer persisted snapshots that widen token authority or rewind charged usage", async () => {
		const snapshots: PersistedSubagentJobSnapshot[] = [];
		const source = createRegistry((snapshot) => snapshots.push(snapshot));
		const contract: SubagentJobContract = {
			thinking: "medium",
			timeoutMs: 120_000,
			maxTurns: 12,
			maxToolCalls: 40,
			maxOutputBytes: 24 * 1024,
			maxTotalTokens: 20_000,
			tools: [],
		};
		const run = completedRun();
		run.result.budget = {
			maxTotalTokens: 20_000,
			workPhaseLimit: 18_000,
			reportReserveTokens: 2_000,
			chargedTokens: 12,
			remainingTokens: 19_988,
			inputTokens: 5,
			outputTokens: 6,
			cacheReadTokens: 9,
			cacheWriteTokens: 1,
			overshootTokens: 0,
			accounting: "estimated",
			exhausted: false,
			hardCap: "aggregate-soft",
		};
		const accepted = launch(source, async () => run, 24 * 1024, contract);
		await flush();
		const trusted = structuredClone(snapshots.at(-1)!);

		const widened = structuredClone(trusted);
		widened.sequence += 1;
		widened.job.contract!.maxTotalTokens = 30_000;
		widened.result!.budget = {
			...widened.result!.budget!,
			maxTotalTokens: 30_000,
			workPhaseLimit: 27_000,
			reportReserveTokens: 3_000,
			remainingTokens: 29_988,
		};
		const widenedRegistry = createRegistry();
		widenedRegistry.restore(
			[trusted, widened].map((snapshot) => ({ type: "custom", customType: JOB_ENTRY_TYPE, data: snapshot })),
		);
		expect(widenedRegistry.inspect(accepted.jobId).job.contract?.maxTotalTokens).toBe(20_000);
		expect(widenedRegistry.inspect(accepted.jobId).result?.budget?.maxTotalTokens).toBe(20_000);

		const rewound = structuredClone(trusted);
		rewound.sequence += 1;
		rewound.result!.budget = {
			...rewound.result!.budget!,
			chargedTokens: 2,
			remainingTokens: 19_998,
			inputTokens: 1,
			outputTokens: 1,
			cacheWriteTokens: 0,
		};
		const rewoundRegistry = createRegistry();
		rewoundRegistry.restore(
			[trusted, rewound].map((snapshot) => ({ type: "custom", customType: JOB_ENTRY_TYPE, data: snapshot })),
		);
		expect(rewoundRegistry.inspect(accepted.jobId).result?.budget?.chargedTokens).toBe(12);
	});

	it("queues a second owner job when the active limit is reached", async () => {
		const run = vi.fn(
			(signal: AbortSignal) =>
				new Promise<SubagentJobRunResult>((resolve) => {
					signal.addEventListener("abort", () =>
						resolve({
							result: { ...completedRun().result, status: "cancelled", partial: true },
							verification: { verified: false, reason: "cancelled", paths: [], unresolvedClaims: [] },
						}),
					);
				}),
		);
		const registry = createRegistry(
			() => {},
			() => {},
			{ maxActiveJobs: 1 },
		);
		launch(registry, run);
		const queued = launch(registry, run);

		expect(queued.status).toBe("queued");
		expect(run).not.toHaveBeenCalled();
		await flush();
		expect(run).toHaveBeenCalledOnce();
		expect(registry.inspect(queued.jobId).job.status).toBe("queued");
	});

	it("does not launch when the initial durable snapshot fails", () => {
		const run = vi.fn(async () => completedRun());
		const registry = createRegistry(() => {
			throw new Error("disk full");
		});

		expect(() => launch(registry, run)).toThrowError(/persistence|disk full/i);
		expect(run).not.toHaveBeenCalled();
	});

	it("turns an unverified completed result into verification_failed without promoting evidence", async () => {
		const snapshots: PersistedSubagentJobSnapshot[] = [];
		const registry = createRegistry((snapshot) => snapshots.push(snapshot));
		const run = completedRun();
		run.result.findings = [
			{
				severity: "high",
				category: "security",
				claim: "Unverified claim",
				evidence: [{ path: "src/file.ts" }],
			},
		];
		const accepted = launch(registry, async () => ({
			...run,
			verification: { verified: false, reason: "Evidence escaped scope.", paths: [], unresolvedClaims: [] },
		}));

		await flush();
		expect(registry.inspect(accepted.jobId).job.status).toBe("verification_failed");
		expect(snapshots.at(-1)?.result?.status).toBe("verification_failed");
		expect(snapshots.at(-1)?.result?.evidence).toBeUndefined();
		expect(snapshots.at(-1)?.result?.findings).toBeUndefined();
	});

	it("deeply freezes nested finding evidence returned by inspection", async () => {
		const registry = createRegistry();
		const run = completedRun();
		run.result.findings = [
			{
				severity: "high",
				category: "security",
				claim: "Verified claim",
				evidence: [{ path: "src/file.ts" }],
			},
		];
		const accepted = launch(registry, async () => run);
		await flush();

		const inspection = registry.inspect(accepted.jobId);
		const evidence = inspection.result?.findings?.[0]?.evidence as unknown as Array<{ path: string }>;
		expect(() => evidence.push({ path: "mutated.ts" })).toThrow();
		expect(() => {
			evidence[0].path = "mutated.ts";
		}).toThrow();
		expect(registry.inspect(accepted.jobId).result?.findings?.[0]?.evidence).toEqual([{ path: "src/file.ts" }]);
	});

	it("cancels through the job controller and waits for runner settlement", async () => {
		let aborted = false;
		let settle!: (value: SubagentJobRunResult) => void;
		const registry = createRegistry();
		const accepted = launch(
			registry,
			(signal) =>
				new Promise<SubagentJobRunResult>((resolve) => {
					settle = resolve;
					signal.addEventListener("abort", () => {
						aborted = true;
						settle({
							result: {
								...completedRun().result,
								status: "cancelled",
								partial: true,
								summary: "Cancelled.",
							},
							verification: { verified: false, reason: "Cancelled.", paths: [], unresolvedClaims: [] },
						});
					});
				}),
		);
		await flush();

		const cancelled = await registry.cancel(accepted.jobId);
		expect(aborted).toBe(true);
		expect(cancelled.job.status).toBe("cancelled");
		expect(registry.inspect(accepted.jobId).job.status).toBe("cancelled");
	});

	it("does not expose or control another owner's job", async () => {
		const registry = createRegistry();
		const accepted = launch(registry, async () => completedRun());
		await flush();

		expect(() => registry.inspect(accepted.jobId, "owner-b")).toThrowError(/not found/i);
		await expect(registry.cancel(accepted.jobId, "owner-b")).rejects.toThrow(/not found/i);
	});

	it("rejects noncanonical persisted findings and inconsistent terminal snapshots", () => {
		const registry = createRegistry();
		const makeSnapshot = (
			overrides: Partial<PersistedSubagentJobSnapshot["result"]> = {},
		): PersistedSubagentJobSnapshot => ({
			schemaVersion: 1,
			sequence: 1,
			job: {
				schemaVersion: 1,
				jobId: "job-invalid",
				ownerSessionId: "owner-a",
				launchLeafId: "leaf-a",
				role: "explore",
				status: "completed",
				createdAt: "2026-01-01T00:00:00.000Z",
				startedAt: "2026-01-01T00:00:01.000Z",
				finishedAt: "2026-01-01T00:00:02.000Z",
				runId: "run-1",
				resultRef: "job:job-invalid",
			},
			result: {
				schemaVersion: 1,
				jobId: "job-invalid",
				runId: "run-1",
				status: "completed",
				verification: { verified: true, reason: "ok" },
				diagnostics: [],
				...overrides,
			},
		});
		const invalidFindings: ReviewFinding[][] = [
			[
				{
					severity: "high",
					category: "security",
					claim: "Bearer secret-token",
					evidence: [{ path: "src/file.ts" }],
				},
			],
			[
				{
					severity: "high",
					category: "security",
					claim: "x".repeat(8 * 1024 + 1),
					evidence: [{ path: "src/file.ts" }],
				},
			],
			[
				{
					severity: "high",
					category: "security",
					claim: "x",
					evidence: Array.from({ length: 17 }, () => ({ path: "src/file.ts" })),
				},
			],
		];

		for (const findings of invalidFindings) {
			registry.restore([{ type: "custom", customType: JOB_ENTRY_TYPE, data: makeSnapshot({ findings }) }]);
			expect(() => registry.inspect("job-invalid")).toThrowError(/not found/i);
		}

		registry.restore([
			{
				type: "custom",
				customType: JOB_ENTRY_TYPE,
				data: makeSnapshot({ status: "failed" }),
			},
		]);
		expect(() => registry.inspect("job-invalid")).toThrowError(/not found/i);

		registry.restore([
			{
				type: "custom",
				customType: JOB_ENTRY_TYPE,
				data: makeSnapshot({ runId: "run-2" }),
			},
		]);
		expect(() => registry.inspect("job-invalid")).toThrowError(/not found/i);

		const baseline = makeSnapshot();
		const lifecycleCases = [
			{
				jobId: "created-valid",
				valid: true,
				data: {
					...baseline,
					job: {
						...baseline.job,
						jobId: "created-valid",
						resultRef: "job:created-valid",
						status: "created",
						startedAt: undefined,
						finishedAt: undefined,
						runId: undefined,
					},
					result: undefined,
				},
			},
			{
				jobId: "created-started",
				valid: false,
				data: {
					...baseline,
					job: {
						...baseline.job,
						jobId: "created-started",
						resultRef: "job:created-started",
						status: "created",
						startedAt: "2026-01-01T00:00:01.000Z",
						finishedAt: undefined,
						runId: undefined,
					},
					result: undefined,
				},
			},
			{
				jobId: "running-valid",
				valid: true,
				data: {
					...baseline,
					job: {
						...baseline.job,
						jobId: "running-valid",
						resultRef: "job:running-valid",
						status: "running",
						startedAt: "2026-01-01T00:00:01.000Z",
						finishedAt: undefined,
						runId: undefined,
					},
					result: undefined,
				},
			},
			{
				jobId: "running-missing-start",
				valid: false,
				data: {
					...baseline,
					job: {
						...baseline.job,
						jobId: "running-missing-start",
						resultRef: "job:running-missing-start",
						status: "running",
						startedAt: undefined,
						finishedAt: undefined,
						runId: undefined,
					},
					result: undefined,
				},
			},
			{
				jobId: "terminal-missing-start",
				valid: false,
				data: {
					...baseline,
					job: {
						...baseline.job,
						jobId: "terminal-missing-start",
						resultRef: "job:terminal-missing-start",
						startedAt: undefined,
					},
				},
			},
			{
				jobId: "interrupted-created",
				valid: true,
				data: {
					...baseline,
					job: {
						...baseline.job,
						jobId: "interrupted-created",
						resultRef: "job:interrupted-created",
						status: "interrupted",
						startedAt: undefined,
						runId: undefined,
					},
					result: { schemaVersion: 1, jobId: "interrupted-created", status: "interrupted", diagnostics: [] },
				},
			},
		] as const;
		for (const lifecycleCase of lifecycleCases) {
			registry.restore([{ type: "custom", customType: JOB_ENTRY_TYPE, data: lifecycleCase.data }]);
			if (lifecycleCase.valid) {
				const expectedStatus =
					lifecycleCase.data.job.status === "created" || lifecycleCase.data.job.status === "running"
						? "interrupted"
						: lifecycleCase.data.job.status;
				expect(registry.inspect(lifecycleCase.jobId).job.status).toBe(expectedStatus);
			} else expect(() => registry.inspect(lifecycleCase.jobId)).toThrowError(/not found/i);
		}
	});

	it("ignores snapshots owned by another session during restore", () => {
		const persisted: PersistedSubagentJobSnapshot[] = [];
		const registry = createRegistry((snapshot) => persisted.push(snapshot));
		const foreignSnapshot: PersistedSubagentJobSnapshot = {
			schemaVersion: 1,
			sequence: 1,
			job: {
				schemaVersion: 1,
				jobId: "foreign-job",
				ownerSessionId: "owner-b",
				launchLeafId: "leaf-b",
				role: "explore",
				status: "running",
				createdAt: "2026-01-01T00:00:00.000Z",
				resultRef: "job:foreign-job",
			},
		};

		registry.restore([{ type: "custom", customType: JOB_ENTRY_TYPE, data: foreignSnapshot }]);

		expect(() => registry.inspect("foreign-job")).toThrowError(/not found/i);
		expect(persisted).toHaveLength(0);
	});

	it("rejects restore while a worker is active and leaves the worker untouched", async () => {
		let settle!: (value: SubagentJobRunResult) => void;
		const registry = createRegistry();
		const accepted = launch(
			registry,
			() =>
				new Promise<SubagentJobRunResult>((resolve) => {
					settle = resolve;
				}),
		);
		await flush();

		expect(() => registry.restore([])).toThrowError(SubagentJobError);
		expect(registry.inspect(accepted.jobId).job.status).toBe("running");
		settle({
			result: { ...completedRun().result, status: "cancelled", partial: true },
			verification: { verified: false, reason: "test", paths: [], unresolvedClaims: [] },
		});
		await flush();
	});

	it("restores active jobs as interrupted without relaunching them", () => {
		const snapshots: PersistedSubagentJobSnapshot[] = [
			{
				schemaVersion: 1,
				sequence: 1,
				job: {
					schemaVersion: 1,
					jobId: "job-restore",
					ownerSessionId: "owner-a",
					launchLeafId: "leaf-a",
					role: "explore",
					status: "running",
					createdAt: "2026-01-01T00:00:00.000Z",
					startedAt: "2026-01-01T00:00:01.000Z",
					resultRef: "job:job-restore",
				},
			},
		];
		const persisted: PersistedSubagentJobSnapshot[] = [];
		const registry = createRegistry((snapshot) => persisted.push(snapshot));

		const notifications = registry.restore(
			snapshots.map((snapshot) => ({ type: "custom", customType: JOB_ENTRY_TYPE, data: snapshot })),
		);

		expect(registry.inspect("job-restore").job.status).toBe("interrupted");
		expect(persisted.at(-1)?.sequence).toBe(2);
		expect(persisted.at(-1)?.result?.diagnostics[0]?.code).toBe("job_runtime_interrupted");
		expect(notifications).toHaveLength(1);
	});

	it("does not notify when terminal persistence fails and releases the active slot", async () => {
		const persisted: PersistedSubagentJobSnapshot[] = [];
		const notify = vi.fn();
		let writes = 0;
		const registry = createRegistry((snapshot) => {
			writes++;
			if (snapshot.job.status === "completed") throw new Error("terminal disk failure");
			persisted.push(snapshot);
		}, notify);
		const accepted = launch(registry, async () => completedRun());

		await flush();
		expect(registry.inspect(accepted.jobId).job.status).toBe("failed");
		expect(notify).not.toHaveBeenCalled();
		expect(writes).toBe(3);
		expect(persisted.at(-1)?.job.status).toBe("running");
		const nextRunner = vi.fn(async () => completedRun());
		let nextError: unknown;
		try {
			launch(registry, nextRunner);
		} catch (error) {
			nextError = error;
		}
		expect(nextError).toBeInstanceOf(SubagentJobError);
		expect((nextError as SubagentJobError).code).toBe("job_persistence_failure");
		expect(nextRunner).not.toHaveBeenCalled();
	});

	it("does not invoke the runner when the running snapshot cannot persist", async () => {
		const run = vi.fn(async () => completedRun());
		let writes = 0;
		const registry = createRegistry(() => {
			writes++;
			if (writes === 2) throw new Error("running disk failure");
		});
		const accepted = launch(registry, run);

		await flush();
		expect(run).not.toHaveBeenCalled();
		expect(registry.inspect(accepted.jobId).job.status).toBe("failed");
		const nextRunner = vi.fn(async () => completedRun());
		let nextError: unknown;
		try {
			launch(registry, nextRunner);
		} catch (error) {
			nextError = error;
		}
		expect(nextError).toBeInstanceOf(SubagentJobError);
		expect((nextError as SubagentJobError).code).toBe("job_persistence_failure");
		expect(nextRunner).not.toHaveBeenCalled();
	});

	it("delivers completion only after terminal persistence and retains at most 32 terminal jobs", async () => {
		const snapshots: PersistedSubagentJobSnapshot[] = [];
		const order: string[] = [];
		const registry = createRegistry(
			(snapshot) => {
				snapshots.push(snapshot);
				if (snapshot.job.status === "completed") order.push("persisted");
			},
			() => order.push("notified"),
		);

		for (let index = 0; index < 33; index++) {
			const accepted = launch(registry, async () => completedRun());
			await flush();
			if (index < 32) expect(registry.inspect(accepted.jobId).job.status).toBe("completed");
		}

		expect(registry.list().filter((job) => job.job.status === "completed" && !job.tombstone)).toHaveLength(32);
		expect(order[0]).toBe("persisted");
		expect(order[1]).toBe("notified");
		expect(snapshots.filter((snapshot) => snapshot.job.status === "completed")).toHaveLength(33);
		// Retention expiry is explicit: the pruned 33rd job stays inspectable as a
		// bounded tombstone instead of silently becoming not-found.
		const firstJobId = snapshots[0]?.job.jobId;
		const tombstoneInspection = registry.inspect(firstJobId!);
		expect(tombstoneInspection.tombstone).toMatchObject({ jobId: firstJobId, terminalStatus: "completed" });
		expect(tombstoneInspection.job.status).toBe("completed");
		expect(tombstoneInspection.result).toBeUndefined();
	});

	it("removes a spilled artifact when its durable full result expires from retention", async () => {
		const artifactRoot = mkdtempSync(join(tmpdir(), "ice-subagent-job-artifacts-"));
		try {
			const artifact = writeSubagentReportArtifact({
				runId: "retained-artifact",
				content: "oversized child output",
				artifactRoot,
			});
			expect(artifact).toBeDefined();
			expect(existsSync(artifact!.path)).toBe(true);
			const registry = createRegistry(undefined, undefined, { reportArtifactRoot: artifactRoot });
			const first = completedRun();
			launch(registry, async () => ({
				...first,
				result: { ...first.result, runId: artifact!.id, reportArtifact: artifact },
			}));
			await flush();
			for (let index = 0; index < 32; index++) {
				launch(registry, async () => completedRun());
				await flush();
			}

			expect(existsSync(artifact!.path)).toBe(false);
			expect(registry.list().filter((inspection) => inspection.tombstone)).toHaveLength(1);
		} finally {
			rmSync(artifactRoot, { recursive: true, force: true });
		}
	});

	it("shuts down active work as interrupted and leaves no active controller", async () => {
		let settle!: (value: SubagentJobRunResult) => void;
		const snapshots: PersistedSubagentJobSnapshot[] = [];
		const registry = createRegistry((snapshot) => snapshots.push(snapshot));
		launch(
			registry,
			(signal) =>
				new Promise<SubagentJobRunResult>((resolve) => {
					settle = resolve;
					signal.addEventListener("abort", () =>
						settle({
							result: { ...completedRun().result, status: "cancelled", partial: true },
							verification: { verified: false, reason: "shutdown", paths: [], unresolvedClaims: [] },
						}),
					);
				}),
		);
		await flush();

		await registry.shutdown();
		expect(registry.list().every((job) => job.job.status !== "running" && job.job.status !== "created")).toBe(true);
		expect(snapshots.at(-1)?.job.status).toBe("interrupted");
	});

	it("makes concurrent shutdown callers await the same worker settlement", async () => {
		let settle!: (value: SubagentJobRunResult) => void;
		let aborted = false;
		const registry = createRegistry();
		launch(
			registry,
			(signal) =>
				new Promise<SubagentJobRunResult>((resolve) => {
					settle = resolve;
					signal.addEventListener("abort", () => {
						aborted = true;
					});
				}),
		);
		await flush();

		let firstResolved = false;
		const first = registry.shutdown().then(() => {
			firstResolved = true;
		});
		const second = registry.shutdown();
		await flush();
		expect(aborted).toBe(true);
		expect(firstResolved).toBe(false);

		settle({
			result: { ...completedRun().result, status: "cancelled", partial: true },
			verification: { verified: false, reason: "shutdown", paths: [], unresolvedClaims: [] },
		});
		await Promise.all([first, second]);
		expect(firstResolved).toBe(true);
	});

	it("promotes queued jobs in FIFO order after terminal persistence", async () => {
		const first = deferredRun();
		const starts: string[] = [];
		const second = vi.fn(async () => {
			starts.push("second");
			return completedRun();
		});
		const third = vi.fn(async () => {
			starts.push("third");
			return completedRun();
		});
		const registry = createRegistry(
			() => {},
			() => {},
			{ maxActiveJobs: 1 },
		);
		launch(registry, first.run);
		const secondJob = launch(registry, second);
		const thirdJob = launch(registry, third);

		await flush();
		expect(first.run).toHaveBeenCalledOnce();
		expect(second).not.toHaveBeenCalled();
		expect(third).not.toHaveBeenCalled();
		first.settle();
		await flush();

		expect(second).toHaveBeenCalledOnce();
		expect(starts[0]).toBe("second");
		expect(starts).toEqual(["second", "third"]);
		expect(registry.inspect(thirdJob.jobId).job.status).toBe("completed");
		expect(registry.inspect(secondJob.jobId).job.status).toBe("completed");
	});

	it("never exceeds the configured active concurrency", async () => {
		const first = deferredRun();
		const second = deferredRun();
		const third = deferredRun();
		const registry = createRegistry(
			() => {},
			() => {},
			{ maxActiveJobs: 2 },
		);
		launch(registry, first.run);
		launch(registry, second.run);
		const thirdJob = launch(registry, third.run);

		await flush();
		expect(first.run).toHaveBeenCalledOnce();
		expect(second.run).toHaveBeenCalledOnce();
		expect(third.run).not.toHaveBeenCalled();
		expect(registry.inspect(thirdJob.jobId).job.status).toBe("queued");

		first.settle();
		await flush();
		expect(third.run).toHaveBeenCalledOnce();
		second.settle();
		third.settle();
		await flush();
	});

	it("rejects the ninth queued job without persistence or runner invocation", async () => {
		const first = deferredRun();
		const persisted: PersistedSubagentJobSnapshot[] = [];
		const registry = createRegistry(
			(snapshot) => persisted.push(snapshot),
			() => {},
			{ maxActiveJobs: 1 },
		);
		launch(registry, first.run);
		const queuedRunners = Array.from({ length: 8 }, () => vi.fn(async () => completedRun()));
		for (const run of queuedRunners) launch(registry, run);
		const writesBeforeReject = persisted.length;
		const rejected = vi.fn(async () => completedRun());

		expect(() => launch(registry, rejected)).toThrowError(/queue/i);
		expect(persisted.length).toBe(writesBeforeReject);
		expect(rejected).not.toHaveBeenCalled();
		first.settle();
		await flush();
	});

	it("rejects an admission that would exceed the owner aggregate output budget", async () => {
		const first = deferredRun();
		const persisted: PersistedSubagentJobSnapshot[] = [];
		const registry = createRegistry(
			(snapshot) => persisted.push(snapshot),
			() => {},
			{
				maxActiveJobs: 1,
				maxAggregateOutputBytes: 32 * 1024,
			},
		);
		launch(registry, first.run, 24 * 1024);
		const rejected = vi.fn(async () => completedRun());

		expect(() => launch(registry, rejected, 9 * 1024)).toThrowError(/budget/i);
		expect(persisted).toHaveLength(1);
		expect(rejected).not.toHaveBeenCalled();
		first.settle();
		await flush();
	});

	it("cancels a queued job without invoking it and releases queue capacity", async () => {
		const first = deferredRun();
		const second = vi.fn(async () => completedRun());
		const third = vi.fn(async () => completedRun());
		const registry = createRegistry(
			() => {},
			() => {},
			{ maxActiveJobs: 1, maxQueuedJobs: 1 },
		);
		launch(registry, first.run);
		const secondJob = launch(registry, second);
		const cancelled = await registry.cancel(secondJob.jobId);

		expect(cancelled.job.status).toBe("cancelled");
		expect(second).not.toHaveBeenCalled();
		const thirdJob = launch(registry, third);
		expect(thirdJob.status).toBe("queued");
		first.settle();
		await flush();
		expect(third).toHaveBeenCalledOnce();
	});

	it("cancels an active and queued subset atomically without running selected queued jobs", async () => {
		const active = vi.fn(
			(signal: AbortSignal) =>
				new Promise<SubagentJobRunResult>((resolve) => {
					signal.addEventListener("abort", () =>
						resolve({
							result: { ...completedRun().result, status: "cancelled", partial: true },
							verification: { verified: false, reason: "cancelled", paths: [], unresolvedClaims: [] },
						}),
					);
				}),
		);
		const selectedQueued = vi.fn(async () => completedRun());
		const unselectedQueued = vi.fn(async () => completedRun());
		const registry = createRegistry(
			() => {},
			() => {},
			{ maxActiveJobs: 1, maxQueuedJobs: 2 },
		);
		const activeJob = launch(registry, active);
		const selectedQueuedJob = launch(registry, selectedQueued);
		const unselectedQueuedJob = launch(registry, unselectedQueued);
		await flush();

		await registry.cancelSubset([activeJob.jobId, selectedQueuedJob.jobId]);
		await flush();

		expect(registry.inspect(activeJob.jobId).job.status).toBe("cancelled");
		expect(registry.inspect(selectedQueuedJob.jobId).job.status).toBe("cancelled");
		expect(selectedQueued).not.toHaveBeenCalled();
		expect(unselectedQueued).toHaveBeenCalledOnce();
		expect(registry.inspect(unselectedQueuedJob.jobId).job.status).toBe("completed");
	});

	it("waits for a running cancellation to settle before promoting the next job", async () => {
		const first = deferredRun();
		const second = vi.fn(async () => completedRun());
		const registry = createRegistry(
			() => {},
			() => {},
			{ maxActiveJobs: 1 },
		);
		const firstJob = launch(registry, first.run);
		launch(registry, second);
		await flush();

		const cancellation = registry.cancel(firstJob.jobId);
		await flush();
		expect(second).not.toHaveBeenCalled();
		first.settle({
			result: { ...completedRun().result, status: "cancelled", partial: true },
			verification: { verified: false, reason: "cancelled", paths: [], unresolvedClaims: [] },
		});
		await cancellation;
		await flush();
		expect(second).toHaveBeenCalledOnce();
	});

	it("does not double-pump or double-release on concurrent cancellation", async () => {
		const first = deferredRun();
		const second = vi.fn(async () => completedRun());
		const registry = createRegistry(
			() => {},
			() => {},
			{ maxActiveJobs: 1 },
		);
		const firstJob = launch(registry, first.run);
		launch(registry, second);
		await flush();

		const cancellations = [registry.cancel(firstJob.jobId), registry.cancel(firstJob.jobId)];
		await flush();
		expect(second).not.toHaveBeenCalled();
		first.settle({
			result: { ...completedRun().result, status: "cancelled", partial: true },
			verification: { verified: false, reason: "cancelled", paths: [], unresolvedClaims: [] },
		});
		await Promise.all(cancellations);
		await flush();
		expect(second).toHaveBeenCalledOnce();
	});

	it("fails closed when the running transition cannot persist", async () => {
		const runner = vi.fn(async () => completedRun());
		let runningWrites = 0;
		const registry = createRegistry((snapshot) => {
			if (snapshot.job.status === "running") {
				runningWrites++;
				throw new Error("running disk failure");
			}
		});
		const failed = launch(registry, runner);
		await flush();

		expect(runner).not.toHaveBeenCalled();
		expect(registry.inspect(failed.jobId).job.status).toBe("failed");
		const nextRunner = vi.fn(async () => completedRun());
		let nextError: unknown;
		try {
			launch(registry, nextRunner);
		} catch (error) {
			nextError = error;
		}
		expect(nextError).toBeInstanceOf(SubagentJobError);
		expect((nextError as SubagentJobError).code).toBe("job_persistence_failure");
		expect(nextRunner).not.toHaveBeenCalled();
		expect(runningWrites).toBe(1);
	});

	it("fails closed when a queued transition cannot persist", async () => {
		const first = deferredRun();
		const persisted: PersistedSubagentJobSnapshot[] = [];
		let failQueued = true;
		const registry = createRegistry(
			(snapshot) => {
				if (snapshot.job.status === "queued" && failQueued) {
					failQueued = false;
					throw new Error("queued disk failure");
				}
				persisted.push(snapshot);
			},
			() => {},
			{ maxActiveJobs: 1 },
		);
		launch(registry, first.run);
		expect(() => launch(registry, async () => completedRun())).toThrowError(/persistence/i);
		expect(persisted.some((snapshot) => snapshot.job.status === "queued")).toBe(false);
		const accepted = launch(registry, async () => completedRun());
		expect(accepted.status).toBe("queued");
		first.settle();
		await flush();
	});

	it("does not promote the queue after terminal persistence fails", async () => {
		const second = vi.fn(async () => completedRun());
		let failTerminal = true;
		const registry = createRegistry(
			(snapshot) => {
				if (snapshot.job.status === "completed" && failTerminal) {
					failTerminal = false;
					throw new Error("terminal disk failure");
				}
			},
			() => {},
			{ maxActiveJobs: 1 },
		);
		launch(registry, async () => completedRun());
		launch(registry, second);
		await flush();

		expect(second).not.toHaveBeenCalled();
		const nextRunner = vi.fn(async () => completedRun());
		let nextError: unknown;
		try {
			launch(registry, nextRunner);
		} catch (error) {
			nextError = error;
		}
		expect(nextError).toBeInstanceOf(SubagentJobError);
		expect((nextError as SubagentJobError).code).toBe("job_persistence_failure");
		expect(nextRunner).not.toHaveBeenCalled();
	});

	it("reports FIFO queue position without exposing scheduler controls", async () => {
		const first = deferredRun();
		const registry = createRegistry(
			() => {},
			() => {},
			{ maxActiveJobs: 1 },
		);
		launch(registry, first.run);
		const queued = launch(registry, async () => completedRun());
		await flush();

		const inspection = registry.inspect(queued.jobId);
		expect(inspection.job.status).toBe("queued");
		expect(inspection.queuePosition).toBe(1);
		expect(JSON.stringify(inspection)).not.toMatch(/priority|schedulerId|workerId/i);
		first.settle();
		await flush();
	});

	it("interrupts queued and running jobs during shutdown without pumping", async () => {
		const first = deferredRun();
		const second = vi.fn(async () => completedRun());
		const registry = createRegistry(
			() => {},
			() => {},
			{ maxActiveJobs: 1 },
		);
		const firstJob = launch(registry, first.run);
		const secondJob = launch(registry, second);
		await flush();

		const shutdown = registry.shutdown();
		await flush();
		expect(registry.inspect(secondJob.jobId).job.status).toBe("interrupted");
		expect(second).not.toHaveBeenCalled();
		first.settle({
			result: { ...completedRun().result, status: "cancelled", partial: true },
			verification: { verified: false, reason: "shutdown", paths: [], unresolvedClaims: [] },
		});
		await shutdown;
		expect(registry.inspect(firstJob.jobId).job.status).toBe("interrupted");
	});

	it("restores every stale nonterminal job as interrupted without relaunch", () => {
		const registry = createRegistry();
		const snapshots = ["created", "queued", "running"].map((status, index) =>
			persistedSnapshot(`stale-${index}`, status),
		);
		const notifications = registry.restore(
			snapshots.map((snapshot) => ({ type: "custom", customType: JOB_ENTRY_TYPE, data: snapshot })),
		);

		expect(notifications).toHaveLength(3);
		expect(registry.list().every((inspection) => inspection.job.status === "interrupted")).toBe(true);
	});

	it("does not restore a foreign queued job into the owner scheduler", () => {
		const registry = createRegistry();
		registry.restore([
			{ type: "custom", customType: JOB_ENTRY_TYPE, data: persistedSnapshot("foreign-queued", "queued", "owner-b") },
		]);

		expect(registry.list()).toHaveLength(0);
		expect(() => registry.inspect("foreign-queued")).toThrowError(/not found/i);
	});

	it("retains a live running job while trimming terminal history", async () => {
		const live = deferredRun();
		const registry = createRegistry(
			() => {},
			() => {},
			{ maxActiveJobs: 2 },
		);
		const liveJob = launch(registry, live.run);
		await flush();
		for (let index = 0; index < 33; index++) {
			const terminal = launch(registry, async () => completedRun());
			await flush();
			expect(registry.inspect(terminal.jobId).job.status).toBe("completed");
		}

		expect(registry.inspect(liveJob.jobId).job.status).toBe("running");
		expect(registry.list().filter((inspection) => inspection.job.status === "completed")).toHaveLength(33);
		expect(registry.list().filter((inspection) => inspection.tombstone)).toHaveLength(1);
		live.settle();
		await flush();
	});

	it("publishes admission, running, and terminal changes after persistence", async () => {
		const statuses: string[] = [];
		const registry = createRegistry();
		const unsubscribe = registry.subscribe(() => statuses.push(registry.list()[0]?.job.status ?? "missing"));
		const accepted = launch(registry, async () => completedRun());
		expect(statuses).toEqual(["created"]);
		await flush();

		expect(registry.inspect(accepted.jobId).job.status).toBe("completed");
		expect(statuses).toEqual(["created", "running", "completed"]);
		unsubscribe();
	});

	it("swallows throwing subscribers without changing scheduling", async () => {
		const first = deferredRun();
		const second = vi.fn(async () => completedRun());
		const registry = createRegistry(
			() => {},
			() => {},
			{ maxActiveJobs: 1 },
		);
		registry.subscribe(() => {
			throw new Error("durable job UI failed");
		});
		launch(registry, first.run);
		const queued = launch(registry, second);
		expect(queued.status).toBe("queued");
		first.settle();
		await flush();
		expect(second).toHaveBeenCalledOnce();
	});

	it("does not publish a phantom job when initial persistence fails", () => {
		const listener = vi.fn();
		const registry = createRegistry(() => {
			throw new Error("initial disk failure");
		});
		registry.subscribe(listener);
		expect(() => launch(registry, async () => completedRun())).toThrowError(SubagentJobError);
		expect(listener).not.toHaveBeenCalled();
	});

	it("publishes one restore completion after stale jobs are terminalized", () => {
		const listener = vi.fn();
		const registry = createRegistry();
		registry.subscribe(listener);
		registry.restore([
			{ type: "custom", customType: JOB_ENTRY_TYPE, data: persistedSnapshot("restore-running", "running") },
		]);
		expect(listener).toHaveBeenCalledOnce();
		expect(registry.inspect("restore-running").job.status).toBe("interrupted");
	});
});

describe("durable job revocation and feature-off restore", () => {
	it("does not silently promote queued work after an explicit pre-promotion stop", async () => {
		const notified: string[] = [];
		const registry = createRegistry(
			() => {},
			(jobId) => {
				notified.push(jobId);
			},
			{ maxActiveJobs: 1 },
		);
		const blocking = deferredRun();
		const first = launch(registry, blocking.run);
		await flush();
		const queuedRun = vi.fn(async () => completedRun());
		const queued = launch(registry, queuedRun);
		await flush();
		expect(registry.inspect(queued.jobId).job.status).toBe("queued");
		// Revocation before promotion must be explicit: stopping queued work
		// records cancellation without ever starting the queued run function.
		const cancelled = await registry.cancel(queued.jobId);
		expect(cancelled.job.status).toBe("cancelled");
		blocking.settle();
		await flush();
		await flush();
		expect(queuedRun).not.toHaveBeenCalled();
		expect(registry.inspect(first.jobId).job.status).toBe("completed");
		expect(registry.inspect(queued.jobId).job.status).toBe("cancelled");
	});

	it("restores terminal retained state as inspectable history without relaunching work", async () => {
		const completed = persistedSnapshot("feature-off-terminal", "completed", "owner-a");
		const registry = createRegistry();
		const notifications = registry.restore([{ type: "custom", customType: JOB_ENTRY_TYPE, data: completed }]);
		expect(notifications).toEqual(["feature-off-terminal"]);
		expect(registry.inspect("feature-off-terminal").job).toMatchObject({
			jobId: "feature-off-terminal",
			status: "completed",
		});
		// Restore loads bounded retained history without starting a live worker:
		// the job remains inspectable, terminal history does not notify twice,
		// and the restored terminal record cannot be mistaken for live work.
		const repeat = registry.restore(
			[{ type: "custom", customType: JOB_ENTRY_TYPE, data: completed }],
			new Set(["feature-off-terminal"]),
		);
		expect(repeat).toEqual([]);
		expect(registry.inspect("feature-off-terminal").job).toMatchObject({
			jobId: "feature-off-terminal",
			status: "completed",
		});
	});
});
describe("durable job identity and artifact parity", () => {
	it("keeps one accepted job ID inspectable across queued, running, and terminal states", async () => {
		const registry = createRegistry(
			() => {},
			() => {},
			{ maxActiveJobs: 1 },
		);
		const first = deferredRun();
		const live = launch(registry, first.run);
		await flush();
		expect(registry.inspect(live.jobId).job).toMatchObject({ jobId: live.jobId, status: "running" });

		const second = deferredRun();
		const queued = launch(registry, second.run);
		expect(registry.inspect(queued.jobId).job).toMatchObject({ jobId: queued.jobId, status: "queued" });
		expect(registry.inspect(queued.jobId).queuePosition).toBe(1);

		first.settle();
		await flush();
		expect(registry.inspect(queued.jobId).job).toMatchObject({ jobId: queued.jobId, status: "running" });
		second.settle();
		await flush();
		expect(registry.inspect(queued.jobId).job).toMatchObject({ jobId: queued.jobId, status: "completed" });
	});

	it("keeps a needs_time job inspectable and marks it running again after extension", async () => {
		const registry = createRegistry(
			() => {},
			() => {},
		);
		const needsTime: SubagentJobRunResult = {
			result: {
				...completedRun().result,
				runId: "run-async",
				status: "needs_time",
				partial: true,
				workArtifact: {
					schemaVersion: 1,
					runId: "run-async",
					profile: "explore",
					startedAtMs: 1,
					lastActivities: [],
					observedOutputBytes: 0,
					touchedPaths: ["src/app.ts"],
					candidateEvidencePaths: [],
					reportProtocol: { status: "missing", diagnostic: "awaiting extension" },
				},
			},
			verification: { verified: false, reason: "pending", paths: [], unresolvedClaims: [] },
		};
		const accepted = launch(registry, async () => needsTime);
		await flush();
		expect(registry.inspect(accepted.jobId).job).toMatchObject({ status: "needs_time", runId: "run-async" });

		expect(registry.markManagedRunState("run-async", "running")).toBe(true);
		expect(registry.inspect(accepted.jobId).job).toMatchObject({ status: "running", runId: "run-async" });

		const completed: SubagentJobRunResult = {
			result: { ...completedRun().result, runId: "run-async" },
			verification: { verified: true, reason: "ok", paths: [], unresolvedClaims: [] },
		};
		await registry.resolveManagedRun("run-async", completed);
		expect(registry.inspect(accepted.jobId).job).toMatchObject({ jobId: accepted.jobId, status: "completed" });
	});

	it("preserves the runtime work artifact when a durable job fails the report protocol", async () => {
		const snapshots: PersistedSubagentJobSnapshot[] = [];
		const registry = createRegistry(
			(snapshot) => snapshots.push(snapshot),
			() => {},
		);
		const protocolFailure: SubagentJobRunResult = {
			result: {
				...completedRun().result,
				runId: "run-protocol",
				status: "verification_failed",
				evidence: undefined,
				reportArtifact: {
					schemaVersion: 1,
					id: "run-protocol",
					path: `${TEST_REPORT_ARTIFACT_ROOT}/run-protocol/report.json`,
					bytes: 12,
					originalBytes: 42,
					sha256: "a".repeat(64),
					contentType: "application/json",
					truncated: true,
				},
				workArtifact: {
					schemaVersion: 1,
					runId: "run-protocol",
					profile: "explore",
					startedAtMs: 1,
					finishedAtMs: 2,
					lastActivities: [
						{
							toolCallId: "c1",
							toolName: "bash",
							action: 'bash "npm run test:api"',
							status: "error",
							startedAtMs: 1,
							finishedAtMs: 2,
							exitCode: 1,
							errorClass: "command_failed",
						},
					],
					observedOutputBytes: 128,
					touchedPaths: ["src/app.ts"],
					candidateEvidencePaths: ["src/generated.ts"],
					reportProtocol: { status: "malformed", diagnostic: "Child report was not valid JSON." },
				},
				diagnostics: [{ code: "report_protocol_failure", message: "Child report was not valid JSON." }],
			},
			verification: { verified: false, reason: "protocol failure", paths: [], unresolvedClaims: [] },
		};
		const accepted = launch(registry, async () => protocolFailure);
		await flush();
		const inspection = registry.inspect(accepted.jobId);
		expect(inspection.job.status).toBe("verification_failed");
		expect(inspection.result?.workArtifact).toBeDefined();
		expect(inspection.result?.reportArtifact).toMatchObject({
			id: "run-protocol",
			contentType: "application/json",
			bytes: 12,
			originalBytes: 42,
			truncated: true,
		});
		expect(inspection.result?.workArtifact?.reportProtocol).toMatchObject({ status: "malformed" });
		expect(inspection.result?.workArtifact?.touchedPaths).toEqual(["src/app.ts"]);
		// Candidate evidence stays bounded and never becomes verified evidence.
		expect(inspection.result?.workArtifact?.candidateEvidencePaths).toEqual(["src/generated.ts"]);
		expect(inspection.result?.evidence).toBeUndefined();

		const trusted = snapshots.at(-1)!;
		const outsideRoot = structuredClone(trusted);
		outsideRoot.sequence += 1;
		outsideRoot.result!.reportArtifact!.path = "/tmp/report.json";
		const mismatchedPath = structuredClone(trusted);
		mismatchedPath.sequence += 2;
		mismatchedPath.result!.reportArtifact!.path = `${TEST_REPORT_ARTIFACT_ROOT}/another-run/report.json`;
		const restored = createRegistry();
		restored.restore(
			[outsideRoot, mismatchedPath].map((snapshot) => ({
				type: "custom",
				customType: JOB_ENTRY_TYPE,
				data: snapshot,
			})),
		);
		expect(restored.list()).toHaveLength(0);
	});

	it("keeps expired terminal history inspectable as a bounded tombstone after restart", async () => {
		const snapshots: PersistedSubagentJobSnapshot[] = [];
		const persisted: PersistedSubagentJobSnapshot[] = [];
		for (let index = 0; index < 33; index++) {
			const jobId = `job-old-${index}`;
			const job = {
				schemaVersion: 1,
				jobId,
				ownerSessionId: "owner-a",
				launchLeafId: "leaf-a",
				role: "explore",
				status: "completed",
				createdAt: "2026-01-01T00:00:00.000Z",
				startedAt: "2026-01-01T00:00:01.000Z",
				finishedAt: "2026-01-01T00:00:02.000Z",
				runId: `run-old-${index}`,
				resultRef: `job:${jobId}`,
			};
			snapshots.push({
				schemaVersion: 1,
				sequence: index + 1,
				job,
				result: {
					schemaVersion: 1,
					jobId,
					runId: `run-old-${index}`,
					status: "completed",
					diagnostics: [],
				},
			} as unknown as PersistedSubagentJobSnapshot);
			void persisted;
		}
		const registry = createRegistry((snapshot) => persisted.push(snapshot));
		registry.restore(snapshots.map((snapshot) => ({ type: "custom", customType: JOB_ENTRY_TYPE, data: snapshot })));

		// 32 full records remain; the oldest is a bounded tombstone, not not-found.
		expect(registry.list().filter((inspection) => !inspection.tombstone)).toHaveLength(32);
		const tombstone = registry.inspect("job-old-0");
		expect(tombstone.tombstone).toMatchObject({ jobId: "job-old-0", terminalStatus: "completed" });
		expect(tombstone.result).toBeUndefined();
		expect(registry.inspect("job-old-1").result).toBeDefined();
	});
});
