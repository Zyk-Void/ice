/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AgentMessage, ThinkingLevel } from "@zykairotis/ice-agent-core";
import type { ImageContent } from "@zykairotis/ice-ai";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CacheWasteTotals } from "../../core/cache-stats.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { SessionTreeNode } from "../../core/session-manager.ts";
import type {
	IceSubagentApprovalAnswer,
	IceSubagentControlAction,
	IceSubagentOverview,
	IceSubagentTranscript,
} from "../../ice-agent-view-bridge.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import {
	RPC_LIVE_CONTROLS,
	RPC_MAX_COLLECTED_EVENT_BYTES,
	RPC_MAX_COLLECTED_EVENTS,
	RPC_MAX_OUTPUT_LINE_BYTES,
} from "./rpc-command-lanes.ts";
import type { RpcCommandInvocationResult, RpcCommandSchemaResult, RpcCommandSource } from "./rpc-command-schema.ts";
import { RpcInputAdmission } from "./rpc-input-admission.ts";
import { RPC_MAX_REQUEST_TIMEOUT_MS } from "./rpc-request-tracker.ts";
import { validateRpcResponse } from "./rpc-response-validation.ts";
import type { RpcSettingsSnapshot, RpcSettingUpdate } from "./rpc-settings.ts";
import type {
	RpcAttachment,
	RpcCapabilities,
	RpcChangelogEntry,
	RpcCommand,
	RpcCompletions,
	RpcDiagnostics,
	RpcEntryPage,
	RpcEvent,
	RpcExportResult,
	RpcExtensionFlag,
	RpcExtensionShortcut,
	RpcExtensionUIResponse,
	RpcMessagePage,
	RpcModelSnapshot,
	RpcModelsRefreshResult,
	RpcProviderSnapshot,
	RpcQueueSnapshot,
	RpcResources,
	RpcResponse,
	RpcScopedModelRef,
	RpcSessionInfo,
	RpcSessionPage,
	RpcSessionState,
	RpcShellDetail,
	RpcShellSummary,
	RpcSlashCommand,
	RpcSubagentPatchAction,
	RpcSubagentPatchResult,
	RpcToolInfo,
	RpcTreePage,
	RpcUIState,
} from "./rpc-types.ts";
import { RPC_MAX_INPUT_LINE_BYTES } from "./rpc-validation.ts";

// ============================================================================
// Types
// ============================================================================

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Path to the ICE CLI entry point (default: searches for dist/ice.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** Deadline for the capability handshake (default: 30 seconds). */
	startupTimeoutMs?: number;
	/** Reports a subscriber failure without interrupting delivery to other subscribers. */
	onListenerError?: (error: Error, event: RpcEvent) => void;
}

/** Server deadline includes queue time; cancellation is cooperative and never rolls back effects. */
export interface RpcOperationOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export type { RpcEvent } from "./rpc-types.ts";
export type RpcEventListener = (event: RpcEvent) => void;

/** Retain only the latest diagnostic text; forwarding to the host stderr is unchanged. */
const MAX_STDERR_CHARS = 64 * 1024;

// ============================================================================
// RPC Client
// ============================================================================

import type { RpcCommandErrorDetails } from "./rpc-command-schema.ts";

export class RpcRequestError extends Error {
	readonly errorCode?: string;
	readonly errorDetails?: RpcCommandErrorDetails;
	readonly command?: string;

	constructor(message: string, errorCode?: string, errorDetails?: RpcCommandErrorDetails, command?: string) {
		super(message);
		this.name = "RpcRequestError";
		this.errorCode = errorCode;
		this.errorDetails = errorDetails;
		this.command = command;
	}
}

