/** Hook dispatch, live child session registry/control, transcripts, and sampling resolution (moved from ice-subagents.ts). */
import { resolve } from "node:path";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@zykairotis/ice-ai";
import type { Api, Model, StreamOptions } from "@zykairotis/ice-ai/compat";
import type { SessionStartEvent } from "../../core/extensions/index.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { CreateAgentSessionResult } from "../../core/sdk.ts";
import type { RetrySettings } from "../../core/settings-manager.ts";
import {
	type IceAgentViewColor,
	type IceAgentViewControlState,
	type IceAgentViewLiveSessionControl,
	type IceAgentViewPresentation,
	type IceAgentViewPresentationPatch,
	isIceAgentViewColor,
	normalizeIceAgentViewPresentation,
} from "../../ice-agent-view-bridge.ts";
import { redactCredentialText } from "../../utils/redact.ts";
import { isRecord } from "../results/report.ts";
import type {
	IceHookContextAddition,
	IceHookDispatchRecord,
	IceResolvedHook,
	IceSubagentHookDispatcher,
	IceSubagentHookEvent,
} from "../settings.ts";
import { canonicalPath } from "../tools/paths.ts";
import type { SubagentExecutionPolicyBox } from "../tools/scoped-tools.ts";
import type {
	IceSubagentMcpAdapter,
	IceSubagentMcpToolAccess,
	NormalizedSubagentRequest,
	ResolvedSubagentProfile,
	SubagentDiagnostic,
	SubagentExecutionContract,
	SubagentThinkingLevel,
} from "../types.ts";
import { SubagentError } from "./helpers.ts";
import { truncateSubagentOutput } from "./prompt.ts";
import type { SubagentCheckInState } from "./view-state.ts";

export interface PendingSubagentHookObservation {
	readonly promise: Promise<void>;
	readonly controller: AbortController;
}

export interface SubagentHookRuntime {
	readonly dispatcher: IceSubagentHookDispatcher;
	readonly hooks: readonly IceResolvedHook[];
	/** Bounded redacted dispatch records retained for the parent result. */
	readonly records: IceHookDispatchRecord[];
	/** In-process observation work is tracked so terminal projections include settled records. */
	readonly pendingObservations?: Set<PendingSubagentHookObservation>;
	readonly ownerSessionId: string;
	readonly runId: string;
	readonly role: string;
	readonly attempt?: 1 | 2;
}

export interface NativeSubagentSessionOptions {
	request: NormalizedSubagentRequest;
	parentActiveTools: readonly string[];
	noLifetimeTimeout?: boolean;
	unsafeHostExec?: boolean;
	model?: Model<Api>;
	modelRuntime?: ModelRuntime;
	agentDir?: string;
	sessionStartEvent?: SessionStartEvent;
	hookRuntime?: SubagentHookRuntime;
	/** Parent-resolved retry policy, copied into the isolated child settings manager. */
	retrySettings?: Pick<RetrySettings, "enabled" | "maxRetries" | "baseDelayMs">;
	/** Parent-owned MCP dispatch for explicitly selected server/tool entries. */
	mcpDispatch?: IceSubagentMcpAdapter["dispatch"];
	/** Parent MCP tool allowlist snapshot; selected child MCP tools must be a subset. */
	parentMcpTools?: readonly string[];
	/** Parent-owned access classification for the allowlist snapshot. */
	mcpToolAccess?: ReadonlyMap<string, IceSubagentMcpToolAccess>;
	beforeTool?: (
		toolName: string,
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
	) => Promise<void>;
	/** Called after each completed Ice turn for authority and timeout-finalization checks. */
	shouldStopAfterTurn?: () => boolean | Promise<boolean>;
	/** Dynamic report-only state while the parent requests a bounded final report. */
	reportOnly?: () => boolean;
	/**
	 * Mutable policy box for a session whose wrappers may outlive one run. Absent for a plain
	 * one-shot child, in which case the flat fields above seed a box that is never re-pointed.
	 */
	policyBox?: SubagentExecutionPolicyBox;
}

