/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import { ModelsError } from "@zykairotis/ice-ai";
import { CombinedAutocompleteProvider, type SlashCommand } from "@zykairotis/ice-tui";
import { FileArgumentError, processFileArguments } from "../../cli/file-processor.ts";
import { getSessionsDir } from "../../config.ts";
import {
	type AgentSessionRuntime,
	SessionImportFileNotFoundError,
	SessionRuntimeUnavailableError,
} from "../../core/agent-session-runtime.ts";
import { computeCacheWaste } from "../../core/cache-stats.ts";
import type {
	ExtensionChromeOptions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import type { ToolResultEvent } from "../../core/extensions/types.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import {
	configureRawStdoutLimit,
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { deleteSessionFile, SessionManager } from "../../core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import type { IceAgentViewBridge } from "../../ice-agent-view-bridge.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { getToolPath } from "../../utils/tools-manager.ts";
import { getAvailableThemesWithPaths, getThemeByName, type Theme, theme } from "../interactive/theme/theme.ts";
import { toJsonEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { RPC_MAX_PENDING_COMMANDS, RpcCommandCoordinator } from "./rpc-command-coordinator.ts";
import { RPC_LIVE_CONTROLS, RPC_MAX_OUTPUT_LINE_BYTES } from "./rpc-command-lanes.ts";
import {
	type CustomStructuredCommand,
	findCustomStructuredCommands,
	getIceSettingsCommandSchemaResult,
	ICE_SETTINGS_SCHEMA_ID,
	invokeIceSettingsCommand,
	mergeCustomStructuredCommandInventory,
	type RpcCommandErrorDetails,
	RpcCommandExecutionError,
	type RpcCommandSchemaResult,
	validateStructuredInvocation,
} from "./rpc-command-schema.ts";
import {
	RPC_MAX_CONTROL_INPUT_BYTES,
	RPC_MAX_LIVE_CONTROLS,
	RPC_MAX_RETAINED_INPUT_BYTES,
	RpcInputAdmission,
} from "./rpc-input-admission.ts";
import { pageAfterKey, pageMessages } from "./rpc-pages.ts";
import {
	RPC_CANCELLABLE_COMMANDS,
	RPC_MAX_REQUEST_TIMEOUT_MS,
	RpcRequestExecutionError,
	type RpcRequestScope,
	RpcRequestTracker,
} from "./rpc-request-tracker.ts";
import {
	applyRpcSetting,
	createRpcSettingsSnapshot,
	type RpcSettingsContext,
	RpcSettingsError,
} from "./rpc-settings.ts";
import type {
	RpcCommand,
	RpcCommandType,
	RpcCompletions,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcModelsChangedEvent,
	RpcModelsRefreshResult,
	RpcResponse,
	RpcSessionChangedEvent,
	RpcSessionState,
	RpcShellsUpdateEvent,
	RpcSlashCommand,
	RpcSubagentPatchAction,
	RpcSubagentPatchResult,
	RpcSubagentsUpdateEvent,
} from "./rpc-types.ts";
import { RpcUIStateStore } from "./rpc-ui-state.ts";
import { RPC_COMMAND_TYPES, RPC_MAX_INPUT_LINE_BYTES, validateRpcInput } from "./rpc-validation.ts";
import {
	getDiagnostics,
	getProviderSnapshot,
	getResources,
	getScopedModelRefs,
	listShellSummaries,
	listTools,
	readChangelog,
	readShellDetail,
	resolveScopedModels,
	toPublicModel,
	toSessionInfo,
} from "./rpc-views.ts";

export type {
	RpcSettingsConstraints,
	RpcSettingsDiagnostic,
	RpcSettingsErrorCode,
	RpcSettingsField,
	RpcSettingsFieldKind,
	RpcSettingsFieldScope,
	RpcSettingsSnapshot,
	RpcSettingsValue,
	RpcSettingUpdate,
} from "./rpc-settings.ts";
// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.ts";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export interface RpcModeOptions {
	/** ICE-only bridge exposing the subagent overview and approval answers. */
	agentViewBridge?: IceAgentViewBridge;
}

/** Quiet period before a burst of background-shell changes is reported as one `shells_update`. */
const SHELLS_UPDATE_DEBOUNCE_MS = 200;

const SESSION_TRANSITIONS = new Set<RpcCommand["type"]>([
	"new_session",
	"switch_session",
	"fork",
	"clone",
	"import_session",
	"reload",
	"navigate_tree",
]);
const MUTATIONS = new Set<RpcCommand["type"]>([
	"prompt",
	"steer",
	"follow_up",
	"clear_queue",
	"remove_queued_message",
	"set_active_tools",
	"set_scoped_models",
	"set_setting",
	"set_model",
	"cycle_model",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_fast_mode",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_auto_compaction",
	"set_auto_retry",
	"set_entry_label",
	"set_session_name",
	"get_commands",
	"get_completions",
	"invoke_command",
	"invoke_shortcut",
	"subagent_patch",
	"refresh_models",
	"delete_session",
	"rename_session",
]);
const LIVE_CONTROLS = RPC_LIVE_CONTROLS;

/** Built-in interactive commands that have a direct RPC command; the rest need the TUI. */
const BUILTIN_RPC_COMMANDS: Readonly<Record<string, RpcCommandType>> = {
	fast: "set_fast_mode",
	model: "set_model",
	"scoped-models": "set_scoped_models",
	export: "export_html",
	import: "import_session",
	name: "set_session_name",
	session: "get_session_stats",
	changelog: "get_changelog",
	shells: "get_shells",
	resources: "get_resources",
	fork: "fork",
	clone: "clone",
	tree: "navigate_tree",
	new: "new_session",
	compact: "compact",
	resume: "switch_session",
	reload: "reload",
};

/** Text and image files read for a prompt's `file` attachments, matching inline text attachments. */
const RPC_MAX_FILE_ATTACHMENT_BYTES = 1024 * 1024;

export async function runRpcMode(runtimeHost: AgentSessionRuntime, options: RpcModeOptions = {}): Promise<never> {
	takeOverStdout();
	configureRawStdoutLimit(RPC_MAX_OUTPUT_LINE_BYTES);
	const { agentViewBridge } = options;
	let session = runtimeHost.session;
	const coordinator = new RpcCommandCoordinator(
		() => session.isStreaming || session.isCompacting || session.isBashRunning,
	);
	let boundSessionId = session.sessionId;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let unsubscribeShells: (() => void) | undefined;
	let unsubscribeCatalog: (() => void) | undefined;
	let unsubscribeSettings: (() => void) | undefined;
	let unsubscribeBridge: (() => void) | undefined;
	let shellsUpdateTimer: ReturnType<typeof setTimeout> | undefined;
	let lastShellsUpdate = "";
	const requests = new RpcRequestTracker();
	const inputAdmission = new RpcInputAdmission();
	const uiState = new RpcUIStateStore();
	let transportFailed = false;
	const modelRefreshControllers = new Set<AbortController>();
	let lastCatalogRefreshFailed = false;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		if (transportFailed) return;
		if ("type" in obj && obj.type === "extension_ui_request") uiState.observe(obj as RpcExtensionUIRequest);
		try {
			writeRawStdout(serializeJsonLine(obj));
		} catch (failure) {
			if (
				failure instanceof Error &&
				"code" in failure &&
				failure.code === "output_too_large" &&
				"type" in obj &&
				obj.type === "response" &&
				"command" in obj &&
				typeof obj.command === "string"
			) {
				try {
					writeRawStdout(
						serializeJsonLine(
							error(
								"id" in obj && typeof obj.id === "string" ? obj.id : undefined,
								obj.command,
								"RPC response exceeds the output limit; request a paged or smaller view. Effects are not rolled back.",
								{ errorCode: "output_too_large" },
							),
						),
					);
					return;
				} catch {
					/* Even a small failure record cannot be admitted. Close instead of dropping state. */
				}
			}
			transportFailed = true;
			process.stderr.write("RPC output failed or exceeded its limit; transport is closing.\n");
			startShutdown(1);
		}
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (
		id: string | undefined,
		command: string,
		message: string,
		details?: { errorCode?: string; errorDetails?: RpcCommandErrorDetails },
	): RpcResponse => {
		return { id, type: "response", command, success: false, error: message, errorCode: "failed", ...details };
	};

	const reportModelsRefresh = (result: RpcModelsRefreshResult, providers?: string[]) => {
		if (!result.aborted) lastCatalogRefreshFailed = result.errors.length > 0;
		else if (result.errors.length > 0) lastCatalogRefreshFailed = true;
		result.hasCatalogError ||= lastCatalogRefreshFailed;
		output({ type: "models_changed", providers, result } satisfies RpcModelsChangedEvent);
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	let shutdownPromise: Promise<void> | undefined;
	let detachInput = () => {};
	let bootstrapping = true;
	let settleBootstrap!: () => void;
	const bootstrapReady = new Promise<void>((resolve) => {
		settleBootstrap = resolve;
	});
	const signalCleanupHandlers: Array<() => void> = [];

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (shuttingDown || opts?.signal?.aborted) return Promise.resolve(defaultValue);
		if (pendingExtensionRequests.size >= RPC_MAX_LIVE_CONTROLS) {
			return Promise.resolve(defaultValue);
		}

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(
				opts,
				undefined,
				{
					method: "select",
					title,
					options,
					...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }),
					...(opts?.content === undefined ? {} : { content: opts.content }),
				},
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(message?: string): void {
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setWorkingMessage",
				message,
			} satisfies RpcExtensionUIRequest);
		},

		setWorkingVisible(visible: boolean): void {
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setWorkingVisible",
				visible,
			} satisfies RpcExtensionUIRequest);
		},

		setWorkingIndicator(options?: WorkingIndicatorOptions): void {
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setWorkingIndicator",
				options,
			} satisfies RpcExtensionUIRequest);
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Factories are never executed headlessly. An explicit projection is data only.
			if (typeof content === "function" && options?.rpcText === undefined) return;
			const lines = typeof content === "function" ? options?.rpcText : content;
			if (
				lines === undefined ||
				(Array.isArray(lines) && lines.every((line: unknown) => typeof line === "string"))
			) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: lines as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		// Factories are never executed headlessly; only an explicit text projection is sent.
		setFooter(factory: unknown, options?: ExtensionChromeOptions): void {
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setFooter",
				lines: factory === undefined ? undefined : options?.rpcText,
			} satisfies RpcExtensionUIRequest);
		},

		setHeader(factory: unknown, options?: ExtensionChromeOptions): void {
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setHeader",
				lines: factory === undefined ? undefined : options?.rpcText,
			} satisfies RpcExtensionUIRequest);
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			return createDialogPromise(undefined, undefined, { method: "editor", title, prefill }, (response) =>
				"value" in response ? response.value : undefined,
			);
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return getAvailableThemesWithPaths();
		},

		getTheme(name: string) {
			return getThemeByName(name);
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	runtimeHost.setRebindSession(async () => {
		const previousSessionId = boundSessionId;
		await rebindSession();
		boundSessionId = session.sessionId;
		lastCatalogRefreshFailed = false;
		output({
			type: "session_changed",
			previousSessionId,
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			cwd: session.sessionManager.getCwd(),
			leafId: session.sessionManager.getLeafId(),
		} satisfies RpcSessionChangedEvent);
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		uiState.reset();
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => coordinator.runTransition(() => runtimeHost.newSession(options)),
				fork: async (entryId, forkOptions) => {
					const result = await coordinator.runTransition(() => runtimeHost.fork(entryId, forkOptions));
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await coordinator.runTransition(() =>
						session.navigateTree(targetId, {
							summarize: options?.summarize,
							customInstructions: options?.customInstructions,
							replaceInstructions: options?.replaceInstructions,
							label: options?.label,
						}),
					);
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return coordinator.runTransition(() => runtimeHost.switchSession(sessionPath, options));
				},
				reload: async () => {
					await coordinator.runTransition(() => session.reload({ beforeSessionStart: () => uiState.reset() }));
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
				checkShutdownRequested();
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		unsubscribeCatalog?.();
		unsubscribeSettings?.();
		unsubscribeCatalog = session.modelRuntime.subscribeChanges(() => {
			if (!shuttingDown) output({ type: "catalog_changed" });
		});
		unsubscribeSettings = session.settingsManager.subscribeChanges(() => {
			if (!shuttingDown) output({ type: "settings_changed" });
		});

		// Shells change on every output chunk; coalesce updates and skip identical consecutive ones.
		unsubscribeShells?.();
		if (shellsUpdateTimer) clearTimeout(shellsUpdateTimer);
		shellsUpdateTimer = undefined;
		lastShellsUpdate = "";
		const registry = session.bashBackground;
		unsubscribeShells = registry.onChange(() => {
			if (shellsUpdateTimer) return;
			shellsUpdateTimer = setTimeout(() => {
				shellsUpdateTimer = undefined;
				const shells = listShellSummaries(registry);
				const serialized = JSON.stringify(shells);
				if (serialized === lastShellsUpdate) return;
				lastShellsUpdate = serialized;
				output({ type: "shells_update", shells } satisfies RpcShellsUpdateEvent);
			}, SHELLS_UPDATE_DEBOUNCE_MS);
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			output(toJsonEvent(event));
			if (event.type === "agent_settled") {
				checkShutdownRequested();
			}
		});
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				startShutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	// Push subagent overview changes; identical consecutive overviews are not repeated.
	let lastSubagentOverview = "";
	unsubscribeBridge = agentViewBridge?.subscribe(() => {
		const overview = agentViewBridge.getSubagentOverview();
		if (!overview) return;
		const serialized = JSON.stringify(overview);
		if (serialized === lastSubagentOverview) return;
		lastSubagentOverview = serialized;
		output({ type: "subagents_update", overview } satisfies RpcSubagentsUpdateEvent);
	});

	// A user patch action runs the parent's registered `agent_patch` tool through the same
	// tool_call/tool_result extension hooks as a model call, so mode gates, the approved-plan
	// read gate, and mutation/verification tracking still apply; the runtime then enforces
	// trusted build authority and per-path parent permission itself.
	const runUserPatchAction = async (
		subagentId: string,
		action: RpcSubagentPatchAction,
	): Promise<RpcSubagentPatchResult> => {
		const tool = session.getRegisteredTool("agent_patch");
		if (!tool || !session.getActiveToolNames().includes("agent_patch")) {
			return { isError: true, text: "agent_patch is not available in this session's current mode." };
		}
		const toolCallId = `rpc-patch-${crypto.randomUUID()}`;
		const input: Record<string, unknown> = { action, id: subagentId };
		const runner = session.extensionRunner;
		const blocked = runner.hasHandlers("tool_call")
			? await runner.emitToolCall({ type: "tool_call", toolName: "agent_patch", toolCallId, input })
			: undefined;
		if (blocked?.block) {
			return { isError: true, text: blocked.reason ?? "An extension blocked agent_patch." };
		}
		let content: Array<{ type: string; text?: string }> = [];
		let details: unknown;
		let isError = false;
		try {
			const result = await tool.execute(toolCallId, input);
			content = result.content;
			details = result.details;
		} catch (err: unknown) {
			isError = true;
			content = [{ type: "text", text: err instanceof Error ? err.message : String(err) }];
		}
		const hooked = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: "agent_patch",
					toolCallId,
					input,
					content: content as ToolResultEvent["content"],
					details,
					isError,
				})
			: undefined;
		const finalContent = (hooked?.content ?? content) as Array<{ type: string; text?: string }>;
		return {
			isError: hooked?.isError ?? isError,
			text: finalContent.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(""),
			details: hooked?.details ?? details,
		};
	};

	const getSettingsContext = (): RpcSettingsContext => ({
		cwd: session.sessionManager.getCwd(),
		settingsManager: session.settingsManager,
		getExtensionSettings: () => session.extensionRunner.getRegisteredSettings(),
		applyLive: () => session.syncSettingsFromManager(),
	});

	/** Session file management stays inside the global or configured session directory. */
	const isSessionFilePath = (target: string): boolean =>
		target.endsWith(".jsonl") &&
		[getSessionsDir(), session.sessionManager.getSessionDir()].some((root) => {
			const relative = relativePath(resolvePath(root), target);
			return relative !== "" && !relative.startsWith("..") && !isAbsolute(relative);
		});

	const getCommandIdentitySources = (name: string): Set<string> => {
		const sources = new Set<string>();
		if (name === "settings") sources.add("builtin");
		for (const extensionCommand of session.extensionRunner.getRegisteredCommands()) {
			if (extensionCommand.invocationName === name) sources.add("extension");
		}
		for (const prompt of session.promptTemplates) {
			if (prompt.name === name) sources.add("prompt");
		}
		for (const skill of session.resourceLoader.getSkills().skills) {
			if (`skill:${skill.name}` === name) sources.add("skill");
		}
		for (const custom of findCustomStructuredCommands(name)) {
			sources.add(custom.source);
		}
		return sources;
	};

	// Handle a single command
	const handleCommand = async (command: RpcCommand, requestSignal?: AbortSignal): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				const filePaths = command.attachments?.flatMap((item) => (item.type === "file" ? [item.path] : [])) ?? [];
				let files: Awaited<ReturnType<typeof processFileArguments>> | undefined;
				if (filePaths.length > 0) {
					try {
						files = await processFileArguments(filePaths, {
							cwd: session.sessionManager.getCwd(),
							autoResizeImages: session.settingsManager.getImageAutoResize(),
							maxTextBytes: RPC_MAX_FILE_ATTACHMENT_BYTES,
						});
					} catch (failure) {
						if (!(failure instanceof FileArgumentError)) throw failure;
						return error(id, "prompt", failure.message, {
							errorCode: failure.code === "too_large" ? "invalid_argument" : failure.code,
						});
					}
				}
				const attachedText = [
					...(command.attachments ?? []).flatMap((item) =>
						item.type === "text"
							? [`<attachment name=${JSON.stringify(item.name)}>\n${item.text}\n</attachment>`]
							: [],
					),
					...(files?.text ? [files.text.trimEnd()] : []),
				].join("\n");
				const message = attachedText ? `${attachedText}\n\n${command.message}` : command.message;
				const attachedImages = [
					...(command.attachments ?? []).flatMap((item) =>
						item.type === "image" ? [{ type: "image" as const, data: item.data, mimeType: item.mimeType }] : [],
					),
					...(files?.images ?? []),
				];
				// Hold admission through preflight, not through streaming. A following transition
				// can then settle the accepted turn without racing its asynchronous input hooks.
				return new Promise<RpcResponse>((resolve, reject) => {
					void session
						.prompt(message, {
							images: [...(command.images ?? []), ...attachedImages],
							streamingBehavior: command.streamingBehavior,
							expandPromptTemplates: attachedText ? false : command.expandPromptTemplates,
							source: "rpc",
							preflightResult: (didSucceed) => {
								if (didSucceed) {
									if (shuttingDown)
										throw new RpcRequestExecutionError("cancelled", "RPC host is shutting down.");
									coordinator.retirePromptPreflight();
									resolve(success(id, "prompt"));
								}
							},
						})
						.catch(reject);
				});
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "get_queue": {
				return success(id, "get_queue", {
					steering: session.getSteeringMessages(),
					followUp: session.getFollowUpMessages(),
				});
			}

			case "clear_queue": {
				return success(id, "clear_queue", session.clearQueue());
			}

			case "remove_queued_message": {
				return success(id, "remove_queued_message", { removed: session.removeQueuedMessage(command.messageId) });
			}

			case "cancel_request": {
				return success(id, "cancel_request", { accepted: requests.cancel(command.requestId) });
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_capabilities": {
				return success(id, "get_capabilities", {
					protocolVersion: 1,
					commands: RPC_COMMAND_TYPES,
					features: [
						"validated_input",
						"queue_snapshot",
						"prompt_options",
						"working_status",
						"transition_barrier",
						"session_changed",
						"session_configuration_events",
						"provider_snapshot",
						"catalog_refresh",
						"entry_session_pagination",
						"bounded_admission",
						"request_cancellation",
						"shutdown_settlement",
						"bounded_transport_admission",
						"view_pagination",
						"runtime_invalidations",
						"safe_diagnostics",
						"command_completions",
						"ui_text_snapshot",
						"inline_attachments",
						"file_attachments",
						"argument_completions",
						"extension_flags",
						"extension_shortcuts",
						"session_file_management",
						"inline_export",
						"ui_chrome_text",
						"cache_stats",
						"explicit_runtime_recovery",
					],
					limits: {
						maxInputLineBytes: RPC_MAX_INPUT_LINE_BYTES,
						maxPendingCommands: RPC_MAX_PENDING_COMMANDS,
						maxRequestTimeoutMs: RPC_MAX_REQUEST_TIMEOUT_MS,
						maxRetainedInputBytes: RPC_MAX_RETAINED_INPUT_BYTES,
						maxControlInputBytes: RPC_MAX_CONTROL_INPUT_BYTES,
						maxLiveControls: RPC_MAX_LIVE_CONTROLS,
						maxQueuedOutputBytes: RPC_MAX_OUTPUT_LINE_BYTES,
					},
					cancellation: {
						commands: RPC_CANCELLABLE_COMMANDS,
						queuedCommands: RPC_COMMAND_TYPES.filter((type) => !LIVE_CONTROLS.has(type)),
						cooperative: true,
						includesQueueTime: true,
					},
					host: { subagents: agentViewBridge !== undefined },
				});
			}

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model ? toPublicModel(session.model) : undefined,
					thinkingLevel: session.thinkingLevel,
					fastMode: session.getFastMode(),
					fastModeAvailable: session.supportsFastMode(),
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					leafId: session.sessionManager.getLeafId(),
					sessionDir: session.sessionManager.getSessionDir(),
					persisted: session.sessionManager.isPersisted(),
					parentSessionPath: session.sessionManager.getHeader()?.parentSession,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
					cwd: session.sessionManager.getCwd(),
					contextUsage: session.getContextUsage(),
					autoRetryEnabled: session.autoRetryEnabled,
					isRetrying: session.isRetrying,
					retryAttempt: session.retryAttempt,
					isBashRunning: session.isBashRunning,
					backgroundShellCount: session.bashBackground.runningCount(),
				};
				return success(id, "get_state", state);
			}

			case "get_tools": {
				return success(id, "get_tools", { tools: listTools(session) });
			}

			case "set_active_tools": {
				if (!Array.isArray(command.toolNames) || command.toolNames.some((name) => typeof name !== "string")) {
					return error(id, "set_active_tools", "Expected toolNames: string[].");
				}
				const known = new Set(session.getAllTools().map((tool) => tool.name));
				const unknown = command.toolNames.filter((name) => !known.has(name));
				if (unknown.length > 0)
					return error(id, "set_active_tools", `Unknown tools: ${unknown.join(", ")}`, { errorCode: "not_found" });
				session.setActiveToolsByName(command.toolNames);
				return success(id, "set_active_tools", { active: session.getActiveToolNames() });
			}

			case "get_system_prompt": {
				return success(id, "get_system_prompt", { text: session.systemPrompt });
			}

			case "get_diagnostics":
				return success(id, "get_diagnostics", getDiagnostics(session));
			case "get_ui_state":
				return success(id, "get_ui_state", uiState.snapshot());
			case "get_completions": {
				const limit = command.limit ?? 100;
				const response = await handleCommand({ type: "get_commands" });
				if (!response?.success || response.command !== "get_commands")
					throw new Error("Command inventory unavailable.");
				// A bare slash token completes command names by prefix, keeping each item's source.
				if (command.prefix.startsWith("/") && !command.prefix.includes(" ")) {
					const name = command.prefix.slice(1);
					const matches = response.data.commands.filter((item) => item.name.startsWith(name));
					return success(id, "get_completions", {
						kind: "command",
						replace: command.prefix,
						items: matches
							.slice(0, limit)
							.map((item) => ({ value: `/${item.name}`, description: item.description, source: item.source })),
						hasMore: matches.length > limit,
					} satisfies RpcCompletions);
				}
				// Arguments, @file and path tokens use the interactive editor's provider unchanged.
				const argumentCompletions = new Map(
					session.extensionRunner
						.getRegisteredCommands()
						.map((registered) => [registered.invocationName, registered.getArgumentCompletions]),
				);
				const commands: SlashCommand[] = response.data.commands.map((item) => ({
					name: item.name,
					getArgumentCompletions: argumentCompletions.get(item.name),
				}));
				const provider = new CombinedAutocompleteProvider(
					commands,
					session.sessionManager.getCwd(),
					getToolPath("fd"),
				);
				const suggestions = await provider.getSuggestions([command.prefix], 0, command.prefix.length, {
					signal: requestSignal ?? new AbortController().signal,
				});
				const items = suggestions?.items ?? [];
				return success(id, "get_completions", {
					kind: command.prefix.startsWith("/") ? "argument" : "path",
					replace: suggestions?.prefix ?? "",
					items: items
						.slice(0, limit)
						.map((item) => ({ value: item.value, label: item.label, description: item.description })),
					hasMore: items.length > limit,
				} satisfies RpcCompletions);
			}

			case "get_resources": {
				return success(id, "get_resources", getResources(session));
			}

			case "get_changelog": {
				return success(id, "get_changelog", { entries: readChangelog() });
			}

			case "get_scoped_models": {
				return success(id, "get_scoped_models", { models: getScopedModelRefs(session) });
			}

			case "set_scoped_models": {
				if (
					!Array.isArray(command.models) ||
					command.models.some((ref) => typeof ref?.provider !== "string" || typeof ref?.modelId !== "string")
				) {
					return error(id, "set_scoped_models", "Expected models: [{ provider, modelId, thinkingLevel? }].");
				}
				session.setScopedModels(resolveScopedModels(session, command.models));
				return success(id, "set_scoped_models", { models: getScopedModelRefs(session) });
			}

			case "reload": {
				if (session.isStreaming || session.isCompacting) {
					return error(id, "reload", "Wait for the current turn or compaction to finish before reloading.", {
						errorCode: "busy",
					});
				}
				await session.reload({ beforeSessionStart: () => uiState.reset() });
				return success(id, "reload");
			}

			case "stop_after_turn": {
				session.requestStopAfterTurn();
				return success(id, "stop_after_turn");
			}

			case "get_flags": {
				const runner = session.extensionRunner;
				const values = runner.getFlagValues();
				return success(id, "get_flags", {
					flags: [...runner.getFlags().values()].map((flag) => ({
						name: flag.name,
						description: flag.description,
						type: flag.type,
						default: flag.default,
						value: values.get(flag.name),
						extensionPath: flag.extensionPath,
					})),
				});
			}

			case "get_shortcuts": {
				const shortcuts = session.extensionRunner.getShortcuts(KeybindingsManager.create().getEffectiveConfig());
				return success(id, "get_shortcuts", {
					shortcuts: [...shortcuts.values()].map((shortcut) => ({
						shortcut: shortcut.shortcut,
						description: shortcut.description,
						extensionPath: shortcut.extensionPath,
					})),
				});
			}

			case "invoke_shortcut": {
				const runner = session.extensionRunner;
				const key = command.shortcut.toLowerCase();
				const shortcut = [...runner.getShortcuts(KeybindingsManager.create().getEffectiveConfig()).values()].find(
					(candidate) => candidate.shortcut.toLowerCase() === key,
				);
				if (!shortcut) {
					return error(id, "invoke_shortcut", `Extension shortcut not found: ${command.shortcut}`, {
						errorCode: "not_found",
					});
				}
				await shortcut.handler(runner.createContext());
				return success(id, "invoke_shortcut");
			}

			// =================================================================
			// Background shells
			// =================================================================

			case "get_shells": {
				return success(id, "get_shells", { shells: listShellSummaries(session.bashBackground) });
			}

			case "get_shell": {
				if (
					typeof command.shellId !== "string" ||
					(command.sinceChars !== undefined && (!Number.isFinite(command.sinceChars) || command.sinceChars < 0))
				) {
					return error(id, "get_shell", "Expected shellId and an optional non-negative sinceChars.");
				}
				return success(
					id,
					"get_shell",
					readShellDetail(session.bashBackground, command.shellId, command.sinceChars),
				);
			}

			case "kill_shell": {
				if (typeof command.shellId !== "string") return error(id, "kill_shell", "Expected shellId.");
				return success(id, "kill_shell", {
					stopped: session.bashBackground.kill(command.shellId, { notify: true }),
				});
			}

			case "background_bash": {
				return success(id, "background_bash", { released: session.bashBackground.releaseAll() });
			}

			// =================================================================
			// Settings
			// =================================================================

			case "get_settings": {
				return success(id, "get_settings", createRpcSettingsSnapshot(getSettingsContext()));
			}

			case "set_setting": {
				const update = "data" in command ? command.data : command;
				const snapshot = await applyRpcSetting(getSettingsContext(), update);
				return success(id, "set_setting", snapshot);
			}

			// =================================================================
			// Subagents
			// =================================================================

			case "get_subagents": {
				return success(id, "get_subagents", agentViewBridge?.getSubagentOverview() ?? null);
			}

			case "respond_subagent_approval": {
				if (
					typeof command.approvalId !== "string" ||
					!["allow-once", "allow-session", "deny"].includes(command.answer)
				) {
					return error(
						id,
						"respond_subagent_approval",
						"Expected approvalId and answer allow-once, allow-session, or deny.",
					);
				}
				const accepted = agentViewBridge?.respondToSubagentApproval(command.approvalId, command.answer) ?? false;
				return success(id, "respond_subagent_approval", { accepted });
			}

			case "subagent_control": {
				if (
					typeof command.subagentId !== "string" ||
					!["stop", "resume", "delete", "send"].includes(command.action) ||
					(command.action === "send" && typeof command.message !== "string")
				) {
					return error(
						id,
						"subagent_control",
						"Expected subagentId and action stop, resume, delete, or send (send needs message).",
					);
				}
				if (!agentViewBridge) return error(id, "subagent_control", "No subagent runtime in this session.");
				const message = await agentViewBridge.controlSubagent(command.subagentId, command.action, command.message);
				return success(id, "subagent_control", { message });
			}

			case "subagent_patch": {
				if (typeof command.subagentId !== "string" || !["inspect", "apply", "reject"].includes(command.action)) {
					return error(id, "subagent_patch", "Expected subagentId and action inspect, apply, or reject.");
				}
				return success(id, "subagent_patch", await runUserPatchAction(command.subagentId, command.action));
			}

			case "get_subagent_messages": {
				if (typeof command.subagentId !== "string") {
					return error(id, "get_subagent_messages", "Expected subagentId.");
				}
				return success(
					id,
					"get_subagent_messages",
					agentViewBridge?.getSubagentTranscript(command.subagentId) ?? null,
				);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = session.modelRuntime.getAvailableSnapshot();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`, {
						errorCode: "not_found",
					});
				}
				await session.setModel(model);
				return success(id, "set_model", toPublicModel(model));
			}

			case "cycle_model": {
				const result = await session.cycleModel(command.direction);
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", { ...result, model: toPublicModel(result.model) });
			}

			case "abort_models_refresh": {
				for (const controller of modelRefreshControllers) controller.abort();
				return success(id, "abort_models_refresh");
			}

			case "refresh_models": {
				if (session.isStreaming || session.isCompacting) {
					return error(
						id,
						"refresh_models",
						"Wait for the current turn or compaction before refreshing catalogs.",
						{ errorCode: "busy" },
					);
				}
				if (command.allowNetwork && process.env.ICE_OFFLINE !== undefined) {
					return error(id, "refresh_models", "Network catalog refresh is disabled by ICE_OFFLINE.", {
						errorCode: "denied",
					});
				}
				const unknown = command.providers?.filter((provider) => !session.modelRuntime.getProvider(provider));
				if (unknown && unknown.length > 0) {
					return error(id, "refresh_models", `Providers not found: ${unknown.join(", ")}`, {
						errorCode: "not_found",
					});
				}
				const target = session;
				const controller = new AbortController();
				modelRefreshControllers.add(controller);
				let timedOut = false;
				const timer = setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, command.timeoutMs ?? 10000);
				try {
					const result = await target.modelRuntime.refresh({
						providers: command.providers,
						allowNetwork: command.allowNetwork ?? false,
						force: command.force,
						signal: controller.signal,
					});
					target.refreshModelMetadata();
					const data: RpcModelsRefreshResult = {
						aborted: result.aborted || controller.signal.aborted,
						timedOut,
						errors: [...result.errors].map(([provider, failure]) => ({
							provider,
							errorCode: failure instanceof ModelsError ? failure.code : "failed",
							message: "Catalog refresh failed; inspect local provider diagnostics for details.",
						})),
						hasCatalogError: target.modelRuntime.getError() !== undefined,
					};
					reportModelsRefresh(data, command.providers);
					return success(id, "refresh_models", data);
				} catch (failure: unknown) {
					const data: RpcModelsRefreshResult = {
						aborted: controller.signal.aborted,
						timedOut,
						errors: controller.signal.aborted
							? []
							: [
									{
										provider: "runtime",
										errorCode: failure instanceof ModelsError ? failure.code : "failed",
										message: "Catalog refresh failed; inspect local provider diagnostics for details.",
									},
								],
						hasCatalogError: target.modelRuntime.getError() !== undefined,
					};
					reportModelsRefresh(data, command.providers);
					return success(id, "refresh_models", data);
				} finally {
					clearTimeout(timer);
					modelRefreshControllers.delete(controller);
				}
			}

			case "get_providers": {
				const snapshot = getProviderSnapshot(session);
				return success(id, "get_providers", {
					...snapshot,
					hasCatalogError: snapshot.hasCatalogError || lastCatalogRefreshFailed,
				});
			}

			case "get_models": {
				if (command.provider !== undefined && !session.modelRuntime.getProvider(command.provider)) {
					return error(id, "get_models", `Provider not found: ${command.provider}`, { errorCode: "not_found" });
				}
				const models = command.availableOnly
					? session.modelRuntime.getAvailableSnapshot()
					: session.modelRuntime.getModels(command.provider);
				const selected = (
					command.provider === undefined
						? [...models]
						: models.filter((model) => model.provider === command.provider)
				).sort((a, b) => a.provider.localeCompare(b.provider, "en") || a.id.localeCompare(b.id, "en"));
				const page = pageAfterKey(
					selected,
					(model) => JSON.stringify([model.provider, model.id]),
					command.cursor,
					command.limit,
				);
				return success(id, "get_models", {
					models: page.items.map(toPublicModel),
					hasMore: page.hasMore,
					nextCursor: page.nextCursor,
					hasCatalogError: lastCatalogRefreshFailed || session.modelRuntime.getError() !== undefined,
				});
			}

			case "get_available_models": {
				const models = [...session.modelRuntime.getAvailableSnapshot()].sort(
					(a, b) => a.provider.localeCompare(b.provider, "en") || a.id.localeCompare(b.id, "en"),
				);
				const page = pageAfterKey(
					models,
					(model) => JSON.stringify([model.provider, model.id]),
					command.cursor,
					command.limit,
				);
				return success(id, "get_available_models", {
					models: page.items.map(toPublicModel),
					hasMore: page.hasMore,
					nextCursor: page.nextCursor,
				});
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level", { level: session.thinkingLevel });
			}

			case "set_fast_mode": {
				session.setFastMode(command.enabled);
				return success(id, "set_fast_mode");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				const levels = session.getAvailableThinkingLevels();
				return success(id, "get_available_thinking_levels", { levels });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions, { signal: requestSignal });
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			case "abort_compaction": {
				session.abortCompaction();
				return success(id, "abort_compaction");
			}

			case "abort_branch_summary": {
				session.abortBranchSummary();
				return success(id, "abort_branch_summary");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const eventResult = await session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: command.command,
					excludeFromContext: command.excludeFromContext ?? false,
					cwd: session.sessionManager.getCwd(),
				});

				if (eventResult?.result) {
					session.recordBashResult(command.command, eventResult.result, {
						excludeFromContext: command.excludeFromContext,
					});
					return success(id, "bash", eventResult.result);
				}

				requestSignal?.throwIfAborted();
				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					id,
					operations: eventResult?.operations,
					signal: requestSignal,
				});
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				const cacheWaste = computeCacheWaste(session.sessionManager.getEntries(), session.modelRuntime);
				return success(id, "get_session_stats", { ...stats, cacheWaste });
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", {
					path,
					...(command.includeContent ? { content: await readFile(path, "utf8") } : {}),
				});
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(
					command.sessionPath,
					command.cwd === undefined ? undefined : { cwdOverride: command.cwd },
				);
				return success(id, "switch_session", result);
			}

			case "fork": {
				if (command.position !== undefined && command.position !== "before" && command.position !== "at") {
					return error(id, "fork", "Expected position before or at.");
				}
				const result = await runtimeHost.fork(
					command.entryId,
					command.position ? { position: command.position } : undefined,
				);
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected", { errorCode: "not_found" });
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "list_sessions": {
				if (command.scope !== undefined && command.scope !== "cwd" && command.scope !== "all") {
					return error(id, "list_sessions", "Expected scope cwd or all.");
				}
				const manager = session.sessionManager;
				let sessions =
					command.scope === "all"
						? await (manager.usesDefaultSessionDir()
								? SessionManager.listAll()
								: SessionManager.listAll(manager.getSessionDir()))
						: await SessionManager.list(manager.getCwd(), manager.getSessionDir());
				sessions.sort(
					(a, b) =>
						b.modified.getTime() - a.modified.getTime() || (a.path === b.path ? 0 : a.path < b.path ? -1 : 1),
				);
				const query = command.query?.trim().toLowerCase();
				if (query)
					sessions = sessions.filter((info) =>
						[info.name, info.cwd, info.firstMessage, info.allMessagesText].some((value) =>
							value?.toLowerCase().includes(query),
						),
					);
				if (command.cursor !== undefined) {
					const cursor = sessions.findIndex((info) => info.path === command.cursor);
					if (cursor === -1)
						return error(id, "list_sessions", "Session cursor not found in this listing.", {
							errorCode: "not_found",
						});
					sessions = sessions.slice(cursor + 1);
				}
				const page = command.limit === undefined ? sessions : sessions.slice(0, command.limit);
				const hasMore = page.length < sessions.length;
				return success(id, "list_sessions", {
					sessions: page.map(toSessionInfo),
					hasMore,
					...(hasMore ? { nextCursor: page.at(-1)!.path } : {}),
				});
			}

			case "import_session": {
				if (typeof command.path !== "string" || (command.cwd !== undefined && typeof command.cwd !== "string")) {
					return error(id, "import_session", "Expected path and an optional cwd.");
				}
				const result = await runtimeHost.importFromJsonl(command.path, command.cwd);
				return success(id, "import_session", result);
			}

			case "export_jsonl": {
				const path = session.exportToJsonl(command.outputPath);
				return success(id, "export_jsonl", {
					path,
					...(command.includeContent ? { content: await readFile(path, "utf8") } : {}),
				});
			}

			case "delete_session": {
				const target = resolvePath(session.sessionManager.getCwd(), command.sessionPath);
				if (!isSessionFilePath(target)) {
					return error(id, "delete_session", "Expected a .jsonl file inside a session directory.", {
						errorCode: "invalid_argument",
					});
				}
				if (session.sessionFile && resolvePath(session.sessionFile) === target) {
					return error(id, "delete_session", "Cannot delete the active session; switch sessions first.", {
						errorCode: "busy",
					});
				}
				if (!existsSync(target)) {
					return error(id, "delete_session", `Session not found: ${target}`, { errorCode: "not_found" });
				}
				const result = await deleteSessionFile(target);
				if (!result.ok) return error(id, "delete_session", result.error ?? "Session deletion failed.");
				return success(id, "delete_session", { method: result.method });
			}

			case "rename_session": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "rename_session", "Session name cannot be empty", { errorCode: "invalid_argument" });
				}
				const target = resolvePath(session.sessionManager.getCwd(), command.sessionPath);
				if (session.sessionFile && resolvePath(session.sessionFile) === target) {
					session.setSessionName(name);
					return success(id, "rename_session");
				}
				if (!isSessionFilePath(target) || !existsSync(target)) {
					return error(id, "rename_session", `Session not found: ${target}`, { errorCode: "not_found" });
				}
				SessionManager.open(target).appendSessionInfo(name);
				return success(id, "rename_session");
			}

			case "navigate_tree": {
				if (!session.sessionManager.getEntry(command.targetId))
					return error(id, "navigate_tree", `Entry ${command.targetId} not found`, { errorCode: "not_found" });
				if (session.isStreaming || session.isCompacting)
					return error(id, "navigate_tree", "Wait for the current operation before navigating.", {
						errorCode: "busy",
					});
				const result = await session.navigateTree(command.targetId, {
					signal: requestSignal,
					summarize: command.summarize,
					customInstructions: command.customInstructions,
					replaceInstructions: command.replaceInstructions,
					label: command.label,
				});
				return success(id, "navigate_tree", {
					cancelled: result.cancelled,
					...(result.aborted !== undefined ? { aborted: result.aborted } : {}),
					...(result.editorText !== undefined ? { editorText: result.editorText } : {}),
					...(result.summaryEntry ? { summaryEntryId: result.summaryEntry.id } : {}),
				});
			}

			case "set_entry_label": {
				if (
					typeof command.entryId !== "string" ||
					(command.label !== undefined && typeof command.label !== "string")
				) {
					return error(id, "set_entry_label", "Expected entryId and an optional label (omit to clear).");
				}
				if (session.isStreaming || session.isCompacting) {
					return error(
						id,
						"set_entry_label",
						"Wait for the current turn or compaction to finish before labeling.",
						{ errorCode: "busy" },
					);
				}
				session.sessionManager.appendLabelChange(command.entryId, command.label?.trim() || undefined);
				return success(id, "set_entry_label", { entryId: command.entryId });
			}

			case "get_entries": {
				const sessionManager = session.sessionManager;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return error(id, "get_entries", `Entry not found: ${command.since}`, { errorCode: "not_found" });
					}
					entries = entries.slice(sinceIndex + 1);
				}
				const page = command.limit === undefined ? entries : entries.slice(0, command.limit);
				const hasMore = page.length < entries.length;
				return success(id, "get_entries", {
					entries: page,
					leafId: sessionManager.getLeafId(),
					hasMore,
					...(hasMore ? { nextCursor: page.at(-1)!.id } : {}),
				});
			}

			case "get_tree": {
				const manager = session.sessionManager;
				const tree = manager.getTree();
				if (command.limit === undefined && command.cursor === undefined && command.parentId === undefined) {
					return success(id, "get_tree", { tree, leafId: manager.getLeafId() });
				}
				let children = tree;
				if (command.parentId !== undefined && command.parentId !== null) {
					const pending = [...tree];
					let parent: (typeof tree)[number] | undefined;
					while (pending.length > 0) {
						const node = pending.pop()!;
						if (node.entry.id === command.parentId) {
							parent = node;
							break;
						}
						pending.push(...node.children);
					}
					if (!parent) return error(id, "get_tree", "Tree parent not found.", { errorCode: "not_found" });
					children = parent.children;
				}
				const page = pageAfterKey(children, (node) => node.entry.id, command.cursor, command.limit ?? 100);
				return success(id, "get_tree", {
					tree: page.items.map(({ children, ...node }) => ({
						...node,
						children: [],
						hasChildren: children.length > 0,
					})),
					leafId: manager.getLeafId(),
					parentId: command.parentId ?? null,
					hasMore: page.hasMore,
					nextCursor: page.nextCursor,
				});
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty", { errorCode: "invalid_argument" });
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				const manager = session.sessionManager;
				const page = pageMessages(
					session.messages,
					session.sessionId,
					manager.getLeafId(),
					manager.getEntries().length,
					command.cursor,
					command.limit,
				);
				return success(id, "get_messages", {
					messages: page.items,
					snapshot: page.snapshot,
					hasMore: page.hasMore,
					nextCursor: page.nextCursor,
				});
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				// Hot-reload skills so the command list reflects additions, updates, and deletions.
				session.refreshSkills();
				const commands: RpcSlashCommand[] = [];

				// Built-in /settings command
				commands.push({
					name: "settings",
					description: "Configure Ice runtime settings",
					source: "builtin",
					interaction: { type: "form", schemaId: "ice.settings" },
				});
				// Other built-ins run only in the TUI; list those an RPC command can perform.
				for (const builtin of BUILTIN_SLASH_COMMANDS) {
					const rpcCommand = BUILTIN_RPC_COMMANDS[builtin.name];
					if (!rpcCommand) continue;
					commands.push({
						name: builtin.name,
						description: builtin.description,
						argumentHint: builtin.argumentHint,
						source: "builtin",
						rpcCommand,
					});
				}

				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						argumentHint: template.argumentHint,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", {
					commands: mergeCustomStructuredCommandInventory(commands),
				});
			}

			case "get_command_schema": {
				const { name, schemaId, source } = command;
				if (!source && getCommandIdentitySources(name).size > 1) {
					return error(id, "get_command_schema", `Command '${name}' is ambiguous across multiple sources.`, {
						errorCode: "ambiguous",
					});
				}

				// 1. Collect all matching structured command candidates
				type StructuredCandidate =
					| { kind: "builtin-settings"; schemaId: string; source: "builtin" }
					| { kind: "custom"; command: CustomStructuredCommand };

				const structuredCandidates: StructuredCandidate[] = [];
				if (name === "settings" && (!source || source === "builtin")) {
					structuredCandidates.push({
						kind: "builtin-settings",
						schemaId: ICE_SETTINGS_SCHEMA_ID,
						source: "builtin",
					});
				}

				const customMatches = findCustomStructuredCommands(name, source);
				for (const cmd of customMatches) {
					structuredCandidates.push({ kind: "custom", command: cmd });
				}

				if (structuredCandidates.length > 1) {
					return error(id, "get_command_schema", `Command '${name}' is ambiguous across multiple sources.`, {
						errorCode: "ambiguous",
					});
				}

				if (structuredCandidates.length === 1) {
					const candidate = structuredCandidates[0]!;
					if (candidate.kind === "builtin-settings") {
						const schemaResult = getIceSettingsCommandSchemaResult(getSettingsContext());
						if (schemaId && schemaResult.schema && schemaId !== schemaResult.schema.schemaId) {
							return error(
								id,
								"get_command_schema",
								`Schema ID mismatch for /settings: expected '${schemaResult.schema.schemaId}', received '${schemaId}'.`,
								{
									errorCode: "stale",
									errorDetails: {
										schemaId: schemaResult.schema.schemaId,
										schemaRevision: schemaResult.schema.revision,
									},
								},
							);
						}
						return success(id, "get_command_schema", schemaResult);
					}

					const res = candidate.command.getSchema();
					const schemaResult: RpcCommandSchemaResult =
						"capability" in res
							? res
							: { capability: "available", schema: res, diagnostics: res.diagnostics ?? [] };

					if (schemaId && schemaResult.schema && schemaId !== schemaResult.schema.schemaId) {
						return error(
							id,
							"get_command_schema",
							`Schema ID mismatch: expected '${schemaResult.schema.schemaId}', received '${schemaId}'.`,
							{
								errorCode: "stale",
								errorDetails: {
									schemaId: schemaResult.schema.schemaId,
									schemaRevision: schemaResult.schema.revision,
								},
							},
						);
					}

					return success(id, "get_command_schema", schemaResult);
				}

				// 2. Known raw slash commands without structured schemas -> unsupported
				const rawMatches: RpcSlashCommand[] = [];
				for (const extCmd of session.extensionRunner.getRegisteredCommands()) {
					if (extCmd.invocationName === name && (!source || source === "extension")) {
						rawMatches.push({ name: extCmd.invocationName, source: "extension" });
					}
				}
				for (const prompt of session.promptTemplates) {
					if (prompt.name === name && (!source || source === "prompt")) {
						rawMatches.push({ name: prompt.name, source: "prompt" });
					}
				}
				for (const skill of session.resourceLoader.getSkills().skills) {
					const skillCmdName = `skill:${skill.name}`;
					if (skillCmdName === name && (!source || source === "skill")) {
						rawMatches.push({ name: skillCmdName, source: "skill" });
					}
				}

				if (rawMatches.length > 1) {
					return error(id, "get_command_schema", `Command '${name}' is ambiguous across multiple sources.`, {
						errorCode: "ambiguous",
					});
				}

				if (rawMatches.length === 1) {
					return success(id, "get_command_schema", {
						capability: "unsupported",
						schema: null,
						diagnostics: [`Command '${name}' does not expose a structured schema.`],
					});
				}

				return error(id, "get_command_schema", `Command '${name}' not found.`, {
					errorCode: "not_found",
				});
			}

			case "invoke_command": {
				const { name, schemaId, schemaRevision, source, arguments: args, options } = command;
				if (!source && getCommandIdentitySources(name).size > 1) {
					return error(id, "invoke_command", `Command '${name}' is ambiguous across multiple sources.`, {
						errorCode: "ambiguous",
					});
				}

				// 1. Collect all matching structured command candidates
				type StructuredInvokeCandidate =
					| { kind: "builtin-settings"; source: "builtin" }
					| { kind: "custom"; command: CustomStructuredCommand };

				const invokeCandidates: StructuredInvokeCandidate[] = [];
				if (name === "settings" && (!source || source === "builtin")) {
					invokeCandidates.push({ kind: "builtin-settings", source: "builtin" });
				}

				const customMatches = findCustomStructuredCommands(name, source);
				for (const cmd of customMatches) {
					invokeCandidates.push({ kind: "custom", command: cmd });
				}

				if (invokeCandidates.length > 1) {
					return error(id, "invoke_command", `Command '${name}' is ambiguous across multiple sources.`, {
						errorCode: "ambiguous",
					});
				}

				if (invokeCandidates.length === 1) {
					const candidate = invokeCandidates[0]!;
					if (candidate.kind === "builtin-settings") {
						try {
							const isBusy = session.isStreaming || session.isCompacting;
							const result = await invokeIceSettingsCommand(
								getSettingsContext(),
								{ schemaId, schemaRevision, arguments: args, options },
								isBusy,
							);
							return success(id, "invoke_command", result);
						} catch (err: unknown) {
							if (err instanceof RpcCommandExecutionError) {
								return error(id, "invoke_command", err.message, {
									errorCode: err.errorCode,
									errorDetails: err.errorDetails,
								});
							}
							return error(
								id,
								"invoke_command",
								err instanceof Error ? err.message : "Command invocation failed.",
								{
									errorCode: "failed",
								},
							);
						}
					}

					// Custom structured command
					const cmd = candidate.command;
					try {
						const isBusy = session.isStreaming || session.isCompacting;
						if (isBusy) {
							throw new RpcCommandExecutionError(
								"busy",
								`Cannot invoke /${name} while a session turn is running.`,
							);
						}

						const schemaRes = cmd.getSchema();
						const schema = "capability" in schemaRes ? schemaRes.schema : schemaRes;
						if (!schema) {
							throw new RpcCommandExecutionError("unsupported", `Command '${name}' schema is unavailable.`);
						}

						// Run authoritative generic validation
						validateStructuredInvocation(schema, { schemaId, schemaRevision, arguments: args, options });

						const result = await cmd.invoke({ schemaId, schemaRevision, arguments: args, options });
						return success(id, "invoke_command", result);
					} catch (err: unknown) {
						if (err instanceof RpcCommandExecutionError) {
							return error(id, "invoke_command", err.message, {
								errorCode: err.errorCode,
								errorDetails: err.errorDetails,
							});
						}
						return error(
							id,
							"invoke_command",
							err instanceof Error ? err.message : "Command invocation failed.",
							{
								errorCode: "failed",
							},
						);
					}
				}

				// 2. Not found or unsupported
				return error(id, "invoke_command", `Command '${name}' does not support structured invocation.`, {
					errorCode: "unsupported",
				});
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	function startShutdown(exitCode = 0, signal?: NodeJS.Signals): void {
		if (shuttingDown) return;
		// Close admission synchronously. Already-running effects settle; queued operations
		// fail their dispatch check. No runtime is disposed beneath an admitted handler.
		shuttingDown = true;
		inputAdmission.close();
		detachInput();
		process.stdin.pause();
		requests.abortAll();
		for (const controller of modelRefreshControllers) controller.abort();
		for (const [id, pending] of pendingExtensionRequests) {
			pending.resolve({ type: "extension_ui_response", id, cancelled: true });
		}
		pendingExtensionRequests.clear();
		session.clearQueue();
		session.abortBash();
		session.abortBranchSummary();
		const abort = session.abort();
		void abort.catch(() => {});
		shutdownPromise = (async () => {
			let code = exitCode;
			try {
				await inputAdmission.waitForIdle();
				await abort;
				await runtimeHost.dispose();
			} catch {
				code = 1;
				process.stderr.write("RPC shutdown failed; inspect local session state before recovery.\n");
			} finally {
				for (const cleanup of signalCleanupHandlers) cleanup();
				unsubscribe?.();
				unsubscribeBackpressure?.();
				unsubscribeShells?.();
				unsubscribeCatalog?.();
				unsubscribeSettings?.();
				unsubscribeBridge?.();
				if (shellsUpdateTimer) clearTimeout(shellsUpdateTimer);
			}
			if (signal !== "SIGTERM") await flushRawStdout();
			process.exit(code);
		})();
		void shutdownPromise.catch(() => {});
	}

	function checkShutdownRequested(): void {
		if (shutdownRequested) startShutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			output(error(undefined, "parse", "Failed to parse command: invalid JSON.", { errorCode: "invalid_request" }));
			return;
		}

		const validation = validateRpcInput(parsed);
		if (!validation.valid) {
			output(error(validation.id, validation.command, validation.error, { errorCode: validation.errorCode }));
			return;
		}

		// Dialog replies bypass command handling so approval waits cannot block them.
		if (validation.command.type === "extension_ui_response") {
			const response = validation.command;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const command = validation.command;
		let request: RpcRequestScope | undefined;
		let finishAdmission: (() => void) | undefined;
		try {
			finishAdmission = inputAdmission.begin(Buffer.byteLength(line, "utf8"), LIVE_CONTROLS.has(command.type));
			request = requests.begin(command);
			// Startup dialogs can already receive answers, but the readiness handshake
			// must not claim binding is complete while a startup hook is still waiting.
			if (bootstrapping && command.type === "get_capabilities") await bootstrapReady;
			const execute = () => {
				if (shuttingDown) throw new RpcRequestExecutionError("cancelled", "RPC host is shutting down.");
				if (
					runtimeHost.isAvailable === false &&
					![
						"get_capabilities",
						"cancel_request",
						"abort_models_refresh",
						"new_session",
						"switch_session",
						"import_session",
					].includes(command.type)
				)
					throw new SessionRuntimeUnavailableError();
				request?.signal.throwIfAborted();
				request?.start();
				return handleCommand(command, request?.signal);
			};
			const response = await (LIVE_CONTROLS.has(command.type)
				? execute()
				: coordinator.run(execute, SESSION_TRANSITIONS.has(command.type), MUTATIONS.has(command.type)));
			request.signal?.throwIfAborted();
			request.finish();
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			checkShutdownRequested();
		} catch (caught: unknown) {
			const commandError = request?.signal?.aborted ? request.signal.reason : caught;
			request?.finish();
			const settingsError = commandError instanceof RpcSettingsError ? commandError : undefined;
			const executionError =
				commandError instanceof RpcCommandExecutionError || commandError instanceof RpcRequestExecutionError
					? commandError
					: undefined;
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
					settingsError
						? {
								errorCode: settingsError.code,
								errorDetails: { key: settingsError.key, scope: settingsError.scope },
							}
						: executionError
							? { errorCode: executionError.errorCode, errorDetails: executionError.errorDetails }
							: commandError instanceof SessionRuntimeUnavailableError || runtimeHost.isAvailable === false
								? { errorCode: "runtime_unavailable" }
								: commandError instanceof SessionImportFileNotFoundError
									? { errorCode: "not_found" }
									: commandError instanceof ModelsError
										? { errorCode: commandError.code }
										: commandError instanceof Error && commandError.name === "AbortError"
											? { errorCode: "cancelled" }
											: undefined,
				),
			);
			if (finishAdmission) await waitForRawStdoutBackpressure();
		} finally {
			request?.finish();
			finishAdmission?.();
		}
	};

	const onInputEnd = () => startShutdown();

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(
			process.stdin,
			(line) => {
				if (!shuttingDown) void handleInputLine(line).catch(() => startShutdown(1));
			},
			{
				maxLineBytes: RPC_MAX_INPUT_LINE_BYTES,
				onOverflow: () => {
					output(
						error(undefined, "parse", "RPC input line exceeds the byte limit.", { errorCode: "input_too_large" }),
					);
				},
			},
		);
		// The reader's EOF listener must consume a final unterminated record before
		// shutdown closes admission. Reversing these listeners loses that record.
		process.stdin.on("end", onInputEnd);
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	registerSignalHandlers();
	const finishBootstrap = inputAdmission.begin(0, false);
	try {
		await coordinator.run(() => rebindSession(), true);
	} catch (failure) {
		startShutdown(1);
		throw failure;
	} finally {
		bootstrapping = false;
		settleBootstrap();
		finishBootstrap();
	}

	// Keep process alive forever
	return new Promise(() => {});
}
