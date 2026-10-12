import type { RpcCommandType } from "./rpc-types.ts";

type Validator = (value: unknown) => boolean;
type Shape = Record<string, Validator>;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str: Validator = (v) => typeof v === "string";
const num: Validator = (v) => typeof v === "number" && Number.isFinite(v);
const bool: Validator = (v) => typeof v === "boolean";
const optional =
	(f: Validator): Validator =>
	(v) =>
		v === undefined || f(v);
const nullable =
	(f: Validator): Validator =>
	(v) =>
		v === null || f(v);
const literal =
	(...values: readonly unknown[]): Validator =>
	(v) =>
		values.includes(v);
const array =
	(f: Validator): Validator =>
	(v) =>
		Array.isArray(v) && v.every(f);
const object =
	(required: Shape, extras: Shape = {}): Validator =>
	(v) =>
		record(v) &&
		Object.entries(required).every(([key, f]) => Object.hasOwn(v, key) && f(v[key])) &&
		Object.entries(extras).every(([key, f]) => v[key] === undefined || f(v[key]));
const strings = array(str);
const stringRecord: Validator = (v) => record(v) && Object.values(v).every(str);
const thinking = literal("off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra");
const scope = literal("global", "project");
const source = literal("builtin", "extension", "prompt", "skill");
const sourceInfo = object(
	{ path: str, source: str, scope: literal("user", "project", "temporary"), origin: literal("package", "top-level") },
	{ baseDir: str },
);
const rates = { input: num, output: num, cacheRead: num, cacheWrite: num };
const usage = object(
	{ ...rates, totalTokens: num, cost: object({ ...rates, total: num }) },
	{ cacheWrite1h: num, reasoning: num },
);
const contextUsage = object({ tokens: nullable(num), contextWindow: num, percent: nullable(num) });
const model = object(
	{
		id: str,
		name: str,
		api: str,
		provider: str,
		baseUrl: str,
		reasoning: bool,
		input: array(literal("text", "image")),
		cost: object(rates, { tiers: array(object({ ...rates, inputTokensAbove: num })) }),
		contextWindow: num,
		maxTokens: num,
	},
	{
		serviceTiers: strings,
		headers: stringRecord,
		samplingParams: record,
		compat: record,
		thinkingLevelMap: (v) => record(v) && Object.values(v).every((x) => x === null || str(x)),
	},
);
const text = object({ type: literal("text"), text: str }, { textSignature: str });
const image = object({ type: literal("image"), data: str, mimeType: str });
const inputPart: Validator = (v) => text(v) || image(v);
const inputContent: Validator = (v) => str(v) || array(inputPart)(v);
const assistantPart: Validator = (v) =>
	text(v) ||
	object({ type: literal("thinking"), thinking: str }, { thinkingSignature: str, redacted: bool })(v) ||
	object({ type: literal("toolCall"), id: str, name: str, arguments: record }, { thoughtSignature: str })(v);
