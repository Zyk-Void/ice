/**
 * Subagent V2 child permission derivation (Plan/subagent-rewrite.md sections 9.1, 9.4, 9.5, 9.7, P3.3/P3.6-P3.8).
 *
 * Invariant: for every subject, the child decision is never more permissive than
 * the parent decision for the same subject. On top of that, the child mutation
 * limit keeps edits, Bash, and mutation adapters at `ask` unless an explicit
 * raiser applies, and project-scope rules can only narrow.
 */
import { evaluatePermission, matchPermissionRules, modeLimit, type PermissionRuleSet } from "./evaluate.ts";
import {
	type AgentPermissionMode,
	type CeilingRaiser,
	CHILD_MUTATION_CEILING,
	type ChildMutationCeilingEntry,
	type ChildSubjectClass,
	mostRestrictiveDecision,
	type PermissionDecision,
} from "./rules.ts";
import type { PermissionSubject } from "./subjects.ts";

const CEILING = new Map<ChildSubjectClass, ChildMutationCeilingEntry>(
	CHILD_MUTATION_CEILING.map((entry) => [entry.subjectClass, entry]),
);

export interface ChildPermissionContext {
	/** Agent definition rules, settings `ice.subagents.permissions`, and call narrowing, each with its origin. */
	childRuleSets: readonly PermissionRuleSet[];
	/** The agent's permission preset. `bubble` changes approval routing only. */
	agentMode: AgentPermissionMode;
	/** Explicit `--sub-yolo` that passed every parent gate. */
	subYolo: boolean;
	/** Child runs in an isolated worktree. */
	worktree: boolean;
}

export interface ChildPermissionDecision {
	decision: PermissionDecision;
	/** Raiser that lifted the mutation limit, if any. */
	raisedBy?: CeilingRaiser;
}

function activeRaiser(
	entry: ChildMutationCeilingEntry,
	subject: PermissionSubject,
	context: ChildPermissionContext,
): CeilingRaiser | undefined {
	if (subject.opaque) return undefined;
	for (const raiser of entry.raisableBy) {
		if (raiser === "sub-yolo" && context.subYolo) return raiser;
		if (raiser === "worktree-isolation" && context.worktree) return raiser;
		if (raiser === "user-allow" || raiser === "managed-allow") {
			const scope = raiser === "user-allow" ? "user" : "managed";
			const allowed = matchPermissionRules(
				subject,
				context.childRuleSets.filter((set) => set.origin.scope === scope),
			).some((match) => match.decision === "allow");
			if (allowed) return raiser;
		}
	}
	return undefined;
}

export function deriveChildDecision(
	subject: PermissionSubject,
	parentDecision: PermissionDecision,
	context: ChildPermissionContext,
): ChildPermissionDecision {
	const entry = CEILING.get(subject.subjectClass);
	if (!entry) return { decision: "deny" };
	const base = entry.childDefault === "parent" ? parentDecision : entry.childDefault;
	const raisedBy = activeRaiser(entry, subject, context);
	let decision: PermissionDecision = raisedBy ? "allow" : mostRestrictiveDecision(base, entry.maxDecision);
	// Child rules can narrow (deny/ask); an allow only counts through a raiser above.
	const narrowing = evaluatePermission({
		subject,
		ruleSets: context.childRuleSets,
		fallback: "allow",
		mode: "inherit",
	});
	decision = mostRestrictiveDecision(decision, narrowing.decision);
	decision = mostRestrictiveDecision(decision, modeLimit(context.agentMode, subject.subjectClass));
	decision = mostRestrictiveDecision(decision, parentDecision);
	return decision === "allow" && raisedBy ? { decision, raisedBy } : { decision };
}

/** Section 9.4: management tools re-added to a child only under every recursion condition. */
export function childDelegationTools(input: {
	spawns: readonly string[];
	depth: number;
	maxDepth: number;
	parentHasAgentTool: boolean;
	parentDecisionForAgent: (name: string) => PermissionDecision;
}): { tools: readonly string[]; spawnable: readonly string[] } {
	if (!input.parentHasAgentTool || input.depth >= input.maxDepth) return { tools: [], spawnable: [] };
	const spawnable = input.spawns.filter((name) => input.parentDecisionForAgent(name) !== "deny");
	return spawnable.length > 0 ? { tools: ["agent", "agent_control"], spawnable } : { tools: [], spawnable: [] };
}
