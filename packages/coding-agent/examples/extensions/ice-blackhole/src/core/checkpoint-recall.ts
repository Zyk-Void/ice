import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@zykairotis/ice-coding-agent";

/**
 * Consume-once handoff from the ice-cognee extension: when checkpoint recall is
 * enabled, Cognee writes <agentDir>/ice-cognee/compaction-recall.json just
 * before Blackhole's session_before_compact hook runs (Cognee is a before-user
 * inline extension, so it always runs first). Blackhole embeds the bounded
 * recall lines as a "Relevant Memory" section and deletes the file so stale
 * recalls never leak into later compactions.
 */

const RECALL_FILE = join("ice-cognee", "compaction-recall.json");
const HEADER = "[Relevant Memory]";
const MAX_MEMORY_CHARS = 4000;
const MAX_LINES = 24;
const MAX_LINE_CHARS = 150;
const MAX_AGE_MS = 15 * 60_000;

interface CheckpointRecallPayload {
	generatedAt?: unknown;
	hostSessionId?: unknown;
	query?: unknown;
	results?: unknown;
}

export function checkpointRecallPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, RECALL_FILE);
}

export function consumeCheckpointRecallSection(
	agentDir?: string,
	now: number = Date.now(),
	expectedHostSessionId?: string,
): string {
	const path = checkpointRecallPath(agentDir);
	if (!existsSync(path)) return "";
	let payload: CheckpointRecallPayload;
	try {
		payload = JSON.parse(readFileSync(path, "utf8")) as CheckpointRecallPayload;
	} catch {
		rmSync(path, { force: true });
		return "";
	}
	if (expectedHostSessionId !== undefined) {
		if (typeof payload.hostSessionId !== "string") {
			rmSync(path, { force: true });
			return "";
		}
		if (payload.hostSessionId !== expectedHostSessionId) return "";
	}
	if (typeof payload.generatedAt !== "string") {
		rmSync(path, { force: true });
		return "";
	}
	const generatedAt = Date.parse(payload.generatedAt);
	if (!Number.isFinite(generatedAt) || generatedAt > now || now - generatedAt > MAX_AGE_MS) {
		rmSync(path, { force: true });
		return "";
	}
	rmSync(path, { force: true });
	if (!Array.isArray(payload.results)) return "";
	const lines = payload.results
		.map((result, index) => {
			if (typeof result !== "object" || result === null) return "";
			const text = "text" in result && typeof result.text === "string" ? result.text.trim() : "";
			if (!text) return "";
			const score =
				"score" in result && typeof result.score === "number" && Number.isFinite(result.score)
					? ` (score ${result.score})`
					: "";
			return `${index + 1}. ${text}${score}`;
		})
		.map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line))
		.filter((line) => line.trim().length > 0)
		.slice(0, MAX_LINES);
	if (lines.length === 0) return "";
	const body: string[] = [];
	for (const line of lines) {
		const candidate = [...body, `- ${line}`].join("\n");
		if (`${HEADER}\n${candidate}`.length > MAX_MEMORY_CHARS) break;
		body.push(`- ${line}`);
	}
	if (body.length === 0) return "";
	return [HEADER, "Untrusted reference data recalled by Cognee:", ...body].join("\n");
}
