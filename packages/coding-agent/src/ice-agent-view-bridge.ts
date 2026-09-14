import type { AgentMessage } from "@zykairotis/ice-agent-core";
import type { AgentSession } from "./core/agent-session.ts";
import type { SubagentRuntimeAttention } from "./ice-subagent-timeout-supervisor.ts";
import { redactCredentialText } from "./utils/redact.ts";

export type IceAgentViewKind = "parent" | "subagent" | "historical-subagent";
export type IceAgentViewAuthority = "safe" | "yolo";

export interface IceAgentViewFinalResult {
	readonly status: string;
	/** True only after the parent verifier has accepted the bounded child result. */
	readonly verified?: boolean;
	readonly summary?: string;
	readonly evidencePaths?: readonly string[];
	readonly diagnostic?: string;
}

/**
 * ICE-owned presentation metadata. It is a projection over the raw child
 * session and never replaces or mutates the messages used for verification.
 */
export interface IceAgentViewPresentation {
	readonly delegatedTask?: string;
	readonly scopeLabels?: readonly string[];
	readonly authority?: IceAgentViewAuthority;
	readonly handoffMessageMarker?: string;
	readonly finalizationMessageMarker?: string;
	readonly timeoutContinuationMessageMarker?: string;
	readonly handoffMessageIndex?: number;
	readonly finalizationMessageIndex?: number;
	readonly finalReportMessageIndex?: number;
	/** True while the child is expected to emit an internal machine report. */
	readonly protocolReportPending?: boolean;
	/** True while the child AgentSession is compacting its in-memory transcript. */
	readonly compacting?: boolean;
	readonly finalizationStarted?: boolean;
	/** Bounded, redacted runtime state for a live child awaiting a time decision. */
	readonly runtimeAttention?: SubagentRuntimeAttention;
	readonly finalResult?: IceAgentViewFinalResult;
}

export type IceAgentViewPresentationPatch = IceAgentViewPresentation;

export type IceAgentViewInteractionMode = "mirror" | "controlled";
export type IceAgentViewControlState =
	| "working"
	| "awaiting-extension"
	| "awaiting-finalization"
	| "final-report-requested"
	| "final-report-received"
	| "terminal";

export interface IceAgentViewLiveSessionControl {
	readonly getState: () => IceAgentViewControlState;
	readonly hasSteered: () => boolean;
	readonly isControlled: () => boolean;
	readonly setControlled: (controlled: boolean) => void;
	readonly waitForControlRelease: () => Promise<void>;
	readonly waitForPendingSteering: () => Promise<void>;
	readonly markSteered: () => boolean;
	readonly beginFinalization: () => boolean;
	readonly requestFinalReport: () => boolean;
	readonly markFinalReportReceived: () => boolean;
	readonly markTerminal: () => void;
	/** Runtime timeout controls are optional for non-supervised display sessions. */
	readonly getRuntimeAttention?: () => SubagentRuntimeAttention | undefined;
	readonly extendRuntime?: (additionalMs: number) => Promise<unknown>;
	readonly stopRuntime?: () => Promise<unknown>;
	readonly markAwaitingExtension?: () => boolean;
	readonly resumeFromExtension?: () => boolean;
	/** Parent-owned queued follow-up; rejected while a user has takeover control. */
	readonly followUp?: (text: string) => Promise<void>;
	readonly steer: (text: string) => Promise<void>;
}

export type IceAgentViewControlResult =
	| { readonly accepted: true; readonly mode: IceAgentViewInteractionMode }
	| { readonly accepted: false; readonly reason: string };

export interface IceAgentViewDescriptor {
	readonly kind: IceAgentViewKind;
	readonly id: string;
	readonly label: string;
	readonly role?: string;
	readonly runId?: string;
	readonly taskId?: string;
	readonly session?: AgentSession;
	readonly live: boolean;
	readonly readOnly: boolean;
	readonly interactionMode?: IceAgentViewInteractionMode;
	readonly controlState?: IceAgentViewControlState;
	readonly authority?: IceAgentViewAuthority;
	readonly model?: string;
	readonly status?: string;
	readonly cwd?: string;
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly presentation?: IceAgentViewPresentation;
	readonly messages?: readonly AgentMessage[];
}

