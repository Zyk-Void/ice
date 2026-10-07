import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	beginQualityBenchLiveBaseline,
	createQualityBenchmarkRun,
	hashQualityText,
	isVerifiedQualityRun,
	measureRequiredCriterionPassRate,
	measureSubagentQualityRun,
	type QualityBenchmarkAggregate,
	type QualityBenchmarkRun,
	type QualityCase,
	type QualityCaseManifestFile,
	renderQualityBenchmarkMarkdown,
	resolveQualityCaseManifest,
	SubagentQualityBenchError,
	type SubagentQualityBenchErrorCode,
	type SubagentQualityRunObservation,
	type SubagentQualityRunRecord,
	serializeQualityBenchmarkJson,
} from "../src/subagents/bench/quality-bench.ts";
import { executeLiveQualityBenchmark } from "../src/subagents/bench/quality-live-bench.ts";
import { qualityCaseManifest } from "./fixtures/quality/cases.ts";

/**
 * Deterministic scoring tests for the ICE subagent quality benchmark. Normal
 * test execution never contacts a provider or consumes tokens. The model-backed
 * baseline is opt-in behind ICE_QUALITY_BENCH_LIVE=1.
 *
 * Run from the repo root:
 *   /usr/bin/node node_modules/vitest/vitest.mjs --run packages/coding-agent/test/ice-subagent-quality-bench.test.ts
 * Live baseline (opt-in, requires configured provider credentials):
 *   ICE_QUALITY_BENCH_LIVE=1 ICE_QUALITY_BENCH_LIVE_MODEL=provider/model /usr/bin/node node_modules/vitest/vitest.mjs --run packages/coding-agent/test/ice-subagent-quality-bench.test.ts
 */

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "quality");
const manifest = resolveQualityCaseManifest(qualityCaseManifest, fixtureRoot);

function baseObservation(overrides: Partial<SubagentQualityRunObservation>): SubagentQualityRunObservation {
	return {
		caseId: "q-focused-retry-limit",
		gitCommit: "0f3e5a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f",
		worktreePath: "/tmp/ice-quality-bench-worktree",
		modelRoute: "bench/fixture-model",
		thinkingLevel: "high",
		childProfile: "explore",
		toolAllowlist: ["read", "grep", "glob"],
		wallMs: 1200,
		assistantRequestCount: 2,
		inputTokens: 1500,
		outputTokens: 220,
		toolCallCount: 4,
		parentFollowUpCount: 0,
		verificationKind: "plain_bounds",
		reportedEvidencePaths: [],
		observedToolCalls: [],
		finalSuccess: true,
		...overrides,
	};
}

function makeCase(overrides: Partial<QualityCase> & { id: string }): QualityCase {
	return {
		class: "focused_lookup",
		objective: "Synthetic objective.",
		expectedOutcome: {
			checks: ["synthetic check"],
			requiredCriterionIds: [],
			requiredEvidencePaths: [],
			solvable: true,
		},
		groundTruthPaths: ["README.md"],
		...overrides,
	};
}

function expectBenchError(fn: () => unknown, code: SubagentQualityBenchErrorCode): void {
	try {
		fn();
	} catch (error) {
		if (error instanceof SubagentQualityBenchError) {
			expect(error.code).toBe(code);
			return;
		}
		throw error;
	}
	throw new Error(`Expected SubagentQualityBenchError with code ${code}, but the call succeeded.`);
}

function focusedLookupRecord(overrides: Partial<SubagentQualityRunObservation> = {}) {
	return measureSubagentQualityRun(
		manifest,
		baseObservation({
			reportedEvidencePaths: ["src/config.ts"],
			observedToolCalls: [{ tool: "read", path: "src/config.ts" }],
			requiredCriterionPassRate: 1,
			...overrides,
		}),
	);
}

