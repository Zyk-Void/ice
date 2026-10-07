/** Launch provenance/preflight and batch/review execution (moved from ice-subagents.ts). */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { redactCredentialText } from "../../utils/redact.ts";
import { revalidateSubagentProfile } from "../definitions/legacy-profiles.ts";
import { classifySubagentFailure } from "../results/format.ts";
import { normalizeReviewFindings, verifySubagentResult } from "../results/report.ts";
import { deriveEffectiveSubagentTools } from "../tools/derive.ts";
import { canonicalPath, isPathWithin } from "../tools/paths.ts";
import {
	type EvidenceRef,
	type NormalizedSubagentRequest,
	REVIEW_DIMENSIONS,
	type ResolvedReviewTask,
	type ResolvedSubagentBatchTask,
	type ReviewBatchResult,
	type ReviewerModelProvenance,
	type ReviewerResult,
	type ReviewFinding,
	type ReviewTask,
	SUBAGENT_BATCH_LIMITS,
	SUBAGENT_HANDOFF_CONTEXT_LIMITS,
	SUBAGENT_OUTPUT_SCHEMA_LIMITS,
	type SubagentBatchItemResult,
	type SubagentBatchResult,
	type SubagentBatchRunOptions,
	type SubagentBatchStatus,
	type SubagentBatchTaskLifecycleEvent,
	type SubagentDiagnostic,
	type SubagentFailureCode,
	type SubagentLaunchPreflight,
	type SubagentLaunchPreflightTask,
	type SubagentLaunchProvenance,
	type SubagentResult,
	type SubagentStatus,
	type SubagentUsage,
	subagentMcpToolName,
} from "../types.ts";
import { SubagentError } from "./helpers.ts";
import { truncateSubagentOutput } from "./prompt.ts";
import {
	assertSubagentHandoffContextBudget,
	normalizeSubagentRequest,
	type SubagentNormalizationOptions,
} from "./request.ts";
import { revalidateSubagentResources } from "./resources.ts";
import { type NativeSubagentRunner, runSubagentWithRecovery } from "./runner.ts";

export function createSubagentLaunchProvenance(
	request: NormalizedSubagentRequest,
	model?: Model<Api>,
): SubagentLaunchProvenance {
	return {
		profile: {
			name: request.profile.name,
			source: request.profile.source,
			sourcePath: request.profile.sourcePath,
			canonicalPath: request.profile.canonicalPath,
			sourceHash: request.profile.sourceHash,
			unsafeHostExec: request.profile.unsafeHostExec === true,
			...(request.profile.color ? { color: request.profile.color } : {}),
		},
		resources: {
			skills: [...request.resources.skills],
			prompts: [...request.resources.prompts],
			context: [...request.resources.context],
		},
		projectTrusted: request.projectTrusted,
		allowExternal: request.allowExternal,
		model: model ? modelReference(model) : undefined,
		...(request.modelCandidates ? { modelCandidates: [...request.modelCandidates] } : {}),
		...(request.modelCandidateSkips ? { modelCandidateSkips: [...request.modelCandidateSkips] } : {}),
		...(request.selectedMcpTools ? { mcpTools: [...request.selectedMcpTools] } : {}),
		...(request.selectedAdapterIds ? { adapterIds: [...request.selectedAdapterIds] } : {}),
		scopeRoots: [...request.scope.roots],
		scopeTargets: [...(request.scope.targets ?? [])],
		checkIn: {
			intervalMs: request.checkInIntervalMs,
			source: request.iceContract.sources.checkInIntervalMs,
		},
		execution: {
			...request.execution,
			timeoutMs: request.timeoutMs,
			...(request.execution.tools ? { tools: [...request.execution.tools] } : {}),
			sources: {
				thinking: request.iceContract.sources.thinking,
				timeoutMs: request.iceContract.sources.timeoutMs,
				temperature: request.iceContract.sources.temperature,
				topP: request.iceContract.sources.topP,
			},
			restrictionsApplied: [...request.iceContract.restrictionsApplied],
		},
		settingsDiagnostics: [...request.iceContract.diagnostics],
		deniedTools: [...request.iceContract.deniedTools],
		...(request.outputSchema
			? {
					outputSchema: {
						schemaBytes: Buffer.byteLength(JSON.stringify(request.outputSchema)),
						maxPayloadBytes: SUBAGENT_OUTPUT_SCHEMA_LIMITS.maxPayloadBytes,
					},
				}
			: {}),
	};
}

