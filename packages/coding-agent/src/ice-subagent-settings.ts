/**
 * ICE subagent control settings (W03–W06) and parent-owned lifecycle hooks
 * (W25–W37): namespaced `ice.subagents` / `ice.hooks` configuration, a pure
 * deterministic resolver with deny-first restriction composition, and an
 * in-process awaited hook dispatcher owned by the parent adapter.
 *
 * Design authority: agent_docs/implementation/subagent-control-settings-hooks-plan.md
 * sections 5 (configuration contract), 6 (invocation contract) and 7 (lifecycle
 * hooks). This module owns parsing/resolution only; file persistence stays in
 * SettingsManager (W04). Ice remains the sole authoritative reasoning/tool loop:
 * hooks observe or gate launches through parent-owned handlers, never through a
 * second agent loop, provider SDK, or child extension loading.
 */

import { createHash, randomUUID } from "node:crypto";

import { type IceCommandHookPolicy, parseIceCommandHookPolicy } from "./ice-subagent-command-hooks.ts";
import { SUBAGENT_CONCURRENCY_LIMITS, type SubagentConcurrencySettings } from "./ice-subagent-concurrency.ts";
import type { SubagentRequestedToolName, SubagentThinkingLevel } from "./ice-subagents.ts";
import { redactCredentialText } from "./utils/redact.ts";

// ---------------------------------------------------------------------------
// W03 — configuration schema
// ---------------------------------------------------------------------------

/** Operational preference fields shared by defaults, role defaults, and calls. */
export interface IceSubagentPreferenceFields {
	thinking?: SubagentThinkingLevel;
	timeoutMs?: number;
	maxOutputBytes?: number;
	temperature?: number;
	topP?: number;
}

export interface IceSubagentSettingsInput {
	enabled?: boolean;
	defaults?: IceSubagentPreferenceFields;
	allowedRoles?: string[];
	roleDefaults?: Record<string, IceSubagentPreferenceFields>;
	/** Reserved enforcement namespace; unknown keys fail closed. */
	restrictions?: {
		maxTimeoutMs?: number;
		maxOutputBytes?: number;
		denyRoles?: string[];
		denyTools?: string[];
	};
	modelSelection?: { mode?: string };
	/** Bounded active-child concurrency for batches and background jobs. */
	concurrency?: SubagentConcurrencySettings;
}

export interface IceHookDefinitionInput {
	id?: unknown;
	event?: unknown;
	roles?: unknown;
	kind?: unknown;
	timeoutMs?: unknown;
	maxOutputBytes?: unknown;
	required?: unknown;
	[key: string]: unknown;
}

export interface IceHooksSettingsInput {
	commandPolicy?: IceCommandHookPolicy;
	enabled?: boolean;
	definitions?: IceHookDefinitionInput[];
}

export interface IceSettingsInput {
	subagents?: IceSubagentSettingsInput;
	hooks?: IceHooksSettingsInput;
}

export const ICE_SUBAGENT_SETTINGS_LIMITS = {
	maxThinkingLength: 16,
	minTimeoutMs: 1,
	maxTimeoutMs: 10 * 60 * 1_000,
	minOutputBytes: 1_024,
	maxOutputBytes: 64 * 1_024,
	minTemperature: 0,
	maxTemperature: 2,
	minTopP: 0,
	maxTopP: 1,
	maxRoles: 64,
	maxRoleNameBytes: 64,
	maxRoleDefaults: 64,
	maxHooks: 32,
	maxHookIdBytes: 128,
	maxHookTimeoutMs: 30_000,
	maxHookOutputBytes: 32 * 1024,
} as const;

export const ICE_SUBAGENT_THINKING_LEVELS: readonly SubagentThinkingLevel[] = Object.freeze([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
]);

const KNOWN_SUBAGENT_SETTINGS_KEYS = new Set([
	"enabled",
	"defaults",
	"allowedRoles",
	"roleDefaults",
	"restrictions",
	"modelSelection",
	"concurrency",
]);
const KNOWN_CONCURRENCY_KEYS = new Set(["default", "max"]);
const KNOWN_PREFERENCE_KEYS = new Set(["thinking", "timeoutMs", "maxOutputBytes", "temperature", "topP"]);
const KNOWN_RESTRICTION_KEYS = new Set(["maxTimeoutMs", "maxOutputBytes", "denyRoles", "denyTools"]);
const KNOWN_HOOK_KEYS = new Set(["id", "event", "roles", "kind", "timeoutMs", "maxOutputBytes", "required"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): Error {
	return new Error(`Invalid ice subagent settings at ${path}: ${message}`);
}

function checkPositiveInteger(value: unknown, path: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw fail(path, `expected integer in [${minimum}, ${maximum}]`);
	}
	return value;
}

function checkFiniteNumber(value: unknown, path: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw fail(path, `expected finite number in [${minimum}, ${maximum}]`);
	}
	return value;
}

function checkRoleName(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) throw fail(path, "expected nonempty role name");
	const normalized = value.trim().toLowerCase();
	if (normalized.length === 0 || Buffer.byteLength(normalized) > ICE_SUBAGENT_SETTINGS_LIMITS.maxRoleNameBytes) {
		throw fail(path, "role name is empty or exceeds 64 bytes");
	}
	return normalized;
}

function parsePreferenceFields(
	value: unknown,
	path: string,
): { fields: IceSubagentPreferenceFields; diagnostics: string[] } {
	if (value === undefined) return { fields: {}, diagnostics: [] };
	if (!isRecord(value)) throw fail(path, "expected object");
	const diagnostics: string[] = [];
	const fields: IceSubagentPreferenceFields = {};
	for (const key of Object.keys(value)) {
		if (key === "maxTotalTokens") {
			throw fail(`${path}.${key}`, '"maxTotalTokens" was removed; use timeoutMs/maxOutputBytes');
		}
		if (key === "maxTurns" || key === "maxToolCalls") {
			throw fail(`${path}.${key}`, `"${key}" was removed; use timeoutMs/maxOutputBytes`);
		}
		if (!KNOWN_PREFERENCE_KEYS.has(key)) throw fail(`${path}.${key}`, `unknown preference key "${key}"`);
	}
	const raw = value as Record<string, unknown>;
	if (raw.thinking !== undefined) {
		if (
			typeof raw.thinking !== "string" ||
			!ICE_SUBAGENT_THINKING_LEVELS.includes(raw.thinking as SubagentThinkingLevel)
		) {
			throw fail(`${path}.thinking`, "expected a supported thinking level");
		}
		fields.thinking = raw.thinking as SubagentThinkingLevel;
	}
	if (raw.timeoutMs !== undefined) {
		fields.timeoutMs = checkPositiveInteger(
			raw.timeoutMs,
			`${path}.timeoutMs`,
			ICE_SUBAGENT_SETTINGS_LIMITS.minTimeoutMs,
			ICE_SUBAGENT_SETTINGS_LIMITS.maxTimeoutMs,
		);
	}
	if (raw.maxOutputBytes !== undefined) {
		fields.maxOutputBytes = checkPositiveInteger(
			raw.maxOutputBytes,
			`${path}.maxOutputBytes`,
			ICE_SUBAGENT_SETTINGS_LIMITS.minOutputBytes,
			ICE_SUBAGENT_SETTINGS_LIMITS.maxOutputBytes,
		);
	}
	if (raw.temperature !== undefined) {
		fields.temperature = checkFiniteNumber(
			raw.temperature,
			`${path}.temperature`,
			ICE_SUBAGENT_SETTINGS_LIMITS.minTemperature,
			ICE_SUBAGENT_SETTINGS_LIMITS.maxTemperature,
		);
	}
	if (raw.topP !== undefined) {
		fields.topP = checkFiniteNumber(
			raw.topP,
			`${path}.topP`,
			ICE_SUBAGENT_SETTINGS_LIMITS.minTopP,
			ICE_SUBAGENT_SETTINGS_LIMITS.maxTopP,
		);
	}
	return { fields: Object.freeze(fields), diagnostics };
}

