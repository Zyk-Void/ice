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

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Api, AssistantMessage, Model } from "@zykairotis/ice-ai/compat";
import type { AgentSession } from "../../core/agent-session.ts";
import type { IceSubagentOverview, IceSubagentOverviewChild } from "../../ice-agent-view-bridge.ts";
import { pathIsWithin, resolveProspectivePath, validateMutationPath } from "../../ice-safe-verify.ts";
import { redactCredentialText } from "../../utils/redact.ts";
import type { AgentTaskInput } from "../api/agent.ts";
import { CHILD_ID_PATTERN, type ChildRuntimeContract } from "../contract/child-runtime-contract.ts";
import { buildChildRuntimeContract, type ChildRuntimeContractInput, createChildId } from "../contract/serialize.ts";
import { validateChildResume } from "../contract/validate-resume.ts";
import { callableAgentDefinitions } from "../definitions/listing.ts";
import { AgentDefinitionCache, type LoadedAgentDefinitions, loadAgentDefinitions } from "../definitions/load.ts";
import type { ResolvedAgentDefinition } from "../definitions/schema.ts";
import { type ApplyOutcome, applyChildDelta } from "../isolation/apply.ts";
import { persistPatchRecovery, persistWorktreePatch, validateWorktreePatch } from "../isolation/patch-state.ts";
import {
	assertOwnedWorktree,
	type ChildDelta,
	captureWorktreeBaseline,
	computeChildDelta,
	createIsolatedWorktree,
	removeIsolatedWorktree,
	type WorktreeBaseline,
} from "../isolation/worktree.ts";
import { type ApprovalAnswer, ApprovalBroker, type PendingApproval } from "../permissions/approval.ts";
import { childDelegationTools, deriveChildDecision } from "../permissions/derive-child.ts";
import { evaluatePermission, type PermissionRuleSet } from "../permissions/evaluate.ts";
import { type AgentPermissionMode, mostRestrictiveDecision, type PermissionDecision } from "../permissions/rules.ts";
import { bashGrantPrefix, extractPermissionSubjects, type PermissionSubject } from "../permissions/subjects.ts";
import { SubagentConcurrencyAdmission } from "../registry/admission.ts";
import {
	buildRecoveryNotice,
	childSessionDirectory,
	createChildSession,
	findInterruptedToolCalls,
	openChildSession,
} from "../registry/child-sessions.ts";
import { type ChildRecord, ChildRegistry, sessionJournal } from "../registry/registry.ts";
import type { ChildTurnOutcome } from "../registry/state-machine.ts";
import {
	isSubagentOutputArtifactRef,
	SUBAGENT_OUTPUT_ARTIFACT_LIMITS,
	type SubagentOutput,
	SubagentOutputArtifactError,
	SubagentOutputArtifactStore,
	type SubagentOutputRead,
} from "../results/output-artifacts.ts";
import { normalizeSubagentOutputSchema } from "../results/report.ts";
import { buildSubagentTaskContract } from "../results/task-contract.ts";
import {
	normalizeV2Acceptance,
	renderV2ResultInstructions,
	type V2OutputCapture,
	V2ResultObservations,
	v2ReportMode,
	validateV2Result,
} from "../results/v2-result.ts";
import type { ChildBudgetLimits } from "../runtime/budgets.ts";
import {
	dispatchSubagentHookDecision,
	dispatchSubagentHookObservation,
	flushSubagentHookObservations,
	type SubagentHookRuntime,
} from "../runtime/live-session.ts";
import { resolveSubagentResources, revalidateSubagentResources } from "../runtime/resources.ts";
import { ICE_BUILTIN_CHILD_TOOLS } from "../tools/adapters.ts";
import { resolveChildTools } from "../tools/resolve.ts";
import {
	boundedText,
	CHILD_PROMPT_SUFFIX,
	type ChildTurnResult,
	COMPLETION_SUMMARY_LIMIT,
	childCwd,
	durableOutputReferenceId,
	freezeRules,
	type OwnerState,
	outputArtifactUnavailable,
	parentToolInfos,
	READ_ONLY_BUILTINS,
	RESULT_TEXT_LIMIT,
	type ResidentChild,
	reconcileTerminalWorktrees,
	resolveChildModel,
	ruleSetsFromFrozen,
	SOURCE_SCOPE,
	SUBAGENT_COMPLETED_CUSTOM_TYPE,
	SubagentV2Error,
	type TurnResultContext,
	type V2RuntimeHost,
	withContextPacket,
} from "./runtime-support.ts";
import { type ChildToolGuard, createV2ChildSession } from "./session-factory.ts";
import type { SubagentsV2Settings } from "./settings.ts";
import { ChildTurnBudget, resolveTurnBudget } from "./turn-budget.ts";

/** Idle children kept in memory per owner; older ones are parked to disk. */
export const MAX_RESIDENT_CHILDREN = 8;
/** A child idle this long after its turn settles is parked: out of memory and live views, still resumable. */
export const RETIRE_GRACE_MS = 30_000;

export class SubagentV2Runtime {
	private readonly host: V2RuntimeHost;
	private readonly outputArtifacts: SubagentOutputArtifactStore;
	private readonly cache = new AgentDefinitionCache();
	private owner: OwnerState | undefined;
	private readonly patchOperations = new Set<string>();

	constructor(host: V2RuntimeHost) {
		this.host = host;
		this.outputArtifacts = new SubagentOutputArtifactStore({
			artifactRoot: join(host.agentDir, "artifacts", "subagent-output"),
		});
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
		if (this.owner)
			throw new SubagentV2Error("busy", "Shut down the previous owner before replacing the parent session.");
		const settings = this.host.getSettings();
		const journal = sessionJournal(parent.sessionManager);
		const registry = new ChildRegistry<ResidentChild>(journal, this.host.now);
		registry.restore();
		reconcileTerminalWorktrees(registry, parent.sessionId);
		for (const record of registry.list(parent.sessionId)) {
			const output = record.lastResult?.output;
			if (!output?.artifact || !isSubagentOutputArtifactRef(output.artifact)) continue;
			let registered = false;
			try {
				registered = this.outputArtifacts.registerDurable(
					parent.sessionId,
					output.artifact,
					durableOutputReferenceId(record.id),
				);
			} catch {
				registered = false;
			}
			if (!registered) {
				const current = registry.get(parent.sessionId, record.id);
				registry.transition(
					parent.sessionId,
					record.id,
					current.generation,
					current.state,
					{ lastResult: { ...record.lastResult!, output: outputArtifactUnavailable(output) } },
					true,
				);
			}
		}
		this.outputArtifacts.finalizeRestore(parent.sessionId);
		const promptApproval = this.host.promptApproval;
		this.owner = {
			sessionId: parent.sessionId,
			journal,
			registry,
			admission: new SubagentConcurrencyAdmission(settings.maxConcurrent),
			broker: new ApprovalBroker({
				...(promptApproval ? { interactive: promptApproval } : {}),
				...(this.host.hasApprovalInbox ? { hasInbox: this.host.hasApprovalInbox } : {}),
				...(this.host.onApprovalsChanged ? { onChange: this.host.onApprovalsChanged } : {}),
				askTimeoutMs: settings.askTimeoutMs,
				...(this.host.now ? { now: this.host.now } : {}),
			}),
			waiters: [],
			retireTimers: new Map(),
			closed: false,
		};
		const owner = this.owner;
		owner.admission.onRelease(() => owner.waiters.shift()?.());
		return owner;
	}

	get registry(): ChildRegistry<ResidentChild> {
		return this.state().registry;
	}

	ownerSessionId(): string {
		return this.state().sessionId;
	}

	/** Resolve a child reference from tool input: an ID, or a name given at launch. */
	resolveChildRef(ref: string): string {
		if (CHILD_ID_PATTERN.test(ref)) return ref;
		const state = this.state();
		const records = state.registry.list(state.sessionId);
		const match = records.find((record) => record.name === ref);
		if (match) return match.id;
		const names = records.flatMap((record) => (record.name ? [record.name] : []));
		throw new SubagentV2Error(
			"preflight",
			`No subagent is named "${ref}".${names.length > 0 ? ` Names in this session: ${names.join(", ")}.` : " No subagent in this session has a name."}`,
		);
	}

