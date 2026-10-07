import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import { ModelsError } from "@zykairotis/ice-ai";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { fauxAssistantMessage, registerFauxProvider } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { CreateAgentSessionResult } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { IceAgentViewBridge } from "../src/ice-agent-view-bridge.ts";
import type * as iceSubagentsModule from "../src/ice-subagents.ts";
import iceSubagents, {
	buildSubagentLaunchPreflight,
	buildSubagentPrompt,
	collectWriterPatchArtifact,
	createSubagentLaunchProvenance,
	createWriterWorkspace,
	formatSubagentLaunchDigest,
	integrateWriterPatchArtifact,
	NativeSubagentRunner,
	normalizeSubagentContextPacket,
	runResolvedSubagentBatch,
	runSubagentWithRecovery,
	type SubagentResult,
	validateWriterLaunchPreflight,
	verifySubagentResult,
	type WriterPatchVerificationContext,
} from "../src/ice-subagents.ts";
import {
	batchResult,
	createAsyncToolHarness,
	createFauxChildRuntime,
	createGitWorkspace,
	createNativeSubagentSession,
	createNoopExtensionRunner,
	createWorkspace,
	createWriterArtifact,
	git,
	normalizeSubagentRequest,
	registerScriptedUsageProvider,
	request,
	resolvedBatchTask,
	scriptedModelRuntime,
	settleManagedDelegate,
	tempDirs,
	testModel,
} from "./ice-subagents-harness.ts";

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ICE subagent contracts", () => {
	it("steers the parent away from single-child delegation of simple tasks", async () => {
		const harness = await createAsyncToolHarness();
		for (const toolName of ["delegate", "delegate_async"] as const) {
			const tool = harness.tools.get(toolName)!;
			expect(tool.description).toMatch(/never delegate a simple single task/i);
			expect(tool.description).toMatch(/at least two children/i);
			const guidelines = (tool.promptGuidelines ?? []).join("\n");
			expect(guidelines).toMatch(/simple single task/i);
			expect(guidelines).toMatch(/two or more children/i);
			expect(tool.description).not.toMatch(/user explicitly asks/i);
			expect(guidelines).not.toMatch(/user explicitly asks/i);
		}
		const batchExpectations = [
			["delegate_batch", /never wrap a single task in a batch/i, /two or more independent sibling tasks/i],
			["review_batch", /never run a single-reviewer batch/i, /two or more independent review dimensions/i],
		] as const;
		for (const [toolName, descriptionPattern, guidelinePattern] of batchExpectations) {
			const tool = harness.tools.get(toolName)!;
			expect(tool.description).toMatch(descriptionPattern);
			expect((tool.promptGuidelines ?? []).join("\n")).toMatch(guidelinePattern);
		}
	});

	it("explains wrong identifier domains without weakening lifecycle rejection", async () => {
		const harness = await createAsyncToolHarness();
		const manage = harness.tools.get("manage_subagent")!;
		const inspect = harness.tools.get("inspect_subagent_job")!;
		const managed = (await manage.execute(
			"wrong-run-domain",
			{ runId: "job:durable-1", action: "peek" } as never,
			undefined,
			undefined,
			harness.context,
		)) as { content?: Array<{ text?: string }>; isError?: boolean };
		expect(managed.isError).toBe(true);
		expect(managed.content?.[0]?.text).toMatch(/resultRef.*remove the `job:` prefix.*inspect_subagent_job/i);
		expect(managed.content?.[0]?.text).toMatch(/foreground runId.*batchId.*taskId/i);

		const inspected = (await inspect.execute(
			"wrong-job-domain",
			{ jobId: "job:durable-1" } as never,
			undefined,
			undefined,
			harness.context,
		)) as { content?: Array<{ text?: string }>; isError?: boolean };
		expect(inspected.isError).toBe(true);
		expect(inspected.content?.[0]?.text).toMatch(/resultRef.*not a jobId.*bare.*details\.accepted\.jobId/i);
		expect(inspected.content?.[0]?.text).toMatch(/foreground runId.*batchId.*taskId/i);
	});

	it("defines configurable subagent attachment and expansion actions", () => {
		const definitions = KEYBINDINGS as Record<string, { defaultKeys?: unknown; description?: string }>;
		expect(definitions["app.subagents.attach"]).toMatchObject({
			defaultKeys: "right",
			description: expect.stringContaining("Attach"),
		});
		expect(definitions["app.subagents.expand"]).toMatchObject({
			defaultKeys: "space",
			description: expect.stringContaining("Expand"),
		});
		const keybindings = new KeybindingsManager({
			"app.subagents.attach": "alt+a",
			"app.subagents.expand": "alt+e",
		});
		expect(keybindings.matches("\x1ba", "app.subagents.attach")).toBe(true);
		expect(keybindings.matches("\x1be", "app.subagents.expand")).toBe(true);
	});

	it("defines configurable normal-shell agent switching and takeover actions", () => {
		const definitions = KEYBINDINGS as Record<string, { defaultKeys?: unknown; description?: string }>;
		for (const action of [
			"app.subagents.open",
			"app.subagents.parent",
			"app.subagents.next",
			"app.subagents.previous",
			"app.subagents.takeControl",
		]) {
			expect(definitions[action]?.description).toBeTruthy();
		}
		const keybindings = new KeybindingsManager({
			"app.subagents.open": "alt+o",
			"app.subagents.parent": "alt+p",
			"app.subagents.next": "alt+n",
			"app.subagents.previous": "alt+b",
			"app.subagents.takeControl": "alt+t",
		});
		expect(keybindings.matches("\x1bo", "app.subagents.open")).toBe(true);
		expect(keybindings.matches("\x1bp", "app.subagents.parent")).toBe(true);
		expect(keybindings.matches("\x1bn", "app.subagents.next")).toBe(true);
		expect(keybindings.matches("\x1bb", "app.subagents.previous")).toBe(true);
		expect(keybindings.matches("\x1bt", "app.subagents.takeControl")).toBe(true);
	});

	it("rejects duplicate, oversized, aggregate, and Unicode-over-budget packet items", async () => {
		expect(() =>
			normalizeSubagentContextPacket({
				items: [{ id: "bad id", kind: "parent_note", content: "invalid" }],
			}),
		).toThrowError(/ID/i);
		expect(() =>
			normalizeSubagentContextPacket({
				items: [
					{ id: "same", kind: "parent_note", content: "one" },
					{ id: "same", kind: "verified_fact", content: "two" },
				],
			}),
		).toThrowError(/unique/i);
		expect(() =>
			normalizeSubagentContextPacket({
				items: [{ id: "large", kind: "parent_note", content: "x".repeat(32 * 1024 + 1) }],
			}),
		).toThrowError(/item/i);
		expect(() =>
			normalizeSubagentContextPacket({
				items: Array.from({ length: 9 }, (_, index) => ({
					id: `item-${index}`,
					kind: "parent_note" as const,
					content: "x".repeat(30 * 1024),
				})),
			}),
		).toThrowError(/aggregate/i);
		expect(() =>
			normalizeSubagentContextPacket({
				items: [{ id: "unicode", kind: "parent_note", content: "😀".repeat(8193) }],
			}),
		).toThrowError(/item/i);
	});

	it("does not expose packet content in the launch digest", async () => {
		const cwd = await createWorkspace();
		const normalized = normalizeSubagentRequest(
			{
				...request(cwd),
				contextPacket: { items: [{ id: "fact", kind: "verified_fact", content: "private packet body" }] },
			},
			cwd,
		);
		const preflight = buildSubagentLaunchPreflight([{ id: "packet", request: normalized }], ["read"]);
		const digest = formatSubagentLaunchDigest(preflight);
		expect(preflight.tasks[0]?.contextPacket).toMatchObject({
			itemCount: 1,
			totalBytes: Buffer.byteLength("private packet body"),
		});
		expect(digest).not.toContain("private packet body");
	});

	it("does not rediscover a resolved launch contract", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		const rolePath = join(agentDir, "agents", "security-review.md");
		await writeFile(rolePath, "---\nname: security-review\ndescription: User security review\n---\nOriginal.\n");
		const normalized = normalizeSubagentRequest(request(cwd, "security-review"), cwd, { agentDir });
		await writeFile(rolePath, "---\nname: security-review\ndescription: Changed security review\n---\nChanged.\n");
		const createSession = vi.fn();
		const result = await new NativeSubagentRunner({ agentDir, createSession }).runResolved(normalized, [
			"delegate",
			"read",
		]);
		expect(result).toMatchObject({
			status: "failed",
			source: "user",
			diagnostics: [{ code: "untrusted_profile" }],
		});
		expect(createSession).not.toHaveBeenCalled();
	});

	it("normalizes exact-file targets and carries them through the read-only launch contract", async () => {
		const cwd = await createWorkspace();
		const targetPath = join(cwd, "src", "target.ts");
		await writeFile(targetPath, "target\n");
		const normalized = normalizeSubagentRequest(
			{
				...request(cwd),
				scope: { roots: ["src"], targets: ["src/target.ts", "src/./target.ts"] },
			},
			cwd,
		);
		const task = { id: "targeted", request: normalized };
		const preflight = buildSubagentLaunchPreflight([task], ["delegate", "read"]);
		const provenance = createSubagentLaunchProvenance(normalized);
		const prompt = buildSubagentPrompt(normalized);

		expect(normalized.scope.targets).toEqual([targetPath]);
		expect(provenance.scopeTargets).toEqual([targetPath]);
		expect(preflight.tasks[0]?.cwd).toBe(cwd);
		expect(preflight.tasks[0]?.scopeTargets).toEqual([targetPath]);
		const digest = formatSubagentLaunchDigest(preflight);
		expect(digest).toContain("targets: src/target.ts");
		expect(digest).not.toContain(targetPath);
		expect(prompt).toContain("Requested primary targets:");
		expect(prompt).toContain("src/target.ts");

		const result = await runResolvedSubagentBatch([task], ["delegate", "read"], {
			runResolved: async () => batchResult(task),
		});
		expect(result.items[0]?.launch.scopeTargets).toEqual([targetPath]);
		expect(result.items[0]?.result.scopeTargets).toEqual([targetPath]);
	});

	it("rejects tracked, staged, and untracked parent changes", async () => {
		const tracked = await createGitWorkspace();
		await writeFile(join(tracked.cwd, "src", "file.ts"), "tracked\n");
		await expect(validateWriterLaunchPreflight(tracked.cwd, tracked.head)).rejects.toThrow(/clean/i);

		const staged = await createGitWorkspace();
		await writeFile(join(staged.cwd, "src", "file.ts"), "staged\n");
		await git(staged.cwd, "add", "src/file.ts");
		await expect(validateWriterLaunchPreflight(staged.cwd, staged.head)).rejects.toThrow(/clean/i);

		const untracked = await createGitWorkspace();
		await writeFile(join(untracked.cwd, "new.txt"), "untracked\n");
		await expect(validateWriterLaunchPreflight(untracked.cwd, untracked.head)).rejects.toThrow(/clean/i);
	});

	it("restores the exact proposed bytes when parent verification fails", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const artifact = await createWriterArtifact(cwd, head, artifactRoot, "src/file.ts", "changed\n");
		const verifier = vi.fn(async () => {
			throw new Error("parent verification failed");
		});

		await expect(
			integrateWriterPatchArtifact(artifact, { cwd, scopeRoots: ["src"], verify: verifier }),
		).rejects.toThrow(/parent verification failed/i);
		expect(verifier).toHaveBeenCalledOnce();
		expect(await readFile(join(cwd, "src", "file.ts"), "utf8")).toBe("base\n");
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");
	});

	it("rejects verifier mutation of a touched file and preserves the newer bytes", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const artifact = await createWriterArtifact(cwd, head, artifactRoot, "src/file.ts", "changed\n");
		const verifier = vi.fn(async ({ parentRoot }: WriterPatchVerificationContext) => {
			await writeFile(join(parentRoot, "src", "file.ts"), "newer\n");
		});

		await expect(
			integrateWriterPatchArtifact(artifact, { cwd, scopeRoots: ["src"], verify: verifier }),
		).rejects.toThrow(/conflict|rollback/i);
		expect(await readFile(join(cwd, "src", "file.ts"), "utf8")).toBe("newer\n");
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe(" M src/file.ts\n");
	});

	it("does not overwrite a touched-file change when verifier failure races rollback", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const artifact = await createWriterArtifact(cwd, head, artifactRoot, "src/file.ts", "changed\n");
		const verifier = vi.fn(async ({ parentRoot }: WriterPatchVerificationContext) => {
			await writeFile(join(parentRoot, "src", "file.ts"), "newer\n");
			throw new Error("parent verification failed");
		});

		await expect(
			integrateWriterPatchArtifact(artifact, { cwd, scopeRoots: ["src"], verify: verifier }),
		).rejects.toThrow(/rollback conflict/i);
		expect(await readFile(join(cwd, "src", "file.ts"), "utf8")).toBe("newer\n");
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe(" M src/file.ts\n");
	});

	it("rolls back safe files when another touched file has a rollback conflict", async () => {
		const { cwd } = await createGitWorkspace();
		await writeFile(join(cwd, "src", "second.ts"), "base-second\n");
		await git(cwd, "add", "src/second.ts");
		await git(cwd, "commit", "-m", "add second writer file");
		const head = (await git(cwd, "rev-parse", "HEAD")).trim();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const workspace = await createWriterWorkspace(cwd, head);
		let artifact: NonNullable<ReturnType<typeof collectWriterPatchArtifact>> | undefined;
		try {
			await writeFile(join(workspace.root, "src", "file.ts"), "changed-first\n");
			await writeFile(join(workspace.root, "src", "second.ts"), "changed-second\n");
			artifact = collectWriterPatchArtifact(
				workspace,
				{ runId: "artifact-multi-file-rollback", status: "completed", baseCommit: head },
				{ scopeRoots: [join(workspace.root, "src")], artifactRoot },
			);
		} finally {
			await workspace.cleanup();
		}
		if (!artifact) throw new Error("writer artifact was not collected");
		const verifier = vi.fn(async ({ parentRoot }: WriterPatchVerificationContext) => {
			await writeFile(join(parentRoot, "src", "file.ts"), "newer-first\n");
			throw new Error("parent verification failed");
		});

		await expect(
			integrateWriterPatchArtifact(artifact, { cwd, scopeRoots: ["src"], verify: verifier }),
		).rejects.toThrow(/rollback conflict/i);
		expect(await readFile(join(cwd, "src", "file.ts"), "utf8")).toBe("newer-first\n");
		expect(await readFile(join(cwd, "src", "second.ts"), "utf8")).toBe("base-second\n");
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe(" M src/file.ts\n");
	});

	it("preserves an unrelated parent change when verifier failure triggers rollback", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const artifact = await createWriterArtifact(cwd, head, artifactRoot, "src/file.ts", "changed\n");
		const verifier = vi.fn(async ({ parentRoot }: WriterPatchVerificationContext) => {
			await writeFile(join(parentRoot, "src", "unrelated.ts"), "keep\n");
			throw new Error("parent verification failed");
		});

		await expect(
			integrateWriterPatchArtifact(artifact, { cwd, scopeRoots: ["src"], verify: verifier }),
		).rejects.toThrow(/parent verification failed/i);
		expect(await readFile(join(cwd, "src", "file.ts"), "utf8")).toBe("base\n");
		expect(await readFile(join(cwd, "src", "unrelated.ts"), "utf8")).toBe("keep\n");
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("?? src/unrelated.ts\n");
	});

	it("does not execute configured Git clean filters while collecting", async () => {
		const { cwd } = await createGitWorkspace();
		const filterRoot = await mkdtemp(join(tmpdir(), "ice-writer-filter-"));
		tempDirs.push(filterRoot);
		const marker = join(filterRoot, "executed");
		const filter = join(filterRoot, "clean-filter.sh");
		await writeFile(filter, `#!/bin/sh\nprintf executed > '${marker}'\ncat\n`, { mode: 0o755 });
		await git(cwd, "config", "filter.ice-test.clean", `${filter} %f`);
		await writeFile(join(cwd, ".gitattributes"), "src/filtered.txt filter=ice-test\n");
		await git(cwd, "add", ".gitattributes");
		await git(cwd, "commit", "-m", "configure clean filter");
		const head = (await git(cwd, "rev-parse", "HEAD")).trim();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const workspace = await createWriterWorkspace(cwd, head);
		try {
			await expect(stat(marker)).rejects.toThrow();
			await writeFile(join(workspace.root, "src", "filtered.txt"), "filter input\n");
			await expect(stat(marker)).rejects.toThrow();
			const artifact = collectWriterPatchArtifact(
				workspace,
				{ runId: "clean-filter-isolation", status: "completed", baseCommit: head },
				{ scopeRoots: [join(workspace.root, "src")], artifactRoot },
			);
			expect(artifact).toBeDefined();
			await expect(stat(marker)).rejects.toThrow();
		} finally {
			await workspace.cleanup();
		}
	});

	it("collects proposals only for completed text add/modify changes", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const workspace = await createWriterWorkspace(cwd, head);
		try {
			expect(
				collectWriterPatchArtifact(
					workspace,
					{ runId: "failed-run", status: "failed", baseCommit: head },
					{ scopeRoots: [join(workspace.root, "src")], artifactRoot },
				),
			).toBeUndefined();
			await writeFile(join(workspace.root, "src", "binary.bin"), Buffer.from([0, 1, 2]));
			expect(() =>
				collectWriterPatchArtifact(
					workspace,
					{ runId: "binary-run", status: "completed", baseCommit: head },
					{ scopeRoots: [join(workspace.root, "src")], artifactRoot },
				),
			).toThrow(/text|UTF-8/i);
			await rm(join(workspace.root, "src", "binary.bin"));
			await rm(join(workspace.root, "src", "file.ts"));
			expect(() =>
				collectWriterPatchArtifact(
					workspace,
					{ runId: "delete-run", status: "completed", baseCommit: head },
					{ scopeRoots: [join(workspace.root, "src")], artifactRoot },
				),
			).toThrow(/deletion/i);
		} finally {
			await workspace.cleanup();
		}
	});

	it.each([
		["immediate provider failure", 0],
		["provider failure before the deadline", 10],
	] as const)("keeps %s as a failed run, not a timeout", async (_label, delayMs) => {
		const cwd = await createWorkspace();
		const normalized = normalizeSubagentRequest({ ...request(cwd), timeoutMs: 100 }, cwd);
		const providerError = new Error("provider stream failed");
		const fakeSession = {
			sessionId: `child-provider-error-${delayMs}`,
			model: {} as Model<Api>,
			messages: [],
			extensionRunner: createNoopExtensionRunner(),
			subscribe: vi.fn(() => vi.fn()),
			prompt: vi.fn(async () => {
				if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
				throw providerError;
			}),
			abort: vi.fn(async () => {}),
			dispose: vi.fn(),
			getSessionStats: vi.fn(() => ({
				tokens: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0 },
				cost: 0.25,
			})),
		} as unknown as CreateAgentSessionResult["session"];
		const result = await new NativeSubagentRunner({
			createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"]);

		expect(result).toMatchObject({
			status: "failed",
			diagnostics: [{ code: "child_runtime_failure", message: "provider stream failed" }],
		});
		expect(result.status).not.toBe("timed_out");
	});

	it("completes through a real native child with the faux provider", async () => {
		const cwd = await createWorkspace();
		const faux = registerFauxProvider();
		try {
			// Plain final-turn mode: a single scripted assistant turn is ingested
			// directly. If the runtime issued an extra finalization request, the
			// exhausted faux queue would fail the run instead.
			faux.setResponses([
				fauxAssistantMessage("The runtime loads the generated provider catalog and selects the requested model."),
			]);
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
			const normalized = normalizeSubagentRequest(request(cwd), cwd);
			const child = await createNativeSubagentSession({
				request: normalized,
				parentActiveTools: ["delegate", "read"],
				model,
				modelRuntime,
				agentDir: cwd,
			});
			expect(child.session.getActiveToolNames()).toEqual(["read"]);
			await expect(
				child.session
					.getToolDefinition("read")!
					.execute(
						"read-outside-native",
						{ path: join(cwd, "package.json") },
						undefined,
						undefined,
						undefined as unknown as ExtensionContext,
					),
			).rejects.toThrow(/outside the approved subagent scope/);
			child.session.dispose();
			const result = await new NativeSubagentRunner({ agentDir: cwd }).runResolved(
				normalized,
				["delegate", "read"],
				{
					model,
					modelRuntime,
				},
			);
			expect(result).toMatchObject({
				status: "completed",
				summary: "The runtime loads the generated provider catalog and selects the requested model.",
				reportMode: "plain_final_turn",
				observedTurns: 1,
			});
			// Plain mode verifies lineage and output bounds only; evidence claims are
			// never asserted for an unstructured final answer.
			expect(verifySubagentResult(result, normalized)).toMatchObject({
				verified: true,
				paths: [],
			});
			// Runtime-owned touched-path/work-artifact telemetry is preserved on the
			// result, but the "plain" protocol status keeps it out of evidence rows.
			expect(result.workArtifact).toMatchObject({
				runId: normalized.runId,
				reportProtocol: { status: "plain" },
				touchedPaths: [],
			});
			expect(result.workArtifact?.finishedAtMs).toBeDefined();
		} finally {
			faux.unregister();
		}
	});
	it("converts an accidental plain JSON envelope into readable parent text", async () => {
		const harness = await createAsyncToolHarness();
		try {
			harness.faux.setResponses([
				fauxAssistantMessage(
					'{"summary":"The concurrency headroom document was created and explains configuration and precedence.","evidence":{"paths":["src/ice-subagent-concurrency.ts"]}}',
				),
			]);
			const result = await settleManagedDelegate(
				harness.tools,
				harness.context,
				await harness.tools.get("delegate")!.execute(
					"plain-json-fallback",
					{
						role: "self",
						self: { instructions: "Inspect the approved scope.", capabilities: ["read"] },
						task: "Inspect the concurrency implementation.",
						scope: { roots: ["src"] },
					},
					undefined,
					undefined,
					harness.context,
				),
			);
			const text = result.content[0]?.text ?? "";
			expect(result).toMatchObject({ isError: false });
			expect(text).toContain("The concurrency headroom document was created");
			expect(text).toContain("Reported paths (not independently verified):");
			expect(text).toContain("- src/ice-subagent-concurrency.ts");
			expect(text).not.toContain('{"summary"');
			expect((result.details as { result: SubagentResult }).result.summary).not.toContain('{"summary"');
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("keeps repeated native child compactions bounded and reconstructible", async () => {
		const cwd = await createWorkspace();
		const agentDir = join(cwd, ".ice-agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				compaction: {
					thresholdPercent: 1,
					keepRecentTokens: 1,
					reserveTokens: 128,
					midRunCompaction: "resume",
				},
			}),
		);
		const faux = registerFauxProvider();
		try {
			const { model, modelRuntime } = await createFauxChildRuntime(cwd, faux);
			faux.setResponses([
				fauxAssistantMessage("first child response"),
				fauxAssistantMessage("threshold summary one"),
				() => fauxAssistantMessage("second child response"),
				() => fauxAssistantMessage("threshold history two"),
				() => fauxAssistantMessage("threshold turn prefix two"),
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
				await child.session.prompt(`${child.prompt}\nfirst context ${"x".repeat(8_000)}`, {
					expandPromptTemplates: false,
					source: "extension",
				});
				await new Promise((resolve) => setTimeout(resolve, 5));
				await child.session.prompt(`${child.prompt}\nsecond context ${"y".repeat(8_000)}`, {
					expandPromptTemplates: false,
					source: "extension",
				});
				const compactionEntries = child.session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "compaction");
				const context = child.session.sessionManager.buildSessionContext();
				expect(compactionEntries).toHaveLength(2);
				expect(compactionEntries[0]?.type === "compaction" ? compactionEntries[0].summary : "").toContain(
					"threshold summary one",
				);
				expect(compactionEntries[1]?.type === "compaction" ? compactionEntries[1].summary : "").toContain(
					"threshold history two",
				);
				expect(compactionEntries[1]?.type === "compaction" ? compactionEntries[1].summary : "").toContain(
					"threshold turn prefix two",
				);
				expect(events.filter((event) => event.type === "compaction_start")).toHaveLength(2);
				expect(events.filter((event) => event.type === "compaction_end")).toHaveLength(2);
				expect(context.messages.filter((message) => message.role === "compactionSummary")).toHaveLength(1);
				expect(JSON.stringify(context)).toContain("threshold history two");
				expect(JSON.stringify(context)).toContain("threshold turn prefix two");
				expect(faux.state.callCount).toBe(5);
			} finally {
				unsubscribe();
				child.session.dispose();
			}
		} finally {
			faux.unregister();
		}
	});

	it("surfaces an exhausted core retry as a failed retry state", async () => {
		const cwd = await createWorkspace();
		const scripted = registerScriptedUsageProvider(
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error_final" }),
			],
			{ api: "anthropic-messages" },
		);
		const settingsManager = SettingsManager.inMemory();
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
		const events: iceSubagentsModule.SubagentEvent[] = [];
		const bridge = new IceAgentViewBridge();
		try {
			const modelRuntime = await scriptedModelRuntime(cwd, scripted.model);
			const normalized = normalizeSubagentRequest(request(cwd), cwd);
			const result = await new NativeSubagentRunner({ agentDir: cwd, agentViewBridge: bridge }).runResolved(
				normalized,
				["delegate", "read"],
				{
					model: scripted.model,
					modelRuntime,
					settingsManager,
					onEvent: (event) => events.push(event),
				},
			);

			expect(result.status).toBe("failed");
			expect(scripted.consumed()).toBe(2);
			const retryEvents = events.filter((event) => event.type === "subagent_retry");
			expect(retryEvents.map((event) => event.retry?.state)).toEqual(["scheduled", "failed"]);
			expect(retryEvents.at(-1)?.retry?.diagnostic).toContain("overloaded_error_final");
			expect(bridge.getView(normalized.runId)?.presentation?.retry).toMatchObject({
				state: "failed",
				attempt: 1,
				maxAttempts: 1,
			});
		} finally {
			scripted.unregister();
		}
	});

	it("enters one-shot wrap-up before the wall-clock timeout", async () => {
		const cwd = await createWorkspace();
		const normalized = normalizeSubagentRequest({ ...request(cwd), timeoutMs: 1 }, cwd);
		const messages: AgentMessage[] = [];
		const promptCalls: string[] = [];
		let notify: ((event: AgentSessionEvent) => void) | undefined;
		const shouldStopAfterTurn = vi.fn(async () => false);
		const agent = {
			shouldStopAfterTurn,
		};
		const fakeSession = {
			sessionId: "child-wrap-up",
			model: testModel("faux", "faux"),
			messages,
			agent,
			extensionRunner: createNoopExtensionRunner(),
			subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
				notify = listener;
				return vi.fn();
			}),
			prompt: vi.fn(async (prompt: string) => {
				promptCalls.push(prompt);
				notify?.({ type: "turn_start" } as AgentSessionEvent);
				messages.push({
					role: "assistant",
					content:
						promptCalls.length === 1
							? "work completed; prepare the final report"
							: '{"summary":"wrapped up","evidence":{"paths":["src"]}}',
					stopReason: "stop",
				} as unknown as AgentMessage);
				notify?.({ type: "message_update" } as AgentSessionEvent);
				notify?.({ type: "turn_end" } as AgentSessionEvent);
				await agent.shouldStopAfterTurn();
			}),
			setActiveToolsByName: vi.fn(),
			getActiveToolNames: vi.fn(() => ["read"]),
			abort: vi.fn(async () => {}),
			dispose: vi.fn(),
			getSessionStats: vi.fn(() => ({
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
			})),
		} as unknown as CreateAgentSessionResult["session"];
		const events: iceSubagentsModule.SubagentEvent[] = [];
		const result = await new NativeSubagentRunner({
			createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
		}).runResolved(normalized, ["delegate", "read"], { onEvent: (event) => events.push(event) });

		expect(result.status).toBe("completed");
		expect(result.observedTurns).toBe(2);
		expect(promptCalls).toHaveLength(2);
		expect(promptCalls[1]).toContain("ICE VOID SUBAGENT WRAP UP");
		expect(promptCalls[1]).toContain("active final-output contract");
		expect(promptCalls[1]).not.toContain("JSON");
		expect(events.filter((event) => event.type === "subagent_wrap_up")).toHaveLength(1);
		expect(shouldStopAfterTurn).toHaveBeenCalledTimes(2);
	});

	it("fails closed when parent delegation is not active", async () => {
		const cwd = await createWorkspace();
		const createSession = vi.fn();
		const runner = new NativeSubagentRunner({ createSession });
		const result = await runner.run(request(cwd), ["read"]);
		expect(result.status).toBe("failed");
		expect(result.diagnostics[0]?.code).toBe("capability_denied");
		expect(createSession).not.toHaveBeenCalled();
	});

	it("returns a typed startup failure when child session startup never settles", async () => {
		const cwd = await createWorkspace();
		const normalized = normalizeSubagentRequest({ ...request(cwd), timeoutMs: 5 }, cwd);
		const result = await Promise.race([
			new NativeSubagentRunner({ createSession: async () => new Promise<never>(() => {}) }).runResolved(normalized, [
				"delegate",
				"read",
			]),
			new Promise<SubagentResult>((_, reject) =>
				setTimeout(() => reject(new Error("child startup timeout was not enforced")), 100),
			),
		]);
		expect(result).toMatchObject({ status: "failed", diagnostics: [{ code: "timeout" }] });
	});

	it("orderly shuts down a reader that finishes startup after the startup deadline", async () => {
		const cwd = await createWorkspace();
		const normalized = normalizeSubagentRequest({ ...request(cwd), timeoutMs: 5 }, cwd);
		let resolveStartup: ((value: CreateAgentSessionResult) => void) | undefined;
		const startup = new Promise<CreateAgentSessionResult>((resolve) => {
			resolveStartup = resolve;
		});
		const lifecycle: string[] = [];
		const shutdown = vi.fn(async () => lifecycle.push("shutdown"));
		const fakeSession = {
			sessionId: "child-late-reader",
			model: {} as Model<Api>,
			messages: [],
			abort: vi.fn(async () => lifecycle.push("abort")),
			dispose: vi.fn(() => lifecycle.push("dispose")),
			extensionRunner: {
				hasHandlers: vi.fn((eventType: string) => eventType === "session_shutdown"),
				emit: shutdown,
			},
		} as unknown as CreateAgentSessionResult["session"];
		const result = await new NativeSubagentRunner({
			createSession: async () => startup,
		}).runResolved(normalized, ["delegate", "read"]);
		expect(result).toMatchObject({ status: "failed", diagnostics: [{ code: "timeout" }] });
		resolveStartup?.({ session: fakeSession } as CreateAgentSessionResult);
		await vi.waitFor(() => expect(fakeSession.dispose).toHaveBeenCalledOnce());
		expect(shutdown).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
		expect(lifecycle).toEqual(["abort", "shutdown", "dispose"]);
	});

	it("admits a retry only after reconciling the first attempt", async () => {
		const cwd = await createWorkspace();
		const task = resolvedBatchTask(cwd, "budget-retry");
		const attemptBytes = 8 * 1024;
		let calls = 0;
		const result = await runResolvedSubagentBatch(
			[task],
			["delegate", "read"],
			{
				runResolved: async () => {
					calls++;
					return {
						...batchResult(task, calls === 1 ? "failed" : "completed"),
						...(calls === 1
							? { childSessionId: undefined, partial: false, retrySafeStartup: true, observedTurns: 0 }
							: {}),
						observedOutputBytes: attemptBytes,
						diagnostics:
							calls === 1
								? [{ code: "child_startup_failure" as const, message: "temporary", retryable: true }]
								: [],
					};
				},
			},
			{},
		);
		expect(calls).toBe(2);
		expect(result.items[0]?.verification.verified).toBe(true);
		expect(result.items[0]?.result.observedOutputBytes).toBe(attemptBytes);
		expect(result.items[0]?.result.recovery?.totalObservedOutputBytes).toBe(attemptBytes * 2);
		expect(result.preflight).not.toHaveProperty("budget");
	});

	it("does not retry an untyped failure even when its message sounds transient", async () => {
		const cwd = await createWorkspace();
		const task = resolvedBatchTask(cwd, "terminal");
		let attempts = 0;
		const result = await runSubagentWithRecovery(task.request, ["delegate", "read"], () => {
			attempts++;
			return Promise.resolve({
				...batchResult(task, "failed", "transient provider failure"),
				diagnostics: [{ code: "child_runtime_failure" as const, message: "transient provider failure" }],
			});
		});
		expect(attempts).toBe(1);
		expect(result.recovery).toMatchObject({ attemptCount: 1, retried: false });
	});

	it("defers fail-fast until a logical task exhausts recovery", async () => {
		const cwd = await createWorkspace();
		const tasks = ["retry", "next"].map((id) => resolvedBatchTask(cwd, id));
		const attempts = new Map<string, number>();
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (task) => {
				const resolvedTask = tasks.find((candidate) => candidate.request.runId === task.runId)!;
				const attempt = (attempts.get(resolvedTask.id) ?? 0) + 1;
				attempts.set(resolvedTask.id, attempt);
				if (resolvedTask.id === "retry" && attempt === 1) {
					return {
						...batchResult(resolvedTask, "failed", "temporary"),
						childSessionId: undefined,
						partial: false,
						retrySafeStartup: true,
						observedTurns: 0,
						diagnostics: [{ code: "child_startup_failure" as const, message: "temporary", retryable: true }],
					};
				}
				return batchResult(resolvedTask);
			},
		};
		const result = await runResolvedSubagentBatch(tasks, ["delegate", "read"], runner, {
			concurrency: 1,
			failFast: true,
		});
		expect(attempts).toEqual(
			new Map([
				["retry", 2],
				["next", 1],
			]),
		);
		expect(result.status).toBe("completed");
		expect(result.items.every((item) => item.result.status === "completed")).toBe(true);
	});

	it("marks only typed provider stream failures as retryable", async () => {
		const cwd = await createWorkspace();
		const transient = await new NativeSubagentRunner({
			createSession: async () => {
				throw new ModelsError("stream", "temporary provider failure");
			},
		}).run(request(cwd), ["delegate", "read"]);
		const untyped = await new NativeSubagentRunner({
			createSession: async () => {
				throw new Error("temporary provider failure");
			},
		}).run(request(cwd), ["delegate", "read"]);
		const auth = await new NativeSubagentRunner({
			createSession: async () => {
				throw new ModelsError("auth", "authentication failed");
			},
		}).run(request(cwd), ["delegate", "read"]);
		expect(transient.diagnostics[0]).toMatchObject({ code: "child_startup_failure", retryable: true });
		expect(untyped.diagnostics[0]).toMatchObject({ code: "child_startup_failure" });
		expect(untyped.diagnostics[0]?.retryable).toBeUndefined();
		expect(auth.diagnostics[0]).toMatchObject({ code: "auth_missing" });
		expect(auth.diagnostics[0]?.retryable).toBeUndefined();
	});

	it("rejects the removed aggregate token budget before launching tasks", async () => {
		const cwd = await createWorkspace();
		const task = resolvedBatchTask(cwd, "removed-token-budget");
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: vi.fn(async () => batchResult(task)),
		};
		const removedOption = { totalTokenBudget: 60_000 } as unknown as Parameters<typeof runResolvedSubagentBatch>[3];
		await expect(runResolvedSubagentBatch([task], ["delegate", "read"], runner, removedOption)).rejects.toThrow(
			/totalTokenBudget.*removed/i,
		);
		expect(runner.runResolved).not.toHaveBeenCalled();
	});

	it("registers delegate through the ICE extension factory", async () => {
		const registerTool = vi.fn();
		iceSubagents({ on: vi.fn(), registerTool } as unknown as ExtensionAPI);
		expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "delegate" }));
		expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "delegate_batch" }));
		const writer = registerTool.mock.calls.find((call) => call[0]?.name === "delegate_write")?.[0];
		expect(writer).toMatchObject({ name: "delegate_write" });
		expect(writer.parameters).toMatchObject({
			properties: {
				baseCommit: { type: "string", minLength: 40, maxLength: 40 },
				task: { type: "string" },
				scope: { type: "object" },
			},
		});
	});
});
