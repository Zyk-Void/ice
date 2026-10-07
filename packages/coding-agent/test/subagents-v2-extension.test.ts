import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";
import { LEGACY_SUBAGENT_TOOL_NAMES, V2_SUBAGENT_TOOL_NAMES } from "../src/subagents/api/tool-set.ts";
import { ChildRegistry } from "../src/subagents/registry/registry.ts";
import iceSubagentsV2, { isSubagentsV2Selected } from "../src/subagents/v2/extension.ts";
import { SubagentV2Runtime } from "../src/subagents/v2/runtime.ts";
import type { ChildTurnResult } from "../src/subagents/v2/runtime-support.ts";
import { resolveSubagentsV2Settings } from "../src/subagents/v2/settings.ts";

function fakeApi() {
	const tools: string[] = [];
	const definitions: ToolDefinition[] = [];
	const flags: string[] = [];
	const events: string[] = [];
	const api = {
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool.name);
			definitions.push(tool);
		},
		registerFlag: (name: string) => flags.push(name),
		on: (event: string) => events.push(event),
		getFlag: () => undefined,
		events: {},
	} as unknown as ExtensionAPI;
	return { api, tools, definitions, flags, events };
}

describe("subagent V2 rollout gate", () => {
	it("selects V2 only from the env var or the global ice.subagents.v2 setting", () => {
		expect(isSubagentsV2Selected(undefined, undefined)).toBe(false);
		expect(isSubagentsV2Selected({ ice: { subagents: { v2: true } } }, undefined)).toBe(true);
		expect(isSubagentsV2Selected({ ice: { subagents: { v2: "yes" } } }, undefined)).toBe(false);
		expect(isSubagentsV2Selected(undefined, "1")).toBe(true);
	});

	it("registers only V2 tools, never a legacy one", () => {
		const { api, tools, flags, events } = fakeApi();
		iceSubagentsV2(api);
		expect(tools).toEqual(["agent", "agent_control", "agent_patch"]);
		for (const name of tools) expect(V2_SUBAGENT_TOOL_NAMES).toContain(name);
		for (const name of tools) expect(LEGACY_SUBAGENT_TOOL_NAMES).not.toContain(name);
		expect(flags).toEqual(["sub-yolo"]);
		expect(events).toEqual(expect.arrayContaining(["before_agent_start", "session_shutdown", "agent_settled"]));
	});
});