export interface IceAgentViewLiveSession {
	readonly runId: string;
	readonly role: string;
	readonly taskId?: string;
	readonly model?: string;
	readonly authority?: IceAgentViewAuthority;
	readonly presentation?: IceAgentViewPresentation;
	readonly session: AgentSession;
	readonly control?: IceAgentViewLiveSessionControl;
}

export interface IceAgentViewLiveSessionSource {
	list(): readonly IceAgentViewLiveSession[];
	subscribe(listener: () => void): () => void;
}

export interface AgentViewUiState {
	readonly editorDraft: string;
	readonly scrollOffset?: number;
	readonly followTranscript: boolean;
	readonly fullscreen?: boolean;
}

export interface IceAgentViewSnapshotInput {
	readonly runId: string;
	readonly role: string;
	readonly model?: string;
	readonly status: string;
	readonly authority?: IceAgentViewAuthority;
	readonly startedAt?: number;
	readonly finishedAt: number;
	readonly messages: readonly AgentMessage[];
	readonly taskId?: string;
	readonly cwd?: string;
	readonly presentation?: IceAgentViewPresentation;
}

const MAX_HISTORICAL_MESSAGES = 96;
const MAX_HISTORICAL_MESSAGE_BYTES = 16 * 1024;
const MAX_HISTORICAL_VIEWS = 32;
const MAX_PRESENTATION_TEXT_BYTES = 16 * 1024;
const MAX_PRESENTATION_LABEL_BYTES = 4096;
const MAX_PRESENTATION_LABELS = 16;
const MAX_PRESENTATION_EVIDENCE_PATHS = 64;
const MAX_PRESENTATION_INDEX = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactSnapshotValue(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") {
		if (key && /(?:api[_-]?key|token|secret|password|authorization)/i.test(key)) return "[REDACTED]";
		return redactCredentialText(value);
	}
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return "[REDACTED]";
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => redactSnapshotValue(item, undefined, seen));
		if (isRecord(value)) {
			return Object.fromEntries(
				Object.entries(value).map(([entryKey, entryValue]) => [
					entryKey,
					redactSnapshotValue(entryValue, entryKey, seen),
				]),
			);
		}
		return "[REDACTED]";
	} finally {
		seen.delete(value);
	}
}

function deepFreezeSnapshot(value: unknown): unknown {
	if (Array.isArray(value)) {
		for (const item of value) deepFreezeSnapshot(item);
		return Object.freeze(value);
	}
	if (isRecord(value)) {
		for (const item of Object.values(value)) deepFreezeSnapshot(item);
		return Object.freeze(value);
	}
	return value;
}

function cloneBoundedMessages(messages: readonly AgentMessage[]): {
	readonly messages: readonly AgentMessage[];
	readonly sourceIndices: readonly number[];
} {
	const bounded: AgentMessage[] = [];
	const sourceIndices: number[] = [];
	let totalBytes = 0;
	const startIndex = Math.max(0, messages.length - MAX_HISTORICAL_MESSAGES);
	for (let sourceIndex = startIndex; sourceIndex < messages.length; sourceIndex += 1) {
		const message = messages[sourceIndex]!;
		let serialized: string;
		try {
			serialized = JSON.stringify(redactSnapshotValue(message));
		} catch {
			continue;
		}
		const bytes = Buffer.byteLength(serialized);
		if (bytes > MAX_HISTORICAL_MESSAGE_BYTES) continue;
		if (totalBytes + bytes > 256 * 1024) break;
		totalBytes += bytes;
		try {
			bounded.push(deepFreezeSnapshot(JSON.parse(serialized)) as AgentMessage);
			sourceIndices.push(sourceIndex);
		} catch {
			// A non-JSON message is not safe to retain as history.
		}
	}
	return { messages: Object.freeze(bounded), sourceIndices: Object.freeze(sourceIndices) };
}

function truncatePresentationText(value: string, maxBytes: number): string {
	const redacted = redactCredentialText(value);
	const bytes = Buffer.from(redacted);
	if (bytes.length <= maxBytes) return redacted;
	let end = maxBytes;
	while (end > 0 && bytes.subarray(0, end).toString("utf8").endsWith("\ufffd")) end -= 1;
	return bytes.subarray(0, end).toString("utf8");
}

