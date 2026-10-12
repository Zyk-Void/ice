import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { AgentToolParametersSchema } from "../src/subagents/api/agent.ts";
import { AgentControlParametersSchema } from "../src/subagents/api/agent-control.ts";
import { AgentPatchParametersSchema } from "../src/subagents/api/agent-patch.ts";
import { isChildGroupId, isChildId } from "../src/subagents/contract/child-runtime-contract.ts";
import { JsonAgentDefinitionSchema, NativeAgentFrontmatterSchema } from "../src/subagents/definitions/schema.ts";
import {
	CHILD_MUTATION_CEILING,
	mostRestrictiveDecision,
	PERMISSION_DECISIONS,
	permissionRank,
} from "../src/subagents/permissions/rules.ts";
import {
	CHILD_INSTANCE_STATES,
	CHILD_STATE_TRANSITIONS,
	canTransitionChildState,
	recoverChildStateAfterRestart,
} from "../src/subagents/registry/state-machine.ts";

const CHILD_ID = `ag_${"a".repeat(26)}`;

describe("subagent V2 definition schema", () => {
	const full = {
		name: "security-review",
		description: "Use for security-focused review",
		tools: ["read", "grep", "find", "bash"],
		disallowedTools: ["edit", "write"],
		model: ["omni/cx/gpt-5.6-luna", "opencode-go/muse-spark-1.3-contributor", "inherit"],
		thinking: "high",
		permissionMode: "review",
		permissions: { deny: ["bash(git push*)"], ask: ["bash(*)"], allow: ["read", "mcp__github__*"] },
		maxTurns: 40,
		maxTokens: null,
		timeoutMs: null,
		background: false,
		isolation: "none",
		contextFiles: true,
		skills: ["tdd"],
		mcp: ["github/*"],
		requiredMcpServers: ["github"],
		hooks: ["audit-bash"],
		initialPrompt: "/review",
		spawns: [],
		color: "accent",
		hidden: false,
		tags: ["review"],
		temperature: 0.2,
		topP: 0.9,
	};

	it("accepts every native field", () => {
		expect(Value.Check(NativeAgentFrontmatterSchema, full)).toBe(true);
	});

	it("accepts a single model reference and a Claude-style comma tool string", () => {
		expect(
			Value.Check(NativeAgentFrontmatterSchema, {
				name: "explore",
				description: "d",
				model: "inherit",
				tools: "read, grep, find",
			}),
		).toBe(true);
	});

	it("rejects unknown keys, including the removed fallbackModel alias", () => {
		expect(Value.Check(NativeAgentFrontmatterSchema, { ...full, fallbackModel: "x/y" })).toBe(false);
		expect(Value.Check(NativeAgentFrontmatterSchema, { ...full, thinkingLevel: "high" })).toBe(false);
	});

	it("enforces the name pattern, required description, and bounds", () => {
		expect(Value.Check(NativeAgentFrontmatterSchema, { ...full, name: "Bad Name" })).toBe(false);
		const { description: _description, ...noDescription } = full;
		expect(Value.Check(NativeAgentFrontmatterSchema, noDescription)).toBe(false);
		expect(Value.Check(NativeAgentFrontmatterSchema, { ...full, maxTurns: 0 })).toBe(false);
		expect(Value.Check(NativeAgentFrontmatterSchema, { ...full, model: [] })).toBe(false);
		expect(Value.Check(NativeAgentFrontmatterSchema, { ...full, permissions: { deny: ["not a rule!"] } })).toBe(
			false,
		);
		expect(Value.Check(NativeAgentFrontmatterSchema, { ...full, spawns: ["Not-Valid"] })).toBe(false);
	});

	it("uses a map key instead of name for JSON definitions and requires a prompt", () => {
		const { name: _name, ...rest } = full;
		expect(Value.Check(JsonAgentDefinitionSchema, { ...rest, prompt: "You review." })).toBe(true);
		expect(Value.Check(JsonAgentDefinitionSchema, rest)).toBe(false);
		expect(Value.Check(JsonAgentDefinitionSchema, { ...rest, name: "x", prompt: "p" })).toBe(false);
	});
});