export interface ParsedIceSubagentSettings {
	enabled: boolean;
	defaults: IceSubagentPreferenceFields;
	allowedRoles: readonly string[] | undefined;
	roleDefaults: Readonly<Record<string, IceSubagentPreferenceFields>>;
	restrictions: {
		maxTimeoutMs?: number;
		maxOutputBytes?: number;
		denyRoles: readonly string[];
		denyTools: readonly string[];
	};
	modelSelection: { mode: "inherit-parent" | "configured" };
	concurrency: SubagentConcurrencySettings;
	diagnostics: readonly string[];
}

export function parseIceSubagentSettings(input: unknown, path = "ice.subagents"): ParsedIceSubagentSettings {
	if (input === undefined || input === null) {
		return {
			enabled: true,
			defaults: Object.freeze({}),
			allowedRoles: undefined,
			roleDefaults: Object.freeze({}),
			restrictions: { denyRoles: Object.freeze([]), denyTools: Object.freeze([]) },
			modelSelection: { mode: "inherit-parent" },
			concurrency: Object.freeze({}),
			diagnostics: Object.freeze([]),
		};
	}
	if (!isRecord(input)) throw fail(path, "expected object");
	for (const key of Object.keys(input)) {
		if (!KNOWN_SUBAGENT_SETTINGS_KEYS.has(key)) throw fail(`${path}.${key}`, `unknown key "${key}"`);
	}
	const diagnostics: string[] = [];
	const enabled = input.enabled === undefined ? true : input.enabled;
	if (typeof enabled !== "boolean") throw fail(`${path}.enabled`, "expected boolean");
	const { fields: defaults } = parsePreferenceFields(input.defaults, `${path}.defaults`);
	let allowedRoles: readonly string[] | undefined;
	if (input.allowedRoles !== undefined) {
		if (!Array.isArray(input.allowedRoles)) throw fail(`${path}.allowedRoles`, "expected string array");
		if (input.allowedRoles.length > ICE_SUBAGENT_SETTINGS_LIMITS.maxRoles) {
			throw fail(`${path}.allowedRoles`, "too many roles");
		}
		allowedRoles = Object.freeze([
			...new Set(input.allowedRoles.map((role) => checkRoleName(role, `${path}.allowedRoles`))),
		]);
	}
	let roleDefaults: Record<string, IceSubagentPreferenceFields> = {};
	if (input.roleDefaults !== undefined) {
		if (!isRecord(input.roleDefaults)) throw fail(`${path}.roleDefaults`, "expected object");
		const names = Object.keys(input.roleDefaults);
		if (names.length > ICE_SUBAGENT_SETTINGS_LIMITS.maxRoleDefaults)
			throw fail(`${path}.roleDefaults`, "too many roles");
		for (const name of names) {
			const normalized = checkRoleName(name, `${path}.roleDefaults`);
			const { fields } = parsePreferenceFields(
				(input.roleDefaults as Record<string, unknown>)[name],
				`${path}.roleDefaults.${name}`,
			);
			roleDefaults[normalized] = fields;
		}
		roleDefaults = Object.freeze(roleDefaults);
	}
	const restrictions = {
		maxTimeoutMs: undefined as number | undefined,
		maxOutputBytes: undefined as number | undefined,
		denyRoles: [] as string[],
		denyTools: [] as string[],
	};
	if (input.restrictions !== undefined) {
		if (!isRecord(input.restrictions)) throw fail(`${path}.restrictions`, "expected object");
		for (const key of Object.keys(input.restrictions)) {
			if (key === "maxTotalTokens") {
				throw fail(`${path}.restrictions.${key}`, '"maxTotalTokens" was removed; use timeoutMs/maxOutputBytes');
			}
			if (key === "maxTurns" || key === "maxToolCalls") {
				throw fail(`${path}.restrictions.${key}`, `"${key}" was removed; use timeoutMs/maxOutputBytes`);
			}
			if (!KNOWN_RESTRICTION_KEYS.has(key))
				throw fail(`${path}.restrictions.${key}`, `unknown enforcement key "${key}"`);
		}
		const raw = input.restrictions as Record<string, unknown>;
		if (raw.maxTimeoutMs !== undefined) {
			restrictions.maxTimeoutMs = checkPositiveInteger(
				raw.maxTimeoutMs,
				`${path}.restrictions.maxTimeoutMs`,
				ICE_SUBAGENT_SETTINGS_LIMITS.minTimeoutMs,
				ICE_SUBAGENT_SETTINGS_LIMITS.maxTimeoutMs,
			);
		}
		if (raw.maxOutputBytes !== undefined) {
			restrictions.maxOutputBytes = checkPositiveInteger(
				raw.maxOutputBytes,
				`${path}.restrictions.maxOutputBytes`,
				ICE_SUBAGENT_SETTINGS_LIMITS.minOutputBytes,
				ICE_SUBAGENT_SETTINGS_LIMITS.maxOutputBytes,
			);
		}
		if (raw.denyRoles !== undefined) {
			if (!Array.isArray(raw.denyRoles)) throw fail(`${path}.restrictions.denyRoles`, "expected string array");
			restrictions.denyRoles = [
				...new Set(raw.denyRoles.map((role) => checkRoleName(role, `${path}.restrictions.denyRoles`))),
			];
		}
		if (raw.denyTools !== undefined) {
			if (!Array.isArray(raw.denyTools)) throw fail(`${path}.restrictions.denyTools`, "expected string array");
			if (
				raw.denyTools.length > 64 ||
				raw.denyTools.some(
					(tool) =>
						typeof tool !== "string" ||
						!/^[A-Za-z][A-Za-z0-9_.-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127})?$/.test(tool),
				)
			) {
				throw fail(
					`${path}.restrictions.denyTools`,
					"expected bounded tool names or exact MCP server/tool identifiers",
				);
			}
			restrictions.denyTools = [...new Set((raw.denyTools as string[]).map((tool) => tool.toLowerCase()))];
		}
	}
	let modelSelection: { mode: "inherit-parent" | "configured" } = { mode: "inherit-parent" };
	if (input.modelSelection !== undefined) {
		if (!isRecord(input.modelSelection)) throw fail(`${path}.modelSelection`, "expected object");
		const mode = (input.modelSelection as Record<string, unknown>).mode;
		if (
			Object.keys(input.modelSelection).some((key) => key !== "mode") ||
			(mode !== undefined && mode !== "inherit-parent" && mode !== "configured")
		) {
			throw fail(`${path}.modelSelection.mode`, 'expected "inherit-parent" or "configured"');
		}
		modelSelection = { mode: mode === "configured" ? "configured" : "inherit-parent" };
		if (mode === "configured") diagnostics.push("explicit child routing requires host-owned global approval");
	}
	let concurrency: SubagentConcurrencySettings = {};
	if (input.concurrency !== undefined) {
		if (!isRecord(input.concurrency)) throw fail(`${path}.concurrency`, "expected object");
		for (const key of Object.keys(input.concurrency)) {
			if (!KNOWN_CONCURRENCY_KEYS.has(key)) throw fail(`${path}.concurrency.${key}`, `unknown key "${key}"`);
		}
		const raw = input.concurrency as Record<string, unknown>;
		if (raw.default !== undefined) {
			concurrency.default = checkPositiveInteger(
				raw.default,
				`${path}.concurrency.default`,
				SUBAGENT_CONCURRENCY_LIMITS.min,
				SUBAGENT_CONCURRENCY_LIMITS.hardCap,
			);
		}
		if (raw.max !== undefined) {
			concurrency.max = checkPositiveInteger(
				raw.max,
				`${path}.concurrency.max`,
				SUBAGENT_CONCURRENCY_LIMITS.min,
				SUBAGENT_CONCURRENCY_LIMITS.hardCap,
			);
		}
		concurrency = Object.freeze(concurrency);
	}
	return {
		enabled,
		defaults,
		allowedRoles,
		roleDefaults,
		restrictions: Object.freeze({
			...restrictions,
			denyRoles: Object.freeze(restrictions.denyRoles),
			denyTools: Object.freeze(restrictions.denyTools),
		}),
		modelSelection,
		concurrency,
		diagnostics: Object.freeze(diagnostics),
	};
}

