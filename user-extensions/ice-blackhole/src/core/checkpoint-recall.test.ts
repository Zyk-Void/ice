import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointRecallPath, consumeCheckpointRecallSection } from "./checkpoint-recall.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	delete process.env.ICE_CODING_AGENT_DIR;
});

function useAgentDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "ice-blackhole-recall-"));
	tempDirs.push(directory);
	process.env.ICE_CODING_AGENT_DIR = directory;
	return directory;
}

function writeRecall(payload: unknown, agentDir: string): void {
	mkdirSync(join(agentDir, "ice-cognee"), { recursive: true });
	writeFileSync(checkpointRecallPath(agentDir), typeof payload === "string" ? payload : JSON.stringify(payload));
}

describe("checkpoint recall handoff", () => {
	it("returns no section when the handoff file is absent", () => {
		const agentDir = useAgentDir();
		expect(consumeCheckpointRecallSection(agentDir)).toBe("");
	});

	it("renders the recall lines as a Relevant Memory section and consumes the file", () => {
		const agentDir = useAgentDir();
		writeRecall(
			{
				generatedAt: new Date().toISOString(),
				query: "queue refactor",
				hits: 2,
				recall: "1. remembered context A\n2. remembered context B",
			},
			agentDir,
		);
		const section = consumeCheckpointRecallSection(agentDir);
		expect(section).toContain("[Relevant Memory]");
		expect(section).toContain("Untrusted reference data recalled by Cognee:");
		expect(section).toContain("- 1. remembered context A");
		expect(section).toContain("- 2. remembered context B");
		expect(section.length).toBeLessThanOrEqual(4000);
		expect(consumeCheckpointRecallSection(agentDir)).toBe("");
	});

	it("rejects stale or malformed handoffs and still removes the file", () => {
		const agentDir = useAgentDir();
		writeRecall({ generatedAt: new Date(Date.now() - 60 * 60_000).toISOString(), recall: "1. old" }, agentDir);
		expect(consumeCheckpointRecallSection(agentDir)).toBe("");
		writeRecall("{ not json", agentDir);
		expect(consumeCheckpointRecallSection(agentDir)).toBe("");
		expect(existsSync(checkpointRecallPath(agentDir))).toBe(false);
	});
});
