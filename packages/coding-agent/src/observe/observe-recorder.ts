/**
 * Live observability recorder for a running AgentSession.
 *
 * Subscribes to the session event stream and projects it into a bounded, redacted
 * snapshot: an activity feed (tool calls, messages, compaction, retries, skills) plus
 * subagent lanes and periodic session state (model, context usage, token totals).
 * Read-only: nothing here mutates the session.
 */

import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import { parseSkillBlock } from "../core/agent-session.ts";
import type { ContextUsage } from "../core/extensions/types.ts";
import {
	getProgressSnapshot,
	OBSERVATORY_TOOL_NAMES,
	type SubagentProgressSnapshot,
} from "../ice-subagent-observatory.ts";

/** Max activity items kept in the ring buffer. */
const MAX_ITEMS = 500;
/**
 * Hard safety ceiling for one retained payload. Normal messages, tool calls, diffs,
 * and compaction summaries are kept in full; this only prevents one pathological
 * event from retaining unbounded memory in the 500-item ring buffer.
 */
const MAX_PAYLOAD_LENGTH = 1024 * 1024;
/** Max lanes kept after they turn terminal. */
const MAX_TERMINAL_LANES = 50;
/** Default poll interval for session header state (model, thinking, context, usage). */
const DEFAULT_POLL_MS = 1000;

export type ObserveItemKind = "message" | "tool" | "subagent" | "compaction" | "retry" | "skill" | "queue";
export type ObserveThreadKind = "main" | "subagent";
export type ObserveThreadColor =
	| "blue"
	| "violet"
	| "cyan"
	| "green"
	| "amber"
	| "rose"
	| "orange"
	| "indigo"
	| "slate";

export interface ObserveThreadIdentity {
	/** Stable path: mainThreadId for the root, parentThreadKey::childThreadId below it. */
	threadKey: string;
	/** Raw session/thread identifier for this node. */
	threadId: string;
	/** Immediate parent raw thread identifier, absent only for a root main agent. */
	parentThreadId?: string;
	/** Root main-agent raw thread identifier. */
	mainThreadId: string;
	threadKind: ObserveThreadKind;
	threadName: string;
	threadColor: ObserveThreadColor;
}

export interface ObserveThread extends ObserveThreadIdentity {
	runId?: string;
	role?: string;
	profileColor?: string;
}

export interface ObserveItem extends ObserveThreadIdentity {
	runId: string;
	id: number;
	ts: number;
	kind: ObserveItemKind;
	/** Original session event or projected subagent lifecycle event. */
	eventType?: string;
	role?: "user" | "assistant";
	/** Complete message text, skill invocation detail, or event detail. */
	text?: string;
	/** Complete serialized source payload for forensic inspection. */
	raw?: string;
	toolCallId?: string;
	toolName?: string;
	state?: "running" | "done" | "error";
	/** Complete JSON.stringify of tool call arguments. */
	args?: string;
	/** Complete text result or compaction summary. */
	result?: string;
	durationMs?: number;
	/** Number of partial/streaming updates seen for a tool call. */
	updates?: number;
	/** Parent observatory tool when this is a child activity. */
	delegationToolName?: string;
}

export interface ObserveLane extends ObserveThreadIdentity {
	streamKey: string;
	runId?: string;
	role?: string;
	toolName: string;
	status: string;
	phase: string;
	terminal: boolean;
	startedAtMs: number;
	elapsedMs: number;
	currentTool?: string;
	currentPath?: string;
	model?: string;
	attempt?: number;
	eventType?: string;
	summary?: string;
}

export interface ObserveHeader {
	runId: string;
	sessionId: string;
	mainThreadId: string;
	mainThreadName: string;
	sessionName?: string;
	model: string | null;
	thinkingLevel: string | null;
	context: ContextUsage | undefined;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	startedAt: number;
}

export interface ObserveState extends ObserveHeader {
	items: ObserveItem[];
	lanes: ObserveLane[];
	threads: ObserveThread[];
}

