import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
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

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("agent", {
					tasks: [{ agent: "summarizer", description: "Summarize", prompt: "Summarize: hello world" }],
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
