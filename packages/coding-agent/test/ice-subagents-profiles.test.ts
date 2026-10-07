import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@zykairotis/ice-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { importRufloAgentPack } from "../src/ice-agent-packs.ts";
import iceSubagents, {
	buildSubagentPrompt,
	getSubagentAgentMigrationManifest,
	listSubagentProfiles,
	resolveSelfSubagentProfile,
	resolveSubagentAgentDirectories,
	resolveSubagentProfile,
	resolveSubagentProfileResolution,
	resolveSubagentResources,
	resolveSubagentThinkingLevel,
	revalidateSubagentProfile,
	runResolvedReviewBatch,
	runResolvedSubagentBatch,
	SUBAGENT_PROFILE_ALIASES,
	SUBAGENT_PROFILE_LIMITS,
	SUBAGENT_PROFILES,
	suggestSubagentProfiles,
} from "../src/ice-subagents.ts";
import { getIceDelegableTools, registerIceDelegableTool } from "../src/subagents/tools/adapters.ts";
import {
	batchResult,
	createAsyncToolHarness,
	createWorkspace,
	normalizeSubagentRequest,
	request,
	tempDirs,
} from "./ice-subagents-harness.ts";

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ICE subagent contracts", () => {
	it("gives self-delegation the default bounded timeout", () => {
		const profile = resolveSelfSubagentProfile({
			cwd: "/tmp",
			instructions: "Inspect the approved scope and report evidence.",
		});
		expect(profile.timeoutMs).toBe(120_000);
		expect(profile.source).toBe("self");
	});

	it("treats profile timeout as a default while honoring the global ceiling", async () => {
		const cwd = await createWorkspace();
		expect(normalizeSubagentRequest(request(cwd), cwd).timeoutMs).toBe(120_000);
		expect(normalizeSubagentRequest({ ...request(cwd), timeoutMs: 60_000 }, cwd).timeoutMs).toBe(60_000);
		expect(normalizeSubagentRequest({ ...request(cwd), timeoutMs: 300_000 }, cwd).timeoutMs).toBe(300_000);
		expect(normalizeSubagentRequest({ ...request(cwd), timeoutMs: 600_000 }, cwd).timeoutMs).toBe(600_000);
		expect(normalizeSubagentRequest({ ...request(cwd), timeoutMs: 900_000 }, cwd).timeoutMs).toBe(
			SUBAGENT_PROFILE_LIMITS.maxTimeoutMs,
		);
	});

	it("reads the subagent V2 model list form as primary and fallback", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		const write = (name: string, model: string) =>
			writeFile(
				join(agentDir, "agents", `${name}.md`),
				`---\nname: ${name}\ndescription: d\nmodel: ${model}\n---\nInspect.\n`,
			);
		await write("listed", "[provider/a, provider/b, inherit]");
		await write("single", "[provider/a]");
		await write("inherited", "inherit");
		await write("toolong", "[provider/a, provider/b, provider/c]");
		expect(resolveSubagentProfileResolution("listed", { cwd, agentDir })).toMatchObject({
			requestedModel: "provider/a",
			fallbackModel: "provider/b",
		});
		expect(resolveSubagentProfileResolution("single", { cwd, agentDir }).requestedModel).toBe("provider/a");
		expect(resolveSubagentProfileResolution("inherited", { cwd, agentDir }).requestedModel).toBeUndefined();
		expect(() => resolveSubagentProfileResolution("toolong", { cwd, agentDir })).toThrow(/legacy subagents accept/);
	});

	it("records profile model metadata without overriding the parent model", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "pinned.md"),
			"---\nname: pinned\ndescription: Pinned model role\nmodel: provider/model\n---\nInspect.\n",
		);
		const profile = resolveSubagentProfileResolution("pinned", { cwd, agentDir });
		expect(profile).toMatchObject({
			requestedModel: "provider/model",
			modelPolicy: "inherit-parent",
		});
		expect(profile.diagnostics ?? []).not.toContain(
			"configured model ignored; child inherits the current parent model",
		);
	});

	it("removed the bundled catalog: only file agents resolve, with global-first shadowing", async () => {
		expect(Object.keys(SUBAGENT_PROFILES)).toEqual([]);
		expect(SUBAGENT_PROFILE_ALIASES).toEqual({});
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-nobundled-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "api-review.md"),
			"---\nname: api-review\ndescription: API review\ntools: read\n---\nReview.\n",
		);
		expect(resolveSubagentProfileResolution("api-review", { cwd, agentDir }).source).toBe("user");
		expect(() => resolveSubagentProfileResolution("explore", { cwd, agentDir })).toThrowError(
			/Unknown subagent profile/,
		);
		expect(() => resolveSubagentProfile("explore", { cwd, agentDir })).toThrowError(/Unknown subagent profile/);
	});

	it("keeps profile adapter selectors explicit, parent-owned, and separate from tools", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-adapter-profile-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "adapter-user.md"),
			"---\nname: adapter-user\ndescription: Adapter profile\ntools: read\nadapters: [fixture/search]\n---\nUse the parent adapter when it is admitted.\n",
		);
		const profile = resolveSubagentProfileResolution("adapter-user", { cwd, agentDir });
		expect(profile).toMatchObject({ requestedTools: ["read"], adapterIds: ["fixture/search"] });

		const owner = {};
		registerIceDelegableTool(owner, {
			adapterId: "fixture/search",
			name: "lookup",
			origin: "fixture/lookup",
			access: "read-only",
			childSafe: true,
			description: "Look up a bounded fixture fact.",
			parameters: Type.Object({}, { additionalProperties: false }),
			execute: vi.fn(async () => ({ ok: true })),
		});
		const available = getIceDelegableTools(owner);
		const withoutAdapter = listSubagentProfiles({ cwd, agentDir });
		const withoutAdapterEntry = withoutAdapter.find((entry) => entry.name === "adapter-user");
		expect(withoutAdapterEntry).toMatchObject({
			requestedAdapters: ["fixture/search"],
			availability: "limited",
		});
		expect(withoutAdapterEntry?.effectiveAdapters).toBeUndefined();
		const withAdapter = listSubagentProfiles({
			cwd,
			agentDir,
			parentActiveTools: ["read", "lookup"],
			delegableTools: available,
		});
		expect(withAdapter.find((entry) => entry.name === "adapter-user")).toMatchObject({
			requestedAdapters: ["fixture/search"],
			effectiveAdapters: ["fixture/search"],
			effectiveTools: ["read", "lookup"],
			availability: "available",
		});

		const normalized = normalizeSubagentRequest(
			{
				parentSessionId: "parent-1",
				role: "adapter-user",
				task: "Inspect the approved scope.",
				scope: { roots: ["src"] },
				cwd,
			},
			cwd,
			{ agentDir, parentActiveTools: ["read", "lookup"], delegableTools: available },
		);
		expect(normalized.profile.requestedTools).toEqual(["read"]);
		expect(normalized.selectedAdapterIds).toEqual(["fixture/search"]);
		expect(normalized.delegatedTools?.map((tool) => tool.name)).toEqual(["lookup"]);

		const toolFree = normalizeSubagentRequest(
			{
				parentSessionId: "parent-1",
				role: "adapter-user",
				task: "Inspect supplied context.",
				scope: { roots: ["src"] },
				cwd,
				execution: { tools: [] },
			},
			cwd,
			{ agentDir, parentActiveTools: ["read", "lookup"], delegableTools: available },
		);
		expect(toolFree.selectedAdapterIds).toBeUndefined();
		expect(toolFree.delegatedTools).toEqual([]);

		await writeFile(
			join(agentDir, "agents", "adapter-bad.md"),
			"---\nname: adapter-bad\ndescription: Bad adapter selector\ntools: read\nadapters: [bad adapter id]\n---\nReject this metadata.\n",
		);
		expect(() => resolveSubagentProfileResolution("adapter-bad", { cwd, agentDir })).toThrowError(/adapter IDs/i);
		await writeFile(
			join(agentDir, "agents", "adapter-unknown.md"),
			"---\nname: adapter-unknown\ndescription: Missing adapter\ntools: read\nadapters: [fixture/missing]\n---\nReject missing authority.\n",
		);
		expect(() =>
			normalizeSubagentRequest(
				{
					parentSessionId: "parent-1",
					role: "adapter-unknown",
					task: "Inspect.",
					scope: { roots: ["src"] },
					cwd,
				},
				cwd,
				{ agentDir, parentActiveTools: ["read"], delegableTools: available },
			),
		).toThrowError(/no child-safe parent registration/i);
	});

	it("resolves explicit file agents; unknown alias spellings fail with discovery hints", async () => {
		expect(SUBAGENT_PROFILE_ALIASES).toEqual({});
		const cwd = await createWorkspace();
		const scoutDir = await mkdtemp(join(tmpdir(), "ice-subagents-scout-agent-"));
		tempDirs.push(scoutDir);
		expect(() => resolveSubagentProfile("scout", { cwd, agentDir: scoutDir })).toThrowError(
			/Unknown subagent profile/,
		);
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-alias-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "explorer.md"),
			"---\nname: explorer\ndescription: Exact explorer\ntools: read\n---\nExact explorer prompt.\n",
		);
		const exact = resolveSubagentProfileResolution("explorer", { cwd, agentDir, projectTrusted: false });
		expect(exact).toMatchObject({ name: "explorer", source: "user", description: "Exact explorer" });
	});

	it("lists valid profiles when an incompatible profile is present", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "reviewer.md"),
			"---\nname: reviewer\ndescription: User review\ntools: read, grep\n---\nReview the approved scope.\n",
		);
		await writeFile(
			join(agentDir, "agents", "incompatible.md"),
			"---\nname: incompatible\ndescription: Writable tester\ntools: read, bash, write\n---\nRun tests.\n",
		);

		const profiles = listSubagentProfiles({ cwd, agentDir });
		expect(profiles.map((profile) => profile.name)).toEqual(["incompatible", "reviewer"]);
		expect(profiles.find((profile) => profile.name === "incompatible")).toMatchObject({
			source: "user",
			availability: "requires_yolo",
			requestedTools: ["read", "bash", "write"],
			effectiveTools: ["read"],
		});
	});

	it("keeps malformed profiles diagnosable without exposing their body", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-invalid-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "broken.md"),
			"---\nname: broken\ndescription: Broken profile\ntools: invalid tool identifier\n---\nDO_NOT_EXPOSE_BODY_MARKER\n",
		);
		const profiles = listSubagentProfiles({ cwd, agentDir });
		const broken = profiles.find((profile) => profile.name === "broken");
		expect(broken).toMatchObject({ source: "user", availability: "invalid", requestedTools: [], effectiveTools: [] });
		expect(broken?.diagnostics?.length).toBeGreaterThan(0);
		expect(JSON.stringify(broken)).not.toContain("DO_NOT_EXPOSE_BODY_MARKER");
	});

	it("projects current invocation capabilities through the profile-listing tool", async () => {
		const _cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-listing-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "coder.md"),
			"---\nname: coder\ndescription: File coder\ntools: read, grep, find, ls, bash, edit, write\n---\nImplement.\n",
		);
		const safeHarness = await createAsyncToolHarness({ activeTools: ["delegate", "read"], agentDir });
		const safeResult = await safeHarness.tools
			.get("list_subagent_profiles")!
			.execute("list-safe", { query: "coder" }, undefined, undefined, safeHarness.context);
		const safeProfile = (safeResult.details as { profiles: Array<Record<string, unknown>> }).profiles[0];
		expect(safeProfile).toMatchObject({
			name: "coder",
			requestedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
			effectiveTools: ["read"],
			availability: "requires_yolo",
		});

		const yoloHarness = await createAsyncToolHarness({
			flags: { "sub-yolo": true, "ice-allow-bash": true },
			iceMode: "build",
			trusted: true,
			agentDir,
		});
		const yoloResult = await yoloHarness.tools
			.get("list_subagent_profiles")!
			.execute("list-yolo", { query: "coder" }, undefined, undefined, yoloHarness.context);
		const yoloProfile = (yoloResult.details as { profiles: Array<Record<string, unknown>> }).profiles[0];
		expect(yoloProfile).toMatchObject({
			name: "coder",
			effectiveTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
			availability: "available",
		});
	});

	it("explains filtered profile misses instead of implying that no profiles exist", async () => {
		const harness = await createAsyncToolHarness();
		const result = await harness.tools
			.get("list_subagent_profiles")!
			.execute("list-miss", { query: "repo-map-one-off-task-label" }, undefined, undefined, harness.context);
		expect(result).toMatchObject({ isError: false });
		expect(result.details).toMatchObject({
			profiles: [],
			query: "repo-map-one-off-task-label",
			queryMatched: false,
			availableProfileNames: ["self"],
			diagnostic: expect.stringContaining("No profile matched query"),
		});
		expect((result.details as { suggestions?: string[] }).suggestions).toBeInstanceOf(Array);
		expect(result.content[0]?.text).toContain("availableProfileNames");
	});

	it("resolves trusted configurable roles with deterministic precedence and provenance", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await mkdir(join(cwd, ".ice", "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "security-review.md"),
			"---\nname: security-review\ndescription: User security review\ntools: read, grep\n---\nUser role prompt.\n",
		);
		await writeFile(
			join(cwd, ".ice", "agents", "security-review.md"),
			"---\nname: security-review\ndescription: Project security review\ntools: read, find\n---\nProject role prompt.\n",
		);

		const resolved = resolveSubagentProfileResolution("security-review", {
			cwd,
			agentDir,
			projectTrusted: true,
		});
		expect(resolved).toMatchObject({
			name: "security-review",
			description: "User security review",
			tools: ["read", "grep"],
			source: "user",
			sourcePath: join(agentDir, "agents", "security-review.md"),
			canonicalPath: join(agentDir, "agents", "security-review.md"),
		});
		expect(resolved.systemPrompt).toContain("User role prompt.");
		expect(resolved.sourceHash).toMatch(/^[a-f0-9]{64}$/);
		expect(resolved.diagnostics?.join("\n")).toMatch(/shadowed trusted project definition/);

		const userResolved = resolveSubagentProfileResolution("security-review", {
			cwd,
			agentDir,
			projectTrusted: false,
		});
		expect(userResolved.source).toBe("user");
		expect(userResolved.systemPrompt).toContain("User role prompt.");
	});

	it("uses the new default global agent path and reports legacy files without moving them", async () => {
		const cwd = await createWorkspace();
		const home = await mkdtemp(join(tmpdir(), "ice-subagents-home-"));
		tempDirs.push(home);
		const previousHome = process.env.HOME;
		const previousAgentDir = process.env.ICE_CODING_AGENT_DIR;
		delete process.env.ICE_CODING_AGENT_DIR;
		process.env.HOME = home;
		const agentDir = join(home, ".ice", "agent");
		try {
			await mkdir(join(agentDir, "agents"), { recursive: true });
			const legacyPath = join(agentDir, "agents", "legacy-review.md");
			await writeFile(
				legacyPath,
				"---\nname: legacy-review\ndescription: Legacy review\ntools: read\n---\nLegacy prompt.\n",
			);
			const directories = resolveSubagentAgentDirectories();
			expect(directories.globalAgentsDir).toBe(join(home, ".ice", "agents"));
			expect(directories.legacyGlobalAgentsDir).toBe(join(agentDir, "agents"));
			const manifest = getSubagentAgentMigrationManifest();
			expect(manifest).toEqual([
				expect.objectContaining({
					name: "legacy-review",
					sourcePath: legacyPath,
					conflict: "none",
				}),
			]);
			expect(() => resolveSubagentProfileResolution("legacy-review", { cwd })).toThrowError(
				/Unknown subagent profile/,
			);
			const listed = listSubagentProfiles({ cwd }).find((profile) => profile.name === "legacy-review");
			expect(listed).toMatchObject({ availability: "invalid", sourcePath: legacyPath });
			expect(listed?.diagnostics?.join("\n")).toMatch(/not loaded|migration target/i);
			expect(await readFile(legacyPath, "utf8")).toContain("Legacy prompt.");
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousAgentDir === undefined) delete process.env.ICE_CODING_AGENT_DIR;
			else process.env.ICE_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("rejects untrusted project roles while global definitions win name collisions", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(cwd, ".ice", "agents"), { recursive: true });
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(cwd, ".ice", "agents", "project-only.md"),
			"---\nname: project-only\ndescription: Project-only role\n---\nProject prompt.\n",
		);
		await writeFile(
			join(agentDir, "agents", "explore.md"),
			"---\nname: explore\ndescription: Shadow role\n---\nShadow prompt.\n",
		);
		await mkdir(join(cwd, ".ice", "agents"), { recursive: true }).catch(() => {});
		await writeFile(
			join(cwd, ".ice", "agents", "explore.md"),
			"---\nname: explore\ndescription: Project role\n---\nProject prompt.\n",
		);

		expect(() =>
			resolveSubagentProfileResolution("project-only", { cwd, agentDir, projectTrusted: false }),
		).toThrowError(/project trust/i);
		const shadowed = resolveSubagentProfileResolution("explore", { cwd, agentDir, projectTrusted: true });
		expect(shadowed).toMatchObject({
			source: "user",
			description: "Shadow role",
			systemPrompt: "Shadow prompt.",
		});
		expect(shadowed.diagnostics?.join("\n")).toMatch(/shadowed trusted project definition/);
	});

	it("imports Ruflo agents recursively into namespaced trusted profiles", async () => {
		const cwd = await createWorkspace();
		const source = await mkdtemp(join(tmpdir(), "ice-ruflo-pack-"));
		const agentRoot = await mkdtemp(join(tmpdir(), "ice-ruflo-agent-root-"));
		tempDirs.push(source, agentRoot);
		await mkdir(join(source, ".claude", "agents", "analysis"), { recursive: true });
		await mkdir(join(source, ".claude", "agents", "development"), { recursive: true });
		await writeFile(
			join(source, ".claude", "agents", "analysis", "analyze-code-quality.md"),
			"---\nname: code-analyzer\ndescription: Analyze code quality.\ntools: [read, grep, find]\nmodel: source/pinned\n---\nInspect the repository and report evidence.\n",
		);
		await writeFile(
			join(source, ".claude", "agents", "development", "code-reviewer.md"),
			"---\nname: code-reviewer\ndescription: Review code.\n---\nReview only the approved scope.\n",
		);
		await writeFile(join(source, ".claude", "agents", "broken.md"), "not frontmatter\n");

		const imported = importRufloAgentPack(source, { targetDir: join(agentRoot, "agents") });
		expect(imported.imported).toEqual(["ruflo-code-analyzer", "ruflo-code-reviewer"]);
		expect(imported.skipped).toEqual([
			{ path: ".claude/agents/broken.md", reason: "missing frontmatter name and description" },
		]);
		const importedProfile = await readFile(join(agentRoot, "agents", "ruflo-code-analyzer.md"), "utf8");
		expect(importedProfile).not.toMatch(/^model:/m);
		const analyzer = resolveSubagentProfileResolution("ruflo-code-analyzer", { cwd, agentDir: agentRoot });
		expect(analyzer).toMatchObject({
			name: "ruflo-code-analyzer",
			source: "user",
			unsafeHostExec: true,
			tools: ["read", "grep", "find"],
		});
		const profiles = listSubagentProfiles({ cwd, agentDir: agentRoot });
		expect(profiles.map((profile) => profile.name)).toEqual(["ruflo-code-analyzer", "ruflo-code-reviewer"].sort());
		expect(profiles.find((profile) => profile.name === "ruflo-code-analyzer")).toMatchObject({
			source: "user",
			unsafeHostExec: true,
		});
		expect(suggestSubagentProfiles("code-analyzr", { cwd, agentDir: agentRoot })).toContain("ruflo-code-analyzer");
	});

	it("requires project trust for selected project resources and rejects outside paths", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(cwd, ".ice", "skills", "project-skill"), { recursive: true });
		await mkdir(join(cwd, ".ice", "prompts"), { recursive: true });
		await writeFile(
			join(cwd, ".ice", "skills", "project-skill", "SKILL.md"),
			"---\nname: project-skill\ndescription: Project skill.\n---\nProject.\n",
		);
		await writeFile(join(cwd, ".ice", "prompts", "project-prompt.md"), "Project prompt.\n");
		await writeFile(join(cwd, "project-context.md"), "Project context.\n");
		await writeFile(join(agentDir, "auth.json"), "credential secret.\n");
		expect(() =>
			resolveSubagentResources({ context: [join(agentDir, "auth.json")] }, { cwd, agentDir, projectTrusted: false }),
		).toThrowError(/resource root|outside approved/i);
		expect(() =>
			resolveSubagentResources({ skills: ["project-skill"] }, { cwd, agentDir, projectTrusted: false }),
		).toThrowError(/project trust/i);
		expect(() =>
			resolveSubagentResources({ prompts: ["project-prompt"] }, { cwd, agentDir, projectTrusted: false }),
		).toThrowError(/project trust/i);
		expect(() =>
			resolveSubagentResources({ context: ["project-context.md"] }, { cwd, agentDir, projectTrusted: false }),
		).toThrowError(/project trust/i);
		const trusted = resolveSubagentResources({ skills: ["project-skill"] }, { cwd, agentDir, projectTrusted: true });
		expect(trusted.skills[0]?.source).toBe("project");
		expect(() =>
			resolveSubagentResources({ context: ["../outside.md"] }, { cwd, agentDir, projectTrusted: true }),
		).toThrowError(/outside/i);
	});

	it("rejects role and resource symlink escapes", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		const outside = await mkdtemp(join(tmpdir(), "ice-subagents-outside-"));
		tempDirs.push(agentDir, outside);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await mkdir(join(agentDir, "skills"), { recursive: true });
		await mkdir(join(outside, "skills", "escape"), { recursive: true });
		await writeFile(join(outside, "escape.md"), "---\nname: escape\ndescription: Outside role.\n---\nOutside.\n");
		await writeFile(
			join(outside, "skills", "escape", "SKILL.md"),
			"---\nname: escape\ndescription: Outside skill.\n---\nOutside.\n",
		);
		await symlink(join(outside, "escape.md"), join(agentDir, "agents", "escape.md"));
		await symlink(join(outside, "skills", "escape"), join(agentDir, "skills", "escape"), "dir");
		expect(() => resolveSubagentProfileResolution("escape", { cwd, agentDir })).toThrowError(/escapes/i);
		expect(() => resolveSubagentResources({ skills: ["escape"] }, { cwd, agentDir })).toThrowError(/escapes/i);
	});

	it("normalizes configurable roles into a trusted launch contract", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await mkdir(join(agentDir, "skills", "review-skill"), { recursive: true });
		await mkdir(join(agentDir, "prompts"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "security-review.md"),
			"---\nname: security-review\ndescription: User security review\ntools:\n  - read\n  - grep\nskills:\n  - review-skill\nprompts:\n  - review-checklist\n---\nReview only.\n",
		);
		await writeFile(
			join(agentDir, "skills", "review-skill", "SKILL.md"),
			"---\nname: review-skill\ndescription: Review skill.\n---\nSkill.\n",
		);
		await writeFile(join(agentDir, "prompts", "review-checklist.md"), "Checklist.\n");

		const normalized = normalizeSubagentRequest(
			{ ...request(cwd, "security-review"), resources: { context: [] } },
			cwd,
			{ agentDir, projectTrusted: false },
		);
		expect(normalized.profile).toMatchObject({ name: "security-review", source: "user" });
		expect(normalized.role).toBe("security-review");
		expect(normalized.resources.skills[0]?.name).toBe("review-skill");
		expect(normalized.resources.prompts[0]?.name).toBe("review-checklist");
		expect(normalized.projectTrusted).toBe(false);
	});

	it("normalizes legacy context and explicit packet items into one immutable handoff", async () => {
		const cwd = await createWorkspace();
		const input = {
			items: [
				{ id: "fact", kind: "verified_fact" as const, content: "Only the selected fact." },
				{ id: "evidence", kind: "evidence_ref" as const, content: "src/auth.ts" },
			],
		};
		const normalized = normalizeSubagentRequest(
			{ ...request(cwd), context: "Legacy parent note.", contextPacket: input },
			cwd,
		);
		expect(normalized.contextPacket.items.map((item) => item.id)).toEqual(["parent-context", "fact", "evidence"]);
		expect(normalized.contextPacket.items.map((item) => item.kind)).toEqual([
			"parent_note",
			"verified_fact",
			"evidence_ref",
		]);
		expect(normalized.contextPacket.totalBytes).toBe(
			normalized.contextPacket.items.reduce((total, item) => total + item.bytes, 0),
		);
		input.items[0]!.content = "Mutated after normalization.";
		const prompt = buildSubagentPrompt(normalized);
		expect(prompt).toContain("Only the selected fact.");
		expect(prompt).toContain("Legacy parent note.");
		expect(prompt).not.toContain("Mutated after normalization.");
		expect(Object.isFrozen(normalized.contextPacket)).toBe(true);
	});

	it("rejects a changed configurable role before child launch", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		const rolePath = join(agentDir, "agents", "security-review.md");
		await writeFile(rolePath, "---\nname: security-review\ndescription: User security review\n---\nOriginal.\n");
		const normalized = normalizeSubagentRequest(request(cwd, "security-review"), cwd, { agentDir });
		await writeFile(rolePath, "---\nname: security-review\ndescription: Changed security review\n---\nChanged.\n");
		expect(() => revalidateSubagentProfile(normalized.profile)).toThrowError(/hash/i);
	});

	it("clamps profile thinking defaults on routes without reasoning metadata", async () => {
		const cwd = await createWorkspace();
		const normalized = normalizeSubagentRequest(request(cwd), cwd);
		expect(normalized.executionThinkingExplicit).toBe(false);
		const faux = registerFauxProvider();
		// Faux routes expose no reasoning metadata, so the self default
		// ("medium") clamps instead of consuming a child run.
		expect(resolveSubagentThinkingLevel(normalized.execution.thinking, faux.getModel())).toBe("off");
	});

	it("uses a self-delegation structured report contract with findings", async () => {
		const cwd = await createWorkspace();
		const reviewRequest = normalizeSubagentRequest(
			{ ...request(cwd), task: "Review security.", outputSchema: { type: "object", additionalProperties: false } },
			cwd,
		);
		expect(buildSubagentPrompt(reviewRequest)).toContain('"findings"');
		expect(reviewRequest.agentKind).toBe("self");
	});

	it("rejects resolved reviewer tasks that do not use self-delegation", async () => {
		const cwd = await createWorkspace();
		const fileAgentDir = await mkdtemp(join(tmpdir(), "ice-subagents-file-review-agent-"));
		tempDirs.push(fileAgentDir);
		await mkdir(join(fileAgentDir, "agents"), { recursive: true });
		await writeFile(
			join(fileAgentDir, "agents", "file-reviewer.md"),
			"---\nname: file-reviewer\ndescription: File reviewer\ntools: read\n---\nReview files.\n",
		);
		const fileRequest = normalizeSubagentRequest(
			{
				parentSessionId: "parent-1",
				role: "file-reviewer",
				task: "Review files.",
				scope: { roots: ["src"] },
				cwd,
			},
			cwd,
			{ agentDir: fileAgentDir },
		);
		const invalidTask = { id: "not-review", request: fileRequest, dimension: "security" as const };
		await expect(
			runResolvedReviewBatch([invalidTask], ["delegate", "read"], {
				runResolved: async () => batchResult(invalidTask),
			}),
		).rejects.toThrowError(/self-delegation/);
	});

	it("rejects changed profile resources during preflight before worker one", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		const rolePath = join(agentDir, "agents", "configured.md");
		await writeFile(rolePath, "---\nname: configured\ndescription: Configured role\n---\nOriginal.\n");
		const normalized = normalizeSubagentRequest({ ...request(cwd, "configured"), task: "Inspect.", cwd }, cwd, {
			agentDir,
		});
		await writeFile(rolePath, "---\nname: configured\ndescription: Changed role\n---\nChanged.\n");
		let calls = 0;
		await expect(
			runResolvedSubagentBatch([{ id: "changed", request: normalized }], ["delegate", "read"], {
				runResolved: async () => {
					calls++;
					return batchResult({ id: "changed", request: normalized });
				},
			}),
		).rejects.toThrowError(/hash changed/i);
		expect(calls).toBe(0);
	});

	it("exposes bounded configurable role and resource selections", () => {
		const registerTool = vi.fn();
		iceSubagents({ on: vi.fn(), registerTool } as unknown as ExtensionAPI);
		const tool = registerTool.mock.calls.find((call) => call[0]?.name === "delegate")?.[0];
		expect(tool.parameters).toMatchObject({
			properties: {
				role: { type: "string" },
				contextPacket: { type: "object" },
				resources: { type: "object" },
			},
		});
	});

	it("runs a selected user role through delegate with launch provenance", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await mkdir(join(agentDir, "skills", "review-skill"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "configured.md"),
			"---\nname: configured\ndescription: Configured role\ntools: read\n---\nConfigured role.\n",
		);
		await writeFile(
			join(agentDir, "skills", "review-skill", "SKILL.md"),
			"---\nname: review-skill\ndescription: Selected.\n---\nSelected.\n",
		);
		const faux = registerFauxProvider();
		const previousAgentDir = process.env.ICE_CODING_AGENT_DIR;
		process.env.ICE_CODING_AGENT_DIR = agentDir;
		try {
			faux.setResponses([fauxAssistantMessage('{"summary":"configured fact","evidence":{"paths":["src"]}}')]);
			const authStorage = AuthStorage.inMemory();
			await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
			const modelRuntime = await ModelRuntime.create({
				credentials: authStorage,
				modelsPath: join(cwd, "models.json"),
			});
			const model = faux.getModel();
			modelRuntime.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				api: model.api,
				models: [model],
			});
			const registerTool = vi.fn();
			iceSubagents({
				on: vi.fn(),
				getActiveTools: () => ["delegate", "read"],
				registerTool,
			} as unknown as ExtensionAPI);
			const tool = registerTool.mock.calls.find((call) => call[0]?.name === "delegate")?.[0];
			const updates: unknown[] = [];
			const result = await tool.execute(
				"delegate-call",
				{
					role: "configured",
					task: "Trace the model runtime.",
					scope: { roots: ["src"] },
					resources: { skills: ["review-skill"] },
				},
				undefined,
				(update: unknown) => updates.push(update),
				{
					cwd,
					model,
					scopedModels: [],
					isProjectTrusted: () => false,
					modelRegistry: new ModelRegistry(modelRuntime),
					sessionManager: { getSessionId: () => "parent-1" },
				} as unknown as ExtensionContext,
			);
			expect(result).toMatchObject({ isError: false, details: { launch: { profile: { source: "user" } } } });
			expect(
				updates.some(
					(update) =>
						typeof update === "object" &&
						update !== null &&
						"details" in update &&
						(update as { details?: { type?: string } }).details?.type === "subagent_progress",
				),
			).toBe(true);
			expect(result.details.launch.resources.skills[0]).toMatchObject({
				name: "review-skill",
				source: "user",
			});
		} finally {
			if (previousAgentDir === undefined) delete process.env.ICE_CODING_AGENT_DIR;
			else process.env.ICE_CODING_AGENT_DIR = previousAgentDir;
			faux.unregister();
		}
	});
});

describe("ICE file/self delegation plan coverage", () => {
	it("resolves self-delegation without a file and rejects delegation-tool inheritance", async () => {
		const cwd = await createWorkspace();
		const profile = resolveSelfSubagentProfile({
			cwd,
			instructions: "Inspect the approved scope and report evidence.",
			capabilities: ["read", "grep"],
		});
		expect(profile).toMatchObject({ name: "self", source: "self", selfDelegated: true });
		expect(() =>
			resolveSelfSubagentProfile({ cwd, instructions: "Inspect.", capabilities: ["read", "delegate"] }),
		).toThrowError(/delegation/i);
		expect(() => resolveSelfSubagentProfile({ cwd, instructions: "   " })).toThrowError(
			/bounded parent instructions/i,
		);
		const normalized = normalizeSubagentRequest(request(cwd), cwd);
		expect(normalized.agentKind).toBe("self");
		expect(normalized.profile.source).toBe("self");
	});
});
