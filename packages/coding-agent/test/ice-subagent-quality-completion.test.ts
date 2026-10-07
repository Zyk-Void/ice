import { describe, expect, it } from "vitest";
import { buildSubagentTaskContract, recommendSubagentReviewerGate } from "../src/subagents/results/task-contract.ts";
import { buildSubagentQualityTelemetry, renderSubagentQualityTelemetry } from "../src/subagents/telemetry/quality.ts";

describe("subagent quality completion regressions", () => {
	it.each([
		["security", "Implement a security-sensitive policy change."],
		["migration", "Implement a schema migration for stored jobs."],
		["broad refactor", "Perform a broad refactor of the routing architecture."],
		["shared infrastructure", "Change shared infrastructure for durable jobs."],
	])("recommends review_batch for %s work even with deterministic tests", (_label, objective) => {
		const contract = buildSubagentTaskContract(objective, {
			kind: "implement",
			verification: { mode: "tests", commands: ["npm test"] },
		});
		const recommendation = recommendSubagentReviewerGate(contract);
		expect(recommendation).toMatch(/high-risk change/i);
		expect(recommendation).toMatch(/review_batch/);
	});

	it("recommends review_batch for a deterministic verification gap but not trivial verified work", () => {
		const noVerification = buildSubagentTaskContract("Implement the scoped change.", {
			kind: "implement",
			verification: { mode: "none" },
		});
		expect(recommendSubagentReviewerGate(noVerification)).toMatch(/deterministic verification gap/i);

		const trivial = buildSubagentTaskContract("Rename a local test variable.", {
			kind: "implement",
			verification: { mode: "tests", commands: ["npm test"] },
		});
		expect(recommendSubagentReviewerGate(trivial)).toBeUndefined();
	});

	it("records bounded semantic route and evidence-type provenance", () => {
		const telemetry = buildSubagentQualityTelemetry({
			workerTier: "judgment",
			routeSource: "tier",
			evidenceCount: 7,
			evidenceTypes: { path: 3, command: 2, artifact: 1, diff: 1, blocked: 0 },
			finalStatus: "completed",
		});
		expect(telemetry.workerTier).toBe("judgment");
		expect(telemetry.routeSource).toBe("tier");
		expect(telemetry.evidenceTypes).toEqual({ path: 3, command: 2, artifact: 1, diff: 1, blocked: 0 });
		const rendered = renderSubagentQualityTelemetry(telemetry);
		expect(rendered).toContain("worker tier: judgment");
		expect(rendered).toContain("route source: tier");
		expect(rendered).toContain("evidence types: path=3, command=2, artifact=1, diff=1, blocked=0");
	});

	it("sanitizes invalid route and evidence provenance without throwing", () => {
		const telemetry = buildSubagentQualityTelemetry({
			workerTier: "unknown",
			routeSource: "other",
			evidenceTypes: { path: -1, command: 1.5, artifact: 2, diff: 0, blocked: 1 },
			finalStatus: "failed",
		});
		expect(telemetry.workerTier).toBeUndefined();
		expect(telemetry.routeSource).toBeUndefined();
		expect(telemetry.evidenceTypes).toEqual({ path: 0, command: 0, artifact: 2, diff: 0, blocked: 1 });
	});
});
