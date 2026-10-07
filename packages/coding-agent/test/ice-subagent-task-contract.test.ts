import { describe, expect, it } from "vitest";
import {
	buildSubagentTaskContract,
	deriveSubagentQualityMode,
	hashSubagentTaskContract,
	renderSubagentTaskContractSection,
	SUBAGENT_TASK_CONTRACT_LIMITS,
	SubagentTaskContractError,
	type SubagentTaskContractErrorCode,
	type SubagentTaskContractInput,
	type SubagentTaskContractKind,
	type SubagentTaskVerificationMode,
} from "../src/subagents/results/task-contract.ts";

function expectContractError(
	run: () => unknown,
	code: SubagentTaskContractErrorCode,
	messageParts: readonly string[] = [],
): void {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	expect(caught, "expected the task contract builder to reject this input").toBeInstanceOf(SubagentTaskContractError);
	const contractError = caught as SubagentTaskContractError;
	expect(contractError.code).toBe(code);
	for (const part of messageParts) expect(contractError.message).toContain(part);
}

describe("buildSubagentTaskContract", () => {
	it("defaults kind to explore, verification to none, and lists to empty", () => {
		const contract = buildSubagentTaskContract("Objective");

		expect(contract.kind).toBe("explore");
		expect(contract.objective).toBe("Objective");
		expect(contract.deliverable).toBe("A bounded answer with supporting evidence paths");
		expect(contract.constraints).toEqual([]);
		expect(contract.nonGoals).toEqual([]);
		expect(contract.knownFacts).toEqual([]);
		expect(contract.verification.mode).toBe("none");
		expect(contract.verification.commands).toEqual([]);
	});

	it("uses a deterministic generic deliverable default per kind", () => {
		const defaults: readonly (readonly [SubagentTaskContractKind, string])[] = [
			["explore", "A bounded answer with supporting evidence paths"],
			["research", "A research summary with cited evidence and findings"],
			["review", "A review report with file-level findings and a verdict"],
			["implement", "A completed scoped change with observed verification"],
			["verify", "A verification report with observed command results"],
		];
		for (const [kind, deliverable] of defaults) {
			const contract = buildSubagentTaskContract("Objective", { kind });
			expect(contract.kind).toBe(kind);
			expect(contract.deliverable).toBe(deliverable);
		}
	});

	it("trims supplied text fields and keeps contract shape", () => {
		const contract = buildSubagentTaskContract("  Find the auth flow  ", {
			kind: "research",
			deliverable: "  A short answer  ",
			constraints: ["  read only  "],
			nonGoals: ["  no refactoring  "],
			knownFacts: [{ id: "  fact-1  ", text: "  some fact  " }],
		});

		expect(contract.kind).toBe("research");
		expect(contract.objective).toBe("Find the auth flow");
		expect(contract.deliverable).toBe("A short answer");
		expect(contract.constraints).toEqual(["read only"]);
		expect(contract.nonGoals).toEqual(["no refactoring"]);
		expect(contract.knownFacts).toEqual([{ id: "fact-1", text: "some fact" }]);
	});

	it("returns a deeply frozen contract", () => {
		const contract = buildSubagentTaskContract("Objective", {
			kind: "implement",
			constraints: ["c"],
			nonGoals: ["n"],
			knownFacts: [{ id: "fact", text: "text" }],
			verification: { mode: "tests", commands: ["npm test"] },
		});

		expect(Object.isFrozen(contract)).toBe(true);
		expect(Object.isFrozen(contract.constraints)).toBe(true);
		expect(Object.isFrozen(contract.nonGoals)).toBe(true);
		expect(Object.isFrozen(contract.knownFacts)).toBe(true);
		expect(Object.isFrozen(contract.knownFacts[0])).toBe(true);
		expect(Object.isFrozen(contract.verification)).toBe(true);
		expect(Object.isFrozen(contract.verification.commands)).toBe(true);

		const mutableKind = contract as { kind: SubagentTaskContractKind };
		expect(() => {
			mutableKind.kind = "research";
		}).toThrow();
		const mutableConstraints = contract.constraints as string[];
		expect(() => {
			mutableConstraints.push("escape");
		}).toThrow();
		const mutableFact = contract.knownFacts[0] as { id: string };
		expect(() => {
			mutableFact.id = "other";
		}).toThrow();
		const mutableVerification = contract.verification as { mode: SubagentTaskVerificationMode };
		expect(() => {
			mutableVerification.mode = "none";
		}).toThrow();
	});

	it("redacts credential-looking text in every string field", () => {
		const contract = buildSubagentTaskContract("Check api_key=sk-test-abc123def456 handling", {
			constraints: ["Never log Bearer sk-test-abc123def456"],
			nonGoals: ["No printing of token=sk-test-abc123def456"],
			knownFacts: [{ id: "auth", text: "Header uses Bearer sk-test-abc123def456" }],
			verification: { mode: "tests", commands: ["echo token=sk-test-abc123def456"] },
		});

		expect(contract.objective).toBe("Check api_key=[REDACTED] handling");
		expect(contract.constraints[0]).toBe("Never log Bearer [REDACTED]");
		expect(contract.nonGoals[0]).toBe("No printing of token=[REDACTED]");
		expect(contract.knownFacts[0]).toEqual({ id: "auth", text: "Header uses Bearer [REDACTED]" });
		expect(contract.verification.commands).toEqual(["echo token=[REDACTED]"]);

		const section = renderSubagentTaskContractSection(contract, "strict");
		expect(section).not.toContain("sk-test-abc123def456");
		expect(section).toContain("[REDACTED]");
	});

	it("accepts input exactly at the caps", () => {
		const contract = buildSubagentTaskContract("Objective", {
			constraints: Array.from({ length: 8 }, () => "x".repeat(1024)),
			nonGoals: Array.from({ length: 8 }, (_, index) => `n${index}`),
			knownFacts: Array.from({ length: 8 }, (_, index) => ({ id: `fact-${index}`, text: "t".repeat(2048) })),
			verification: { mode: "tests", commands: Array.from({ length: 4 }, () => "c".repeat(512)) },
		});

		expect(contract.constraints).toHaveLength(8);
		expect(contract.nonGoals).toHaveLength(8);
		expect(contract.knownFacts).toHaveLength(8);
		expect(contract.verification.commands).toHaveLength(4);
	});
});

