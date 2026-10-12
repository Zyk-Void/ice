/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@zykairotis/ice-agent-core";
import type { ImageContent, Model } from "@zykairotis/ice-ai";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CacheWasteTotals } from "../../core/cache-stats.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { ResourceDiagnostic } from "../../core/diagnostics.ts";
import type { ContextUsage, ToolInfo } from "../../core/extensions/types.ts";
import type { AuthStatus } from "../../core/provider-composer.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import type { BackgroundShellSnapshot } from "../../core/tools/bash-background.ts";
import type {
	IceSubagentApprovalAnswer,
	IceSubagentControlAction,
	IceSubagentOverview,
	IceSubagentTranscript,
} from "../../ice-agent-view-bridge.ts";
import type { JsonAgentSessionEvent } from "../json-event.ts";
import type {
	RpcCommandErrorDetails,
	RpcCommandInvocationResult,
	RpcCommandSchemaResult,
	RpcCommandSource,
} from "./rpc-command-schema.ts";
import type { RpcSettingsSnapshot, RpcSettingUpdate } from "./rpc-settings.ts";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| {
			id?: string;
			type: "prompt";
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
			expandPromptTemplates?: boolean;
			attachments?: RpcAttachment[];
	  }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "remove_queued_message"; messageId: string }
	| { id?: string; type: "get_queue" }
	| { id?: string; type: "clear_queue" }
	| { id?: string; type: "abort" }
	| { id?: string; type: "cancel_request"; requestId: string }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_capabilities" }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_fast_mode"; enabled: boolean }
	| { id?: string; type: "get_tools" }
	| { id?: string; type: "set_active_tools"; toolNames: string[] }
	| { id?: string; type: "get_system_prompt" }
	| { id?: string; type: "get_diagnostics" }
	| { id?: string; type: "get_ui_state" }
	| { id?: string; type: "get_completions"; prefix: string; limit?: number }
	| { id?: string; type: "get_resources" }
	| { id?: string; type: "get_changelog" }
	| { id?: string; type: "get_scoped_models" }
	| { id?: string; type: "set_scoped_models"; models: RpcScopedModelRef[] }
	| { id?: string; type: "reload" }
	| { id?: string; type: "stop_after_turn" }
	| { id?: string; type: "get_flags" }
	| { id?: string; type: "get_shortcuts" }
	| { id?: string; type: "invoke_shortcut"; shortcut: string }

	// Background shells
	| { id?: string; type: "get_shells" }
	| { id?: string; type: "get_shell"; shellId: string; sinceChars?: number }
	| { id?: string; type: "kill_shell"; shellId: string }
	| { id?: string; type: "background_bash" }

	// Settings
	| { id?: string; type: "get_settings" }
	| ({ id?: string; type: "set_setting" } & RpcSettingUpdate)
	| { id?: string; type: "set_setting"; data: RpcSettingUpdate }

	// Subagents (ICE launcher only)
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "respond_subagent_approval"; approvalId: string; answer: IceSubagentApprovalAnswer }
	| { id?: string; type: "get_subagent_messages"; subagentId: string }
	| { id?: string; type: "subagent_control"; subagentId: string; action: IceSubagentControlAction; message?: string }
	| { id?: string; type: "subagent_patch"; subagentId: string; action: RpcSubagentPatchAction }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model"; direction?: "forward" | "backward" }
	| { id?: string; type: "get_available_models"; cursor?: string; limit?: number }
	| { id?: string; type: "get_providers" }
	| { id?: string; type: "get_models"; provider?: string; availableOnly?: boolean; cursor?: string; limit?: number }
	| {
			id?: string;
			type: "refresh_models";
			providers?: string[];
			allowNetwork?: boolean;
			force?: boolean;
			timeoutMs?: number;
	  }
	| { id?: string; type: "abort_models_refresh" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string; timeoutMs?: number }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	| { id?: string; type: "abort_compaction" }
	| { id?: string; type: "abort_branch_summary" }

	// Bash
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean; timeoutMs?: number }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string; includeContent?: boolean }
	| { id?: string; type: "switch_session"; sessionPath: string; cwd?: string }
	| { id?: string; type: "fork"; entryId: string; position?: "before" | "at" }
	| { id?: string; type: "list_sessions"; scope?: "cwd" | "all"; cursor?: string; limit?: number; query?: string }
	| { id?: string; type: "import_session"; path: string; cwd?: string }
	| { id?: string; type: "export_jsonl"; outputPath?: string; includeContent?: boolean }
	| { id?: string; type: "delete_session"; sessionPath: string }
	| { id?: string; type: "rename_session"; sessionPath: string; name: string }
	| {
			id?: string;
			type: "navigate_tree";
			timeoutMs?: number;
			targetId: string;
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
	  }
	| { id?: string; type: "set_entry_label"; entryId: string; label?: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_entries"; since?: string; limit?: number }
	| { id?: string; type: "get_tree"; parentId?: string | null; cursor?: string; limit?: number }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages"; cursor?: string; limit?: number }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" }
	| {
			id?: string;
			type: "get_command_schema";
			name: string;
			schemaId?: string;
			source?: RpcCommandSource;
	  }
	| {
			id?: string;
			type: "invoke_command";
			name: string;
			schemaId?: string;
			schemaRevision?: string;
			source?: RpcCommandSource;
			arguments: Record<string, unknown>;
			options?: { scope?: "global" | "project" };
	  };

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** Argument syntax hint, when provided by the source. */
	argumentHint?: string;
	/** What kind of command this is */
	source: RpcCommandSource;
	/** Source metadata for the owning resource */
	sourceInfo?: SourceInfo;
	/** Declarative structured interaction metadata */
	interaction?: { type: "form"; schemaId: string } | { type: "text" };
	/** Built-in interactive command: the RPC command that performs it. Sending it as a prompt does not run it. */
	rpcCommand?: RpcCommandType;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcCapabilities {
	protocolVersion: 1;
	commands: RpcCommandType[];
	features: string[];
	limits: {
		maxInputLineBytes: number;
		maxPendingCommands?: number;
		maxRequestTimeoutMs?: number;
		maxRetainedInputBytes?: number;
		maxControlInputBytes?: number;
		maxLiveControls?: number;
		maxQueuedOutputBytes?: number;
	};
	cancellation?: {
		commands: RpcCommandType[];
		queuedCommands?: RpcCommandType[];
		cooperative: true;
		includesQueueTime: true;
	};
	host: { subagents: boolean };
}

