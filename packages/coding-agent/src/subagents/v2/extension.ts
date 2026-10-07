/**
 * Subagent V2 extension (Plan/subagent-rewrite.md section 12, P6.0-P6.6).
 *
 * Loaded instead of the legacy extension when `ice.subagents.v2` or
 * ICE_SUBAGENTS_V2=1 is set, so the model never sees both tool sets. Registers
 * `agent` and `agent_control`; `agent_patch` arrives with worktree isolation
 * (Phase 7). The callable agent list reaches the model as a cache-stable delta
 * message before each agent run.
 */

import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/extensions/index.ts";
import { type AgentToolParameters, AgentToolParametersSchema } from "../api/agent.ts";
import type { AgentControlParameters } from "../api/agent-control.ts";
import { AgentControlParametersSchema } from "../api/agent-control.ts";
import { getSubagentGlobalAgentsDir } from "../definitions/legacy-profiles.ts";
import {
	AGENT_LISTING_CUSTOM_TYPE,
	type AgentListingState,
	computeAgentListingDelta,
	renderAgentListingMessage,
} from "../definitions/listing.ts";
import { authorizeUnsafeSubagentHostExecution, flagEnabled, type IceSubagentsOptions } from "../extension-support.ts";
import type { ApprovalAnswer } from "../permissions/approval.ts";
import { getIceDelegableTools } from "../tools/adapters.ts";
import { type ChildTurnResult, SubagentV2Runtime } from "./runtime.ts";
import { resolveSubagentsV2Settings } from "./settings.ts";

const AGENT_TOOL_DESCRIPTION =
	"Launch subagents: independent child sessions that work in their own context window and return a final report. " +
	"Each task names an agent from the agent list (default `general`), a short description, and a self-contained prompt: the child cannot see this conversation, so include the goal, relevant paths and facts, constraints, and the expected result. " +
	"Prefer doing small sequential work yourself; delegate independent parallel work, work that benefits from a separate context window, or work suited to a specialist agent. " +
	"Up to 8 tasks run concurrently. By default the call waits and returns each child's report. With background=true it returns child IDs at once and each completion arrives later as a follow-up message. " +
	"To continue a child, pass resume=<id> with a new prompt. Child permissions never exceed yours; edits and shell commands may require approval.";

const AGENT_CONTROL_DESCRIPTION =
	"Manage subagents by ID: status, list, wait (until idle or timeout), output (latest full report), send (message: note for the running or next turn; followup: start a new turn; interrupt: cancel the current turn then follow up), resume (revive a parked child), stop (cancel the current turn, keep the child), delete (remove a stopped child), agents (definition diagnostics).";

function text(value: string, details?: unknown) {
	return { content: [{ type: "text" as const, text: value }], details };
}

function formatTurn(result: ChildTurnResult): string {
	const header = `## ${result.agent} (${result.id}): ${result.outcome}`;
	const error = result.error ? `\nError: ${result.error}` : "";
	return `${header}${error}\n\n${result.text || "(no final message)"}${result.truncated ? "\n\n[Report truncated; use agent_control action=output for the stored result.]" : ""}`;
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
		getParentMode: () => (options.getIceMode?.() === "plan" ? "plan" : "build"),
		isSubYolo: () => {
			if (!latestCtx || !flagEnabled(ice, "sub-yolo")) return false;
			try {
				return authorizeUnsafeSubagentHostExecution(latestCtx, options, true) !== undefined;
			} catch {
				return false;
			}
		},
		getAdapters: () => getIceDelegableTools(ice.events),
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
					const acceptance = task.acceptance?.length
						? `\n\nAcceptance criteria:\n${task.acceptance.map((item) => `- ${item}`).join("\n")}`
						: "";
					prompts.set(record.id, `${task.prompt}${acceptance}`);
				});
				let freshIndex = 0;
				for (const task of params.tasks) order.push(task.resume ?? records[freshIndex++]!.id);
			} catch (error) {
				return text(`Could not launch: ${error instanceof Error ? error.message : String(error)}`);
			}
			const runs = order.map((id, index) => {
				const task = params.tasks[index]!;
				const run = task.resume
					? runtime.continueChild(id, task.prompt, { foreground: !background })
					: runtime.runTurn(id, prompts.get(id)!, { foreground: !background, background });
				return run.catch(
					(error): ChildTurnResult => ({
						id,
						agent: task.agent ?? "unknown",
						outcome: "failed",
						text: "",
						truncated: false,
						usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			});
			if (background) {
				return text(
					`Started ${order.length} subagent${order.length === 1 ? "" : "s"} in the background: ${order.join(", ")}. Each completion arrives as a follow-up message.`,
					{ ids: order },
				);
			}
			const abort = () => {
				for (const id of order) void runtime.stop(id);
			};
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const results = await Promise.all(runs);
				return text(results.map(formatTurn).join("\n\n"), {
					results: results.map(({ text: _text, ...rest }) => rest),
				});
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
									return `${record.id} ${record.agent}: ${record.state}, turns ${record.usage.turns}, tokens ${record.usage.inputTokens + record.usage.outputTokens}${record.lastTurnOutcome ? `, last turn ${record.lastTurnOutcome}` : ""}${blocked}`;
								})
								.join("\n"),
						);
					}
					case "wait": {
						const result = await registry.waitFor(
							owner,
							needId(),
							(record) => record.state !== "running" && record.state !== "starting",
							params.timeoutMs ?? 60_000,
							signal,
						);
						return text(
							`${result.timedOut ? "Wait ended before every child settled." : "All children settled."}\n${result.records.map((record) => `${record.id}: ${record.state}${record.lastTurnOutcome ? ` (${record.lastTurnOutcome})` : ""}`).join("\n")}`,
						);
					}
					case "output": {
						return text(
							needId()
								.map((id) => {
									const output = runtime.outputOf(id);
									return output ? formatTurn(output) : `${id}: no final message yet.`;
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

	ice.registerTool(agentTool as unknown as ToolDefinition);
	ice.registerTool(controlTool as unknown as ToolDefinition);
}
