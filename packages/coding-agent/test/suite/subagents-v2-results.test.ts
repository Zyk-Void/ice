import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { AgentTaskInput } from "../../src/subagents/api/agent.ts";
import { renderBatchSynthesisSection, summarizeV2BatchSynthesis } from "../../src/subagents/results/batch-synthesis.ts";
import { normalizeV2Acceptance } from "../../src/subagents/results/v2-result.ts";
import { subagentMcpToolName } from "../../src/subagents/types.ts";
import { SubagentV2Runtime } from "../../src/subagents/v2/runtime.ts";
import type { V2RuntimeHost } from "../../src/subagents/v2/runtime-support.ts";
import { createV2ChildSession } from "../../src/subagents/v2/session-factory.ts";
import { resolveSubagentsV2Settings } from "../../src/subagents/v2/settings.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const runtimes: SubagentV2Runtime[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.shutdown();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const schema = {
	type: "object",
	properties: { answer: { type: "integer" } },
	required: ["answer"],
	additionalProperties: false,
};
const task: AgentTaskInput = {
	agent: "general",
	description: "typed result",
	prompt: "Inspect notes.txt; return observed evidence.",
	outputSchema: schema,
};
function report(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		summary: "Observed answer",
		evidence: { paths: ["notes.txt"] },
		payload: { answer: 42 },
		...overrides,
	});
}
const read = () => fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }), { stopReason: "toolUse" });

async function setup(repository = false) {
	const harness = await createHarness();
	harnesses.push(harness);
	const cwd = join(harness.tempDir, "repo");
	mkdirSync(cwd);
	writeFileSync(join(cwd, "notes.txt"), "42\n");
	if (repository) {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["add", "notes.txt"], { cwd });
		execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "init"], {
			cwd,
		});
	}
	let manager = SessionManager.create(cwd, join(harness.tempDir, "sessions"));
	const sent: Array<{ content: unknown; details?: unknown }> = [];
	const parent = {
		get sessionId() {
			return manager.getSessionId();
		},
		get sessionManager() {
			return manager;
		},
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		getActiveToolNames: () => ["read", "grep", "edit", "write", "agent", "agent_patch"],
		sendCustomMessage: vi.fn(async (message: { content: unknown; details?: unknown }) => {
			sent.push(message);
		}),
	} as unknown as AgentSession;
	const host: V2RuntimeHost = {
		getParentSession: () => parent,
		agentDir: join(harness.tempDir, "agent"),
		userAgentsDir: join(harness.tempDir, "agents"),
		getSettings: () => resolveSubagentsV2Settings({ projectTrusted: repository }),
		isProjectTrusted: () => repository,
		getParentMode: () => "build",
		isSubYolo: () => false,
		getAdapters: () => [],
	};
	const runtime = new SubagentV2Runtime(host);
	runtimes.push(runtime);
	return {
		harness,
		runtime,
		host,
		cwd,
		sent,
		restart: () => {
			manager = SessionManager.open(manager.getSessionFile()!);
			const restored = new SubagentV2Runtime(host);
			runtimes.push(restored);
			return restored;
		},
	};
}

async function run(runtime: SubagentV2Runtime, input: AgentTaskInput = task, background = false) {
	const [record] = await runtime.launch([input]);
	return runtime.runTurn(record!.id, input.prompt, { foreground: !background, background });
}

