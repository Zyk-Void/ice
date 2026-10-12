/**
 * Subagent V2 child session files (Plan/subagent-rewrite.md sections 11.1 and 11.6, P5.2/P5.3/P5.7).
 *
 * Every child is an ordinary Ice session file under
 * `<parent-session-dir>/subagents/<parent-session-id>/`. Its first custom entry is
 * the frozen runtime contract plus hash, flushed durably before the child may
 * start. Reopening verifies that hash, so revival never re-resolves authority.
 */
import { join } from "node:path";
import { assertValidSessionId, type SessionEntry, SessionManager } from "../../core/session-manager.ts";
import type { ChildRuntimeContract } from "../contract/child-runtime-contract.ts";
import { hashChildRuntimeContract, parseChildRuntimeContract } from "../contract/serialize.ts";

export const CHILD_INIT_ENTRY_TYPE = "ice-subagent-v2-init";

export function childSessionDirectory(parentSessionDir: string, parentSessionId: string): string {
	// Imported session headers are untrusted; a path-shaped id must not escape the session directory.
	assertValidSessionId(parentSessionId);
	return join(parentSessionDir, "subagents", parentSessionId);
}

/**
 * Create the child session file and durably record the contract. Throws when the
 * write fails; callers must not launch the child in that case.
 */
export function createChildSession(input: {
	parentSessionDir: string;
	parentSessionId: string;
	parentSessionFile?: string;
	contract: ChildRuntimeContract;
	cwd: string;
}): { sessionManager: SessionManager; transcriptPath: string; contractHash: string } {
	const sessionManager = SessionManager.create(
		input.cwd,
		childSessionDirectory(input.parentSessionDir, input.parentSessionId),
		{ id: input.contract.id, ...(input.parentSessionFile ? { parentSession: input.parentSessionFile } : {}) },
	);
	const contractHash = hashChildRuntimeContract(input.contract);
	sessionManager.appendCustomEntry(CHILD_INIT_ENTRY_TYPE, { contract: input.contract, contractHash });
	sessionManager.flushDurably();
	const transcriptPath = sessionManager.getSessionFile();
	if (!transcriptPath) throw new Error("Child session file was not created.");
	return { sessionManager, transcriptPath, contractHash };
}

/** Reopen a child session and return its verified frozen contract. */
export function openChildSession(
	transcriptPath: string,
	expectedHash: string,
): { sessionManager: SessionManager; contract: ChildRuntimeContract } {
	const sessionManager = SessionManager.open(transcriptPath);
	const init = sessionManager
		.getEntries()
		.find((entry) => entry.type === "custom" && entry.customType === CHILD_INIT_ENTRY_TYPE);
	if (!init || init.type !== "custom") throw new Error("Child session has no runtime contract entry.");
	const data = init.data as { contract?: unknown; contractHash?: unknown };
	if (data.contractHash !== expectedHash) throw new Error("Child session contract hash does not match the registry.");
	const contract = parseChildRuntimeContract(JSON.stringify(data.contract), expectedHash);
	return { sessionManager, contract };
}

export interface InterruptedToolCall {
	id: string;
	name: string;
}

/** Tool calls in the last assistant message that never received a result: candidates for a recovery notice, never for replay. */
export function findInterruptedToolCalls(entries: readonly SessionEntry[]): InterruptedToolCall[] {
	const pending = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role: string; content?: unknown; toolCallId?: string };
		if (message.role === "assistant" && Array.isArray(message.content)) {
			pending.clear();
			for (const part of message.content as Array<{ type?: string; id?: string; name?: string }>)
				if (part.type === "toolCall" && part.id && part.name) pending.set(part.id, part.name);
		} else if (message.role === "toolResult" && message.toolCallId) {
			pending.delete(message.toolCallId);
		}
	}
	return [...pending].map(([id, name]) => ({ id, name }));
}

/** Host message prepended to the next explicit continuation after an interruption (D14). */
export function buildRecoveryNotice(interrupted: readonly InterruptedToolCall[]): string {
	const calls =
		interrupted.length > 0
			? ` These tool calls were cut off and were not replayed: ${interrupted.map((call) => `${call.name} (${call.id})`).join(", ")}. Their effects are unknown; inspect state before repeating any of them.`
			: "";
	return `Your previous turn was interrupted by a process restart.${calls}`;
}