/** Cached, non-secret provider/catalog information; no auth resolution or refresh. */
export interface RpcProviderInfo {
	id: string;
	name: string;
	authTypes: Array<"api_key" | "oauth">;
	auth: Pick<AuthStatus, "configured" | "source"> & { type?: "api_key" | "oauth" };
	modelCount: number;
	availableModelCount: number;
	dynamicCatalog: boolean;
}

export interface RpcProviderSnapshot {
	providers: RpcProviderInfo[];
	/** A local configuration/composition/availability error exists; raw error text is omitted. */
	hasCatalogError: boolean;
}

export interface RpcModelSnapshot {
	models: readonly Model<string>[];
	hasCatalogError: boolean;
	hasMore?: boolean;
	nextCursor?: string;
}

export interface RpcMessagePage {
	messages: AgentMessage[];
	snapshot: string;
	hasMore: boolean;
	nextCursor?: string;
}

export interface RpcTreePage {
	tree: Array<SessionTreeNode & { hasChildren?: boolean }>;
	leafId: string | null;
	hasMore?: boolean;
	nextCursor?: string;
	parentId?: string | null;
}

export interface RpcModelsRefreshResult {
	aborted: boolean;
	timedOut: boolean;
	errors: Array<{ provider: string; errorCode: string; message: string }>;
	hasCatalogError: boolean;
}

