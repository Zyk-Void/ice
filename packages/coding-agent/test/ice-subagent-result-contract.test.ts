import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionResult } from "../src/core/sdk.ts";
import {
	type IceHookDispatchRecord,
	IceSubagentHookDispatcher,
	parseIceHooksSettings,
	projectIceHookRecords,
	resolveIceSubagentHooks,
} from "../src/ice-subagent-settings.ts";
import {
	extractCandidateEvidencePaths,
	NativeSubagentRunner,
	normalizeSubagentRequest as normalizeSubagentRequestWithAgentDir,
	parseSubagentReportOutcome,
	type SubagentHookRuntime,
	type SubagentNormalizationOptions,
	type SubagentRequest,
	type SubagentResult,
	verifySubagentResult,
} from "../src/ice-subagents.ts";

const tempDirs: string[] = [];

function normalizeSubagentRequest(
	request: SubagentRequest,
	cwd: string,
	options: SubagentNormalizationOptions = {},
): ReturnType<typeof normalizeSubagentRequestWithAgentDir> {
	// This suite pins the structured report contract, which typed flows still run.
	const normalized = normalizeSubagentRequestWithAgentDir(request, cwd, {
		agentDir: join(cwd, ".ice-agent"),
		...options,
	});
	return { ...normalized, reportMode: "structured_report" };
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

async function workspace(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "ice-result-contract-"));
	tempDirs.push(cwd);
	await mkdir(join(cwd, "src"), { recursive: true });
	await writeFile(join(cwd, "src", "app.ts"), "export const app = true;\n");
	return cwd;
}

function request(cwd: string, overrides: Partial<SubagentRequest> = {}): SubagentRequest {
	return {
		parentSessionId: "parent-contract",
		role: "self",
		self: {
			instructions: "Inspect the scoped app entry point and preserve evidence.",
			capabilities: ["read", "grep", "find", "ls"],
		},
		task: "Inspect the scoped app entry point.",
		scope: { roots: ["src"] },
		cwd,
		...overrides,
	};
}

function assistantMessage(text: string, stopReason = "stop"): AgentMessage {
	return { role: "assistant", content: text, stopReason } as unknown as AgentMessage;
}

interface FakeChildOptions {
	firstResponse: string | Error;
	repairResponse?: string | Error;
	failRepairPrompt?: Error;
	emitProgress?: boolean;
}

function fakeChildSession(options: FakeChildOptions) {
	const messages: AgentMessage[] = [];
	const prompts: string[] = [];
	const activeToolCalls: string[][] = [];
	const listeners: Array<(event: unknown) => void> = [];
	const notifyProgress = (): void => {
		if (!options.emitProgress) return;
		for (const listener of listeners) {
			listener({ type: "turn_start" });
			listener({ type: "message_update" });
		}
	};
	const session = {
		sessionId: "child-contract",
		model: {} as Model<Api>,
		messages,
		extensionRunner: { hasHandlers: () => false, emit: async () => undefined },
		subscribe: vi.fn((listener: (event: unknown) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		}),
		getActiveToolNames: vi.fn(() => activeToolCalls.at(-1) ?? ["read"]),
		setActiveToolsByName: vi.fn((names: string[]) => {
			activeToolCalls.push([...names]);
		}),
		prompt: vi.fn(async (text: string) => {
			prompts.push(text);
			if (prompts.length === 1) {
				if (options.firstResponse instanceof Error) throw options.firstResponse;
				messages.push(assistantMessage(options.firstResponse));
				notifyProgress();
				return;
			}
			if (text.startsWith("[ICE VOID SUBAGENT REPORT REPAIR]")) {
				if (options.failRepairPrompt) throw options.failRepairPrompt;
				if (options.repairResponse === undefined) throw new Error("unexpected repair prompt");
				if (options.repairResponse instanceof Error) throw options.repairResponse;
				messages.push(assistantMessage(options.repairResponse));
				notifyProgress();
				return;
			}
			throw new Error(`Unexpected child prompt: ${text.slice(0, 48)}`);
		}),
		abort: vi.fn(async () => {}),
		dispose: vi.fn(),
		getSessionStats: vi.fn(() => ({
			tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			cost: 0,
		})),
	};
	return { session: session as unknown as CreateAgentSessionResult["session"], messages, prompts, raw: session };
}

