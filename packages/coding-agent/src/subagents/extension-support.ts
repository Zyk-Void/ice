import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import type { IceAgentViewBridge } from "../ice-agent-view-bridge.ts";
import type { IceCapabilityState, IceMode } from "../ice-safe-verify.ts";
import { createIceCommandHookHandler } from "./hooks/command-hooks.ts";
import { SubagentError } from "./runtime/helpers.ts";
import type { PendingSubagentHookObservation, SubagentHookRuntime } from "./runtime/live-session.ts";
import {
	getIceSubagentHookHandlers,
	ICE_HOOK_JOURNAL_ENTRY_TYPE,
	type IceHookDispatcherOptions,
	type IceHookDispatchRecord,
	type IceHookHandler,
	type IceHookJournalEntry,
	IceSubagentHookDispatcher,
	parseIceSettings,
	projectIceHookRecords,
	resolveIceSubagentHooks,
} from "./settings.ts";
import type { IceSubagentMcpAdapter } from "./types.ts";

export interface IceSubagentsOptions {
	/** Internal trusted parent registration owner; the facade supplies ice.events. */
	parentHookOwner?: object;
	/** Optional trusted profile/settings root override used by embedded hosts and hermetic tests. */
	agentDir?: string;
	getIceMode?: () => IceMode | undefined;
	getIceCapabilityState?: () => IceCapabilityState | undefined;
	agentViewBridge?: IceAgentViewBridge;
	/** Trusted in-process policy handlers keyed by the configured hook ID. */
	hookHandlers?: Readonly<Record<string, IceHookHandler>>;
	/** Optional approval bridge for configured `ask` decisions; absent means deny. */
	requestHookApproval?: IceHookDispatcherOptions["requestApproval"];
	/** Bounded observation sink; it must never be used as an authorization channel. */
	onHookObservation?: IceHookDispatcherOptions["onObservation"];
	/** Optional parent-owned MCP adapter; absent adapters fail selected MCP launches closed. */
	mcpAdapter?: IceSubagentMcpAdapter;
	/** Host-supplied agent definitions (SDK); the `--agents` flag takes precedence when set. */
	agents?: Record<string, unknown>;
}

export function flagEnabled(ice: ExtensionAPI, name: string): boolean {
	const value = typeof ice.getFlag === "function" ? ice.getFlag(name) : undefined;
	return value === true || value === "true";
}

export interface UnsafeSubagentAuthorization {
	readonly parentActiveTools: readonly string[];
	readonly allowExternal: boolean;
}

export function authorizeUnsafeSubagentHostExecution(
	ctx: ExtensionContext,
	options: IceSubagentsOptions,
	startupSubYolo: boolean,
): UnsafeSubagentAuthorization | undefined {
	if (!startupSubYolo) return undefined;
	const capabilityState = options.getIceCapabilityState?.();
	if (!capabilityState) {
		throw new SubagentError(
			"capability_denied",
			"Unsafe subagent host execution requires authoritative ICE capability state.",
		);
	}
	if (capabilityState.mode !== "build") {
		throw new SubagentError(
			"capability_denied",
			"Unsafe subagent host execution requires explicit --ice-mode build.",
		);
	}
	if (!ctx.isProjectTrusted()) {
		throw new SubagentError("capability_denied", "Unsafe subagent host execution requires a trusted project.");
	}
	if (!capabilityState.bashEnabledInRecordedProcess || !capabilityState.tools.includes("bash")) {
		throw new SubagentError(
			"capability_denied",
			"Unsafe subagent host execution requires the startup-authorized parent Bash capability.",
		);
	}
	if ((ctx.mode !== "tui" && ctx.mode !== "rpc") || !ctx.hasUI) {
		throw new SubagentError(
			"capability_denied",
			"Unsafe subagent host execution requires an interactive TUI or an explicitly authorized RPC session.",
		);
	}
	// Capability state is the authoritative parent upper bound. YOLO changes the
	// policy gate; it must not manufacture tools the parent did not activate.
	return {
		parentActiveTools: Object.freeze([...capabilityState.tools]),
		allowExternal: capabilityState.allowExternal,
	};
}

export function normalizeSubagentHookIds(value: unknown): readonly string[] {
	if (
		!Array.isArray(value) ||
		value.length > 32 ||
		value.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
	) {
		throw new SubagentError("malformed_result", "Hook selections must contain at most 32 bounded hook IDs.");
	}
	return Object.freeze([...new Set(value as string[])]);
}

/**
 * Persist the bounded redacted hook record. Intent entries are the durable boundary crossed
 * before any hook handler runs: a throw blocks required hooks and skips optional hooks, so a
 * crash can leave an unresolved intent but never an unknown effect. Outcome entries stay
 * best-effort; their absence also leaves the intent unresolved on restart without replay.
 */
export function appendSubagentHookJournal(ice: Pick<ExtensionAPI, "appendEntry">, entry: IceHookJournalEntry): void {
	const record = projectIceHookRecords([entry.record])[0];
	if (!record) return;
	ice.appendEntry(
		ICE_HOOK_JOURNAL_ENTRY_TYPE,
		{ schemaVersion: entry.schemaVersion, phase: entry.phase, record },
		{ durable: entry.phase === "intent" },
	);
}

