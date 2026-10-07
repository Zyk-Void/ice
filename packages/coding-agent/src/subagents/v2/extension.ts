/**
 * Subagent V2 extension (Plan/subagent-rewrite.md section 12, P6.0-P6.6).
 *
 * Loaded instead of the legacy extension when `ice.subagents.v2` or
 * ICE_SUBAGENTS_V2=1 is set, so the model never sees both tool sets. Registers
 * `agent`, `agent_control`, and `agent_patch` (worktree children). The callable agent list reaches the model as a cache-stable delta
 * message before each agent run.
 */

import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/extensions/index.ts";
import { truncateHead } from "../../core/tools/truncate.ts";
import { parseVerifierArgv, runVerifier } from "../../ice-safe-verify.ts";
import { redactCredentialText } from "../../utils/redact.ts";
import { type AgentToolParameters, AgentToolParametersSchema } from "../api/agent.ts";
import type { AgentControlParameters } from "../api/agent-control.ts";
import { AgentControlParametersSchema } from "../api/agent-control.ts";
import { type AgentPatchParameters, AgentPatchParametersSchema } from "../api/agent-patch.ts";
import { getSubagentGlobalAgentsDir } from "../definitions/legacy-profiles.ts";
import {
	AGENT_LISTING_CUSTOM_TYPE,
	type AgentListingState,
	computeAgentListingDelta,
	renderAgentListingMessage,
} from "../definitions/listing.ts";
import { authorizeUnsafeSubagentHostExecution, flagEnabled, type IceSubagentsOptions } from "../extension-support.ts";
import type { ApprovalAnswer } from "../permissions/approval.ts";
import { renderSubagentAssuranceSection } from "../results/assurance.ts";
import { renderBatchSynthesisSection, summarizeV2BatchSynthesis } from "../results/batch-synthesis.ts";
import { isSubagentOutputArtifactRef } from "../results/output-artifacts.ts";
import { getIceDelegableTools } from "../tools/adapters.ts";
import { SUBAGENT_PRESENTATION_LIMIT_BYTES } from "../types.ts";
import { type ChildTurnResult, SubagentV2Runtime } from "./runtime.ts";
import { resolveSubagentsV2Settings } from "./settings.ts";

const AGENT_TOOL_DESCRIPTION =
	"Launch subagents: independent child sessions that work in their own context window and return a final report. " +
	"Each task names an agent from the agent list (default `general`), a short description, and a self-contained prompt: the child cannot see this conversation, so include the goal, relevant paths and facts, constraints, and the expected result. " +
	"Prefer doing small sequential work yourself; delegate independent parallel work, work that benefits from a separate context window, or work suited to a specialist agent. " +
	"Up to 8 tasks run concurrently. By default the call waits and returns each child's report; multi-task foreground calls also include bounded deterministic counts, evidence overlap, and possible disagreements from checked child results. This is bookkeeping, not semantic consensus or verification. With background=true it returns child IDs at once and each completion arrives independently as a follow-up message. Large final answers expose bounded offset/length reads through agent_control action=output. " +
	"To continue a child, pass resume=<id> with a new prompt. After budget_exhausted, also supply an explicit maxTurns/maxTokens/timeoutMs within the frozen ceiling to renew the task budget. Child permissions never exceed yours; edits and shell commands may require approval.";

const AGENT_PATCH_DESCRIPTION =
	"Review the changes of a subagent that ran with isolation=worktree. inspect shows the files and diff it changed relative to your workspace at spawn time (your pre-existing uncommitted work is excluded). apply merges those changes into your working tree without touching the git index; it writes nothing if your workspace changed in a conflicting way. reject discards them. Both apply and reject remove the child's worktree.";
const PATCH_PREVIEW_LIMIT = 48 * 1024;

const AGENT_CONTROL_DESCRIPTION =
	"Manage subagents by ID: status, list, wait (until idle or timeout), output (latest bounded report; supply offset and optional length to read a retained large final-answer artifact in chunks), send (message: note for the running or next turn; followup: start a new turn; interrupt: cancel the current turn then follow up), resume (revive a parked child), stop (cancel the current turn, keep the child), delete (remove a stopped child), agents (definition diagnostics). Output reads are owner-scoped, redacted, and bounded to 48 KiB; continue at the returned nextOffset.";

function text(value: string, details?: unknown) {
	const projection = truncateHead(redactCredentialText(value), {
		maxBytes: SUBAGENT_PRESENTATION_LIMIT_BYTES - 256,
		maxLines: 2000,
	});
	const content = `${projection.content}${projection.truncated ? "\n[Presentation truncated; inspect individual children with agent_control action=output.]" : ""}`;
	return { content: [{ type: "text" as const, text: content }], details };
}