// ---------------------------------------------------------------------------
// W25 — hook event contract
// ---------------------------------------------------------------------------

export const ICE_SUBAGENT_HOOK_EVENTS = [
	"subagent.beforeLaunch",
	"subagent.started",
	"subagent.beforeTool",
	"subagent.afterTool",
	"subagent.checkpoint",
	"subagent.attention",
	"subagent.beforeAccept",
	"subagent.completed",
	"subagent.failed",
	"subagent.timedOut",
	"subagent.cancelled",
] as const;

export type IceSubagentHookEvent = (typeof ICE_SUBAGENT_HOOK_EVENTS)[number];

export const ICE_SUBAGENT_DECISION_EVENTS: readonly IceSubagentHookEvent[] = Object.freeze([
	"subagent.beforeLaunch",
	"subagent.beforeTool",
	"subagent.beforeAccept",
]);

export const ICE_SUBAGENT_OBSERVATION_EVENTS: readonly IceSubagentHookEvent[] = Object.freeze([
	"subagent.started",
	"subagent.afterTool",
	"subagent.checkpoint",
	"subagent.attention",
	"subagent.completed",
	"subagent.failed",
	"subagent.timedOut",
	"subagent.cancelled",
]);

export type IceHookKind = "in-process" | "command";
export type IceHookOutcome = "continue" | "deny" | "ask";

export interface IceHookDefinition {
	id: string;
	event: IceSubagentHookEvent;
	roles: readonly string[] | undefined;
	kind: IceHookKind;
	timeoutMs: number;
	maxOutputBytes: number;
	required: boolean;
}

export interface ParsedIceHooksSettings {
	commandPolicy?: IceCommandHookPolicy;
	enabled: boolean;
	definitions: readonly IceHookDefinition[];
	diagnostics: readonly string[];
}

function checkHookId(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw fail(path, "expected nonempty hook id");
	const id = value.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw fail(path, "hook id must match [A-Za-z0-9_-]{1,128}");
	return id;
}

export function parseIceHookDefinition(input: IceHookDefinitionInput, path: string): IceHookDefinition {
	if (!isRecord(input)) throw fail(path, "expected object");
	for (const key of Object.keys(input)) {
		if (!KNOWN_HOOK_KEYS.has(key)) throw fail(`${path}.${key}`, `unknown hook key "${key}"`);
	}
	const id = checkHookId(input.id, `${path}.id`);
	const event = input.event;
	if (typeof event !== "string" || !(ICE_SUBAGENT_HOOK_EVENTS as readonly string[]).includes(event)) {
		throw fail(`${path}.event`, `expected one of ${(ICE_SUBAGENT_HOOK_EVENTS as readonly string[]).join(", ")}`);
	}
	let roles: readonly string[] | undefined;
	if (input.roles !== undefined) {
		if (!Array.isArray(input.roles)) throw fail(`${path}.roles`, "expected string array");
		roles = Object.freeze([...new Set(input.roles.map((role) => checkRoleName(role, `${path}.roles`)))]);
	}
	const kind = input.kind === undefined ? "in-process" : input.kind;
	if (kind !== "in-process" && kind !== "command") {
		throw fail(`${path}.kind`, 'expected "in-process" or "command"');
	}
	const timeoutMs =
		input.timeoutMs === undefined
			? 1_500
			: checkPositiveInteger(input.timeoutMs, `${path}.timeoutMs`, 1, ICE_SUBAGENT_SETTINGS_LIMITS.maxHookTimeoutMs);
	const maxOutputBytes =
		input.maxOutputBytes === undefined
			? 8_192
			: checkPositiveInteger(
					input.maxOutputBytes,
					`${path}.maxOutputBytes`,
					1,
					ICE_SUBAGENT_SETTINGS_LIMITS.maxHookOutputBytes,
				);
	const required = input.required === undefined ? true : input.required;
	if (typeof required !== "boolean") throw fail(`${path}.required`, "expected boolean");
	return Object.freeze({ id, event: event as IceSubagentHookEvent, roles, kind, timeoutMs, maxOutputBytes, required });
}

export function parseIceHooksSettings(input: unknown, path = "ice.hooks"): ParsedIceHooksSettings {
	if (input === undefined || input === null) {
		return { enabled: false, definitions: Object.freeze([]), diagnostics: Object.freeze([]) };
	}
	if (!isRecord(input)) throw fail(path, "expected object");
	for (const key of Object.keys(input)) {
		if (key !== "enabled" && key !== "definitions" && key !== "commandPolicy")
			throw fail(`${path}.${key}`, `unknown key "${key}"`);
	}
	const commandPolicy = parseIceCommandHookPolicy(input.commandPolicy);
	const rawDefinitions = (input as Record<string, unknown>).definitions;
	const enabled =
		(input as Record<string, unknown>).enabled === undefined
			? Array.isArray(rawDefinitions) && rawDefinitions.length > 0
			: (input as Record<string, unknown>).enabled;
	if (typeof enabled !== "boolean") throw fail(`${path}.enabled`, "expected boolean");
	if (rawDefinitions === undefined)
		return { enabled, commandPolicy, definitions: Object.freeze([]), diagnostics: Object.freeze([]) };
	if (!Array.isArray(rawDefinitions)) throw fail(`${path}.definitions`, "expected array");
	if (rawDefinitions.length > ICE_SUBAGENT_SETTINGS_LIMITS.maxHooks)
		throw fail(`${path}.definitions`, "too many hooks");
	const seen = new Set<string>();
	const definitions = rawDefinitions.map((definition, index) => {
		const parsed = parseIceHookDefinition(definition as IceHookDefinitionInput, `${path}.definitions[${index}]`);
		if (seen.has(parsed.id)) throw fail(`${path}.definitions[${index}].id`, `duplicate hook id "${parsed.id}"`);
		seen.add(parsed.id);
		return parsed;
	});
	return { enabled, commandPolicy, definitions: Object.freeze(definitions), diagnostics: Object.freeze([]) };
}

export function parseIceSettings(input: unknown): {
	subagents: ParsedIceSubagentSettings;
	hooks: ParsedIceHooksSettings;
} {
	if (input === undefined || input === null) {
		return { subagents: parseIceSubagentSettings(undefined), hooks: parseIceHooksSettings(undefined) };
	}
	if (!isRecord(input)) throw fail("ice", "expected object");
	for (const key of Object.keys(input)) {
		if (key !== "subagents" && key !== "hooks") throw fail(`ice.${key}`, `unknown key "${key}"`);
	}
	return {
		subagents: parseIceSubagentSettings((input as Record<string, unknown>).subagents),
		hooks: parseIceHooksSettings((input as Record<string, unknown>).hooks),
	};
}

/** Read the raw `ice` namespace from merged or scoped settings. Unknown keys are preserved for strict parsing. */
export function readIceSettingsInput(settings: { ice?: unknown }): IceSettingsInput | undefined {
	const namespace = settings?.ice;
	if (namespace === undefined || namespace === null) return undefined;
	if (!isRecord(namespace)) throw fail("ice", "expected object");
	return namespace as IceSettingsInput;
}

// ---------------------------------------------------------------------------
// W05/W06 — deterministic defaults resolver + deny-first restriction composition
// ---------------------------------------------------------------------------

export type IceSettingSource =
	| "bundled"
	| "global"
	| "project"
	| "role"
	| "global-role"
	| "project-role"
	| "call"
	| "enforced";

export interface IceResolvedField<T> {
	value: T;
	source: IceSettingSource;
}

