import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { SubagentHookTarget } from "../../src/subagents/extension-support.ts";
import type { SubagentHookRuntime } from "../../src/subagents/runtime/live-session.ts";
import {
	type IceHookDispatchRecord,
	type IceHookHandler,
	IceSubagentHookDispatcher,
	parseIceHooksSettings,
	resolveIceSubagentHooks,
} from "../../src/subagents/settings.ts";
import { SubagentV2Runtime } from "../../src/subagents/v2/runtime.ts";
import type { V2RuntimeHost } from "../../src/subagents/v2/runtime-support.ts";
import { resolveSubagentsV2Settings } from "../../src/subagents/v2/settings.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

interface HookSetup {
	definitions: Array<{ id: string; event: string; required?: boolean; roles?: string[] }>;
	handlers: Record<string, IceHookHandler>;
}

async function setup(hookSetup: HookSetup) {
	const harness = await createHarness();
	harnesses.push(harness);
	const cwd = harness.tempDir;
	writeFileSync(join(cwd, "notes.txt"), "notes\n");
	const sessionManager = SessionManager.create(cwd, join(harness.tempDir, "sessions"));
	const parent = {
		sessionId: sessionManager.getSessionId(),
		sessionManager,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		getActiveToolNames: () => ["read", "grep", "find", "ls"],
		sendCustomMessage: vi.fn(async () => {}),
	} as unknown as AgentSession;
	const records: IceHookDispatchRecord[] = [];
	const targets: SubagentHookTarget[] = [];
	const host: V2RuntimeHost = {
		getParentSession: () => parent,
		agentDir: join(harness.tempDir, "agent"),
		userAgentsDir: join(harness.tempDir, "agents"),
		getSettings: () => resolveSubagentsV2Settings({ projectTrusted: false }),
		isProjectTrusted: () => false,
		getParentMode: () => "build",
		isSubYolo: () => false,
		getAdapters: () => [],
		createHookRuntime: (target): SubagentHookRuntime | undefined => {
			targets.push(target);
			const hooks = resolveIceSubagentHooks({
				hooks: parseIceHooksSettings({ enabled: true, definitions: hookSetup.definitions }),
				role: target.role,
				...(target.roleHookIds ? { roleHookIds: target.roleHookIds } : {}),
			});
			if (hooks.length === 0) return undefined;
			return {
				dispatcher: new IceSubagentHookDispatcher({
					handlers: hookSetup.handlers,
					onRecord: (record) => records.push(record),
				}),
				hooks,
				records: [],
				pendingObservations: new Set(),
				ownerSessionId: target.ownerSessionId,
				runId: target.runId,
				role: target.role,
			};
		},
	};
	return { harness, sessionManager, host, records, targets };
}

const task = (agent: string, prompt: string) => ({ agent, description: `${agent} task`, prompt });
const events = (records: readonly IceHookDispatchRecord[]) => records.map((record) => record.event);

