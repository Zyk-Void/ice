import { createHash } from "node:crypto";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import { RpcCommandExecutionError } from "./rpc-command-schema.ts";

export interface RpcPage<T> {
	items: T[];
	hasMore: boolean;
	nextCursor?: string;
}

/** Key cursors describe live ordered listings, not a retained server snapshot. */
export function pageAfterKey<T>(
	items: readonly T[],
	key: (item: T) => string,
	cursor?: string,
	limit?: number,
): RpcPage<T> {
	let start = 0;
	if (cursor !== undefined) {
		const found = items.findIndex((item) => key(item) === cursor);
		if (found === -1) throw new RpcCommandExecutionError("not_found", "Page cursor not found in this view.");
		start = found + 1;
	}
	const page = items.slice(start, limit === undefined ? undefined : start + limit);
	const hasMore = start + page.length < items.length;
	return { items: page, hasMore, ...(hasMore ? { nextCursor: key(page[page.length - 1]!) } : {}) };
}

/** Messages lack stable IDs. Reject cursors after branch/length/entry changes instead of shifting offsets. */
export function pageMessages(
	messages: readonly AgentMessage[],
	sessionId: string,
	leafId: string | null,
	entryCount: number,
	cursor?: string,
	limit?: number,
): RpcPage<AgentMessage> & { snapshot: string } {
	const snapshot = createHash("sha256")
		.update(JSON.stringify([sessionId, leafId, entryCount, messages.length]))
		.digest("hex");
	let start = 0;
	if (cursor !== undefined) {
		let decoded: unknown;
		try {
			decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		} catch {
			throw new RpcCommandExecutionError("validation", "Invalid message cursor.");
		}
		if (
			!Array.isArray(decoded) ||
			decoded.length !== 2 ||
			typeof decoded[0] !== "string" ||
			typeof decoded[1] !== "number" ||
			!Number.isSafeInteger(decoded[1]) ||
			decoded[1] < 0 ||
			decoded[1] > messages.length
		) {
			throw new RpcCommandExecutionError("validation", "Invalid message cursor.");
		}
		if (decoded[0] !== snapshot)
			throw new RpcCommandExecutionError("stale", "Message view changed; restart pagination.");
		start = decoded[1];
	}
	const page = messages.slice(start, limit === undefined ? undefined : start + limit);
	const hasMore = start + page.length < messages.length;
	return {
		items: page,
		snapshot,
		hasMore,
		...(hasMore
			? { nextCursor: Buffer.from(JSON.stringify([snapshot, start + page.length])).toString("base64url") }
			: {}),
	};
}
