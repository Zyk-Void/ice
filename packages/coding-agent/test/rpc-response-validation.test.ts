import { fauxAssistantMessage } from "@zykairotis/ice-ai";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { getIceSettingsCommandSchemaResult } from "../src/modes/rpc/rpc-command-schema.ts";
import { validateRpcResponse } from "../src/modes/rpc/rpc-response-validation.ts";
import { createRpcSettingsSnapshot } from "../src/modes/rpc/rpc-settings.ts";
import type { RpcCommandType } from "../src/modes/rpc/rpc-types.ts";
import { RPC_COMMAND_TYPES } from "../src/modes/rpc/rpc-validation.ts";
import { getResources, listTools, toPublicModel } from "../src/modes/rpc/rpc-views.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let harness: Harness;
const payloads: Partial<Record<RpcCommandType, unknown>> = {};
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const entry = {
	type: "message",
	id: "entry",
	parentId: null,
	timestamp: "2026-01-01T00:00:00Z",
	message: { role: "user", content: "hello", timestamp: 1 },
};

beforeAll(async () => {
	harness = await createHarness();
	const context = { cwd: harness.tempDir, settingsManager: harness.settingsManager };
	const model = toPublicModel(harness.getModel());
	const noData: RpcCommandType[] = [
		"prompt",
		"steer",
		"follow_up",
		"abort",
		"set_fast_mode",
		"reload",
		"stop_after_turn",
		"invoke_shortcut",
		"rename_session",
		"abort_models_refresh",
		"set_steering_mode",
		"set_follow_up_mode",
		"set_auto_compaction",
		"set_auto_retry",
		"abort_retry",
		"abort_compaction",
		"abort_branch_summary",
		"abort_bash",
		"set_session_name",
	];
	for (const command of noData) payloads[command] = undefined;
	Object.assign(payloads, {
		remove_queued_message: { removed: false },
		get_queue: { steering: [], followUp: [] },
		clear_queue: { steering: [], followUp: [] },
		cancel_request: { accepted: true },
		new_session: { cancelled: false },
		get_capabilities: {
			protocolVersion: 1,
			commands: RPC_COMMAND_TYPES,
			features: [],
			limits: { maxInputLineBytes: 16777216 },
			host: { subagents: false },
		},
		get_state: {
			model,
			thinkingLevel: "off",
			fastMode: false,
			fastModeAvailable: false,
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			sessionId: "fixture",
			leafId: null,
			sessionDir: "/tmp",
			persisted: false,
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
			cwd: "/tmp",
			autoRetryEnabled: false,
			isRetrying: false,
			retryAttempt: 0,
			isBashRunning: false,
			backgroundShellCount: 0,
		},
		get_tools: { tools: listTools(harness.session) },
		set_active_tools: { active: ["read"] },
		get_system_prompt: { text: "hello" },
		get_resources: getResources(harness.session),
		get_changelog: { entries: [{ version: "1.0.0", content: "note" }] },
		get_scoped_models: { models: [] },
		set_scoped_models: { models: [{ provider: model.provider, modelId: model.id, thinkingLevel: "low" }] },
		get_diagnostics: {
			diagnostics: [{ source: "catalog", severity: "error", code: "catalog_error", message: "safe" }],
			truncated: false,
		},
		get_ui_state: {
			statuses: [{ key: "key", text: "text" }],
			widgets: [{ key: "widget", lines: ["line"], placement: "aboveEditor" }],
			truncated: false,
		},
		get_completions: {
			kind: "command",
			replace: "/com",
			items: [{ value: "/command", source: "extension" }],
			hasMore: false,
		},
		get_flags: { flags: [{ name: "flag", type: "boolean", default: false, value: true, extensionPath: "/ext" }] },
		get_shortcuts: { shortcuts: [{ shortcut: "ctrl+alt+y", extensionPath: "/ext" }] },
		delete_session: { method: "trash" },
		get_shells: { shells: [] },
		get_shell: null,
		kill_shell: { stopped: true },
		background_bash: { released: 1 },
		get_settings: createRpcSettingsSnapshot(context),
		set_setting: createRpcSettingsSnapshot(context),
		get_subagents: null,
		respond_subagent_approval: { accepted: false },
		get_subagent_messages: { live: false, messages: [fauxAssistantMessage("done")] },
		subagent_control: { message: "stopped" },
		subagent_patch: { isError: false, text: "patch" },
		set_model: model,
		cycle_model: { model, thinkingLevel: "low", isScoped: false },
		get_available_models: { models: [model], hasMore: false },
		get_providers: {
			providers: [
				{
					id: model.provider,
					name: "Faux",
					authTypes: ["api_key"],
					auth: { configured: false },
					modelCount: 1,
					availableModelCount: 0,
					dynamicCatalog: false,
				},
			],
			hasCatalogError: false,
		},
		get_models: { models: [model], hasCatalogError: false, hasMore: false },
		refresh_models: { aborted: false, timedOut: false, errors: [], hasCatalogError: false },
		set_thinking_level: { level: "low" },
		cycle_thinking_level: null,
		get_available_thinking_levels: { levels: ["off"] },
		compact: { summary: "summary", firstKeptEntryId: "entry", tokensBefore: 20, usage },
		bash: { output: "partial", exitCode: null, cancelled: true, truncated: false },
		get_session_stats: {
			sessionId: "fixture",
			userMessages: 1,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 1,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			cacheWaste: { missedTokens: 0, missedCost: 0, missCount: 0 },
		},
		export_html: { path: "/tmp/export.html" },
		switch_session: { cancelled: false },
		fork: { cancelled: false },
		clone: { cancelled: false },
		list_sessions: { sessions: [], hasMore: false },
		import_session: { cancelled: false },
		export_jsonl: { path: "/tmp/export.jsonl" },
		navigate_tree: { cancelled: false },
		set_entry_label: { entryId: "entry" },
		get_fork_messages: { messages: [{ entryId: "entry", text: "hello" }] },
		get_entries: { entries: [entry], leafId: "entry", hasMore: false },
		get_tree: { tree: [{ entry, children: [] }], leafId: "entry" },
		get_last_assistant_text: { text: null },
		get_messages: {
			messages: [
				{
					...fauxAssistantMessage("done"),
					diagnostics: [{ type: "info", timestamp: 1, error: { message: "safe", code: 1 } }],
				},
			],
			snapshot: "snapshot",
			hasMore: false,
		},
		get_commands: { commands: [{ name: "command", source: "extension", interaction: { type: "text" } }] },
		get_command_schema: getIceSettingsCommandSchemaResult(context),
		invoke_command: { status: "completed" },
	});
});
afterAll(() => harness?.cleanup());