function presentationIndex(value: unknown, sourceIndices?: readonly number[]): number | undefined {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_PRESENTATION_INDEX) {
		return undefined;
	}
	if (!sourceIndices) return value;
	const retainedIndex = sourceIndices.indexOf(value);
	return retainedIndex >= 0 ? retainedIndex : undefined;
}

function boundedRuntimeNumber(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
		? value
		: undefined;
}

function normalizeRuntimeAttention(input: unknown): SubagentRuntimeAttention | undefined {
	if (!isRecord(input)) return undefined;
	const state = input.state;
	const phase = input.phase;
	if (
		(state !== "running" && state !== "awaiting_extension" && state !== "terminal") ||
		(phase !== "startup" && phase !== "working" && phase !== "controlled_wait" && phase !== "finalization")
	) {
		return undefined;
	}
	const initialTimeoutMs = boundedRuntimeNumber(input.initialTimeoutMs);
	const activeBudgetMs = boundedRuntimeNumber(input.activeBudgetMs);
	const activeElapsedMs = boundedRuntimeNumber(input.activeElapsedMs);
	const totalExtendedMs = boundedRuntimeNumber(input.totalExtendedMs);
	const extensionCount = boundedRuntimeNumber(input.extensionCount);
	const remainingExtendableMs = boundedRuntimeNumber(input.remainingExtendableMs);
	if (
		initialTimeoutMs === undefined ||
		activeBudgetMs === undefined ||
		activeElapsedMs === undefined ||
		totalExtendedMs === undefined ||
		extensionCount === undefined ||
		remainingExtendableMs === undefined
	) {
		return undefined;
	}
	const rawActivities = Array.isArray(input.lastActivities) ? input.lastActivities : [];
	const lastActivities = rawActivities
		.slice(-12)
		.map((activity) => {
			if (!isRecord(activity)) return undefined;
			const toolCallId =
				typeof activity.toolCallId === "string" ? truncatePresentationText(activity.toolCallId, 256) : undefined;
			const toolName =
				typeof activity.toolName === "string" ? truncatePresentationText(activity.toolName, 256) : undefined;
			// "completed" is a legacy projection of "ok"; normalize at the bridge boundary.
			const rawOutcome = activity.status;
			const outcome =
				rawOutcome === "ok" || rawOutcome === "completed"
					? "ok"
					: rawOutcome === "running"
						? "running"
						: rawOutcome === "aborted"
							? "aborted"
							: rawOutcome === "error"
								? "error"
								: undefined;
			if (!toolCallId || !toolName || outcome === undefined) {
				return undefined;
			}
			const startedAtMs = boundedRuntimeNumber(activity.startedAtMs);
			if (startedAtMs === undefined) return undefined;
			const finishedAtMs = boundedRuntimeNumber(activity.finishedAtMs);
			const path = typeof activity.path === "string" ? truncatePresentationText(activity.path, 512) : undefined;
			const action =
				typeof activity.action === "string" ? truncatePresentationText(activity.action, 512) : undefined;
			const exitCode = boundedRuntimeNumber(activity.exitCode, 65_535);
			const errorClass =
				typeof activity.errorClass === "string" && activity.errorClass.length > 0
					? truncatePresentationText(activity.errorClass, 128)
					: undefined;
			return {
				toolCallId,
				toolName,
				status: outcome,
				...(action ? { action } : {}),
				...(path ? { path } : {}),
				startedAtMs,
				...(finishedAtMs !== undefined ? { finishedAtMs } : {}),
				...(exitCode !== undefined ? { exitCode } : {}),
				...(errorClass ? { errorClass } : {}),
			};
		})
		.filter((activity): activity is SubagentRuntimeAttention["lastActivities"][number] => activity !== undefined);
	const repeatedFailureInput = isRecord(input.repeatedFailure) ? input.repeatedFailure : undefined;
	const repeatedFailureAction =
		repeatedFailureInput && typeof repeatedFailureInput.action === "string"
			? truncatePresentationText(repeatedFailureInput.action, 512)
			: undefined;
	const repeatedFailureCount = repeatedFailureInput
		? boundedRuntimeNumber(repeatedFailureInput.count, 1024)
		: undefined;
	const repeatedFailure =
		repeatedFailureAction && repeatedFailureCount !== undefined && repeatedFailureCount >= 2
			? { action: repeatedFailureAction, count: repeatedFailureCount }
			: undefined;
	const usageInput = isRecord(input.usage) ? input.usage : undefined;
	const usage = usageInput
		? (() => {
				const inputTokens = boundedRuntimeNumber(usageInput.inputTokens);
				const outputTokens = boundedRuntimeNumber(usageInput.outputTokens);
				const cacheReadTokens = boundedRuntimeNumber(usageInput.cacheReadTokens);
				const cacheWriteTokens = boundedRuntimeNumber(usageInput.cacheWriteTokens);
				const cost =
					typeof usageInput.cost === "number" && Number.isFinite(usageInput.cost) && usageInput.cost >= 0
						? usageInput.cost
						: undefined;
				return inputTokens !== undefined &&
					outputTokens !== undefined &&
					cacheReadTokens !== undefined &&
					cacheWriteTokens !== undefined &&
					cost !== undefined
					? { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost }
					: undefined;
			})()
		: undefined;
	const progressAgeMs = boundedRuntimeNumber(input.progressAgeMs);
	const lastProgressAtMs = boundedRuntimeNumber(input.lastProgressAtMs);
	const decisionDeadlineAtMs = boundedRuntimeNumber(input.decisionDeadlineAtMs);
	return deepFreezeSnapshot({
		phase,
		state,
		initialTimeoutMs,
		activeBudgetMs,
		activeElapsedMs,
		totalExtendedMs,
		extensionCount,
		remainingExtendableMs,
		...(progressAgeMs !== undefined ? { progressAgeMs } : {}),
		...(lastProgressAtMs !== undefined ? { lastProgressAtMs } : {}),
		...(decisionDeadlineAtMs !== undefined ? { decisionDeadlineAtMs } : {}),
		lastActivities,
		...(repeatedFailure ? { repeatedFailure } : {}),
		...(usage ? { usage } : {}),
	}) as IceAgentViewPresentation["runtimeAttention"];
}

