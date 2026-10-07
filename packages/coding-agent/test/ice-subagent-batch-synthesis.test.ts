import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	findExactDuplicateBatchTasks,
	renderBatchSynthesisSection,
	type SubagentBatchSynthesis,
	type SubagentBatchSynthesisItem,
	summarizeBatchSynthesis,
} from "../src/subagents/results/batch-synthesis.ts";
import type { ReviewFinding, SubagentBatchTask } from "../src/subagents/types.ts";

function batchTask(overrides: Partial<SubagentBatchTask> & { id: string }): SubagentBatchTask {
	return {
		role: "reviewer",
		task: "Review the auth module",
		scope: { roots: ["src"] },
		...overrides,
	};
}

function finding(severity: ReviewFinding["severity"], category: string, claim: string): ReviewFinding {
	return { severity, category, claim, evidence: [{ path: "src/a.ts" }] };
}

function item(taskId: string, result?: SubagentBatchSynthesisItem["result"]): SubagentBatchSynthesisItem {
	return { taskId, result };
}

describe("findExactDuplicateBatchTasks", () => {
	it("flags siblings whose effective contract is exactly identical", () => {
		const tasks = [
			batchTask({ id: "a", task: "Review the auth module", kind: "review", deliverable: "findings list" }),
			batchTask({ id: "b", task: "Review the auth module", kind: "review", deliverable: "findings list" }),
		];
		expect(findExactDuplicateBatchTasks(tasks)).toEqual([{ firstId: "a", duplicateId: "b" }]);
	});

	it("never flags overlapping scopes alone; different task text is not a duplicate", () => {
		const tasks = [
			batchTask({ id: "a", task: "Review security dimension", scope: { roots: ["src"], targets: ["src/a.ts"] } }),
			batchTask({ id: "b", task: "Review correctness dimension", scope: { roots: ["src"], targets: ["src/a.ts"] } }),
		];
		expect(findExactDuplicateBatchTasks(tasks)).toEqual([]);
	});

	it("detects duplicates after whitespace normalization of task text", () => {
		const tasks = [
			batchTask({ id: "a", task: "  Review   the auth\nmodule\ttoday " }),
			batchTask({ id: "b", task: "Review the auth module today" }),
		];
		expect(findExactDuplicateBatchTasks(tasks)).toEqual([{ firstId: "a", duplicateId: "b" }]);
	});

	it("keeps the first occurrence and reports every later duplicate", () => {
		const tasks = [
			batchTask({ id: "a", task: "Same objective" }),
			batchTask({ id: "b", task: "Same objective" }),
			batchTask({ id: "c", task: "Same objective" }),
		];
		expect(findExactDuplicateBatchTasks(tasks)).toEqual([
			{ firstId: "a", duplicateId: "b" },
			{ firstId: "a", duplicateId: "c" },
		]);
	});

	it("treats empty and missing scope lists as equivalent but distinct from non-empty roots", () => {
		const emptyPair = [
			batchTask({ id: "a", scope: { roots: [] } }),
			batchTask({ id: "b", scope: { roots: [], targets: [] } }),
		];
		expect(findExactDuplicateBatchTasks(emptyPair)).toEqual([{ firstId: "a", duplicateId: "b" }]);

		const differentRoots = [
			batchTask({ id: "a", scope: { roots: [] } }),
			batchTask({ id: "b", scope: { roots: ["src"] } }),
		];
		expect(findExactDuplicateBatchTasks(differentRoots)).toEqual([]);
	});

	it("treats different scope root order as the same contract but different roots as distinct", () => {
		const reordered = [
			batchTask({ id: "a", scope: { roots: ["src", "lib"], targets: ["a.ts", "b.ts"] } }),
			batchTask({ id: "b", scope: { roots: ["lib", "src"], targets: ["b.ts", "a.ts"] } }),
		];
		expect(findExactDuplicateBatchTasks(reordered)).toEqual([{ firstId: "a", duplicateId: "b" }]);

		const differentRoots = [
			batchTask({ id: "a", scope: { roots: ["src", "lib"] } }),
			batchTask({ id: "b", scope: { roots: ["src", "docs"] } }),
		];
		expect(findExactDuplicateBatchTasks(differentRoots)).toEqual([]);
	});

	it("does not flag siblings that differ only in declared kind or deliverable", () => {
		const kindDiff = [batchTask({ id: "a", kind: "review" }), batchTask({ id: "b" })];
		expect(findExactDuplicateBatchTasks(kindDiff)).toEqual([]);

		const deliverableDiff = [
			batchTask({ id: "a", deliverable: "findings list" }),
			batchTask({ id: "b", deliverable: "patch" }),
		];
		expect(findExactDuplicateBatchTasks(deliverableDiff)).toEqual([]);
	});

	it("returns no pairs for an empty batch", () => {
		expect(findExactDuplicateBatchTasks([])).toEqual([]);
	});
});

