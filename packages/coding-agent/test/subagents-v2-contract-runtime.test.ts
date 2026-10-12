import { describe, expect, it } from "vitest";
import {
	type ChildRuntimeContract,
	isChildGroupId,
	isChildId,
} from "../src/subagents/contract/child-runtime-contract.ts";
import {
	buildChildRuntimeContract,
	type ChildRuntimeContractInput,
	createChildGroupId,
	createChildId,
	hashChildRuntimeContract,
	parseChildRuntimeContract,
} from "../src/subagents/contract/serialize.ts";
import { type ResumeAuthorityContext, validateChildResume } from "../src/subagents/contract/validate-resume.ts";
import { buildSubagentTaskContract } from "../src/subagents/results/task-contract.ts";
import { type ParentToolInfo, resolveChildTools } from "../src/subagents/tools/resolve.ts";

const builtin = (name: string, access: ParentToolInfo["access"]): ParentToolInfo => ({ name, access, childSafe: true });
const PARENT: ParentToolInfo[] = [
	builtin("read", "read-only"),
	builtin("grep", "read-only"),
	builtin("find", "read-only"),
	builtin("ls", "read-only"),
	builtin("bash", "mutation"),
	builtin("edit", "mutation"),
	builtin("write", "mutation"),
	builtin("delegate", "mutation"),
	builtin("agent", "mutation"),
	builtin("agent_control", "read-only"),
	{ name: "web_fetch", access: "read-only", childSafe: true, adapterId: "web", fingerprint: "f1" },
	{ name: "deploy", access: "mutation", childSafe: false },
	{ name: "mystery", access: "unknown", childSafe: true },
	{
		name: "mcp__github__list_issues",
		access: "read-only",
		childSafe: true,
		adapterId: "mcp:github",
		fingerprint: "g1",
		mcp: { server: "github", tool: "list_issues" },
	},
];
const names = (resolution: ReturnType<typeof resolveChildTools>) => resolution.tools.map((tool) => tool.name);

describe("subagent V2 child tool resolution", () => {
	it("gives `*` every child-safe parent tool except management, unknown, unsafe, and MCP tools", () => {
		expect(names(resolveChildTools({ parentTools: PARENT }))).toEqual([
			"bash",
			"edit",
			"find",
			"grep",
			"ls",
			"read",
			"web_fetch",
			"write",
		]);
		expect(
			names(resolveChildTools({ parentTools: PARENT, tools: ["*"], disallowedTools: ["edit", "write"] })),
		).not.toContain("edit");
	});

	it("never grants a tool the parent lacks and explains each unavailable request", () => {
		const parentTools = PARENT.filter((tool) => tool.name !== "bash");
		const resolution = resolveChildTools({
			parentTools,
			tools: ["read", "bash", "deploy", "mystery", "delegate", "edit"],
			disallowedTools: ["edit"],
		});
		expect(names(resolution)).toEqual(["read"]);
		expect(resolution.diagnostics).toEqual([
			'tool "bash" is not active in the parent',
			'tool "deploy" is not child-safe',
			'tool "mystery" has unknown access classification',
			'tool "delegate" is a parent management tool',
			'tool "edit" is listed in disallowedTools',
		]);
	});

	it("selects MCP tools only through explicit selectors and keeps adapter fingerprints", () => {
		const resolution = resolveChildTools({ parentTools: PARENT, tools: ["read"], mcp: ["github/*", "slack/*"] });
		expect(resolution.tools).toContainEqual({
			name: "mcp__github__list_issues",
			access: "read-only",
			adapterId: "mcp:github",
			fingerprint: "g1",
		});
		expect(resolution.diagnostics).toEqual(['mcp selector "slack/*" matches no child-safe parent MCP tool']);
	});

	it("adds recursion tools only when the delegation gate passed", () => {
		expect(names(resolveChildTools({ parentTools: PARENT, tools: ["agent", "read"] }))).toEqual(["read"]);
		expect(
			names(
				resolveChildTools({ parentTools: PARENT, tools: ["read"], delegationTools: ["agent", "agent_control"] }),
			),
		).toEqual(["agent", "agent_control", "read"]);
	});
});

