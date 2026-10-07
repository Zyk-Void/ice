/**
 * Subagent V2 runtime (Plan/subagent-rewrite.md sections 6, 9-13, P5.4/P5.5/P6).
 *
 * Owns, per parent session, one ChildRegistry, one FIFO admission pool, and one
 * approval broker. A launch resolves the definition, model, tools, and child
 * rules into a frozen contract, persists it durably, and only then creates the
 * ordinary child AgentSession. Foreground and background children share the
 * same runtime; background completions are journaled and delivered at most once
 * as `subagent_completed` follow-ups.
 */
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Api, AssistantMessage, Model } from "@zykairotis/ice-ai/compat";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentTaskInput } from "../api/agent.ts";
import type { ChildRuntimeContract, NormalizedPermissionRule } from "../contract/child-runtime-contract.ts";
import { buildChildRuntimeContract, createChildId } from "../contract/serialize.ts";
import { validateChildResume } from "../contract/validate-resume.ts";
import { callableAgentDefinitions } from "../definitions/listing.ts";
import { AgentDefinitionCache, type LoadedAgentDefinitions, loadAgentDefinitions } from "../definitions/load.ts";
import type { AgentDefinitionSource, ResolvedAgentDefinition } from "../definitions/schema.ts";
import { type ApprovalAnswer, ApprovalBroker, type ApprovalRequest } from "../permissions/approval.ts";
import { childDelegationTools, deriveChildDecision } from "../permissions/derive-child.ts";
import { evaluatePermission, type PermissionRuleSet } from "../permissions/evaluate.ts";
import {
	type AgentPermissionMode,
	mostRestrictiveDecision,
	type PermissionDecision,
	type PermissionRuleScope,
} from "../permissions/rules.ts";
import { bashGrantPrefix, extractPermissionSubjects, type PermissionSubject } from "../permissions/subjects.ts";
import { SubagentConcurrencyAdmission } from "../registry/admission.ts";
import {
	buildRecoveryNotice,
	createChildSession,
	findInterruptedToolCalls,
	openChildSession,
} from "../registry/child-sessions.ts";
import { type ChildRecord, ChildRegistry, sessionJournal } from "../registry/registry.ts";
import type { ChildTurnOutcome } from "../registry/state-machine.ts";
import { buildSubagentTaskContract } from "../results/task-contract.ts";
import type { IceResolvedDelegableTool } from "../tools/adapters.ts";
import { ICE_BUILTIN_CHILD_TOOLS } from "../tools/adapters.ts";
import { type ParentToolInfo, resolveChildTools } from "../tools/resolve.ts";
import { type ChildToolGuard, createV2ChildSession } from "./session-factory.ts";
import type { SubagentsV2Settings } from "./settings.ts";

export const SUBAGENT_COMPLETED_CUSTOM_TYPE = "subagent_completed";
const RESULT_TEXT_LIMIT = 48 * 1024;
const COMPLETION_SUMMARY_LIMIT = 4 * 1024;

const SOURCE_SCOPE: Readonly<Record<AgentDefinitionSource, PermissionRuleScope>> = {
	builtin: "builtin",
	package: "user",
	user: "user",
	"user-settings": "user",
	project: "project",
	"project-settings": "project",
	"project-compat": "project",
	flag: "cli",
	managed: "managed",
};

const READ_ONLY_BUILTINS = new Set(["read", "grep", "find", "ls"]);

