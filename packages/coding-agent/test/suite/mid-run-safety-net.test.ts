import type { AgentTool } from "@zykairotis/ice-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { isPastMidRunSafetyNet } from "../../src/core/compaction/compaction.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function bulkTool(outputChars: number): AgentTool {
	return {
		name: "bulk",
		label: "Bulk",
		description: "Return a large result",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "x".repeat(outputChars) }], details: {} }),
	};
}

function compactionEntries(harness: Harness): number {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
}

describe("mid-run compaction safety net", () => {
	it("flags context past 95 percent of the window and not below", () => {
		expect(isPastMidRunSafetyNet(2851, 3000)).toBe(true);
		expect(isPastMidRunSafetyNet(2850, 3000)).toBe(false);
		expect(isPastMidRunSafetyNet(1500, 3000)).toBe(false);
		expect(isPastMidRunSafetyNet(2851, 0)).toBe(false);
	});

	it("compacts at the safety net even when mid-run compaction is off", async () => {
		// Threshold 99% keeps the proactive mid-run path silent; a single run
		// blowing past the 95% hard ceiling (2850 of 3000) must still compact
		// at the next tool-turn boundary instead of climbing into overflow.
		// The first turn stays small so the compaction cut has earlier turns to
		// summarize; the second turn's huge result crosses the ceiling.
		let calls = 0;
		const growingTool: AgentTool = {
			name: "grow",
			label: "Grow",
			description: "Return a small result first, then a huge one",
			parameters: Type.Object({}),
			execute: async () => {
				calls++;
				return { content: [{ type: "text", text: "x".repeat(calls === 1 ? 800 : 40000) }], details: {} };
			},
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3000, maxTokens: 100 }],
			settings: {
				compaction: {
					enabled: true,
					thresholdPercent: 99,
					midRunCompaction: "off",
					reserveTokens: 0,
					keepRecentTokens: 500,
				},
			},
			tools: [growingTool],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("grow", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("grow", {}), { stopReason: "toolUse" }),
			// Consumed by the compaction summary request (no extension provides it).
			fauxAssistantMessage("Summary of the earlier turns."),
			fauxAssistantMessage("continued"),
		]);

		await harness.session.prompt("start");
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(compactionEntries(harness)).toBeGreaterThan(0);
	});

	it("keeps mid-run compaction off below the safety-net ceiling", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3000, maxTokens: 100 }],
			settings: {
				compaction: {
					enabled: true,
					thresholdPercent: 99,
					midRunCompaction: "off",
					reserveTokens: 0,
					keepRecentTokens: 500,
				},
			},
			tools: [bulkTool(400)],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bulk", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bulk", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(harness.faux.state.callCount).toBe(3);
		expect(compactionEntries(harness)).toBe(0);
	});
});