export async function dispatchSubagentHookDecision(
	runtime: SubagentHookRuntime | undefined,
	event: Extract<IceSubagentHookEvent, "subagent.beforeLaunch" | "subagent.beforeTool" | "subagent.beforeAccept">,
	payload: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<readonly IceHookContextAddition[]> {
	if (!runtime) return Object.freeze([]);
	const result = await runtime.dispatcher.dispatch({
		hooks: runtime.hooks,
		event,
		ownerSessionId: runtime.ownerSessionId,
		runId: runtime.runId,
		attempt: runtime.attempt,
		role: runtime.role,
		payload,
		signal,
	});
	if (result.decision !== "continue") {
		const detail = result.diagnostics.filter(Boolean).join(" ");
		throw new SubagentError(
			"capability_denied",
			`Subagent ${event} hook denied the action.${detail ? ` ${detail}` : ""}`,
		);
	}
	return result.contextAdditions;
}

export function dispatchSubagentHookObservation(
	runtime: SubagentHookRuntime | undefined,
	event: Exclude<IceSubagentHookEvent, "subagent.beforeLaunch" | "subagent.beforeTool" | "subagent.beforeAccept">,
	payload: Record<string, unknown>,
	parentSignal?: AbortSignal,
): void {
	if (!runtime) return;
	const controller = new AbortController();
	const abort = (): void => controller.abort();
	if (parentSignal) {
		if (parentSignal.aborted) abort();
		else parentSignal.addEventListener("abort", abort, { once: true });
	}
	const pending: PendingSubagentHookObservation = {
		controller,
		promise: runtime.dispatcher
			.dispatch({
				hooks: runtime.hooks,
				event,
				ownerSessionId: runtime.ownerSessionId,
				runId: runtime.runId,
				attempt: runtime.attempt,
				role: runtime.role,
				payload,
				signal: controller.signal,
			})
			.then(
				() => undefined,
				() => undefined,
			),
	};
	runtime.pendingObservations?.add(pending);
	void pending.promise.then(
		() => {
			parentSignal?.removeEventListener("abort", abort);
			runtime.pendingObservations?.delete(pending);
		},
		() => {
			parentSignal?.removeEventListener("abort", abort);
			runtime.pendingObservations?.delete(pending);
		},
	);
}

const SUBAGENT_HOOK_OBSERVATION_FLUSH_MS = 2_000;

export async function flushSubagentHookObservations(
	runtime: SubagentHookRuntime | undefined,
	maxWaitMs = SUBAGENT_HOOK_OBSERVATION_FLUSH_MS,
): Promise<void> {
	if (!runtime?.pendingObservations || runtime.pendingObservations.size === 0) return;
	const pending = [...runtime.pendingObservations];
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.all(pending.map((entry) => entry.promise)),
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					for (const entry of pending) entry.controller.abort();
					resolve();
				}, maxWaitMs);
			}),
		]);
		await Promise.all(pending.map((entry) => entry.promise));
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export interface NativeSubagentSession {
	session: CreateAgentSessionResult["session"];
	profile: ResolvedSubagentProfile;
	tools: string[];
	prompt: string;
	diagnostics?: readonly SubagentDiagnostic[];
	/** Stable affinity for the shared fork prefix; independent of child session identity. */
	promptCacheKey?: string;
}

export interface SubagentLiveSession {
	readonly runId: string;
	readonly role: string;
	readonly taskId?: string;
	readonly model?: string;
	readonly authority?: "safe" | "yolo";
	readonly color?: IceAgentViewColor;
	readonly presentation?: IceAgentViewPresentation;
	readonly checkIn?: SubagentCheckInState;
	readonly session: CreateAgentSessionResult["session"];
	readonly control?: IceAgentViewLiveSessionControl;
}

export interface SubagentLiveSessionRegistration {
	readonly runId: string;
	readonly role: string;
	readonly taskId?: string;
	readonly model?: string;
	readonly authority?: "safe" | "yolo";
	readonly color?: IceAgentViewColor;
	readonly presentation?: IceAgentViewPresentation;
	readonly checkIn?: SubagentCheckInState;
	readonly session: CreateAgentSessionResult["session"];
	readonly control?: IceAgentViewLiveSessionControl;
}

export class SubagentLiveSessionRegistry {
	private readonly sessions = new Map<string, SubagentLiveSession>();
	private readonly listeners = new Set<() => void>();

	register(input: SubagentLiveSessionRegistration): () => void {
		const { color: requestedColor, ...sessionInput } = input;
		const color = isIceAgentViewColor(requestedColor) ? requestedColor : undefined;
		const session = Object.freeze({
			...sessionInput,
			...(color ? { color } : {}),
			...(input.presentation ? { presentation: normalizeIceAgentViewPresentation(input.presentation) } : {}),
		});
		this.sessions.set(input.runId, session);
		this.publish();
		return () => {
			if (this.sessions.get(input.runId)?.session !== input.session) return;
			this.sessions.delete(input.runId);
			this.publish();
		};
	}