export interface IceResolvedSubagentContract {
	enabled: boolean;
	thinking: IceResolvedField<SubagentThinkingLevel>;
	timeoutMs: IceResolvedField<number>;
	maxOutputBytes: IceResolvedField<number>;
	temperature: IceResolvedField<number | undefined>;
	topP: IceResolvedField<number | undefined>;
	allowedRoles: IceResolvedField<readonly string[] | undefined>;
	role: IceResolvedField<string>;
	diagnostics: readonly string[];
	rejected: readonly string[];
	/** W06: legacy flat projection for compact consumers (values only). */
	values: {
		thinking: SubagentThinkingLevel;
		timeoutMs: number;
		maxOutputBytes: number;
		temperature?: number;
		topP?: number;
	};
	/** W06: legacy flat projection for compact consumers (sources only). */
	sources: {
		thinking: IceSettingSource;
		timeoutMs: IceSettingSource;
		maxOutputBytes: IceSettingSource;
		temperature: IceSettingSource;
		topP: IceSettingSource;
	};
	/** W06: caps that clamped a preference value (empty when none applied). */
	restrictionsApplied: readonly string[];
	/** W06: configured tool denials are applied again at the child dispatch boundary. */
	deniedTools: readonly string[];
	/** W06: deny-first refusal, when the role itself is refused. */
	denied?: { code: "role_denied" | "role_not_allowed" | "disabled"; message: string };
}

export interface IceContractCallInput extends IceSubagentPreferenceFields {
	role?: string;
	tools?: string[];
}

export interface IceResolverInput {
	global?: ParsedIceSubagentSettings;
	project?: ParsedIceSubagentSettings;
	/** ice always resolves global-first; stock ice keeps its own project-first default elsewhere. */
	globalFirst?: boolean;
	globalSettings?: { ice?: unknown };
	projectSettings?: { ice?: unknown };
	projectTrusted?: boolean;
	role: string;
	call?: IceContractCallInput;
	parentActiveTools?: readonly string[];
	unsafeHostExec?: boolean;
	bundledDefaults?: IceSubagentPreferenceFields;
}

const BUNDLED_CONTRACT_DEFAULTS: IceSubagentPreferenceFields = Object.freeze({
	thinking: "medium",
	timeoutMs: 120_000,
	maxOutputBytes: 24_576,
});

function frozenDiagnostics(values: string[]): readonly string[] {
	return Object.freeze(values.map((value) => redactCredentialText(value).slice(0, 512)));
}

/** Normalize a role name. Alias indirection was removed with the bundled catalog. */
export function normalizeIceRoleName(role: string): string {
	return role.trim().toLowerCase();
}

function intuitAllowedRolesIntersection(layers: Array<readonly string[] | undefined>): readonly string[] | undefined {
	let result: Set<string> | undefined;
	for (const layer of layers) {
		// An omitted or empty preference allowlist means "no additional
		// restriction". Deny-all policy is represented by denyRoles.
		if (layer === undefined || layer.length === 0) continue;
		const normalized = new Set(layer.map((role) => normalizeIceRoleName(role)));
		if (result === undefined) result = normalized;
		else result = new Set([...result].filter((role) => normalized.has(role)));
	}
	return result === undefined ? undefined : Object.freeze([...result].sort());
}

