/**
 * Subagent V2 permission contract (Phase 0: types and data only).
 *
 * Design: Plan/subagent-rewrite.md sections 9.1-9.7. The evaluator, subject
 * extraction, and child derivation land in Phase 3; this module freezes the
 * vocabulary they share.
 */

export const PERMISSION_DECISIONS = ["deny", "ask", "allow"] as const;
/** Ordered least to most permissive. */
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

/** Rank used by the monotonic child invariant: a child rank never exceeds the parent rank. */
export function permissionRank(decision: PermissionDecision): number {
	return PERMISSION_DECISIONS.indexOf(decision);
}

export function mostRestrictiveDecision(left: PermissionDecision, right: PermissionDecision): PermissionDecision {
	return permissionRank(left) <= permissionRank(right) ? left : right;
}

/**
 * Rule grammar: `tool` or `tool(pattern)`, for example `bash(git push*)`,
 * `edit(src/**)`, `agent(explore)`, `mcp__github__*`, or `*` for every tool.
 */
export const PERMISSION_RULE_PATTERN = "^(?:\\*|[A-Za-z][A-Za-z0-9_.*-]{0,127})(\\(.{1,512}\\))?$";
export const PERMISSION_RULE_LIMITS = Object.freeze({ maxRulesPerList: 128, maxRuleBytes: 640 });

export interface PermissionRuleLists {
	allow?: readonly string[];
	ask?: readonly string[];
	deny?: readonly string[];
}

/** Where a rule came from; the child mutation ceiling depends on it. */
export type PermissionRuleScope = "builtin" | "managed" | "user" | "project" | "cli" | "session";
export type PermissionRuleCarrier = "settings" | "agent-definition" | "compat-definition" | "flag" | "grant";

export interface PermissionRuleOrigin {
	scope: PermissionRuleScope;
	carrier: PermissionRuleCarrier;
}

/** Agent-level permission presets (section 9.5). `sub-yolo` is a launch flag, not a definition value. */
export const AGENT_PERMISSION_MODES = ["inherit", "plan", "review", "build", "bubble"] as const;
export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];

export type ChildSubjectClass =
	| "read"
	| "edit-write"
	| "bash"
	| "mutation-adapter"
	| "external-directory"
	/** `agent(name)`; reaches a child only through the gated recursion exception (section 9.4). */
	| "delegation";

export type CeilingRaiser = "sub-yolo" | "user-allow" | "managed-allow" | "worktree-isolation";

export interface ChildMutationCeilingEntry {
	subjectClass: ChildSubjectClass;
	/** `parent` means the child starts from the parent decision for the same operation. */
	childDefault: PermissionDecision | "parent";
	/** Upper bound before any raiser applies; the parent decision is always a further cap. */
	maxDecision: PermissionDecision;
	/** Only these may raise the subject above `childDefault`; the result stays capped by the parent decision. */
	raisableBy: readonly CeilingRaiser[];
}

/**
 * Section 9.7 child mutation ceiling. Project-scope sources never appear as raisers:
 * repository content can narrow child authority but never grant unattended mutation.
 */
export const CHILD_MUTATION_CEILING: readonly ChildMutationCeilingEntry[] = Object.freeze([
	Object.freeze({ subjectClass: "read", childDefault: "parent", maxDecision: "allow", raisableBy: Object.freeze([]) }),
	Object.freeze({
		subjectClass: "edit-write",
		childDefault: "ask",
		maxDecision: "allow",
		raisableBy: Object.freeze(["sub-yolo", "user-allow", "managed-allow", "worktree-isolation"] as const),
	}),
	Object.freeze({
		subjectClass: "bash",
		childDefault: "ask",
		maxDecision: "allow",
		raisableBy: Object.freeze(["sub-yolo", "user-allow", "managed-allow"] as const),
	}),
	Object.freeze({
		subjectClass: "mutation-adapter",
		childDefault: "ask",
		maxDecision: "allow",
		raisableBy: Object.freeze(["user-allow", "managed-allow"] as const),
	}),
	Object.freeze({
		subjectClass: "delegation",
		childDefault: "parent",
		maxDecision: "allow",
		raisableBy: Object.freeze([]),
	}),
	Object.freeze({
		subjectClass: "external-directory",
		childDefault: "parent",
		maxDecision: "ask",
		raisableBy: Object.freeze(["sub-yolo", "managed-allow"] as const),
	}),
] satisfies ChildMutationCeilingEntry[]);

export interface ParsedPermissionRule {
	/** Tool name or glob such as `mcp__github__*`. */
	tool: string;
	/** Subject glob inside the parentheses; absent matches every subject of the tool. */
	pattern?: string;
}

export function parsePermissionRule(text: string): ParsedPermissionRule {
	if (!new RegExp(PERMISSION_RULE_PATTERN).test(text)) throw new Error(`Invalid permission rule "${text}"`);
	const open = text.indexOf("(");
	if (open === -1) return { tool: text };
	return { tool: text.slice(0, open), pattern: text.slice(open + 1, -1) };
}

/**
 * Glob match. In path mode `*` stays within one segment and `**` crosses
 * segments (gitignore style); otherwise `*` matches any run of characters.
 */
export function globMatches(pattern: string, value: string, pathMode = false): boolean {
	let source = "";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index]!;
		if (char === "*") {
			if (pathMode && pattern[index + 1] === "*") {
				index++;
				if (pattern[index + 1] === "/") {
					index++;
					source += "(?:.*/)?";
				} else source += ".*";
			} else source += pathMode ? "[^/]*" : "[\\s\\S]*";
		} else if (char === "?") source += pathMode ? "[^/]" : ".";
		else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`).test(value);
}