/** The request-independent identity a hook runtime is resolved for. */
export interface SubagentHookTarget {
	projectTrusted: boolean;
	role: string;
	roleHookIds?: readonly string[];
	callHookIds?: readonly string[];
	cwd: string;
	/** Read-only children never run command hooks. */
	readOnly: boolean;
	ownerSessionId: string;
	runId: string;
}

/** Resolve configured hooks for one child and bind them to parent-owned handlers. Undefined when none apply. */
export function buildSubagentHookRuntime(
	ctx: ExtensionContext,
	settingsManager: SettingsManager,
	target: SubagentHookTarget,
	options: IceSubagentsOptions,
	attempt?: 1 | 2,
	onJournal?: (entry: IceHookJournalEntry) => void,
): SubagentHookRuntime | undefined {
	const resolvedHooks = resolveIceSubagentHooks({
		globalHooks: { ice: settingsManager.getIceSettingsValue("global") },
		projectHooks: { ice: settingsManager.getIceSettingsValue("project") },
		projectTrusted: target.projectTrusted,
		role: target.role,
		roleHookIds: target.roleHookIds,
		callHookIds: target.callHookIds,
	});
	if (resolvedHooks.length === 0) return undefined;
	const defaultApproval: NonNullable<IceHookDispatcherOptions["requestApproval"]> = async (approval) => {
		try {
			return await ctx.ui.confirm(
				`Approve ICE hook ${approval.hookId}`,
				approval.reason || "The configured subagent hook requested approval.",
			);
		} catch {
			return false;
		}
	};
	const requestApproval =
		options.requestHookApproval ??
		(ctx.hasUI && ctx.mode !== "print" && ctx.mode !== "json" ? defaultApproval : undefined);
	const records: IceHookDispatchRecord[] = [];
	const pendingObservations = new Set<PendingSubagentHookObservation>();
	const globalPolicy = parseIceSettings(settingsManager.getIceSettingsValue("global")).hooks.commandPolicy;
	const projectPolicy = parseIceSettings(settingsManager.getIceSettingsValue("project")).hooks.commandPolicy;
	if (target.projectTrusted && projectPolicy?.enabled) {
		throw new SubagentError(
			"capability_denied",
			"Projects cannot authorize command hooks; configure host-owned global policy.",
		);
	}
	const registered = options.parentHookOwner ? getIceSubagentHookHandlers(options.parentHookOwner) : {};
	const handlers: Record<string, IceHookHandler> = {};
	for (const [id, handler] of Object.entries({ ...registered, ...options.hookHandlers })) {
		handlers[id] = async (...args: Parameters<IceHookHandler>) => {
			if (options.hookHandlers?.[id] !== handler && registered[id] !== handler)
				throw new SubagentError("capability_denied", `Parent hook ${id} was unregistered or replaced.`);
			return handler(...args);
		};
	}
	for (const hook of resolvedHooks) {
		if (hook.kind !== "command") continue;
		delete handlers[hook.id];
		if (!globalPolicy?.enabled) continue;
		handlers[hook.id] = createIceCommandHookHandler({
			policy: globalPolicy,
			workspace: target.cwd,
			isAuthorized: () => {
				const capabilities = options.getIceCapabilityState?.();
				const current = parseIceSettings(settingsManager.getIceSettingsValue("global")).hooks.commandPolicy;
				return (
					!target.readOnly &&
					ctx.isProjectTrusted() &&
					settingsManager.isProjectTrusted() &&
					capabilities?.mode === "build" &&
					capabilities.bashEnabledInRecordedProcess === true &&
					capabilities.tools.includes("bash") &&
					JSON.stringify(current) === JSON.stringify(globalPolicy)
				);
			},
			approve:
				ctx.hasUI && ctx.mode !== "print" && ctx.mode !== "json"
					? (id) =>
							ctx.ui.confirm(
								`Execute command hook ${id}?`,
								"This executes the exact host-approved command without a sandbox. Host filesystem, network, and account authority remain accessible.",
							)
					: undefined,
		});
	}
	return {
		dispatcher: new IceSubagentHookDispatcher({
			handlers,
			onIntent: (record) => {
				// Intent persistence is authoritative: the dispatcher awaits
				// this callback and never invokes the hook handler when it
				// throws/rejects. Outcome persistence remains best-effort.
				onJournal?.({ schemaVersion: 1, phase: "intent", record });
			},
			requestApproval,
			onObservation: options.onHookObservation,
			onRecord: (record) => {
				if (records.length < 64) records.push(record);
				try {
					onJournal?.({ schemaVersion: 1, phase: "outcome", record });
				} catch {
					// Outcome journaling stays best-effort: the intent record
					// remains unresolved on restart and is never replayed.
				}
			},
		}),
		hooks: resolvedHooks,
		records,
		pendingObservations,
		ownerSessionId: target.ownerSessionId,
		runId: target.runId,
		role: target.role,
		attempt,
	};
}