export function resolveIceSubagentContract(input: IceResolverInput): IceResolvedSubagentContract {
	const diagnostics: string[] = [];
	const rejected: string[] = [];
	const requestedRole = input.role.trim().toLowerCase();
	if (!requestedRole) throw new Error("Role must be nonempty.");
	const canonicalRole = normalizeIceRoleName(requestedRole);

	const globalParsed =
		input.global ??
		parseIceSubagentSettings(
			input.globalSettings ? readIceSettingsInput(input.globalSettings as { ice?: unknown })?.subagents : undefined,
			"ice.subagents(global)",
		);
	const projectTrusted = input.projectTrusted ?? true;
	// Project policy is untrusted until the caller proves otherwise. Never let a
	// pre-parsed project object bypass that boundary.
	const projectParsed = projectTrusted
		? (input.project ??
			(input.projectSettings
				? parseIceSubagentSettings(
						readIceSettingsInput(input.projectSettings as { ice?: unknown })?.subagents,
						"ice.subagents(project)",
					)
				: parseIceSubagentSettings(undefined, "ice.subagents(project)")))
		: parseIceSubagentSettings(undefined, "ice.subagents(project)");
	if (input.projectSettings && !projectTrusted) {
		diagnostics.push("project ice.subagents ignored without project trust");
	}

	const enabled = globalParsed.enabled && projectParsed.enabled;
	if (!globalParsed.enabled) diagnostics.push("ice.subagents disabled globally");
	if (!projectParsed.enabled) diagnostics.push("ice.subagents disabled by project");

	const bundled: IceSubagentPreferenceFields = { ...BUNDLED_CONTRACT_DEFAULTS, ...(input.bundledDefaults ?? {}) };
	// ice resolves global-first: an explicit global/default beats a project value.
	// Security restrictions stay deny-first either way. Stock ice behavior is
	// unchanged because stock ice never routes through this ice resolver.
	// globalFirst:false remains only as an escape hatch for legacy tests.
	const globalFirst = input.globalFirst !== false;
	const layers: Array<{ fields: IceSubagentPreferenceFields; source: IceSettingSource }> = globalFirst
		? [
				{ fields: bundled, source: "bundled" },
				{ fields: projectParsed.defaults, source: "project" },
				{ fields: globalParsed.defaults, source: "global" },
			]
		: [
				{ fields: bundled, source: "bundled" },
				{ fields: globalParsed.defaults, source: "global" },
				{ fields: projectParsed.defaults, source: "project" },
			];
	const roleLayers: Array<{ fields: IceSubagentPreferenceFields; source: IceSettingSource }> = [];
	const globalRole = globalParsed.roleDefaults[canonicalRole];
	const projectRole = projectParsed.roleDefaults[canonicalRole];
	if (globalFirst) {
		if (projectRole) roleLayers.push({ fields: projectRole, source: "project-role" });
		if (globalRole) roleLayers.push({ fields: globalRole, source: "global-role" });
	} else {
		if (globalRole) roleLayers.push({ fields: globalRole, source: "global-role" });
		if (projectRole) roleLayers.push({ fields: projectRole, source: "project-role" });
	}

	type PreferenceKey = keyof IceSubagentPreferenceFields;
	const resolveField = <K extends PreferenceKey>(
		key: K,
		callValue: IceSubagentPreferenceFields[K] | undefined,
	): IceResolvedField<NonNullable<IceSubagentPreferenceFields[K]>> => {
		let value = bundled[key] as NonNullable<IceSubagentPreferenceFields[K]>;
		let source: IceSettingSource = "bundled";
		const orderedLayers = globalFirst
			? [
					...layers.filter((layer) => layer.source === "project"),
					...roleLayers.filter((layer) => layer.source === "project-role"),
					...layers.filter((layer) => layer.source === "global"),
					...roleLayers.filter((layer) => layer.source === "global-role"),
				]
			: [...layers.slice(1), ...roleLayers];
		for (const layer of orderedLayers) {
			const candidate = layer.fields[key];
			if (candidate !== undefined) {
				value = candidate as NonNullable<IceSubagentPreferenceFields[K]>;
				source = layer.source;
			}
		}
		if (callValue !== undefined) {
			value = callValue as NonNullable<IceSubagentPreferenceFields[K]>;
			source = "call";
		}
		return { value, source };
	};

	const call = input.call ?? {};
	const thinking = resolveField("thinking", call.thinking);
	const timeoutMs = resolveField("timeoutMs", call.timeoutMs);
	const maxOutputBytes = resolveField("maxOutputBytes", call.maxOutputBytes);
	const resolveOptionalField = (
		key: "temperature" | "topP",
		callValue: number | undefined,
	): IceResolvedField<number | undefined> => {
		let value: number | undefined = bundled[key];
		let source: IceSettingSource = "bundled";
		const orderedLayers = globalFirst
			? [
					...layers.filter((layer) => layer.source === "project"),
					...roleLayers.filter((layer) => layer.source === "project-role"),
					...layers.filter((layer) => layer.source === "global"),
					...roleLayers.filter((layer) => layer.source === "global-role"),
				]
			: [...layers.slice(1), ...roleLayers];
		for (const layer of orderedLayers) {
			const candidate = layer.fields[key];
			if (candidate !== undefined) {
				value = candidate;
				source = layer.source;
			}
		}
		if (callValue !== undefined) {
			value = callValue;
			source = "call";
		}
		return { value, source };
	};
	const temperature = resolveOptionalField("temperature", call.temperature);
	const topP = resolveOptionalField("topP", call.topP);

	// W06: enforced hard caps use the most restrictive applicable cap and are not
	// another preference layer. Preference values above a cap are clamped with an
	// explicit diagnostic; the enforced source label records the restriction.
	const caps: Array<{
		key: "timeoutMs" | "maxOutputBytes";
		values: Array<number | undefined>;
	}> = [
		{ key: "timeoutMs", values: [globalParsed.restrictions.maxTimeoutMs, projectParsed.restrictions.maxTimeoutMs] },
		{
			key: "maxOutputBytes",
			values: [globalParsed.restrictions.maxOutputBytes, projectParsed.restrictions.maxOutputBytes],
		},
	];
	const resolvedTimeoutMs: IceResolvedField<number> = timeoutMs;
	const resolvedMaxOutputBytes: IceResolvedField<number> = maxOutputBytes;
	const clampToCap = (field: IceResolvedField<number>, cap: number, key: string): IceResolvedField<number> => {
		if (field.value <= cap) return field;
		diagnostics.push(`${key} clamped to enforced cap ${cap} (requested ${field.value} from ${field.source})`);
		return { value: cap, source: "enforced" };
	};
	const cappedTimeoutMs = (() => {
		const applicable = caps[0]!.values.filter((value): value is number => value !== undefined);
		return applicable.length === 0
			? resolvedTimeoutMs
			: clampToCap(resolvedTimeoutMs, Math.min(...applicable), "timeoutMs");
	})();
	const cappedMaxOutputBytes = (() => {
		const applicable = caps[1]!.values.filter((value): value is number => value !== undefined);
		return applicable.length === 0
			? resolvedMaxOutputBytes
			: clampToCap(resolvedMaxOutputBytes, Math.min(...applicable), "maxOutputBytes");
	})();

	// W06: allowed roles intersect across layers; project narrowing can never
	// re-enable a globally denied or globally unlisted role. Alias normalization
	// happens before the intersection so `scout` cannot bypass an `explore` deny.
	const allowedRoles = intuitAllowedRolesIntersection([globalParsed.allowedRoles, projectParsed.allowedRoles]);
	const denyRoles = new Set(
		[...globalParsed.restrictions.denyRoles, ...projectParsed.restrictions.denyRoles].map(normalizeIceRoleName),
	);
	const deniedTools = Object.freeze(
		[...new Set([...globalParsed.restrictions.denyTools, ...projectParsed.restrictions.denyTools])].sort(),
	);
	// W06: deny-first refusal is data, not a throw, so facades can render it
	// without catching. Deny wins over weaker allow rules.
	let denied: IceResolvedSubagentContract["denied"];
	if (!enabled) {
		denied = { code: "disabled", message: "ice.subagents is disabled." };
	} else if (denyRoles.has(canonicalRole)) {
		denied = {
			code: "role_denied",
			message: `Role "${canonicalRole}" is denied by ice.subagents restrictions (requested "${requestedRole}").`,
		};
	} else if (allowedRoles !== undefined && !allowedRoles.includes(canonicalRole)) {
		denied = {
			code: "role_not_allowed",
			message: `Role "${canonicalRole}" is not in the ice.subagents allowedRoles set (requested "${requestedRole}").`,
		};
	}
	const restrictionsApplied = diagnostics.some((entry) => entry.includes("timeoutMs clamped")) ? ["timeoutMs"] : [];
	if (diagnostics.some((entry) => entry.includes("maxOutputBytes clamped")))
		restrictionsApplied.push("maxOutputBytes");

	const contract: IceResolvedSubagentContract = {
		enabled,
		thinking,
		timeoutMs: cappedTimeoutMs,
		maxOutputBytes: cappedMaxOutputBytes,
		temperature,
		topP,
		allowedRoles: {
			value: allowedRoles,
			source: projectParsed.allowedRoles && projectParsed.allowedRoles.length > 0 ? "project" : "global",
		},
		role: { value: canonicalRole, source: "call" },
		deniedTools,
		diagnostics: frozenDiagnostics(diagnostics),
		rejected: frozenDiagnostics(rejected),
		values: {
			thinking: thinking.value,
			timeoutMs: cappedTimeoutMs.value,
			maxOutputBytes: cappedMaxOutputBytes.value,
			...(temperature.value !== undefined ? { temperature: temperature.value } : {}),
			...(topP.value !== undefined ? { topP: topP.value } : {}),
		},
		sources: {
			thinking: thinking.source,
			timeoutMs: cappedTimeoutMs.source,
			maxOutputBytes: cappedMaxOutputBytes.source,
			temperature: temperature.source,
			topP: topP.source,
		},
		restrictionsApplied: Object.freeze(restrictionsApplied),
		...(denied ? { denied } : {}),
	};
	return Object.freeze(contract);
}

export interface IceToolNarrowing {
	requested: readonly string[];
	effective: readonly SubagentRequestedToolName[];
	denied: readonly string[];
	diagnostics: readonly string[];
}

/** Intersect caller-requested tools with profile, parent, mode, and deny policy. */
export function narrowIceSubagentTools(options: {
	requested?: readonly string[];
	profileRequested?: readonly string[];
	profileTools?: readonly string[];
	parentActiveTools?: readonly string[];
	unsafeHostExec?: boolean;
	denyTools?: readonly string[];
}): IceToolNarrowing {
	const diagnostics: string[] = [];
	const parentActiveTools = options.parentActiveTools ?? ["read", "grep", "find", "ls"];
	const unsafeHostExec = options.unsafeHostExec ?? false;
	const profileRequested = options.profileRequested ?? options.profileTools ?? [];
	const eligible = new Set<SubagentRequestedToolName>(
		(unsafeHostExec
			? (["read", "grep", "find", "ls", "bash", "edit", "write"] as const)
			: (["read", "grep", "find", "ls"] as const)
		).filter((tool) => parentActiveTools.includes(tool)),
	);
	const profile = new Set(profileRequested.map((tool) => tool.toLowerCase()));
	const deny = new Set((options.denyTools ?? []).map((tool) => tool.toLowerCase()));
	const requested =
		options.requested === undefined ? [...profile] : [...options.requested.map((tool) => tool.toLowerCase())];
	if (options.requested !== undefined && options.requested.length === 0) {
		diagnostics.push("caller requested an empty tool subset; no tools will be granted");
	}
	const effective: SubagentRequestedToolName[] = [];
	const denied: string[] = [];
	for (const tool of new Set(requested)) {
		if (deny.has(tool)) {
			denied.push(tool);
			diagnostics.push(`tool "${tool}" denied by ice.subagents restrictions`);
			continue;
		}
		if (!profile.has(tool)) {
			denied.push(tool);
			diagnostics.push(`tool "${tool}" is not requested by the selected profile`);
			continue;
		}
		if (!eligible.has(tool as SubagentRequestedToolName)) {
			denied.push(tool);
			diagnostics.push(`tool "${tool}" is not eligible under the parent/mode policy`);
			continue;
		}
		effective.push(tool as SubagentRequestedToolName);
	}
	return {
		requested: Object.freeze(requested),
		effective: Object.freeze(effective),
		denied: Object.freeze(denied),
		diagnostics: frozenDiagnostics(diagnostics),
	};
}

// ---------------------------------------------------------------------------
// W26 — hook configuration resolver (stable IDs, mandatory globals win)
// ---------------------------------------------------------------------------

export interface IceHookSource {
	layer: "global" | "project" | "role" | "call";
	trusted: boolean;
}

export interface IceResolvedHook extends IceHookDefinition {
	source: IceHookSource;
	order: number;
}