describe("quality case manifest resolution", () => {
	it("resolves the fixture manifest from disk with one case per class", () => {
		expect(manifest.cases).toHaveLength(10);
		expect(manifest.repoRoot).toBe(resolve(fixtureRoot, "repo"));
		expect(new Set(manifest.cases.map((qualityCase) => qualityCase.class)).size).toBe(10);
		const focused = manifest.caseById.get("q-focused-retry-limit");
		expect(focused?.groundTruthPaths).toContain("src/config.ts");
		expect(focused?.expectedOutcome.solvable).toBe(true);
	});

	it("rejects duplicate case ids", () => {
		const bad: QualityCaseManifestFile = {
			schemaVersion: 1,
			repoRoot: "repo",
			cases: [makeCase({ id: "q-dup" }), makeCase({ id: "q-dup" })],
		};
		expectBenchError(() => resolveQualityCaseManifest(bad, fixtureRoot), "invalid_manifest");
	});

	it("rejects unknown case classes", () => {
		const bad: QualityCaseManifestFile = {
			schemaVersion: 1,
			repoRoot: "repo",
			cases: [makeCase({ id: "q-class", class: "not_a_class" as QualityCase["class"] })],
		};
		expectBenchError(() => resolveQualityCaseManifest(bad, fixtureRoot), "invalid_manifest");
	});

	it("rejects ground truth paths that escape the fixture repo", () => {
		const bad: QualityCaseManifestFile = {
			schemaVersion: 1,
			repoRoot: "repo",
			cases: [makeCase({ id: "q-escape", groundTruthPaths: ["../../package.json"] })],
		};
		expectBenchError(() => resolveQualityCaseManifest(bad, fixtureRoot), "invalid_manifest");
	});

	it("rejects ground truth paths that do not exist on disk", () => {
		const bad: QualityCaseManifestFile = {
			schemaVersion: 1,
			repoRoot: "repo",
			cases: [makeCase({ id: "q-missing", groundTruthPaths: ["src/does-not-exist.ts"] })],
		};
		expectBenchError(() => resolveQualityCaseManifest(bad, fixtureRoot), "invalid_manifest");
	});

	it("rejects required criteria that the case does not declare", () => {
		const bad: QualityCaseManifestFile = {
			schemaVersion: 1,
			repoRoot: "repo",
			cases: [
				makeCase({
					id: "q-criterion",
					expectedOutcome: {
						checks: ["check"],
						requiredCriterionIds: ["undeclared"],
						requiredEvidencePaths: [],
						solvable: true,
					},
				}),
			],
		};
		expectBenchError(() => resolveQualityCaseManifest(bad, fixtureRoot), "invalid_manifest");
	});

	it("rejects required evidence paths outside the case ground truth", () => {
		const bad: QualityCaseManifestFile = {
			schemaVersion: 1,
			repoRoot: "repo",
			cases: [
				makeCase({
					id: "q-required-evidence",
					expectedOutcome: {
						checks: ["check"],
						requiredCriterionIds: [],
						requiredEvidencePaths: ["src/config.ts"],
						solvable: true,
					},
				}),
			],
		};
		expectBenchError(() => resolveQualityCaseManifest(bad, fixtureRoot), "invalid_manifest");
	});

	it("rejects repo roots that escape the fixture root", () => {
		const bad: QualityCaseManifestFile = { schemaVersion: 1, repoRoot: "../..", cases: [makeCase({ id: "q-root" })] };
		expectBenchError(() => resolveQualityCaseManifest(bad, fixtureRoot), "invalid_manifest");
	});
});