describe("subagent V2 patch inspection", () => {
	it("exposes retained recovery references without injecting private preimages", async () => {
		const { api, definitions } = fakeApi();
		iceSubagentsV2(api);
		const inspect = vi.spyOn(SubagentV2Runtime.prototype, "inspectPatch").mockReturnValue({
			state: "applying",
			recoveryRef: "/owner/private/recovery.json",
			artifactRef: "/owner/patch.diff",
		});
		try {
			const tool = definitions.find((candidate) => candidate.name === "agent_patch")!;
			const result = await tool.execute(
				"inspect-call",
				{ action: "inspect", id: `ag_${"a".repeat(26)}` },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(result.details).toEqual({
				status: "applying",
				recoveryRef: "/owner/private/recovery.json",
				artifactRef: "/owner/patch.diff",
			});
			expect(JSON.stringify(result.content)).toContain("Recovery data:");
			expect(JSON.stringify(result)).not.toContain("base64");
		} finally {
			inspect.mockRestore();
		}
	});
});

describe("subagent V2 typed result API", () => {
	it("rejects a resumed outputSchema before launching any fresh sibling", async () => {
		const { api, definitions } = fakeApi();
		iceSubagentsV2(api);
		const launch = vi.spyOn(SubagentV2Runtime.prototype, "launch");
		const continuation = vi.spyOn(SubagentV2Runtime.prototype, "continueChild");
		try {
			const tool = definitions.find((candidate) => candidate.name === "agent")!;
			const result = await tool.execute(
				"schema",
				{
					tasks: [
						{ agent: "general", description: "fresh", prompt: "fresh" },
						{
							resume: `ag_${"a".repeat(26)}`,
							description: "resume",
							prompt: "resume",
							outputSchema: { type: "object" },
						},
					],
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(JSON.stringify(result)).toContain("frozen outputSchema");
			expect(launch).not.toHaveBeenCalled();
			expect(continuation).not.toHaveBeenCalled();
		} finally {
			launch.mockRestore();
			continuation.mockRestore();
		}
	});

	it.each([false, true])("forwards task-local acceptance on resume, background=%s", async (background) => {
		const { api, definitions } = fakeApi();
		iceSubagentsV2(api);
		const id = `ag_${"a".repeat(26)}`;
		const launch = vi.spyOn(SubagentV2Runtime.prototype, "launch").mockResolvedValue([]);
		const continuation = vi
			.spyOn(SubagentV2Runtime.prototype, "continueChild")
			.mockImplementation(async (_id, _prompt, options) => {
				options.accepted?.();
				return {
					id,
					agent: "general",
					outcome: "completed",
					text: "report",
					truncated: false,
					usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
					validation: {
						reportMode: "structured_report",
						verified: true,
						assurance: "evidence_checked",
						reason: "Observed evidence; semantics unverified.",
						paths: [],
						requirements: [],
					},
				};
			});
		try {
			const tool = definitions.find((candidate) => candidate.name === "agent")!;
			const result = await tool.execute(
				"acceptance",
				{
					background,
					tasks: [{ resume: id, description: "resume", prompt: "resume", acceptance: ["Additional criterion"] }],
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(continuation).toHaveBeenCalledWith(
				id,
				"resume",
				expect.objectContaining({ foreground: !background, acceptance: ["Additional criterion"] }),
			);
			if (!background) expect(JSON.stringify(result)).toContain("evidence_checked");
		} finally {
			launch.mockRestore();
			continuation.mockRestore();
		}
	});

	it("routes bounded output range reads through the V2 child owner", async () => {
		const { api, definitions } = fakeApi();
		iceSubagentsV2(api);
		const id = `ag_${"a".repeat(26)}`;
		const registry = new ChildRegistry<Parameters<SubagentV2Runtime["registry"]["attach"]>[2]>({
			append: () => {},
			flush: () => {},
			entries: () => [],
		});
		const owner = vi.spyOn(SubagentV2Runtime.prototype, "ownerSessionId").mockReturnValue("owner");
		const projection = vi.spyOn(SubagentV2Runtime.prototype, "registry", "get").mockReturnValue(registry);
		const read = vi.spyOn(SubagentV2Runtime.prototype, "readOutput").mockReturnValue({
			artifactId: "00000000-0000-4000-8000-000000000000",
			offset: 12,
			bytesRead: 4,
			totalBytes: 20,
			nextOffset: 16,
			eof: false,
			contentType: "text/plain",
			text: "data",
			sha256: "a".repeat(64),
			truncated: false,
		});
		try {
			const tool = definitions.find((candidate) => candidate.name === "agent_control")!;
			const result = await tool.execute(
				"output-range",
				{ action: "output", id, offset: 12, length: 4 },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(read).toHaveBeenCalledWith(id, { offset: 12, length: 4 });
			expect(JSON.stringify(result.content)).toContain("nextOffset=16");
			expect(JSON.stringify(result.content)).toContain("data");
		} finally {
			owner.mockRestore();
			projection.mockRestore();
			read.mockRestore();
		}
	});

	it("renders saved assurance when inspecting output and bounds aggregate text", async () => {
		const { api, definitions } = fakeApi();
		iceSubagentsV2(api);
		const registry = new ChildRegistry<Parameters<SubagentV2Runtime["registry"]["attach"]>[2]>({
			append: () => {},
			flush: () => {},
			entries: () => [],
		});
		const owner = vi.spyOn(SubagentV2Runtime.prototype, "ownerSessionId").mockReturnValue("owner");
		const projection = vi.spyOn(SubagentV2Runtime.prototype, "registry", "get").mockReturnValue(registry);
		const output = vi.spyOn(SubagentV2Runtime.prototype, "outputOf").mockImplementation((id) => ({
			id,
			agent: "general",
			outcome: "completed",
			text: "x".repeat(48 * 1024),
			truncated: false,
			usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
			validation: {
				reportMode: "structured_report",
				verified: true,
				assurance: "evidence_checked",
				reason: "Observed evidence",
				paths: [],
				requirements: [],
			},
		}));
		try {
			const tool = definitions.find((candidate) => candidate.name === "agent_control")!;
			const one = await tool.execute(
				"output",
				{ action: "output", id: `ag_${"a".repeat(26)}` },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(JSON.stringify(one)).toContain("evidence_checked");
			const many = await tool.execute(
				"output",
				{
					action: "output",
					ids: Array.from({ length: 8 }, (_, i) => `ag_${String.fromCharCode(97 + i).repeat(26)}`),
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			const rendered = many.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
			expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(64 * 1024);
			expect(rendered).toContain("Presentation truncated");
		} finally {
			owner.mockRestore();
			projection.mockRestore();
			output.mockRestore();
		}
	});
});

describe("subagent V2 batch synthesis", () => {
	it("adds bounded deterministic synthesis before ordered foreground child reports", async () => {
		const { api, definitions } = fakeApi();
		iceSubagentsV2(api);
		const journal = { append: () => {}, flush: () => {}, entries: () => [] };
		const records = new ChildRegistry(journal);
		const ids = [`ag_${"a".repeat(26)}`, `ag_${"b".repeat(26)}`];
		const accepted = ids.map((id, index) =>
			records.accept({
				id,
				ownerSessionId: "owner",
				rootSessionId: "owner",
				depth: 0,
				agent: "review",
				description: `review ${index + 1}`,
				contractHash: `hash-${index}`,
				transcriptPath: `/unused/${index}`,
			}),
		);
		const results = new Map<string, ChildTurnResult>([
			[
				ids[0]!,
				{
					id: ids[0]!,
					agent: "review",
					outcome: "completed",
					text: "Review A",
					truncated: false,
					usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
					validation: {
						reportMode: "structured_report",
						verified: true,
						assurance: "evidence_checked",
						reason: "Observed evidence; semantics unverified.",
						paths: ["/repo/src/auth.ts"],
						requirements: [],
						findings: [
							{
								severity: "high",
								category: "security",
								claim: "Authentication enforcement is present",
								evidence: [{ path: "/repo/src/auth.ts" }],
							},
						],
					},
				},
			],
			[
				ids[1]!,
				{
					id: ids[1]!,
					agent: "review",
					outcome: "completed",
					text: "Review B",
					truncated: false,
					usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
					validation: {
						reportMode: "structured_report",
						verified: true,
						assurance: "evidence_checked",
						reason: "Observed evidence; semantics unverified.",
						paths: ["/repo/src/auth.ts"],
						requirements: [],
						findings: [
							{
								severity: "high",
								category: "Security",
								claim: "Authentication enforcement is missing",
								evidence: [{ path: "/repo/src/auth.ts" }],
							},
						],
					},
				},
			],
		]);
		const launch = vi.spyOn(SubagentV2Runtime.prototype, "launch").mockResolvedValue(accepted);
		const run = vi.spyOn(SubagentV2Runtime.prototype, "runTurn").mockImplementation(async (id) => results.get(id)!);
		try {
			const tool = definitions.find((candidate) => candidate.name === "agent")!;
			const result = await tool.execute(
				"batch",
				{
					tasks: [
						{ agent: "review", description: "first review", prompt: "Review the authentication path." },
						{
							agent: "review",
							description: "second review",
							prompt: "Independently review the authentication path.",
						},
					],
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			const rendered = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
			expect(rendered.indexOf(`## review (${ids[0]})`)).toBeLessThan(rendered.indexOf(`## review (${ids[1]})`));
			expect(rendered).toContain("## Subagent batch synthesis");
			expect(rendered).toContain("children: 2 total, 2 completed, 0 failed, 0 other");
			expect(rendered).toContain(`${ids[0]} <-> ${ids[1]}: 1 shared paths (/repo/src/auth.ts)`);
			expect(rendered).toContain("[finding_claim]");
			expect(rendered).toContain("not semantic verification or independent review approval");
			expect(JSON.stringify(result.details)).toContain("batchSynthesis");
		} finally {
			launch.mockRestore();
			run.mockRestore();
		}
	});

	it("returns independent background child handles without claiming an aggregate result", async () => {
		const { api, definitions } = fakeApi();
		iceSubagentsV2(api);
		const records = new ChildRegistry({ append: () => {}, flush: () => {}, entries: () => [] });
		const ids = [`ag_${"c".repeat(26)}`, `ag_${"d".repeat(26)}`];
		const accepted = ids.map((id, index) =>
			records.accept({
				id,
				ownerSessionId: "owner",
				rootSessionId: "owner",
				depth: 0,
				agent: "general",
				description: `background ${index + 1}`,
				contractHash: `background-${index}`,
				transcriptPath: `/unused/background-${index}`,
			}),
		);
		const launch = vi.spyOn(SubagentV2Runtime.prototype, "launch").mockResolvedValue(accepted);
		const run = vi.spyOn(SubagentV2Runtime.prototype, "runTurn").mockImplementation(async (_id, _prompt, options) => {
			options.accepted?.();
			return new Promise<ChildTurnResult>(() => {});
		});
		try {
			const tool = definitions.find((candidate) => candidate.name === "agent")!;
			const result = await tool.execute(
				"background-batch",
				{
					background: true,
					tasks: ids.map((_id, index) => ({
						agent: "general",
						description: `background ${index + 1}`,
						prompt: `run ${index + 1}`,
					})),
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(result.details).toMatchObject({ ids });
			expect(JSON.stringify(result)).not.toContain("batchSynthesis");
			expect(JSON.stringify(result)).toContain("Started 2 subagents");
		} finally {
			launch.mockRestore();
			run.mockRestore();
		}
	});
});

describe("subagent V2 task budgets", () => {
	it.each(["Supply an explicit permitted budget", "Budget maxTurns exceeds the frozen ceiling"])(
		"surfaces rejected background renewal: %s",
		async (message) => {
			const { api, definitions } = fakeApi();
			iceSubagentsV2(api);
			const launch = vi.spyOn(SubagentV2Runtime.prototype, "launch").mockResolvedValue([]);
			const continuation = vi
				.spyOn(SubagentV2Runtime.prototype, "continueChild")
				.mockRejectedValue(new Error(message));
			try {
				const tool = definitions.find((candidate) => candidate.name === "agent")!;
				const result = await tool.execute(
					"renew",
					{
						background: true,
						tasks: [{ resume: `ag_${"a".repeat(26)}`, description: "continue", prompt: "continue" }],
					},
					undefined,
					undefined,
					{} as ExtensionContext,
				);
				expect(JSON.stringify(result)).toContain("No subagents started.");
				expect(JSON.stringify(result)).toContain(message);
				expect(result.details).toMatchObject({ ids: [], rejected: [{ outcome: "failed", error: message }] });
			} finally {
				launch.mockRestore();
				continuation.mockRestore();
			}
		},
	);

	it("acknowledges background acceptance without awaiting task completion", async () => {
		const { api, definitions } = fakeApi();
		iceSubagentsV2(api);
		const launch = vi.spyOn(SubagentV2Runtime.prototype, "launch").mockResolvedValue([]);
		const continuation = vi
			.spyOn(SubagentV2Runtime.prototype, "continueChild")
			.mockImplementation(async (_id, _prompt, options) => {
				options.accepted?.();
				return new Promise(() => {});
			});
		try {
			const tool = definitions.find((candidate) => candidate.name === "agent")!;
			const id = `ag_${"a".repeat(26)}`;
			const result = await tool.execute(
				"renew",
				{ background: true, tasks: [{ resume: id, description: "continue", prompt: "continue", maxTurns: 2 }] },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(result.details).toMatchObject({ ids: [id], rejected: [] });
			expect(JSON.stringify(result)).toContain("Started 1 subagent");
		} finally {
			launch.mockRestore();
			continuation.mockRestore();
		}
	});
	it("forwards explicit renewal fields for agent resume without changing other runtime fields", async () => {
		const { api, definitions } = fakeApi();
		iceSubagentsV2(api);
		const launch = vi.spyOn(SubagentV2Runtime.prototype, "launch").mockResolvedValue([]);
		const continuation = vi.spyOn(SubagentV2Runtime.prototype, "continueChild").mockResolvedValue({
			id: `ag_${"a".repeat(26)}`,
			agent: "explore",
			outcome: "completed",
			text: "renewed",
			truncated: false,
			usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
		});
		try {
			const id = `ag_${"a".repeat(26)}`;
			const tool = definitions.find((candidate) => candidate.name === "agent")!;
			await tool.execute(
				"renew",
				{
					tasks: [
						{
							resume: id,
							description: "continue",
							prompt: "continue",
							maxTurns: 2,
							maxTokens: 100,
							timeoutMs: 500,
						},
					],
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(continuation).toHaveBeenCalledWith(id, "continue", {
				foreground: true,
				budgets: { maxTurns: 2, maxTokens: 100, timeoutMs: 500 },
			});
			expect(launch).toHaveBeenCalledWith([]);
		} finally {
			launch.mockRestore();
			continuation.mockRestore();
		}
	});
});

describe("subagent V2 control wait", () => {
	it("does not call an idle queued continuation settled", async () => {
		const { api, definitions } = fakeApi();
		iceSubagentsV2(api);
		const registry = new ChildRegistry<Parameters<SubagentV2Runtime["registry"]["attach"]>[2]>({
			append: () => {},
			flush: () => {},
			entries: () => [],
		});
		const id = `ag_${"a".repeat(26)}`;
		const record = registry.accept({
			id,
			ownerSessionId: "owner",
			rootSessionId: "owner",
			depth: 0,
			agent: "general",
			description: "queued",
			contractHash: "hash",
			transcriptPath: "/unused",
		});
		const running = registry.transition("owner", id, record.generation, "running");
		registry.transition("owner", id, running.generation, "idle", { turnInFlight: true });
		const owner = vi.spyOn(SubagentV2Runtime.prototype, "ownerSessionId").mockReturnValue("owner");
		const projection = vi.spyOn(SubagentV2Runtime.prototype, "registry", "get").mockReturnValue(registry);
		try {
			const tool = definitions.find((candidate) => candidate.name === "agent_control")!;
			let settled = false;
			const waiting = tool
				.execute("wait-call", { action: "wait", id, timeoutMs: 1000 }, undefined, undefined, {} as ExtensionContext)
				.then((result) => {
					settled = true;
					return result;
				});
			await Promise.resolve();
			await Promise.resolve();
			expect(settled).toBe(false);
			registry.transition("owner", id, registry.get("owner", id).generation, "idle", {
				turnInFlight: false,
				lastTurnOutcome: "cancelled",
			});
			expect(JSON.stringify(await waiting)).toContain("All children settled.");
		} finally {
			owner.mockRestore();
			projection.mockRestore();
		}
	});
});

describe("subagent V2 settings", () => {
	it("lets project settings narrow but never raise ceilings or enable compat", () => {
		const settings = resolveSubagentsV2Settings({
			global: { maxConcurrent: 4, maxDepth: 1, permissions: { allow: ["bash(npm test*)"] } },
			project: {
				maxConcurrent: 8,
				maxDepth: 0,
				permissions: { deny: ["bash(git push*)"] },
				compat: { claudeAgents: true },
			},
			projectTrusted: true,
		});
		expect(settings).toMatchObject({ maxConcurrent: 4, maxDepth: 0, compat: { claudeAgents: false } });
		expect(settings.ruleSets.map((set) => set.origin.scope)).toEqual(["user", "project"]);
	});

	it("ignores untrusted project settings and fails closed on invalid values", () => {
		const untrusted = resolveSubagentsV2Settings({ project: { defaultAgent: "evil" }, projectTrusted: false });
		expect(untrusted.defaultAgent).toBe("general");
		const invalid = resolveSubagentsV2Settings({
			global: { maxConcurrent: 999, permissions: { allow: ["(bad"] } },
			projectTrusted: false,
		});
		expect(invalid.maxConcurrent).toBe(4);
		expect(invalid.ruleSets).toEqual([]);
		expect(invalid.diagnostics.length).toBeGreaterThan(0);
	});
});
