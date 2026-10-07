import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { CHILD_INIT_ENTRY_TYPE } from "../../src/subagents/registry/child-sessions.ts";
import { type ChildTurnResult, SubagentV2Runtime, type V2RuntimeHost } from "../../src/subagents/v2/runtime.ts";
import { resolveSubagentsV2Settings } from "../../src/subagents/v2/settings.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

interface Parent {
	session: AgentSession;
	sent: Array<{ customType: string; content: unknown }>;
	tools: string[];
}

async function setup(options: { tools?: string[]; parentFile?: string } = {}) {
	const harness = await createHarness();
	harnesses.push(harness);
	const sessionManager = options.parentFile
		? SessionManager.open(options.parentFile)
		: SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions"));
	const parent: Parent = {
		sent: [],
		tools: options.tools ?? ["read", "grep", "find", "ls", "bash", "edit", "write"],
		session: undefined as unknown as AgentSession,
	};
	parent.session = {
		sessionId: sessionManager.getSessionId(),
		sessionManager,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		getActiveToolNames: () => parent.tools,
		sendCustomMessage: vi.fn(async (message: { customType: string; content: unknown }) => {
			parent.sent.push(message);
		}),
	} as unknown as AgentSession;
	const host = (overrides: Partial<V2RuntimeHost> = {}): V2RuntimeHost => ({
		getParentSession: () => parent.session,
		agentDir: join(harness.tempDir, "agent"),
		userAgentsDir: join(harness.tempDir, "agents"),
		getSettings: () => resolveSubagentsV2Settings({ projectTrusted: false }),
		isProjectTrusted: () => false,
		getParentMode: () => "build",
		isSubYolo: () => false,
		getAdapters: () => [],
		...overrides,
	});
	return { harness, parent, sessionManager, host };
}

function transcriptOf(runtime: SubagentV2Runtime, childId: string): string {
	return readFileSync(runtime.registry.get(runtime.ownerSessionId(), childId).transcriptPath, "utf8");
}

const task = (agent: string, prompt: string) => ({ agent, description: `${agent} task`, prompt });

async function runOne(
	runtime: SubagentV2Runtime,
	agent: string,
	prompt: string,
	background = false,
): Promise<ChildTurnResult & { childId: string }> {
	const [record] = await runtime.launch([task(agent, prompt)]);
	const result = await runtime.runTurn(record!.id, prompt, { foreground: !background, background });
	return { ...result, childId: record!.id };
}