describe("V2 task-local typed results", () => {
	it("synthesizes V2 siblings from checked evidence and matches shared criterion text, not local IDs", () => {
		const synthesis = summarizeV2BatchSynthesis([
			{
				id: "ag_a",
				outcome: "completed",
				validation: {
					paths: ["src/auth.ts"],
					findings: [
						{
							severity: "high",
							category: "security",
							claim: "Authentication enforcement is present",
							evidence: [{ path: "src/auth.ts" }],
						},
					],
					requirements: [
						{ requirement: "Review authentication", required: true, verified: true, claim: "satisfied" },
					],
				},
			},
			{
				id: "ag_b",
				outcome: "failed",
				validation: {
					paths: ["src/auth.ts"],
					findings: [
						{
							severity: "high",
							category: "Security",
							claim: "Authentication enforcement is missing",
							evidence: [{ path: "src/auth.ts" }],
						},
					],
					requirements: [
						{ requirement: "Review authorization", required: true, verified: false, claim: "failed" },
					],
				},
			},
			{
				id: "ag_c",
				outcome: "completed",
				validation: {
					paths: [],
					requirements: [
						{ requirement: " Review authentication ", required: true, verified: false, claim: "failed" },
					],
				},
			},
		]);
		expect(synthesis.counts).toEqual({ total: 3, completed: 2, failed: 1, other: 0 });
		expect(synthesis.evidenceOverlap).toEqual([{ taskIdA: "ag_a", taskIdB: "ag_b", sharedPaths: ["src/auth.ts"] }]);
		expect(synthesis.contradictions.map(({ taskIdA, taskIdB, kind }) => [taskIdA, taskIdB, kind])).toEqual([
			["ag_a", "ag_b", "finding_claim"],
			["ag_a", "ag_c", "requirement_claim"],
		]);
		expect(renderBatchSynthesisSection(synthesis)).toContain("disagreement is preserved for parent synthesis");
	});

	it("normalizes local schemas, prompts the native child, and validates an observed payload", async () => {
		const { harness, runtime } = await setup();
		harness.setResponses([
			read(),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("ICE V2 FINAL RESULT CONTRACT");
				expect(JSON.stringify(context.messages)).toContain("additionalProperties");
				return fauxAssistantMessage(report());
			},
		]);
		const result = await run(runtime);
		expect(result).toMatchObject({
			outcome: "completed",
			validation: { verified: true, assurance: "evidence_checked", payload: { answer: 42 } },
		});
		expect(result.validation?.reason).toContain("Semantic correctness");
	});

	it.each([
		{ type: "object", $ref: "https://invalid/schema", additionalProperties: false },
		{ type: "object", properties: {}, additionalProperties: true },
		{ type: "string" },
	])("rejects invalid schema before any sibling acceptance: %j", async (outputSchema) => {
		const { runtime, host } = await setup();
		const factory = vi.fn(createV2ChildSession);
		const checked = new SubagentV2Runtime({ ...host, createChildAgentSession: factory });
		runtimes.push(checked);
		await expect(
			checked.launch([
				{ ...task, outputSchema: undefined },
				{ ...task, outputSchema },
			]),
		).rejects.toThrow();
		expect(factory).not.toHaveBeenCalled();
		expect(checked.registry.list(checked.ownerSessionId())).toEqual([]);
		expect(runtime.registry.list(runtime.ownerSessionId())).toEqual([]);
	});

	it.each([
		"not JSON",
		report({ payload: { answer: "wrong" } }),
		report({ payload: { answer: 42, extra: true } }),
		report({ payload: undefined }),
		report({ evidence: { paths: ["missing.txt"] } }),
	])("preserves malformed/invalid reports without claiming completion", async (answer) => {
		const { harness, runtime } = await setup();
		harness.setResponses([read(), fauxAssistantMessage(answer)]);
		const result = await run(runtime);
		expect(result).toMatchObject({
			outcome: "failed",
			text: answer,
			validation: { verified: false, assurance: "unverified_plain" },
		});
		expect(result.error).toBeTruthy();
		expect(runtime.registry.get(runtime.ownerSessionId(), result.id).lastTurnOutcome).toBe("failed");
		expect(runtime.outputOf(result.id)).toEqual(result);
	});

	it("rejects an existing file that the child did not access", async () => {
		const { harness, runtime } = await setup();
		harness.setResponses([fauxAssistantMessage(report())]);
		expect(await run(runtime)).toMatchObject({
			outcome: "failed",
			error: expect.stringMatching(/not successfully accessed/),
		});
	});

	it("does not treat a denied write or a search-directory listing as file evidence", async () => {
		const { harness, runtime } = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "notes.txt", content: "changed" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(report()),
		]);
		expect(await run(runtime)).toMatchObject({ outcome: "failed" });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("grep", { pattern: "42", path: "." }), { stopReason: "toolUse" }),
			fauxAssistantMessage(report()),
		]);
		expect(await run(runtime)).toMatchObject({ outcome: "failed" });
	});

	it("does not let prior-task reads or sibling evidence satisfy a later task", async () => {
		const { harness, runtime } = await setup();
		harness.setResponses([read(), fauxAssistantMessage(report())]);
		const first = await run(runtime);
		expect(first.outcome).toBe("completed");
		harness.setResponses([fauxAssistantMessage(report())]);
		expect(await runtime.continueChild(first.id, "again", { foreground: true })).toMatchObject({ outcome: "failed" });
		harness.setResponses([fauxAssistantMessage(report())]);
		expect(await run(runtime)).toMatchObject({ outcome: "failed" });
	});

	it("rejects out-of-scope and symlink-replaced citations", async () => {
		const { harness, runtime, cwd } = await setup();
		writeFileSync(join(harness.tempDir, "outside.txt"), "external");
		symlinkSync(join(harness.tempDir, "outside.txt"), join(cwd, "escape.txt"));
		harness.setResponses([read(), fauxAssistantMessage(report({ evidence: { paths: ["escape.txt"] } }))]);
		expect(await run(runtime)).toMatchObject({ outcome: "failed" });
	});

	it.each(["missing", "partial", "no-evidence", "unobserved"])("fails required acceptance: %s", async (kind) => {
		const { harness, runtime } = await setup();
		const requirements =
			kind === "missing"
				? []
				: [
						{
							id: "criterion-1",
							status: kind === "partial" ? "partial" : "satisfied",
							...(kind === "no-evidence"
								? {}
								: { evidencePaths: [kind === "unobserved" ? "unread.txt" : "notes.txt"] }),
						},
					];
		harness.setResponses([read(), fauxAssistantMessage(report({ requirements }))]);
		const result = await run(runtime, { ...task, acceptance: ["Explain observed answer"] });
		expect(result).toMatchObject({
			outcome: "failed",
			validation: { verified: false, requirements: [{ id: "criterion-1", required: true, verified: false }] },
		});
		expect(result.validation?.payload).toBeUndefined();
	});

	it("checks required claims against observed evidence without claiming test or review execution", async () => {
		const { harness, runtime } = await setup();
		harness.setResponses([
			read(),
			fauxAssistantMessage(
				report({
					requirements: [{ id: "criterion-1", status: "satisfied", evidencePaths: ["notes.txt"] }],
					assurance: "review_verified",
					testsPassed: true,
				}),
			),
		]);
		expect(await run(runtime, { ...task, acceptance: ["Explain observed answer"] })).toMatchObject({
			outcome: "completed",
			validation: { assurance: "evidence_checked", requirements: [{ verified: true }] },
		});
	});

	it("preserves first-claim-wins and frozen acceptance on continuations", async () => {
		const { harness, runtime } = await setup();
		harness.setResponses([
			read(),
			fauxAssistantMessage(
				report({
					requirements: [
						{ id: "criterion-1", status: "failed" },
						{ id: "criterion-1", status: "satisfied", evidencePaths: ["notes.txt"] },
					],
				}),
			),
		]);
		const first = await run(runtime, { ...task, acceptance: ["Original criterion"] });
		expect(first.outcome).toBe("failed");
		harness.setResponses([
			read(),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("criterion-2: Additional criterion");
				return fauxAssistantMessage(
					report({ requirements: [{ id: "criterion-2", status: "satisfied", evidencePaths: ["notes.txt"] }] }),
				);
			},
		]);
		const next = await runtime.continueChild(first.id, "follow up", {
			foreground: true,
			acceptance: ["Additional criterion"],
		});
		expect(next).toMatchObject({
			outcome: "failed",
			validation: {
				requirements: [
					{ id: "criterion-1", verified: false },
					{ id: "criterion-2", verified: true },
				],
			},
		});
		await expect(runtime.continueChild(first.id, "invalid", { foreground: true, acceptance: [" "] })).rejects.toThrow(
			/Acceptance/,
		);
	});

	it("keeps resume-added acceptance task-local through parking and restart", async () => {
		const { harness, runtime, restart } = await setup();
		const satisfied = (id: string) => ({ id, status: "satisfied", evidencePaths: ["notes.txt"] });
		harness.setResponses([read(), fauxAssistantMessage(report({ requirements: [satisfied("criterion-1")] }))]);
		const first = await run(runtime, { ...task, acceptance: ["Frozen criterion"] });
		expect(first.outcome).toBe("completed");
		harness.setResponses([
			read(),
			fauxAssistantMessage(report({ requirements: [satisfied("criterion-1"), satisfied("criterion-2")] })),
		]);
		const second = await runtime.continueChild(first.id, "second task", {
			foreground: true,
			acceptance: ["Second-task criterion"],
		});
		expect(second.outcome).toBe("completed");
		await runtime.registry.park(runtime.ownerSessionId(), first.id);
		await runtime.shutdown();
		const restored = restart();
		expect(restored.outputOf(first.id)).toEqual(second);
		harness.setResponses([
			read(),
			fauxAssistantMessage(report({ requirements: [satisfied("criterion-1"), satisfied("criterion-2")] })),
		]);
		const third = await restored.continueChild(first.id, "third task", {
			foreground: true,
			acceptance: ["Third-task criterion"],
		});
		expect(third).toMatchObject({
			outcome: "completed",
			validation: {
				requirements: [
					{ id: "criterion-1", requirement: "Frozen criterion", semanticVerified: false },
					{ id: "criterion-2", requirement: "Third-task criterion", semanticVerified: false },
				],
			},
		});
		harness.setResponses([read(), fauxAssistantMessage(report({ requirements: [satisfied("criterion-1")] }))]);
		const fourth = await restored.continueChild(first.id, "fourth task", { foreground: true });
		expect(fourth.outcome).toBe("completed");
		expect(fourth.validation?.requirements).toEqual([
			expect.objectContaining({ id: "criterion-1", requirement: "Frozen criterion" }),
		]);
	});

	it.each([{ findings: undefined }, { findings: [] }])(
		"keeps optional review findings %j as untrusted empty claims",
		async ({ findings }) => {
			const { harness, runtime } = await setup();
			harness.setResponses([read(), fauxAssistantMessage(report({ findings }))]);
			expect(await run(runtime, { ...task, agent: "review", outputSchema: undefined })).toMatchObject({
				outcome: "completed",
				validation: { verified: true, assurance: "evidence_checked", findings: [] },
			});
		},
	);

	it("forces a structured report for review and validates all finding evidence", async () => {
		const { harness, runtime } = await setup();
		harness.setResponses([
			read(),
			fauxAssistantMessage(
				report({
					findings: [
						{ severity: "high", category: "security", claim: "Check this", evidence: [{ path: "notes.txt" }] },
					],
				}),
			),
		]);
		expect(await run(runtime, { ...task, agent: "review", outputSchema: undefined })).toMatchObject({
			outcome: "completed",
			validation: { assurance: "evidence_checked", findings: [{ claim: "Check this" }] },
		});
		harness.setResponses([
			read(),
			fauxAssistantMessage(
				report({
					findings: [
						{ severity: "high", category: "security", claim: "Invented", evidence: [{ path: "missing.txt" }] },
					],
				}),
			),
		]);
		expect(await run(runtime, { ...task, agent: "review" })).toMatchObject({ outcome: "failed" });
	});

	it("retains large final answers as durable owner artifacts with bounded range reads", async () => {
		const { harness, runtime, restart } = await setup();
		const answer = `${"x".repeat(48 * 1024)}🙂z`;
		harness.setResponses([fauxAssistantMessage(answer)]);
		const result = await run(runtime, { ...task, outputSchema: undefined });
		const output = result.output;
		const artifact = output?.artifact;
		const ownerSessionId = runtime.ownerSessionId();
		expect(result).toMatchObject({
			outcome: "completed",
			truncated: true,
			output: { captureStatus: "artifact_complete", inlineTruncated: true },
		});
		expect(artifact).toBeDefined();

		const chunks: string[] = [];
		let offset = 0;
		while (true) {
			const chunk = runtime.readOutput(result.id, { offset, length: 48 * 1024 });
			chunks.push(chunk.text);
			offset = chunk.nextOffset;
			if (chunk.eof) break;
		}
		expect(chunks.join("")).toBe(answer);
		const ownerArtifactDirectory = join(
			harness.tempDir,
			"agent",
			"artifacts",
			"subagent-output",
			createHash("sha256").update(ownerSessionId, "utf8").digest("hex"),
		);
		const artifactPath = join(ownerArtifactDirectory, artifact!.id, "output.txt");
		expect(existsSync(artifactPath)).toBe(true);

		await runtime.shutdown();
		const restored = restart();
		expect(restored.outputOf(result.id)?.output).toEqual(output);
		expect(restored.readOutput(result.id, { offset: 48 * 1024, length: 4 })).toMatchObject({
			text: "🙂",
			bytesRead: 4,
			eof: false,
		});
		harness.setResponses([fauxAssistantMessage("y".repeat(48 * 1024 + 1))]);
		const replacement = await restored.continueChild(result.id, "return a newer result", { foreground: true });
		const replacementArtifact = replacement.output?.artifact;
		expect(replacementArtifact).toBeDefined();
		expect(existsSync(artifactPath)).toBe(false);
		const replacementPath = join(ownerArtifactDirectory, replacementArtifact!.id, "output.txt");
		expect(existsSync(replacementPath)).toBe(true);
		await restored.delete(result.id);
		expect(existsSync(replacementPath)).toBe(false);
		expect(() => restored.readOutput(result.id)).toThrow(/Unknown child/);
	});

	it("keeps plain results explicitly unverified and redacts their projection", async () => {
		const { harness, runtime } = await setup();
		harness.setResponses([fauxAssistantMessage("api_key=secret-value proof tests passed")]);
		const result = await run(runtime, { ...task, outputSchema: undefined });
		expect(result).toMatchObject({
			outcome: "completed",
			validation: { reportMode: "plain_final_turn", verified: false, assurance: "unverified_plain" },
		});
		expect(result.text).not.toContain("secret-value");
	});

	it("preserves failed validation across parking/restart and delivers it once in background", async () => {
		const { harness, runtime, sent, restart } = await setup();
		harness.setResponses([read(), fauxAssistantMessage(report({ payload: { answer: "bad" } }))]);
		const result = await run(runtime, task, true);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.details).toMatchObject({
			outcome: "failed",
			validation: { verified: false, assurance: "unverified_plain" },
		});
		await runtime.registry.park(runtime.ownerSessionId(), result.id);
		await runtime.shutdown();
		const restored = restart();
		expect(restored.outputOf(result.id)).toEqual(result);
		restored.flushCompletions();
		expect(sent).toHaveLength(1);
	});

	it("does not promote truncated or budget-exhausted valid-looking reports", async () => {
		const { harness, runtime } = await setup();
		harness.setResponses([read(), fauxAssistantMessage(report(), { stopReason: "length" })]);
		expect(await run(runtime)).toMatchObject({ outcome: "failed", validation: { verified: false } });
		// The budget refuses the read, so the valid-looking report comes from the tool-free wrap-up.
		harness.setResponses([read(), fauxAssistantMessage(report())]);
		expect(await run(runtime, { ...task, maxTurns: 1 })).toMatchObject({
			outcome: "budget_exhausted",
			validation: { verified: false, assurance: "unverified_plain" },
		});
	});

	it("validates worktree paths before automatic unchanged cleanup and retains the checked result", async () => {
		const { harness, runtime } = await setup(true);
		harness.setResponses([read(), fauxAssistantMessage(report())]);
		const result = await run(runtime, { ...task, isolation: "worktree" });
		expect(result.outcome).toBe("completed");
		expect(result.validation?.paths).toHaveLength(1);
		expect(existsSync(result.validation!.paths[0]!)).toBe(false);
		expect(runtime.outputOf(result.id)).toEqual(result);
	});

	it.each([30, 50])(
		"preserves oversized %s KiB raw answers without accepting a truncated JSON prefix",
		async (size) => {
			const { harness, runtime } = await setup();
			harness.setResponses([read(), fauxAssistantMessage(report({ summary: "x".repeat(size * 1024) }))]);
			const result = await run(runtime);
			expect(result).toMatchObject({ outcome: "failed", truncated: size > 48, validation: { verified: false } });
			expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(48 * 1024);
			expect(
				readFileSync(runtime.registry.get(runtime.ownerSessionId(), result.id).transcriptPath, "utf8"),
			).toContain("x".repeat(size * 1024));
		},
	);

	it("does not reuse an intermediate JSON report when the final response is empty", async () => {
		const { harness, runtime } = await setup();
		harness.setResponses([
			fauxAssistantMessage([{ type: "text", text: report() }, fauxToolCall("read", { path: "notes.txt" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(""),
		]);
		expect(await run(runtime)).toMatchObject({ outcome: "failed", text: "", validation: { verified: false } });
	});

	it("invalidates evidence when its observed file is modified before final validation", async () => {
		const { harness, runtime, cwd } = await setup();
		harness.setResponses([
			read(),
			() => {
				writeFileSync(join(cwd, "notes.txt"), "concurrent change\n");
				return fauxAssistantMessage(report());
			},
		]);
		expect(await run(runtime)).toMatchObject({ outcome: "failed", validation: { verified: false } });
	});

	it("observes actual dispatch after approval, not the earlier symlink target", async () => {
		const { harness, host, cwd } = await setup();
		writeFileSync(join(cwd, "other.txt"), "99\n");
		symlinkSync(join(cwd, "notes.txt"), join(cwd, "alias.txt"));
		const settings = resolveSubagentsV2Settings({
			global: { permissions: { ask: ["read"] } },
			projectTrusted: false,
		});
		const runtime = new SubagentV2Runtime({
			...host,
			getSettings: () => settings,
			promptApproval: async () => {
				unlinkSync(join(cwd, "alias.txt"));
				symlinkSync(join(cwd, "other.txt"), join(cwd, "alias.txt"));
				return "allow-once";
			},
		});
		runtimes.push(runtime);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "alias.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(report()),
		]);
		const result = await run(runtime);
		expect(result.outcome).toBe("failed");
		expect(readFileSync(runtime.registry.get(runtime.ownerSessionId(), result.id).transcriptPath, "utf8")).toContain(
			"99",
		);
	});

	it("never presents a previous verified snapshot as an interrupted turn result after restart", async () => {
		const { harness, runtime, restart } = await setup();
		harness.setResponses([read(), fauxAssistantMessage(report())]);
		const result = await run(runtime);
		const record = runtime.registry.get(runtime.ownerSessionId(), result.id);
		runtime.registry.transition(
			runtime.ownerSessionId(),
			result.id,
			record.generation,
			"running",
			{ turnInFlight: true },
			true,
		);
		const restored = restart();
		expect(restored.registry.get(restored.ownerSessionId(), result.id).lastTurnOutcome).toBe("interrupted");
		expect(restored.outputOf(result.id)).toBeUndefined();
	});

	it("keeps final response and usage when native message context is replaced", async () => {
		const { harness, host } = await setup();
		const observedUsage = { inputTokens: 0, outputTokens: 0 };
		const summaryUsage = { ...fauxAssistantMessage("summary").usage, input: 7, output: 4 };
		const factory = async (options: Parameters<typeof createV2ChildSession>[0]) => {
			const session = await createV2ChildSession(options);
			session.subscribe((event) => {
				if (event.type !== "message_end" || event.message.role !== "assistant") return;
				observedUsage.inputTokens += event.message.usage.input;
				observedUsage.outputTokens += event.message.usage.output;
			});
			const listeners: Array<Parameters<AgentSession["subscribe"]>[0]> = [];
			const subscribe = session.subscribe.bind(session);
			vi.spyOn(session, "subscribe").mockImplementation((listener) => {
				listeners.push(listener);
				return subscribe(listener);
			});
			const prompt = session.prompt.bind(session);
			vi.spyOn(session, "prompt").mockImplementation(async (...args) => {
				await prompt(...args);
				for (const listener of listeners)
					listener({
						type: "compaction_end",
						reason: "threshold",
						result: { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 100, usage: summaryUsage },
						aborted: false,
						willRetry: false,
					});
				observedUsage.inputTokens += summaryUsage.input;
				observedUsage.outputTokens += summaryUsage.output;
				session.agent.state.messages = [];
			});
			return session;
		};
		const runtime = new SubagentV2Runtime({ ...host, createChildAgentSession: factory });
		runtimes.push(runtime);
		harness.setResponses([read(), fauxAssistantMessage(report())]);
		expect(await run(runtime)).toMatchObject({
			outcome: "completed",
			text: report(),
			usage: observedUsage,
			validation: { verified: true },
		});
		expect(observedUsage.inputTokens).toBeGreaterThan(0);
		expect(observedUsage.outputTokens).toBeGreaterThan(0);
	});

	it("redacts a historical transcript fallback and explicitly refuses to verify it", async () => {
		const { harness, runtime } = await setup();
		harness.setResponses([fauxAssistantMessage("api_key=old-secret")]);
		const result = await run(runtime, { ...task, outputSchema: undefined });
		const record = runtime.registry.get(runtime.ownerSessionId(), result.id);
		runtime.registry.transition(
			runtime.ownerSessionId(),
			result.id,
			record.generation,
			"idle",
			{ lastResult: undefined },
			true,
		);
		expect(runtime.outputOf(result.id)).toMatchObject({
			validation: { verified: false, assurance: "unverified_plain" },
		});
		expect(runtime.outputOf(result.id)?.text).not.toContain("old-secret");
	});

	it("preserves exact legacy MCP selector identity without loading profiles for hashing", () => {
		expect(subagentMcpToolName("docs/search")).toBe("mcp_docs_search_8a3cf6e4ee4e");
	});

	it("bounds and freezes positional acceptance IDs", () => {
		const criteria = normalizeV2Acceptance([" A "], ["A", "B"]);
		expect(criteria).toEqual(["A", "B"]);
		expect(Object.isFrozen(criteria)).toBe(true);
		expect(() => normalizeV2Acceptance(Array.from({ length: 17 }, (_, i) => `criterion ${i}`))).toThrow(/Too many/);
	});
});
