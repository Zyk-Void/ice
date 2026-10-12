import type { AgentMessage } from "@zykairotis/ice-agent-core";
import type { SessionEntry } from "@zykairotis/ice-coding-agent";
import { describe, expect, it } from "vitest";
import { BLACKHOLE_MINIMAL_KEPT_SENTINEL, resolveBlackholeTail } from "./tail.ts";

function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() } as AgentMessage,
	} as SessionEntry;
}

function recallEntry(id: string): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: "ice-cognee-recall",
		content: "old recalled memory",
		display: false,
	} as SessionEntry;
}

describe("blackhole tail plan", () => {
	it("keeps Ice's firstKeptEntryId for ice-default and drops recall noise", () => {
		const plan = resolveBlackholeTail({
			tailBehavior: "ice-default",
			firstKeptEntryId: "keep-1",
			messagesToSummarize: [{ role: "user", content: "old turn", timestamp: 1 } as AgentMessage],
			turnPrefixMessages: [],
			branchEntries: [userEntry("keep-1", "recent"), recallEntry("recall-1")],
		});
		expect(plan.firstKeptEntryId).toBe("keep-1");
		expect(plan.summarizedKeptTail).toBe(0);
		expect(plan.sourceMessages.map((message) => message.role)).toEqual(["user"]);
	});

	it("summarizes the kept tail and uses the minimal sentinel", () => {
		const plan = resolveBlackholeTail({
			tailBehavior: "minimal",
			firstKeptEntryId: "keep-1",
			messagesToSummarize: [{ role: "user", content: "old turn", timestamp: 1 } as AgentMessage],
			turnPrefixMessages: [],
			branchEntries: [userEntry("keep-1", "recent user"), userEntry("keep-2", "latest user")],
		});
		expect(plan.firstKeptEntryId).toBe(BLACKHOLE_MINIMAL_KEPT_SENTINEL);
		expect(plan.summarizedKeptTail).toBe(2);
		expect(plan.sourceMessages).toHaveLength(3);
	});
});