interface ResolvedBatchConfiguration {
	concurrency: number;
}

function resolveBatchConfiguration(options: SubagentBatchRunOptions): ResolvedBatchConfiguration {
	if (Object.hasOwn(options, "totalBudgetBytes")) {
		throw new SubagentError("malformed_result", '"totalBudgetBytes" was removed; output storage is host-owned.');
	}
	if (Object.hasOwn(options, "totalTokenBudget")) {
		throw new SubagentError(
			"malformed_result",
			'"totalTokenBudget" was removed; use batch concurrency and per-task execution controls.',
		);
	}
	const maxAllowed = options.concurrencyPolicy?.maxConcurrency ?? SUBAGENT_BATCH_LIMITS.maxConcurrency;
	const defaultConcurrency = options.concurrencyPolicy?.defaultConcurrency ?? SUBAGENT_BATCH_LIMITS.defaultConcurrency;
	const concurrency = options.concurrency ?? defaultConcurrency;
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > maxAllowed) {
		throw new SubagentError("malformed_result", `Batch concurrency must be between 1 and ${maxAllowed}.`);
	}
	return { concurrency };
}

function preflightModel(task: ResolvedSubagentBatchTask): SubagentLaunchPreflightTask["model"] {
	const resolved = task.model ? modelReference(task.model) : undefined;
	if (task.modelProvenance && task.modelProvenance.resolved !== resolved) {
		throw new SubagentError("malformed_result", `Parent model provenance is inconsistent for task ${task.id}.`);
	}
	return { resolved, source: task.request.requestedModel ? "call" : "parent" };
}

export function effectiveSubagentToolNames(
	request: NormalizedSubagentRequest,
	parentTools: readonly string[],
	unsafeHostExec: boolean,
): string[] {
	const wanted = (request.execution.tools ?? request.profile.requestedTools).filter(
		(tool) => request.profile.requestedTools.includes(tool) && !request.deniedTools.includes(tool.toLowerCase()),
	);
	const builtins = deriveEffectiveSubagentTools({
		requestedTools: wanted,
		parentActiveTools: parentTools,
		unsafeHostExec: unsafeHostExec && !request.readOnlyReview,
	});
	return [
		...builtins,
		...(request.delegatedTools ?? []).map((tool) => tool.name),
		...(request.selectedMcpTools ?? []).map(subagentMcpToolName),
	];
}

