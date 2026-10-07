import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { IceAgentViewBridge } from "../src/ice-agent-view-bridge.ts";
import iceSubagents from "../src/ice-subagents.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

type ToolCallResult = { isError: boolean; content: Array<{ text: string }>; details: Record<string, any> };

async function harness() {
	const cwd = mkdtempSync(join(tmpdir(), "ice-bg-wait-"));
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
	runtime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const entries: Array<Record<string, unknown>> = [];
	const api = {
		events: createEventBus(),
		registerFlag() {},
		getFlag: () => false,
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand() {},
		on: (event: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), fn]);
		},
		getActiveTools: () => ["delegate", "read", "grep", "find", "ls"],
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage() {},
	} as unknown as ExtensionAPI;

	const bridge = new IceAgentViewBridge();
	const sendCustomMessage = vi.fn(async () => {});
	bridge.setParentSession({ sessionId: "owner", sendCustomMessage } as unknown as AgentSession);
	iceSubagents(api, { agentDir, getIceMode: () => "plan", agentViewBridge: bridge });

	const context = {
		cwd,
		mode: "rpc",
		hasUI: true,
		ui: { notify() {}, custom: async () => undefined },
		model,
		scopedModels: [],
		modelRegistry: new ModelRegistry(runtime),
		settingsManager: SettingsManager.inMemory({ ice: { subagents: { modelSelection: { mode: "configured" } } } }),
		isProjectTrusted: () => true,
		getSystemPrompt: () => "parent instructions",
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
	const call = (name: string, params: Record<string, unknown>) =>
		tools
			.get(name)!
			.execute(`call-${Math.random()}`, params, undefined, undefined, context) as unknown as Promise<ToolCallResult>;
	return { faux, bridge, sendCustomMessage, call };
}

describe("ctrl+b background release for manage_subagent wait", () => {
	it("returns the live observation early, keeps the child running, and reports completion once", async () => {
		const h = await harness();
		let releaseChild!: () => void;
		const childGate = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		h.faux.setResponses([
			async () => {
				await childGate;
				return fauxAssistantMessage('{"summary":"background done","evidence":{"paths":["src"]}}');
			},
		]);

		const launch = await h.call("delegate", { role: "self", task: "Inspect the source", scope: { roots: ["src"] } });
		const runId = launch.details.managed.runId as string;
		expect(h.bridge.hasBlockingWait()).toBe(false);

		const waiting = h.call("manage_subagent", { action: "wait", runId, waitMs: 60_000 });
		// The child is blocked inside its first model call, so it is genuinely running when released.
		await vi.waitFor(() => expect(h.faux.state.callCount).toBe(1), { timeout: 10_000 });
		await vi.waitFor(() => expect(h.bridge.hasBlockingWait()).toBe(true));
		expect(h.bridge.releaseBlockingWaits()).toBe(1);

		const waited = await waiting;
		expect(waited.isError).toBe(false);
		expect(waited.details.backgrounded).toBe(true);
		expect(waited.details.observation.childState).toBe("running");
		expect(waited.content[0]!.text).toContain("moved this wait to the background");
		expect(h.bridge.hasBlockingWait()).toBe(false);
		expect(h.bridge.backgroundSubagentCount()).toBe(1);
		expect(h.sendCustomMessage).not.toHaveBeenCalled();

		releaseChild();
		await vi.waitFor(() => expect(h.sendCustomMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
		expect(h.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "subagent_background_completed",
				details: { runId, childState: "completed" },
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		expect(h.bridge.backgroundSubagentCount()).toBe(0);
	});

	it("does nothing when no wait is in flight", async () => {
		const h = await harness();
		expect(h.bridge.hasBlockingWait()).toBe(false);
		expect(h.bridge.releaseBlockingWaits()).toBe(0);
	});
});
