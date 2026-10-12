/**
 * The `ice` settings namespace: parent-owned subagent lifecycle hooks
 * (`ice.hooks`, W25-W37) and strict validation of the whole namespace.
 * `ice.subagents` is owned by subagents/v2/settings.ts; this module only
 * delegates its validation there so one schema governs it.
 *
 * Design authority: agent_docs/implementation/subagent-control-settings-hooks-plan.md
 * section 7 (lifecycle hooks). This module owns parsing/resolution only; file
 * persistence stays in SettingsManager. Ice remains the sole authoritative
 * reasoning/tool loop: hooks observe or gate launches through parent-owned
 * handlers, never through a second agent loop, provider SDK, or child extension loading.
 */

import { createHash, randomUUID } from "node:crypto";
import { redactCredentialText } from "../utils/redact.ts";
import { type IceCommandHookPolicy, parseIceCommandHookPolicy } from "./hooks/command-hooks.ts";
import { resolveSubagentsV2Settings } from "./v2/settings.ts";

// ---------------------------------------------------------------------------
// Configuration schema
// ---------------------------------------------------------------------------

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
	subagents?: unknown;
	hooks?: IceHooksSettingsInput;
}

export const ICE_SUBAGENT_SETTINGS_LIMITS = {
	maxRoleNameBytes: 64,
	maxHooks: 32,
	maxHookIdBytes: 128,
	maxHookTimeoutMs: 30_000,
	maxHookOutputBytes: 32 * 1024,
} as const;

const KNOWN_HOOK_KEYS = new Set(["id", "event", "roles", "kind", "timeoutMs", "maxOutputBytes", "required"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): Error {
	return new Error(`Invalid ice settings at ${path}: ${message}`);
}

function checkPositiveInteger(value: unknown, path: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw fail(path, `expected integer in [${minimum}, ${maximum}]`);
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

/**
 * Strictly validate one scope's `ice` namespace. Throws on any invalid or
 * unknown key so security-sensitive settings never load partially.
 * Deprecated legacy `ice.subagents` keys are accepted (and reported elsewhere).
 */
export function parseIceSettings(input: unknown): { hooks: ParsedIceHooksSettings } {
	if (input === undefined || input === null) return { hooks: parseIceHooksSettings(undefined) };
	if (!isRecord(input)) throw fail("ice", "expected object");
	for (const key of Object.keys(input)) {
		if (key !== "subagents" && key !== "hooks") throw fail(`ice.${key}`, `unknown key "${key}"`);
	}
	const subagents = resolveSubagentsV2Settings({ global: input.subagents, projectTrusted: false });
	if (subagents.diagnostics.length > 0) throw fail("ice.subagents", subagents.diagnostics.join("; "));
	return { hooks: parseIceHooksSettings(input.hooks) };
}

/** Read the raw `ice` namespace from merged or scoped settings. Unknown keys are preserved for strict parsing. */
export function readIceSettingsInput(settings: { ice?: unknown }): IceSettingsInput | undefined {
	const namespace = settings?.ice;
	if (namespace === undefined || namespace === null) return undefined;
	if (!isRecord(namespace)) throw fail("ice", "expected object");
	return namespace as IceSettingsInput;
}

function frozenDiagnostics(values: string[]): readonly string[] {
	return Object.freeze(values.map((value) => redactCredentialText(value).slice(0, 512)));
}

/** Normalize a role name. Alias indirection was removed with the bundled catalog. */
export function normalizeIceRoleName(role: string): string {
	return role.trim().toLowerCase();
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
