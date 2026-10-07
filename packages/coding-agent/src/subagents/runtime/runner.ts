/** NativeSubagentRunner, retained children, and bounded startup recovery (moved from ice-subagents.ts). */
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import type { Api, AssistantMessage, Model } from "@zykairotis/ice-ai/compat";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { matchesEntryType } from "../../core/legacy-compat/identity.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "../../core/sdk.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import {
	type IceAgentViewBridge,
	type IceAgentViewLiveSessionControl,
	type IceAgentViewPresentation,
	type IceAgentViewPresentationPatch,
	normalizeIceAgentViewPresentation,
} from "../../ice-agent-view-bridge.ts";
import { redactCredentialText } from "../../utils/redact.ts";
import { resolveSubagentMcpRuntime, revalidateSubagentProfile } from "../definitions/legacy-profiles.ts";
import { classifySubagentFailure } from "../results/format.ts";
import {
	SUBAGENT_OUTPUT_ARTIFACT_LIMITS,
	type SubagentOutput,
	SubagentOutputArtifactStore,
} from "../results/output-artifacts.ts";
import {
	CANDIDATE_EVIDENCE_PATH_LIMIT,
	extractCandidateEvidencePaths,
	INTERACTIVE_FINAL_REPORT_MARKER,
	INTERACTIVE_FINAL_REPORT_PROMPT,
	INTERACTIVE_PLAIN_FINAL_PROMPT,
	normalizePlainFinalAnswer,
	parseSubagentReportOutcome,
	SUBAGENT_HANDOFF_MARKER,
	SUBAGENT_REPORT_REPAIR_PROMPT,
	SUBAGENT_WRAP_UP_MARKER,
	SUBAGENT_WRAP_UP_PROMPT,
	type SubagentParsedReport,
	verifySubagentResult,
} from "../results/report.ts";
import type { SubagentExecutionPolicyBox } from "../tools/scoped-tools.ts";
import {
	type IceSubagentMcpAdapter,
	type IceSubagentMcpToolAccess,
	type NormalizedSubagentRequest,
	SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS,
	SUBAGENT_REPORT_LIMITS,
	SUBAGENT_REPORT_PARSER_LIMITS,
	SUBAGENT_RETAINED_RESULT_LIMIT,
	SUBAGENT_WRAP_UP_LIMITS,
	type SubagentAttemptNumber,
	type SubagentAttemptSummary,
	type SubagentCompactionReason,
	type SubagentCompactionStatus,
	type SubagentDiagnostic,
	type SubagentEvent,
	type SubagentManagedHandle,
	type SubagentManagedObservation,
	type SubagentReportProtocolStatus,
	type SubagentRequest,
	type SubagentRequirementClaim,
	type SubagentResult,
	type SubagentStatus,
	type SubagentUsage,
	type SubagentWorkArtifact,
	subagentMcpToolName,
} from "../types.ts";
import { addBatchUsage, batchUsage } from "./batch.ts";
import {
	abortChildSession,
	awaitSubagentStartup,
	buildSubagentToolActivityDigest,
	displayScopedSubagentPath,
	extractBashExitCode,
	extractProgressPath,
	modelLabel,
	SubagentError,
	shutdownChildSession,
	stringToolArgument,
} from "./helpers.ts";
import {
	createSubagentLiveSessionControl,
	dispatchSubagentHookDecision,
	dispatchSubagentHookObservation,
	flushSubagentHookObservations,
	type NativeSubagentSession,
	type SubagentHookRuntime,
	type SubagentLiveSessionRegistry,
} from "./live-session.ts";
import { extractAssistantText, truncateSubagentOutput } from "./prompt.ts";
import {
	annotateSubagentAssurance,
	boundFollowUpBudget,
	normalizeSubagentRequest,
	SUBAGENT_FOLLOW_UP_LIMIT,
	SUBAGENT_FOLLOW_UP_STATE_ENTRY_TYPE,
	type SubagentFollowUpStateSnapshot,
} from "./request.ts";
import { revalidateSubagentResources } from "./resources.ts";
import { createNativeSubagentSession } from "./session-factory.ts";
import {
	projectSubagentManagementState,
	projectSubagentTerminalStatus,
	type SubagentRetryState,
	SubagentRunSupervisor,
	SubagentRunSupervisorRegistry,
	type SubagentRuntimeAttention,
	type SubagentSupervisorStopReason,
	type SubagentToolActivityDigest,
} from "./supervisor.ts";

export const ICE_SUBAGENT_BACKEND_POLICY = Object.freeze({
	decision: "native-only",
	defaultBackend: "native",
	fallbackBackend: null,
	automaticFallback: false,
	rollback: "restore-known-good-no-state-migration",
} as const);

export function assertIceSubagentBackendPolicy(): void {
	if (
		ICE_SUBAGENT_BACKEND_POLICY.decision !== "native-only" ||
		ICE_SUBAGENT_BACKEND_POLICY.defaultBackend !== "native" ||
		ICE_SUBAGENT_BACKEND_POLICY.fallbackBackend !== null ||
		ICE_SUBAGENT_BACKEND_POLICY.automaticFallback
	) {
		throw new SubagentError("capability_denied", "The frozen native-only backend policy is invalid.");
	}
}

export interface NativeSubagentRunnerOptions {
	createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	agentDir?: string;
	/** Legacy root for historical report-artifact decoding during migration. */
	artifactRoot?: string;
	outputArtifactRoot?: string;
	outputArtifacts?: SubagentOutputArtifactStore;
	/** Optional parent-owned MCP adapter supplied by the host integration. */
	mcpAdapter?: IceSubagentMcpAdapter;
	liveSessionRegistry?: SubagentLiveSessionRegistry;
	agentViewBridge?: IceAgentViewBridge;
	supervisorRegistry?: SubagentRunSupervisorRegistry<SubagentResult>;
	/** Optional durable parent-session journal for accepted follow-up request ids. */
	persistFollowUpState?: (snapshot: SubagentFollowUpStateSnapshot) => void;
}

export interface NativeSubagentRunOptions {
	model?: Model<Api>;
	settingsManager?: SettingsManager;
	unsafeHostExec?: boolean;
	modelRuntime?: ModelRuntime;
	projectTrusted?: boolean;
	/** Parent-owned live policy check; a false result stops at the next safe boundary. */
	isAuthorityStillValid?: () => boolean | Promise<boolean>;
	batchId?: string;
	taskId?: string;
	/** Internal sibling execution (for batches/reviews) has no public lifecycle handle or retention. */
	management?: "public" | "internal";
	attempt?: 1 | 2;
	signal?: AbortSignal;
	onEvent?: (event: SubagentEvent) => void;
	onRuntimeAttention?: (attention: SubagentRuntimeAttention) => void;
	onManagedResult?: (result: SubagentResult) => void | Promise<void>;
	/** Launch-time admission handle; invoked once when supervision starts for this run. */
	onManagedHandle?: (handle: SubagentManagedHandle) => void;
	/** Supervise activity and cancellation without expiring a running child. */
	noLifetimeTimeout?: boolean;
	/** Durable result ownership is used only by delegate_async. */
	outputArtifactLifecycle?: "process_local" | "durable";
	/** Parent-owned lifecycle hook runtime; absent when the feature is disabled. */
	hookRuntime?: SubagentHookRuntime;
	/** Optional per-run parent-owned MCP dispatch override. */
	mcpDispatch?: IceSubagentMcpAdapter["dispatch"];
	parentMcpTools?: readonly string[];
	mcpToolAccess?: ReadonlyMap<string, IceSubagentMcpToolAccess>;
	/** Advisory hook for parent steering (Take Control input); never affects execution. */
	onSteering?: (runId: string) => void;
	/** Stage 3 reuse: continue a retained terminal child session instead of creating a new one. */
	resume?: {
		session: CreateAgentSessionResult["session"];
		tools: readonly string[];
		resumedFromRunId: string;
		/** Reuse cycles already consumed by this child, carried across re-retention. */
		resumeCount: number;
		/** Policy box installed by the original run; this run re-points it at its own policy. */
		policyBox: SubagentExecutionPolicyBox;
		/** Tools the current parent policy still authorizes for this child. */
		eligibleTools: ReadonlySet<string>;
	};
}

/** Bounded metadata for a retained terminal child; safe to surface to the parent. */
export interface RetainedSubagentChild {
	runId: string;
	role: string;
	terminalStatus: string;
	finishedAt: number;
	resumeCount: number;
}

/** Stage 3 reuse options. Deliberately cannot carry model/profile/scope/tool widening. */
export interface NativeSubagentResumeOptions
	extends Omit<NativeSubagentRunOptions, "resume" | "model" | "unsafeHostExec" | "projectTrusted"> {
	/** Parent-owned hook runtime factory, bound to the resumed request. */
	createHookRuntimeFor?: (request: NormalizedSubagentRequest) => SubagentHookRuntime | undefined;
	/** Parent-owned revalidation, bound to the resumed request and its hook runtime. */
	isAuthorityStillValidFor?: (
		request: NormalizedSubagentRequest,
		hookRuntime: SubagentHookRuntime | undefined,
	) => boolean;
}

/** Stage 1 decision: only verified completions are eligible for reuse. */
function isReusableTerminalStatus(status: string | undefined): boolean {
	return status === "completed";
}

/** Bounded retained terminal children per runner; the oldest is evicted first. */
const SUBAGENT_RETAINED_CHILD_LIMIT = 8;
/** Bounded reuse cycles per retained child before it must be deleted. */
const SUBAGENT_RETAINED_RESUME_LIMIT = 8;

/** Stage 2: a terminal child session retained for explicit reuse or deletion. */
interface RetainedSubagentSession {
	runId: string;
	parentSessionId: string;
	role: string;
	terminalStatus: string;
	finishedAt: number;
	resumeCount: number;
	session: CreateAgentSessionResult["session"];
	tools: readonly string[];
	request: NormalizedSubagentRequest;
	model?: Model<Api>;
	unsafeHostExec: boolean;
	/** Policy box the original run installed; a resume re-points this exact box. */
	policyBox: SubagentExecutionPolicyBox;
}

export class NativeSubagentRunner {
	private readonly createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	private readonly agentDir?: string;
	private readonly artifactRoot?: string;
	private readonly outputArtifacts: SubagentOutputArtifactStore;
	private readonly liveSessionRegistry?: SubagentLiveSessionRegistry;
	private readonly agentViewBridge?: IceAgentViewBridge;
	private readonly supervisorRegistry: SubagentRunSupervisorRegistry<SubagentResult>;
	private readonly mcpAdapter?: IceSubagentMcpAdapter;
	private readonly runtimeManagementEnabled: boolean;
	private readonly persistFollowUpState?: (snapshot: SubagentFollowUpStateSnapshot) => void;
	private readonly supervisorOwners = new Map<string, string>();
	private readonly followUpRequests = new Map<string, Set<string>>();
	/** Terminal child sessions retained for explicit resume/delete or history inspection. */
	private readonly retainedChildren = new Map<string, RetainedSubagentSession>();
	/** Superseded retained runId -> the active run that claimed it while a resume is in flight. */
	private readonly activeResumeClaims = new Map<string, string>();
	/** Live multiplexed runs detached from the parent tool call but still under supervision. */
	private readonly detachedRuns = new Map<string, { promise?: Promise<SubagentResult> }>();
	/** Terminal result observation ledger for settled managed runs (all terminal states). */
	private readonly retainedManagedResults = new Map<string, { result: SubagentResult; parentSessionId: string }>();

	constructor(options: NativeSubagentRunnerOptions = {}) {
		assertIceSubagentBackendPolicy();
		this.createSession = options.createSession ?? createAgentSession;
		this.agentDir = options.agentDir;
		this.artifactRoot = options.artifactRoot;
		this.outputArtifacts =
			options.outputArtifacts ??
			new SubagentOutputArtifactStore({ artifactRoot: options.outputArtifactRoot ?? options.artifactRoot });
		this.liveSessionRegistry = options.liveSessionRegistry;
		this.agentViewBridge = options.agentViewBridge;
		this.mcpAdapter = options.mcpAdapter;
		this.runtimeManagementEnabled = options.supervisorRegistry !== undefined;
		this.persistFollowUpState = options.persistFollowUpState;
		this.supervisorRegistry = options.supervisorRegistry ?? new SubagentRunSupervisorRegistry<SubagentResult>();
	}