const bash = object(
	{ output: str, cancelled: bool, truncated: bool },
	{ exitCode: nullable(num), fullOutputPath: str },
);
const message: Validator = (v) => {
	if (!record(v) || !num(v.timestamp)) return false;
	switch (v.role) {
		case "user":
			return object({ content: inputContent })(v);
		case "assistant":
			return object(
				{
					content: array(assistantPart),
					api: str,
					provider: str,
					model: str,
					usage,
					stopReason: literal("pending", "stop", "length", "toolUse", "error", "aborted", "deferred"),
				},
				{
					responseModel: str,
					responseId: str,
					errorMessage: str,
					rawStopReason: str,
					diagnostics: array(
						object(
							{ type: str, timestamp: num },
							{
								error: object({ message: str }, { name: str, stack: str, code: (v) => str(v) || num(v) }),
								details: record,
							},
						),
					),
					deferred: object(
						{ provider: str, modelId: str, api: str, id: str },
						{ expiresAt: num, pollAfterMs: num },
					),
				},
			)(v);
		case "toolResult":
			return object(
				{ toolCallId: str, toolName: str, content: array(inputPart), isError: bool },
				{ usage, addedToolNames: strings },
			)(v);
		case "bashExecution":
			return bash(v) && object({ command: str }, { excludeFromContext: bool })(v);
		case "custom":
			return object({ customType: str, content: inputContent, display: bool })(v);
		case "branchSummary":
			return object({ summary: str, fromId: str })(v);
		case "compactionSummary":
			return object({ summary: str, tokensBefore: num })(v);
		default:
			return false;
	}
};
const compaction = object(
	{ summary: str, firstKeptEntryId: str, tokensBefore: num },
	{ estimatedTokensAfter: num, usage },
);
const entry: Validator = (v) => {
	if (!object({ type: str, id: str, parentId: nullable(str), timestamp: str })(v) || !record(v)) return false;
	switch (v.type) {
		case "message":
			return message(v.message);
		case "thinking_level_change":
			return str(v.thinkingLevel);
		case "model_change":
			return object({ provider: str, modelId: str })(v);
		case "compaction":
			return compaction(v) && object({}, { fromHook: bool })(v);
		case "branch_summary":
			return object({ fromId: str, summary: str }, { usage, fromHook: bool })(v);
		case "custom":
			return str(v.customType);
		case "custom_message":
			return object({ customType: str, content: inputContent, display: bool })(v);
		case "label":
			return object({ targetId: str }, { label: str })(v);
		case "session_info":
			return object({}, { name: str })(v);
		default:
			return false;
	}
};
function tree(v: unknown, depth = 0): boolean {
	return (
		depth < 64 &&
		object(
			{ entry, children: array((child) => tree(child, depth + 1)) },
			{ label: str, labelTimestamp: str, hasChildren: bool },
		)(v)
	);
}
const collision = object(
	{ resourceType: literal("extension", "skill", "prompt", "theme"), name: str, winnerPath: str, loserPath: str },
	{ winnerSource: str, loserSource: str },
);
const diagnostic = object({ type: literal("warning", "error", "collision"), message: str }, { path: str, collision });
const resources = object(
	{
		contextFiles: strings,
		appendSystemPromptPaths: strings,
		skills: array(object({ name: str, description: str, filePath: str, sourceInfo })),
		prompts: array(object({ name: str, sourceInfo }, { description: str })),
		themes: array(object({}, { name: str, sourcePath: str })),
		extensions: array(object({ path: str, sourceInfo })),
		extensionErrors: array(object({ path: str, error: str })),
		diagnostics: array(diagnostic),
	},
	{ systemPromptPath: str },
);
const scopedModels = object({ models: array(object({ provider: str, modelId: str }, { thinkingLevel: thinking })) });
const shell = object(
	{
		taskId: str,
		command: str,
		origin: literal("model", "user"),
		status: literal("running", "completed", "failed", "killed"),
		startedAt: num,
		totalChars: num,
	},
	{ description: str, endedAt: num, finalText: str },
);
const packageSource: Validator = (v) =>
	str(v) ||
	object(
		{ source: str },
		{ autoload: bool, extensions: strings, skills: strings, prompts: strings, themes: strings },
	)(v);
