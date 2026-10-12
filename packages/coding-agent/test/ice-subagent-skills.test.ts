import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkillsFromDir } from "../src/core/skills.ts";

describe("ICE subagent project skills", () => {
	it("loads valid profiles with resolvable user-guide references", () => {
		const dir = resolve(import.meta.dirname, "../../../.ice/skills");
		const result = loadSkillsFromDir({ dir, source: "project" });
		const names = ["ice-subagent-create", "ice-subagent-configure", "ice-subagent-supervise"];
		for (const name of names) {
			expect(result.skills.some((skill) => skill.name === name)).toBe(true);
			const body = readFileSync(resolve(dir, name, "SKILL.md"), "utf8");
			expect(body).toContain("../../../packages/coding-agent/docs/subagents-v2.md");
			expect(
				readFileSync(resolve(dir, name, "../../../packages/coding-agent/docs/subagents-v2.md"), "utf8"),
			).toContain("# Subagents V2");
		}
		expect(result.diagnostics.filter((diagnostic) => names.some((name) => diagnostic.path?.includes(name)))).toEqual(
			[],
		);
	});
});