describe("summarizeBatchSynthesis", () => {
	it("computes counts and sorted coverage rows across statuses", () => {
		const synthesis = summarizeBatchSynthesis([
			item("d", { status: "running" }),
			item("b", {
				status: "failed",
				requirementStates: [
					{ id: "req-1", required: true, verified: true },
					{ id: "req-2", required: true, verified: false },
					{ id: "req-3", required: false, verified: true },
				],
				evidence: { paths: ["src/x.ts"] },
			}),
			item("a", { status: "completed" }),
			item("c"),
		]);
		expect(synthesis.counts).toEqual({ total: 4, completed: 1, failed: 1, other: 2 });
		expect(synthesis.coverage.map((row) => row.taskId)).toEqual(["a", "b", "c", "d"]);
		expect(synthesis.coverage[1]).toEqual({
			taskId: "b",
			status: "failed",
			verifiedCriteria: 2,
			unresolvedCriteria: 1,
			evidencePathCount: 1,
		});
		expect(synthesis.coverage[2]).toEqual({
			taskId: "c",
			status: "other",
			verifiedCriteria: 0,
			unresolvedCriteria: 0,
			evidencePathCount: 0,
		});
	});

	it("returns an empty frozen synthesis for an empty batch", () => {
		const synthesis = summarizeBatchSynthesis([]);
		expect(synthesis.counts).toEqual({ total: 0, completed: 0, failed: 0, other: 0 });
		expect(synthesis.coverage).toEqual([]);
		expect(synthesis.evidenceOverlap).toEqual([]);
		expect(synthesis.contradictions).toEqual([]);
		expect(Object.isFrozen(synthesis)).toBe(true);
		expect(Object.isFrozen(synthesis.counts)).toBe(true);
		expect(Object.isFrozen(synthesis.coverage)).toBe(true);
	});

	it("freezes the whole synthesis structure", () => {
		const synthesis = summarizeBatchSynthesis([
			item("a", { status: "completed", evidence: { paths: ["src/a.ts"] } }),
			item("b", { status: "completed", evidence: { paths: ["src/a.ts"] } }),
		]);
		expect(Object.isFrozen(synthesis.coverage[0])).toBe(true);
		expect(Object.isFrozen(synthesis.evidenceOverlap)).toBe(true);
		expect(Object.isFrozen(synthesis.evidenceOverlap[0])).toBe(true);
		expect(Object.isFrozen(synthesis.evidenceOverlap[0]!.sharedPaths)).toBe(true);
		expect(Object.isFrozen(synthesis.contradictions)).toBe(true);
	});

	it("reports pairwise evidence overlap with sorted shared paths and no empty pairs", () => {
		const synthesis = summarizeBatchSynthesis([
			item("a", { status: "completed", evidence: { paths: ["src/b.ts", "src/a.ts", "src/c.ts"] } }),
			item("b", { status: "completed", evidence: { paths: ["src/a.ts", "src/d.ts", "src/b.ts"] } }),
			item("c", { status: "completed", evidence: { paths: ["src/unique.ts"] } }),
		]);
		expect(synthesis.evidenceOverlap).toEqual([
			{ taskIdA: "a", taskIdB: "b", sharedPaths: ["src/a.ts", "src/b.ts"] },
		]);
	});

	it("caps shared paths at 16 per pair, sorted", () => {
		const allPaths = Array.from({ length: 20 }, (_, i) => `src/file${String(i).padStart(2, "0")}.ts`);
		const synthesis = summarizeBatchSynthesis([
			item("a", { status: "completed", evidence: { paths: allPaths } }),
			item("b", { status: "completed", evidence: { paths: [...allPaths].reverse() } }),
		]);
		expect(synthesis.evidenceOverlap).toHaveLength(1);
		expect(synthesis.evidenceOverlap[0]!.sharedPaths).toHaveLength(16);
		expect(synthesis.evidenceOverlap[0]!.sharedPaths).toEqual([...allPaths].sort().slice(0, 16));
	});

	it("detects a high-severity same-category opposite-polarity finding contradiction", () => {
		const synthesis = summarizeBatchSynthesis([
			item("review-b", {
				status: "completed",
				findings: [finding("high", "security", "Auth check is enforced for admin routes")],
			}),
			item("review-a", {
				status: "completed",
				findings: [finding("high", "Security", "Auth check is missing for admin routes")],
			}),
		]);
		expect(synthesis.contradictions).toHaveLength(1);
		const contradiction = synthesis.contradictions[0]!;
		expect(contradiction.kind).toBe("finding_claim");
		expect(contradiction.taskIdA).toBe("review-a");
		expect(contradiction.taskIdB).toBe("review-b");
		expect(contradiction.summaryA).toContain("missing");
		expect(contradiction.summaryB).toContain("enforced");
	});

	it("does not detect finding contradictions for same polarity, other categories, or low severities", () => {
		const samePolarity = summarizeBatchSynthesis([
			item("a", { findings: [finding("high", "security", "Auth check is enforced on the write path")] }),
			item("b", { findings: [finding("high", "security", "Auth check is enforced on the read path")] }),
		]);
		expect(samePolarity.contradictions).toEqual([]);

		const differentCategory = summarizeBatchSynthesis([
			item("a", { findings: [finding("high", "security", "Auth check is missing")] }),
			item("b", { findings: [finding("high", "correctness", "Auth check is enforced")] }),
		]);
		expect(differentCategory.contradictions).toEqual([]);

		const mediumOnly = summarizeBatchSynthesis([
			item("a", { findings: [finding("medium", "security", "Auth check is missing")] }),
			item("b", { findings: [finding("high", "security", "Auth check is enforced")] }),
		]);
		expect(mediumOnly.contradictions).toEqual([]);

		const mediumPair = summarizeBatchSynthesis([
			item("a", { findings: [finding("medium", "security", "Auth check is missing")] }),
			item("b", { findings: [finding("medium", "security", "Auth check is enforced")] }),
		]);
		expect(mediumPair.contradictions).toEqual([]);
	});

	it("detects a requirement-claim contradiction for the same criterion id", () => {
		const synthesis = summarizeBatchSynthesis([
			item("a", {
				status: "completed",
				requirementStates: [{ id: "req-1", required: true, verified: true }],
			}),
			item("b", {
				status: "completed",
				requirementStates: [{ id: "req-1", required: true, verified: false, claim: "failed" }],
			}),
		]);
		expect(synthesis.contradictions).toHaveLength(1);
		const contradiction = synthesis.contradictions[0]!;
		expect(contradiction.kind).toBe("requirement_claim");
		expect(contradiction.taskIdA).toBe("a");
		expect(contradiction.taskIdB).toBe("b");
		expect(contradiction.summaryA).toContain("criterion req-1: verified");
		expect(contradiction.summaryB).toContain("criterion req-1: unverified");
		expect(contradiction.summaryB).toContain("(claim: failed)");
	});

	it("does not flag requirement claims when both children agree", () => {
		const bothVerified = summarizeBatchSynthesis([
			item("a", { requirementStates: [{ id: "req-1", required: true, verified: true }] }),
			item("b", { requirementStates: [{ id: "req-1", required: true, verified: true }] }),
		]);
		expect(bothVerified.contradictions).toEqual([]);

		const bothUnverified = summarizeBatchSynthesis([
			item("a", { requirementStates: [{ id: "req-1", required: true, verified: false }] }),
			item("b", { requirementStates: [{ id: "req-1", required: true, verified: false }] }),
		]);
		expect(bothUnverified.contradictions).toEqual([]);

		const disjointIds = summarizeBatchSynthesis([
			item("a", { requirementStates: [{ id: "req-1", required: true, verified: true }] }),
			item("b", { requirementStates: [{ id: "req-2", required: true, verified: false }] }),
		]);
		expect(disjointIds.contradictions).toEqual([]);
	});

	it("caps contradictions at 32 with deterministic ordering", () => {
		const criteria = Array.from({ length: 40 }, (_, i) => `req-${String(i).padStart(2, "0")}`);
		const synthesis = summarizeBatchSynthesis([
			item("a", {
				status: "completed",
				requirementStates: criteria.map((id) => ({ id, required: true, verified: true })),
			}),
			item("b", {
				status: "completed",
				requirementStates: criteria.map((id) => ({ id, required: true, verified: false })),
			}),
		]);
		expect(synthesis.contradictions).toHaveLength(32);
		const criterionIds = synthesis.contradictions.map((entry) => {
			const match = /^criterion (req-\d+): verified$/.exec(entry.summaryA);
			expect(match).not.toBeNull();
			return match![1]!;
		});
		expect(criterionIds).toEqual(criteria.slice(0, 32));
		expect(synthesis.contradictions.every((entry) => entry.kind === "requirement_claim")).toBe(true);
	});

	it("orders contradictions deterministically across pairs and kinds", () => {
		const synthesis = summarizeBatchSynthesis([
			item("c", {
				status: "completed",
				findings: [finding("high", "tests", "Coverage is missing for edge cases")],
				requirementStates: [{ id: "req-1", required: true, verified: false }],
			}),
			item("a", {
				status: "completed",
				findings: [finding("high", "tests", "Coverage is complete for edge cases")],
				requirementStates: [{ id: "req-1", required: true, verified: true }],
			}),
			item("b", {
				status: "completed",
				requirementStates: [{ id: "req-1", required: true, verified: true }],
			}),
		]);
		expect(synthesis.contradictions.map((entry) => [entry.taskIdA, entry.taskIdB, entry.kind])).toEqual([
			["a", "c", "finding_claim"],
			["a", "c", "requirement_claim"],
			["b", "c", "requirement_claim"],
		]);
	});

	it("redacts credential-like text in emitted strings", () => {
		const synthesis = summarizeBatchSynthesis([
			item("a", { findings: [finding("high", "security", "token=supersecretvalue is missing from the response")] }),
			item("b", { findings: [finding("high", "security", "token=supersecretvalue is stored encrypted")] }),
		]);
		const summaries = JSON.stringify(synthesis.contradictions);
		expect(summaries).not.toContain("supersecretvalue");
		expect(summaries).toContain("token=[REDACTED]");
	});

	it("bounds claim summaries to 200 characters", () => {
		const longClaim = `Auth check is missing ${"detail ".repeat(60)}`;
		const synthesis = summarizeBatchSynthesis([
			item("a", { findings: [finding("high", "security", longClaim)] }),
			item("b", { findings: [finding("high", "security", "Auth check is enforced")] }),
		]);
		for (const entry of synthesis.contradictions) {
			expect(Array.from(entry.summaryA).length).toBeLessThanOrEqual(200);
			expect(Array.from(entry.summaryB).length).toBeLessThanOrEqual(200);
		}
	});
});