export type ObserveRecorderEvent =
	| { type: "activity"; item: ObserveItem }
	| { type: "activity_update"; item: ObserveItem }
	| { type: "lane"; lane: ObserveLane }
	| { type: "thread"; thread: ObserveThread }
	| { type: "header" };

export interface ObserveRecorder {
	getState(): ObserveState;
	getHeader(): ObserveHeader;
	subscribe(listener: (event: ObserveRecorderEvent) => void): () => void;
	stop(): void;
}

/** Durable sink for the recorder's projected run history. Implementations must be synchronous. */
export interface ObservePersistence {
	recordRun(header: ObserveHeader): void;
	recordEvent(event: ObserveRecorderEvent, header: ObserveHeader): void;
	finishRun(runId: string, endedAt: number): void;
	close(): void;
}

export interface ObserveRecorderOptions {
	/** Poll interval for header state in ms (default 1000; 0 disables polling). */
	pollMs?: number;
	/** Optional durable sink. Persistence failures are isolated from the agent loop. */
	persistence?: ObservePersistence;
}

/**
 * The session surface the recorder depends on. AgentSession satisfies this structurally,
 * which keeps the recorder unit-testable with a fake event emitter.
 */
export interface ObserveSessionLike {
	subscribe(listener: (event: unknown) => void): () => void;
	sessionId: string;
	sessionName?: string;
	readonly model: { provider: string; id: string } | null | undefined;
	readonly thinkingLevel: string;
	getContextUsage(): ContextUsage | undefined;
}

function retainPayload(text: string): string {
	if (text.length <= MAX_PAYLOAD_LENGTH) return text;
	return `${text.slice(0, MAX_PAYLOAD_LENGTH)}\n\n[observe payload limit: ${text.length - MAX_PAYLOAD_LENGTH} characters omitted]`;
}

function serializePayload(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return retainPayload(value);
	try {
		const serialized = JSON.stringify(value, null, 2);
		return retainPayload(serialized ?? String(value));
	} catch {
		return retainPayload(String(value));
	}
}

function messageText(message: AgentMessage): string {
	if (message.role === "assistant") {
		return message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
	if (message.role === "user") {
		return typeof message.content === "string"
			? message.content
			: message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n");
	}
	return "";
}

function resultText(result: unknown): string {
	if (result === null || result === undefined) return "";
	if (typeof result === "string") return result;
	if (typeof result === "object" && "content" in (result as Record<string, unknown>)) {
		const content = (result as { content?: unknown }).content;
		if (Array.isArray(content)) {
			return content
				.map((block) =>
					block && typeof block === "object" && (block as { type?: string }).type === "text"
						? String((block as { text?: unknown }).text ?? "")
						: "",
				)
				.filter((text) => text.length > 0)
				.join("\n");
		}
	}
	return JSON.stringify(result);
}

function isSubagentSnapshot(value: unknown): value is SubagentProgressSnapshot {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { schemaVersion?: unknown }).schemaVersion === 1 &&
		typeof (value as { streamKey?: unknown }).streamKey === "string"
	);
}

function getSubagentSnapshot(partialResult: unknown): SubagentProgressSnapshot | undefined {
	if (isSubagentSnapshot(partialResult)) return partialResult;
	if (typeof partialResult !== "object" || partialResult === null) return undefined;
	const record = partialResult as { details?: unknown };
	const fromDetails = getProgressSnapshot(record.details);
	if (isSubagentSnapshot(fromDetails)) return fromDetails;
	const direct = getProgressSnapshot(partialResult);
	return isSubagentSnapshot(direct) ? direct : undefined;
}

const THREAD_COLOR_PALETTE: readonly ObserveThreadColor[] = [
	"blue",
	"violet",
	"cyan",
	"green",
	"amber",
	"rose",
	"orange",
	"indigo",
];

function threadColorFor(threadKey: string, profileColor?: string): ObserveThreadColor {
	const preferred: Record<string, ObserveThreadColor> = {
		accent: "blue",
		success: "green",
		warning: "amber",
		error: "rose",
		muted: "slate",
		dim: "slate",
		text: "cyan",
	};
	if (profileColor && preferred[profileColor]) return preferred[profileColor];
	let hash = 0;
	for (const character of threadKey) hash = (hash * 31 + character.charCodeAt(0)) | 0;
	return THREAD_COLOR_PALETTE[Math.abs(hash) % THREAD_COLOR_PALETTE.length];
}