const settingsField: Validator = (v) => {
	if (
		!object(
			{
				key: str,
				label: str,
				description: str,
				group: str,
				kind: str,
				scope: literal("global", "project", "both"),
				projectOverride: bool,
				restartRequired: bool,
			},
			{
				effectiveSource: scope,
				hostOnly: bool,
				options: strings,
				constraints: object({}, { min: num, max: num, integer: bool, maxItems: num, maxLength: num }),
			},
		)(v) ||
		!record(v)
	)
		return false;
	const kinds: Record<string, Validator> = {
		boolean: bool,
		select: str,
		number: num,
		text: str,
		"string-list": strings,
		"package-sources": array(packageSource),
	};
	const f = Object.hasOwn(kinds, String(v.kind)) ? kinds[String(v.kind)] : undefined;
	return Boolean(f?.(v.value) && f?.(v.effectiveValue));
};
const settings = object({
	protocolVersion: literal(1),
	cwd: str,
	projectTrusted: bool,
	fields: array(settingsField),
	diagnostics: array(
		object({
			code: literal("settings_io_error", "settings_parse_error", "ice_policy_error", "ice_deprecated_setting"),
			scope,
			message: str,
		}),
	),
});
const schemaField: Validator = (v) => {
	if (
		!object(
			{ key: str, label: str, valueType: str },
			{
				description: str,
				group: str,
				required: bool,
				readOnly: bool,
				restartRequired: bool,
				placeholder: str,
				scope: literal("global", "project", "either"),
				projectOverride: bool,
				min: num,
				max: num,
				step: num,
				minLength: num,
				maxLength: num,
				multiline: bool,
				minItems: num,
				maxItems: num,
			},
		)(v) ||
		!record(v)
	)
		return false;
	const types: Record<string, Validator> = {
		boolean: bool,
		integer: (x) => num(x) && Number.isInteger(x),
		number: num,
		string: str,
		enum: str,
		"string-list": strings,
	};
	const f = Object.hasOwn(types, String(v.valueType)) ? types[String(v.valueType)] : undefined;
	return (
		f !== undefined &&
		optional(f)(v.value) &&
		optional(f)(v.effectiveValue) &&
		(v.valueType !== "enum" || array(object({ value: str, label: str }, { description: str }))(v.options))
	);
};
const schema = object(
	{
		protocolVersion: literal(1),
		commandName: str,
		schemaId: str,
		revision: str,
		title: str,
		invocationMode: literal("single-field"),
		fields: array(schemaField),
	},
	{ description: str, groups: array(object({ id: str, label: str }, { description: str })), diagnostics: strings },
);
const overview = object({
	enabled: bool,
	capacity: object({ running: num, queued: num, max: num }),
	maxDepth: num,
	diagnostics: strings,
	children: array(
		object(
			{
				id: str,
				agent: str,
				description: str,
				state: str,
				depth: num,
				running: bool,
				background: bool,
				resident: bool,
				finished: bool,
				turns: num,
				tokens: num,
				cost: num,
			},
			{ name: str, lastTurnOutcome: str, patchState: str, blockedReasons: strings },
		),
	),
	approvals: array(
		object(
			{ id: str, childId: str, agent: str, tool: str, summary: str, foreground: bool, queuedAt: num, deadline: num },
			{ name: str, sessionRule: str },
		),
	),
});
const state = object(
	{
		thinkingLevel: thinking,
		fastMode: bool,
		fastModeAvailable: bool,
		isStreaming: bool,
		isCompacting: bool,
		steeringMode: literal("all", "one-at-a-time"),
		followUpMode: literal("all", "one-at-a-time"),
		sessionId: str,
		leafId: nullable(str),
		sessionDir: str,
		persisted: bool,
		autoCompactionEnabled: bool,
		messageCount: num,
		pendingMessageCount: num,
		cwd: str,
		autoRetryEnabled: bool,
		isRetrying: bool,
		retryAttempt: num,
		isBashRunning: bool,
		backgroundShellCount: num,
	},
	{ model, sessionFile: str, sessionName: str, parentSessionPath: str, contextUsage },
);
const queue = object({ steering: strings, followUp: strings });
const cancelled = object({ cancelled: bool });
const accepted = object({ accepted: bool });
const level = object({ level: thinking });
const noData: Validator = (v) => v === undefined;