export function buildSubagentLaunchPreflight(
	tasks: readonly ResolvedSubagentBatchTask[],
	parentActiveTools: readonly string[],
	options: SubagentBatchRunOptions & { batchId?: string } = {},
): SubagentLaunchPreflight {
	validateResolvedBatchTasks(tasks);
	const { concurrency } = resolveBatchConfiguration(options);
	const preflightTasks = tasks.map((task) => {
		revalidateSubagentProfile(task.request.profile);
		revalidateSubagentResources(task.request.resources);
		assertSubagentHandoffContextBudget(task.request.contextPacket, task.request.forkContext);
		const tools = effectiveSubagentToolNames(task.request, parentActiveTools, options.unsafeHostExec === true);
		if (
			tools.length === 0 &&
			!task.request.delegatedTools?.length &&
			!task.request.selectedMcpTools?.length &&
			task.request.requestedTools?.length !== 0
		) {
			throw new SubagentError(
				"capability_denied",
				`Parent policy does not permit any child tool for task ${task.id}.`,
			);
		}
		return {
			taskId: task.id,
			role: task.request.role,
			cwd: task.request.cwd,
			model: {
				...preflightModel(task),
				...(task.request.modelCandidates ? { candidates: [...task.request.modelCandidates] } : {}),
				...(task.request.modelCandidateSkips ? { skipped: [...task.request.modelCandidateSkips] } : {}),
			},
			...(task.request.selectedMcpTools ? { mcpTools: [...task.request.selectedMcpTools] } : {}),
			...(task.request.selectedAdapterIds ? { adapterIds: [...task.request.selectedAdapterIds] } : {}),
			scopeRoots: [...task.request.scope.roots],
			scopeTargets: [...(task.request.scope.targets ?? [])],
			tools,
			resources: {
				skills: task.request.resources.skills.map((resource) => resource.name),
				prompts: task.request.resources.prompts.map((resource) => resource.name),
				context: task.request.resources.context.map((resource) => resource.name),
			},
			execution: {
				thinking: task.request.execution.thinking,
				timeoutMs: task.request.timeoutMs,
				...(task.request.execution.temperature !== undefined
					? { temperature: task.request.execution.temperature }
					: {}),
				...(task.request.execution.topP !== undefined ? { topP: task.request.execution.topP } : {}),
				tools: task.request.execution.tools,
			},
			...(task.request.outputSchema
				? {
						outputSchema: {
							schemaBytes: Buffer.byteLength(JSON.stringify(task.request.outputSchema)),
							maxPayloadBytes: SUBAGENT_OUTPUT_SCHEMA_LIMITS.maxPayloadBytes,
						},
					}
				: {}),
			resourceProvenance: {
				skills: task.request.resources.skills.map(({ kind, name, source, canonicalPath, sourceHash }) => ({
					kind,
					name,
					source,
					canonicalPath,
					sourceHash,
				})),
				prompts: task.request.resources.prompts.map(({ kind, name, source, canonicalPath, sourceHash }) => ({
					kind,
					name,
					source,
					canonicalPath,
					sourceHash,
				})),
				context: task.request.resources.context.map(({ kind, name, source, canonicalPath, sourceHash }) => ({
					kind,
					name,
					source,
					canonicalPath,
					sourceHash,
				})),
			},
			contextPacket: {
				itemCount: task.request.contextPacket.items.length,
				totalBytes: task.request.contextPacket.totalBytes,
				items: task.request.contextPacket.items.map(({ id, kind, bytes }) => ({ id, kind, bytes })),
			},
			forkContext: {
				mode: task.request.forkContext.mode,
				sourceSessionId: task.request.forkContext.sourceSessionId,
				sourceLeafId: task.request.forkContext.sourceLeafId,
				messageCount: task.request.forkContext.messages.length,
				totalBytes: task.request.forkContext.totalBytes,
				dropped: task.request.forkContext.dropped,
			},
			contextBudget: {
				packetBytes: task.request.contextPacket.totalBytes,
				forkBytes: task.request.forkContext.totalBytes,
				totalBytes: task.request.contextPacket.totalBytes + task.request.forkContext.totalBytes,
				maxBytes: SUBAGENT_HANDOFF_CONTEXT_LIMITS.maxTotalBytes,
			},
			projectTrusted: task.request.projectTrusted,
		};
	});
	return {
		batchId: options.batchId,
		taskCount: tasks.length,
		concurrency,
		recovery: options.unsafeHostExec
			? { maxAttempts: 1, sameModel: true, retryableFailures: [] }
			: {
					maxAttempts: 2,
					sameModel: !tasks.some((task) => task.request.resolveStartupFallback),
					retryableFailures: ["explicit_transient_startup"],
				},
		tasks: preflightTasks,
	};
}

