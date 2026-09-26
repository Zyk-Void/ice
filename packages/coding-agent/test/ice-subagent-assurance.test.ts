import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	deriveSubagentAssuranceLevel,
	renderSubagentAssuranceSection,
	SUBAGENT_ASSURANCE_LEVEL_TEXT,
	SUBAGENT_ASSURANCE_SECTION_LIMITS,
	type SubagentAssuranceLevel,
	type SubagentAssuranceLevelInput,
	type SubagentEvidenceDescriptor,
	validateSubagentEvidenceClaims,
	validateSubagentImplementationClaims,
} from "../src/ice-subagent-assurance.ts";

const ALL_ASSURANCE_LEVELS: readonly SubagentAssuranceLevel[] = [
	"unverified_plain",
	"evidence_checked",
	"criteria_verified",
	"verification_executed",
	"review_verified",
];

const FLAG_KEYS = [
	"evidenceChecked",
	"requiredCriteriaAllVerified",
	"verificationCommandObserved",
	"verificationCommandPassed",
	"reviewerVerified",
] as const;

function levelInput(
	reportMode: SubagentAssuranceLevelInput["reportMode"],
	flags: Partial<Record<(typeof FLAG_KEYS)[number], boolean>>,
): SubagentAssuranceLevelInput {
	return {
		reportMode,
		evidenceChecked: false,
		requiredCriteriaAllVerified: false,
		verificationCommandObserved: false,
		verificationCommandPassed: false,
		reviewerVerified: false,
		...flags,
	};
}

describe("deriveSubagentAssuranceLevel", () => {
	it("returns unverified_plain when no signal applies", () => {
		expect(deriveSubagentAssuranceLevel(levelInput("structured_report", {}))).toBe("unverified_plain");
	});

	it("caps plain_final_turn at unverified_plain regardless of flags", () => {
		expect(
			deriveSubagentAssuranceLevel(
				levelInput("plain_final_turn", {
					evidenceChecked: true,
					requiredCriteriaAllVerified: true,
					verificationCommandObserved: true,
					verificationCommandPassed: true,
					reviewerVerified: true,
				}),
			),
		).toBe("unverified_plain");
		for (const flag of FLAG_KEYS) {
			expect(deriveSubagentAssuranceLevel(levelInput("plain_final_turn", { [flag]: true })), flag).toBe(
				"unverified_plain",
			);
		}
	});

	it("maps each single signal to its own level", () => {
		expect(deriveSubagentAssuranceLevel(levelInput("structured_report", { evidenceChecked: true }))).toBe(
			"evidence_checked",
		);
		expect(deriveSubagentAssuranceLevel(levelInput("structured_report", { requiredCriteriaAllVerified: true }))).toBe(
			"criteria_verified",
		);
		expect(
			deriveSubagentAssuranceLevel(
				levelInput("structured_report", { verificationCommandObserved: true, verificationCommandPassed: true }),
			),
		).toBe("verification_executed");
		expect(deriveSubagentAssuranceLevel(levelInput("structured_report", { reviewerVerified: true }))).toBe(
			"review_verified",
		);
	});

	it("verification_executed requires the command to be both observed and successful", () => {
		expect(deriveSubagentAssuranceLevel(levelInput("structured_report", { verificationCommandObserved: true }))).toBe(
			"unverified_plain",
		);
		expect(deriveSubagentAssuranceLevel(levelInput("structured_report", { verificationCommandPassed: true }))).toBe(
			"unverified_plain",
		);
		expect(
			deriveSubagentAssuranceLevel(
				levelInput("structured_report", {
					verificationCommandObserved: true,
					verificationCommandPassed: false,
					evidenceChecked: true,
				}),
			),
		).toBe("evidence_checked");
		expect(
			deriveSubagentAssuranceLevel(
				levelInput("structured_report", {
					verificationCommandObserved: false,
					verificationCommandPassed: true,
					evidenceChecked: true,
				}),
			),
		).toBe("evidence_checked");
	});

	it("applies strict precedence between levels", () => {
		expect(
			deriveSubagentAssuranceLevel(
				levelInput("structured_report", { evidenceChecked: true, requiredCriteriaAllVerified: true }),
			),
		).toBe("criteria_verified");
		expect(
			deriveSubagentAssuranceLevel(
				levelInput("structured_report", {
					evidenceChecked: true,
					requiredCriteriaAllVerified: true,
					verificationCommandObserved: true,
					verificationCommandPassed: true,
				}),
			),
		).toBe("verification_executed");
		expect(
			deriveSubagentAssuranceLevel(
				levelInput("structured_report", {
					evidenceChecked: true,
					requiredCriteriaAllVerified: true,
					verificationCommandObserved: true,
					verificationCommandPassed: true,
					reviewerVerified: true,
				}),
			),
		).toBe("review_verified");
		// A reviewer verdict outranks an unexecuted or failed verification command.
		expect(
			deriveSubagentAssuranceLevel(
				levelInput("structured_report", {
					verificationCommandObserved: true,
					verificationCommandPassed: false,
					reviewerVerified: true,
				}),
			),
		).toBe("review_verified");
	});

	it("matches the full 64-combination truth table", () => {
		for (const reportMode of ["plain_final_turn", "structured_report"] as const) {
			for (let mask = 0; mask < 32; mask++) {
				const input: SubagentAssuranceLevelInput = {
					reportMode,
					evidenceChecked: (mask & 1) !== 0,
					requiredCriteriaAllVerified: (mask & 2) !== 0,
					verificationCommandObserved: (mask & 4) !== 0,
					verificationCommandPassed: (mask & 8) !== 0,
					reviewerVerified: (mask & 16) !== 0,
				};
				let expected: SubagentAssuranceLevel = "unverified_plain";
				if (reportMode === "structured_report") {
					if (input.reviewerVerified) expected = "review_verified";
					else if (input.verificationCommandObserved && input.verificationCommandPassed)
						expected = "verification_executed";
					else if (input.requiredCriteriaAllVerified) expected = "criteria_verified";
					else if (input.evidenceChecked) expected = "evidence_checked";
				}
				expect(deriveSubagentAssuranceLevel(input), `${reportMode} mask ${mask}`).toBe(expected);
			}
		}
	});
});

