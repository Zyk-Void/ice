import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIceSubagents } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("subagents V2 SDK wiring", () => {
	it("runs a child through the inline extension and exposes it in the overview", async () => {
		const subagents = createIceSubagents({
			agents: { summarizer: { description: "Summarize text", prompt: "Summarize what you are given." } },
		});
		const harness = await createHarness({ extensionFactories: [subagents.extension], persistSession: true });
		harnesses.push(harness);
		expect(subagents.overview()).toBeUndefined();
		subagents.attach(harness.session);
		expect(subagents.overview()).toMatchObject({ enabled: true, children: [], approvals: [] });
		expect(harness.session.getActiveToolNames()).toEqual(expect.arrayContaining(["agent", "agent_control"]));
		// Delegation guidance reaches the system prompt with the tool.
		expect(harness.session.systemPrompt).toContain("Do not delegate understanding");
		expect(harness.session.systemPrompt).toContain("agent_control action=delete");

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("agent", {
					tasks: [
						{ agent: "summarizer", name: "greeter", description: "Summarize", prompt: "Summarize: hello world" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("child summary: greeting"),
			fauxAssistantMessage("parent done"),
		]);
		await harness.session.prompt("delegate");

		const toolResult = harness.eventsOfType("tool_execution_end").find((event) => event.toolName === "agent")
			?.result as { content: Array<{ text: string }> };
		expect(toolResult.content[0]!.text).toContain("child summary: greeting");
		expect(subagents.overview()?.children).toEqual([
			expect.objectContaining({ agent: "summarizer", description: "Summarize", running: false, depth: 0 }),
		]);
		expect(harness.getPendingResponseCount()).toBe(0);
		// Tools accept the name given at launch.
		const control = harness.session.getRegisteredTool("agent_control")!;
		const status = await control.execute("status", { action: "status", id: "greeter" });
		expect((status.content[0] as { text: string }).text).toContain(subagents.overview()!.children[0]!.id);
		const list = await control.execute("list", { action: "list" });
		expect((list.content[0] as { text: string }).text).toContain("(greeter)");
	});

	it("ends agent_control wait when the user queues a message", async () => {
		const subagents = createIceSubagents({ agentDir: join("/nonexistent", "agent") });
		const harness = await createHarness({ extensionFactories: [subagents.extension], persistSession: true });
		harnesses.push(harness);
		subagents.attach(harness.session);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const childResponse = vi.fn(async () => {
			await gate;
			return fauxAssistantMessage("late report");
		});
		harness.setResponses([childResponse]);
		const agent = harness.session.getRegisteredTool("agent")!;
		const control = harness.session.getRegisteredTool("agent_control")!;
		const started = await agent.execute("launch", {
			tasks: [{ agent: "explore", description: "Slow", prompt: "Take a while" }],
			background: true,
		});
		const id = (started.details as { ids: string[] }).ids[0]!;
		await vi.waitFor(() => expect(childResponse).toHaveBeenCalledOnce());
		const waiting = control.execute("wait", { action: "wait", id, timeoutMs: 60_000 });
		vi.spyOn(harness.session, "pendingMessageCount", "get").mockReturnValue(1);
		const result = await waiting;
		expect((result.content[0] as { text: string }).text).toContain("the user sent a message");
		expect(subagents.overview()?.children[0]).toMatchObject({ running: true });
		release();
		await vi.waitFor(() => expect(subagents.overview()?.children[0]).toMatchObject({ running: false }));
	});

	it("keeps children read-only unless the host passes build mode", async () => {
		const subagents = createIceSubagents({ agentDir: join("/nonexistent", "agent") });
		const harness = await createHarness({ extensionFactories: [subagents.extension], persistSession: true });
		harnesses.push(harness);
		subagents.attach(harness.session);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("agent", {
					tasks: [{ agent: "general", description: "Write", prompt: "Create out.txt" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("write", { path: "out.txt", content: "no" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("could not write"),
			fauxAssistantMessage("parent done"),
		]);
		await harness.session.prompt("delegate");
		expect(subagents.overview()?.children).toHaveLength(1);
		expect(existsSync(join(harness.tempDir, "out.txt"))).toBe(false);
		const parentWrites = harness.eventsOfType("tool_execution_end").filter((event) => event.toolName === "write");
		expect(parentWrites).toEqual([]);
	});

	it("denies a build-mode child's write that resolves to ask, since an SDK session has no approval UI", async () => {
		const subagents = createIceSubagents({ mode: "build", agentDir: join("/nonexistent", "agent") });
		const harness = await createHarness({ extensionFactories: [subagents.extension], persistSession: true });
		harnesses.push(harness);
		subagents.attach(harness.session);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("agent", {
					tasks: [{ agent: "general", description: "Write", prompt: "Create out.txt" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("write", { path: "out.txt", content: "no" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("could not write"),
			fauxAssistantMessage("parent done"),
		]);
		await harness.session.prompt("delegate");
		expect(existsSync(join(harness.tempDir, "out.txt"))).toBe(false);
		expect(subagents.overview()?.approvals).toEqual([]);
	});

	it("lets a build-mode child write when a user allow rule grants it", async () => {
		const subagents = createIceSubagents({ mode: "build", agentDir: join("/nonexistent", "agent") });
		const harness = await createHarness({
			extensionFactories: [subagents.extension],
			persistSession: true,
			settings: { ice: { subagents: { permissions: { allow: ["write(**)"] } } } },
		});
		harnesses.push(harness);
		subagents.attach(harness.session);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("agent", {
					tasks: [{ agent: "general", description: "Write", prompt: "Create out.txt" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("write", { path: "out.txt", content: "yes" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote out.txt"),
			fauxAssistantMessage("parent done"),
		]);
		await harness.session.prompt("delegate");
		expect(readFileSync(join(harness.tempDir, "out.txt"), "utf8")).toBe("yes");
	});
});
