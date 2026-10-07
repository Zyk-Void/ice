/** Legacy subagent runtime helpers: errors, activity digests, child abort/shutdown, startup await (moved from ice-subagents.ts). */
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { emitSessionShutdownEvent } from "../../core/extensions/runner.ts";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { CreateAgentSessionResult } from "../../core/sdk.ts";
import { redactCredentialText } from "../../utils/redact.ts";
import { isRecord } from "../results/report.ts";
import { isPathWithin } from "../tools/paths.ts";
import {
	SUBAGENT_CONTEXT_PACKET_LIMITS,
	SUBAGENT_SCOPE_FIELD,
	SUBAGENT_SCOPE_ROOT_HINT,
	SUBAGENT_SCOPE_TARGET_FIELD,
	SUBAGENT_SCOPE_TARGET_HINT,
	type SubagentContextItemInput,
	type SubagentContextPacket,
	type SubagentContextPacketInput,
	type SubagentFailureCode,
} from "../types.ts";
import type { SubagentToolActivityDigest } from "./supervisor.ts";

export function modelLabel(model: Model<Api> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

export function requireParentModel(ctx: ExtensionContext): Model<Api> {
	const model = ctx.model as Model<Api> | undefined;
	if (!model) throw new SubagentError("model_unavailable", "Subagent launch requires a current parent model.");
	return model;
}

export function extractProgressPath(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const input = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath", "root", "cwd"]) {
		if (typeof input[key] === "string") return input[key];
	}
	return undefined;
}

export function displayScopedSubagentPath(
	cwd: string,
	scopeRoots: readonly string[],
	value: string | undefined,
): string | undefined {
	if (!value) return undefined;
	try {
		const candidate = resolve(cwd, value);
		if (!scopeRoots.some((root) => isPathWithin(root, candidate))) return undefined;
		return relative(cwd, candidate) || ".";
	} catch {
		return undefined;
	}
}

function boundedSubagentActivityPreview(value: string | undefined, maxBytes = 192): string | undefined {
	if (!value) return undefined;
	const singleLine = redactCredentialText(value)
		.replace(/[\u0000\r\n\t]+/g, " ")
		.trim();
	if (!singleLine) return undefined;
	const bytes = Buffer.from(singleLine);
	if (bytes.length <= maxBytes) return singleLine;
	let end = maxBytes;
	while (end > 0 && bytes.subarray(0, end).toString("utf8").endsWith("\ufffd")) end -= 1;
	return `${bytes.subarray(0, end).toString("utf8")}…`;
}

export function stringToolArgument(args: unknown, ...keys: string[]): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const input = args as Record<string, unknown>;
	for (const key of keys) {
		if (typeof input[key] === "string") return input[key];
	}
	return undefined;
}

export function buildSubagentToolActivityDigest(
	toolCallId: string,
	toolName: string,
	args: unknown,
	cwd: string,
	scopeRoots: readonly string[],
	outcome: SubagentToolActivityDigest["status"],
	startedAtMs: number,
	finishedAtMs?: number,
	metadata?: { exitCode?: number; errorClass?: string },
): SubagentToolActivityDigest {
	const normalizedTool = toolName.toLowerCase();
	const rawPath = extractProgressPath(args);
	const path = displayScopedSubagentPath(cwd, scopeRoots, rawPath);
	const displayPath = path ?? (rawPath ? "<outside approved scope>" : undefined);
	let action: string;
	if (normalizedTool === "bash") {
		// First logical command line only: bounded, redacted, no multi-line or chained dump.
		const command = boundedSubagentActivityPreview(
			stringToolArgument(args, "command", "cmd")?.split(/\r?\n|&&|;/)[0],
			192,
		);
		action = command ? `bash "${command}"` : "bash <redacted command>";
	} else if (normalizedTool === "grep") {
		const pattern = boundedSubagentActivityPreview(stringToolArgument(args, "pattern", "query"), 96);
		action = `grep${pattern ? ` "${pattern}"` : ""}${displayPath ? ` in ${displayPath}` : ""}`;
	} else if (normalizedTool === "find") {
		const pattern = boundedSubagentActivityPreview(stringToolArgument(args, "pattern", "glob", "query"), 96);
		action = `find${pattern ? ` "${pattern}"` : ""}${displayPath ? ` in ${displayPath}` : ""}`;
	} else if (
		normalizedTool === "read" ||
		normalizedTool === "write" ||
		normalizedTool === "edit" ||
		normalizedTool === "ls"
	) {
		action = `${normalizedTool}${displayPath ? ` ${displayPath}` : ""}`;
	} else {
		action = `${toolName}${displayPath ? ` ${displayPath}` : ""}`;
	}
	return Object.freeze({
		toolCallId,
		toolName,
		action: boundedSubagentActivityPreview(action, 256) ?? toolName,
		status: outcome,
		...(path ? { path } : {}),
		// Phase 4.4: bounded digest of the full serialized arguments so the
		// supervisor can detect materially identical repeated calls.
		argsDigest: createHash("sha256").update(safeSubagentArgsJson(args)).digest("hex").slice(0, 16),
		startedAtMs,
		...(finishedAtMs !== undefined ? { finishedAtMs } : {}),
		...(metadata?.exitCode !== undefined ? { exitCode: metadata.exitCode } : {}),
		...(metadata?.errorClass ? { errorClass: metadata.errorClass } : {}),
	});
}

