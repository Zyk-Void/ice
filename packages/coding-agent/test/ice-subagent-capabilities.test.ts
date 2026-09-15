import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@zykairotis/ice-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { loadSkillsFromDir } from "../src/core/skills.ts";
import {
	boundedIceToolOutput,
	createIceDelegableToolDefinitions,
	getIceDelegableTools,
	type IceDelegableTool,
	registerIceDelegableTool,
	resolveIceDelegableTools,
} from "../src/ice-subagent-capabilities.ts";
import {
	createNativeSubagentSession,
	NativeSubagentRunner,
	normalizeSubagentRequest,
	resolveSelfSubagentProfile,
	revalidateSubagentResources,
	subagentMcpToolName,
} from "../src/ice-subagents.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace() {
	const cwd = mkdtempSync(join(tmpdir(), "ice-capabilities-"));
	dirs.push(cwd);
	mkdirSync(join(cwd, "src"));
	return { cwd, agentDir: join(cwd, "agent") };
}
function definition(overrides: Partial<IceDelegableTool> = {}): IceDelegableTool {
	return {
		adapterId: "test/lookup",
		name: "lookup",
		origin: "test/lookup",
		access: "read-only",
		childSafe: true,
		description: "Look up a bounded fact.",
		parameters: Type.Object({ query: Type.String() }, { additionalProperties: false }),
		execute: vi.fn(async () => ({ answer: "fact" })),
		...overrides,
	};
}
const context = { parentSessionId: "parent", runId: "child", cwd: "/fixture", scopeRoots: ["/fixture/src"] };

function select(owner: object, requested = ["lookup"], allowMutation = false) {
	return resolveIceDelegableTools({
		available: getIceDelegableTools(owner),
		parentActiveTools: requested,
		requested,
		allowMutation,
	});
}

