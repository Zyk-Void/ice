import type { SubagentStatus, SubagentUsage } from "./ice-subagents.ts";
import { redactCredentialText } from "./utils/redact.ts";

/**
 * Local structured delegation telemetry (P2-2). Bounded per-run outcome records
 * that let future stress tests compute first-pass success, success-after-extension,
 * malformed-report rate, verification-failure rate, extension counts, and profile
 * outcomes without reconstructing metrics by hand.
 *
 * Records are session-local only: no prompt bodies, no credentials, and no
 * external telemetry transmission of any kind.
 */

export type SubagentTelemetryMode = "foreground" | "async" | "batch" | "review";
export type SubagentTelemetryReportProtocol = "valid" | "malformed" | "missing" | "truncated" | "not_applicable";

export interface SubagentOutcomeTelemetry {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly profile: string;
	readonly mode: SubagentTelemetryMode;
	readonly attempts: number;
	readonly extensionCount: number;
	readonly activeElapsedMs: number;
	readonly finalStatus: SubagentStatus;
	readonly reportProtocolStatus: SubagentTelemetryReportProtocol;
	readonly verificationPassed: boolean;
	readonly requiredCriteriaTotal: number;
	readonly requiredCriteriaSatisfied: number;
	readonly parentSteeringCount: number;
	readonly usage?: SubagentUsage;
	readonly recordedAtMs: number;
}

export interface SubagentTelemetrySummary {
	readonly totalRuns: number;
	readonly completed: number;
	readonly verifiedCompleted: number;
	readonly firstPassVerified: number;
	readonly verifiedAfterExtension: number;
	readonly malformedReports: number;
	readonly verificationFailures: number;
	readonly averageExtensions: number;
	readonly requiredCriteriaTotal: number;
	readonly requiredCriteriaSatisfied: number;
	readonly steeredRuns: number;
	readonly byProfile: readonly {
		profile: string;
		runs: number;
		verifiedCompleted: number;
	}[];
}

export const SUBAGENT_TELEMETRY_LIMIT = 256;

export interface SubagentOutcomeTelemetryInput {
	runId: string;
	profile: string;
	mode: SubagentTelemetryMode;
	attempts?: number;
	extensionCount?: number;
	activeElapsedMs?: number;
	finalStatus: SubagentStatus;
	reportProtocolStatus?: SubagentTelemetryReportProtocol;
	verificationPassed?: boolean;
	requiredCriteriaTotal?: number;
	requiredCriteriaSatisfied?: number;
	parentSteeringCount?: number;
	usage?: SubagentUsage;
}

function boundedSafeInteger(value: number | undefined, max: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0;
}

/** Bounded single-line safe token: no whitespace or control characters survive. */
function boundedToken(value: string | undefined, maxBytes: number): string | undefined {
	if (!value) return undefined;
	const redacted = redactCredentialText(value)
		.replace(/[\u0000-\u001f\u007f\s]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!redacted) return undefined;
	const bytes = Buffer.from(redacted, "utf8");
	if (bytes.length <= maxBytes) return redacted;
	let end = maxBytes;
	while (end > 0 && bytes.subarray(0, end).toString("utf8").endsWith("\ufffd")) end -= 1;
	return bytes.subarray(0, end).toString("utf8");
}

function boundedStatus(value: SubagentStatus): SubagentStatus {
	return value;
}

function boundedUsage(usage: SubagentUsage | undefined): SubagentUsage | undefined {
	if (!usage) return undefined;
	if (
		![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.cost].every(
			(value) => Number.isFinite(value) && value >= 0,
		)
	)
		return undefined;
	return Object.freeze({ ...usage });
}

export class SubagentTelemetryStore {
	private readonly records = new Map<string, SubagentOutcomeTelemetry>();
	private readonly listeners = new Set<() => void>();

