/** Legacy ice-subagents extension: registers the 15 model-facing tools, commands, and handlers (moved from ice-subagents.ts; replaced in V2 Phase 6/10). */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Component } from "@zykairotis/ice-tui";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../core/extensions/types.ts";
import { matchesEntryType } from "../core/legacy-compat/identity.ts";
import { type IceSettingsValue, SettingsManager } from "../core/settings-manager.ts";
import type { Skill } from "../core/skills.ts";
import {
	getConfiguredIceVerifierArgv,
	type IceVerifierState,
	parseVerifierArgv,
	runVerifier,
} from "../ice-safe-verify.ts";
import { redactCredentialText } from "../utils/redact.ts";
import {
	type CancelSubagentBatchTool,
	type DelegateAsyncTool,
	type DelegateBatchTool,
	type DelegateTool,
	type DelegateWriteTool,
	delegateAsyncParameters,
	delegateBatchParameters,
	delegateParameters,
	delegateWriteParameters,
	type InspectSubagentBatchTool,
	type ListSubagentProfilesTool,
	listSubagentProfilesParameters,
	type ManagedBatchInspection,
	type ManageSubagentTool,
	manageSubagentParameters,
	type ReadSubagentOutputTool,
	type ReviewBatchTool,
	readSubagentOutputParameters,
	reviewBatchParameters,
	type SubagentJobTool,
	type SubagentProfileListingDetails,
	subagentBatchIdParameters,
	subagentJobParameters,
	type WriterPatchWorkflowTool,
	writerPatchWorkflowParameters,
} from "./api/legacy-schemas.ts";
import {
	hashSource,
	listSubagentProfiles,
	revalidateSubagentProfile,
	type SubagentProfileResolutionOptions,
	suggestSubagentProfiles,
} from "./definitions/legacy-profiles.ts";
import {
	appendSubagentHookJournal,
	applyIceProfileSettingsSummary,
	authorizeUnsafeSubagentHostExecution,
	createSubagentHookRuntime,
	flagEnabled,
	formatIceSubagentSettingsSummary,
	getParentSettingsManager,
	IceSubagentSettingsSubmenu,
	type IceSubagentsOptions,
	isCurrentSubagentAuthorityValid,
	memoizeSubagentForkContextSource,
	resolveRequestedSubagentModel,
	resolveSubagentConcurrencyPolicyFromSettings,
	type UnsafeSubagentAuthorization,
	validateSubagentMcpAdmission,
} from "./extension-support.ts";
import {
	inspectWriterPatchArtifact,
	integrateWriterPatchArtifact,
	type WriterPatchInspection,
	type WriterWorkflowToolResult,
} from "./isolation/writer-patch.ts";
import { SubagentConcurrencyAdmission } from "./registry/admission.ts";
import {
	JOB_COMPLETION_MESSAGE_TYPE,
	JOB_ENTRY_TYPE,
	SUBAGENT_JOB_QUEUE_LIMIT,
	SubagentJobError,
	type SubagentJobInspection,
	SubagentJobRegistry,
	type SubagentJobRunResult,
} from "./registry/jobs.ts";
import { findExactDuplicateBatchTasks } from "./results/batch-synthesis.ts";
import {
	describeSubagentDelegationBreadth,
	formatBatchToolResult,
	formatManagedObservation,
	formatReviewBatchToolResult,
	formatRuntimeAttention,
	formatSubagentCheckInState,
	formatSubagentJobInspection,
	formatToolResult,
	formatWriterToolResult,
	formatWriterWorkflowResult,
	gateSubagentPreflight,
	publishBatchTaskProgress,
	publishRuntimeProgress,
	publishWorkflowProgress,
	redactReviewBatchResult,
	redactSubagentBatchResult,
	redactSubagentResult,
	redactSubagentVerification,
	redactWriterResult,
	redactWriterWorkflowResult,
	renderObservatoryCall,
	renderObservatoryResult,
	renderSubagentProfileCall,
	renderSubagentProfileResult,
	subagentCheckInFreshness,
	writerIntegrationFailure,
	writerWorkflowFailure,
} from "./results/format.ts";
import { SubagentOutputArtifactError, SubagentOutputArtifactStore } from "./results/output-artifacts.ts";
import { verifySubagentResult } from "./results/report.ts";
import {
	buildSubagentLaunchPreflight,
	createSubagentLaunchProvenance,
	effectiveSubagentToolNames,
	modelReference,
	resolveReviewTask,
	runResolvedReviewBatch,
	runResolvedSubagentBatch,
} from "./runtime/batch.ts";
import {
	SUBAGENT_CHECKIN_INTERVAL_MS,
	SubagentCheckInCoordinator,
	type SubagentCheckInState,
} from "./runtime/checkin.ts";
import {
	formatDurableJobIdentifierError,
	formatManagedIdentifierError,
	formatSubagentToolError,
	modelLabel,
	requireParentModel,
	SubagentError,
	withBatchTaskContext,
} from "./runtime/helpers.ts";
import {
	dispatchSubagentHookDecision,
	type SubagentHookRuntime,
	SubagentLiveSessionRegistry,
} from "./runtime/live-session.ts";
import { formatSubagentPreflightFailure } from "./runtime/preflight.ts";
import { truncateSubagentOutput } from "./runtime/prompt.ts";
import {
	applySubagentHookContextAdditions,
	MANAGED_WRITER_LIMITS,
	normalizeSubagentRequest,
	normalizeWriterRequest,
	SUBAGENT_FOLLOW_UP_STATE_ENTRY_TYPE,
	type SubagentNormalizationOptions,
} from "./runtime/request.ts";
import { revalidateSubagentResources } from "./runtime/resources.ts";
import { resolveIceSubagentCandidates, resolveIceSubagentRoute, snapshotIceSubagentRoute } from "./runtime/routing.ts";
import { NativeSubagentRunner, runSubagentWithRecovery } from "./runtime/runner.ts";
import {
	formatSubagentToolActivity,
	SubagentRunSupervisorRegistry,
	type SubagentRuntimeAttention,
} from "./runtime/supervisor.ts";
import { NativeWriterRunner } from "./runtime/writer-runner.ts";
import {
	ICE_HOOK_JOURNAL_ENTRY_TYPE,
	type IceHookJournalEntry,
	parseIceSettings,
	resolveIceSubagentContract,
	resolveIceSubagentHooks,
} from "./settings.ts";
import { type SubagentOutcomeTelemetryInput, SubagentTelemetryStore } from "./telemetry/outcomes.ts";
import { getIceDelegableTools } from "./tools/adapters.ts";
import {
	type IceSubagentMcpAdapter,
	type ManagedSubagentBatchRecord,
	type ManagedWriterInspection,
	type ManagedWriterRecord,
	type NormalizedSubagentRequest,
	type NormalizedWriterRequest,
	parentMcpAdapters,
	type ResolvedReviewTask,
	type ResolvedSubagentBatchTask,
	SUBAGENT_BATCH_LIMITS,
	SUBAGENT_DELEGATION_POLICY_GUIDELINES,
	SUBAGENT_INTERNAL_REPORT_GUIDANCE,
	SUBAGENT_MANAGED_REQUEST_LIMIT,
	SUBAGENT_MANAGEMENT_WAIT_DEFAULT_MS,
	SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS,
	SUBAGENT_SCOPE_TOOL_GUIDANCE,
	type SubagentManagedHandle,
	type SubagentManagedObservation,
	type SubagentProfileSummary,
	type SubagentRequest,
	type SubagentResult,
	type SubagentVerification,
	subagentMcpToolName,
	type WriterRequest,
	type WriterResult,
} from "./types.ts";
import { parseAgentsViewMode, SubagentObservatoryView } from "./ui/components.ts";
import {
	projectDurableSubagentJob,
	projectSubagentCompletionInbox,
	SubagentObservatoryStore,
} from "./ui/observatory.ts";

