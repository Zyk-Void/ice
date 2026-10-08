/**
 * Subagent V2 extension (Plan/subagent-rewrite.md section 12, P6.0-P6.6).
 *
 * The ICE subagent extension. Registers
 * `agent`, `agent_control`, and `agent_patch` (worktree children). The callable agent list reaches the model as a cache-stable delta
 * message before each agent run.
 */

import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "../../core/extensions/index.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { truncateHead } from "../../core/tools/truncate.ts";
import type {
	IceAgentViewLiveSession,
	IceAgentViewLiveSessionControl,
	IceAgentViewLiveSessionSource,
} from "../../ice-agent-view-bridge.ts";
import { parseVerifierArgv, runVerifier } from "../../ice-safe-verify.ts";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
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
import {
	appendSubagentHookJournal,
	authorizeUnsafeSubagentHostExecution,
	buildSubagentHookRuntime,
	flagEnabled,
	type IceSubagentsOptions,
} from "../extension-support.ts";
import type { ApprovalAnswer } from "../permissions/approval.ts";
import type { ChildRecord } from "../registry/registry.ts";
import { renderSubagentAssuranceSection } from "../results/assurance.ts";
import { renderBatchSynthesisSection, summarizeV2BatchSynthesis } from "../results/batch-synthesis.ts";
import { isSubagentOutputArtifactRef } from "../results/output-artifacts.ts";
import { createSubagentLiveSessionControl } from "../runtime/live-session.ts";
import { getIceDelegableTools } from "../tools/adapters.ts";
import { parentMcpAdapters, SUBAGENT_PRESENTATION_LIMIT_BYTES } from "../types.ts";
import { AgentHubView, formatTokens, type HubSource, statusMark } from "../ui/hub.ts";
import { createAgentDefinitionFile, formatAgentDefinitions } from "./agent-manager.ts";
import { completionEvent, lifecycleEvents, SUBAGENT_EVENT_CHANNEL } from "./events.ts";
import { SubagentV2Runtime } from "./runtime.ts";
import { type ChildTurnResult, mcpDelegableTools, withContextPacket } from "./runtime-support.ts";
import { resolveSubagentsV2Settings } from "./settings.ts";

const AGENT_TOOL_DESCRIPTION =
	"Launch subagents: independent child sessions with their own context window that return a final report. " +
	"Each task names an agent from the agent list (default `general`), a 3-5 word description, and a self-contained prompt. " +
	"Up to 8 tasks per call; they run concurrently up to the configured limit and the rest queue. By default the call waits and returns each report; multi-task calls also include bounded deterministic counts, evidence overlap, and possible disagreements from checked results (bookkeeping, not verification). With background=true it returns child IDs at once and each completion arrives later as a message. Large final answers are read in chunks with agent_control action=output. " +
	"Continue a child with resume=<id> and a new prompt; it keeps its context. After budget_exhausted, also supply an explicit maxTurns/maxTokens/timeoutMs within the frozen ceiling. Child permissions never exceed yours; edits and shell commands may require approval. Subagents cannot launch subagents of their own.";

/** How to delegate well; rendered into the system prompt while the `agent` tool is active. */
const AGENT_TOOL_GUIDELINES = [
	"Delegate independent, context-heavy, or parallel work to subagents. Read a known file, look up a specific symbol, or search 2-3 known files yourself; delegating those is slower.",
	"A new subagent has not seen this conversation. Brief it fully: the goal and why it matters, what you already know or ruled out, exact paths and lines, whether to change code or only research, and the report you expect (with a length limit when short is enough).",
	'Do not delegate understanding. Never write "based on your findings, fix it": synthesize results yourself, then give the next subagent a concrete instruction.',
	"Launch independent tasks in one agent call so they run in parallel. Use background=true only when you have other work to do meanwhile.",
	"Background results arrive as messages. Do not poll on your own (repeated agent_control status or wait, or sleep in a loop); continue other work or end your turn. When the user asks about subagents, check once with agent_control action=list or status and report what it shows. Never guess a running subagent's findings.",
	"Subagent reports are not shown to the user. Summarize what matters in your reply.",
	"Every subagent gets a unique name: the one you give (for example auth-review) or an automatic one shown in the result. resume, agent_control, and agent_patch accept the name or the ID. Continue a subagent with resume=<name or id> when its context helps the follow-up. Delete a subagent you will not need again with agent_control action=delete. Finished subagents leave memory after 30 seconds but stay listed and resumable until deleted.",
];

