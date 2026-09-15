import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@zykairotis/ice-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { registerIceDelegableTool } from "../src/ice-subagent-capabilities.ts";
import { registerIceSubagentHook } from "../src/ice-subagent-settings.ts";
import iceSubagents, {
	type IceSubagentMcpAdapter,
	NativeSubagentRunner,
	type NormalizedSubagentRequest,
	registerIceSubagentMcpAdapter,
	type SubagentResult,
	subagentMcpToolName,
} from "../src/ice-subagents.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function harness() {
	const cwd = mkdtempSync(join(tmpdir(), "ice-ready-"));
	cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	mkdirSync(join(cwd, "src"));
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	const faux = registerFauxProvider();
	cleanup.push(() => faux.unregister());
	const credentials = AuthStorage.inMemory();
	const model = faux.getModel();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux" }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: join(cwd, "models.json") });
	const primary = { ...model, id: "primary" };
	const fallback = { ...model, id: "fallback" };
	runtime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [model, primary, fallback],
	});
	const events = createEventBus();
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const entries: Array<Record<string, unknown>> = [];
	let active = [
		"delegate",
		"delegate_async",
		"delegate_batch",
		"review_batch",
		"read",
		"grep",
		"find",
		"ls",
		"lookup",
	];
	const settings = SettingsManager.inMemory({ ice: { subagents: { modelSelection: { mode: "configured" } } } });
	const api = {
		events,
		registerFlag() {},
		getFlag: () => false,
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand() {},
		on: (event: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), fn]);
		},
		getActiveTools: () => active,
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage() {},
	} as unknown as ExtensionAPI;
	iceSubagents(api, { agentDir, getIceMode: () => "plan" });
	const context = {
		cwd,
		mode: "rpc",
		hasUI: true,
		ui: { notify() {}, custom: async () => undefined },
		model,
		scopedModels: [],
		modelRegistry: new ModelRegistry(runtime),
		settingsManager: settings,
		isProjectTrusted: () => true,
		getSystemPrompt: () => "ACTUAL_PARENT_INSTRUCTIONS: only authorized work.",
		sessionManager: {
			getSessionId: () => "owner",
			getLeafId: () => "leaf",
			getEntries: () => entries,
			buildSessionContext: () => ({ messages: [] }),
		},
	} as unknown as ExtensionContext;
	const emit = async (type: string) => {
		for (const fn of handlers.get(type) ?? []) await fn({ type, reason: "startup" }, context);
	};
	await emit("session_start");
	cleanup.push(() => emit("session_shutdown"));
	const call = async (name: string, params: Record<string, unknown>, signal?: AbortSignal) =>
		tools.get(name)!.execute(`call-${Math.random()}`, params, signal, undefined, context) as unknown as Promise<{
			isError: boolean;
			content: Array<{ text: string }>;
			details: Record<string, any>;
		}>;
	const request = { role: "self", task: "Inspect the source", scope: { roots: ["src"] } };
	const file = (name: string, frontmatter: string) =>
		writeFileSync(
			join(agentDir, "agents", `${name}.md`),
			`---\nname: ${name}\ndescription: readiness fixture\ntools: read\n${frontmatter}\n---\nInspect source and preserve evidence.`,
		);
	return {
		cwd,
		agentDir,
		faux,
		runtime,
		model,
		primary,
		fallback,
		events,
		settings,
		context,
		entries,
		tools,
		call,
		request,
		file,
		setActive: (next: string[]) => {
			active = next;
		},
	};
}
const success = '{"summary":"verified fixture","evidence":{"paths":["src"]}}';
function startupFailure(request: NormalizedSubagentRequest): SubagentResult {
	return {
		runId: request.runId,
		parentSessionId: request.parentSessionId,
		profile: request.profile.name,
		source: request.profile.source,
		status: "failed",
		summary: "pre-effect startup failure",
		retrySafeStartup: true,
		observedTurns: 0,
		observedOutputBytes: 0,
		partial: false,
		diagnostics: [{ code: "child_startup_failure", message: "explicit transient startup", retryable: true }],
	};
}

