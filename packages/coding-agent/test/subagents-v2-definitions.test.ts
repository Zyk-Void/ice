import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_AGENT_NAMES, getBuiltinAgentDefinitions } from "../src/subagents/definitions/builtin.ts";
import { findProjectAgentDirectories, listAgentMarkdownFiles } from "../src/subagents/definitions/discover.ts";
import {
	callableAgentDefinitions,
	computeAgentListingDelta,
	renderAgentListingMessage,
} from "../src/subagents/definitions/listing.ts";
import { AgentDefinitionCache, loadAgentDefinitions } from "../src/subagents/definitions/load.ts";
import {
	parseClaudeCompatAgentMarkdown,
	parseJsonAgentDefinitions,
	parseNativeAgentMarkdown,
} from "../src/subagents/definitions/parse.ts";
import { NativeAgentFrontmatterSchema, type ResolvedAgentDefinition } from "../src/subagents/definitions/schema.ts";

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ice-v2-defs-")));
	temps.push(dir);
	return dir;
}

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function agent(name: string, description = `${name} agent`, extra = ""): string {
	return `---\nname: ${name}\ndescription: ${description}\n${extra}---\nYou are ${name}.\n`;
}

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
}

function initRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
}

describe("subagent V2 definition parsing", () => {
	it("ignores Markdown without a frontmatter name and reports named invalid files", () => {
		expect(parseNativeAgentMarkdown("# Notes\nreference doc", "user", "/a/notes.md").kind).toBe("not-agent");
		expect(parseNativeAgentMarkdown("---\ntitle: x\n---\nbody", "user", "/a/x.md").kind).toBe("not-agent");
		const invalid = parseNativeAgentMarkdown("---\nname: x\n---\nbody", "user", "/a/x.md");
		expect(invalid).toMatchObject({ kind: "invalid", issue: { name: "x", availability: "invalid" } });
	});

	it("uses the frontmatter name as identity regardless of filename", () => {
		const parsed = parseNativeAgentMarkdown(agent("security-review"), "project", "/p/.ice/agents/sec.md");
		expect(parsed).toMatchObject({
			kind: "agent",
			definition: { name: "security-review", prompt: "You are security-review." },
		});
	});

	it("names the V2 replacement for removed legacy keys", () => {
		const parsed = parseNativeAgentMarkdown(
			agent("worker", "w", "model: a/b\nfallbackModel: c/d\nthinkingLevel: high\n"),
			"user",
			"/u/worker.md",
		);
		expect(parsed.kind).toBe("invalid");
		const diagnostics = parsed.kind === "invalid" ? parsed.issue.diagnostics.join("\n") : "";
		expect(diagnostics).toContain('"fallbackModel" was removed; use model: [primary, fallback, inherit]');
		expect(diagnostics).toContain('"thinkingLevel" was removed; use thinking');
	});

	it("normalizes a comma tool string and accepts an ordered model list", () => {
		const parsed = parseNativeAgentMarkdown(
			agent("explore", "e", "tools: read, grep, find\nmodel: [a/b, c/d, inherit]\n"),
			"user",
			"/u/explore.md",
		);
		expect(parsed).toMatchObject({
			kind: "agent",
			definition: { fields: { tools: ["read", "grep", "find"], model: ["a/b", "c/d", "inherit"] } },
		});
	});

	it("parses JSON definition maps and rejects bad names or missing prompts", () => {
		const { definitions, issues } = parseJsonAgentDefinitions(
			{
				docs: { description: "d", prompt: "p" },
				"Bad Name": { description: "d", prompt: "p" },
				noprompt: { description: "d" },
			},
			"user-settings",
			"settings",
		);
		expect(definitions.map((definition) => definition.name)).toEqual(["docs"]);
		expect(issues.map((issue) => issue.sourcePath)).toEqual(["settings.Bad Name", "settings.noprompt"]);
	});

	it("maps Claude compat fields and never raises authority", () => {
		const content =
			"---\nname: reviewer\ndescription: r\ntools: Read, Grep, Glob, Bash\nmodel: sonnet\npermissionMode: acceptEdits\nmemory: user\ncolor: red\n---\nReview.\n";
		const unmapped = parseClaudeCompatAgentMarkdown(content, "/p/.claude/agents/r.md", {});
		expect(unmapped).toMatchObject({
			kind: "agent",
			definition: { limited: true, fields: { tools: ["read", "grep", "find", "bash"], color: "error" } },
		});
		const definition = unmapped.kind === "agent" ? unmapped.definition : undefined;
		expect(definition?.fields.permissionMode).toBeUndefined();
		expect(definition?.diagnostics.join("\n")).toMatch(/permissionMode "acceptEdits" ignored/);
		expect(definition?.diagnostics.join("\n")).toMatch(/"memory" is not supported/);
		const mapped = parseClaudeCompatAgentMarkdown(content, "/p/.claude/agents/r.md", {
			sonnet: "anthropic/claude-sonnet-5-5",
		});
		expect(mapped).toMatchObject({
			kind: "agent",
			definition: { limited: false, fields: { model: "anthropic/claude-sonnet-5-5" } },
		});
	});
});

