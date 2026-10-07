import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import type { Context } from "@zykairotis/ice-ai";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { mapAgentPackTools, unsupportedAgentPackFields } from "../src/ice-agent-packs.ts";
import { IceAgentViewBridge } from "../src/ice-agent-view-bridge.ts";
import * as iceSubagentsModule from "../src/ice-subagents.ts";
import iceSubagents, {
	assertSubagentToolEligible,
	buildSubagentLaunchPreflight,
	buildSubagentPrompt,
	createScopedWriterToolDefinitions,
	deriveSubagentTools,
	formatSubagentLaunchDigest,
	NativeSubagentRunner,
	runResolvedSubagentBatch,
	runSubagentWithRecovery,
	SubagentError,
	type SubagentResult,
	verifySubagentResult,
} from "../src/ice-subagents.ts";
import { JOB_COMPLETION_MESSAGE_TYPE, JOB_ENTRY_TYPE } from "../src/subagents/registry/jobs.ts";
import {
	type AsyncToolHarnessOptions,
	batchResult,
	createAsyncToolHarness,
	createFauxChildRuntime,
	createNativeSubagentSession,
	createNoopExtensionRunner,
	createWorkspace,
	normalizeSubagentRequest,
	registerScriptedUsageProvider,
	request,
	resolvedBatchTask,
	resolvedReviewTask,
	scriptedModelRuntime,
	settleManagedDelegate,
	tempDirs,
	testModel,
} from "./ice-subagents-harness.ts";

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ICE subagent contracts", () => {
	it("returns inspectable owner-scoped handles for background batches and reviews", async () => {
		const harness = await createAsyncToolHarness();
		const instruction = "Inspect the approved scope and return a concise structured report.";
		const response = fauxAssistantMessage('{"summary":"Inspected src.","evidence":{"paths":["src"]},"findings":[]}');
		const inspect = harness.tools.get("inspect_subagent_batch")!;
		const launchBatch = async (toolName: "delegate_batch" | "review_batch", params: Record<string, unknown>) => {
			const accepted = await harness.tools
				.get(toolName)!
				.execute(`launch-${toolName}`, params as never, undefined, undefined, harness.context);
			expect(accepted).toMatchObject({ isError: false, details: { accepted: { batchId: expect.any(String) } } });
			// The visible ack must carry the child runIds so the parent can manage
			// each child without a separate inspection round trip.
			const acceptedTasks = accepted.details.accepted.tasks as Array<{ taskId: string; runId: string }>;
			expect(acceptedTasks.length).toBeGreaterThan(1);
			const ackText = accepted.content?.[0]?.text ?? "";
			for (const task of acceptedTasks) {
				expect(ackText).toContain(`${task.taskId}=${task.runId}`);
			}
			const batchId = accepted.details.accepted.batchId as string;
			await vi.waitFor(
				async () => {
					const inspection = await inspect.execute(
						`inspect-${toolName}`,
						{ batchId },
						undefined,
						undefined,
						harness.context,
					);
					expect(inspection.details.inspection.result).toBeDefined();
				},
				{ timeout: 5_000, interval: 10 },
			);
			const inspection = await inspect.execute(
				`inspect-${toolName}-final`,
				{ batchId },
				undefined,
				undefined,
				harness.context,
			);
			return inspection.details.inspection.result;
		};

		try {
			harness.faux.setResponses([response, response, response, response]);
			const batch = await launchBatch("delegate_batch", {
				tasks: ["first", "second"].map((id) => ({
					id,
					role: "self",
					self: { instructions: instruction, capabilities: ["read", "grep", "find", "ls"] },
					task: `Inspect the source tree for ${id}.`,
					scope: { roots: ["src"] },
				})),
			});
			expect((batch as { items: Array<{ taskId: string }> }).items.map((item) => item.taskId)).toEqual([
				"first",
				"second",
			]);

			const review = await launchBatch("review_batch", {
				tasks: ["correctness", "security"].map((dimension, index) => ({
					id: `review-${index}`,
					dimension,
					task: `Review ${dimension}.`,
					scope: { roots: ["src"] },
				})),
			});
			expect((review as { reviewers: Array<{ taskId: string }> }).reviewers.map((item) => item.taskId)).toEqual([
				"review-0",
				"review-1",
			]);
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("routes manage_subagent actions through owner-scoped validation with phase gates", async () => {
		const harness = await createAsyncToolHarness();
		const manage = harness.tools.get("manage_subagent")!;
		type ManageOutcome = { isError?: boolean; details?: { error?: { code?: string; message?: string } } };
		const execute = async (params: Record<string, unknown>): Promise<ManageOutcome> =>
			(await manage.execute(
				"call-manage",
				{ runId: "run-unknown-0001", ...params } as never,
				undefined,
				undefined,
				harness.context,
			)) as ManageOutcome;

		// Live-only actions reject an unknown handle at the ownership boundary.
		for (const action of ["peek", "inspect", "detach", "stop"] as const) {
			const rejected = await execute({ action });
			expect(rejected.isError).toBe(true);
			expect(rejected.details?.error?.code).toBe("child_protocol_failure");
		}
		// Only the detach branch reports the detach-specific rejection.
		expect((await execute({ action: "detach" })).details?.error?.message).toMatch(/can be detached/i);
		// follow_up requires a stable requestId and a bounded message.
		expect((await execute({ action: "follow_up" })).details?.error?.code).toBe("malformed_result");

		// waitMs is validated before ownership, proving the wait branch reaches the
		// bounded management wait rather than any child execution path.
		for (const waitMs of [0, iceSubagentsModule.SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS + 1]) {
			const outOfWindow = await execute({ action: "wait", waitMs });
			expect(outOfWindow.isError).toBe(true);
			expect(outOfWindow.details?.error?.code).toBe("malformed_result");
			expect(outOfWindow.details?.error?.message).toMatch(/Management wait must be an integer between 1 and/);
		}
		const inWindow = await execute({ action: "wait", waitMs: 50 });
		expect(inWindow.isError).toBe(true);
		expect(inWindow.details?.error?.code).toBe("child_protocol_failure");
		expect(inWindow.details?.error?.message).toMatch(/owned by this parent session/);

		// Terminal-only actions reject the same unknown handle: there is no retained
		// child to resume, and delete reports the idempotent forgotten outcome.
		expect((await execute({ action: "resume", message: "continue" })).details?.error?.code).toBe(
			"child_protocol_failure",
		);
		const forgotten = await execute({ action: "delete" });
		expect(forgotten.isError).toBe(false);
	});

	it("shares one directories-only scope schema across delegated tools", async () => {
		const harness = await createAsyncToolHarness();
		type DirectToolSchema = { properties?: { scope?: object } };
		type BatchToolSchema = {
			properties?: { tasks?: { items?: { properties?: { scope?: object } } } };
		};
		const directScope = (name: string) => (harness.tools.get(name)!.parameters as DirectToolSchema).properties?.scope;
		const batchScope = (name: string) =>
			(harness.tools.get(name)!.parameters as BatchToolSchema).properties?.tasks?.items?.properties?.scope;
		const scope = directScope("delegate");

		expect(scope).toBe(directScope("delegate_async"));
		expect(scope).toBe(batchScope("delegate_batch"));
		expect(scope).toBe(batchScope("review_batch"));
		expect(scope).toMatchObject({
			additionalProperties: false,
			description: expect.stringMatching(/existing directories only/i),
			properties: {
				roots: {
					minItems: 1,
					maxItems: 16,
					description: expect.stringMatching(/directories/i),
					items: { description: expect.stringMatching(/do not pass file paths/i) },
				},
				targets: {
					maxItems: 16,
					description: expect.stringMatching(/regular files|exact files/i),
					items: { description: expect.stringMatching(/regular files|exact files/i) },
				},
			},
		});
		for (const name of ["delegate", "delegate_async", "delegate_batch", "review_batch"] as const) {
			expect(harness.tools.get(name)!.description).toMatch(/scope\.roots accepts existing directories only/i);
		}
	});

	it("reports actionable structured details when a file is used as a scope root", async () => {
		const cwd = await createWorkspace();
		await writeFile(join(cwd, "src", "file.ts"), "file\n");
		let failure: unknown;
		try {
			normalizeSubagentRequest({ ...request(cwd), scope: { roots: ["src/file.ts"] } }, cwd);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(SubagentError);
		if (!(failure instanceof SubagentError)) throw new Error("expected a structured subagent error");
		expect(failure.code).toBe("invalid_scope");
		expect(failure.details).toMatchObject({
			field: "scope.roots",
			path: "src/file.ts",
			hint: expect.stringMatching(
				/scope\.roots.*parent directory|parent directory.*scope\.targets|mention the exact file in task/i,
			),
		});
		expect(failure.message).toMatch(/existing directories only|parent directory/i);
	});

	it("rejects a guessed workspace root with cwd and dot-scope retry guidance", async () => {
		const cwd = await createWorkspace();
		const guessedRoot = resolve(cwd, "..", "guessed-ice-void-root");
		let failure: unknown;
		try {
			normalizeSubagentRequest({ ...request(cwd), scope: { roots: [guessedRoot] } }, cwd);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(SubagentError);
		if (!(failure instanceof SubagentError)) throw new Error("expected a structured subagent error");
		expect(failure.code).toBe("invalid_scope");
		expect(failure.message).toContain(`Current workspace: ${cwd}`);
		expect(failure.message).toContain('Use "." for the current workspace');
		expect(failure.details).toMatchObject({ field: "scope.roots", path: guessedRoot });
		expect(failure.details?.hint).toContain('Use "." for the current workspace');
	});

	it("reports scope errors before any child launch and identifies invalid batch tasks", async () => {
		const harness = await createAsyncToolHarness();
		await writeFile(join(harness.context.cwd, "src", "file.ts"), "file\n");
		const runResolved = vi.spyOn(NativeSubagentRunner.prototype, "runResolved");
		try {
			const cases = [
				{
					name: "delegate_async",
					expectedText: "Background delegation rejected",
					expectedDetails: { field: "scope.roots", path: "src/file.ts" },
					params: {
						role: "self",
						self: {
							instructions: "Inspect the approved scope and report evidence.",
							capabilities: ["read", "grep", "find", "ls"],
						},
						task: "Inspect the file.",
						scope: { roots: ["src/file.ts"] },
					},
				},
				{
					name: "delegate_batch",
					expectedText: 'Batch task "invalid-root" rejected',
					expectedDetails: { taskId: "invalid-root", field: "scope.roots", path: "src/file.ts" },
					params: {
						tasks: [
							{
								id: "valid-before",
								role: "self",
								self: {
									instructions: "Inspect the approved scope and report evidence.",
									capabilities: ["read", "grep", "find", "ls"],
								},
								task: "Inspect before.",
								scope: { roots: ["src"] },
							},
							{
								id: "invalid-root",
								role: "self",
								self: {
									instructions: "Inspect the approved scope and report evidence.",
									capabilities: ["read", "grep", "find", "ls"],
								},
								task: "Inspect the file.",
								scope: { roots: ["src/file.ts"] },
							},
							{
								id: "valid-after",
								role: "self",
								self: {
									instructions: "Inspect the approved scope and report evidence.",
									capabilities: ["read", "grep", "find", "ls"],
								},
								task: "Inspect after.",
								scope: { roots: ["src"] },
							},
						],
					},
				},
				{
					name: "review_batch",
					expectedText: 'Batch task "invalid-root" rejected',
					expectedDetails: { taskId: "invalid-root", field: "scope.roots", path: "src/file.ts" },
					params: {
						tasks: [
							{
								id: "valid-before",
								dimension: "correctness",
								task: "Review before.",
								scope: { roots: ["src"] },
							},
							{
								id: "invalid-root",
								dimension: "security",
								task: "Review the file.",
								scope: { roots: ["src/file.ts"] },
							},
							{
								id: "valid-after",
								dimension: "tests",
								task: "Review after.",
								scope: { roots: ["src"] },
							},
						],
					},
				},
				{
					name: "delegate_batch",
					expectedText: 'Batch task "invalid-target" rejected',
					expectedDetails: { taskId: "invalid-target", field: "scope.targets", path: "src/missing.ts" },
					params: {
						tasks: [
							{
								id: "valid-before-target",
								role: "self",
								self: {
									instructions: "Inspect the approved scope and report evidence.",
									capabilities: ["read", "grep", "find", "ls"],
								},
								task: "Inspect before.",
								scope: { roots: ["src"] },
							},
							{
								id: "invalid-target",
								role: "self",
								self: {
									instructions: "Inspect the approved scope and report evidence.",
									capabilities: ["read", "grep", "find", "ls"],
								},
								task: "Inspect the missing file.",
								scope: { roots: ["src"], targets: ["src/missing.ts"] },
							},
							{
								id: "valid-after-target",
								role: "self",
								self: {
									instructions: "Inspect the approved scope and report evidence.",
									capabilities: ["read", "grep", "find", "ls"],
								},
								task: "Inspect after.",
								scope: { roots: ["src"] },
							},
						],
					},
				},
			] as const;

			for (const [index, testCase] of cases.entries()) {
				const result = await harness.tools
					.get(testCase.name)!
					.execute(`invalid-batch-${index}`, testCase.params, undefined, undefined, harness.context);
				expect(result).toMatchObject({ isError: true });
				expect(result.content[0]?.text).toContain(testCase.expectedText);
				expect(result.details).toMatchObject({
					error: {
						code: "invalid_scope",
						details: testCase.expectedDetails,
					},
				});
			}
			expect(runResolved).not.toHaveBeenCalled();
		} finally {
			runResolved.mockRestore();
		}
	});

	it("rejects external child scopes unless the parent explicitly allows them", async () => {
		const cwd = await createWorkspace();
		const external = await mkdtemp(join(tmpdir(), "ice-subagents-external-"));
		tempDirs.push(external);
		await mkdir(join(external, "project"));
		const childRequest = { ...request(cwd), scope: { roots: [resolve(external, "project")] } };
		expect(() => normalizeSubagentRequest(childRequest, cwd)).toThrow(/outside the parent workspace/);
		const normalized = normalizeSubagentRequest(childRequest, cwd, { allowExternal: true });
		expect(normalized.scope.roots).toEqual([resolve(external, "project")]);
		expect(normalized.allowExternal).toBe(true);
	});

	it("normalizes unsafe subagent flags without consuming the following prompt", () => {
		const normalizer = (
			iceSubagentsModule as unknown as {
				normalizeUnsafeSubagentStartupArgs?: (
					args: readonly string[],
					options: { stdinIsTTY: boolean; stdoutIsTTY: boolean },
				) => string[];
			}
		).normalizeUnsafeSubagentStartupArgs;
		expect(normalizer).toBeTypeOf("function");
		if (!normalizer) return;
		expect(
			normalizer(["--ice-mode", "build", "--ice-allow-bash", "--sub-yolo", "Trace unsafe execution"], {
				stdinIsTTY: true,
				stdoutIsTTY: true,
			}),
		).toEqual(["--ice-mode", "build", "--ice-allow-bash=true", "--sub-yolo=true", "Trace unsafe execution"]);
		expect(
			normalizer(["--ice-mode", "build", "--sub-yolo", "--ice-allow-bash", "Trace unsafe execution"], {
				stdinIsTTY: true,
				stdoutIsTTY: true,
			}),
		).toEqual(["--ice-mode", "build", "--sub-yolo=true", "--ice-allow-bash=true", "Trace unsafe execution"]);
		expect(
			normalizer(["--mode", "rpc", "--ice-mode", "build", "--ice-allow-bash", "--sub-yolo"], {
				stdinIsTTY: false,
				stdoutIsTTY: false,
			}),
		).toEqual(["--mode", "rpc", "--ice-mode", "build", "--ice-allow-bash=true", "--sub-yolo=true"]);
	});

	it("rejects duplicate unsafe startup flags", () => {
		const normalizer = (
			iceSubagentsModule as unknown as {
				normalizeUnsafeSubagentStartupArgs: (
					args: readonly string[],
					options: { stdinIsTTY: boolean; stdoutIsTTY: boolean },
				) => string[];
			}
		).normalizeUnsafeSubagentStartupArgs;
		const tty = { stdinIsTTY: true, stdoutIsTTY: true };
		const valid = ["--ice-mode", "build", "--ice-allow-bash", "--sub-yolo"];
		expect(() => normalizer([...valid, "--sub-yolo"], tty)).toThrow(/duplicate/i);
		expect(() =>
			normalizer(["--ice-mode", "build", "--ice-mode", "build", "--ice-allow-bash", "--sub-yolo"], tty),
		).toThrow(/duplicate/i);
		expect(() =>
			normalizer(["--ice-mode", "build", "--ice-allow-bash", "--ice-allow-bash", "--sub-yolo"], tty),
		).toThrow(/duplicate/i);
		expect(() => normalizer([...valid, "--mode", "json", "--mode", "json"], tty)).toThrow(/duplicate/i);
		expect(() => normalizer([...valid, "--print", "-p"], tty)).toThrow(/duplicate/i);
	});

	it("rejects unsafe startup combinations before runtime", () => {
		const normalizer = (
			iceSubagentsModule as unknown as {
				normalizeUnsafeSubagentStartupArgs?: (
					args: readonly string[],
					options: { stdinIsTTY: boolean; stdoutIsTTY: boolean },
				) => string[];
			}
		).normalizeUnsafeSubagentStartupArgs!;
		const tty = { stdinIsTTY: true, stdoutIsTTY: true };
		const valid = ["--ice-mode", "build", "--ice-allow-bash", "--sub-yolo", "prompt"];
		expect(() => normalizer(["--sub-yolo", "prompt"], tty)).toThrow(/explicit --ice-mode build/);
		expect(() => normalizer(["--ice-mode", "build", "--sub-yolo", "prompt"], tty)).toThrow(/--ice-allow-bash/);
		expect(() => normalizer([...valid, "--no-approve"], tty)).toThrow(/--no-approve/);
		expect(() => normalizer([...valid, "--print"], tty)).toThrow(/interactive TUI/);
		expect(() => normalizer([...valid, "--mode", "json"], tty)).toThrow(/interactive TUI/);
		expect(() => normalizer([...valid, "--mode", "text"], tty)).toThrow(/interactive TUI/);
		expect(() => normalizer([...valid, "--mode", "text", "--mode", "json"], tty)).toThrow(/interactive TUI/);
		expect(() => normalizer(valid, { stdinIsTTY: false, stdoutIsTTY: true })).toThrow(/interactive TUI/);
		expect(() => normalizer([...valid.slice(0, 4), "--sub-yolo=false", "prompt"], tty)).toThrow(/boolean true/);
		expect(() => normalizer([...valid, "--ice-allow-bash=false"], tty)).toThrow(/--ice-allow-bash/);
		expect(() =>
			normalizer(["--ice-mode", "build", "--ice-mode", "plan", "--ice-allow-bash", "--sub-yolo"], tty),
		).toThrow(/explicit --ice-mode build/);
	});

	it("allows --allow-external without --sub-yolo in print and headless runs", () => {
		const normalizer = (
			iceSubagentsModule as unknown as {
				normalizeUnsafeSubagentStartupArgs: (
					args: readonly string[],
					options: { stdinIsTTY: boolean; stdoutIsTTY: boolean },
				) => string[];
			}
		).normalizeUnsafeSubagentStartupArgs;
		const headless = { stdinIsTTY: false, stdoutIsTTY: false };
		expect(normalizer(["--ice-mode", "build", "--allow-external", "-p", "prompt"], headless)).toEqual([
			"--ice-mode",
			"build",
			"--allow-external=true",
			"-p",
			"prompt",
		]);
		expect(() => normalizer(["--allow-external", "-p", "prompt"], headless)).toThrow(
			"--allow-external requires explicit --ice-mode build.",
		);
		expect(() =>
			normalizer(["--ice-mode", "build", "--ice-allow-bash", "--sub-yolo", "--allow-external", "-p", "x"], headless),
		).toThrow(/interactive TUI/);
	});

	it("denies unsafe delegation outside the current build mode", async () => {
		const harness = await createAsyncToolHarness({
			activeTools: ["delegate", "read", "bash"],
			flags: { "sub-yolo": true, "ice-allow-bash": true },
			iceMode: "plan",
			trusted: true,
		});
		const result = await harness.tools.get("delegate")!.execute(
			"unsafe-plan",
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
		expect(result).toMatchObject({ isError: true });
		expect(result.content[0].text).toContain("explicit --ice-mode build");
		expect(harness.confirm).not.toHaveBeenCalled();
	});

	it("fails closed on trust, authoritative capability, and TUI gates", async () => {
		const cases: Array<[AsyncToolHarnessOptions, RegExp]> = [
			[
				{
					activeTools: ["delegate", "read", "bash"],
					flags: { "sub-yolo": true, "ice-allow-bash": true },
					iceMode: "build",
				},
				/trusted project/,
			],
			[
				{ activeTools: ["delegate", "read", "bash"], flags: { "sub-yolo": true }, iceMode: "build", trusted: true },
				/startup-authorized parent Bash/,
			],
			[
				{
					activeTools: ["delegate", "read", "bash"],
					flags: { "sub-yolo": true, "ice-allow-bash": true },
					mode: "json",
					iceMode: "build",
					trusted: true,
				},
				/interactive TUI or an explicitly authorized RPC session/,
			],
		];
		for (const [options, expected] of cases) {
			const harness = await createAsyncToolHarness(options);
			const result = await harness.tools.get("delegate")!.execute(
				"unsafe-gate",
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
			expect(result).toMatchObject({ isError: true });
			expect(result.content[0].text).toMatch(expected);
		}
	});

	it("allows startup-authorized unsafe delegation in RPC without TUI confirmation", async () => {
		const harness = await createAsyncToolHarness({
			activeTools: ["delegate", "read", "bash"],
			flags: { "sub-yolo": true, "ice-allow-bash": true },
			mode: "rpc",
			iceMode: "build",
			trusted: true,
		});
		let observedTools: readonly string[] | undefined;
		const runResolved = vi
			.spyOn(NativeSubagentRunner.prototype, "runResolved")
			.mockImplementation(async (request, activeTools) => {
				observedTools = [...activeTools];
				return {
					runId: request.runId,
					parentSessionId: request.parentSessionId,
					childSessionId: "child-rpc-unsafe-tools",
					profile: request.role,
					source: request.profile.source,
					status: "completed",
					summary: "ok",
					output: {
						text: "ok",
						textBytes: 2,
						originalBytes: 2,
						inlineTruncated: false,
						captureStatus: "inline_complete",
					},
					observedOutputBytes: 2,
					partial: false,
					diagnostics: [],
					evidence: { paths: ["src"] },
				};
			});
		try {
			const result = await harness.tools.get("delegate")!.execute(
				"rpc-unsafe-tools",
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
			expect(result).toMatchObject({ isError: false });
			expect(observedTools).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "edit", "write", "bash"]));
			expect(harness.confirm).not.toHaveBeenCalled();
		} finally {
			runResolved.mockRestore();
		}
	});

	it("adds the complete unsafe built-in tool set after the authoritative gates pass", async () => {
		const harness = await createAsyncToolHarness({
			activeTools: ["delegate", "read", "bash"],
			flags: { "sub-yolo": true, "ice-allow-bash": true },
			iceMode: "build",
			trusted: true,
		});
		let observedTools: readonly string[] | undefined;
		const runResolved = vi
			.spyOn(NativeSubagentRunner.prototype, "runResolved")
			.mockImplementation(async (request, activeTools) => {
				observedTools = [...activeTools];
				return {
					runId: request.runId,
					parentSessionId: request.parentSessionId,
					childSessionId: "child-unsafe-tools",
					profile: request.role,
					source: request.profile.source,
					status: "completed",
					summary: "ok",
					output: {
						text: "ok",
						textBytes: 2,
						originalBytes: 2,
						inlineTruncated: false,
						captureStatus: "inline_complete",
					},
					observedOutputBytes: 2,
					partial: false,
					diagnostics: [],
					evidence: { paths: ["src"] },
				};
			});
		try {
			const result = await harness.tools.get("delegate")!.execute(
				"unsafe-tools",
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
			expect(result).toMatchObject({ isError: false });
			expect(observedTools).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "edit", "write", "bash"]));
		} finally {
			runResolved.mockRestore();
		}
	});

	it("reads --sub-yolo after extension startup applies CLI flags", async () => {
		const harness = await createAsyncToolHarness({
			activeTools: ["delegate", "read", "bash"],
			flags: { "sub-yolo": true, "ice-allow-bash": true },
			lateSubYolo: true,
			iceMode: "build",
			trusted: true,
		});
		let observedTools: readonly string[] | undefined;
		const runResolved = vi
			.spyOn(NativeSubagentRunner.prototype, "runResolved")
			.mockImplementation(async (request, activeTools) => {
				observedTools = [...activeTools];
				return {
					runId: request.runId,
					parentSessionId: request.parentSessionId,
					childSessionId: "child-late-sub-yolo",
					profile: request.role,
					source: request.profile.source,
					status: "completed",
					summary: "ok",
					output: {
						text: "ok",
						textBytes: 2,
						originalBytes: 2,
						inlineTruncated: false,
						captureStatus: "inline_complete",
					},
					observedOutputBytes: 2,
					partial: false,
					diagnostics: [],
					evidence: { paths: ["src"] },
				};
			});
		try {
			const result = await harness.tools.get("delegate")!.execute(
				"late-sub-yolo",
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
			expect(result).toMatchObject({ isError: false, details: { unsafeHostExec: true } });
			expect(observedTools).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "edit", "write", "bash"]));
		} finally {
			runResolved.mockRestore();
		}
	});

	it("uses immutable startup authority when mutable active tools disappear", async () => {
		let activeToolReads = 0;
		const harness = await createAsyncToolHarness({
			activeTools: () => {
				activeToolReads++;
				return activeToolReads === 1 ? ["delegate", "read", "bash"] : ["delegate", "read"];
			},
			confirm: true,
			flags: { "sub-yolo": true, "ice-allow-bash": true },
			iceMode: "build",
			trusted: true,
		});
		harness.faux.setResponses([fauxAssistantMessage('{"summary":"ok","evidence":{"paths":["src"]}}')]);
		const result = await harness.tools.get("delegate")!.execute(
			"unsafe-revoked",
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
		expect(result).toMatchObject({ isError: false });
		expect(activeToolReads).toBe(0);
		expect(harness.confirm).not.toHaveBeenCalled();
	});

	it("launches one unsafe foreground child without retry or per-child confirmation", async () => {
		const runResolved = vi
			.spyOn(NativeSubagentRunner.prototype, "runResolved")
			.mockImplementation(async (normalized) => ({
				runId: normalized.runId,
				childSessionId: "unsafe-child",
				parentSessionId: "owner-a",
				profile: "self",
				source: "self",
				status: "completed",
				summary: "host command inspected source",
				output: {
					text: "host command inspected source",
					textBytes: Buffer.byteLength("host command inspected source"),
					originalBytes: Buffer.byteLength("host command inspected source"),
					inlineTruncated: false,
					captureStatus: "inline_complete" as const,
				},
				observedOutputBytes: Buffer.byteLength("host command inspected source"),
				partial: false,
				diagnostics: [],
				evidence: { paths: ["src"] },
			}));
		try {
			const harness = await createAsyncToolHarness({
				activeTools: ["delegate", "read", "bash"],
				confirm: true,
				flags: { "sub-yolo": true, "ice-allow-bash": true },
				iceMode: "build",
				trusted: true,
			});
			const result = await harness.tools.get("delegate")!.execute(
				"unsafe-confirmed",
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
			expect(result).toMatchObject({ isError: false, details: { unsafeHostExec: true } });
			expect(runResolved).toHaveBeenCalledOnce();
			expect(runResolved.mock.calls[0]?.[2]).toMatchObject({ unsafeHostExec: true, attempt: 1 });
			expect(harness.confirm).not.toHaveBeenCalled();
		} finally {
			runResolved.mockRestore();
		}
	});

	it("propagates startup YOLO across async, batch, and review without prompts", async () => {
		const harness = await createAsyncToolHarness({
			activeTools: ["delegate", "delegate_async", "delegate_batch", "review_batch", "read", "bash"],
			flags: { "sub-yolo": true, "ice-allow-bash": true },
			iceMode: "build",
			trusted: true,
		});
		harness.faux.setResponses([
			fauxAssistantMessage('{"summary":"ok","evidence":{"paths":["src"]},"findings":[]}'),
			fauxAssistantMessage('{"summary":"ok","evidence":{"paths":["src"]},"findings":[]}'),
			fauxAssistantMessage('{"summary":"ok","evidence":{"paths":["src"]},"findings":[]}'),
		]);
		const asyncResult = await harness.tools.get("delegate_async")!.execute(
			"safe-async",
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
		expect(asyncResult).toMatchObject({ isError: false });
		const batchResult = await harness.tools.get("delegate_batch")!.execute(
			"safe-batch",
			{
				tasks: [
					{
						id: "one",
						role: "self",
						self: {
							instructions: "Inspect the approved scope and report evidence.",
							capabilities: ["read", "grep", "find", "ls"],
						},
						task: "Inspect source.",
						scope: { roots: ["src"] },
					},
				],
			},
			undefined,
			undefined,
			harness.context,
		);
		expect(batchResult).toMatchObject({ isError: false });
		const reviewResult = await harness.tools.get("review_batch")!.execute(
			"safe-review",
			{
				tasks: [{ id: "one", dimension: "correctness", task: "Inspect source.", scope: { roots: ["src"] } }],
			},
			undefined,
			undefined,
			harness.context,
		);
		expect(reviewResult).toMatchObject({ isError: false });
		expect(harness.confirm).not.toHaveBeenCalled();
	});

	it("allows a user override for the explicit durable-job inspect action", () => {
		const keybindings = new KeybindingsManager({ "app.subagents.inspect": "alt+i" });
		expect(keybindings.matches("\x1bi", "app.subagents.inspect")).toBe(true);
		expect(keybindings.matches("i", "app.subagents.inspect")).toBe(false);
	});

	it("intersects parent capabilities with the file-agent tool policy", async () => {
		const _cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-tools-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "toolcheck.md"),
			"---\nname: toolcheck\ndescription: Tool check\ntools: read, grep\n---\nCheck.\n",
		);
		expect(
			deriveSubagentTools(["read", "edit", "delegate", "grep", "bash"], {
				name: "toolcheck",
				description: "t",
				systemPrompt: "s",
				requestedTools: ["read", "grep"],
				tools: ["read", "grep"],
				thinkingLevel: "low",
				timeoutMs: 60_000,
				modelPolicy: "inherit-parent",
			}),
		).toEqual(["read", "grep"]);
		expect(
			deriveSubagentTools(["edit", "bash", "delegate"], {
				name: "toolcheck",
				description: "t",
				systemPrompt: "s",
				requestedTools: ["read"],
				tools: ["read"],
				thinkingLevel: "low",
				timeoutMs: 60_000,
				modelPolicy: "inherit-parent",
			}),
		).toEqual([]);
	});

	it("reports foreign agent-pack capabilities instead of granting them", async () => {
		// W11: known read-only tokens map; bash/edit/write and foreign policy
		// keys are reported, never converted into ICE child authority.
		expect(mapAgentPackTools(["read", "Bash", "network-scan"])).toEqual({
			tools: ["read"],
			unsupported: ["Bash", "network-scan"],
		});
		expect(mapAgentPackTools(undefined)).toEqual({
			tools: ["read", "grep", "find", "ls"],
			unsupported: [],
		});
		expect(unsupportedAgentPackFields({ name: "a", description: "b", tools: [], model: "pinned" })).toEqual([]);
		expect(unsupportedAgentPackFields({ name: "a", description: "b", hooks: {}, mcp: [] })).toEqual(["hooks", "mcp"]);
	});

	it("does not widen tools, scope, resources, or sibling context through packets", async () => {
		const cwd = await createWorkspace();
		const first = normalizeSubagentRequest(
			{
				...request(cwd),
				contextPacket: { items: [{ id: "first", kind: "parent_note", content: "first secret" }] },
			},
			cwd,
		);
		const second = normalizeSubagentRequest(
			{
				...request(cwd),
				contextPacket: { items: [{ id: "second", kind: "parent_note", content: "second secret" }] },
			},
			cwd,
		);
		const tasks = [
			{ id: "first", request: first },
			{ id: "second", request: second },
		];
		const prompts: string[] = [];
		const result = await runResolvedSubagentBatch(tasks, ["delegate", "read"], {
			runResolved: async (task) => {
				prompts.push(buildSubagentPrompt(task));
				return batchResult(tasks.find((candidate) => candidate.request.runId === task.runId)!);
			},
		});
		expect(result.preflight.tasks.map((task) => task.tools)).toEqual([["read"], ["read"]]);
		expect(result.preflight.tasks.map((task) => task.scopeRoots)).toEqual([first.scope.roots, second.scope.roots]);
		expect(result.preflight.tasks.map((task) => task.resources)).toEqual([
			{ skills: [], prompts: [], context: [] },
			{ skills: [], prompts: [], context: [] },
		]);
		expect(result.preflight.tasks.map((task) => task.projectTrusted)).toEqual([false, false]);
		expect(result.preflight.tasks.map((task) => task.contextPacket)).toEqual([
			{
				itemCount: 1,
				totalBytes: Buffer.byteLength("first secret"),
				items: [{ id: "first", kind: "parent_note", bytes: 12 }],
			},
			{
				itemCount: 1,
				totalBytes: Buffer.byteLength("second secret"),
				items: [{ id: "second", kind: "parent_note", bytes: 13 }],
			},
		]);
		expect(prompts[0]).toContain("first secret");
		expect(prompts[0]).not.toContain("second secret");
		expect(prompts[1]).toContain("second secret");
		expect(prompts[1]).not.toContain("first secret");
	});

	it("normalizes scope roots and rejects roots outside the parent cwd", async () => {
		const cwd = await createWorkspace();
		const normalized = normalizeSubagentRequest(request(cwd), cwd);
		expect(normalized.scope.roots).toEqual([join(cwd, "src")]);

		expect(() => normalizeSubagentRequest({ ...request(cwd), scope: { roots: [".."] } }, cwd)).toThrowError(
			/outside the parent workspace/,
		);
	});

	it("rejects a missing exact-file target with structured scope details", async () => {
		const cwd = await createWorkspace();
		let failure: unknown;
		try {
			normalizeSubagentRequest({ ...request(cwd), scope: { roots: ["src"], targets: ["src/missing.ts"] } }, cwd);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(SubagentError);
		if (!(failure instanceof SubagentError)) throw new Error("expected a structured subagent error");
		expect(failure.code).toBe("invalid_scope");
		expect(failure.details).toMatchObject({
			field: "scope.targets",
			path: "src/missing.ts",
		});
		expect(failure.message).toMatch(/target|exist|regular file/i);
	});

	it("builds an explicitly unsafe child with host Bash and a visible risk contract", async () => {
		const cwd = await createWorkspace();
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { projectTrusted: true });
		let captured: CreateAgentSessionOptions | undefined;
		const fakeSession = {
			sessionId: "child-unsafe",
			messages: [],
		} as unknown as CreateAgentSessionResult["session"];
		await createNativeSubagentSession(
			{
				request: normalized,
				parentActiveTools: ["delegate", "read", "grep", "find", "ls", "bash", "edit", "write"],
				unsafeHostExec: true,
			},
			async (options) => {
				captured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		);
		expect(captured?.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(captured?.customTools?.map((tool) => tool.name)).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"write",
			"edit",
			"bash",
		]);
		expect(captured?.customTools?.map((tool) => tool.name)).not.toEqual(
			expect.arrayContaining(["delegate", "delegate_async", "delegate_write", "review_batch"]),
		);
		expect(captured?.customTools?.find((tool) => tool.name === "bash")).toBeDefined();
		expect(captured?.resourceLoader?.getSystemPrompt()).toContain("explicitly authorized host-execution worker");
		expect(captured?.resourceLoader?.getSystemPrompt()).toContain("Selected role guidance (self):");
		expect(captured?.resourceLoader?.getSystemPrompt()).toContain(
			"these child tools for this run: read, grep, find, ls",
		);
		expect(captured?.resourceLoader?.getSystemPrompt()).toContain(
			"Execute only the parent task with the provided tools",
		);
		expect(captured?.resourceLoader?.getSystemPrompt()).not.toContain("read-only repository exploration worker");
		expect(captured?.resourceLoader?.getAppendSystemPrompt().join("\n")).toContain("UNSANDBOXED SUBAGENT RUNTIME");
		expect(captured?.resourceLoader?.getAppendSystemPrompt().join("\n")).toContain(
			"Model-visible tool authority remains the explicit profile-aware child tool allowlist",
		);
		expect(captured?.resourceLoader?.getAppendSystemPrompt().join("\n")).not.toContain(
			"FULL-AUTHORITY SUBAGENT RUNTIME",
		);
		expect(captured?.resourceLoader?.getSystemPrompt()).toContain(
			"Role guidance describes the methodology and kind of result expected",
		);
		expect(captured?.resourceLoader?.getAppendSystemPrompt().join("\n")).toContain(
			"Cancellation is best-effort and cannot undo completed effects.",
		);

		const normalizedReview = normalizeSubagentRequest(request(cwd), cwd, { projectTrusted: true });
		let reviewCaptured: CreateAgentSessionOptions | undefined;
		await createNativeSubagentSession(
			{
				request: normalizedReview,
				parentActiveTools: ["delegate", "read", "grep", "bash"],
				unsafeHostExec: true,
			},
			async (options) => {
				reviewCaptured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		);
		expect(reviewCaptured?.tools).toEqual(["read", "grep"]);

		const normalizedReadOnly = normalizeSubagentRequest(request(cwd), cwd);
		let readOnlyCaptured: CreateAgentSessionOptions | undefined;
		await createNativeSubagentSession(
			{ request: normalizedReadOnly, parentActiveTools: ["delegate", "read", "grep", "bash"] },
			async (options) => {
				readOnlyCaptured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		);
		expect(readOnlyCaptured?.tools).toEqual(["read", "grep"]);
		await expect(
			createNativeSubagentSession(
				{ request: normalizedReadOnly, parentActiveTools: ["delegate", "read", "bash"], unsafeHostExec: true },
				async () => ({ session: fakeSession }) as CreateAgentSessionResult,
			),
		).rejects.toThrow(/trusted project/);
	});

	it("keeps read-only child sessions contained despite an external request bit", async () => {
		const cwd = await createWorkspace();
		const external = await mkdtemp(join(tmpdir(), "ice-subagent-readonly-external-"));
		tempDirs.push(external);
		const externalFile = join(external, "external.txt");
		await writeFile(externalFile, "external\n");
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { allowExternal: true });
		let captured: CreateAgentSessionOptions | undefined;
		const fakeSession = {
			sessionId: "child-readonly-external",
			messages: [],
		} as unknown as CreateAgentSessionResult["session"];
		await createNativeSubagentSession(
			{ request: normalized, parentActiveTools: ["delegate", "read"] },
			async (options) => {
				captured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		);
		const readTool = captured?.customTools?.find((tool) => tool.name === "read");
		if (!readTool) throw new Error("read-only child read tool missing");
		await expect(
			readTool.execute("read-external", { path: externalFile }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow(/outside|approved|scope/i);
		expect(await readFile(externalFile, "utf8")).toBe("external\n");
	});

	it("loads only explicitly selected resources and no ambient extensions even for an unsafe child", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(cwd, ".ice", "extensions"), { recursive: true });
		await mkdir(join(cwd, ".ice", "skills", "ambient-skill"), { recursive: true });
		await mkdir(join(cwd, ".ice", "prompts"), { recursive: true });
		await mkdir(join(agentDir, "skills", "user-skill"), { recursive: true });
		await mkdir(join(agentDir, "prompts"), { recursive: true });
		const explicitContextPath = join(cwd, "explicit-context.md");
		await writeFile(
			join(cwd, ".ice", "extensions", "ambient.ts"),
			'export default function(ice) { ice.registerCommand("ambient", { description: "ambient", handler: async () => {} }); }\n',
		);
		await writeFile(
			join(cwd, ".ice", "skills", "ambient-skill", "SKILL.md"),
			"---\nname: ambient-skill\ndescription: Ambient project skill\n---\nAmbient skill.\n",
		);
		await writeFile(
			join(agentDir, "skills", "user-skill", "SKILL.md"),
			"---\nname: user-skill\ndescription: Ambient user skill\n---\nUser skill.\n",
		);
		await writeFile(join(cwd, ".ice", "prompts", "ambient.md"), "Ambient prompt.\n");
		await writeFile(join(agentDir, "prompts", "user.md"), "User prompt.\n");
		await writeFile(join(cwd, "AGENTS.md"), "Ambient project context.\n");
		await writeFile(explicitContextPath, "Explicit child context.\n");
		await writeFile(join(cwd, ".ice", "SYSTEM.md"), "Ambient system prompt.\n");
		await writeFile(join(cwd, ".ice", "APPEND_SYSTEM.md"), "Ambient append prompt.\n");
		const normalized = normalizeSubagentRequest(
			{ ...request(cwd), resources: { context: [explicitContextPath] } },
			cwd,
			{ agentDir, projectTrusted: true },
		);
		const fakeSession = {
			sessionId: "child-ambient",
			messages: [],
		} as unknown as CreateAgentSessionResult["session"];
		let captured: CreateAgentSessionOptions | undefined;
		await createNativeSubagentSession(
			{
				request: normalized,
				parentActiveTools: ["delegate", "read", "grep", "find", "ls", "bash", "edit", "write"],
				unsafeHostExec: true,
				agentDir,
			},
			async (options) => {
				captured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		);
		const loader = captured?.resourceLoader;
		expect(loader?.getExtensions().extensions).toEqual([]);
		expect(loader?.getSkills().skills).toEqual([]);
		expect(loader?.getPrompts().prompts).toEqual([]);
		expect(loader?.getAgentsFiles().agentsFiles).toEqual([
			{ path: explicitContextPath, content: "Explicit child context.\n" },
		]);
		expect(loader?.getSystemPrompt()).not.toContain("Ambient system prompt.\n");
		expect(loader?.getAppendSystemPrompt()).not.toContain("Ambient append prompt.\n");
	});

	it("passes unsafe tools through the native runner execution path", async () => {
		const cwd = await createWorkspace();
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { projectTrusted: true });
		let captured: CreateAgentSessionOptions | undefined;
		const childMessages: AgentMessage[] = [];
		const fakeSession = {
			sessionId: "child-runner-unsafe",
			model: { provider: "faux", id: "unsafe" } as Model<Api>,
			messages: childMessages,
			subscribe: vi.fn(() => vi.fn()),
			prompt: vi.fn(async () => {
				childMessages.push({
					role: "assistant",
					content: '{"summary":"ok","evidence":{"paths":["src"]}}',
					stopReason: "stop",
				} as unknown as AgentMessage);
			}),
			abort: vi.fn(async () => {}),
			dispose: vi.fn(),
			extensionRunner: createNoopExtensionRunner(),
			getSessionStats: vi.fn(() => ({
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
			})),
		} as unknown as CreateAgentSessionResult["session"];
		const result = await new NativeSubagentRunner({
			createSession: async (options) => {
				captured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		}).runResolved(normalized, ["delegate", "read", "grep", "find", "ls", "bash", "edit", "write"], {
			unsafeHostExec: true,
			projectTrusted: true,
		});
		expect(result.status).toBe("completed");
		expect(captured?.tools).toEqual(["read", "grep", "find", "ls"]);
	});

	it("builds a stripped child with fresh in-memory history and narrowed tools", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		let captured: CreateAgentSessionOptions | undefined;
		const fakeSession = {
			sessionId: "child-1",
			messages: [],
		} as unknown as CreateAgentSessionResult["session"];
		await createNativeSubagentSession(
			{ request: normalized, parentActiveTools: ["delegate", "read", "grep", "edit"], agentDir },
			async (options) => {
				captured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		);
		expect(captured?.tools).toEqual(["read", "grep"]);
		expect(captured?.customTools?.map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);
		const scopedRead = captured?.customTools?.find((tool) => tool.name === "read");
		expect(scopedRead).toBeDefined();
		await expect(
			scopedRead!.execute(
				"read-outside",
				{ path: join(cwd, "package.json") },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			),
		).rejects.toThrow(/outside the approved subagent scope/);
		await expect(
			scopedRead!.execute(
				"read-home",
				{ path: "~/.ice/agent/auth.json" },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			),
		).rejects.toThrow(/outside the approved subagent scope/);
		for (const [name, params] of [
			["grep", { pattern: "secret", path: join(cwd, "package.json") }],
			["find", { pattern: "*", path: join(cwd, "package.json") }],
			["ls", { path: join(cwd, "package.json") }],
		] as const) {
			const tool = captured?.customTools?.find((candidate) => candidate.name === name);
			expect(tool).toBeDefined();
			await expect(
				tool!.execute(`${name}-outside`, params, undefined, undefined, undefined as unknown as ExtensionContext),
			).rejects.toThrow(/outside the approved subagent scope/);
		}
		expect(captured?.sessionManager?.getEntries()).toEqual([]);
		const loader = captured?.resourceLoader;
		expect(loader?.getExtensions().extensions).toEqual([]);
		expect(loader?.getSkills().skills).toEqual([]);
		expect(loader?.getPrompts().prompts).toEqual([]);
		expect(loader?.getThemes().themes).toEqual([]);
		expect(loader?.getAgentsFiles().agentsFiles).toEqual([]);
		expect(loader?.getAppendSystemPrompt()).toEqual([]);
		expect(loader?.getSystemPrompt()).toContain("Inspect the approved scope");
		expect(buildSubagentPrompt(normalized)).toContain("Trace the model runtime.");
	});

	it("keeps selected resource paths from widening final tool authority", async () => {
		const cwd = await createWorkspace();
		const resourceRoot = await mkdtemp(join(tmpdir(), "ice-subagents-resource-root-"));
		tempDirs.push(resourceRoot);
		const resourcePath = join(resourceRoot, "selected.md");
		await writeFile(resourcePath, "selected resource\n");
		const definitions = createScopedWriterToolDefinitions(cwd, [join(cwd, "src")], false, [resourceRoot], ["read"]);
		const readTool = definitions.find((tool) => tool.name === "read");
		const findTool = definitions.find((tool) => tool.name === "find");
		expect(readTool).toBeDefined();
		expect(findTool).toBeDefined();
		await expect(
			readTool!.execute(
				"read-selected-resource",
				{ path: resourcePath },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			),
		).resolves.toMatchObject({ content: [{ type: "text" }] });
		await expect(
			findTool!.execute(
				"find-forged-selected-resource",
				{ pattern: "*", path: resourceRoot },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			),
		).rejects.toMatchObject({ code: "capability_denied" });
		const emptyTools = createScopedWriterToolDefinitions(cwd, [join(cwd, "src")], false, [resourceRoot], []);
		const emptyReadTool = emptyTools.find((tool) => tool.name === "read");
		await expect(
			emptyReadTool!.execute(
				"read-with-empty-subset",
				{ path: resourcePath },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			),
		).rejects.toMatchObject({ code: "capability_denied" });
		expect(() => assertSubagentToolEligible("read-like", ["read"])).toThrowError(SubagentError);
	});

	it("keeps existing scope admission behavior for authorized tools", async () => {
		const cwd = await createWorkspace();
		const definitions = createScopedWriterToolDefinitions(cwd, [join(cwd, "src")], false, [], ["read"]);
		const readTool = definitions.find((tool) => tool.name === "read");
		await writeFile(join(cwd, "src", "inside.txt"), "inside\n");
		await expect(
			readTool!.execute(
				"read-in-scope",
				{ path: join(cwd, "src", "inside.txt") },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			),
		).resolves.toMatchObject({ content: [{ type: "text" }] });
		await expect(
			readTool!.execute(
				"read-outside-scope",
				{ path: join(cwd, "outside.txt") },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			),
		).rejects.toThrow(/outside|approved|scope/i);
	});

	it("lets an unsafe child read explicitly inherited parent skills through symlink aliases without widening mutation or host scope", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		const sharedSkills = await mkdtemp(join(tmpdir(), "ice-subagents-shared-skills-"));
		const outside = await mkdtemp(join(tmpdir(), "ice-subagents-skill-outside-"));
		tempDirs.push(agentDir, sharedSkills, outside);
		const reviewDir = join(sharedSkills, "review");
		await mkdir(reviewDir, { recursive: true });
		await mkdir(join(agentDir, "skills"), { recursive: true });
		await writeFile(
			join(reviewDir, "SKILL.md"),
			"---\nname: review\ndescription: Ambient review skill.\n---\nAmbient review skill.\n",
		);
		await symlink(reviewDir, join(agentDir, "skills", "review"));
		await writeFile(join(agentDir, "auth.json"), "credential secret.\n");
		await writeFile(join(cwd, "src", "in-scope.ts"), "in scope\n");
		await writeFile(join(outside, "secret.txt"), "outside secret\n");
		await symlink(outside, join(cwd, "src", "link"));
		const normalized = normalizeSubagentRequest(
			{ ...request(cwd), self: { ...request(cwd).self, inheritSkills: true } },
			cwd,
			{
				agentDir,
				projectTrusted: true,
				parentSkills: [
					{
						name: "review",
						description: "Parent-loaded review skill",
						filePath: join(agentDir, "skills", "review", "SKILL.md"),
						baseDir: reviewDir,
						sourceInfo: {
							path: join(agentDir, "skills", "review", "SKILL.md"),
							source: "local",
							scope: "user",
							origin: "top-level",
						},
						disableModelInvocation: false,
					},
				],
			},
		);
		let captured: CreateAgentSessionOptions | undefined;
		const fakeSession = {
			sessionId: "child-yolo-skill-alias",
			messages: [],
		} as unknown as CreateAgentSessionResult["session"];
		await createNativeSubagentSession(
			{
				request: normalized,
				parentActiveTools: ["delegate", "read", "grep", "find", "ls", "bash", "edit", "write"],
				unsafeHostExec: true,
				agentDir,
			},
			async (options) => {
				captured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		);
		expect(captured?.resourceLoader?.getSkills().skills.map((skill) => skill.name)).toEqual(
			expect.arrayContaining(["review"]),
		);
		const scopedRead = captured?.customTools?.find((tool) => tool.name === "read");
		const scopedWrite = captured?.customTools?.find((tool) => tool.name === "write");
		expect(scopedRead).toBeDefined();
		expect(scopedWrite).toBeDefined();
		const aliasPath = join(agentDir, "skills", "review", "SKILL.md");
		const canonicalSkillPath = join(reviewDir, "SKILL.md");
		for (const path of [aliasPath, canonicalSkillPath]) {
			await expect(
				scopedRead!.execute(
					"read-yolo-skill",
					{ path },
					undefined,
					undefined,
					undefined as unknown as ExtensionContext,
				),
			).resolves.toMatchObject({ content: [{ type: "text" }] });
		}
		await expect(
			scopedRead!.execute(
				"read-auth",
				{ path: join(agentDir, "auth.json") },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			),
		).rejects.toThrow(/outside|approved|scope/i);
		await expect(
			scopedRead!.execute(
				"read-symlink-escape",
				{ path: join(cwd, "src", "link", "secret.txt") },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			),
		).rejects.toThrow(/outside|approved|scope|moved/i);
		await expect(
			scopedWrite!.execute(
				"write-skill",
				{ path: canonicalSkillPath, content: "mutated\n" },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			),
		).rejects.toThrow(/outside|approved|scope/i);
		expect(await readFile(canonicalSkillPath, "utf8")).toContain("Ambient review skill.");
	});

	it("compacts a long-running native child and resumes with the same authority", async () => {
		const cwd = await createWorkspace();
		const agentDir = join(cwd, ".ice-agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(cwd, "src", "large.txt"), "child context\n");
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				compaction: {
					thresholdPercent: 1,
					reserveTokens: 128,
					keepRecentTokens: 1,
					midRunCompaction: "resume",
				},
			}),
		);
		const faux = registerFauxProvider();
		try {
			const authStorage = AuthStorage.inMemory();
			await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
			const modelRuntime = await ModelRuntime.create({
				credentials: authStorage,
				modelsPath: join(cwd, "models.json"),
			});
			const model = faux.getModel();
			modelRuntime.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				api: model.api,
				models: [model],
			});
			faux.setResponses([
				fauxAssistantMessage("partial child response", { stopReason: "length" }),
				fauxAssistantMessage("The child task context was compacted and is ready to resume."),
				fauxAssistantMessage('{"summary":"compacted child report","evidence":{"paths":["src/large.txt"]}}'),
			]);
			// Structured report mode: the child-compaction contract asserts a parsed
			// JSON-envelope summary, which only the typed ingestion path produces.
			// (Ordinary delegations ingest the natural final turn verbatim.)
			const normalized = normalizeSubagentRequest(
				{
					...request(cwd),
					acceptanceCriteria: [
						{ id: "compaction-report", requirement: "Return the bounded report envelope.", required: true },
					],
				},
				cwd,
				{ agentDir },
			);
			expect(normalized.reportMode).toBe("structured_report");
			const events: iceSubagentsModule.SubagentEvent[] = [];
			const bridge = new IceAgentViewBridge();
			const result = await new NativeSubagentRunner({ agentDir, agentViewBridge: bridge }).runResolved(
				normalized,
				["delegate", "read"],
				{ model, modelRuntime, onEvent: (event) => events.push(event) },
			);

			expect(result.status).toBe("completed");
			expect(result.summary).toBe("compacted child report");
			const compactionEvents = events.filter(
				(event) => event.type === "subagent_compaction_start" || event.type === "subagent_compaction_end",
			);
			expect(compactionEvents).toEqual([
				expect.objectContaining({
					type: "subagent_compaction_start",
					status: "running",
					compactionReason: "overflow",
					compactionStatus: "started",
				}),
				expect.objectContaining({
					type: "subagent_compaction_end",
					status: "running",
					compactionReason: "overflow",
					compactionStatus: "completed",
					compactionWillRetry: true,
				}),
			]);
			expect(compactionEvents.every((event) => !Object.hasOwn(event, "summary"))).toBe(true);
			expect(bridge.getView(normalized.runId)?.presentation).toMatchObject({ compacting: false });
		} finally {
			faux.unregister();
		}
	});

	it("preserves child model, tools, and scope across overflow compaction", async () => {
		const cwd = await createWorkspace();
		const agentDir = join(cwd, ".ice-agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(cwd, "src", "app.ts"), "export const app = true;\n");
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 128, midRunCompaction: "resume" } }),
		);
		const faux = registerFauxProvider();
		try {
			const authStorage = AuthStorage.inMemory();
			await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
			const modelRuntime = await ModelRuntime.create({
				credentials: authStorage,
				modelsPath: join(cwd, "models.json"),
			});
			const model = faux.getModel();
			modelRuntime.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				api: model.api,
				models: [model],
			});
			faux.setResponses([
				fauxAssistantMessage("partial child response", { stopReason: "length" }),
				fauxAssistantMessage("The child context was compacted."),
				fauxAssistantMessage("The child resumed after compaction."),
			]);
			const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
			const child = await createNativeSubagentSession({
				request: normalized,
				parentActiveTools: ["delegate", "read"],
				model,
				modelRuntime,
				agentDir,
			});
			const events: AgentSessionEvent[] = [];
			const unsubscribe = child.session.subscribe((event) => events.push(event));
			try {
				await child.session.prompt(child.prompt, { expandPromptTemplates: false, source: "extension" });
				expect(events.some((event) => event.type === "compaction_start" && event.reason === "overflow")).toBe(true);
				expect(events.some((event) => event.type === "compaction_end" && event.willRetry)).toBe(true);
				expect(child.session.messages.some((message) => message.role === "compactionSummary")).toBe(true);
				expect(child.session.model).toBe(model);
				expect(child.session.getActiveToolNames()).toEqual(["read"]);
				await expect(
					child.session
						.getToolDefinition("read")!
						.execute(
							"read-after-compaction-outside-scope",
							{ path: join(cwd, "package.json") },
							undefined,
							undefined,
							undefined as unknown as ExtensionContext,
						),
				).rejects.toThrow(/outside the approved subagent scope/);
			} finally {
				unsubscribe();
				child.session.dispose();
			}
		} finally {
			faux.unregister();
		}
	});

	it("continues model-driven child tool work after overflow compaction", async () => {
		const cwd = await createWorkspace();
		const agentDir = join(cwd, ".ice-agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(cwd, "src", "after-compaction.txt"), "post-compaction evidence\n");
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 128, midRunCompaction: "resume" } }),
		);
		const faux = registerFauxProvider();
		try {
			const { model, modelRuntime } = await createFauxChildRuntime(cwd, faux);
			let finalContext: Context | undefined;
			faux.setResponses([
				fauxAssistantMessage("partial child response", { stopReason: "length" }),
				fauxAssistantMessage("overflow summary retained the task"),
				fauxAssistantMessage(
					fauxToolCall("read", { path: "src/after-compaction.txt" }, { id: "post-compaction-read" }),
					{ stopReason: "toolUse" },
				),
				(context) => {
					finalContext = context;
					return fauxAssistantMessage(
						'{"summary":"tool continuation complete","evidence":{"paths":["src/after-compaction.txt"]}}',
					);
				},
			]);
			// Structured report mode: this test asserts a parsed JSON-envelope summary
			// plus evidence paths, which only the typed ingestion path produces.
			const normalized = normalizeSubagentRequest(
				{
					...request(cwd),
					acceptanceCriteria: [
						{ id: "tool-report", requirement: "Return the bounded report envelope.", required: true },
					],
				},
				cwd,
				{ agentDir },
			);
			expect(normalized.reportMode).toBe("structured_report");
			const events: iceSubagentsModule.SubagentEvent[] = [];
			const result = await new NativeSubagentRunner({ agentDir }).runResolved(normalized, ["delegate", "read"], {
				model,
				modelRuntime,
				onEvent: (event) => events.push(event),
			});

			expect(result).toMatchObject({
				status: "completed",
				summary: "tool continuation complete",
				evidence: { paths: ["src/after-compaction.txt"] },
			});
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "subagent_tool_start",
						toolName: "read",
						toolCallId: "post-compaction-read",
					}),
					expect.objectContaining({
						type: "subagent_tool_end",
						toolName: "read",
						toolCallId: "post-compaction-read",
					}),
				]),
			);
			expect(JSON.stringify(finalContext)).toContain("post-compaction evidence");
			expect(faux.state.callCount).toBe(4);
		} finally {
			faux.unregister();
		}
	});

	it("uses the core provider retry path without replaying a completed child tool", async () => {
		const cwd = await createWorkspace();
		await writeFile(join(cwd, "src", "app.ts"), "export const app = true;\n");
		const scripted = registerScriptedUsageProvider(
			[
				fauxAssistantMessage(fauxToolCall("read", { path: "src/app.ts" }, { id: "retry-read" })),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
				fauxAssistantMessage('{"summary":"recovered child report","evidence":{"paths":["src/app.ts"]}}'),
			],
			{ api: "anthropic-messages" },
		);
		const settingsManager = SettingsManager.inMemory();
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
		const events: iceSubagentsModule.SubagentEvent[] = [];
		const bridge = new IceAgentViewBridge();
		let childRetrySettings: ReturnType<SettingsManager["getRetrySettings"]> | undefined;
		try {
			const model = scripted.model;
			const modelRuntime = await scriptedModelRuntime(cwd, model);
			const normalized = normalizeSubagentRequest(request(cwd), cwd);
			const result = await new NativeSubagentRunner({
				agentDir: cwd,
				artifactRoot: join(cwd, "artifacts"),
				agentViewBridge: bridge,
				createSession: async (sessionOptions) => {
					childRetrySettings = sessionOptions.settingsManager?.getRetrySettings();
					return createAgentSession(sessionOptions);
				},
			}).runResolved(normalized, ["delegate", "read"], {
				model,
				modelRuntime,
				settingsManager,
				onEvent: (event) => events.push(event),
			});

			expect(childRetrySettings).toMatchObject({ enabled: true, maxRetries: 1, baseDelayMs: 1 });
			expect(result.status).toBe("completed");
			expect(scripted.consumed()).toBe(3);
			expect(events.filter((event) => event.type === "subagent_tool_start")).toHaveLength(1);
			const retryEvents = events.filter((event) => event.type === "subagent_retry");
			expect(retryEvents.map((event) => event.retry?.state)).toEqual(["scheduled", "recovered"]);
			expect(retryEvents[0]?.retry).toMatchObject({ attempt: 1, maxAttempts: 1, delayMs: 1 });
			expect(retryEvents[0]?.retry?.diagnostic).toBe("overloaded_error");
			expect(bridge.getView(normalized.runId)?.presentation?.retry).toMatchObject({
				state: "recovered",
				attempt: 1,
				maxAttempts: 1,
			});
		} finally {
			scripted.unregister();
		}
	});

	it("installs unsafe prompt and mutation tools on the real child session", async () => {
		const cwd = await createWorkspace();
		const faux = registerFauxProvider();
		try {
			const authStorage = AuthStorage.inMemory();
			await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
			const modelRuntime = await ModelRuntime.create({
				credentials: authStorage,
				modelsPath: join(cwd, "models.json"),
			});
			const model = faux.getModel();
			modelRuntime.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				api: model.api,
				models: [model],
			});
			const normalized = normalizeSubagentRequest(request(cwd), cwd, { projectTrusted: true });
			const child = await createNativeSubagentSession({
				request: normalized,
				parentActiveTools: ["delegate", "read", "grep", "find", "ls", "bash", "edit", "write"],
				unsafeHostExec: true,
				model,
				modelRuntime,
				agentDir: cwd,
			});
			try {
				expect(child.session.getActiveToolNames()).toEqual(["read", "grep", "find", "ls"]);
				expect(child.session.systemPrompt).toContain("explicitly authorized host-execution worker");
				expect(child.session.systemPrompt).toContain("Selected role guidance (self):");
				expect(child.session.systemPrompt).toContain("Role guidance describes the methodology");
				expect(child.session.systemPrompt).toContain("The trusted parent explicitly authorizes these child tools");
				expect(child.session.systemPrompt).toContain("Execute only the parent task with the provided tools");
				expect(child.session.systemPrompt).not.toContain("Do not modify files, run commands");
			} finally {
				child.session.dispose();
			}
		} finally {
			faux.unregister();
		}
	});

	it("rejects out-of-scope finding evidence at the direct review verifier boundary", async () => {
		const cwd = await createWorkspace();
		const task = resolvedReviewTask(cwd, "direct-review", "security");
		const result = {
			...batchResult(task),
			findings: [
				{
					severity: "high" as const,
					category: "security",
					claim: "The boundary is unsafe.",
					evidence: [{ path: "../outside" }],
				},
			],
		};
		// Review verification is structured-report-only regardless of fixture mode.
		expect(verifySubagentResult(result, { ...task.request, reportMode: "structured_report" })).toMatchObject({
			verified: false,
			reason: expect.stringMatching(/outside|exist/i),
		});
	});

	it("retries a proven pre-effect startup failure with the same authority and remaining deadline", async () => {
		const cwd = await createWorkspace();
		const task = resolvedBatchTask(cwd, "retry");
		const attempts: number[] = [];
		const requests: unknown[] = [];
		const result = await runSubagentWithRecovery(task.request, ["delegate", "read"], (attempt, retryRequest) => {
			attempts.push(attempt);
			requests.push(retryRequest);
			if (attempt === 1) {
				return Promise.resolve({
					...batchResult(task, "failed", "temporary"),
					childSessionId: undefined,
					partial: false,
					retrySafeStartup: true,
					observedTurns: 0,
					diagnostics: [
						{ code: "child_startup_failure" as const, message: "provider startup failed", retryable: true },
					],
				});
			}
			return Promise.resolve(batchResult(task));
		});
		expect(attempts).toEqual([1, 2]);
		expect(requests[0]).toBe(task.request);
		expect(requests[1]).not.toBe(task.request);
		expect(requests[1]).toMatchObject({
			runId: task.request.runId,
			scope: task.request.scope,
			profile: task.request.profile,
		});
		expect((requests[1] as typeof task.request).timeoutMs).toBeLessThanOrEqual(task.request.timeoutMs);
		expect(result.status).toBe("completed");
		expect(result.observedOutputBytes).toBe(Buffer.byteLength("ok"));
		expect(result.recovery?.totalObservedOutputBytes).toBe(Buffer.byteLength("temporary") + Buffer.byteLength("ok"));
		expect(result.usage).toEqual({
			inputTokens: 2,
			outputTokens: 4,
			cacheReadTokens: 6,
			cacheWriteTokens: 8,
			cost: 1,
		});
		expect(result.recovery).toEqual({
			attemptCount: 2,
			retried: true,
			totalObservedOutputBytes: Buffer.byteLength("temporary") + Buffer.byteLength("ok"),
			attempts: [
				{
					attempt: 1,
					status: "failed",
					failureCode: "child_startup_failure",
					observedOutputBytes: Buffer.byteLength("temporary"),
				},
				{ attempt: 2, status: "completed", observedOutputBytes: Buffer.byteLength("ok") },
			],
		});
	});

	it("builds an ordered preflight with actual model, capability, scope, and resource provenance", async () => {
		const cwd = await createWorkspace();
		await writeFile(join(cwd, "AGENTS.md"), "secret context body must not enter the digest");
		const parent = testModel("provider", "parent");
		const parentTask = resolvedReviewTask(cwd, "parent", "correctness");
		const contextTask = {
			...resolvedReviewTask(cwd, "security", "security"),
			request: normalizeSubagentRequest(
				{ ...request(cwd), task: "Review security.", resources: { context: ["AGENTS.md"] } },
				cwd,
				{ projectTrusted: true },
			),
		};
		const assigned = [parentTask, contextTask].map((task) => ({
			...task,
			model: parent,
			modelProvenance: { source: "parent" as const, resolved: "provider/parent" },
		}));
		const preflight = buildSubagentLaunchPreflight(assigned, ["read", "grep"], {
			batchId: "batch-1",
			concurrency: 2,
		});
		expect(preflight).toMatchObject({
			batchId: "batch-1",
			taskCount: 2,
			concurrency: 2,
		});
		expect(preflight).not.toHaveProperty("budget");
		expect(preflight.tasks.map((task) => task.taskId)).toEqual(["parent", "security"]);
		expect(preflight.tasks[0]?.model).toEqual({ resolved: "provider/parent", source: "parent" });
		expect(preflight.tasks[1]?.model).toEqual({ resolved: "provider/parent", source: "parent" });
		expect(preflight.tasks[0]?.scopeRoots).toEqual(parentTask.request.scope.roots);
		expect(preflight.tasks[0]?.tools).toEqual(["read", "grep"]);
		expect(preflight.tasks[1]?.resources.context).toEqual(["AGENTS.md"]);
		expect(preflight.tasks[1]?.resourceProvenance.context[0]).toMatchObject({
			name: "AGENTS.md",
			source: "project",
			sourceHash: expect.any(String),
		});
		const digest = formatSubagentLaunchDigest(preflight, 1024);
		expect(Buffer.byteLength(digest)).toBeLessThanOrEqual(1024);
		expect(digest).toContain("provider/parent [parent]");
		expect(digest).not.toContain("secret context body");
		const truncatedDigest = formatSubagentLaunchDigest(preflight, 128);
		expect(Buffer.byteLength(truncatedDigest)).toBeLessThanOrEqual(128);
		expect(preflight.tasks[1]?.model).toEqual({ resolved: "provider/parent", source: "parent" });
	});

	it("reports the full built-in tool set for unsafe batch preflight", async () => {
		const cwd = await createWorkspace();
		const task = resolvedBatchTask(cwd, "unsafe");
		const preflight = buildSubagentLaunchPreflight(
			[task],
			["delegate", "read", "grep", "find", "ls", "bash", "edit", "write"],
			{ unsafeHostExec: true },
		);
		expect(preflight.tasks[0]?.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(preflight.recovery).toEqual({ maxAttempts: 1, sameModel: true, retryableFailures: [] });
	});

	it("does not retry unsafe batch children", async () => {
		const cwd = await createWorkspace();
		const task = resolvedBatchTask(cwd, "unsafe");
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: vi.fn(async () => {
				throw new Error("unsafe child failed after a host side effect");
			}),
		};
		const result = await runResolvedSubagentBatch([task], ["delegate", "read", "bash"], runner, {
			unsafeHostExec: true,
		});
		expect(result.status).toBe("failed");
		expect(result).not.toHaveProperty("budget");
		expect(runner.runResolved).toHaveBeenCalledOnce();
	});
	it("applies before-launch hook context additions without widening child authority", async () => {
		const settingsManager = SettingsManager.inMemory({
			ice: {
				hooks: {
					enabled: true,
					definitions: [
						{
							id: "context",
							event: "subagent.beforeLaunch",
							kind: "in-process",
							required: true,
						},
					],
				},
			},
		});
		const contexts: Context[] = [];
		const harness = await createAsyncToolHarness({
			settingsManager,
			hookHandlers: {
				context: () => ({ outcome: "continue" as const, contextAdditions: [{ content: "hook note" }] }),
			},
		});
		try {
			harness.faux.setResponses([
				(context) => {
					contexts.push(context);
					return fauxAssistantMessage('{"summary":"context applied","evidence":{"paths":["src"]}}');
				},
			]);
			const result = await settleManagedDelegate(
				harness.tools,
				harness.context,
				await harness.tools.get("delegate").execute(
					"hook-context",
					{
						role: "self",
						self: {
							instructions: "Inspect the approved scope and report evidence.",
							capabilities: ["read", "grep", "find", "ls"],
						},
						task: "Inspect the source tree.",
						scope: { roots: ["src"] },
					},
					undefined,
					undefined,
					harness.context,
				),
			);
			expect(result).toMatchObject({ isError: false });
			expect(contexts.some((context) => JSON.stringify(context.messages).includes("hook note"))).toBe(true);
			expect(contexts.some((context) => JSON.stringify(context.messages).includes("no lifetime timeout"))).toBe(
				true,
			);
			const launch = (result.details as { launch?: { execution?: { tools?: readonly string[] } } }).launch;
			expect(launch?.execution?.tools ?? []).not.toContain("bash");
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("restores owner-scoped jobs and delivers only undelivered completion metadata", async () => {
		const registerTool = vi.fn();
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
		const appended: Array<{ customType: string; data: unknown }> = [];
		const sent: Array<{ message: unknown; options: unknown }> = [];
		const entries: Array<Record<string, unknown>> = [
			{
				type: "custom",
				customType: JOB_ENTRY_TYPE,
				data: {
					schemaVersion: 1,
					sequence: 1,
					job: {
						schemaVersion: 1,
						jobId: "stale-job",
						ownerSessionId: "owner-a",
						launchLeafId: "leaf-a",
						role: "self",
						status: "running",
						createdAt: "2026-01-01T00:00:00.000Z",
						startedAt: "2026-01-01T00:00:00.500Z",
						resultRef: "job:stale-job",
					},
				},
			},
			{
				type: "custom",
				customType: JOB_ENTRY_TYPE,
				data: {
					schemaVersion: 1,
					sequence: 1,
					job: {
						schemaVersion: 1,
						jobId: "foreign-job",
						ownerSessionId: "owner-b",
						launchLeafId: "leaf-b",
						role: "self",
						status: "completed",
						createdAt: "2026-01-01T00:00:00.000Z",
						startedAt: "2026-01-01T00:00:00.500Z",
						finishedAt: "2026-01-01T00:00:01.000Z",
						resultRef: "job:foreign-job",
					},
					result: { schemaVersion: 1, jobId: "foreign-job", status: "completed", diagnostics: [] },
				},
			},
			{
				type: "custom",
				customType: JOB_ENTRY_TYPE,
				data: {
					schemaVersion: 1,
					sequence: 1,
					job: {
						schemaVersion: 1,
						jobId: "done-job",
						ownerSessionId: "owner-a",
						launchLeafId: "leaf-a",
						role: "self",
						status: "completed",
						createdAt: "2026-01-01T00:00:00.000Z",
						startedAt: "2026-01-01T00:00:00.500Z",
						finishedAt: "2026-01-01T00:00:01.000Z",
						resultRef: "job:done-job",
					},
					result: { schemaVersion: 1, jobId: "done-job", status: "completed", summary: "done", diagnostics: [] },
				},
			},
			{
				type: "custom_message",
				customType: JOB_COMPLETION_MESSAGE_TYPE,
				details: { jobId: "done-job", status: "completed", resultRef: "job:done-job" },
			},
		];
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) {
				handlers.set(event, handler);
			},
			registerTool,
			appendEntry(customType: string, data: unknown) {
				appended.push({ customType, data });
				entries.push({ type: "custom", customType, data });
			},
			sendMessage(message: unknown, options: unknown) {
				sent.push({ message, options });
			},
		} as unknown as ExtensionAPI;
		iceSubagents(api);
		const context = {
			cwd: "/workspace",
			model: undefined,
			scopedModels: [],
			isProjectTrusted: () => false,
			sessionManager: {
				getSessionId: () => "owner-a",
				getLeafId: () => "leaf-a",
				getEntries: () => entries,
			},
		} as unknown as ExtensionContext;
		await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, context);

		expect(appended.at(-1)).toMatchObject({
			customType: JOB_ENTRY_TYPE,
			data: { job: { jobId: "stale-job", status: "interrupted" } },
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message).toMatchObject({
			customType: JOB_COMPLETION_MESSAGE_TYPE,
			details: { jobId: "stale-job", status: "interrupted", resultRef: "job:stale-job" },
		});
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		const inspect = registerTool.mock.calls.find((call) => call[0]?.name === "inspect_subagent_job")?.[0];
		const inspected = await inspect.execute(
			"inspect-restored",
			{ jobId: "stale-job" },
			undefined,
			undefined,
			context,
		);
		expect(inspected).toMatchObject({ isError: false, details: { inspection: { job: { status: "interrupted" } } } });
		const foreign = await inspect.execute("inspect-foreign", { jobId: "foreign-job" }, undefined, undefined, context);
		expect(foreign).toMatchObject({ isError: true });
		await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, context);
	});

	it("reads large final output through the shared owner-scoped parent tool", async () => {
		const harness = await createAsyncToolHarness();
		const finalAnswer = "large final answer 🌿\\n".repeat(2_400);
		try {
			harness.faux.setResponses([fauxAssistantMessage(finalAnswer)]);
			const launched = await settleManagedDelegate(
				harness.tools,
				harness.context,
				await harness.tools.get("delegate")!.execute(
					"read-output-launch",
					{
						role: "self",
						self: {
							instructions: "Inspect the approved scope and report the requested fact.",
							capabilities: ["read"],
						},
						task: "Inspect the source tree and return the final answer.",
						scope: { roots: ["src"] },
					},
					undefined,
					undefined,
					harness.context,
				),
			);
			expect(launched).toMatchObject({ isError: false });
			const result = (launched.details as { result: SubagentResult }).result;
			expect(result.output).toMatchObject({
				captureStatus: "artifact_complete",
				artifact: { schemaVersion: 2, truncated: false },
			});
			const artifactId = result.output!.artifact!.id;
			expect(artifactId).not.toBe(result.runId);
			expect(result.output!.artifact).not.toHaveProperty("path");

			const readTool = harness.tools.get("read_subagent_output")!;
			const read = await readTool.execute(
				"read-output",
				{ artifactId, length: 64 * 1024 },
				undefined,
				undefined,
				harness.context,
			);
			expect(read).toMatchObject({ isError: false });
			expect(read.details).toMatchObject({
				output: {
					artifactId,
					text: finalAnswer,
					totalBytes: Buffer.byteLength(finalAnswer),
					eof: true,
				},
			});
			expect(read.content[0]?.text).toContain(`nextOffset=${Buffer.byteLength(finalAnswer)}`);

			const foreignContext = {
				...harness.context,
				sessionManager: {
					getSessionId: () => "owner-b",
					getLeafId: () => "leaf-b",
					getEntries: harness.getEntries,
				},
			} as unknown as ExtensionContext;
			const foreign = await readTool.execute("read-foreign", { artifactId }, undefined, undefined, foreignContext);
			const unknown = await readTool.execute(
				"read-unknown",
				{ artifactId: "00000000-0000-4000-8000-000000000000" },
				undefined,
				undefined,
				harness.context,
			);
			expect(foreign).toMatchObject({ isError: true, details: { error: { code: "artifact_not_found" } } });
			expect(unknown).toMatchObject({ isError: true, details: { error: { code: "artifact_not_found" } } });
			expect(foreign.content[0]?.text).toBe(unknown.content[0]?.text);
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("cancels only jobs from an aborted parent run and allows later runs to launch", async () => {
		const harness = await createAsyncToolHarness();
		const parentSignals = [new AbortController(), new AbortController(), new AbortController()];
		let runCount = 0;
		let secondChildSignal: AbortSignal | undefined;
		const completedResult = (request: {
			runId: string;
			parentSessionId: string;
			profile: string;
			source: SubagentResult["source"];
		}) => ({
			runId: request.runId,
			parentSessionId: request.parentSessionId,
			childSessionId: `child-${++runCount}`,
			profile: request.profile,
			source: request.source,
			status: "completed" as const,
			summary: "async fact",
			output: {
				text: "async fact",
				textBytes: Buffer.byteLength("async fact"),
				originalBytes: Buffer.byteLength("async fact"),
				inlineTruncated: false,
				captureStatus: "inline_complete" as const,
			},
			observedOutputBytes: Buffer.byteLength("async fact"),
			partial: false,
			diagnostics: [],
			evidence: { paths: ["src"] },
		});
		const runResolved = vi
			.spyOn(NativeSubagentRunner.prototype, "runResolved")
			.mockImplementation(async (request, _activeTools, options) => {
				if (runCount === 1) {
					secondChildSignal = options?.signal;
					await new Promise<void>((resolve) => {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
				}
				return completedResult({
					runId: request.runId,
					parentSessionId: request.parentSessionId,
					profile: request.profile.name,
					source: request.profile.source,
				});
			});
		try {
			const context = harness.context as ExtensionContext & { signal?: AbortSignal };
			const tool = harness.tools.get("delegate_async")!;
			const inspect = harness.tools.get("inspect_subagent_job")!;
			context.signal = parentSignals[0]!.signal;
			await harness.handlers.get("agent_start")!({ type: "agent_start" }, context);
			const first = await tool.execute(
				"parent-one",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Trace the first child.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				context,
			);
			await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, context);
			await vi.waitFor(async () => {
				const result = await inspect.execute(
					"inspect-one",
					{ jobId: first.details.accepted.jobId },
					undefined,
					undefined,
					context,
				);
				expect(result.details.inspection.job.status).toBe("completed");
			});

			context.signal = parentSignals[1]!.signal;
			await harness.handlers.get("agent_start")!({ type: "agent_start" }, context);
			const second = await tool.execute(
				"parent-two",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Trace the second child.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				context,
			);
			parentSignals[1]!.abort();
			await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, context);
			const secondInspection = await inspect.execute(
				"inspect-two",
				{ jobId: second.details.accepted.jobId },
				undefined,
				undefined,
				context,
			);
			expect(secondInspection.details.inspection.job.status).toBe("cancelled");
			expect(secondChildSignal?.aborted).toBe(true);

			context.signal = parentSignals[2]!.signal;
			await harness.handlers.get("agent_start")!({ type: "agent_start" }, context);
			const third = await tool.execute(
				"parent-three",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Trace the third child.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				context,
			);
			await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, context);
			await vi.waitFor(async () => {
				const result = await inspect.execute(
					"inspect-three",
					{ jobId: third.details.accepted.jobId },
					undefined,
					undefined,
					context,
				);
				expect(result.details.inspection.job.status).toBe("completed");
			});
			expect(harness.sent).toHaveLength(3);
		} finally {
			runResolved.mockRestore();
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("requires structured in-scope evidence before verification passes", async () => {
		const cwd = await createWorkspace();
		const normalized = normalizeSubagentRequest(
			{ ...request(cwd), outputSchema: { type: "object", additionalProperties: false } },
			cwd,
		);
		const base: SubagentResult = {
			runId: normalized.runId,
			parentSessionId: "parent-1",
			childSessionId: "child-verified",
			profile: "self",
			source: "self",
			status: "completed",
			summary: "Found the requested implementation fact.",
			output: {
				text: "Found the requested implementation fact.",
				textBytes: Buffer.byteLength("Found the requested implementation fact."),
				originalBytes: Buffer.byteLength("Found the requested implementation fact."),
				inlineTruncated: false,
				captureStatus: "inline_complete",
			},
			observedOutputBytes: Buffer.byteLength("Found the requested implementation fact."),
			partial: false,
			diagnostics: [],
			payload: {},
		};
		expect(verifySubagentResult(base, normalized)).toMatchObject({
			verified: false,
			reason: expect.stringMatching(/structured evidence/i),
		});
		expect(verifySubagentResult({ ...base, evidence: { paths: ["src"] } }, normalized)).toMatchObject({
			verified: true,
			paths: [join(cwd, "src")],
		});
		expect(verifySubagentResult({ ...base, evidence: { paths: [".."] } }, normalized)).toMatchObject({
			verified: false,
			reason: expect.stringContaining("outside approved scope"),
		});
	});
});

describe("ICE file/self delegation plan coverage", () => {
	it("wires the parent-owned MCP adapter through the native runner", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-mcp-runner-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "mcp-runner.md"),
			"---\nname: mcp-runner\ndescription: MCP runner\ntools: read\nmcp: [search/docs]\n---\nInspect.\n",
		);
		const normalized = normalizeSubagentRequest(
			{
				parentSessionId: "parent-1",
				role: "mcp-runner",
				task: "Inspect.",
				scope: { roots: ["src"] },
				cwd,
			},
			cwd,
			{ agentDir },
		);
		const model = testModel("faux", "faux");
		const dispatched = vi.fn(async () => ({ ok: true }));
		const adapter = {
			listAuthorizedTools: vi.fn(() => [{ selector: "search/docs", access: "read-only" as const }]),
			dispatch: dispatched,
		};
		const messages: AgentMessage[] = [];
		const session = {
			sessionId: "child-mcp-runner",
			model,
			messages,
			extensionRunner: createNoopExtensionRunner(),
			subscribe: vi.fn(() => vi.fn()),
			prompt: vi.fn(async () => {
				messages.push({
					role: "assistant",
					content: '{"summary":"MCP report","evidence":{"paths":["src"]}}',
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
		const runner = new NativeSubagentRunner({
			agentDir,
			mcpAdapter: adapter,
			createSession: async (options) => {
				const tool = options.customTools?.find(
					(candidate) => candidate.name === iceSubagentsModule.subagentMcpToolName("search/docs"),
				);
				expect(tool).toBeDefined();
				await tool!.execute("mcp-runner-tool", { q: "x" }, undefined, undefined, undefined as never);
				return { session } as CreateAgentSessionResult;
			},
		});
		const result = await runner.runResolved(normalized, ["delegate", "read"], { model });
		expect(result.status).toBe("completed");
		expect(adapter.listAuthorizedTools).toHaveBeenCalledOnce();
		expect(dispatched).toHaveBeenCalledOnce();
		expect(dispatched).toHaveBeenCalledWith("search", "docs", { q: "x" }, undefined);
	});
});
