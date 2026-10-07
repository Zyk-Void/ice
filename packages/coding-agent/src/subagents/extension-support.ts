/** Extension wiring helpers: MCP admission, sub-yolo authorization, settings submenu, model and hook runtime (moved from ice-subagents.ts). */
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { Container, getKeybindings, Spacer, Text } from "@zykairotis/ice-tui";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import type { IceAgentViewBridge } from "../ice-agent-view-bridge.ts";
import type { IceCapabilityState, IceMode } from "../ice-safe-verify.ts";
import { redactCredentialText } from "../utils/redact.ts";
import { hashSource, resolveSubagentMcpRuntime, revalidateSubagentProfile } from "./definitions/legacy-profiles.ts";
import { createIceCommandHookHandler } from "./hooks/command-hooks.ts";
import {
	type ResolvedSubagentConcurrencyPolicy,
	resolveSubagentConcurrencyPolicy,
	SUBAGENT_CONCURRENCY_LIMITS,
} from "./registry/admission.ts";
import { modelReference } from "./runtime/batch.ts";
import { SUBAGENT_CHECKIN_INTERVAL_MS } from "./runtime/checkin.ts";
import { requireParentModel, SubagentError } from "./runtime/helpers.ts";
import {
	type PendingSubagentHookObservation,
	resolveSubagentThinkingLevel,
	type SubagentHookRuntime,
} from "./runtime/live-session.ts";
import { truncateSubagentOutput } from "./runtime/prompt.ts";
import { revalidateSubagentResources } from "./runtime/resources.ts";
import { resolveIceSubagentCandidates, resolveIceSubagentRoute, snapshotIceSubagentRoute } from "./runtime/routing.ts";
import {
	getIceSubagentHookHandlers,
	ICE_SUBAGENT_SETTINGS_LIMITS,
	type IceHookDispatcherOptions,
	type IceHookDispatchRecord,
	type IceHookHandler,
	type IceHookJournalEntry,
	type IceResolvedHook,
	IceSubagentHookDispatcher,
	parseIceSettings,
	resolveIceSubagentContract,
	resolveIceSubagentHooks,
} from "./settings.ts";
import { normalizeIceToolSchema } from "./tools/adapters.ts";
import {
	type IceSubagentMcpAdapter,
	type IceSubagentMcpToolAuthorization,
	type NormalizedSubagentRequest,
	SUBAGENT_DETACH_RETENTION_MS,
	SUBAGENT_MANAGEMENT_WAIT_DEFAULT_MS,
	SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS,
	type SubagentForkContextSource,
	type SubagentProfileSummary,
	subagentMcpToolName,
} from "./types.ts";

export function memoizeSubagentForkContextSource(source: SubagentForkContextSource): SubagentForkContextSource {
	const sourceSessionId = source.getSessionId();
	const sourceLeafId = source.getLeafId();
	let resolvedContext: { messages: readonly AgentMessage[] } | undefined;
	return {
		getSessionId: () => sourceSessionId,
		getLeafId: () => sourceLeafId,
		buildSessionContext: () => {
			if (!resolvedContext) resolvedContext = source.buildSessionContext();
			return resolvedContext;
		},
	};
}

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
}