export interface RpcModelsChangedEvent {
	type: "models_changed";
	providers?: string[];
	result: RpcModelsRefreshResult;
}

export interface RpcEntryPage {
	entries: SessionEntry[];
	leafId: string | null;
	hasMore: boolean;
	nextCursor?: string;
}

export interface RpcSessionPage {
	sessions: RpcSessionInfo[];
	hasMore: boolean;
	nextCursor?: string;
}

export interface RpcQueueSnapshot {
	steering: readonly string[];
	followUp: readonly string[];
}

export interface RpcSessionState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	fastMode: boolean;
	fastModeAvailable: boolean;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	leafId: string | null;
	sessionDir: string;
	persisted: boolean;
	parentSessionPath?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	cwd: string;
	/** Estimated context usage; undefined when no model is selected. */
	contextUsage?: ContextUsage;
	autoRetryEnabled: boolean;
	isRetrying: boolean;
	retryAttempt: number;
	/** True while a foreground `bash` command (user or RPC) is running. */
	isBashRunning: boolean;
	/** Background shells still running. */
	backgroundShellCount: number;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "remove_queued_message"; success: true; data: { removed: boolean } }
	| { id?: string; type: "response"; command: "get_queue" | "clear_queue"; success: true; data: RpcQueueSnapshot }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "cancel_request"; success: true; data: { accepted: boolean } }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_capabilities"; success: true; data: RpcCapabilities }
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| { id?: string; type: "response"; command: "get_tools"; success: true; data: { tools: RpcToolInfo[] } }
	| { id?: string; type: "response"; command: "set_active_tools"; success: true; data: { active: string[] } }
	| { id?: string; type: "response"; command: "get_system_prompt"; success: true; data: { text: string } }
	| { id?: string; type: "response"; command: "get_diagnostics"; success: true; data: RpcDiagnostics }
	| { id?: string; type: "response"; command: "get_ui_state"; success: true; data: RpcUIState }
	| { id?: string; type: "response"; command: "get_completions"; success: true; data: RpcCompletions }
	| { id?: string; type: "response"; command: "get_resources"; success: true; data: RpcResources }
	| { id?: string; type: "response"; command: "get_changelog"; success: true; data: { entries: RpcChangelogEntry[] } }
	| {
			id?: string;
			type: "response";
			command: "get_scoped_models";
			success: true;
			data: { models: RpcScopedModelRef[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_scoped_models";
			success: true;
			data: { models: RpcScopedModelRef[] };
	  }
	| { id?: string; type: "response"; command: "reload"; success: true }
	| { id?: string; type: "response"; command: "stop_after_turn"; success: true }
	| { id?: string; type: "response"; command: "get_flags"; success: true; data: { flags: RpcExtensionFlag[] } }
	| {
			id?: string;
			type: "response";
			command: "get_shortcuts";
			success: true;
			data: { shortcuts: RpcExtensionShortcut[] };
	  }
	| { id?: string; type: "response"; command: "invoke_shortcut"; success: true }

	// Background shells
	| { id?: string; type: "response"; command: "get_shells"; success: true; data: { shells: RpcShellSummary[] } }
	| { id?: string; type: "response"; command: "get_shell"; success: true; data: RpcShellDetail | null }
	| { id?: string; type: "response"; command: "kill_shell"; success: true; data: { stopped: boolean } }
	| { id?: string; type: "response"; command: "background_bash"; success: true; data: { released: number } }

	// Settings
	| { id?: string; type: "response"; command: "get_settings"; success: true; data: RpcSettingsSnapshot }
	| { id?: string; type: "response"; command: "set_setting"; success: true; data: RpcSettingsSnapshot }

	// Subagents: null when this host has no subagent runtime or no parent session yet
	| { id?: string; type: "response"; command: "get_subagents"; success: true; data: IceSubagentOverview | null }
	| {
			id?: string;
			type: "response";
			command: "respond_subagent_approval";
			success: true;
			data: { accepted: boolean };
	  }
	| { id?: string; type: "response"; command: "subagent_control"; success: true; data: { message: string } }
	| { id?: string; type: "response"; command: "subagent_patch"; success: true; data: RpcSubagentPatchResult }
	// Null when the subagent is unknown or belongs to another parent session
	| {
			id?: string;
			type: "response";
			command: "get_subagent_messages";
			success: true;
			data: IceSubagentTranscript | null;
	  }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[]; hasMore?: boolean; nextCursor?: string };
	  }
	| { id?: string; type: "response"; command: "get_providers"; success: true; data: RpcProviderSnapshot }
	| { id?: string; type: "response"; command: "get_models"; success: true; data: RpcModelSnapshot }
	| { id?: string; type: "response"; command: "refresh_models"; success: true; data: RpcModelsRefreshResult }
	| { id?: string; type: "response"; command: "abort_models_refresh"; success: true }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true; data: { level: ThinkingLevel } }
	| { id?: string; type: "response"; command: "set_fast_mode"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_thinking_levels";
			success: true;
			data: { levels: ThinkingLevel[] };
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_compaction"; success: true }
	| { id?: string; type: "response"; command: "abort_branch_summary"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| {
			id?: string;
			type: "response";
			command: "get_session_stats";
			success: true;
			data: SessionStats & { cacheWaste: CacheWasteTotals };
	  }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: RpcExportResult }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text?: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "list_sessions"; success: true; data: RpcSessionPage }
	| { id?: string; type: "response"; command: "import_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "export_jsonl"; success: true; data: RpcExportResult }
	| { id?: string; type: "response"; command: "delete_session"; success: true; data: { method: "trash" | "unlink" } }
	| { id?: string; type: "response"; command: "rename_session"; success: true }
	| {
			id?: string;
			type: "response";
			command: "navigate_tree";
			success: true;
			data: { cancelled: boolean; aborted?: boolean; editorText?: string; summaryEntryId?: string };
	  }
	| { id?: string; type: "response"; command: "set_entry_label"; success: true; data: { entryId: string } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			data: RpcEntryPage;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: RpcTreePage;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: RpcMessagePage }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_command_schema";
			success: true;
			data: RpcCommandSchemaResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "invoke_command";
			success: true;
			data: RpcCommandInvocationResult;
	  }

	// Error response (any command can fail)
	| {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
			errorCode?: string;
			errorDetails?: RpcCommandErrorDetails;
	  };