describe("production file/self delegation acceptance", () => {
	it("uses real parent instructions automatically and preserves additive guidance", async () => {
		const h = await harness();
		let prompt = "";
		h.faux.setResponses([
			(ctx) => {
				prompt = ctx.systemPrompt ?? "";
				return fauxAssistantMessage(success);
			},
		]);
		const result = await h.call("delegate", { ...h.request, self: { instructions: "ADDITIONAL_TASK_GUIDANCE" } });
		expect(result.isError).toBe(false);
		expect(prompt).toContain("ACTUAL_PARENT_INSTRUCTIONS");
		expect(prompt).toContain("ADDITIONAL_TASK_GUIDANCE");
	});
	it("runs registered parent MCP tools for self with real schemas, hooks, and bounded output", async () => {
		const h = await harness();
		const dispatch = vi.fn(async () => ({ ok: true, api_key: "never-expose", body: "x".repeat(50000) }));
		const adapter: IceSubagentMcpAdapter = {
			listAuthorizedTools: () => [
				{
					selector: "docs/search",
					access: "read-only",
					parameters: Type.Object({ q: Type.String() }, { additionalProperties: false }),
					description: "Search documentation",
				},
			],
			dispatch,
		};
		cleanup.push(registerIceSubagentMcpAdapter(h.events, adapter));
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall(subagentMcpToolName("docs/search"), { q: "query" })]),
			fauxAssistantMessage(success),
		]);
		const result = await h.call("delegate", { ...h.request, self: { mcp: ["docs/search"] } });
		expect(result.isError).toBe(false);
		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch.mock.calls[0]?.slice(0, 3)).toEqual(["docs", "search", { q: "query" }]);
		expect(JSON.stringify(result)).not.toContain("never-expose");
	});
	it("enforces required MCP policy hooks before the adapter executes", async () => {
		const h = await harness();
		const dispatch = vi.fn(async () => ({ ok: true }));
		cleanup.push(
			registerIceSubagentMcpAdapter(h.events, {
				listAuthorizedTools: () => [
					{ selector: "docs/search", access: "read-only", parameters: Type.Object({ q: Type.String() }) },
				],
				dispatch,
			}),
		);
		h.settings.setIceSettingsValue("global", {
			subagents: { modelSelection: { mode: "configured" } },
			hooks: {
				enabled: true,
				definitions: [{ id: "mcp-gate", event: "subagent.beforeTool", kind: "in-process", required: true }],
			},
		});
		const gate = vi.fn(async () => ({ outcome: "deny" as const, reason: "MCP fixture policy denied" }));
		cleanup.push(registerIceSubagentHook(h.events, "mcp-gate", gate));
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall(subagentMcpToolName("docs/search"), { q: "query" })]),
			fauxAssistantMessage(success),
		]);
		await h.call("delegate", { ...h.request, self: { mcp: ["docs/search"] }, execution: { hooks: [] } });
		expect(gate).toHaveBeenCalledOnce();
		expect(dispatch).not.toHaveBeenCalled();
		expect(h.entries.some((entry) => JSON.stringify(entry).includes("mcp-gate"))).toBe(true);
	});
	it("fails missing schema, unknown classification and mutation MCP admission before dispatch", async () => {
		const h = await harness();
		for (const access of ["read-only", "unknown", "mutation"] as const) {
			const dispatch = vi.fn(async () => ({}));
			const remove = registerIceSubagentMcpAdapter(h.events, {
				listAuthorizedTools: () => [
					{ selector: "docs/search", access, ...(access === "read-only" ? {} : { parameters: Type.Object({}) }) },
				],
				dispatch,
			});
			const result = await h.call("delegate", { ...h.request, self: { mcp: ["docs/search"] } });
			expect(result.isError).toBe(true);
			expect(dispatch).not.toHaveBeenCalled();
			remove();
		}
	});
	it("executes external tool adapters through the facade and revokes removed parent tools", async () => {
		const h = await harness();
		const execute = vi.fn(async () => ({ fact: true }));
		cleanup.push(
			registerIceDelegableTool(h.events, {
				adapterId: "fixture/lookup",
				name: "lookup",
				origin: "fixture/lookup",
				access: "read-only",
				childSafe: true,
				description: "Lookup",
				parameters: Type.Object({}),
				execute,
			}),
		);
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("lookup", {})]), fauxAssistantMessage(success)]);
		expect((await h.call("delegate", h.request)).isError).toBe(false);
		expect(execute).toHaveBeenCalledOnce();
		h.setActive(["delegate", "read"]);
		expect((await h.call("delegate", { ...h.request, self: { capabilities: ["lookup"] } })).isError).toBe(true);
		expect(execute).toHaveBeenCalledOnce();
	});
	it("falls back during admission and records the unavailable primary", async () => {
		const h = await harness();
		h.file("pair", `model: ${h.model.provider}/absent\nfallbackModel: ${h.model.provider}/fallback`);
		h.faux.setResponses([fauxAssistantMessage(success)]);
		const result = await h.call("delegate", { ...h.request, role: "pair" });
		expect(result.isError).toBe(false);
		expect(result.details.launch.model).toContain("fallback");
		expect(result.details.launch.modelCandidateSkips[0].reason).toMatch(/catalog/);
	});
	it("uses a different configured model only after proven pre-effect startup failure", async () => {
		const h = await harness();
		h.file("pair", `model: ${h.model.provider}/primary\nfallbackModel: ${h.model.provider}/fallback`);
		h.faux.setResponses([fauxAssistantMessage(success)]);
		const original = NativeSubagentRunner.prototype.runResolved;
		const selected: string[] = [];
		vi.spyOn(NativeSubagentRunner.prototype, "runResolved").mockImplementation(async function (
			this: NativeSubagentRunner,
			request,
			tools,
			options,
		) {
			selected.push(options?.model?.id ?? "none");
			if (selected.length === 1) return startupFailure(request);
			return original.call(this, request, tools, options);
		});
		const result = await h.call("delegate", { ...h.request, role: "pair" });
		expect(selected).toEqual(["primary", "fallback"]);
		expect(result.isError).toBe(false);
		expect(result.details.launch.model).toContain("fallback");
	});
	it("never replays a runtime failure with a child identity even when marked retryable", async () => {
		const h = await harness();
		h.file("pair", `model: ${h.model.provider}/primary\nfallbackModel: ${h.model.provider}/fallback`);
		const spy = vi.spyOn(NativeSubagentRunner.prototype, "runResolved").mockImplementation(async (request) => ({
			...startupFailure(request),
			childSessionId: "effects-may-exist",
			observedTurns: 1,
		}));
		const result = await h.call("delegate", { ...h.request, role: "pair" });
		expect(result.isError).toBe(true);
		expect(spy).toHaveBeenCalledOnce();
	});
	it("captures parent route and capabilities in durable jobs and rejects catalog changes while queued", async () => {
		const h = await harness();
		const releases: Array<() => void> = [];
		const spy = vi.spyOn(NativeSubagentRunner.prototype, "runResolved").mockImplementation(async (request) => {
			await new Promise<void>((resolve) => releases.push(resolve));
			return {
				...startupFailure(request),
				retrySafeStartup: false,
				status: "completed",
				summary: "ok",
				diagnostics: [],
				evidence: { paths: ["src"] },
			};
		});
		const first = await h.call("delegate_async", h.request);
		await h.call("delegate_async", h.request);
		await h.call("delegate_async", h.request);
		await h.call("delegate_async", h.request);
		await vi.waitFor(() => expect(releases).toHaveLength(4));
		const queued = await h.call("delegate_async", h.request);
		expect(queued.details.accepted.status).toBe("queued");
		const inspect = await h.call("inspect_subagent_job", { jobId: first.details.accepted.jobId });
		expect(inspect.details.inspection.job.contract.route).toMatchObject({
			provider: h.model.provider,
			modelId: h.model.id,
			capabilityHash: expect.any(String),
		});
		expect(inspect.details.inspection.job.contract.resourcesHash).toMatch(/^[a-f0-9]{64}$/);
		h.runtime.registerProvider(h.model.provider, {
			baseUrl: h.model.baseUrl,
			api: h.model.api,
			models: [{ ...h.model, contextWindow: h.model.contextWindow + 1 }],
		});
		releases[0]!();
		await vi.waitFor(async () => {
			const state = await h.call("inspect_subagent_job", { jobId: queued.details.accepted.jobId });
			expect(state.details.inspection.job.status).toBe("failed");
			expect(state.details.inspection.result.summary).toMatch(/capabilities changed/i);
		});
		// The four already-started jobs invoked the runner; the queued job failed
		// contract revalidation before its runner was invoked.
		expect(spy).toHaveBeenCalledTimes(4);
		releases[1]!();
		releases[2]!();
		releases[3]!();
	});
	it("discovery includes self without needing any file or consuming a provider call", async () => {
		const h = await harness();
		const result = await h.call("list_subagent_profiles", {});
		expect(result.isError).toBe(false);
		expect(result.details.profiles).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "self", source: "self" })]),
		);
		expect(h.faux.state.callCount).toBe(0);
	});
});
