import type { SettingItem } from "@zykairotis/ice-tui";
import type { RegisteredSettings } from "../../core/extensions/types.ts";
import type { IceSettingsValue, PackageSource, SettingsManager, SettingsScope } from "../../core/settings-manager.ts";
import { resolveSubagentConcurrencyPolicy } from "../../ice-subagent-concurrency.ts";
import { parseIceSettings, resolveIceSubagentContract } from "../../ice-subagent-settings.ts";

export type RpcSettingsFieldKind = "boolean" | "select" | "number" | "text" | "string-list" | "package-sources";
export type RpcSettingsFieldScope = SettingsScope | "both";
export type RpcSettingsValue = boolean | string | number | string[] | PackageSource[];

export interface RpcSettingsConstraints {
	min?: number;
	max?: number;
	integer?: boolean;
	maxItems?: number;
	maxLength?: number;
}

interface RpcSettingsFieldBase {
	key: string;
	label: string;
	description: string;
	group: string;
	kind: RpcSettingsFieldKind;
	scope: RpcSettingsFieldScope;
	projectOverride: boolean;
	/** Preference source; ICE restrictions may further narrow effectiveValue. */
	effectiveSource?: SettingsScope;
	restartRequired: boolean;
	hostOnly?: boolean;
	value: RpcSettingsValue;
	effectiveValue: RpcSettingsValue;
	options?: string[];
	constraints?: RpcSettingsConstraints;
}

export type RpcSettingsField = RpcSettingsFieldBase;

export interface RpcSettingsDiagnostic {
	code: "settings_io_error" | "settings_parse_error" | "ice_policy_error";
	scope: SettingsScope;
	message: string;
}

export interface RpcSettingsSnapshot {
	protocolVersion: 1;
	cwd: string;
	projectTrusted: boolean;
	fields: RpcSettingsField[];
	diagnostics: RpcSettingsDiagnostic[];
}

export interface RpcSettingUpdate {
	key: string;
	scope: SettingsScope;
	value: unknown;
}

export interface RpcSettingsContext {
	cwd: string;
	settingsManager: SettingsManager;
	getExtensionSettings?: () => RegisteredSettings[];
	applyLive?: () => void;
}

export type RpcSettingsErrorCode =
	| "unknown_key"
	| "invalid_scope"
	| "scope_not_supported"
	| "project_untrusted"
	| "invalid_type"
	| "invalid_option"
	| "out_of_range"
	| "invalid_value"
	| "extension_change_failed"
	| "persistence_failed";

export class RpcSettingsError extends Error {
	readonly code: RpcSettingsErrorCode;
	readonly key?: string;
	readonly scope?: SettingsScope;

	constructor(code: RpcSettingsErrorCode, message: string, options: { key?: string; scope?: SettingsScope } = {}) {
		super(message);
		this.name = "RpcSettingsError";
		this.code = code;
		this.key = options.key;
		this.scope = options.scope;
	}
}