describe("parent-owned delegable capabilities", () => {
	it("requires explicit registration and isolates owners", () => {
		const owner = {};
		registerIceDelegableTool(owner, definition());
		expect(select(owner).map((tool) => tool.name)).toEqual(["lookup"]);
		expect(getIceDelegableTools({})).toEqual([]);
		expect(() => select({}, ["lookup"])).toThrow(/no child-safe/);
		expect(() => registerIceDelegableTool(owner, definition())).toThrow(/Duplicate/);
	});
	it("selects profile adapter IDs independently from model-visible tool names", () => {
		const owner = {};
		registerIceDelegableTool(owner, definition({ adapterId: "fixture/search", name: "lookup" }));
		registerIceDelegableTool(owner, definition({ adapterId: "fixture/search", name: "lookup_extra" }));
		const selected = resolveIceDelegableTools({
			available: getIceDelegableTools(owner),
			parentActiveTools: ["lookup", "lookup_extra"],
			requested: [],
			requestedAdapterIds: ["fixture/search"],
			allowMutation: false,
		});
		expect(selected.map((tool) => tool.name)).toEqual(["lookup", "lookup_extra"]);
		expect(selected.every((tool) => tool.adapterId === "fixture/search")).toBe(true);
		expect(() =>
			resolveIceDelegableTools({
				available: getIceDelegableTools(owner),
				parentActiveTools: ["lookup", "lookup_extra"],
				requested: [],
				requestedAdapterIds: ["fixture/missing"],
				allowMutation: false,
			}),
		).toThrow(/no child-safe parent registration/);
	});
	it("requires explicit adapter identity instead of deriving it from origin", () => {
		expect(() => registerIceDelegableTool({}, definition({ adapterId: "invalid adapter id" }))).toThrow(/adapter ID/);
	});
	it("rejects built-in replacements, recursion, management, invalid schemas, and missing scope guarantees", () => {
		for (const name of ["read", "delegate", "manage_subagent", "delegate_async", "shutdown"]) {
			expect(() => registerIceDelegableTool({}, definition({ name }))).toThrow();
		}
		expect(() => registerIceDelegableTool({}, definition({ childSafe: false as never }))).toThrow(/child-safe/);
		expect(() =>
			registerIceDelegableTool({}, definition({ parameters: { type: "object", $ref: "remote" } as never })),
		).toThrow(/references/);
	});
	it("narrows mutations and denies rather than manufacturing parent authority", () => {
		const owner = {};
		registerIceDelegableTool(owner, definition({ access: "mutation" }));
		expect(select(owner)).toEqual([]);
		expect(select(owner, ["lookup"], true)).toHaveLength(1);
		expect(
			resolveIceDelegableTools({
				available: getIceDelegableTools(owner),
				parentActiveTools: ["lookup"],
				requested: ["lookup"],
				denied: ["lookup"],
				allowMutation: true,
			}),
		).toEqual([]);
		expect(() =>
			resolveIceDelegableTools({
				available: getIceDelegableTools(owner),
				parentActiveTools: [],
				requested: ["lookup"],
				allowMutation: true,
			}),
		).toThrow(/parent/);
		const unknown = {};
		registerIceDelegableTool(unknown, definition({ access: "unknown" }));
		expect(() => select(unknown)).toThrow(/unknown access/);
	});
	it("pins registration identity and rejects revocation even after same-name replacement", async () => {
		const owner = {};
		const remove = registerIceDelegableTool(owner, definition());
		const selected = select(owner);
		remove();
		registerIceDelegableTool(owner, definition());
		expect(selected[0]!.isCurrent()).toBe(false);
		const tool = createIceDelegableToolDefinitions(selected, context)[0]!;
		await expect(tool.execute("call", { query: "q" }, undefined, undefined, {} as ExtensionContext)).rejects.toThrow(
			/revoked/,
		);
	});
	it("validates inputs and gives the adapter only an immutable child context", async () => {
		const execute = vi.fn(async (_params, ctx) => {
			expect(Object.isFrozen(ctx)).toBe(true);
			expect(Object.isFrozen(ctx.scopeRoots)).toBe(true);
			expect(ctx).not.toHaveProperty("sessionManager");
			return { token: "hidden", answer: "fact" };
		});
		const owner = {};
		registerIceDelegableTool(owner, definition({ execute }));
		const tool = createIceDelegableToolDefinitions(select(owner), context)[0]!;
		await expect(tool.execute("bad", { query: 3 }, undefined, undefined, {} as ExtensionContext)).rejects.toThrow(
			/invalid/,
		);
		expect(execute).not.toHaveBeenCalled();
		const result = await tool.execute("ok", { query: "q" }, undefined, undefined, {} as ExtensionContext);
		expect(JSON.stringify(result)).not.toContain("hidden");
		expect(JSON.stringify(result)).toContain("fact");
	});
	it("stops waiting when an already-dispatched adapter ignores cancellation", async () => {
		const owner = {};
		const controller = new AbortController();
		let started!: () => void;
		const dispatched = new Promise<void>((resolve) => {
			started = resolve;
		});
		registerIceDelegableTool(
			owner,
			definition({
				execute: async () => {
					started();
					return new Promise(() => {});
				},
			}),
		);
		const tool = createIceDelegableToolDefinitions(select(owner), context)[0]!;
		const pending = tool.execute(
			"cancel-running",
			{ query: "q" },
			controller.signal,
			undefined,
			{} as ExtensionContext,
		);
		await dispatched;
		controller.abort();
		await expect(pending).rejects.toThrow(/cancelled/);
	});
	it("does not dispatch after cancellation and preserves error results", async () => {
		const owner = {};
		const execute = vi.fn(async () => ({ isError: true, message: "rejected" }));
		registerIceDelegableTool(owner, definition({ execute }));
		const tool = createIceDelegableToolDefinitions(select(owner), context)[0]!;
		await expect(
			tool.execute("cancel", { query: "q" }, AbortSignal.abort(), undefined, {} as ExtensionContext),
		).rejects.toThrow(/cancelled/);
		expect(execute).not.toHaveBeenCalled();
		expect(await tool.execute("call", { query: "q" }, undefined, undefined, {} as ExtensionContext)).toMatchObject({
			isError: true,
		});
	});
	it("bounds multibyte and cyclic output while redacting nested secret keys", () => {
		const cyclic: Record<string, unknown> = { password: "hidden", nested: { apiKey: "hidden" }, message: "abc" };
		cyclic.self = cyclic;
		expect(boundedIceToolOutput(cyclic)).not.toContain("hidden");
		expect(boundedIceToolOutput(cyclic)).toContain("CIRCULAR");
		const text = boundedIceToolOutput("\u20ac".repeat(10000), 1024);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
		expect(text).not.toContain("\ufffd");
	});
	it("keeps MCP names distinct across underscore and truncation collisions", () => {
		expect(subagentMcpToolName("a_b/c")).not.toBe(subagentMcpToolName("a/b_c"));
		expect(subagentMcpToolName(`${"a".repeat(100)}/one`)).not.toBe(subagentMcpToolName(`${"a".repeat(100)}/two`));
		expect(subagentMcpToolName("server/tool").length).toBeLessThanOrEqual(64);
	});
});

