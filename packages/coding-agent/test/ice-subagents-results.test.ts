import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import type { Context } from "@zykairotis/ice-ai";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { fauxAssistantMessage, registerFauxProvider } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import type { CreateAgentSessionResult } from "../src/core/sdk.ts";
import iceSubagents, {
	integrateWriterPatchArtifact,
	NativeSubagentRunner,
	runResolvedSubagentBatch,
	runSubagentWithRecovery,
	SUBAGENT_REPORT_ARTIFACT_LIMITS,
	type SubagentResult,
	truncateSubagentOutput,
	verifySubagentResult,
	type WriterPatchVerificationContext,
	writeSubagentReportArtifact,
} from "../src/ice-subagents.ts";
import { SubagentOutputArtifactStore } from "../src/subagents/results/output-artifacts.ts";
import { getProgressSnapshot } from "../src/subagents/ui/observatory.ts";
import {
	batchResult,
	createAsyncToolHarness,
	createFauxChildRuntime,
	createGitWorkspace,
	createNoopExtensionRunner,
	createWorkspace,
	createWriterArtifact,
	git,
	normalizeSubagentRequest,
	request,
	resolvedBatchTask,
	tempDirs,
	testModel,
	verificationFixture,
} from "./ice-subagents-harness.ts";

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ICE subagent contracts", () => {
	it("rejects a tampered artifact before parent mutation", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const artifact = await createWriterArtifact(cwd, head, artifactRoot, "src/child.ts", "child\n");
		const verifier = vi.fn(async () => {});

		await expect(
			integrateWriterPatchArtifact(
				{ ...artifact, patchSha256: "0".repeat(64) },
				{ cwd, scopeRoots: ["src"], verify: verifier },
			),
		).rejects.toThrow(/hash/i);
		expect(verifier).not.toHaveBeenCalled();
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");
	});

	it("rejects a dirty parent before artifact application", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const artifact = await createWriterArtifact(cwd, head, artifactRoot, "src/child.ts", "child\n");
		await writeFile(join(cwd, "src", "parent-change.ts"), "parent\n");
		const verifier = vi.fn(async () => {});

		await expect(
			integrateWriterPatchArtifact(artifact, { cwd, scopeRoots: ["src"], verify: verifier }),
		).rejects.toThrow(/clean|parent/i);
		expect(verifier).not.toHaveBeenCalled();
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("?? src/parent-change.ts\n");
	});

	it("keeps artifact expectations immutable during verification", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const artifact = await createWriterArtifact(cwd, head, artifactRoot, "src/file.ts", "changed\n");
		const expectedAfterSha256 = artifact.files[0]!.afterSha256;
		const newerAfterSha256 = createHash("sha256").update("newer\n").digest("hex");
		let verifiedAfterSha256: string | undefined;
		const verifier = vi.fn(async ({ parentRoot, artifact: verifiedArtifact }: WriterPatchVerificationContext) => {
			await writeFile(join(parentRoot, "src", "file.ts"), "newer\n");
			artifact.files[0]!.afterSha256 = newerAfterSha256;
			Reflect.set(verifiedArtifact.files[0]!, "afterSha256", newerAfterSha256);
			verifiedAfterSha256 = verifiedArtifact.files[0]!.afterSha256;
		});

		await expect(
			integrateWriterPatchArtifact(artifact, { cwd, scopeRoots: ["src"], verify: verifier }),
		).rejects.toThrow(/conflict|rollback/i);
		expect(verifiedAfterSha256).toBe(expectedAfterSha256);
		expect(artifact.files[0]!.afterSha256).toBe(newerAfterSha256);
		expect(await readFile(join(cwd, "src", "file.ts"), "utf8")).toBe("newer\n");
	});

	it("bounds output by UTF-8 bytes and marks truncation", () => {
		expect(truncateSubagentOutput("ok", 10)).toEqual({ text: "ok", truncated: false });
		expect(truncateSubagentOutput("😀😀", 5)).toEqual({ text: "😀", truncated: true });
	});

	it("rejects removed caller-controlled execution output budgets before launch", async () => {
		const cwd = await createWorkspace();
		expect(() =>
			normalizeSubagentRequest({ ...request(cwd), execution: { maxOutputBytes: 1_024 } as never }, cwd),
		).toThrowError(/execution\.maxOutputBytes.*removed/i);
		expect(() =>
			normalizeSubagentRequest({ ...request(cwd), execution: { maxTotalTokens: 20_000 } as never }, cwd),
		).toThrowError(/maxTotalTokens.*removed/i);
	});

	it("preserves task and report semantics across native child compaction", async () => {
		const cwd = await createWorkspace();
		const agentDir = join(cwd, ".ice-agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(cwd, "src", "semantic.txt"), "semantic evidence\n");
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 128, midRunCompaction: "resume" } }),
		);
		const taskMarker = "SEMANTIC_TASK_OBJECTIVE_91";
		const acceptanceMarker = "SEMANTIC_ACCEPTANCE_REQUIREMENT_37";
		const reportMarker = "SEMANTIC_REPORT_MODE_62";
		const summaryMarker = `${taskMarker} ${acceptanceMarker} ${reportMarker}`;
		const faux = registerFauxProvider();
		try {
			const { model, modelRuntime } = await createFauxChildRuntime(cwd, faux);
			let compactionContext: Context | undefined;
			let resumedContext: Context | undefined;
			faux.setResponses([
				fauxAssistantMessage("partial child response", { stopReason: "length" }),
				(context) => {
					compactionContext = context;
					return fauxAssistantMessage(`Preserved summary: ${summaryMarker}`);
				},
				(context) => {
					resumedContext = context;
					return fauxAssistantMessage(
						JSON.stringify({
							summary: "semantic child report",
							evidence: { paths: ["src/semantic.txt"] },
							requirements: [
								{
									id: "preserve-semantics",
									status: "satisfied",
									note: summaryMarker,
									evidencePaths: ["src/semantic.txt"],
								},
							],
						}),
					);
				},
			]);
			const normalized = normalizeSubagentRequest(
				{
					...request(cwd),
					task: `Complete ${taskMarker} while retaining the approved evidence contract.`,
					contextPacket: {
						items: [{ id: "report-mode", kind: "parent_note", content: reportMarker }],
					},
					acceptanceCriteria: [
						{
							id: "preserve-semantics",
							requirement: `The final report must retain ${acceptanceMarker}.`,
							required: true,
							evidence: "path",
							dimension: "correctness",
						},
					],
				},
				cwd,
				{ agentDir },
			);
			const result = await new NativeSubagentRunner({ agentDir }).runResolved(normalized, ["delegate", "read"], {
				model,
				modelRuntime,
			});

			expect(result.status).toBe("completed");
			expect(JSON.stringify(compactionContext)).toContain(taskMarker);
			expect(JSON.stringify(compactionContext)).toContain(acceptanceMarker);
			expect(JSON.stringify(compactionContext)).toContain(reportMarker);
			expect(JSON.stringify(resumedContext)).toContain(summaryMarker);
			expect(result.requirementClaims).toEqual([
				expect.objectContaining({ id: "preserve-semantics", status: "satisfied" }),
			]);
		} finally {
			faux.unregister();
		}
	});

	it("bounds and redacts report artifacts before returning their pointer", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-report-artifact-"));
		tempDirs.push(artifactRoot);
		const content = `api_key=secret-token\n${"x".repeat(SUBAGENT_REPORT_ARTIFACT_LIMITS.maxBytes + 128)}`;
		const artifact = writeSubagentReportArtifact({
			runId: "artifact-boundary",
			content,
			artifactRoot,
			contentType: "application/json",
		});
		expect(artifact).toMatchObject({
			id: "artifact-boundary",
			contentType: "application/json",
			bytes: SUBAGENT_REPORT_ARTIFACT_LIMITS.maxBytes,
			truncated: true,
		});
		const saved = await readFile(artifact!.path, "utf8");
		expect(saved).not.toContain("secret-token");
		expect(Buffer.byteLength(saved)).toBe(SUBAGENT_REPORT_ARTIFACT_LIMITS.maxBytes);
		expect((await stat(artifact!.path)).mode & 0o777).toBe(0o444);
		expect((await stat(artifactRoot)).mode & 0o777).toBe(0o700);

		const duplicate = writeSubagentReportArtifact({
			runId: "artifact-boundary",
			content: "replacement must not happen",
			artifactRoot,
		});
		expect(duplicate).toBeUndefined();
		expect(await readFile(artifact!.path, "utf8")).toBe(saved);
	});

	it("rejects report artifacts beneath a symlinked root", async () => {
		const parent = await mkdtemp(join(tmpdir(), "ice-report-artifact-parent-"));
		const target = await mkdtemp(join(tmpdir(), "ice-report-artifact-target-"));
		tempDirs.push(parent, target);
		const alias = join(parent, "alias");
		await symlink(target, alias, "dir");

		expect(
			writeSubagentReportArtifact({
				runId: "symlink-root",
				content: "must not follow the alias",
				artifactRoot: alias,
			}),
		).toBeUndefined();
	});

	it("rejects reports above the fixed parser input limit and records observed bytes", async () => {
		const cwd = await createWorkspace();
		const rawReport = JSON.stringify({ summary: "x".repeat(50 * 1024), evidence: { paths: ["src"] } });
		const childMessages: AgentMessage[] = [];
		const fakeSession = {
			sessionId: "child-over-cap",
			model: {} as Model<Api>,
			messages: childMessages,
			extensionRunner: createNoopExtensionRunner(),
			subscribe: vi.fn(() => vi.fn()),
			prompt: vi.fn(async () => {
				childMessages.push({
					role: "assistant",
					content: rawReport,
					stopReason: "stop",
				} as unknown as AgentMessage);
			}),
			abort: vi.fn(async () => {}),
			dispose: vi.fn(),
			getSessionStats: vi.fn(() => ({
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
			})),
		} as unknown as CreateAgentSessionResult["session"];
		const structuredRequest = {
			...request(cwd),
			outputSchema: { type: "object" as const, additionalProperties: false },
		};
		const artifactRoot = join(cwd, ".artifacts");
		const outputArtifacts = new SubagentOutputArtifactStore({ artifactRoot });
		const normalized = normalizeSubagentRequest(structuredRequest, cwd);
		const result = await new NativeSubagentRunner({
			outputArtifacts,
			createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"]);
		// An oversized structured report is a bounded report-protocol failure after real work:
		// never verified completed, never pretending no work happened.
		expect(result.status).toBe("verification_failed");
		expect(result.diagnostics[0]?.code).toBe("report_protocol_failure");
		expect(result.observedOutputBytes).toBe(Buffer.byteLength(rawReport));
		expect(result.workArtifact?.reportProtocol).toMatchObject({ status: "truncated" });
		expect(result.output).toMatchObject({
			captureStatus: "artifact_complete",
			originalBytes: Buffer.byteLength(rawReport),
			artifact: { contentType: "application/json", truncated: false },
		});
		expect(result.output?.artifact?.id).not.toBe(normalized.runId);
		const stored = outputArtifacts.read({
			ownerSessionId: normalized.parentSessionId,
			artifactId: result.output!.artifact!.id,
			length: 64,
		});
		expect(stored.text).toBe(rawReport.slice(0, 64));
		expect(verifySubagentResult(result, normalized).verified).toBe(false);
	});

	it("does not publish partial provider output as a final artifact or leak credentials", async () => {
		const cwd = await createWorkspace();
		const rawPartial = `Bearer partial-secret\n${"y".repeat(SUBAGENT_REPORT_ARTIFACT_LIMITS.maxBytes + 64)}`;
		const childMessages: AgentMessage[] = [
			{
				role: "assistant",
				content: rawPartial,
				stopReason: "stop",
			} as unknown as AgentMessage,
		];
		const fakeSession = {
			sessionId: "child-partial-over-cap",
			model: {} as Model<Api>,
			messages: childMessages,
			extensionRunner: createNoopExtensionRunner(),
			subscribe: vi.fn(() => vi.fn()),
			prompt: vi.fn(async () => {
				throw new Error("provider disconnected");
			}),
			abort: vi.fn(async () => {}),
			dispose: vi.fn(),
			getSessionStats: vi.fn(() => ({
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
			})),
		} as unknown as CreateAgentSessionResult["session"];
		const artifactRoot = join(cwd, ".artifacts");
		const result = await new NativeSubagentRunner({
			artifactRoot,
			createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
		}).run(request(cwd), ["delegate", "read"]);
		expect(result.status).toBe("failed");
		expect(result.output).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain("reportArtifact");
		expect(JSON.stringify(result)).not.toContain("partial-secret");
	});

	it("normalizes a completed child report and usage", async () => {
		const cwd = await createWorkspace();
		const messages: unknown[] = [];
		const fakeSession = {
			sessionId: "child-complete",
			model: {} as Model<Api>,
			messages,
			extensionRunner: createNoopExtensionRunner(),
			subscribe: vi.fn(() => vi.fn()),
			prompt: vi.fn(async () => {
				messages.push({
					role: "assistant",
					content: '{"summary":"fact report","evidence":{"paths":["src"]},"payload":{}}',
					stopReason: "stop",
				});
			}),
			abort: vi.fn(async () => {}),
			dispose: vi.fn(),
			getSessionStats: vi.fn(() => ({
				tokens: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
				cost: 0.01,
			})),
		} as unknown as CreateAgentSessionResult["session"];
		const runner = new NativeSubagentRunner({
			createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
		});
		const result = await runner.run(
			{ ...request(cwd), outputSchema: { type: "object", additionalProperties: false } },
			["delegate", "read"],
		);
		expect(result).toMatchObject({
			status: "completed",
			summary: "fact report",
			partial: false,
			evidence: { paths: ["src"] },
			reportMode: "structured_report",
		});
		expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 4, cost: 0.01 });
	});

	it("redacts credentials from foreground child results", async () => {
		const harness = await createAsyncToolHarness();
		const runResolved = vi
			.spyOn(NativeSubagentRunner.prototype, "runResolved")
			.mockImplementation(async (normalized) => ({
				runId: normalized.runId,
				parentSessionId: normalized.parentSessionId,
				childSessionId: "child-redaction",
				profile: normalized.profile.name,
				source: normalized.profile.source,
				status: "completed",
				summary: 'token: "top-secret"',
				observedOutputBytes: 20,
				partial: false,
				diagnostics: [],
				evidence: { paths: ["src"] },
			}));
		try {
			const result = await harness.tools.get("delegate")!.execute(
				"redaction",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Inspect source.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			expect(result.content[0]?.text).not.toContain("top-secret");
			expect((result.details as { result: SubagentResult }).result.summary).not.toContain("top-secret");
		} finally {
			runResolved.mockRestore();
		}
	});

	it("finishes a child whose final answer exceeds the former output budget", async () => {
		const cwd = await createWorkspace();
		const normalized = {
			...normalizeSubagentRequest({ ...request(cwd), timeoutMs: 1_000 }, cwd),
			reportMode: "plain_final_turn" as const,
		};
		let notify: ((event: AgentSessionEvent) => void) | undefined;
		const abort = vi.fn(async () => {});
		const finalAnswer = "x".repeat(60_000);
		const fakeSession = {
			sessionId: "child-output-no-cutoff",
			model: testModel("faux", "faux"),
			messages: [],
			extensionRunner: createNoopExtensionRunner(),
			subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
				notify = listener;
				return vi.fn();
			}),
			prompt: vi.fn(async () => {
				notify?.({
					type: "tool_execution_start",
					toolName: "read",
					args: { path: join(cwd, "outside") },
				} as AgentSessionEvent);
				(fakeSession.messages as unknown[]).push({ role: "assistant", content: finalAnswer });
				notify?.({ type: "message_update" } as AgentSessionEvent);
			}),
			abort,
			dispose: vi.fn(),
			getSessionStats: vi.fn(() => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 })),
		} as unknown as CreateAgentSessionResult["session"];
		const progressPaths: Array<string | undefined> = [];
		const result = await new NativeSubagentRunner({
			artifactRoot: join(cwd, "artifacts"),
			createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"], {
			onEvent: (event) => {
				if (event.type === "subagent_tool_start") progressPaths.push(event.path);
			},
		});

		expect(result.status).toBe("completed");
		expect(result.output).toMatchObject({
			text: finalAnswer.slice(0, 48 * 1024),
			originalBytes: Buffer.byteLength(finalAnswer),
			captureStatus: "artifact_complete",
			artifact: { storedBytes: Buffer.byteLength(finalAnswer), truncated: false },
		});
		expect(abort).not.toHaveBeenCalled();
		expect(progressPaths).toEqual([undefined]);
	});

	it("does not suppress startup recovery because the first attempt reported many bytes", async () => {
		const cwd = await createWorkspace();
		const task = resolvedBatchTask(cwd, "large-startup-output");
		const observedFirstBytes = 32 * 1024;
		const attempts: number[] = [];
		const result = await runSubagentWithRecovery(task.request, ["delegate", "read"], (attempt) => {
			attempts.push(attempt);
			if (attempt === 1) {
				return Promise.resolve({
					...batchResult(task, "failed", "startup failed"),
					childSessionId: undefined,
					partial: false,
					retrySafeStartup: true,
					observedTurns: 0,
					observedOutputBytes: observedFirstBytes,
					diagnostics: [{ code: "child_startup_failure" as const, message: "startup failed", retryable: true }],
				});
			}
			return Promise.resolve(batchResult(task));
		});
		expect(attempts).toEqual([1, 2]);
		expect(result.status).toBe("completed");
		expect(result.recovery?.totalObservedOutputBytes).toBe(observedFirstBytes + Buffer.byteLength("ok"));
	});

	it("verifies terminal output against its attempt cap while recovery tracks all bytes", async () => {
		const cwd = await createWorkspace();
		const task = resolvedBatchTask(cwd, "high-bytes");
		const attemptBytes = 8 * 1024;
		const result = await runSubagentWithRecovery(task.request, ["delegate", "read"], (attempt) =>
			Promise.resolve({
				...batchResult(task, attempt === 1 ? "failed" : "completed"),
				...(attempt === 1
					? { childSessionId: undefined, partial: false, retrySafeStartup: true, observedTurns: 0 }
					: {}),
				observedOutputBytes: attemptBytes,
				diagnostics:
					attempt === 1 ? [{ code: "child_startup_failure" as const, message: "temporary", retryable: true }] : [],
			}),
		);
		expect(result.observedOutputBytes).toBe(attemptBytes);
		expect(result.recovery?.totalObservedOutputBytes).toBe(attemptBytes * 2);
		expect(verifySubagentResult(result, task.request)).toMatchObject({ verified: true });
	});

	it("rejects removed aggregate output budgets before launching tasks", async () => {
		const cwd = await createWorkspace();
		const task = resolvedBatchTask(cwd, "removed-output-budget");
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: vi.fn(async () => batchResult(task)),
		};
		const removedOption = { totalBudgetBytes: 1 } as unknown as Parameters<typeof runResolvedSubagentBatch>[3];
		await expect(runResolvedSubagentBatch([task], ["delegate", "read"], runner, removedOption)).rejects.toThrow(
			/totalBudgetBytes.*removed/i,
		);
		expect(runner.runResolved).not.toHaveBeenCalled();
	});

	it("reports verifier failure without leaving the proposal applied", async () => {
		const { cwd, head } = await createGitWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-writer-agent-"));
		tempDirs.push(agentDir);
		const artifact = await createWriterArtifact(
			cwd,
			head,
			join(agentDir, "artifacts", "writer"),
			"src/failed.ts",
			"failed\n",
		);
		const previousAgentDir = process.env.ICE_CODING_AGENT_DIR;
		process.env.ICE_CODING_AGENT_DIR = agentDir;
		try {
			const registerTool = vi.fn();
			iceSubagents({
				on: vi.fn(),
				getFlag: () => JSON.stringify([process.execPath, "-e", "process.exit(7)"]),
				getActiveTools: () => ["integrate_writer_patch"],
				registerTool,
			} as unknown as ExtensionAPI);
			const tool = registerTool.mock.calls.find((call) => call[0]?.name === "integrate_writer_patch")?.[0];
			const updates: unknown[] = [];
			const result = await tool.execute(
				"integrate-writer-failed-verifier",
				{ artifact },
				undefined,
				(update: unknown) => updates.push(update),
				{
					cwd,
					isProjectTrusted: () => true,
				} as unknown as ExtensionContext,
			);
			expect(result.details).toMatchObject({ status: "verification_failed", verification: { status: "failed" } });
			const progress = updates
				.map((update) => getProgressSnapshot((update as { details?: unknown }).details))
				.filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== undefined);
			expect(progress.map((snapshot) => snapshot.phase)).toContain("rolling_back");
			expect(progress.at(-1)).toMatchObject({
				phase: "verification_failed",
				status: "failed",
				rollbackStatus: "restored",
				terminal: true,
			});
			expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");
			let failedFileExists = true;
			try {
				await stat(join(cwd, "src", "failed.ts"));
			} catch {
				failedFileExists = false;
			}
			expect(failedFileExists).toBe(false);
		} finally {
			if (previousAgentDir === undefined) delete process.env.ICE_CODING_AGENT_DIR;
			else process.env.ICE_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("does not verify failed child evidence as success", async () => {
		const cwd = await createWorkspace();
		const normalized = normalizeSubagentRequest(request(cwd), cwd);
		const base: SubagentResult = {
			runId: normalized.runId,
			parentSessionId: "parent-1",
			childSessionId: "child-1",
			profile: "self",
			source: "self",
			status: "failed",
			summary: "No result",
			observedOutputBytes: Buffer.byteLength("No result"),
			partial: false,
			diagnostics: [],
		};
		expect(verifySubagentResult(base, normalized)).toMatchObject({
			verified: false,
			reason: expect.stringContaining("terminal status"),
		});
	});

	it("rejects a result with the wrong logical run lineage", async () => {
		const cwd = await createWorkspace();
		const { normalized, result } = verificationFixture(cwd);
		expect(verifySubagentResult({ ...result, runId: "different-run" }, normalized)).toMatchObject({
			verified: false,
			reason: expect.stringMatching(/run|lineage/i),
		});
	});

	it("requires child session lineage for completed results", async () => {
		const cwd = await createWorkspace();
		const { normalized, result } = verificationFixture(cwd);
		expect(verifySubagentResult({ ...result, childSessionId: undefined }, normalized)).toMatchObject({
			verified: false,
			reason: expect.stringMatching(/child session lineage|lineage/i),
		});
	});

	it("rejects completed results marked partial", async () => {
		const cwd = await createWorkspace();
		const { normalized, result } = verificationFixture(cwd);
		expect(verifySubagentResult({ ...result, partial: true }, normalized)).toMatchObject({
			verified: false,
			reason: expect.stringMatching(/partial|terminal/i),
		});
	});

	it("reapplies the evidence count bound at the parent verification gate", async () => {
		const cwd = await createWorkspace();
		const { normalized, result } = verificationFixture(cwd);
		expect(
			verifySubagentResult({ ...result, evidence: { paths: Array.from({ length: 65 }, () => "src") } }, normalized),
		).toMatchObject({
			verified: false,
			reason: expect.stringMatching(/evidence|bound/i),
		});
	});

	it("reapplies the evidence path byte bound at the parent verification gate", async () => {
		const cwd = await createWorkspace();
		const { normalized, result } = verificationFixture(cwd);
		const longPath = `${"src/../".repeat(2048)}src`;
		expect(Buffer.byteLength(longPath)).toBeGreaterThan(4096);
		expect(verifySubagentResult({ ...result, evidence: { paths: [longPath] } }, normalized)).toMatchObject({
			verified: false,
			reason: expect.stringMatching(/path|bound|evidence/i),
		});
	});

	it("rejects lineage, provenance, accounting, and missing-evidence violations", async () => {
		const cwd = await createWorkspace();
		const { normalized, result } = verificationFixture(cwd);
		const cases: Array<[Partial<SubagentResult>, RegExp]> = [
			[{ parentSessionId: "other-parent" }, /parent session/i],
			[{ profile: "other" }, /profile/i],
			[{ source: "project" }, /profile or source/i],
			[{ observedOutputBytes: -1 }, /invalid/i],
			[{ observedOutputBytes: Number.NaN }, /invalid/i],
			[{ observedOutputBytes: Number.POSITIVE_INFINITY }, /invalid/i],
			[{ output: { ...result.output!, textBytes: -1 } }, /bounded output projection/i],
			[{ evidence: { paths: ["missing-evidence.txt"] } }, /does not exist/i],
		];
		for (const [change, reason] of cases) {
			expect(verifySubagentResult({ ...result, ...change }, normalized)).toMatchObject({
				verified: false,
				reason: expect.stringMatching(reason),
			});
		}
	});

	it("rejects verifier-time symlink evidence escapes", async () => {
		const cwd = await createWorkspace();
		const outside = await mkdtemp(join(tmpdir(), "ice-subagent-verifier-outside-"));
		tempDirs.push(outside);
		await symlink(outside, join(cwd, "src", "escape"), "dir");
		const { normalized, result } = verificationFixture(cwd);
		expect(verifySubagentResult({ ...result, evidence: { paths: ["src/escape"] } }, normalized)).toMatchObject({
			verified: false,
			reason: expect.stringMatching(/outside approved scope/i),
		});
	});
});