describe("SUBAGENT_ASSURANCE_LEVEL_TEXT", () => {
	it("covers exactly the five assurance levels with nonempty text", () => {
		expect(Object.keys(SUBAGENT_ASSURANCE_LEVEL_TEXT).sort()).toEqual([...ALL_ASSURANCE_LEVELS].sort());
		for (const level of ALL_ASSURANCE_LEVELS) {
			expect(SUBAGENT_ASSURANCE_LEVEL_TEXT[level].length, level).toBeGreaterThan(0);
		}
	});

	it("never uses the word passed for the plain bounds-only level", () => {
		expect(SUBAGENT_ASSURANCE_LEVEL_TEXT.unverified_plain).not.toMatch(/passed/i);
		expect(SUBAGENT_ASSURANCE_LEVEL_TEXT.unverified_plain).toContain("bounds-checked only");
	});
});

describe("validateSubagentEvidenceClaims", () => {
	const baseObserved = {
		observedPaths: ["src/auth.ts", "docs/notes.md"],
		observedCommands: [
			{ command: "npm test", exitStatus: 0 },
			{ command: "node scripts/check.mjs", exitStatus: 3 },
		],
		ownedArtifactIds: ["artifact-1"],
		ownedChangedPaths: ["src/auth.ts"],
	};

	it("verifies observed paths exactly and under lexical normalization", () => {
		const result = validateSubagentEvidenceClaims(
			[
				{ kind: "path", id: "exact", path: "src/auth.ts" },
				{ kind: "path", id: "dot", path: "./src/auth.ts" },
				{ kind: "path", id: "dotdot", path: "src/../src/auth.ts" },
				{ kind: "path", id: "double-slash", path: "docs//notes.md" },
			],
			baseObserved,
		);
		expect(result.fabricatedIds).toEqual([]);
		expect(result.unverifiedIds).toEqual([]);
		expect(result.verifiedIds).toEqual(["exact", "dot", "dotdot", "double-slash"]);
		expect(result.precision).toBe(1);
	});

	it("classifies unobserved, escaping, and absolute-conflated paths as fabricated", () => {
		const result = validateSubagentEvidenceClaims(
			[
				{ kind: "path", id: "missing", path: "src/missing.ts" },
				{ kind: "path", id: "escape", path: "../outside.ts" },
				{ kind: "path", id: "absolute", path: "/src/auth.ts" },
				{ kind: "path", id: "empty", path: "" },
			],
			baseObserved,
		);
		expect(result.verifiedIds).toEqual([]);
		expect(result.unverifiedIds).toEqual([]);
		expect(result.fabricatedIds).toEqual(["missing", "escape", "absolute", "empty"]);
		expect(result.precision).toBe(0);
	});

	it("verifies artifact ownership and rejects stale or invented ids", () => {
		const result = validateSubagentEvidenceClaims(
			[
				{ kind: "artifact", id: "owned", artifactId: "artifact-1" },
				{ kind: "artifact", id: "stale", artifactId: "artifact-9" },
			],
			baseObserved,
		);
		expect(result.verifiedIds).toEqual(["owned"]);
		expect(result.fabricatedIds).toEqual(["stale"]);
	});

	it("matches commands after whitespace collapsing and honors claimed exit status", () => {
		const result = validateSubagentEvidenceClaims(
			[
				{ kind: "command", id: "collapsed", command: "npm   test", claimedExitStatus: 0 },
				{ kind: "command", id: "no-status", command: "node scripts/check.mjs" },
				{ kind: "command", id: "status-mismatch", command: "npm test", claimedExitStatus: 1 },
				{ kind: "command", id: "never-ran", command: "cargo test --all" },
				{ kind: "command", id: "empty", command: "   " },
			],
			baseObserved,
		);
		expect(result.verifiedIds).toEqual(["collapsed", "no-status"]);
		expect(result.fabricatedIds).toEqual(["status-mismatch", "never-ran", "empty"]);
	});

	it("matches commands whose observed form carries irregular whitespace", () => {
		const result = validateSubagentEvidenceClaims(
			[{ kind: "command", id: "c", command: "npm test", claimedExitStatus: 0 }],
			{
				...baseObserved,
				observedCommands: [{ command: "\tnpm \t test  ", exitStatus: 0 }],
			},
		);
		expect(result.verifiedIds).toEqual(["c"]);
	});

	it("verifies diffs against owned changed paths and stays unverified without ownership data", () => {
		const owned = validateSubagentEvidenceClaims(
			[
				{ kind: "diff", id: "owned", changedPaths: ["./src/auth.ts"] },
				{ kind: "diff", id: "vacuous", changedPaths: [] },
			],
			baseObserved,
		);
		expect(owned.verifiedIds).toEqual(["owned", "vacuous"]);

		const unowned = validateSubagentEvidenceClaims(
			[{ kind: "diff", id: "partial", changedPaths: ["src/auth.ts", "docs/other.md"] }],
			baseObserved,
		);
		expect(unowned.fabricatedIds).toEqual(["partial"]);

		const noOwnershipData = validateSubagentEvidenceClaims(
			[{ kind: "diff", id: "unknown", changedPaths: ["src/auth.ts"] }],
			{ ...baseObserved, ownedChangedPaths: undefined },
		);
		expect(noOwnershipData.unverifiedIds).toEqual(["unknown"]);
		expect(noOwnershipData.fabricatedIds).toEqual([]);
	});

	it("always verifies not_run reporting of uncertainty", () => {
		const result = validateSubagentEvidenceClaims(
			[{ kind: "not_run", id: "blocked", reason: "sandbox has no network access" }],
			baseObserved,
		);
		expect(result.verifiedIds).toEqual(["blocked"]);
		expect(result.fabricatedIds).toEqual([]);
		expect(result.precision).toBe(1);
	});

	it("computes precision over all descriptors and partitions the id buckets", () => {
		const descriptors: readonly SubagentEvidenceDescriptor[] = [
			{ kind: "path", id: "ok-path", path: "src/auth.ts" },
			{ kind: "path", id: "bad-path", path: "src/missing.ts" },
			{ kind: "command", id: "ok-cmd", command: "npm test", claimedExitStatus: 0 },
			{ kind: "diff", id: "no-data", changedPaths: ["src/auth.ts"] },
			{ kind: "not_run", id: "skipped", reason: "no tests declared" },
		];
		const result = validateSubagentEvidenceClaims(descriptors, { ...baseObserved, ownedChangedPaths: undefined });
		expect(result.verifiedIds).toEqual(["ok-path", "ok-cmd", "skipped"]);
		expect(result.unverifiedIds).toEqual(["no-data"]);
		expect(result.fabricatedIds).toEqual(["bad-path"]);
		expect(result.precision).toBeCloseTo(3 / 5, 12);
		const allIds = [...result.verifiedIds, ...result.unverifiedIds, ...result.fabricatedIds].sort();
		expect(allIds).toEqual(descriptors.map((descriptor) => descriptor.id).sort());
	});

	it("returns zero precision and empty buckets for no descriptors", () => {
		const result = validateSubagentEvidenceClaims([], baseObserved);
		expect(result.verifiedIds).toEqual([]);
		expect(result.unverifiedIds).toEqual([]);
		expect(result.fabricatedIds).toEqual([]);
		expect(result.precision).toBe(0);
	});
});

