import { fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("safe custom message and queued input boundaries", () => {
	it("records context-only messages after tool results without starting a follow-up", async () => {
		let release: () => void = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started: () => void = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const harness = await createHarness({
			tools: [
				{
					name: "wait",
					label: "Wait",
					description: "Wait",
					parameters: Type.Object({}),
					execute: async () => {
						started();
						await barrier;
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		let sawContext = false;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				sawContext = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "context"),
				);
				return fauxAssistantMessage("done");
			},
			fauxAssistantMessage("unwanted follow-up"),
		]);
		const prompt = harness.session.prompt("start");
		await toolStarted;
		try {
			await harness.session.sendCustomMessage(
				{ customType: "note", content: "context", display: false },
				{ triggerTurn: false, deliverAs: "followUp" },
			);
			expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
		} finally {
			release();
		}
		await prompt;
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"custom",
			"assistant",
		]);
		expect(getAssistantTexts(harness)).toEqual(["", "done"]);
		expect(sawContext).toBe(true);
	});

	it.each([false, true])("queues compaction input without auto-running after cancellation=%s", async (cancelled) => {
		let release: () => void = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 } },
			extensionFactories: [
				(ice) => {
					ice.on("session_before_compact", async (event) => {
						entered();
						await barrier;
						return {
							compaction: {
								summary: "summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("queued reply"),
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const compaction = harness.session.compact();
		await started;
		try {
			await harness.session.prompt("during compaction", { streamingBehavior: "followUp" });
			expect(harness.session.getFollowUpMessages()).toEqual(["during compaction"]);
			if (cancelled) harness.session.abortCompaction();
		} finally {
			release();
		}
		if (cancelled) await expect(compaction).rejects.toMatchObject({ name: "AbortError" });
		else await compaction;
		await harness.session.waitForIdle();
		if (cancelled) {
			expect(getAssistantTexts(harness)).not.toContain("queued reply");
			expect(harness.session.getFollowUpMessages()).toEqual(["during compaction"]);
		} else {
			expect(getAssistantTexts(harness)).toContain("queued reply");
			expect(harness.session.pendingMessageCount).toBe(0);
		}
	});

	it.each(["steer", "followUp"] as const)("runs input hooks exactly once for %s", async (mode) => {
		const seen: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.on("input", async (event) => {
						seen.push(event.text);
						if (event.text === "skip") return { action: "handled" };
						return { action: "transform", text: `${event.text}:transformed` };
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session[mode]("queued");
		await harness.session[mode]("skip");
		expect(seen).toEqual(["queued", "skip"]);
		expect(mode === "steer" ? harness.session.getSteeringMessages() : harness.session.getFollowUpMessages()).toEqual([
			"queued:transformed",
		]);
	});
});