describe("evidence measurement", () => {
	it("scores full precision when the reported path exists and was observed", () => {
		const record = focusedLookupRecord();
		expect(record.evidencePrecision).toBe(1);
		expect(record.fabricatedEvidenceCount).toBe(0);
		expect(record.fabricatedEvidencePaths).toEqual([]);
	});

	it("requires the evidence path to appear among observed tool calls", () => {
		const record = focusedLookupRecord({ observedToolCalls: [{ tool: "read", path: "README.md" }] });
		expect(record.evidencePrecision).toBe(0);
		expect(record.fabricatedEvidenceCount).toBe(0);
	});

	it("counts nonexistent reported paths as fabricated", () => {
		const record = focusedLookupRecord({
			reportedEvidencePaths: ["src/config.ts", "src/ghost.ts"],
		});
		expect(record.evidencePrecision).toBe(0.5);
		expect(record.fabricatedEvidenceCount).toBe(1);
		expect(record.fabricatedEvidencePaths).toEqual(["src/ghost.ts"]);
	});

	it("treats repo-escaping evidence as fabricated without touching the filesystem", () => {
		const record = focusedLookupRecord({ reportedEvidencePaths: ["../../package.json"] });
		expect(record.evidencePrecision).toBe(0);
		expect(record.fabricatedEvidenceCount).toBe(1);
		expect(record.fabricatedEvidencePaths).toEqual(["../../package.json"]);
	});

	it("scores zero precision when no evidence is reported", () => {
		const record = focusedLookupRecord({ reportedEvidencePaths: [], observedToolCalls: [] });
		expect(record.evidencePrecision).toBe(0);
		expect(record.fabricatedEvidenceCount).toBe(0);
	});

	it("normalizes absolute in-repo evidence paths and relative observed paths", () => {
		const record = focusedLookupRecord({
			reportedEvidencePaths: [join(manifest.repoRoot, "src/config.ts")],
			observedToolCalls: [{ tool: "read", path: "./src/config.ts" }],
		});
		expect(record.evidencePrecision).toBe(1);
	});

	it("deduplicates repeated evidence paths", () => {
		const record = focusedLookupRecord({ reportedEvidencePaths: ["src/config.ts", "./src/config.ts"] });
		expect(record.evidencePrecision).toBe(1);
	});

	it("rejects observations for unknown cases", () => {
		expectBenchError(
			() => measureSubagentQualityRun(manifest, baseObservation({ caseId: "q-unknown" })),
			"case_not_found",
		);
	});

	it("rejects malformed observations", () => {
		expectBenchError(() => measureSubagentQualityRun(manifest, baseObservation({ wallMs: -1 })), "invalid_record");
		expectBenchError(
			() => measureSubagentQualityRun(manifest, baseObservation({ verificationKind: "magic" as never })),
			"invalid_record",
		);
		expectBenchError(
			() => measureSubagentQualityRun(manifest, baseObservation({ requiredCriterionPassRate: 1.5 })),
			"invalid_record",
		);
	});
});

describe("required criterion pass rate", () => {
	it("computes the fraction of satisfied required criteria", () => {
		const focused = manifest.caseById.get("q-focused-retry-limit");
		expect(focused).toBeDefined();
		const rate = measureRequiredCriterionPassRate(focused!, [
			{ criterionId: "retry-limit-value", satisfied: true },
			{ criterionId: "retry-limit-file", satisfied: false },
		]);
		expect(rate).toBe(0.5);
	});

	it("ignores claims for non-required criteria", () => {
		const investigation = manifest.caseById.get("q-invest-fee-inflation");
		expect(investigation).toBeDefined();
		const rate = measureRequiredCriterionPassRate(investigation!, [
			{ criterionId: "affected-caller", satisfied: true },
			{ criterionId: "not-required", satisfied: true },
		]);
		expect(rate).toBe(0.5);
	});

	it("treats a case with no required criteria as satisfied", () => {
		const synthetic = makeCase({ id: "q-no-requirements" });
		expect(measureRequiredCriterionPassRate(synthetic, [])).toBe(1);
	});
});

