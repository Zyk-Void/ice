import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@zykairotis/ice-ai/compat";
import type { AgentSession } from "../../core/agent-session.ts";
import type { IceVerifierState } from "../../ice-safe-verify.ts";
import type { ChildRuntimeContract, NormalizedPermissionRule } from "../contract/child-runtime-contract.ts";
import type { AgentDefinitionSource } from "../definitions/schema.ts";
import { removeIsolatedWorktree, worktreeGit, worktreeSnapshotRef } from "../isolation/worktree.ts";
import type { ApprovalAnswer, ApprovalBroker, ApprovalRequest, PendingApproval } from "../permissions/approval.ts";
import type { PermissionRuleSet } from "../permissions/evaluate.ts";
import type { PermissionRuleScope } from "../permissions/rules.ts";
import type { SubagentConcurrencyAdmission } from "../registry/admission.ts";
import { openChildSession } from "../registry/child-sessions.ts";
import type { ChildRegistry } from "../registry/registry.ts";
import type { V2ChildTurnResult, V2OutputCapture, V2ResultObservations } from "../results/v2-result.ts";
import type { IceResolvedDelegableTool } from "../tools/adapters.ts";
import { ICE_BUILTIN_CHILD_TOOLS } from "../tools/adapters.ts";
import type { ParentToolInfo } from "../tools/resolve.ts";
import type { createV2ChildSession } from "./session-factory.ts";
import type { SubagentsV2Settings } from "./settings.ts";
import type { ChildTurnBudget } from "./turn-budget.ts";

export const SUBAGENT_COMPLETED_CUSTOM_TYPE = "subagent_completed";
export const RESULT_TEXT_LIMIT = 48 * 1024;
export const COMPLETION_SUMMARY_LIMIT = 4 * 1024;

export function durableOutputReferenceId(childId: string): string {
	return `durable:v2:${childId}`;
}

export function outputArtifactUnavailable(output: V2OutputCapture): V2OutputCapture {
	const { artifact: _artifact, ...inline } = output;
	return { ...inline, captureStatus: "artifact_unavailable" };
}

export const SOURCE_SCOPE: Readonly<Record<AgentDefinitionSource, PermissionRuleScope>> = {
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

export const READ_ONLY_BUILTINS = new Set(["read", "grep", "find", "ls"]);

export interface V2RuntimeHost {
	getParentSession(): AgentSession | undefined;
	agentDir: string;
	userAgentsDir: string;
	getSettings(): SubagentsV2Settings;
	isProjectTrusted(): boolean;
	getParentMode(): "plan" | "build";
	isSubYolo(): boolean;
	getAdapters(): readonly IceResolvedDelegableTool[];
	/** The host configures the verifier; child/model text cannot choose commands. */
	verifyPatch?: (root: string, signal?: AbortSignal) => Promise<IceVerifierState>;
	getPatchVerifier?: () => V2RuntimeHost["verifyPatch"];
	/** Foreground approval prompt; absent when the parent has no interactive UI. */
	promptApproval?: (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalAnswer>;
	/** True while an approval inbox (Agent Hub) is attached; background asks then wait instead of denying. */
	hasApprovalInbox?: () => boolean;
	/** Called whenever the set of pending approvals changes. */
	onApprovalsChanged?: (pending: readonly PendingApproval[]) => void;
	createChildAgentSession?: typeof createV2ChildSession;
	now?: () => number;
}

export interface ResidentChild {
	session: AgentSession;
	contract: ChildRuntimeContract;
	grants: string[];
	pendingNote?: string;
	recoveryNotice?: string;
	controller?: AbortController;
	budget?: ChildTurnBudget;
	observations?: V2ResultObservations;
	/** True while a parent tool call is waiting on this child's turn. */
	foreground: boolean;
	running?: Promise<ChildTurnResult>;
	dispose(): Promise<void>;
}

export type ChildTurnResult = V2ChildTurnResult;

export class SubagentV2Error extends Error {
	readonly code: "unknown_agent" | "preflight" | "blocked" | "busy";
	constructor(code: SubagentV2Error["code"], message: string) {
		super(message);
		this.code = code;
	}
}

export interface TurnResultContext {
	acceptance: readonly string[];
	observations: V2ResultObservations;
	final?: AssistantMessage;
	usage: ChildTurnResult["usage"];
}

export interface OwnerState {
	sessionId: string;
	registry: ChildRegistry<ResidentChild>;
	admission: SubagentConcurrencyAdmission;
	broker: ApprovalBroker;
	waiters: Array<() => void>;
	closed: boolean;
}

export function parentToolInfos(parent: AgentSession, adapters: readonly IceResolvedDelegableTool[]): ParentToolInfo[] {
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

export function splitModelReference(reference: string): { provider: string; model: string } | undefined {
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

export function ruleSetsFromFrozen(rules: readonly NormalizedPermissionRule[]): PermissionRuleSet[] {
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

export function freezeRules(sets: readonly PermissionRuleSet[]): NormalizedPermissionRule[] {
	const out: NormalizedPermissionRule[] = [];
	for (const set of sets)
		for (const decision of ["deny", "ask", "allow"] as const)
			for (const rule of set.rules[decision] ?? []) out.push({ rule, decision, scope: set.origin.scope });
	return out;
}

export function boundedText(text: string, limit: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text) <= limit) return { text, truncated: false };
	const marker = "\n[truncated]";
	let end = Math.max(0, limit - Buffer.byteLength(marker));
	const bytes = Buffer.from(text);
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return { text: `${bytes.subarray(0, end).toString("utf8")}${marker}`, truncated: true };
}

/**
 * Finish cleanup that a crash interrupted: a child whose patch reached a terminal
 * state (or that was deleted) must not keep its worktree or snapshot ref. Only
 * this owner's records are considered, removal stays ownership-checked, and
 * failures are left for inspection rather than forced.
 */
export function reconcileTerminalWorktrees(registry: ChildRegistry<ResidentChild>, ownerSessionId: string): void {
	for (const record of registry.list(ownerSessionId, { includeDeleted: true })) {
		const terminal =
			record.state === "deleted" ||
			record.patchState === "applied" ||
			record.patchState === "rejected" ||
			record.patchState === "unchanged";
		if (!terminal) continue;
		try {
			const { repoRoot, worktreePath } = openChildSession(record.transcriptPath, record.contractHash).contract
				.isolation;
			if (!repoRoot || !worktreePath) continue;
			if (existsSync(worktreePath)) removeIsolatedWorktree(repoRoot, worktreePath);
			else worktreeGit(repoRoot, ["update-ref", "-d", worktreeSnapshotRef(worktreePath)]);
		} catch {
			// Missing transcript, ownership mismatch, or git failure: leave it for inspection.
		}
	}
}

/** Working directory of a child: its worktree (plus the parent's offset) when isolated. */
export function childCwd(contract: ChildRuntimeContract, parentCwd: string): string {
	const { worktreePath, cwdOffset } = contract.isolation;
	if (contract.isolation.mode !== "worktree" || !worktreePath) return parentCwd;
	return cwdOffset ? join(worktreePath, cwdOffset) : worktreePath;
}

export const CHILD_PROMPT_SUFFIX =
	"\n\nYou are a subagent. You cannot see the parent conversation. Work only within your approved scope and tools. Your final message is returned to the parent agent as your result: make it a complete, self-contained report.";