export interface IceHookResolverInput {
	globalHooks?: { ice?: unknown };
	projectHooks?: { ice?: unknown };
	hooks?: ParsedIceHooksSettings;
	projectTrusted?: boolean;
	/** Optional role-level selection of approved optional hook IDs; undefined keeps all optional hooks. */
	roleHookIds?: readonly string[];
	/** Optional call-level selection of approved optional hook IDs; combined with roleHookIds as a union. */
	callHookIds?: readonly string[];
	role?: string;
	event?: IceSubagentHookEvent;
}

/** Deterministic hook order: mandatory globals, optional globals, project, role/call. */
export function resolveIceSubagentHooks(input: IceHookResolverInput): readonly IceResolvedHook[] {
	const projectTrusted = input.projectTrusted ?? true;
	const globalParsed =
		input.hooks ??
		parseIceHooksSettings(
			input.globalHooks ? readIceSettingsInput(input.globalHooks as { ice?: unknown })?.hooks : undefined,
			"ice.hooks(global)",
		);
	const projectParsed =
		projectTrusted && input.projectHooks
			? parseIceHooksSettings(
					readIceSettingsInput(input.projectHooks as { ice?: unknown })?.hooks,
					"ice.hooks(project)",
				)
			: parseIceHooksSettings(undefined, "ice.hooks(project)");

	const rawGlobalHooks = input.globalHooks
		? readIceSettingsInput(input.globalHooks as { ice?: unknown })?.hooks
		: undefined;
	if ((isRecord(rawGlobalHooks) && rawGlobalHooks.enabled === false) || (input.hooks && !input.hooks.enabled))
		return Object.freeze([]);
	const byId = new Map<string, IceResolvedHook>();
	let order = 0;
	const addLayer = (
		definitions: readonly IceHookDefinition[],
		source: IceHookSource,
		options: { mandatoryOnly?: boolean; optionalOnly?: boolean } = {},
	): void => {
		for (const definition of definitions) {
			if (options.mandatoryOnly && !definition.required) continue;
			if (options.optionalOnly && definition.required) continue;
			if (byId.has(definition.id)) {
				const global = byId.get(definition.id)!;
				if (definition.required && definition.event !== global.event)
					throw new Error(
						`Required hook ${definition.id} conflicts with its global event; resolve the configuration explicitly.`,
					);
				if (definition.required && !global.required)
					byId.set(definition.id, Object.freeze({ ...global, required: true }));
				continue;
			}
			// Project hooks can never shadow or disable a mandatory global hook id.
			byId.set(definition.id, Object.freeze({ ...definition, source, order: order++ }));
		}
	};
	// Mandatory globals first so project/role/call layers cannot weaken them.
	// A disabled layer contributes no hooks; retaining its definitions in memory
	// must not accidentally turn the feature back on.
	if (globalParsed.enabled) {
		addLayer(globalParsed.definitions, { layer: "global", trusted: true }, { mandatoryOnly: true });
		addLayer(globalParsed.definitions, { layer: "global", trusted: true }, { optionalOnly: true });
	}
	if (projectTrusted && projectParsed.enabled) {
		addLayer(projectParsed.definitions, { layer: "project", trusted: true });
	}

	const approvedOptional = new Set([...byId.values()].filter((hook) => !hook.required).map((hook) => hook.id));
	const checkSelectable = (ids: readonly string[] | undefined, kind: string): readonly string[] | undefined => {
		if (ids === undefined) return undefined;
		const selected = new Set<string>();
		for (const id of ids) {
			if (!byId.has(id)) throw new Error(`${kind} references unknown hook id "${id}".`);
			const hook = byId.get(id)!;
			if (hook.required) throw new Error(`${kind} must not reselect mandatory hook "${id}".`);
			if (!approvedOptional.has(id)) throw new Error(`${kind} references unapproved hook "${id}".`);
			selected.add(id);
		}
		return Object.freeze([...selected]);
	};
	const selectedRoleHookIds = checkSelectable(input.roleHookIds, "role hooks");
	const selectedCallHookIds = checkSelectable(input.callHookIds, "call hooks");
	const hasOptionalSelection = selectedRoleHookIds !== undefined || selectedCallHookIds !== undefined;
	const selectedOptionalHookIds = new Set([...(selectedRoleHookIds ?? []), ...(selectedCallHookIds ?? [])]);
	const ordered = [...byId.values()]
		.sort((left, right) => left.order - right.order)
		.filter((hook) => {
			if (hook.required) return true;
			if (hasOptionalSelection && !selectedOptionalHookIds.has(hook.id)) return false;
			if (input.role === undefined || hook.roles === undefined) return true;
			return hook.roles.map(normalizeIceRoleName).includes(normalizeIceRoleName(input.role));
		});
	if (input.event !== undefined) {
		return Object.freeze(ordered.filter((hook) => hook.event === input.event));
	}
	return Object.freeze(ordered);
}

// ---------------------------------------------------------------------------
// W27–W30, W34–W37 — parent-owned in-process hook dispatcher
// ---------------------------------------------------------------------------

export interface IceHookContextAddition {
	content: string;
}

export interface IceHookDecisionInput {
	hook: IceResolvedHook;
	event: IceSubagentHookEvent;
	ownerSessionId: string;
	runId: string;
	attempt?: 1 | 2;
	role?: string;
	/** Frozen bounded snapshot; handlers must not mutate authority. */
	payload: Readonly<Record<string, unknown>>;
	signal?: AbortSignal;
}

export interface IceHookDecisionResult {
	outcome: IceHookOutcome;
	reason?: string;
	/** Only `subagent.beforeLaunch` decision hooks may add bounded parent context. */
	contextAdditions?: readonly IceHookContextAddition[];
}

export type IceHookHandler = (input: IceHookDecisionInput) => IceHookDecisionResult | Promise<IceHookDecisionResult>;

const parentHookHandlers = new WeakMap<object, Record<string, IceHookHandler>>();

/** Trusted parent extensions register directly; event-bus messages never authorize handlers. */
export function registerIceSubagentHook(owner: object, id: string, handler: IceHookHandler): () => void {
	checkHookId(id, "parent hook registration");
	const handlers = getIceSubagentHookHandlers(owner);
	if (Object.hasOwn(handlers, id)) throw new Error(`Duplicate parent hook handler "${id}".`);
	handlers[id] = handler;
	return () => {
		if (handlers[id] === handler) delete handlers[id];
	};
}

export function getIceSubagentHookHandlers(owner: object): Record<string, IceHookHandler> {
	let handlers = parentHookHandlers.get(owner);
	if (!handlers) {
		handlers = Object.create(null) as Record<string, IceHookHandler>;
		parentHookHandlers.set(owner, handlers);
	}
	return handlers;
}

export const ICE_HOOK_JOURNAL_ENTRY_TYPE = "ice-subagent-hook-v1";

export interface IceHookJournalEntry {
	schemaVersion: 1;
	phase: "intent" | "outcome";
	record: IceHookDispatchRecord;
}

export interface IceHookDispatchRecord {
	eventId: string;
	ownerSessionId: string;
	runId: string;
	attempt?: 1 | 2;
	hookId: string;
	event: IceSubagentHookEvent;
	outcome: IceHookOutcome;
	required: boolean;
	reason?: string;
	durationMs: number;
	observational: boolean;
}

export const ICE_HOOK_CONTEXT_ADDITION_LIMITS = Object.freeze({
	maxItemsPerHook: 4,
	maxItemBytes: 4 * 1024,
} as const);

