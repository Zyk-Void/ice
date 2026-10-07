import { describe, expect, it } from "vitest";
import type { SubagentJobInspection, SubagentJobResultEnvelope } from "../src/subagents/registry/jobs.ts";
import {
	buildSubagentQualityTelemetry,
	formatWeakRunDiagnostics,
	renderSubagentQualityTelemetry,
	SUBAGENT_QUALITY_TELEMETRY_MAX_BYTES,
	SUBAGENT_WEAK_RUN_DIAGNOSTIC_CODES,
	type SubagentQualityTelemetryInput,
} from "../src/subagents/telemetry/quality.ts";
import {
	type DurableSubagentJobResultView,
	formatDurableSubagentJobDetail,
	projectDurableSubagentJobResult,
} from "../src/subagents/ui/observatory.ts";

const TASK_HASH = "a".repeat(64);
const CONTEXT_HASH = "b".repeat(64);

function fullInput(overrides: Partial<SubagentQualityTelemetryInput> = {}): SubagentQualityTelemetryInput {
	return {
		taskContractHash: TASK_HASH,
		contextManifestHash: CONTEXT_HASH,
		qualityMode: "standard",
		assurance: "verification_executed",
		reportMode: "structured_report",
		reasoningLevel: "high",
		criteriaTotal: 3,
		criteriaRequired: 2,
		criteriaVerified: 3,
		unresolvedClaims: 0,
		evidenceCount: 2,
		followUpCount: 1,
		repeatedFailureCount: 0,
		reviewerUsed: true,
		reviewerOutcome: "verified",
		finalStatus: "completed",
		...overrides,
	};
}

