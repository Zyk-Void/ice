/** Native writer runner (moved from ice-subagents.ts). */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "../../core/sdk.ts";
import {
	collectWriterPatchArtifact,
	createWriterWorkspace,
	validateWriterLaunchPreflight,
} from "../isolation/writer-patch.ts";
import { SUBAGENT_OUTPUT_ARTIFACT_LIMITS, SubagentOutputArtifactStore } from "../results/output-artifacts.ts";
import { deriveUnsafeSubagentTools, deriveWriterTools } from "../tools/derive.ts";
import type {
	NormalizedWriterRequest,
	SubagentStatus,
	SubagentUsage,
	WriterPatchArtifact,
	WriterResult,
	WriterWorkspace,
} from "../types.ts";
import type { ObservatoryPhase } from "../ui/observatory.ts";
import {
	abortChildSession,
	awaitSubagentStartup,
	displayScopedSubagentPath,
	extractProgressPath,
	SubagentError,
	shutdownChildSession,
} from "./helpers.ts";
import { extractAssistantText, truncateSubagentOutput } from "./prompt.ts";
import {
	createNativeWriterSession,
	type NativeWriterRunnerOptions,
	type NativeWriterRunOptions,
	type NativeWriterSession,
	type WriterProgressEvent,
} from "./session-factory.ts";

export class NativeWriterRunner {
	private readonly createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	private readonly agentDir?: string;
	private readonly artifactRoot?: string;
	private readonly outputArtifacts: SubagentOutputArtifactStore;

	constructor(options: NativeWriterRunnerOptions = {}) {
		this.createSession = options.createSession ?? createAgentSession;
		this.agentDir = options.agentDir;
		this.artifactRoot = options.artifactRoot;
		this.outputArtifacts =
			options.outputArtifacts ?? new SubagentOutputArtifactStore({ artifactRoot: options.outputArtifactRoot });
	}