function normalizeHookContextAdditions(value: unknown, hookId: string): readonly IceHookContextAddition[] {
	if (value === undefined) return Object.freeze([]);
	if (!Array.isArray(value) || value.length > ICE_HOOK_CONTEXT_ADDITION_LIMITS.maxItemsPerHook) {
		throw new Error(
			`hook "${hookId}" returned more than ${ICE_HOOK_CONTEXT_ADDITION_LIMITS.maxItemsPerHook} context additions`,
		);
	}
	const additions = value.map((entry, index) => {
		if (!isRecord(entry) || typeof entry.content !== "string") {
			throw new Error(`hook "${hookId}" returned an invalid context addition at index ${index}`);
		}
		const content = redactCredentialText(entry.content.trim());
		if (!content) throw new Error(`hook "${hookId}" returned an empty context addition at index ${index}`);
		if (Buffer.byteLength(content) > ICE_HOOK_CONTEXT_ADDITION_LIMITS.maxItemBytes) {
			throw new Error(`hook "${hookId}" returned an oversized context addition at index ${index}`);
		}
		return Object.freeze({ content });
	});
	return Object.freeze(additions);
}

export interface IceHookDispatcherOptions {
	handlers?: Readonly<Record<string, IceHookHandler>>;
	/** Approval callback for `ask` outcomes; must fail closed when absent. */
	requestApproval?: (record: {
		hookId: string;
		event: IceSubagentHookEvent;
		runId: string;
		ownerSessionId: string;
		reason: string;
		signal?: AbortSignal;
	}) => boolean | Promise<boolean>;
	now?: () => number;
	/** Observational hook records only; never an authorization channel. */
	onObservation?: (record: IceHookDispatchRecord) => void;
	/**
	 * Authoritative intent sink invoked and awaited immediately before a
	 * handler is entered. Rejection/throw blocks the gated action for a
	 * required hook and skips an optional hook with a bounded diagnostic.
	 */
	onIntent?: (record: IceHookDispatchRecord) => void | Promise<void>;
	/** Bounded record sink used by the parent-owned persistence/projection adapter. */
	onRecord?: (record: IceHookDispatchRecord) => void;
}

export interface IceHookDispatchResult {
	decision: IceHookOutcome;
	records: readonly IceHookDispatchRecord[];
	diagnostics: readonly string[];
	/** Bounded context additions emitted by an allowed beforeLaunch decision hook. */
	contextAdditions: readonly IceHookContextAddition[];
}

const MAX_HOOK_PAYLOAD_BYTES = 16 * 1024;

function boundedHookValue(value: unknown, key: string | undefined, depth: number, seen: WeakSet<object>): unknown {
	if (depth > 4) return "[TRUNCATED]";
	if (key && /(?:api[_-]?key|token|secret|password|authorization|cookie)/i.test(key)) return "[REDACTED]";
	if (typeof value === "string") {
		const redacted = redactCredentialText(value);
		const bytes = Buffer.from(redacted);
		if (bytes.byteLength <= 4 * 1024) return redacted;
		return `${bytes.subarray(0, 4 * 1024).toString("utf8")}…`;
	}
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value !== "object") return String(value).slice(0, 256);
	if (seen.has(value)) return "[REDACTED]";
	seen.add(value);
	try {
		if (Array.isArray(value))
			return value.slice(0, 32).map((entry) => boundedHookValue(entry, undefined, depth + 1, seen));
		const result: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(value).slice(0, 32)) {
			result[entryKey] = boundedHookValue(entryValue, entryKey, depth + 1, seen);
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

function freezeHookValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		for (const entry of value) freezeHookValue(entry);
		return Object.freeze(value);
	}
	if (typeof value === "object" && value !== null) {
		for (const entry of Object.values(value)) freezeHookValue(entry);
		return Object.freeze(value);
	}
	return value;
}

function boundedHookPayload(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const bounded = boundedHookValue(payload, undefined, 0, new WeakSet<object>());
	if (!isRecord(bounded)) return Object.freeze({ payloadTruncated: true });
	try {
		if (Buffer.byteLength(JSON.stringify(bounded)) <= MAX_HOOK_PAYLOAD_BYTES) {
			return freezeHookValue(bounded) as Readonly<Record<string, unknown>>;
		}
	} catch {
		// Fall through to the digest-only projection.
	}
	return Object.freeze({
		payloadTruncated: true,
		payloadDigest: createHash("sha256").update(JSON.stringify(bounded)).digest("hex").slice(0, 16),
	});
}

