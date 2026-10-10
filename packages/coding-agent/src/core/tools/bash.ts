import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentTool } from "@zykairotis/ice-agent-core";
import { Container, Text, truncateToWidth } from "@zykairotis/ice-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { clearSessionEnvironment } from "../legacy-compat/env.ts";
import type { BashBackgroundRegistry } from "./bash-background.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/** Seconds to milliseconds; 0 (which models send to mean "none") is no timeout. */
function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined || timeout === 0) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Timeout in seconds; omit it (or pass 0) for no timeout. It also stops a background shell, so omit it for servers and watchers.",
		}),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Start the command as a background shell and return its id at once (for servers, watchers, and long builds or tests). Check it with bash_output and stop it with bash_kill; its final output also arrives as a message when it exits.",
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	/** Set when the command runs as a background shell; the result holds output so far. */
	backgroundTaskId?: string;
	/** Who sent it there: the model (`run_in_background`) or the user (ctrl+b). */
	backgroundOrigin?: "model" | "user";
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using ice's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want ice's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = getShellConfig(options?.shellPath);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = { ...getShellEnv() };
	clearSessionEnvironment(env);
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.ICE_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.ICE_SESSION_FILE = sessionFile;
		if (model) {
			env.ICE_PROVIDER = model.provider;
			env.ICE_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.ICE_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Ice session metadata as ICE_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/** Background shells: `run_in_background` and the user's ctrl+b. Omit to keep every call in the foreground. */
	background?: BashBackgroundRegistry;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	const background = options?.background;
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.${background ? " Set run_in_background for commands that keep running (dev servers, watchers, long test runs); do not append & yourself." : ""}`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		promptGuidelines: [
			...(exposeSessionEnvironment
				? ["Inspect ICE_* environment variables for current model and session details."]
				: []),
			...(background
				? [
						"Background shells (run_in_background, or moved there by the user) keep running between turns: check them with bash_output (optionally waiting for them to finish) instead of sleeping, and stop the ones you no longer need with bash_kill.",
					]
				: []),
		],
		parameters: bashSchema,
		async execute(
			toolCallId,
			{ command, timeout, run_in_background: runInBackground }: BashToolInput,
			signal?: AbortSignal,
			onUpdate?,
			ctx?,
		) {
			// Reject a bad timeout before anything starts, so a background shell cannot fail later on it.
			resolveTimeoutMs(timeout);
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook, exposeSessionEnvironment, ctx);
			const output = new OutputAccumulator({ tempFilePrefix: "ice-bash" });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			// A backgrounded call has already returned; later output goes to its background shell.
			let detached = false;
			let backgroundTaskId: string | undefined;
			const shellDecoder = new TextDecoder();
			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty || detached) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				if (backgroundTaskId)
					background?.appendOutput(backgroundTaskId, shellDecoder.decode(data, { stream: true }));
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			// The process listens to its own signal so a backgrounded command outlives this tool call.
			const execAbort = new AbortController();
			const forwardAbort = () => execAbort.abort();
			if (signal?.aborted) execAbort.abort();
			else signal?.addEventListener("abort", forwardAbort, { once: true });
			const startedAt = Date.now();

			const runToCompletion = async () => {
				try {
					let exitCode: number | null;
					try {
						const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
							onData: handleData,
							signal: execAbort.signal,
							// Custom operations see "no timeout" the same way, whatever the model sent.
							timeout: timeout || undefined,
							env: spawnContext.env,
						});
						exitCode = result.exitCode;
					} catch (err) {
						const snapshot = await finishOutput();
						const { text } = formatOutput(snapshot, "");
						if (err instanceof Error && err.message === "aborted") {
							throw new Error(appendStatus(text, "Command aborted"));
						}
						if (err instanceof Error && err.message.startsWith("timeout:")) {
							const timeoutSecs = err.message.split(":")[1];
							throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
						}
						throw err;
					}

					const snapshot = await finishOutput();
					const { text: outputText, details } = formatOutput(snapshot);
					if (exitCode !== 0 && exitCode !== null) {
						throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
					}
					return { content: [{ type: "text" as const, text: outputText }], details };
				} finally {
					clearUpdateTimer();
					signal?.removeEventListener("abort", forwardAbort);
				}
			};

			if (runInBackground && !background) {
				throw new Error("Background shells are not available here; run the command without run_in_background.");
			}
			if (!background) return await runToCompletion();

			const settledOutcome = (completion: Promise<{ content: Array<{ type: "text"; text: string }> }>) =>
				completion.then(
					(result) => ({ text: result.content[0]?.text ?? "", isError: false }),
					(err: unknown) => ({ text: err instanceof Error ? err.message : String(err), isError: true }),
				);

			if (runInBackground) {
				// Started detached: the tool call returns at once, and its own abort no longer stops the shell.
				detached = true;
				signal?.removeEventListener("abort", forwardAbort);
				const completion = runToCompletion();
				backgroundTaskId = background.adopt(
					command,
					startedAt,
					() => execAbort.abort(),
					settledOutcome(completion),
					{
						origin: "model",
					},
				);
				return {
					content: [
						{
							type: "text",
							text: `Started background shell ${backgroundTaskId}. Check it with bash_output (id "${backgroundTaskId}", optionally wait_seconds to wait for it to finish); stop it with bash_kill. Its final output also arrives as a message when it exits.`,
						},
					],
					details: { backgroundTaskId, backgroundOrigin: "model" },
				};
			}

			let releaseCall!: () => void;
			const released = new Promise<"released">((resolve) => {
				releaseCall = () => resolve("released");
			});
			const unregister = background.registerForeground(toolCallId, command, releaseCall);
			const completion = runToCompletion();
			try {
				const first = await Promise.race([completion.then(() => "settled" as const), released]);
				if (first === "settled") return await completion;
			} catch {
				return await completion;
			} finally {
				unregister();
			}

			detached = true;
			signal?.removeEventListener("abort", forwardAbort);
			const snapshot = output.snapshot({ persistIfTruncated: true });
			const taskId = background.adopt(command, startedAt, () => execAbort.abort(), settledOutcome(completion), {
				origin: "user",
				initialOutput: snapshot.content,
			});
			backgroundTaskId = taskId;
			const soFar = snapshot.content ? `Output so far:\n${snapshot.content}` : "No output yet.";
			return {
				content: [
					{
						type: "text",
						text: `The user moved this command to the background as ${taskId}; it is still running. ${soFar}\n\nCheck it with bash_output (id "${taskId}") and stop it with bash_kill; its final output also arrives as a follow-up message when it exits. Do not report or assume its result before then: continue other work, or end your turn if nothing else is left.`,
					},
				],
				details: {
					backgroundTaskId: taskId,
					backgroundOrigin: "user",
					...(snapshot.truncation.truncated
						? { truncation: snapshot.truncation, fullOutputPath: snapshot.fullOutputPath }
						: {}),
				},
			};
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