describe("validateSubagentImplementationClaims", () => {
	it("accepts consistent claims with normalized paths and collapsed commands", () => {
		const result = validateSubagentImplementationClaims(
			{
				modifiedFiles: ["./src/auth.ts"],
				ranCommands: [{ command: "npm \t test", exitStatus: 0 }],
			},
			{
				changedPaths: ["src/auth.ts", "src/other.ts"],
				observedCommands: [{ command: "npm test", exitStatus: 0 }],
				workspaceRoot: "/repo/work",
			},
		);
		expect(result.fileMismatches).toEqual([]);
		expect(result.commandMismatches).toEqual([]);
		expect(result.consistent).toBe(true);
	});

	it("reports claimed files that are not in the observed patch", () => {
		const result = validateSubagentImplementationClaims(
			{ modifiedFiles: ["src/missing.ts"], ranCommands: [] },
			{ changedPaths: ["src/auth.ts"], observedCommands: [] },
		);
		expect(result.fileMismatches).toEqual([{ path: "src/missing.ts", reason: "not_in_patch" }]);
		expect(result.consistent).toBe(false);
	});

	it("reports lexical workspace escapes as outside_workspace", () => {
		const dotdot = validateSubagentImplementationClaims(
			{ modifiedFiles: ["../escape.txt"], ranCommands: [] },
			{ changedPaths: [], observedCommands: [], workspaceRoot: "/repo/work" },
		);
		expect(dotdot.fileMismatches).toEqual([{ path: "../escape.txt", reason: "outside_workspace" }]);

		const deepEscape = validateSubagentImplementationClaims(
			{ modifiedFiles: ["src/../../secret.txt"], ranCommands: [] },
			{ changedPaths: [], observedCommands: [], workspaceRoot: "/repo/work" },
		);
		expect(deepEscape.fileMismatches).toEqual([{ path: "src/../../secret.txt", reason: "outside_workspace" }]);

		const absoluteEscape = validateSubagentImplementationClaims(
			{ modifiedFiles: ["/etc/passwd"], ranCommands: [] },
			{ changedPaths: [], observedCommands: [], workspaceRoot: "/repo/work" },
		);
		expect(absoluteEscape.fileMismatches).toEqual([{ path: "/etc/passwd", reason: "outside_workspace" }]);
	});

	it("checks the workspace boundary before the patch and accepts absolute in-workspace paths", () => {
		const both = validateSubagentImplementationClaims(
			{ modifiedFiles: ["../escape.txt"], ranCommands: [] },
			{ changedPaths: [], observedCommands: [], workspaceRoot: "/repo/work" },
		);
		expect(both.fileMismatches).toEqual([{ path: "../escape.txt", reason: "outside_workspace" }]);

		const inside = validateSubagentImplementationClaims(
			{ modifiedFiles: ["/repo/work/src/auth.ts"], ranCommands: [] },
			{ changedPaths: ["src/auth.ts"], observedCommands: [], workspaceRoot: "/repo/work" },
		);
		expect(inside.fileMismatches).toEqual([]);
		expect(inside.consistent).toBe(true);
	});

	it("skips the workspace check when no workspace root is supplied", () => {
		const result = validateSubagentImplementationClaims(
			{ modifiedFiles: ["../escape.txt"], ranCommands: [] },
			{ changedPaths: [], observedCommands: [] },
		);
		expect(result.fileMismatches).toEqual([{ path: "../escape.txt", reason: "not_in_patch" }]);
	});

	it("distinguishes unobserved commands from exit status mismatches", () => {
		const result = validateSubagentImplementationClaims(
			{
				modifiedFiles: [],
				ranCommands: [
					{ command: "npm run lint", exitStatus: 0 },
					{ command: "npm test", exitStatus: 0 },
				],
			},
			{
				changedPaths: [],
				observedCommands: [{ command: "npm test", exitStatus: 1 }],
			},
		);
		expect(result.commandMismatches).toEqual([
			{ command: "npm run lint", reason: "not_observed" },
			{ command: "npm test", reason: "exit_status_mismatch" },
		]);
		expect(result.consistent).toBe(false);
	});

	it("accepts a claimed exit status when any observed run of the command matches it", () => {
		const result = validateSubagentImplementationClaims(
			{ modifiedFiles: [], ranCommands: [{ command: "npm test", exitStatus: 0 }] },
			{
				changedPaths: [],
				observedCommands: [
					{ command: "npm test", exitStatus: 1 },
					{ command: "npm test", exitStatus: 0 },
				],
			},
		);
		expect(result.commandMismatches).toEqual([]);
		expect(result.consistent).toBe(true);
	});
});