const AGENT_PATCH_DESCRIPTION =
	"Review the changes of a subagent that ran with isolation=worktree. inspect shows the files and diff it changed relative to your workspace at spawn time (your pre-existing uncommitted work is excluded). apply merges those changes into your working tree without touching the git index; it writes nothing if your workspace changed in a conflicting way. reject discards them. Both apply and reject remove the child's worktree.";
const PATCH_PREVIEW_LIMIT = 48 * 1024;
/** How often agent_control wait checks for a user message that should end it. */
const WAIT_MESSAGE_POLL_MS = 250;

const AGENT_CONTROL_DESCRIPTION =
	"Manage subagents by name or ID. When the user asks how subagents are doing, check with list or status. Actions: status, list, wait (block once until the children settle or the timeout; background completions arrive as messages, so do not wait repeatedly), output (latest bounded report; supply offset and optional length to read a retained large final-answer artifact in chunks), send (message: note for the running or next turn; followup: start a new turn; interrupt: cancel the current turn then follow up), resume (revive a parked child), stop (cancel the current turn, keep the child), delete (stop it if running, then remove it; use when its work is done and you will not resume it), agents (definition diagnostics). Output reads are owner-scoped, redacted, and bounded to 48 KiB; continue at the returned nextOffset.";

function text(value: string, details?: unknown) {
	const projection = truncateHead(redactCredentialText(value), {
		maxBytes: SUBAGENT_PRESENTATION_LIMIT_BYTES - 256,
		maxLines: 2000,
	});
	const content = `${projection.content}${projection.truncated ? "\n[Presentation truncated; inspect individual children with agent_control action=output.]" : ""}`;
	return { content: [{ type: "text" as const, text: content }], details };
}

function formatTurn(result: ChildTurnResult, name?: string): string {
	const header = `## ${result.agent}${name ? ` "${name}"` : ""} (${result.id}): ${result.outcome}`;
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

/**
 * Last listing state shown in the current branch (undefined when a full re-list is needed), and whether a
 * compaction removed the child roster from context since it was last shown.
 */
function listingStateFromBranch(ctx: ExtensionContext): { state: AgentListingState | undefined; compacted: boolean } {
	let state: AgentListingState | undefined;
	let compacted = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction") {
			state = undefined;
			compacted = true;
		} else if (entry.type === "custom_message" && entry.customType === AGENT_LISTING_CUSTOM_TYPE) {
			const details = entry.details as { state?: Array<[string, string]>; roster?: boolean } | undefined;
			if (details?.state) state = new Map(details.state);
			if (details?.roster) compacted = false;
		}
	}
	return { state, compacted };
}

const ROSTER_LIMIT = 20;
/** How often a foreground agent call refreshes its live child rows. */
const PROGRESS_INTERVAL_MS = 500;

/**
 * Live rows for a foreground agent call: finished children first, running ones last, then a summary with the
 * background key. The tool view shows the tail while running, so the summary and running rows stay visible.
 */
function foregroundProgress(runtime: SubagentV2Runtime, ids: readonly string[]): string | undefined {
	let children: ReturnType<SubagentV2Runtime["overview"]>["children"];
	try {
		children = runtime.overview().children;
	} catch {
		return undefined;
	}
	const rows = ids.flatMap((id) => children.filter((child) => child.id === id));
	if (rows.length === 0) return undefined;
	const ordered = [...rows.filter((child) => !child.running), ...rows.filter((child) => child.running)];
	const lines = ordered.map((child) => {
		const status = child.running
			? child.state === "queued"
				? "queued"
				: "running"
			: (child.lastTurnOutcome ?? child.state);
		const activity = child.running ? runtime.currentActivity(child.id) : undefined;
		return `${statusMark({ state: child.running && child.state !== "queued" ? "running" : child.state, ...(child.lastTurnOutcome ? { lastTurnOutcome: child.lastTurnOutcome } : {}) }).glyph} ${child.name ?? child.id} · ${child.agent} · ${status} · ${formatTokens(child.tokens)} tok${activity ? ` · ${activity}` : ""}`;
	});
	const running = rows.filter((child) => child.running).length;
	const backgroundKey = keyText("app.tasks.background");
	const summary =
		running > 0
			? `${running} of ${rows.length} running${backgroundKey ? ` · ${backgroundKey} moves them to the background` : ""}`
			: `${rows.length} finished`;
	return [...lines, summary].join("\n");
}