function formatTurn(result: ChildTurnResult): string {
	const header = `## ${result.agent} (${result.id}): ${result.outcome}`;
	const error = result.error ? `\nError: ${result.error}` : "";
	const assurance = result.validation
		? `\n\n${renderSubagentAssuranceSection(result.validation.assurance, {})}\n${result.validation.reason}`
		: "";
	const output = result.output;
	const artifact = output?.artifact && isSubagentOutputArtifactRef(output.artifact) ? output.artifact : undefined;
	const artifactNotice = artifact
		? `\n\nFull final answer retained as artifact ${artifact.id} (${artifact.storedBytes} bytes${artifact.truncated ? ", truncated at the host storage limit" : ""}). Read with agent_control action=output id=${result.id} offset=<byte-offset> [length=<bytes>].`
		: output?.captureStatus === "artifact_unavailable"
			? "\n\n[The full final answer exceeded inline storage limits; artifact capture was unavailable.]"
			: "";
	const truncation =
		result.truncated && !artifact && output?.captureStatus !== "artifact_unavailable"
			? "\n\n[Report truncated; the original remains in the child transcript.]"
			: "";
	return `${header}${error}\n\n${result.text || "(no final message)"}${assurance}${artifactNotice}${truncation}`;
}

/** Last listing state shown in the current branch, or undefined when a full re-list is needed. */
function listingStateFromBranch(ctx: ExtensionContext): AgentListingState | undefined {
	let state: AgentListingState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction") state = undefined;
		else if (entry.type === "custom_message" && entry.customType === AGENT_LISTING_CUSTOM_TYPE) {
			const details = entry.details as { state?: Array<[string, string]> } | undefined;
			if (details?.state) state = new Map(details.state);
		}
	}
	return state;
}

export function isSubagentsV2Selected(globalSettings: { ice?: unknown } | undefined, env: string | undefined): boolean {
	if (env === "1" || env === "true") return true;
	const ice = globalSettings?.ice as { subagents?: { v2?: unknown } } | undefined;
	return ice?.subagents?.v2 === true;
}