describe("subagent V2 hooks", () => {
	it("denies a launch in beforeLaunch before anything is persisted", async () => {
		const { sessionManager, host } = await setup({
			definitions: [{ id: "gate", event: "subagent.beforeLaunch" }],
			handlers: { gate: () => ({ outcome: "deny", reason: "no delegation today" }) },
		});
		const runtime = new SubagentV2Runtime(host);
		await expect(runtime.launch([task("explore", "look")])).rejects.toThrow(/beforeLaunch hook denied/);
		expect(runtime.registry.list(sessionManager.getSessionId())).toEqual([]);
	});

	it("gives beforeLaunch context additions to the first turn as untrusted parent data", async () => {
		const { harness, host } = await setup({
			definitions: [{ id: "ctx", event: "subagent.beforeLaunch" }],
			handlers: { ctx: () => ({ outcome: "continue", contextAdditions: [{ content: "HOOK-CONTEXT-MARKER" }] }) },
		});
		const runtime = new SubagentV2Runtime(host);
		let seen = "";
		harness.setResponses([
			(context) => {
				seen = JSON.stringify(context.messages);
				return fauxAssistantMessage("done");
			},
		]);
		const [record] = await runtime.launch([task("explore", "look")]);
		await runtime.runTurn(record!.id, "look", { foreground: true });
		expect(seen).toContain("HOOK-CONTEXT-MARKER");
		expect(seen).toContain("untrusted data");
	});

	it("gates each child tool in beforeTool and observes the turn lifecycle", async () => {
		const { harness, host, records } = await setup({
			definitions: [
				{ id: "tools", event: "subagent.beforeTool" },
				{ id: "after", event: "subagent.afterTool", required: false },
				{ id: "start", event: "subagent.started", required: false },
				{ id: "done", event: "subagent.completed", required: false },
			],
			handlers: {
				tools: (input) => ({ outcome: input.payload.tool === "read" ? "deny" : "continue" }),
				after: () => ({ outcome: "continue" }),
				start: () => ({ outcome: "continue" }),
				done: () => ({ outcome: "continue" }),
			},
		});
		const runtime = new SubagentV2Runtime(host);
		let toolResult = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }), { stopReason: "toolUse" }),
			(context) => {
				toolResult = JSON.stringify(context.messages.at(-1));
				return fauxAssistantMessage("report");
			},
		]);
		const [record] = await runtime.launch([task("explore", "look")]);
		const result = await runtime.runTurn(record!.id, "look", { foreground: true });
		expect(result.outcome).toBe("completed");
		expect(toolResult).toContain("beforeTool hook denied");
		expect(events(records)).toEqual([
			"subagent.started",
			"subagent.beforeTool",
			"subagent.afterTool",
			"subagent.beforeTool",
			"subagent.completed",
		]);
	});

	it("fails the turn when beforeAccept denies the result", async () => {
		const { harness, host } = await setup({
			definitions: [{ id: "accept", event: "subagent.beforeAccept" }],
			handlers: { accept: () => ({ outcome: "deny", reason: "not acceptable" }) },
		});
		const runtime = new SubagentV2Runtime(host);
		harness.setResponses([fauxAssistantMessage("report")]);
		const [record] = await runtime.launch([task("explore", "look")]);
		const result = await runtime.runTurn(record!.id, "look", { foreground: true });
		expect(result.outcome).toBe("failed");
		expect(result.error).toMatch(/beforeAccept hook denied/);
	});

	it("selects a definition's optional hooks and refuses unknown hook IDs before launch", async () => {
		const { harness, sessionManager, host, records, targets } = await setup({
			definitions: [
				{ id: "picked", event: "subagent.completed", required: false },
				{ id: "other", event: "subagent.completed", required: false },
			],
			handlers: { picked: () => ({ outcome: "continue" }), other: () => ({ outcome: "continue" }) },
		});
		mkdirSync(join(harness.tempDir, "agents"), { recursive: true });
		writeFileSync(
			join(harness.tempDir, "agents", "hooked.md"),
			"---\nname: hooked\ndescription: d\ntools: [read]\nhooks: [picked]\n---\nHooked.\n",
		);
		writeFileSync(
			join(harness.tempDir, "agents", "broken.md"),
			"---\nname: broken\ndescription: d\ntools: [read]\nhooks: [missing]\n---\nBroken.\n",
		);
		const runtime = new SubagentV2Runtime(host);
		harness.setResponses([fauxAssistantMessage("report")]);
		const [record] = await runtime.launch([task("hooked", "look")]);
		await runtime.runTurn(record!.id, "look", { foreground: true });
		expect(targets[0]).toMatchObject({ role: "hooked", roleHookIds: ["picked"], readOnly: false });
		expect(records.map((entry) => entry.hookId)).toEqual(["picked"]);
		await expect(runtime.launch([task("broken", "look")])).rejects.toThrow(/unknown hook id "missing"/);
		expect(runtime.registry.list(sessionManager.getSessionId())).toHaveLength(1);
	});
});
