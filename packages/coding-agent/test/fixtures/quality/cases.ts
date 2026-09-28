import type { QualityCase, QualityCaseManifestFile } from "../../../src/ice-subagent-quality-bench.ts";

/**
 * Fixture corpus for the ICE subagent quality benchmark: one case per quality
 * class, each with deterministic ground truth inside ./repo. Paths are
 * relative to the repo root declared below. The corpus is non-secret.
 */

const focusedLookup: QualityCase = {
	id: "q-focused-retry-limit",
	class: "focused_lookup",
	objective:
		"State the configured assistant sync retry limit of the kiosk-ledger fixture and name the file that defines it.",
	acceptanceCriteria: [
		{ id: "retry-limit-value", requirement: "The answer states the retry limit is 3." },
		{ id: "retry-limit-file", requirement: "The answer names src/config.ts as the defining file." },
	],
	expectedOutcome: {
		checks: ["The run cites src/config.ts as observed evidence.", "The run satisfies both required criteria."],
		requiredCriterionIds: ["retry-limit-value", "retry-limit-file"],
		requiredEvidencePaths: ["src/config.ts"],
		requiredAnswerFragments: ["3", "src/config.ts"],
		solvable: true,
	},
	groundTruthPaths: ["src/config.ts", "README.md"],
};

const crossFileReasoning: QualityCase = {
	id: "q-chain-audit-write",
	class: "cross_file_reasoning",
	objective: "Trace how a recorded sale reaches the audit ring and name every module on that path.",
	acceptanceCriteria: [
		{
			id: "chain-complete",
			requirement: "The answer lists ledger.ts, ring.ts, and index.ts in the audit write path.",
		},
	],
	expectedOutcome: {
		checks: ["The run cites src/ledger.ts and src/ring.ts as observed evidence."],
		requiredCriterionIds: ["chain-complete"],
		requiredEvidencePaths: ["src/ledger.ts", "src/ring.ts"],
		requiredAnswerFragments: ["src/index.ts", "src/ledger.ts", "src/ring.ts"],
		solvable: true,
	},
	groundTruthPaths: ["src/ledger.ts", "src/ring.ts", "src/index.ts", "docs/architecture.md"],
};

const bugLocalization: QualityCase = {
	id: "q-bug-ring-off-by-one",
	class: "bug_localization",
	objective: "Find the loop defect in the audit ring snapshot and report the file and function where it lives.",
	acceptanceCriteria: [
		{ id: "bug-file", requirement: "The answer names src/ring.ts as the defective file." },
		{
			id: "bug-symbol",
			requirement: "The answer names AuditRing.snapshot and its one-iteration-too-many loop.",
		},
	],
	expectedOutcome: {
		checks: ["The run cites src/ring.ts as observed evidence."],
		requiredCriterionIds: ["bug-file", "bug-symbol"],
		requiredEvidencePaths: ["src/ring.ts"],
		requiredAnswerFragments: ["src/ring.ts", "audit", "snapshot"],
		solvable: true,
	},
	groundTruthPaths: ["src/ring.ts", "docs/changelog.md"],
};

const reviewPrecision: QualityCase = {
	id: "q-review-pricing",
	class: "review_precision",
	objective: "Review src/pricing.ts and report the single real defect; do not invent defects in clean code.",
	acceptanceCriteria: [
		{ id: "defect-found", requirement: "The answer identifies the cents/dollars unit mismatch in withLateFee." },
		{ id: "no-false-positives", requirement: "The answer reports no defect in roundToCents." },
	],
	expectedOutcome: {
		checks: ["The run cites src/pricing.ts as observed evidence.", "The reviewer defect count is 1."],
		requiredCriterionIds: ["defect-found"],
		requiredEvidencePaths: ["src/pricing.ts"],
		requiredAnswerFragments: ["withlatefee", "cents", "dollars"],
		solvable: true,
	},
	groundTruthPaths: ["src/pricing.ts"],
};

const implementVerify: QualityCase = {
	id: "q-implement-median",
	class: "implement_verify",
	objective: "Add a median(values) export to src/sum.ts without changing existing exports, then verify it.",
	acceptanceCriteria: [
		{ id: "median-exported", requirement: "median is exported from src/sum.ts." },
		{ id: "median-even", requirement: "median averages the two middle values for even-length input." },
	],
	expectedOutcome: {
		checks: ["The run cites src/sum.ts as observed evidence.", "The run reports a verification result."],
		requiredCriterionIds: ["median-exported", "median-even"],
		requiredEvidencePaths: ["src/sum.ts"],
		requiredAnswerFragments: ["median", "src/sum.ts"],
		solvable: true,
	},
	groundTruthPaths: ["src/sum.ts", "README.md"],
};