/** Normalize presentation data at the bridge boundary before publishing it. */
export function normalizeIceAgentViewPresentation(
	input: IceAgentViewPresentation | undefined,
	sourceIndices?: readonly number[],
): IceAgentViewPresentation | undefined {
	if (!input || !isRecord(input)) return undefined;
	const delegatedTask =
		typeof input.delegatedTask === "string"
			? truncatePresentationText(input.delegatedTask, MAX_PRESENTATION_TEXT_BYTES)
			: undefined;
	const scopeLabels = Array.isArray(input.scopeLabels)
		? input.scopeLabels
				.filter((label): label is string => typeof label === "string" && label.length > 0)
				.slice(0, MAX_PRESENTATION_LABELS)
				.map((label) => truncatePresentationText(label, MAX_PRESENTATION_LABEL_BYTES))
		: undefined;
	const authority = input.authority === "safe" || input.authority === "yolo" ? input.authority : undefined;
	const handoffMessageMarker =
		typeof input.handoffMessageMarker === "string"
			? truncatePresentationText(input.handoffMessageMarker, MAX_PRESENTATION_LABEL_BYTES)
			: undefined;
	const finalizationMessageMarker =
		typeof input.finalizationMessageMarker === "string"
			? truncatePresentationText(input.finalizationMessageMarker, MAX_PRESENTATION_LABEL_BYTES)
			: undefined;
	const timeoutContinuationMessageMarker =
		typeof input.timeoutContinuationMessageMarker === "string"
			? truncatePresentationText(input.timeoutContinuationMessageMarker, MAX_PRESENTATION_LABEL_BYTES)
			: undefined;
	const runtimeAttention = normalizeRuntimeAttention(input.runtimeAttention);
	const finalResultInput = isRecord(input.finalResult) ? input.finalResult : undefined;
	const finalStatus =
		finalResultInput && typeof finalResultInput.status === "string"
			? truncatePresentationText(finalResultInput.status, MAX_PRESENTATION_LABEL_BYTES)
			: undefined;
	const finalVerified =
		finalResultInput && typeof finalResultInput.verified === "boolean" ? finalResultInput.verified : undefined;
	const finalEvidencePaths =
		finalResultInput && Array.isArray(finalResultInput.evidencePaths)
			? finalResultInput.evidencePaths
					.filter((path): path is string => typeof path === "string" && path.length > 0)
					.slice(0, MAX_PRESENTATION_EVIDENCE_PATHS)
					.map((path) => truncatePresentationText(path, MAX_PRESENTATION_LABEL_BYTES))
			: undefined;
	const finalResult = finalStatus
		? {
				status: finalStatus,
				...(finalVerified !== undefined ? { verified: finalVerified } : {}),
				...(typeof finalResultInput?.summary === "string"
					? { summary: truncatePresentationText(finalResultInput.summary, MAX_PRESENTATION_TEXT_BYTES) }
					: {}),
				...(finalEvidencePaths && finalEvidencePaths.length > 0 ? { evidencePaths: finalEvidencePaths } : {}),
				...(typeof finalResultInput?.diagnostic === "string"
					? { diagnostic: truncatePresentationText(finalResultInput.diagnostic, MAX_PRESENTATION_TEXT_BYTES) }
					: {}),
			}
		: undefined;
	const handoffMessageIndex = presentationIndex(input.handoffMessageIndex, sourceIndices);
	const finalizationMessageIndex = presentationIndex(input.finalizationMessageIndex, sourceIndices);
	const finalReportMessageIndex = presentationIndex(input.finalReportMessageIndex, sourceIndices);
	const normalized: IceAgentViewPresentation = {
		...(delegatedTask ? { delegatedTask } : {}),
		...(scopeLabels && scopeLabels.length > 0 ? { scopeLabels } : {}),
		...(authority ? { authority } : {}),
		...(handoffMessageMarker ? { handoffMessageMarker } : {}),
		...(finalizationMessageMarker ? { finalizationMessageMarker } : {}),
		...(timeoutContinuationMessageMarker ? { timeoutContinuationMessageMarker } : {}),
		...(handoffMessageIndex !== undefined ? { handoffMessageIndex } : {}),
		...(finalizationMessageIndex !== undefined ? { finalizationMessageIndex } : {}),
		...(finalReportMessageIndex !== undefined ? { finalReportMessageIndex } : {}),
		...(typeof input.protocolReportPending === "boolean"
			? { protocolReportPending: input.protocolReportPending }
			: {}),
		...(typeof input.compacting === "boolean" ? { compacting: input.compacting } : {}),
		...(typeof input.finalizationStarted === "boolean" ? { finalizationStarted: input.finalizationStarted } : {}),
		...(runtimeAttention ? { runtimeAttention } : {}),
		...(finalResult ? { finalResult } : {}),
	};
	return Object.keys(normalized).length > 0 ? (deepFreezeSnapshot(normalized) as IceAgentViewPresentation) : undefined;
}