export default function iceSubagents(ice: ExtensionAPI, options: IceSubagentsOptions = {}): void {
	options = {
		...options,
		getIceMode: options.getIceMode,
		getIceCapabilityState: options.getIceCapabilityState,
		parentHookOwner: ice.events,
	};
	if (typeof ice.registerFlag === "function") {
		ice.registerFlag("sub-yolo", {
			description:
				"Allow explicitly requested subagent host/mutation capabilities when they also intersect the trusted build parent's active authority; this is not a sandbox",
			type: "boolean",
		});
	}
	const subYoloEnabled = (): boolean => flagEnabled(ice, "sub-yolo");
	const agentDir = options.agentDir ?? getAgentDir();
	const subagentArtifactRoot = join(agentDir, "artifacts", "subagent");
	const outputArtifacts = new SubagentOutputArtifactStore({
		artifactRoot: join(agentDir, "artifacts", "subagent-output"),
	});
	const registeredMcpProxy: IceSubagentMcpAdapter = {
		getIdentity: () => parentMcpAdapters.get(ice.events),
		listAuthorizedTools: () => parentMcpAdapters.get(ice.events)?.listAuthorizedTools() ?? [],
		dispatch: (server, tool, params, signal) => {
			const adapter = parentMcpAdapters.get(ice.events);
			if (!adapter) throw new SubagentError("capability_denied", "Parent MCP adapter was removed.");
			return adapter.dispatch(server, tool, params, signal);
		},
	};
	const mcpAdapter = options.mcpAdapter ?? registeredMcpProxy;
	const parentToolSnapshot = (unsafe: UnsafeSubagentAuthorization | undefined): readonly string[] => {
		if (!unsafe) return typeof ice.getActiveTools === "function" ? ice.getActiveTools() : [];
		const registered = getIceDelegableTools(ice.events);
		const external = registered.length
			? registered
					.filter((tool) => ice.getActiveTools().includes(tool.name) && tool.isCurrent())
					.map((tool) => tool.name)
			: [];
		return Object.freeze([...unsafe.parentActiveTools, ...external]);
	};
	let parentSkills: readonly Skill[] = [];
	ice.on("before_agent_start", (event) => {
		parentSkills = Object.freeze((event.systemPromptOptions?.skills ?? []).map((skill) => ({ ...skill })));
	});
	const parentSnapshotOptions = (
		ctx: ExtensionContext,
		request: SubagentRequest,
		unsafe: { parentActiveTools: readonly string[] } | undefined,
	): SubagentNormalizationOptions => ({
		parentSystemPrompt:
			request.role === "self" && typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined,
		parentActiveTools: parentToolSnapshot(unsafe as UnsafeSubagentAuthorization | undefined),
		parentSkills,
		delegableTools: getIceDelegableTools(ice.events).map((tool) => ({
			...tool,
			isCurrent: () => tool.isCurrent() && ice.getActiveTools().includes(tool.name),
		})),
		unsafeHostExec: unsafe !== undefined,
	});
	const liveSessions = new SubagentLiveSessionRegistry();
	const supervisorRegistry = new SubagentRunSupervisorRegistry<SubagentResult>();
	let observatoryStore: SubagentObservatoryStore | undefined;
	let jobs: SubagentJobRegistry | undefined;
	const checkIns = new Map<string, SubagentCheckInCoordinator>();
	const getCheckIns = (ownerSessionId: string): SubagentCheckInCoordinator => {
		let coordinator = checkIns.get(ownerSessionId);
		if (!coordinator) {
			coordinator = new SubagentCheckInCoordinator(
				ownerSessionId,
				() => options.agentViewBridge?.getParentSession(),
				undefined,
				(runId, state) => {
					liveSessions.updateCheckInState(runId, state);
					observatoryStore?.updateCheckInState(runId, state);
					jobs?.updateCheckInState(
						runId,
						state
							? {
									sequence: state.sequence,
									...(state.lastAcknowledgedAt !== undefined
										? { lastAcknowledgedAt: state.lastAcknowledgedAt }
										: {}),
									...(state.pendingSince !== undefined ? { pendingSince: state.pendingSince } : {}),
									...(state.delivery === "owner_unavailable" && state.pendingSince !== undefined
										? { overdueSince: state.pendingSince }
										: {}),
								}
							: undefined,
					);
				},
			);
			checkIns.set(ownerSessionId, coordinator);
		}
		return coordinator;
	};
	const terminalCheckIn = (ownerSessionId: string, runId: string): void => {
		const coordinator = checkIns.get(ownerSessionId);
		if (!coordinator) return;
		coordinator.terminal(runId);
		if (coordinator.activeChildrenCount === 0) {
			coordinator.dispose();
			checkIns.delete(ownerSessionId);
		}
	};
	const withCheckIn = <T extends { runId: string }>(
		observation: T,
		ownerSessionId: string,
	): T & {
		checkIn?: SubagentCheckInState;
	} => {
		const checkIn = checkIns.get(ownerSessionId)?.getState(observation.runId);
		return checkIn ? { ...observation, checkIn } : observation;
	};
	// Accepted requests of managed delegate runs so terminal observations get the same parent
	// verification the synchronous path produced. Bounded; oldest entries are dropped first.
	const managedRequests = new Map<string, NormalizedSubagentRequest>();
	const managedRequestKey = (ownerSessionId: string, runId: string): string => `${ownerSessionId}\u0000${runId}`;
	const rememberManagedRequest = (request: NormalizedSubagentRequest): void => {
		const key = managedRequestKey(request.parentSessionId, request.runId);
		managedRequests.delete(key);
		managedRequests.set(key, request);
		while (managedRequests.size > SUBAGENT_MANAGED_REQUEST_LIMIT) {
			const oldest = managedRequests.keys().next().value;
			if (oldest === undefined) break;
			managedRequests.delete(oldest);
		}
	};
	const managedVerificationFor = (
		ownerSessionId: string,
		observation: SubagentManagedObservation,
	): SubagentVerification | undefined => {
		if (!observation.result) return undefined;
		const request = managedRequests.get(managedRequestKey(ownerSessionId, observation.result.runId));
		return request ? verifySubagentResult(observation.result, request) : undefined;
	};
	const managedBatches = new Map<string, ManagedSubagentBatchRecord>();
	const managedBatchOutputReference = (batchId: string): string => `batch:${batchId}`;
	const releaseManagedBatchOutput = (record: ManagedSubagentBatchRecord): void => {
		for (const artifactId of record.outputArtifactIds) {
			outputArtifacts.release({
				ownerSessionId: record.ownerSessionId,
				artifactId,
				referenceId: managedBatchOutputReference(record.batchId),
			});
		}
		record.outputArtifactIds.clear();
	};
	const pruneManagedBatches = (): void => {
		while (managedBatches.size >= SUBAGENT_BATCH_LIMITS.retainedManagedBatches) {
			const oldestTerminal = [...managedBatches.entries()].find(([, record]) =>
				["completed", "partial", "failed", "cancelled"].includes(record.state),
			);
			if (!oldestTerminal) return;
			releaseManagedBatchOutput(oldestTerminal[1]);
			managedBatches.delete(oldestTerminal[0]);
		}
	};
	const createManagedBatch = (
		batchId: string,
		ownerSessionId: string,
		kind: ManagedSubagentBatchRecord["kind"],
		controller: AbortController,
		tasks: readonly ResolvedSubagentBatchTask[],
	): ManagedSubagentBatchRecord => {
		const active = [...managedBatches.values()].filter(
			(record) => !["completed", "partial", "failed", "cancelled"].includes(record.state),
		).length;
		if (active >= SUBAGENT_BATCH_LIMITS.maxManagedBatches) {
			throw new SubagentError("batch_admission_exhausted", "The owner reached the active managed-batch limit.");
		}
		pruneManagedBatches();
		if (managedBatches.size >= SUBAGENT_BATCH_LIMITS.retainedManagedBatches) {
			throw new SubagentError("batch_admission_exhausted", "The managed-batch result ledger is full.");
		}
		const record: ManagedSubagentBatchRecord = {
			batchId,
			ownerSessionId,
			kind,
			acceptedAt: Date.now(),
			tasks: new Map(
				tasks.map((task) => [
					task.id,
					{
						taskId: task.id,
						runId: task.request.runId,
						role: task.request.role,
						model: modelLabel(task.model) ?? "unknown",
						status: "queued",
					},
				]),
			),
			controller,
			outputArtifactIds: new Set(),
			state: "queued",
		};
		managedBatches.set(batchId, record);
		return record;
	};
	const snapshotManagedBatch = (record: ManagedSubagentBatchRecord): ManagedBatchInspection => ({
		batchId: record.batchId,
		kind: record.kind,
		state: record.state,
		acceptedAt: record.acceptedAt,
		tasks: [...record.tasks.values()].map((task) => ({
			...task,
			...(checkIns.get(record.ownerSessionId)?.getState(task.runId)
				? { checkIn: checkIns.get(record.ownerSessionId)?.getState(task.runId) }
				: {}),
		})),
		...(record.result ? { result: record.result } : {}),
	});
	const ownedManagedBatch = (batchId: string, ownerSessionId: string): ManagedSubagentBatchRecord => {
		const record = managedBatches.get(batchId);
		if (!record || record.ownerSessionId !== ownerSessionId) {
			throw new SubagentError("capability_denied", "The managed batch is not available to this owner session.");
		}
		return record;
	};
	const managedWriters = new Map<string, ManagedWriterRecord>();
	const releaseManagedWriterOutput = (record: ManagedWriterRecord): void => {
		const artifactId = record.result?.output?.artifact?.id;
		if (!artifactId) return;
		outputArtifacts.release({ ownerSessionId: record.ownerSessionId, artifactId });
	};
	const managedWriterControllers = new Set<AbortController>();
	const managedWriterTasks = new Set<Promise<WriterResult>>();
	let pendingManagedWriterAdmissions = 0;
	const pruneManagedWriters = (): void => {
		while (managedWriters.size >= MANAGED_WRITER_LIMITS.retained) {
			const oldestTerminal = [...managedWriters.entries()].find(
				([, record]) => record.state !== "starting" && record.state !== "running",
			);
			if (!oldestTerminal) return;
			releaseManagedWriterOutput(oldestTerminal[1]);
			managedWriters.delete(oldestTerminal[0]);
		}
	};
	const reserveManagedWriterAdmission = (): void => {
		const active = [...managedWriters.values()].filter(
			(record) => record.state === "starting" || record.state === "running",
		).length;
		if (active + pendingManagedWriterAdmissions >= MANAGED_WRITER_LIMITS.maxActive) {
			throw new SubagentError("batch_admission_exhausted", "The owner reached the active managed-writer limit.");
		}
		pruneManagedWriters();
		if (managedWriters.size >= MANAGED_WRITER_LIMITS.retained) {
			throw new SubagentError("batch_admission_exhausted", "The managed-writer result ledger is full.");
		}
		pendingManagedWriterAdmissions++;
	};
	const releaseManagedWriterAdmission = (): void => {
		pendingManagedWriterAdmissions = Math.max(0, pendingManagedWriterAdmissions - 1);
	};
	const snapshotManagedWriter = (record: ManagedWriterRecord, waitExpired = false): ManagedWriterInspection => ({
		runId: record.runId,
		state: record.state,
		...(waitExpired ? { waitExpired: true } : {}),
		acceptedAt: record.acceptedAt,
		baseCommit: record.baseCommit,
		workspaceIsolation: record.workspaceIsolation,
		phase: record.phase,
		...(record.currentTool ? { currentTool: record.currentTool } : {}),
		...(record.currentPath ? { currentPath: record.currentPath } : {}),
		...(record.lastProgressAt !== undefined ? { lastProgressAt: record.lastProgressAt } : {}),
		...(checkIns.get(record.ownerSessionId)?.getState(record.runId)
			? { checkIn: checkIns.get(record.ownerSessionId)?.getState(record.runId) }
			: {}),
		...(record.result ? { result: redactWriterResult(record.result) } : {}),
	});
	const ownedManagedWriter = (runId: string, ownerSessionId: string): ManagedWriterRecord | undefined => {
		const record = managedWriters.get(runId);
		if (record && record.ownerSessionId !== ownerSessionId) {
			throw new SubagentError("capability_denied", "The managed writer is not available to this owner session.");
		}
		return record;
	};
	const waitManagedWriter = async (
		record: ManagedWriterRecord,
		waitMs: number,
		signal: AbortSignal | undefined,
	): Promise<boolean> => {
		if (record.state !== "starting" && record.state !== "running") return false;
		if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS) {
			throw new SubagentError(
				"malformed_result",
				`Management wait must be an integer between 1 and ${SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS} ms.`,
			);
		}
		return await new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (expired: boolean): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abortWait);
				resolve(expired);
			};
			const abortWait = (): void => finish(true);
			const timer = setTimeout(() => finish(true), waitMs);
			if (signal?.aborted) finish(true);
			else signal?.addEventListener("abort", abortWait, { once: true });
			void record.completion?.then(
				() => finish(false),
				() => finish(false),
			);
		});
	};
	const armManagedWriterCheckIn = (record: ManagedWriterRecord, intervalMs: number, model: string): void => {
		const coordinator = getCheckIns(record.ownerSessionId);
		if (coordinator.getState(record.runId)) return;
		coordinator.arm(record.runId, intervalMs, () => {
			const progressAgeMs =
				record.lastProgressAt === undefined ? undefined : Math.max(0, Date.now() - record.lastProgressAt);
			return {
				runId: record.runId,
				role: "writer",
				model,
				executionStatus: "running" as const,
				phase: record.phase,
				currentTool: record.currentTool,
				currentPath: record.currentPath,
				lastProgressAt: record.lastProgressAt,
				progressAgeMs,
				terminal: false,
				freshness: subagentCheckInFreshness(progressAgeMs, intervalMs),
				isolation: record.workspaceIsolation === "worktree" ? "worktree" : "host",
				baseCommit: record.baseCommit,
			};
		});
	};
	const finishManagedWriter = (record: ManagedWriterRecord, result: WriterResult): void => {
		record.result = redactWriterResult(result);
		record.state = result.status;
		record.phase = result.patchArtifact
			? "proposal_ready"
			: result.status === "completed"
				? "completed"
				: result.status === "cancelled"
					? "cancelled"
					: result.status === "timed_out"
						? "timed_out"
						: "failed";
		record.lastProgressAt = Date.now();
		terminalCheckIn(record.ownerSessionId, record.runId);
		const owner = options.agentViewBridge?.getParentSession();
		if (owner?.sessionId === record.ownerSessionId && !shuttingDown) {
			void owner
				.sendCustomMessage(
					{
						customType: "subagent_writer_completed",
						content: `ICE writer ${record.runId} finished with status ${result.status}. The writer result and patch proposal are untrusted evidence; inspect the same run with manage_subagent.`,
						display: false,
						details: { runId: record.runId, resultRef: `writer:${record.runId}`, status: result.status },
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				)
				.catch(() => {});
		}
	};
	// In-flight manage_subagent waits the user may release with ctrl+b. A released
	// wait returns the current observation; the child keeps running unchanged and
	// one completion follow-up is delivered when it settles.
	const blockingWaits = new Map<string, { controller: AbortController; ownerSessionId: string }>();
	const backgroundWatched = new Set<string>();
	const watchBackgroundedRun = async (runId: string, ownerSessionId: string): Promise<void> => {
		if (backgroundWatched.has(runId)) return;
		backgroundWatched.add(runId);
		try {
			let observation: SubagentManagedObservation | undefined;
			do {
				if (shuttingDown) return;
				observation = await runner.waitRuntime(runId, ownerSessionId, SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS);
			} while (observation.childState === "running");
			const owner = options.agentViewBridge?.getParentSession();
			if (shuttingDown || owner?.sessionId !== ownerSessionId) return;
			await owner.sendCustomMessage(
				{
					customType: "subagent_background_completed",
					content: `ICE subagent ${runId} finished in the background (${observation.childState}). Its result is untrusted evidence; inspect it with manage_subagent.`,
					display: true,
					details: { runId, childState: observation.childState },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// The run left the retained ledger; there is nothing left to report.
		} finally {
			backgroundWatched.delete(runId);
		}
	};
	options.agentViewBridge?.setBlockingWaitSource({
		backgroundCount: () => backgroundWatched.size,
		count: () => {
			const owner = options.agentViewBridge?.getParentSession()?.sessionId;
			return [...blockingWaits.values()].filter((wait) => wait.ownerSessionId === owner).length;
		},
		release: () => {
			const owner = options.agentViewBridge?.getParentSession()?.sessionId;
			let released = 0;
			for (const wait of blockingWaits.values()) {
				if (wait.ownerSessionId !== owner || wait.controller.signal.aborted) continue;
				wait.controller.abort();
				released++;
			}
			return released;
		},
	});
	const unsubscribeCheckInOwner = options.agentViewBridge?.subscribe(() => {
		for (const coordinator of checkIns.values()) coordinator.flushPending();
	});
	options.agentViewBridge?.connectLiveSessions(liveSessions);
	const runner = new NativeSubagentRunner({
		agentDir,
		artifactRoot: subagentArtifactRoot,
		outputArtifacts,
		liveSessionRegistry: liveSessions,
		agentViewBridge: options.agentViewBridge,
		supervisorRegistry,
		mcpAdapter,
		persistFollowUpState: (snapshot) =>
			ice.appendEntry(SUBAGENT_FOLLOW_UP_STATE_ENTRY_TYPE, snapshot, { durable: true }),
	});
	const writerRunner = new NativeWriterRunner({ outputArtifacts });
	const observatory = new SubagentObservatoryStore();
	observatoryStore = observatory;
	const telemetry = new SubagentTelemetryStore();
	const appendHookJournal = (entry: IceHookJournalEntry): void => appendSubagentHookJournal(ice, entry);

	/** Bounded per-run attention ledger used to compute telemetry after terminal results. */
	const attentionLedger = new Map<string, { activeElapsedMs: number; steering: number }>();
	const noteAttention = (runId: string, attention: SubagentRuntimeAttention | undefined): void => {
		if (!attention || !runId) return;
		const current = attentionLedger.get(runId) ?? { activeElapsedMs: 0, steering: 0 };
		attentionLedger.set(runId, {
			activeElapsedMs: Math.max(current.activeElapsedMs, attention.activeElapsedMs ?? 0),
			steering: current.steering,
		});
	};
	const noteSteering = (runId: string): void => {
		const current = attentionLedger.get(runId) ?? { activeElapsedMs: 0, steering: 0 };
		attentionLedger.set(runId, { ...current, steering: current.steering + 1 });
	};
	const armManagedBatchChild = (
		record: ManagedSubagentBatchRecord,
		task: ResolvedSubagentBatchTask,
		handle: SubagentManagedHandle,
		unsafeHostExec: boolean,
	): void => {
		const state = record.tasks.get(task.id);
		if (state) state.status = "running";
		record.state = "running";
		const coordinator = getCheckIns(task.request.parentSessionId);
		if (coordinator.getState(handle.runId)) return;
		coordinator.arm(handle.runId, task.request.checkInIntervalMs, () => {
			const attention = runner.getRuntimeAttention(handle.runId, task.request.parentSessionId);
			const lastActivity = attention?.lastActivities.at(-1);
			return {
				runId: handle.runId,
				role: task.request.role,
				model: modelLabel(task.model) ?? "unknown",
				executionStatus: "running" as const,
				phase: attention?.phase,
				currentTool: lastActivity?.toolName,
				currentPath: lastActivity?.path,
				lastProgressAt: attention?.lastProgressAtMs,
				progressAgeMs: attention?.progressAgeMs,
				recentActivities: attention?.lastActivities.slice(-3).map(formatSubagentToolActivity),
				terminal: attention?.state === "terminal",
				freshness: subagentCheckInFreshness(attention?.progressAgeMs, task.request.checkInIntervalMs),
				isolation: unsafeHostExec ? ("host" as const) : ("read-only" as const),
			};
		});
	};
	const noteManagedBatchChildTerminal = (
		record: ManagedSubagentBatchRecord,
		task: ResolvedSubagentBatchTask,
		result: SubagentResult | undefined,
	): void => {
		terminalCheckIn(task.request.parentSessionId, task.request.runId);
		const artifactId = result?.output?.artifact?.id;
		if (
			artifactId &&
			outputArtifacts.retain({
				ownerSessionId: record.ownerSessionId,
				artifactId,
				referenceId: managedBatchOutputReference(record.batchId),
			})
		) {
			record.outputArtifactIds.add(artifactId);
		}
		const state = record.tasks.get(task.id);
		if (state) {
			state.status =
				result?.status === "completed" || result?.status === "verification_failed"
					? "completed"
					: result?.status === "cancelled"
						? "cancelled"
						: result?.status === "timed_out"
							? "timed_out"
							: "failed";
		}
	};
	const recordTelemetry = (
		runId: string,
		profile: string,
		mode: SubagentOutcomeTelemetryInput["mode"],
		result: SubagentResult,
		verification: SubagentVerification,
		requiredCriteriaTotal: number,
	): void => {
		const attention = attentionLedger.get(runId);
		telemetry.record({
			runId,
			profile,
			mode,
			attempts: result.recovery?.attemptCount ?? 1,
			extensionCount: 0,
			activeElapsedMs: attention?.activeElapsedMs ?? 0,
			finalStatus: result.status,
			reportProtocolStatus:
				result.workArtifact?.reportProtocol.status ?? (result.status === "completed" ? "valid" : "missing"),
			verificationPassed: verification.structuredVerified === true && result.status === "completed",
			requiredCriteriaTotal,
			requiredCriteriaSatisfied:
				verification.requirementSummary?.requiredSatisfied ?? (verification.verified ? requiredCriteriaTotal : 0),
			parentSteeringCount: attention?.steering ?? 0,
			usage: result.usage,
		});
		attentionLedger.delete(runId);
	};
	let subagentAdmission: SubagentConcurrencyAdmission | undefined;
	let parentBusy = false;
	let shuttingDown = false;
	type ParentRunState = {
		registry: SubagentJobRegistry | undefined;
		signal: AbortSignal | undefined;
		acceptedJobIds: Set<string>;
		cancellationPromise?: Promise<void>;
		abortListener?: () => void;
	};
	let parentRunState: ParentRunState | undefined;
	const pendingCompletionIds = new Set<string>();

	const cancelParentRun = (state: ParentRunState): Promise<void> => {
		if (!state.cancellationPromise) {
			state.cancellationPromise = state.registry
				? state.registry.cancelSubset([...state.acceptedJobIds]).catch(() => {})
				: Promise.resolve();
		}
		return state.cancellationPromise;
	};
	const detachParentRun = (state: ParentRunState): void => {
		if (state.signal && state.abortListener) state.signal.removeEventListener("abort", state.abortListener);
		if (parentRunState === state) parentRunState = undefined;
	};
	const beginParentRun = (ctx: ExtensionContext): void => {
		if (parentRunState) detachParentRun(parentRunState);
		const state: ParentRunState = {
			registry: jobs,
			signal: ctx.signal,
			acceptedJobIds: new Set<string>(),
		};
		const abortListener = (): void => {
			void cancelParentRun(state);
		};
		state.abortListener = abortListener;
		parentRunState = state;
		if (state.signal) {
			if (state.signal.aborted) abortListener();
			else state.signal.addEventListener("abort", abortListener, { once: true });
		}
	};

	const deliverCompletion = (jobId: string): void => {
		if (shuttingDown || parentBusy || !jobs) return;
		let inspection: SubagentJobInspection;
		try {
			inspection = jobs.inspect(jobId);
		} catch {
			return;
		}
		ice.sendMessage(
			{
				customType: JOB_COMPLETION_MESSAGE_TYPE,
				content:
					`ICE background job ${jobId} ${inspection.job.status}. ` +
					`Result: ${inspection.job.resultRef}. Use inspect_subagent_job to inspect it.`,
				display: true,
				details: {
					jobId,
					status: inspection.job.status,
					resultRef: inspection.job.resultRef,
				},
			},
			{ triggerTurn: false },
		);
	};
	const queueCompletion = (jobId: string): void => {
		if (shuttingDown || !jobs) return;
		if (parentBusy) pendingCompletionIds.add(jobId);
		else deliverCompletion(jobId);
	};
	const drainCompletionNotifications = (): void => {
		if (parentBusy || shuttingDown) return;
		const pending = [...pendingCompletionIds];
		pendingCompletionIds.clear();
		for (const jobId of pending) deliverCompletion(jobId);
	};

	const delegateWrite: DelegateWriteTool = {
		name: "delegate_write",
		label: "delegate_write",
		executionMode: "sequential",
		description:
			"Run one managed ICE writer and return its handle after clean parent/worktree preflight; inspect or stop it with manage_subagent. Normal mode uses a clean detached Git worktree and returns an immutable bounded patch proposal. Explicit --sub-yolo uses the trusted parent workspace directly, including dirty files, and may use Bash; it provides no isolation, rollback, or patch proposal. The child always uses the current parent model.",
		promptSnippet: "Delegate one bounded writer (isolated normally, direct in YOLO)",
		parameters: delegateWriteParameters,
		renderCall: (args, theme, context) => renderObservatoryCall("delegate_write", args, theme, context),
		renderResult: (result, options, theme, context) => renderObservatoryResult(result, options, theme, context),
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			publishWorkflowProgress(
				observatory,
				toolCallId,
				"delegate_write",
				{ phase: "created", status: "created", cwd: ctx.cwd },
				onUpdate,
			);
			let normalizedRequest: NormalizedWriterRequest | undefined;
			let directWorkspace = false;
			let admissionReserved = false;
			let writerController: AbortController | undefined;
			let removeWriterAbortListener: (() => void) | undefined;
			try {
				const unsafeAuthorization = authorizeUnsafeSubagentHostExecution(ctx, options, subYoloEnabled());
				directWorkspace = unsafeAuthorization !== undefined;
				const request: WriterRequest = {
					parentSessionId: ctx.sessionManager.getSessionId(),
					task: params.task,
					scope: params.scope,
					baseCommit: params.baseCommit,
					cwd: ctx.cwd,
					timeoutMs: params.startupTimeoutMs,
				};
				const normalized = normalizeWriterRequest(request, ctx.cwd, {
					allowExternal: unsafeAuthorization?.allowExternal === true,
				});
				normalizedRequest = normalized;
				const model = requireParentModel(ctx);
				const checkInIntervalMs = params.checkInIntervalMs ?? SUBAGENT_CHECKIN_INTERVAL_MS;
				if (!Number.isSafeInteger(checkInIntervalMs) || checkInIntervalMs < SUBAGENT_CHECKIN_INTERVAL_MS) {
					throw new SubagentError(
						"malformed_result",
						`checkInIntervalMs must be an integer of at least ${SUBAGENT_CHECKIN_INTERVAL_MS} ms.`,
					);
				}
				reserveManagedWriterAdmission();
				admissionReserved = true;
				const controller = new AbortController();
				writerController = controller;
				managedWriterControllers.add(controller);
				const abortWriter = (): void => controller.abort();
				if (signal) {
					if (signal.aborted) abortWriter();
					else signal.addEventListener("abort", abortWriter, { once: true });
				}
				removeWriterAbortListener = signal ? () => signal.removeEventListener("abort", abortWriter) : undefined;
				let resolveAdmitted: ((record: ManagedWriterRecord) => void) | undefined;
				const admitted = new Promise<ManagedWriterRecord>((resolve) => {
					resolveAdmitted = resolve;
				});
				let managedRecord: ManagedWriterRecord | undefined;
				let trackedRun: Promise<WriterResult> | undefined;
				const rawRun = writerRunner.run(
					normalized,
					directWorkspace ? parentToolSnapshot(unsafeAuthorization) : ice.getActiveTools(),
					{
						model,
						modelRuntime: ctx.modelRegistry.getRuntime(),
						directWorkspace,
						unsafeHostExec: directWorkspace,
						signal: controller.signal,
						onAdmitted: (admission) => {
							if (admissionReserved) {
								releaseManagedWriterAdmission();
								admissionReserved = false;
							}
							managedRecord = {
								runId: admission.runId,
								ownerSessionId: request.parentSessionId,
								state: "starting",
								acceptedAt: Date.now(),
								baseCommit: admission.baseCommit,
								workspaceIsolation: admission.workspaceIsolation,
								phase: "workspace_created",
								controller,
							};
							managedWriters.set(managedRecord.runId, managedRecord);
							if (trackedRun) managedRecord.completion = trackedRun;
							resolveAdmitted?.(managedRecord);
						},
						onEvent: (event) => {
							try {
								if (managedRecord) {
									managedRecord.phase = event.phase;
									managedRecord.currentTool = event.currentTool;
									managedRecord.currentPath = event.currentPath;
									managedRecord.lastProgressAt = Date.now();
									if (event.phase === "running") {
										managedRecord.state = "running";
										armManagedWriterCheckIn(managedRecord, checkInIntervalMs, modelLabel(model) ?? "unknown");
									}
								}
								publishWorkflowProgress(
									observatory,
									toolCallId,
									"delegate_write",
									{
										runId: event.runId,
										model: modelLabel(model),
										phase: event.phase,
										status: event.status,
										cwd: ctx.cwd,
										currentTool: event.currentTool,
										currentPath: event.currentPath,
										artifactReady: event.artifactReady,
										changedFileCount: event.changedFileCount,
										artifactStatus: event.artifactStatus,
										diagnostics: event.diagnostics,
									},
									onUpdate,
								);
							} catch {
								// Progress observers cannot change writer execution.
							}
						},
					},
				);
				const completion = rawRun.then(
					(result) => {
						if (managedRecord) finishManagedWriter(managedRecord, result);
						return result;
					},
					(error: unknown) => {
						const message = redactCredentialText(error instanceof Error ? error.message : String(error));
						const failedResult = redactWriterResult({
							runId: managedRecord?.runId ?? randomUUID(),
							parentSessionId: request.parentSessionId,
							status: "failed",
							workspaceIsolation: directWorkspace ? "parent" : "worktree",
							summary: message,
							baseCommit: normalized.baseCommit,
							observedOutputBytes: 0,
							workspaceRemoved: !directWorkspace,
							diagnostics: [{ code: "child_runtime_failure", message }],
						});
						if (managedRecord) finishManagedWriter(managedRecord, failedResult);
						return failedResult;
					},
				);
				trackedRun = completion;
				if (managedRecord) managedRecord.completion = completion;
				managedWriterTasks.add(completion);
				void completion.finally(() => {
					removeWriterAbortListener?.();
					removeWriterAbortListener = undefined;
					if (writerController) managedWriterControllers.delete(writerController);
					managedWriterTasks.delete(completion);
					if (admissionReserved) {
						releaseManagedWriterAdmission();
						admissionReserved = false;
					}
				});
				// A writer that finishes before admission (preflight failure) returns its result directly.
				const outcome = await Promise.race([
					admitted.then((record) => ({ kind: "admitted" as const, record })),
					completion.then((completed) => ({ kind: "completed" as const, result: completed })),
				]);
				if (outcome.kind === "admitted") {
					return {
						content: [
							{
								type: "text",
								text: `Writer ${outcome.record.runId} accepted after clean parent/worktree preflight. It is still running in ${outcome.record.workspaceIsolation === "worktree" ? "an isolated worktree" : "the explicitly authorized parent workspace"}; inspect or stop it with manage_subagent. No patch is integrated automatically.`,
							},
						],
						details: {
							accepted: {
								runId: outcome.record.runId,
								resultRef: `writer:${outcome.record.runId}`,
								baseCommit: outcome.record.baseCommit,
								workspaceIsolation: outcome.record.workspaceIsolation,
							},
						},
						isError: false,
					};
				}
				const result = outcome.result;
				const safeResult = redactWriterResult(result);
				const progress = publishWorkflowProgress(
					observatory,
					toolCallId,
					"delegate_write",
					{
						phase: result.patchArtifact
							? "proposal_ready"
							: result.status === "completed"
								? "completed"
								: result.status === "cancelled"
									? "cancelled"
									: result.status === "timed_out"
										? "timed_out"
										: "failed",
						status: result.status,
						runId: result.runId,
						model: modelLabel(model),
						cwd: ctx.cwd,
						artifactReady: result.patchArtifact !== undefined,
						...(result.patchArtifact
							? { changedFileCount: result.patchArtifact.files.length, artifactStatus: "ready" }
							: {}),
						diagnostics: result.diagnostics.map((diagnostic) => diagnostic.code),
					},
					onUpdate,
				);
				return {
					content: [{ type: "text", text: formatWriterToolResult(safeResult) }],
					details: { result: safeResult, ...(progress ? { progress } : {}) },
					isError: safeResult.status !== "completed" || (!directWorkspace && !safeResult.workspaceRemoved),
				};
			} catch (error) {
				removeWriterAbortListener?.();
				if (writerController) managedWriterControllers.delete(writerController);
				if (admissionReserved) releaseManagedWriterAdmission();
				const message = error instanceof Error ? error.message : String(error);
				const code = error instanceof SubagentError ? error.code : "child_startup_failure";
				const failedResult = redactWriterResult({
					runId: randomUUID(),
					parentSessionId: ctx.sessionManager.getSessionId(),
					status: "failed",
					workspaceIsolation: directWorkspace ? "parent" : "worktree",
					summary: message,
					baseCommit: normalizedRequest?.baseCommit ?? params.baseCommit,
					observedOutputBytes: 0,
					workspaceRemoved: !directWorkspace,
					diagnostics: [{ code, message }],
				});
				publishWorkflowProgress(
					observatory,
					toolCallId,
					"delegate_write",
					{ phase: "failed", status: "failed", cwd: ctx.cwd, diagnostics: [code] },
					onUpdate,
				);
				return {
					content: [{ type: "text", text: formatWriterToolResult(failedResult) }],
					details: { result: failedResult },
					isError: true,
				};
			}
		},
	};
	const inspectWriterPatch: WriterPatchWorkflowTool = {
		name: "inspect_writer_patch",
		label: "inspect_writer_patch",
		description:
			"Validate a completed delegate_write production artifact and return bounded metadata plus a 32 KiB patch preview. This is a parent review operation and never changes the parent tree.",
		promptSnippet: "Inspect a writer patch proposal",
		parameters: writerPatchWorkflowParameters,
		renderCall: (args, theme, context) => renderObservatoryCall("inspect_writer_patch", args, theme, context),
		renderResult: (result, options, theme, context) => renderObservatoryResult(result, options, theme, context),
		execute: async (toolCallId, params, _signal, onUpdate, ctx) => {
			publishWorkflowProgress(
				observatory,
				toolCallId,
				"inspect_writer_patch",
				{ phase: "inspecting", status: "running", cwd: ctx.cwd },
				onUpdate,
			);
			try {
				const inspected = inspectWriterPatchArtifact(params.artifact, ctx.cwd);
				const progress = publishWorkflowProgress(
					observatory,
					toolCallId,
					"inspect_writer_patch",
					{
						phase: "inspected",
						status: "completed",
						cwd: ctx.cwd,
						artifactReady: true,
						changedFileCount: inspected.artifact.files.length,
						artifactStatus: "valid",
					},
					onUpdate,
				);
				const result = redactWriterWorkflowResult({ ...inspected, ...(progress ? { progress } : {}) });
				return {
					content: [{ type: "text", text: formatWriterWorkflowResult(result) }],
					details: result,
					isError: false,
				};
			} catch (error) {
				const progress = publishWorkflowProgress(
					observatory,
					toolCallId,
					"inspect_writer_patch",
					{ phase: "verification_failed", status: "failed", cwd: ctx.cwd, diagnostics: ["artifact_invalid"] },
					onUpdate,
				);
				const result = writerWorkflowFailure("artifact_invalid", error);
				if (progress) result.progress = progress;
				return {
					content: [{ type: "text", text: formatWriterWorkflowResult(result) }],
					details: result,
					isError: true,
				};
			}
		},
	};
	const rejectWriterPatch: WriterPatchWorkflowTool = {
		name: "reject_writer_patch",
		label: "reject_writer_patch",
		description:
			"Record the current parent decision to reject a validated writer patch proposal without changing, deleting, consuming, or tombstoning its immutable artifact.",
		promptSnippet: "Reject a writer patch proposal",
		parameters: writerPatchWorkflowParameters,
		renderCall: (args, theme, context) => renderObservatoryCall("reject_writer_patch", args, theme, context),
		renderResult: (result, options, theme, context) => renderObservatoryResult(result, options, theme, context),
		execute: async (toolCallId, params, _signal, onUpdate, ctx) => {
			publishWorkflowProgress(
				observatory,
				toolCallId,
				"reject_writer_patch",
				{ phase: "inspecting", status: "running", cwd: ctx.cwd },
				onUpdate,
			);
			try {
				const inspected = inspectWriterPatchArtifact(params.artifact, ctx.cwd);
				const progress = publishWorkflowProgress(
					observatory,
					toolCallId,
					"reject_writer_patch",
					{
						phase: "rejected",
						status: "completed",
						cwd: ctx.cwd,
						artifactReady: true,
						changedFileCount: inspected.artifact.files.length,
						artifactStatus: "rejected",
					},
					onUpdate,
				);
				const result: WriterWorkflowToolResult = {
					status: "rejected",
					artifact: inspected.artifact,
					parentRoot: inspected.parentRoot,
					...(progress ? { progress } : {}),
				};
				return {
					content: [{ type: "text", text: formatWriterWorkflowResult(result) }],
					details: result,
					isError: false,
				};
			} catch (error) {
				const progress = publishWorkflowProgress(
					observatory,
					toolCallId,
					"reject_writer_patch",
					{ phase: "verification_failed", status: "failed", cwd: ctx.cwd, diagnostics: ["artifact_invalid"] },
					onUpdate,
				);
				const result = writerWorkflowFailure("artifact_invalid", error);
				if (progress) result.progress = progress;
				return {
					content: [{ type: "text", text: formatWriterWorkflowResult(result) }],
					details: result,
					isError: true,
				};
			}
		},
	};
	const integrateWriterPatch: WriterPatchWorkflowTool = {
		name: "integrate_writer_patch",
		label: "integrate_writer_patch",
		description:
			"Explicitly integrate one validated delegate_write proposal into the trusted parent in build mode. A configured --ice-verify command is mandatory; W3 applies the patch transactionally and rolls back on verification or conflict failure.",
		promptSnippet: "Integrate a reviewed writer patch proposal",
		parameters: writerPatchWorkflowParameters,
		renderCall: (args, theme, context) => renderObservatoryCall("integrate_writer_patch", args, theme, context),
		renderResult: (result, options, theme, context) => renderObservatoryResult(result, options, theme, context),
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			publishWorkflowProgress(
				observatory,
				toolCallId,
				"integrate_writer_patch",
				{ phase: "validating", status: "running", cwd: ctx.cwd },
				onUpdate,
			);
			let inspected: WriterPatchInspection;
			try {
				inspected = inspectWriterPatchArtifact(params.artifact, ctx.cwd);
			} catch (error) {
				const progress = publishWorkflowProgress(
					observatory,
					toolCallId,
					"integrate_writer_patch",
					{ phase: "verification_failed", status: "failed", cwd: ctx.cwd, diagnostics: ["artifact_invalid"] },
					onUpdate,
				);
				const result = writerWorkflowFailure("artifact_invalid", error);
				if (progress) result.progress = progress;
				return {
					content: [{ type: "text", text: formatWriterWorkflowResult(result) }],
					details: result,
					isError: true,
				};
			}
			publishWorkflowProgress(
				observatory,
				toolCallId,
				"integrate_writer_patch",
				{
					phase: "inspected",
					status: "running",
					cwd: ctx.cwd,
					artifactReady: true,
					changedFileCount: inspected.artifact.files.length,
					artifactStatus: "valid",
				},
				onUpdate,
			);
			if (!ctx.isProjectTrusted()) {
				const progress = publishWorkflowProgress(
					observatory,
					toolCallId,
					"integrate_writer_patch",
					{ phase: "verification_failed", status: "failed", cwd: ctx.cwd, diagnostics: ["untrusted_project"] },
					onUpdate,
				);
				const result = writerWorkflowFailure(
					"verification_failed",
					"Writer integration requires a trusted project.",
				);
				if (progress) result.progress = progress;
				return {
					content: [{ type: "text", text: formatWriterWorkflowResult(result) }],
					details: result,
					isError: true,
				};
			}
			let verifierArgv: string[] | undefined;
			try {
				const configuredFlag = ice.getFlag("ice-verify");
				verifierArgv =
					configuredFlag === undefined ? getConfiguredIceVerifierArgv() : parseVerifierArgv(configuredFlag);
			} catch (error) {
				const progress = publishWorkflowProgress(
					observatory,
					toolCallId,
					"integrate_writer_patch",
					{ phase: "verification_failed", status: "failed", cwd: ctx.cwd, diagnostics: ["verifier_unavailable"] },
					onUpdate,
				);
				const result = writerWorkflowFailure("verifier_unavailable", error);
				if (progress) result.progress = progress;
				return {
					content: [{ type: "text", text: formatWriterWorkflowResult(result) }],
					details: result,
					isError: true,
				};
			}
			if (!verifierArgv) {
				const progress = publishWorkflowProgress(
					observatory,
					toolCallId,
					"integrate_writer_patch",
					{ phase: "verification_failed", status: "failed", cwd: ctx.cwd, diagnostics: ["verifier_unavailable"] },
					onUpdate,
				);
				const result = writerWorkflowFailure(
					"verifier_unavailable",
					"integrate_writer_patch requires a configured --ice-verify command.",
				);
				if (progress) result.progress = progress;
				return {
					content: [{ type: "text", text: formatWriterWorkflowResult(result) }],
					details: result,
					isError: true,
				};
			}
			let verification: IceVerifierState | undefined;
			let rollbackStarted = false;
			try {
				publishWorkflowProgress(
					observatory,
					toolCallId,
					"integrate_writer_patch",
					{ phase: "applying", status: "running", cwd: ctx.cwd },
					onUpdate,
				);
				const integrated = await integrateWriterPatchArtifact(params.artifact, {
					cwd: ctx.cwd,
					scopeRoots: [inspected.parentRoot],
					onRollback: () => {
						rollbackStarted = true;
						publishWorkflowProgress(
							observatory,
							toolCallId,
							"integrate_writer_patch",
							{ phase: "rolling_back", status: "running", cwd: ctx.cwd, rollbackStatus: "running" },
							onUpdate,
						);
					},
					verify: async ({ parentRoot }) => {
						publishWorkflowProgress(
							observatory,
							toolCallId,
							"integrate_writer_patch",
							{ phase: "verifying", status: "running", cwd: ctx.cwd, verifierStatus: "running" },
							onUpdate,
						);
						verification = await runVerifier(verifierArgv!, parentRoot, { signal });
						if (verification.status !== "passed") {
							throw new Error(verification.failureMessage ?? `Verifier exited with ${verification.status}.`);
						}
					},
				});
				const progress = publishWorkflowProgress(
					observatory,
					toolCallId,
					"integrate_writer_patch",
					{
						phase: "integrated",
						status: "completed",
						cwd: ctx.cwd,
						artifactReady: true,
						changedFileCount: integrated.changedPaths.length,
						artifactStatus: "integrated",
						verifierStatus: verification?.status,
					},
					onUpdate,
				);
				const result: WriterWorkflowToolResult = {
					status: "integrated",
					artifact: integrated.artifact,
					parentRoot: integrated.parentRoot,
					changedPaths: integrated.changedPaths,
					verification,
					...(progress ? { progress } : {}),
				};
				return {
					content: [{ type: "text", text: formatWriterWorkflowResult(result) }],
					details: result,
					isError: false,
				};
			} catch (error) {
				const phase =
					error instanceof SubagentError && error.code === "rollback_conflict"
						? "rollback_conflict"
						: error instanceof SubagentError && error.code === "verification_failure"
							? "verification_failed"
							: "integration_conflict";
				const progress = publishWorkflowProgress(
					observatory,
					toolCallId,
					"integrate_writer_patch",
					{
						phase,
						status: "failed",
						cwd: ctx.cwd,
						verifierStatus: verification?.status,
						rollbackStatus: rollbackStarted
							? phase === "rollback_conflict"
								? "conflict"
								: "restored"
							: undefined,
						diagnostics: [phase],
					},
					onUpdate,
				);
				const result = writerIntegrationFailure(error);
				if (progress) result.progress = progress;
				if (verification) result.verification = verification;
				return {
					content: [{ type: "text", text: formatWriterWorkflowResult(result) }],
					details: result,
					isError: true,
				};
			}
		},
	};
	const listProfiles: ListSubagentProfilesTool = {
		name: "list_subagent_profiles",
		label: "list_subagent_profiles",
		description:
			"List ICE file agents plus self-delegation, with bounded diagnostics. query is an optional substring filter, not a role-discovery oracle: an empty filtered result means no profile matched that query, not that no profiles exist. On a miss the tool returns fuzzy suggestions plus available profile names. Each profile reports requested capabilities separately from effective capabilities for this invocation; availability distinguishes available, limited, and requires_yolo. Self-delegation (role self) needs bounded parent instructions and no file; file agents resolve global-first with shadowed project sources surfaced. Children use the deterministic primary/fallback/parent model order; listing reports requested/fallback models. Listing is observational and grants no capabilities.",
		promptSnippet: "List available subagent profiles and invocation capabilities",
		parameters: listSubagentProfilesParameters,
		renderCall: (args, theme, context) => renderSubagentProfileCall(args, theme, context),
		renderResult: (result, renderOptions, theme, context) =>
			renderSubagentProfileResult(result, renderOptions, theme, context),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				let unsafeAuthorization: UnsafeSubagentAuthorization | undefined;
				if (subYoloEnabled()) {
					try {
						unsafeAuthorization = authorizeUnsafeSubagentHostExecution(ctx, options, true);
					} catch {
						// Invalid startup authorization is represented by the safe projection;
						// listing must remain diagnostic rather than granting access.
					}
				}
				const settingsManager = getParentSettingsManager(ctx);
				const projectTrusted = ctx.isProjectTrusted();
				const resolutionOptions: SubagentProfileResolutionOptions = {
					cwd: ctx.cwd,
					agentDir,
					includeSelf: true,
					delegableTools: getIceDelegableTools(ice.events),
					projectTrusted,
					parentActiveTools: parentToolSnapshot(unsafeAuthorization),
					unsafeHostExec: unsafeAuthorization !== undefined,
				};
				const query = params.query?.trim();
				const projectProfile = (raw: SubagentProfileSummary): SubagentProfileSummary => {
					const profile = applyIceProfileSettingsSummary(raw, settingsManager, projectTrusted);
					if (profile.availability === "invalid" || profile.availability === "untrusted")
						return { ...profile, effectiveTools: [], effectiveMcpTools: [] };
					try {
						const policy = resolveIceSubagentContract({
							role: profile.name,
							globalSettings: settingsManager.getGlobalSettings(),
							projectSettings: settingsManager.getProjectSettings(),
							projectTrusted,
						});
						const authorized = profile.mcpTools?.length ? mcpAdapter.listAuthorizedTools() : [];
						const effectiveMcpTools = (profile.mcpTools ?? []).filter((selector) => {
							const entry = authorized.find((entry) => entry.selector === selector);
							return (
								entry?.parameters &&
								(entry.access === "read-only" || (entry.access === "mutation" && unsafeAuthorization)) &&
								!policy.deniedTools.includes(selector.toLowerCase()) &&
								!policy.deniedTools.includes(subagentMcpToolName(selector).toLowerCase())
							);
						});
						const parent = requireParentModel(ctx);
						const configured = !!(profile.requestedModel || profile.fallbackModel);
						if (
							configured &&
							parseIceSettings(settingsManager.getGlobalSettings().ice).subagents.modelSelection.mode !==
								"configured"
						)
							throw new Error("File model candidates require global configured routing.");
						const route = configured
							? resolveIceSubagentCandidates({
									parent,
									primary: profile.requestedModel,
									fallback: profile.fallbackModel,
									runtime: ctx.modelRegistry.getRuntime(),
								})
							: undefined;
						const missingMcp = (profile.mcpTools?.length ?? 0) !== effectiveMcpTools.length;
						return {
							...profile,
							effectiveModel: modelReference(route?.model ?? parent),
							modelCandidateSkips: route?.skipped,
							effectiveMcpTools,
							effectiveTools: [...profile.effectiveTools, ...effectiveMcpTools.map(subagentMcpToolName)],
							...(missingMcp
								? {
										availability: "invalid" as const,
										diagnostics: [
											...(profile.diagnostics ?? []),
											"Selected MCP tool is unavailable, unclassified, missing its schema, or denied.",
										],
									}
								: {}),
						};
					} catch (error) {
						return {
							...profile,
							availability: "invalid",
							effectiveMcpTools: [],
							diagnostics: [
								...(profile.diagnostics ?? []),
								redactCredentialText(error instanceof Error ? error.message : String(error)).slice(0, 512),
							],
						};
					}
				};
				const profiles = listSubagentProfiles(resolutionOptions, query).map(projectProfile);
				const bounded = profiles.map((profile) => ({
					...profile,
					description: redactCredentialText(profile.description).slice(0, 512),
					sourcePath: redactCredentialText(profile.sourcePath).slice(0, 4096),
				}));
				const queryMiss = Boolean(query) && bounded.length === 0;
				const allProfiles = queryMiss ? listSubagentProfiles(resolutionOptions).map(projectProfile) : [];
				const details: SubagentProfileListingDetails = {
					profiles: bounded,
					...(query ? { query, queryMatched: bounded.length > 0 } : {}),
					...(queryMiss
						? {
								suggestions: suggestSubagentProfiles(query!, resolutionOptions),
								availableProfileNames: allProfiles.map((profile) => profile.name).slice(0, 32),
								diagnostic: `No profile matched query "${redactCredentialText(query!)}". The query filters profile identities/descriptions; omit it to list all profiles or choose one of availableProfileNames.`,
							}
						: {}),
				};
				return {
					content: [{ type: "text", text: redactCredentialText(JSON.stringify(details)) }],
					details,
					isError: false,
				};
			} catch (error) {
				const message = redactCredentialText(error instanceof Error ? error.message : String(error));
				return {
					content: [{ type: "text", text: `Profile listing rejected: ${message}` }],
					details: undefined,
					isError: true,
				};
			}
		},
	};
	const manageSubagent: ManageSubagentTool = {
		name: "manage_subagent",
		label: "manage_subagent",
		description:
			"Inspect, peek, wait, follow up, detach, stop, resume, or delete the same ICE child through one phase-aware owner-scoped lifecycle. Use the foreground runId returned by delegate: details.managed.runId for a live background launch, or details.result.runId for a retained terminal result. Do not pass a durable jobId, resultRef such as job:<id>, batchId, or taskId. Peek returns the latest bounded snapshot immediately. Wait blocks this tool call for at most waitMs until a terminal state; a wait expiry reports the current state and never changes child state. Detach retains the same live child under management so the parent can continue other work. Follow-up queues bounded untrusted task data through Ice steering, requires a stable requestId, and is rejected while a user has takeover control. Following up or detaching preserves run ID, model, profile, scope, and tool authority and cannot widen owner-scoped output artifact access. Stop explicitly cancels a live child. Resume continues a retained completed child in its original session and authority; delete forgets a retained reusable session idempotently, while managed terminal observations stay peekable.",
		promptSnippet: "Inspect, wait, follow up, stop, or manage a subagent run",
		parameters: manageSubagentParameters,
		renderCall: (args, theme, context) => renderObservatoryCall("manage_subagent", args, theme, context),
		renderResult: (result, options, theme, context) => renderObservatoryResult(result, options, theme, context),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const parentSessionId = ctx.sessionManager.getSessionId();
			try {
				const writer = ownedManagedWriter(params.runId, parentSessionId);
				if (writer) {
					let waitExpired = false;
					if (params.action === "stop") {
						if (writer.state !== "starting" && writer.state !== "running") {
							throw new SubagentError("child_protocol_failure", "The selected writer is not running.");
						}
						writer.controller.abort();
						await writer.completion?.catch(() => undefined);
					} else if (params.action === "wait") {
						waitExpired = await waitManagedWriter(
							writer,
							params.waitMs ?? SUBAGENT_MANAGEMENT_WAIT_DEFAULT_MS,
							_signal,
						);
					} else if (params.action !== "inspect" && params.action !== "peek") {
						throw new SubagentError(
							"child_protocol_failure",
							"Writer handles support inspect, peek, bounded wait, and explicit stop; they cannot be resumed, detached, or followed up.",
						);
					}
					const inspection = snapshotManagedWriter(writer, waitExpired);
					const text = [
						`Writer ${inspection.runId} is ${inspection.state}.`,
						`Isolation: ${inspection.workspaceIsolation}; base commit: ${inspection.baseCommit}.`,
						`Phase: ${inspection.phase}.`,
						formatSubagentCheckInState(inspection.checkIn),
						inspection.currentTool ? `Current tool: ${inspection.currentTool}.` : undefined,
						inspection.currentPath ? `Current scoped path: ${inspection.currentPath}.` : undefined,
						inspection.waitExpired ? "Management wait expired; the writer remains active." : undefined,
						inspection.result ? formatWriterToolResult(inspection.result) : undefined,
					]
						.filter((line): line is string => line !== undefined)
						.join("\n");
					return {
						content: [{ type: "text", text: truncateSubagentOutput(redactCredentialText(text), 16 * 1024).text }],
						details: { action: params.action, runId: params.runId, writer: inspection },
						isError: false,
					};
				}
				if (params.action === "peek") {
					const observation = runner.peekRuntime(params.runId, parentSessionId);
					if (!observation)
						throw new SubagentError(
							"child_protocol_failure",
							"The selected subagent is not a live retained run owned by this parent session.",
						);
					const observed = withCheckIn(observation, parentSessionId);
					const verification = managedVerificationFor(parentSessionId, observed);
					return {
						content: [{ type: "text", text: formatManagedObservation(observed, verification) }],
						details: {
							action: "peek" as const,
							runId: params.runId,
							observation: observed,
							...(verification ? { verification } : {}),
						},
						isError: false,
					};
				}
				if (params.action === "wait") {
					const release = new AbortController();
					const waitKey = `${_toolCallId}\u0000${params.runId}`;
					blockingWaits.set(waitKey, { controller: release, ownerSessionId: parentSessionId });
					let observation: SubagentManagedObservation;
					try {
						observation = await runner.waitRuntime(
							params.runId,
							parentSessionId,
							params.waitMs ?? SUBAGENT_MANAGEMENT_WAIT_DEFAULT_MS,
							_signal ? AbortSignal.any([_signal, release.signal]) : release.signal,
						);
					} finally {
						blockingWaits.delete(waitKey);
					}
					const backgrounded = release.signal.aborted && !_signal?.aborted && observation.childState === "running";
					if (backgrounded) void watchBackgroundedRun(params.runId, parentSessionId);
					const observed = withCheckIn(observation, parentSessionId);
					const verification = managedVerificationFor(parentSessionId, observed);
					const backgroundNote = backgrounded
						? "The user moved this wait to the background. The subagent is still running with unchanged authority and budget; a follow-up message arrives when it finishes. Do not report or assume its result before then: continue other work, or end your turn instead of waiting again.\n\n"
						: "";
					return {
						content: [{ type: "text", text: backgroundNote + formatManagedObservation(observed, verification) }],
						details: {
							action: "wait" as const,
							runId: params.runId,
							observation: observed,
							...(backgrounded ? { backgrounded: true } : {}),
							...(verification ? { verification } : {}),
						},
						isError: false,
					};
				}
				if (params.action === "detach") {
					const observation = runner.detachRuntime(params.runId, parentSessionId);
					if (!observation)
						throw new SubagentError(
							"child_protocol_failure",
							"The selected subagent is not a live retained run that can be detached.",
						);
					const observed = withCheckIn(observation, parentSessionId);
					return {
						content: [
							{
								type: "text",
								text: `Detached retained subagent ${params.runId}; it keeps the same run ID, child session, model, scope, and tool authority.\n${formatManagedObservation(observed)}`,
							},
						],
						details: { action: "detach" as const, runId: params.runId, observation: observed },
						isError: false,
					};
				}
				if (params.action === "inspect") {
					const attention = runner.getRuntimeAttention(params.runId, parentSessionId);
					if (!attention)
						throw new SubagentError(
							"child_protocol_failure",
							"The selected subagent is not a live retained run owned by this parent session.",
						);
					const checkIn = checkIns.get(parentSessionId)?.getState(params.runId);
					return {
						content: [
							{
								type: "text",
								text: [formatRuntimeAttention(attention), formatSubagentCheckInState(checkIn)]
									.filter((part): part is string => part !== undefined)
									.join("\n"),
							},
						],
						details: {
							action: "inspect" as const,
							runId: params.runId,
							attention,
							...(checkIn ? { checkIn } : {}),
						},
						isError: false,
					};
				}
				if (params.action === "follow_up") {
					if (!params.requestId || !params.message) {
						throw new SubagentError(
							"malformed_result",
							"follow_up requires a stable requestId and a bounded message.",
						);
					}
					const followUp = await runner.followUpRuntime(
						params.runId,
						parentSessionId,
						params.requestId,
						params.message,
					);
					return {
						content: [
							{
								type: "text",
								text:
									followUp.status === "duplicate"
										? `Follow-up ${params.requestId} was already accepted for ${params.runId}.`
										: `Follow-up ${params.requestId} was queued for ${params.runId}; it cannot widen the existing scope or tools.`,
							},
						],
						details: { action: "follow_up" as const, runId: params.runId, followUp },
						isError: false,
					};
				}
				if (params.action === "resume") {
					// Phase gate: resume is valid only for a retained terminal child. A live
					// run (supervisor-owned) or an in-flight resume claim must fail here
					// instead of reaching the session layer.
					if (runner.getOwnedSupervisor(params.runId, parentSessionId)) {
						throw new SubagentError(
							"child_protocol_failure",
							"The selected subagent is still active; only a retained completed child can be resumed.",
						);
					}
					if (!params.message) {
						throw new SubagentError("malformed_result", "resume requires a bounded message.");
					}
					const settingsManager = getParentSettingsManager(ctx);
					const resumed = await runner.resumeRuntime(
						params.runId,
						parentSessionId,
						params.message,
						[...ice.getActiveTools()],
						{
							modelRuntime: ctx.modelRegistry.getRuntime(),
							signal: _signal,
							createHookRuntimeFor: (request) =>
								createSubagentHookRuntime(ctx, settingsManager, request, options, undefined, appendHookJournal),
							isAuthorityStillValidFor: (request, hookRuntime) =>
								isCurrentSubagentAuthorityValid(ctx, settingsManager, request, hookRuntime),
						},
					);
					return {
						content: [
							{
								type: "text",
								text: `Resumed retained subagent ${params.runId} as ${resumed.runId}. Final status: ${resumed.status}.\n${resumed.summary}`,
							},
						],
						details: {
							action: "resume" as const,
							runId: params.runId,
							resumedFromRunId: params.runId,
							result: redactSubagentResult(resumed),
						},
						isError: resumed.status !== "completed",
					};
				}
				if (params.action === "delete") {
					// Phase gate: delete is valid only for a retained terminal child. A live
					// run must be stopped first; the runner enforces the same boundary.
					if (runner.getOwnedSupervisor(params.runId, parentSessionId)) {
						throw new SubagentError(
							"child_protocol_failure",
							"The selected subagent is still active; stop it before deleting.",
						);
					}
					const deleted = await runner.deleteRetainedChild(params.runId, parentSessionId);
					return {
						content: [
							{
								type: "text",
								text: deleted.deleted
									? `Deleted retained subagent ${params.runId}.`
									: `Retained subagent ${params.runId} was already forgotten; nothing to delete.`,
							},
						],
						details: { action: "delete" as const, runId: params.runId, deleted },
						isError: false,
					};
				}
				// Phase gate: stop is valid only for a live run. A retained terminal
				// child has no supervisor to stop; stopping it again is a no-op
				// rejected here so terminal handles cannot masquerade as live runs.
				if (!runner.getOwnedSupervisor(params.runId, parentSessionId)) {
					throw new SubagentError(
						"child_protocol_failure",
						"The selected subagent is not running; retained terminal children support peek, wait, resume, or delete.",
					);
				}
				const result = await runner.stopRuntime(params.runId, parentSessionId);
				return {
					content: [
						{ type: "text", text: `Stopped retained subagent ${params.runId}. Final status: ${result.status}.` },
					],
					details: { action: "stop" as const, runId: params.runId, result: redactSubagentResult(result) },
					isError: false,
				};
			} catch (error) {
				const message = formatManagedIdentifierError(error, params.runId);
				return {
					content: [{ type: "text", text: `Subagent management rejected: ${message}` }],
					details: formatSubagentToolError(error),
					isError: true,
				};
			}
		},
	};
	const delegate: DelegateTool = {
		name: "delegate",
		label: "delegate",
		description: `${SUBAGENT_SCOPE_TOOL_GUIDANCE} ${SUBAGENT_INTERNAL_REPORT_GUIDANCE} Delegation is for parallel fan-out, not single errands: never delegate a simple single task you can complete directly with your own parent tools; launch a child only when the plan calls for at least two children (delegate_batch or concurrent background delegate launches). Run one managed ICE child as a file agent or self-delegation (role self with bounded parent instructions; no file needed). Delegate always returns a managed handle after the child starts; periodic check-ins are advisory and do not expire or interrupt the child. Use manage_subagent to inspect, follow up, wait, or stop; read a large final answer with read_subagent_output when the result carries an output artifact. File agents resolve global-first; models follow the deterministic call/primary/fallback/parent order without credential expansion. Safe mode clamps the selected profile to its requested read-only capabilities. Explicit --sub-yolo permits only the selected profile's requested built-in capabilities that are also active in the trusted parent after build-mode, trust, and parent-Bash checks; it does not grant every parent tool. Trusted ambient resources may load, but model-visible authority remains the explicit child tool allowlist and recursive delegation is not authorized. This is not a filesystem sandbox; the parent verifies and synthesizes the evidence.`,
		promptSnippet: "Delegate one bounded file/self subagent",
		promptGuidelines: [...SUBAGENT_DELEGATION_POLICY_GUIDELINES],
		parameters: delegateParameters,
		renderCall: (args, theme, context) => renderObservatoryCall("delegate", args, theme, context),
		renderResult: (result, options, theme, context) => renderObservatoryResult(result, options, theme, context),
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			publishWorkflowProgress(
				observatory,
				toolCallId,
				"delegate",
				{ phase: "created", status: "created", cwd: ctx.cwd, role: params.role },
				onUpdate,
			);
			const request: SubagentRequest = {
				parentSessionId: ctx.sessionManager.getSessionId(),
				role: params.role,
				task: params.task,
				scope: params.scope,
				cwd: ctx.cwd,
				context: params.context,
				contextPacket: params.contextPacket,
				contextMode: params.contextMode,
				checkInIntervalMs: params.checkInIntervalMs,
				timeoutMs: params.startupTimeoutMs,
				execution: params.execution,
				resources: params.resources,
				acceptanceCriteria: params.acceptanceCriteria,
				preflight: params.preflight,
				outputSchema: params.outputSchema,
				...(params.self !== undefined
					? {
							self: {
								...params.self,
								...(params.self.capabilities !== undefined
									? { capabilities: [...params.self.capabilities] }
									: {}),
							},
						}
					: {}),
			};
			try {
				if (
					params.checkInIntervalMs !== undefined &&
					(!Number.isSafeInteger(params.checkInIntervalMs) ||
						params.checkInIntervalMs < SUBAGENT_CHECKIN_INTERVAL_MS)
				)
					throw new SubagentError(
						"malformed_result",
						`checkInIntervalMs must be an integer of at least ${SUBAGENT_CHECKIN_INTERVAL_MS} ms.`,
					);
				const projectTrusted = ctx.isProjectTrusted();
				const settingsManager = getParentSettingsManager(ctx);
				const unsafeAuthorization = authorizeUnsafeSubagentHostExecution(ctx, options, subYoloEnabled());
				let normalized = normalizeSubagentRequest(request, ctx.cwd, {
					...parentSnapshotOptions(ctx, request, unsafeAuthorization),
					projectTrusted,
					parentContext: request.contextMode === "fork" ? ctx.sessionManager : undefined,
					allowExternal: unsafeAuthorization?.allowExternal === true,
					settingsManager,
					agentDir,
				});
				const model = resolveRequestedSubagentModel(ctx, settingsManager, normalized);
				validateSubagentMcpAdmission(normalized, mcpAdapter, unsafeAuthorization !== undefined);
				const preflightGate = gateSubagentPreflight(normalized);
				// Journal every parent-owned hook dispatch for crash ambiguity recovery.
				if (preflightGate.blocked) {
					publishWorkflowProgress(
						observatory,
						toolCallId,
						"delegate",
						{
							phase: "failed",
							status: "failed",
							cwd: ctx.cwd,
							role: params.role,
							diagnostics: ["preflight_failed"],
						},
						onUpdate,
					);
					return {
						content: [{ type: "text", text: formatSubagentPreflightFailure(preflightGate.evaluation) }],
						details: {
							result: {
								runId: normalized.runId,
								parentSessionId: normalized.parentSessionId,
								profile: normalized.profile.name,
								source: normalized.profile.source,
								status: "failed" as const,
								summary: "Required environment preflight failed; no child run was consumed.",
								observedOutputBytes: 0,
								partial: false,
								diagnostics: [
									{
										code: "preflight_failed" as const,
										message: formatSubagentPreflightFailure(preflightGate.evaluation),
									},
								],
							},
							verification: {
								verified: false,
								reason: "Required environment preflight failed before child launch.",
								paths: [],
								unresolvedClaims: [],
							},
							launch: createSubagentLaunchProvenance(normalized, model),
						},
						isError: true,
					};
				}
				const hookRuntime = createSubagentHookRuntime(
					ctx,
					settingsManager,
					normalized,
					options,
					undefined,
					appendHookJournal,
				);
				const hookContextAdditions = await dispatchSubagentHookDecision(
					hookRuntime,
					"subagent.beforeLaunch",
					{
						role: normalized.role,
						task: normalized.task,
						scopeRoots: normalized.scope.roots,
						tools: normalized.execution.tools ?? normalized.profile.requestedTools,
						budgets: normalized.execution,
					},
					signal,
				);
				normalized = applySubagentHookContextAdditions(normalized, hookContextAdditions);
				const postHookPreflight = gateSubagentPreflight(normalized);
				if (postHookPreflight.blocked) {
					throw new SubagentError(
						"preflight_failed",
						formatSubagentPreflightFailure(postHookPreflight.evaluation),
					);
				}
				if (!isCurrentSubagentAuthorityValid(ctx, settingsManager, normalized, hookRuntime)) {
					throw new SubagentError(
						"capability_denied",
						"Current settings, trust, profile, resources, or hooks changed during beforeLaunch.",
					);
				}
				const breadthAdvisory = describeSubagentDelegationBreadth(normalized);
				const unsafeHostExec = unsafeAuthorization !== undefined;
				const parentActiveTools = unsafeAuthorization
					? [...unsafeAuthorization.parentActiveTools]
					: [...ice.getActiveTools()];
				const effectiveParentActiveTools = parentActiveTools;
				let resolveManagedHandle: ((handle: SubagentManagedHandle) => void) | undefined;
				let managedHandleDelivered = false;
				const managedHandlePromise = new Promise<SubagentManagedHandle>((resolve) => {
					resolveManagedHandle = resolve;
				});
				const runChild = (
					attempt: 1 | 2,
					childRequest: NormalizedSubagentRequest,
					activeTools: readonly string[],
				) =>
					runner.runResolved(childRequest, activeTools, {
						model: childRequest.retryModel ?? model,
						modelRuntime: ctx.modelRegistry.getRuntime(),
						settingsManager,
						projectTrusted: childRequest.projectTrusted,
						unsafeHostExec,
						attempt,
						noLifetimeTimeout: true,
						signal,
						isAuthorityStillValid: () =>
							isCurrentSubagentAuthorityValid(ctx, settingsManager, childRequest, hookRuntime),
						onRuntimeAttention: (attention) => noteAttention(childRequest.runId, attention),
						onSteering: (steeredRunId) => noteSteering(steeredRunId),
						hookRuntime,
						onEvent: (event) =>
							publishRuntimeProgress(observatory, toolCallId, "delegate", ctx.cwd, event, onUpdate),
						onManagedHandle: (handle: SubagentManagedHandle) => {
							const coordinator = getCheckIns(normalized.parentSessionId);
							if (!coordinator.getState(handle.runId))
								coordinator.arm(handle.runId, childRequest.checkInIntervalMs, () => {
									const attention = runner.getRuntimeAttention(handle.runId, normalized.parentSessionId);
									return {
										runId: handle.runId,
										role: childRequest.role,
										model: modelLabel(childRequest.retryModel ?? model) ?? "unknown",
										executionStatus: "running" as const,
										phase: attention?.phase,
										currentTool: attention?.lastActivities.at(-1)?.toolName,
										currentPath: attention?.lastActivities.at(-1)?.path,
										terminal: attention?.state === "terminal",
										lastProgressAt: attention?.lastProgressAtMs,
										progressAgeMs: attention?.progressAgeMs,
										recentActivities: attention?.lastActivities.slice(-3).map(formatSubagentToolActivity),
										freshness: subagentCheckInFreshness(
											attention?.progressAgeMs,
											childRequest.checkInIntervalMs,
										),
										isolation: unsafeHostExec ? ("host" as const) : ("read-only" as const),
									};
								});
							managedHandleDelivered = true;
							rememberManagedRequest(childRequest);
							resolveManagedHandle?.(handle);
						},
					});
				const runPromise = unsafeHostExec
					? runChild(1, normalized, effectiveParentActiveTools)
					: runSubagentWithRecovery(normalized, effectiveParentActiveTools, runChild, {
							getStopReason: () => (signal?.aborted ? "cancelled" : undefined),
						});
				void runPromise.then(
					(settled) => {
						terminalCheckIn(normalized.parentSessionId, normalized.runId);
						// A result that settles before the handle is returned directly below.
						if (!managedHandleDelivered) return;
						const request =
							managedRequests.get(managedRequestKey(normalized.parentSessionId, settled.runId)) ?? normalized;
						recordTelemetry(
							settled.runId,
							normalized.role,
							"foreground",
							settled,
							verifySubagentResult(settled, request),
							normalized.acceptanceCriteria.length,
						);
					},
					() => terminalCheckIn(normalized.parentSessionId, normalized.runId),
				);
				// Return control at admission: the same child session keeps running
				// under the supervisor, and the run promise is kept alive so its
				// terminal result is published exactly once to the retained ledger.
				//
				// The retained child stays bound to the parent run signal handed to
				// runResolved, exactly like delegate_async's parent-run tie: a normal run
				// completion never aborts that signal, so returning here does not cancel
				// the child. It terminates only on an explicit abort/compact/dispose of the
				// launching run, on manage_subagent stop, or on session shutdown through
				// runner.shutdown().
				const outcome = await Promise.race([
					runPromise.then((value) => ({ kind: "settled" as const, value })),
					managedHandlePromise.then((handle) => ({ kind: "managed" as const, handle })),
				]);
				if (outcome.kind === "managed") {
					void runPromise.catch(() => {});
					const observation = runner.peekRuntime(outcome.handle.runId, normalized.parentSessionId);
					// A startup fallback may have admitted a different model than the first candidate.
					const admittedRequest =
						managedRequests.get(managedRequestKey(normalized.parentSessionId, outcome.handle.runId)) ??
						normalized;
					const launchText = `Launched retained subagent ${outcome.handle.runId} in managed mode; it keeps the same run ID, child session, model, profile, scope, and tool authority.${observation ? `\n${formatManagedObservation(observation)}` : ""}`;
					return {
						content: [
							{
								type: "text",
								text: breadthAdvisory ? `Advisory: ${breadthAdvisory}\n\n${launchText}` : launchText,
							},
						],
						details: {
							managed: outcome.handle,
							...(observation ? { observation } : {}),
							launch: createSubagentLaunchProvenance(admittedRequest, admittedRequest.retryModel ?? model),
							...(breadthAdvisory ? { advisory: breadthAdvisory } : {}),
						},
						isError: false,
					};
				}
				// Settled before the managed handle existed (startup failure or instant completion).
				const result = outcome.value;
				const verification = verifySubagentResult(result, normalized);
				recordTelemetry(
					result.runId,
					normalized.role,
					"foreground",
					result,
					verification,
					normalized.acceptanceCriteria.length,
				);
				const finalResult =
					!verification.verified && result.status === "completed"
						? {
								...result,
								status: "verification_failed" as const,
								diagnostics: [
									...result.diagnostics,
									{ code: "verification_failure" as const, message: verification.reason },
								],
							}
						: result;
				const safeResult = redactSubagentResult(finalResult);
				const safeVerification = redactSubagentVerification(verification);
				const progress = publishWorkflowProgress(
					observatory,
					toolCallId,
					"delegate",
					{
						phase:
							finalResult.status === "verification_failed"
								? "verification_failed"
								: finalResult.status === "needs_time"
									? "running"
									: finalResult.status,
						status: finalResult.status,
						runId: finalResult.runId,
						model: modelLabel(model),
						cwd: ctx.cwd,
						evidenceCount: finalResult.evidence?.paths.length,
						usage: finalResult.usage,
						diagnostics: finalResult.diagnostics.map((diagnostic) => diagnostic.code),
					},
					onUpdate,
				);
				return {
					content: [
						{
							type: "text",
							text: breadthAdvisory
								? `Advisory: ${breadthAdvisory}\n\n${formatToolResult(safeResult, safeVerification)}`
								: formatToolResult(safeResult, safeVerification),
						},
					],
					details: {
						result: safeResult,
						verification: safeVerification,
						launch: {
							...createSubagentLaunchProvenance(normalized, model),
							model: result.model ?? modelReference(model),
							modelCandidateSkips: result.modelCandidateSkips ?? normalized.modelCandidateSkips,
						},
						...(preflightGate.evaluation.checks.length > 0 ? { preflight: preflightGate.evaluation.checks } : {}),
						...(breadthAdvisory ? { advisory: breadthAdvisory } : {}),
						...(unsafeHostExec ? { unsafeHostExec: true } : {}),
						...(progress ? { progress } : {}),
					},
					isError: finalResult.status !== "completed" || !verification.verified,
				};
			} catch (error) {
				const message = redactCredentialText(error instanceof Error ? error.message : String(error));
				publishWorkflowProgress(
					observatory,
					toolCallId,
					"delegate",
					{ phase: "failed", status: "failed", cwd: ctx.cwd, diagnostics: ["delegation_rejected"] },
					onUpdate,
				);
				return {
					content: [{ type: "text", text: `Delegation rejected: ${message}` }],
					details: formatSubagentToolError(error),
					isError: true,
				};
			}
		},
	};
	const delegateAsync: DelegateAsyncTool = {
		name: "delegate_async",
		label: "delegate_async",
		description: `${SUBAGENT_SCOPE_TOOL_GUIDANCE} ${SUBAGENT_INTERNAL_REPORT_GUIDANCE} Delegation is for parallel fan-out, not single errands: never delegate a simple single task you can complete directly with your own parent tools; launch a child only when the plan calls for at least two children (delegate_batch or concurrent background delegate launches). Accept one durable asynchronous ICE child for the current session using the current parent model captured at acceptance time. While it runs, ICE delivers periodic check-ins to the owning session using its configured interval; these are progress notices, not child deadlines, and cancellation remains explicit. The returned details.accepted.jobId is the bare identifier for inspect_subagent_job or cancel_subagent_job; details.accepted.resultRef (job:<id>) is display/reference metadata, not a jobId. Do not use a batchId, taskId, or foreground runId with the durable-job tools. The parent-owned scheduler admits bounded active work or FIFO queued work, owns cancellation, persists state, and returns acceptance metadata without awaiting the child. Safe mode clamps the selected profile to requested read-only capabilities. Explicit --sub-yolo permits only profile-requested built-in capabilities that are also active in the trusted parent; it does not grant every parent tool. Trusted ambient resources may load, but model-visible authority remains the explicit child allowlist and recursive delegation is not authorized.`,
		promptSnippet: "Launch one durable asynchronous subagent",
		promptGuidelines: [...SUBAGENT_DELEGATION_POLICY_GUIDELINES],
		parameters: delegateAsyncParameters,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			try {
				if (signal?.aborted)
					throw new SubagentJobError("job_invalid", "Background job launch was cancelled before acceptance.");
				const parentRun = parentRunState;
				if (parentRun?.signal?.aborted)
					throw new SubagentJobError("job_invalid", "Background job launch was cancelled before acceptance.");
				const registry = jobs;
				if (!registry || shuttingDown)
					throw new SubagentJobError("job_invalid", "Background jobs are unavailable during session teardown.");
				const request: SubagentRequest = {
					parentSessionId: ctx.sessionManager.getSessionId(),
					role: params.role,
					task: params.task,
					scope: params.scope,
					cwd: ctx.cwd,
					context: params.context,
					contextPacket: params.contextPacket,
					contextMode: params.contextMode,
					timeoutMs: params.startupTimeoutMs,
					execution: params.execution,
					resources: params.resources,
					acceptanceCriteria: params.acceptanceCriteria,
					preflight: params.preflight,
					outputSchema: params.outputSchema,
					...(params.self !== undefined
						? {
								self: {
									...params.self,
									...(params.self.capabilities !== undefined
										? { capabilities: [...params.self.capabilities] }
										: {}),
								},
							}
						: {}),
				};
				const projectTrusted = ctx.isProjectTrusted();
				const settingsManager = getParentSettingsManager(ctx);
				const unsafeAuthorization = authorizeUnsafeSubagentHostExecution(ctx, options, subYoloEnabled());
				let normalized = normalizeSubagentRequest(request, ctx.cwd, {
					...parentSnapshotOptions(ctx, request, unsafeAuthorization),
					projectTrusted,
					parentContext: request.contextMode === "fork" ? ctx.sessionManager : undefined,
					allowExternal: unsafeAuthorization?.allowExternal === true,
					settingsManager,
					agentDir,
				});
				const model = resolveRequestedSubagentModel(ctx, settingsManager, normalized);
				validateSubagentMcpAdmission(normalized, mcpAdapter, unsafeAuthorization !== undefined);
				const hookRuntime = createSubagentHookRuntime(
					ctx,
					settingsManager,
					normalized,
					options,
					undefined,
					appendHookJournal,
				);
				const hookContextAdditions = await dispatchSubagentHookDecision(
					hookRuntime,
					"subagent.beforeLaunch",
					{
						role: normalized.role,
						task: normalized.task,
						scopeRoots: normalized.scope.roots,
						tools: normalized.execution.tools ?? normalized.profile.requestedTools,
						budgets: normalized.execution,
					},
					signal,
				);
				normalized = applySubagentHookContextAdditions(normalized, hookContextAdditions);
				if (signal?.aborted)
					throw new SubagentJobError("job_invalid", "Background job launch was cancelled before acceptance.");
				if (!isCurrentSubagentAuthorityValid(ctx, settingsManager, normalized, hookRuntime)) {
					throw new SubagentError(
						"capability_denied",
						"Current settings, trust, profile, resources, or hooks changed during beforeLaunch.",
					);
				}
				// A required failed preflight blocks launch before consuming a child run.
				const asyncPreflightGate = gateSubagentPreflight(normalized);
				// Journal every asynchronous parent-owned hook dispatch for crash ambiguity recovery.
				if (asyncPreflightGate.blocked) {
					throw new SubagentError(
						"preflight_failed",
						formatSubagentPreflightFailure(asyncPreflightGate.evaluation),
					);
				}
				const unsafeHostExec = unsafeAuthorization !== undefined;
				const modelRuntime = ctx.modelRegistry.getRuntime();
				// Durable acceptance pins the route; even a retry-safe startup cannot reroute this job.
				normalized = { ...normalized, resolveStartupFallback: undefined };
				const launchLeafId = ctx.sessionManager.getLeafId();
				const acceptedRoute = snapshotIceSubagentRoute(model);
				const acceptedTools = effectiveSubagentToolNames(
					normalized,
					parentToolSnapshot(unsafeAuthorization),
					unsafeHostExec,
				);
				const launch = createSubagentLaunchProvenance(normalized, model);
				const accepted = registry.launch({
					launchLeafId,
					role: normalized.role,
					model: modelLabel(model),
					contract: {
						route: acceptedRoute,
						capabilities: [
							...(normalized.delegatedTools ?? []).map(({ adapterId, name, origin, fingerprint }) => ({
								adapterId,
								name,
								origin,
								fingerprint,
							})),
							...(normalized.mcpAuthorizations ?? []).map((entry) => ({
								name: subagentMcpToolName(entry.selector),
								origin: entry.selector,
								fingerprint: hashSource(JSON.stringify(entry)),
							})),
						],
						resourcesHash: hashSource(JSON.stringify(normalized.resources)),
						thinking: normalized.execution.thinking,
						checkInIntervalMs: normalized.checkInIntervalMs,
						...(normalized.execution.temperature !== undefined
							? { temperature: normalized.execution.temperature }
							: {}),
						...(normalized.execution.topP !== undefined ? { topP: normalized.execution.topP } : {}),
						tools: acceptedTools,
						sourceHash: normalized.profile.sourceHash,
						...(normalized.modelCandidates ? { modelCandidates: [...normalized.modelCandidates] } : {}),
						...(normalized.modelCandidateSkips
							? { modelCandidateSkips: [...normalized.modelCandidateSkips] }
							: {}),
						...(normalized.selectedMcpTools ? { mcpTools: [...normalized.selectedMcpTools] } : {}),
					},
					run: async (jobSignal) => {
						const authorityFailure = (): SubagentJobRunResult => {
							const result: SubagentResult = {
								runId: normalized.runId,
								parentSessionId: normalized.parentSessionId,
								profile: normalized.profile.name,
								source: normalized.profile.source,
								status: "failed",
								summary:
									"Accepted background delegation was blocked because current trust or authority was revoked before promotion.",
								observedOutputBytes: 0,
								partial: false,
								diagnostics: [
									{
										code: "capability_denied",
										message:
											"Current settings or project trust no longer authorize the accepted child contract.",
									},
								],
							};
							return { result, verification: verifySubagentResult(result, normalized) };
						};
						let promotionActiveTools: readonly string[];
						try {
							if (!isCurrentSubagentAuthorityValid(ctx, settingsManager, normalized, hookRuntime))
								return authorityFailure();
							if (normalized.routeSnapshot) resolveRequestedSubagentModel(ctx, settingsManager, normalized);
							else
								resolveIceSubagentRoute({
									parent: model,
									runtime: modelRuntime,
									enabled: true,
									captured: acceptedRoute,
								});
							const currentProjectTrusted = settingsManager.isProjectTrusted() && ctx.isProjectTrusted();
							if (normalized.projectTrusted && !currentProjectTrusted) return authorityFailure();
							revalidateSubagentProfile(normalized.profile);
							revalidateSubagentResources(normalized.resources);
							const currentContract = resolveIceSubagentContract({
								globalSettings: settingsManager.getGlobalSettings(),
								projectSettings: settingsManager.getProjectSettings(),
								globalFirst: true,
								projectTrusted: currentProjectTrusted,
								role: normalized.role,
								call: {
									role: normalized.role,
									thinking: normalized.execution.thinking,
									startupTimeoutMs: normalized.timeoutMs,
								},
							});
							const acceptedTools = (normalized.execution.tools ?? normalized.profile.requestedTools).filter(
								(tool) => !normalized.deniedTools.includes(tool.toLowerCase()),
							);
							const currentHookRuntime = resolveIceSubagentHooks({
								globalHooks: settingsManager.getGlobalSettings(),
								projectHooks: settingsManager.getProjectSettings(),
								projectTrusted: currentProjectTrusted,
								role: normalized.role,
								roleHookIds: normalized.profile.hooks,
								callHookIds: normalized.hookIds,
							});
							const acceptedHookIds = (hookRuntime?.hooks ?? []).map(
								(hook) =>
									`${hook.id}:${hook.event}:${hook.kind}:${hook.required}:${hook.timeoutMs}:${hook.maxOutputBytes}`,
							);
							const currentHookIds = currentHookRuntime.map(
								(hook) =>
									`${hook.id}:${hook.event}:${hook.kind}:${hook.required}:${hook.timeoutMs}:${hook.maxOutputBytes}`,
							);
							if (
								currentContract.denied ||
								!currentContract.enabled ||
								currentContract.values.timeoutMs < normalized.timeoutMs ||
								acceptedTools.some((tool) => currentContract.deniedTools.includes(tool)) ||
								acceptedHookIds.join("|") !== currentHookIds.join("|")
							) {
								return authorityFailure();
							}
							if (unsafeHostExec) {
								const currentUnsafeAuthorization = authorizeUnsafeSubagentHostExecution(
									ctx,
									options,
									subYoloEnabled(),
								);
								if (!currentUnsafeAuthorization) return authorityFailure();
								promotionActiveTools = [...parentToolSnapshot(currentUnsafeAuthorization)];
							} else {
								promotionActiveTools = [...ice.getActiveTools()];
							}
						} catch (error) {
							const failure = authorityFailure();
							failure.result.summary = redactCredentialText(
								error instanceof Error ? error.message : String(error),
							);
							return failure;
						}
						const runAttempt = (
							attempt: 1 | 2,
							childRequest: NormalizedSubagentRequest,
							activeTools: readonly string[],
						) =>
							runner.runResolved(childRequest, activeTools, {
								model,
								modelRuntime,
								settingsManager,
								projectTrusted: childRequest.projectTrusted,
								unsafeHostExec,
								attempt,
								noLifetimeTimeout: true,
								signal: jobSignal,
								isAuthorityStillValid: () =>
									isCurrentSubagentAuthorityValid(ctx, settingsManager, childRequest, hookRuntime),
								hookRuntime,
								onManagedHandle: (handle) => {
									const coordinator = getCheckIns(normalized.parentSessionId);
									if (coordinator.getState(accepted.jobId)) return;
									coordinator.arm(accepted.jobId, childRequest.checkInIntervalMs, () => {
										const attention = runner.getRuntimeAttention(handle.runId, normalized.parentSessionId);
										const lastActivity = attention?.lastActivities.at(-1);
										return {
											jobId: accepted.jobId,
											role: childRequest.role,
											model: modelLabel(model) ?? "unknown",
											executionStatus: "running",
											phase: attention?.phase,
											currentTool: lastActivity?.toolName,
											currentPath: lastActivity?.path,
											terminal: attention?.state === "terminal",
											lastProgressAt: attention?.lastProgressAtMs,
											progressAgeMs: attention?.progressAgeMs,
											recentActivities: attention?.lastActivities.slice(-3).map(formatSubagentToolActivity),
											freshness: subagentCheckInFreshness(
												attention?.progressAgeMs,
												childRequest.checkInIntervalMs,
											),
											isolation: unsafeHostExec ? ("host" as const) : ("read-only" as const),
										};
									});
								},
								onRuntimeAttention: (attention) => {
									noteAttention(childRequest.runId, attention);
								},
								onManagedResult: async (managedResult) => {
									const verification = verifySubagentResult(managedResult, childRequest);
									recordTelemetry(
										managedResult.runId,
										childRequest.role,
										"async",
										managedResult,
										verification,
										childRequest.acceptanceCriteria.length,
									);
									await registry.resolveManagedRun(childRequest.runId, {
										result: managedResult,
										verification,
									});
								},
							});
						const result = unsafeHostExec
							? await runAttempt(1, normalized, promotionActiveTools)
							: await runSubagentWithRecovery(normalized, promotionActiveTools, runAttempt, {
									getStopReason: () => (jobSignal.aborted ? "cancelled" : undefined),
								});
						terminalCheckIn(normalized.parentSessionId, accepted.jobId);
						const jobVerification = verifySubagentResult(result, normalized);
						recordTelemetry(
							result.runId,
							normalized.role,
							"async",
							result,
							jobVerification,
							normalized.acceptanceCriteria.length,
						);
						return {
							result,
							verification: jobVerification,
						};
					},
				});
				if (parentRun && parentRunState === parentRun && parentRun.registry === registry) {
					parentRun.acceptedJobIds.add(accepted.jobId);
					if (parentRun.signal?.aborted) void cancelParentRun(parentRun);
				}
				return {
					content: [
						{
							type: "text",
							text: `Background subagent job ${accepted.jobId} accepted. Use this bare jobId with inspect_subagent_job or cancel_subagent_job. Result ref for display only: ${accepted.resultRef}.`,
						},
					],
					details: { accepted, launch },
					isError: false,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Background delegation rejected: ${message}` }],
					details: formatSubagentToolError(error),
					isError: true,
				};
			}
		},
	};
	const readSubagentOutput: ReadSubagentOutputTool = {
		name: "read_subagent_output",
		label: "read_subagent_output",
		description:
			"Read one bounded UTF-8 chunk from an owner-scoped subagent final-answer artifact. Supply only its opaque artifactId and optional byte offset/length; filesystem paths and run/job IDs are not accepted.",
		promptSnippet: "Read a retained subagent final-answer chunk",
		parameters: readSubagentOutputParameters,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				const output = outputArtifacts.read({
					ownerSessionId: ctx.sessionManager.getSessionId(),
					...params,
				});
				return {
					content: [
						{
							type: "text",
							text: `Artifact ${output.artifactId} · bytes ${output.offset}-${output.nextOffset}/${output.totalBytes} · nextOffset=${output.nextOffset} · eof=${output.eof} · ${output.contentType} · sha256=${output.sha256} · truncated=${output.truncated}\n\n${output.text}`,
						},
					],
					details: { output },
					isError: false,
				};
			} catch (error) {
				const artifactError =
					error instanceof SubagentOutputArtifactError
						? error
						: new SubagentOutputArtifactError(
								"artifact_storage_failure",
								"Subagent output artifact read is unavailable.",
							);
				const details = { error: { code: artifactError.code, message: artifactError.message } };
				return {
					content: [
						{ type: "text", text: `Output read failed (${artifactError.code}): ${artifactError.message}` },
					],
					details,
					isError: true,
				};
			}
		},
	};
	const inspectSubagentJob: SubagentJobTool = {
		name: "inspect_subagent_job",
		label: "inspect_subagent_job",
		description:
			"Inspect one owner-scoped durable subagent job and its bounded result projection. Pass only the bare jobId returned as details.accepted.jobId by delegate_async; do not pass resultRef values such as job:<id>, a foreground runId, batchId, or taskId.",
		promptSnippet: "Inspect a durable subagent job",
		parameters: subagentJobParameters,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				if (!jobs || shuttingDown)
					throw new SubagentJobError("job_invalid", "Background jobs are unavailable during session teardown.");
				const inspection = jobs.inspect(params.jobId, ctx.sessionManager.getSessionId());
				const attention =
					inspection.job.status === "running" && inspection.job.runId
						? runner.getRuntimeAttention(inspection.job.runId, ctx.sessionManager.getSessionId())
						: undefined;
				const checkIn = checkIns.get(ctx.sessionManager.getSessionId())?.getState(params.jobId);
				return {
					content: [
						{
							type: "text",
							text: [
								formatSubagentJobInspection(inspection),
								attention ? formatRuntimeAttention(attention) : undefined,
								formatSubagentCheckInState(checkIn),
								attention
									? `Use manage_subagent with runId ${inspection.job.runId} to inspect, follow up, wait, or stop the same retained child.`
									: undefined,
							]
								.filter((part): part is string => part !== undefined)
								.join("\n\n"),
						},
					],
					details: { inspection, ...(attention ? { attention } : {}), ...(checkIn ? { checkIn } : {}) },
					isError: false,
				};
			} catch (error) {
				const message = formatDurableJobIdentifierError(error, params.jobId);
				return {
					content: [{ type: "text", text: `Subagent job inspection rejected: ${message}` }],
					details: undefined,
					isError: true,
				};
			}
		},
	};
	const cancelSubagentJob: SubagentJobTool = {
		name: "cancel_subagent_job",
		label: "cancel_subagent_job",
		description:
			"Cancel one owner-scoped durable subagent job and wait for its worker to settle. Pass only the bare jobId returned as details.accepted.jobId by delegate_async; do not pass resultRef values such as job:<id>, a foreground runId, batchId, or taskId.",
		promptSnippet: "Cancel a durable subagent job",
		parameters: subagentJobParameters,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				if (!jobs || shuttingDown)
					throw new SubagentJobError("job_invalid", "Background jobs are unavailable during session teardown.");
				const inspection = await jobs.cancel(params.jobId, ctx.sessionManager.getSessionId());
				return {
					content: [{ type: "text", text: formatSubagentJobInspection(inspection) }],
					details: { inspection },
					isError: false,
				};
			} catch (error) {
				const message = formatDurableJobIdentifierError(error, params.jobId);
				return {
					content: [{ type: "text", text: `Subagent job cancellation rejected: ${message}` }],
					details: undefined,
					isError: true,
				};
			}
		},
	};
	const inspectSubagentBatch: InspectSubagentBatchTool = {
		name: "inspect_subagent_batch",
		label: "inspect_subagent_batch",
		description:
			"Inspect one owner-scoped managed delegate_batch or review_batch. Pass the bare batchId returned by the batch tool, never resultRef or a child runId. Completed batches include their deterministic bounded aggregate result; each child runId can be managed separately with manage_subagent.",
		promptSnippet: "Inspect a managed sibling batch",
		parameters: subagentBatchIdParameters,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				const record = ownedManagedBatch(params.batchId, ctx.sessionManager.getSessionId());
				const inspection = snapshotManagedBatch(record);
				const text =
					record.result && "reviewers" in record.result
						? formatReviewBatchToolResult(record.result)
						: record.result
							? formatBatchToolResult(record.result)
							: [
									`Managed ${record.kind} batch ${record.batchId} is ${record.state}.`,
									...inspection.tasks.map(
										(task) => `- ${task.taskId}: ${task.status} · ${task.role} · ${task.runId}`,
									),
									"Use inspect_subagent_batch again for the aggregate result; manage each running child by its runId.",
								].join("\n");
				return { content: [{ type: "text", text }], details: { inspection }, isError: false };
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Managed batch inspection rejected: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: formatSubagentToolError(error),
					isError: true,
				};
			}
		},
	};
	const cancelSubagentBatch: CancelSubagentBatchTool = {
		name: "cancel_subagent_batch",
		label: "cancel_subagent_batch",
		description:
			"Cancel one owner-scoped managed sibling batch and wait for its running children to settle. Pass the bare batchId returned by delegate_batch or review_batch. This only cancels; it never integrates writer changes or widens child authority.",
		promptSnippet: "Cancel a managed sibling batch",
		parameters: subagentBatchIdParameters,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				const record = ownedManagedBatch(params.batchId, ctx.sessionManager.getSessionId());
				if (record.completion && !record.result) {
					record.controller.abort();
					await record.completion.catch(() => undefined);
				}
				const inspection = snapshotManagedBatch(record);
				return {
					content: [{ type: "text", text: `Managed batch ${record.batchId} is ${record.state}.` }],
					details: { inspection },
					isError: false,
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Managed batch cancellation rejected: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: formatSubagentToolError(error),
					isError: true,
				};
			}
		},
	};
	const delegateBatch: DelegateBatchTool = {
		name: "delegate_batch",
		label: "delegate_batch",
		description: `${SUBAGENT_SCOPE_TOOL_GUIDANCE} ${SUBAGENT_INTERNAL_REPORT_GUIDANCE} Never wrap a single task in a batch: delegate_batch is for two or more independent sibling tasks, so a lone task is done directly in the parent. Run up to eight independently scoped sibling ICE children through the same atomic executor using the current parent model. Each child uses a fresh session; its final answer is retained with fixed host-owned inline limits plus an optional output artifact. The tool always returns an owner-scoped batchId and child runIds after preflight so the parent remains available; inspect with inspect_subagent_batch, cancel the aggregate with cancel_subagent_batch, manage an individual child by its runId, or read a child output artifact with read_subagent_output. batchId/resultRef are not durable jobIds. Safe mode clamps each selected profile to requested read-only capabilities. Explicit --sub-yolo permits only each profile's requested built-in capabilities that are also active in the trusted parent; it does not grant every parent tool. Trusted ambient resources may load in YOLO, but model-visible authority remains each explicit child allowlist and recursive delegation is not authorized. The parent synthesizes the independent evidence.`,
		promptSnippet: "Delegate bounded parallel profile-aware subagents",
		promptGuidelines: [
			...SUBAGENT_DELEGATION_POLICY_GUIDELINES,
			"Do not wrap a single task in a batch: delegate_batch requires two or more independent sibling tasks, so a lone task is done directly in the parent.",
		],
		parameters: delegateBatchParameters,
		renderCall: (args, theme, context) => renderObservatoryCall("delegate_batch", args, theme, context),
		renderResult: (result, options, theme, context) => renderObservatoryResult(result, options, theme, context),
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			publishWorkflowProgress(
				observatory,
				toolCallId,
				"delegate_batch",
				{ phase: "created", status: "running", cwd: ctx.cwd, role: "batch" },
				onUpdate,
			);
			try {
				const projectTrusted = ctx.isProjectTrusted();
				const settingsManager = getParentSettingsManager(ctx);
				const unsafeAuthorization = authorizeUnsafeSubagentHostExecution(ctx, options, subYoloEnabled());
				// Phase 6.1: reject exact duplicate sibling contracts while leaving
				// legitimate overlapping (independent-review) scopes untouched.
				const duplicatePair = findExactDuplicateBatchTasks(params.tasks)[0];
				if (duplicatePair) {
					throw new SubagentError(
						"invalid_request",
						`Batch tasks ${duplicatePair.firstId} and ${duplicatePair.duplicateId} are exact duplicates; differentiate their scopes, kinds, or briefs, or drop one sibling.`,
					);
				}
				const parentContext = params.tasks.some((task) => task.contextMode === "fork")
					? memoizeSubagentForkContextSource(ctx.sessionManager)
					: undefined;
				const tasks: ResolvedSubagentBatchTask[] = params.tasks.map((task) => {
					try {
						const request: SubagentRequest = {
							parentSessionId: ctx.sessionManager.getSessionId(),
							role: task.role,
							task: task.task,
							scope: task.scope,
							cwd: ctx.cwd,
							context: task.context,
							contextPacket: task.contextPacket,
							contextMode: task.contextMode,
							kind: task.kind,
							deliverable: task.deliverable,
							constraints: task.constraints,
							nonGoals: task.nonGoals,
							verification: task.verification,
							checkInIntervalMs: task.checkInIntervalMs,
							execution: task.execution,
							resources: task.resources,
							acceptanceCriteria: task.acceptanceCriteria,
							preflight: task.preflight,
							outputSchema: task.outputSchema,
							...(task.self !== undefined
								? {
										self: {
											...task.self,
											...(task.self.capabilities !== undefined
												? { capabilities: [...task.self.capabilities] }
												: {}),
										},
									}
								: {}),
						};
						const normalized = normalizeSubagentRequest(request, ctx.cwd, {
							...parentSnapshotOptions(ctx, request, unsafeAuthorization),
							projectTrusted,
							parentContext,
							allowExternal: unsafeAuthorization?.allowExternal === true,
							settingsManager,
							agentDir,
						});
						const hookRuntime = createSubagentHookRuntime(
							ctx,
							settingsManager,
							normalized,
							options,
							undefined,
							appendHookJournal,
						);
						const childModel = resolveRequestedSubagentModel(ctx, settingsManager, normalized);
						validateSubagentMcpAdmission(normalized, mcpAdapter, unsafeAuthorization !== undefined);
						return { id: task.id, request: normalized, model: childModel, hookRuntime };
					} catch (error) {
						throw withBatchTaskContext(error, task.id);
					}
				});
				for (const task of tasks) {
					const hookContextAdditions = await dispatchSubagentHookDecision(
						task.hookRuntime,
						"subagent.beforeLaunch",
						{
							role: task.request.role,
							task: task.request.task,
							scopeRoots: task.request.scope.roots,
							tools: task.request.execution.tools ?? task.request.profile.requestedTools,
							budgets: task.request.execution,
						},
						signal,
					);
					task.request = applySubagentHookContextAdditions(task.request, hookContextAdditions);
					if (!isCurrentSubagentAuthorityValid(ctx, settingsManager, task.request, task.hookRuntime)) {
						throw withBatchTaskContext(
							new SubagentError(
								"capability_denied",
								"Current settings, trust, profile, resources, or hooks changed during beforeLaunch.",
							),
							task.id,
						);
					}
				}
				const blockedPreflight = tasks.find((task) => gateSubagentPreflight(task.request).blocked);
				if (blockedPreflight) {
					const evaluation = gateSubagentPreflight(blockedPreflight.request);
					throw new SubagentError(
						"preflight_failed",
						`Task ${blockedPreflight.id}: ${formatSubagentPreflightFailure(evaluation.evaluation)}`,
					);
				}
				const unsafeHostExec = unsafeAuthorization !== undefined;
				const effectiveParentActiveTools = unsafeAuthorization
					? [...unsafeAuthorization.parentActiveTools]
					: [...ice.getActiveTools()];
				if (signal?.aborted) throw new SubagentError("cancellation", "Batch was cancelled before admission.");
				const batchId = randomUUID();
				const concurrencyPolicy = resolveSubagentConcurrencyPolicyFromSettings(settingsManager);
				const backgroundOptions = {
					batchId,
					concurrency: params.concurrency,
					concurrencyPolicy,
					admission: subagentAdmission,
					failFast: params.failFast,
					modelRuntime: ctx.modelRegistry.getRuntime(),
					settingsManager,
					unsafeHostExec,
					isAuthorityStillValid: (request: NormalizedSubagentRequest, hookRuntime?: SubagentHookRuntime) =>
						isCurrentSubagentAuthorityValid(ctx, settingsManager, request, hookRuntime),
				};
				buildSubagentLaunchPreflight(tasks, effectiveParentActiveTools, backgroundOptions);
				const batchController = new AbortController();
				const abortBatch = (): void => batchController.abort();
				if (signal) signal.addEventListener("abort", abortBatch, { once: true });
				const record = createManagedBatch(
					batchId,
					ctx.sessionManager.getSessionId(),
					"batch",
					batchController,
					tasks,
				);
				const completion = runResolvedSubagentBatch(tasks, effectiveParentActiveTools, runner, {
					...backgroundOptions,
					managedBackground: true,
					signal: batchController.signal,
					onManagedHandle: (task, handle) => armManagedBatchChild(record, task, handle, unsafeHostExec),
					onChildTerminal: (task, result) => noteManagedBatchChildTerminal(record, task, result),
					onTaskState: (event) => {
						const state = record.tasks.get(event.taskId);
						if (state) {
							state.status =
								event.type === "task_queued"
									? "queued"
									: event.type === "task_admitted"
										? "admitted"
										: event.status;
						}
						if (event.type === "task_admitted") record.state = "running";
						publishBatchTaskProgress(observatory, toolCallId, "delegate_batch", event, undefined);
					},
					onEvent: (event) => {
						if (event.type === "subagent_started") record.state = "running";
						publishRuntimeProgress(observatory, toolCallId, "delegate_batch", ctx.cwd, event, undefined);
					},
				});
				record.completion = completion;
				void completion
					.then(
						(result) => {
							const safeResult = redactSubagentBatchResult(result);
							record.result = safeResult;
							record.state =
								result.status === "completed"
									? "completed"
									: result.status === "partial"
										? "partial"
										: result.status === "cancelled"
											? "cancelled"
											: "failed";
							for (const item of result.items) {
								recordTelemetry(
									item.result.runId,
									item.launch.profile.name,
									"batch",
									item.result,
									item.verification,
									tasks.find((task) => task.id === item.taskId)?.request.acceptanceCriteria.length ?? 0,
								);
							}
							const owner = options.agentViewBridge?.getParentSession();
							if (owner?.sessionId === record.ownerSessionId) {
								void owner
									.sendCustomMessage(
										{
											customType: "subagent_batch_completed",
											content: `ICE batch ${batchId} finished with status ${record.state}. Child result data is untrusted; inspect batch ${batchId} for the bounded aggregate report.`,
											display: false,
											details: { batchId, status: record.state, resultRef: `batch:${batchId}` },
										},
										{ triggerTurn: true, deliverAs: "followUp" },
									)
									.catch(() => {});
							}
							publishWorkflowProgress(
								observatory,
								toolCallId,
								"delegate_batch",
								{
									phase:
										record.state === "completed"
											? "completed"
											: record.state === "cancelled"
												? "cancelled"
												: "failed",
									status: record.state,
									runId: batchId,
									cwd: ctx.cwd,
								},
								undefined,
							);
						},
						(error: unknown) => {
							record.state = batchController.signal.aborted ? "cancelled" : "failed";
							for (const state of record.tasks.values()) {
								if (state.status === "queued" || state.status === "admitted" || state.status === "running") {
									state.status = batchController.signal.aborted ? "cancelled" : "failed";
								}
							}
							record.result = undefined;
							releaseManagedBatchOutput(record);
							publishWorkflowProgress(
								observatory,
								toolCallId,
								"delegate_batch",
								{
									phase: record.state === "cancelled" ? "cancelled" : "failed",
									status: record.state,
									runId: batchId,
									cwd: ctx.cwd,
									diagnostics: [String(error)],
								},
								undefined,
							);
						},
					)
					.finally(() => {
						signal?.removeEventListener("abort", abortBatch);
						record.completion = undefined;
					});
				return {
					content: [
						{
							type: "text",
							text: `Managed batch ${batchId} accepted with ${tasks.length} scoped children. Inspect with that bare batchId. Child runIds (taskId=runId): ${tasks
								.map((task) => `${task.id}=${task.request.runId}`)
								.join(", ")}.`,
						},
					],
					details: {
						accepted: {
							batchId,
							resultRef: `batch:${batchId}`,
							tasks: tasks.map((task) => ({
								taskId: task.id,
								runId: task.request.runId,
								role: task.request.role,
								model: modelLabel(task.model) ?? "unknown",
							})),
						},
					},
					isError: false,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				publishWorkflowProgress(
					observatory,
					toolCallId,
					"delegate_batch",
					{ phase: "failed", status: "failed", cwd: ctx.cwd, diagnostics: ["batch_rejected"] },
					onUpdate,
				);
				return {
					content: [{ type: "text", text: message }],
					details: formatSubagentToolError(error),
					isError: true,
				};
			}
		},
	};
	const reviewBatch: ReviewBatchTool = {
		name: "review_batch",
		label: "review_batch",
		description: `${SUBAGENT_SCOPE_TOOL_GUIDANCE} ${SUBAGENT_INTERNAL_REPORT_GUIDANCE} Never run a single-reviewer batch: review_batch is for two or more independent review dimensions or targets, so one review is done directly in the parent. Run up to eight independently scoped reviewers for correctness, security, tests, or regression risk through the existing bounded delegate scheduler. Reviewers always use the current parent model and preserve independent verification. Always returns an owner-scoped batchId and child runIds after preflight; inspect the deterministic aggregate with inspect_subagent_batch, cancel with cancel_subagent_batch, or manage each child by its runId. batchId/resultRef are not durable jobIds. Safe mode clamps the resolved review profile to requested read-only capabilities. Explicit --sub-yolo permits only profile-requested built-in capabilities that are also active in the trusted parent; it does not grant every parent tool. Trusted ambient resources may load in YOLO, but model-visible authority remains the explicit reviewer allowlist and recursive delegation is not authorized.`,
		promptSnippet: "Run bounded parallel typed reviewers",
		promptGuidelines: [
			...SUBAGENT_DELEGATION_POLICY_GUIDELINES,
			"Do not run a single-reviewer batch: review_batch is for two or more independent review dimensions or targets, so one review is done directly in the parent.",
		],
		parameters: reviewBatchParameters,
		renderCall: (args, theme, context) => renderObservatoryCall("review_batch", args, theme, context),
		renderResult: (result, options, theme, context) => renderObservatoryResult(result, options, theme, context),
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			publishWorkflowProgress(
				observatory,
				toolCallId,
				"review_batch",
				{ phase: "created", status: "running", cwd: ctx.cwd, role: "review" },
				onUpdate,
			);
			try {
				const projectTrusted = ctx.isProjectTrusted();
				const settingsManager = getParentSettingsManager(ctx);
				const unsafeAuthorization = authorizeUnsafeSubagentHostExecution(ctx, options, subYoloEnabled());
				const parentContext = params.tasks.some((task) => task.contextMode === "fork")
					? memoizeSubagentForkContextSource(ctx.sessionManager)
					: undefined;
				const tasks: ResolvedReviewTask[] = params.tasks.map((task) => {
					try {
						const resolved = resolveReviewTask(task, ctx.sessionManager.getSessionId(), ctx.cwd, {
							parentSystemPrompt: typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined,
							parentActiveTools: ["read", "grep", "find", "ls"],
							projectTrusted,
							parentContext,
							allowExternal: unsafeAuthorization?.allowExternal === true,
							settingsManager,
							agentDir,
						});
						const childModel = resolveRequestedSubagentModel(ctx, settingsManager, resolved.request);
						return {
							...resolved,
							model: childModel,
							modelProvenance: {
								source: resolved.request.requestedModel ? "call" : "parent",
								resolved: modelReference(childModel),
							},
							hookRuntime: createSubagentHookRuntime(
								ctx,
								settingsManager,
								resolved.request,
								options,
								undefined,
								appendHookJournal,
							),
						};
					} catch (error) {
						throw withBatchTaskContext(error, task.id);
					}
				});
				for (const task of tasks) {
					const hookContextAdditions = await dispatchSubagentHookDecision(
						task.hookRuntime,
						"subagent.beforeLaunch",
						{
							role: task.request.role,
							task: task.request.task,
							scopeRoots: task.request.scope.roots,
							tools: task.request.execution.tools ?? task.request.profile.requestedTools,
							budgets: task.request.execution,
						},
						signal,
					);
					task.request = applySubagentHookContextAdditions(task.request, hookContextAdditions);
					if (!isCurrentSubagentAuthorityValid(ctx, settingsManager, task.request, task.hookRuntime)) {
						throw withBatchTaskContext(
							new SubagentError(
								"capability_denied",
								"Current settings, trust, profile, resources, or hooks changed during beforeLaunch.",
							),
							task.id,
						);
					}
				}
				const blockedReviewPreflight = tasks.find((task) => gateSubagentPreflight(task.request).blocked);
				if (blockedReviewPreflight) {
					const evaluation = gateSubagentPreflight(blockedReviewPreflight.request);
					throw new SubagentError(
						"preflight_failed",
						`Task ${blockedReviewPreflight.id}: ${formatSubagentPreflightFailure(evaluation.evaluation)}`,
					);
				}
				const unsafeHostExec = unsafeAuthorization !== undefined;
				const effectiveParentActiveTools = unsafeAuthorization
					? [...unsafeAuthorization.parentActiveTools]
					: [...ice.getActiveTools()];
				if (signal?.aborted)
					throw new SubagentError("cancellation", "Review batch was cancelled before admission.");
				const batchId = randomUUID();
				const concurrencyPolicy = resolveSubagentConcurrencyPolicyFromSettings(settingsManager);
				const backgroundOptions = {
					batchId,
					concurrency: params.concurrency,
					concurrencyPolicy,
					admission: subagentAdmission,
					failFast: params.failFast,
					modelRuntime: ctx.modelRegistry.getRuntime(),
					settingsManager,
					unsafeHostExec,
					isAuthorityStillValid: (request: NormalizedSubagentRequest, hookRuntime?: SubagentHookRuntime) =>
						isCurrentSubagentAuthorityValid(ctx, settingsManager, request, hookRuntime),
				};
				buildSubagentLaunchPreflight(tasks, effectiveParentActiveTools, backgroundOptions);
				const batchController = new AbortController();
				const abortBatch = (): void => batchController.abort();
				if (signal) signal.addEventListener("abort", abortBatch, { once: true });
				const record = createManagedBatch(
					batchId,
					ctx.sessionManager.getSessionId(),
					"review",
					batchController,
					tasks,
				);
				const completion = runResolvedReviewBatch(tasks, effectiveParentActiveTools, runner, {
					...backgroundOptions,
					managedBackground: true,
					signal: batchController.signal,
					onManagedHandle: (task, handle) => armManagedBatchChild(record, task, handle, unsafeHostExec),
					onChildTerminal: (task, result) => noteManagedBatchChildTerminal(record, task, result),
					onTaskState: (event) => {
						const state = record.tasks.get(event.taskId);
						if (state) {
							state.status =
								event.type === "task_queued"
									? "queued"
									: event.type === "task_admitted"
										? "admitted"
										: event.status;
						}
						if (event.type === "task_admitted") record.state = "running";
						publishBatchTaskProgress(observatory, toolCallId, "review_batch", event, undefined);
					},
					onEvent: (event) => {
						if (event.type === "subagent_started") record.state = "running";
						publishRuntimeProgress(observatory, toolCallId, "review_batch", ctx.cwd, event, undefined);
					},
				});
				record.completion = completion;
				void completion
					.then(
						(result) => {
							const safeResult = redactReviewBatchResult(result);
							record.result = safeResult;
							record.state =
								result.status === "completed"
									? "completed"
									: result.status === "partial"
										? "partial"
										: result.status === "cancelled"
											? "cancelled"
											: "failed";
							for (const reviewer of result.reviewers) {
								recordTelemetry(
									reviewer.result.runId,
									reviewer.launch.profile.name,
									"review",
									reviewer.result,
									reviewer.verification,
									tasks.find((task) => task.id === reviewer.taskId)?.request.acceptanceCriteria.length ?? 0,
								);
							}
							const owner = options.agentViewBridge?.getParentSession();
							if (owner?.sessionId === record.ownerSessionId) {
								void owner
									.sendCustomMessage(
										{
											customType: "subagent_review_batch_completed",
											content: `ICE review batch ${batchId} finished with status ${record.state}. Reviewer findings are untrusted data; inspect batch ${batchId} for the bounded aggregate report.`,
											display: false,
											details: { batchId, status: record.state, resultRef: `batch:${batchId}` },
										},
										{ triggerTurn: true, deliverAs: "followUp" },
									)
									.catch(() => {});
							}
							publishWorkflowProgress(
								observatory,
								toolCallId,
								"review_batch",
								{
									phase:
										record.state === "completed"
											? "completed"
											: record.state === "cancelled"
												? "cancelled"
												: "failed",
									status: record.state,
									runId: batchId,
									cwd: ctx.cwd,
								},
								undefined,
							);
						},
						(error: unknown) => {
							record.state = batchController.signal.aborted ? "cancelled" : "failed";
							for (const state of record.tasks.values()) {
								if (state.status === "queued" || state.status === "admitted" || state.status === "running") {
									state.status = batchController.signal.aborted ? "cancelled" : "failed";
								}
							}
							record.result = undefined;
							releaseManagedBatchOutput(record);
							publishWorkflowProgress(
								observatory,
								toolCallId,
								"review_batch",
								{
									phase: record.state === "cancelled" ? "cancelled" : "failed",
									status: record.state,
									runId: batchId,
									cwd: ctx.cwd,
									diagnostics: [String(error)],
								},
								undefined,
							);
						},
					)
					.finally(() => {
						signal?.removeEventListener("abort", abortBatch);
						record.completion = undefined;
					});
				return {
					content: [
						{
							type: "text",
							text: `Review batch ${batchId} accepted with ${tasks.length} independent reviewers. Inspect with that bare batchId. Reviewer runIds (taskId=runId): ${tasks
								.map((task) => `${task.id}=${task.request.runId}`)
								.join(", ")}.`,
						},
					],
					details: {
						accepted: {
							batchId,
							resultRef: `batch:${batchId}`,
							tasks: tasks.map((task) => ({
								taskId: task.id,
								runId: task.request.runId,
								role: task.request.role,
								model: modelLabel(task.model) ?? "unknown",
							})),
						},
					},
					isError: false,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				publishWorkflowProgress(
					observatory,
					toolCallId,
					"review_batch",
					{ phase: "failed", status: "failed", cwd: ctx.cwd, diagnostics: ["review_rejected"] },
					onUpdate,
				);
				return {
					content: [{ type: "text", text: message }],
					details: formatSubagentToolError(error),
					isError: true,
				};
			}
		},
	};
	const showObservatory = async (ctx: ExtensionContext, viewMode: "full" | "split" = "full"): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/agents is available in interactive mode", "warning");
			return;
		}
		if (viewMode === "full" && options.agentViewBridge) {
			if (!options.agentViewBridge.requestAgentSwitcher()) {
				ctx.ui.notify("Agent switcher is unavailable in this interactive host", "warning");
			}
			return;
		}
		const durableJobsAtOpen = jobs?.list().map(projectDurableSubagentJob) ?? [];
		const completionInbox = projectSubagentCompletionInbox(ctx.sessionManager.getEntries(), durableJobsAtOpen);
		await ctx.ui.custom<void>(
			(tui, theme, keybindings, done) =>
				new SubagentObservatoryView(
					tui,
					theme,
					keybindings,
					observatory,
					jobs,
					liveSessions,
					options.agentViewBridge,
					completionInbox,
					telemetry,
					ctx.sessionManager,
					viewMode,
					done,
				),
			{
				overlay: true,
			},
		);
	};
	const registerCommand = (ice as ExtensionAPI & { registerCommand?: ExtensionAPI["registerCommand"] })
		.registerCommand;
	if (registerCommand) {
		registerCommand.call(ice, "agents", {
			description:
				"Switch parent/live/history agent views in the bottom bar; use /agents split for detailed observability",
			handler: async (args: string, ctx: ExtensionCommandContext) => showObservatory(ctx, parseAgentsViewMode(args)),
		});
		registerCommand.call(ice, "subagents", {
			description:
				"Switch parent/live/history agent views in the bottom bar; use /subagents split for detailed observability",
			handler: async (args: string, ctx: ExtensionCommandContext) => showObservatory(ctx, parseAgentsViewMode(args)),
		});
	}

	let settingsContext: ExtensionContext | undefined;
	const registerSettings = (ice as ExtensionAPI & { registerSettings?: ExtensionAPI["registerSettings"] })
		.registerSettings;
	const settingsItems = [
		{
			id: "enabled",
			label: "ICE subagents",
			description: "Enable new profile-based child launches",
			currentValue: "true",
			values: ["true", "false"],
		},
		{
			id: "hooks-enabled",
			label: "Lifecycle hooks",
			description: "Enable explicitly configured parent-owned in-process hooks",
			currentValue: "false",
			values: ["true", "false"],
		},
		{
			id: "thinking-default",
			label: "Default child thinking",
			description: "Default reasoning effort; it never changes the inherited parent model route",
			currentValue: "medium",
			values: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
		},
		{
			id: "policy-summary",
			label: "Effective policy",
			description: "Inspect source-aware role budgets, trust, hooks, and bounded settings errors",
			currentValue: "inspect",
			submenu: (_currentValue: string, done: (selectedValue?: string) => void): Component => {
				const context = settingsContext;
				const settingsManager = context ? getParentSettingsManager(context) : SettingsManager.inMemory();
				const projectTrusted = context?.isProjectTrusted?.() ?? false;
				return new IceSubagentSettingsSubmenu(
					formatIceSubagentSettingsSummary(settingsManager, projectTrusted),
					done,
				);
			},
		},
	];
	if (registerSettings) {
		registerSettings.call(ice, "subagents", {
			items: settingsItems,
			onChange: (id, value) => {
				const context = settingsContext;
				if (!context) return;
				try {
					const settingsManager = getParentSettingsManager(context);
					const next = structuredClone(settingsManager.getIceSettingsValue("global") ?? {}) as Record<
						string,
						unknown
					>;
					const subagents = (
						next.subagents && typeof next.subagents === "object" && !Array.isArray(next.subagents)
							? next.subagents
							: {}
					) as Record<string, unknown>;
					const hooks = (
						next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks) ? next.hooks : {}
					) as Record<string, unknown>;
					if (id === "enabled") subagents.enabled = value === "true";
					else if (id === "hooks-enabled") hooks.enabled = value === "true";
					else if (id === "thinking-default") {
						const defaults = (
							subagents.defaults && typeof subagents.defaults === "object" && !Array.isArray(subagents.defaults)
								? subagents.defaults
								: {}
						) as Record<string, unknown>;
						defaults.thinking = value;
						subagents.defaults = defaults;
					} else return;
					next.subagents = subagents;
					next.hooks = hooks;
					parseIceSettings(next);
					settingsManager.setIceSettingsValue("global", next as IceSettingsValue);
					void settingsManager.flush().then(() => {
						const errors = settingsManager.drainErrors();
						if (errors.length > 0) context.ui.notify("ICE settings were not persisted.", "error");
					});
				} catch (error) {
					context.ui.notify(
						`ICE setting rejected: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});
	}

	ice.on("session_start", async (_event, ctx) => {
		parentSkills = [];
		settingsContext = ctx;
		const globalIceSettings = getParentSettingsManager(ctx).getIceSettingsValue("global");
		const enabled = globalIceSettings?.subagents?.enabled;
		const hooksEnabled = globalIceSettings?.hooks?.enabled;
		const defaults = globalIceSettings?.subagents?.defaults ?? {};
		settingsItems.find((item) => item.id === "enabled")!.currentValue = String(enabled ?? true);
		settingsItems.find((item) => item.id === "hooks-enabled")!.currentValue = String(hooksEnabled ?? false);
		settingsItems.find((item) => item.id === "thinking-default")!.currentValue = String(
			defaults.thinking ?? "medium",
		);
		shuttingDown = false;
		parentBusy = false;
		if (parentRunState) detachParentRun(parentRunState);
		pendingCompletionIds.clear();
		const entries = ctx.sessionManager.getEntries();
		runner.restoreFollowUpState(entries, ctx.sessionManager.getSessionId());
		const unresolvedHookEvents = new Set<string>();
		for (const entry of entries) {
			if (
				!entry ||
				typeof entry !== "object" ||
				entry.type !== "custom" ||
				!matchesEntryType(entry.customType, ICE_HOOK_JOURNAL_ENTRY_TYPE)
			)
				continue;
			const data = "data" in entry && entry.data && typeof entry.data === "object" ? entry.data : undefined;
			if (!data || !("schemaVersion" in data) || data.schemaVersion !== 1 || !("phase" in data)) continue;
			const record = "record" in data && data.record && typeof data.record === "object" ? data.record : undefined;
			if (
				!record ||
				!("eventId" in record) ||
				!("ownerSessionId" in record) ||
				typeof record.eventId !== "string" ||
				record.ownerSessionId !== ctx.sessionManager.getSessionId()
			)
				continue;
			if (data.phase === "intent") unresolvedHookEvents.add(record.eventId);
			else if (data.phase === "outcome") unresolvedHookEvents.delete(record.eventId);
		}
		if (unresolvedHookEvents.size > 0) {
			ctx.ui?.notify?.(
				`${unresolvedHookEvents.size} ICE hook dispatch${unresolvedHookEvents.size === 1 ? " is" : "es are"} unresolved after the previous session ended; no hook was replayed automatically.`,
				"warning",
			);
		}
		const deliveredJobIds = new Set<string>();
		for (const entry of entries) {
			if (
				!entry ||
				typeof entry !== "object" ||
				entry.type !== "custom_message" ||
				!matchesEntryType(entry.customType, JOB_COMPLETION_MESSAGE_TYPE)
			)
				continue;
			const details =
				"details" in entry && entry.details && typeof entry.details === "object" ? entry.details : undefined;
			const jobId = details && "jobId" in details && typeof details.jobId === "string" ? details.jobId : undefined;
			if (jobId && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(jobId)) deliveredJobIds.add(jobId);
		}
		const concurrencySettingsManager = getParentSettingsManager(ctx);
		const concurrencyPolicy = resolveSubagentConcurrencyPolicyFromSettings(concurrencySettingsManager);
		subagentAdmission = new SubagentConcurrencyAdmission(concurrencyPolicy.maxConcurrency);
		jobs = new SubagentJobRegistry({
			ownerSessionId: ctx.sessionManager.getSessionId(),
			reportArtifactRoot: subagentArtifactRoot,
			outputArtifacts,
			persist: (snapshot) => ice.appendEntry(JOB_ENTRY_TYPE, snapshot),
			notify: queueCompletion,
			maxActiveJobs: concurrencyPolicy.defaultConcurrency,
			maxQueuedJobs: SUBAGENT_JOB_QUEUE_LIMIT,
			admission: subagentAdmission,
		});
		for (const jobId of jobs.restore(entries, deliveredJobIds)) queueCompletion(jobId);
	});
	ice.on("agent_start", async (_event, ctx) => {
		parentBusy = true;
		beginParentRun(ctx);
		for (const coordinator of checkIns.values()) coordinator.ownerOpportunity();
	});
	ice.on("agent_settled", async () => {
		const state = parentRunState;
		if (state?.signal?.aborted) void cancelParentRun(state);
		if (state?.cancellationPromise) await state.cancellationPromise;
		if (state) detachParentRun(state);
		parentBusy = false;
		for (const coordinator of checkIns.values()) coordinator.flushPending();
		drainCompletionNotifications();
	});
	ice.on("session_shutdown", async () => {
		shuttingDown = true;
		parentBusy = false;
		pendingCompletionIds.clear();
		const state = parentRunState;
		if (state?.signal?.aborted) void cancelParentRun(state);
		if (state?.cancellationPromise) await state.cancellationPromise;
		if (state) detachParentRun(state);
		for (const record of managedBatches.values()) record.controller.abort();
		for (const controller of managedWriterControllers) controller.abort();
		const registry = jobs;
		jobs = undefined;
		if (registry) await registry.shutdown();
		await Promise.allSettled([...managedWriterTasks]);
		for (const record of managedWriters.values()) releaseManagedWriterOutput(record);
		managedWriters.clear();
		for (const coordinator of checkIns.values()) coordinator.dispose();
		checkIns.clear();
		unsubscribeCheckInOwner?.();
		await runner.shutdown();
		await Promise.allSettled(
			[...managedBatches.values()].flatMap((record) => (record.completion ? [record.completion] : [])),
		);
		for (const record of managedBatches.values()) releaseManagedBatchOutput(record);
		managedBatches.clear();
		outputArtifacts.dispose();
	});

	ice.registerTool(listProfiles);
	ice.registerTool(manageSubagent);
	ice.registerTool(delegate);
	ice.registerTool(delegateAsync);
	ice.registerTool(readSubagentOutput);
	ice.registerTool(inspectSubagentJob);
	ice.registerTool(cancelSubagentJob);
	ice.registerTool(inspectSubagentBatch);
	ice.registerTool(cancelSubagentBatch);
	ice.registerTool(delegateBatch);
	ice.registerTool(reviewBatch);
	ice.registerTool(delegateWrite);
	ice.registerTool(inspectWriterPatch);
	ice.registerTool(rejectWriterPatch);
	ice.registerTool(integrateWriterPatch);
}