describe("renderBatchSynthesisSection", () => {
	it("renders counts, coverage rows, overlap, and the disagreement framing", () => {
		const synthesis = summarizeBatchSynthesis([
			item("review-a", {
				status: "completed",
				requirementStates: [
					{ id: "req-1", required: true, verified: true },
					{ id: "req-2", required: true, verified: false },
				],
				evidence: { paths: ["src/a.ts", "src/b.ts"] },
				findings: [finding("high", "security", "Input validation is missing")],
			}),
			item("review-b", {
				status: "failed",
				requirementStates: [{ id: "req-1", required: true, verified: true }],
				evidence: { paths: ["src/a.ts"] },
				findings: [finding("high", "security", "Input validation is enforced")],
			}),
		]);
		const rendered = renderBatchSynthesisSection(synthesis);
		expect(rendered).toContain("## Subagent batch synthesis");
		expect(rendered).toContain("children: 2 total, 1 completed, 1 failed, 0 other");
		expect(rendered).toContain("- review-a: completed; criteria 1/2 verified; evidence paths 2");
		expect(rendered).toContain("- review-b: failed; criteria 1/1 verified; evidence paths 1");
		expect(rendered).toContain("evidence overlap:");
		expect(rendered).toContain("- review-a <-> review-b: 1 shared paths (src/a.ts)");
		expect(rendered).toContain("disagreement is preserved for parent synthesis; never averaged away");
		expect(rendered).toContain("[finding_claim]");
		expect(rendered.endsWith("\n")).toBe(true);
	});

	it("renders none placeholders for an empty synthesis", () => {
		const rendered = renderBatchSynthesisSection(summarizeBatchSynthesis([]));
		expect(rendered).toContain("children: 0 total, 0 completed, 0 failed, 0 other");
		expect(rendered).toContain("coverage:\n- none");
		expect(rendered).toContain("evidence overlap:\n- none");
		expect(rendered).toContain("never averaged away):\n- none");
	});

	it("is byte-identical for identical inputs", () => {
		const buildItems = (): SubagentBatchSynthesisItem[] => [
			item("review-a", {
				status: "completed",
				evidence: { paths: ["src/b.ts", "src/a.ts"] },
				findings: [finding("high", "security", "Auth check is missing")],
			}),
			item("review-b", {
				status: "failed",
				evidence: { paths: ["src/a.ts", "src/c.ts"] },
				findings: [finding("high", "security", "Auth check is enforced")],
				requirementStates: [{ id: "req-1", required: true, verified: false }],
			}),
		];
		const first = renderBatchSynthesisSection(summarizeBatchSynthesis(buildItems()));
		const second = renderBatchSynthesisSection(summarizeBatchSynthesis(buildItems()));
		expect(first).toBe(second);
		expect(first.length).toBeGreaterThan(0);
	});

	it("honors the 4 KiB cap with UTF-8-safe truncation", () => {
		const unicodePadding = `caféñø ${"日本語テキスト ".repeat(40)}`;
		const negativeClaim = `Auth check is missing ${unicodePadding}`;
		const positiveClaim = `Auth check is enforced ${unicodePadding}`;
		const items: SubagentBatchSynthesisItem[] = [];
		for (let i = 0; i < 16; i++) {
			const claim = i % 2 === 0 ? negativeClaim : positiveClaim;
			items.push(
				item(`child-${String(i).padStart(2, "0")}`, {
					status: "completed",
					findings: [finding("high", "security", claim), finding("high", "correctness", claim)],
				}),
			);
		}
		const synthesis: SubagentBatchSynthesis = summarizeBatchSynthesis(items);
		expect(synthesis.contradictions).toHaveLength(32);
		const rendered = renderBatchSynthesisSection(synthesis);
		const bytes = Buffer.byteLength(rendered, "utf8");
		expect(bytes).toBeLessThanOrEqual(4 * 1024);
		expect(Buffer.from(rendered, "utf8").toString("utf8")).toBe(rendered);
		expect(rendered.endsWith("\n[truncated]")).toBe(true);
	});
});