function contractInput(overrides: Partial<ChildRuntimeContractInput> = {}): ChildRuntimeContractInput {
	const tools = resolveChildTools({ parentTools: PARENT, tools: ["read", "edit", "web_fetch"] }).tools;
	return {
		id: `ag_${"a".repeat(26)}`,
		ownerSessionId: "s1",
		rootSessionId: "s1",
		depth: 0,
		agent: { name: "worker", source: "builtin", sourceHash: "h", resolvedDefinitionHash: "r" },
		prompt: {
			system: "Deploy with api_key=SECRETSECRETSECRET and Bearer SECRETSECRETTOKEN.",
			contextFiles: true,
			resourceHashes: [],
		},
		model: { provider: "cx", model: "gpt-6-luna", thinking: "high" },
		capabilities: {
			tools,
			permissionRules: [{ rule: "bash(git push*)", decision: "deny", scope: "user" }],
			scopeRoots: ["."],
			mcpServers: [],
			spawns: [],
			maxDepth: 0,
			subYolo: false,
			agentMode: "build",
			parentMode: "build",
			worktree: true,
		},
		result: { acceptance: [], taskContract: buildSubagentTaskContract("Implement the fix.") },
		budgets: { startupTimeoutMs: 600_000 },
		isolation: { mode: "worktree" },
		createdAt: "2026-10-07T00:00:00.000Z",
		...overrides,
	};
}

describe("subagent V2 runtime contract", () => {
	it("creates valid child and group IDs", () => {
		const id = createChildId();
		expect(isChildId(id)).toBe(true);
		expect(isChildGroupId(createChildGroupId())).toBe(true);
		expect(createChildId(() => new Uint8Array(17))).toBe(`ag_${"a".repeat(26)}`);
		expect(createChildId()).not.toBe(id);
	});

	it("redacts, freezes, and hashes deterministically", () => {
		const contract = buildChildRuntimeContract(contractInput());
		expect(contract.prompt.system).not.toContain("SECRETSECRET");
		expect(Object.isFrozen(contract.capabilities.tools)).toBe(true);
		expect(hashChildRuntimeContract(contract)).toBe(
			hashChildRuntimeContract(buildChildRuntimeContract(contractInput())),
		);
		expect(hashChildRuntimeContract(contract)).not.toBe(
			hashChildRuntimeContract(buildChildRuntimeContract(contractInput({ depth: 0, ownerSessionId: "s2" }))),
		);
	});

	it("round-trips through JSON only with the recorded hash", () => {
		const contract = buildChildRuntimeContract(contractInput());
		const hash = hashChildRuntimeContract(contract);
		const json = JSON.stringify(contract);
		expect(parseChildRuntimeContract(json, hash)).toEqual(contract);
		const tampered = json.replace('"subYolo":false', '"subYolo":true');
		expect(() => parseChildRuntimeContract(tampered, hash)).toThrow(/does not match/);
		expect(() => buildChildRuntimeContract(contractInput({ depth: 1 }))).toThrow(/exceeds maxDepth/);
	});
});

describe("subagent V2 resume validation", () => {
	const contract = buildChildRuntimeContract(contractInput());
	const context = (overrides: Partial<ResumeAuthorityContext> = {}): ResumeAuthorityContext => ({
		ownerSessionId: "s1",
		parentTools: PARENT,
		subYolo: false,
		parentMode: "build",
		modelAvailable: () => true,
		tombstoned: false,
		...overrides,
	});

	it("clamps active tools to the frozen set even when the parent gained tools", () => {
		expect(validateChildResume(contract, context())).toEqual({
			ok: true,
			activeTools: ["edit", "read", "web_fetch"],
		});
	});

	it("blocks before any turn when parent authority was revoked or changed", () => {
		const reasons = (overrides: Partial<ResumeAuthorityContext>) => {
			const result = validateChildResume(contract, context(overrides));
			return result.ok ? [] : result.reasons;
		};
		expect(reasons({ parentTools: PARENT.filter((tool) => tool.name !== "edit") })).toEqual([
			'tool "edit" is no longer active in the parent',
		]);
		expect(
			reasons({
				parentTools: PARENT.map((tool) => (tool.name === "web_fetch" ? { ...tool, fingerprint: "f2" } : tool)),
			}),
		).toEqual(['tool "web_fetch" implementation changed since the child was created']);
		expect(reasons({ parentMode: "plan" })).toEqual(["parent switched to plan mode; this child can mutate"]);
		expect(reasons({ modelAvailable: () => false })).toEqual(["model cx/gpt-6-luna is no longer available"]);
		expect(reasons({ ownerSessionId: "other" })).toEqual(["child belongs to another session"]);
		expect(reasons({ tombstoned: true })).toEqual(["child was deleted"]);
	});

	it("requires sub-yolo to still be active for a contract accepted under it", () => {
		const yolo: ChildRuntimeContract = buildChildRuntimeContract(
			contractInput({ capabilities: { ...contractInput().capabilities, subYolo: true } }),
		);
		expect(validateChildResume(yolo, context()).ok).toBe(false);
		expect(validateChildResume(yolo, context({ subYolo: true })).ok).toBe(true);
	});
});