function shortThreadId(value: string): string {
	return value.length > 10 ? value.slice(0, 10) : value;
}

type ObserveItemInput = Omit<ObserveItem, "id" | "ts" | "runId" | keyof ObserveThreadIdentity>;

export function startObserveRecorder(session: ObserveSessionLike, options?: ObserveRecorderOptions): ObserveRecorder {
	const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
	const persistence = options?.persistence;
	const startedAt = Date.now();
	const runId = `${session.sessionId}:${startedAt}:${randomUUID()}`;
	const items: ObserveItem[] = [];
	const lanes = new Map<string, ObserveLane>();
	const terminalLaneOrder: string[] = [];
	const listeners = new Set<(event: ObserveRecorderEvent) => void>();
	let nextId = 1;
	let usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let lastPersistedHeader: string | undefined;

	function emit(event: ObserveRecorderEvent): void {
		try {
			const header = buildHeader();
			// The poll timer emits a header every tick; persist only real changes so idle sessions stay bounded.
			const serialized = event.type === "header" ? JSON.stringify(header) : undefined;
			if (serialized === undefined || serialized !== lastPersistedHeader) {
				persistence?.recordEvent(event, header);
				if (serialized !== undefined) lastPersistedHeader = serialized;
			}
		} catch {
			// Observability persistence is advisory and cannot affect the agent loop.
		}
		for (const listener of listeners) {
			listener(event);
		}
	}

	const mainThread: ObserveThread = {
		runId,
		threadKey: session.sessionId,
		threadId: session.sessionId,
		mainThreadId: session.sessionId,
		threadKind: "main",
		threadName: session.sessionName?.trim() || `main · ${shortThreadId(session.sessionId)}`,
		threadColor: "blue",
	};
	const threads = new Map<string, ObserveThread>([[mainThread.threadKey, mainThread]]);

	function registerThread(thread: ObserveThread): ObserveThread {
		const previous = threads.get(thread.threadKey);
		threads.set(thread.threadKey, thread);
		if (
			!previous ||
			previous.threadName !== thread.threadName ||
			previous.threadColor !== thread.threadColor ||
			previous.role !== thread.role ||
			previous.profileColor !== thread.profileColor
		) {
			emit({ type: "thread", thread });
		}
		return thread;
	}

	function ensureParentThread(parentThreadId: string): ObserveThread {
		for (const thread of threads.values()) {
			if (thread.threadId === parentThreadId) return thread;
		}
		return registerThread({
			runId,
			threadKey: parentThreadId,
			threadId: parentThreadId,
			mainThreadId: parentThreadId,
			threadKind: "main",
			threadName: `main · ${shortThreadId(parentThreadId)}`,
			threadColor: threadColorFor(parentThreadId),
		});
	}

	function ensureSubagentThread(snapshot: SubagentProgressSnapshot): ObserveThread {
		const parentThreadId = snapshot.parentSessionId ?? mainThread.threadId;
		const parent = ensureParentThread(parentThreadId);
		const childThreadId = snapshot.childSessionId ?? snapshot.runId ?? snapshot.streamKey;
		const threadKey = `${parent.threadKey}::${childThreadId}`;
		const role = snapshot.role || snapshot.toolName;
		return registerThread({
			runId,
			threadKey,
			threadId: childThreadId,
			parentThreadId: parent.threadId,
			mainThreadId: parent.mainThreadId,
			threadKind: "subagent",
			threadName: `${role} · ${shortThreadId(snapshot.taskId ?? childThreadId)}`,
			threadColor: threadColorFor(threadKey, snapshot.color),
			...(snapshot.role ? { role: snapshot.role } : {}),
			...(snapshot.color ? { profileColor: snapshot.color } : {}),
		});
	}

	function pushItem(item: ObserveItemInput, thread: ObserveThread = mainThread): ObserveItem {
		const full: ObserveItem = {
			runId,
			threadKey: thread.threadKey,
			threadId: thread.threadId,
			...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
			mainThreadId: thread.mainThreadId,
			threadKind: thread.threadKind,
			threadName: thread.threadName,
			threadColor: thread.threadColor,
			...item,
			id: nextId++,
			ts: Date.now(),
		};
		items.push(full);
		if (items.length > MAX_ITEMS) {
			items.splice(0, items.length - MAX_ITEMS);
		}
		emit({ type: "activity", item: full });
		return full;
	}

	function findToolItem(toolCallId: string): ObserveItem | undefined {
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			if (item.threadKind === "main" && item.toolCallId === toolCallId) return item;
		}
		return undefined;
	}

	function subagentTransition(
		previous: ObserveLane | undefined,
		snapshot: SubagentProgressSnapshot,
		thread: ObserveThread,
	): ObserveItemInput | undefined {
		const changed =
			!previous ||
			previous.phase !== snapshot.phase ||
			previous.status !== snapshot.status ||
			previous.currentTool !== snapshot.currentTool ||
			previous.currentPath !== snapshot.currentPath ||
			previous.terminal !== snapshot.terminal;
		const eventType = snapshot.eventType;
		if (previous && eventType === "subagent_progress" && !changed) return undefined;
		if (previous && !eventType && !changed) return undefined;

		const isCompaction =
			snapshot.phase === "compacting" ||
			eventType === "subagent_compaction_start" ||
			eventType === "subagent_compaction_end";
		const isRetry = snapshot.phase === "retrying" || eventType === "subagent_retry";
		const kind: ObserveItemKind = isCompaction ? "compaction" : isRetry ? "retry" : "subagent";
		const failure = [
			"failed",
			"cancelled",
			"timed_out",
			"verification_failed",
			"integration_conflict",
			"rollback_conflict",
		].includes(snapshot.status);
		const state: ObserveItem["state"] = failure ? "error" : snapshot.terminal ? "done" : "running";
		const childTool = snapshot.currentTool ? ` · ${snapshot.currentTool}` : "";
		let text: string;
		switch (eventType) {
			case "subagent_created":
				text = `${thread.threadName} created`;
				break;
			case "subagent_started":
				text = `${thread.threadName} started`;
				break;
			case "subagent_tool_start":
				text = `${thread.threadName} tool start${childTool}`;
				break;
			case "subagent_tool_end":
				text = `${thread.threadName} tool end${childTool}`;
				break;
			case "subagent_compaction_start":
				text = `${thread.threadName} compaction started`;
				break;
			case "subagent_compaction_end":
				text = `${thread.threadName} compaction finished${snapshot.compactionWillRetry ? " · will retry" : ""}`;
				break;
			case "subagent_retry":
				text = `${thread.threadName} retrying${snapshot.retry?.attempt ? ` · attempt ${snapshot.retry.attempt}` : ""}`;
				break;
			case "subagent_wrap_up":
				text = `${thread.threadName} wrapping up`;
				break;
			case "subagent_completed":
				text = `${thread.threadName} completed`;
				break;
			case "subagent_failed":
				text = `${thread.threadName} failed`;
				break;
			case "subagent_cancelled":
				text = `${thread.threadName} cancelled`;
				break;
			case "subagent_timed_out":
				text = `${thread.threadName} timed out`;
				break;
			case "subagent_progress":
				text = `${thread.threadName} progress${childTool}`;
				break;
			default:
				text = `${thread.threadName} ${snapshot.phase}${childTool}`;
				break;
		}
		return {
			kind,
			eventType: eventType ?? `subagent_${snapshot.phase}`,
			state,
			text: retainPayload(text),
			delegationToolName: snapshot.toolName,
			...(snapshot.currentTool ? { toolName: snapshot.currentTool } : {}),
			...(snapshot.toolCallId ? { toolCallId: snapshot.toolCallId } : {}),
			...(snapshot.summary ? { result: retainPayload(snapshot.summary) } : {}),
			raw: serializePayload(snapshot),
		};
	}

	function applyLane(snapshot: SubagentProgressSnapshot): void {
		const thread = ensureSubagentThread(snapshot);
		const existing = lanes.get(snapshot.streamKey);
		const lane: ObserveLane = {
			threadKey: thread.threadKey,
			threadId: thread.threadId,
			...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
			mainThreadId: thread.mainThreadId,
			threadKind: thread.threadKind,
			threadName: thread.threadName,
			threadColor: thread.threadColor,
			streamKey: snapshot.streamKey,
			runId: snapshot.runId,
			role: snapshot.role,
			toolName: snapshot.toolName,
			status: snapshot.status,
			phase: snapshot.phase,
			terminal: snapshot.terminal,
			startedAtMs: snapshot.startedAtMs,
			elapsedMs: snapshot.elapsedMs,
			currentTool: snapshot.currentTool,
			currentPath: snapshot.currentPath,
			model: snapshot.model,
			attempt: snapshot.attempt,
			eventType: snapshot.eventType,
			summary: snapshot.summary,
		};
		if (existing?.terminal && !lane.terminal) return;
		if (!existing && lane.terminal && terminalLaneOrder.length >= MAX_TERMINAL_LANES) {
			const evicted = terminalLaneOrder.shift();
			if (evicted) lanes.delete(evicted);
		}
		const activity = subagentTransition(existing, snapshot, thread);
		if (activity) pushItem(activity, thread);
		lanes.set(lane.streamKey, lane);
		if (lane.terminal && !existing?.terminal) {
			terminalLaneOrder.push(lane.streamKey);
		}
	}

	function handleEvent(event: unknown): void {
		if (!event || typeof event !== "object") return;
		const e = event as { type: string } & Record<string, unknown>;
		switch (e.type) {
			case "message_start": {
				const message = e.message as AgentMessage;
				if (message.role !== "user") break;
				const text = messageText(message);
				const skill = parseSkillBlock(text);
				if (skill) {
					pushItem({
						kind: "skill",
						eventType: e.type,
						text: retainPayload(`/${skill.name}${skill.userMessage ? ` ${skill.userMessage}` : ""}`),
						raw: serializePayload(message),
					});
				} else {
					pushItem({
						kind: "message",
						eventType: e.type,
						role: "user",
						text: retainPayload(text),
						raw: serializePayload(message),
					});
				}
				break;
			}
			case "message_end": {
				const message = e.message as AgentMessage;
				if (message.role !== "assistant") break;
				usageTotals = {
					input: usageTotals.input + message.usage.input,
					output: usageTotals.output + message.usage.output,
					cacheRead: usageTotals.cacheRead + message.usage.cacheRead,
					cacheWrite: usageTotals.cacheWrite + message.usage.cacheWrite,
					cost: usageTotals.cost + message.usage.cost.total,
				};
				const text = messageText(message);
				if (text.trim().length > 0) {
					pushItem({
						kind: "message",
						eventType: e.type,
						role: "assistant",
						text: retainPayload(text),
						raw: serializePayload(message),
					});
				}
				emit({ type: "header" });
				break;
			}
			case "tool_execution_start": {
				pushItem({
					kind: "tool",
					eventType: e.type,
					toolCallId: String(e.toolCallId),
					toolName: String(e.toolName),
					state: "running",
					args: serializePayload(e.args ?? null),
					raw: serializePayload(e),
					updates: 0,
				});
				break;
			}
			case "tool_execution_update": {
				const toolName = String(e.toolName);
				const snapshot = getSubagentSnapshot(e.partialResult);
				if ((OBSERVATORY_TOOL_NAMES as readonly string[]).includes(toolName) && snapshot) {
					applyLane(snapshot);
					const lane = lanes.get(snapshot.streamKey);
					if (lane) emit({ type: "lane", lane });
					break;
				}
				const item = findToolItem(String(e.toolCallId));
				if (item) {
					item.updates = (item.updates ?? 0) + 1;
					emit({ type: "activity_update", item });
				}
				break;
			}
			case "tool_execution_end": {
				const toolCallId = String(e.toolCallId);
				const item = findToolItem(toolCallId);
				if (item) {
					item.state = e.isError ? "error" : "done";
					item.eventType = e.type;
					item.result = retainPayload(resultText(e.result));
					item.raw = serializePayload(e.result);
					item.durationMs = Math.max(0, Date.now() - item.ts);
					emit({ type: "activity_update", item });
				} else {
					pushItem({
						kind: "tool",
						eventType: e.type,
						toolCallId,
						toolName: String(e.toolName),
						state: e.isError ? "error" : "done",
						result: retainPayload(resultText(e.result)),
						raw: serializePayload(e.result),
						durationMs: 0,
					});
				}
				emit({ type: "header" });
				break;
			}
			case "compaction_start": {
				pushItem({
					kind: "compaction",
					eventType: e.type,
					text: `started (${String(e.reason)})`,
					raw: serializePayload({ reason: e.reason }),
				});
				break;
			}
			case "compaction_end": {
				const parts = [`finished (${String(e.reason)})`];
				if (e.aborted === true) parts.push("aborted");
				if (e.willRetry === true) parts.push("will retry");
				if (typeof e.errorMessage === "string" && e.errorMessage.length > 0) {
					parts.push(`error: ${retainPayload(e.errorMessage)}`);
				}
				const result = e.result;
				const summary =
					typeof result === "object" &&
					result !== null &&
					typeof (result as { summary?: unknown }).summary === "string"
						? retainPayload((result as { summary: string }).summary)
						: undefined;
				pushItem({
					kind: "compaction",
					eventType: e.type,
					text: parts.join(", "),
					result: summary,
					raw: serializePayload({
						reason: e.reason,
						result: e.result,
						aborted: e.aborted,
						willRetry: e.willRetry,
						errorMessage: e.errorMessage,
					}),
				});
				break;
			}
			case "auto_retry_start": {
				pushItem({
					kind: "retry",
					eventType: e.type,
					text: `attempt ${String(e.attempt)}/${String(e.maxAttempts)} in ${String(e.delayMs)}ms`,
					raw: serializePayload(e),
				});
				break;
			}
			case "auto_retry_end": {
				const detail = e.success ? "succeeded" : `failed: ${retainPayload(String(e.finalError ?? ""))}`;
				pushItem({
					kind: "retry",
					eventType: e.type,
					text: `attempt ${String(e.attempt)} ${detail}`,
					raw: serializePayload(e),
				});
				break;
			}
			case "queue_update": {
				const steering = (e.steering as readonly string[]).length;
				const followUp = (e.followUp as readonly string[]).length;
				pushItem({
					kind: "queue",
					eventType: e.type,
					text: `${steering} steering, ${followUp} follow-up`,
					raw: serializePayload(e),
				});
				break;
			}
			default:
				break;
		}
	}

	function buildHeader(): ObserveHeader {
		const model = session.model;
		return {
			runId,
			sessionId: session.sessionId,
			mainThreadId: mainThread.threadId,
			mainThreadName: mainThread.threadName,
			sessionName: session.sessionName,
			model: model ? `${model.provider}/${model.id}` : null,
			thinkingLevel: session.thinkingLevel,
			context: session.getContextUsage(),
			usage: { ...usageTotals },
			startedAt,
		};
	}

	try {
		persistence?.recordRun(buildHeader());
		persistence?.recordEvent({ type: "thread", thread: mainThread }, buildHeader());
	} catch {
		// Observability persistence is advisory and cannot affect the agent loop.
	}
	const unsubscribe = session.subscribe(handleEvent);
	const pollTimer = pollMs > 0 ? setInterval(() => emit({ type: "header" }), pollMs) : undefined;

	return {
		getState(): ObserveState {
			return { ...buildHeader(), items: [...items], lanes: [...lanes.values()], threads: [...threads.values()] };
		},
		getHeader: buildHeader,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		stop() {
			unsubscribe();
			if (pollTimer) clearInterval(pollTimer);
			try {
				persistence?.finishRun(runId, Date.now());
				persistence?.close();
			} catch {
				// Observability persistence is advisory and cannot affect shutdown.
			}
			listeners.clear();
		},
	};
}
