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
		expect(text).toContain("2 active · 1 running · 1 idle");
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
		expect(line).toContain("ag_a · explore");
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

	it("lists finished (parked) children after active ones and selects in that order", () => {
		const { view } = hub({
			rows: () => [
				{ ...ROWS[0]!, id: "ag_done", description: "Old task", state: "parked" },
				{ ...ROWS[1]!, id: "ag_live", description: "Live task" },
			],
		});
		const text = view.render(80).join("\n");
		expect(text).toContain("1 active, 1 finished");
		expect(text.indexOf("Live task")).toBeLessThan(text.indexOf("Finished (enter resumes and opens)"));
		expect(text.indexOf("Finished (enter resumes and opens)")).toBeLessThan(text.indexOf("Old task"));
		expect(text).toContain("details of ag_live");
		view.handleInput("\x1b[B");
		expect(view.render(80).join("\n")).toContain("details of ag_done");
		view.dispose();
	});

	it("keeps the selection on the same child when it moves to the finished group", () => {
		let rows: HubRow[] = [
			{ ...ROWS[0]!, id: "ag_one", name: "atlas", description: "First" },
			{ ...ROWS[0]!, id: "ag_two", name: "basil", description: "Second" },
		];
		const { view } = hub({ rows: () => rows });
		view.handleInput("\x1b[A");
		view.render(80);
		// The first child finishes and moves below the second; the selection follows it.
		rows = [{ ...rows[1]! }, { ...rows[0]!, state: "parked", lastTurnOutcome: "completed" }];
		const text = view.render(80).join("\n");
		expect(text).toContain("details of ag_one");
		expect(text).toContain("atlas · explore · ag_one");
		expect(text).toMatch(/› ✓ atlas\s+explore\s+completed/);
		view.dispose();
	});

	it("windows a long roster around the selection and names children in notices", async () => {
		const rows: HubRow[] = Array.from({ length: 30 }, (_, index) => ({
			...ROWS[0]!,
			id: `ag_${index}`,
			name: `child-${index}`,
			description: `Task ${index}`,
		}));
		const { view } = hub({ rows: () => rows });
		let text = view.render(80).join("\n");
		expect(text).toContain("Task 0");
		expect(text).not.toContain("Task 20");
		expect(text).toContain("↓ 16 more");
		for (let step = 0; step < 20; step++) view.handleInput("\x1b[B");
		text = view.render(80).join("\n");
		expect(text).toContain("Task 20");
		expect(text).not.toContain("Task 0 ");
		expect(text).toMatch(/↑ \d+ more/);
		view.handleInput("s");
		expect(view.render(80).join("\n")).toContain("details of ag_20");
		await vi.waitFor(() => expect(view.render(80).join("\n")).toContain("Stopped the current turn of child-20."));
		view.dispose();
	});

	it("counts queued children once when the header shows capacity", () => {
		const { view } = hub({
			rows: () => [{ ...ROWS[0]!, state: "queued" }],
			capacity: () => ({ running: 0, queued: 1, max: 1 }),
		});
		const header = view.render(80)[0]!;
		expect(header).toContain("0/1 slots in use, 1 queued");
		expect(header.match(/queued/g)).toHaveLength(1);
		view.dispose();
	});

	it("resumes a parked child before opening it", async () => {
		const resumed = new Set<string>();
		const { view, done } = hub({
			rows: () => [{ ...ROWS[0]!, state: "parked" }],
			focus: (id) => resumed.has(id),
			resume: async (id) => {
				resumed.add(id);
			},
		});
		view.handleInput("\r");
		expect(view.render(80).join("\n")).toContain("Resuming ag_a");
		await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
		view.dispose();
	});

	it("shows slot usage in the header and closes on the hub key", () => {
		const { view, done } = hub({ capacity: () => ({ running: 1, queued: 2, max: 4 }) });
		expect(view.render(80)[0]).toContain("1/4 slots in use, 2 queued");
		view.handleInput("\x1b[D");
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