describe("buildSubagentQualityTelemetry", () => {
	it("builds a frozen record with every field set from a full input", () => {
		const telemetry = buildSubagentQualityTelemetry(fullInput());
		expect(telemetry).toEqual({
			taskContractHash: TASK_HASH,
			contextManifestHash: CONTEXT_HASH,
			qualityMode: "standard",
			assurance: "verification_executed",
			reportMode: "structured_report",
			reasoningLevel: "high",
			criteriaTotal: 3,
			criteriaRequired: 2,
			criteriaVerified: 3,
			unresolvedClaims: 0,
			evidenceCount: 2,
			followUpCount: 1,
			repeatedFailureCount: 0,
			reviewerUsed: true,
			reviewerOutcome: "verified",
			finalStatus: "completed",
		});
		expect(Object.isFrozen(telemetry)).toBe(true);
	});

	it("omits undefined optionals for a partial input and defaults counts to 0", () => {
		const telemetry = buildSubagentQualityTelemetry({ finalStatus: "failed" });
		expect(telemetry.finalStatus).toBe("failed");
		for (const key of [
			"taskContractHash",
			"contextManifestHash",
			"qualityMode",
			"assurance",
			"reportMode",
			"reasoningLevel",
			"reviewerOutcome",
		]) {
			expect(key in telemetry).toBe(false);
		}
		expect(telemetry.criteriaTotal).toBe(0);
		expect(telemetry.criteriaRequired).toBe(0);
		expect(telemetry.criteriaVerified).toBe(0);
		expect(telemetry.unresolvedClaims).toBe(0);
		expect(telemetry.evidenceCount).toBe(0);
		expect(telemetry.followUpCount).toBe(0);
		expect(telemetry.repeatedFailureCount).toBe(0);
		expect(telemetry.reviewerUsed).toBe(false);
		expect(Object.keys(telemetry).sort()).toEqual([
			"criteriaRequired",
			"criteriaTotal",
			"criteriaVerified",
			"evidenceCount",
			"finalStatus",
			"followUpCount",
			"repeatedFailureCount",
			"reviewerUsed",
			"unresolvedClaims",
		]);
	});

	it("coerces invalid counts to 0 without throwing", () => {
		const telemetry = buildSubagentQualityTelemetry({
			finalStatus: "completed",
			criteriaTotal: -1,
			criteriaRequired: Number.NaN,
			criteriaVerified: 2.5,
			unresolvedClaims: "3",
			evidenceCount: Number.POSITIVE_INFINITY,
			followUpCount: Number.MAX_SAFE_INTEGER + 1,
			repeatedFailureCount: null,
			reviewerUsed: "yes",
		});
		expect(telemetry.criteriaTotal).toBe(0);
		expect(telemetry.criteriaRequired).toBe(0);
		expect(telemetry.criteriaVerified).toBe(0);
		expect(telemetry.unresolvedClaims).toBe(0);
		expect(telemetry.evidenceCount).toBe(0);
		expect(telemetry.followUpCount).toBe(0);
		expect(telemetry.repeatedFailureCount).toBe(0);
		expect(telemetry.reviewerUsed).toBe(false);
	});

	it("redacts credentials and bounds string fields", () => {
		const telemetry = buildSubagentQualityTelemetry({
			finalStatus: "completed with Bearer sk-test-abc123",
			reasoningLevel: "high Bearer sk-test-abc123",
		});
		expect(telemetry.finalStatus).toContain("[REDACTED]");
		expect(telemetry.finalStatus).not.toContain("sk-test-abc123");
		expect(telemetry.reasoningLevel).toBeDefined();
		expect(telemetry.reasoningLevel).not.toContain("sk-test-abc123");
		expect(Buffer.byteLength(telemetry.reasoningLevel ?? "", "utf8")).toBeLessThanOrEqual(16);
	});

	it("truncates an oversized final status instead of throwing", () => {
		const telemetry = buildSubagentQualityTelemetry({ finalStatus: "x".repeat(5000) });
		expect(Buffer.byteLength(telemetry.finalStatus, "utf8")).toBeLessThanOrEqual(2048);
	});

	it("keeps only valid 64-character lowercase hex hashes", () => {
		const fromManifest = buildSubagentQualityTelemetry({
			taskContractHash: "not-a-hash",
			contextManifestHash: "A".repeat(64),
			contextManifest: { hash: CONTEXT_HASH, entries: [{ identifier: "file:src/a.ts" }] },
			finalStatus: "completed",
		});
		expect(fromManifest.taskContractHash).toBeUndefined();
		expect(fromManifest.contextManifestHash).toBe(CONTEXT_HASH);

		const direct = buildSubagentQualityTelemetry({ contextManifestHash: CONTEXT_HASH, finalStatus: "completed" });
		expect(direct.contextManifestHash).toBe(CONTEXT_HASH);

		const absent = buildSubagentQualityTelemetry({
			contextManifest: { hash: "short", entries: [] },
			finalStatus: "completed",
		});
		expect(absent.contextManifestHash).toBeUndefined();
	});

	it("omits enum-like fields that are not known members", () => {
		const telemetry = buildSubagentQualityTelemetry({
			qualityMode: "yolo",
			assurance: "titanium",
			reportMode: "json",
			reviewerOutcome: "maybe",
			finalStatus: "completed",
		});
		expect("qualityMode" in telemetry).toBe(false);
		expect("assurance" in telemetry).toBe(false);
		expect("reportMode" in telemetry).toBe(false);
		expect("reviewerOutcome" in telemetry).toBe(false);
	});
});

