#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	type LiveQualityBenchMode,
	renderQualityBenchmarkMarkdown,
	resolveQualityCaseManifest,
	serializeQualityBenchmarkJson,
} from "../src/subagents/bench/quality-bench.ts";
import { executeLiveQualityBenchmark } from "../src/subagents/bench/quality-live-bench.ts";
import { qualityCaseManifest } from "../test/fixtures/quality/cases.ts";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const worktreeRoot = resolve(packageRoot, "..", "..");
const fixtureRoot = join(packageRoot, "test", "fixtures", "quality");
const fixture = resolveQualityCaseManifest(qualityCaseManifest, fixtureRoot);

function listEnv(name: string): string[] | undefined {
	const value = process.env[name]?.trim();
	if (!value) return undefined;
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function modesEnv(): LiveQualityBenchMode[] | undefined {
	const values = listEnv("ICE_QUALITY_BENCH_LIVE_MODES");
	if (!values) return undefined;
	const allowed = new Set<LiveQualityBenchMode>([
		"plain",
		"structured",
		"contract",
		"contract-no-context",
		"file",
		"batch",
		"review",
	]);
	for (const value of values) {
		if (!allowed.has(value as LiveQualityBenchMode)) {
			throw new Error(`Unknown ICE_QUALITY_BENCH_LIVE_MODES value: ${value}`);
		}
	}
	return values as LiveQualityBenchMode[];
}

async function main(): Promise<void> {
	if (process.env.ICE_QUALITY_BENCH_LIVE !== "1") {
		throw new Error("Set ICE_QUALITY_BENCH_LIVE=1 to permit model-backed benchmark calls.");
	}
	const modelRoute = process.argv[2] ?? process.env.ICE_QUALITY_BENCH_LIVE_MODEL;
	if (!modelRoute) throw new Error("Pass provider/model or set ICE_QUALITY_BENCH_LIVE_MODEL.");
	const repeatsValue = process.env.ICE_QUALITY_BENCH_LIVE_REPEATS;
	const repeats = repeatsValue ? Number.parseInt(repeatsValue, 10) : undefined;
	const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreeRoot });
	const run = await executeLiveQualityBenchmark({
		modelRoute,
		fixture,
		gitCommit: stdout.trim(),
		worktreePath: worktreeRoot,
		...(repeats !== undefined ? { repeats } : {}),
		...(modesEnv() ? { modes: modesEnv() } : {}),
		...(listEnv("ICE_QUALITY_BENCH_LIVE_CASES") ? { caseIds: listEnv("ICE_QUALITY_BENCH_LIVE_CASES") } : {}),
		...(process.env.ICE_QUALITY_BENCH_LIVE_THINKING
			? { thinkingLevel: process.env.ICE_QUALITY_BENCH_LIVE_THINKING as "medium" }
			: {}),
	});
	const artifactDir = resolve(
		process.env.ICE_QUALITY_BENCH_LIVE_OUTPUT_DIR ?? join(worktreeRoot, ".artifacts", "subagent-quality-bench"),
	);
	await mkdir(artifactDir, { recursive: true });
	const safeRoute = modelRoute.replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
	const stem = `baseline-live-${safeRoute}-${stdout.trim().slice(0, 12)}`;
	const markdownPath = join(artifactDir, `${stem}.md`);
	const jsonPath = join(artifactDir, `${stem}.json`);
	await writeFile(markdownPath, renderQualityBenchmarkMarkdown(run), "utf8");
	await writeFile(jsonPath, serializeQualityBenchmarkJson(run), "utf8");
	console.log(
		JSON.stringify({
			markdownPath,
			jsonPath,
			runs: run.runs.length,
			weightedVerifiedSuccess: run.aggregate.weightedVerifiedSuccess,
			minEvidencePrecision: run.minEvidencePrecision,
		}),
	);
}

await main();
