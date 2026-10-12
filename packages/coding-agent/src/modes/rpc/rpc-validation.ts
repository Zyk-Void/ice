import { RPC_MAX_REQUEST_TIMEOUT_MS } from "./rpc-request-tracker.ts";
import type { RpcCommand, RpcCommandType, RpcExtensionUIResponse } from "./rpc-types.ts";

export const RPC_MAX_INPUT_LINE_BYTES = 16 * 1024 * 1024;

type Validator = (value: unknown) => boolean;
type Fields = Record<string, Validator>;

const string: Validator = (value) => typeof value === "string";
const boolean: Validator = (value) => typeof value === "boolean";
const object: Validator = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const optional =
	(validate: Validator): Validator =>
	(value) =>
		value === undefined || validate(value);
const oneOf =
	(...values: string[]): Validator =>
	(value) =>
		typeof value === "string" && values.includes(value);
const arrayOf =
	(validate: Validator): Validator =>
	(value) =>
		Array.isArray(value) && value.every(validate);
const thinking = oneOf("off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra");
const queueMode = oneOf("all", "one-at-a-time");
const source = optional(oneOf("builtin", "extension", "prompt", "skill"));
const images = optional(
	arrayOf((value) => {
		if (!object(value)) return false;
		const image = value as Record<string, unknown>;
		return image.type === "image" && string(image.data) && string(image.mimeType);
	}),
);
const message = { message: string, images };
const requestTimeout = optional(
	(value) =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= RPC_MAX_REQUEST_TIMEOUT_MS,
);
const pageLimit = optional(
	(value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 1000,
);

/** Exhaustive wire inventory: a new command must declare its input validation here. */
const commandFields = {
	prompt: {
		...message,
		streamingBehavior: optional(oneOf("steer", "followUp")),
		expandPromptTemplates: optional(boolean),
		attachments: optional(
			(value) =>
				Array.isArray(value) &&
				value.length <= 16 &&
				value.every((item: unknown) => {
					if (!object(item)) return false;
					const attachment = item as Record<string, unknown>;
					if (attachment.type === "file")
						return (
							typeof attachment.path === "string" && attachment.path.length > 0 && attachment.path.length <= 4096
						);
					if (typeof attachment.name !== "string" || attachment.name.length > 256) return false;
					return attachment.type === "text"
						? typeof attachment.text === "string" && Buffer.byteLength(attachment.text, "utf8") <= 1024 * 1024
						: attachment.type === "image" && string(attachment.data) && string(attachment.mimeType);
				}),
		),
	},
	steer: message,
	follow_up: message,
	remove_queued_message: { messageId: string },
	get_queue: {},
	clear_queue: {},
	abort: {},
	cancel_request: { requestId: string },
	new_session: { parentSession: optional(string) },
	get_capabilities: {},
	get_state: {},
	set_fast_mode: { enabled: boolean },
	get_tools: {},
	set_active_tools: { toolNames: arrayOf(string) },
	get_system_prompt: {},
	get_diagnostics: {},
	get_ui_state: {},
	get_completions: { prefix: (value) => typeof value === "string" && value.length <= 256, limit: pageLimit },
	get_resources: {},
	get_changelog: {},
	get_scoped_models: {},
	set_scoped_models: {
		models: arrayOf((value) => {
			if (!object(value)) return false;
			const ref = value as Record<string, unknown>;
			return string(ref.provider) && string(ref.modelId) && optional(thinking)(ref.thinkingLevel);
		}),
	},
	reload: {},
	stop_after_turn: {},
	get_flags: {},
	get_shortcuts: {},
	invoke_shortcut: { shortcut: (value) => typeof value === "string" && value.length > 0 && value.length <= 64 },
	get_shells: {},
	get_shell: {
		shellId: string,
		sinceChars: optional((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0),
	},
	kill_shell: { shellId: string },
	background_bash: {},
	get_settings: {},
	// Settings have their own authoritative validator and error details.
	set_setting: {},
	get_subagents: {},
	respond_subagent_approval: { approvalId: string, answer: oneOf("allow-once", "allow-session", "deny") },
	get_subagent_messages: { subagentId: string },
	subagent_control: {
		subagentId: string,
		action: oneOf("stop", "resume", "delete", "send"),
		message: optional(string),
	},
	subagent_patch: { subagentId: string, action: oneOf("inspect", "apply", "reject") },
	set_model: { provider: string, modelId: string },
	cycle_model: { direction: optional(oneOf("forward", "backward")) },
	get_available_models: { cursor: optional(string), limit: pageLimit },
	get_providers: {},
	get_models: {
		provider: optional(string),
		availableOnly: optional(boolean),
		cursor: optional(string),
		limit: pageLimit,
	},
	refresh_models: {
		providers: optional(arrayOf(string)),
		allowNetwork: optional(boolean),
		force: optional(boolean),
		timeoutMs: optional(
			(value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 30000,
		),
	},
	abort_models_refresh: {},
	set_thinking_level: { level: thinking },
	cycle_thinking_level: {},
	get_available_thinking_levels: {},
	set_steering_mode: { mode: queueMode },
	set_follow_up_mode: { mode: queueMode },
	compact: { customInstructions: optional(string), timeoutMs: requestTimeout },
	set_auto_compaction: { enabled: boolean },
	set_auto_retry: { enabled: boolean },
	abort_retry: {},
	abort_compaction: {},
	abort_branch_summary: {},
	bash: { command: string, excludeFromContext: optional(boolean), timeoutMs: requestTimeout },
	abort_bash: {},
	get_session_stats: {},
	export_html: { outputPath: optional(string), includeContent: optional(boolean) },
	switch_session: { sessionPath: string, cwd: optional(string) },
	fork: { entryId: string, position: optional(oneOf("before", "at")) },
	list_sessions: {
		scope: optional(oneOf("cwd", "all")),
		cursor: optional(string),
		limit: pageLimit,
		query: optional((value) => typeof value === "string" && value.length <= 256),
	},
	import_session: { path: string, cwd: optional(string) },
	export_jsonl: { outputPath: optional(string), includeContent: optional(boolean) },
	delete_session: { sessionPath: string },
	rename_session: { sessionPath: string, name: string },
	navigate_tree: {
		timeoutMs: requestTimeout,
		targetId: string,
		summarize: optional(boolean),
		customInstructions: optional(string),
		replaceInstructions: optional(boolean),
		label: optional(string),
	},
	set_entry_label: { entryId: string, label: optional(string) },
	clone: {},
	get_fork_messages: {},
	get_entries: { since: optional(string), limit: pageLimit },
	get_tree: {
		parentId: optional((value) => value === null || string(value)),
		cursor: optional(string),
		limit: pageLimit,
	},
	get_last_assistant_text: {},
	set_session_name: { name: string },
	get_messages: { cursor: optional((value) => typeof value === "string" && value.length <= 1024), limit: pageLimit },
	get_commands: {},
	get_command_schema: { name: string, schemaId: optional(string), source },
	invoke_command: {
		name: string,
		schemaId: optional(string),
		schemaRevision: optional(string),
		source,
		arguments: object,
		options: optional(
			(value) => object(value) && optional(oneOf("global", "project"))((value as Record<string, unknown>).scope),
		),
	},
} satisfies Record<RpcCommandType, Fields>;

export const RPC_COMMAND_TYPES = Object.keys(commandFields) as RpcCommandType[];

export type RpcInputValidation =
	| { valid: true; command: RpcCommand | RpcExtensionUIResponse }
	| {
			valid: false;
			id?: string;
			command: string;
			error: string;
			errorCode: "invalid_request" | "invalid_argument" | "unknown_command";
	  };

export function validateRpcInput(value: unknown): RpcInputValidation {
	if (!object(value))
		return { valid: false, command: "parse", error: "Expected a command object.", errorCode: "invalid_request" };
	const input = value as Record<string, unknown>;
	const id = typeof input.id === "string" ? input.id : undefined;
	const command = typeof input.type === "string" ? input.type : "parse";
	const invalid = (
		error: string,
		errorCode: "invalid_request" | "invalid_argument" | "unknown_command",
	): RpcInputValidation => ({ valid: false, id, command, error, errorCode });
	if (!string(input.type) || (input.id !== undefined && !string(input.id)))
		return invalid("Expected a string type and optional string id.", "invalid_request");
	if (command === "extension_ui_response") {
		if (!string(input.id) || !(string(input.value) || boolean(input.confirmed) || input.cancelled === true))
			return invalid("Expected a dialog id and value, confirmed, or cancelled response.", "invalid_argument");
		if (
			(input.value !== undefined && !string(input.value)) ||
			(input.confirmed !== undefined && !boolean(input.confirmed)) ||
			(input.cancelled !== undefined && input.cancelled !== true)
		)
			return invalid("Invalid dialog response value.", "invalid_argument");
		return { valid: true, command: input as unknown as RpcExtensionUIResponse };
	}
	if (!Object.hasOwn(commandFields, command)) return invalid(`Unknown command: ${command}`, "unknown_command");
	const fields: Fields = commandFields[command as RpcCommandType];
	if (input.timeoutMs !== undefined && !Object.hasOwn(fields, "timeoutMs"))
		return invalid(`Command ${command} does not support timeoutMs.`, "invalid_argument");
	for (const [key, validate] of Object.entries(fields)) {
		if (!validate(input[key])) return invalid(`Invalid or missing '${key}' for ${command}.`, "invalid_argument");
	}
	if (command === "subagent_control" && input.action === "send" && !string(input.message))
		return invalid("Action send requires message.", "invalid_argument");
	return { valid: true, command: input as unknown as RpcCommand };
}