	/** Restore the latest bounded follow-up request-id ledger for this owner. */
	restoreFollowUpState(entries: readonly unknown[], ownerSessionId: string): number {
		this.followUpRequests.clear();
		for (const entry of entries) {
			if (
				!entry ||
				typeof entry !== "object" ||
				!("type" in entry) ||
				entry.type !== "custom" ||
				!("customType" in entry) ||
				typeof entry.customType !== "string" ||
				!matchesEntryType(entry.customType, SUBAGENT_FOLLOW_UP_STATE_ENTRY_TYPE) ||
				!("data" in entry) ||
				!entry.data ||
				typeof entry.data !== "object"
			) {
				continue;
			}
			const data = entry.data as Record<string, unknown>;
			if (
				data.schemaVersion !== 1 ||
				data.ownerSessionId !== ownerSessionId ||
				typeof data.runId !== "string" ||
				data.runId.length === 0 ||
				data.runId.length > 256 ||
				!Array.isArray(data.requestIds) ||
				data.requestIds.length > SUBAGENT_FOLLOW_UP_LIMIT ||
				data.requestIds.some(
					(value) => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value),
				)
			) {
				continue;
			}
			this.followUpRequests.set(data.runId, new Set(data.requestIds as string[]));
		}
		return this.followUpRequests.size;
	}

	private persistFollowUpLedger(runId: string, parentSessionId: string, requestIds: Set<string>): void {
		this.persistFollowUpState?.(
			Object.freeze({
				schemaVersion: 1,
				ownerSessionId: parentSessionId,
				runId,
				requestIds: Object.freeze([...requestIds]),
			}),
		);
	}

	private releaseOutputArtifact(result: SubagentResult, parentSessionId: string, referenceId = "capture"): void {
		if (!result.output?.artifact) return;
		this.outputArtifacts.release({
			ownerSessionId: parentSessionId,
			artifactId: result.output.artifact.id,
			referenceId,
		});
	}

	private forgetRetainedManagedResult(runId: string): void {
		const retained = this.retainedManagedResults.get(runId);
		if (!retained) return;
		this.retainedManagedResults.delete(runId);
		this.releaseOutputArtifact(retained.result, retained.parentSessionId);
	}

	getRuntimeAttention(runId: string, parentSessionId: string): SubagentRuntimeAttention | undefined {
		const snapshot = this.getOwnedSupervisor(runId, parentSessionId)?.getSnapshot();
		return snapshot
			? Object.freeze({ ...snapshot, lastActivities: Object.freeze(snapshot.lastActivities.slice(-3)) })
			: undefined;
	}

	/**
	 * Observational snapshot of a live retained run. Peeking mutates no runtime
	 * budget and grants no authority; ownership is checked by parent session.
	 * Settled runs keep serving their bounded terminal observation from the
	 * retained-result ledger after supervisor cleanup.
	 */
	peekRuntime(runId: string, parentSessionId: string): SubagentManagedObservation | undefined {
		const supervisor = this.getOwnedSupervisor(runId, parentSessionId);
		if (supervisor) {
			const snapshot = supervisor.getSnapshot();
			const { childState, terminal } = projectSubagentManagementState(snapshot);
			const retained = terminal ? this.retainedManagedResults.get(runId) : undefined;
			return Object.freeze({
				runId,
				childState,
				terminal,
				waitExpired: false,
				attention: Object.freeze({
					...snapshot,
					lastActivities: Object.freeze(snapshot.lastActivities.slice(-3)),
				}),
				...(retained && retained.parentSessionId === parentSessionId ? { result: retained.result } : {}),
			});
		}
		const retained = this.retainedManagedResults.get(runId);
		if (retained && retained.parentSessionId === parentSessionId) {
			return Object.freeze({
				runId,
				childState: projectSubagentTerminalStatus(retained.result.status),
				terminal: true,
				waitExpired: false,
				result: retained.result,
			});
		}
		return undefined;
	}

	/**
	 * Wait for a terminal or attention child state for at most `waitMs`, then
	 * return the latest observation. Expiry sets `waitExpired` and never marks
	 * the child `timed_out`. Event driven through the supervisor lifecycle
	 * waiters; there is no polling loop.
	 */
	async waitRuntime(
		runId: string,
		parentSessionId: string,
		waitMs: number,
		signal?: AbortSignal,
	): Promise<SubagentManagedObservation> {
		if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS) {
			throw new SubagentError(
				"malformed_result",
				`Management wait must be an integer between 1 and ${SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS} ms.`,
			);
		}
		const supervisor = this.getOwnedSupervisor(runId, parentSessionId);
		if (!supervisor) {
			// A settled run can outlive its supervisor in the bounded retained
			// ledger; there is nothing left to wait for, so report it directly.
			const settled = this.peekRuntime(runId, parentSessionId);
			if (settled) return settled;
			throw new SubagentError(
				"child_protocol_failure",
				"The selected subagent is not a live retained run owned by this parent session.",
			);
		}
		const deadline = Date.now() + waitMs;
		for (;;) {
			const observation = this.peekRuntime(runId, parentSessionId);
			if (!observation) {
				throw new SubagentError(
					"child_protocol_failure",
					"The selected subagent is no longer a live retained run owned by this parent session.",
				);
			}
			// Attention states pause the child clock awaiting an explicit decision;
			// they are wait-satisfying states, not waiting-in-progress states.
			if (observation.childState !== "running") return observation;
			let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
			try {
				await Promise.race([
					supervisor.waitForLifecycleChange(signal),
					new Promise<void>((resolve) => {
						timer = globalThis.setTimeout(resolve, Math.max(0, deadline - Date.now()));
					}),
				]);
			} finally {
				if (timer) globalThis.clearTimeout(timer);
			}
			// Loop first so a terminal transition racing the deadline is reported
			// as the observed state; only a still-running child after the deadline
			// returns with waitExpired (a management expiry, never a child timeout).
			if (signal?.aborted) {
				// Parent cancellation stops the wait without inventing a child outcome.
				const cancelled = this.peekRuntime(runId, parentSessionId);
				if (!cancelled) {
					throw new SubagentError(
						"child_protocol_failure",
						"The selected subagent is no longer a live retained run owned by this parent session.",
					);
				}
				return cancelled;
			}
			if (Date.now() < deadline) continue;
			const afterDeadline = this.peekRuntime(runId, parentSessionId);
			if (!afterDeadline) {
				throw new SubagentError(
					"child_protocol_failure",
					"The selected subagent is no longer a live retained run owned by this parent session.",
				);
			}
			if (afterDeadline.childState !== "running") return afterDeadline;
			return Object.freeze({ ...afterDeadline, waitExpired: true });
		}
	}

	/**
	 * Retain the same child under management so the parent can continue other
	 * work, without a replacement child and without replaying the initial prompt.
	 * The same run ID, session, model, profile, scope, and tool authority
	 * continue. Detach is a bookkeeping decision only: it never changes runtime
	 * authority, budget, or lifecycle state.
	 * Idempotent per run.
	 */
	detachRuntime(runId: string, parentSessionId: string): SubagentManagedObservation | undefined {
		const supervisor = this.getOwnedSupervisor(runId, parentSessionId);
		if (!supervisor) {
			const retained = this.retainedChildren.get(runId);
			if (
				this.getRetainedManagedResult(runId, parentSessionId) ||
				(retained !== undefined && retained.parentSessionId === parentSessionId)
			) {
				throw new SubagentError(
					"child_protocol_failure",
					"The selected subagent is already terminal; detach is live-only.",
				);
			}
			return undefined;
		}
		const state = supervisor.stateValue;
		if (state === "terminal") {
			throw new SubagentError(
				"child_protocol_failure",
				"The selected subagent is already terminal; detach is live-only.",
			);
		}
		if (!this.detachedRuns.has(runId)) this.detachedRuns.set(runId, {});
		return this.peekRuntime(runId, parentSessionId);
	}

	/** Terminal result of a settled retained run; absent while the run is live. */
	getRetainedManagedResult(runId: string, parentSessionId: string): SubagentResult | undefined {
		const retained = this.retainedManagedResults.get(runId);
		return retained && retained.parentSessionId === parentSessionId ? retained.result : undefined;
	}

	/**
	 * Store a terminal managed result for post-terminal observation. Returns true
	 * only for the first publication of a run, which is the exactly-once guard
	 * shared by every managed terminal observer.
	 *
	 * The result ledger is keyed by managed run identity. A `resume` mints a new
	 * run id for the continued execution, so the superseded terminal handle keeps
	 * its own observation until it is explicitly deleted or evicted; it never
	 * masquerades as the resumed run.
	 */
	noteManagedTerminalResult(runId: string, parentSessionId: string, result: SubagentResult): boolean {
		if (this.activeResumeClaims.has(runId)) return false;
		if (this.retainedManagedResults.has(runId)) return false;
		this.retainedManagedResults.set(runId, { result, parentSessionId });
		this.detachedRuns.delete(runId);
		while (this.retainedManagedResults.size > SUBAGENT_RETAINED_RESULT_LIMIT) {
			const oldest = this.retainedManagedResults.keys().next().value;
			if (oldest === undefined) break;
			this.forgetRetainedManagedResult(oldest);
		}
		return true;
	}

	/**
	 * Publish a terminal result for a run whose terminal path is owned by the
	 * runner promise rather than a supervisor callback. This covers runs the
	 * parent stopped blocking on at launch time, so their completion is still
	 * observable through the retained-result ledger. It runs before the
	 * supervisor is terminated and unregistered, so a concurrent management wait
	 * never observes a gap between terminal state and the retained result.
	 * Idempotent.
	 */
	private async settleManagedRun(
		runId: string,
		parentSessionId: string,
		result: SubagentResult,
		onManagedResult?: (result: SubagentResult) => void | Promise<void>,
	): Promise<void> {
		if (!this.runtimeManagementEnabled) return;
		// A retry-safe startup failure is not terminal for the run: the shared
		// recovery loop re-attempts the same run ID.
		if (result.retrySafeStartup === true) return;
		// Retain before the terminal transition wakes any pending management wait,
		// so a waiter never observes terminal state without a retained result.
		const firstPublication = this.noteManagedTerminalResult(runId, parentSessionId, result);
		this.getOwnedSupervisor(runId, parentSessionId)?.finish(result, result.status);
		if (firstPublication && onManagedResult) {
			// Runner-owned terminal publication notifies durable observers exactly once.
			try {
				await onManagedResult(result);
			} catch {
				// Durable/job observers cannot change a terminal child result.
			}
		}
	}

	async stopRuntime(runId: string, parentSessionId: string): Promise<SubagentResult> {
		const supervisor = this.getOwnedSupervisor(runId, parentSessionId);
		if (!supervisor) {
			// A settled run outlives its supervisor in the bounded retained ledger;
			// stopping it again reports the same terminal result instead of failing.
			const settled = this.getRetainedManagedResult(runId, parentSessionId);
			if (settled) return settled;
			throw new SubagentError("child_protocol_failure", "The selected subagent is not running.");
		}
		return supervisor.stop("cancelled");
	}

	async followUpRuntime(
		runId: string,
		parentSessionId: string,
		requestId: string,
		message: string,
	): Promise<{ runId: string; status: "queued" | "duplicate" }> {
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requestId)) {
			throw new SubagentError("malformed_result", "Follow-up requestId must be a bounded stable identifier.");
		}
		if (message.trim().length === 0 || Buffer.byteLength(message) > 8 * 1024) {
			throw new SubagentError("malformed_result", "Follow-up message must be nonempty and at most 8 KiB.");
		}
		if (!this.getOwnedSupervisor(runId, parentSessionId)) {
			throw new SubagentError("child_protocol_failure", "The selected subagent is not owned by this parent.");
		}
		const entry = this.liveSessionRegistry?.get(runId);
		const control = entry?.control;
		if (!control?.followUp || control.getState() !== "working") {
			throw new SubagentError("child_protocol_failure", "The selected subagent is not accepting follow-up.");
		}
		if (control.isControlled()) {
			throw new SubagentError("child_protocol_failure", "User takeover currently owns the selected subagent.");
		}
		const requestIds = this.followUpRequests.get(runId) ?? new Set<string>();
		if (requestIds.has(requestId)) return { runId, status: "duplicate" };
		boundFollowUpBudget(requestIds);
		requestIds.add(requestId);
		this.followUpRequests.set(runId, requestIds);
		try {
			this.persistFollowUpLedger(runId, parentSessionId, requestIds);
		} catch (error) {
			requestIds.delete(requestId);
			if (requestIds.size === 0) this.followUpRequests.delete(runId);
			throw new SubagentError(
				"child_protocol_failure",
				`Could not durably record the follow-up budget before delivery: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		try {
			await control.followUp(message.trim());
			return { runId, status: "queued" };
		} catch (error) {
			requestIds.delete(requestId);
			if (requestIds.size === 0) this.followUpRequests.delete(runId);
			throw error;
		}
	}

	async shutdown(): Promise<void> {
		await this.supervisorRegistry.shutdownAll();
		this.supervisorOwners.clear();
		this.followUpRequests.clear();
		this.detachedRuns.clear();
		for (const runId of [...this.retainedManagedResults.keys()]) this.forgetRetainedManagedResult(runId);
		// Deterministic cleanup: await every retained session's shutdown event and dispose
		// rather than returning while disposal is still in flight.
		await Promise.allSettled(
			[...this.retainedChildren.values()].map((retained) => shutdownChildSession(retained.session)),
		);
		this.retainedChildren.clear();
		this.activeResumeClaims.clear();
	}

	/** Bounded retention of terminal children eligible for reuse or deletion. */
	/** True when a retained entry already owns this exact child session. */
	private hasRetainedSession(session: CreateAgentSessionResult["session"]): boolean {
		for (const value of this.retainedChildren.values()) {
			if (value.session === session) return true;
		}
		return false;
	}

	/** Drops any retained entry owning this exact child session, so no stale handle survives. */
	private dropRetainedSession(session: CreateAgentSessionResult["session"]): void {
		for (const [key, value] of this.retainedChildren) {
			if (value.session === session) {
				this.retainedChildren.delete(key);
				this.forgetRetainedManagedResult(key);
			}
		}
	}

	private async retainTerminalChild(child: RetainedSubagentSession): Promise<void> {
		// One retained entry per child session: a resume re-retains the same session under the
		// new run id, so the superseded entry must not linger as a stale handle.
		this.dropRetainedSession(child.session);
		this.retainedChildren.set(child.runId, child);
		while (this.retainedChildren.size > SUBAGENT_RETAINED_CHILD_LIMIT) {
			const oldest = this.retainedChildren.keys().next();
			if (oldest.done) break;
			const evicted = this.retainedChildren.get(oldest.value);
			this.retainedChildren.delete(oldest.value);
			// Eviction forgets the managed terminal observation and its output reference
			// as well, so a peek cannot outlive the retained session it describes.
			this.forgetRetainedManagedResult(oldest.value);
			this.detachedRuns.delete(oldest.value);
			if (evicted) await shutdownChildSession(evicted.session);
		}
	}

	/** Stage 3: continue a retained completed child in its original session and authority. */
	async resumeRuntime(
		runId: string,
		parentSessionId: string,
		message: string,
		parentActiveTools: readonly string[],
		options: NativeSubagentResumeOptions = {},
	): Promise<SubagentResult> {
		if (this.activeResumeClaims.has(runId)) {
			throw new SubagentError("child_protocol_failure", "The retained subagent is already resuming.");
		}
		const retained = this.retainedChildren.get(runId);
		if (!retained || retained.parentSessionId !== parentSessionId) {
			throw new SubagentError(
				"child_protocol_failure",
				"The selected subagent is not a retained terminal child owned by this parent session.",
			);
		}
		// Only a verified completion is reusable. Failed, cancelled, and timed-out terminal
		// children stay retained for inspection and deletion but cannot be resumed.
		if (!isReusableTerminalStatus(retained.terminalStatus)) {
			throw new SubagentError(
				"child_protocol_failure",
				`Only a completed retained subagent can be resumed; this one is ${retained.terminalStatus}.`,
			);
		}
		if (message.trim().length === 0 || Buffer.byteLength(message) > 8 * 1024) {
			throw new SubagentError("malformed_result", "Resume message must be nonempty and at most 8 KiB.");
		}
		if (retained.resumeCount >= SUBAGENT_RETAINED_RESUME_LIMIT) {
			throw new SubagentError(
				"child_protocol_failure",
				"The retained subagent has reached its reuse limit and must be deleted.",
			);
		}
		// Reject pre-start conditions before consuming the retained handle.
		if (!parentActiveTools.includes("delegate")) {
			throw new SubagentError("capability_denied", "Delegation is not active in the parent policy.");
		}
		if (options.signal?.aborted) {
			throw new SubagentError("cancellation", "Parent cancellation arrived before retained-child resume.");
		}
		this.revalidateResumedChild(retained, parentActiveTools);
		// A new run identity keeps verifySubagentResult lineage sound; the retained session keeps
		// its conversation history, and no resume parameter can widen the original authority.
		const request: NormalizedSubagentRequest = {
			...retained.request,
			runId: randomUUID(),
			task: message.trim(),
		};
		const { isAuthorityStillValidFor, createHookRuntimeFor, ...rest } = options;
		const hookRuntime = createHookRuntimeFor?.(request);
		// Fail closed before any resumed model turn when current authority has drifted. The
		// retained session's wrappers are rebound through its mutable execution-policy box below.
		if (isAuthorityStillValidFor && !isAuthorityStillValidFor(request, hookRuntime)) {
			throw new SubagentError(
				"capability_denied",
				"Current settings, trust, profile, resources, or hooks no longer authorize resuming this child.",
			);
		}
		retained.resumeCount += 1;
		// Claim the handle synchronously before the first await: while this execution is in
		// flight the superseded handle must reject both a second resume and a delete, and the
		// reused session must not be reachable through two identities at once. The old
		// terminal observation is forgotten at the same instant so the superseded run id
		// cannot keep serving a stale peekable result while its session is live again.
		this.retainedChildren.delete(runId);
		this.forgetRetainedManagedResult(runId);
		this.detachedRuns.delete(runId);
		this.activeResumeClaims.set(runId, request.runId);
		// Defence in depth beside `revalidateResumedChild`: the resumed run's policy carries the
		// intersection of the child's original tools with current parent authority, so a tool
		// removed since the original run fails closed at dispatch, not only at this boundary.
		const resumedMcpTools = new Set((retained.request.selectedMcpTools ?? []).map(subagentMcpToolName));
		const resumedEligibleTools = new Set(
			retained.tools.filter((tool) => parentActiveTools.includes(tool) || resumedMcpTools.has(tool)),
		);
		try {
			return await this.runResolved(request, parentActiveTools, {
				...rest,
				// Model, unsafe-exec, and trust state are reused verbatim: the resume surface
				// exposes no parameter that could widen the child's original authority.
				model: retained.model,
				unsafeHostExec: retained.unsafeHostExec,
				projectTrusted: retained.request.projectTrusted,
				hookRuntime,
				isAuthorityStillValid: isAuthorityStillValidFor
					? () => isAuthorityStillValidFor(request, hookRuntime)
					: undefined,
				resume: {
					session: retained.session,
					tools: retained.tools,
					resumedFromRunId: runId,
					resumeCount: retained.resumeCount,
					policyBox: retained.policyBox,
					eligibleTools: resumedEligibleTools,
				},
			});
		} catch (error) {
			// Restore the handle so a thrown execution cannot silently drop retained state.
			this.activeResumeClaims.delete(runId);
			if (!this.hasRetainedSession(retained.session)) this.retainedChildren.set(runId, retained);
			throw error;
		}
	}

	/** Fail-closed revalidation for reuse; mirrors the launch-time authority gates. */
	private revalidateResumedChild(retained: RetainedSubagentSession, parentActiveTools: readonly string[]): void {
		revalidateSubagentProfile(retained.request.profile);
		revalidateSubagentResources(retained.request.resources);
		if (retained.unsafeHostExec) {
			if (!retained.request.projectTrusted) {
				throw new SubagentError("capability_denied", "Unsafe subagent host execution requires a trusted project.");
			}
			if (!parentActiveTools.includes("bash")) {
				throw new SubagentError(
					"capability_denied",
					"Unsafe subagent host execution requires parent Bash capability.",
				);
			}
		}
		const mcpToolNames = new Set((retained.request.selectedMcpTools ?? []).map(subagentMcpToolName));
		if (retained.request.mcpAuthorityStillValid?.() === false) {
			throw new SubagentError("capability_denied", "Selected MCP authority changed since the child was retained.");
		}
		for (const delegated of retained.request.delegatedTools ?? []) {
			if (!delegated.isCurrent() || !parentActiveTools.includes(delegated.name)) {
				throw new SubagentError("capability_denied", `Delegated tool ${delegated.name} was revoked.`);
			}
		}
		// Ordinary child tools must still be active in the parent. MCP definitions are synthetic
		// child names and are validated by the captured MCP authority fingerprint above.
		const revokedTools = retained.tools.filter(
			(tool) => !mcpToolNames.has(tool) && !parentActiveTools.includes(tool),
		);
		if (revokedTools.length > 0) {
			throw new SubagentError(
				"capability_denied",
				`Resumed child tool authority is no longer active in the parent: ${revokedTools.join(", ")}.`,
			);
		}
	}

	/**
	 * Stage 4: owner-scoped, idempotent removal of a retained terminal child.
	 * Forgets the reusable session, the managed terminal observation, and any
	 * detached multiplexing handle together: after a successful delete no
	 * management operation may keep serving the forgotten run's result.
	 */
	async deleteRetainedChild(runId: string, parentSessionId: string): Promise<{ runId: string; deleted: boolean }> {
		// A handle claimed by an in-flight resume is still active: deleting it would dispose
		// the session underneath the running execution.
		if (this.activeResumeClaims.has(runId)) {
			throw new SubagentError(
				"child_protocol_failure",
				"The selected subagent is still active; stop it before deleting.",
			);
		}
		const retained = this.retainedChildren.get(runId);
		if (!retained) {
			if (this.supervisorOwners.get(runId) === parentSessionId) {
				throw new SubagentError(
					"child_protocol_failure",
					"The selected subagent is still active; stop it before deleting.",
				);
			}
			// Idempotent: an unknown or already-forgotten child session is not an error.
			// A terminal observation without a retained session (for example, a startup
			// failure) remains observable through peek; there is no session to delete.
			return { runId, deleted: false };
		}
		if (retained.parentSessionId !== parentSessionId) {
			throw new SubagentError(
				"child_protocol_failure",
				"The selected subagent is not a retained terminal child owned by this parent session.",
			);
		}
		this.retainedChildren.delete(runId);
		this.forgetRetainedManagedResult(runId);
		this.detachedRuns.delete(runId);
		this.agentViewBridge?.removeHistoricalSnapshot(runId);
		await shutdownChildSession(retained.session);
		return { runId, deleted: true };
	}

	/** Bounded metadata for the retained terminal children of one parent session. */
	listRetainedChildren(parentSessionId: string): readonly RetainedSubagentChild[] {
		return Object.freeze(
			[...this.retainedChildren.values()]
				.filter((child) => child.parentSessionId === parentSessionId)
				.map((child) =>
					Object.freeze({
						runId: child.runId,
						role: child.role,
						terminalStatus: child.terminalStatus,
						finishedAt: child.finishedAt,
						resumeCount: child.resumeCount,
					}),
				),
		);
	}

	/** Owner-scoped live supervisor lookup. Public so the phase-aware `manage_subagent`
	 * dispatcher can gate live-only actions (detach/stop) against terminal-only
	 * actions (resume/delete) without reaching into the registry. */
	getOwnedSupervisor(runId: string, parentSessionId: string): SubagentRunSupervisor<SubagentResult> | undefined {
		if (this.supervisorOwners.get(runId) !== parentSessionId) return undefined;
		return this.supervisorRegistry.get(runId);
	}

	async run(
		request: SubagentRequest,
		parentActiveTools: readonly string[],
		options: NativeSubagentRunOptions = {},
	): Promise<SubagentResult> {
		const normalized = normalizeSubagentRequest(request, request.cwd ?? process.cwd(), {
			agentDir: this.agentDir,
			projectTrusted: options.projectTrusted,
			settingsManager: options.settingsManager,
		});
		return this.runResolved(normalized, parentActiveTools, options);
	}

	async runResolved(
		normalized: NormalizedSubagentRequest,
		parentActiveTools: readonly string[],
		options: NativeSubagentRunOptions = {},
	): Promise<SubagentResult> {
		const result = await this.runResolvedInternal(normalized, parentActiveTools, options);
		await flushSubagentHookObservations(options.hookRuntime);
		const records = options.hookRuntime?.records;
		return records && records.length > 0 ? { ...result, hookRecords: Object.freeze([...records]) } : result;
	}

	private async runResolvedInternal(
		normalized: NormalizedSubagentRequest,
		parentActiveTools: readonly string[],
		options: NativeSubagentRunOptions = {},
	): Promise<SubagentResult> {
		const runId = normalized.runId;
		const publicManagementEnabled = this.runtimeManagementEnabled && options.management !== "internal";
		// Batch/review children are internal for lifecycle management, but they still need
		// live observability when the host installed the view registry. Internal means
		// "no public handle or retention", not "hide the work while it is running".
		const agentViewEnabled = options.management !== "internal" || this.liveSessionRegistry !== undefined;
		const historicalAgentViewEnabled = options.management !== "internal";
		const attemptDeadline = Date.now() + normalized.timeoutMs;
		const profile = normalized.profile;
		const startedAt = Date.now();
		const base = {
			runId,
			parentSessionId: normalized.parentSessionId,
			profile: profile.name,
			color: profile.color,
			source: profile.source,
			batchId: options.batchId,
			model: modelLabel(options.model),
			attempt: options.attempt,
			...(options.resume ? { resumedFromRunId: options.resume.resumedFromRunId } : {}),
			observedOutputBytes: 0,
			reportMode: normalized.reportMode,
			qualityMode: normalized.qualityMode,
			taskContractHash: normalized.taskContractHash,
			contextManifestHash: normalized.contextManifest?.hash,
			reasoningLevel: normalized.execution.thinking,
			followUpCount: 0,
			...(normalized.scope.targets?.length ? { scopeTargets: [...normalized.scope.targets] } : {}),
		};
		if (!parentActiveTools.includes("delegate")) {
			return {
				...base,
				status: "failed",
				summary: "Delegation is not active in the parent policy.",
				partial: false,
				diagnostics: [{ code: "capability_denied", message: "Parent policy does not activate delegate." }],
			};
		}
		if (options.signal?.aborted) {
			return {
				...base,
				status: "cancelled",
				summary: "Subagent cancelled before startup.",
				partial: true,
				diagnostics: [{ code: "cancellation", message: "Parent cancellation arrived before child startup." }],
			};
		}

		// One mutable policy box per child session. A fresh run installs it; a resumed run re-points
		// the box the original run's wrappers already read, so a reused `AgentSession` dispatches
		// against current hooks, authority, and budgets instead of inheriting the original run's
		// closures. Declared before the terminal cleanup below, which publishes the same box with
		// the retained child so a later resume re-points the very box those wrappers hold.
		const policyBox: SubagentExecutionPolicyBox = options.resume?.policyBox ?? {
			current: { eligibleTools: new Set<string>(), strictEligibility: false },
		};
		let childSession: NativeSubagentSession["session"] | undefined;
		let observedOutputBytes = 0;
		let control: "cancelled" | "timed_out" | undefined;
		let resolveControl: ((reason: "cancelled" | "timed_out") => void) | undefined;
		let removeAbortListener: (() => void) | undefined;
		let supervisor: SubagentRunSupervisor<SubagentResult> | undefined;
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		let cleanupPromise: Promise<void> | undefined;
		let unsubscribeChild: (() => void) | undefined;
		let releaseLiveSession: (() => void) | undefined;
		let retainedChildTools: readonly string[] = [];
		let liveControl: IceAgentViewLiveSessionControl | undefined;
		let childToolFailed = false;
		const runDiagnostics: SubagentDiagnostic[] = [];
		let reportOnly = false;
		let authorityRevoked = false;
		let lastProgressAt = 0;
		let retryState: SubagentRetryState | undefined;
		let wrapUpRequested = false;
		let wrapUpPromptStarted = false;
		let terminalStatus: string | undefined;
		// Terminal result of this attempt, captured before teardown so the retained
		// ledger is populated ahead of supervisor cleanup.
		let settledTerminalResult: SubagentResult | undefined;
		// Per-child turn and tool-call ceilings were intentionally removed. Keep
		// observed turn telemetry and reserve only the final wall-clock window so
		// the child can finish a useful answer before its real timeout.
		let observedTurns = 0;
		// Phase 5.4: bounded ledger of successful bash commands actually executed
		// by this child, used to verify declared verification commands. Redacted
		// and capped; failures are never recorded as executed.
		const observedBashCommands: { command: string }[] = [];
		const pendingBashCommands = new Map<string, string>();
		// Phase 5.3: bounded set of paths the child actually observed with tools,
		// used to validate claimed evidence paths against runtime-observed state.
		const observedEvidencePaths: string[] = [];
		const wrapUpWallReserveMs = Math.min(
			SUBAGENT_WRAP_UP_LIMITS.maximumWallReserveMs,
			Math.max(
				SUBAGENT_WRAP_UP_LIMITS.minimumWallReserveMs,
				Math.floor(normalized.timeoutMs * SUBAGENT_WRAP_UP_LIMITS.wallReserveRatio),
			),
		);
		const requestWrapUpIfNeeded = (): boolean => {
			if (
				options.noLifetimeTimeout ||
				wrapUpRequested ||
				wrapUpPromptStarted ||
				reportOnly ||
				liveControl?.isControlled()
			)
				return false;
			const wallThreshold = Date.now() >= attemptDeadline - wrapUpWallReserveMs;
			if (!wallThreshold) return false;
			wrapUpRequested = true;
			supervisor?.setPhase("wrapping_up");
			emit("subagent_wrap_up", "running");
			return true;
		};
		let childAbortPromise: Promise<void> | undefined;
		const abortChild = async (): Promise<void> => {
			if (!childAbortPromise) {
				const pending = abortChildSession(childSession!);
				childAbortPromise = pending;
				void pending.finally(() => {
					if (childAbortPromise === pending) childAbortPromise = undefined;
				});
			}
			await childAbortPromise;
		};
		let presentation: IceAgentViewPresentation | undefined;
		const updatePresentation = (patch: IceAgentViewPresentationPatch): void => {
			presentation = normalizeIceAgentViewPresentation({ ...presentation, ...patch });
			this.liveSessionRegistry?.updatePresentation(runId, patch);
		};
		const cleanupTerminalSession = async (): Promise<void> => {
			if (cleanupPromise) return cleanupPromise;
			cleanupPromise = (async () => {
				removeAbortListener?.();
				removeAbortListener = undefined;
				unsubscribeChild?.();
				unsubscribeChild = undefined;
				liveControl?.markTerminal();
				if (historicalAgentViewEnabled && childSession && terminalStatus) {
					presentation = presentation
						? normalizeIceAgentViewPresentation({ ...presentation, compacting: false })
						: presentation;
					this.agentViewBridge?.registerHistoricalSnapshot({
						runId,
						role: profile.name,
						color: profile.color,
						taskId: options.taskId,
						model: modelLabel(options.model ?? childSession.model),
						authority: options.unsafeHostExec === true ? "yolo" : "safe",
						status: terminalStatus,
						retentionState: isReusableTerminalStatus(terminalStatus) ? "reusable" : "history-only",
						startedAt,
						finishedAt: Date.now(),
						presentation,
						messages: childSession.messages,
						cwd: normalized.cwd,
					});
				}
				releaseLiveSession?.();
				releaseLiveSession = undefined;
				supervisor?.terminate(terminalStatus ?? "completed");
				this.supervisorRegistry.remove(runId);
				this.supervisorOwners.delete(runId);
				this.followUpRequests.delete(runId);
				if (childSession) {
					// Every terminal child with a session remains inspectable and deletable. Only verified
					// completions are reusable; failed, cancelled, and timed-out children are history-only.
					// The resume claim ends here; retention republishes exactly one handle.
					if (options.resume) this.activeResumeClaims.delete(options.resume.resumedFromRunId);
					const keepRetained = options.management !== "internal" && terminalStatus !== undefined;
					if (keepRetained) {
						await this.retainTerminalChild({
							runId,
							parentSessionId: normalized.parentSessionId,
							role: profile.name,
							terminalStatus: terminalStatus ?? "completed",
							finishedAt: Date.now(),
							resumeCount: options.resume?.resumeCount ?? 0,
							session: childSession,
							tools: retainedChildTools,
							request: normalized,
							model: options.model,
							unsafeHostExec: options.unsafeHostExec === true,
							policyBox,
						});
					} else {
						this.dropRetainedSession(childSession);
						await shutdownChildSession(childSession);
					}
				}
			})();
			return cleanupPromise;
		};
		const emit = (
			type: SubagentEvent["type"],
			status: SubagentStatus,
			toolName?: string,
			path?: string,
			toolCallId?: string,
			attention?: SubagentRuntimeAttention,
			compaction?: {
				reason: SubagentCompactionReason;
				status: SubagentCompactionStatus;
				willRetry?: boolean;
			},
			retry?: SubagentRetryState,
		) => {
			if (
				type === "subagent_completed" ||
				type === "subagent_failed" ||
				type === "subagent_cancelled" ||
				type === "subagent_timed_out"
			) {
				terminalStatus = status;
			}
			const safePath = displayScopedSubagentPath(normalized.cwd, normalized.scope.roots, path);
			options.onEvent?.({
				...base,
				type,
				status,
				childSessionId: childSession?.sessionId,
				toolName,
				...(toolCallId ? { toolCallId } : {}),
				...(safePath ? { path: safePath } : {}),
				...(attention ? { attention } : {}),
				...(compaction
					? {
							compactionReason: compaction.reason,
							compactionStatus: compaction.status,
							...(compaction.willRetry !== undefined ? { compactionWillRetry: compaction.willRetry } : {}),
						}
					: {}),
				...(retry ? { retry } : {}),
			});
		};
		const observeAssistantText = (): string => {
			const text = extractAssistantText(childSession?.messages ?? []);
			observedOutputBytes = Buffer.byteLength(text);
			return text;
		};
		const materializeOutput = (
			text: string,
			contentType: "text/plain" | "application/json" = "text/plain",
		): SubagentOutput =>
			this.outputArtifacts.capture({
				ownerSessionId: normalized.parentSessionId,
				text,
				contentType,
				lifecycle: options.outputArtifactLifecycle ?? "process_local",
			});
		const releaseOutput = (result: SubagentResult): void => {
			this.releaseOutputArtifact(
				result,
				normalized.parentSessionId,
				options.outputArtifactLifecycle === "durable" ? "durable" : "capture",
			);
		};
		const observeUsage = (): SubagentUsage | undefined => {
			if (!childSession) return undefined;
			try {
				const stats = childSession.getSessionStats();
				return {
					inputTokens: stats.tokens.input,
					outputTokens: stats.tokens.output,
					cacheReadTokens: stats.tokens.cacheRead,
					cacheWriteTokens: stats.tokens.cacheWrite,
					cost: stats.cost,
				};
			} catch {
				return undefined;
			}
		};
		emit("subagent_created", "created");

		const activeToolActivities = new Map<string, SubagentToolActivityDigest>();
		const touchedPaths = new Set<string>();
		const recordTouchedPath = (toolName: string, path: string | undefined): void => {
			if (!path) return;
			const normalizedTool = toolName.toLowerCase();
			if (normalizedTool !== "write" && normalizedTool !== "edit") return;
			if (touchedPaths.size >= SUBAGENT_REPORT_LIMITS.maxEvidencePaths) return;
			touchedPaths.add(path);
		};
		/**
		 * Build the runtime-owned bounded work artifact from observed activity.
		 * It is derived from tool events and report protocol state only, never from
		 * model-claimed content, so a report failure cannot erase real work.
		 */
		const buildWorkArtifact = (
			reportProtocol: SubagentWorkArtifact["reportProtocol"],
			options: {
				candidateEvidencePaths?: readonly string[];
				requirementClaims?: readonly SubagentRequirementClaim[];
				terminal: boolean;
			} = { terminal: true },
		): SubagentWorkArtifact => {
			const lastActivities = supervisor
				? supervisor.getSnapshot().lastActivities.slice(-SUBAGENT_REPORT_LIMITS.maxEvidencePaths)
				: [...activeToolActivities.values()].slice(-SUBAGENT_REPORT_LIMITS.maxEvidencePaths);
			return Object.freeze({
				schemaVersion: 1,
				runId,
				...(childSession ? { childSessionId: childSession.sessionId } : {}),
				profile: profile.name,
				startedAtMs: startedAt,
				...(options.terminal ? { finishedAtMs: Date.now() } : {}),
				lastActivities: Object.freeze(lastActivities.slice(-12)),
				observedOutputBytes,
				touchedPaths: Object.freeze([...touchedPaths].slice(0, SUBAGENT_REPORT_LIMITS.maxEvidencePaths)),
				candidateEvidencePaths: Object.freeze(
					(options.candidateEvidencePaths ?? []).slice(0, CANDIDATE_EVIDENCE_PATH_LIMIT),
				),
				reportProtocol: Object.freeze({
					status: reportProtocol.status,
					...(reportProtocol.diagnostic ? { diagnostic: reportProtocol.diagnostic } : {}),
				}),
				...(options.requirementClaims && options.requirementClaims.length > 0
					? { requirementClaims: Object.freeze(options.requirementClaims) }
					: {}),
			});
		};
		let terminalHookObserved = false;
		let observeTerminalHook: (result?: SubagentResult) => Promise<void> = async () => {};
		const decorateSubagentResult = (result: SubagentResult): SubagentResult => {
			const usage = observeUsage();
			const hookRecords = options.hookRuntime ? Object.freeze(options.hookRuntime.records.slice()) : undefined;
			return {
				...result,
				diagnostics: [
					...result.diagnostics,
					...runDiagnostics.filter(
						(diagnostic) => !result.diagnostics.some((entry) => entry.message === diagnostic.message),
					),
				],
				...(usage ? { usage } : {}),
				observedTurns,
				...(hookRecords && hookRecords.length > 0 ? { hookRecords } : {}),
			};
		};

		try {
			const mcpRuntime = resolveSubagentMcpRuntime(
				{
					adapter: this.mcpAdapter,
					dispatch: options.mcpDispatch,
					parentMcpTools: options.parentMcpTools,
					mcpToolAccess: options.mcpToolAccess,
				},
				normalized.selectedMcpTools ?? [],
				options.unsafeHostExec === true,
			);
			policyBox.current = {
				beforeTool: async (toolName, toolCallId, params, signal) => {
					if (reportOnly)
						throw new SubagentError("capability_denied", "Report finalization cannot execute tools.");
					if (options.isAuthorityStillValid && !(await options.isAuthorityStillValid())) {
						authorityRevoked = true;
						throw new SubagentError(
							"capability_denied",
							"Current parent settings or trust no longer authorize this child tool dispatch.",
						);
					}
					await dispatchSubagentHookDecision(
						options.hookRuntime ? { ...options.hookRuntime, attempt: options.attempt } : undefined,
						"subagent.beforeTool",
						{ toolName, toolCallId, params },
						signal,
					);
					if (signal?.aborted || (options.isAuthorityStillValid && !(await options.isAuthorityStillValid()))) {
						authorityRevoked = true;
						throw new SubagentError("capability_denied", "Authority changed while awaiting a tool policy hook.");
					}
				},
				reportOnly: () => reportOnly,
				shouldStopAfterTurn: async () => {
					if (options.isAuthorityStillValid && !(await options.isAuthorityStillValid())) {
						authorityRevoked = true;
						return true;
					}
					return requestWrapUpIfNeeded();
				},
				// A resumed child re-checks every wrapped tool against current parent authority; a fresh
				// child relies on the eligible set applied when its definitions were built.
				eligibleTools: options.resume?.eligibleTools ?? policyBox.current.eligibleTools,
				strictEligibility: options.resume !== undefined,
			};
			const startupPromise = options.resume
				? Promise.resolve<NativeSubagentSession>({
						session: options.resume.session,
						profile,
						tools: [...options.resume.tools],
						prompt: normalized.task,
					})
				: createNativeSubagentSession(
						{
							request: normalized,
							parentActiveTools,
							noLifetimeTimeout: options.noLifetimeTimeout,
							model: options.model,
							modelRuntime: options.modelRuntime,
							agentDir: this.agentDir,
							retrySettings: options.settingsManager?.getRetrySettings(),
							unsafeHostExec: options.unsafeHostExec,
							mcpDispatch: mcpRuntime.dispatch,
							parentMcpTools: mcpRuntime.parentMcpTools,
							mcpToolAccess: mcpRuntime.mcpToolAccess,
							hookRuntime: options.hookRuntime
								? { ...options.hookRuntime, attempt: options.attempt }
								: undefined,
							policyBox,
						},
						this.createSession,
					);
			const startup = await awaitSubagentStartup(startupPromise, normalized.timeoutMs, options.signal);
			if (startup.kind !== "completed") {
				if (startup.kind === "error") throw startup.error;
				void startupPromise.then(
					async (created) => {
						try {
							await abortChildSession(created.session);
						} finally {
							await shutdownChildSession(created.session);
						}
					},
					() => {},
				);
				if (startup.kind === "cancelled") control = "cancelled";
				const status = startup.kind === "cancelled" ? "cancelled" : "failed";
				emit(status === "cancelled" ? "subagent_cancelled" : "subagent_failed", status);
				return {
					...base,
					status,
					summary:
						startup.kind === "cancelled"
							? "Subagent cancelled during startup."
							: "Subagent startup deadline exceeded.",
					partial: true,
					diagnostics: [
						{
							code: status === "cancelled" ? "cancellation" : "timeout",
							message:
								status === "cancelled" ? "Child cancelled during startup." : "Child startup deadline exceeded.",
						},
					],
				};
			}
			const created = startup.value;
			childSession = created.session;
			retainedChildTools = created.tools;
			if (created.diagnostics) runDiagnostics.push(...created.diagnostics);
			presentation = normalizeIceAgentViewPresentation({
				delegatedTask: normalized.task,
				scopeLabels: normalized.scope.roots.map((root) => relative(normalized.cwd, root) || "."),
				authority: options.unsafeHostExec === true ? "yolo" : "safe",
				reportMode: normalized.reportMode,
				// Plain mode streams the child's natural answer, so internal
				// final-report text is only hidden while the structured protocol runs.
				protocolReportPending: normalized.reportMode === "structured_report",
				handoffMessageMarker: SUBAGENT_HANDOFF_MARKER,
				finalizationMessageMarker: INTERACTIVE_FINAL_REPORT_MARKER,
				wrapUpMessageMarker: SUBAGENT_WRAP_UP_MARKER,
				handoffMessageIndex: childSession.messages.length,
			});
			liveControl = createSubagentLiveSessionControl(
				childSession,
				() => this.liveSessionRegistry?.notify(),
				() => updatePresentation({ protocolReportPending: false }),
			);
			unsubscribeChild = childSession.subscribe((event: AgentSessionEvent) => {
				if (event.type === "auto_retry_start") {
					const diagnostic = truncateSubagentOutput(redactCredentialText(event.errorMessage), 512).text;
					retryState = Object.freeze({
						state: "scheduled" as const,
						attempt: event.attempt,
						maxAttempts: event.maxAttempts,
						delayMs: event.delayMs,
						...(diagnostic ? { diagnostic } : {}),
					});
					updatePresentation({ retry: retryState });
					emit("subagent_retry", "running", undefined, undefined, undefined, undefined, undefined, retryState);
					return;
				}
				if (event.type === "auto_retry_end") {
					const diagnostic = event.finalError
						? truncateSubagentOutput(redactCredentialText(event.finalError), 512).text
						: undefined;
					retryState = Object.freeze({
						state: event.success ? ("recovered" as const) : ("failed" as const),
						attempt: event.attempt,
						maxAttempts: retryState?.maxAttempts ?? event.attempt,
						...(retryState?.delayMs !== undefined ? { delayMs: retryState.delayMs } : {}),
						...(diagnostic ? { diagnostic } : {}),
					});
					updatePresentation({ retry: retryState });
					emit("subagent_retry", "running", undefined, undefined, undefined, undefined, undefined, retryState);
					return;
				}
				if (event.type === "turn_start") {
					observedTurns += 1;
				} else if (event.type === "tool_execution_start") {
					const activity = buildSubagentToolActivityDigest(
						event.toolCallId,
						event.toolName,
						event.args,
						normalized.cwd,
						normalized.scope.roots,
						"running",
						Date.now(),
					);
					if (event.toolName.toLowerCase() === "bash") {
						const command = truncateSubagentOutput(
							redactCredentialText(stringToolArgument(event.args, "command", "cmd") ?? ""),
							2 * 1024,
						).text;
						if (command) pendingBashCommands.set(event.toolCallId, command);
					}
					activeToolActivities.set(event.toolCallId, activity);
					supervisor?.recordActivity(activity);
					emit(
						"subagent_tool_start",
						"running",
						event.toolName,
						extractProgressPath(event.args),
						event.toolCallId,
					);
				} else if (event.type === "tool_execution_end") {
					childToolFailed ||= event.isError;
					const started = activeToolActivities.get(event.toolCallId);
					if (started) {
						const isBash = started.toolName.toLowerCase() === "bash";
						const exitCode = isBash && event.isError ? extractBashExitCode(event.result) : undefined;
						const activity = Object.freeze({
							...started,
							status: (event.isError ? "error" : "ok") as SubagentToolActivityDigest["status"],
							finishedAtMs: Date.now(),
							...(exitCode !== undefined ? { exitCode } : {}),
							...(event.isError ? { errorClass: isBash ? "command_failed" : "tool_failed" } : {}),
						});
						activeToolActivities.set(event.toolCallId, activity);
						supervisor?.recordActivity(activity);
						recordTouchedPath(started.toolName, started.path);
						const pendingCommand = pendingBashCommands.get(event.toolCallId);
						pendingBashCommands.delete(event.toolCallId);
						if (isBash && pendingCommand && !event.isError) {
							observedBashCommands.push({ command: pendingCommand });
							if (observedBashCommands.length > 16) observedBashCommands.shift();
						}
						if (started.path && !event.isError) {
							observedEvidencePaths.push(started.path);
							if (observedEvidencePaths.length > SUBAGENT_REPORT_LIMITS.maxEvidencePaths)
								observedEvidencePaths.shift();
						}
					}
					emit("subagent_tool_end", "running", event.toolName, started?.path, event.toolCallId);
					dispatchSubagentHookObservation(
						options.hookRuntime!,
						"subagent.afterTool",
						{
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							isError: event.isError,
							path: started?.path,
						},
						options.signal,
					);
				} else if (event.type === "compaction_start") {
					updatePresentation({ compacting: true });
					emit("subagent_compaction_start", "running", undefined, undefined, undefined, undefined, {
						reason: event.reason,
						status: "started",
					});
				} else if (event.type === "compaction_end") {
					updatePresentation({ compacting: false });
					emit("subagent_compaction_end", "running", undefined, undefined, undefined, undefined, {
						reason: event.reason,
						status: event.aborted ? "aborted" : event.result ? "completed" : "failed",
						willRetry: event.willRetry,
					});
				} else if (event.type === "message_update") {
					observedOutputBytes = Buffer.byteLength(extractAssistantText(childSession?.messages ?? []));
					if (Date.now() - lastProgressAt >= 250) {
						lastProgressAt = Date.now();
						emit("subagent_progress", "running");
						dispatchSubagentHookObservation(
							options.hookRuntime!,
							"subagent.checkpoint",
							{
								phase: supervisor?.getSnapshot().phase ?? "working",
								observedOutputBytes,
								observedTurns,
							},
							options.signal,
						);
					}
				}
			});
			if (!childSession.model) {
				throw new SubagentError("model_unavailable", "No model is available for the child session.");
			}
			if (options.signal?.aborted) {
				control = "cancelled";
				await abortChildSession(childSession);
				emit("subagent_cancelled", "cancelled");
				return {
					...base,
					childSessionId: childSession.sessionId,
					status: "cancelled",
					summary: "Subagent cancelled before prompting.",
					partial: true,
					diagnostics: [{ code: "cancellation", message: "Parent cancellation arrived before prompting." }],
				};
			}

			let stopAfterSupervisor: ((reason: SubagentSupervisorStopReason) => Promise<SubagentResult>) | undefined;
			const baseLiveControl = liveControl;
			if (publicManagementEnabled) {
				supervisor = new SubagentRunSupervisor<SubagentResult>({
					runId,
					childSessionId: childSession.sessionId,
					phase: "working",
					abort: abortChild,
					stop: async (reason) => {
						if (!stopAfterSupervisor) throw new Error(`Subagent run ${runId} has no terminal continuation.`);
						return decorateSubagentResult(await stopAfterSupervisor(reason));
					},
					onChange: (snapshot) => {
						const attention = {
							...snapshot,
							lastActivities: Object.freeze(snapshot.lastActivities.slice(-3)),
						};
						updatePresentation({ runtimeAttention: attention });
						try {
							options.onRuntimeAttention?.(attention);
						} catch {
							// Lifecycle observers are advisory and cannot affect child execution.
						}
					},
				});
				this.supervisorRegistry.register(supervisor);
				this.supervisorOwners.set(runId, normalized.parentSessionId);
				try {
					options.onManagedHandle?.({ runId, childSessionId: childSession.sessionId });
				} catch {
					// Admission observers cannot affect child execution.
				}
				liveControl = baseLiveControl
					? {
							...baseLiveControl,
							setControlled: (controlled) => {
								baseLiveControl.setControlled(controlled);
								if (controlled && !childSession!.isStreaming) supervisor?.pauseForControlledWait();
								else if (!controlled) supervisor?.resumeFromControlledWait();
							},
							steer: async (text) => {
								supervisor?.resumeFromControlledWait();
								try {
									await baseLiveControl.steer(text);
								} finally {
									if (baseLiveControl.isControlled() && !childSession!.isStreaming)
										supervisor?.pauseForControlledWait();
								}
								try {
									options.onSteering?.(runId);
								} catch {
									// Telemetry observers are advisory and cannot affect steering.
								}
							},
							getRuntimeAttention: () => supervisor?.getSnapshot(),
							stopRuntime: () => this.stopRuntime(runId, normalized.parentSessionId),
						}
					: undefined;
			}
			releaseLiveSession = agentViewEnabled
				? this.liveSessionRegistry?.register({
						runId,
						role: profile.name,
						color: profile.color,
						taskId: options.taskId,
						model: modelLabel(options.model ?? childSession.model),
						authority: options.unsafeHostExec === true ? "yolo" : "safe",
						presentation,
						session: childSession,
						control: liveControl,
					})
				: undefined;
			emit("subagent_started", "running");
			dispatchSubagentHookObservation(
				options.hookRuntime!,
				"subagent.started",
				{
					childSessionId: childSession.sessionId,
					role: normalized.role,
					tools: created.tools,
				},
				options.signal,
			);

			type PromptOutcome =
				| { kind: "completed" }
				| { kind: "error"; error: unknown }
				| { kind: "cancelled" | "timed_out" };
			const controlPromise = new Promise<"cancelled" | "timed_out">((resolveControlPromise) => {
				resolveControl = resolveControlPromise;
			});
			const abortListener = (): void => {
				resolveControl?.("cancelled");
			};
			if (options.signal) {
				options.signal.addEventListener("abort", abortListener, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", abortListener);
			}
			const awaitPrompt = async (promptPromise: Promise<void>): Promise<PromptOutcome> => {
				void promptPromise.catch(() => {});
				const races: Array<Promise<PromptOutcome>> = [
					promptPromise.then(
						() => ({ kind: "completed" as const }),
						(error: unknown) => ({ kind: "error" as const, error }),
					),
					controlPromise.then((reason) => ({ kind: reason })),
				];
				return Promise.race(races);
			};
			let controlledFailurePromise: Promise<SubagentResult> | undefined;
			const structuredReportMode = normalized.reportMode === "structured_report";
			const finalDeliverableNoun = structuredReportMode ? "report" : "answer";
			const missingDeliverableTarget = structuredReportMode
				? "a valid final envelope"
				: "a nonempty final assistant answer";
			const controlledFailure = (reason: "cancelled" | "timed_out"): Promise<SubagentResult> => {
				if (controlledFailurePromise) return controlledFailurePromise;
				controlledFailurePromise = (async () => {
					control = reason;
					await abortChild();
					const status = reason === "cancelled" ? "cancelled" : reason === "timed_out" ? "timed_out" : "failed";
					emit(
						status === "cancelled"
							? "subagent_cancelled"
							: status === "timed_out"
								? "subagent_timed_out"
								: "subagent_failed",
						status,
					);
					const diagnosticMessage =
						reason === "timed_out"
							? structuredReportMode
								? `Child reached its ${normalized.timeoutMs} ms wall-clock timeout before a verified bounded report completed.`
								: `Child reached its ${normalized.timeoutMs} ms wall-clock timeout before a final assistant answer completed.`
							: structuredReportMode
								? "Child was cancelled before a verified bounded report completed."
								: "Child was cancelled before a final assistant answer completed.";
					updatePresentation({
						finalizationStarted: false,
						protocolReportPending: false,
						finalResult: { status, diagnostic: diagnosticMessage },
					});
					observeAssistantText();
					return {
						...base,
						childSessionId: childSession!.sessionId,
						status,
						summary: diagnosticMessage,
						observedOutputBytes,
						partial: true,
						workArtifact: buildWorkArtifact(
							{
								status: "missing",
								diagnostic:
									reason === "cancelled"
										? `No final ${finalDeliverableNoun}: the child was cancelled before ${missingDeliverableTarget}.`
										: reason === "timed_out"
											? `No final ${finalDeliverableNoun}: the child reached its wall-clock timeout before ${missingDeliverableTarget}.`
											: `No final ${finalDeliverableNoun}: the child ended before ${missingDeliverableTarget}.`,
							},
							{ terminal: true },
						),
						diagnostics: [
							{
								code: reason === "cancelled" ? "cancellation" : "timeout",
								message: diagnosticMessage,
							},
						],
					};
				})();
				return controlledFailurePromise;
			};
			const buildFailureResult = (error: unknown): SubagentResult => {
				const failure = classifySubagentFailure(error, childSession ? "runtime" : "startup", childToolFailed);
				const diagnostic = {
					code: failure.code,
					message: failure.message,
					...(failure.retryable ? { retryable: true } : {}),
				};
				if (childSession) observeAssistantText();
				const usage = observeUsage();
				const status = control === "cancelled" ? "cancelled" : control === "timed_out" ? "timed_out" : "failed";
				if (childSession) {
					updatePresentation({
						finalizationStarted: false,
						protocolReportPending: false,
						finalResult: { status, diagnostic: diagnostic.message },
					});
				}
				emit(
					status === "cancelled"
						? "subagent_cancelled"
						: status === "timed_out"
							? "subagent_timed_out"
							: "subagent_failed",
					status,
				);
				return {
					...base,
					childSessionId: childSession?.sessionId,
					status,
					summary: diagnostic.message,
					observedOutputBytes,
					partial: status !== "failed",
					...(childSession
						? {
								workArtifact: buildWorkArtifact(
									{
										status: "missing",
										diagnostic: `No final ${finalDeliverableNoun}: the run ended before ${missingDeliverableTarget}.`,
									},
									{ terminal: true },
								),
							}
						: {}),
					diagnostics: [diagnostic],
					...(usage ? { usage } : {}),
				};
			};
			observeTerminalHook = async (result?: SubagentResult): Promise<void> => {
				if (terminalHookObserved || !options.hookRuntime) return;
				const status = result?.status ?? terminalStatus;
				if (!status) return;
				terminalHookObserved = true;
				const event =
					status === "completed"
						? "subagent.completed"
						: status === "timed_out"
							? "subagent.timedOut"
							: status === "cancelled"
								? "subagent.cancelled"
								: "subagent.failed";
				dispatchSubagentHookObservation(
					options.hookRuntime,
					event,
					{
						status,
						childSessionId: childSession?.sessionId,
						observedOutputBytes: result?.observedOutputBytes ?? observedOutputBytes,
					},
					options.signal,
				);
			};
			const finalizeManaged = async (result: SubagentResult): Promise<SubagentResult> => {
				// An explicit parent control decision owns the terminal
				// classification: an aborted child turn cannot downgrade a
				// cancellation into a generic failure or a silent completion.
				const controlled: SubagentResult =
					control === "cancelled" || control === "timed_out"
						? result.status === control
							? result
							: {
									...result,
									status: control,
									diagnostics: [
										...result.diagnostics,
										{
											code: control === "cancelled" ? "cancellation" : "timeout",
											message:
												control === "cancelled"
													? "Parent cancelled the retained child; the terminal status is cancellation."
													: "Parent ended the retained child at its time decision; the terminal status is timeout.",
										},
									],
								}
						: result;
				await observeTerminalHook(controlled);
				await flushSubagentHookObservations(options.hookRuntime);
				// Retain before the terminal transition wakes any pending management
				// wait, so a waiter never observes terminal state without a result.
				const firstPublication = publicManagementEnabled
					? this.noteManagedTerminalResult(runId, normalized.parentSessionId, controlled)
					: false;
				supervisor?.finish(controlled, controlled.status);
				await cleanupTerminalSession();
				const decorated = decorateSubagentResult(controlled);
				if (firstPublication) {
					try {
						await options.onManagedResult?.(decorated);
					} catch {
						// Durable/job observers cannot change a terminal child result.
					}
				}
				return decorated;
			};
			stopAfterSupervisor = async (reason) => {
				resolveControl?.(reason);
				const result = await controlledFailure(reason);
				return finalizeManaged(result);
			};
			const awaitInteractiveBoundary = async (
				waitPromise: Promise<void>,
			): Promise<"cancelled" | "timed_out" | undefined> => {
				const races: Array<Promise<"cancelled" | "timed_out" | undefined>> = [
					waitPromise.then(() => undefined),
					controlPromise.then((reason) => reason),
				];
				return Promise.race(races);
			};

			let runAfterInitial: (reportStartIndex: number) => Promise<SubagentResult>;
			let runWrapUp: () => Promise<SubagentResult>;
			let runFinalization: () => Promise<SubagentResult>;
			let reportRepairAttempted = false;
			const completeFromParsedReport = async (
				report: SubagentParsedReport,
				lastAssistant: AssistantMessage | undefined,
				rawReportForArtifact?: string,
			): Promise<SubagentResult> => {
				if (authorityRevoked || (options.isAuthorityStillValid && !(await options.isAuthorityStillValid()))) {
					authorityRevoked = true;
					return buildFailureResult(
						new SubagentError(
							"capability_denied",
							"Current parent settings or trust no longer authorize accepting this child result.",
						),
					);
				}
				const summary = truncateSubagentOutput(report.summary, SUBAGENT_OUTPUT_ARTIFACT_LIMITS.inlineBytes);
				const output = materializeOutput(
					rawReportForArtifact ?? JSON.stringify(report) ?? "{}",
					"application/json",
				);
				let finalReportMessageIndex = -1;
				if (lastAssistant) {
					for (let index = childSession!.messages.length - 1; index >= 0; index -= 1) {
						if (childSession!.messages[index] === lastAssistant) {
							finalReportMessageIndex = index;
							break;
						}
					}
				}
				const usage = observeUsage();
				const candidateResult: SubagentResult = {
					...base,
					childSessionId: childSession!.sessionId,
					status: "completed",
					summary: summary.text,
					observedOutputBytes: output.originalBytes,
					partial: false,
					truncated: summary.truncated || output.inlineTruncated,
					diagnostics: [],
					output,
					evidence: { paths: report.paths },
					findings: report.findings.length > 0 ? report.findings : undefined,
					...(report.requirementClaims.length > 0 ? { requirementClaims: report.requirementClaims } : {}),
					...(report.payload ? { payload: report.payload } : {}),
					observedTurns,
					...(usage ? { usage } : {}),
				};
				const completedResult: SubagentResult = candidateResult;
				try {
					await dispatchSubagentHookDecision(
						options.hookRuntime,
						"subagent.beforeAccept",
						{
							status: completedResult.status,
							summary: completedResult.summary,
							evidencePaths: report.paths,
							observedOutputBytes: completedResult.observedOutputBytes,
						},
						options.signal,
					);
				} catch (error) {
					const failure =
						error instanceof SubagentError ? error : new SubagentError("capability_denied", String(error));
					const rejectedResult: SubagentResult = {
						...completedResult,
						status: "verification_failed",
						diagnostics: [{ code: failure.code, message: failure.message }],
					};
					updatePresentation({
						finalizationStarted: false,
						protocolReportPending: false,
						finalResult: { status: "verification_failed", verified: false, diagnostic: failure.message },
					});
					emit("subagent_failed", "verification_failed");
					return rejectedResult;
				}
				const verification = verifySubagentResult(completedResult, normalized);
				const annotatedResult: SubagentResult = annotateSubagentAssurance(
					verification.requirementSummary
						? { ...completedResult, requirementStates: verification.requirementSummary.states }
						: completedResult,
					verification,
					normalized,
					observedBashCommands,
					observedEvidencePaths,
					{
						followUpCount: this.followUpRequests.get(runId)?.size ?? 0,
						repeatedFailureCount: supervisor?.getSnapshot().repeatedFailure?.count ?? 0,
					},
				);
				updatePresentation({
					finalizationStarted: false,
					protocolReportPending: false,
					...(finalReportMessageIndex >= 0 ? { finalReportMessageIndex } : {}),
					finalResult: {
						status: verification.verified ? "completed" : "verification_failed",
						verified: verification.verified,
						summary: summary.text,
						evidencePaths: report.paths,
						...(!verification.verified ? { diagnostic: verification.reason } : {}),
					},
				});
				emit(
					verification.verified ? "subagent_completed" : "subagent_failed",
					verification.verified ? "completed" : "verification_failed",
				);
				return annotatedResult;
			};
			/**
			 * Plain final-turn terminal ingestion: accept the child's natural final
			 * assistant turn directly as the result. No JSON envelope, no parse or
			 * repair call. Runtime failure precedence (authority, missing assistant
			 * turn, error/aborted stop reason) matches the structured terminal path.
			 */
			const completeFromPlainFinalTurn = async (reportStartIndex: number): Promise<SubagentResult> => {
				if (authorityRevoked || (options.isAuthorityStillValid && !(await options.isAuthorityStillValid()))) {
					authorityRevoked = true;
					return buildFailureResult(
						new SubagentError(
							"capability_denied",
							"Current parent settings or trust no longer authorize accepting this child result.",
						),
					);
				}
				const lastAssistant = [...childSession!.messages.slice(reportStartIndex)]
					.reverse()
					.find((message) => message.role === "assistant") as AssistantMessage | undefined;
				if (!lastAssistant) {
					throw new SubagentError("malformed_result", "Child completed without a nonempty assistant answer.");
				}
				if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
					throw new SubagentError(
						"child_protocol_failure",
						`Child ended with stop reason ${lastAssistant.stopReason}.`,
					);
				}
				const rawAnswer = extractAssistantText(childSession!.messages, reportStartIndex);
				observedOutputBytes = Math.max(observedOutputBytes, Buffer.byteLength(rawAnswer));
				if (rawAnswer.trim().length === 0) {
					return protocolFailureResult(
						"missing",
						"Child completed without a nonempty final assistant answer.",
						rawAnswer,
					);
				}
				const finalAnswer = normalizePlainFinalAnswer(rawAnswer);
				const output = materializeOutput(finalAnswer);
				const answer = truncateSubagentOutput(finalAnswer, SUBAGENT_OUTPUT_ARTIFACT_LIMITS.inlineBytes);
				const usage = observeUsage();
				const candidateResult: SubagentResult = {
					...base,
					childSessionId: childSession!.sessionId,
					status: "completed",
					summary: answer.text,
					observedOutputBytes: output.originalBytes,
					partial: false,
					truncated: answer.truncated || output.inlineTruncated,
					diagnostics: [],
					output,
					// Runtime-owned bounded telemetry for plain answers: records the
					// touched-path view and the plain terminal state. The "plain"
					// status is filtered out of parent-facing artifact rows.
					workArtifact: buildWorkArtifact({ status: "plain" }, { terminal: true }),
					observedTurns,
					...(usage ? { usage } : {}),
				};
				const completedResult: SubagentResult = candidateResult;
				try {
					await dispatchSubagentHookDecision(
						options.hookRuntime,
						"subagent.beforeAccept",
						{
							status: completedResult.status,
							summary: completedResult.summary,
							evidencePaths: [],
							observedOutputBytes: completedResult.observedOutputBytes,
						},
						options.signal,
					);
				} catch (error) {
					const failure =
						error instanceof SubagentError ? error : new SubagentError("capability_denied", String(error));
					const rejectedResult: SubagentResult = {
						...completedResult,
						status: "verification_failed",
						diagnostics: [{ code: failure.code, message: failure.message }],
					};
					updatePresentation({
						finalizationStarted: false,
						protocolReportPending: false,
						finalResult: { status: "verification_failed", verified: false, diagnostic: failure.message },
					});
					emit("subagent_failed", "verification_failed");
					return rejectedResult;
				}
				const verification = verifySubagentResult(completedResult, normalized);
				const annotatedResult: SubagentResult = annotateSubagentAssurance(
					verification.requirementSummary
						? { ...completedResult, requirementStates: verification.requirementSummary.states }
						: completedResult,
					verification,
					normalized,
					observedBashCommands,
					observedEvidencePaths,
					{
						followUpCount: this.followUpRequests.get(runId)?.size ?? 0,
						repeatedFailureCount: supervisor?.getSnapshot().repeatedFailure?.count ?? 0,
					},
				);
				// No finalReportMessageIndex: the plain answer stays visible in the child view.
				updatePresentation({
					finalizationStarted: false,
					protocolReportPending: false,
					finalResult: {
						status: verification.verified ? "completed" : "verification_failed",
						verified: verification.verified,
						summary: answer.text,
						...(!verification.verified ? { diagnostic: verification.reason } : {}),
					},
				});
				emit(
					verification.verified ? "subagent_completed" : "subagent_failed",
					verification.verified ? "completed" : "verification_failed",
				);
				return annotatedResult;
			};
			/**
			 * A malformed/truncated/missing final envelope after real work becomes a
			 * non-success result with a preserved bounded artifact. It is never shown as
			 * verified completed, and it never pretends that no work happened.
			 */
			const protocolFailureResult = (
				protocolStatus: SubagentReportProtocolStatus,
				diagnostic: string,
				rawReport: string,
				options: { requirementClaims?: readonly SubagentRequirementClaim[] } = {},
			): SubagentResult => {
				const candidates = [...extractCandidateEvidencePaths(rawReport)]
					.filter((path, index, all) => all.indexOf(path) === index)
					.slice(0, CANDIDATE_EVIDENCE_PATH_LIMIT);
				const output = rawReport.trim().length > 0 ? materializeOutput(rawReport, "application/json") : undefined;
				const artifact = buildWorkArtifact(
					{ status: protocolStatus, diagnostic },
					{
						candidateEvidencePaths: candidates,
						...(options.requirementClaims ? { requirementClaims: options.requirementClaims } : {}),
						terminal: true,
					},
				);
				const usage = observeUsage();
				const failureSummary =
					touchedPaths.size > 0
						? structuredReportMode
							? `Child work was observed (${touchedPaths.size} touched path${touchedPaths.size === 1 ? "" : "s"}) but the final report failed the bounded report protocol.`
							: `Child work was observed (${touchedPaths.size} touched path${touchedPaths.size === 1 ? "" : "s"}) but the final answer failed the plain final-turn ingestion.`
						: structuredReportMode
							? "Child completed without a valid bounded final report; observed work was preserved as a bounded artifact."
							: "Child completed without a nonempty final assistant answer; observed work was preserved as a bounded artifact.";
				updatePresentation({
					finalizationStarted: false,
					protocolReportPending: false,
					finalResult: { status: "verification_failed", verified: false, summary: failureSummary, diagnostic },
				});
				emit("subagent_failed", "verification_failed");
				return {
					...base,
					childSessionId: childSession?.sessionId,
					status: "verification_failed",
					summary: failureSummary,
					observedOutputBytes,
					partial: false,
					workArtifact: artifact,
					...(output ? { output } : {}),
					diagnostics: [{ code: "report_protocol_failure", message: diagnostic }],
					...(usage ? { usage } : {}),
				};
			};
			const parseCompletedResult = async (reportStartIndex: number): Promise<SubagentResult> => {
				const rawReport = extractAssistantText(childSession!.messages, reportStartIndex);
				observedOutputBytes = Buffer.byteLength(rawReport);
				const lastAssistant = [...childSession!.messages.slice(reportStartIndex)]
					.reverse()
					.find((message) => message.role === "assistant") as AssistantMessage | undefined;
				// No assistant message at all means the child stream never produced a
				// turn; that is a runtime failure, not a preserved-work protocol failure.
				if (!lastAssistant) {
					throw new SubagentError("malformed_result", "Child completed without a nonempty assistant report.");
				}
				if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
					throw new SubagentError(
						"child_protocol_failure",
						`Child ended with stop reason ${lastAssistant.stopReason}.`,
					);
				}
				if (rawReport.trim().length === 0) {
					return protocolFailureResult(
						"missing",
						"Child completed without a nonempty assistant report.",
						rawReport,
					);
				}
				const outcome = parseSubagentReportOutcome(
					rawReport,
					SUBAGENT_REPORT_PARSER_LIMITS.maxBytes,
					normalized.outputSchema,
				);
				if (outcome.kind === "valid") {
					return await completeFromParsedReport(outcome.report, lastAssistant, rawReport);
				}
				return protocolFailureResult(
					outcome.kind === "truncated" ? "truncated" : "malformed",
					outcome.diagnostic,
					rawReport,
				);
			};
			/**
			 * Optional one-time report-only repair: same live child session, tools
			 * disabled, hidden prompt requesting only the internal final envelope,
			 * maximum one retry, no implementation replay. Never triggered for
			 * cancellation, authority failure, or terminal timeout.
			 */
			const attemptReportRepair = async (preserved: SubagentResult): Promise<SubagentResult> => {
				const session = childSession!;
				const previousTools = (() => {
					try {
						return session.getActiveToolNames();
					} catch {
						return undefined;
					}
				})();
				try {
					try {
						reportOnly = true;
						session.setActiveToolsByName([]);
					} catch {
						// The independent beforeTool guard denies dispatch even if SDK disabling fails.
					}
					const turnsBefore = observedTurns;
					const repairStartIndex = session.messages.length;
					updatePresentation({ finalizationStarted: true, protocolReportPending: true });
					// The child can only repair what it can see; name the exact prior
					// validation failure instead of repeating the generic envelope demand.
					const priorFailure = preserved.diagnostics.find(
						(entry) => entry.code === "report_protocol_failure",
					)?.message;
					const repairPrompt = priorFailure
						? `${SUBAGENT_REPORT_REPAIR_PROMPT} The specific validation failure was: ${priorFailure}`
						: SUBAGENT_REPORT_REPAIR_PROMPT;
					const outcome = await awaitPrompt(
						session.prompt(repairPrompt, {
							expandPromptTemplates: false,
							source: "extension",
						}),
					);
					if (observedTurns === turnsBefore) observedTurns += 1;
					if (outcome.kind === "cancelled" || outcome.kind === "timed_out") {
						releaseOutput(preserved);
						return controlledFailure(outcome.kind);
					}
					if (outcome.kind === "error") {
						return {
							...preserved,
							diagnostics: [
								...preserved.diagnostics,
								{
									code: "report_protocol_failure" as const,
									message: "One-time report repair attempt errored before completion.",
								},
							],
						};
					}
					const rawRepair = extractAssistantText(session.messages, repairStartIndex);
					observedOutputBytes = Math.max(observedOutputBytes, Buffer.byteLength(rawRepair));
					const repairOutcome = parseSubagentReportOutcome(
						rawRepair,
						SUBAGENT_REPORT_PARSER_LIMITS.maxBytes,
						normalized.outputSchema,
					);
					if (repairOutcome.kind === "valid") {
						const lastAssistant = [...session.messages.slice(repairStartIndex)]
							.reverse()
							.find((message) => message.role === "assistant") as AssistantMessage | undefined;
						const repaired = await completeFromParsedReport(repairOutcome.report, lastAssistant, rawRepair);
						releaseOutput(preserved);
						return repaired;
					}
					return {
						...preserved,
						diagnostics: [
							...preserved.diagnostics,
							{
								code: "report_protocol_failure" as const,
								message: "One-time report repair attempt returned an invalid final envelope.",
							},
						],
					};
				} finally {
					if (previousTools !== undefined) {
						try {
							session.setActiveToolsByName(previousTools);
						} catch {
							// The terminal session is being shut down anyway.
						}
					}
				}
			};
			/** Parse the final report; on a protocol failure allow at most one bounded repair attempt. */
			const finalizeReport = async (reportStartIndex: number): Promise<SubagentResult> => {
				const parsed = await parseCompletedResult(reportStartIndex);
				const protocolFailed = parsed.diagnostics.some(
					(diagnostic) => diagnostic.code === "report_protocol_failure",
				);
				if (!protocolFailed || reportRepairAttempted) return parsed;
				reportRepairAttempted = true;
				return attemptReportRepair(parsed);
			};
			runWrapUp = async (): Promise<SubagentResult> => {
				wrapUpPromptStarted = true;
				reportOnly = true;
				supervisor?.setPhase("wrapping_up");
				try {
					childSession!.setActiveToolsByName([]);
				} catch {
					// The independent beforeTool guard still denies any wrap-up tool dispatch.
				}
				const turnsBefore = observedTurns;
				const wrapUpStartIndex = childSession!.messages.length;
				updatePresentation({ wrapUpMessageIndex: wrapUpStartIndex });
				const outcome = await awaitPrompt(
					childSession!.prompt(SUBAGENT_WRAP_UP_PROMPT, {
						expandPromptTemplates: false,
						source: "extension",
					}),
				);
				if (observedTurns === turnsBefore) observedTurns += 1;
				if (outcome.kind === "cancelled" || outcome.kind === "timed_out") {
					return controlledFailure(outcome.kind);
				}
				if (outcome.kind === "error") throw classifySubagentFailure(outcome.error, "runtime", childToolFailed);
				return runAfterInitial(wrapUpStartIndex);
			};
			runFinalization = async (): Promise<SubagentResult> => {
				const turnsBefore = observedTurns;
				supervisor?.setPhase("finalization");
				const finalReportStartIndex = childSession!.messages.length;
				updatePresentation({
					finalizationStarted: true,
					finalizationMessageIndex: finalReportStartIndex,
					...(structuredReportMode ? { protocolReportPending: true } : {}),
				});
				const finalOutcome = await awaitPrompt(
					childSession!.prompt(
						structuredReportMode ? INTERACTIVE_FINAL_REPORT_PROMPT : INTERACTIVE_PLAIN_FINAL_PROMPT,
						{
							expandPromptTemplates: false,
							source: "extension",
						},
					),
				);
				if (observedTurns === turnsBefore) observedTurns += 1;
				if (finalOutcome.kind === "cancelled" || finalOutcome.kind === "timed_out") {
					return controlledFailure(finalOutcome.kind);
				}
				if (finalOutcome.kind === "error") {
					throw classifySubagentFailure(finalOutcome.error, "runtime", childToolFailed);
				}
				if (!liveControl?.markFinalReportReceived()) {
					throw new SubagentError(
						"child_protocol_failure",
						structuredReportMode
							? "Child final report was not accepted by its control state."
							: "Child final answer was not accepted by its control state.",
					);
				}
				return structuredReportMode
					? finalizeReport(finalReportStartIndex)
					: completeFromPlainFinalTurn(finalReportStartIndex);
			};
			runAfterInitial = async (reportStartIndex: number): Promise<SubagentResult> => {
				if (authorityRevoked) {
					return buildFailureResult(
						new SubagentError(
							"capability_denied",
							"Current parent settings or trust revoked this child before its next safe boundary.",
						),
					);
				}
				if (liveControl && (liveControl.isControlled() || liveControl.hasSteered())) {
					if (liveControl.isControlled()) supervisor?.pauseForControlledWait();
					for (const waitPromise of [
						liveControl.waitForPendingSteering(),
						liveControl.waitForControlRelease(),
						liveControl.waitForPendingSteering(),
					]) {
						const reason = await awaitInteractiveBoundary(waitPromise);
						if (reason) return controlledFailure(reason);
					}
					supervisor?.resumeFromControlledWait();
				}
				if (wrapUpRequested && !wrapUpPromptStarted) return runWrapUp();
				if (liveControl?.hasSteered()) {
					if (liveControl.getState() === "working") {
						if (!liveControl.beginFinalization() || !liveControl.requestFinalReport()) {
							throw new SubagentError(
								"child_protocol_failure",
								"Child finalization state could not be established.",
							);
						}
					} else if (liveControl.getState() !== "final-report-requested") {
						throw new SubagentError("child_protocol_failure", "Child finalization state could not be resumed.");
					}
					return runFinalization();
				}
				return structuredReportMode
					? finalizeReport(reportStartIndex)
					: completeFromPlainFinalTurn(reportStartIndex);
			};
			const runInitial = async (): Promise<SubagentResult> => {
				if (authorityRevoked) {
					return buildFailureResult(
						new SubagentError(
							"capability_denied",
							"Current parent settings or trust revoked this child before startup.",
						),
					);
				}
				const turnsBefore = observedTurns;
				const reportStartIndex = childSession!.messages.length;
				if (presentation?.handoffMessageIndex !== reportStartIndex) {
					updatePresentation({ handoffMessageIndex: reportStartIndex });
				}
				const outcome = await awaitPrompt(
					childSession!.prompt(created.prompt, {
						expandPromptTemplates: false,
						source: "extension",
					}),
				);
				if (observedTurns === turnsBefore) observedTurns += 1;
				if (outcome.kind === "cancelled" || outcome.kind === "timed_out") {
					return controlledFailure(outcome.kind);
				}
				if (outcome.kind === "error") {
					throw classifySubagentFailure(outcome.error, "runtime", childToolFailed);
				}
				return runAfterInitial(reportStartIndex);
			};
			const initialResult = decorateSubagentResult(await runInitial());
			settledTerminalResult = initialResult;
			return initialResult;
		} catch (error) {
			const failure = classifySubagentFailure(error, childSession ? "runtime" : "startup", childToolFailed);
			const retrySafeStartup = !childSession && observedTurns === 0 && !options.unsafeHostExec && failure.retryable;
			const diagnostic = {
				code: failure.code,
				message: failure.message,
				...(retrySafeStartup ? { retryable: true } : {}),
			};
			if (childSession) observeAssistantText();
			const usage = observeUsage();
			const status = control === "cancelled" ? "cancelled" : control === "timed_out" ? "timed_out" : "failed";
			if (childSession) {
				updatePresentation({
					finalizationStarted: false,
					protocolReportPending: false,
					finalResult: { status, diagnostic: diagnostic.message },
				});
			}
			emit(
				status === "cancelled"
					? "subagent_cancelled"
					: status === "timed_out"
						? "subagent_timed_out"
						: "subagent_failed",
				status,
			);
			const failedResult = decorateSubagentResult({
				...base,
				childSessionId: childSession?.sessionId,
				retrySafeStartup,
				status,
				summary: diagnostic.message,
				observedOutputBytes,
				partial: status !== "failed",
				...(childSession
					? {
							workArtifact: buildWorkArtifact(
								{
									status: "missing",
									diagnostic: "No final report: the run ended before a valid final envelope.",
								},
								{ terminal: true },
							),
						}
					: {}),
				diagnostics: [diagnostic],
				...(usage ? { usage } : {}),
			});
			settledTerminalResult = failedResult;
			return failedResult;
		} finally {
			if (timeout) globalThis.clearTimeout(timeout);
			await observeTerminalHook();
			if (settledTerminalResult && publicManagementEnabled) {
				// Publish before supervisor teardown so a concurrent management wait
				// never observes terminal state without a retained result.
				await this.settleManagedRun(
					runId,
					normalized.parentSessionId,
					settledTerminalResult,
					options.onManagedResult,
				);
			}
			await flushSubagentHookObservations(options.hookRuntime);
			await cleanupTerminalSession();
		}
	}
}

export type SubagentRecoveryStopReason = "cancelled" | "timed_out" | "fail_fast";

export interface SubagentRecoveryHooks {
	getStopReason?: () => SubagentRecoveryStopReason | undefined;
}

export async function runSubagentWithRecovery(
	normalized: NormalizedSubagentRequest,
	parentActiveTools: readonly string[],
	runAttempt: (
		attempt: SubagentAttemptNumber,
		request: NormalizedSubagentRequest,
		activeTools: readonly string[],
	) => Promise<SubagentResult>,
	hooks: SubagentRecoveryHooks = {},
): Promise<SubagentResult> {
	const attempts: SubagentAttemptSummary[] = [];
	const aggregate = batchUsage();
	let hasUsage = false;
	let totalObservedOutputBytes = 0;
	let totalTurns = 0;
	const deadline = Date.now() + normalized.timeoutMs;
	let currentRequest = normalized;

	const finalize = (result: SubagentResult): SubagentResult => {
		return {
			...result,
			...(normalized.scope.targets?.length ? { scopeTargets: [...normalized.scope.targets] } : {}),
			...(hasUsage ? { usage: aggregate } : {}),
			observedTurns: totalTurns,
			...(currentRequest.modelCandidateSkips ? { modelCandidateSkips: currentRequest.modelCandidateSkips } : {}),
			recovery: Object.freeze({
				attemptCount: (attempts.length || 1) as SubagentAttemptNumber,
				retried: attempts.length === 2,
				totalObservedOutputBytes,
				attempts: Object.freeze(attempts),
			}),
		};
	};

	const stoppedResult = (reason: SubagentRecoveryStopReason): SubagentResult => {
		const timedOut = reason === "timed_out";
		return {
			runId: normalized.runId,
			parentSessionId: normalized.parentSessionId,
			profile: normalized.profile.name,
			source: normalized.profile.source,
			status: timedOut ? "timed_out" : "cancelled",
			summary: timedOut
				? "Subagent retry suppressed after timeout."
				: "Subagent retry suppressed after cancellation.",
			observedOutputBytes: 0,
			partial: true,
			diagnostics: [
				{
					code: timedOut ? "timeout" : "cancellation",
					message: timedOut
						? "Batch timeout arrived before the next subagent attempt."
						: reason === "fail_fast"
							? "Batch fail-fast stopped the next subagent attempt."
							: "Parent cancellation arrived before the next subagent attempt.",
				},
			],
		};
	};

	for (const attempt of [1, 2] as const) {
		if (attempt === 2) {
			const stopReason = hooks.getStopReason?.();
			if (stopReason) return finalize(stoppedResult(stopReason));
		}
		let result: SubagentResult;
		try {
			if (attempt === 2) {
				const remainingTime = deadline - Date.now();
				if (remainingTime <= 0) return finalize(stoppedResult("timed_out"));
				currentRequest = {
					...normalized,
					timeoutMs: remainingTime,
				};
				if (normalized.resolveStartupFallback)
					currentRequest.retryModel = normalized.resolveStartupFallback(currentRequest);
			}
			result = await runAttempt(attempt, currentRequest, parentActiveTools);
		} catch (error) {
			const failure = classifySubagentFailure(error, "runtime");
			result = {
				runId: normalized.runId,
				parentSessionId: normalized.parentSessionId,
				profile: normalized.profile.name,
				source: normalized.profile.source,
				status: "failed",
				summary: failure.message,
				observedOutputBytes: 0,
				partial: false,
				diagnostics: [
					{
						code: failure.code,
						message: failure.message,
						...(failure.retryable ? { retryable: true } : {}),
					},
				],
			};
		}
		const attemptSummary = {
			attempt,
			status: result.status,
			...(result.status !== "completed" &&
			result.diagnostics[0]?.code &&
			result.diagnostics[0].code !== "report_spilled" &&
			result.diagnostics[0].code !== "report_artifact_failure"
				? { failureCode: result.diagnostics[0].code }
				: {}),
			observedOutputBytes: result.observedOutputBytes,
		};
		Object.freeze(attemptSummary);
		attempts.push(attemptSummary);
		totalObservedOutputBytes += result.observedOutputBytes;
		totalTurns += result.observedTurns ?? 0;
		if (result.usage) {
			addBatchUsage(aggregate, result.usage);
			hasUsage = true;
		}
		const stoppedAfterAttempt = hooks.getStopReason?.();
		if (stoppedAfterAttempt)
			return finalize({ ...result, ...stoppedResult(stoppedAfterAttempt), workArtifact: result.workArtifact });
		const retryable =
			attempt === 1 &&
			result.status === "failed" &&
			result.retrySafeStartup === true &&
			!result.childSessionId &&
			!result.workArtifact &&
			!result.partial &&
			(result.observedTurns ?? 0) === 0 &&
			result.diagnostics.some(
				(diagnostic) => diagnostic.retryable === true && diagnostic.code === "child_startup_failure",
			);
		if (!retryable) return finalize(result);
	}
	throw new Error("Subagent recovery exhausted without a terminal result.");
}