describe("task contract rejection", () => {
	it("rejects an empty or whitespace-only objective", () => {
		expectContractError(() => buildSubagentTaskContract(""), "contract_invalid", ["objective"]);
		expectContractError(() => buildSubagentTaskContract("   "), "contract_invalid", ["objective"]);
	});

	it("rejects oversized strings with specific fields", () => {
		expectContractError(
			() => buildSubagentTaskContract("Objective", { deliverable: "d".repeat(1025) }),
			"contract_oversized",
			["deliverable"],
		);
		expectContractError(
			() => buildSubagentTaskContract("Objective", { constraints: ["x".repeat(1025)] }),
			"contract_oversized",
			["constraints[0]"],
		);
		expectContractError(
			() => buildSubagentTaskContract("Objective", { nonGoals: ["x".repeat(1025)] }),
			"contract_oversized",
			["non-goals[0]"],
		);
		expectContractError(
			() => buildSubagentTaskContract("Objective", { knownFacts: [{ id: "fact", text: "t".repeat(2049) }] }),
			"contract_oversized",
			["known fact 0 text"],
		);
		expectContractError(
			() =>
				buildSubagentTaskContract("Objective", {
					verification: { mode: "tests", commands: ["c".repeat(513)] },
				}),
			"contract_oversized",
			["verification command 0"],
		);
	});

	it("rejects more than the capped number of items", () => {
		const nineItems = Array.from({ length: 9 }, (_, index) => `item ${index}`);
		expectContractError(
			() => buildSubagentTaskContract("Objective", { constraints: nineItems }),
			"contract_oversized",
			["constraints"],
		);
		expectContractError(() => buildSubagentTaskContract("Objective", { nonGoals: nineItems }), "contract_oversized", [
			"non-goals",
		]);
		expectContractError(
			() =>
				buildSubagentTaskContract("Objective", {
					knownFacts: Array.from({ length: 9 }, (_, index) => ({ id: `fact-${index}`, text: "t" })),
				}),
			"contract_oversized",
			["knownFacts"],
		);
		expectContractError(
			() =>
				buildSubagentTaskContract("Objective", {
					verification: { mode: "tests", commands: ["a", "b", "c", "d", "e"] },
				}),
			"contract_oversized",
			["commands"],
		);
	});

	it("rejects duplicate and malformed known fact ids", () => {
		expectContractError(
			() =>
				buildSubagentTaskContract("Objective", {
					knownFacts: [
						{ id: "fact-a", text: "one" },
						{ id: "fact-a", text: "two" },
					],
				}),
			"contract_invalid",
			["duplicated"],
		);
		for (const badId of ["has space", "-leading", ".leading", "bad!id", "a".repeat(65)]) {
			expectContractError(
				() => buildSubagentTaskContract("Objective", { knownFacts: [{ id: badId, text: "t" }] }),
				"contract_invalid",
				["id"],
			);
		}
	});

	it("rejects invalid kind and verification mode values", () => {
		const badKind = { kind: "audit" } as unknown as SubagentTaskContractInput;
		expectContractError(() => buildSubagentTaskContract("Objective", badKind), "contract_invalid", ["kind"]);
		const badMode = { verification: { mode: "always" } } as unknown as SubagentTaskContractInput;
		expectContractError(() => buildSubagentTaskContract("Objective", badMode), "contract_invalid", [
			"verification mode",
		]);
	});

	it("rejects malformed structures and empty trimmed list items", () => {
		expectContractError(
			() =>
				buildSubagentTaskContract("Objective", { constraints: "single" } as unknown as SubagentTaskContractInput),
			"contract_invalid",
			["constraints"],
		);
		expectContractError(() => buildSubagentTaskContract("Objective", { constraints: ["   "] }), "contract_invalid", [
			"constraints[0]",
		]);
		expectContractError(
			() =>
				buildSubagentTaskContract("Objective", {
					knownFacts: [{ id: "fact" }],
				} as unknown as SubagentTaskContractInput),
			"contract_invalid",
			["known fact 0"],
		);
		expectContractError(
			() =>
				buildSubagentTaskContract("Objective", {
					verification: { commands: "npm test" },
				} as unknown as SubagentTaskContractInput),
			"contract_invalid",
			["verification commands"],
		);
		expectContractError(
			() =>
				buildSubagentTaskContract("Objective", {
					verification: { timeout: 5 },
				} as unknown as SubagentTaskContractInput),
			"contract_invalid",
			["unsupported keys", "timeout"],
		);
	});

	it("rejects unknown top-level keys that would escalate tool, scope, model, or MCP authority", () => {
		const escalated = {
			tools: ["bash"],
			scope: { roots: ["src"] },
			model: "openai/gpt-5",
			mcp: ["server"],
		} as unknown as SubagentTaskContractInput;
		expectContractError(() => buildSubagentTaskContract("Objective", escalated), "contract_invalid", [
			"unsupported keys",
			"tools",
			"scope",
			"model",
			"mcp",
		]);

		const contract = buildSubagentTaskContract("Objective");
		expect(Object.keys(contract).sort()).toEqual([
			"constraints",
			"deliverable",
			"kind",
			"knownFacts",
			"nonGoals",
			"objective",
			"verification",
		]);
		for (const forbidden of ["tools", "scope", "model", "mcp", "capabilities", "permissions"]) {
			expect(forbidden in contract).toBe(false);
		}
	});
});