function validReport(summary = " inspected the app"): string {
	return JSON.stringify({ summary, evidence: { paths: ["src/app.ts"] } });
}

describe("subagent final report parse outcomes", () => {
	it("parses a valid bounded report", () => {
		const outcome = parseSubagentReportOutcome(validReport(), 64 * 1024);
		expect(outcome.kind).toBe("valid");
		if (outcome.kind === "valid") {
			expect(outcome.report.paths).toEqual(["src/app.ts"]);
			expect(outcome.report.requirementClaims).toEqual([]);
		}
	});

	it("returns malformed diagnostics instead of throwing", () => {
		for (const text of ["not-json", '{"summary":"", "evidence":{"paths":[]}}', '{"summary":"s"}']) {
			const outcome = parseSubagentReportOutcome(text, 64 * 1024);
			expect(outcome.kind).toBe("malformed");
			if (outcome.kind === "malformed") expect(outcome.diagnostic.length).toBeGreaterThan(0);
		}
	});

	it("returns a bounded truncated outcome for oversized reports", () => {
		const outcome = parseSubagentReportOutcome(validReport("x".repeat(4096)), 1024);
		expect(outcome.kind).toBe("truncated");
	});

	it("treats an empty report as a protocol failure", () => {
		const outcome = parseSubagentReportOutcome("   \n", 64 * 1024);
		expect(outcome.kind).toBe("malformed");
	});

	it("extracts bounded candidate evidence paths from unparseable text", () => {
		const text = `I edited src/app.ts and src/types.d.ts plus "src/generated.ts". Long path: "${"a/".repeat(600)}b.ts"`;
		const candidates = extractCandidateEvidencePaths(text);
		expect(candidates.length).toBeGreaterThan(0);
		expect(candidates.length).toBeLessThanOrEqual(16);
		expect(candidates).toContain("src/app.ts");
	});
});

describe("subagent requirement claims", () => {
	it("parses bounded requirement claims deterministically", () => {
		const outcome = parseSubagentReportOutcome(
			JSON.stringify({
				summary: "done",
				evidence: { paths: ["src/app.ts"] },
				requirements: [
					{ id: "ownership", status: "satisfied", evidencePaths: ["src/app.ts"] },
					{ id: "ownership", status: "partial" },
					{ id: "extra-unknown", status: "satisfied" },
				],
			}),
			64 * 1024,
		);
		expect(outcome.kind).toBe("valid");
		if (outcome.kind === "valid") {
			expect(outcome.report.requirementClaims).toHaveLength(2);
			expect(outcome.report.requirementClaims[0]).toMatchObject({ id: "ownership", status: "satisfied" });
		}
	});

	it("rejects invalid requirement claims as malformed reports", () => {
		const outcome = parseSubagentReportOutcome(
			JSON.stringify({
				summary: "done",
				evidence: { paths: ["src/app.ts"] },
				requirements: [{ id: "bad status", status: "banana" }],
			}),
			64 * 1024,
		);
		expect(outcome.kind).toBe("malformed");
	});
});