	async run(
		request: NormalizedWriterRequest,
		parentActiveTools: readonly string[],
		options: NativeWriterRunOptions = {},
	): Promise<WriterResult> {
		const runId = randomUUID();
		const directWorkspace = options.directWorkspace === true;
		const base = {
			runId,
			parentSessionId: request.parentSessionId,
			baseCommit: request.baseCommit,
			workspaceIsolation: directWorkspace ? ("parent" as const) : ("worktree" as const),
			observedOutputBytes: 0,
			workspaceRemoved: false,
		};
		const emit = (
			phase: ObservatoryPhase,
			status: SubagentStatus,
			fields: Omit<WriterProgressEvent, "runId" | "phase" | "status"> = {},
		): void => options.onEvent?.({ runId, phase, status, ...fields });
		const activeWriterTools = directWorkspace
			? deriveUnsafeSubagentTools(parentActiveTools)
			: deriveWriterTools(parentActiveTools);
		if (activeWriterTools.length === 0) {
			emit("preflight", "failed", { diagnostics: ["capability_denied"] });
			return {
				...base,
				status: "failed",
				summary: directWorkspace
					? "YOLO writer has no active scoped writer tools."
					: "Writer delegation is not active in the parent policy.",
				workspaceRemoved: !directWorkspace,
				diagnostics: [
					{
						code: "capability_denied",
						message: directWorkspace
							? "YOLO writer requires an active scoped writer tool."
							: "Parent policy does not activate delegate_write.",
					},
				],
			};
		}
		if (options.signal?.aborted) {
			emit("preflight", "cancelled", { diagnostics: ["cancellation"] });
			return {
				...base,
				status: "cancelled",
				summary: "Writer cancelled before startup.",
				workspaceRemoved: !directWorkspace,
				diagnostics: [{ code: "cancellation", message: "Parent cancellation arrived before writer startup." }],
			};
		}

		let workspace: WriterWorkspace | undefined;
		let childSession: NativeWriterSession["session"] | undefined;
		let observedOutputBytes = 0;
		let removeAbortListener: (() => void) | undefined;
		let unsubscribeChild: (() => void) | undefined;
		let control: "cancelled" | undefined;
		let resolveControl: ((reason: "cancelled") => void) | undefined;
		let patchArtifact: WriterPatchArtifact | undefined;
		let result: WriterResult = {
			...base,
			status: "failed",
			summary: "Writer failed before completion.",
			diagnostics: [],
		};
		try {
			emit("preflight", "running");
			const preflight = directWorkspace
				? { parentRoot: request.cwd }
				: await validateWriterLaunchPreflight(request.cwd, request.baseCommit);
			workspace = directWorkspace
				? {
						parentRoot: request.cwd,
						root: request.cwd,
						baseCommit: request.baseCommit,
						cleanup: async () => {},
					}
				: await createWriterWorkspace(request.cwd, request.baseCommit);
			emit("workspace_created", "running", directWorkspace ? { diagnostics: ["unsafe_parent_workspace"] } : {});
			try {
				options.onAdmitted?.({
					runId,
					baseCommit: request.baseCommit,
					workspaceIsolation: directWorkspace ? "parent" : "worktree",
				});
			} catch {
				// Admission observers cannot alter writer execution.
			}
			const isolatedRequest: NormalizedWriterRequest = directWorkspace
				? request
				: {
						...request,
						cwd: workspace.root,
						scope: {
							roots: request.scope.roots.map((root) =>
								resolve(workspace!.root, relative(preflight.parentRoot, root)),
							),
						},
					};
			const startupPromise = createNativeWriterSession(
				{
					request: isolatedRequest,
					parentActiveTools,
					directWorkspace,
					unsafeHostExec: options.unsafeHostExec,
					model: options.model,
					modelRuntime: options.modelRuntime,
					agentDir: this.agentDir,
				},
				this.createSession,
			);
			const startup = await awaitSubagentStartup(startupPromise, request.timeoutMs, options.signal);
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
				throw new SubagentError(
					startup.kind === "cancelled" ? "cancellation" : "timeout",
					`Writer ${startup.kind} during startup.`,
				);
			}
			const created = startup.value;
			childSession = created.session;
			emit("running", "running");
			if (typeof childSession.subscribe === "function") {
				unsubscribeChild = childSession.subscribe((event: AgentSessionEvent) => {
					if (event.type === "tool_execution_start") {
						emit("tool_activity", "running", {
							currentTool: event.toolName,
							currentPath: displayScopedSubagentPath(
								workspace?.root ?? request.cwd,
								isolatedRequest.scope.roots,
								extractProgressPath(event.args),
							),
						});
					} else if (event.type === "message_update") {
						observedOutputBytes = Buffer.byteLength(extractAssistantText(childSession?.messages ?? []));
					}
				});
			}
			if (!childSession.model) throw new SubagentError("model_unavailable", "No model is available for the writer.");
			if (options.signal?.aborted) {
				control = "cancelled";
				await abortChildSession(childSession);
				result = {
					...base,
					status: "cancelled",
					summary: "Writer cancelled before prompting.",
					diagnostics: [{ code: "cancellation", message: "Parent cancellation arrived before prompting." }],
				};
			} else {
				const controlPromise = new Promise<"cancelled">((resolveControlPromise) => {
					resolveControl = resolveControlPromise;
				});
				const abortListener = () => resolveControl?.("cancelled");
				if (options.signal) {
					options.signal.addEventListener("abort", abortListener, { once: true });
					removeAbortListener = () => options.signal?.removeEventListener("abort", abortListener);
				}
				const promptPromise = childSession.prompt(created.prompt, {
					expandPromptTemplates: false,
				});
				void promptPromise.catch(() => {});
				const outcome = await Promise.race([
					promptPromise.then(
						() => ({ kind: "completed" as const }),
						(error: unknown) => ({ kind: "error" as const, error }),
					),
					controlPromise.then((reason) => ({ kind: reason })),
				]);
				if (outcome.kind === "cancelled") {
					control = outcome.kind;
					await abortChildSession(childSession);
					result = {
						...base,
						status: "cancelled",
						observedOutputBytes,
						summary: "Writer cancelled.",
						diagnostics: [{ code: "cancellation", message: "Writer cancelled." }],
					};
				} else if (outcome.kind === "error") {
					throw outcome.error;
				} else {
					const rawOutput = extractAssistantText(childSession.messages);
					const output =
						rawOutput.length > 0
							? this.outputArtifacts.capture({ ownerSessionId: request.parentSessionId, text: rawOutput })
							: undefined;
					const usage = (() => {
						try {
							const stats = childSession!.getSessionStats();
							return {
								inputTokens: stats.tokens.input,
								outputTokens: stats.tokens.output,
								cacheReadTokens: stats.tokens.cacheRead,
								cacheWriteTokens: stats.tokens.cacheWrite,
								cost: stats.cost,
							} satisfies SubagentUsage;
						} catch {
							return undefined;
						}
					})();
					if (!directWorkspace) {
						emit("collecting_artifact", "running");
						patchArtifact = collectWriterPatchArtifact(
							workspace,
							{ runId, status: "completed", baseCommit: request.baseCommit },
							{ scopeRoots: isolatedRequest.scope.roots, artifactRoot: this.artifactRoot },
						);
					}
					result = {
						...base,
						status: "completed",
						summary: output?.text || "Writer completed.",
						observedOutputBytes: output?.originalBytes ?? Buffer.byteLength(rawOutput),
						diagnostics: [
							...(directWorkspace
								? [
										{
											code: "unsafe_parent_workspace" as const,
											message: "YOLO writer mutated the parent workspace directly.",
										},
									]
								: []),
							...(output?.captureStatus === "artifact_truncated"
								? [
										{
											code: "output_artifact_truncated" as const,
											message: "The stored writer final answer was truncated.",
										},
									]
								: output?.captureStatus === "artifact_unavailable"
									? [
											{
												code: "output_artifact_unavailable" as const,
												message: "The writer final answer could not be fully retained.",
											},
										]
									: []),
						],
						...(output ? { output } : {}),
						...(patchArtifact ? { patchArtifact } : {}),
						...(usage ? { usage } : {}),
					};
				}
			}
		} catch (error) {
			const failure =
				error instanceof SubagentError
					? error
					: new SubagentError(
							childSession ? "child_runtime_failure" : "child_startup_failure",
							error instanceof Error ? error.message : String(error),
						);
			result = {
				...base,
				status: control === "cancelled" ? "cancelled" : "failed",
				observedOutputBytes,
				summary: truncateSubagentOutput(failure.message, SUBAGENT_OUTPUT_ARTIFACT_LIMITS.inlineBytes).text,
				diagnostics: [{ code: failure.code, message: failure.message }],
			};
		} finally {
			removeAbortListener?.();
			unsubscribeChild?.();
			try {
				if (childSession) await shutdownChildSession(childSession);
			} catch (error) {
				if (patchArtifact) rmSync(dirname(patchArtifact.patchRef), { recursive: true, force: true });
				patchArtifact = undefined;
				const message = error instanceof Error ? error.message : String(error);
				result = {
					...result,
					status: "failed",
					patchArtifact: undefined,
					diagnostics: [...result.diagnostics, { code: "child_runtime_failure", message }],
				};
			}
			if (workspace && !directWorkspace) {
				emit("cleanup", result.status, {
					artifactReady: patchArtifact !== undefined,
					...(patchArtifact ? { changedFileCount: patchArtifact.files.length } : {}),
				});
				try {
					await workspace.cleanup();
					result = { ...result, workspaceRemoved: true, ...(patchArtifact ? { patchArtifact } : {}) };
				} catch (error) {
					if (patchArtifact) rmSync(dirname(patchArtifact.patchRef), { recursive: true, force: true });
					patchArtifact = undefined;
					const message = error instanceof Error ? error.message : String(error);
					result = {
						...result,
						status: "failed",
						patchArtifact: undefined,
						diagnostics: [...result.diagnostics, { code: "writer_workspace_failure", message }],
					};
				}
			} else if (directWorkspace) {
				emit("cleanup", result.status, { diagnostics: ["unsafe_parent_workspace"] });
			}
		}
		emit(
			result.patchArtifact
				? "proposal_ready"
				: result.status === "completed"
					? "completed"
					: result.status === "cancelled"
						? "cancelled"
						: result.status === "timed_out"
							? "timed_out"
							: "failed",
			result.status,
			{
				artifactReady: result.patchArtifact !== undefined,
				...(result.patchArtifact
					? { changedFileCount: result.patchArtifact.files.length, artifactStatus: "ready" }
					: {}),
				...(result.diagnostics.length > 0
					? { diagnostics: result.diagnostics.map((diagnostic) => diagnostic.code) }
					: {}),
			},
		);
		return result;
	}
}