export function formatSubagentLaunchDigest(preflight: SubagentLaunchPreflight, maxBytes = 8 * 1024): string {
	if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
		throw new SubagentError("malformed_result", "Launch digest size must be a positive integer.");
	}
	const lines = [
		`Launch preflight: ${preflight.taskCount} tasks`,
		`concurrency: ${preflight.concurrency}`,
		`recovery: maxAttempts=${preflight.recovery.maxAttempts} sameModel=${preflight.recovery.sameModel} retryable=${preflight.recovery.retryableFailures.join(",")}`,
		...preflight.tasks.flatMap((task) => {
			const model = task.model.resolved ?? "unresolved";
			const source = ` [${task.model.source}]`;
			const resources = Object.entries(task.resources)
				.filter(([, names]) => names.length > 0)
				.map(([kind, names]) => `${kind}: ${names.join(", ")}`)
				.join("; ");
			return [
				`${task.taskId} (${task.role})`,
				`  model: ${model}${source}`,
				task.model.candidates && task.model.candidates.length > 0
					? `  model candidates: ${task.model.candidates.join(", ")}`
					: undefined,
				task.model.skipped && task.model.skipped.length > 0
					? `  model skips: ${task.model.skipped.map((skip) => `${skip.reference} (${skip.reason})`).join(", ")}`
					: undefined,
				task.mcpTools && task.mcpTools.length > 0 ? `  MCP tools: ${task.mcpTools.join(", ")}` : undefined,
				`  scope: ${task.scopeRoots.join(", ")}`,
				task.scopeTargets.length > 0
					? `  targets: ${task.scopeTargets.map((target) => relative(task.cwd, target) || ".").join(", ")}`
					: undefined,
				`  tools: ${task.tools.join(", ")}`,
				`  execution: thinking=${task.execution.thinking} timeout=${task.execution.timeoutMs}ms${task.execution.temperature !== undefined ? ` temperature=${task.execution.temperature}` : ""}${
					task.execution.topP !== undefined ? ` topP=${task.execution.topP}` : ""
				}`,
				task.outputSchema
					? `  output schema: ${task.outputSchema.schemaBytes} bytes, payload <= ${task.outputSchema.maxPayloadBytes} bytes`
					: undefined,
				`  context: ${task.forkContext.mode} fork=${task.forkContext.messageCount}/${task.forkContext.totalBytes} bytes packet=${task.contextPacket.totalBytes} bytes`,
				resources ? `  resources: ${resources}` : undefined,
			];
		}),
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
	return truncateSubagentOutput(redactCredentialText(lines), maxBytes).text;
}

export function batchUsage(): SubagentUsage {
	return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
}

export function addBatchUsage(total: SubagentUsage, usage: SubagentUsage | undefined): void {
	if (!usage) return;
	total.inputTokens += usage.inputTokens;
	total.outputTokens += usage.outputTokens;
	total.cacheReadTokens += usage.cacheReadTokens;
	total.cacheWriteTokens += usage.cacheWriteTokens;
	total.cost += usage.cost;
}

function batchTaskResult(
	task: ResolvedSubagentBatchTask,
	status: Extract<SubagentStatus, "failed" | "cancelled" | "timed_out">,
	code: SubagentFailureCode,
	message: string,
	retryable = false,
): SubagentResult {
	return {
		runId: task.request.runId,
		parentSessionId: task.request.parentSessionId,
		profile: task.request.profile.name,
		source: task.request.profile.source,
		status,
		summary: message,
		observedOutputBytes: 0,
		partial: status !== "failed",
		diagnostics: [{ code, message, ...(retryable ? { retryable: true } : {}) }],
		...(task.request.scope.targets?.length ? { scopeTargets: [...task.request.scope.targets] } : {}),
	};
}

function batchItem(
	task: ResolvedSubagentBatchTask,
	result: SubagentResult,
	verification = verifySubagentResult(result, task.request),
): SubagentBatchItemResult {
	const normalizedResult = {
		...result,
		...(task.request.scope.targets?.length ? { scopeTargets: [...task.request.scope.targets] } : {}),
	};
	return {
		taskId: task.id,
		launch: createSubagentLaunchProvenance(task.request, task.model),
		result: normalizedResult,
		verification,
	};
}

function validateResolvedBatchTasks(tasks: readonly ResolvedSubagentBatchTask[]): void {
	if (tasks.length === 0 || tasks.length > SUBAGENT_BATCH_LIMITS.maxTasks) {
		throw new SubagentError("malformed_result", `A batch must contain 1-${SUBAGENT_BATCH_LIMITS.maxTasks} tasks.`);
	}
	const ids = new Set<string>();
	for (const task of tasks) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task.id) || ids.has(task.id)) {
			throw new SubagentError("malformed_result", `Batch task IDs must be unique bounded identifiers: ${task.id}`);
		}
		ids.add(task.id);
	}
}

function batchStatus(
	items: readonly SubagentBatchItemResult[],
	stopReason: "cancelled" | "timed_out" | undefined,
	failFast: boolean,
): SubagentBatchStatus {
	const successful = items.filter((item) => item.result.status === "completed" && item.verification.verified).length;
	if (successful === items.length) return "completed";
	if (successful > 0) return "partial";
	if (failFast) return "failed";
	if (stopReason === "timed_out" || items.some((item) => item.result.status === "timed_out")) return "timed_out";
	if (stopReason === "cancelled" || items.some((item) => item.result.status === "cancelled")) return "cancelled";
	return "failed";
}