export class IceAgentViewBridge {
	private parentSession: AgentSession | undefined;
	private liveSource: IceAgentViewLiveSessionSource | undefined;
	private unsubscribeLiveSource: (() => void) | undefined;
	private readonly historical = new Map<string, IceAgentViewDescriptor>();
	private readonly listeners = new Set<() => void>();
	private readonly switcherRequestListeners = new Set<() => void>();
	private readonly uiState = new Map<string, AgentViewUiState>();
	private readonly interactionModes = new Map<string, IceAgentViewInteractionMode>();
	private displayedId = "parent";

	setParentSession(session: AgentSession): void {
		const replaced = this.parentSession !== undefined && this.parentSession !== session;
		if (replaced && this.displayedId !== "parent") this.releaseControlForView(this.displayedId);
		this.parentSession = session;
		// A new parent session starts a new lineage. Never leave an old child selected
		// while lifecycle commands replace the authoritative runtime session.
		if (replaced && this.displayedId !== "parent") {
			this.displayedId = "parent";
		}
		this.publish();
	}

	connectLiveSessions(source: IceAgentViewLiveSessionSource): void {
		this.unsubscribeLiveSource?.();
		this.liveSource = source;
		const connectedSource = source;
		this.unsubscribeLiveSource = source.subscribe(() => {
			if (this.liveSource !== connectedSource) return;
			if (this.displayedId !== "parent" && !this.getView(this.displayedId)) {
				this.displayedId = "parent";
			}
			this.publish();
		});
		this.publish();
	}