describe("aggregation and regression comparison", () => {
	const verifiedFocused = focusedLookupRecord();
	const failedReview = measureSubagentQualityRun(
		manifest,
		baseObservation({
			caseId: "q-review-pricing",
			finalSuccess: false,
			reportedEvidencePaths: ["src/pricing.ts"],
			observedToolCalls: [{ tool: "read", path: "src/pricing.ts" }],
		}),
	);

	it("computes weighted verified success and per-class breakdowns", () => {
		const run = createQualityBenchmarkRun({
			fixture: manifest,
			records: [verifiedFocused, failedReview],
			weights: { byClass: { focused_lookup: 3, review_precision: 1 } },
		});
		expect(run.aggregate.runs).toBe(2);
		expect(run.aggregate.verifiedSuccesses).toBe(1);
		expect(run.aggregate.weightedVerifiedSuccess).toBe(0.75);
		const focused = run.aggregate.byClass.find((breakdown) => breakdown.class === "focused_lookup");
		expect(focused?.verifiedSuccessRate).toBe(1);
		const review = run.aggregate.byClass.find((breakdown) => breakdown.class === "review_precision");
		expect(review?.verifiedSuccessRate).toBe(0);
	});

	it("verifies only runs with a contract, full criteria, and sufficient precision", () => {
		expect(isVerifiedQualityRun(verifiedFocused, 1)).toBe(true);
		expect(isVerifiedQualityRun(focusedLookupRecord({ verificationKind: "none" }), 1)).toBe(false);
		expect(isVerifiedQualityRun(focusedLookupRecord({ requiredCriterionPassRate: 0.5 }), 1)).toBe(false);
		const halfPrecision = { ...focusedLookupRecord(), evidencePrecision: 0.5 };
		expect(isVerifiedQualityRun(halfPrecision, 1)).toBe(false);
		expect(isVerifiedQualityRun(halfPrecision, 0.5)).toBe(true);
	});

	it("flags material regressions beyond the configured threshold", () => {
		const baseline = createQualityBenchmarkRun({ fixture: manifest, records: [verifiedFocused, verifiedFocused] });
		const degraded = focusedLookupRecord({
			reportedEvidencePaths: ["src/config.ts", "src/ghost.ts"],
			finalSuccess: true,
		});
		const current = createQualityBenchmarkRun({
			fixture: manifest,
			records: [degraded, degraded],
			comparison: { baseline: baseline.aggregate, threshold: 0.05 },
		});
		const success = current.comparison?.comparisons.find(
			(comparison) => comparison.category === "aggregate:weighted_verified_success",
		);
		expect(success?.baseline).toBe(1);
		expect(success?.current).toBe(0);
		expect(success?.regression).toBe(true);
		const fabricated = current.comparison?.comparisons.find(
			(comparison) => comparison.category === "aggregate:fabricated_evidence_count",
		);
		expect(fabricated?.delta).toBe(2);
		expect(fabricated?.regression).toBe(true);
		expect(current.comparison?.materialRegressions.map((comparison) => comparison.category)).toContain(
			"class:focused_lookup:verified_success_rate",
		);
	});

	it("does not flag sub-threshold deltas or improvements", () => {
		const nearBaseline: QualityBenchmarkAggregate = {
			runs: 100,
			verifiedSuccesses: 53,
			weightedVerifiedSuccess: 0.53,
			meanEvidencePrecision: 1,
			fabricatedEvidenceCount: 0,
			byClass: [],
		};
		const run = createQualityBenchmarkRun({
			fixture: manifest,
			records: [verifiedFocused, failedReview],
			comparison: { baseline: nearBaseline, threshold: 0.05 },
		});
		const success = run.comparison?.comparisons.find(
			(comparison) => comparison.category === "aggregate:weighted_verified_success",
		);
		expect(success?.delta).toBeCloseTo(-0.03);
		expect(success?.regression).toBe(false);
		const improving: QualityBenchmarkAggregate = {
			runs: 100,
			verifiedSuccesses: 99,
			weightedVerifiedSuccess: 0.99,
			meanEvidencePrecision: 0.99,
			fabricatedEvidenceCount: 2,
			byClass: [],
		};
		const better = createQualityBenchmarkRun({
			fixture: manifest,
			records: [verifiedFocused],
			comparison: { baseline: improving, threshold: 0.05 },
		});
		const fabricated = better.comparison?.comparisons.find(
			(comparison) => comparison.category === "aggregate:fabricated_evidence_count",
		);
		expect(fabricated?.delta).toBe(-2);
		expect(fabricated?.regression).toBe(false);
	});

	it("rejects empty record lists and out-of-range thresholds", () => {
		expectBenchError(() => createQualityBenchmarkRun({ fixture: manifest, records: [] }), "empty_corpus");
		const baseline: QualityBenchmarkAggregate = {
			runs: 1,
			verifiedSuccesses: 1,
			weightedVerifiedSuccess: 1,
			meanEvidencePrecision: 1,
			fabricatedEvidenceCount: 0,
			byClass: [],
		};
		expectBenchError(
			() =>
				createQualityBenchmarkRun({
					fixture: manifest,
					records: [verifiedFocused],
					comparison: { baseline, threshold: -1 },
				}),
			"invalid_record",
		);
	});
});

