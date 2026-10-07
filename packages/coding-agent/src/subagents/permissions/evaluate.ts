/**
 * Subagent V2 shared permission evaluator (Plan/subagent-rewrite.md sections 9.1-9.3, 9.5, P3.2).
 *
 * One evaluator for parent and children. Every matching rule across every rule
 * set is collected and the most restrictive wins (deny > ask > allow); with no
 * match the caller's default applies. A mode limit is then applied on top, and
 * plan/review limits cannot be raised by any rule, profile, or sub-yolo.
 */
import {
	type AgentPermissionMode,
	type ChildSubjectClass,
	globMatches,
	mostRestrictiveDecision,
	PERMISSION_DECISIONS,
	type PermissionDecision,
	type PermissionRuleLists,
	type PermissionRuleOrigin,
	parsePermissionRule,
} from "./rules.ts";
import type { PermissionSubject } from "./subjects.ts";

export interface PermissionRuleSet {
	origin: PermissionRuleOrigin;
	rules: PermissionRuleLists;
}

export interface PermissionMatch {
	rule: string;
	decision: PermissionDecision;
	origin: PermissionRuleOrigin;
}

export function ruleMatchesSubject(rule: string, subject: PermissionSubject): boolean {
	const parsed = parsePermissionRule(rule);
	if (!globMatches(parsed.tool, subject.tool)) return false;
	if (parsed.pattern === undefined) return true;
	if (subject.value === undefined) return false;
	return globMatches(parsed.pattern, subject.value, subject.pathMode);
}

/** All rules matching the subject, most restrictive first. */
export function matchPermissionRules(
	subject: PermissionSubject,
	ruleSets: readonly PermissionRuleSet[],
): PermissionMatch[] {
	const matches: PermissionMatch[] = [];
	for (const set of ruleSets) {
		for (const decision of PERMISSION_DECISIONS) {
			for (const rule of set.rules[decision] ?? []) {
				if (ruleMatchesSubject(rule, subject)) matches.push({ rule, decision, origin: set.origin });
			}
		}
	}
	return matches.sort(
		(left, right) => PERMISSION_DECISIONS.indexOf(left.decision) - PERMISSION_DECISIONS.indexOf(right.decision),
	);
}

/** Mode limit per subject class. `inherit`, `build`, and `bubble` do not narrow. */
export function modeLimit(
	mode: AgentPermissionMode | "plan" | "build",
	subjectClass: ChildSubjectClass,
): PermissionDecision {
	if (mode !== "plan" && mode !== "review") return "allow";
	switch (subjectClass) {
		case "read":
			return "allow";
		case "bash":
		case "external-directory":
		case "delegation":
			return "ask";
		case "edit-write":
		case "mutation-adapter":
			return "deny";
	}
}

export interface PermissionEvaluation {
	decision: PermissionDecision;
	matches: readonly PermissionMatch[];
	/** True when the mode limit lowered the rule result. */
	limitedByMode: boolean;
}

export function evaluatePermission(input: {
	subject: PermissionSubject;
	ruleSets: readonly PermissionRuleSet[];
	/** Decision when no rule matches. */
	fallback: PermissionDecision;
	mode: AgentPermissionMode | "plan" | "build";
}): PermissionEvaluation {
	const matches = matchPermissionRules(input.subject, input.ruleSets);
	let decision = matches[0]?.decision ?? input.fallback;
	// A command substitution hides what actually runs; it never auto-allows.
	if (input.subject.opaque) decision = mostRestrictiveDecision(decision, "ask");
	const limit = modeLimit(input.mode, input.subject.subjectClass);
	const limited = mostRestrictiveDecision(decision, limit);
	return { decision: limited, matches, limitedByMode: limited !== decision };
}

/** Most restrictive decision over all subjects of one tool call (for example each Bash subcommand). */
export function evaluatePermissionSubjects(
	subjects: readonly PermissionSubject[],
	evaluate: (subject: PermissionSubject) => PermissionDecision,
): PermissionDecision {
	let decision: PermissionDecision = "allow";
	for (const subject of subjects) decision = mostRestrictiveDecision(decision, evaluate(subject));
	return decision;
}