	disconnect(): void {
		for (const entry of this.liveSource?.list() ?? []) entry.control?.setControlled(false);
		this.unsubscribeLiveSource?.();
		this.unsubscribeLiveSource = undefined;
		this.liveSource = undefined;
		this.interactionModes.clear();
		if (this.displayedId !== "parent") this.displayedId = "parent";
		this.publish();
	}

	registerHistoricalSnapshot(input: IceAgentViewSnapshotInput): void {
		const id = input.runId;
		const clonedMessages = cloneBoundedMessages(input.messages);
		const presentation = normalizeIceAgentViewPresentation(input.presentation, clonedMessages.sourceIndices);
		// Re-registering a run makes it the newest retained snapshot.
		this.historical.delete(id);
		this.interactionModes.delete(id);
		this.historical.set(
			id,
			Object.freeze({
				kind: "historical-subagent" as const,
				id,
				label: input.taskId ? `${input.role} · ${input.taskId}` : input.role,
				role: input.role,
				runId: input.runId,
				taskId: input.taskId,
				live: false,
				readOnly: true,
				interactionMode: "mirror" as const,
				authority: input.authority,
				model: input.model,
				status: input.status,
				cwd: input.cwd,
				startedAt: input.startedAt,
				finishedAt: input.finishedAt,
				...(presentation ? { presentation } : {}),
				messages: clonedMessages.messages,
			}),
		);
		while (this.historical.size > MAX_HISTORICAL_VIEWS) {
			const oldestId = this.historical.keys().next().value as string | undefined;
			if (oldestId === undefined) break;
			this.historical.delete(oldestId);
			this.uiState.delete(oldestId);
		}
		this.publish();
	}

	requestAgentSwitcher(): boolean {
		if (this.switcherRequestListeners.size === 0) return false;
		for (const listener of this.switcherRequestListeners) {
			try {
				listener();
			} catch {
				// UI-intent observers must not affect bridge state or runtime execution.
			}
		}
		return true;
	}

	subscribeAgentSwitcherRequests(listener: () => void): () => void {
		this.switcherRequestListeners.add(listener);
		return () => this.switcherRequestListeners.delete(listener);
	}

	listViews(): readonly IceAgentViewDescriptor[] {
		const parent: IceAgentViewDescriptor[] = this.parentSession
			? [
					Object.freeze({
						kind: "parent" as const,
						id: "parent",
						label: "parent",
						session: this.parentSession,
						live: true,
						readOnly: false,
						model: this.parentSession.model
							? `${this.parentSession.model.provider}/${this.parentSession.model.id}`
							: undefined,
						status: this.parentSession.isStreaming ? "working" : "idle",
						cwd: this.parentSession.sessionManager.getCwd(),
					}),
				]
			: [];
		const liveEntries = this.liveSource?.list() ?? [];
		const live = liveEntries.map((entry) => {
			const interactionMode = this.interactionModes.get(entry.runId) ?? "mirror";
			const controlState = entry.control?.getState();
			const runtimeAttention = entry.control?.getRuntimeAttention?.() ?? entry.presentation?.runtimeAttention;
			const canAcceptInput = interactionMode === "controlled" && controlState === "working";
			return Object.freeze({
				kind: "subagent" as const,
				id: entry.runId,
				label: entry.taskId ? `${entry.role} · ${entry.taskId}` : entry.role,
				role: entry.role,
				runId: entry.runId,
				taskId: entry.taskId,
				session: entry.session,
				live: true,
				readOnly: !canAcceptInput,
				interactionMode,
				controlState,
				authority: entry.authority,
				presentation: runtimeAttention
					? normalizeIceAgentViewPresentation({ ...entry.presentation, runtimeAttention })
					: entry.presentation,
				model: entry.model,
				status:
					controlState === "awaiting-extension" ? "needs_time" : entry.session.isStreaming ? "working" : "idle",
				cwd: entry.session.sessionManager.getCwd(),
			});
		});
		const liveIds = new Set(live.map((view) => view.id));
		const historical = [...this.historical.values()].filter((view) => !liveIds.has(view.id));
		return Object.freeze([...parent, ...live, ...historical]);
	}

