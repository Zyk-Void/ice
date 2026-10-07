/**
 * Subagent V2 built-in agents (Plan/subagent-rewrite.md section 7.5, P2.5).
 *
 * Built-ins are the lowest-precedence source: a user, project, settings, or flag
 * definition with the same name replaces one whole (fields are never merged).
 * Every built-in has `spawns: []`; authority still comes from the parent (section 9).
 */
import { canonicalJson, hashAgentSource } from "./parse.ts";
import type { ResolvedAgentDefinition } from "./schema.ts";

const REPORT =
	"Report findings with file paths and line references. Separate verified facts from inferences, and say what you could not determine.";

const BUILTINS: ReadonlyArray<Omit<ResolvedAgentDefinition, "source" | "sourceHash" | "diagnostics" | "limited">> = [
	{
		name: "general",
		description:
			"General-purpose agent for multi-step research or implementation tasks that benefit from a separate context window.",
		prompt: `You are a general-purpose subagent working for a parent agent. Complete the delegated task fully within the approved scope, using only the tools you have. ${REPORT}`,
		fields: { spawns: [] },
	},
	{
		name: "explore",
		description:
			'Fast read-only codebase exploration: find files, search code, and explain how something works. Say "quick", "medium", or "very thorough" in the task.',
		prompt: `You are a read-only exploration subagent. Search and read efficiently; match breadth to the requested thoroughness. Do not modify files. ${REPORT}`,
		fields: {
			tools: ["read", "grep", "find", "ls", "bash"],
			permissionMode: "plan",
			contextFiles: false,
			spawns: [],
		},
	},
	{
		name: "plan",
		description:
			"Read-only implementation planning: study the code and return a step-by-step plan with affected files.",
		prompt: `You are a read-only planning subagent. Study the relevant code, then return an ordered implementation plan naming the files and functions to change, the risks, and how to verify each step. Do not modify files. ${REPORT}`,
		fields: { tools: ["read", "grep", "find", "ls"], permissionMode: "plan", contextFiles: false, spawns: [] },
	},
	{
		name: "review",
		description:
			"Read-only code review for correctness, security, tests, or regression risk; returns structured findings.",
		prompt: `You are a read-only review subagent. Examine the requested change or area for defects. For each finding give severity, location, the concrete failure scenario, and a fix. Run verification commands only when they cannot modify the workspace. ${REPORT}`,
		fields: { tools: ["read", "grep", "find", "ls", "bash"], permissionMode: "review", spawns: [] },
	},
	{
		name: "worker",
		description:
			"Implementation worker that edits code in an isolated git worktree and returns a patch for the parent to review and apply.",
		prompt: `You are an implementation subagent working in an isolated worktree. Make the requested change, keep it minimal, and run the relevant checks. Summarize what changed and the verification you ran. ${REPORT}`,
		fields: { permissionMode: "build", isolation: "worktree", spawns: [] },
	},
];

export const BUILTIN_AGENT_NAMES = Object.freeze(BUILTINS.map((agent) => agent.name));

export function getBuiltinAgentDefinitions(): readonly ResolvedAgentDefinition[] {
	return BUILTINS.map((agent) =>
		Object.freeze({
			...agent,
			fields: Object.freeze({ ...agent.fields }),
			source: "builtin" as const,
			sourceHash: hashAgentSource(canonicalJson(agent)),
			diagnostics: Object.freeze([]),
			limited: false,
		}),
	);
}