/**
 * Parent sessions that emitted session_shutdown, shared by every extension instance in the process. A session
 * switch loads the next instance while the host bridge still points at the closed parent; that instance must not
 * bind an owner to it (and journal into its file).
 */
const shutDownParents = new WeakSet<AgentSession>();

/**
 * The parent's existing children, for a context that lost them (compaction or a resumed session), so the
 * model continues them by name instead of relaunching. Bounded; descriptions are the parent's own text.
 */
function renderChildRoster(runtime: SubagentV2Runtime): string | undefined {
	let all: ReturnType<SubagentV2Runtime["overview"]>["children"];
	try {
		all = runtime.overview().children;
	} catch {
		return undefined;
	}
	const children = all.filter((child) => child.depth === 0 && child.state !== "deleted").slice(-ROSTER_LIMIT);
	if (children.length === 0) return undefined;
	const lines = children.map((child) => {
		const description = child.description.length > 80 ? `${child.description.slice(0, 79)}…` : child.description;
		const status = child.running ? (child.state === "queued" ? "queued" : "running") : child.state;
		return `- ${child.name ?? child.id}${child.name ? ` (${child.id})` : ""} · ${child.agent} · ${status}${child.lastTurnOutcome ? ` · last turn ${child.lastTurnOutcome}` : ""} · ${description}`;
	});
	return [
		"Current subagents in this session (shown after compaction or a resume). Continue one with agent resume=<name or id> instead of launching a duplicate; agent_control action=status or output reads one. Results of running ones still arrive as messages.",
		...lines,
	].join("\n");
}

