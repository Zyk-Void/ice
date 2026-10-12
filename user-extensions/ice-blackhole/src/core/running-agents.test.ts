import type { SessionEntry } from "@zykairotis/ice-coding-agent";
import { describe, expect, it } from "vitest";
import {
	extractRunningAgents,
	formatRunningAgentsSection,
	SUBAGENT_JOB_COMPLETION_TYPE,
	SUBAGENT_JOB_ENTRY_TYPE,
} from "./running-agents.ts";

let entryCounter = 0;

function jobSnapshotEntry(job: Record<string, unknown>): SessionEntry {
	entryCounter += 1;
	return {
		type: "custom",
		id: `job-${entryCounter}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: SUBAGENT_JOB_ENTRY_TYPE,
		data: { schemaVersion: 1, sequence: entryCounter, job: { role: "explore", ...job } },
	} as unknown as SessionEntry;
}

function jobCompletionEntry(jobId: string): SessionEntry {
	entryCounter += 1;
	return {
		type: "custom_message",
		id: `done-${entryCounter}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: SUBAGENT_JOB_COMPLETION_TYPE,
		content: `ICE background job ${jobId} completed.`,
		display: true,
		details: { jobId, status: "completed", resultRef: "artifacts/x.json" },
	} as unknown as SessionEntry;
}

describe("running agents scan", () => {
	it("lists jobs whose latest snapshot is still active", () => {
		const jobs = extractRunningAgents([
			jobSnapshotEntry({ jobId: "a", status: "queued" }),
			jobSnapshotEntry({ jobId: "a", status: "running" }),
			jobSnapshotEntry({ jobId: "b", status: "needs_time" }),
		]);
		expect(jobs).toEqual([
			{ jobId: "a", role: "explore", status: "running" },
			{ jobId: "b", role: "explore", status: "needs_time" },
		]);
	});

	it("excludes terminal snapshots and snapshots lagging a completion message", () => {
		const jobs = extractRunningAgents([
			jobSnapshotEntry({ jobId: "done-1", status: "completed" }),
			jobSnapshotEntry({ jobId: "done-2", status: "running" }),
			jobCompletionEntry("done-2"),
			jobSnapshotEntry({ jobId: "failed-1", status: "timed_out" }),
		]);
		expect(jobs).toHaveLength(0);
	});

	it("ignores malformed entries and caps the list", () => {
		const entries: SessionEntry[] = [jobSnapshotEntry({ jobId: "bad", status: 42 }), jobCompletionEntry("orphan")];
		for (let i = 0; i < 12; i++) entries.push(jobSnapshotEntry({ jobId: `j${i}`, status: "running" }));
		const jobs = extractRunningAgents(entries);
		expect(jobs).toHaveLength(8);
		expect(jobs.map((job) => job.jobId)).toEqual(["j4", "j5", "j6", "j7", "j8", "j9", "j10", "j11"]);
	});

	it("renders a section only when jobs are running", () => {
		expect(formatRunningAgentsSection([])).toBe("");
		const section = formatRunningAgentsSection([{ jobId: "a", role: "explore", status: "running" }]);
		expect(section).toBe("[Running Agents]\n- explore (running) job a: re-check via inspect_subagent_job");
	});
});