export default function iceSubagentsV2(ice: ExtensionAPI, options: IceSubagentsOptions = {}): void {
	if (typeof ice.registerFlag === "function") {
		ice.registerFlag("sub-yolo", {
			description:
				"Let subagents run edits and shell commands the trusted build parent may run, without per-call approval; this is not a sandbox",
			type: "boolean",
		});
	}
	let latestCtx: ExtensionContext | undefined;
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsFor = (ctx: ExtensionContext | undefined) => {
		const manager = ctx?.settingsManager;
		const trusted = ctx?.isProjectTrusted?.() ?? false;
		return resolveSubagentsV2Settings({
			global: (manager?.getGlobalSettings() as { ice?: { subagents?: unknown } } | undefined)?.ice?.subagents,
			project: (manager?.getProjectSettings() as { ice?: { subagents?: unknown } } | undefined)?.ice?.subagents,
			projectTrusted: trusted,
			env: process.env.ICE_SUBAGENTS_V2,
		});
	};
	const runtime = new SubagentV2Runtime({
		getParentSession: () => options.agentViewBridge?.getParentSession(),
		agentDir,
		userAgentsDir: getSubagentGlobalAgentsDir(options.agentDir),
		getSettings: () => settingsFor(latestCtx),
		isProjectTrusted: () => latestCtx?.isProjectTrusted?.() ?? false,
		getParentMode: () => (options.getIceMode?.() === "build" ? "build" : "plan"),
		isSubYolo: () => {
			if (!latestCtx || !flagEnabled(ice, "sub-yolo")) return false;
			try {
				return authorizeUnsafeSubagentHostExecution(latestCtx, options, true) !== undefined;
			} catch {
				return false;
			}
		},
		getAdapters: () => getIceDelegableTools(ice.events),
		getPatchVerifier: () => {
			const argv = parseVerifierArgv(ice.getFlag("ice-verify"));
			return argv ? (root, signal) => runVerifier(argv, root, { signal }) : undefined;
		},
		promptApproval: async (request, signal) => {
			const ctx = latestCtx;
			if (!ctx?.hasUI) return "deny";
			const choices: Array<[string, ApprovalAnswer]> = [
				["Allow once", "allow-once"],
				...(request.sessionRule
					? ([[`Always allow ${request.sessionRule} for this subagent`, "allow-session"]] as Array<
							[string, ApprovalAnswer]
						>)
					: []),
				["Deny", "deny"],
			];
			const picked = await ctx.ui.select(
				`Subagent ${request.agent} wants to run ${request.summary}`,
				choices.map(([label]) => label),
				{ signal },
			);
			return choices.find(([label]) => label === picked)?.[1] ?? "deny";
		},
	});

	ice.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		runtime.invalidateDefinitions();
	});
	ice.on("before_agent_start", async (_event, ctx) => {
		latestCtx = ctx;
		try {
			const delta = computeAgentListingDelta(listingStateFromBranch(ctx), runtime.callableAgents());
			const content = renderAgentListingMessage(delta);
			if (!content) return undefined;
			return {
				message: {
					customType: AGENT_LISTING_CUSTOM_TYPE,
					content,
					display: false,
					details: { state: [...delta.next] },
				},
			};
		} catch {
			return undefined;
		}
	});
	ice.on("agent_settled", async () => {
		try {
			runtime.flushCompletions();
		} catch {
			// No parent session yet.
		}
	});
	ice.on("session_shutdown", async () => {
		await runtime.shutdown();
	});

	const agentTool: ToolDefinition<typeof AgentToolParametersSchema> = {
		name: "agent",
		label: "agent",
		description: AGENT_TOOL_DESCRIPTION,
		promptSnippet: "Launch or continue subagents",
		parameters: AgentToolParametersSchema,
		execute: async (_toolCallId, params: AgentToolParameters, signal, _onUpdate, ctx) => {
			latestCtx = ctx;
			const background = params.background === true;
			for (const task of params.tasks) {
				if (task.resume && task.outputSchema)
					return text("A resumed task keeps its frozen outputSchema; remove that field.");
				if (task.resume && task.agent) return text("A task cannot set both resume and agent.");
				if (task.resume && (task.model || task.thinking || task.isolation || task.scope))
					return text(
						"A resumed task keeps its frozen model, thinking, isolation, and scope; remove those fields.",
					);
			}
			const fresh = params.tasks.filter((task) => !task.resume);
			const prompts = new Map<string, string>();
			const order: string[] = [];
			try {
				const records = await runtime.launch(fresh);
				records.forEach((record, index) => {
					const task = fresh[index]!;
					prompts.set(record.id, task.prompt);
				});
				let freshIndex = 0;
				for (const task of params.tasks) order.push(task.resume ?? records[freshIndex++]!.id);
			} catch (error) {
				return text(`Could not launch: ${error instanceof Error ? error.message : String(error)}`);
			}
			const admissions: Promise<boolean>[] = [];
			const runs = order.map((id, index) => {
				let acknowledge!: (started: boolean) => void;
				admissions.push(
					new Promise<boolean>((resolve) => {
						acknowledge = resolve;
					}),
				);
				const accepted = background ? { accepted: () => acknowledge(true) } : signal ? { signal } : {};
				const task = params.tasks[index]!;
				const budgets =
					task.maxTurns !== undefined || task.maxTokens !== undefined || task.timeoutMs !== undefined
						? {
								...(task.maxTurns !== undefined ? { maxTurns: task.maxTurns } : {}),
								...(task.maxTokens !== undefined ? { maxTokens: task.maxTokens } : {}),
								...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
							}
						: undefined;
				const run = task.resume
					? runtime.continueChild(id, task.prompt, {
							foreground: !background,
							budgets,
							...(task.acceptance ? { acceptance: task.acceptance } : {}),
							...accepted,
						})
					: runtime.runTurn(id, prompts.get(id)!, { foreground: !background, background, ...accepted });
				return run.catch((error): ChildTurnResult => {
					acknowledge(false);
					return {
						id,
						agent: task.agent ?? "unknown",
						outcome: "failed",
						text: "",
						truncated: false,
						usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
						error: error instanceof Error ? error.message : String(error),
					};
				});
			});
			if (background) {
				const started = await Promise.all(admissions);
				const ids = order.filter((_id, index) => started[index]);
				const rejected = await Promise.all(runs.filter((_run, index) => !started[index]));
				return text(
					`${ids.length ? `Started ${ids.length} subagent${ids.length === 1 ? "" : "s"} in the background: ${ids.join(", ")}. Each completion arrives as a follow-up message.` : "No subagents started."}${rejected.length ? `\n\nCould not start:\n${rejected.map(formatTurn).join("\n\n")}` : ""}`,
					{ ids, rejected: rejected.map(({ text: _text, ...rest }) => rest) },
				);
			}
			const abort = () => {
				for (const id of order) void runtime.stop(id);
			};
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			try {
				const results = await Promise.all(runs);
				const synthesis = results.length > 1 ? summarizeV2BatchSynthesis(results) : undefined;
				return text(
					[
						...(synthesis
							? [
									renderBatchSynthesisSection(synthesis),
									"Criterion coverage summarizes report-claim/evidence consistency only; it is not semantic verification or independent review approval.",
								]
							: []),
						...results.map(formatTurn),
					].join("\n\n"),
					{
						results: results.map(({ text: _text, ...rest }) => rest),
						...(synthesis ? { batchSynthesis: synthesis } : {}),
					},
				);
			} finally {
				signal?.removeEventListener("abort", abort);
			}
		},
	};

	const controlTool: ToolDefinition<typeof AgentControlParametersSchema> = {
		name: "agent_control",
		label: "agent_control",
		description: AGENT_CONTROL_DESCRIPTION,
		promptSnippet: "Inspect, message, wait for, stop, or delete subagents",
		parameters: AgentControlParametersSchema,
		execute: async (_toolCallId, params: AgentControlParameters, signal, _onUpdate, ctx) => {
			latestCtx = ctx;
			const ids = params.ids ?? (params.id ? [params.id] : []);
			const needId = () => {
				if (ids.length === 0) throw new Error(`action=${params.action} needs id or ids.`);
				return ids;
			};
			try {
				const owner = runtime.ownerSessionId();
				const registry = runtime.registry;
				switch (params.action) {
					case "list": {
						const records = registry.list(owner);
						if (records.length === 0) return text("No subagents in this session.");
						return text(
							records
								.map(
									(record) =>
										`${record.id}  ${record.agent}  ${record.state}${record.lastTurnOutcome ? ` (last turn: ${record.lastTurnOutcome})` : ""}  ${record.description}`,
								)
								.join("\n"),
						);
					}
					case "status": {
						return text(
							needId()
								.map((id) => {
									const record = registry.get(owner, id);
									const blocked = record.blockedReasons?.length
										? `\nBlocked: ${record.blockedReasons.join("; ")}`
										: "";
									return `${record.id} ${record.agent}: ${record.state}, turns ${record.usage.turns}, tokens ${record.usage.inputTokens + record.usage.outputTokens + (record.usage.cacheReadTokens ?? 0) + (record.usage.cacheWriteTokens ?? 0)}${record.lastTurnOutcome ? `, last turn ${record.lastTurnOutcome}` : ""}${blocked}`;
								})
								.join("\n"),
						);
					}
					case "wait": {
						const result = await registry.waitFor(
							owner,
							needId(),
							(record) => !record.turnInFlight && record.state !== "running" && record.state !== "starting",
							params.timeoutMs ?? 60_000,
							signal,
						);
						return text(
							`${result.timedOut ? "Wait ended before every child settled." : "All children settled."}\n${result.records.map((record) => `${record.id}: ${record.state}${record.lastTurnOutcome ? ` (${record.lastTurnOutcome})` : ""}`).join("\n")}`,
						);
					}
					case "output": {
						const requestedIds = needId();
						if ((params.offset !== undefined || params.length !== undefined) && requestedIds.length !== 1)
							return text("Range reads require exactly one child ID.");
						return text(
							requestedIds
								.map((id) => {
									if (params.offset !== undefined || params.length !== undefined) {
										const chunk = runtime.readOutput(id, {
											...(params.offset !== undefined ? { offset: params.offset } : {}),
											...(params.length !== undefined ? { length: params.length } : {}),
										});
										return `Artifact ${chunk.artifactId} · bytes ${chunk.offset}-${chunk.nextOffset}/${chunk.totalBytes} · nextOffset=${chunk.nextOffset} · eof=${chunk.eof} · ${chunk.contentType} · sha256=${chunk.sha256} · truncated=${chunk.truncated}\n\n${chunk.text}`;
									}
									const result = runtime.outputOf(id);
									return result ? formatTurn(result) : `${id}: no final message yet.`;
								})
								.join("\n\n"),
						);
					}
					case "send": {
						if (!params.message) return text("action=send needs message.");
						const [id] = needId();
						return text(await runtime.send(id!, params.message, params.delivery ?? "followup"));
					}
					case "resume": {
						for (const id of needId()) await runtime.revive(id);
						return text(`Resumed ${ids.join(", ")}.`);
					}
					case "stop": {
						for (const id of needId()) await runtime.stop(id);
						return text(`Stopped the current turn of ${ids.join(", ")}; the child sessions are kept.`);
					}
					case "delete": {
						for (const id of needId()) await runtime.delete(id);
						return text(`Deleted ${ids.join(", ")}.`);
					}
					case "agents": {
						const definitions = runtime.definitions();
						const lines = [...definitions.active.values()].map(
							(definition) =>
								`${definition.name} [${definition.source}${definition.limited ? ", limited" : ""}${definition.fields.hidden ? ", hidden" : ""}]: ${definition.description}${definition.diagnostics.length ? ` (${definition.diagnostics.join("; ")})` : ""}`,
						);
						for (const entry of definitions.shadowed)
							lines.push(
								`${entry.definition.name} [${entry.definition.source}] shadowed by ${entry.shadowedBy.source}`,
							);
						for (const definition of definitions.disabled) lines.push(`${definition.name} [disabled]`);
						for (const issue of definitions.issues)
							lines.push(
								`${issue.name ?? "(unnamed)"} [${issue.availability}] ${issue.sourcePath ?? ""}: ${issue.diagnostics.join("; ")}`,
							);
						return text(lines.join("\n"));
					}
				}
			} catch (error) {
				return text(
					`agent_control ${params.action} failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	};

	const patchTool: ToolDefinition<typeof AgentPatchParametersSchema> = {
		name: "agent_patch",
		label: "agent_patch",
		description: AGENT_PATCH_DESCRIPTION,
		promptSnippet: "Inspect, apply, or reject a worktree subagent's changes",
		parameters: AgentPatchParametersSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, params: AgentPatchParameters, signal, _onUpdate, ctx) => {
			latestCtx = ctx;
			try {
				if (params.action === "inspect") {
					const inspection = runtime.inspectPatch(params.id);
					if (!inspection.delta)
						return text(
							`Patch of ${params.id} is ${inspection.state}.${inspection.recoveryRef ? ` Recovery data: ${inspection.recoveryRef}` : ""}`,
							{
								status: inspection.state,
								artifactRef: inspection.artifactRef,
								recoveryRef: inspection.recoveryRef,
							},
						);
					const { delta } = inspection;
					if (delta.empty) return text(`Child ${params.id} made no changes.`, { status: "empty" });
					const preview = truncateHead(redactCredentialText(delta.patch), {
						maxBytes: PATCH_PREVIEW_LIMIT,
						maxLines: 2000,
					});
					const bounded = `${preview.content}${preview.truncated ? "\n[patch preview truncated]" : ""}`;
					return text(
						`Changed paths (relative to the parent's state at spawn, so pre-existing WIP is excluded):\n${delta.changedPaths.map((entry) => `${entry.status} ${entry.path}`).join("\n")}\n\n${bounded}${delta.patchTruncated ? "\n[patch exceeds the stored limit]" : ""}`,
						{ status: "open", changedPaths: delta.changedPaths, artifactRef: inspection.artifactRef },
					);
				}
				if (params.action === "apply") {
					const outcome = await runtime.applyPatch(params.id, signal);
					switch (outcome.status) {
						case "applied":
							return text(
								`Applied and verified the patch of ${params.id}: ${outcome.writtenPaths.join(", ")}. The parent index was not changed.${outcome.cleanupError ? ` Cleanup needs inspection: ${outcome.cleanupError}` : ""}`,
								outcome,
							);
						case "empty":
							return text(`Child ${params.id} made no changes; its worktree was removed.`, outcome);
						case "already":
							return text(`The patch of ${params.id} was already ${outcome.patchState}.`, outcome);
						case "conflict":
							return text(
								`The patch of ${params.id} conflicts with changes made in the parent since the child started. Nothing was written.\n${outcome.details}`,
								outcome,
							);
						case "changed_during_apply":
							return text(
								`${outcome.path} changed while applying; nothing was written. Retry when the workspace is stable.`,
								outcome,
							);
						case "verification_failed":
							return text(`Patch apply failed and its changes were rolled back: ${outcome.details}`, outcome);
						case "rollback_conflict":
							return text(
								`Patch apply failed. Newer or unknown state was preserved at ${outcome.paths.join(", ")}; inspect the parent and retained recovery data before proceeding. ${outcome.details}`,
								outcome,
							);
					}
				}
				const rejected = runtime.rejectPatch(params.id);
				return text(
					rejected.status === "rejected"
						? `Rejected the patch of ${params.id} and removed its worktree.`
						: `The patch of ${params.id} was already ${rejected.patchState}.`,
					rejected,
				);
			} catch (error) {
				return text(
					`agent_patch ${params.action} failed: ${error instanceof Error ? error.message : String(error)}`,
					{ status: "error" },
				);
			}
		},
	};

	ice.registerTool(agentTool as unknown as ToolDefinition);
	ice.registerTool(controlTool as unknown as ToolDefinition);
	ice.registerTool(patchTool as unknown as ToolDefinition);
}