export default function iceSubagentsV2(ice: ExtensionAPI, options: IceSubagentsOptions = {}): void {
	if (typeof ice.registerFlag === "function") {
		ice.registerFlag("agents", {
			description:
				'Extra subagent definitions as JSON, for example {"reviewer":{"description":"...","prompt":"..."}}; same schema as ice.subagents.agents',
			type: "string",
		});
		ice.registerFlag("sub-yolo", {
			description:
				"Let subagents run edits and shell commands the trusted build parent may run, without per-call approval; this is not a sandbox",
			type: "boolean",
		});
	}
	let latestCtx: ExtensionContext | undefined;
	/** A resumed session shows the child roster once: its children may have been interrupted while it was closed. */
	let rosterAfterResume = false;
	const nameOf = (id: string): string | undefined => {
		try {
			return runtime.registry.get(runtime.ownerSessionId(), id).name;
		} catch {
			return undefined;
		}
	};
	const formatNamedTurn = (result: ChildTurnResult) => formatTurn(result, nameOf(result.id));
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsFor = (ctx: ExtensionContext | undefined) => {
		// The footer can initialize the owner before session_start provides an extension context.
		const manager = ctx?.settingsManager ?? options.agentViewBridge?.getParentSession()?.settingsManager;
		const trusted = ctx?.isProjectTrusted?.() ?? manager?.isProjectTrusted() ?? false;
		return resolveSubagentsV2Settings({
			global: (manager?.getGlobalSettings() as { ice?: { subagents?: unknown } } | undefined)?.ice?.subagents,
			project: (manager?.getProjectSettings() as { ice?: { subagents?: unknown } } | undefined)?.ice?.subagents,
			projectTrusted: trusted,
		});
	};
	const hubListeners = new Set<() => void>();
	const notifyHub = () => {
		for (const listener of hubListeners) listener();
	};
	let lastApprovalCount = 0;
	const announcedApprovals = new Set<string>();
	const runtime = new SubagentV2Runtime({
		getParentSession: () => {
			const parent = options.agentViewBridge?.getParentSession();
			return parent && !shutDownParents.has(parent) ? parent : undefined;
		},
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
		getAdapters: () => {
			const mcpAdapter = options.mcpAdapter ?? parentMcpAdapters.get(ice.events);
			const identity = mcpAdapter?.getIdentity?.();
			const isCurrentAdapter = () =>
				(options.mcpAdapter ?? parentMcpAdapters.get(ice.events)) === mcpAdapter &&
				mcpAdapter?.getIdentity?.() === identity;
			return [...getIceDelegableTools(ice.events), ...mcpDelegableTools(mcpAdapter, isCurrentAdapter)];
		},
		getPatchVerifier: () => {
			const argv = parseVerifierArgv(ice.getFlag("ice-verify"));
			return argv ? (root, signal) => runVerifier(argv, root, { signal }) : undefined;
		},
		getFlagAgents: () => {
			const raw = typeof ice.getFlag === "function" ? ice.getFlag("agents") : undefined;
			if (typeof raw !== "string" || !raw.trim()) return options.agents;
			try {
				return JSON.parse(raw) as unknown;
			} catch {
				return raw; // Reported as an invalid --agents source by the definition loader.
			}
		},
		createHookRuntime: (target) => {
			const ctx = latestCtx;
			if (!ctx) throw new Error("no parent context is available to resolve subagent hooks");
			const settingsManager = ctx.settingsManager ?? SettingsManager.create(ctx.cwd, agentDir);
			return buildSubagentHookRuntime(ctx, settingsManager, target, options, undefined, (entry) =>
				appendSubagentHookJournal(ice, entry),
			);
		},
		onChildActivity: () => notifyHub(),
		isDisplayed: (childId) => options.agentViewBridge?.getDisplayedId() === childId,
		// Background asks wait for an inbox: the Agent Hub in the TUI, or an RPC client
		// answering through respond_subagent_approval. Elsewhere they are denied at once.
		hasApprovalInbox: () => (latestCtx?.mode === "tui" || latestCtx?.mode === "rpc") && latestCtx.hasUI === true,
		onApprovalsChanged: (pending) => {
			for (const approval of pending) {
				if (announcedApprovals.has(approval.request.id)) continue;
				announcedApprovals.add(approval.request.id);
				ice.events.emit(SUBAGENT_EVENT_CHANNEL, {
					type: "subagent_permission_request",
					childId: approval.request.childId,
					agent: approval.request.agent,
					ownerSessionId: approval.request.ownerSessionId,
					depth: 0,
					state: "blocked",
					tool: approval.request.tool,
				});
			}
			for (const id of announcedApprovals)
				if (!pending.some((approval) => approval.request.id === id)) announcedApprovals.delete(id);
			const background = pending.filter((approval) => !approval.request.foreground);
			if (background.length > lastApprovalCount && latestCtx?.hasUI) {
				const newest = background.at(-1)!.request;
				latestCtx.ui.notify(
					`Subagent ${newest.agent} is waiting for approval: ${newest.summary}. Open /agents to answer.`,
					"warning",
				);
			}
			lastApprovalCount = background.length;
			notifyHub();
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

	// Live V2 children appear in the normal interactive child view (focus, mirror, take control, cycling).
	const controls = new Map<string, { session: AgentSession; control: IceAgentViewLiveSessionControl }>();
	const liveSource: IceAgentViewLiveSessionSource = {
		list: () => {
			let owner: string;
			try {
				owner = runtime.ownerSessionId();
			} catch {
				return [];
			}
			const live: IceAgentViewLiveSession[] = [];
			for (const record of runtime.registry.list(owner)) {
				const resident = runtime.registry.resident(owner, record.id);
				if (!resident) continue;
				let entry = controls.get(record.id);
				if (entry?.session !== resident.session) {
					const base = createSubagentLiveSessionControl(resident.session, notifyHub);
					entry = {
						session: resident.session,
						control: {
							...base,
							stopRuntime: () => runtime.stop(record.id),
							followUp: async (text: string) => {
								await runtime.send(record.id, text, "followup");
							},
						},
					};
					controls.set(record.id, entry);
				}
				live.push({
					runId: record.id,
					role: record.agent,
					taskId: record.name ?? record.description,
					session: resident.session,
					control: entry.control,
				});
			}
			return live;
		},
		subscribe: (listener) => {
			hubListeners.add(listener);
			return () => hubListeners.delete(listener);
		},
	};
	let unsubscribeRegistry: (() => void) | undefined;
	options.agentViewBridge?.setSubagentControlSource({
		overview: () => {
			try {
				return runtime.overview();
			} catch {
				return undefined; // No parent session yet.
			}
		},
		respondToApproval: (approvalId, answer) => runtime.respondToApproval(approvalId, answer),
	});
	// Ctrl+B: foreground agent waits the user may move to the background.
	const blockingWaits = new Set<{ ownerSessionId: string; release: () => void }>();
	const backgroundIds: string[] = [];
	options.agentViewBridge?.setBlockingWaitSource({
		count: () => {
			const owner = options.agentViewBridge?.getParentSession()?.sessionId;
			return [...blockingWaits].filter((wait) => wait.ownerSessionId === owner).length;
		},
		release: () => {
			const owner = options.agentViewBridge?.getParentSession()?.sessionId;
			let released = 0;
			for (const wait of blockingWaits) {
				if (wait.ownerSessionId !== owner) continue;
				blockingWaits.delete(wait);
				wait.release();
				released++;
			}
			return released;
		},
		backgroundCount: () => {
			try {
				const owner = runtime.ownerSessionId();
				const running = backgroundIds.filter((id) => runtime.registry.resident(owner, id)?.running);
				backgroundIds.splice(0, backgroundIds.length, ...running);
				return running.length;
			} catch {
				return 0;
			}
		},
	});

	ice.on("session_start", async (event, ctx) => {
		latestCtx = ctx;
		// A reload keeps the same parent session object; it is live again.
		const parent = options.agentViewBridge?.getParentSession();
		if (parent) shutDownParents.delete(parent);
		rosterAfterResume = event.reason === "startup" || event.reason === "resume";
		runtime.invalidateDefinitions();
		unsubscribeRegistry?.();
		unsubscribeRegistry = undefined;
		try {
			const previous = new Map<string, ChildRecord>();
			unsubscribeRegistry = runtime.registry.subscribe((event) => {
				notifyHub();
				if (event.type === "record") {
					for (const lifecycle of lifecycleEvents(previous.get(event.record.id), event.record))
						ice.events.emit(SUBAGENT_EVENT_CHANNEL, lifecycle);
					previous.set(event.record.id, event.record);
				} else {
					const depth = previous.get(event.completion.childId)?.depth ?? 0;
					ice.events.emit(SUBAGENT_EVENT_CHANNEL, completionEvent(event.completion, depth));
				}
			});
		} catch {
			// No parent session yet; connected on the next session start.
		}
		options.agentViewBridge?.connectLiveSessions(liveSource);
		// Results that finished while this session was closed show up right away, without starting a turn;
		// the model reads them with the next prompt.
		if (event.reason === "startup" || event.reason === "resume") {
			try {
				runtime.flushCompletions({ triggerTurn: false });
			} catch {
				// No parent session yet.
			}
		}
	});
	ice.on("before_agent_start", async (_event, ctx) => {
		latestCtx = ctx;
		try {
			const branch = listingStateFromBranch(ctx);
			const delta = computeAgentListingDelta(branch.state, runtime.callableAgents());
			const roster = branch.compacted || rosterAfterResume ? renderChildRoster(runtime) : undefined;
			rosterAfterResume = false;
			const content = [renderAgentListingMessage(delta), roster].filter(Boolean).join("\n\n");
			if (!content) return undefined;
			return {
				message: {
					customType: AGENT_LISTING_CUSTOM_TYPE,
					content,
					display: false,
					details: { state: [...delta.next], ...(roster ? { roster: true } : {}) },
				},
			};
		} catch {
			return undefined;
		}
	});
	// A completion is delivered once its message is in the transcript, not when it was sent.
	ice.on("message_end", async (event) => {
		runtime.confirmDelivery(event.message);
	});
	ice.on("session_compact", async () => {
		try {
			runtime.flushCompletions();
		} catch {
			// No parent session yet.
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
		const parent = options.agentViewBridge?.getParentSession();
		if (parent) shutDownParents.add(parent);
		unsubscribeRegistry?.();
		controls.clear();
		await runtime.shutdown();
	});

	const agentTool: ToolDefinition<typeof AgentToolParametersSchema> = {
		name: "agent",
		label: "agent",
		description: AGENT_TOOL_DESCRIPTION,
		promptSnippet: "Launch or continue subagents",
		promptGuidelines: AGENT_TOOL_GUIDELINES,
		parameters: AgentToolParametersSchema,
		execute: async (_toolCallId, params: AgentToolParameters, signal, onUpdate, ctx) => {
			latestCtx = ctx;
			const background = params.background === true;
			for (const task of params.tasks) {
				if (task.resume && task.outputSchema)
					return text("A resumed task keeps its frozen outputSchema; remove that field.");
				if (task.resume && task.agent) return text("A task cannot set both resume and agent.");
				if (task.resume && task.name) return text("A resumed task keeps its name; remove the name field.");
				if (task.resume && (task.model || task.thinking || task.isolation || task.scope))
					return text(
						"A resumed task keeps its frozen model, thinking, isolation, and scope; remove those fields.",
					);
			}
			// Validate every context packet before any child is accepted; a bad item launches nothing.
			const taskPrompts: string[] = [];
			try {
				for (const task of params.tasks) taskPrompts.push(withContextPacket(task.prompt, task.context));
			} catch (error) {
				return text(`Could not launch: ${error instanceof Error ? error.message : String(error)}`);
			}
			const fresh = params.tasks.filter((task) => !task.resume);
			const prompts = new Map<string, string>();
			const order: string[] = [];
			try {
				// resume accepts an ID or a name given at launch.
				const resumeIds = params.tasks.map((task) =>
					task.resume ? runtime.resolveChildRef(task.resume) : undefined,
				);
				const records = await runtime.launch(fresh);
				let launched = 0;
				params.tasks.forEach((task, index) => {
					if (!task.resume) prompts.set(records[launched++]!.id, taskPrompts[index]!);
				});
				let freshIndex = 0;
				for (const resumeId of resumeIds) order.push(resumeId ?? records[freshIndex++]!.id);
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
					? runtime.continueChild(id, taskPrompts[index]!, {
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
					`${ids.length ? `Started ${ids.length} subagent${ids.length === 1 ? "" : "s"} in the background: ${ids.map((id) => (nameOf(id) ? `${nameOf(id)} (${id})` : id)).join(", ")}. Each completion arrives as a follow-up message.` : "No subagents started."}${rejected.length ? `\n\nCould not start:\n${rejected.map(formatNamedTurn).join("\n\n")}` : ""}`,
					{ ids, rejected: rejected.map(({ text: _text, ...rest }) => rest) },
				);
			}
			const abort = () => {
				for (const id of order) void runtime.stop(id);
			};
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			let release!: () => void;
			const released = new Promise<"released">((resolve) => {
				release = () => resolve("released");
			});
			// Keyed like count()/release(): the bridge's current parent session.
			const wait = { ownerSessionId: options.agentViewBridge?.getParentSession()?.sessionId ?? "", release };
			blockingWaits.add(wait);
			let lastProgress: string | undefined;
			const publishProgress = () => {
				const progress = foregroundProgress(runtime, order);
				if (!progress || progress === lastProgress) return;
				lastProgress = progress;
				onUpdate?.(text(progress, { progress: true }));
			};
			publishProgress();
			const progressTimer = onUpdate ? setInterval(publishProgress, PROGRESS_INTERVAL_MS) : undefined;
			try {
				const settled = await Promise.race([Promise.all(runs), released]);
				if (settled === "released") {
					const moved = runtime.detachToBackground(order);
					backgroundIds.push(...order);
					return text(
						`Moved ${moved} running subagent${moved === 1 ? "" : "s"} to the background (${order.map((id) => (nameOf(id) ? `${nameOf(id)} (${id})` : id)).join(", ")}). Each completion arrives as a follow-up message; children that already finished can be read with agent_control action=output.`,
						{ ids: order, detached: true },
					);
				}
				const results = settled;
				const synthesis = results.length > 1 ? summarizeV2BatchSynthesis(results) : undefined;
				return text(
					[
						...(synthesis
							? [
									renderBatchSynthesisSection(synthesis),
									"Criterion coverage summarizes report-claim/evidence consistency only; it is not semantic verification or independent review approval.",
								]
							: []),
						...results.map(formatNamedTurn),
					].join("\n\n"),
					{
						results: results.map(({ text: _text, ...rest }) => rest),
						...(synthesis ? { batchSynthesis: synthesis } : {}),
					},
				);
			} finally {
				if (progressTimer) clearInterval(progressTimer);
				blockingWaits.delete(wait);
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
			const refs = params.ids ?? (params.id ? [params.id] : []);
			let ids: string[] = refs;
			const needId = () => {
				if (ids.length === 0) throw new Error(`action=${params.action} needs id or ids.`);
				return ids;
			};
			try {
				const owner = runtime.ownerSessionId();
				// Every action accepts IDs or names given at launch.
				ids = refs.map((ref) => runtime.resolveChildRef(ref));
				const registry = runtime.registry;
				switch (params.action) {
					case "list": {
						const records = registry.list(owner);
						if (records.length === 0) return text("No subagents in this session.");
						return text(
							records
								.map(
									(record) =>
										`${record.id}${record.name ? ` (${record.name})` : ""}  ${record.agent}  ${record.state}${record.lastTurnOutcome ? ` (last turn: ${record.lastTurnOutcome})` : ""}  ${record.description}`,
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
						// The user can always talk to the parent: a queued message or Ctrl+B ends the wait early.
						const interrupt = new AbortController();
						let reason: "message" | "released" | undefined;
						const stop = (why?: "message" | "released") => {
							reason ??= why;
							interrupt.abort();
						};
						const onAbort = () => stop();
						signal?.addEventListener("abort", onAbort, { once: true });
						const poll = setInterval(() => {
							if (ctx.hasPendingMessages()) stop("message");
						}, WAIT_MESSAGE_POLL_MS);
						const blocking = {
							ownerSessionId: options.agentViewBridge?.getParentSession()?.sessionId ?? "",
							release: () => stop("released"),
						};
						blockingWaits.add(blocking);
						if (ctx.hasPendingMessages()) stop("message");
						let result: Awaited<ReturnType<typeof registry.waitFor>>;
						try {
							result = await registry.waitFor(
								owner,
								needId(),
								(record) => !record.turnInFlight && record.state !== "running" && record.state !== "starting",
								params.timeoutMs ?? 60_000,
								interrupt.signal,
							);
						} finally {
							clearInterval(poll);
							blockingWaits.delete(blocking);
							signal?.removeEventListener("abort", onAbort);
						}
						const header =
							reason === "message"
								? "Stopped waiting because the user sent a message; read it now. The children keep running and their completions still arrive as messages."
								: reason === "released"
									? "The user moved this wait to the background. The children keep running and their completions arrive as messages."
									: result.timedOut
										? "Wait ended before every child settled. Their completions arrive as messages; do not wait again in a loop."
										: "All children settled.";
						return text(
							`${header}\n${result.records.map((record) => `${record.id}: ${record.state}${record.lastTurnOutcome ? ` (${record.lastTurnOutcome})` : ""}`).join("\n")}`,
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
										return `${"artifactId" in chunk ? `Artifact ${chunk.artifactId}` : `Inline report ${id}`} · bytes ${chunk.offset}-${chunk.nextOffset}/${chunk.totalBytes} · nextOffset=${chunk.nextOffset} · eof=${chunk.eof} · ${chunk.contentType} · sha256=${chunk.sha256} · truncated=${chunk.truncated}\n\n${chunk.text}`;
									}
									const result = runtime.outputOf(id);
									return result ? formatNamedTurn(result) : `${id}: no final message yet.`;
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
					case "agents":
						return text(formatAgentDefinitions(runtime));
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
			let id = params.id;
			try {
				id = runtime.resolveChildRef(params.id);
				if (params.action === "inspect") {
					const inspection = runtime.inspectPatch(id);
					if (!inspection.delta)
						return text(
							`Patch of ${id} is ${inspection.state}.${inspection.recoveryRef ? ` Recovery data: ${inspection.recoveryRef}` : ""}`,
							{
								status: inspection.state,
								artifactRef: inspection.artifactRef,
								recoveryRef: inspection.recoveryRef,
							},
						);
					const { delta } = inspection;
					if (delta.empty) return text(`Child ${id} made no changes.`, { status: "empty" });
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
					const outcome = await runtime.applyPatch(id, signal);
					switch (outcome.status) {
						case "applied":
							return text(
								`${"unverified" in outcome ? "Applied (unverified: no --ice-verify verifier is configured; run your checks)" : "Applied and verified"} the patch of ${id}: ${outcome.writtenPaths.join(", ")}. The parent index was not changed.${outcome.cleanupError ? ` Cleanup needs inspection: ${outcome.cleanupError}` : ""}`,
								outcome,
							);
						case "empty":
							return text(`Child ${id} made no changes; its worktree was removed.`, outcome);
						case "already":
							return text(`The patch of ${id} was already ${outcome.patchState}.`, outcome);
						case "conflict":
							return text(
								`The patch of ${id} conflicts with changes made in the parent since the child started. Nothing was written.\n${outcome.details}`,
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
				const rejected = runtime.rejectPatch(id);
				return text(
					rejected.status === "rejected"
						? `Rejected the patch of ${id} and removed its worktree.`
						: `The patch of ${id} was already ${rejected.patchState}.`,
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

	const hubSource: HubSource = {
		rows: () => runtime.overview().children,
		approvals: () => runtime.pendingApprovals(),
		details: (id) => runtime.describeChild(id),
		subscribe: (listener) => {
			hubListeners.add(listener);
			return () => hubListeners.delete(listener);
		},
		focus: (id) => options.agentViewBridge?.requestDisplay(id) ?? false,
		stop: (id) => runtime.stop(id),
		resume: (id) => runtime.revive(id),
		delete: (id) => runtime.delete(id),
		respond: (approvalId, answer) => runtime.respondToApproval(approvalId, answer),
		capacity: () => runtime.overview().capacity,
	};
	if (typeof ice.registerCommand === "function") {
		ice.registerCommand("agents", {
			description:
				"Agent Hub: subagents, approvals, and actions. /agents list shows definitions; /agents new <name> [--project] creates one",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				latestCtx = ctx;
				const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
				if (verb === "list") {
					ctx.ui.notify(formatAgentDefinitions(runtime), "info");
					return;
				}
				if (verb === "new") {
					const project = rest.includes("--project");
					const name = rest.find((part) => !part.startsWith("--"));
					try {
						const path = createAgentDefinitionFile({
							name: name ?? "",
							directory: project
								? join(ctx.cwd, CONFIG_DIR_NAME, "agents")
								: getSubagentGlobalAgentsDir(options.agentDir),
							projectTrusted: !project || ctx.isProjectTrusted(),
						});
						runtime.invalidateDefinitions();
						ctx.ui.notify(
							`Created ${path}. Edit its description, tools, and prompt; /agents list validates it.`,
							"info",
						);
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}
				if (ctx.mode !== "tui" || !ctx.hasUI) {
					ctx.ui.notify(formatAgentDefinitions(runtime), "info");
					return;
				}
				try {
					runtime.ownerSessionId();
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
					return;
				}
				// In place of the editor, like other pickers: an overlay draws over the transcript without clearing it.
				await ctx.ui.custom<void>(
					(tui, theme, keybindings, done) => new AgentHubView(tui, theme, keybindings, hubSource, () => done()),
				);
			},
		});
	}

	ice.registerTool(agentTool as unknown as ToolDefinition);
	ice.registerTool(controlTool as unknown as ToolDefinition);
	ice.registerTool(patchTool as unknown as ToolDefinition);
}