function hookPayloadFingerprint(payload: Readonly<Record<string, unknown>>): string {
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

function boundedReason(reason: string | undefined, maxBytes: number): string | undefined {
	if (reason === undefined) return undefined;
	const redacted = redactCredentialText(reason);
	const bytes = Buffer.byteLength(redacted);
	if (bytes <= maxBytes) return redacted;
	let end = maxBytes;
	const buffer = Buffer.from(redacted);
	while (end > 0 && buffer.subarray(0, end).toString("utf8").endsWith("�")) end -= 1;
	return `${buffer.subarray(0, end).toString("utf8")}…`;
}

/**
 * Awaited parent-owned dispatcher. Decision hooks return continue/deny/ask;
 * observational hooks never change recorded execution facts. Deny is sticky per
 * dispatch; ask requires an approval-capable owner client and fails closed
 * headless. Required-hook timeout/malformed output/crash blocks the gated
 * action; optional observer failure is recorded as a diagnostic only.
 */
export class IceSubagentHookDispatcher {
	private readonly handlers: Readonly<Record<string, IceHookHandler>>;
	private readonly requestApproval: IceHookDispatcherOptions["requestApproval"];
	private readonly now: () => number;
	private readonly onObservation: ((record: IceHookDispatchRecord) => void) | undefined;
	private readonly onIntent: ((record: IceHookDispatchRecord) => void | Promise<void>) | undefined;
	private readonly onRecord: ((record: IceHookDispatchRecord) => void) | undefined;

	constructor(options: IceHookDispatcherOptions = {}) {
		this.handlers = options.handlers ?? {};
		this.requestApproval = options.requestApproval;
		this.now = options.now ?? Date.now;
		this.onObservation = options.onObservation;
		this.onIntent = options.onIntent;
		this.onRecord = options.onRecord;
	}

	private isDecision(event: IceSubagentHookEvent): boolean {
		return (ICE_SUBAGENT_DECISION_EVENTS as readonly string[]).includes(event);
	}

	async dispatch(options: {
		hooks: readonly IceResolvedHook[];
		event: IceSubagentHookEvent;
		ownerSessionId: string;
		runId: string;
		attempt?: 1 | 2;
		role?: string;
		payload?: Record<string, unknown>;
		signal?: AbortSignal;
	}): Promise<IceHookDispatchResult> {
		const diagnostics: string[] = [];
		const records: IceHookDispatchRecord[] = [];
		const eligible = options.hooks.filter((hook) => {
			if (hook.event !== options.event) return false;
			if (
				hook.roles &&
				options.role &&
				!hook.roles.map(normalizeIceRoleName).includes(normalizeIceRoleName(options.role))
			) {
				return false;
			}
			return true;
		});
		let decision: IceHookOutcome = "continue";
		let denied = false;
		const contextAdditions: IceHookContextAddition[] = [];
		const payload = boundedHookPayload(options.payload ?? {});
		const fingerprint = hookPayloadFingerprint(payload);
		const appendRecord = (record: Omit<IceHookDispatchRecord, "ownerSessionId" | "runId" | "attempt">): void => {
			const frozen = Object.freeze({
				...record,
				ownerSessionId: options.ownerSessionId,
				runId: options.runId,
				...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
			});
			records.push(frozen);
			try {
				this.onRecord?.(frozen);
			} catch {
				// Record consumers are non-authoritative.
			}
			if (!this.isDecision(options.event)) {
				try {
					this.onObservation?.(frozen);
				} catch {
					// Observation consumers are non-authoritative.
				}
			}
		};
		for (const hook of eligible) {
			const eventId = randomUUID();
			if (denied) {
				appendRecord({
					eventId,
					hookId: hook.id,
					event: options.event,
					outcome: "deny",
					required: hook.required,
					reason: "sticky deny from an earlier hook",
					durationMs: 0,
					observational: !this.isDecision(options.event),
				});
				continue;
			}
			const started = this.now();
			const frozenPayload = Object.freeze({ ...payload, payloadFingerprint: fingerprint });
			const hookController = new AbortController();
			const removeParentAbort = options.signal
				? (() => {
						const abort = () => hookController.abort();
						if (options.signal!.aborted) abort();
						else options.signal!.addEventListener("abort", abort, { once: true });
						return () => options.signal!.removeEventListener("abort", abort);
					})()
				: undefined;
			try {
				if (options.signal?.aborted) throw new Error("hook dispatch cancelled");
				const handler = this.handlers[hook.id];
				if (!handler) {
					if (hook.required) {
						throw new Error(
							hook.kind === "command"
								? `required command hook "${hook.id}" is disabled; command hooks require an explicit executable policy`
								: `required hook "${hook.id}" has no registered parent handler`,
						);
					}
					diagnostics.push(
						`optional hook "${hook.id}" has no available handler; skipped without changing execution facts`,
					);
					appendRecord({
						eventId,
						hookId: hook.id,
						event: options.event,
						outcome: "continue",
						required: hook.required,
						reason: "no handler; optional observation unavailable",
						durationMs: this.now() - started,
						observational: !this.isDecision(options.event),
					});
					continue;
				}
				const intentRecord = Object.freeze({
					eventId,
					ownerSessionId: options.ownerSessionId,
					runId: options.runId,
					...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
					hookId: hook.id,
					event: options.event,
					outcome: "continue" as const,
					required: hook.required,
					durationMs: 0,
					observational: !this.isDecision(options.event),
				});
				const timeoutMs = Math.min(hook.timeoutMs, ICE_SUBAGENT_SETTINGS_LIMITS.maxHookTimeoutMs);
				try {
					await withHookTimeout(
						Promise.resolve().then(() => {
							if (hookController.signal.aborted) throw new Error("hook dispatch cancelled");
							return this.onIntent?.(intentRecord);
						}),
						timeoutMs,
						options.signal,
						() => hookController.abort(),
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const diagnostic = `hook "${hook.id}" intent was not durably recorded; handler was not invoked: ${redactCredentialText(message).slice(0, 256)}`;
					if (hook.required) throw new Error(diagnostic);
					diagnostics.push(diagnostic);
					appendRecord({
						eventId,
						hookId: hook.id,
						event: options.event,
						outcome: "continue",
						required: hook.required,
						reason: boundedReason(message, 1024),
						durationMs: this.now() - started,
						observational: !this.isDecision(options.event),
					});
					continue;
				}
				if (hookController.signal.aborted) throw new Error("hook dispatch cancelled");
				const remainingHandlerMs = timeoutMs - (this.now() - started);
				if (remainingHandlerMs <= 0) throw new Error(`hook "${hook.id}" exceeded its intent deadline`);
				const outcome = await withHookTimeout(
					Promise.resolve().then(() => {
						if (hookController.signal.aborted) throw new Error("hook dispatch cancelled");
						return handler({
							hook,
							event: options.event,
							ownerSessionId: options.ownerSessionId,
							runId: options.runId,
							attempt: options.attempt,
							role: options.role,
							payload: frozenPayload,
							signal: hookController.signal,
						});
					}),
					remainingHandlerMs,
					options.signal,
					() => hookController.abort(),
				);
				if (outcome.outcome !== "continue" && outcome.outcome !== "deny" && outcome.outcome !== "ask") {
					throw new Error(`hook "${hook.id}" returned malformed outcome`);
				}
				if (!this.isDecision(options.event) && outcome.outcome !== "continue") {
					throw new Error(`observational hook "${hook.id}" must not return a decision`);
				}
				const additions = normalizeHookContextAdditions(outcome.contextAdditions, hook.id);
				if (additions.length > 0 && options.event !== "subagent.beforeLaunch") {
					throw new Error(`hook "${hook.id}" may add context only during subagent.beforeLaunch`);
				}
				const reason = boundedReason(outcome.reason, 1024);
				if (outcome.outcome === "deny") {
					denied = true;
					decision = "deny";
				} else if (outcome.outcome === "ask" && !denied) {
					const elapsedMs = Math.max(0, this.now() - started);
					const remainingMs = timeoutMs - elapsedMs;
					if (remainingMs <= 0) throw new Error(`hook "${hook.id}" exceeded its approval deadline`);
					const approved = this.requestApproval
						? await withHookTimeout(
								Promise.resolve().then(() =>
									this.requestApproval!({
										hookId: hook.id,
										event: options.event,
										runId: options.runId,
										ownerSessionId: options.ownerSessionId,
										reason: reason ?? `hook "${hook.id}" requested approval`,
										signal: hookController.signal,
									}),
								),
								remainingMs,
								options.signal,
								() => hookController.abort(),
							)
						: false;
					if (!approved) {
						denied = true;
						decision = "deny";
						diagnostics.push(`hook "${hook.id}" ask was not approved; failing closed`);
					}
				}
				if (additions.length > 0 && !denied) contextAdditions.push(...additions);
				appendRecord({
					eventId,
					hookId: hook.id,
					event: options.event,
					outcome: outcome.outcome === "ask" && decision === "deny" ? "deny" : outcome.outcome,
					required: hook.required,
					...(reason ? { reason } : {}),
					durationMs: this.now() - started,
					observational: !this.isDecision(options.event),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (this.isDecision(options.event) && hook.required) {
					appendRecord({
						eventId,
						hookId: hook.id,
						event: options.event,
						outcome: "deny",
						required: hook.required,
						reason: boundedReason(message, 1024),
						durationMs: this.now() - started,
						observational: false,
					});
					denied = true;
					decision = "deny";
					diagnostics.push(
						`required hook "${hook.id}" failed closed: ${redactCredentialText(message).slice(0, 256)}`,
					);
				} else {
					diagnostics.push(
						`optional hook "${hook.id}" failed without changing execution facts: ${redactCredentialText(message).slice(0, 256)}`,
					);
					appendRecord({
						eventId,
						hookId: hook.id,
						event: options.event,
						outcome: "continue",
						required: hook.required,
						reason: boundedReason(message, 1024),
						durationMs: this.now() - started,
						observational: !this.isDecision(options.event),
					});
				}
			} finally {
				removeParentAbort?.();
			}
		}
		return {
			decision,
			records: Object.freeze(records),
			diagnostics: frozenDiagnostics(diagnostics),
			contextAdditions: Object.freeze(contextAdditions),
		};
	}
}

function withHookTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal,
	onTimeout?: () => void,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let removeAbortListener: (() => void) | undefined;
	return new Promise<T>((resolve, reject) => {
		const finish = (callback: () => void): void => {
			if (timer) clearTimeout(timer);
			removeAbortListener?.();
			callback();
		};
		const abortListener = (): void => finish(() => reject(new Error("hook dispatch cancelled")));
		if (signal) {
			if (signal.aborted) {
				abortListener();
				return;
			}
			signal.addEventListener("abort", abortListener, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", abortListener);
		}
		timer = setTimeout(
			() =>
				finish(() => {
					onTimeout?.();
					reject(new Error(`hook exceeded ${timeoutMs} ms deadline`));
				}),
			timeoutMs,
		);
		promise.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
	});
}

/** Bounded redacted projection for observatory/RPC views (W36). Never includes raw payloads. */
export function projectIceHookRecords(records: readonly IceHookDispatchRecord[]): ReadonlyArray<{
	eventId: string;
	ownerSessionId: string;
	runId: string;
	attempt?: 1 | 2;
	hookId: string;
	event: IceSubagentHookEvent;
	outcome: IceHookOutcome;
	required: boolean;
	durationMs: number;
	observational: boolean;
	reason?: string;
}> {
	return Object.freeze(
		records.map((record) =>
			Object.freeze({
				eventId: record.eventId,
				ownerSessionId: record.ownerSessionId,
				runId: record.runId,
				...(record.attempt !== undefined ? { attempt: record.attempt } : {}),
				hookId: record.hookId,
				event: record.event,
				outcome: record.outcome,
				required: record.required,
				durationMs: record.durationMs,
				observational: record.observational,
				...(record.reason ? { reason: redactCredentialText(record.reason).slice(0, 512) } : {}),
			}),
		),
	);
}
