import type { AgentMessage } from "@zykairotis/ice-agent-core";
import { type SessionEntry, sessionEntryToContextMessages } from "@zykairotis/ice-coding-agent";
import type { TailBehavior } from "./unified-config.ts";

/** firstKeptEntryId that matches no prior session entry, so only the new compact + later entries remain. */
export const BLACKHOLE_MINIMAL_KEPT_SENTINEL = "__blackhole_minimal_tail__";

const RECALL_CUSTOM_TYPES = new Set(["ice-cognee-recall"]);

export interface BlackholeTailInput {
	tailBehavior: TailBehavior;
	firstKeptEntryId: string;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	branchEntries: SessionEntry[];
}

export interface BlackholeTailPlan {
	firstKeptEntryId: string;
	sourceMessages: AgentMessage[];
	droppedRecallCount: number;
	summarizedKeptTail: number;
}

function isRecallNoise(message: AgentMessage): boolean {
	return message.role === "custom" && RECALL_CUSTOM_TYPES.has(message.customType);
}

function collectFromFirstKept(branchEntries: SessionEntry[], firstKeptEntryId: string): AgentMessage[] {
	const start = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
	const from = start >= 0 ? start : 0;
	const messages: AgentMessage[] = [];
	for (const entry of branchEntries.slice(from)) {
		messages.push(...sessionEntryToContextMessages(entry));
	}
	return messages;
}

/** Drop Cognee recall custom messages from the compact source so they cannot echo into the checkpoint. */
export function filterCompactSourceMessages(messages: AgentMessage[]): {
	messages: AgentMessage[];
	droppedRecallCount: number;
} {
	const kept: AgentMessage[] = [];
	let droppedRecallCount = 0;
	for (const message of messages) {
		if (isRecallNoise(message)) {
			droppedRecallCount += 1;
			continue;
		}
		kept.push(message);
	}
	return { messages: kept, droppedRecallCount };
}

/**
 * Decide which session tail survives compaction.
 *
 * `ice-default` keeps Ice's keepRecentTokens cut.
 * `minimal` summarizes that tail too and keeps only the new compact entry
 * (plus anything appended after, such as Blackhole's resume message).
 */
export function resolveBlackholeTail(input: BlackholeTailInput): BlackholeTailPlan {
	const prepared = [...input.messagesToSummarize, ...input.turnPrefixMessages];
	if (input.tailBehavior !== "minimal") {
		const filtered = filterCompactSourceMessages(prepared);
		return {
			firstKeptEntryId: input.firstKeptEntryId,
			sourceMessages: filtered.messages,
			droppedRecallCount: filtered.droppedRecallCount,
			summarizedKeptTail: 0,
		};
	}

	const keptTail = collectFromFirstKept(input.branchEntries, input.firstKeptEntryId);
	const filtered = filterCompactSourceMessages([...prepared, ...keptTail]);
	return {
		firstKeptEntryId: BLACKHOLE_MINIMAL_KEPT_SENTINEL,
		sourceMessages: filtered.messages,
		droppedRecallCount: filtered.droppedRecallCount,
		summarizedKeptTail: keptTail.length,
	};
}
