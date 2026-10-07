import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBuiltinAgentDefinitions } from "../src/subagents/definitions/builtin.ts";
import { resolveAgentDefinitionSet } from "../src/subagents/definitions/precedence.ts";
import type { ChildRecord } from "../src/subagents/registry/registry.ts";
import { runAgentsCli } from "../src/subagents/v2/cli.ts";
import { lifecycleEvents } from "../src/subagents/v2/events.ts";

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const loaded = () => ({
	...resolveAgentDefinitionSet({
		definitions: getBuiltinAgentDefinitions(),
		issues: [
			{
				name: "bad",
				source: "user",
				sourcePath: "/u/bad.md",
				availability: "invalid",
				diagnostics: ['unknown key "x"'],
			},
		],
		disabledAgents: ["plan"],
	}),
	searchedDirectories: [],
});

describe("ice agents CLI", () => {
	it("lists definitions as text and JSON", () => {
		const text = runAgentsCli(["list"], { cwd: "/", agentDir: "/", load: loaded });
		expect(text.exitCode).toBe(0);
		expect(text.stdout).toContain("general [builtin]");
		expect(text.stdout).toContain("plan [disabled]");
		const json = JSON.parse(runAgentsCli(["list", "--json"], { cwd: "/", agentDir: "/", load: loaded }).stdout);
		expect(json.active.map((entry: { name: string }) => entry.name)).toEqual([
			"explore",
			"general",
			"review",
			"worker",
		]);
		expect(json.disabled).toEqual(["plan"]);
		expect(json.issues[0]).toMatchObject({ name: "bad", availability: "invalid" });
	});

	it("validates every discovered definition and fails on invalid ones", () => {
		const result = runAgentsCli(["validate"], { cwd: "/", agentDir: "/", load: loaded });
		expect(result).toMatchObject({ exitCode: 1 });
		expect(result.stdout).toContain('/u/bad.md: unknown key "x"');
	});

	it("validates explicit files with precise migration diagnostics", () => {
		const dir = mkdtempSync(join(tmpdir(), "ice-v2-cli-"));
		temps.push(dir);
		mkdirSync(join(dir, "a"));
		writeFileSync(join(dir, "a/good.md"), "---\nname: good\ndescription: d\n---\nPrompt.\n");
		writeFileSync(join(dir, "a/old.md"), "---\nname: old\ndescription: d\nfallbackModel: x/y\n---\nPrompt.\n");
		writeFileSync(join(dir, "a/notes.md"), "# notes\n");
		const result = runAgentsCli(["validate", "a/good.md", "a/old.md", "a/notes.md"], { cwd: dir, agentDir: dir });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("a/good.md: valid (good)");
		expect(result.stdout).toContain('a/old.md: invalid: "fallbackModel" was removed');
		expect(result.stdout).toContain("a/notes.md: not an agent definition");
	});

	it("prints usage for unknown commands", () => {
		expect(runAgentsCli(["frobnicate"], { cwd: "/", agentDir: "/", load: loaded })).toMatchObject({ exitCode: 2 });
	});
});

describe("subagent V2 lifecycle events", () => {
	const record = (overrides: Partial<ChildRecord>): ChildRecord => ({
		id: "ag_x",
		ownerSessionId: "s",
		rootSessionId: "s",
		depth: 0,
		agent: "explore",
		description: "d",
		contractHash: "h",
		transcriptPath: "/t",
		state: "starting",
		generation: 1,
		turnInFlight: true,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	});
	const types = (previous: ChildRecord | undefined, next: ChildRecord) =>
		lifecycleEvents(previous, next).map((event) => event.type);

	it("maps registry changes to lifecycle events", () => {
		expect(types(undefined, record({}))).toEqual(["subagent_start"]);
		expect(types(record({}), record({ state: "running" }))).toEqual(["subagent_turn_start"]);
		expect(types(record({ state: "running" }), record({ state: "idle", lastTurnOutcome: "completed" }))).toEqual([
			"subagent_turn_end",
		]);
		expect(types(record({ state: "idle" }), record({ state: "parked" }))).toEqual(["subagent_parked"]);
		expect(types(record({ state: "parked" }), record({ state: "idle" }))).toEqual(["subagent_revived"]);
		expect(types(record({ state: "running" }), record({ state: "blocked" }))).toEqual(["subagent_blocked"]);
		expect(types(record({ state: "running" }), record({ state: "parked", lastTurnOutcome: "interrupted" }))).toEqual([
			"subagent_turn_end",
			"subagent_parked",
			"subagent_interrupted",
		]);
		expect(types(record({ state: "idle" }), record({ state: "deleted" }))).toEqual(["subagent_end"]);
		expect(
			types(record({ state: "idle", patchState: "open" }), record({ state: "idle", patchState: "applied" })),
		).toEqual(["subagent_patch"]);
	});

	it("carries bounded metadata only", () => {
		const [event] = lifecycleEvents(undefined, record({}));
		expect(Object.keys(event!).sort()).toEqual(["agent", "childId", "depth", "ownerSessionId", "state", "type"]);
	});
});
