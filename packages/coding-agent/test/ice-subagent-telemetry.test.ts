import { describe, expect, it, vi } from "vitest";
import {
	formatSubagentTelemetrySummary,
	SUBAGENT_TELEMETRY_LIMIT,
	SubagentTelemetryStore,
} from "../src/ice-subagent-telemetry.ts";

describe("subagent outcome telemetry", () => {
	it("records bounded local per-run outcomes", () => {
		const store = new SubagentTelemetryStore();
		const record = store.record({
			runId: "run-1",
			profile: "explore",
			mode: "foreground",
			finalStatus: "completed",
			reportProtocolStatus: "valid",
			verificationPassed: true,
			usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, cost: 0.25 },
		});
		expect(record).toMatchObject({
			schemaVersion: 1,
			runId: "run-1",
			profile: "explore",
			mode: "foreground",
			attempts: 1,
			extensionCount: 0,
			finalStatus: "completed",
			verificationPassed: true,
		});
		expect(store.list()).toHaveLength(1);
	});

	it("computes first-pass, after-extension, malformed-report, and verification metrics", () => {
		const store = new SubagentTelemetryStore();
		store.record({
			runId: "first",
			profile: "explore",
			mode: "foreground",
			finalStatus: "completed",
			verificationPassed: true,
		});
		store.record({
			runId: "extended",
			profile: "worker",
			mode: "async",
			extensionCount: 2,
			finalStatus: "completed",
			verificationPassed: true,
		});
		store.record({
			runId: "malformed",
			profile: "worker",
			mode: "batch",
			finalStatus: "verification_failed",
			reportProtocolStatus: "malformed",
		});
		store.record({ runId: "verify-fail", profile: "review", mode: "review", finalStatus: "verification_failed" });
		const summary = store.summary();
		expect(summary.totalRuns).toBe(4);
		expect(summary.verifiedCompleted).toBe(2);
		expect(summary.firstPassVerified).toBe(1);
		expect(summary.verifiedAfterExtension).toBe(1);
		expect(summary.malformedReports).toBe(1);
		expect(summary.verificationFailures).toBe(2);
		expect(summary.averageExtensions).toBe(0.5);
		expect(summary.byProfile[0]).toMatchObject({ profile: "worker", runs: 2, verifiedCompleted: 1 });
	});

	it("separates plain acceptance from structured verification metrics", () => {
		const store = new SubagentTelemetryStore();
		store.record({
			runId: "plain",
			profile: "explore",
			mode: "foreground",
			finalStatus: "completed",
			reportProtocolStatus: "plain",
			verificationPassed: false,
		});
		store.record({
			runId: "structured",
			profile: "review",
			mode: "review",
			finalStatus: "completed",
			reportProtocolStatus: "valid",
			verificationPassed: true,
		});

		const summary = store.summary();
		expect(summary.completed).toBe(2);
		expect(summary.verifiedCompleted).toBe(1);
		expect(summary.firstPassVerified).toBe(1);
		expect(summary.verificationFailures).toBe(0);
		expect(summary.byProfile).toEqual([
			{ profile: "explore", runs: 1, verifiedCompleted: 0 },
			{ profile: "review", runs: 1, verifiedCompleted: 1 },
		]);
	});

	it("replaces a re-recorded run and keeps bounded retention", () => {
		const store = new SubagentTelemetryStore();
		store.record({ runId: "run", profile: "explore", mode: "foreground", finalStatus: "needs_time" });
		store.record({
			runId: "run",
			profile: "explore",
			mode: "foreground",
			finalStatus: "completed",
			verificationPassed: true,
			usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, cost: 0.25 },
		});
		expect(store.list()).toHaveLength(1);
		expect(store.list()[0]?.finalStatus).toBe("completed");
		expect(store.list()[0]?.usage).toEqual({
			inputTokens: 10,
			outputTokens: 4,
			cacheReadTokens: 2,
			cacheWriteTokens: 1,
			cost: 0.25,
		});
		for (let index = 0; index < SUBAGENT_TELEMETRY_LIMIT + 10; index++) {
			store.record({ runId: `bulk-${index}`, profile: "worker", mode: "batch", finalStatus: "completed" });
		}
		expect(store.list()).toHaveLength(SUBAGENT_TELEMETRY_LIMIT);
	});

	it("rejects invalid records deterministically", () => {
		const store = new SubagentTelemetryStore();
		expect(store.record({ runId: "", profile: "x", mode: "foreground", finalStatus: "completed" })).toBeUndefined();
		expect(store.record({ runId: "r", profile: "", mode: "foreground", finalStatus: "completed" })).toBeUndefined();
		expect(
			store.record({ runId: "r", profile: "x", mode: "recursive" as never, finalStatus: "completed" }),
		).toBeUndefined();
		expect(store.list()).toHaveLength(0);
	});

	it("never retains prompt bodies or credentials and formats bounded rows", () => {
		const store = new SubagentTelemetryStore();
		store.record({ runId: "run with secret", profile: "explore", mode: "foreground", finalStatus: "completed" });
		for (const record of store.list()) {
			expect(record.runId).not.toContain(" ");
		}
		store.record({
			runId: "ok",
			profile: "explore",
			mode: "foreground",
			finalStatus: "completed",
			verificationPassed: true,
		});
		const rows = formatSubagentTelemetrySummary(store.summary());
		expect(rows[0]).toContain("TELEMETRY");
		expect(rows.join("\n")).toContain("first-pass 1");
		expect(formatSubagentTelemetrySummary(new SubagentTelemetryStore().summary())).toEqual([]);
	});

	it("keeps recording when subscribers throw", () => {
		const store = new SubagentTelemetryStore();
		const listener = vi.fn(() => {
			throw new Error("subscriber failure");
		});
		store.subscribe(listener);
		store.record({ runId: "run", profile: "explore", mode: "foreground", finalStatus: "completed" });
		expect(listener).toHaveBeenCalledTimes(1);
		expect(store.list()).toHaveLength(1);
	});
});