describe("deterministic rendering", () => {
	const records = [
		focusedLookupRecord(),
		focusedLookupRecord({ reportedEvidencePaths: ["src/config.ts", "src/ghost.ts"] }),
	];
	const header = {
		title: "ICE subagent quality benchmark",
		generatedAt: "2026-09-26T00:00:00.000Z",
		baselineLabel: "phase0-baseline",
		currentLabel: "phase0-current",
	};

	it("renders byte-identical markdown and JSON for identical inputs", () => {
		const first = createQualityBenchmarkRun({ fixture: manifest, records, header });
		const second = createQualityBenchmarkRun({ fixture: manifest, records, header });
		expect(renderQualityBenchmarkMarkdown(first)).toBe(renderQualityBenchmarkMarkdown(second));
		expect(serializeQualityBenchmarkJson(first)).toBe(serializeQualityBenchmarkJson(second));
	});

	it("renders byte-identical output with a comparison section", () => {
		const baseline = createQualityBenchmarkRun({ fixture: manifest, records: [records[0]!] });
		const options = {
			fixture: manifest,
			records,
			header,
			comparison: { baseline: baseline.aggregate, threshold: 0.05 },
		};
		const first = createQualityBenchmarkRun(options);
		const second = createQualityBenchmarkRun(options);
		expect(renderQualityBenchmarkMarkdown(first)).toBe(renderQualityBenchmarkMarkdown(second));
		expect(renderQualityBenchmarkMarkdown(first)).toContain("## Regression comparison");
	});

	it("omits timestamps unless the header provides one", () => {
		const run = createQualityBenchmarkRun({ fixture: manifest, records: [records[0]!] });
		expect(renderQualityBenchmarkMarkdown(run)).not.toContain("generatedAt");
		expect(serializeQualityBenchmarkJson(run)).not.toContain("generatedAt");
		const stamped = createQualityBenchmarkRun({ fixture: manifest, records: [records[0]!], header });
		expect(renderQualityBenchmarkMarkdown(stamped)).toContain("generatedAt: 2026-09-26T00:00:00.000Z");
	});

	it("includes per-run provenance tables and the aggregate table", () => {
		const markdown = renderQualityBenchmarkMarkdown(
			createQualityBenchmarkRun({ fixture: manifest, records, header }),
		);
		expect(markdown).toContain("## Run provenance");
		expect(markdown).toContain("### run 1: q-focused-retry-limit (focused_lookup) - verified: yes");
		expect(markdown).toContain("| gitCommit |");
		expect(markdown).toContain("| modelRoute | bench/fixture-model |");
		expect(markdown).toContain("| verificationKind | plain_bounds |");
		expect(markdown).toContain("## Aggregate by class");
		expect(markdown).toContain("| focused_lookup |");
	});
});

