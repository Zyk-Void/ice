import type { SessionEntry } from "@zykairotis/ice-coding-agent";

/**
 * Reconstruct background subagent jobs that are still in flight at compaction
 * time from durable session entries, so the post-compaction model does not
 * forget delegations it is waiting on.
 *
 * Sources (written by the built-in ice-subagents extension):
 * - custom entries "ice-subagent-job-v1" carrying PersistedSubagentJobSnapshot
 *   ({ schemaVersion, sequence, job: { jobId, role, status, ... } });
 * - custom messages "ice-subagent-job-completion" whose details carry
 *   { jobId, status, resultRef } for snapshots that lag a finished job.
 *
 * Foreground delegates block their turn and cannot span a compaction, so only
 * background jobs can appear here. Child sessions run with noExtensions, so
 * job-level status is the best observable state; jobs are listed with their id
 * so the model can re-attach via inspect_subagent_job after compaction.
 */

export const SUBAGENT_JOB_ENTRY_TYPE = "ice-subagent-job-v1";
export const SUBAGENT_JOB_COMPLETION_TYPE = "ice-subagent-job-completion";

const ACTIVE_JOB_STATUSES = new Set(["created", "queued", "running", "needs_time"]);
const MAX_RUNNING_AGENTS = 8;

export interface RunningAgentJob {
	jobId: string;
	role: string;
	status: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function completionJobId(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	return typeof details.jobId === "string" ? details.jobId : undefined;
}

export function extractRunningAgents(branchEntries: readonly SessionEntry[]): RunningAgentJob[] {
	const latest = new Map<string, { role: string; status: string }>();
	const completed = new Set<string>();

	for (const entry of branchEntries) {
		if (entry.type === "custom" && entry.customType === SUBAGENT_JOB_ENTRY_TYPE) {
			if (!isRecord(entry.data)) continue;
			const job = entry.data.job;
			if (!isRecord(job)) continue;
			const jobId = typeof job.jobId === "string" ? job.jobId : undefined;
			const status = typeof job.status === "string" ? job.status : undefined;
			if (!jobId || !status) continue;
			latest.set(jobId, { role: typeof job.role === "string" ? job.role : "subagent", status });
			continue;
		}
		if (entry.type === "custom_message" && entry.customType === SUBAGENT_JOB_COMPLETION_TYPE) {
			const jobId = completionJobId(entry.details);
			if (jobId) completed.add(jobId);
		}
	}

	const running: RunningAgentJob[] = [];
	for (const [jobId, job] of latest) {
		if (completed.has(jobId) || !ACTIVE_JOB_STATUSES.has(job.status)) continue;
		running.push({ jobId, role: job.role, status: job.status });
	}
	// Keep the most recent jobs while preserving chronological order.
	return running.slice(-MAX_RUNNING_AGENTS);
}

export function formatRunningAgentsSection(jobs: readonly RunningAgentJob[]): string {
	if (jobs.length === 0) return "";
	const lines = jobs.map((job) => `- ${job.role} (${job.status}) job ${job.jobId}: re-check via inspect_subagent_job`);
	return ["[Running Agents]", ...lines].join("\n");
}