export interface V2RuntimeHost {
	getParentSession(): AgentSession | undefined;
	agentDir: string;
	userAgentsDir: string;
	getSettings(): SubagentsV2Settings;
	isProjectTrusted(): boolean;
	getParentMode(): "plan" | "build";
	isSubYolo(): boolean;
	getAdapters(): readonly IceResolvedDelegableTool[];
	/** Foreground approval prompt; absent when the parent has no interactive UI. */
	promptApproval?: (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalAnswer>;
	createChildAgentSession?: typeof createV2ChildSession;
	now?: () => number;
}

interface ResidentChild {
	session: AgentSession;
	contract: ChildRuntimeContract;
	grants: string[];
	pendingNote?: string;
	recoveryNotice?: string;
	controller?: AbortController;
	/** True while a parent tool call is waiting on this child's turn. */
	foreground: boolean;
	running?: Promise<ChildTurnResult>;
	dispose(): Promise<void>;
}

export interface ChildTurnResult {
	id: string;
	agent: string;
	outcome: ChildTurnOutcome;
	text: string;
	truncated: boolean;
	usage: { inputTokens: number; outputTokens: number; cost: number };
	error?: string;
}

export class SubagentV2Error extends Error {
	readonly code: "unknown_agent" | "preflight" | "blocked" | "busy";
	constructor(code: SubagentV2Error["code"], message: string) {
		super(message);
		this.code = code;
	}
}

interface OwnerState {
	sessionId: string;
	registry: ChildRegistry<ResidentChild>;
	admission: SubagentConcurrencyAdmission;
	broker: ApprovalBroker;
	waiters: Array<() => void>;
}

function parentToolInfos(parent: AgentSession, adapters: readonly IceResolvedDelegableTool[]): ParentToolInfo[] {
	const active = new Set(parent.getActiveToolNames());
	const infos: ParentToolInfo[] = [];
	for (const name of active) {
		if ((ICE_BUILTIN_CHILD_TOOLS as readonly string[]).includes(name)) {
			infos.push({ name, access: READ_ONLY_BUILTINS.has(name) ? "read-only" : "mutation", childSafe: true });
			continue;
		}
		const adapter = adapters.find((candidate) => candidate.name === name && candidate.isCurrent());
		if (adapter) {
			infos.push({
				name,
				access: adapter.access,
				childSafe: adapter.definition.childSafe,
				adapterId: adapter.adapterId,
				fingerprint: adapter.fingerprint,
			});
		} else {
			// Not a child-safe built-in or registered adapter: visible to the resolver only as ineligible.
			infos.push({ name, access: "unknown", childSafe: false });
		}
	}
	return infos;
}

function splitModelReference(reference: string): { provider: string; model: string } | undefined {
	const slash = reference.indexOf("/");
	if (slash <= 0 || slash === reference.length - 1) return undefined;
	return { provider: reference.slice(0, slash), model: reference.slice(slash + 1) };
}

/** First candidate with an available model and configured credentials; `inherit` is the parent model. */
export function resolveChildModel(
	parent: AgentSession,
	candidates: readonly string[] | undefined,
): { model: Model<Api>; skipped: Array<{ reference: string; reason: string }> } {
	const parentModel = parent.model as Model<Api> | undefined;
	if (!parentModel) throw new SubagentV2Error("preflight", "The parent session has no model.");
	const list = candidates && candidates.length > 0 ? candidates : ["inherit"];
	const skipped: Array<{ reference: string; reason: string }> = [];
	for (const reference of list) {
		if (reference === "inherit") return { model: parentModel, skipped };
		const split = splitModelReference(reference);
		if (!split) {
			skipped.push({ reference, reason: "not a provider/model reference" });
			continue;
		}
		const model = parent.modelRuntime.getModel(split.provider, split.model);
		if (!model) skipped.push({ reference, reason: "not present in the model catalog" });
		else if (!parent.modelRuntime.hasConfiguredAuth(split.provider))
			skipped.push({ reference, reason: "no configured credentials" });
		else return { model, skipped };
	}
	throw new SubagentV2Error(
		"preflight",
		`No candidate model is available: ${skipped.map((entry) => `${entry.reference} (${entry.reason})`).join("; ")}`,
	);
}

function ruleSetsFromFrozen(rules: readonly NormalizedPermissionRule[]): PermissionRuleSet[] {
	const byScope = new Map<PermissionRuleScope, PermissionRuleSet>();
	for (const rule of rules) {
		let set = byScope.get(rule.scope);
		if (!set) {
			set = { origin: { scope: rule.scope, carrier: "settings" }, rules: { allow: [], ask: [], deny: [] } };
			byScope.set(rule.scope, set);
		}
		(set.rules[rule.decision] as string[]).push(rule.rule);
	}
	return [...byScope.values()];
}

function freezeRules(sets: readonly PermissionRuleSet[]): NormalizedPermissionRule[] {
	const out: NormalizedPermissionRule[] = [];
	for (const set of sets)
		for (const decision of ["deny", "ask", "allow"] as const)
			for (const rule of set.rules[decision] ?? []) out.push({ rule, decision, scope: set.origin.scope });
	return out;
}

function boundedText(text: string, limit: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text) <= limit) return { text, truncated: false };
	let end = limit;
	const bytes = Buffer.from(text);
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return { text: `${bytes.subarray(0, end).toString("utf8")}\n[truncated]`, truncated: true };
}

