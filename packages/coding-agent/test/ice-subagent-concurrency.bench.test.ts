import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { normalizeSubagentRequest, runResolvedSubagentBatch } from "../src/ice-subagents.ts";

/**
 * Opt-in, no-network benchmark for ICE subagent batch concurrency. Skipped
 * unless ICE_BENCH_CONCURRENCY=1 is set; never consumes provider tokens.
 *
 * Run: ICE_BENCH_CONCURRENCY=1 node ../../node_modules/vitest/dist/cli.js --run test/ice-subagent-concurrency.bench.test.ts
 */

const LEVELS = [1, 2, 4, 8];
const TASKS_PER_LEVEL = 8;
const CHILD_WORK_MS = 20;
const enabled = process.env.ICE_BENCH_CONCURRENCY === "1";

class EventLoopLagSampler {
	private maxLagMs = 0;
	private running = false;

	start(): void {
		this.running = true;
		this.maxLagMs = 0;
		let expected = performance.now() + 5;
		const tick = (): void => {
			if (!this.running) return;
			const lag = performance.now() - expected - 5;
			if (lag > this.maxLagMs) this.maxLagMs = lag;
			expected = performance.now() + 5;
			setTimeout(tick, 5);
		};
		setTimeout(tick, 5);
	}

	stop(): number {
		this.running = false;
		return this.maxLagMs;
	}
}

interface BenchSample {
	concurrency: number;
	wallMs: number;
	peakActive: number;
	maxLagMs: number;
}

async function runLevel(concurrency: number, cwd: string): Promise<BenchSample> {
	const tasks = Array.from({ length: TASKS_PER_LEVEL }, (_, index) => ({
		id: `task-${index}`,
		request: normalizeSubagentRequest(
			{
				parentSessionId: "bench-parent",
				role: "self",
				task: `Read-only benchmark task ${index}.`,
				scope: { roots: ["src"] },
				cwd,
				self: { instructions: "Report evidence.", capabilities: ["read"] },
			},
			cwd,
			{ agentDir: join(cwd, ".ice-agent") },
		),
	}));
	let active = 0;
	let peakActive = 0;
	const sampler = new EventLoopLagSampler();
	const runner = {
		runResolved: async (request: { runId: string }) => {
			active++;
			peakActive = Math.max(peakActive, active);
			await new Promise((resolve) => setTimeout(resolve, CHILD_WORK_MS));
			active--;
			const owner = tasks.find((task) => task.request.runId === request.runId)!;
			return {
				runId: request.runId,
				childSessionId: `bench-${request.runId}`,
				parentSessionId: "bench-parent",
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
	sampler.start();
	const startedAt = performance.now();
	const result = await runResolvedSubagentBatch(tasks, ["delegate", "read"], runner, { concurrency });
	const wallMs = performance.now() - startedAt;
	const maxLagMs = sampler.stop();
	if (result.status !== "completed") {
		const itemStatuses = result.items
			.map((item) => `${item.taskId}:${item.result.status}:${item.verification.reason}`)
			.join(", ");
		throw new Error(
			`benchmark batch failed: ${result.status}: items=[${itemStatuses}] diagnostics=${result.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`).join("; ")}`,
		);
	}
	return { concurrency, wallMs, peakActive, maxLagMs };
}

describe.skipIf(!enabled)("subagent batch concurrency benchmark (opt-in)", () => {
	it("records wall time, peak active children, and event-loop lag for 1/2/4/8", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "ice-bench-concurrency-"));
		await mkdir(join(cwd, "src"));
		try {
			const samples: BenchSample[] = [];
			for (const level of LEVELS) {
				await runLevel(level, cwd); // warm-up pass
				samples.push(await runLevel(level, cwd));
			}
			console.log(
				`simulated ${CHILD_WORK_MS}ms children, ${TASKS_PER_LEVEL} tasks per level (no network, no tokens)`,
			);
			console.log("concurrency | wall ms | peak active | max event-loop lag ms");
			for (const sample of samples) {
				console.log(
					`${String(sample.concurrency).padStart(11)} | ${sample.wallMs.toFixed(1).padStart(7)} | ${String(sample.peakActive).padStart(11)} | ${sample.maxLagMs.toFixed(2)}`,
				);
			}
			for (const sample of samples) {
				expect(sample.peakActive).toBeLessThanOrEqual(sample.concurrency);
				expect(sample.peakActive).toBe(sample.concurrency);
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
