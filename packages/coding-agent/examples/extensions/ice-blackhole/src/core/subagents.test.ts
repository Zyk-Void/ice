import type { SessionEntry } from "@zykairotis/ice-coding-agent";
import { describe, expect, it } from "vitest";
import { extractSubagents, formatSubagentsSection, SUBAGENT_CHILD_ENTRY_TYPE } from "./subagents.ts";

let entryCounter = 0;

function childEntry(record: Record<string, unknown>): SessionEntry {
	entryCounter += 1;
	return {
		type: "custom",
		id: `child-${entryCounter}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: SUBAGENT_CHILD_ENTRY_TYPE,
		data: { agent: "explore", state: "idle", description: "task", ...record },
	} as unknown as SessionEntry;
}

describe("subagents scan", () => {
	it("keeps the latest record per child and drops deleted children", () => {
		const children = extractSubagents([
			childEntry({ id: "a", state: "running" }),
			childEntry({ id: "b", state: "idle" }),
			childEntry({ id: "a", state: "idle", lastTurnOutcome: "completed" }),
			childEntry({ id: "b", state: "deleted" }),
		]);
		expect(children).toEqual([
			{ id: "a", agent: "explore", state: "idle", description: "task", outcome: "completed" },
		]);
	});

	it("projects the validated conclusion, assurance, and artifact id", () => {
		const [child] = extractSubagents([
			childEntry({
				id: "a",
				name: "scout",
				lastTurnOutcome: "completed",
				lastResult: {
					text: `## Found   the\nbug. ${"x".repeat(300)}`,
					validation: { assurance: "unverified_plain" },
					output: { artifact: { id: "art-1" } },
				},
			}),
		]);
		expect(child?.name).toBe("scout");
		expect(child?.assurance).toBe("unverified_plain");
		expect(child?.artifactId).toBe("art-1");
		expect(child?.conclusion?.startsWith("Found the bug. xxx")).toBe(true);
		expect(child?.conclusion?.length).toBe(160);
	});

	it("ignores malformed and unrelated entries and caps the list", () => {
		const entries: SessionEntry[] = [
			childEntry({ id: 7 }),
			childEntry({ id: "no-state", state: undefined }),
			{
				type: "custom",
				customType: "other",
				data: { id: "x", agent: "a", state: "idle" },
			} as unknown as SessionEntry,
		];
		for (let i = 0; i < 15; i++) entries.push(childEntry({ id: `c${i}` }));
		const children = extractSubagents(entries);
		expect(children).toHaveLength(12);
		expect(children[0]?.id).toBe("c3");
		expect(children.at(-1)?.id).toBe("c14");
	});

	it("renders nothing without children and tells how to read each one", () => {
		expect(formatSubagentsSection([])).toBe("");
		const section = formatSubagentsSection([
			{ id: "r1", agent: "explore", state: "running", description: "scan" },
			{
				id: "d1",
				name: "scout",
				agent: "review",
				state: "idle",
				description: "audit",
				outcome: "completed",
				conclusion: "all good",
				artifactId: "art-1",
			},
		]);
		expect(section).toContain("[Subagents]");
		expect(section).toContain("untrusted data");
		expect(section).toContain("- r1 · explore · running · scan\n  running; check agent_control action=status id=r1");
		expect(section).toContain("- scout (d1) · review · idle · last turn completed · audit");
		expect(section).toContain("conclusion: all good");
		expect(section).toContain("full report: agent_control action=output id=d1 (artifact art-1)");
	});
});