interface RpcSettingsDefinition {
	key: string;
	label: string;
	description: string;
	group: string;
	kind: RpcSettingsFieldKind;
	scope: RpcSettingsFieldScope;
	defaultValue: RpcSettingsValue;
	restartRequired: boolean;
	hostOnly?: boolean;
	options?: string[];
	constraints?: RpcSettingsConstraints;
	read: (settings: SettingsManager) => RpcSettingsValue;
	set: (settings: SettingsManager, scope: SettingsScope, value: RpcSettingsValue) => void;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const TRANSPORTS = ["auto", "sse", "websocket"];
const STEERING_MODES = ["all", "one-at-a-time"];
const MID_RUN_COMPACTION = ["off", "pause", "resume"];
const PROJECT_TRUST = ["ask", "always", "never"];
const DOUBLE_ESCAPE_ACTIONS = ["fork", "tree", "none"];
const TREE_FILTER_MODES = ["default", "no-tools", "user-only", "labeled-only", "all"];
const UI_MODES = ["regular", "fullscreen"];
const FULLSCREEN_SCROLLBARS = ["auto", "always", "hidden"];

function setting(definition: Omit<RpcSettingsDefinition, "set"> & { key: string }): RpcSettingsDefinition {
	return {
		...definition,
		set: (settings, scope, value) => settings.setSettingValue(scope, definition.key, value),
	};
}

function effectiveIceValue(settings: SettingsManager, key: string, fallback: RpcSettingsValue): RpcSettingsValue {
	try {
		const global = parseIceSettings(settings.getGlobalSettings().ice).subagents;
		const project = parseIceSettings(
			settings.isProjectTrusted() ? settings.getProjectSettings().ice : undefined,
		).subagents;
		if (key === "ice.subagents.enabled") return global.enabled && project.enabled;
		if (key === "ice.hooks.enabled") {
			const globalHooks = parseIceSettings(settings.getGlobalSettings().ice).hooks;
			const projectHooks = parseIceSettings(
				settings.isProjectTrusted() ? settings.getProjectSettings().ice : undefined,
			).hooks;
			return settings.getGlobalSettings().ice?.hooks?.enabled === false
				? false
				: globalHooks.enabled || projectHooks.enabled;
		}
		const concurrencyPolicy = resolveSubagentConcurrencyPolicy({
			global,
			project,
			projectTrusted: settings.isProjectTrusted(),
		});
		if (key === "ice.subagents.concurrency.default") return concurrencyPolicy.defaultConcurrency;
		if (key === "ice.subagents.concurrency.max") return concurrencyPolicy.maxConcurrency;
		const contract = resolveIceSubagentContract({
			global,
			project,
			globalFirst: true,
			projectTrusted: settings.isProjectTrusted(),
			role: "__ice_defaults__",
			bundledDefaults: {
				thinking: "medium",
				timeoutMs: 120_000,
				maxOutputBytes: 24_576,
			},
		});
		switch (key) {
			case "ice.subagents.defaults.thinking":
				return contract.values.thinking;
			case "ice.subagents.defaults.timeoutMs":
				return contract.values.timeoutMs;
			case "ice.subagents.defaults.maxOutputBytes":
				return contract.values.maxOutputBytes;
			case "ice.subagents.allowedRoles":
				return contract.allowedRoles.value ? [...contract.allowedRoles.value] : [];
			default:
				return cloneValue(fallback);
		}
	} catch {
		// A malformed security-sensitive namespace must not appear enabled or
		// expose stale permissive values through a headless projection.
		if (key === "ice.subagents.enabled" || key === "ice.hooks.enabled") return false;
		return cloneValue(fallback);
	}
}

function effectiveIceConcurrencySource(settings: SettingsManager, key: string): SettingsScope | undefined {
	if (key !== "ice.subagents.concurrency.default" && key !== "ice.subagents.concurrency.max") return undefined;
	try {
		const projectTrusted = settings.isProjectTrusted();
		const global = parseIceSettings(settings.getGlobalSettings().ice).subagents;
		const project = parseIceSettings(projectTrusted ? settings.getProjectSettings().ice : undefined).subagents;
		const policy = resolveSubagentConcurrencyPolicy({ global, project, projectTrusted });
		const source = key.endsWith(".default") ? policy.sources.default : policy.sources.max;
		return source === "global" || source === "project" ? source : undefined;
	} catch {
		return undefined;
	}
}

function setIceValue(settings: SettingsManager, scope: SettingsScope, key: string, value: RpcSettingsValue): void {
	const current = (settings.getIceSettingsValue(scope) ?? {}) as unknown as Record<string, unknown>;
	const next = structuredClone(current);
	const parts = key.split(".").slice(1);
	let target = next;
	for (const part of parts.slice(0, -1)) {
		const existing = target[part];
		if (existing !== undefined && !isRecord(existing)) {
			throw new RpcSettingsError("invalid_value", `Cannot update ${key}: ${part} is not an object`, { key, scope });
		}
		target[part] = isRecord(existing) ? existing : {};
		target = target[part] as Record<string, unknown>;
	}
	const leaf = parts.at(-1);
	if (!leaf) throw new RpcSettingsError("unknown_key", `Invalid ICE setting key: ${key}`, { key, scope });
	target[leaf] = structuredClone(value);
	try {
		parseIceSettings(next);
	} catch (error) {
		throw new RpcSettingsError(
			"invalid_value",
			error instanceof Error ? error.message : `Invalid ICE setting: ${key}`,
			{ key, scope },
		);
	}
	settings.setIceSettingsValue(scope, next as IceSettingsValue);
}

function iceSetting(definition: Omit<RpcSettingsDefinition, "set"> & { key: string }): RpcSettingsDefinition {
	return {
		...definition,
		set: (settings, scope, value) => setIceValue(settings, scope, definition.key, value),
	};
}

const ICE_SETTINGS: RpcSettingsDefinition[] = [
	iceSetting({
		key: "ice.subagents.enabled",
		label: "ICE subagents",
		description: "Enable profile-based ICE delegation; disabling it blocks new child launches",
		group: "ICE · Subagents",
		kind: "boolean",
		scope: "both",
		defaultValue: true,
		restartRequired: false,
		read: (settings) => effectiveIceValue(settings, "ice.subagents.enabled", true) as boolean,
	}),
	iceSetting({
		key: "ice.subagents.defaults.thinking",
		label: "Subagent thinking",
		description: "Default reasoning effort for delegated children; the parent model route is unchanged",
		group: "ICE · Subagents",
		kind: "select",
		scope: "both",
		defaultValue: "medium",
		options: THINKING_LEVELS,
		restartRequired: false,
		read: (settings) => effectiveIceValue(settings, "ice.subagents.defaults.thinking", "medium") as string,
	}),
	iceSetting({
		key: "ice.subagents.defaults.timeoutMs",
		label: "Subagent timeout",
		description: "Default bounded child execution timeout in milliseconds",
		group: "ICE · Subagents",
		kind: "number",
		scope: "both",
		defaultValue: 120_000,
		constraints: { min: 1, max: 600_000, integer: true },
		restartRequired: false,
		read: (settings) => effectiveIceValue(settings, "ice.subagents.defaults.timeoutMs", 120_000) as number,
	}),
	iceSetting({
		key: "ice.subagents.defaults.maxOutputBytes",
		label: "Subagent result size cap",
		description: "Default complete parent-facing result size cap in UTF-8 bytes; this is not model tokens or cost",
		group: "ICE · Subagents",
		kind: "number",
		scope: "both",
		defaultValue: 24_576,
		constraints: { min: 1_024, max: 65_536, integer: true },
		restartRequired: false,
		read: (settings) => effectiveIceValue(settings, "ice.subagents.defaults.maxOutputBytes", 24_576) as number,
	}),
	iceSetting({
		key: "ice.subagents.allowedRoles",
		label: "Allowed subagent roles",
		description: "Optional role allowlist; an empty list means no additional role restriction",
		group: "ICE · Subagents",
		kind: "string-list",
		scope: "both",
		defaultValue: [],
		constraints: { maxItems: 64, maxLength: 64 },
		restartRequired: false,
		read: (settings) => effectiveIceValue(settings, "ice.subagents.allowedRoles", []) as string[],
	}),
	iceSetting({
		key: "ice.subagents.concurrency.default",
		label: "Subagent default concurrency",
		description: "Default active read-only children shared by batches and durable jobs",
		group: "ICE · Subagents",
		kind: "number",
		scope: "both",
		defaultValue: 4,
		constraints: { min: 1, max: 8, integer: true },
		restartRequired: false,
		read: (settings) => effectiveIceValue(settings, "ice.subagents.concurrency.default", 4) as number,
	}),
	iceSetting({
		key: "ice.subagents.concurrency.max",
		label: "Subagent concurrency cap",
		description: "Hard active-child ceiling shared by batches and durable jobs",
		group: "ICE · Subagents",
		kind: "number",
		scope: "both",
		defaultValue: 8,
		constraints: { min: 1, max: 8, integer: true },
		restartRequired: false,
		read: (settings) => effectiveIceValue(settings, "ice.subagents.concurrency.max", 8) as number,
	}),
	iceSetting({
		key: "ice.hooks.enabled",
		label: "Subagent lifecycle hooks",
		description:
			"Enable parent-owned hooks; executable hooks additionally require global command policy, trusted build mode, Bash and approval",
		group: "ICE · Hooks",
		kind: "boolean",
		scope: "both",
		defaultValue: false,
		restartRequired: false,
		read: (settings) => effectiveIceValue(settings, "ice.hooks.enabled", false) as boolean,
	}),
];

const BUILTIN_SETTINGS: RpcSettingsDefinition[] = [
	...ICE_SETTINGS,
	setting({
		key: "defaultProvider",
		label: "Default provider",
		description: "Provider selected when a new session starts",
		group: "Model",
		kind: "text",
		scope: "both",
		defaultValue: "",
		restartRequired: true,
		constraints: { maxLength: 256 },
		read: (settings) => settings.getDefaultProvider() ?? "",
	}),
	setting({
		key: "defaultModel",
		label: "Default model",
		description: "Model selected when a new session starts",
		group: "Model",
		kind: "text",
		scope: "both",
		defaultValue: "",
		restartRequired: true,
		constraints: { maxLength: 512 },
		read: (settings) => settings.getDefaultModel() ?? "",
	}),
	setting({
		key: "defaultThinkingLevel",
		label: "Default thinking level",
		description: "Reasoning level used for new and active sessions when supported",
		group: "Model",
		kind: "select",
		scope: "both",
		defaultValue: "off",
		options: THINKING_LEVELS,
		restartRequired: false,
		read: (settings) => settings.getDefaultThinkingLevel() ?? "off",
	}),
	setting({
		key: "fastMode",
		label: "Fast mode",
		description: "Request the priority service tier when the active model supports it",
		group: "Model",
		kind: "boolean",
		scope: "both",
		defaultValue: false,
		restartRequired: false,
		read: (settings) => settings.getFastMode(),
	}),
	setting({
		key: "transport",
		label: "Transport",
		description: "Provider streaming transport",
		group: "Network",
		kind: "select",
		scope: "both",
		defaultValue: "auto",
		options: TRANSPORTS,
		restartRequired: false,
		read: (settings) => settings.getTransport(),
	}),
	setting({
		key: "steeringMode",
		label: "Steering mode",
		description: "How queued steering messages are delivered",
		group: "Queue",
		kind: "select",
		scope: "both",
		defaultValue: "one-at-a-time",
		options: STEERING_MODES,
		restartRequired: false,
		read: (settings) => settings.getSteeringMode(),
	}),
	setting({
		key: "followUpMode",
		label: "Follow-up mode",
		description: "How queued follow-up messages are delivered",
		group: "Queue",
		kind: "select",
		scope: "both",
		defaultValue: "one-at-a-time",
		options: STEERING_MODES,
		restartRequired: false,
		read: (settings) => settings.getFollowUpMode(),
	}),
	setting({
		key: "compaction.enabled",
		label: "Automatic compaction",
		description: "Compact context automatically before the model runs out of space",
		group: "Compaction",
		kind: "boolean",
		scope: "both",
		defaultValue: true,
		restartRequired: false,
		read: (settings) => settings.getCompactionEnabled(),
	}),
	setting({
		key: "compaction.thresholdPercent",
		label: "Compaction threshold",
		description: "Context usage percentage that triggers automatic compaction",
		group: "Compaction",
		kind: "number",
		scope: "both",
		defaultValue: 85,
		constraints: { min: 1, max: 99, integer: true },
		restartRequired: false,
		read: (settings) => settings.getCompactionThresholdPercent(),
	}),
	setting({
		key: "compaction.midRunCompaction",
		label: "Mid-run compaction",
		description: "Pause or resume after compacting between tool turns",
		group: "Compaction",
		kind: "select",
		scope: "both",
		defaultValue: "off",
		options: MID_RUN_COMPACTION,
		restartRequired: false,
		read: (settings) => settings.getMidRunCompaction(),
	}),
	setting({
		key: "retry.enabled",
		label: "Automatic retry",
		description: "Retry transient provider failures",
		group: "Reliability",
		kind: "boolean",
		scope: "both",
		defaultValue: true,
		restartRequired: false,
		read: (settings) => settings.getRetryEnabled(),
	}),
	setting({
		key: "quietStartup",
		label: "Quiet startup",
		description: "Reduce startup status output",
		group: "Startup",
		kind: "boolean",
		scope: "both",
		defaultValue: false,
		restartRequired: false,
		read: (settings) => settings.getQuietStartup(),
	}),
	setting({
		key: "enableInstallTelemetry",
		label: "Install telemetry",
		description: "Allow anonymous install and update telemetry",
		group: "Privacy",
		kind: "boolean",
		scope: "global",
		defaultValue: true,
		restartRequired: false,
		read: (settings) => settings.getEnableInstallTelemetry(),
	}),
	setting({
		key: "collapseChangelog",
		label: "Collapse changelog",
		description: "Show a condensed changelog after updates",
		group: "Startup",
		kind: "boolean",
		scope: "both",
		defaultValue: false,
		restartRequired: false,
		read: (settings) => settings.getCollapseChangelog(),
	}),
	setting({
		key: "enableSkillCommands",
		label: "Skill commands",
		description: "Expose loaded skills as slash commands",
		group: "Resources",
		kind: "boolean",
		scope: "both",
		defaultValue: true,
		restartRequired: true,
		read: (settings) => settings.getEnableSkillCommands(),
	}),
	setting({
		key: "enabledModels",
		label: "Enabled model patterns",
		description: "Model patterns available for cycling",
		group: "Model",
		kind: "string-list",
		scope: "both",
		defaultValue: [],
		constraints: { maxItems: 1000, maxLength: 512 },
		restartRequired: true,
		read: (settings) => settings.getEnabledModels() ?? [],
	}),
	setting({
		key: "packages",
		label: "Package sources",
		description: "Configured package sources and resource filters",
		group: "Resources",
		kind: "package-sources",
		scope: "both",
		defaultValue: [],
		constraints: { maxItems: 100 },
		restartRequired: true,
		read: (settings) => settings.getPackages(),
	}),
	setting({
		key: "doubleEscapeAction",
		label: "Double escape action",
		description: "Action for double escape with an empty editor",
		group: "Input",
		kind: "select",
		scope: "both",
		defaultValue: "tree",
		options: DOUBLE_ESCAPE_ACTIONS,
		restartRequired: false,
		read: (settings) => settings.getDoubleEscapeAction(),
	}),
	setting({
		key: "treeFilterMode",
		label: "Tree filter mode",
		description: "Default filter used by the session tree",
		group: "Sessions",
		kind: "select",
		scope: "both",
		defaultValue: "default",
		options: TREE_FILTER_MODES,
		restartRequired: false,
		read: (settings) => settings.getTreeFilterMode(),
	}),
	setting({
		key: "defaultProjectTrust",
		label: "Default project trust",
		description: "Fallback trust decision for project-local resources",
		group: "Security",
		kind: "select",
		scope: "global",
		defaultValue: "ask",
		options: PROJECT_TRUST,
		restartRequired: false,
		read: (settings) => settings.getDefaultProjectTrust(),
	}),
	setting({
		key: "warnings.anthropicExtraUsage",
		label: "Anthropic extra usage warning",
		description: "Warn when subscription authentication may incur extra usage charges",
		group: "Warnings",
		kind: "boolean",
		scope: "both",
		defaultValue: true,
		restartRequired: false,
		read: (settings) => settings.getWarnings().anthropicExtraUsage ?? true,
	}),
	setting({
		key: "terminal.showImages",
		label: "Show terminal images",
		description: "Render images in terminal tool output",
		group: "Terminal",
		kind: "boolean",
		scope: "both",
		defaultValue: true,
		hostOnly: true,
		restartRequired: true,
		read: (settings) => settings.getShowImages(),
	}),
	setting({
		key: "terminal.imageWidthCells",
		label: "Terminal image width",
		description: "Preferred width for inline terminal images",
		group: "Terminal",
		kind: "number",
		scope: "both",
		defaultValue: 60,
		constraints: { min: 1, max: 1000, integer: true },
		hostOnly: true,
		restartRequired: true,
		read: (settings) => settings.getImageWidthCells(),
	}),
	setting({
		key: "terminal.clearOnShrink",
		label: "Clear terminal on shrink",
		description: "Clear rows when terminal content becomes shorter",
		group: "Terminal",
		kind: "boolean",
		scope: "both",
		defaultValue: false,
		hostOnly: true,
		restartRequired: true,
		read: (settings) => settings.getClearOnShrink(),
	}),
	setting({
		key: "terminal.showTerminalProgress",
		label: "Terminal progress",
		description: "Emit terminal progress escape sequences",
		group: "Terminal",
		kind: "boolean",
		scope: "both",
		defaultValue: false,
		hostOnly: true,
		restartRequired: true,
		read: (settings) => settings.getShowTerminalProgress(),
	}),
	setting({
		key: "images.autoResize",
		label: "Resize images",
		description: "Resize large images before sending them to the model",
		group: "Images",
		kind: "boolean",
		scope: "both",
		defaultValue: true,
		restartRequired: true,
		read: (settings) => settings.getImageAutoResize(),
	}),
	setting({
		key: "images.blockImages",
		label: "Block images",
		description: "Prevent images from being sent to providers",
		group: "Images",
		kind: "boolean",
		scope: "both",
		defaultValue: false,
		restartRequired: true,
		read: (settings) => settings.getBlockImages(),
	}),
	setting({
		key: "hideThinkingBlock",
		label: "Hide thinking blocks",
		description: "Hide reasoning blocks in the terminal transcript",
		group: "Terminal",
		kind: "boolean",
		scope: "both",
		defaultValue: false,
		hostOnly: true,
		restartRequired: true,
		read: (settings) => settings.getHideThinkingBlock(),
	}),
	setting({
		key: "showCacheMissNotices",
		label: "Cache miss notices",
		description: "Show significant prompt-cache misses in the transcript",
		group: "Terminal",
		kind: "boolean",
		scope: "both",
		defaultValue: false,
		hostOnly: true,
		restartRequired: true,
		read: (settings) => settings.getShowCacheMissNotices(),
	}),
	setting({
		key: "editorPaddingX",
		label: "Editor padding",
		description: "Horizontal padding for the input editor",
		group: "Terminal",
		kind: "number",
		scope: "both",
		defaultValue: 0,
		constraints: { min: 0, max: 3, integer: true },
		hostOnly: true,
		restartRequired: true,
		read: (settings) => settings.getEditorPaddingX(),
	}),
	setting({
		key: "outputPad",
		label: "Output padding",
		description: "Horizontal padding for rendered messages",
		group: "Terminal",
		kind: "number",
		scope: "both",
		defaultValue: 1,
		constraints: { min: 0, max: 1, integer: true },
		hostOnly: true,
		restartRequired: true,
		read: (settings) => settings.getOutputPad(),
	}),
	setting({
		key: "autocompleteMaxVisible",
		label: "Autocomplete height",
		description: "Maximum visible autocomplete entries",
		group: "Terminal",
		kind: "number",
		scope: "both",
		defaultValue: 5,
		constraints: { min: 3, max: 20, integer: true },
		hostOnly: true,
		restartRequired: true,
		read: (settings) => settings.getAutocompleteMaxVisible(),
	}),
	setting({
		key: "uiMode",
		label: "UI mode",
		description: "Terminal interface mode",
		group: "Terminal",
		kind: "select",
		scope: "both",
		defaultValue: "regular",
		options: UI_MODES,
		hostOnly: true,
		restartRequired: true,
		read: (settings) => settings.getUiMode(),
	}),
	setting({
		key: "fullscreenScrollbar",
		label: "Fullscreen scrollbar",
		description: "Scrollbar visibility in fullscreen mode",
		group: "Terminal",
		kind: "select",
		scope: "both",
		defaultValue: "auto",
		options: FULLSCREEN_SCROLLBARS,
		hostOnly: true,
		restartRequired: true,
		read: (settings) => settings.getFullscreenScrollbar(),
	}),
	setting({
		key: "showHardwareCursor",
		label: "Hardware cursor",
		description: "Keep the terminal hardware cursor visible for IME positioning",
		group: "Terminal",
		kind: "boolean",
		scope: "both",
		defaultValue: false,
		hostOnly: true,
		restartRequired: true,
		read: (settings) => settings.getShowHardwareCursor(),
	}),
];

function readPath(settings: Record<string, unknown>, key: string): unknown {
	let current: unknown = settings;
	for (const part of key.split(".")) {
		if (!isRecord(current) || !(part in current)) return undefined;
		current = current[part];
	}
	return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPath(settings: Record<string, unknown>, key: string): boolean {
	return readPath(settings, key) !== undefined;
}

function cloneValue(value: RpcSettingsValue): RpcSettingsValue {
	return structuredClone(value);
}

const MAX_PACKAGE_SOURCE_STRING_LENGTH = 4096;

function isSafePackageSourceString(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_PACKAGE_SOURCE_STRING_LENGTH && !value.includes("\u0000");
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isSafePackageSourceString);
}

function isPackageSource(value: unknown): value is PackageSource {
	if (isSafePackageSourceString(value)) return true;
	if (!isRecord(value) || !isSafePackageSourceString(value.source)) return false;
	const allowedKeys = new Set(["source", "autoload", "extensions", "skills", "prompts", "themes"]);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
	if (value.autoload !== undefined && typeof value.autoload !== "boolean") return false;
	for (const key of ["extensions", "skills", "prompts", "themes"]) {
		const entries = value[key];
		if (entries !== undefined && !isStringArray(entries)) return false;
	}
	return true;
}

function isPackageSources(value: unknown): value is PackageSource[] {
	return Array.isArray(value) && value.length <= 100 && value.every(isPackageSource);
}

function normalizeForSnapshot(definition: RpcSettingsDefinition, value: unknown): RpcSettingsValue {
	if (value === undefined) return cloneValue(definition.defaultValue);
	switch (definition.kind) {
		case "boolean":
			return typeof value === "boolean" ? value : cloneValue(definition.defaultValue);
		case "select":
			return typeof value === "string" && definition.options?.includes(value)
				? value
				: cloneValue(definition.defaultValue);
		case "number":
			return typeof value === "number" && Number.isFinite(value) ? value : cloneValue(definition.defaultValue);
		case "text":
			return typeof value === "string" ? value : cloneValue(definition.defaultValue);
		case "string-list":
			return isStringArray(value) ? [...value] : cloneValue(definition.defaultValue);
		case "package-sources":
			return isPackageSources(value) ? structuredClone(value) : cloneValue(definition.defaultValue);
	}
}

function invalid(code: RpcSettingsErrorCode, message: string, update: RpcSettingUpdate): RpcSettingsError {
	return new RpcSettingsError(code, message, { key: update.key, scope: update.scope });
}

function validateValue(definition: RpcSettingsDefinition, update: RpcSettingUpdate): RpcSettingsValue {
	const value = update.value;
	switch (definition.kind) {
		case "boolean":
			if (typeof value !== "boolean") throw invalid("invalid_type", `${update.key} requires a boolean`, update);
			return value;
		case "select":
			if (typeof value !== "string") throw invalid("invalid_type", `${update.key} requires a string option`, update);
			if (!definition.options?.includes(value)) {
				throw invalid("invalid_option", `Invalid option for ${update.key}: ${value}`, update);
			}
			return value;
		case "number": {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw invalid("invalid_type", `${update.key} requires a finite number`, update);
			}
			const constraints = definition.constraints;
			if (
				(constraints?.min !== undefined && value < constraints.min) ||
				(constraints?.max !== undefined && value > constraints.max) ||
				(constraints?.integer === true && !Number.isInteger(value))
			) {
				throw invalid("out_of_range", `Value out of range for ${update.key}`, update);
			}
			return value;
		}
		case "text":
			if (typeof value !== "string") throw invalid("invalid_type", `${update.key} requires text`, update);
			if (value.includes("\u0000") || (definition.constraints?.maxLength ?? Infinity) < value.length) {
				throw invalid("invalid_value", `Invalid text value for ${update.key}`, update);
			}
			return value;
		case "string-list":
			if (!isStringArray(value)) throw invalid("invalid_type", `${update.key} requires a string list`, update);
			if (
				value.length > (definition.constraints?.maxItems ?? Infinity) ||
				value.some(
					(item) => item.includes("\u0000") || item.length > (definition.constraints?.maxLength ?? Infinity),
				)
			) {
				throw invalid("invalid_value", `Invalid list value for ${update.key}`, update);
			}
			return [...value];
		case "package-sources":
			if (!isPackageSources(value)) {
				throw invalid("invalid_value", `Invalid package sources for ${update.key}`, update);
			}
			return structuredClone(value);
	}
}