export class RpcClient {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private readonly terminationListeners = new Set<(error: Error) => void>();
	private pendingRequests: Map<
		string,
		{ command: RpcCommand["type"]; resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
	> = new Map();
	private readonly requestAdmission = new RpcInputAdmission();
	private activeCollectors = 0;
	private requestId = 0;
	private startupId = 0;
	private stderr = "";
	private exitError: Error | null = null;
	private options: RpcClientOptions;

	constructor(options: RpcClientOptions = {}) {
		this.options = options;
	}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		const startupTimeout = this.options.startupTimeoutMs ?? 30000;
		if (!Number.isSafeInteger(startupTimeout) || startupTimeout <= 0 || startupTimeout > 2_147_483_647) {
			throw new Error("startupTimeoutMs must be a positive timer-safe integer.");
		}
		this.exitError = null;
		this.stderr = "";

		const cliPath = this.options.cliPath ?? "dist/ice.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const childProcess = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = childProcess;

		// Collect stderr for debugging
		childProcess.stderr?.on("data", (data) => {
			if (this.process !== childProcess) return;
			this.stderr = (this.stderr + data.toString()).slice(-MAX_STDERR_CHARS);
			process.stderr.write(data);
		});

		childProcess.once("exit", (code, signal) => {
			if (this.process !== childProcess) return;
			const error = this.exitError ?? this.createProcessExitError(code, signal);
			this.exitError = error;
			this.rejectPendingRequests(error);
		});
		childProcess.once("error", (error) => {
			if (this.process !== childProcess) return;
			const processError =
				this.exitError ?? new Error(`Agent process error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = processError;
			this.rejectPendingRequests(processError);
		});
		childProcess.stdin?.on("error", (error) => {
			if (this.process !== childProcess) return;
			const stdinError =
				this.exitError ?? new Error(`Agent process stdin error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = stdinError;
			this.rejectPendingRequests(stdinError);
		});

		// Set up strict JSONL reader for stdout.
		this.stopReadingStdout = attachJsonlLineReader(
			childProcess.stdout!,
			(line) => {
				this.handleLine(line);
			},
			{
				maxLineBytes: RPC_MAX_OUTPUT_LINE_BYTES,
				onOverflow: () => {
					const error = new RpcRequestError("RPC output record exceeds the client limit.", "output_too_large");
					this.exitError ??= error;
					this.rejectPendingRequests(this.exitError);
					void this.stop().catch(() => {});
				},
			},
		);

		try {
			const capabilities = this.getData<unknown>(
				await this.send(
					{ type: "get_capabilities" },
					{ timeoutMs: startupTimeout, id: `startup_${++this.startupId}` },
				),
			);
			if (
				!capabilities ||
				typeof capabilities !== "object" ||
				!("protocolVersion" in capabilities) ||
				capabilities.protocolVersion !== 1 ||
				!("commands" in capabilities) ||
				!Array.isArray(capabilities.commands) ||
				capabilities.commands.some((command: unknown) => typeof command !== "string") ||
				!capabilities.commands.includes("get_capabilities") ||
				!("features" in capabilities) ||
				!Array.isArray(capabilities.features) ||
				capabilities.features.some((feature: unknown) => typeof feature !== "string") ||
				!("limits" in capabilities) ||
				!capabilities.limits ||
				typeof capabilities.limits !== "object" ||
				!("maxInputLineBytes" in capabilities.limits) ||
				typeof capabilities.limits.maxInputLineBytes !== "number" ||
				!Number.isSafeInteger(capabilities.limits.maxInputLineBytes) ||
				capabilities.limits.maxInputLineBytes <= 0 ||
				!("host" in capabilities) ||
				!capabilities.host ||
				typeof capabilities.host !== "object" ||
				!("subagents" in capabilities.host) ||
				typeof capabilities.host.subagents !== "boolean"
			) {
				throw new Error("Invalid RPC capability handshake response.");
			}
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	async stop(): Promise<void> {
		const childProcess = this.process;
		if (!childProcess) return;
		const stopped = this.exitError ?? new Error("RPC client stopped");
		this.exitError = stopped;
		this.rejectPendingRequests(stopped);
		this.stopReadingStdout?.();
		this.stopReadingStdout = null;

		if (childProcess.exitCode === null && childProcess.signalCode === null) {
			await new Promise<void>((resolve) => {
				const onExit = () => {
					clearTimeout(timeout);
					resolve();
				};
				const timeout = setTimeout(() => {
					childProcess.off("exit", onExit);
					childProcess.kill("SIGKILL");
					resolve();
				}, 1000);
				childProcess.once("exit", onExit);
				childProcess.kill("SIGTERM");
			});
		}
		if (this.process === childProcess) this.process = null;
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(
		message: string,
		images?: ImageContent[],
		options: {
			streamingBehavior?: "steer" | "followUp";
			expandPromptTemplates?: boolean;
			attachments?: RpcAttachment[];
		} = {},
	): Promise<void> {
		await this.send({ type: "prompt", message, images, ...options });
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/** Send a dialog reply without allocating a request ID or awaiting a command response. */
	async respondToExtensionUI(response: RpcExtensionUIResponse): Promise<void> {
		const stdin = this.getWritableStdin();
		const line = serializeJsonLine(response);
		const release = this.requestAdmission.begin(Buffer.byteLength(line, "utf8"), true);
		try {
			await new Promise<void>((resolve, reject) => {
				stdin.write(line, (error) => (error ? reject(error) : resolve()));
			});
		} finally {
			release();
		}
	}

	/** Read pending steering and follow-up text without consuming the queues. */
	async getQueue(): Promise<RpcQueueSnapshot> {
		return this.getData(await this.send({ type: "get_queue" }));
	}

	/** Clear pending messages and return the removed text. */
	async clearQueue(): Promise<RpcQueueSnapshot> {
		return this.getData(await this.send({ type: "clear_queue" }));
	}

	/** Discover the supported command inventory and transport features. */
	async getCapabilities(): Promise<RpcCapabilities> {
		return this.getData(await this.send({ type: "get_capabilities" }));
	}

	/** Remove one pending steering or follow-up message using its queue-update ID. */
	async removeQueuedMessage(messageId: string): Promise<boolean> {
		const response = await this.send({ type: "remove_queued_message", messageId });
		return this.getData<{ removed: boolean }>(response).removed;
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/** Get the versioned settings snapshot exposed by the RPC bridge. */
	async getSettings(): Promise<RpcSettingsSnapshot> {
		const response = await this.send({ type: "get_settings" });
		return this.getData(response);
	}

	async setSetting(update: RpcSettingUpdate): Promise<RpcSettingsSnapshot>;
	async setSetting(key: string, scope: RpcSettingUpdate["scope"], value: unknown): Promise<RpcSettingsSnapshot>;
	async setSetting(
		updateOrKey: RpcSettingUpdate | string,
		scope?: RpcSettingUpdate["scope"],
		value?: unknown,
	): Promise<RpcSettingsSnapshot> {
		let update: RpcSettingUpdate;
		if (typeof updateOrKey === "string") {
			if (scope === undefined) throw new Error("Setting scope is required");
			update = { key: updateOrKey, scope, value };
		} else {
			update = updateOrKey;
		}
		const response = await this.send({ type: "set_setting", ...update });
		return this.getData(response);
	}

	/** Subagent overview; null when the host has no subagent runtime or no parent session yet. */
	async getSubagents(): Promise<IceSubagentOverview | null> {
		const response = await this.send({ type: "get_subagents" });
		return this.getData(response);
	}

	/** Answer a pending subagent approval; false when it is no longer pending. */
	async respondToSubagentApproval(approvalId: string, answer: IceSubagentApprovalAnswer): Promise<boolean> {
		const response = await this.send({ type: "respond_subagent_approval", approvalId, answer });
		return this.getData<{ accepted: boolean }>(response).accepted;
	}

	/** Stop, resume, delete, or send a follow-up to one child; resolves to the runtime's summary. */
	async controlSubagent(subagentId: string, action: IceSubagentControlAction, message?: string): Promise<string> {
		const response = await this.send({
			type: "subagent_control",
			subagentId,
			action,
			...(message !== undefined ? { message } : {}),
		});
		return this.getData<{ message: string }>(response).message;
	}

	/** Inspect, apply, or reject a worktree child's patch through the parent's `agent_patch` tool and its hooks. */
	async subagentPatch(subagentId: string, action: RpcSubagentPatchAction): Promise<RpcSubagentPatchResult> {
		const response = await this.send({ type: "subagent_patch", subagentId, action });
		return this.getData(response);
	}

	/** Bounded, redacted transcript of one child; null when it is unknown or owned by another parent. */
	async getSubagentMessages(subagentId: string): Promise<IceSubagentTranscript | null> {
		const response = await this.send({ type: "get_subagent_messages", subagentId });
		return this.getData(response);
	}

	/** Every registered tool with its schema and whether it is active. */
	async getTools(): Promise<RpcToolInfo[]> {
		const response = await this.send({ type: "get_tools" });
		return this.getData<{ tools: RpcToolInfo[] }>(response).tools;
	}

	/** Replace the active tool set; resolves to the names that are active afterwards. */
	async setActiveTools(toolNames: string[]): Promise<string[]> {
		const response = await this.send({ type: "set_active_tools", toolNames });
		return this.getData<{ active: string[] }>(response).active;
	}

	async getSystemPrompt(): Promise<string> {
		const response = await this.send({ type: "get_system_prompt" });
		return this.getData<{ text: string }>(response).text;
	}

	async getDiagnostics(): Promise<RpcDiagnostics> {
		return this.getData(await this.send({ type: "get_diagnostics" }));
	}

	async getUIState(): Promise<RpcUIState> {
		return this.getData(await this.send({ type: "get_ui_state" }));
	}

	async getCompletions(prefix: string, limit?: number): Promise<RpcCompletions> {
		return this.getData(await this.send({ type: "get_completions", prefix, limit }));
	}

	/** Loaded context files, skills, prompts, themes, and extensions, by path and metadata. */
	async getResources(): Promise<RpcResources> {
		const response = await this.send({ type: "get_resources" });
		return this.getData(response);
	}

	/** Changelog entries, newest first. */
	async getChangelog(): Promise<RpcChangelogEntry[]> {
		const response = await this.send({ type: "get_changelog" });
		return this.getData<{ entries: RpcChangelogEntry[] }>(response).entries;
	}

	/** Models the model-cycling commands rotate through; empty means every available model. */
	async getScopedModels(): Promise<RpcScopedModelRef[]> {
		const response = await this.send({ type: "get_scoped_models" });
		return this.getData<{ models: RpcScopedModelRef[] }>(response).models;
	}

	async setScopedModels(models: RpcScopedModelRef[]): Promise<RpcScopedModelRef[]> {
		const response = await this.send({ type: "set_scoped_models", models });
		return this.getData<{ models: RpcScopedModelRef[] }>(response).models;
	}

	/** Reload settings, extensions, skills, prompts, themes, and context files. */
	async reload(): Promise<void> {
		await this.send({ type: "reload" });
	}

	/** End the run after the current tool turn completes. */
	async stopAfterTurn(): Promise<void> {
		await this.send({ type: "stop_after_turn" });
	}

	/** Flags registered by extensions, with their current values. */
	async getFlags(): Promise<RpcExtensionFlag[]> {
		return this.getData<{ flags: RpcExtensionFlag[] }>(await this.send({ type: "get_flags" })).flags;
	}

	/** Keyboard shortcuts registered by extensions, after built-in conflict resolution. */
	async getShortcuts(): Promise<RpcExtensionShortcut[]> {
		return this.getData<{ shortcuts: RpcExtensionShortcut[] }>(await this.send({ type: "get_shortcuts" })).shortcuts;
	}

	/** Run an extension shortcut's handler as if its key were pressed. */
	async invokeShortcut(shortcut: string): Promise<void> {
		await this.send({ type: "invoke_shortcut", shortcut });
	}

	/** Every tracked background shell without its output. */
	async getShells(): Promise<RpcShellSummary[]> {
		const response = await this.send({ type: "get_shells" });
		return this.getData<{ shells: RpcShellSummary[] }>(response).shells;
	}

	/** One shell with its output from `sinceChars`; null when unknown. Does not consume the model's `bash_output` cursor. */
	async getShell(shellId: string, sinceChars?: number): Promise<RpcShellDetail | null> {
		const response = await this.send({
			type: "get_shell",
			shellId,
			...(sinceChars !== undefined ? { sinceChars } : {}),
		});
		return this.getData(response);
	}

	/** Stop a running background shell; false when it is unknown or already finished. */
	async killShell(shellId: string): Promise<boolean> {
		const response = await this.send({ type: "kill_shell", shellId });
		return this.getData<{ stopped: boolean }>(response).stopped;
	}

	/** Move running foreground bash calls to the background; resolves to how many moved. */
	async backgroundBash(): Promise<number> {
		const response = await this.send({ type: "background_bash" });
		return this.getData<{ released: number }>(response).released;
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(direction?: "forward" | "backward"): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model", direction });
		return this.getData(response);
	}

	/** Explicit catalog refresh; cache-only by default, with a server cancellation deadline. */
	async refreshModels(
		options: { providers?: string[]; allowNetwork?: boolean; force?: boolean; timeoutMs?: number } = {},
	): Promise<RpcModelsRefreshResult> {
		const timeoutMs = options.timeoutMs ?? 10000;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
			throw new RpcRequestError(
				"timeoutMs must be an integer from 1 to 30000.",
				"invalid_argument",
				undefined,
				"refresh_models",
			);
		}
		return this.getData(await this.send({ type: "refresh_models", ...options }, { timeoutMs: timeoutMs + 5000 }));
	}

	/** Cancel the in-flight catalog refresh; does not cancel a queued refresh command. */
	async abortModelsRefresh(): Promise<void> {
		await this.send({ type: "abort_models_refresh" });
	}

	/** Read cached provider/auth metadata without resolving credentials or making requests. */
	async getProviders(): Promise<RpcProviderSnapshot> {
		return this.getData(await this.send({ type: "get_providers" }));
	}

	/** Read all cached models, including unconfigured providers, or filter to available models. */
	async getModels(
		options: { provider?: string; availableOnly?: boolean; cursor?: string; limit?: number } = {},
	): Promise<RpcModelSnapshot> {
		return this.getData(await this.send({ type: "get_models", ...options }));
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	async getAvailableModelsPage(
		options: { cursor?: string; limit?: number } = {},
	): Promise<{ models: ModelInfo[]; hasMore?: boolean; nextCursor?: string }> {
		return this.getData(await this.send({ type: "get_available_models", ...options }));
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<{ level: ThinkingLevel }> {
		return this.getData(await this.send({ type: "set_thinking_level", level }));
	}

	async setFastMode(enabled: boolean): Promise<void> {
		await this.send({ type: "set_fast_mode", enabled });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * Get list of available thinking levels for the current model.
	 */
	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		const response = await this.send({ type: "get_available_thinking_levels" });
		return this.getData<{ levels: ThinkingLevel[] }>(response).levels;
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string, options: RpcOperationOptions = {}): Promise<CompactionResult> {
		const response = await this.sendOperation({ type: "compact", customInstructions }, options);
		return this.getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(
		command: string,
		options: RpcOperationOptions & { excludeFromContext?: boolean } = {},
	): Promise<BashResult> {
		const response = await this.sendOperation(
			{ type: "bash", command, excludeFromContext: options.excludeFromContext },
			options,
		);
		return this.getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats & { cacheWaste: CacheWasteTotals }> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string, options: { includeContent?: boolean } = {}): Promise<RpcExportResult> {
		const response = await this.send({ type: "export_html", outputPath, ...options });
		return this.getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string, cwd?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath, cwd });
		return this.getData(response);
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async fork(entryId: string, position?: "before" | "at"): Promise<{ text?: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId, ...(position ? { position } : {}) });
		return this.getData(response);
	}

	/**
	 * Clone the current active branch into a new session.
	 * @returns Object with `cancelled: true` if an extension cancelled the clone
	 */
	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}

	/** Sessions for the current working directory, or every project with `scope: "all"`. */
	async listSessions(scope?: "cwd" | "all"): Promise<RpcSessionInfo[]> {
		const response = await this.send({ type: "list_sessions", ...(scope ? { scope } : {}) });
		return this.getData<{ sessions: RpcSessionInfo[] }>(response).sessions;
	}

	/** Bounded listing/search with a path cursor; pages are live snapshots, not a frozen result set. */
	async listSessionsPage(
		options: { scope?: "cwd" | "all"; cursor?: string; limit?: number; query?: string } = {},
	): Promise<RpcSessionPage> {
		return this.getData(await this.send({ type: "list_sessions", ...options }));
	}

	/** Replace the current session with a JSONL export; `cwd` supplies a working directory the file no longer has. */
	async importSession(path: string, cwd?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "import_session", path, ...(cwd ? { cwd } : {}) });
		return this.getData(response);
	}

	async exportJsonl(outputPath?: string, options: { includeContent?: boolean } = {}): Promise<RpcExportResult> {
		const response = await this.send({ type: "export_jsonl", ...(outputPath ? { outputPath } : {}), ...options });
		return this.getData(response);
	}

	/** Move a non-active session file to the trash, or unlink it when no `trash` CLI is available. */
	async deleteSession(sessionPath: string): Promise<{ method: "trash" | "unlink" }> {
		return this.getData(await this.send({ type: "delete_session", sessionPath }));
	}

	/** Set the display name of any session file, including the active one. */
	async renameSession(sessionPath: string, name: string): Promise<void> {
		await this.send({ type: "rename_session", sessionPath, name });
	}

	/** Move the session leaf to another entry, optionally summarizing the branch being left. */
	async navigateTree(
		targetId: string,
		options: RpcOperationOptions & {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		} = {},
	): Promise<{ cancelled: boolean; aborted?: boolean; editorText?: string; summaryEntryId?: string }> {
		const { signal, timeoutMs, ...navigation } = options;
		const response = await this.sendOperation(
			{ type: "navigate_tree", targetId, ...navigation },
			{ signal, timeoutMs },
		);
		return this.getData(response);
	}

	/** Set or, with no label, clear an entry's label. */
	async setEntryLabel(entryId: string, label?: string): Promise<void> {
		await this.send({ type: "set_entry_label", entryId, ...(label !== undefined ? { label } : {}) });
	}

	/** Request cancellation by wire ID; acceptance is not an operation-settlement acknowledgement. */
	async cancelRequest(requestId: string): Promise<boolean> {
		return this.getData<{ accepted: boolean }>(await this.send({ type: "cancel_request", requestId })).accepted;
	}

	async abortCompaction(): Promise<void> {
		await this.send({ type: "abort_compaction" });
	}

	async abortBranchSummary(): Promise<void> {
		await this.send({ type: "abort_branch_summary" });
	}

	/**
	 * Get messages available for forking.
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get session entries in append order, optionally only those after the `since` entry id.
	 */
	async getEntries(since?: string, limit?: number): Promise<RpcEntryPage> {
		const response = await this.send({ type: "get_entries", since, limit });
		return this.getData(response);
	}

	/**
	 * Get the session entry tree.
	 */
	async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
		const response = await this.send({ type: "get_tree" });
		return this.getData<{ tree: SessionTreeNode[]; leafId: string | null }>(response);
	}

	async getTreePage(
		options: { parentId?: string | null; cursor?: string; limit?: number } = {},
	): Promise<RpcTreePage> {
		return this.getData(await this.send({ type: "get_tree", limit: 100, ...options }));
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * Set the session display name.
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	async getMessagesPage(options: { cursor?: string; limit?: number } = {}): Promise<RpcMessagePage> {
		return this.getData(await this.send({ type: "get_messages", limit: 100, ...options }));
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	/**
	 * Get command schema for a structured slash command.
	 */
	async getCommandSchema(options: {
		name: string;
		schemaId?: string;
		source?: RpcCommandSource;
	}): Promise<RpcCommandSchemaResult> {
		const response = await this.send({
			type: "get_command_schema",
			name: options.name,
			schemaId: options.schemaId,
			source: options.source,
		});
		return this.getData<RpcCommandSchemaResult>(response);
	}

	/**
	 * Invoke a structured slash command with arguments.
	 */
	async invokeCommand(options: {
		name: string;
		schemaId?: string;
		schemaRevision?: string;
		source?: RpcCommandSource;
		arguments: Record<string, unknown>;
		options?: { scope?: "global" | "project" };
	}): Promise<RpcCommandInvocationResult> {
		const response = await this.send({
			type: "invoke_command",
			name: options.name,
			schemaId: options.schemaId,
			schemaRevision: options.schemaRevision,
			source: options.source,
			arguments: options.arguments,
			options: options.options,
		});
		return this.getData<RpcCommandInvocationResult>(response);
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_settled event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.terminationListeners.size >= 64) {
				reject(new RpcRequestError("RPC idle waiter limit reached.", "busy"));
				return;
			}
			if (this.exitError) {
				reject(this.exitError);
				return;
			}
			const cleanup = () => {
				clearTimeout(timer);
				unsubscribe();
				this.terminationListeners.delete(onTermination);
			};
			const onTermination = (error: Error) => {
				cleanup();
				reject(error);
			};
			const timer = setTimeout(() => {
				onTermination(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);
			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_settled") {
					cleanup();
					resolve();
				}
			});
			this.terminationListeners.add(onTermination);
		});
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000, signal?: AbortSignal): Promise<RpcEvent[]> {
		return new Promise((resolve, reject) => {
			if (this.exitError) {
				reject(this.exitError);
				return;
			}
			if (signal?.aborted) {
				reject(new Error("Event collection cancelled"));
				return;
			}
			if (this.activeCollectors >= 4) {
				reject(new RpcRequestError("RPC event collector limit reached.", "busy"));
				return;
			}
			this.activeCollectors++;
			let cleaned = false;
			let eventBytes = 0;
			const events: RpcEvent[] = [];
			const cleanup = () => {
				if (cleaned) return;
				cleaned = true;
				this.activeCollectors--;
				clearTimeout(timer);
				unsubscribe();
				signal?.removeEventListener("abort", onAbort);
				this.terminationListeners.delete(onTermination);
			};
			const onTermination = (error: Error) => {
				cleanup();
				reject(error);
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("Event collection cancelled"));
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);
			const unsubscribe = this.onEvent((event) => {
				eventBytes += Buffer.byteLength(serializeJsonLine(event), "utf8");
				if (events.length >= RPC_MAX_COLLECTED_EVENTS || eventBytes > RPC_MAX_COLLECTED_EVENT_BYTES) {
					cleanup();
					events.length = 0;
					reject(new RpcRequestError("RPC collected event limit reached.", "output_overflow"));
					return;
				}
				events.push(event);
				if (event.type === "agent_settled") {
					cleanup();
					resolve(events);
				}
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			this.terminationListeners.add(onTermination);
		});
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<RpcEvent[]> {
		const controller = new AbortController();
		const eventsPromise = this.collectEvents(timeout, controller.signal);
		// Collection can time out while prompt preflight is still pending. Observe its
		// rejection immediately, then preserve the original submission error if any.
		void eventsPromise.catch(() => {});
		try {
			await this.prompt(message, images);
			return await eventsPromise;
		} finally {
			controller.abort();
		}
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private handleLine(line: string): void {
		if (this.exitError) return;
		let data: unknown;
		try {
			data = JSON.parse(line);
		} catch {
			return; // Ignore non-JSON diagnostics, not subscriber exceptions.
		}
		if (!data || typeof data !== "object" || !("type" in data) || typeof data.type !== "string") return;
		if (data.type === "response") {
			if ("id" in data && typeof data.id === "string") {
				const pending = this.pendingRequests.get(data.id);
				if (pending) {
					this.pendingRequests.delete(data.id);
					if (!validateRpcResponse(pending.command, data)) {
						pending.reject(
							new RpcRequestError(
								"Invalid RPC response envelope or payload.",
								"invalid_response",
								undefined,
								pending.command,
							),
						);
					} else pending.resolve(data as RpcResponse);
				}
			}
			return; // Late/unmatched responses are not events.
		}
		const event = data as RpcEvent;
		for (const listener of [...this.eventListeners]) {
			try {
				listener(event);
			} catch (error: unknown) {
				try {
					if (this.options.onListenerError) {
						this.options.onListenerError(error instanceof Error ? error : new Error(String(error)), event);
					} else process.stderr.write("RPC event listener failed.\n");
				} catch {
					process.stderr.write("RPC listener error reporter failed.\n");
				}
			}
		}
	}

	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
	}

	private rejectPendingRequests(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
		const listeners = [...this.terminationListeners];
		this.terminationListeners.clear();
		for (const listener of listeners) listener(error);
	}

	private getWritableStdin(): NonNullable<ChildProcess["stdin"]> {
		const childProcess = this.process;
		const stdin = childProcess?.stdin;
		if (!childProcess || !stdin) {
			throw new Error("Client not started");
		}
		if (this.exitError) {
			throw this.exitError;
		}
		if (childProcess.exitCode !== null) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		if (stdin.destroyed || !stdin.writable) {
			const error = new Error(`Agent process stdin is not writable. Stderr: ${this.stderr}`);
			this.exitError = error;
			throw error;
		}

		return stdin;
	}

	private sendOperation(
		command: Extract<RpcCommandBody, { type: "compact" | "navigate_tree" | "bash" }>,
		options: RpcOperationOptions,
	): Promise<RpcResponse> {
		if (
			options.timeoutMs !== undefined &&
			(!Number.isSafeInteger(options.timeoutMs) ||
				options.timeoutMs < 1 ||
				options.timeoutMs > RPC_MAX_REQUEST_TIMEOUT_MS)
		) {
			return Promise.reject(
				new RpcRequestError(
					`timeoutMs must be an integer from 1 to ${RPC_MAX_REQUEST_TIMEOUT_MS}.`,
					"invalid_argument",
					undefined,
					command.type,
				),
			);
		}
		return this.send(
			{ ...command, timeoutMs: options.timeoutMs },
			{
				signal: options.signal,
				// Preserve the existing response bound by default. An explicit server
				// deadline gets five seconds to settle/respond before local failure.
				timeoutMs: options.timeoutMs === undefined ? 30000 : options.timeoutMs + 5000,
				cancelOnTimeout: true,
			},
		);
	}

	private async send(
		command: RpcCommandBody,
		options: { timeoutMs?: number; id?: string; signal?: AbortSignal; cancelOnTimeout?: boolean } = {},
	): Promise<RpcResponse> {
		if (options.signal?.aborted)
			throw new RpcRequestError("Request cancelled before submission.", "cancelled", undefined, command.type);
		const stdin = this.getWritableStdin();
		const id = options.id ?? `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;
		const line = serializeJsonLine(fullCommand);
		const bytes = Buffer.byteLength(line, "utf8");
		if (bytes - 1 > RPC_MAX_INPUT_LINE_BYTES)
			throw new RpcRequestError("RPC input record exceeds the limit.", "input_too_large", undefined, command.type);
		let releaseAdmission: () => void;
		try {
			releaseAdmission = this.requestAdmission.begin(bytes, RPC_LIVE_CONTROLS.has(command.type));
		} catch {
			throw new RpcRequestError("RPC pending input/request limit reached.", "busy", undefined, command.type);
		}

		return new Promise((resolve, reject) => {
			let written = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				releaseAdmission();
				clearTimeout(timeout);
				options.signal?.removeEventListener("abort", onAbort);
			};
			const fail = (error: Error, cancel = false) => {
				const pending = this.pendingRequests.get(id);
				if (!pending) return;
				this.pendingRequests.delete(id);
				pending.reject(error);
				if (cancel && written) void this.cancelRequest(id).catch(() => {});
			};
			const onAbort = () =>
				fail(
					new RpcRequestError(
						"Cancellation requested; remote settlement is not confirmed.",
						"cancelled",
						undefined,
						command.type,
					),
					true,
				);
			timeout = setTimeout(() => {
				fail(
					new RpcRequestError(
						`Timeout waiting for response to ${command.type}; remote settlement is not confirmed.`,
						"timeout",
						undefined,
						command.type,
					),
					options.cancelOnTimeout,
				);
			}, options.timeoutMs ?? 30000);

			this.pendingRequests.set(id, {
				command: command.type,
				resolve: (response) => {
					cleanup();
					if (!response.success) {
						reject(
							new RpcRequestError(response.error, response.errorCode, response.errorDetails, response.command),
						);
					} else {
						resolve(response);
					}
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});

			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.signal?.aborted) {
				onAbort();
				return;
			}
			try {
				written = true;
				stdin.write(line, (error) => {
					if (error) fail(error);
				});
			} catch (error: unknown) {
				const writeError = error instanceof Error ? error : new Error(String(error));
				fail(writeError);
			}
		});
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new RpcRequestError(
				errorResponse.error,
				errorResponse.errorCode,
				errorResponse.errorDetails as RpcCommandErrorDetails | undefined,
				errorResponse.command,
			);
		}
		// Wire structure was validated against the matching command before settlement.
		// Opaque extension metadata remains bounded data, not semantically verified content.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