const partialContextRecovery: QualityCase = {
	id: "q-partial-fee-origin",
	class: "partial_context_recovery",
	objective:
		"Given only the fragment 'const fee = balanceCents * 100 * LATE_FEE_RATE', locate the enclosing file and the module that defines the constant.",
	acceptanceCriteria: [
		{ id: "fee-file", requirement: "The answer names src/pricing.ts as the enclosing file." },
		{ id: "fee-config", requirement: "The answer names src/config.ts as the constant source." },
	],
	expectedOutcome: {
		checks: ["The run cites src/pricing.ts and src/config.ts as observed evidence."],
		requiredCriterionIds: ["fee-file", "fee-config"],
		requiredEvidencePaths: ["src/pricing.ts", "src/config.ts"],
		requiredAnswerFragments: ["src/pricing.ts", "src/config.ts"],
		solvable: true,
	},
	groundTruthPaths: ["src/pricing.ts", "src/config.ts"],
};

const longInvestigation: QualityCase = {
	id: "q-invest-fee-inflation",
	class: "long_investigation",
	objective:
		"Determine why charged late fees are hundreds of times larger than expected and report the root cause plus every file involved.",
	acceptanceCriteria: [
		{ id: "root-cause", requirement: "The answer attributes the inflation to withLateFee in src/pricing.ts." },
		{ id: "affected-caller", requirement: "The answer names src/ledger.ts as the affected caller." },
	],
	expectedOutcome: {
		checks: ["The run cites src/pricing.ts and src/ledger.ts as observed evidence."],
		requiredCriterionIds: ["root-cause", "affected-caller"],
		requiredEvidencePaths: ["src/pricing.ts", "src/ledger.ts"],
		requiredAnswerFragments: ["src/pricing.ts", "src/ledger.ts", "withlatefee"],
		solvable: true,
	},
	groundTruthPaths: ["src/pricing.ts", "src/ledger.ts", "src/config.ts", "src/index.ts"],
};

const batchCoverage: QualityCase = {
	id: "q-batch-exports",
	class: "batch_coverage",
	objective: "Enumerate every module re-exported by src/index.ts of the kiosk-ledger fixture.",
	acceptanceCriteria: [
		{
			id: "all-modules",
			requirement: "The answer lists config.ts, ledger.ts, pricing.ts, ring.ts, and sum.ts.",
		},
	],
	expectedOutcome: {
		checks: ["The run cites src/index.ts as observed evidence."],
		requiredCriterionIds: ["all-modules"],
		requiredEvidencePaths: ["src/index.ts"],
		requiredAnswerFragments: ["config.ts", "ledger.ts", "pricing.ts", "ring.ts", "sum.ts"],
		solvable: true,
	},
	groundTruthPaths: ["src/index.ts", "src/config.ts", "src/ledger.ts", "src/pricing.ts", "src/ring.ts", "src/sum.ts"],
};

const conflictingEvidence: QualityCase = {
	id: "q-conflict-ring-fix-claim",
	class: "conflicting_evidence",
	objective:
		"docs/changelog.md claims the audit ring off-by-one was fixed in 0.3.0. Verify the claim against the source and report which one is correct.",
	acceptanceCriteria: [
		{ id: "claim-rejected", requirement: "The answer states the changelog claim is false." },
		{ id: "evidence-source", requirement: "The answer cites the AuditRing.snapshot loop in src/ring.ts as proof." },
	],
	expectedOutcome: {
		checks: ["The run cites src/ring.ts and docs/changelog.md as observed evidence."],
		requiredCriterionIds: ["claim-rejected", "evidence-source"],
		requiredEvidencePaths: ["src/ring.ts", "docs/changelog.md"],
		requiredAnswerFragments: ["false", "src/ring.ts"],
		solvable: true,
	},
	groundTruthPaths: ["src/ring.ts", "docs/changelog.md"],
};

const insufficientEvidence: QualityCase = {
	id: "q-missing-http-client",
	class: "insufficient_evidence",
	objective: "Identify which module in the kiosk-ledger fixture implements the HTTP client.",
	acceptanceCriteria: [
		{ id: "absence-stated", requirement: "The answer states that no HTTP client exists in the fixture." },
	],
	expectedOutcome: {
		checks: ["A correct run reports insufficient evidence and fabricates no evidence path."],
		requiredCriterionIds: ["absence-stated"],
		requiredEvidencePaths: [],
		requiredAnswerFragments: ["no http client"],
		solvable: false,
	},
	groundTruthPaths: ["src/index.ts"],
};

export const qualityCaseManifest: QualityCaseManifestFile = {
	schemaVersion: 1,
	repoRoot: "repo",
	cases: [
		focusedLookup,
		crossFileReasoning,
		bugLocalization,
		reviewPrecision,
		implementVerify,
		partialContextRecovery,
		longInvestigation,
		batchCoverage,
		conflictingEvidence,
		insufficientEvidence,
	],
};