function extensionDefinition(settings: RegisteredSettings, item: SettingItem): RpcSettingsDefinition | undefined {
	if (item.submenu || !item.values || item.values.length === 0) return undefined;
	const key = `extension.${settings.name}.${item.id}`;
	const booleanField = item.values.length === 2 && item.values.includes("true") && item.values.includes("false");
	const options = [...item.values];
	const kind: RpcSettingsFieldKind = booleanField ? "boolean" : "select";
	const defaultValue: RpcSettingsValue = booleanField ? item.currentValue === "true" : item.currentValue;
	return {
		key,
		label: item.label,
		description: item.description ?? `Extension setting ${item.label}`,
		group: `Extension: ${settings.name}`,
		kind,
		scope: "global",
		defaultValue,
		restartRequired: false,
		options: booleanField ? undefined : options,
		read: () => (booleanField ? item.currentValue === "true" : item.currentValue),
		set: (_manager, _scope, value) => {
			const serialized = booleanField ? (value ? "true" : "false") : String(value);
			try {
				settings.onChange(item.id, serialized);
				item.currentValue = serialized;
			} catch (error) {
				throw new RpcSettingsError(
					"extension_change_failed",
					error instanceof Error ? "Extension setting rejected the value" : "Extension setting failed",
					{ key },
				);
			}
		},
	};
}