describe("subagent V2 agent directory discovery", () => {
	it("walks from cwd to the git root, most specific first, and never above it", () => {
		const root = temp();
		write(join(root, ".ice/agents/outside.md"), agent("outside"));
		const repo = join(root, "repo");
		initRepo(repo);
		write(join(repo, ".ice/agents/top.md"), agent("top"));
		write(join(repo, "pkg/.ice/agents/near.md"), agent("near"));
		const dirs = findProjectAgentDirectories({ cwd: join(repo, "pkg"), home: "/nonexistent-home" });
		expect(dirs).toEqual([join(repo, "pkg/.ice/agents"), join(repo, ".ice/agents")]);
	});

	it("does not let a nested repository truncate the project walk", () => {
		const project = temp();
		initRepo(project);
		write(join(project, ".ice/agents/a.md"), agent("a"));
		const nested = join(project, "vendor/lib");
		initRepo(nested);
		write(join(nested, ".ice/agents/b.md"), agent("b"));
		expect(findProjectAgentDirectories({ cwd: nested, projectRoot: project, home: "/x" })).toEqual([
			join(nested, ".ice/agents"),
			join(project, ".ice/agents"),
		]);
		expect(findProjectAgentDirectories({ cwd: nested, home: "/x" })).toEqual([join(nested, ".ice/agents")]);
	});

	it("falls back to the main checkout when a linked worktree has no agents directory", () => {
		const main = temp();
		initRepo(main);
		write(join(main, "README.md"), "x");
		git(main, "add", "README.md");
		git(main, "commit", "-q", "-m", "init");
		write(join(main, ".ice/agents/shared.md"), agent("shared"));
		const linked = join(temp(), "wt");
		git(main, "worktree", "add", "-q", "--detach", linked);
		expect(findProjectAgentDirectories({ cwd: linked, home: "/x" })).toEqual([join(main, ".ice/agents")]);
		write(join(linked, ".ice/agents/own.md"), agent("own"));
		expect(findProjectAgentDirectories({ cwd: linked, home: "/x" })).toEqual([join(linked, ".ice/agents")]);
	});

	it("lists recursively, dedupes by inode, and skips escaping symlinks", () => {
		const root = temp();
		const agents = join(root, "agents");
		write(join(agents, "review/security.md"), agent("security"));
		write(join(agents, "a.md"), agent("a"));
		symlinkSync(join(agents, "a.md"), join(agents, "alias.md"));
		write(join(root, "secret.md"), agent("secret"));
		symlinkSync(join(root, "secret.md"), join(agents, "escape.md"));
		const result = listAgentMarkdownFiles([agents]);
		expect(result.files.map((file) => file.path.slice(agents.length + 1)).sort()).toEqual([
			"a.md",
			"review/security.md",
		]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toContain(
			"symlink target escapes the agents directory; skipped",
		);
	});
});

describe("subagent V2 definition loading and precedence", () => {
	function setup() {
		const home = temp();
		const user = join(home, "agents");
		const repo = join(temp(), "repo");
		initRepo(repo);
		return { home, user, repo };
	}

	it("ships the built-ins with no spawns and a worktree worker", () => {
		const builtins = getBuiltinAgentDefinitions();
		expect(BUILTIN_AGENT_NAMES).toEqual(["general", "explore", "plan", "review", "worker"]);
		for (const definition of builtins) {
			expect(definition.fields.spawns).toEqual([]);
			expect(
				Value.Check(NativeAgentFrontmatterSchema, {
					name: definition.name,
					description: definition.description,
					...definition.fields,
				}),
			).toBe(true);
		}
		expect(builtins.find((definition) => definition.name === "worker")?.fields.isolation).toBe("worktree");
	});

	it("applies builtin < user < trusted project < flag < managed, keeping shadow history", () => {
		const { home, user, repo } = setup();
		const managed = join(temp(), "managed");
		write(join(user, "explore.md"), agent("explore", "user explore"));
		write(join(user, "solo.md"), agent("solo", "user solo"));
		write(join(repo, ".ice/agents/explore.md"), agent("explore", "project explore"));
		write(join(repo, ".ice/agents/locked.md"), agent("locked", "project locked"));
		write(join(managed, "locked.md"), agent("locked", "managed locked"));
		const loaded = loadAgentDefinitions({
			cwd: repo,
			userAgentsDir: user,
			projectTrusted: true,
			managedAgentsDir: managed,
			flagAgents: {
				solo: { description: "flag solo", prompt: "p" },
				locked: { description: "flag locked", prompt: "p" },
			},
			disabledAgents: ["locked", "plan"],
			home,
		});
		expect(loaded.active.get("explore")?.description).toBe("project explore");
		expect(loaded.active.get("solo")?.description).toBe("flag solo");
		expect(loaded.active.get("locked")?.description).toBe("managed locked");
		expect(loaded.active.has("plan")).toBe(false);
		expect(loaded.disabled.map((definition) => definition.name)).toEqual(["plan"]);
		const shadowedExplore = loaded.shadowed.filter((entry) => entry.definition.name === "explore");
		expect(shadowedExplore.map((entry) => entry.definition.source)).toEqual(["builtin", "user"]);
	});

	it("prefers the project directory closest to cwd", () => {
		const { home, user, repo } = setup();
		write(join(repo, ".ice/agents/x.md"), agent("x", "root x"));
		write(join(repo, "pkg/.ice/agents/x.md"), agent("x", "pkg x"));
		const loaded = loadAgentDefinitions({ cwd: join(repo, "pkg"), userAgentsDir: user, projectTrusted: true, home });
		expect(loaded.active.get("x")?.description).toBe("pkg x");
	});

	it("reports untrusted project definitions by name only and never activates them", () => {
		const { home, user, repo } = setup();
		write(join(repo, ".ice/agents/general.md"), agent("general", "evil general"));
		const loaded = loadAgentDefinitions({
			cwd: repo,
			userAgentsDir: user,
			projectTrusted: false,
			settingsAgents: { project: { sneaky: { description: "d", prompt: "p" } } },
			home,
		});
		expect(loaded.active.get("general")?.source).toBe("builtin");
		expect(loaded.active.has("sneaky")).toBe(false);
		expect(loaded.issues.filter((issue) => issue.availability === "untrusted").map((issue) => issue.name)).toEqual([
			"general",
			"sneaky",
		]);
	});

	it("loads .claude/agents only when compat is enabled, below native project definitions", () => {
		const { home, user, repo } = setup();
		write(join(repo, ".claude/agents/r.md"), "---\nname: r\ndescription: claude r\n---\nReview.\n");
		write(join(repo, ".claude/agents/explore.md"), "---\nname: explore\ndescription: claude explore\n---\nE.\n");
		write(join(repo, ".ice/agents/explore.md"), agent("explore", "native explore"));
		const off = loadAgentDefinitions({ cwd: repo, userAgentsDir: user, projectTrusted: true, home });
		expect(off.active.has("r")).toBe(false);
		const on = loadAgentDefinitions({
			cwd: repo,
			userAgentsDir: user,
			projectTrusted: true,
			home,
			compat: { claudeAgents: true },
		});
		expect(on.active.get("r")?.source).toBe("project-compat");
		expect(on.active.get("explore")?.description).toBe("native explore");
	});

	it("reloads only when the cache key changes", () => {
		const { home, user, repo } = setup();
		const cache = new AgentDefinitionCache();
		const load = () => loadAgentDefinitions({ cwd: repo, userAgentsDir: user, projectTrusted: true, home });
		const first = cache.get("k1", load);
		write(join(user, "late.md"), agent("late"));
		expect(cache.get("k1", load)).toBe(first);
		expect(cache.get("k2", load).active.has("late")).toBe(true);
	});
});

describe("subagent V2 model agent listing", () => {
	const def = (
		name: string,
		fields: ResolvedAgentDefinition["fields"] = {},
		hash = name,
	): ResolvedAgentDefinition => ({
		name,
		description: `${name} does things`,
		prompt: "p",
		fields,
		source: "user",
		sourceHash: hash,
		diagnostics: [],
		limited: false,
	});

	it("advertises only visible, unlimited agents whose MCP servers are present", () => {
		const active = new Map(
			[
				def("a"),
				def("hidden", { hidden: true }),
				{ ...def("limited"), limited: true },
				def("gh", { requiredMcpServers: ["github"] }),
			].map((definition) => [definition.name, definition]),
		);
		expect(callableAgentDefinitions(active).map((definition) => definition.name)).toEqual(["a"]);
		expect(callableAgentDefinitions(active, ["my-github-server"]).map((definition) => definition.name)).toEqual([
			"a",
			"gh",
		]);
	});

	it("sends a full list first, then only changes, and nothing when unchanged", () => {
		const first = computeAgentListingDelta(undefined, [
			def("a", { tools: ["read"] }),
			def("b", { disallowedTools: ["bash"] }),
		]);
		const text = renderAgentListingMessage(first) ?? "";
		expect(text).toContain("- a: a does things (Tools: read)");
		expect(text).toContain("- b: b does things (Tools: All tools except bash)");
		const same = computeAgentListingDelta(first.next, [
			def("a", { tools: ["read"] }),
			def("b", { disallowedTools: ["bash"] }),
		]);
		expect(renderAgentListingMessage(same)).toBeUndefined();
		const update = computeAgentListingDelta(first.next, [def("a", {}, "a2"), def("c")]);
		expect(update).toMatchObject({ full: false, removed: ["b"] });
		expect(update.added.map((definition) => definition.name)).toEqual(["c"]);
		expect(update.changed.map((definition) => definition.name)).toEqual(["a"]);
	});

	it("stays within the byte budget", () => {
		const many = Array.from({ length: 60 }, (_, index) => ({
			...def(`agent-${index}`),
			description: "x".repeat(400),
		}));
		const text = renderAgentListingMessage(computeAgentListingDelta(undefined, many), 2048) ?? "";
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048);
		expect(text).toContain("agent-59");
	});
});