const CHILD_PROMPT_SUFFIX =
	"\n\nYou are a subagent. You cannot see the parent conversation. Work only within your approved scope and tools. Your final message is returned to the parent agent as your result: make it a complete, self-contained report.";

export class SubagentV2Runtime {
	private readonly host: V2RuntimeHost;
	private readonly cache = new AgentDefinitionCache();
	private owner: OwnerState | undefined;

	constructor(host: V2RuntimeHost) {
		this.host = host;
	}

	// --- owner state ------------------------------------------------------

	private parent(): AgentSession {
		const parent = this.host.getParentSession();
		if (!parent) throw new SubagentV2Error("preflight", "No parent session is available.");
		return parent;
	}

	private state(): OwnerState {
		const parent = this.parent();
		if (this.owner?.sessionId === parent.sessionId) return this.owner;
		const settings = this.host.getSettings();
		const registry = new ChildRegistry<ResidentChild>(sessionJournal(parent.sessionManager), this.host.now);
		registry.restore();
		const promptApproval = this.host.promptApproval;
		this.owner = {
			sessionId: parent.sessionId,
			registry,
			admission: new SubagentConcurrencyAdmission(settings.maxConcurrent),
			broker: new ApprovalBroker({
				...(promptApproval ? { interactive: promptApproval } : {}),
				askTimeoutMs: settings.askTimeoutMs,
				...(this.host.now ? { now: this.host.now } : {}),
			}),
			waiters: [],
		};
		this.owner.admission.onRelease(() => this.owner?.waiters.shift()?.());
		return this.owner;
	}

	get registry(): ChildRegistry<ResidentChild> {
		return this.state().registry;
	}

	ownerSessionId(): string {
		return this.state().sessionId;
	}

	definitions(): LoadedAgentDefinitions {
		const settings = this.host.getSettings();
		const parent = this.parent();
		const trusted = this.host.isProjectTrusted();
		const key = JSON.stringify([
			parent.sessionManager.getCwd(),
			trusted,
			settings.agents,
			settings.disabledAgents,
			settings.compat,
		]);
		return this.cache.get(key, () =>
			loadAgentDefinitions({
				cwd: parent.sessionManager.getCwd(),
				userAgentsDir: this.host.userAgentsDir,
				projectTrusted: trusted,
				settingsAgents: settings.agents,
				disabledAgents: settings.disabledAgents,
				compat: settings.compat,
			}),
		);
	}

	invalidateDefinitions(): void {
		this.cache.invalidate();
	}

	callableAgents(): ResolvedAgentDefinition[] {
		return callableAgentDefinitions(this.definitions().active);
	}

	// --- permissions ------------------------------------------------------

	private parentDecision(parent: AgentSession, subject: PermissionSubject): PermissionDecision {
		const mode = this.host.getParentMode();
		if (subject.tool === "external_directory") return mode === "plan" ? "deny" : "ask";
		const active = parent.getActiveToolNames().includes(subject.tool);
		return evaluatePermission({ subject, ruleSets: [], fallback: active ? "allow" : "deny", mode }).decision;
	}

