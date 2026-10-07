import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import { LEGACY_SUBAGENT_TOOL_NAMES, V2_SUBAGENT_TOOL_NAMES } from "../src/subagents/api/tool-set.ts";
import iceSubagentsV2, { isSubagentsV2Selected } from "../src/subagents/v2/extension.ts";
import { resolveSubagentsV2Settings } from "../src/subagents/v2/settings.ts";

function fakeApi() {
	const tools: string[] = [];
	const flags: string[] = [];
	const events: string[] = [];
	const api = {
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerFlag: (name: string) => flags.push(name),
		on: (event: string) => events.push(event),
		getFlag: () => undefined,
		events: {},
	} as unknown as ExtensionAPI;
	return { api, tools, flags, events };
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
		expect(tools).toEqual(["agent", "agent_control"]);
		for (const name of tools) expect(V2_SUBAGENT_TOOL_NAMES).toContain(name);
		for (const name of tools) expect(LEGACY_SUBAGENT_TOOL_NAMES).not.toContain(name);
		expect(flags).toEqual(["sub-yolo"]);
		expect(events).toEqual(expect.arrayContaining(["before_agent_start", "session_shutdown", "agent_settled"]));
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