describe("renderSubagentQualityTelemetry", () => {
	it("renders deterministic key: value lines and contains the final status", () => {
		const first = renderSubagentQualityTelemetry(buildSubagentQualityTelemetry(fullInput()));
		const second = renderSubagentQualityTelemetry(buildSubagentQualityTelemetry(fullInput()));
		expect(first).toBe(second);
		expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(SUBAGENT_QUALITY_TELEMETRY_MAX_BYTES);
		expect(first).toContain(`task contract hash: ${TASK_HASH}`);
		expect(first).toContain(`context manifest hash: ${CONTEXT_HASH}`);
		expect(first).toContain("quality mode: standard");
		expect(first).toContain("assurance: verification_executed");
		expect(first).toContain("report mode: structured_report");
		expect(first).toContain("reasoning level: high");
		expect(first).toContain("criteria total: 3");
		expect(first).toContain("criteria required: 2");
		expect(first).toContain("criteria verified: 3");
		expect(first).toContain("unresolved claims: 0");
		expect(first).toContain("evidence count: 2");
		expect(first).toContain("follow-up count: 1");
		expect(first).toContain("repeated failure count: 0");
		expect(first).toContain("reviewer used: true");
		expect(first).toContain("reviewer outcome: verified");
		expect(first).toContain("final status: completed");
		expect(first).not.toContain("[truncated]");
	});

	it("caps the block at 2 KiB with a truncation marker when oversized", () => {
		const telemetry = buildSubagentQualityTelemetry(fullInput({ finalStatus: "x".repeat(5000) }));
		const rendered = renderSubagentQualityTelemetry(telemetry);
		expect(rendered).toBe(renderSubagentQualityTelemetry(telemetry));
		expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(SUBAGENT_QUALITY_TELEMETRY_MAX_BYTES);
		expect(rendered.endsWith("[truncated]")).toBe(true);
	});
});

describe("formatWeakRunDiagnostics", () => {
	it("returns no diagnostics for a healthy run", () => {
		const diagnostics = formatWeakRunDiagnostics(buildSubagentQualityTelemetry(fullInput()));
		expect(diagnostics).toEqual([]);
		expect(Object.isFrozen(diagnostics)).toBe(true);
	});

	it("flags evidence_unverified only for zero evidence on non-explore runs", () => {
		expect(formatWeakRunDiagnostics(buildSubagentQualityTelemetry(fullInput({ evidenceCount: 0 })))).toEqual([
			"evidence_unverified",
		]);
		expect(
			formatWeakRunDiagnostics(
				buildSubagentQualityTelemetry(fullInput({ evidenceCount: 0, qualityMode: "explore" })),
			),
		).toEqual([]);
		expect(formatWeakRunDiagnostics(buildSubagentQualityTelemetry(fullInput()))).not.toContain("evidence_unverified");
	});

	it("flags verification_not_run only for structured reports at unverified_plain assurance", () => {
		expect(
			formatWeakRunDiagnostics(
				buildSubagentQualityTelemetry(
					fullInput({ reportMode: "structured_report", assurance: "unverified_plain" }),
				),
			),
		).toEqual(["verification_not_run"]);
		expect(
			formatWeakRunDiagnostics(
				buildSubagentQualityTelemetry(fullInput({ reportMode: "plain_final_turn", assurance: "unverified_plain" })),
			),
		).toEqual([]);
		expect(
			formatWeakRunDiagnostics(
				buildSubagentQualityTelemetry(
					fullInput({ reportMode: "structured_report", assurance: "evidence_checked" }),
				),
			),
		).toEqual([]);
	});

	it("flags context_bootstrap_empty only when the manifest hash is absent", () => {
		expect(
			formatWeakRunDiagnostics(buildSubagentQualityTelemetry(fullInput({ contextManifestHash: undefined }))),
		).toEqual(["context_bootstrap_empty"]);
		expect(formatWeakRunDiagnostics(buildSubagentQualityTelemetry(fullInput()))).not.toContain(
			"context_bootstrap_empty",
		);
	});

	it("flags task_brief_under_specified only when the task contract hash is absent", () => {
		expect(
			formatWeakRunDiagnostics(buildSubagentQualityTelemetry(fullInput({ taskContractHash: undefined }))),
		).toEqual(["task_brief_under_specified"]);
		expect(formatWeakRunDiagnostics(buildSubagentQualityTelemetry(fullInput()))).not.toContain(
			"task_brief_under_specified",
		);
	});

	it("flags review_disagreement only when the reviewer disagreed", () => {
		expect(
			formatWeakRunDiagnostics(buildSubagentQualityTelemetry(fullInput({ reviewerOutcome: "disagreed" }))),
		).toEqual(["review_disagreement"]);
		expect(formatWeakRunDiagnostics(buildSubagentQualityTelemetry(fullInput({ reviewerOutcome: "none" })))).toEqual(
			[],
		);
	});

	it("emits every applicable code once, in deterministic order", () => {
		const telemetry = buildSubagentQualityTelemetry({
			qualityMode: "standard",
			reportMode: "structured_report",
			assurance: "unverified_plain",
			evidenceCount: 0,
			reviewerUsed: true,
			reviewerOutcome: "disagreed",
			finalStatus: "completed",
		});
		const diagnostics = formatWeakRunDiagnostics(telemetry);
		expect(diagnostics).toEqual([...SUBAGENT_WEAK_RUN_DIAGNOSTIC_CODES]);
		expect(formatWeakRunDiagnostics(telemetry)).toEqual(diagnostics);
	});
});