function getDefinitions(context: RpcSettingsContext): RpcSettingsDefinition[] {
	const definitions = [...BUILTIN_SETTINGS];
	for (const settings of context.getExtensionSettings?.() ?? []) {
		for (const item of settings.items) {
			const definition = extensionDefinition(settings, item);
			if (definition) definitions.push(definition);
		}
	}
	return definitions;
}

function fieldFromDefinition(definition: RpcSettingsDefinition, settingsManager: SettingsManager): RpcSettingsField {
	const globalSettings = settingsManager.getGlobalSettings() as unknown as Record<string, unknown>;
	const projectSettings = settingsManager.getProjectSettings() as unknown as Record<string, unknown>;
	const effectiveValue = normalizeForSnapshot(definition, definition.read(settingsManager));
	const effectiveSource =
		effectiveIceConcurrencySource(settingsManager, definition.key) ??
		settingsManager.getSettingSource(definition.key);
	const configuredValue = normalizeForSnapshot(
		definition,
		readPath(globalSettings, definition.key) ?? definition.defaultValue,
	);
	return {
		key: definition.key,
		label: definition.label,
		description: definition.description,
		group: definition.group,
		kind: definition.kind,
		scope: definition.scope,
		value: configuredValue,
		effectiveValue,
		projectOverride:
			definition.scope !== "global" &&
			hasPath(projectSettings, definition.key) &&
			!(settingsManager.isGlobalFirst() && hasPath(globalSettings, definition.key)),
		effectiveSource,
		restartRequired: definition.restartRequired,
		...(definition.hostOnly ? { hostOnly: true } : {}),
		...(definition.options ? { options: [...definition.options] } : {}),
		...(definition.constraints ? { constraints: { ...definition.constraints } } : {}),
	};
}

