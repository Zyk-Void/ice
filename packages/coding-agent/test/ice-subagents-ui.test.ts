import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import { fauxAssistantMessage } from "@zykairotis/ice-ai/compat";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { CreateAgentSessionResult } from "../src/core/sdk.ts";
import { IceAgentViewBridge } from "../src/ice-agent-view-bridge.ts";
import iceSubagents, {
	emitObservatoryUpdate,
	formatSubagentTranscript,
	normalizeSubagentForkContext,
	parseAgentsViewMode,
	SubagentLiveSessionRegistry,
	SubagentViewSwitcher,
	validateWriterLaunchPreflight,
} from "../src/ice-subagents.ts";
import { JOB_COMPLETION_MESSAGE_TYPE, SubagentJobRegistry } from "../src/subagents/registry/jobs.ts";
import { createAsyncToolHarness, createGitWorkspace, git, tempDirs } from "./ice-subagents-harness.ts";

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ICE subagent contracts", () => {
	it("parses full and split agents commands without aliases", () => {
		expect(parseAgentsViewMode(undefined)).toBe("full");
		expect(parseAgentsViewMode("")).toBe("full");
		expect(parseAgentsViewMode("split")).toBe("split");
		expect(parseAgentsViewMode("split extra")).toBe("split");
		expect(parseAgentsViewMode("full")).toBe("full");
	});

	it("renders the default agent chooser and browses parent/live views with arrows", () => {
		const bridge = new IceAgentViewBridge();
		const parent = {
			sessionId: "parent",
			messages: [],
			isStreaming: false,
			sessionManager: { getCwd: () => "/repo" },
		} as unknown as CreateAgentSessionResult["session"];
		const child = {
			sessionId: "child",
			messages: [],
			isStreaming: true,
			sessionManager: { getCwd: () => "/repo" },
		} as unknown as CreateAgentSessionResult["session"];
		const registry = new SubagentLiveSessionRegistry();
		bridge.setParentSession(parent);
		bridge.connectLiveSessions(registry);
		const release = registry.register({ runId: "run-coder", role: "coder", taskId: "repo-map", session: child });
		const requestRender = vi.fn();
		const done = vi.fn();
		const fakeTheme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
		};
		const switcher = new SubagentViewSwitcher(
			{ requestRender } as never,
			fakeTheme as never,
			new KeybindingsManager(),
			bridge,
			done,
		);
		try {
			const initial = switcher.render(90).join("\n");
			expect(initial).toContain("Agents");
			expect(initial).toContain("Main agent");
			expect(initial).toContain("coder · repo-map");
			expect(initial).toContain("↑↓/←→ browse");
			switcher.handleInput("\x1b[B");
			expect(requestRender).toHaveBeenCalled();
			switcher.handleInput("\n");
			expect(bridge.getDisplayedId()).toBe("run-coder");
			expect(done).toHaveBeenCalledOnce();
		} finally {
			switcher.dispose();
			release();
		}
	});

	it("tracks live child sessions and renders bounded redacted transcript text", () => {
		const session = { sessionId: "child-live", messages: [] } as unknown as CreateAgentSessionResult["session"];
		const registry = new SubagentLiveSessionRegistry();
		const release = registry.register({ runId: "run-live", role: "self", session });
		expect(registry.get("run-live")).toMatchObject({ runId: "run-live", role: "self", session });
		expect(
			formatSubagentTranscript([
				{ role: "user", content: "Inspect source." },
				{ role: "assistant", content: "api_key=secret-value" },
			] as AgentMessage[]),
		).toContain("api_key=[REDACTED]");
		expect(
			formatSubagentTranscript(
				[{ role: "assistant", content: `api_key=${"secret-value".repeat(100)}` }] as unknown as AgentMessage[],
				32,
			),
		).not.toContain("secret-value");
		release();
		expect(registry.get("run-live")).toBeUndefined();
	});

	it("sanitizes an opt-in fork from buildSessionContext without importing branch state", () => {
		const assistant = fauxAssistantMessage("assistant response");
		assistant.content = [
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "secret" } },
			{ type: "text", text: "assistant response" },
		];
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Authorization: Bearer bearer-value api_key=secret-value password=hunter2" },
					{ type: "image", data: "base64", mimeType: "image/png" },
				],
				timestamp: 1,
			},
			assistant,
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "filesystem secret" }],
				isError: false,
				timestamp: 3,
			},
			{ role: "branchSummary", summary: "branch summary", fromId: "old-leaf", timestamp: 4 },
			{ role: "compactionSummary", summary: "compaction summary", tokensBefore: 42, timestamp: 5 },
			{ role: "custom", customType: "extension-state", content: "custom state", display: false, timestamp: 6 },
		];
		const buildSessionContext = vi.fn(() => ({ messages, thinkingLevel: "low", model: null }));
		const getBranch = vi.fn(() => {
			throw new Error("getBranch must not be used for fork context");
		});
		const source = {
			getSessionId: () => "parent-session",
			getLeafId: () => "leaf-1",
			buildSessionContext,
			getBranch,
		};
		const snapshot = normalizeSubagentForkContext(source);

		expect(buildSessionContext).toHaveBeenCalledOnce();
		expect(getBranch).not.toHaveBeenCalled();
		expect(snapshot).toMatchObject({
			mode: "fork",
			sourceSessionId: "parent-session",
			sourceLeafId: "leaf-1",
			messages: [
				{ index: 0, role: "user" },
				{ index: 1, role: "assistant", content: "assistant response" },
				{ index: 3, role: "summary", content: "branch summary" },
				{ index: 4, role: "summary", content: "compaction summary" },
			],
			dropped: { thinking: 1, toolCalls: 1, toolResults: 1, images: 1, custom: 1, empty: 0 },
		});
		expect(snapshot.messages[0]?.content).not.toContain("bearer-value");
		expect(snapshot.messages[0]?.content).not.toContain("secret-value");
		expect(snapshot.messages[0]?.content).not.toContain("hunter2");
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.messages)).toBe(true);
		expect(Object.isFrozen(snapshot.messages[0])).toBe(true);
	});

	it("requires a full locally resolved base commit equal to HEAD", async () => {
		const { cwd, head } = await createGitWorkspace();
		await expect(validateWriterLaunchPreflight(cwd, head.slice(0, 39))).rejects.toThrow(/40-character/i);
		await expect(validateWriterLaunchPreflight(cwd, "f".repeat(40))).rejects.toThrow(/preflight|single revision/i);
		await writeFile(join(cwd, "src", "second.ts"), "second\n");
		await git(cwd, "add", "src/second.ts");
		await git(cwd, "commit", "-m", "second");
		await expect(validateWriterLaunchPreflight(cwd, head)).rejects.toThrow(/HEAD/i);
	});

	it("isolates throwing observability update callbacks", () => {
		expect(() =>
			emitObservatoryUpdate(
				() => {
					throw new Error("update failed");
				},
				{ content: [{ type: "text", text: "progress" }], details: { type: "subagent_progress" } },
			),
		).not.toThrow();
	});

	it("registers bounded observatory renderers and command aliases", () => {
		const registerTool = vi.fn();
		const registerCommand = vi.fn();
		iceSubagents({ on: vi.fn(), registerTool, registerCommand } as unknown as ExtensionAPI);
		const tools = new Map(registerTool.mock.calls.map((call) => [call[0]?.name, call[0]]));
		for (const name of [
			"list_subagent_profiles",
			"delegate",
			"delegate_batch",
			"review_batch",
			"delegate_write",
			"inspect_writer_patch",
			"reject_writer_patch",
			"integrate_writer_patch",
		]) {
			expect(tools.get(name)).toMatchObject({
				renderCall: expect.any(Function),
				renderResult: expect.any(Function),
			});
		}
		expect(registerCommand.mock.calls.map((call) => call[0])).toEqual(["agents", "subagents"]);
		expect(tools.get("delegate_async")).toMatchObject({
			name: "delegate_async",
			parameters: expect.objectContaining({
				properties: expect.objectContaining({ role: expect.any(Object), task: expect.any(Object) }),
			}),
		});
		for (const name of ["delegate", "delegate_async"]) {
			const schema = tools.get(name)?.parameters;
			expect(
				Value.Check(schema, { role: "explore", task: "Inspect.", scope: { roots: ["."] }, startupTimeoutMs: 1000 }),
			).toBe(true);
			expect(
				Value.Check(schema, { role: "explore", task: "Inspect.", scope: { roots: ["."] }, timeoutMs: 1000 }),
			).toBe(false);
		}
		expect(tools.get("inspect_subagent_job")?.parameters).toMatchObject({
			properties: { jobId: { type: "string", minLength: 1, maxLength: 128 } },
		});
		expect(tools.get("cancel_subagent_job")?.parameters).toMatchObject({
			properties: { jobId: { type: "string", minLength: 1, maxLength: 128 } },
		});
		const outputReader = tools.get("read_subagent_output");
		expect(outputReader).toMatchObject({ name: "read_subagent_output" });
		expect(outputReader?.parameters).toMatchObject({
			additionalProperties: false,
			properties: {
				artifactId: { type: "string", minLength: 36, maxLength: 36 },
				offset: { type: "integer", minimum: 0 },
				length: { type: "integer", minimum: 1, maximum: 64 * 1024 },
			},
		});
		expect(
			Value.Check(outputReader?.parameters, {
				artifactId: "00000000-0000-4000-8000-000000000000",
				offset: 0,
				length: 16 * 1024,
			}),
		).toBe(true);
		expect(
			Value.Check(outputReader?.parameters, {
				artifactId: "00000000-0000-4000-8000-000000000000",
				path: "/tmp/output.txt",
			}),
		).toBe(false);
		for (const name of ["delegate", "delegate_async", "delegate_batch", "review_batch", "delegate_write"]) {
			expect(tools.get(name)?.parameters.properties).not.toHaveProperty("background");
			expect(tools.get(name)?.description).not.toMatch(/background:\s*false/);
		}
		const delegateSchema = tools.get("delegate")?.parameters;
		const delegateCall = { role: "self", task: "Inspect.", scope: { roots: ["src"] } };
		expect(Value.Check(delegateSchema, delegateCall)).toBe(true);
		expect(Value.Check(delegateSchema, { ...delegateCall, background: false })).toBe(false);
		expect(
			Value.Check(tools.get("delegate_write")?.parameters, {
				task: "Edit.",
				baseCommit: "a".repeat(40),
				scope: { roots: ["src"] },
				background: false,
			}),
		).toBe(false);
		expect(tools.get("delegate_async")?.parameters.properties).not.toHaveProperty("queue");
		expect(tools.get("delegate_async")?.parameters.properties).not.toHaveProperty("plannedOutputBytes");
		for (const name of ["delegate", "delegate_async", "delegate_batch", "review_batch"]) {
			expect(tools.get(name)?.description).toContain("internal bounded structured final-report protocol");
			expect(tools.get(name)?.description).toContain("do not ask the child to format its work as JSON");
			expect(tools.get(name)?.description).toContain(
				"the runtime ingests the child's natural final assistant turn directly",
			);
		}
	});
	it("shows persisted completion metadata in both overlays without side effects", async () => {
		const harness = await createAsyncToolHarness();
		const inspectSpy = vi.spyOn(SubagentJobRegistry.prototype, "inspect");
		try {
			harness.faux.setResponses([
				fauxAssistantMessage('{"summary":"completion fact","evidence":{"paths":["src"]}}'),
			]);
			const accepted = await harness.tools.get("delegate_async").execute(
				"async-inbox",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Inspect the source tree.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			const jobId = accepted.details.accepted.jobId as string;
			await new Promise((resolve) => setTimeout(resolve, 50));
			harness.entries.push({
				type: "custom_message",
				customType: JOB_COMPLETION_MESSAGE_TYPE,
				timestamp: "2026-01-01T00:00:02.000Z",
				content: "hostile transcript api_key=secret-value /tmp/secret.txt",
				details: { jobId, status: "completed", resultRef: `job:${jobId}` },
			});
			const entryCount = harness.entries.length;
			const messageCount = harness.sent.length;
			const readCount = harness.getEntries.mock.calls.length;

			for (const [overlayIndex, commandName] of ["agents", "subagents"].entries()) {
				inspectSpy.mockClear();
				await harness.commands.get(commandName)!.handler("", harness.context);
				const view = harness.getOverlay() as {
					children: Array<{ render(width: number): string[] }>;
					handleInput(data: string): void;
				};
				const text = () => view.children.flatMap((child) => child.render(200)).join("\n");

				expect(text()).toContain("COMPLETION INBOX");
				expect(text()).toContain(`✓ ${jobId.slice(0, 6)} self completed`);
				expect(text()).not.toContain("hostile transcript");
				expect(text()).not.toContain("secret-value");
				expect(inspectSpy).not.toHaveBeenCalled();
				expect(harness.entries).toHaveLength(entryCount);
				expect(harness.sent).toHaveLength(messageCount);
				expect(harness.getEntries.mock.calls).toHaveLength(readCount + overlayIndex + 1);

				view.handleInput("enter");
				expect(inspectSpy).not.toHaveBeenCalled();
				view.handleInput("escape");
				view.handleInput("escape");
			}
		} finally {
			inspectSpy.mockRestore();
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("keeps the completion inbox frozen until the overlay reopens", async () => {
		const harness = await createAsyncToolHarness();
		try {
			await harness.handlers.get("agent_start")!({ type: "agent_start" }, harness.context);
			harness.faux.setResponses([fauxAssistantMessage('{"summary":"safe boundary","evidence":{"paths":["src"]}}')]);
			await harness.tools.get("delegate_async").execute(
				"async-boundary",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Inspect the source tree.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			await harness.commands.get("agents")!.handler("", harness.context);
			const view = harness.getOverlay() as {
				children: Array<{ render(width: number): string[] }>;
				handleInput(data: string): void;
			};
			const text = () => view.children.flatMap((child) => child.render(200)).join("\n");
			expect(text()).toContain("BACKGROUND RECENT");
			expect(text()).not.toContain("COMPLETION INBOX");

			await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, harness.context);
			const sent = harness.sent.at(-1) as {
				message: { customType: string; content: unknown; details: unknown };
			};
			harness.entries.push({
				type: "custom_message",
				customType: sent.message.customType,
				timestamp: "2026-01-01T00:00:02.000Z",
				content: sent.message.content,
				details: sent.message.details,
			});
			expect(text()).not.toContain("COMPLETION INBOX");
			view.handleInput("escape");

			await harness.commands.get("agents")!.handler("", harness.context);
			const reopened = harness.getOverlay() as { children: Array<{ render(width: number): string[] }> };
			expect(reopened.children.flatMap((child) => child.render(200)).join("\n")).toContain("COMPLETION INBOX");
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});
});