	updatePresentation(runId: string, patch: IceAgentViewPresentationPatch): boolean {
		const current = this.sessions.get(runId);
		if (!current) return false;
		const presentation = normalizeIceAgentViewPresentation({ ...current.presentation, ...patch });
		this.sessions.set(
			runId,
			Object.freeze({
				...current,
				...(presentation ? { presentation } : {}),
			}),
		);
		this.publish();
		return true;
	}

	updateCheckInState(runId: string, checkIn: SubagentCheckInState | undefined): boolean {
		const current = this.sessions.get(runId);
		if (!current) return false;
		const { checkIn: _previous, ...withoutCheckIn } = current;
		this.sessions.set(runId, Object.freeze(checkIn ? { ...withoutCheckIn, checkIn } : withoutCheckIn));
		this.publish();
		return true;
	}

	get(runId: string | undefined): SubagentLiveSession | undefined {
		return runId ? this.sessions.get(runId) : undefined;
	}

	list(): readonly SubagentLiveSession[] {
		return Object.freeze([...this.sessions.values()]);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	notify(): void {
		this.publish();
	}

	private publish(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// Live-session views are observational and must not affect child execution.
			}
		}
	}
}

export function createSubagentLiveSessionControl(
	session: CreateAgentSessionResult["session"],
	onChange: () => void = () => {},
	onSteered: () => void = () => {},
): IceAgentViewLiveSessionControl {
	let state: IceAgentViewControlState = "working";
	let steered = false;
	let controlled = false;
	let pendingSteering = 0;
	const controlReleaseWaiters = new Set<() => void>();
	const steeringWaiters = new Set<() => void>();
	const changed = (): void => onChange();
	const resolveControlRelease = (): void => {
		for (const resolve of controlReleaseWaiters) resolve();
		controlReleaseWaiters.clear();
	};
	const resolveSteeringWaiters = (): void => {
		if (pendingSteering !== 0) return;
		for (const resolve of steeringWaiters) resolve();
		steeringWaiters.clear();
	};
	const markSteered = (): boolean => {
		if (state !== "working") return false;
		steered = true;
		try {
			onSteered();
		} catch {
			// Presentation updates are observational and must not affect control state.
		}
		changed();
		return true;
	};
	return {
		getState: () => state,
		hasSteered: () => steered,
		isControlled: () => controlled,
		setControlled: (nextControlled: boolean) => {
			if (state !== "working") nextControlled = false;
			if (controlled === nextControlled) return;
			controlled = nextControlled;
			if (!controlled) resolveControlRelease();
			changed();
		},
		waitForControlRelease: async () => {
			if (!controlled || state !== "working") return;
			await new Promise<void>((resolve) => controlReleaseWaiters.add(resolve));
		},
		waitForPendingSteering: async () => {
			if (pendingSteering === 0) return;
			await new Promise<void>((resolve) => steeringWaiters.add(resolve));
		},
		markSteered,
		beginFinalization: () => {
			if (!steered || controlled || pendingSteering !== 0 || state !== "working") return false;
			state = "awaiting-finalization";
			changed();
			return true;
		},
		requestFinalReport: () => {
			if (state !== "awaiting-finalization") return false;
			state = "final-report-requested";
			changed();
			return true;
		},
		markFinalReportReceived: () => {
			if (state !== "final-report-requested") return false;
			state = "final-report-received";
			changed();
			return true;
		},

		markTerminal: () => {
			if (state === "terminal") return;
			state = "terminal";
			controlled = false;
			pendingSteering = 0;
			resolveControlRelease();
			resolveSteeringWaiters();
			changed();
		},
		followUp: async (text: string) => {
			if (controlled) throw new SubagentError("child_protocol_failure", "User takeover currently owns this child.");
			if (!markSteered()) {
				throw new SubagentError("child_protocol_failure", "Child no longer accepts parent follow-up.");
			}
			await session.steer(text);
			changed();
		},
		steer: async (text: string) => {
			if (!markSteered()) {
				throw new SubagentError("child_protocol_failure", "Child no longer accepts interactive steering.");
			}
			pendingSteering++;
			try {
				const promptOptions = session.isStreaming ? { streamingBehavior: "steer" as const } : {};
				await session.prompt(text, { ...promptOptions, source: "interactive" });
			} finally {
				pendingSteering = Math.max(0, pendingSteering - 1);
				resolveSteeringWaiters();
				changed();
			}
		},
	};
}