/** Exhaustive against the local command union; new commands must supply a validator. */
const successValidators = {
	prompt: noData,
	steer: noData,
	follow_up: noData,
	abort: noData,
	remove_queued_message: object({ removed: bool }),
	get_queue: queue,
	clear_queue: queue,
	cancel_request: accepted,
	new_session: cancelled,
	get_capabilities: object(
		{
			protocolVersion: literal(1),
			commands: strings,
			features: strings,
			limits: object(
				{ maxInputLineBytes: num },
				{
					maxPendingCommands: num,
					maxRequestTimeoutMs: num,
					maxRetainedInputBytes: num,
					maxControlInputBytes: num,
					maxLiveControls: num,
					maxQueuedOutputBytes: num,
				},
			),
			host: object({ subagents: bool }),
		},
		{
			cancellation: object(
				{ commands: strings, cooperative: literal(true), includesQueueTime: literal(true) },
				{ queuedCommands: strings },
			),
		},
	),
	get_state: state,
	set_fast_mode: noData,
	get_diagnostics: object({
		diagnostics: array(
			object({ source: str, severity: literal("warning", "error"), code: str, message: str }, { path: str }),
		),
		truncated: bool,
	}),
	get_ui_state: object(
		{
			statuses: array(object({ key: str, text: str })),
			widgets: array(object({ key: str, lines: strings, placement: literal("aboveEditor", "belowEditor") })),
			truncated: bool,
		},
		{ header: strings, footer: strings, title: str, editorText: str, workingMessage: str, workingVisible: bool },
	),
	get_completions: object({
		kind: literal("command", "argument", "path"),
		replace: str,
		items: array(object({ value: str }, { label: str, description: str, source })),
		hasMore: bool,
	}),
	get_tools: object({
		tools: array(
			object(
				{ name: str, description: str, parameters: record, sourceInfo, active: bool },
				{ promptGuidelines: strings, access: literal("read", "write") },
			),
		),
	}),
	set_active_tools: object({ active: strings }),
	get_system_prompt: object({ text: str }),
	get_resources: resources,
	get_changelog: object({ entries: array(object({ version: str, content: str })) }),
	get_scoped_models: scopedModels,
	set_scoped_models: scopedModels,
	reload: noData,
	stop_after_turn: noData,
	get_flags: object({
		flags: array(
			object(
				{ name: str, type: literal("boolean", "string"), extensionPath: str },
				{ description: str, default: (v) => bool(v) || str(v), value: (v) => bool(v) || str(v) },
			),
		),
	}),
	get_shortcuts: object({ shortcuts: array(object({ shortcut: str, extensionPath: str }, { description: str })) }),
	invoke_shortcut: noData,
	get_shells: object({ shells: array(shell) }),
	get_shell: nullable(object({ shell, output: str, outputOffset: num })),
	kill_shell: object({ stopped: bool }),
	background_bash: object({ released: num }),
	get_settings: settings,
	set_setting: settings,
	get_subagents: nullable(overview),
	respond_subagent_approval: accepted,
	get_subagent_messages: nullable(object({ live: bool, messages: array(message) })),
	subagent_control: object({ message: str }),
	subagent_patch: object({ isError: bool, text: str }),
	set_model: model,
	cycle_model: nullable(object({ model, thinkingLevel: thinking, isScoped: bool })),
	get_available_models: object({ models: array(model) }, { hasMore: bool, nextCursor: str }),
	get_providers: object({
		providers: array(
			object({
				id: str,
				name: str,
				authTypes: array(literal("api_key", "oauth")),
				auth: object({ configured: bool }, { source: str, type: literal("api_key", "oauth") }),
				modelCount: num,
				availableModelCount: num,
				dynamicCatalog: bool,
			}),
		),
		hasCatalogError: bool,
	}),
	get_models: object({ models: array(model), hasCatalogError: bool }, { hasMore: bool, nextCursor: str }),
	refresh_models: object({
		aborted: bool,
		timedOut: bool,
		errors: array(object({ provider: str, errorCode: str, message: str })),
		hasCatalogError: bool,
	}),
	abort_models_refresh: noData,
	set_thinking_level: level,
	cycle_thinking_level: nullable(level),
	get_available_thinking_levels: object({ levels: array(thinking) }),
	set_steering_mode: noData,
	set_follow_up_mode: noData,
	compact: compaction,
	set_auto_compaction: noData,
	set_auto_retry: noData,
	abort_retry: noData,
	abort_compaction: noData,
	abort_branch_summary: noData,
	bash,
	abort_bash: noData,
	get_session_stats: object(
		{
			sessionId: str,
			userMessages: num,
			assistantMessages: num,
			toolCalls: num,
			toolResults: num,
			totalMessages: num,
			tokens: object({ ...rates, total: num }),
			cost: num,
			cacheWaste: object({ missedTokens: num, missedCost: num, missCount: num }),
		},
		{ sessionFile: str, contextUsage },
	),
	export_html: object({ path: str }, { content: str }),
	switch_session: cancelled,
	fork: object({ cancelled: bool }, { text: str }),
	clone: cancelled,
	list_sessions: object(
		{
			sessions: array(
				object(
					{ path: str, id: str, cwd: str, created: str, modified: str, messageCount: num, firstMessage: str },
					{ name: str, parentSessionPath: str },
				),
			),
			hasMore: bool,
		},
		{ nextCursor: str },
	),
	import_session: cancelled,
	export_jsonl: object({ path: str }, { content: str }),
	delete_session: object({ method: literal("trash", "unlink") }),
	rename_session: noData,
	navigate_tree: object({ cancelled: bool }, { aborted: bool, editorText: str, summaryEntryId: str }),
	set_entry_label: object({ entryId: str }),
	get_fork_messages: object({ messages: array(object({ entryId: str, text: str })) }),
	get_entries: object({ entries: array(entry), leafId: nullable(str), hasMore: bool }, { nextCursor: str }),
	get_tree: object(
		{ tree: array((v) => tree(v)), leafId: nullable(str) },
		{ hasMore: bool, nextCursor: str, parentId: nullable(str) },
	),
	get_last_assistant_text: object({ text: nullable(str) }),
	set_session_name: noData,
	get_messages: object({ messages: array(message), snapshot: str, hasMore: bool }, { nextCursor: str }),
	get_commands: object({
		commands: array(
			object(
				{ name: str, source },
				{
					description: str,
					argumentHint: str,
					sourceInfo,
					rpcCommand: str,
					interaction: (v) =>
						object({ type: literal("text") })(v) || object({ type: literal("form"), schemaId: str })(v),
				},
			),
		),
	}),
	get_command_schema: object({
		capability: literal("available", "unsupported", "failed"),
		schema: nullable(schema),
		diagnostics: strings,
	}),
	invoke_command: object({ status: literal("updated", "completed", "accepted") }, { schema, message: str }),
} satisfies Record<RpcCommandType, Validator>;