function diagnostics(settingsManager: SettingsManager): RpcSettingsDiagnostic[] {
	const loadDiagnostics = settingsManager.getLoadErrors().map(({ scope }) => ({
		code: "settings_parse_error" as const,
		scope,
		message: `Unable to parse ${scope} settings; ICE delegation remains blocked until it is repaired`,
	}));
	const iceDiagnostics: RpcSettingsDiagnostic[] = [];
	const diagnoseIceScope = (scope: SettingsScope, value: unknown): void => {
		try {
			parseIceSettings(value);
		} catch {
			iceDiagnostics.push({
				code: "ice_policy_error",
				scope,
				message: "ICE security-sensitive settings are invalid; delegation is blocked",
			});
		}
	};
	diagnoseIceScope("global", settingsManager.getGlobalSettings().ice);
	if (settingsManager.isProjectTrusted()) {
		diagnoseIceScope("project", settingsManager.getProjectSettings().ice);
	}
	const writeDiagnostics = settingsManager.drainErrors().map(({ scope }) => ({
		code: "settings_io_error" as const,
		scope,
		message: `Unable to read or persist ${scope} settings`,
	}));
	return [...loadDiagnostics, ...iceDiagnostics, ...writeDiagnostics];
}

export function createRpcSettingsSnapshot(context: RpcSettingsContext): RpcSettingsSnapshot {
	const settingsManager = context.settingsManager;
	return {
		protocolVersion: 1,
		cwd: context.cwd,
		projectTrusted: settingsManager.isProjectTrusted(),
		fields: getDefinitions(context).map((definition) => fieldFromDefinition(definition, settingsManager)),
		diagnostics: diagnostics(settingsManager),
	};
}