describe("dry fixture run", () => {
	it("scores a scripted focused_lookup run end-to-end against the fixture tree from disk", () => {
		// The scoring path must exercise the real fixture tree, not string constants.
		const configPath = join(manifest.repoRoot, "src", "config.ts");
		expect(existsSync(configPath)).toBe(true);
		expect(readFileSync(configPath, "utf8")).toContain("export const RETRY_LIMIT = 3;");

		const focused = manifest.caseById.get("q-focused-retry-limit");
		expect(focused).toBeDefined();
		const passRate = measureRequiredCriterionPassRate(focused!, [
			{ criterionId: "retry-limit-value", satisfied: true },
			{ criterionId: "retry-limit-file", satisfied: true },
		]);
		expect(passRate).toBe(1);

		const record = focusedLookupRecord({ requiredCriterionPassRate: passRate, wallMs: 987 });
		expect(record.evidencePrecision).toBe(1);
		expect(record.fabricatedEvidenceCount).toBe(0);
		expect(isVerifiedQualityRun(record, 1)).toBe(true);

		const run = createQualityBenchmarkRun({
			fixture: manifest,
			records: [record],
			header: {
				title: "ICE subagent quality benchmark",
				generatedAt: "2026-09-26T00:00:00.000Z",
				baselineLabel: "phase0-dry",
				currentLabel: "phase0-dry",
			},
			weights: { byClass: { focused_lookup: 2 } },
		});
		expect(run.aggregate.runs).toBe(1);
		expect(run.aggregate.verifiedSuccesses).toBe(1);
		expect(run.aggregate.weightedVerifiedSuccess).toBe(1);
		expect(run.aggregate.meanEvidencePrecision).toBe(1);
		expect(run.aggregate.byClass[0]).toMatchObject({
			class: "focused_lookup",
			runs: 1,
			verifiedSuccesses: 1,
			fabricatedEvidenceCount: 0,
			meanWallMs: 987,
		});

		const markdown = renderQualityBenchmarkMarkdown(run);
		expect(markdown).toContain("weighted verified-task success: 1.000");
		expect(markdown).toContain("### run 1: q-focused-retry-limit (focused_lookup) - verified: yes");

		const parsed = JSON.parse(serializeQualityBenchmarkJson(run)) as QualityBenchmarkRun;
		expect(parsed.schemaVersion).toBe(1);
		expect(parsed.aggregate.weightedVerifiedSuccess).toBe(1);
		expect(parsed.runs[0]?.record.evidencePrecision).toBe(1);
		// The JSON round-trip renders identically: no in-memory-only state.
		expect(renderQualityBenchmarkMarkdown(parsed)).toBe(markdown);
	});
});

describe("redaction and hashing", () => {
	it("redacts credential-looking notes from rendered artifacts", () => {
		const record = focusedLookupRecord({ notes: "token=supersecret-value" });
		const run = createQualityBenchmarkRun({ fixture: manifest, records: [record] });
		const markdown = renderQualityBenchmarkMarkdown(run);
		const json = serializeQualityBenchmarkJson(run);
		expect(markdown).not.toContain("supersecret-value");
		expect(json).not.toContain("supersecret-value");
		expect(markdown).toContain("token=[REDACTED]");
	});

	it("hashes text deterministically with sha256", () => {
		expect(hashQualityText("task-contract")).toBe(hashQualityText("task-contract"));
		expect(hashQualityText("task-contract")).toMatch(/^[a-f0-9]{64}$/);
		expect(hashQualityText("a")).not.toBe(hashQualityText("b"));
	});
});

describe("live baseline gate", () => {
	it("fails closed when no model route is configured", () => {
		expectBenchError(() => beginQualityBenchLiveBaseline({}), "credentials_required");
	});

	it("admits a syntactically valid route without making a provider call", () => {
		expect(beginQualityBenchLiveBaseline({ modelRoute: "bench/fixture-model" })).toEqual({
			modelRoute: "bench/fixture-model",
		});
	});
});

const liveEnabled = process.env.ICE_QUALITY_BENCH_LIVE === "1";

describe.skipIf(!liveEnabled)("ICE quality bench live baseline (opt-in)", () => {
	it("runs one real production-path sample when explicitly enabled", async () => {
		const run = await executeLiveQualityBenchmark({
			modelRoute: process.env.ICE_QUALITY_BENCH_LIVE_MODEL,
			fixture: manifest,
			gitCommit: process.env.ICE_QUALITY_BENCH_LIVE_COMMIT ?? "live-test",
			worktreePath: fixtureRoot,
			repeats: 1,
			modes: ["contract"],
			caseIds: [manifest.cases[0]!.id],
		});
		expect(run.runs).toHaveLength(1);
		expect(run.runs[0]?.record.modelRoute).toBeTruthy();
		expect(run.runs[0]?.record.notes).toMatch(/live mode=contract/);
	}, 120_000);
});