export type RpcAttachment =
	| { type: "text"; name: string; text: string }
	| { type: "image"; name: string; data: string; mimeType: string }
	/** A host file read like a CLI `@file` argument; relative paths resolve against the session cwd. */
	| { type: "file"; path: string };

export interface RpcExportResult {
	path: string;
	/** File contents, present only when `includeContent` was requested. */
	content?: string;
}

/** A flag registered by an extension, with its current value. */
export interface RpcExtensionFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	value?: boolean | string;
	extensionPath: string;
}

/** A keyboard shortcut registered by an extension, after built-in conflict resolution. */
export interface RpcExtensionShortcut {
	shortcut: string;
	description?: string;
	extensionPath: string;
}

export interface RpcDiagnostics {
	diagnostics: Array<{ source: string; severity: "warning" | "error"; code: string; path?: string; message: string }>;
	truncated: boolean;
}

export interface RpcUIState {
	statuses: Array<{ key: string; text: string }>;
	widgets: Array<{ key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
	/** Text projection of an extension header/footer; absent when none is set or it has no projection. */
	header?: string[];
	footer?: string[];
	title?: string;
	editorText?: string;
	workingMessage?: string;
	workingVisible?: boolean;
	truncated: boolean;
}

export interface RpcCompletions {
	/** `command`: slash names; `argument`: a command's argument completions; `path`: `@file` or path tokens. */
	kind: "command" | "argument" | "path";
	/** Trailing text of `prefix` that each item's `value` replaces. */
	replace: string;
	items: Array<{ value: string; label?: string; description?: string; source?: RpcCommandSource }>;
	hasMore: boolean;
}

/** A model reference as `set_model` takes it, with an optional per-model thinking level. */
export interface RpcScopedModelRef {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}

/** A registered tool and whether it is active for the model. */
export type RpcToolInfo = ToolInfo & { active: boolean };

/** A background shell without its output; `get_shell` returns the output. */
export type RpcShellSummary = Omit<BackgroundShellSnapshot, "output" | "finalText">;

export interface RpcShellDetail {
	shell: RpcShellSummary & { finalText?: string };
	/** Retained output from `sinceChars` onward (all of it when omitted). */
	output: string;
	/** Character offset of `output[0]` in the shell's lifetime output; pass `outputOffset + output.length` as the next `sinceChars`. */
	outputOffset: number;
}

/** Session list entry; timestamps are ISO strings and the searchable full text is omitted. */
export interface RpcSessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

export interface RpcChangelogEntry {
	version: string;
	content: string;
}

/** Loaded resources by path and metadata; file contents are not included. */
export interface RpcResources {
	contextFiles: string[];
	systemPromptPath?: string;
	appendSystemPromptPaths: string[];
	skills: Array<{ name: string; description: string; filePath: string; sourceInfo: SourceInfo }>;
	prompts: Array<{ name: string; description?: string; sourceInfo: SourceInfo }>;
	themes: Array<{ name?: string; sourcePath?: string }>;
	extensions: Array<{ path: string; sourceInfo: SourceInfo }>;
	extensionErrors: Array<{ path: string; error: string }>;
	diagnostics: ResourceDiagnostic[];
}

/** Emitted when background shells start, print, or finish; carries every tracked shell without output. */
export interface RpcShellsUpdateEvent {
	type: "shells_update";
	shells: RpcShellSummary[];
}

export type RpcSubagentPatchAction = "inspect" | "apply" | "reject";

/** Outcome of an `agent_patch` run on the user's behalf, exactly as the model would see it. */
export interface RpcSubagentPatchResult {
	/** True when an extension blocked the call or the tool failed. */
	isError: boolean;
	/** Tool text: changed paths and a bounded, redacted patch preview for inspect, or the outcome. */
	text: string;
	/** Tool details, for example `{ status, changedPaths }`. */
	details?: unknown;
}

/** Emitted whenever the subagent overview changes; carries the full bounded overview. */
export interface RpcSubagentsUpdateEvent {
	type: "subagents_update";
	overview: IceSubagentOverview;
}

/** Emitted after runtime replacement and RPC extension/subscription rebinding finish. */
export interface RpcSessionChangedEvent {
	type: "session_changed";
	previousSessionId: string;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	leafId: string | null;
}

/** All unsolicited RPC stdout records (responses are correlated separately). */
export type RpcEvent =
	| JsonAgentSessionEvent
	| RpcExtensionUIRequest
	| RpcShellsUpdateEvent
	| RpcSubagentsUpdateEvent
	| RpcSessionChangedEvent
	| RpcModelsChangedEvent
	| { type: "catalog_changed" }
	| { type: "settings_changed" };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| {
			type: "extension_ui_request";
			id: string;
			method: "select";
			title: string;
			options: string[];
			timeout?: number;
			content?: string;
	  }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setWorkingMessage"; message?: string }
	| { type: "extension_ui_request"; id: string; method: "setWorkingVisible"; visible: boolean }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWorkingIndicator";
			options?: { frames?: string[]; intervalMs?: number };
	  }
	| { type: "extension_ui_request"; id: string; method: "setHeader" | "setFooter"; lines: string[] | undefined }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
