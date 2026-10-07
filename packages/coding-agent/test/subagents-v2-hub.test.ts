import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { parseNativeAgentMarkdown } from "../src/subagents/definitions/parse.ts";
import type { ApprovalAnswer, PendingApproval } from "../src/subagents/permissions/approval.ts";
import { AgentHubView, type HubRow, type HubSource } from "../src/subagents/ui/hub.ts";
import { createAgentDefinitionFile } from "../src/subagents/v2/agent-manager.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const ROWS: HubRow[] = [
	{ id: "ag_a", agent: "explore", description: "Map auth", state: "running", turns: 1, tokens: 1500, cost: 0 },
	{
		id: "ag_b",
		agent: "worker",
		description: "Fix bug",
		state: "idle",
		lastTurnOutcome: "completed",
		turns: 2,
		tokens: 300,
		cost: 0,
		patchState: "open",
	},
];

function approval(childId: string, id: string): PendingApproval {
	return {
		request: {
			id,
			ownerSessionId: "s",
			childId,
			agent: "worker",
			tool: "bash",
			summary: "bash: npm test",
			foreground: false,
		},
		queuedAt: 0,
		deadline: 1,
	};
}

function hub(overrides: Partial<HubSource> = {}) {
	const calls: string[] = [];
	const responses: Array<[string, ApprovalAnswer]> = [];
	let listener: (() => void) | undefined;
	const source: HubSource = {
		rows: () => ROWS,
		approvals: () => [approval("ag_b", "r1")],
		details: (id) => [`details of ${id}`],
		subscribe: (next) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		focus: (id) => {
			calls.push(`focus ${id}`);
			return true;
		},
		stop: async (id) => {
			calls.push(`stop ${id}`);
		},
		delete: async (id) => {
			calls.push(`delete ${id}`);
		},
		respond: (id, answer) => {
			responses.push([id, answer]);
			return true;
		},
		...overrides,
	};
	const requestRender = vi.fn();
	const done = vi.fn();
	const view = new AgentHubView({ requestRender } as never, theme as never, new KeybindingsManager(), source, done);
	return { view, calls, responses, requestRender, done, emit: () => listener?.() };
}

describe("subagent V2 Agent Hub", () => {
	it("renders counts, pending approvals, the roster, and the selected child's inspector", () => {
		const { view } = hub();
		const text = view.render(80).join("\n");
		expect(text).toContain("Agent Hub");
		expect(text).toContain("2 agents · 1 running · 1 idle");
		expect(text).toContain("1 pending approval");
		expect(text).toContain("worker (ag_b): bash: npm test");
		expect(text).toContain("explore");
		expect(text).toContain("1.5k tok");
		expect(text).toContain("patch open");
		expect(text).toContain("details of ag_a");
		view.dispose();
	});

	it("lays out roster and inspector side by side on wide terminals", () => {
		const { view } = hub();
		const line = view.render(140).find((candidate) => candidate.includes("│"));
		expect(line).toBeDefined();
		expect(line).toContain("explore");
		expect(line).toContain("explore · ag_a");
		view.dispose();
	});

	it("moves selection, focuses, stops, deletes, and closes through configurable keys", async () => {
		const { view, calls, done } = hub();
		view.handleInput("\x1b[B");
		expect(view.render(80).join("\n")).toContain("details of ag_b");
		view.handleInput("s");
		view.handleInput("D");
		await Promise.resolve();
		expect(calls).toEqual(["stop ag_b", "delete ag_b"]);
		view.handleInput("\r");
		expect(calls.at(-1)).toBe("focus ag_b");
		expect(done).toHaveBeenCalledOnce();
		view.dispose();
	});

	it("answers the selected child's pending approval", () => {
		const { view, responses } = hub();
		view.handleInput("\x1b[B");
		view.handleInput("y");
		view.handleInput("n");
		expect(responses).toEqual([
			["r1", "allow-once"],
			["r1", "deny"],
		]);
		view.dispose();
	});

	it("re-renders on runtime changes and stops listening when disposed", () => {
		const { view, emit, requestRender } = hub();
		emit();
		expect(requestRender).toHaveBeenCalledOnce();
		view.dispose();
		emit();
		expect(requestRender).toHaveBeenCalledOnce();
	});

	it("keeps the Hub open when a child has no live session to focus", () => {
		const { view, done } = hub({ focus: () => false });
		view.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
		expect(view.render(80).join("\n")).toContain("has no live session to show");
		view.dispose();
	});
});

describe("subagent V2 agent manager", () => {
	const temps: string[] = [];
	afterEach(() => {
		for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("creates a valid native definition and never overwrites", () => {
		const dir = mkdtempSync(join(tmpdir(), "ice-v2-agents-"));
		temps.push(dir);
		const path = createAgentDefinitionFile({
			name: "docs-writer",
			directory: join(dir, "agents"),
			projectTrusted: true,
		});
		expect(parseNativeAgentMarkdown(readFileSync(path, "utf8"), "user", path).kind).toBe("agent");
		expect(() =>
			createAgentDefinitionFile({ name: "docs-writer", directory: join(dir, "agents"), projectTrusted: true }),
		).toThrow(/already exists/);
	});

	it("rejects invalid names and untrusted project directories", () => {
		const dir = mkdtempSync(join(tmpdir(), "ice-v2-agents-"));
		temps.push(dir);
		expect(() => createAgentDefinitionFile({ name: "Bad Name", directory: dir, projectTrusted: true })).toThrow(
			/lowercase/,
		);
		expect(() => createAgentDefinitionFile({ name: "ok", directory: join(dir, "p"), projectTrusted: false })).toThrow(
			/trust/,
		);
		expect(existsSync(join(dir, "p"))).toBe(false);
	});
});