describe("subagent V2 runtime", () => {
	it("runs a foreground child under its frozen contract and records it durably", async () => {
		const { harness, sessionManager, host } = await setup();
		writeFileSync(join(harness.tempDir, "notes.txt"), "token check lives in auth.ts:42\n");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("The token check is in auth.ts:42."),
		]);
		const runtime = new SubagentV2Runtime(host());
		const result = await runOne(runtime, "explore", "Where is the token check?");
		expect(result).toMatchObject({
			outcome: "completed",
			text: "The token check is in auth.ts:42.",
			agent: "explore",
		});
		const record = runtime.registry.get(sessionManager.getSessionId(), result.childId);
		expect(record).toMatchObject({ state: "idle", lastTurnOutcome: "completed", usage: { turns: 1 } });
		const transcript = readFileSync(record.transcriptPath, "utf8");
		expect(transcript).toContain(CHILD_INIT_ENTRY_TYPE);
		expect(transcript).toContain("auth.ts:42");
		expect(
			record.transcriptPath.startsWith(
				join(harness.tempDir, "sessions", "subagents", sessionManager.getSessionId()),
			),
		).toBe(true);
	});

	it("keeps child writes at ask and denies them without an approval channel", async () => {
		const { harness, host } = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "out.txt", content: "x" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("I could not write the file."),
		]);
		const runtime = new SubagentV2Runtime(host());
		const result = await runOne(runtime, "general", "Write out.txt");
		expect(result.outcome).toBe("completed");
		expect(existsSync(join(harness.tempDir, "out.txt"))).toBe(false);
		expect(transcriptOf(runtime, result.childId)).toContain("Permission denied: write was not approved (no-channel)");
	});

	it("lets an interactive approval or authorized sub-yolo allow child writes", async () => {
		const approved = await setup();
		approved.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "a" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const prompts: string[] = [];
		const withPrompt = new SubagentV2Runtime(
			approved.host({
				promptApproval: async (request) => {
					prompts.push(request.summary);
					return "allow-once";
				},
			}),
		);
		await runOne(withPrompt, "general", "Write a.txt");
		expect(prompts).toEqual(["write: a.txt"]);
		expect(readFileSync(join(approved.harness.tempDir, "a.txt"), "utf8")).toBe("a");

		const yolo = await setup();
		yolo.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "b.txt", content: "b" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await runOne(new SubagentV2Runtime(yolo.host({ isSubYolo: () => true })), "general", "Write b.txt");
		expect(readFileSync(join(yolo.harness.tempDir, "b.txt"), "utf8")).toBe("b");
	});

	it("never lets sub-yolo override a plan-mode parent or the explore agent's plan preset", async () => {
		const { harness, host } = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "c.txt", content: "c" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("blocked"),
		]);
		const runtime = new SubagentV2Runtime(host({ isSubYolo: () => true, getParentMode: () => "plan" }));
		const result = await runOne(runtime, "general", "Write c.txt");
		expect(existsSync(join(harness.tempDir, "c.txt"))).toBe(false);
		expect(transcriptOf(runtime, result.childId)).toContain(
			"Permission denied: write is not allowed for this subagent",
		);
	});

	it("delivers a background completion to the parent exactly once", async () => {
		const { harness, parent, host } = await setup();
		harness.setResponses([fauxAssistantMessage("background report")]);
		const runtime = new SubagentV2Runtime(host());
		const result = await runOne(runtime, "explore", "Summarize", true);
		expect(result.outcome).toBe("completed");
		await Promise.resolve();
		expect(parent.sent).toHaveLength(1);
		expect(parent.sent[0]).toMatchObject({ customType: "subagent_completed" });
		runtime.flushCompletions();
		expect(parent.sent).toHaveLength(1);
	});

	it("restores after a restart, revives under the frozen contract, and blocks when authority was revoked", async () => {
		const first = await setup();
		first.harness.setResponses([fauxAssistantMessage("first turn")]);
		const runtime = new SubagentV2Runtime(first.host());
		const { childId } = await runOne(runtime, "general", "Start");
		first.sessionManager.flushDurably();
		const parentFile = first.sessionManager.getSessionFile()!;

		// New process: same parent session file, restored registry.
		first.parent.session = {
			...first.parent.session,
			sessionManager: SessionManager.open(parentFile),
		} as AgentSession;
		const restarted = new SubagentV2Runtime(first.host());
		expect(restarted.registry.get(first.sessionManager.getSessionId(), childId)).toMatchObject({ state: "parked" });
		first.harness.setResponses([fauxAssistantMessage("second turn")]);
		const continued = await restarted.continueChild(childId, "Continue", { foreground: true });
		expect(continued).toMatchObject({ outcome: "completed", text: "second turn" });

		await restarted.registry.park(first.sessionManager.getSessionId(), childId);
		first.parent.tools = ["read", "grep", "find", "ls"];
		await expect(restarted.continueChild(childId, "Again", { foreground: true })).rejects.toThrow(
			/no longer active in the parent/,
		);
		expect(restarted.registry.get(first.sessionManager.getSessionId(), childId).state).toBe("blocked");
	});

	it("refuses unknown agents with the available list and launches nothing for a bad batch", async () => {
		const { sessionManager, host } = await setup();
		const runtime = new SubagentV2Runtime(host());
		await expect(runtime.launch([task("explore", "ok"), task("nope", "bad")])).rejects.toThrow(
			/Agent "nope" is not available. Available agents: explore, general, plan, review/,
		);
		expect(runtime.registry.list(sessionManager.getSessionId())).toEqual([]);
	});
});