	record(input: SubagentOutcomeTelemetryInput): SubagentOutcomeTelemetry | undefined {
		const runId = boundedToken(input.runId, 128);
		const profile = boundedToken(input.profile, 64);
		if (!runId || !profile) return undefined;
		const modes: SubagentTelemetryMode[] = ["foreground", "async", "batch", "review"];
		if (!modes.includes(input.mode)) return undefined;
		const record: SubagentOutcomeTelemetry = Object.freeze({
			schemaVersion: 1,
			runId,
			profile,
			mode: input.mode,
			attempts: boundedSafeInteger(input.attempts, 8) || 1,
			extensionCount: boundedSafeInteger(input.extensionCount, 64),
			activeElapsedMs: boundedSafeInteger(input.activeElapsedMs, 24 * 60 * 60 * 1000),
			finalStatus: boundedStatus(input.finalStatus),
			reportProtocolStatus: input.reportProtocolStatus ?? "not_applicable",
			verificationPassed: input.verificationPassed === true,
			requiredCriteriaTotal: boundedSafeInteger(input.requiredCriteriaTotal, 1024),
			requiredCriteriaSatisfied: boundedSafeInteger(input.requiredCriteriaSatisfied, 1024),
			parentSteeringCount: boundedSafeInteger(input.parentSteeringCount, 1024),
			...(boundedUsage(input.usage) ? { usage: boundedUsage(input.usage) } : {}),
			recordedAtMs: Date.now(),
		});
		// Same run re-recorded (e.g. after extension) replaces the earlier entry.
		this.records.set(runId, record);
		while (this.records.size > SUBAGENT_TELEMETRY_LIMIT) {
			const oldest = this.records.keys().next().value;
			if (oldest === undefined) break;
			this.records.delete(oldest);
		}
		this.publish();
		return record;
	}

	list(): readonly SubagentOutcomeTelemetry[] {
		return Object.freeze([...this.records.values()]);
	}

	private publish(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// Telemetry consumers are non-authoritative observers.
			}
		}
	}

	clear(): void {
		if (this.records.size === 0) return;
		this.records.clear();
		this.publish();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	summary(): SubagentTelemetrySummary {
		const records = [...this.records.values()];
		const totalRuns = records.length;
		const completed = records.filter((record) => record.finalStatus === "completed").length;
		const verified = records.filter((record) => record.verificationPassed);
		const verifiedAfterExtension = verified.filter((record) => record.extensionCount > 0).length;
		const malformedReports = records.filter(
			(record) => record.reportProtocolStatus === "malformed" || record.reportProtocolStatus === "truncated",
		).length;
		const verificationFailures = records.filter(
			(record) => !record.verificationPassed && record.finalStatus !== "needs_time",
		).length;
		const byProfileMap = new Map<string, { profile: string; runs: number; verifiedCompleted: number }>();
		for (const record of records) {
			const entry = byProfileMap.get(record.profile) ?? { profile: record.profile, runs: 0, verifiedCompleted: 0 };
			entry.runs += 1;
			if (record.verificationPassed) entry.verifiedCompleted += 1;
			byProfileMap.set(record.profile, entry);
		}
		return {
			totalRuns,
			completed,
			verifiedCompleted: verified.length,
			firstPassVerified: verified.filter((record) => record.extensionCount === 0 && record.attempts <= 1).length,
			verifiedAfterExtension,
			malformedReports,
			verificationFailures,
			averageExtensions:
				totalRuns === 0
					? 0
					: Math.round((records.reduce((total, record) => total + record.extensionCount, 0) / totalRuns) * 100) /
						100,
			requiredCriteriaTotal: records.reduce((total, record) => total + record.requiredCriteriaTotal, 0),
			requiredCriteriaSatisfied: records.reduce((total, record) => total + record.requiredCriteriaSatisfied, 0),
			steeredRuns: records.filter((record) => record.parentSteeringCount > 0).length,
			byProfile: Object.freeze(
				[...byProfileMap.values()].sort(
					(left, right) => right.runs - left.runs || left.profile.localeCompare(right.profile),
				),
			),
		};
	}
}

/** Bounded text rows for observatory display. */
export function formatSubagentTelemetrySummary(summary: SubagentTelemetrySummary): string[] {
	if (summary.totalRuns === 0) return [];
	const rows = [
		"TELEMETRY (session-local)",
		`runs ${summary.totalRuns} · verified ${summary.verifiedCompleted} · first-pass ${summary.firstPassVerified} · after-extension ${summary.verifiedAfterExtension}`,
		`malformed reports ${summary.malformedReports} · verification failures ${summary.verificationFailures} · avg extensions ${summary.averageExtensions}`,
		`required criteria ${summary.requiredCriteriaSatisfied}/${summary.requiredCriteriaTotal} · steered runs ${summary.steeredRuns}`,
	];
	const profiles = summary.byProfile
		.slice(0, 6)
		.map((entry) => `${entry.profile}: ${entry.verifiedCompleted}/${entry.runs} verified`)
		.join(" · ");
	if (profiles) rows.push(profiles);
	return rows;
}