	private guardFor(contract: ChildRuntimeContract, resident: () => ResidentChild | undefined): ChildToolGuard {
		const childRuleSets = ruleSetsFromFrozen(contract.capabilities.permissionRules);
		const access = new Map(contract.capabilities.tools.map((tool) => [tool.name, tool.access]));
		return async (toolName, args) => {
			const parent = this.parent();
			const cwd = parent.sessionManager.getCwd();
			const subjects = extractPermissionSubjects({
				tool: toolName,
				args,
				cwd,
				...(access.has(toolName) && !(ICE_BUILTIN_CHILD_TOOLS as readonly string[]).includes(toolName)
					? { adapterAccess: access.get(toolName) }
					: {}),
			});
			const grants = resident()?.grants ?? [];
			let decision: PermissionDecision = "allow";
			for (const subject of subjects) {
				const parentDecision = this.parentDecision(parent, subject);
				let child = deriveChildDecision(subject, parentDecision, {
					childRuleSets,
					agentMode: contract.capabilities.agentMode,
					subYolo: contract.capabilities.subYolo,
					worktree: contract.capabilities.worktree,
				}).decision;
				if (child === "ask" && grants.length > 0 && !subject.opaque) {
					const granted = evaluatePermission({
						subject,
						ruleSets: [{ origin: { scope: "session", carrier: "grant" }, rules: { allow: grants } }],
						fallback: "ask",
						mode: "inherit",
					}).decision;
					if (granted === "allow") child = "allow";
				}
				decision = mostRestrictiveDecision(decision, child);
			}
			if (decision === "allow") return;
			if (decision === "deny") throw new Error(`Permission denied: ${toolName} is not allowed for this subagent.`);
			const firstBash = subjects.find((subject) => subject.tool === "bash")?.value;
			const summary =
				toolName === "bash"
					? `bash: ${String(args.command ?? "").slice(0, 300)}`
					: `${toolName}: ${subjects[0]?.value ?? ""}`;
			const sessionRule = toolName === "bash" && firstBash ? `bash(${bashGrantPrefix(firstBash)}*)` : toolName;
			const outcome = await this.state().broker.request({
				id: `${contract.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
				ownerSessionId: contract.ownerSessionId,
				childId: contract.id,
				agent: contract.agent.name,
				tool: toolName,
				summary,
				sessionRule,
				foreground: resident()?.foreground === true,
			});
			if (outcome.decision === "deny")
				throw new Error(`Permission denied: ${toolName} was not approved (${outcome.source}).`);
			if (outcome.sessionRule) resident()?.grants.push(outcome.sessionRule);
		};
	}

	// --- launch -----------------------------------------------------------

	/** Resolve one new task into a frozen contract. Throws before anything is persisted. */
	private preflight(
		task: AgentTaskInput,
		settings: SubagentsV2Settings,
	): { contract: ChildRuntimeContract; model: Model<Api> } {
		const parent = this.parent();
		const name = task.agent ?? settings.defaultAgent;
		const definitions = this.definitions();
		const definition = callableAgentDefinitions(definitions.active).find((candidate) => candidate.name === name);
		if (!definition) {
			const available = this.callableAgents().map((candidate) => candidate.name);
			throw new SubagentV2Error(
				"unknown_agent",
				`Agent "${name}" is not available. Available agents: ${available.join(", ") || "none"}.`,
			);
		}
		const agentSubject: PermissionSubject = {
			tool: "agent",
			value: name,
			pathMode: false,
			subjectClass: "delegation",
		};
		const agentDecision = evaluatePermission({
			subject: agentSubject,
			ruleSets: settings.ruleSets,
			fallback: "allow",
			mode: "inherit",
		}).decision;
		if (agentDecision === "deny")
			throw new SubagentV2Error("preflight", `Agent "${name}" is denied by ice.subagents.permissions.`);
		const fields = definition.fields;
		const isolation = task.isolation ?? fields.isolation ?? "none";
		if (isolation === "worktree")
			throw new SubagentV2Error("preflight", "Worktree isolation is not available yet in subagents V2.");
		const tools =
			typeof fields.tools === "string" ? fields.tools.split(",").map((tool) => tool.trim()) : fields.tools;
		const adapters = this.host.getAdapters();
		const parentTools = parentToolInfos(parent, adapters);
		const delegation = childDelegationTools({
			spawns: fields.spawns ?? [],
			depth: 0,
			maxDepth: settings.maxDepth,
			parentHasAgentTool: parent.getActiveToolNames().includes("agent"),
			parentDecisionForAgent: (agent) =>
				evaluatePermission({
					subject: { tool: "agent", value: agent, pathMode: false, subjectClass: "delegation" },
					ruleSets: settings.ruleSets,
					fallback: "allow",
					mode: "inherit",
				}).decision,
		});
		const resolution = resolveChildTools({
			parentTools,
			...(tools ? { tools } : {}),
			...(fields.disallowedTools ? { disallowedTools: fields.disallowedTools } : {}),
			...(fields.mcp ? { mcp: fields.mcp } : {}),
			delegationTools: delegation.tools,
		});
		const candidates = task.model ? [task.model] : typeof fields.model === "string" ? [fields.model] : fields.model;
		const { model, skipped } = resolveChildModel(parent, candidates);
		const definitionRules: PermissionRuleSet[] = fields.permissions
			? [
					{
						origin: { scope: SOURCE_SCOPE[definition.source], carrier: "agent-definition" },
						rules: fields.permissions,
					},
				]
			: [];
		const id = createChildId();
		const cwd = parent.sessionManager.getCwd();
		const scopeRoots = (task.scope?.roots ?? ["."]).map((root) => {
			const absolute = resolve(cwd, root);
			let canonical: string;
			try {
				canonical = realpathSync(absolute);
			} catch {
				throw new SubagentV2Error("preflight", `scope root ${root} does not exist`);
			}
			if (!statSync(canonical).isDirectory())
				throw new SubagentV2Error("preflight", `scope root ${root} is not a directory; put files in scope.targets`);
			return canonical;
		});
		const systemPrompt = `${definition.prompt}${CHILD_PROMPT_SUFFIX}${
			resolution.diagnostics.length > 0 ? `\n\nUnavailable tools: ${resolution.diagnostics.join("; ")}.` : ""
		}`;
		const contract = buildChildRuntimeContract({
			id,
			ownerSessionId: parent.sessionId,
			rootSessionId: parent.sessionId,
			depth: 0,
			agent: {
				name,
				source: definition.source,
				...(definition.sourcePath ? { sourcePath: definition.sourcePath } : {}),
				sourceHash: definition.sourceHash,
				resolvedDefinitionHash: definition.sourceHash,
			},
			prompt: {
				system: systemPrompt,
				...(fields.initialPrompt ? { initialPrompt: fields.initialPrompt } : {}),
				contextFiles: fields.contextFiles ?? true,
				resourceHashes: [],
			},
			model: {
				provider: model.provider,
				model: model.id,
				thinking: task.thinking ?? fields.thinking ?? "medium",
				...(fields.temperature !== undefined ? { temperature: fields.temperature } : {}),
				...(fields.topP !== undefined ? { topP: fields.topP } : {}),
				...(skipped.length > 0 ? { skippedCandidates: skipped } : {}),
			},
			capabilities: {
				tools: resolution.tools,
				permissionRules: freezeRules([...settings.ruleSets, ...definitionRules]),
				scopeRoots,
				...(task.scope?.targets ? { targets: task.scope.targets } : {}),
				mcpServers: [],
				spawns: delegation.spawnable,
				maxDepth: settings.maxDepth,
				subYolo: this.host.isSubYolo(),
				agentMode: (fields.permissionMode ?? "inherit") as AgentPermissionMode,
				parentMode: this.host.getParentMode(),
				worktree: false,
			},
			result: {
				...(task.outputSchema ? { outputSchema: task.outputSchema } : {}),
				acceptance: task.acceptance ?? [],
				taskContract: buildSubagentTaskContract(task.description),
			},
			budgets: {
				...((task.maxTurns ?? fields.maxTurns) ? { maxTurns: (task.maxTurns ?? fields.maxTurns) as number } : {}),
				...((task.maxTokens ?? fields.maxTokens)
					? { maxTokens: (task.maxTokens ?? fields.maxTokens) as number }
					: {}),
				...((task.timeoutMs ?? fields.timeoutMs)
					? { timeoutMs: (task.timeoutMs ?? fields.timeoutMs) as number }
					: {}),
				startupTimeoutMs: 600_000,
			},
			isolation: { mode: "none" },
		});
		return { contract, model };
	}

	private async residentFor(
		contract: ChildRuntimeContract,
		sessionManager: Parameters<typeof createV2ChildSession>[0]["sessionManager"],
		model: Model<Api>,
	): Promise<ResidentChild> {
		const parent = this.parent();
		let resident: ResidentChild | undefined;
		const session = await (this.host.createChildAgentSession ?? createV2ChildSession)({
			contract,
			sessionManager,
			cwd: parent.sessionManager.getCwd(),
			agentDir: this.host.agentDir,
			model,
			modelRuntime: parent.modelRuntime,
			adapters: this.host.getAdapters(),
			guard: this.guardFor(contract, () => resident),
		});
		resident = {
			session,
			contract,
			grants: [],
			foreground: false,
			dispose: async () => {
				await session.abort().catch(() => {});
				session.dispose();
			},
		};
		return resident;
	}

	/** Accept and start new children. Resolves once each is persisted and resident. */
	async launch(tasks: readonly AgentTaskInput[]): Promise<ChildRecord[]> {
		const settings = this.host.getSettings();
		const parent = this.parent();
		const state = this.state();
		// Preflight every task before persisting any, so a bad batch launches nothing.
		const prepared = tasks.map((task) => ({ task, ...this.preflight(task, settings) }));
		const records: ChildRecord[] = [];
		for (const { task, contract, model } of prepared) {
			const created = createChildSession({
				parentSessionDir: parent.sessionManager.getSessionDir(),
				parentSessionId: parent.sessionId,
				...(parent.sessionManager.getSessionFile()
					? { parentSessionFile: parent.sessionManager.getSessionFile() }
					: {}),
				contract,
				cwd: parent.sessionManager.getCwd(),
			});
			const record = state.registry.accept({
				id: contract.id,
				ownerSessionId: contract.ownerSessionId,
				rootSessionId: contract.rootSessionId,
				depth: contract.depth,
				agent: contract.agent.name,
				description: task.description,
				contractHash: created.contractHash,
				transcriptPath: created.transcriptPath,
			});
			const resident = await this.residentFor(contract, created.sessionManager, model);
			state.registry.attach(state.sessionId, contract.id, resident);
			records.push(record);
		}
		return records;
	}

	private async acquire(state: OwnerState, signal?: AbortSignal): Promise<void> {
		while (!state.admission.tryAcquire()) {
			if (signal?.aborted) throw new Error("Cancelled while queued.");
			await new Promise<void>((resolve) => state.waiters.push(resolve));
		}
	}

	/** Run one turn of a resident child. Never throws; failures become turn outcomes. */
	runTurn(id: string, text: string, options: { foreground: boolean; background?: boolean }): Promise<ChildTurnResult> {
		const state = this.state();
		const resident = state.registry.resident(state.sessionId, id);
		if (!resident) return Promise.reject(new SubagentV2Error("busy", `Child ${id} is not resident.`));
		if (resident.running) return Promise.reject(new SubagentV2Error("busy", `Child ${id} is already running.`));
		const controller = new AbortController();
		const run = (async (): Promise<ChildTurnResult> => {
			const notes = [resident.recoveryNotice, resident.pendingNote].filter(Boolean);
			resident.recoveryNotice = undefined;
			resident.pendingNote = undefined;
			const prompt = notes.length > 0 ? `${notes.join("\n\n")}\n\n${text}` : text;
			let outcome: ChildTurnOutcome = "completed";
			let error: string | undefined;
			const startIndex = resident.session.messages.length;
			try {
				await this.acquire(state, controller.signal);
			} catch {
				return this.finishTurn(
					state,
					resident,
					id,
					"cancelled",
					startIndex,
					options.background === true,
					"Cancelled while queued.",
				);
			}
			try {
				resident.foreground = options.foreground;
				const record = state.registry.get(state.sessionId, id);
				state.registry.transition(state.sessionId, id, record.generation, "running", { turnInFlight: true }, true);
				controller.signal.addEventListener("abort", () => void resident.session.abort().catch(() => {}), {
					once: true,
				});
				await resident.session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
				if (controller.signal.aborted) outcome = "cancelled";
				const last = resident.session.messages.at(-1) as AssistantMessage | undefined;
				if (!controller.signal.aborted && last?.role === "assistant" && last.stopReason === "error") {
					outcome = "failed";
					error = last.errorMessage ?? "child model error";
				}
			} catch (caught) {
				outcome = controller.signal.aborted ? "cancelled" : "failed";
				error = caught instanceof Error ? caught.message : String(caught);
			} finally {
				state.admission.release();
				resident.foreground = false;
			}
			return this.finishTurn(state, resident, id, outcome, startIndex, options.background === true, error);
		})().finally(() => {
			resident.running = undefined;
		});
		resident.running = run;
		resident.controller = controller;
		return run;
	}

	private finishTurn(
		state: OwnerState,
		resident: ResidentChild,
		id: string,
		outcome: ChildTurnOutcome,
		startIndex: number,
		background: boolean,
		error?: string,
	): ChildTurnResult {
		const messages = resident.session.messages.slice(startIndex);
		let inputTokens = 0;
		let outputTokens = 0;
		let cost = 0;
		let finalText = "";
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			const assistant = message as AssistantMessage;
			inputTokens += assistant.usage?.input ?? 0;
			outputTokens += assistant.usage?.output ?? 0;
			cost += assistant.usage?.cost?.total ?? 0;
			const text = assistant.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");
			if (text.trim()) finalText = text;
		}
		const bounded = boundedText(finalText, RESULT_TEXT_LIMIT);
		const record = state.registry.get(state.sessionId, id);
		const usage = {
			inputTokens: record.usage.inputTokens + inputTokens,
			outputTokens: record.usage.outputTokens + outputTokens,
			cost: record.usage.cost + cost,
			turns: record.usage.turns + 1,
		};
		const target =
			record.state === "starting" || record.state === "running" || record.state === "stopping"
				? "idle"
				: record.state;
		if (record.state === "starting") {
			const running = state.registry.transition(state.sessionId, id, record.generation, "running");
			state.registry.transition(
				state.sessionId,
				id,
				running.generation,
				"idle",
				{ turnInFlight: false, lastTurnOutcome: outcome, usage },
				true,
			);
		} else {
			state.registry.transition(
				state.sessionId,
				id,
				record.generation,
				target,
				{ turnInFlight: false, lastTurnOutcome: outcome, usage },
				true,
			);
		}
		const result: ChildTurnResult = {
			id,
			agent: resident.contract.agent.name,
			outcome,
			text: bounded.text,
			truncated: bounded.truncated,
			usage: { inputTokens, outputTokens, cost },
			...(error ? { error } : {}),
		};
		if (background) this.deliverCompletion(state, result);
		return result;
	}

	private deliverCompletion(state: OwnerState, result: ChildTurnResult): void {
		const deliveryId = `${result.id}:${state.registry.get(state.sessionId, result.id).usage.turns}`;
		const summary = boundedText(
			result.error ? `${result.error}\n\n${result.text}` : result.text,
			COMPLETION_SUMMARY_LIMIT,
		).text;
		state.registry.recordCompletion({
			deliveryId,
			childId: result.id,
			ownerSessionId: state.sessionId,
			agent: result.agent,
			outcome: result.outcome,
			summary,
			at: (this.host.now ?? Date.now)(),
		});
		this.flushCompletions();
	}

	/** Deliver pending completions to the parent as follow-ups, each at most once. */
	flushCompletions(): void {
		const state = this.state();
		const parent = this.parent();
		for (const completion of state.registry.pendingCompletions(state.sessionId)) {
			const claimed = state.registry.claimDelivery(state.sessionId, completion.deliveryId);
			if (!claimed) continue;
			void parent
				.sendCustomMessage(
					{
						customType: SUBAGENT_COMPLETED_CUSTOM_TYPE,
						content: `Subagent ${claimed.agent} (${claimed.childId}) finished: ${claimed.outcome}.\n\n${claimed.summary}\n\nUse agent_control action=output id=${claimed.childId} for the full result.`,
						display: true,
						details: { childId: claimed.childId, agent: claimed.agent, outcome: claimed.outcome },
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				)
				.catch(() => {});
		}
	}

	// --- continuation and control ----------------------------------------

	/** Bring a parked/blocked child back under its frozen contract, or report why it cannot run. */
	async revive(id: string): Promise<void> {
		const state = this.state();
		const parent = this.parent();
		const handle = await state.registry.revive(state.sessionId, id, async (record) => {
			const opened = openChildSession(record.transcriptPath, record.contractHash);
			const validation = validateChildResume(opened.contract, {
				ownerSessionId: state.sessionId,
				parentTools: parentToolInfos(parent, this.host.getAdapters()),
				subYolo: this.host.isSubYolo(),
				parentMode: this.host.getParentMode(),
				modelAvailable: (provider, model) =>
					(provider === parent.model?.provider && model === parent.model?.id) ||
					(parent.modelRuntime.getModel(provider, model) !== undefined &&
						parent.modelRuntime.hasConfiguredAuth(provider)),
				tombstoned: false,
			});
			if (!validation.ok) return { blocked: validation.reasons };
			const model =
				parent.model?.provider === opened.contract.model.provider &&
				parent.model?.id === opened.contract.model.model
					? (parent.model as Model<Api>)
					: parent.modelRuntime.getModel(opened.contract.model.provider, opened.contract.model.model)!;
			const resident = await this.residentFor(opened.contract, opened.sessionManager, model);
			if (record.lastTurnOutcome === "interrupted")
				resident.recoveryNotice = buildRecoveryNotice(findInterruptedToolCalls(opened.sessionManager.getEntries()));
			return { handle: resident };
		});
		if (!handle) {
			const record = state.registry.get(state.sessionId, id);
			throw new SubagentV2Error("blocked", `Child ${id} cannot resume: ${(record.blockedReasons ?? []).join("; ")}`);
		}
	}

	/** Continue an existing child with a new turn (agent resume and agent_control send followup). */
	async continueChild(id: string, text: string, options: { foreground: boolean }): Promise<ChildTurnResult> {
		const state = this.state();
		const record = state.registry.get(state.sessionId, id);
		if (record.state === "parked" || record.state === "blocked") await this.revive(id);
		return this.runTurn(id, text, { foreground: options.foreground, background: !options.foreground });
	}

	async send(id: string, message: string, delivery: "message" | "followup" | "interrupt"): Promise<string> {
		const state = this.state();
		const record = state.registry.get(state.sessionId, id);
		const resident = state.registry.resident(state.sessionId, id);
		if (delivery === "interrupt") {
			if (resident?.running) {
				resident.controller?.abort();
				await resident.running.catch(() => {});
			}
			void this.continueChild(id, message, { foreground: false });
			return "Interrupted the current turn and started a follow-up turn.";
		}
		if (record.state === "running" && resident) {
			if (delivery === "message") await resident.session.steer(message);
			else await resident.session.followUp(message);
			return delivery === "message"
				? "Message delivered to the running turn."
				: "Follow-up queued after the running turn.";
		}
		if (delivery === "message") {
			if (record.state === "parked" || record.state === "blocked") await this.revive(id);
			const target = state.registry.resident(state.sessionId, id);
			if (target) target.pendingNote = [target.pendingNote, message].filter(Boolean).join("\n\n");
			return "Message queued for the child's next turn.";
		}
		void this.continueChild(id, message, { foreground: false });
		return "Follow-up turn started; completion will be delivered when it finishes.";
	}

	async stop(id: string): Promise<void> {
		const state = this.state();
		const resident = state.registry.resident(state.sessionId, id);
		if (resident?.running) {
			resident.controller?.abort();
			await resident.running.catch(() => {});
		}
	}

	async delete(id: string): Promise<void> {
		await this.stop(id);
		const state = this.state();
		await state.registry.delete(state.sessionId, id);
	}

	async shutdown(): Promise<void> {
		this.owner?.broker.dispose();
		await this.owner?.registry.disposeAll();
		this.owner = undefined;
	}

	outputOf(id: string): ChildTurnResult | undefined {
		const state = this.state();
		const record = state.registry.get(state.sessionId, id);
		const resident = state.registry.resident(state.sessionId, id);
		const messages =
			resident?.session.messages ??
			openChildSession(record.transcriptPath, record.contractHash).sessionManager.buildSessionContext().messages;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index] as AssistantMessage;
			if (message.role !== "assistant") continue;
			const text = message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");
			if (!text.trim()) continue;
			const bounded = boundedText(text, RESULT_TEXT_LIMIT);
			return {
				id,
				agent: record.agent,
				outcome: record.lastTurnOutcome ?? "completed",
				text: bounded.text,
				truncated: bounded.truncated,
				usage: {
					inputTokens: record.usage.inputTokens,
					outputTokens: record.usage.outputTokens,
					cost: record.usage.cost,
				},
			};
		}
		return undefined;
	}

	respondToApproval(id: string, answer: ApprovalAnswer): boolean {
		return this.state().broker.respond(id, answer);
	}
}
