import { fauxAssistantMessage } from "@zykairotis/ice-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

describe("issue #7150: RPC prompt during manual compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("accepts and preserves an RPC prompt during manual compaction", async () => {
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});

		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(ice) => {
					ice.on("session_before_compact", async (event) => {
						markCompactionStarted();
						await compactionReleased;
						return {
							compaction: {
								summary: "manual compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);

		const timestamp = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old user message" }],
			timestamp: timestamp - 1000,
		});
		harness.sessionManager.appendMessage(
			fauxAssistantMessage("old assistant response", { timestamp: timestamp - 500 }),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("probe response")]);

		const compactPromise = harness.session.compact();
		await compactionStarted;

		let preflightResult: boolean | undefined;
		let promptError: unknown;
		try {
			await harness.session.prompt("PROBE-7150", {
				source: "rpc",
				preflightResult: (success) => {
					preflightResult = success;
				},
			});
		} catch (error) {
			promptError = error;
		} finally {
			releaseCompaction();
			await compactPromise;
		}
		// compact() settles with its own result; the queued prompt then runs detached.
		await harness.session.waitForIdle();

		const persistedUserTexts = harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
			);

		expect(preflightResult).toBe(true);
		expect(promptError).toBeUndefined();
		expect(getUserTexts(harness)).toContain("PROBE-7150");
		expect(persistedUserTexts).toContain("PROBE-7150");
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
});
