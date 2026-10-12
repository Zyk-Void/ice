/**
 * Model-facing tools for background shells: `bash_output` reads a shell's status and new
 * output (optionally waiting for it to finish), `bash_kill` stops one. Both are active
 * exactly when `bash` is, since only bash starts background shells.
 */
import { Text } from "@zykairotis/ice-tui";
import { type Static, Type } from "typebox";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { type BackgroundShellSnapshot, type BashBackgroundRegistry, USER_MESSAGE_POLL_MS } from "./bash-background.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "./truncate.ts";

export const BASH_SHELL_TOOL_NAMES = ["bash_output", "bash_kill"] as const;

/** Longest single `bash_output` wait; longer waits are split across calls so the turn stays interruptible. */
export const MAX_WAIT_SECONDS = 300;

const bashOutputSchema = Type.Object({
	id: Type.Optional(
		Type.String({ description: "Background shell id (for example bash-1). Omit to list every background shell." }),
	),
	wait_seconds: Type.Optional(
		Type.Number({
			description: `Wait up to this many seconds (max ${MAX_WAIT_SECONDS}) for the shell to finish before reporting. Only when you need the result now and have nothing else to do; a user message ends the wait early.`,
		}),
	),
});

const bashKillSchema = Type.Object({
	id: Type.String({ description: "Background shell id to stop (for example bash-1)" }),
});

export type BashOutputInput = Static<typeof bashOutputSchema>;
export type BashKillInput = Static<typeof bashKillSchema>;

export function formatShellRuntime(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusLine(shell: BackgroundShellSnapshot, now: number): string {
	const runtime = formatShellRuntime((shell.endedAt ?? now) - shell.startedAt);
	return `${shell.taskId}: ${shell.status} (${runtime}) $ ${shell.command.split("\n", 1)[0]}`;
}

/** Output text capped like a foreground bash result, keeping the newest lines. */
function capOutput(text: string): string {
	const truncation = truncateTail(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return truncation.truncated
		? `[earlier output omitted: showing the last ${truncation.outputLines} of ${truncation.totalLines} lines]\n${truncation.content}`
		: truncation.content;
}

export function createBashOutputToolDefinition(
	registry: BashBackgroundRegistry,
	now: () => number = Date.now,
): ToolDefinition<typeof bashOutputSchema, { shells: BackgroundShellSnapshot["status"][] }> {
	return {
		name: "bash_output",
		label: "bash_output",
		description:
			"Check background shells started with bash run_in_background (or moved there by the user). With an id, returns the shell's status and the output written since your last check; wait_seconds waits for it to finish first. Without an id, lists every background shell. A shell's final output arrives as a message when it exits, so do not poll or wait repeatedly.",
		promptSnippet: "Check background shells: status and new output",
		parameters: bashOutputSchema,
		async execute(_toolCallId, { id, wait_seconds }: BashOutputInput, signal, _onUpdate, ctx) {
			if (!id) {
				const shells = registry.snapshots();
				const text =
					shells.length === 0
						? "No background shells."
						: shells.map((shell) => statusLine(shell, now())).join("\n");
				return { content: [{ type: "text", text }], details: { shells: shells.map((shell) => shell.status) } };
			}
			if (wait_seconds !== undefined && (!Number.isFinite(wait_seconds) || wait_seconds < 0)) {
				throw new Error("wait_seconds must be a non-negative number");
			}
			const waitMs = Math.min(wait_seconds ?? 0, MAX_WAIT_SECONDS) * 1000;
			// The user can always talk to the agent: a queued message ends the wait early.
			const interrupt = new AbortController();
			let interruptedByMessage = false;
			const stopForMessage = () => {
				if (!ctx?.hasPendingMessages()) return;
				interruptedByMessage = true;
				interrupt.abort();
			};
			const onAbort = () => interrupt.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) interrupt.abort();
			const poll = waitMs > 0 ? setInterval(stopForMessage, USER_MESSAGE_POLL_MS) : undefined;
			if (waitMs > 0) stopForMessage();
			let read: Awaited<ReturnType<BashBackgroundRegistry["read"]>>;
			try {
				read = await registry.read(id, { waitMs, signal: interrupt.signal });
			} finally {
				if (poll) clearInterval(poll);
				signal?.removeEventListener("abort", onAbort);
			}
			if (!read) {
				const known = registry.snapshots().map((shell) => shell.taskId);
				throw new Error(`Unknown background shell "${id}".${known.length ? ` Known: ${known.join(", ")}.` : ""}`);
			}
			const { shell, newOutput, omittedChars } = read;
			const parts = [statusLine(shell, now())];
			if (interruptedByMessage && shell.status === "running") {
				parts.push(
					"Stopped waiting because the user sent a message; read it now. The shell keeps running and its final output arrives as a message when it exits.",
				);
			}
			if (omittedChars > 0) parts.push(`[${omittedChars} characters of new output were dropped before this check]`);
			parts.push(newOutput ? capOutput(newOutput) : "(no new output)");
			if (shell.status !== "running" && shell.finalText) parts.push(`Final result:\n${capOutput(shell.finalText)}`);
			return { content: [{ type: "text", text: parts.join("\n\n") }], details: { shells: [shell.status] } };
		},
		renderCall(args, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const wait = args?.wait_seconds ? theme.fg("muted", ` (wait ${args.wait_seconds}s)`) : "";
			text.setText(theme.fg("toolTitle", theme.bold(`bash_output ${args?.id ?? "(all)"}`)) + wait);
			return text;
		},
	};
}

export function createBashKillToolDefinition(
	registry: BashBackgroundRegistry,
): ToolDefinition<typeof bashKillSchema, undefined> {
	return {
		name: "bash_kill",
		label: "bash_kill",
		description: "Stop a running background shell (started with bash run_in_background) and its child processes.",
		promptSnippet: "Stop a background shell",
		parameters: bashKillSchema,
		async execute(_toolCallId, { id }: BashKillInput) {
			const shell = registry.get(id);
			if (!shell) throw new Error(`Unknown background shell "${id}".`);
			if (!registry.kill(id))
				return { content: [{ type: "text", text: `${id} already ${shell.status}.` }], details: undefined };
			return { content: [{ type: "text", text: `Stopped ${id}.` }], details: undefined };
		},
		renderCall(args, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold(`bash_kill ${args?.id ?? ""}`)));
			return text;
		},
	};
}
