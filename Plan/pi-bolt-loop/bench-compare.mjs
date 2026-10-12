#!/usr/bin/env node
// Controller-owned A/B comparator. Runs the candidate worktree's frozen bench harness against a base
// checkout and the candidate checkout, interleaved, and decides pass/fail from medians.
//
// node bench-compare.mjs --harness <worktree> --base <checkout> --cand <checkout> --runs <n>
//   --targets name:minGain,... --guards name,... --max-regress 0.10 --out <verdict.json> [--aa]
// Exit 0 = pass, 1 = fail, 2 = harness error.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		harness: { type: "string" },
		base: { type: "string" },
		cand: { type: "string" },
		runs: { type: "string", default: "7" },
		targets: { type: "string", default: "" },
		guards: { type: "string", default: "" },
		"max-regress": { type: "string", default: "0.10" },
		out: { type: "string" },
		aa: { type: "boolean", default: false },
	},
});

const runs = Number(values.runs);
const maxRegress = Number(values["max-regress"]);
const targets = new Map(
	values.targets
		.split(",")
		.filter(Boolean)
		.map((entry) => {
			const [name, gain] = entry.split(":");
			return [name, Number(gain)];
		}),
);
const guards = values.guards.split(",").filter((name) => name && !targets.has(name));
const metrics = [...targets.keys(), ...guards];
if (!values.harness || !values.base || !values.cand || metrics.length === 0) {
	console.error("missing --harness, --base, --cand, or metrics");
	process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "pi-bolt-compare-"));
const runner = join(values.harness, "bench/pi-bolt/run.mjs");

function sample(repo, metric, index) {
	const out = join(scratch, `${metric}-${index}-${repo === values.base ? "base" : "cand"}.json`);
	const result = spawnSync("node", [runner, "--repo", repo, "--metric", metric, "--runs", "1", "--out", out], {
		encoding: "utf8",
		timeout: 15 * 60 * 1000,
	});
	if (result.status !== 0) {
		throw new Error(`bench failed (${repo}, ${metric}): exit ${result.status}\n${(result.stderr ?? "").slice(-4000)}`);
	}
	const parsed = JSON.parse(readFileSync(out, "utf8"));
	const value = parsed?.metrics?.[metric]?.samples?.[0];
	if (parsed.schema !== "ice-bench/1" || typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`bad bench output for ${metric} from ${repo}`);
	}
	return value;
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const verdict = { runs, maxRegress, metrics: {}, passed: true, reasons: [] };
try {
	for (const metric of metrics) {
		const base = [];
		const cand = [];
		// Interleave and alternate order so drift in machine load hits both sides equally.
		for (let i = 0; i < runs; i++) {
			if (i % 2 === 0) {
				base.push(sample(values.base, metric, i));
				cand.push(sample(values.cand, metric, i));
			} else {
				cand.push(sample(values.cand, metric, i));
				base.push(sample(values.base, metric, i));
			}
		}
		const baseMedian = median(base);
		const candMedian = median(cand);
		const change = (candMedian - baseMedian) / baseMedian;
		const entry = { base, cand, baseMedian, candMedian, change };
		if (targets.has(metric)) {
			entry.role = "target";
			entry.required = -targets.get(metric);
			entry.passed = change <= -targets.get(metric);
			if (!entry.passed) {
				verdict.reasons.push(
					`${metric}: changed ${(change * 100).toFixed(1)}%, needs <= -${(targets.get(metric) * 100).toFixed(1)}%`,
				);
			}
		} else {
			entry.role = "guard";
			// A/A mode (same code on both sides) checks harness noise in both directions.
			entry.passed = values.aa ? Math.abs(change) <= maxRegress : change <= maxRegress;
			if (!entry.passed) {
				verdict.reasons.push(`${metric}: regressed ${(change * 100).toFixed(1)}% (limit ${(maxRegress * 100).toFixed(0)}%)`);
			}
		}
		verdict.metrics[metric] = entry;
		if (!entry.passed) verdict.passed = false;
	}
} catch (error) {
	verdict.passed = false;
	verdict.error = error instanceof Error ? error.message : String(error);
	if (values.out) writeFileSync(values.out, `${JSON.stringify(verdict, null, 2)}\n`);
	console.error(verdict.error);
	rmSync(scratch, { recursive: true, force: true });
	process.exit(2);
}

rmSync(scratch, { recursive: true, force: true });
if (values.out) writeFileSync(values.out, `${JSON.stringify(verdict, null, 2)}\n`);
for (const [metric, entry] of Object.entries(verdict.metrics)) {
	console.log(
		`${entry.passed ? "PASS" : "FAIL"} ${entry.role} ${metric}: base ${entry.baseMedian.toFixed(1)} cand ${entry.candMedian.toFixed(1)} (${(entry.change * 100).toFixed(1)}%)`,
	);
}
process.exit(verdict.passed ? 0 : 1);