function response(command: RpcCommandType, data: unknown) {
	return JSON.parse(JSON.stringify({ type: "response", id: "request", command, success: true, data })) as unknown;
}

describe("RPC success payload validation", () => {
	test.each(RPC_COMMAND_TYPES)("accepts native-shaped %s and rejects a primitive payload", (command) => {
		expect(Object.hasOwn(payloads, command)).toBe(true);
		expect(validateRpcResponse(command, response(command, payloads[command]))).toBe(true);
		expect(validateRpcResponse(command, response(command, 42))).toBe(false);
	});

	test("rejects malformed nested messages/models/tools/tree and failure details", () => {
		for (const [command, data] of [
			["get_models", { models: [{ ...harness.getModel(), reasoning: "yes" }], hasCatalogError: false }],
			["get_models", { models: [{ ...harness.getModel(), thinkingLevelMap: { high: 3 } }], hasCatalogError: false }],
			["get_tools", { tools: [{ ...listTools(harness.session)[0], access: "execute" }] }],
			["get_messages", { messages: [{ role: "unknown", timestamp: 1 }], snapshot: "s", hasMore: false }],
			[
				"get_messages",
				{
					messages: [{ ...fauxAssistantMessage("done"), diagnostics: [{ type: "info", timestamp: "bad" }] }],
					snapshot: "s",
					hasMore: false,
				},
			],
			["get_tree", { tree: [{ entry, children: [42] }], leafId: null }],
		] as const)
			expect(validateRpcResponse(command, response(command, data))).toBe(false);
		for (const fields of [{ errorCode: 42 }, { errorDetails: [] }, { errorDetails: { min: "one" } }])
			expect(
				validateRpcResponse("get_state", {
					type: "response",
					command: "get_state",
					success: false,
					error: "failed",
					...fields,
				}),
			).toBe(false);
		expect(
			validateRpcResponse("get_state", {
				type: "response",
				command: "get_state",
				success: false,
				error: "failed",
				errorCode: "busy",
				errorDetails: { field: "mode" },
			}),
		).toBe(true);
	});

	test("accepts shared acyclic metadata but rejects cycles/accessors/deep trees", () => {
		const shared = { note: "safe" };
		expect(
			validateRpcResponse("get_system_prompt", {
				type: "response",
				command: "get_system_prompt",
				success: true,
				data: { text: "hello", first: shared, second: shared },
			}),
		).toBe(true);
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(
			validateRpcResponse("get_system_prompt", {
				type: "response",
				command: "get_system_prompt",
				success: true,
				data: { text: "hello", cycle },
			}),
		).toBe(false);
		let accessed = false;
		const getter = Object.defineProperty({}, "secret", {
			enumerable: true,
			get: () => {
				accessed = true;
				return "value";
			},
		});
		expect(
			validateRpcResponse("get_system_prompt", {
				type: "response",
				command: "get_system_prompt",
				success: true,
				data: { text: "hello", getter },
			}),
		).toBe(false);
		expect(accessed).toBe(false);
		const root: { entry: typeof entry; children: unknown[] } = { entry, children: [] };
		let node = root;
		for (let i = 0; i < 70; i++) {
			const child = { entry, children: [] as unknown[] };
			node.children.push(child);
			node = child;
		}
		expect(validateRpcResponse("get_tree", response("get_tree", { tree: [root], leafId: null }))).toBe(false);
	});
});