	definitions(): LoadedAgentDefinitions {
		const settings = this.host.getSettings();
		const parent = this.parent();
		const trusted = this.host.isProjectTrusted();
		const flagAgents = this.host.getFlagAgents?.();
		const key = JSON.stringify([
			parent.sessionManager.getCwd(),
			trusted,
			settings.agents,
			flagAgents,
			settings.disabledAgents,
			settings.compat,
		]);
		return this.cache.get(key, () =>
			loadAgentDefinitions({
				cwd: parent.sessionManager.getCwd(),
				userAgentsDir: this.host.userAgentsDir,
				projectTrusted: trusted,
				settingsAgents: settings.agents,
				...(flagAgents !== undefined ? { flagAgents } : {}),
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
		const settings = this.host.getSettings();
		if (settings.diagnostics.length) return "deny";
		if (subject.tool === "external_directory") return mode === "plan" ? "deny" : "ask";
		const activeTools = parent.getActiveToolNames();
		// A bridged MCP tool carries the parent authority of its `mcp` proxy tool, never more.
		const bridgedMcp =
			!activeTools.includes(subject.tool) &&
			activeTools.includes("mcp") &&
			this.host.getAdapters().some((adapter) => adapter.mcp && adapter.name === subject.tool);
		const decide = (candidate: PermissionSubject) =>
			evaluatePermission({
				subject: candidate,
				ruleSets: settings.ruleSets,
				fallback: activeTools.includes(subject.tool) || bridgedMcp ? "allow" : "deny",
				mode,
			}).decision;
		const decision = decide(subject);
		return bridgedMcp ? mostRestrictiveDecision(decision, decide({ ...subject, tool: "mcp" })) : decision;
	}

	private guardFor(contract: ChildRuntimeContract, resident: () => ResidentChild | undefined): ChildToolGuard {
		const permit = this.permissionGuardFor(contract, resident);
		return async (toolName, args, signal) => {
			await permit(toolName, args, signal);
			await dispatchSubagentHookDecision(
				resident()?.hooks,
				"subagent.beforeTool",
				{ agent: contract.agent.name, tool: toolName, args },
				signal,
			);
		};
	}

	private permissionGuardFor(
		contract: ChildRuntimeContract,
		resident: () => ResidentChild | undefined,
	): ChildToolGuard {
		const childRuleSets = ruleSetsFromFrozen(contract.capabilities.permissionRules);
		const access = new Map(contract.capabilities.tools.map((tool) => [tool.name, tool.access]));
		return async (toolName, args, signal) => {
			if (signal?.aborted) throw new Error("Child tool was cancelled.");
			resident()?.budget?.assertOrdinaryWork();
			this.assertChildAuthority(contract);
			const parent = this.parent();
			if (parent.sessionId !== contract.ownerSessionId) throw new Error("Child owner is no longer active.");
			const cwd = childCwd(contract, parent.sessionManager.getCwd());
			let permissionArgs = args;
			if (READ_ONLY_BUILTINS.has(toolName) || toolName === "edit" || toolName === "write") {
				const canonical = resolveProspectivePath(resolve(cwd, String(args.path ?? ".")));
				permissionArgs = { ...args, path: canonical };
				if (toolName === "edit" || toolName === "write") {
					const reason = validateMutationPath(canonical, cwd, cwd);
					if (reason) throw new Error(reason);
				}
			}
			const subjects = extractPermissionSubjects({
				tool: toolName,
				args: permissionArgs,
				cwd,
				...(access.has(toolName) && !(ICE_BUILTIN_CHILD_TOOLS as readonly string[]).includes(toolName)
					? { adapterAccess: access.get(toolName) }
					: {}),
			});
			const grants = resident()?.grants ?? [];
			const parentSubject = (subject: PermissionSubject): PermissionSubject => {
				if (contract.isolation.mode !== "worktree" || !subject.pathMode || !subject.value) return subject;
				const mirrored = resolve(
					contract.isolation.repoRoot!,
					relative(contract.isolation.worktreePath!, resolve(cwd, subject.value)),
				);
				return {
					...subject,
					value:
						subject.tool === "external_directory"
							? mirrored
							: relative(parent.sessionManager.getCwd(), mirrored).split("\\").join("/"),
				};
			};
			let decision: PermissionDecision = "allow";
			for (const subject of subjects) {
				const parentDecision = this.parentDecision(parent, parentSubject(subject));
				let child = deriveChildDecision(subject, parentDecision, {
					childRuleSets,
					agentMode: contract.capabilities.agentMode,
					subYolo: contract.capabilities.subYolo,
					worktree: contract.capabilities.worktree,
				}).decision;
				if (parentDecision === "allow" && child === "ask" && grants.length > 0 && !subject.opaque) {
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
			const outcome = await this.state().broker.request(
				{
					id: `${contract.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
					ownerSessionId: contract.ownerSessionId,
					childId: contract.id,
					agent: contract.agent.name,
					tool: toolName,
					summary,
					sessionRule,
					foreground: resident()?.foreground === true,
				},
				signal,
			);
			if (outcome.decision === "deny")
				throw new Error(`Permission denied: ${toolName} was not approved (${outcome.source}).`);
			if (signal?.aborted) throw new Error("Child tool was cancelled during approval.");
			resident()?.budget?.assertOrdinaryWork();
			this.assertChildAuthority(contract);
			if (subjects.some((subject) => this.parentDecision(this.parent(), parentSubject(subject)) === "deny"))
				throw new Error("Current parent permission denied the approved child operation.");
			if (outcome.sessionRule) resident()?.grants.push(outcome.sessionRule);
		};
	}

	// --- launch -----------------------------------------------------------

	/** Resolve one new task into a frozen contract. Throws before anything is persisted. */
	private preflight(
		task: AgentTaskInput,
		settings: SubagentsV2Settings,
	): { input: ChildRuntimeContractInput; model: Model<Api> } {
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
		if (isolation === "worktree" && !this.host.isProjectTrusted())
			throw new SubagentV2Error("preflight", "Worktree isolation requires a trusted project.");
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
		const targets = task.scope?.targets?.map((target) => {
			const absolute = resolve(cwd, target);
			if (!existsSync(absolute)) throw new SubagentV2Error("preflight", `scope target ${target} does not exist`);
			if (lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile())
				throw new SubagentV2Error("preflight", `scope target ${target} must be a regular non-symlink file`);
			const canonical = realpathSync(absolute);
			if (!scopeRoots.some((root) => pathIsWithin(root, canonical)))
				throw new SubagentV2Error("preflight", `scope target ${target} is outside the approved roots`);
			return canonical;
		});
		// Definition-selected skills/prompts/context are trust-gated, bounded, and hash-pinned now;
		// the session factory revalidates the hashes before every launch and revival.
		const resources =
			fields.skills?.length || fields.prompts?.length || fields.context?.length
				? resolveSubagentResources(
						{
							...(fields.skills ? { skills: [...fields.skills] } : {}),
							...(fields.prompts ? { prompts: [...fields.prompts] } : {}),
							...(fields.context ? { context: [...fields.context] } : {}),
						},
						{ cwd, agentDir: this.host.agentDir, projectTrusted: this.host.isProjectTrusted() },
					)
				: undefined;
		const outputSchema = normalizeSubagentOutputSchema(task.outputSchema);
		const acceptance = normalizeV2Acceptance(task.acceptance ?? []);
		const systemPrompt = `${definition.prompt}${CHILD_PROMPT_SUFFIX}${
			resolution.diagnostics.length > 0 ? `\n\nUnavailable tools: ${resolution.diagnostics.join("; ")}.` : ""
		}`;
		const input: ChildRuntimeContractInput = {
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
				...(fields.hooks?.length ? { hooks: [...fields.hooks] } : {}),
			},
			prompt: {
				system: systemPrompt,
				...(fields.initialPrompt ? { initialPrompt: fields.initialPrompt } : {}),
				contextFiles: fields.contextFiles ?? true,
				resourceHashes: resources
					? [...resources.skills, ...resources.prompts, ...resources.context].map((resource) => ({
							id: `${resource.kind}:${resource.name}`,
							sha256: resource.sourceHash,
						}))
					: [],
				...(resources ? { resources } : {}),
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
				...(targets ? { targets } : {}),
				mcpServers: [],
				spawns: delegation.spawnable,
				maxDepth: settings.maxDepth,
				subYolo: this.host.isSubYolo(),
				agentMode: (fields.permissionMode ?? "inherit") as AgentPermissionMode,
				parentMode: this.host.getParentMode(),
				parentPolicyHash: createHash("sha256").update(JSON.stringify(settings.ruleSets)).digest("hex"),
				worktree: isolation === "worktree",
			},
			result: {
				...(outputSchema ? { outputSchema: { ...outputSchema } } : {}),
				acceptance,
				taskContract: buildSubagentTaskContract(task.description),
			},
			budgets: {
				...resolveTurnBudget({
					maxTurns: task.maxTurns ?? fields.maxTurns ?? undefined,
					maxTokens: task.maxTokens ?? fields.maxTokens ?? undefined,
					timeoutMs: task.timeoutMs ?? fields.timeoutMs ?? undefined,
				}),
				startupTimeoutMs: 600_000,
			},
			isolation: { mode: isolation },
		};
		return { input, model };
	}

	/**
	 * Capture the parent's dirty baseline, create the child's worktree, and
	 * rewrite scope roots into it. Scope roots outside the repository are refused.
	 */
	private prepareWorktree(input: ChildRuntimeContractInput): ChildRuntimeContractInput {
		const parent = this.parent();
		const baseline = captureWorktreeBaseline(parent.sessionManager.getCwd());
		const repoRoot = realpathSync(baseline.repoRoot);
		const scopeRoots = input.capabilities.scopeRoots.map((root) => {
			const rel = relative(repoRoot, root);
			if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
				throw new SubagentV2Error(
					"preflight",
					`scope root ${root} is outside the repository; worktree children stay inside it`,
				);
			return rel;
		});
		const worktreePath = join(
			childSessionDirectory(parent.sessionManager.getSessionDir(), parent.sessionId),
			"worktrees",
			input.id,
		);
		createIsolatedWorktree(baseline, worktreePath);
		mkdirSync(join(worktreePath, baseline.cwdOffset), { recursive: true });
		for (const rel of scopeRoots) mkdirSync(join(worktreePath, rel), { recursive: true });
		return {
			...input,
			capabilities: {
				...input.capabilities,
				scopeRoots: scopeRoots.map((rel) => (rel === "" ? worktreePath : join(worktreePath, rel))),
				...(input.capabilities.targets
					? { targets: input.capabilities.targets.map((target) => join(worktreePath, relative(repoRoot, target))) }
					: {}),
			},
			isolation: {
				mode: "worktree",
				baselineId: baseline.baselineCommit,
				baselineTree: baseline.baselineTree,
				headCommit: baseline.headCommit,
				repoRoot,
				cwdOffset: baseline.cwdOffset,
				worktreePath,
			},
		};
	}

	private async residentFor(
		contract: ChildRuntimeContract,
		sessionManager: Parameters<typeof createV2ChildSession>[0]["sessionManager"],
		model: Model<Api>,
		hooks: SubagentHookRuntime | undefined = this.hooksFor(contract, "blocked"),
	): Promise<ResidentChild> {
		const parent = this.parent();
		const owner = this.state();
		if (owner.closed) throw new SubagentV2Error("blocked", "The child owner was shut down.");
		let resident: ResidentChild | undefined;
		const session = await (this.host.createChildAgentSession ?? createV2ChildSession)({
			contract,
			sessionManager,
			cwd: childCwd(contract, parent.sessionManager.getCwd()),
			agentDir: this.host.agentDir,
			model,
			modelRuntime: parent.modelRuntime,
			adapters: this.host.getAdapters(),
			guard: this.guardFor(contract, () => resident),
			observeTool: (toolName, args) => {
				const done = resident?.observations?.startTool(toolName, args);
				return (success) => {
					done?.(success);
					dispatchSubagentHookObservation(hooks, "subagent.afterTool", {
						agent: contract.agent.name,
						tool: toolName,
						success,
					});
				};
			},
		});
		try {
			if (owner.closed || this.owner !== owner)
				throw new SubagentV2Error("blocked", "The child owner shut down during session creation.");
			owner.registry.get(owner.sessionId, contract.id);
			this.assertChildAuthority(contract);
		} catch (error) {
			await session.abort().catch(() => {});
			session.dispose();
			throw error;
		}
		resident = {
			session,
			contract,
			grants: [],
			foreground: false,
			...(hooks ? { hooks } : {}),
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
		if (settings.diagnostics.length)
			throw new SubagentV2Error("preflight", `Invalid parent settings: ${settings.diagnostics.join("; ")}`);
		if (!settings.enabled && tasks.length > 0)
			throw new SubagentV2Error("preflight", "Subagents are disabled by ice.subagents.enabled.");
		const parent = this.parent();
		const state = this.state();
		const taken = new Set(
			state.registry.list(state.sessionId).flatMap((record) => (record.name ? [record.name] : [])),
		);
		for (const task of tasks) {
			if (!task.name) continue;
			if (taken.has(task.name))
				throw new SubagentV2Error(
					"preflight",
					`The name "${task.name}" is already used by another subagent in this session; choose another.`,
				);
			taken.add(task.name);
		}
		// Preflight every task before persisting any, so a bad batch launches nothing.
		const prepared = tasks.map((task) => ({ task, ...this.preflight(task, settings) }));
		for (const { input } of prepared) {
			const subject: PermissionSubject = {
				tool: "agent",
				value: input.agent.name,
				pathMode: false,
				subjectClass: "delegation",
			};
			if (
				evaluatePermission({ subject, ruleSets: settings.ruleSets, fallback: "allow", mode: "inherit" })
					.decision !== "ask"
			)
				continue;
			const approval = await state.broker.request({
				id: `${input.id}:launch`,
				ownerSessionId: state.sessionId,
				childId: input.id,
				agent: input.agent.name,
				tool: "agent",
				summary: `delegate to ${input.agent.name}`,
				foreground: true,
			});
			if (approval.decision !== "allow")
				throw new SubagentV2Error(
					"preflight",
					`Delegation to ${input.agent.name} was not approved (${approval.source}).`,
				);
		}
		// beforeLaunch hooks decide before anything is persisted; their bounded additions become
		// untrusted parent context for the first turn and cannot change the frozen contract.
		const launchHooks = new Map<string, { hooks?: SubagentHookRuntime; note?: string }>();
		for (const { task, input } of prepared) {
			const contract = buildChildRuntimeContract(input);
			const hooks = this.hooksFor(contract, "preflight");
			let additions: Awaited<ReturnType<typeof dispatchSubagentHookDecision>>;
			try {
				additions = await dispatchSubagentHookDecision(hooks, "subagent.beforeLaunch", {
					agent: contract.agent.name,
					description: task.description,
					isolation: contract.isolation.mode,
					tools: contract.capabilities.tools.map((tool) => tool.name),
				});
			} catch (error) {
				throw new SubagentV2Error("preflight", error instanceof Error ? error.message : String(error));
			}
			const note = additions.length
				? withContextPacket(
						"",
						additions.map((addition, index) => ({
							id: `hook-context-${index + 1}`,
							kind: "parent_note" as const,
							content: addition.content,
						})),
					).trim()
				: undefined;
			launchHooks.set(input.id, { ...(hooks ? { hooks } : {}), ...(note ? { note } : {}) });
		}
		if (
			state.closed ||
			this.owner !== state ||
			parent.sessionId !== this.parent().sessionId ||
			JSON.stringify(settings) !== JSON.stringify(this.host.getSettings())
		)
			throw new SubagentV2Error("blocked", "Child launch authority changed during preflight.");
		for (const { input } of prepared) this.assertChildAuthority(buildChildRuntimeContract(input));
		const records: ChildRecord[] = [];
		const staged: Array<{
			task: AgentTaskInput;
			contract: ChildRuntimeContract;
			created: ReturnType<typeof createChildSession>;
			model: Model<Api>;
		}> = [];
		const worktrees: Array<{ repoRoot: string; path: string }> = [];
		try {
			for (const { task, input, model } of prepared) {
				const isolated = input.isolation.mode === "worktree" ? this.prepareWorktree(input) : input;
				if (isolated.isolation.worktreePath && isolated.isolation.repoRoot)
					worktrees.push({ repoRoot: isolated.isolation.repoRoot, path: isolated.isolation.worktreePath });
				const contract = buildChildRuntimeContract(isolated);
				const created = createChildSession({
					parentSessionDir: parent.sessionManager.getSessionDir(),
					parentSessionId: parent.sessionId,
					...(parent.sessionManager.getSessionFile()
						? { parentSessionFile: parent.sessionManager.getSessionFile() }
						: {}),
					contract,
					cwd: childCwd(contract, parent.sessionManager.getCwd()),
				});
				staged.push({ task, contract, created, model });
			}
			for (const { task, contract, created } of staged) {
				const record = state.registry.accept({
					id: contract.id,
					ownerSessionId: contract.ownerSessionId,
					rootSessionId: contract.rootSessionId,
					depth: contract.depth,
					agent: contract.agent.name,
					...(task.name ? { name: task.name } : {}),
					description: task.description,
					contractHash: created.contractHash,
					transcriptPath: created.transcriptPath,
					...(contract.isolation.mode === "worktree" ? { patchState: "open" as const } : {}),
				});
				records.push(record);
			}
			for (const { contract, created, model } of staged) {
				const launch = launchHooks.get(contract.id);
				const resident = await this.residentFor(contract, created.sessionManager, model, launch?.hooks);
				if (launch?.note) resident.pendingNote = launch.note;
				state.registry.attach(state.sessionId, contract.id, resident);
			}
			return records;
		} catch (error) {
			const cleanupFailures: string[] = [];
			for (const record of records) {
				try {
					const current = state.registry.get(state.sessionId, record.id);
					state.registry.transition(
						state.sessionId,
						record.id,
						current.generation,
						"aborted",
						{ turnInFlight: false },
						true,
					);
					await state.registry.delete(state.sessionId, record.id);
				} catch (cleanup) {
					cleanupFailures.push(String(cleanup));
				}
			}
			for (const worktree of worktrees) {
				try {
					removeIsolatedWorktree(worktree.repoRoot, worktree.path);
				} catch (cleanup) {
					cleanupFailures.push(String(cleanup));
				}
			}
			for (const item of staged) rmSync(item.created.transcriptPath, { force: true });
			if (cleanupFailures.length)
				throw new SubagentV2Error(
					"preflight",
					`${String(error)}; cleanup needs inspection: ${cleanupFailures.join("; ")}`,
				);
			throw error;
		}
	}

	private async acquire(state: OwnerState, signal?: AbortSignal): Promise<void> {
		while (true) {
			if (state.closed || signal?.aborted) throw new Error("Cancelled while queued.");
			if (state.admission.tryAcquire()) return;
			await new Promise<void>((resolveWait, reject) => {
				const wake = () => {
					signal?.removeEventListener("abort", abort);
					resolveWait();
				};
				const abort = () => {
					const index = state.waiters.indexOf(wake);
					if (index >= 0) state.waiters.splice(index, 1);
					signal?.removeEventListener("abort", abort);
					reject(new Error("Cancelled while queued."));
				};
				state.waiters.push(wake);
				signal?.addEventListener("abort", abort, { once: true });
			});
		}
	}

	/** Run one turn of a resident child. Never throws; failures become turn outcomes. */
	runTurn(
		id: string,
		text: string,
		options: {
			foreground: boolean;
			background?: boolean;
			budgets?: ChildBudgetLimits;
			acceptance?: readonly string[];
			accepted?: () => void;
			signal?: AbortSignal;
		},
	): Promise<ChildTurnResult> {
		const state = this.state();
		const record = state.registry.get(state.sessionId, id);
		if (this.patchOperations.has(id) || (record.patchState && record.patchState !== "open"))
			return Promise.reject(new SubagentV2Error("blocked", "A patch decision prevents child execution."));
		const resident = state.registry.resident(state.sessionId, id);
		if (!resident) return Promise.reject(new SubagentV2Error("busy", `Child ${id} is not resident.`));
		if (resident.running) return Promise.reject(new SubagentV2Error("busy", `Child ${id} is already running.`));
		let limits: ChildBudgetLimits;
		let acceptance: readonly string[];
		try {
			acceptance = normalizeV2Acceptance(resident.contract.result.acceptance, options.acceptance);
			this.assertChildAuthority(resident.contract);
			if (
				record.lastTurnOutcome === "budget_exhausted" &&
				!Object.values(options.budgets ?? {}).some((value) => value !== undefined)
			)
				throw new SubagentV2Error("blocked", "Supply an explicit permitted budget to continue an exhausted child.");
			limits = resolveTurnBudget(resident.contract.budgets, options.budgets);
		} catch (error) {
			return Promise.reject(error);
		}
		const observations = new V2ResultObservations(
			childCwd(resident.contract, this.parent().sessionManager.getCwd()),
			resident.contract.capabilities.scopeRoots,
		);
		const resultContext: TurnResultContext = {
			acceptance,
			observations,
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
		};
		this.cancelRetire(state, id);
		resident.liveUsage = resultContext.usage;
		resident.admitted = false;
		state.registry.transition(state.sessionId, id, record.generation, record.state, { turnInFlight: true }, true);
		options.accepted?.();
		const controller = new AbortController();
		const cancel = () => controller.abort();
		options.signal?.addEventListener("abort", cancel, { once: true });
		if (options.signal?.aborted) cancel();
		const run = (async (): Promise<ChildTurnResult> => {
			const notes = [resident.recoveryNotice, resident.pendingNote].filter(Boolean);
			resident.recoveryNotice = undefined;
			resident.pendingNote = undefined;
			const instructions = renderV2ResultInstructions(resident.contract, acceptance);
			const prompt = redactCredentialText([...notes, text, instructions].filter(Boolean).join("\n\n"));
			let outcome: ChildTurnOutcome = "completed";
			let error: string | undefined;
			let unsubscribe: (() => void) | undefined;
			try {
				await this.acquire(state, controller.signal);
				resident.admitted = true;
			} catch {
				// A child stopped before it ever ran holds no work: remove it once this turn settles.
				const current = state.registry.get(state.sessionId, id);
				if (current.usage.turns === 0 && !current.patchState) void this.delete(id).catch(() => {});
				return this.finishTurn(
					state,
					resident,
					id,
					"cancelled",
					options.background === true,
					"Cancelled while queued.",
					resultContext,
				);
			}
			try {
				if (controller.signal.aborted || state.closed) throw new Error("Cancelled before child turn.");
				this.assertChildAuthority(resident.contract);
				resident.foreground = options.foreground;
				const record = state.registry.get(state.sessionId, id);
				state.registry.transition(state.sessionId, id, record.generation, "running", { turnInFlight: true }, true);
				dispatchSubagentHookObservation(resident.hooks, "subagent.started", {
					agent: resident.contract.agent.name,
				});
				controller.signal.addEventListener("abort", () => void resident.session.abort().catch(() => {}), {
					once: true,
				});
				resident.budget = new ChildTurnBudget(
					resident.session,
					limits,
					() => {
						if (state.closed) throw new Error("Child owner was shut down.");
						this.assertChildAuthority(resident.contract);
					},
					controller.signal,
					this.host.now,
				);
				resident.observations = observations;
				unsubscribe = resident.session.subscribe((event) => {
					const assistant =
						event.type === "message_end" && event.message.role === "assistant" ? event.message : undefined;
					if (assistant) resultContext.final = assistant;
					const usage = assistant?.usage ?? (event.type === "compaction_end" ? event.result?.usage : undefined);
					if (!usage) return;
					resultContext.usage.inputTokens += usage.input;
					resultContext.usage.outputTokens += usage.output;
					resultContext.usage.cacheReadTokens = (resultContext.usage.cacheReadTokens ?? 0) + usage.cacheRead;
					resultContext.usage.cacheWriteTokens = (resultContext.usage.cacheWriteTokens ?? 0) + usage.cacheWrite;
					resultContext.usage.cost += usage.cost.total;
					this.host.onChildActivity?.();
				});
				await resident.session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
				if (controller.signal.aborted) outcome = "cancelled";
				const last = resultContext.final;
				if (!controller.signal.aborted && last?.role === "assistant" && last.stopReason === "error") {
					outcome = "failed";
					error = last.errorMessage ?? "child model error";
				}
				if (
					!controller.signal.aborted &&
					v2ReportMode(resident.contract, acceptance) === "structured_report" &&
					last?.role === "assistant" &&
					last.stopReason !== "stop"
				) {
					outcome = "failed";
					error ??= "Structured report did not end with a complete final response.";
				}
			} catch (caught) {
				outcome = controller.signal.aborted ? "cancelled" : "failed";
				error = caught instanceof Error ? caught.message : String(caught);
			} finally {
				try {
					if (resident.budget?.interrupted() && !controller.signal.aborted && !state.closed) {
						outcome = "budget_exhausted";
						error = await resident.budget.wrapUp(controller.signal);
					}
					if (controller.signal.aborted || state.closed) outcome = "cancelled";
				} finally {
					unsubscribe?.();
					resident.observations = undefined;
					resident.budget?.dispose();
					resident.budget = undefined;
					state.admission.release();
					resident.foreground = false;
				}
			}
			if (outcome === "completed" && resident.hooks) {
				try {
					await dispatchSubagentHookDecision(resident.hooks, "subagent.beforeAccept", {
						agent: resident.contract.agent.name,
						outcome,
					});
				} catch (caught) {
					outcome = "failed";
					error = caught instanceof Error ? caught.message : String(caught);
				}
			}
			dispatchSubagentHookObservation(
				resident.hooks,
				outcome === "completed"
					? "subagent.completed"
					: outcome === "cancelled"
						? "subagent.cancelled"
						: outcome === "budget_exhausted"
							? "subagent.timedOut"
							: "subagent.failed",
				{ agent: resident.contract.agent.name, outcome, ...(error ? { error } : {}) },
			);
			await flushSubagentHookObservations(resident.hooks);
			return this.finishTurn(state, resident, id, outcome, options.background === true, error, resultContext);
		})().finally(() => {
			options.signal?.removeEventListener("abort", cancel);
			resident.running = undefined;
			this.scheduleRetire(state, id);
			void this.parkExcessResidents(state).catch(() => {});
		});
		resident.running = run;
		resident.controller = controller;
		return run;
	}

	private captureOutput(ownerSessionId: string, childId: string, rawText: string): SubagentOutput {
		let output: SubagentOutput;
		try {
			output = this.outputArtifacts.capture({ ownerSessionId, text: rawText });
		} catch {
			const inline = boundedText(redactCredentialText(rawText), SUBAGENT_OUTPUT_ARTIFACT_LIMITS.inlineBytes);
			return {
				text: inline.text,
				textBytes: Buffer.byteLength(inline.text, "utf8"),
				originalBytes: Buffer.byteLength(rawText, "utf8"),
				inlineTruncated: inline.truncated,
				captureStatus: inline.truncated ? "artifact_unavailable" : "inline_complete",
			};
		}
		if (!output.artifact) return output;
		let retained = false;
		try {
			retained = this.outputArtifacts.retainDurable(
				ownerSessionId,
				output.artifact,
				durableOutputReferenceId(childId),
			);
		} catch {
			retained = false;
		}
		if (retained) return output;
		try {
			this.outputArtifacts.release({ ownerSessionId, artifactId: output.artifact.id });
		} catch {
			// The persisted result remains explicit if storage cleanup is unavailable.
		}
		const { text, ...metadata } = output;
		return { text, ...outputArtifactUnavailable(metadata) };
	}

	private releaseOutputArtifact(ownerSessionId: string, childId: string, output: V2OutputCapture | undefined): void {
		if (!output?.artifact || !isSubagentOutputArtifactRef(output.artifact)) return;
		try {
			this.outputArtifacts.release({
				ownerSessionId,
				artifactId: output.artifact.id,
				referenceId: durableOutputReferenceId(childId),
			});
		} catch {
			// Result retention is authoritative; cleanup is best-effort.
		}
	}

	private async finishTurn(
		state: OwnerState,
		resident: ResidentChild,
		id: string,
		outcome: ChildTurnOutcome,
		background: boolean,
		error: string | undefined,
		resultContext: TurnResultContext,
	): Promise<ChildTurnResult> {
		// The turn usage moves into the record below; drop the live view so it is not counted twice.
		resident.liveUsage = undefined;
		resident.admitted = undefined;
		const { inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0, cost } = resultContext.usage;
		const rawFinalText =
			resultContext.final?.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("") ?? "";
		const finalText = redactCredentialText(rawFinalText);
		const validation = validateV2Result(
			resident.contract,
			resultContext.acceptance,
			finalText,
			outcome,
			resultContext.observations,
		);
		if (outcome === "completed" && validation.reportMode === "structured_report" && !validation.verified) {
			outcome = "failed";
			error = validation.reason;
		}
		const record = state.registry.get(state.sessionId, id);
		const previousOutput = record.lastResult?.output;
		const output = this.captureOutput(state.sessionId, id, rawFinalText);
		const { text: _inlineText, ...outputMetadata } = output;
		const result: ChildTurnResult = {
			id,
			agent: resident.contract.agent.name,
			outcome,
			text: output.text,
			truncated: output.inlineTruncated,
			output: outputMetadata,
			usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost },
			validation,
			...(error ? { error: redactCredentialText(error) } : {}),
		};
		const usage = {
			inputTokens: record.usage.inputTokens + inputTokens,
			outputTokens: record.usage.outputTokens + outputTokens,
			cacheReadTokens: (record.usage.cacheReadTokens ?? 0) + cacheReadTokens,
			cacheWriteTokens: (record.usage.cacheWriteTokens ?? 0) + cacheWriteTokens,
			cost: record.usage.cost + cost,
			turns: record.usage.turns + 1,
		};
		const target =
			record.state === "starting" || record.state === "running" || record.state === "stopping"
				? "idle"
				: record.state;
		// Billing precedes the durable transition so its flush covers both; a crash cannot drop spent usage.
		if (inputTokens || outputTokens || cacheReadTokens || cacheWriteTokens || cost) {
			state.journal.append("subagent_usage", {
				childId: id,
				agent: result.agent,
				usage: {
					input: inputTokens,
					output: outputTokens,
					cacheRead: cacheReadTokens,
					cacheWrite: cacheWriteTokens,
					cost,
				},
			});
		}
		try {
			if (record.state === "starting") {
				const running = state.registry.transition(state.sessionId, id, record.generation, "running");
				state.registry.transition(
					state.sessionId,
					id,
					running.generation,
					"idle",
					{ turnInFlight: false, lastTurnOutcome: outcome, usage, lastResult: result },
					true,
				);
			} else {
				state.registry.transition(
					state.sessionId,
					id,
					record.generation,
					target,
					{ turnInFlight: false, lastTurnOutcome: outcome, usage, lastResult: result },
					true,
				);
			}
		} catch (caught) {
			this.releaseOutputArtifact(state.sessionId, id, result.output);
			throw caught;
		}
		this.releaseOutputArtifact(state.sessionId, id, previousOutput);
		if (resident.contract.isolation.mode === "worktree") {
			const { repoRoot, worktreePath } = resident.contract.isolation;
			try {
				const { baseline } = this.worktreeOf(id);
				if (computeChildDelta(baseline, worktreePath!).empty) {
					state.registry.setPatchState(state.sessionId, id, "unchanged");
					await state.registry.park(state.sessionId, id);
					removeIsolatedWorktree(repoRoot!, worktreePath!);
				}
			} catch (cleanup) {
				result.error = redactCredentialText(`Automatic worktree cleanup needs inspection: ${String(cleanup)}`);
				const current = state.registry.get(state.sessionId, id);
				state.registry.transition(
					state.sessionId,
					id,
					current.generation,
					current.state,
					{ lastResult: result },
					true,
				);
			}
		}
		const detached = resident.detached === true;
		resident.detached = false;
		if (background || detached) this.deliverCompletion(state, result);
		return result;
	}

	private cancelRetire(state: OwnerState, id: string): void {
		const timer = state.retireTimers.get(id);
		if (timer) clearTimeout(timer);
		state.retireTimers.delete(id);
	}

	private scheduleRetire(state: OwnerState, id: string): void {
		this.cancelRetire(state, id);
		const timer = setTimeout(() => {
			state.retireTimers.delete(id);
			void this.retire(state, id).catch(() => {});
		}, RETIRE_GRACE_MS);
		timer.unref?.();
		state.retireTimers.set(id, timer);
	}

	/** Park a settled child that nothing is using; a displayed child is checked again later. */
	private async retire(state: OwnerState, id: string): Promise<void> {
		if (state.closed || this.owner !== state) return;
		let record: ChildRecord;
		try {
			record = state.registry.get(state.sessionId, id);
		} catch {
			return; // Deleted meanwhile.
		}
		const resident = state.registry.resident(state.sessionId, id);
		if (record.state !== "idle" || !resident || resident.running || resident.foreground) return;
		if (this.patchOperations.has(id) || this.host.isDisplayed?.(id)) {
			this.scheduleRetire(state, id);
			return;
		}
		await state.registry.park(state.sessionId, id);
	}

	/**
	 * Keep at most MAX_RESIDENT_CHILDREN idle children in memory per owner by
	 * parking the least recently used ones (plan 11.4). Parked children keep their
	 * transcript and contract on disk and revive on the next continuation.
	 */
	private async parkExcessResidents(state: OwnerState): Promise<void> {
		const idle = state.registry
			.list(state.sessionId)
			.filter((record) => {
				if (record.state !== "idle" || this.patchOperations.has(record.id)) return false;
				const resident = state.registry.resident(state.sessionId, record.id);
				return resident !== undefined && !resident.running && !resident.foreground;
			})
			.sort((left, right) => left.updatedAt - right.updatedAt);
		for (const record of idle.slice(0, Math.max(0, idle.length - MAX_RESIDENT_CHILDREN))) {
			try {
				await state.registry.park(state.sessionId, record.id);
			} catch {
				// It changed state since the scan; leave it.
			}
		}
	}

	private deliverCompletion(state: OwnerState, result: ChildTurnResult): void {
		const deliveryId = `${result.id}:${state.registry.get(state.sessionId, result.id).usage.turns}`;
		const text = result.error ? `${result.error}\n\n${result.text}` : result.text;
		const marker = `\n[Report truncated at 16 KiB; read the full report with agent_control action=output id=${result.id} offset=${COMPLETION_SUMMARY_LIMIT}]`;
		const bounded = boundedText(
			text,
			Buffer.byteLength(text) > COMPLETION_SUMMARY_LIMIT
				? COMPLETION_SUMMARY_LIMIT - Buffer.byteLength(marker) + Buffer.byteLength("\n[truncated]")
				: COMPLETION_SUMMARY_LIMIT,
		);
		const kept = bounded.truncated ? bounded.text.slice(0, -"\n[truncated]".length) : bounded.text;
		const reportOffset = Math.max(
			0,
			Buffer.byteLength(kept) - (result.error ? Buffer.byteLength(`${result.error}\n\n`) : 0),
		);
		const summary = bounded.truncated
			? `${kept}\n[Report truncated at 16 KiB; read the full report with agent_control action=output id=${result.id} offset=${reportOffset}]`
			: kept;
		state.registry.recordCompletion({
			deliveryId,
			childId: result.id,
			ownerSessionId: state.sessionId,
			agent: result.agent,
			outcome: result.outcome,
			summary,
			...(result.validation
				? {
						validation: {
							reportMode: result.validation.reportMode,
							verified: result.validation.verified,
							assurance: result.validation.assurance,
							reason: result.validation.reason,
						},
					}
				: {}),
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
						content: `Subagent ${claimed.agent}${this.childName(state, claimed.childId)} (${claimed.childId}) finished: ${claimed.outcome}.${claimed.validation ? `\nAssurance: ${claimed.validation.assurance}; ${claimed.validation.reason}` : ""}\n\nUntrusted child report:\n${claimed.summary}\n\n${this.completionTrailer(state, claimed.childId)}`,
						display: true,
						details: {
							childId: claimed.childId,
							agent: claimed.agent,
							outcome: claimed.outcome,
							...(claimed.validation ? { validation: claimed.validation } : {}),
						},
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				)
				.catch(() => {});
		}
	}

	/** ` "name"` for a named child, else empty. */
	private childName(state: OwnerState, childId: string): string {
		try {
			const name = state.registry.get(state.sessionId, childId).name;
			return name ? ` "${name}"` : "";
		} catch {
			return ""; // Deleted meanwhile.
		}
	}

	/** Next actions for a finished child, and which of its siblings are still working. */
	private completionTrailer(state: OwnerState, childId: string): string {
		const working = state.registry
			.list(state.sessionId)
			.filter((record) => record.id !== childId && state.registry.resident(state.sessionId, record.id)?.running)
			.map((record) => record.name ?? record.id);
		const siblings =
			working.length > 0
				? `${working.length} other subagent${working.length === 1 ? " is" : "s are"} still running (${working.slice(0, 8).join(", ")}${working.length > 8 ? `, and ${working.length - 8} more; agent_control action=list shows all` : ""}); their results arrive as separate messages.`
				: "No other subagents are running.";
		return [
			`Full result: agent_control action=output id=${childId}.`,
			`Next: continue it with resume=${childId} if its context helps, or delete it with agent_control action=delete id=${childId} when you no longer need it.`,
			siblings,
		].join("\n");
	}

	// --- continuation and control ----------------------------------------

	/** Resolve hooks under current settings; invalid hook configuration refuses the child. */
	private hooksFor(contract: ChildRuntimeContract, code: "preflight" | "blocked"): SubagentHookRuntime | undefined {
		try {
			return this.host.createHookRuntime?.({
				projectTrusted: this.host.isProjectTrusted(),
				role: contract.agent.name,
				...(contract.agent.hooks ? { roleHookIds: contract.agent.hooks } : {}),
				cwd: childCwd(contract, this.parent().sessionManager.getCwd()),
				readOnly: contract.capabilities.agentMode === "plan" || contract.capabilities.agentMode === "review",
				ownerSessionId: contract.ownerSessionId,
				runId: contract.id,
			});
		} catch (error) {
			throw new SubagentV2Error(code, `Subagent hooks: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private assertChildAuthority(contract: ChildRuntimeContract): void {
		const parent = this.parent();
		const validation = validateChildResume(contract, {
			ownerSessionId: parent.sessionId,
			parentTools: parentToolInfos(parent, this.host.getAdapters()),
			subYolo: this.host.isSubYolo(),
			parentMode: this.host.getParentMode(),
			modelAvailable: (provider, model) =>
				(provider === parent.model?.provider && model === parent.model?.id) ||
				(parent.modelRuntime.getModel(provider, model) !== undefined &&
					parent.modelRuntime.hasConfiguredAuth(provider)),
			tombstoned: false,
		});
		const reasons = validation.ok ? [] : [...validation.reasons];
		if (this.host.getSettings().diagnostics.length) reasons.push("invalid parent settings");
		if (contract.isolation.mode === "worktree" && !this.host.isProjectTrusted())
			reasons.push("project trust was revoked");
		if (
			contract.capabilities.parentPolicyHash &&
			contract.capabilities.parentPolicyHash !==
				createHash("sha256").update(JSON.stringify(this.host.getSettings().ruleSets)).digest("hex")
		)
			reasons.push("parent permission policy changed; the frozen child cannot be silently reauthorized");
		const resources = contract.prompt.resources;
		if (resources) {
			const selected = [...resources.skills, ...resources.prompts, ...resources.context];
			if (selected.some((resource) => resource.source === "project") && !this.host.isProjectTrusted())
				reasons.push("project trust for selected resources was revoked");
			try {
				revalidateSubagentResources(resources);
			} catch (error) {
				reasons.push(error instanceof Error ? error.message : String(error));
			}
		}
		if (reasons.length)
			throw new SubagentV2Error("blocked", `Child ${contract.id} cannot run: ${reasons.join("; ")}`);
	}

	/** Bring a parked/blocked child back under its frozen contract, or report why it cannot run. */
	async revive(id: string): Promise<void> {
		const state = this.state();
		const parent = this.parent();
		const patchState = state.registry.get(state.sessionId, id).patchState;
		if (this.patchOperations.has(id) || (patchState && patchState !== "open"))
			throw new SubagentV2Error("blocked", "A patch decision prevents child revival.");
		const handle = await state.registry.revive(state.sessionId, id, async (record) => {
			const opened = openChildSession(record.transcriptPath, record.contractHash);
			const worktree = opened.contract.isolation.worktreePath;
			if (opened.contract.isolation.mode === "worktree" && (!worktree || !existsSync(worktree)))
				return { blocked: ["the child's worktree no longer exists"] };
			try {
				this.assertChildAuthority(opened.contract);
				if (worktree) assertOwnedWorktree(opened.contract.isolation.repoRoot!, worktree);
			} catch (error) {
				return { blocked: [error instanceof Error ? error.message : String(error)] };
			}
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
	async continueChild(
		id: string,
		text: string,
		options: {
			foreground: boolean;
			budgets?: ChildBudgetLimits;
			acceptance?: readonly string[];
			accepted?: () => void;
			signal?: AbortSignal;
		},
	): Promise<ChildTurnResult> {
		const state = this.state();
		const record = state.registry.get(state.sessionId, id);
		if (this.patchOperations.has(id)) throw new SubagentV2Error("busy", "A patch operation is in progress.");
		if (record.patchState && record.patchState !== "open")
			throw new SubagentV2Error(
				"blocked",
				`Child ${id}'s worktree patch was ${record.patchState}; start a new child.`,
			);
		if (
			record.lastTurnOutcome === "budget_exhausted" &&
			!Object.values(options.budgets ?? {}).some((value) => value !== undefined)
		)
			throw new SubagentV2Error("blocked", "Supply an explicit permitted budget to continue an exhausted child.");
		const contract = this.contractOf(id).contract;
		normalizeV2Acceptance(contract.result.acceptance, options.acceptance);
		resolveTurnBudget(contract.budgets, options.budgets);
		if (record.state === "parked" || record.state === "blocked") await this.revive(id);
		return this.runTurn(id, text, { ...options, background: !options.foreground });
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
			this.assertContinuationAvailable(id);
			void this.continueChild(id, message, { foreground: false }).catch(() => {});
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
		this.assertContinuationAvailable(id);
		void this.continueChild(id, message, { foreground: false }).catch(() => {});
		return "Follow-up turn started; completion will be delivered when it finishes.";
	}

	private assertContinuationAvailable(id: string): void {
		const { record, contract } = this.contractOf(id);
		if (this.patchOperations.has(id) || (record.patchState && record.patchState !== "open"))
			throw new SubagentV2Error("blocked", "The patch is no longer open.");
		if (this.registry.resident(this.ownerSessionId(), id)?.running)
			throw new SubagentV2Error("busy", "Child already has a turn in flight.");
		if (record.lastTurnOutcome === "budget_exhausted")
			throw new SubagentV2Error("blocked", "Use agent resume with an explicit permitted budget after exhaustion.");
		this.assertChildAuthority(contract);
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
		if (this.patchOperations.has(id)) throw new SubagentV2Error("busy", "Patch integration is in progress.");
		const patchState = this.registry.get(this.ownerSessionId(), id).patchState;
		if (patchState === "applying" || patchState === "rollback_conflict")
			throw new SubagentV2Error(
				"blocked",
				"Inspect unresolved parent integration effects before deleting child recovery data.",
			);
		await this.stop(id);
		const state = this.state();
		this.cancelRetire(state, id);
		await state.registry.delete(state.sessionId, id, async (record) => {
			try {
				const contract = openChildSession(record.transcriptPath, record.contractHash).contract;
				const { repoRoot, worktreePath } = contract.isolation;
				if (repoRoot && worktreePath && existsSync(worktreePath)) removeIsolatedWorktree(repoRoot, worktreePath);
			} finally {
				this.releaseOutputArtifact(state.sessionId, id, record.lastResult?.output);
			}
		});
	}

	// --- worktree patches ---------------------------------------------------

	private contractOf(id: string): { record: ChildRecord; contract: ChildRuntimeContract } {
		const state = this.state();
		const record = state.registry.get(state.sessionId, id);
		return {
			record,
			contract:
				state.registry.resident(state.sessionId, id)?.contract ??
				openChildSession(record.transcriptPath, record.contractHash).contract,
		};
	}

	private worktreeOf(id: string): { record: ChildRecord; contract: ChildRuntimeContract; baseline: WorktreeBaseline } {
		const { record, contract } = this.contractOf(id);
		const isolation = contract.isolation;
		if (
			isolation.mode !== "worktree" ||
			!isolation.worktreePath ||
			!isolation.repoRoot ||
			!isolation.baselineId ||
			!isolation.baselineTree ||
			!isolation.headCommit
		)
			throw new SubagentV2Error("preflight", `Child ${id} does not run in a worktree; it has no patch.`);
		return {
			record,
			contract,
			baseline: {
				repoRoot: isolation.repoRoot,
				headCommit: isolation.headCommit,
				baselineCommit: isolation.baselineId,
				baselineTree: isolation.baselineTree,
				cwdOffset: isolation.cwdOffset ?? "",
			},
		};
	}

	private assertPatchOpen(record: ChildRecord): void {
		if (record.patchState && record.patchState !== "open")
			throw new SubagentV2Error("blocked", `The patch of child ${record.id} was already ${record.patchState}.`);
		if (
			record.turnInFlight ||
			this.patchOperations.has(record.id) ||
			record.state === "running" ||
			record.state === "starting" ||
			record.state === "stopping"
		)
			throw new SubagentV2Error("busy", `Child ${record.id} is still running; wait or stop it first.`);
	}

	private patchDirectory(id: string): string {
		const parent = this.parent();
		return join(childSessionDirectory(parent.sessionManager.getSessionDir(), parent.sessionId), "patches", id);
	}

	inspectPatch(id: string): {
		state: ChildRecord["patchState"];
		delta?: ChildDelta;
		artifactRef?: string;
		recoveryRef?: string;
	} {
		const { record, contract, baseline } = this.worktreeOf(id);
		if (record.patchState !== "open")
			return {
				state: record.patchState,
				artifactRef: record.patchArtifact?.patchRef,
				recoveryRef: record.patchRecoveryRef,
			};
		this.assertPatchOpen(record);
		const delta = computeChildDelta(baseline, contract.isolation.worktreePath!);
		const artifact = persistWorktreePatch(
			this.patchDirectory(id),
			baseline,
			contract.isolation.worktreePath!,
			record.contractHash,
			delta,
		);
		this.registry.setPatchState(record.ownerSessionId, id, "open", artifact);
		return { state: "open", delta, artifactRef: artifact.patchRef };
	}

	/** Inspect-first, verified integration. Pending intent is never replayed after restart. */
	async applyPatch(
		id: string,
		signal?: AbortSignal,
	): Promise<(ApplyOutcome | { status: "already"; patchState: string }) & { cleanupError?: string }> {
		const state = this.state();
		const { record, contract, baseline } = this.worktreeOf(id);
		if (record.patchState === "applied" || record.patchState === "rejected" || record.patchState === "unchanged")
			return { status: "already", patchState: record.patchState };
		this.assertPatchOpen(record);
		if (!record.patchArtifact) throw new SubagentV2Error("preflight", "Inspect this patch before applying it.");
		const verifier = this.host.getPatchVerifier?.() ?? this.host.verifyPatch;
		const delta = validateWorktreePatch(record.patchArtifact, this.patchDirectory(id), baseline, record.contractHash);
		if (computeChildDelta(baseline, contract.isolation.worktreePath!).finalTree !== delta.finalTree)
			throw new SubagentV2Error("blocked", "Child worktree changed after inspection; inspect the new patch first.");
		const scopeRoots = contract.capabilities.scopeRoots.map((root) =>
			resolve(baseline.repoRoot, relative(contract.isolation.worktreePath!, root)),
		);
		const authorize = () => {
			if (signal?.aborted || state.closed) throw new SubagentV2Error("blocked", "Patch apply was cancelled.");
			const parent = this.parent();
			if (
				parent.sessionId !== state.sessionId ||
				this.host.getParentMode() !== "build" ||
				!this.host.isProjectTrusted() ||
				!parent.getActiveToolNames().includes("agent_patch")
			)
				throw new SubagentV2Error("blocked", "Patch apply requires the current owner's trusted build authority.");
			if (!pathIsWithin(baseline.repoRoot, realpathSync(parent.sessionManager.getCwd())))
				throw new SubagentV2Error("blocked", "Parent workspace no longer matches this patch.");
			for (const { path } of delta.changedPaths) {
				const subjects = extractPermissionSubjects({
					tool: "write",
					args: { path: resolve(baseline.repoRoot, path) },
					cwd: baseline.repoRoot,
				});
				if (subjects.some((subject) => this.parentDecision(parent, subject) !== "allow"))
					throw new SubagentV2Error("blocked", `Parent permission does not allow patch path ${path}.`);
			}
		};
		authorize();
		assertOwnedWorktree(baseline.repoRoot, contract.isolation.worktreePath!);
		this.patchOperations.add(id);
		try {
			const outcome = await applyChildDelta(baseline, delta.finalTree, {
				scopeRoots,
				authorize,
				...(verifier ? { verify: (root: string) => verifier(root, signal) } : {}),
				beforeWrite: (recovery) => {
					const recoveryRef = persistPatchRecovery(this.patchDirectory(id), recovery);
					state.registry.setPatchState(state.sessionId, id, "applying", undefined, recoveryRef);
				},
				commit: () => state.registry.setPatchState(state.sessionId, id, delta.empty ? "unchanged" : "applied"),
			});
			if (outcome.status === "rollback_conflict")
				state.registry.setPatchState(state.sessionId, id, "rollback_conflict");
			else if (outcome.status === "verification_failed") state.registry.setPatchState(state.sessionId, id, "open");
			if (outcome.status === "applied" || outcome.status === "empty") {
				try {
					const current = state.registry.get(state.sessionId, id);
					if (current.state === "idle") await state.registry.park(state.sessionId, id);
					removeIsolatedWorktree(baseline.repoRoot, contract.isolation.worktreePath!);
				} catch (error) {
					return { ...outcome, cleanupError: String(error) };
				}
			}
			return outcome;
		} finally {
			this.patchOperations.delete(id);
		}
	}

	rejectPatch(id: string): { status: "rejected" | "already"; patchState: string } {
		const state = this.state();
		const { record, contract, baseline } = this.worktreeOf(id);
		if (record.patchState === "applied" || record.patchState === "rejected" || record.patchState === "unchanged")
			return { status: "already", patchState: record.patchState };
		this.assertPatchOpen(record);
		assertOwnedWorktree(baseline.repoRoot, contract.isolation.worktreePath!);
		state.registry.setPatchState(state.sessionId, id, "rejected");
		removeIsolatedWorktree(baseline.repoRoot, contract.isolation.worktreePath!);
		return { status: "rejected", patchState: "rejected" };
	}

	async shutdown(): Promise<void> {
		const owner = this.owner;
		if (!owner) return;
		owner.closed = true;
		for (const timer of owner.retireTimers.values()) clearTimeout(timer);
		owner.retireTimers.clear();
		owner.broker.dispose();
		const runs: Promise<ChildTurnResult>[] = [];
		for (const record of owner.registry.list(owner.sessionId)) {
			const resident = owner.registry.resident(owner.sessionId, record.id);
			resident?.controller?.abort();
			if (resident?.running) runs.push(resident.running);
		}
		await Promise.allSettled(runs);
		await owner.registry.disposeAll();
		this.owner = undefined;
	}

	outputOf(id: string): ChildTurnResult | undefined {
		const state = this.state();
		const record = state.registry.get(state.sessionId, id);
		if (record.lastResult) return structuredClone(record.lastResult);
		if (record.lastTurnOutcome === "interrupted") return undefined;
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
			const bounded = boundedText(redactCredentialText(text), RESULT_TEXT_LIMIT);
			return {
				id,
				agent: record.agent,
				outcome: record.lastTurnOutcome ?? "completed",
				text: bounded.text,
				truncated: bounded.truncated,
				validation: {
					reportMode: "plain_final_turn",
					verified: false,
					assurance: "unverified_plain",
					reason: "Historical transcript projection: no host-validated result snapshot; claims are unverified.",
					paths: [],
					requirements: [],
				},
				usage: {
					inputTokens: record.usage.inputTokens,
					outputTokens: record.usage.outputTokens,
					cacheReadTokens: record.usage.cacheReadTokens ?? 0,
					cacheWriteTokens: record.usage.cacheWriteTokens ?? 0,
					cost: record.usage.cost,
				},
			};
		}
		return undefined;
	}

	readOutput(
		id: string,
		range: { offset?: number; length?: number } = {},
	): SubagentOutputRead | Omit<SubagentOutputRead, "artifactId"> {
		const state = this.state();
		const result = this.outputOf(id);
		if (!result) {
			throw new SubagentOutputArtifactError("artifact_not_found", "Subagent output artifact was not found.");
		}
		if (!result.output?.artifact || !isSubagentOutputArtifactRef(result.output.artifact)) {
			const offset = range.offset ?? 0;
			const length = range.length ?? SUBAGENT_OUTPUT_ARTIFACT_LIMITS.defaultReadBytes;
			if (
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				!Number.isSafeInteger(length) ||
				length < 1 ||
				length > SUBAGENT_OUTPUT_ARTIFACT_LIMITS.maxReadBytes
			) {
				throw new SubagentOutputArtifactError("artifact_offset_invalid", "Output read range is invalid.");
			}
			const bytes = Buffer.from(result.text);
			if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)) {
				throw new SubagentOutputArtifactError(
					"artifact_offset_invalid",
					"Output offset must be on a UTF-8 boundary.",
				);
			}
			let end = Math.min(bytes.length, offset + length);
			while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
			if (end === offset && end < bytes.length) {
				throw new SubagentOutputArtifactError(
					"artifact_offset_invalid",
					"Read length is too small for a UTF-8 code point.",
				);
			}
			return {
				offset,
				bytesRead: end - offset,
				totalBytes: bytes.length,
				nextOffset: end,
				eof: end === bytes.length,
				contentType: "text/plain",
				text: bytes.subarray(offset, end).toString("utf8"),
				sha256: createHash("sha256").update(bytes).digest("hex"),
				truncated: result.truncated,
			};
		}
		return this.outputArtifacts.read({
			ownerSessionId: state.sessionId,
			artifactId: result.output.artifact.id,
			...range,
		});
	}

	respondToApproval(id: string, answer: ApprovalAnswer): boolean {
		return this.state().broker.respond(id, answer);
	}

	/** Footer, Agent Hub, and RPC projection; the registry stays the only lifecycle owner. */
	overview(): IceSubagentOverview {
		const state = this.state();
		const settings = this.host.getSettings();
		const children = state.registry.list(state.sessionId).map((record): IceSubagentOverviewChild => {
			const resident = state.registry.resident(state.sessionId, record.id);
			const live = resident?.liveUsage;
			return {
				id: record.id,
				agent: record.agent,
				...(record.name ? { name: record.name } : {}),
				description: record.description,
				// A turn waiting for an admission slot is queued, whatever the instance state.
				state: resident?.running && resident.admitted === false ? "queued" : record.state,
				...(record.lastTurnOutcome ? { lastTurnOutcome: record.lastTurnOutcome } : {}),
				depth: record.depth,
				running: resident?.running !== undefined,
				background: resident?.running !== undefined && !resident.foreground,
				resident: resident !== undefined,
				finished: record.state === "parked",
				turns: record.usage.turns,
				tokens:
					record.usage.inputTokens + record.usage.outputTokens + (live ? live.inputTokens + live.outputTokens : 0),
				cost: record.usage.cost + (live?.cost ?? 0),
				...(record.patchState ? { patchState: record.patchState } : {}),
				...(record.blockedReasons?.length ? { blockedReasons: record.blockedReasons } : {}),
			};
		});
		return {
			enabled: settings.enabled && settings.diagnostics.length === 0,
			capacity: { running: state.admission.active, queued: state.waiters.length, max: state.admission.capacity },
			maxDepth: settings.maxDepth,
			children,
			approvals: state.broker.pending.map(({ request, queuedAt, deadline }) => ({
				id: request.id,
				childId: request.childId,
				agent: request.agent,
				tool: request.tool,
				summary: request.summary,
				...(request.sessionRule ? { sessionRule: request.sessionRule } : {}),
				foreground: request.foreground,
				queuedAt,
				deadline,
			})),
			diagnostics: settings.diagnostics,
		};
	}

	/** Agent Hub inspector lines for one child, from its frozen contract and latest result. */
	describeChild(id: string): string[] {
		const { record, contract } = this.contractOf(id);
		const live = this.registry.resident(this.ownerSessionId(), id)?.liveUsage;
		const tokens =
			record.usage.inputTokens + record.usage.outputTokens + (live ? live.inputTokens + live.outputTokens : 0);
		const cost = record.usage.cost + (live?.cost ?? 0);
		const { capabilities, model, isolation, budgets } = contract;
		const budget = [
			budgets.maxTurns ? `${budgets.maxTurns} turns` : "",
			budgets.maxTokens ? `${budgets.maxTokens} tokens` : "",
			budgets.timeoutMs ? `${Math.round(budgets.timeoutMs / 1000)}s` : "",
		].filter(Boolean);
		const lines = [
			`Task: ${record.description}`,
			`Agent: ${contract.agent.name} (${contract.agent.source})`,
			`Model: ${model.provider}/${model.model} · thinking ${model.thinking}`,
			`Tools: ${capabilities.tools.map((tool) => tool.name).join(", ") || "none"}`,
			`Permissions: ${capabilities.agentMode}${capabilities.subYolo ? " · sub-yolo" : ""} · parent ${capabilities.parentMode}`,
			`Scope: ${capabilities.scopeRoots.join(", ")}`,
			`Isolation: ${isolation.mode}${record.patchState ? ` · patch ${record.patchState}` : ""}`,
			`Budget: ${budget.join(" · ") || "none"}`,
			`Usage: ${record.usage.turns} turns${live ? " + 1 running" : ""} · ${tokens} tokens · ${cost.toFixed(4)}`,
		];
		const result = record.lastResult;
		if (result) {
			lines.push("", `Last turn: ${result.outcome}${result.validation ? ` · ${result.validation.assurance}` : ""}`);
			const preview = (result.error ?? result.text)
				.split("\n")
				.filter((line) => line.trim())
				.slice(0, 8);
			lines.push(...preview);
		}
		return lines;
	}

	/**
	 * The parent stopped waiting for these running children (Ctrl+B): their
	 * current turns continue, and each completion arrives as a follow-up.
	 */
	detachToBackground(ids: readonly string[]): number {
		const state = this.state();
		let detached = 0;
		for (const id of ids) {
			let resident: ResidentChild | undefined;
			try {
				resident = state.registry.resident(state.sessionId, id);
			} catch {
				continue; // Deleted or unknown since the wait began.
			}
			if (!resident?.running) continue;
			resident.detached = true;
			resident.foreground = false;
			detached++;
		}
		return detached;
	}

	pendingApprovals(): readonly PendingApproval[] {
		return this.state().broker.pending;
	}
}
