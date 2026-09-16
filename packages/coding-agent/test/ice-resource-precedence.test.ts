import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { resolveIceSubagentContract, resolveIceSubagentHooks } from "../src/ice-subagent-settings.ts";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "ice-resources-"));
	roots.push(cwd);
	const agentDir = join(cwd, "global");
	for (const [root, label] of [
		[agentDir, "GLOBAL"],
		[join(cwd, ".ice"), "PROJECT"],
	]) {
		mkdirSync(join(root!, "skills", "same"), { recursive: true });
		mkdirSync(join(root!, "prompts"), { recursive: true });
		writeFileSync(join(root!, "skills", "same", "SKILL.md"), `---\nname: same\ndescription: ${label}\n---\n${label}`);
		writeFileSync(join(root!, "prompts", "same.md"), `---\ndescription: ${label}\n---\n${label}`);
		writeFileSync(join(root!, "SYSTEM.md"), label!);
		writeFileSync(join(root!, "APPEND_SYSTEM.md"), label!);
	}
	return { cwd, agentDir };
}

describe("ice-only resource precedence and no ambient child installs", () => {
	it("prefers global same-name skills, prompts, system and append prompts, including after reload", async () => {
		const { cwd, agentDir } = fixture();
		const settings = SettingsManager.create(cwd, agentDir, { globalFirst: true, projectTrusted: true });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: settings,
			noExtensions: true,
			noThemes: true,
		});
		await loader.reload();
		expect(loader.getSkills().skills.find((skill) => skill.name === "same")?.description).toBe("GLOBAL");
		expect(loader.getPrompts().prompts.find((prompt) => prompt.name === "same")?.description).toBe("GLOBAL");
		expect(loader.getSystemPrompt()).toBe("GLOBAL");
		expect(loader.getAppendSystemPrompt()).toContain("GLOBAL");
		expect(loader.getAppendSystemPrompt()).not.toContain("PROJECT");
		await loader.reload();
		expect(loader.getSkills().skills.find((skill) => skill.name === "same")?.description).toBe("GLOBAL");
	});
	it("does not change stock Ice project-first resource behavior", async () => {
		const { cwd, agentDir } = fixture();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir),
			noExtensions: true,
			noThemes: true,
		});
		await loader.reload();
		expect(loader.getSkills().skills.find((skill) => skill.name === "same")?.description).toBe("PROJECT");
		expect(loader.getPrompts().prompts.find((prompt) => prompt.name === "same")?.description).toBe("PROJECT");
		expect(loader.getSystemPrompt()).toBe("PROJECT");
	});
	it("explicit empty global package arrays do not activate project packages", async () => {
		const { cwd, agentDir } = fixture();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
		writeFileSync(
			join(cwd, ".ice", "settings.json"),
			JSON.stringify({ packages: ["npm:should-never-install-fixture"] }),
		);
		const manager = new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { globalFirst: true }),
		});
		const missing = vi.fn(async () => "error" as const);
		await manager.resolve(missing);
		expect(missing).not.toHaveBeenCalled();
	});
	it("skips package resolution and extension-source installation for bounded children", async () => {
		const { cwd, agentDir } = fixture();
		const resolve = vi.spyOn(DefaultPackageManager.prototype, "resolve");
		const extensions = vi.spyOn(DefaultPackageManager.prototype, "resolveExtensionSources");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noPackages: true,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "child",
			appendSystemPrompt: [],
		});
		await loader.reload();
		expect(resolve).not.toHaveBeenCalled();
		expect(extensions).not.toHaveBeenCalled();
		expect(loader.getExtensions().extensions).toEqual([]);
	});
	it("keeps explicit global preferences above project per-role defaults without weakening caps", () => {
		const contract = resolveIceSubagentContract({
			role: "self",
			projectTrusted: true,
			globalSettings: {
				ice: { subagents: { defaults: { timeoutMs: 10_000 }, restrictions: { maxTimeoutMs: 8_000 } } },
			},
			projectSettings: { ice: { subagents: { roleDefaults: { self: { timeoutMs: 4_000 } } } } },
		});
		expect(contract.values.timeoutMs).toBe(8_000);
	});
	it("global hook definitions win collisions, retaining required status", () => {
		const hook = { id: "gate", event: "subagent.beforeLaunch", kind: "in-process" };
		const hooks = resolveIceSubagentHooks({
			projectTrusted: true,
			globalHooks: {
				ice: { hooks: { enabled: true, definitions: [{ ...hook, timeoutMs: 100, required: false }] } },
			},
			projectHooks: {
				ice: { hooks: { enabled: true, definitions: [{ ...hook, timeoutMs: 1000, required: true }] } },
			},
		});
		expect(hooks).toHaveLength(1);
		expect(hooks[0]).toMatchObject({ timeoutMs: 100, required: true, source: { layer: "global" } });
	});
	it("explicit global hook disable cannot be reversed by project settings", () => {
		const hooks = resolveIceSubagentHooks({
			projectTrusted: true,
			globalHooks: { ice: { hooks: { enabled: false } } },
			projectHooks: {
				ice: { hooks: { enabled: true, definitions: [{ id: "gate", event: "subagent.beforeLaunch" }] } },
			},
		});
		expect(hooks).toEqual([]);
	});
});