export async function runResolvedSubagentBatch(
	tasks: readonly ResolvedSubagentBatchTask[],
	parentActiveTools: readonly string[],
	runner: Pick<NativeSubagentRunner, "runResolved">,
	options: SubagentBatchRunOptions = {},
): Promise<SubagentBatchResult> {
	const batchId = options.batchId ?? randomUUID();
	const preflight = buildSubagentLaunchPreflight(tasks, parentActiveTools, {
		...options,
		batchId,
	});
	const concurrency = preflight.concurrency;
	const admission = options.admission;
	const controller = new AbortController();
	const items: Array<SubagentBatchItemResult | undefined> = new Array(tasks.length);
	const diagnostics: SubagentDiagnostic[] = [];
	const usage = batchUsage();
	let nextIndex = 0;
	let active = 0;
	let settled = 0;
	let finished = false;
	let stopReason: "cancelled" | undefined;
	let failFastTriggered = false;
	let removeAbortListener: (() => void) | undefined;

	return new Promise<SubagentBatchResult>((resolveBatch) => {
		const publishTaskState = (event: SubagentBatchTaskLifecycleEvent): void => options.onTaskState?.(event);
		for (const [index, task] of tasks.entries()) {
			publishTaskState({
				type: "task_queued",
				batchId,
				taskId: task.id,
				role: task.request.profile.name,
				index,
			});
		}

		const finish = (): void => {
			if (finished || settled !== tasks.length || active !== 0) return;
			finished = true;
			removeAbortListener?.();
			removeAdmissionListener?.();
			const completedItems = items as SubagentBatchItemResult[];
			resolveBatch({
				batchId,
				status: batchStatus(completedItems, stopReason, failFastTriggered),
				preflight,
				items: completedItems,
				usage,
				diagnostics,
			});
		};

		const markQueued = (
			index: number,
			status: "failed" | "cancelled" | "timed_out",
			code: SubagentFailureCode,
			message: string,
		): void => {
			const task = tasks[index]!;
			const result = batchTaskResult(task, status, code, message);
			items[index] = batchItem(task, result);
			diagnostics.push({ code, message: `${task.id}: ${message}` });
			publishTaskState({
				type: "task_skipped",
				batchId,
				taskId: task.id,
				status,
				reason: message,
			});
			settled++;
		};

		// Wake this batch's pump when shared admission capacity is released elsewhere
		// (for example by a background job settling or a batch slot freeing up).
		const removeAdmissionListener = admission ? admission.onRelease(() => pump()) : undefined;

		const pump = (): void => {
			if (finished) return;
			if (stopReason || failFastTriggered) {
				while (nextIndex < tasks.length) {
					const status = failFastTriggered ? "failed" : stopReason!;
					const code: SubagentFailureCode = failFastTriggered
						? "child_runtime_failure"
						: status === "cancelled"
							? "cancellation"
							: "timeout";
					markQueued(
						nextIndex++,
						status,
						code,
						failFastTriggered ? "Batch stopped after fail-fast." : `Batch ${status}.`,
					);
				}
				finish();
				return;
			}

			while (active < concurrency && nextIndex < tasks.length) {
				if (admission && !admission.tryAcquire()) break;
				const task = tasks[nextIndex]!;
				const index = nextIndex++;
				active++;
				publishTaskState({
					type: "task_admitted",
					batchId,
					taskId: task.id,
					role: task.request.profile.name,
					index,
				});
				let childResult: SubagentResult | undefined;
				void Promise.resolve()
					.then(() => {
						const runAttempt = (
							attempt: 1 | 2,
							request: NormalizedSubagentRequest,
							activeTools: readonly string[],
						) =>
							runner.runResolved(request, activeTools, {
								model: request.retryModel ?? task.model,
								modelRuntime: options.modelRuntime,
								settingsManager: options.settingsManager,
								projectTrusted: request.projectTrusted,
								unsafeHostExec: options.unsafeHostExec,
								taskId: task.id,
								signal: controller.signal,
								isAuthorityStillValid: () => options.isAuthorityStillValid?.(request, task.hookRuntime) ?? true,
								batchId,
								...(options.managedBackground ? {} : { management: "internal" as const }),
								noLifetimeTimeout: true,
								attempt,
								hookRuntime: task.hookRuntime,
								onManagedHandle: options.managedBackground
									? (handle) => options.onManagedHandle?.(task, handle)
									: undefined,
								onEvent: (event) => options.onEvent?.({ ...event, taskId: task.id }),
							});
						return options.unsafeHostExec
							? runAttempt(1, task.request, parentActiveTools)
							: runSubagentWithRecovery(task.request, parentActiveTools, runAttempt, {
									getStopReason: () => {
										if (stopReason) return stopReason;
										return failFastTriggered ? "fail_fast" : undefined;
									},
								});
					})
					.then(
						(result) => {
							const verification = verifySubagentResult(result, task.request);
							const finalResult =
								!verification.verified && result.status === "completed"
									? {
											...result,
											status: "verification_failed" as const,
											diagnostics: [
												...result.diagnostics,
												{
													code: "verification_failure" as const,
													message: verification.reason,
												},
											],
										}
									: result;
							childResult = finalResult;
							const item = batchItem(task, finalResult, verification);
							items[index] = item;
							addBatchUsage(usage, item.result.usage);
							if (options.failFast && (item.result.status !== "completed" || !item.verification.verified)) {
								failFastTriggered = true;
								controller.abort();
							}
						},
						(error: unknown) => {
							const failure = classifySubagentFailure(error, "runtime");
							const result = batchTaskResult(task, "failed", failure.code, failure.message, failure.retryable);
							childResult = result;
							items[index] = batchItem(task, result);
							diagnostics.push({ code: result.diagnostics[0]!.code, message: `${task.id}: ${failure.message}` });
							addBatchUsage(usage, result.usage);
							if (options.failFast) {
								failFastTriggered = true;
								controller.abort();
							}
						},
					)
					.finally(() => {
						try {
							options.onChildTerminal?.(task, childResult);
						} catch {
							// Lifecycle observers cannot change batch results.
						}
						active--;
						admission?.release();
						settled++;
						pump();
					});
			}
			finish();
		};

		const stop = (reason: "cancelled"): void => {
			if (stopReason || finished || failFastTriggered) return;
			stopReason = reason;
			controller.abort();
			pump();
		};
		if (options.signal) {
			if (options.signal.aborted) stop("cancelled");
			else {
				const abortListener = () => stop("cancelled");
				options.signal.addEventListener("abort", abortListener, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", abortListener);
			}
		}
		pump();
	});
}

function normalizeReviewTaskEvidence(
	evidence: readonly EvidenceRef[] | undefined,
	request: NormalizedSubagentRequest,
): EvidenceRef[] {
	if (!evidence || evidence.length === 0) return [];
	if (evidence.length > 16) throw new SubagentError("malformed_result", "Reviewer evidence references are bounded.");
	return evidence.map((reference) => {
		if (
			!reference ||
			typeof reference.path !== "string" ||
			reference.path.length === 0 ||
			Buffer.byteLength(reference.path) > 4096
		) {
			throw new SubagentError("malformed_result", "Reviewer evidence references are invalid.");
		}
		const candidate = resolve(request.cwd, reference.path);
		if (!existsSync(candidate)) {
			throw new SubagentError("invalid_scope", `Reviewer evidence path does not exist: ${reference.path}`);
		}
		const canonicalCandidate = canonicalPath(candidate);
		if (!request.allowExternal && !request.scope.roots.some((root) => isPathWithin(root, canonicalCandidate))) {
			throw new SubagentError("invalid_scope", `Reviewer evidence path is outside scope: ${reference.path}`);
		}
		return { path: canonicalCandidate };
	});
}

export function modelReference(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function reviewTaskPrompt(task: ReviewTask, evidence: readonly EvidenceRef[]): string {
	return [
		task.task,
		`Review dimension: ${task.dimension}.`,
		"Return exactly one JSON object with `summary`, `evidence.paths`, and `findings`.",
		"Each finding must contain `severity` (low, medium, or high), `category`, `claim`, and evidence path references.",
		evidence.length > 0
			? `Parent evidence references:\n${evidence.map((ref) => `- ${ref.path}`).join("\n")}`
			: undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join("\n\n");
}

export function resolveReviewTask(
	task: ReviewTask,
	parentSessionId: string,
	cwd: string,
	options: SubagentNormalizationOptions = {},
): ResolvedReviewTask {
	if (!REVIEW_DIMENSIONS.includes(task.dimension)) {
		throw new SubagentError("malformed_result", `Unknown review dimension: ${task.dimension}`);
	}
	// review_batch uses self-delegation with a bounded reviewer instruction snapshot;
	// explicitly named file agents remain available through delegate/delegate_batch.
	const baseRequest = normalizeSubagentRequest(
		{
			parentSessionId,
			role: "self",
			self: {
				instructions:
					"You are a bounded reviewer. Inspect only the approved scope, report concrete defects with file paths and line references, separate verified findings from uncertainty and unrun checks, and do not modify files.",
				capabilities: ["read", "grep", "find", "ls"],
			},
			task: task.task,
			scope: task.scope,
			cwd,
			context: task.context,
			contextPacket: task.contextPacket,
			contextMode: task.contextMode,
			kind: "review",
			verification: { mode: "review" },
			checkInIntervalMs: task.checkInIntervalMs,
			execution: task.execution,
			resources: task.resources,
			outputSchema: task.outputSchema,
		},
		cwd,
		options,
	);
	const evidence = normalizeReviewTaskEvidence(task.evidence, baseRequest);
	return {
		id: task.id,
		dimension: task.dimension,
		request: {
			...baseRequest,
			readOnlyReview: true,
			reportMode: "structured_report",
			task: reviewTaskPrompt(task, evidence),
		},
	};
}

function reviewBatchItemStatus(item: ReviewerResult): boolean {
	return item.result.status === "completed" && item.verification.verified;
}

export async function runResolvedReviewBatch(
	tasks: readonly ResolvedReviewTask[],
	parentActiveTools: readonly string[],
	runner: Pick<NativeSubagentRunner, "runResolved">,
	options: SubagentBatchRunOptions = {},
): Promise<ReviewBatchResult> {
	for (const task of tasks) {
		if (task.request.agentKind !== "self" || task.request.profile.source !== "self") {
			throw new SubagentError("malformed_result", `Reviewer task ${task.id} must use self-delegation.`);
		}
		if (!REVIEW_DIMENSIONS.includes(task.dimension)) {
			throw new SubagentError("malformed_result", `Unknown review dimension: ${task.dimension}`);
		}
		// Reviewers always ingest through the strict JSON report protocol, even when
		// a hand-built task arrived normalized as a plain delegation.
		if (task.request.reportMode !== "structured_report") {
			task.request = { ...task.request, readOnlyReview: true, reportMode: "structured_report" };
		}
	}
	const batch = await runResolvedSubagentBatch(tasks, parentActiveTools, runner, options);
	const reviewers = tasks.map((task, index) => {
		const item = batch.items[index]!;
		const modelProvenance =
			task.modelProvenance ??
			({
				source: "parent",
				resolved: task.model ? modelReference(task.model) : "parent",
			} satisfies ReviewerModelProvenance);
		let verification = item.verification;
		let findings: ReviewFinding[] = [];
		if (verification.verified) {
			try {
				findings = normalizeReviewFindings(item.result.findings, task.request);
			} catch (error) {
				verification = {
					verified: false,
					reason: error instanceof Error ? error.message : "Reviewer findings failed verification.",
					paths: verification.paths,
					unresolvedClaims: verification.unresolvedClaims,
				};
			}
		}
		return {
			taskId: task.id,
			dimension: task.dimension,
			findings,
			verification,
			result: verification.verified
				? item.result
				: item.result.status === "completed"
					? {
							...item.result,
							status: "verification_failed" as const,
							diagnostics: [
								...item.result.diagnostics,
								{ code: "verification_failure" as const, message: verification.reason },
							],
						}
					: item.result,
			launch: { ...item.launch, modelProvenance },
			modelProvenance,
		};
	});
	const successful = reviewers.filter(reviewBatchItemStatus).length;
	const status: SubagentBatchStatus =
		successful === reviewers.length
			? "completed"
			: successful > 0
				? "partial"
				: batch.status === "timed_out" || batch.status === "cancelled"
					? batch.status
					: "failed";
	return {
		batchId: batch.batchId,
		status,
		preflight: batch.preflight,
		reviewers,
		usage: batch.usage,
		diagnostics: batch.diagnostics,
	};
}