export async function applyRpcSetting(
	context: RpcSettingsContext,
	update: RpcSettingUpdate,
): Promise<RpcSettingsSnapshot> {
	if (update.scope !== "global" && update.scope !== "project") {
		throw invalid("invalid_scope", `Unsupported settings scope: ${String(update.scope)}`, update);
	}

	const definition = getDefinitions(context).find((candidate) => candidate.key === update.key);
	if (!definition) throw invalid("unknown_key", `Unknown setting key: ${update.key}`, update);
	if (definition.scope === "global" && update.scope !== "global") {
		throw invalid("scope_not_supported", `${update.key} does not support project scope`, update);
	}
	if (update.scope === "project" && !context.settingsManager.isProjectTrusted()) {
		throw invalid("project_untrusted", "Project is not trusted; refusing to write project settings", update);
	}

	const value = validateValue(definition, update);
	try {
		definition.set(context.settingsManager, update.scope, value);
		await context.settingsManager.flush();
	} catch (error) {
		if (error instanceof RpcSettingsError) throw error;
		throw new RpcSettingsError("persistence_failed", "Unable to persist setting", {
			key: update.key,
			scope: update.scope,
		});
	}

	const errors = diagnostics(context.settingsManager);
	if (errors.length > 0) {
		throw new RpcSettingsError("persistence_failed", errors[0].message, {
			key: update.key,
			scope: errors[0].scope,
		});
	}
	context.applyLive?.();
	return createRpcSettingsSnapshot(context);
}