describe("durable observatory quality projection", () => {
	/** The durable envelope does not declare `assurance` yet; fixtures include it as the extension it is. */
	type QualityResultEnvelope = SubagentJobResultEnvelope;

	function inspectionFor(jobId: string, result: QualityResultEnvelope): SubagentJobInspection {
		return {
			job: {
				schemaVersion: 1,
				jobId,
				ownerSessionId: "owner-a",
				launchLeafId: "leaf-a",
				role: "explore",
				status: "completed",
				createdAt: "2026-01-01T00:00:00.000Z",
				finishedAt: "2026-01-01T00:00:02.000Z",
				resultRef: `job:${jobId}`,
			},
			result,
		};
	}

	it("passes quality metadata through to the durable result view", () => {
		const detail = projectDurableSubagentJobResult(
			inspectionFor("job-quality", {
				schemaVersion: 1,
				jobId: "job-quality",
				status: "completed",
				diagnostics: [],
				reportMode: "structured_report",
				qualityMode: "strict",
				assurance: "review_verified",
				taskContractHash: TASK_HASH,
			}),
		);
		expect(detail?.qualityMode).toBe("strict");
		expect(detail?.assurance).toBe("review_verified");
		expect(detail?.taskContractHash).toBe(TASK_HASH);
		const text = formatDurableSubagentJobDetail(detail!).join("\n");
		expect(text).toContain("Quality mode");
		expect(text).toContain("strict; assurance review_verified");
		expect(text).toContain("Task contract");
		expect(text).toContain(TASK_HASH);
	});

	it("omits quality rows when the result carries no quality metadata", () => {
		const detail = projectDurableSubagentJobResult(
			inspectionFor("job-plain", {
				schemaVersion: 1,
				jobId: "job-plain",
				status: "completed",
				diagnostics: [],
			}),
		);
		expect("qualityMode" in (detail ?? {})).toBe(false);
		expect("assurance" in (detail ?? {})).toBe(false);
		expect("taskContractHash" in (detail ?? {})).toBe(false);
		const text = formatDurableSubagentJobDetail(detail!).join("\n");
		expect(text).not.toContain("Quality mode");
		expect(text).not.toContain("Task contract");
	});

	it("formats quality mode without an assurance suffix when assurance is absent", () => {
		const view: DurableSubagentJobResultView = {
			schemaVersion: 1,
			jobId: "job-mode",
			status: "completed",
			role: "explore",
			resultRef: "job:job-mode",
			qualityMode: "strict",
			evidence: [],
			findings: [],
			diagnostics: [],
		};
		const text = formatDurableSubagentJobDetail(view).join("\n");
		expect(text).toContain("Quality mode");
		expect(text).toContain("strict");
		expect(text).not.toContain("assurance");
		expect(text).not.toContain("Task contract");
	});
});
