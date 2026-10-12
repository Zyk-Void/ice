import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { computeSkillsSignature } from "../src/core/skills.ts";

describe("skills hot reload", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let skillsDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `skill-hot-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		skillsDir = join(agentDir, "skills");
		mkdirSync(skillsDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSkill(dir: string, name: string, description: string): void {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nSkill body.`);
	}

	function createLoader(): DefaultResourceLoader {
		// noSkills + an explicit additional path keeps ambient machine-level skill
		// sources (user config dirs) out of the assertion surface.
		return new DefaultResourceLoader({ cwd, agentDir, noSkills: true, additionalSkillPaths: [skillsDir] });
	}

	describe("computeSkillsSignature", () => {
		it("is stable when nothing changes", () => {
			const dir = join(tempDir, "sig");
			writeSkill(join(dir, "a"), "a", "Skill a");
			const before = computeSkillsSignature([dir]);
			const after = computeSkillsSignature([dir]);
			expect(after).toBe(before);
		});

		it("changes when a skill is added or deleted", () => {
			const dir = join(tempDir, "sig-add");
			writeSkill(join(dir, "a"), "a", "Skill a");
			const before = computeSkillsSignature([dir]);
			writeSkill(join(dir, "b"), "b", "Skill b");
			expect(computeSkillsSignature([dir])).not.toBe(before);
			const withB = computeSkillsSignature([dir]);
			rmSync(join(dir, "b"), { recursive: true });
			expect(computeSkillsSignature([dir])).not.toBe(withB);
		});

		it("changes when a skill file is updated", () => {
			const dir = join(tempDir, "sig-update");
			writeSkill(join(dir, "a"), "a", "Skill a");
			const file = join(dir, "a", "SKILL.md");
			const before = computeSkillsSignature([dir]);
			writeFileSync(file, "---\nname: a\ndescription: Updated\n---\nSkill body.");
			utimesSync(file, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
			expect(computeSkillsSignature([dir])).not.toBe(before);
		});

		it("changes when a watched root is deleted", () => {
			const dir = join(tempDir, "sig-delete");
			writeSkill(join(dir, "a"), "a", "Skill a");
			const before = computeSkillsSignature([dir]);
			rmSync(dir, { recursive: true });
			expect(computeSkillsSignature([dir])).not.toBe(before);
		});
	});

	describe("DefaultResourceLoader.refreshSkillsIfChanged", () => {
		it("returns false before the loader has loaded", () => {
			const loader = createLoader();
			expect(loader.refreshSkillsIfChanged()).toBe(false);
		});

		it("returns false when nothing changed", async () => {
			writeSkill(join(skillsDir, "stable"), "stable", "A stable skill");
			const loader = createLoader();
			await loader.reload();
			expect(loader.refreshSkillsIfChanged()).toBe(false);
		});

		it("picks up an added skill", async () => {
			writeSkill(join(skillsDir, "first"), "first", "First skill");
			const loader = createLoader();
			await loader.reload();
			expect(loader.getSkills().skills.some((s) => s.name === "first")).toBe(true);

			writeSkill(join(skillsDir, "second"), "second", "Second skill");
			expect(loader.refreshSkillsIfChanged()).toBe(true);
			const names = loader.getSkills().skills.map((s) => s.name);
			expect(names).toContain("first");
			expect(names).toContain("second");
		});

		it("picks up an updated skill description", async () => {
			const skillDir = join(skillsDir, "editable");
			writeSkill(skillDir, "editable", "Before update");
			const loader = createLoader();
			await loader.reload();
			expect(loader.getSkills().skills.find((s) => s.name === "editable")?.description).toBe("Before update");

			const file = join(skillDir, "SKILL.md");
			writeFileSync(file, "---\nname: editable\ndescription: After update\n---\nSkill body.");
			utimesSync(file, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
			expect(loader.refreshSkillsIfChanged()).toBe(true);
			expect(loader.getSkills().skills.find((s) => s.name === "editable")?.description).toBe("After update");
		});

		it("picks up a deleted skill", async () => {
			const skillDir = join(skillsDir, "doomed");
			writeSkill(skillDir, "doomed", "A doomed skill");
			const loader = createLoader();
			await loader.reload();
			expect(loader.getSkills().skills.some((s) => s.name === "doomed")).toBe(true);

			rmSync(skillDir, { recursive: true });
			expect(loader.refreshSkillsIfChanged()).toBe(true);
			expect(loader.getSkills().skills.some((s) => s.name === "doomed")).toBe(false);
		});

		it("returns false for an empty skill set with no sources", async () => {
			const emptySkillsDir = join(tempDir, "empty-skills");
			mkdirSync(emptySkillsDir, { recursive: true });
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				noSkills: true,
				additionalSkillPaths: [emptySkillsDir],
			});
			await loader.reload();
			expect(loader.getSkills().skills).toEqual([]);
			expect(loader.refreshSkillsIfChanged()).toBe(false);
		});
	});
});