const validators: Record<string, Validator> = successValidators;
const errorDetails = object(
	{},
	{
		field: str,
		expectedType: literal("boolean", "integer", "number", "string", "enum", "string-list"),
		min: num,
		max: num,
		minLength: num,
		maxLength: num,
		minItems: num,
		maxItems: num,
		allowedValues: strings,
		scope,
		schemaId: str,
		schemaRevision: str,
	},
);

/** Bound even opaque extension details and extra metadata. These are admission limits,
 * not claims of full semantic validity. Reject cycles, accessors and exotic objects.
 */
function boundedData(value: unknown): boolean {
	const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
	const ancestors = new WeakSet<object>();
	let remaining = 1_000_000;
	while (pending.length > 0) {
		const item = pending.pop()!;
		const current = item.value;
		if (item.exit && typeof current === "object" && current !== null) {
			ancestors.delete(current);
			continue;
		}
		if (--remaining < 0 || item.depth > 128) return false;
		if (current === null || current === undefined || str(current) || bool(current) || num(current)) continue;
		if (typeof current !== "object" || ancestors.has(current)) return false;
		ancestors.add(current);
		pending.push({ value: current, depth: item.depth, exit: true });
		const isArray = Array.isArray(current);
		if (!isArray && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null)
			return false;
		const keys = Reflect.ownKeys(current).filter((key) => !isArray || key !== "length");
		if (keys.length > remaining || (isArray && keys.length !== current.length)) return false;
		for (const key of keys) {
			if (
				typeof key !== "string" ||
				(isArray &&
					(!Number.isSafeInteger(Number(key)) ||
						Number(key) < 0 ||
						Number(key) >= current.length ||
						String(Number(key)) !== key))
			)
				return false;
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (!descriptor || !("value" in descriptor)) return false;
			pending.push({ value: descriptor.value, depth: item.depth + 1 });
		}
	}
	return true;
}

/** Validate unknown response structure only; callers own subsequent typed decoding. */
export function validateRpcResponse(command: RpcCommandType, value: unknown): boolean {
	try {
		if (
			!Object.hasOwn(validators, command) ||
			!boundedData(value) ||
			!record(value) ||
			!Object.hasOwn(value, "type") ||
			!Object.hasOwn(value, "command") ||
			!Object.hasOwn(value, "success") ||
			value.type !== "response" ||
			value.command !== command ||
			!optional(str)(value.id) ||
			!bool(value.success)
		)
			return false;
		if (!value.success)
			return str(value.error) && optional(str)(value.errorCode) && optional(errorDetails)(value.errorDetails);
		return validators[command](value.data);
	} catch {
		return false;
	}
}