/**
 * Phase 0 acceptance: produce the standardized, human-readable baseline
 * artifact. Scores are deterministic scripted outcomes driven by real fixture
 * ground truth (evidence precision is measured against files on disk); they
 * are NOT model-quality measurements. The live-model baseline remains gated
 * behind ICE_QUALITY_BENCH_LIVE=1 with usable credentials.
 */
describe("phase 0 baseline artifact", () => {
	it("writes the deterministic dry-run baseline report to .artifacts/subagent-quality-bench", () => {
		const artifactDir = resolve(
			join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".artifacts", "subagent-quality-bench"),
		);
		mkdirSync(artifactDir, { recursive: true });
		const baseObservation = {
			gitCommit: "dry-run",
			worktreePath: "dry-run",
			modelRoute: "faux/dry-run",
			thinkingLevel: "medium",
			childProfile: "self",
			toolAllowlist: ["read", "grep", "find", "ls"],
			wallMs: 0,
			assistantRequestCount: 0,
			toolCallCount: 0,
			parentFollowUpCount: 0,
			verificationKind: "none" as const,
			finalSuccess: false,
			notes: "dry-run scripted outcome; not model-quality evidence",
		};
		const modeSpecs = [
			{ mode: "plain", childProfiles: ["self", "file"] },
			{ mode: "structured", childProfiles: ["self", "file"] },
			{ mode: "structured+contract", childProfiles: ["self", "file", "batch", "review"] },
		] as const;
		const records: SubagentQualityRunRecord[] = [];
		for (const qualityCase of manifest.cases) {
			for (const spec of modeSpecs) {
				for (const childProfile of spec.childProfiles) {
					const observed = qualityCase.groundTruthPaths.map((path) => ({
						tool: "read",
						path,
					}));
					const scriptedSuccess = spec.mode !== "plain";
					const record = measureSubagentQualityRun(manifest, {
						...baseObservation,
						caseId: qualityCase.id,
						childProfile,
						verificationKind: spec.mode === "plain" ? ("plain_bounds" as const) : ("structured" as const),
						observedToolCalls: observed,
						reportedEvidencePaths: qualityCase.groundTruthPaths.slice(0, 3),
						requiredCriterionPassRate:
							spec.mode === "structured+contract" && qualityCase.acceptanceCriteria?.length ? 1 : undefined,
						assistantRequestCount: spec.mode === "plain" ? 4 : 6,
						wallMs: spec.mode === "plain" ? 4_000 : 6_000,
						toolCallCount: 3,
						finalSuccess: scriptedSuccess,
						reviewerDefectCount: spec.mode === "structured+contract" && childProfile === "review" ? 1 : undefined,
					});
					records.push(record);
				}
			}
		}
		const run = createQualityBenchmarkRun({
			fixture: manifest,
			records,
			header: {
				title: "ICE subagent quality baseline (dry run)",
				baselineLabel: "dry-run-scripted",
				currentLabel: "dry-run-scripted",
			},
		});
		const markdown = renderQualityBenchmarkMarkdown(run);
		const json = serializeQualityBenchmarkJson(run);
		expect(markdown).toContain("ICE subagent quality baseline (dry run)");
		expect(json).toContain('"schemaVersion": 1');
		writeFileSync(join(artifactDir, "baseline-dry.md"), markdown, "utf8");
		writeFileSync(join(artifactDir, "baseline-dry.json"), json, "utf8");
		expect(existsSync(join(artifactDir, "baseline-dry.md"))).toBe(true);
		expect(existsSync(join(artifactDir, "baseline-dry.json"))).toBe(true);
	});
});