describe("hashSubagentTaskContract", () => {
	const baseInput = {
		kind: "research" as const,
		deliverable: "A report",
		constraints: ["c1", "c2"],
		nonGoals: ["n1"],
		knownFacts: [{ id: "fact-1", text: "t1" }],
		verification: { mode: "tests" as const, commands: ["npm test"] },
	};

	it("produces a lowercase 64-character sha256 hex digest", () => {
		const hash = hashSubagentTaskContract(buildSubagentTaskContract("Objective", baseInput));
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("is deterministic across rebuilds from equal input", () => {
		const first = hashSubagentTaskContract(buildSubagentTaskContract("Objective", baseInput));
		const second = hashSubagentTaskContract(buildSubagentTaskContract("Objective", baseInput));
		expect(first).toBe(second);
	});

	it("is independent of input key order", () => {
		const base = hashSubagentTaskContract(buildSubagentTaskContract("Objective", baseInput));
		const reordered = hashSubagentTaskContract(
			buildSubagentTaskContract("Objective", {
				verification: { commands: ["npm test"], mode: "tests" },
				knownFacts: [{ text: "t1", id: "fact-1" }],
				nonGoals: ["n1"],
				constraints: ["c1", "c2"],
				deliverable: "A report",
				kind: "research",
			}),
		);
		expect(reordered).toBe(base);
	});

	it("changes when any contract field changes", () => {
		const base = hashSubagentTaskContract(buildSubagentTaskContract("Objective", baseInput));
		const variants: SubagentTaskContractInput[] = [
			{ ...baseInput, kind: "review" },
			{ ...baseInput, deliverable: "Another report" },
			{ ...baseInput, constraints: ["c1", "c2", "c3"] },
			{ ...baseInput, nonGoals: ["n2"] },
			{ ...baseInput, knownFacts: [{ id: "fact-1", text: "changed" }] },
			{ ...baseInput, knownFacts: [{ id: "fact-2", text: "t1" }] },
			{ ...baseInput, verification: { mode: "review" } },
			{ ...baseInput, verification: { mode: "tests", commands: ["npm run check"] } },
		];
		for (const variant of variants) {
			expect(hashSubagentTaskContract(buildSubagentTaskContract("Objective", variant))).not.toBe(base);
		}
		expect(hashSubagentTaskContract(buildSubagentTaskContract("Other objective", baseInput))).not.toBe(base);
	});
});

describe("deriveSubagentQualityMode", () => {
	const noCriteria = { hasAcceptanceCriteria: false, hasOutputSchema: false };

	it("derives explore for unadorned explore tasks", () => {
		const contract = buildSubagentTaskContract("Objective", { kind: "explore" });
		expect(deriveSubagentQualityMode(contract, noCriteria)).toBe("explore");
	});

	it("derives standard for a defaulted kind so untyped calls stay substantial", () => {
		const contract = buildSubagentTaskContract("Objective", { kind: "explore" });
		expect(deriveSubagentQualityMode(contract, { ...noCriteria, defaultedKind: true })).toBe("standard");
	});

	it("derives explore for evidence-only explore tasks", () => {
		const contract = buildSubagentTaskContract("Objective", {
			kind: "explore",
			verification: { mode: "evidence" },
		});
		expect(deriveSubagentQualityMode(contract, noCriteria)).toBe("explore");
	});

	it("derives standard for explore tasks with test verification", () => {
		const contract = buildSubagentTaskContract("Objective", {
			kind: "explore",
			verification: { mode: "tests" },
		});
		expect(deriveSubagentQualityMode(contract, noCriteria)).toBe("standard");
	});

	it("derives standard for research and implement tasks without criteria", () => {
		const research = buildSubagentTaskContract("Objective", { kind: "research" });
		expect(deriveSubagentQualityMode(research, noCriteria)).toBe("standard");
		const implement = buildSubagentTaskContract("Objective", { kind: "implement" });
		expect(deriveSubagentQualityMode(implement, noCriteria)).toBe("standard");
	});

	it("derives strict when acceptance criteria are present, including for explore", () => {
		const implement = buildSubagentTaskContract("Objective", { kind: "implement" });
		expect(deriveSubagentQualityMode(implement, { ...noCriteria, hasAcceptanceCriteria: true })).toBe("strict");
		const explore = buildSubagentTaskContract("Objective", { kind: "explore" });
		expect(deriveSubagentQualityMode(explore, { ...noCriteria, hasAcceptanceCriteria: true })).toBe("strict");
	});

	it("derives strict when an output schema is present", () => {
		const contract = buildSubagentTaskContract("Objective", { kind: "verify" });
		expect(deriveSubagentQualityMode(contract, { ...noCriteria, hasOutputSchema: true })).toBe("strict");
	});

	it("derives strict when forced regardless of contract shape", () => {
		const contract = buildSubagentTaskContract("Objective", { kind: "explore" });
		const forced: { hasAcceptanceCriteria: boolean; hasOutputSchema: boolean; forced?: "strict" | undefined } = {
			...noCriteria,
			forced: "strict",
		};
		expect(deriveSubagentQualityMode(contract, forced)).toBe("strict");
	});

	it("derives strict for review-mode verification", () => {
		const contract = buildSubagentTaskContract("Objective", {
			kind: "research",
			verification: { mode: "review" },
		});
		expect(deriveSubagentQualityMode(contract, noCriteria)).toBe("strict");
	});
});

describe("renderSubagentTaskContractSection", () => {
	it("renders kind, quality mode, objective, deliverable, lists, and verification", () => {
		const contract = buildSubagentTaskContract("Find the auth entry point", {
			kind: "explore",
			constraints: ["Read-only exploration"],
			nonGoals: ["No edits"],
			knownFacts: [{ id: "entry", text: "src/main.ts is the entry point" }],
			verification: { mode: "evidence" },
		});

		const section = renderSubagentTaskContractSection(contract, "explore");

		expect(section).toContain("## Delegation task contract");
		expect(section).toContain("kind: explore");
		expect(section).toContain("quality mode: explore");
		expect(section).toContain("objective: Find the auth entry point");
		expect(section).toContain("deliverable: A bounded answer with supporting evidence paths");
		expect(section).toContain("constraints:\n- Read-only exploration");
		expect(section).toContain("non-goals:\n- No edits");
		expect(section).toContain("known facts:\n- [entry] src/main.ts is the entry point");
		expect(section).toContain("verification mode: evidence");
		expect(section).toContain("declarations only; runtime authority comes from approved tools");
		expect(section).not.toContain("[task contract section truncated]");
	});

	it("renders declared commands with the declarations-only label", () => {
		const withCommands = buildSubagentTaskContract("Objective", {
			verification: { mode: "tests", commands: ["npm test", "npm run lint"] },
		});
		const section = renderSubagentTaskContractSection(withCommands, "standard");
		expect(section).toContain("verification mode: tests");
		expect(section).toContain("- npm test");
		expect(section).toContain("- npm run lint");

		const withoutCommands = buildSubagentTaskContract("Objective");
		const bare = renderSubagentTaskContractSection(withoutCommands, "explore");
		expect(bare).toContain("verification mode: none");
		expect(bare).toContain(
			"declared verification commands (declarations only; runtime authority comes from approved tools): none",
		);
	});

	it("is deterministic across repeated renders and rebuilds", () => {
		const input: SubagentTaskContractInput = {
			kind: "implement",
			deliverable: "A scoped change",
			constraints: ["Keep the loop intact"],
			verification: { mode: "tests", commands: ["npm test"] },
		};
		const first = renderSubagentTaskContractSection(buildSubagentTaskContract("Objective", input), "strict");
		const second = renderSubagentTaskContractSection(buildSubagentTaskContract("Objective", input), "strict");
		expect(first).toBe(second);
		expect(first.length).toBeGreaterThan(0);
	});

	it("truncates deterministically to the 4 KiB cap without splitting UTF-8 code points", () => {
		const contract = buildSubagentTaskContract("Objective", {
			kind: "implement",
			constraints: Array.from({ length: 8 }, (_, index) => `c${index} ${"é".repeat(400)}`),
			verification: { mode: "tests", commands: ["npm test"] },
		});

		const section = renderSubagentTaskContractSection(contract, "strict");

		expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(SUBAGENT_TASK_CONTRACT_LIMITS.maxSectionBytes);
		expect(section.endsWith("[task contract section truncated]")).toBe(true);
		expect(section).toContain("kind: implement");
		expect(section).not.toContain("\uFFFD");
	});
});