describe("subagent V2 permission contract", () => {
	it("orders decisions deny < ask < allow", () => {
		expect(PERMISSION_DECISIONS.map(permissionRank)).toEqual([0, 1, 2]);
		expect(mostRestrictiveDecision("allow", "ask")).toBe("ask");
		expect(mostRestrictiveDecision("deny", "allow")).toBe("deny");
	});

	it("never lets a project-scope source raise child mutation authority", () => {
		for (const entry of CHILD_MUTATION_CEILING) {
			expect(entry.raisableBy.every((raiser) => !raiser.startsWith("project"))).toBe(true);
		}
	});

	it("defaults every mutation subject to ask and caps external directories below allow", () => {
		const bySubject = new Map(CHILD_MUTATION_CEILING.map((entry) => [entry.subjectClass, entry]));
		for (const subject of ["edit-write", "bash", "mutation-adapter"] as const) {
			expect(bySubject.get(subject)?.childDefault).toBe("ask");
		}
		expect(bySubject.get("bash")?.raisableBy).not.toContain("worktree-isolation");
		expect(bySubject.get("external-directory")?.maxDecision).toBe("ask");
		expect(bySubject.get("external-directory")?.raisableBy).toEqual(["sub-yolo", "managed-allow"]);
	});
});

describe("subagent V2 child lifecycle", () => {
	it("defines transitions for every state and keeps deleted terminal", () => {
		for (const state of CHILD_INSTANCE_STATES) expect(CHILD_STATE_TRANSITIONS[state]).toBeDefined();
		expect(CHILD_STATE_TRANSITIONS.deleted).toEqual([]);
		expect(canTransitionChildState("aborted", "running")).toBe(false);
	});

	it("only revives parked children through idle and only deletes stopped children", () => {
		expect(canTransitionChildState("parked", "idle")).toBe(true);
		expect(canTransitionChildState("parked", "running")).toBe(false);
		expect(canTransitionChildState("running", "deleted")).toBe(false);
		expect(canTransitionChildState("idle", "deleted")).toBe(true);
	});

	it("parks resident children on restart and marks only in-flight turns interrupted", () => {
		expect(recoverChildStateAfterRestart("running", true)).toEqual({ state: "parked", interruptedTurn: true });
		expect(recoverChildStateAfterRestart("blocked", false)).toEqual({ state: "parked", interruptedTurn: false });
		expect(recoverChildStateAfterRestart("idle", false)).toEqual({ state: "parked", interruptedTurn: false });
		expect(recoverChildStateAfterRestart("deleted", false)).toEqual({ state: "deleted", interruptedTurn: false });
	});
});

describe("subagent V2 model-facing API", () => {
	it("validates child and group IDs", () => {
		expect(isChildId(CHILD_ID)).toBe(true);
		expect(isChildId(`ag_${"a".repeat(25)}`)).toBe(false);
		expect(isChildId(`agg_${"a".repeat(26)}`)).toBe(false);
		expect(isChildGroupId(`agg_${"a".repeat(26)}`)).toBe(true);
	});

	it("accepts one to eight agent tasks and rejects unknown task keys", () => {
		const task = { description: "Map auth flow", prompt: "Find where tokens are validated." };
		expect(Value.Check(AgentToolParametersSchema, { tasks: [task] })).toBe(true);
		expect(Value.Check(AgentToolParametersSchema, { tasks: [] })).toBe(false);
		expect(Value.Check(AgentToolParametersSchema, { tasks: Array(9).fill(task) })).toBe(false);
		expect(Value.Check(AgentToolParametersSchema, { tasks: [{ ...task, role: "self" }] })).toBe(false);
		expect(
			Value.Check(AgentToolParametersSchema, {
				tasks: [{ ...task, resume: CHILD_ID, scope: { roots: ["."] }, isolation: "worktree" }],
				background: true,
			}),
		).toBe(true);
	});

	it("validates agent_control and agent_patch actions", () => {
		expect(
			Value.Check(AgentControlParametersSchema, {
				action: "send",
				id: CHILD_ID,
				message: "Also check refresh tokens.",
				delivery: "followup",
			}),
		).toBe(true);
		expect(Value.Check(AgentControlParametersSchema, { action: "cancel", id: CHILD_ID })).toBe(false);
		// A reference is a child ID or a launch name; anything else is rejected.
		expect(Value.Check(AgentControlParametersSchema, { action: "wait", id: "run_123" })).toBe(false);
		expect(Value.Check(AgentControlParametersSchema, { action: "wait", id: "Auth Review" })).toBe(false);
		expect(Value.Check(AgentControlParametersSchema, { action: "wait", id: "auth-review" })).toBe(true);
		expect(Value.Check(AgentPatchParametersSchema, { id: CHILD_ID, action: "apply" })).toBe(true);
		expect(Value.Check(AgentPatchParametersSchema, { id: CHILD_ID, action: "integrate" })).toBe(false);
	});
});