describe("result contract: malformed reports preserve work artifacts", () => {
	it("keeps a valid report completed and verified", async () => {
		const cwd = await workspace();
		const child = fakeChildSession({ firstResponse: validReport() });
		const normalized = normalizeSubagentRequest(request(cwd), cwd);
		const result = await new NativeSubagentRunner({
			createSession: async () => ({ session: child.session }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"]);
		expect(result.status).toBe("completed");
		expect(verifySubagentResult(result, normalized)).toMatchObject({ verified: true });
	});

	it("emits and returns a parent-owned checkpoint observation at a native progress boundary", async () => {
		const cwd = await workspace();
		const child = fakeChildSession({ firstResponse: validReport(), emitProgress: true });
		const parsedHooks = parseIceHooksSettings({
			definitions: [{ id: "checkpoint", event: "subagent.checkpoint", required: false }],
		});
		const hooks = resolveIceSubagentHooks({ hooks: parsedHooks, role: "self" });
		const records: IceHookDispatchRecord[] = [];
		const observations: Readonly<Record<string, unknown>>[] = [];
		const hookRuntime: SubagentHookRuntime = {
			dispatcher: new IceSubagentHookDispatcher({
				handlers: {
					checkpoint: ({ payload }) => {
						observations.push(payload);
						return { outcome: "continue" as const };
					},
				},
				onRecord: (record) => records.push(record),
			}),
			hooks,
			records,
			pendingObservations: new Set(),
			ownerSessionId: "parent-contract",
			runId: "run-checkpoint",
			role: "self",
		};
		const normalized = normalizeSubagentRequest(request(cwd), cwd);
		const result = await new NativeSubagentRunner({
			createSession: async () => ({ session: child.session }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"], { hookRuntime });
		const checkpoint = result.hookRecords?.find((record) => record.event === "subagent.checkpoint");
		expect(checkpoint).toMatchObject({
			hookId: "checkpoint",
			event: "subagent.checkpoint",
			outcome: "continue",
			observational: true,
			ownerSessionId: "parent-contract",
			runId: "run-checkpoint",
		});
		expect(observations).toHaveLength(1);
		expect(observations[0]).toMatchObject({ observedTurns: 1 });
		expect(projectIceHookRecords(result.hookRecords ?? [])).toMatchObject([
			{ event: "subagent.checkpoint", outcome: "continue", observational: true },
		]);
	});

	it("rejects a valid report when parent authority is revoked before acceptance", async () => {
		const cwd = await workspace();
		const child = fakeChildSession({ firstResponse: validReport() });
		const normalized = normalizeSubagentRequest(request(cwd), cwd);
		const result = await new NativeSubagentRunner({
			createSession: async () => ({ session: child.session }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"], { isAuthorityStillValid: () => false });
		expect(result.status).toBe("failed");
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "capability_denied" })]),
		);
		expect(child.raw.prompt).toHaveBeenCalled();
	});

	it("returns a validated bounded custom payload without replacing the outer envelope", async () => {
		const cwd = await workspace();
		const child = fakeChildSession({
			firstResponse: JSON.stringify({
				summary: "payload report",
				evidence: { paths: ["src/app.ts"] },
				payload: { severity: "high" },
			}),
		});
		const normalized = normalizeSubagentRequest(
			request(cwd, {
				outputSchema: {
					type: "object",
					properties: { severity: { type: "string" } },
					required: ["severity"],
					additionalProperties: false,
				},
			}),
			cwd,
		);
		const result = await new NativeSubagentRunner({
			createSession: async () => ({ session: child.session }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"]);
		expect(result.status).toBe("completed");
		expect(result.payload).toEqual({ severity: "high" });
		expect(result.evidence).toEqual({ paths: ["src/app.ts"] });
	});

	it("caps the complete serialized parent-facing envelope, not only report text", async () => {
		const cwd = await workspace();
		const response = JSON.stringify({
			summary: "large findings",
			evidence: { paths: ["src/app.ts"] },
			findings: Array.from({ length: 32 }, (_, index) => ({
				severity: "medium",
				category: `category-${index}`,
				claim: "x".repeat(1800),
				evidence: [{ path: "src/app.ts" }],
			})),
		});
		const maxBytes = Buffer.byteLength(response);
		const child = fakeChildSession({ firstResponse: response });
		const normalized = normalizeSubagentRequest(request(cwd, { execution: { maxOutputBytes: maxBytes } }), cwd);
		const result = await new NativeSubagentRunner({
			createSession: async () => ({ session: child.session }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"]);
		expect(result.status).toBe("verification_failed");
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("report_protocol_failure");
		expect(result.diagnostics.map((diagnostic) => diagnostic.message).join(" ")).toMatch(
			/parent-facing result envelope/i,
		);
	});

	it("does not spend a report-repair turn after a one-turn budget is exhausted", async () => {
		const cwd = await workspace();
		const child = fakeChildSession({ firstResponse: "not json", repairResponse: validReport("should not run") });
		const normalized = normalizeSubagentRequest(request(cwd, { execution: { maxTurns: 1 } }), cwd);
		const result = await new NativeSubagentRunner({
			createSession: async () => ({ session: child.session }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"]);
		expect(result.status).toBe("failed");
		expect(child.raw.prompt).toHaveBeenCalledTimes(1);
		expect(result.diagnostics.some((diagnostic) => /turn budget/i.test(diagnostic.message))).toBe(true);
	});

	it("preserves a bounded artifact when a successful edit precedes a malformed report", async () => {
		const cwd = await workspace();
		const reportText = "I updated src/app.ts but here is my prose, not JSON.";
		const child = fakeChildSession({ firstResponse: reportText });
		// Simulate observed write/edit activity feeding the artifact.
		const originalPrompt = child.raw.prompt.getMockImplementation()!;
		child.raw.prompt.mockImplementation(async (text: string) => {
			if (child.raw.prompt.mock.calls.length === 1) {
				child.raw.subscribe.mock.calls.forEach(() => {});
				// Emit a fake write tool activity through the subscription channel.
				const listener = (child.raw.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
					| ((event: unknown) => void)
					| undefined;
				listener?.({
					type: "tool_execution_start",
					toolCallId: "w1",
					toolName: "write",
					args: { path: join(cwd, "src", "app.ts") },
				});
				listener?.({ type: "tool_execution_end", toolCallId: "w1", toolName: "write", isError: false, result: {} });
			}
			return originalPrompt(text);
		});
		const normalized = normalizeSubagentRequest(request(cwd), cwd);
		const result = await new NativeSubagentRunner({
			createSession: async () => ({ session: child.session }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"]);
		expect(result.status).toBe("verification_failed");
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("report_protocol_failure");
		expect(result.workArtifact).toBeDefined();
		expect(result.workArtifact?.reportProtocol).toMatchObject({ status: "malformed" });
		expect(result.workArtifact?.candidateEvidencePaths).toContain("src/app.ts");
		// Malformed reports can never fabricate verified evidence.
		const verification = verifySubagentResult(result, normalized);
		expect(verification.verified).toBe(false);
		expect(result.evidence).toBeUndefined();
	});

	it("does not loop: a failed repair is attempted exactly once", async () => {
		const cwd = await workspace();
		const child = fakeChildSession({
			firstResponse: "still not json",
			repairResponse: "repair also not json",
		});
		const normalized = normalizeSubagentRequest(request(cwd), cwd);
		const result = await new NativeSubagentRunner({
			createSession: async () => ({ session: child.session }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"]);
		expect(result.status).toBe("verification_failed");
		expect(child.raw.prompt).toHaveBeenCalledTimes(2);
		expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "report_protocol_failure")).toHaveLength(2);
		expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("repair"))).toBe(true);
	});

	it("repairs a malformed report once and then completes verified", async () => {
		const cwd = await workspace();
		const child = fakeChildSession({
			firstResponse: "prose, not json",
			repairResponse: validReport("repaired summary"),
		});
		const normalized = normalizeSubagentRequest(request(cwd), cwd);
		const result = await new NativeSubagentRunner({
			createSession: async () => ({ session: child.session }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"]);
		expect(result.status).toBe("completed");
		expect(result.summary).toBe("repaired summary");
		expect(verifySubagentResult(result, normalized).verified).toBe(true);
		expect(child.raw.prompt).toHaveBeenCalledTimes(2);
		// Repair prompts request only the internal envelope and never a new task.
		expect(child.prompts[1]).toContain("[ICE VOID SUBAGENT REPORT REPAIR]");
		expect(child.prompts[1]).not.toContain("Inspect the scoped app entry point.");
	});

	it("never triggers report repair for parent cancellation", async () => {
		const cwd = await workspace();
		const child = fakeChildSession({ firstResponse: new Error("stream aborted") });
		const normalized = normalizeSubagentRequest(request(cwd), cwd);
		const controller = new AbortController();
		const result = await new NativeSubagentRunner({
			createSession: async () => ({ session: child.session }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"], { signal: controller.signal });
		expect(["failed", "cancelled"]).toContain(result.status);
		expect(child.raw.prompt).toHaveBeenCalledTimes(1);
	});

	it("keeps a runtime stream failure as failed, not verification_failed", async () => {
		const cwd = await workspace();
		const messages: AgentMessage[] = [];
		const session = {
			sessionId: "child-stream-fail",
			model: {} as Model<Api>,
			messages,
			extensionRunner: { hasHandlers: () => false, emit: async () => undefined },
			subscribe: vi.fn(() => vi.fn()),
			prompt: vi.fn(async () => {
				// The stream failed without ever producing an assistant turn.
			}),
			abort: vi.fn(async () => {}),
			dispose: vi.fn(),
			getSessionStats: vi.fn(() => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 })),
		};
		const normalized = normalizeSubagentRequest(request(cwd), cwd);
		const result = await new NativeSubagentRunner({
			createSession: async () =>
				({ session: session as unknown as CreateAgentSessionResult["session"] }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"]);
		expect(result.status).toBe("failed");
	});
});

describe("requirement-level verification", () => {
	async function criteriaWorkspace() {
		const cwd = await workspace();
		const normalized = normalizeSubagentRequest(
			request(cwd, {
				acceptanceCriteria: [
					{ id: "ownership", requirement: "Report file ownership.", evidence: "path" },
					{ id: "visual", requirement: "Visual hierarchy is clear.", dimension: "visual" },
					{ id: "nice-to-have", requirement: "Optional extra.", required: false },
				],
			}),
			cwd,
		);
		return { cwd, normalized };
	}

	function resultWith(
		normalized: ReturnType<typeof normalizeSubagentRequest>,
		overrides: Partial<SubagentResult> & { requirements?: unknown[] } = {},
	): SubagentResult {
		const { requirements, ...rest } = overrides;
		const base: SubagentResult = {
			runId: normalized.runId,
			parentSessionId: normalized.parentSessionId,
			childSessionId: "child-1",
			profile: normalized.role,
			source: normalized.profile.source,
			status: "completed",
			summary: "done",
			observedOutputBytes: 32,
			partial: false,
			diagnostics: [],
			evidence: { paths: ["src/app.ts"] },
			...(requirements !== undefined
				? { requirementClaims: requirements as SubagentResult["requirementClaims"] }
				: {}),
			...rest,
		};
		return base;
	}

	it("allows completion when every required criterion is satisfied", async () => {
		const { normalized } = await criteriaWorkspace();
		const result = resultWith(normalized, {
			requirements: [
				{ id: "ownership", status: "satisfied", evidencePaths: ["src/app.ts"] },
				{ id: "visual", status: "satisfied" },
				{ id: "nice-to-have", status: "not_attempted" },
			],
		});
		const verification = verifySubagentResult(result, normalized);
		expect(verification.verified).toBe(true);
		expect(verification.requirementSummary).toMatchObject({ required: 2, requiredSatisfied: 2 });
		// Optional incomplete criteria stay visible without failing completion.
		expect(verification.unresolvedClaims.join(" ")).toContain("nice-to-have");
	});

	it("fails verification when a required criterion claim is missing", async () => {
		const { normalized } = await criteriaWorkspace();
		const result = resultWith(normalized, {
			requirements: [{ id: "ownership", status: "satisfied", evidencePaths: ["src/app.ts"] }],
		});
		const verification = verifySubagentResult(result, normalized);
		expect(verification.verified).toBe(false);
		expect(verification.reason).toContain("visual");
		expect(verification.reason).toContain("visual acceptance pending");
	});

	it("fails verification when a required criterion is partial, blocked, or failed", async () => {
		const cwd = await workspace();
		for (const status of ["partial", "blocked", "failed", "not_attempted"] as const) {
			const withPartial = normalizeSubagentRequest(
				request(cwd, {
					acceptanceCriteria: [
						{ id: "ownership", requirement: "Report file ownership.", evidence: "path" },
						{ id: "required-partial", requirement: "Must be complete." },
					],
				}),
				cwd,
			);
			const verification = verifySubagentResult(
				resultWith(withPartial, {
					requirementClaims: [
						{ id: "ownership", status: "satisfied", evidencePaths: ["src/app.ts"] },
						{ id: "required-partial", status },
					],
				}),
				withPartial,
			);
			expect(verification.verified, `status ${status} must fail verification`).toBe(false);
			expect(verification.reason).toContain("required-partial");
		}
	});

	it("fails verification when declared path evidence is missing or outside scope", async () => {
		const { cwd, normalized } = await criteriaWorkspace();
		await writeFile(join(cwd, "outside.txt"), "outside the approved roots\n");
		const missing = verifySubagentResult(
			resultWith(normalized, {
				requirements: [
					{ id: "ownership", status: "satisfied", evidencePaths: ["src/does-not-exist.ts"] },
					{ id: "visual", status: "satisfied" },
				],
			}),
			normalized,
		);
		expect(missing.verified).toBe(false);
		expect(missing.reason).toContain("does-not-exist");

		const outside = verifySubagentResult(
			resultWith(normalized, {
				requirements: [
					{ id: "ownership", status: "satisfied", evidencePaths: ["outside.txt"] },
					{ id: "visual", status: "satisfied" },
				],
			}),
			normalized,
		);
		expect(outside.verified).toBe(false);
		expect(outside.reason).toMatch(/outside approved scope/);
	});

	it("requires declared path evidence for path-evidence criteria", async () => {
		const cwd = await workspace();
		const normalized = normalizeSubagentRequest(
			request(cwd, {
				acceptanceCriteria: [{ id: "ownership", requirement: "Report file ownership.", evidence: "path" }],
			}),
			cwd,
		);
		const result = resultWith(normalized, { requirements: [{ id: "ownership", status: "satisfied" }] });
		const verification = verifySubagentResult(result, normalized);
		expect(verification.verified).toBe(false);
		expect(verification.reason).toContain("without declared path evidence");
	});

	it("renders a bounded requirement summary", async () => {
		const cwd = await workspace();
		const normalized = normalizeSubagentRequest(
			request(cwd, {
				acceptanceCriteria: [
					{ id: "ownership", requirement: "Ownership." },
					{ id: "capture", requirement: "Capture." },
					{ id: "visual", requirement: "Visual.", dimension: "visual" },
				],
			}),
			cwd,
		);
		const result = resultWith(normalized, {
			requirements: [
				{ id: "ownership", status: "satisfied", evidencePaths: ["src/app.ts"] },
				{ id: "capture", status: "satisfied", evidencePaths: ["src/app.ts"] },
				{ id: "visual", status: "partial", note: "spacing off" },
			],
		});
		const verification = verifySubagentResult(result, normalized);
		expect(verification.verified).toBe(false);
		expect(verification.reason).toContain("Functional verification passed; visual acceptance pending");
		expect(verification.requirementSummary?.states.map((state) => state.id)).toEqual([
			"ownership",
			"capture",
			"visual",
		]);
	});
});