function safeSubagentArgsJson(args: unknown): string {
	try {
		return JSON.stringify(args) ?? "";
	} catch {
		return String(typeof args);
	}
}

/**
 * Extract a bounded exit code from a bash tool result without retaining output:
 * tool result details first, then the strict trailing status line only.
 */
export function extractBashExitCode(result: unknown): number | undefined {
	if (!result || typeof result !== "object") return undefined;
	const details = (result as { details?: unknown }).details;
	if (details && typeof details === "object") {
		const exitCode = (details as { exitCode?: unknown }).exitCode;
		if (typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 65_535) {
			return exitCode;
		}
	}
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((part) =>
			part && typeof part === "object" && (part as { type?: unknown }).type === "text"
				? (part as { text?: unknown }).text
				: "",
		)
		.filter((text): text is string => typeof text === "string")
		.join("\n");
	const match = /(?:^|\n)[^\n]*Command (?:exited with|aborted|timed out).*?(\d{1,5})\s*$/im.exec(text);
	if (!match) return undefined;
	const parsed = Number.parseInt(match[1] ?? "", 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : undefined;
}

const CHILD_ABORT_GRACE_MS = 1_000;

export async function abortChildSession(session: { abort: () => Promise<void> }): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			Promise.resolve(session.abort()).catch(() => {}),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, CHILD_ABORT_GRACE_MS);
			}),
		]);
	} catch {
		// Cancellation is best effort; disposal and parent cleanup remain authoritative.
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function shutdownChildSession(session: CreateAgentSessionResult["session"]): Promise<void> {
	try {
		await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
	} finally {
		session.dispose();
	}
}

export interface SubagentErrorDetails {
	readonly field?: string;
	readonly path?: string;
	readonly hint?: string;
	readonly taskId?: string;
}

export class SubagentError extends Error {
	readonly code: SubagentFailureCode;
	readonly retryable: boolean;
	readonly details?: SubagentErrorDetails;

	constructor(code: SubagentFailureCode, message: string, retryable = false, details?: SubagentErrorDetails) {
		super(message);
		this.name = "SubagentError";
		this.code = code;
		this.retryable = retryable;
		this.details = details;
	}
}

export function invalidSubagentScope(
	message: string,
	path?: string,
	hint = SUBAGENT_SCOPE_ROOT_HINT,
	workspace?: string,
): SubagentError {
	const workspaceHint = workspace
		? ` Current workspace: ${workspace}. Use "." for the current workspace, or an existing relative directory under it.`
		: "";
	return new SubagentError("invalid_scope", `${message}${workspaceHint}`, false, {
		field: SUBAGENT_SCOPE_FIELD,
		...(path !== undefined ? { path } : {}),
		hint: `${hint}${workspaceHint}`,
	});
}

export function invalidSubagentTarget(message: string, path?: string): SubagentError {
	return new SubagentError("invalid_scope", message, false, {
		field: SUBAGENT_SCOPE_TARGET_FIELD,
		...(path !== undefined ? { path } : {}),
		hint: SUBAGENT_SCOPE_TARGET_HINT,
	});
}

export function withBatchTaskContext(error: unknown, taskId: string): SubagentError {
	const failure =
		error instanceof SubagentError
			? error
			: new SubagentError("malformed_result", error instanceof Error ? error.message : String(error));
	return new SubagentError(failure.code, `Batch task "${taskId}" rejected: ${failure.message}`, failure.retryable, {
		...failure.details,
		taskId,
	});
}

export interface SubagentToolErrorDetails {
	readonly error: {
		readonly code: SubagentFailureCode;
		readonly message: string;
		readonly retryable: boolean;
		readonly details?: SubagentErrorDetails;
	};
}

export function formatSubagentToolError(error: unknown): SubagentToolErrorDetails {
	const failure =
		error instanceof SubagentError
			? error
			: new SubagentError("malformed_result", error instanceof Error ? error.message : String(error));
	return {
		error: {
			code: failure.code,
			message: redactCredentialText(failure.message),
			retryable: failure.retryable,
			...(failure.details ? { details: failure.details } : {}),
		},
	};
}

export function formatManagedIdentifierError(error: unknown, runId: string): string {
	const message = redactCredentialText(error instanceof Error ? error.message : String(error));
	const resultRefHint = runId.startsWith("job:")
		? " The supplied value looks like a resultRef; remove the `job:` prefix and use the resulting bare jobId with inspect_subagent_job or cancel_subagent_job instead."
		: "";
	return `${message} manage_subagent requires a foreground runId returned by delegate (use details.managed.runId for a live background launch or details.result.runId for a retained terminal result); it does not accept a durable jobId, resultRef, batchId, or taskId.${resultRefHint}`;
}

export function formatDurableJobIdentifierError(error: unknown, jobId: string): string {
	const message = redactCredentialText(error instanceof Error ? error.message : String(error));
	const resultRefHint = jobId.startsWith("job:")
		? " The supplied value is a resultRef, not a jobId; pass the bare value returned as details.accepted.jobId."
		: "";
	return `${message} This tool requires the bare durable jobId returned as details.accepted.jobId by delegate_async; do not pass a resultRef (job:<id>), foreground runId, batchId, or taskId.${resultRefHint}`;
}

type StartupControlReason = "cancelled" | "deadline_exceeded";
type StartupOutcome<T> =
	| { kind: "completed"; value: T }
	| { kind: "error"; error: unknown }
	| { kind: StartupControlReason };

export async function awaitSubagentStartup<T>(
	startup: Promise<T>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<StartupOutcome<T>> {
	let timer: NodeJS.Timeout | undefined;
	let removeAbortListener: (() => void) | undefined;
	let resolveControl: ((reason: StartupControlReason) => void) | undefined;
	const control = new Promise<StartupControlReason>((resolve) => {
		resolveControl = resolve;
	});
	const startupOutcome = startup.then(
		(value): StartupOutcome<T> => ({ kind: "completed", value }),
		(error): StartupOutcome<T> => ({ kind: "error", error }),
	);
	const abortListener = () => resolveControl?.("cancelled");
	if (signal) {
		if (signal.aborted) resolveControl?.("cancelled");
		else {
			signal.addEventListener("abort", abortListener, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", abortListener);
		}
	}
	timer = setTimeout(() => resolveControl?.("deadline_exceeded"), timeoutMs);
	try {
		return await Promise.race([startupOutcome, control.then((kind) => ({ kind }))]);
	} finally {
		if (timer) clearTimeout(timer);
		removeAbortListener?.();
	}
}

export function normalizeSubagentContextPacket(
	packet: SubagentContextPacketInput | undefined,
	legacyContext?: string,
): SubagentContextPacket {
	const inputs: SubagentContextItemInput[] = [];
	if (legacyContext !== undefined) {
		if (typeof legacyContext !== "string") {
			throw new SubagentError("malformed_result", "Subagent context must be a string.");
		}
		const content = redactCredentialText(legacyContext.trim());
		if (content) inputs.push({ id: "parent-context", kind: "parent_note", content });
	}
	if (packet !== undefined) {
		if (!isRecord(packet) || !Array.isArray(packet.items)) {
			throw new SubagentError("malformed_result", "Subagent context packet must contain an item array.");
		}
		for (const item of packet.items) {
			if (!isRecord(item)) {
				throw new SubagentError("malformed_result", "Subagent context packet items must be objects.");
			}
			const id = typeof item.id === "string" ? item.id.trim() : "";
			const kind = item.kind;
			const content = typeof item.content === "string" ? redactCredentialText(item.content.trim()) : "";
			if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
				throw new SubagentError("malformed_result", `Invalid context packet item ID: ${id}`);
			}
			if (kind !== "parent_note" && kind !== "verified_fact" && kind !== "evidence_ref" && kind !== "artifact_ref") {
				throw new SubagentError("malformed_result", `Invalid context packet item kind for ${id}.`);
			}
			if (!content) {
				throw new SubagentError("malformed_result", `Context packet item ${id} must be nonempty.`);
			}
			inputs.push({ id, kind, content });
		}
	}
	if (inputs.length > SUBAGENT_CONTEXT_PACKET_LIMITS.maxItems) {
		throw new SubagentError("malformed_result", "Context packet contains too many items.");
	}
	const ids = new Set<string>();
	let totalBytes = 0;
	const items = inputs.map((input) => {
		if (ids.has(input.id)) {
			throw new SubagentError("malformed_result", `Context packet item IDs must be unique: ${input.id}`);
		}
		ids.add(input.id);
		const bytes = Buffer.byteLength(input.content);
		if (bytes > SUBAGENT_CONTEXT_PACKET_LIMITS.maxItemBytes) {
			throw new SubagentError("malformed_result", `Context packet item exceeds the per-item byte cap: ${input.id}`);
		}
		totalBytes += bytes;
		if (totalBytes > SUBAGENT_CONTEXT_PACKET_LIMITS.maxTotalBytes) {
			throw new SubagentError("malformed_result", "Context packet exceeds the aggregate byte cap.");
		}
		return Object.freeze({ ...input, bytes });
	});
	const frozenItems = Object.freeze(items);
	return Object.freeze({ items: frozenItems, totalBytes });
}