export function validateSubagentMcpAdmission(
	request: NormalizedSubagentRequest,
	adapter: IceSubagentMcpAdapter | undefined,
	unsafeHostExec: boolean,
): void {
	const selected = request.selectedMcpTools ?? [];
	resolveSubagentMcpRuntime({ adapter }, selected, unsafeHostExec && !request.readOnlyReview);
	if (selected.length === 0) return;
	if (!adapter)
		throw new SubagentError("capability_denied", "Selected MCP tools require a registered parent adapter.");
	const entries = adapter.listAuthorizedTools();
	const captured = selected.map((selector) => {
		const entry = entries.find((item) => item.selector === selector)!;
		if (!entry.parameters)
			throw new SubagentError(
				"capability_denied",
				`MCP adapter ${selector} does not expose its installed parameter schema.`,
			);
		if (
			request.deniedTools.includes(selector.toLowerCase()) ||
			request.deniedTools.includes(subagentMcpToolName(selector).toLowerCase())
		)
			throw new SubagentError("capability_denied", `MCP tool ${selector} is denied by policy.`);
		return Object.freeze({
			selector,
			access: entry.access,
			parameters: normalizeIceToolSchema(entry.parameters),
			description: redactCredentialText(entry.description ?? `MCP ${selector}`).slice(0, 4096),
		});
	});
	const fingerprint = (items: readonly IceSubagentMcpToolAuthorization[]): string => hashSource(JSON.stringify(items));
	const capturedHash = fingerprint(captured);
	const capturedIdentity = adapter.getIdentity?.() ?? adapter;
	request.mcpAuthorizations = Object.freeze(captured);
	request.mcpAuthorityStillValid = () => {
		try {
			if ((adapter.getIdentity?.() ?? adapter) !== capturedIdentity) return false;
			const now = adapter.listAuthorizedTools();
			return (
				fingerprint(
					selected.map((selector) => {
						const entry = now.find((item) => item.selector === selector);
						if (!entry?.parameters) throw new Error("revoked");
						return {
							selector,
							access: entry.access,
							parameters: normalizeIceToolSchema(entry.parameters),
							description: redactCredentialText(entry.description ?? `MCP ${selector}`).slice(0, 4096),
						};
					}),
				) === capturedHash
			);
		} catch {
			return false;
		}
	};
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

export function getParentSettingsManager(ctx: ExtensionContext): SettingsManager {
	const projectTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
	return (
		ctx.settingsManager ??
		SettingsManager.create(typeof ctx.cwd === "string" ? ctx.cwd : process.cwd(), getAgentDir(), {
			projectTrusted,
		})
	);
}

export function resolveSubagentConcurrencyPolicyFromSettings(
	settingsManager: SettingsManager,
): ResolvedSubagentConcurrencyPolicy {
	try {
		const global = parseIceSettings(settingsManager.getGlobalSettings().ice);
		const project = parseIceSettings(settingsManager.getProjectSettings().ice);
		return resolveSubagentConcurrencyPolicy({
			global: global.subagents,
			project: project.subagents,
			projectTrusted: settingsManager.isProjectTrusted(),
		});
	} catch {
		return resolveSubagentConcurrencyPolicy({});
	}
}

export function formatIceSubagentSettingsSummary(settingsManager: SettingsManager, projectTrusted: boolean): string {
	const lines = ["ICE subagent policy", ""];
	try {
		const global = parseIceSettings(settingsManager.getGlobalSettings().ice);
		const project = parseIceSettings(settingsManager.getProjectSettings().ice);
		const effectiveProjectTrusted = projectTrusted && settingsManager.isProjectTrusted();
		const contractRoles = [
			...Object.keys(global.subagents.roleDefaults),
			...Object.keys(project.subagents.roleDefaults),
		].filter((role, index, roles) => roles.indexOf(role) === index);
		lines.push(`global subagents: ${global.subagents.enabled ? "enabled" : "disabled"}`);
		lines.push(
			`project subagents: ${effectiveProjectTrusted ? (project.subagents.enabled ? "enabled" : "disabled") : "untrusted/ignored"}`,
		);
		lines.push(`project trust: ${effectiveProjectTrusted ? "trusted" : "not trusted"}`);
		lines.push(
			`hooks: ${global.hooks.enabled ? "enabled" : "disabled"} · ${global.hooks.definitions.length} global declarations; command execution policy ${global.hooks.commandPolicy?.enabled ? "enabled (trust/build/Bash/approval gates still apply)" : "disabled"}`,
		);
		lines.push(
			`routing: ${global.subagents.modelSelection.mode === "configured" ? "configured candidates enabled" : "inherit-parent only"} · global-first ice policy`,
		);
		const concurrencyPolicy = resolveSubagentConcurrencyPolicy({
			global: global.subagents,
			project: project.subagents,
			projectTrusted: effectiveProjectTrusted,
		});
		lines.push(
			`concurrency: default=${concurrencyPolicy.defaultConcurrency} [${concurrencyPolicy.sources.default}] · cap=${concurrencyPolicy.maxConcurrency} [${concurrencyPolicy.sources.max}] · shared batch/job admission (limits ${SUBAGENT_CONCURRENCY_LIMITS.min}-${SUBAGENT_CONCURRENCY_LIMITS.hardCap})${concurrencyPolicy.diagnostics.length > 0 ? ` · ${concurrencyPolicy.diagnostics.join("; ")}` : ""}`,
		);
		lines.push(
			`startup bound: maximum ${ICE_SUBAGENT_SETTINGS_LIMITS.maxStartupTimeoutMs} ms to create/admit a child · management wait default ${SUBAGENT_MANAGEMENT_WAIT_DEFAULT_MS} ms (max ${SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS} ms) · detach retention ${SUBAGENT_DETACH_RETENTION_MS} ms; none of these is a child lifetime timeout`,
		);
		lines.push(
			`check-ins: default ${global.subagents.defaults.checkInIntervalMs ?? SUBAGENT_CHECKIN_INTERVAL_MS} ms · minimum ${ICE_SUBAGENT_SETTINGS_LIMITS.minCheckInIntervalMs} ms · managed runs have no lifetime deadline`,
		);
		lines.push("");
		for (const role of contractRoles.slice(0, 12)) {
			const contract = resolveIceSubagentContract({
				global: global.subagents,
				project: project.subagents,
				globalFirst: true,
				projectTrusted: effectiveProjectTrusted,
				role,
			});
			const values = [
				`thinking=${contract.values.thinking} [${contract.sources.thinking}]`,
				`startupTimeout=${contract.values.timeoutMs}ms [${contract.sources.timeoutMs}]`,
				`checkIn=${contract.values.checkInIntervalMs}ms [${contract.sources.checkInIntervalMs}]`,
				...(contract.values.temperature !== undefined
					? [`temperature=${contract.values.temperature} [${contract.sources.temperature}]`]
					: []),
				...(contract.values.topP !== undefined ? [`topP=${contract.values.topP} [${contract.sources.topP}]`] : []),
			];
			lines.push(`${role}: ${contract.denied ? `denied (${contract.denied.code})` : values.join(" · ")}`);
		}
		if (contractRoles.length === 0)
			lines.push("role defaults: none configured; file agents and self-delegation remain available");
		if (contractRoles.length > 12)
			lines.push(`… ${contractRoles.length - 12} additional configured role defaults omitted`);
		const loadErrors = settingsManager.getLoadErrors();
		if (loadErrors.length > 0) {
			lines.push("");
			lines.push("settings errors (delegation fails closed):");
			for (const error of loadErrors.slice(0, 8)) lines.push(`- ${error.scope}: ${error.error.message}`);
		}
	} catch (error) {
		lines.push(
			`settings summary unavailable; delegation fails closed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return truncateSubagentOutput(redactCredentialText(lines.join("\n")), 8 * 1024).text;
}

export class IceSubagentSettingsSubmenu extends Container {
	private readonly onCancel: () => void;

	constructor(summary: string, onCancel: () => void) {
		super();
		this.onCancel = onCancel;
		this.addChild(new Text(summary, 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text("Esc to go back", 0, 0));
	}

	handleInput(data: string): void {
		if (getKeybindings().matches(data, "tui.select.cancel")) this.onCancel();
	}
}

export function applyIceProfileSettingsSummary(
	profile: SubagentProfileSummary,
	settingsManager: SettingsManager,
	projectTrusted: boolean,
): SubagentProfileSummary {
	try {
		const globalSettings = parseIceSettings(settingsManager.getGlobalSettings().ice).subagents;
		const projectSettings = parseIceSettings(settingsManager.getProjectSettings().ice).subagents;
		const contract = resolveIceSubagentContract({
			global: globalSettings,
			project: projectSettings,
			globalFirst: true,
			projectTrusted,
			role: profile.name,
			bundledDefaults: {
				thinking: profile.effectiveThinkingLevel,
				checkInIntervalMs: profile.effectiveCheckInIntervalMs ?? SUBAGENT_CHECKIN_INTERVAL_MS,
				startupTimeoutMs: profile.effectiveTimeoutMs,
				temperature: profile.requestedTemperature,
				topP: profile.requestedTopP,
			},
		});
		const diagnostics = [
			...(profile.profileDiagnostics ?? []),
			...contract.diagnostics,
			...(contract.denied ? [contract.denied.message] : []),
		].slice(0, 12);
		return {
			...profile,
			effectiveThinkingLevel: contract.values.thinking,
			effectiveCheckInIntervalMs: contract.values.checkInIntervalMs,
			effectiveTimeoutMs: contract.values.timeoutMs,
			...(contract.values.temperature !== undefined ? { effectiveTemperature: contract.values.temperature } : {}),
			...(contract.values.topP !== undefined ? { effectiveTopP: contract.values.topP } : {}),
			effectiveSettingSources: Object.freeze({ ...contract.sources }),
			profileDiagnostics: Object.freeze(diagnostics),
			...(contract.denied ? { availability: "invalid" as const } : {}),
		};
	} catch (error) {
		return {
			...profile,
			availability: "invalid",
			profileDiagnostics: Object.freeze([
				...(profile.profileDiagnostics ?? []),
				`ICE settings rejected this profile: ${error instanceof Error ? error.message : String(error)}`,
			]),
		};
	}
}

export function isCurrentSubagentAuthorityValid(
	ctx: ExtensionContext,
	settingsManager: SettingsManager,
	normalized: NormalizedSubagentRequest,
	hookRuntime: SubagentHookRuntime | undefined,
): boolean {
	try {
		if (settingsManager.getLoadErrors().length > 0) return false;
		if (normalized.routeSnapshot) resolveRequestedSubagentModel(ctx, settingsManager, normalized);
		const projectTrusted = settingsManager.isProjectTrusted() && ctx.isProjectTrusted();
		if (normalized.projectTrusted && !projectTrusted) return false;
		revalidateSubagentProfile(normalized.profile);
		revalidateSubagentResources(normalized.resources);
		const contract = resolveIceSubagentContract({
			globalSettings: settingsManager.getGlobalSettings(),
			projectSettings: settingsManager.getProjectSettings(),
			globalFirst: true,
			projectTrusted,
			role: normalized.role,
			call: {
				role: normalized.role,
				thinking: normalized.execution.thinking,
				startupTimeoutMs: normalized.timeoutMs,
			},
		});
		if (contract.denied || !contract.enabled || contract.values.timeoutMs < normalized.timeoutMs) return false;
		const acceptedTools = (normalized.execution.tools ?? normalized.profile.requestedTools).filter(
			(tool) => !normalized.deniedTools.includes(tool.toLowerCase()),
		);
		if (acceptedTools.some((tool) => contract.deniedTools.includes(tool.toLowerCase()))) return false;
		if (normalized.delegatedTools?.some((tool) => !tool.isCurrent())) return false;
		if (normalized.mcpAuthorityStillValid?.() === false) return false;
		if (
			normalized.selectedMcpTools?.some(
				(tool) =>
					contract.deniedTools.includes(tool.toLowerCase()) ||
					contract.deniedTools.includes(subagentMcpToolName(tool).toLowerCase()),
			)
		)
			return false;
		const currentHooks = resolveIceSubagentHooks({
			globalHooks: settingsManager.getGlobalSettings(),
			projectHooks: settingsManager.getProjectSettings(),
			projectTrusted,
			role: normalized.role,
			roleHookIds: normalized.profile.hooks,
			callHookIds: normalized.hookIds,
		});
		const hookFingerprint = (hook: IceResolvedHook): string =>
			`${hook.id}:${hook.event}:${hook.kind}:${hook.required}:${hook.timeoutMs}:${hook.maxOutputBytes}`;
		return (hookRuntime?.hooks ?? []).map(hookFingerprint).join("|") === currentHooks.map(hookFingerprint).join("|");
	} catch {
		return false;
	}
}

export function resolveRequestedSubagentModel(
	ctx: ExtensionContext,
	settings: SettingsManager,
	request: NormalizedSubagentRequest,
): Model<Api> {
	const parent = requireParentModel(ctx);
	const global = parseIceSettings(settings.getGlobalSettings().ice).subagents;
	// Candidate order: explicit call model, otherwise file primary, then file
	// fallback, then the captured parent. Duplicates collapse; only retry-safe
	// admission failures advance to the next candidate.
	const primary = request.requestedModel ?? request.profile.requestedModel;
	const fallback = request.fallbackModel ?? request.profile.fallbackModel;
	const hasConfiguredCandidates = primary !== undefined || fallback !== undefined;
	let model: Model<Api>;
	let selection: ReturnType<typeof resolveIceSubagentCandidates> | undefined;
	if (request.routeSnapshot) {
		model = resolveIceSubagentRoute({
			parent,
			requested: primary,
			fallback,
			captured: request.routeSnapshot,
			enabled: global.modelSelection.mode === "configured",
			runtime: ctx.modelRegistry.getRuntime(),
			requirements: request.executionThinkingExplicit ? { thinking: request.execution.thinking } : undefined,
		});
	} else if (hasConfiguredCandidates) {
		if (global.modelSelection.mode !== "configured") {
			throw new SubagentError(
				"capability_denied",
				"Configured child model candidates require global ice.subagents.modelSelection.mode=configured.",
			);
		}
		selection = resolveIceSubagentCandidates({
			parent,
			primary,
			fallback,
			runtime: ctx.modelRegistry.getRuntime(),
			requirements: request.executionThinkingExplicit ? { thinking: request.execution.thinking } : undefined,
		});
		model = selection.model;
	} else {
		model = parent;
	}
	resolveSubagentThinkingLevel(request.execution.thinking, model, { explicit: request.executionThinkingExplicit });
	if (hasConfiguredCandidates && !request.routeSnapshot) {
		request.routeSnapshot = snapshotIceSubagentRoute(model);
		const references = [
			...new Set([primary, fallback].filter((candidate): candidate is string => candidate !== undefined)),
		];
		if (!references.includes(modelReference(parent))) references.push(modelReference(parent));
		request.modelCandidates = Object.freeze(references);
		request.modelCandidateSkips = selection?.skipped.length ? Object.freeze([...selection.skipped]) : undefined;
		if (model !== parent) {
			const failedReference = modelReference(model);
			request.resolveStartupFallback = (retryRequest) => {
				if (parseIceSettings(settings.getGlobalSettings().ice).subagents.modelSelection.mode !== "configured")
					throw new SubagentError("capability_denied", "Child routing was disabled before startup recovery.");
				const next = resolveIceSubagentCandidates({
					parent,
					primary,
					fallback,
					exclude: [failedReference],
					runtime: ctx.modelRegistry.getRuntime(),
					requirements: request.executionThinkingExplicit ? { thinking: request.execution.thinking } : undefined,
				});
				retryRequest.routeSnapshot = snapshotIceSubagentRoute(next.model);
				retryRequest.modelCandidateSkips = next.skipped;
				return next.model;
			};
		}
	}
	return model;
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

export function createSubagentHookRuntime(
	ctx: ExtensionContext,
	settingsManager: SettingsManager,
	normalized: NormalizedSubagentRequest,
	options: IceSubagentsOptions,
	attempt?: 1 | 2,
	onJournal?: (entry: IceHookJournalEntry) => void,
): SubagentHookRuntime | undefined {
	const resolvedHooks = resolveIceSubagentHooks({
		globalHooks: settingsManager.getGlobalSettings(),
		projectHooks: settingsManager.getProjectSettings(),
		projectTrusted: normalized.projectTrusted,
		role: normalized.role,
		roleHookIds: normalized.profile.hooks,
		callHookIds: normalized.hookIds,
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
	const globalPolicy = parseIceSettings(settingsManager.getGlobalSettings().ice).hooks.commandPolicy;
	const projectPolicy = parseIceSettings(settingsManager.getProjectSettings().ice).hooks.commandPolicy;
	if (normalized.projectTrusted && projectPolicy?.enabled) {
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
			workspace: normalized.cwd,
			isAuthorized: () => {
				const capabilities = options.getIceCapabilityState?.();
				const current = parseIceSettings(settingsManager.getGlobalSettings().ice).hooks.commandPolicy;
				return (
					!normalized.readOnlyReview &&
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
		ownerSessionId: normalized.parentSessionId,
		runId: normalized.runId,
		role: normalized.role,
		attempt,
	};
}
