import { type Context, fauxAssistantMessage, type SimpleStreamOptions, streamSimple } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { generateBranchSummary } from "../../src/core/compaction/branch-summarization.ts";
import { completeSummarization } from "../../src/core/compaction/compaction.ts";
import { compact, createFileOps, generateSummary } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const invalid = [
	["length", fauxAssistantMessage("partial", { stopReason: "length" })],
	["toolUse", fauxAssistantMessage("partial", { stopReason: "toolUse" })],
	[
		"tool block",
		fauxAssistantMessage([
			{ type: "text", text: "partial" },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "file" } },
		]),
	],
	["blank", fauxAssistantMessage("  \n")],
	["aborted", fauxAssistantMessage("partial", { stopReason: "aborted" })],
] as const;

describe("compaction summary validation", () => {
	it.each(invalid)("rejects %s for history, split-turn and branch summaries", async (_name, response) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const message = { role: "user" as const, content: "preserve this context", timestamp: Date.now() };
		harness.setResponses([response]);
		await expect(generateSummary([message], harness.getModel(), 4096, "faux-key")).rejects.toThrow();
		harness.setResponses([response]);
		await expect(
			compact(
				{
					firstKeptEntryId: "kept",
					messagesToSummarize: [],
					turnPrefixMessages: [message],
					isSplitTurn: true,
					tokensBefore: 100,
					fileOps: createFileOps(),
					settings: { enabled: true, reserveTokens: 4096, keepRecentTokens: 10 },
				},
				harness.getModel(),
				"faux-key",
			),
		).rejects.toThrow();
		harness.setResponses([response]);
		const branch = await generateBranchSummary(
			[{ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message }],
			{ model: harness.getModel(), apiKey: "faux-key", signal: new AbortController().signal },
		);
		expect(branch.summary).toBeUndefined();
		expect(branch.error || branch.aborted).toBeTruthy();
	});

	it.each(invalid)("does not persist %s or replace active history", async (_name, response) => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 4096 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("original response")]);
		await harness.session.prompt("original request");
		const before = structuredClone(harness.session.messages);
		harness.setResponses([response]);
		await expect(harness.session.compact()).rejects.toThrow();
		expect(harness.session.messages).toEqual(before);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ result: undefined });
	});

	it("strips tools and tool selection without mutating caller inputs", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("checkpoint")]);
		const context: Context = {
			messages: [],
			tools: [{ name: "read", description: "unused", parameters: { type: "object", properties: {} } }],
		};
		const options: SimpleStreamOptions = { apiKey: "faux-key", toolChoice: "auto" };
		let receivedContext: Context | undefined;
		let receivedOptions: SimpleStreamOptions | undefined;
		await completeSummarization(harness.getModel(), context, options, (model, requestContext, requestOptions) => {
			receivedContext = requestContext;
			receivedOptions = requestOptions;
			return streamSimple(model, requestContext, requestOptions);
		});
		expect(receivedContext?.tools).toBeUndefined();
		expect(receivedOptions?.toolChoice).toBeUndefined();
		expect(context.tools).toHaveLength(1);
		expect(options.toolChoice).toBe("auto");
	});

	it("honors cancellation observed after the provider completes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("checkpoint")]);
		const controller = new AbortController();
		const response = await completeSummarization(
			harness.getModel(),
			{ messages: [] },
			{ apiKey: "faux-key", signal: controller.signal },
			async (model, context, options) => {
				const stream = streamSimple(model, context, options);
				await stream.result();
				controller.abort();
				return stream;
			},
		);
		expect(response.stopReason).toBe("aborted");
	});

	it("accepts complete nonblank text", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("valid checkpoint")]);
		expect(
			await generateSummary(
				[{ role: "user", content: "history", timestamp: Date.now() }],
				harness.getModel(),
				4096,
				"faux-key",
			),
		).toBe("valid checkpoint");
	});
});