function messageTranscriptText(message: AgentMessage): string {
	const content = (message as AgentMessage & { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!isRecord(part)) return "";
			if (typeof part.text === "string") return part.text;
			if (part.type === "thinking") return "[thinking]";
			if (part.type === "toolCall") return `[tool call ${typeof part.name === "string" ? part.name : "unknown"}]`;
			return "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

export function formatSubagentTranscript(messages: readonly AgentMessage[], maxBytes = 48 * 1024): string {
	const rows = messages.slice(-96).map((message) => {
		const role = message.role === "toolResult" ? "tool" : message.role;
		const text = messageTranscriptText(message) || "[no text]";
		return `${role}: ${text}`;
	});
	return truncateSubagentOutput(redactCredentialText(rows.join("\n")), maxBytes).text;
}

export function buildUnsafeSubagentSystemPrompt(profile: ResolvedSubagentProfile, tools: readonly string[]): string {
	return [
		"You are ICE's explicitly authorized host-execution worker.",
		`Selected role guidance (${profile.name}): ${profile.systemPrompt}`,
		"Role guidance describes the methodology and kind of result expected; explicit host authority does not turn a planner, reviewer, tester, or other specialist into a generic worker.",
		"The trusted parent explicitly authorizes these child tools for this run:",
		tools.join(", "),
		"Execute only the parent task with the provided tools. A requested mutation is an instruction to use the matching mutation tool; do not add unrelated work.",
		"Bash runs with the host account's permissions and may access resources outside the approved scope. Do not claim isolation or cleanup.",
		"Trusted ambient resources may be loaded, but model-visible authority remains this explicit tool allowlist. Recursive delegation is not authorized.",
	].join(" ");
}

export function mergeTrustedChildContext(
	base: readonly { path: string; content: string }[],
	selected: readonly { path: string; content: string }[],
): Array<{ path: string; content: string }> {
	const merged: Array<{ path: string; content: string }> = [];
	const seen = new Set<string>();
	for (const file of [...base, ...selected]) {
		let key: string;
		try {
			key = canonicalPath(file.path);
		} catch {
			key = resolve(file.path);
		}
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(file);
	}
	return merged;
}

const SUBAGENT_OPENAI_SAMPLING_APIS = new Set(["azure-openai-responses", "openai-completions", "openai-responses"]);

interface SubagentSamplingResolution {
	options: Pick<StreamOptions, "temperature" | "samplingParams">;
	diagnostics: readonly SubagentDiagnostic[];
}

export function resolveSubagentSamplingOptions(
	model: Model<Api>,
	execution: Pick<SubagentExecutionContract, "thinking" | "temperature" | "topP">,
): SubagentSamplingResolution {
	const diagnostics: SubagentDiagnostic[] = [];
	const options: Pick<StreamOptions, "temperature" | "samplingParams"> = {};
	const compatibility = model.compat as { supportsTemperature?: boolean } | undefined;
	if (execution.temperature !== undefined) {
		const unsupported =
			model.api === "anthropic-messages" &&
			(compatibility?.supportsTemperature === false || execution.thinking !== "off");
		if (unsupported) {
			diagnostics.push({
				code: "provider_option_unsupported",
				message:
					execution.thinking !== "off"
						? "Profile temperature was omitted because Anthropic extended thinking does not accept temperature."
						: "Profile temperature was omitted because the selected Anthropic model does not support it.",
			});
		} else {
			options.temperature = execution.temperature;
		}
	}
	if (execution.topP !== undefined) {
		if (SUBAGENT_OPENAI_SAMPLING_APIS.has(model.api)) {
			options.samplingParams = { top_p: execution.topP };
		} else {
			diagnostics.push({
				code: "provider_option_unsupported",
				message: `Profile top-p was omitted because ${model.api} is not an OpenAI-compatible sampling API.`,
			});
		}
	}
	return { options, diagnostics: Object.freeze(diagnostics) };
}

/**
 * W13: resolve the requested reasoning level without changing the selected
 * provider route. An explicit caller override for unsupported effort fails
 * before a child session is created; profile defaults keep the historical
 * clamp behavior so stacked-bundled roles still run on routes without
 * reasoning metadata (for example the faux test provider). The SDK clamps
 * the resolved level again at session creation, so this remains a
 * pre-consumption guard, not a second routing decision.
 */
export function resolveSubagentThinkingLevel(
	requested: SubagentThinkingLevel,
	model: Model<Api> | undefined,
	options: { explicit?: boolean } = {},
): SubagentThinkingLevel {
	if (!model) return requested;
	const supported = getSupportedThinkingLevels(model);
	if ((supported as readonly string[]).includes(requested)) return requested;
	if (!options.explicit) return clampThinkingLevel(model, requested) as SubagentThinkingLevel;
	throw new SubagentError(
		"model_unavailable",
		`Requested thinking level "${requested}" is not supported by the selected parent model route.`,
	);
}