describe("renderSubagentAssuranceSection", () => {
	it("renders the level, its description, and evidence counts deterministically", () => {
		const validation = {
			evidence: validateSubagentEvidenceClaims(
				[
					{ kind: "path", id: "b-bad", path: "src/missing.ts" },
					{ kind: "path", id: "a-good", path: "src/auth.ts" },
					{ kind: "diff", id: "c-nodata", changedPaths: ["src/auth.ts"] },
					{ kind: "not_run", id: "d-skipped", reason: "no tests declared" },
				],
				{
					observedPaths: ["src/auth.ts"],
					observedCommands: [],
					ownedArtifactIds: [],
					ownedChangedPaths: undefined,
				},
			),
		};
		const first = renderSubagentAssuranceSection("criteria_verified", validation);
		const second = renderSubagentAssuranceSection("criteria_verified", validation);
		expect(first).toBe(second);
		const lines = first.split("\n");
		expect(lines[0]).toBe("## Result assurance");
		expect(lines[1]).toBe(`level: criteria_verified - ${SUBAGENT_ASSURANCE_LEVEL_TEXT.criteria_verified}`);
		expect(lines[2]).toContain("evidence: 2/4 verified, 1 unverified, 1 fabricated, precision 0.500");
		// Sorted, locale-independent id lists.
		expect(lines[3]).toBe("fabricated evidence ids: b-bad");
		expect(lines[4]).toBe("unverified evidence ids: c-nodata");
	});

	it("renders implementation claims as consistent or with capped mismatch lines", () => {
		const consistent = renderSubagentAssuranceSection("verification_executed", {
			implementation: { fileMismatches: [], commandMismatches: [], consistent: true },
		});
		expect(consistent).toContain("implementation claims: consistent with observed runtime state");

		const inconsistent = renderSubagentAssuranceSection("unverified_plain", {
			implementation: {
				fileMismatches: [
					{ path: "../escape.txt", reason: "outside_workspace" },
					{ path: "src/missing.ts", reason: "not_in_patch" },
				],
				commandMismatches: [{ command: "npm test", reason: "exit_status_mismatch" }],
				consistent: false,
			},
		});
		expect(inconsistent).toContain("implementation claims: inconsistent (2 file, 1 command mismatches)");
		expect(inconsistent).toContain("- file: ../escape.txt (outside_workspace)");
		expect(inconsistent).toContain("- file: src/missing.ts (not_in_patch)");
		expect(inconsistent).toContain("- command: npm test (exit_status_mismatch)");

		const overflow = renderSubagentAssuranceSection("unverified_plain", {
			implementation: {
				fileMismatches: Array.from({ length: 12 }, (_, index) => ({
					path: `src/file-${index}.ts`,
					reason: "not_in_patch" as const,
				})),
				commandMismatches: Array.from({ length: 9 }, (_, index) => ({
					command: `cmd-${index}`,
					reason: "not_observed" as const,
				})),
				consistent: false,
			},
		});
		expect(overflow).toContain("- ... 4 more file mismatches");
		expect(overflow).toContain("- ... 1 more command mismatches");
	});

	it("renders every assurance level without exceeding the byte cap", () => {
		for (const level of ALL_ASSURANCE_LEVELS) {
			const rendered = renderSubagentAssuranceSection(level, {});
			expect(rendered).toContain(`level: ${level} - ${SUBAGENT_ASSURANCE_LEVEL_TEXT[level]}`);
			expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(
				SUBAGENT_ASSURANCE_SECTION_LIMITS.maxSectionBytes,
			);
		}
	});

	it("stays bounded and marks truncation for oversized validation input", () => {
		const rendered = renderSubagentAssuranceSection("unverified_plain", {
			evidence: {
				verifiedIds: [],
				unverifiedIds: [],
				fabricatedIds: Array.from({ length: 200 }, (_, index) => `id-${index}-${"x".repeat(400)}`),
				precision: 0,
			},
			implementation: {
				fileMismatches: Array.from({ length: 100 }, (_, index) => ({
					path: `src/${"y".repeat(500)}-${index}.ts`,
					reason: "not_in_patch" as const,
				})),
				commandMismatches: Array.from({ length: 100 }, (_, index) => ({
					command: `${"z".repeat(500)} ${index}`,
					reason: "not_observed" as const,
				})),
				consistent: false,
			},
		});
		expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(
			SUBAGENT_ASSURANCE_SECTION_LIMITS.maxSectionBytes,
		);
		expect(rendered.endsWith("[assurance section truncated]")).toBe(true);
	});

	it("truncates individual oversized items and redacts credential-looking text", () => {
		const rendered = renderSubagentAssuranceSection("evidence_checked", {
			evidence: {
				verifiedIds: [],
				unverifiedIds: [],
				fabricatedIds: [`long-${"x".repeat(1000)}`, "api_key=supersecretvalue123"],
				precision: 0,
			},
		});
		expect(rendered).toContain("[truncated]");
		expect(rendered).toContain("api_key=[REDACTED]");
		expect(rendered).not.toContain("supersecretvalue123");
		expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(
			SUBAGENT_ASSURANCE_SECTION_LIMITS.maxSectionBytes,
		);
	});
});