describe("self snapshots and real native capability dispatch", () => {
	it("retains actual parent instructions and defaults to only eligible active tools", () => {
		const profile = resolveSelfSubagentProfile({
			cwd: "/tmp",
			parentSystemPrompt: "PARENT POLICY",
			instructions: "Inspect carefully",
			parentActiveTools: ["read", "delegate", "shutdown", "random"],
		});
		expect(profile.systemPrompt).toContain("PARENT POLICY");
		expect(profile.systemPrompt).toContain("Inspect carefully");
		expect(profile.requestedTools).toEqual(["read"]);
		expect(() =>
			resolveSelfSubagentProfile({ cwd: "/tmp", parentSystemPrompt: "parent", capabilities: ["delegate"] }),
		).toThrow(/delegation/);
	});
	it("inherits skills only explicitly and detects changed bytes", () => {
		const { cwd, agentDir } = workspace();
		const skillDir = join(agentDir, "skills", "fixture");
		mkdirSync(skillDir, { recursive: true });
		const path = join(skillDir, "SKILL.md");
		writeFileSync(
			path,
			"---\nname: fixture\ndescription: Test skill\n---\nUse bash, but this is only instruction data.",
		);
		const skills = loadSkillsFromDir({ dir: join(agentDir, "skills"), source: "user" }).skills;
		const request = { parentSessionId: "parent", role: "self", task: "Inspect", scope: { roots: ["src"] } };
		const options = { agentDir, parentSystemPrompt: "parent", parentActiveTools: ["read"], parentSkills: skills };
		expect(normalizeSubagentRequest(request, cwd, options).resources.skills).toEqual([]);
		const inherited = normalizeSubagentRequest({ ...request, self: { inheritSkills: true } }, cwd, options);
		expect(inherited.resources.skills).toHaveLength(1);
		expect(inherited.profile.requestedTools).toEqual(["read"]);
		writeFileSync(path, "changed");
		expect(() => revalidateSubagentResources(inherited.resources)).toThrow();
	});
	it("exposes a registered external tool to the actual Ice loop and executes it once", async () => {
		const { cwd, agentDir } = workspace();
		const owner = {};
		const execute = vi.fn(async () => ({ answer: "fact" }));
		registerIceDelegableTool(owner, definition({ execute }));
		const request = normalizeSubagentRequest(
			{ parentSessionId: "parent", role: "self", task: "Inspect", scope: { roots: ["src"] } },
			cwd,
			{
				agentDir,
				parentSystemPrompt: "PARENT POLICY",
				parentActiveTools: ["lookup"],
				delegableTools: getIceDelegableTools(owner),
			},
		);
		const faux = registerFauxProvider();
		try {
			const credentials = AuthStorage.inMemory();
			await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux" }));
			const runtime = await ModelRuntime.create({ credentials, modelsPath: join(cwd, "models.json") });
			const model = faux.getModel();
			runtime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("lookup", { query: "q" })]),
				fauxAssistantMessage('{"summary":"fact","evidence":{"paths":["src"]}}'),
			]);
			const runner = new NativeSubagentRunner({ agentDir });
			const result = await runner.runResolved(request, ["delegate", "lookup"], { model, modelRuntime: runtime });
			expect(result.status).toBe("completed");
			expect(execute).toHaveBeenCalledOnce();
			await runner.shutdown();
		} finally {
			faux.unregister();
		}
	});
	it("permits an explicitly tool-free child without silently adding read tools", async () => {
		const { cwd, agentDir } = workspace();
		const request = normalizeSubagentRequest(
			{
				parentSessionId: "parent",
				role: "self",
				task: "Inspect supplied context",
				scope: { roots: ["src"] },
				execution: { tools: [] },
			},
			cwd,
			{ agentDir, parentSystemPrompt: "parent" },
		);
		let active: readonly string[] | undefined;
		await createNativeSubagentSession(
			{ request, parentActiveTools: ["delegate", "read"], agentDir },
			async (options) => {
				active = options.tools;
				return { session: { sessionId: "test", messages: [] } } as never;
			},
		);
		expect(active).toEqual([]);
	});
});