	getView(id: string): IceAgentViewDescriptor | undefined {
		const views = this.listViews();
		if (id === "parent") return views.find((view) => view.kind === "parent");
		return views.find((view) => view.id === id);
	}

	getDisplayedView(): IceAgentViewDescriptor | undefined {
		return this.getView(this.displayedId);
	}

	getDisplayedId(): string {
		return this.displayedId;
	}

	requestDisplay(id: string): boolean {
		if (!this.getView(id)) return false;
		if (this.displayedId === id) return true;
		this.releaseControlForView(this.displayedId);
		this.displayedId = id;
		this.publish();
		return true;
	}

	cycleDisplayed(delta: -1 | 1): boolean {
		const views = this.listViews();
		if (views.length === 0) return false;
		const currentIndex = Math.max(
			0,
			views.findIndex((view) => view.id === this.displayedId),
		);
		const nextIndex = (currentIndex + delta + views.length) % views.length;
		return this.requestDisplay(views[nextIndex]!.id);
	}

	getInteractionMode(id = this.displayedId): IceAgentViewInteractionMode | undefined {
		if (id === "parent") return undefined;
		return this.interactionModes.get(id) ?? (this.getView(id)?.kind === "subagent" ? "mirror" : undefined);
	}

	requestTakeControl(id = this.displayedId): IceAgentViewControlResult {
		const view = this.getView(id);
		if (!view || view.kind === "parent") return { accepted: false, reason: "No live subagent is selected." };
		if (view.kind === "historical-subagent") {
			return { accepted: false, reason: "Historical views are read-only." };
		}
		const entry = this.liveSource?.list().find((candidate) => candidate.runId === id);
		if (!entry?.control)
			return { accepted: false, reason: "The child session does not accept interactive steering." };
		if (entry.control.getState() !== "working") {
			return { accepted: false, reason: `Cannot take control: child is ${entry.control.getState()}.` };
		}
		const nextMode = this.getInteractionMode(id) === "controlled" ? "mirror" : "controlled";
		this.interactionModes.set(id, nextMode);
		entry.control.setControlled(nextMode === "controlled");
		this.publish();
		return { accepted: true, mode: nextMode };
	}

	async sendInput(id: string, text: string): Promise<void> {
		if (this.getInteractionMode(id) !== "controlled") {
			throw new Error("Take Control before sending input to a live subagent.");
		}
		const entry = this.liveSource?.list().find((candidate) => candidate.runId === id);
		if (!entry?.control) throw new Error("The child session is no longer available for steering.");
		await entry.control.steer(text);
		this.publish();
	}

	getRuntimeAttention(id: string): SubagentRuntimeAttention | undefined {
		const entry = this.liveSource?.list().find((candidate) => candidate.runId === id);
		return entry?.control?.getRuntimeAttention?.() ?? entry?.presentation?.runtimeAttention;
	}

	async extendRuntime(id: string, additionalMs: number): Promise<unknown> {
		const entry = this.liveSource?.list().find((candidate) => candidate.runId === id);
		if (!entry?.control?.extendRuntime) throw new Error("The selected subagent cannot be extended.");
		const result = await entry.control.extendRuntime(additionalMs);
		this.publish();
		return result;
	}

	async stopRuntime(id: string): Promise<unknown> {
		const entry = this.liveSource?.list().find((candidate) => candidate.runId === id);
		if (!entry?.control?.stopRuntime) throw new Error("The selected subagent cannot be stopped by runtime control.");
		const result = await entry.control.stopRuntime();
		this.publish();
		return result;
	}

	returnToParent(): void {
		this.requestDisplay("parent");
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getUiState(id: string): AgentViewUiState | undefined {
		return this.uiState.get(id);
	}

	setUiState(id: string, state: AgentViewUiState): void {
		this.uiState.set(id, Object.freeze({ ...state }));
	}

	private releaseControlForView(id: string): void {
		if (id === "parent" || this.getInteractionMode(id) !== "controlled") return;
		this.interactionModes.set(id, "mirror");
		const entry = this.liveSource?.list().find((candidate) => candidate.runId === id);
		entry?.control?.setControlled(false);
	}

	private publish(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// Display observers must never affect parent or child execution.
			}
		}
	}
}
