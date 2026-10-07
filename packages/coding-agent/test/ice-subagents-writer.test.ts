import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import * as iceSubagentsModule from "../src/ice-subagents.ts";
import iceSubagents, {
	collectWriterPatchArtifact,
	createNativeWriterSession,
	createScopedWriterToolDefinitions,
	createWriterWorkspace,
	deriveWriterTools,
	inspectWriterPatchArtifact,
	integrateWriterPatchArtifact,
	NativeWriterRunner,
	normalizeWriterRequest,
	resolveSubagentProfileResolution,
	validateWriterLaunchPreflight,
	type WriterPatchVerificationContext,
	type WriterResult,
} from "../src/ice-subagents.ts";
import { getProgressSnapshot } from "../src/subagents/ui/observatory.ts";
import {
	createAsyncToolHarness,
	createGitWorkspace,
	createNativeSubagentSession,
	createNoopExtensionRunner,
	createWorkspace,
	createWriterArtifact,
	execFileAsync,
	git,
	normalizeSubagentRequest,
	request,
	tempDirs,
	testModel,
	writerRequest,
} from "./ice-subagents-harness.ts";

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ICE subagent contracts", () => {
	it("accepts isolated writers after preflight and exposes their retained result through manage_subagent", async () => {
		const workspace = await createGitWorkspace();
		const harness = await createAsyncToolHarness({
			activeTools: ["delegate_write", "read", "write", "edit", "grep", "find", "ls"],
		});
		const previousAgentDir = process.env.ICE_CODING_AGENT_DIR;
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagent-writer-agent-"));
		tempDirs.push(agentDir);
		process.env.ICE_CODING_AGENT_DIR = agentDir;
		(harness.context as unknown as { cwd: string }).cwd = workspace.cwd;
		const delegateWrite = harness.tools.get("delegate_write")!;
		const manage = harness.tools.get("manage_subagent")!;
		let shutdown = false;
		try {
			harness.faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						"write",
						{ path: "src/file.ts", content: "writer change\n" },
						{ id: "writer-output-write" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Writer completed. ".repeat(2_900)),
			]);
			const accepted = await delegateWrite.execute(
				"writer-background",
				{
					task: "Inspect the scoped source and report completion.",
					baseCommit: workspace.head,
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			expect(accepted).toMatchObject({
				isError: false,
				details: {
					accepted: { runId: expect.any(String), baseCommit: workspace.head, workspaceIsolation: "worktree" },
				},
			});
			const runId = accepted.details.accepted.runId as string;
			let writerResult: WriterResult | undefined;
			await vi.waitFor(
				async () => {
					const inspection = await manage.execute(
						"writer-inspect-terminal",
						{ runId, action: "inspect" },
						undefined,
						undefined,
						harness.context,
					);
					const writer = inspection.details.writer as { result?: WriterResult };
					writerResult = writer.result;
					expect(writer).toMatchObject({
						state: "completed",
						result: { status: "completed", workspaceIsolation: "worktree", workspaceRemoved: true },
					});
				},
				{ timeout: 5_000, interval: 10 },
			);
			const outputArtifactId = writerResult?.output?.artifact?.id;
			const patchRef = writerResult?.patchArtifact?.patchRef;
			if (!outputArtifactId || !patchRef) throw new Error("Expected independent writer output and patch artifacts.");
			const readOutput = harness.tools.get("read_subagent_output")!;
			expect(
				await readOutput.execute(
					"writer-output-before-shutdown",
					{ artifactId: outputArtifactId, length: 8 },
					undefined,
					undefined,
					harness.context,
				),
			).toMatchObject({ isError: false });

			const rejected = await delegateWrite.execute(
				"writer-preflight-rejected",
				{ task: "Must not be admitted.", baseCommit: "0".repeat(40), scope: { roots: ["src"] } },
				undefined,
				undefined,
				harness.context,
			);
			expect(rejected).toMatchObject({ isError: true, details: { result: { status: "failed" } } });
			expect(rejected.details).not.toHaveProperty("accepted");
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			shutdown = true;
			const releasedOutput = await readOutput.execute(
				"writer-output-after-shutdown",
				{ artifactId: outputArtifactId, length: 8 },
				undefined,
				undefined,
				harness.context,
			);
			expect(releasedOutput).toMatchObject({
				isError: true,
				details: { error: { code: "artifact_storage_failure" } },
			});
			expect(await readFile(patchRef, "utf8")).toContain("writer change");
		} finally {
			if (!shutdown)
				await harness.handlers.get("session_shutdown")!(
					{ type: "session_shutdown", reason: "quit" },
					harness.context,
				);
			harness.faux.unregister();
			if (previousAgentDir === undefined) delete process.env.ICE_CODING_AGENT_DIR;
			else process.env.ICE_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("evicts writer text output without deleting its independent patch artifact", async () => {
		const workspace = await createGitWorkspace();
		const harness = await createAsyncToolHarness({
			activeTools: ["delegate_write", "read", "write", "edit", "grep", "find", "ls"],
		});
		const previousAgentDir = process.env.ICE_CODING_AGENT_DIR;
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagent-writer-retention-agent-"));
		tempDirs.push(agentDir);
		process.env.ICE_CODING_AGENT_DIR = agentDir;
		(harness.context as unknown as { cwd: string }).cwd = workspace.cwd;
		const delegateWrite = harness.tools.get("delegate_write")!;
		const manage = harness.tools.get("manage_subagent")!;
		const readOutput = harness.tools.get("read_subagent_output")!;
		harness.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", { path: "src/file.ts", content: "writer patch\n" }, { id: "writer-retention-write" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Writer output retained. ".repeat(2_100)),
			...Array.from({ length: 16 }, () => fauxAssistantMessage("No patch required.")),
		]);
		const launchAndWait = async (index: number) => {
			const accepted = await delegateWrite.execute(
				`writer-retention-launch-${index}`,
				{
					task: "Inspect the scoped source and report completion.",
					baseCommit: workspace.head,
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			expect(accepted.isError).toBe(false);
			const runId = accepted.details.accepted.runId as string;
			let result: WriterResult | undefined;
			await vi.waitFor(
				async () => {
					const inspection = await manage.execute(
						`writer-retention-inspect-${index}`,
						{ runId, action: "inspect" },
						undefined,
						undefined,
						harness.context,
					);
					result = (inspection.details.writer as { result?: WriterResult }).result;
					expect(result?.status).toBe("completed");
				},
				{ timeout: 5_000, interval: 10 },
			);
			return result!;
		};

		try {
			const first = await launchAndWait(0);
			const outputArtifactId = first.output?.artifact?.id;
			const patchRef = first.patchArtifact?.patchRef;
			if (!outputArtifactId || !patchRef) throw new Error("Expected writer text and patch artifacts.");
			expect(
				await readOutput.execute(
					"writer-retention-read-initial",
					{ artifactId: outputArtifactId, length: 8 },
					undefined,
					undefined,
					harness.context,
				),
			).toMatchObject({ isError: false });
			for (let index = 1; index < 16; index++) await launchAndWait(index);
			expect(
				await readOutput.execute(
					"writer-retention-read-before-eviction",
					{ artifactId: outputArtifactId, length: 8 },
					undefined,
					undefined,
					harness.context,
				),
			).toMatchObject({ isError: false });
			await launchAndWait(16);
			const expiredOutput = await readOutput.execute(
				"writer-retention-read-after-eviction",
				{ artifactId: outputArtifactId, length: 8 },
				undefined,
				undefined,
				harness.context,
			);
			expect(expiredOutput).toMatchObject({ isError: true, details: { error: { code: "artifact_not_found" } } });
			expect(await readFile(patchRef, "utf8")).toContain("writer patch");
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
			if (previousAgentDir === undefined) delete process.env.ICE_CODING_AGENT_DIR;
			else process.env.ICE_CODING_AGENT_DIR = previousAgentDir;
		}
	}, 60_000);

	it("stops an admitted background writer and waits for isolated-worktree cleanup", async () => {
		const workspace = await createGitWorkspace();
		const harness = await createAsyncToolHarness({
			activeTools: ["delegate_write", "read", "write", "edit", "grep", "find", "ls"],
		});
		const previousAgentDir = process.env.ICE_CODING_AGENT_DIR;
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagent-writer-stop-agent-"));
		tempDirs.push(agentDir);
		process.env.ICE_CODING_AGENT_DIR = agentDir;
		(harness.context as unknown as { cwd: string }).cwd = workspace.cwd;
		let releaseWriter!: () => void;
		let markWriterStarted!: () => void;
		const blockedWriter = new Promise<void>((resolve) => {
			releaseWriter = resolve;
		});
		const writerStarted = new Promise<void>((resolve) => {
			markWriterStarted = resolve;
		});
		try {
			harness.faux.setResponses([
				async () => {
					markWriterStarted();
					await blockedWriter;
					return fauxAssistantMessage("Writer stopped after admission.");
				},
			]);
			const accepted = await harness.tools.get("delegate_write")!.execute(
				"writer-stop-launch",
				{
					task: "Inspect the scoped source and report completion.",
					baseCommit: workspace.head,
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			expect(accepted).toMatchObject({ isError: false, details: { accepted: { runId: expect.any(String) } } });
			const runId = accepted.details.accepted.runId as string;
			await writerStarted;
			const stopping = harness.tools
				.get("manage_subagent")!
				.execute("writer-stop", { runId, action: "stop" }, undefined, undefined, harness.context);
			releaseWriter();
			const stopped = await stopping;
			expect(stopped).toMatchObject({
				isError: false,
				details: {
					writer: {
						state: "cancelled",
						result: { status: "cancelled", workspaceIsolation: "worktree", workspaceRemoved: true },
					},
				},
			});
			expect(await git(workspace.cwd, "status", "--porcelain=v1", "-uall")).toBe("");
		} finally {
			releaseWriter();
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
			if (previousAgentDir === undefined) delete process.env.ICE_CODING_AGENT_DIR;
			else process.env.ICE_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("accepts external writer scopes only with the explicit capability", async () => {
		const workspace = await createGitWorkspace();
		const external = await mkdtemp(join(tmpdir(), "ice-writer-external-"));
		tempDirs.push(external);
		await mkdir(join(external, "project"));
		const writer = writerRequest(workspace.cwd, workspace.head);
		writer.scope = { roots: [resolve(external, "project")] };
		expect(() => normalizeWriterRequest(writer, workspace.cwd)).toThrow(/outside the parent workspace/);
		const normalized = normalizeWriterRequest(writer, workspace.cwd, { allowExternal: true });
		expect(normalized.scope.roots).toEqual([resolve(external, "project")]);
		expect(normalized.allowExternal).toBe(true);
	});

	it("allows the explicit YOLO writer path to skip parent worktree preflight", async () => {
		const harness = await createAsyncToolHarness({
			activeTools: ["delegate", "delegate_write", "read", "bash"],
			flags: { "sub-yolo": true, "ice-allow-bash": true },
			iceMode: "build",
			trusted: true,
		});
		const result = await harness.tools
			.get("delegate_write")!
			.execute(
				"writer-without-preflight",
				{ task: "Change source.", baseCommit: "0".repeat(40), scope: { roots: ["src"] } },
				undefined,
				undefined,
				harness.context,
			);
		expect(result).toMatchObject({ isError: false });
		expect(result.details).toMatchObject({ accepted: { workspaceIsolation: "parent" } });
		expect(result.content[0].text).toMatch(/explicitly authorized parent workspace/i);
	});

	it("requires a clean parent HEAD and ignores ignored files for writers", async () => {
		const { cwd, head } = await createGitWorkspace();
		await writeFile(join(cwd, "ignored.txt"), "ignored\n");
		expect(await validateWriterLaunchPreflight(cwd, head)).toMatchObject({
			baseCommit: head,
			parentHead: head,
			statusPorcelain: "",
		});
	});

	it("creates and removes a detached writer worktree without touching the parent", async () => {
		const { cwd, head } = await createGitWorkspace();
		const workspace = await createWriterWorkspace(cwd, head);
		try {
			expect((await git(workspace.root, "rev-parse", "HEAD")).trim()).toBe(head);
			await writeFile(join(workspace.root, "src", "writer.ts"), "writer\n");
			expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");
		} finally {
			await workspace.cleanup();
		}
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");
		expect(await git(cwd, "worktree", "list")).not.toContain(workspace.root);
	});

	it("confines writer tools, including new paths and linked-worktree .git metadata", async () => {
		const { cwd, head } = await createGitWorkspace();
		const workspace = await createWriterWorkspace(cwd, head);
		try {
			const tools = createScopedWriterToolDefinitions(workspace.root, [join(workspace.root, "src")]);
			expect(tools.map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls", "write", "edit"]);
			const writeTool = tools.find((tool) => tool.name === "write")!;
			const editTool = tools.find((tool) => tool.name === "edit")!;
			await writeTool.execute(
				"write",
				{ path: "src/new.ts", content: "new\n" },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			await editTool.execute(
				"edit",
				{ path: "src/file.ts", edits: [{ oldText: "base", newText: "edited" }] },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			for (const path of [
				"../escape.ts",
				join(workspace.root, "outside.ts"),
				"src/link/new.ts",
				".git/config",
				"src/.git/new.ts",
			]) {
				await expect(
					writeTool.execute("write", { path, content: "blocked" }, undefined, undefined, {} as ExtensionContext),
				).rejects.toThrow(/outside|\.git|approved|symlink/i);
			}
			expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");
		} finally {
			await workspace.cleanup();
		}
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");
	});

	it("uses a distinct writer capability and session tool set", async () => {
		const { cwd, head } = await createGitWorkspace();
		const workspace = await createWriterWorkspace(cwd, head);
		try {
			expect(deriveWriterTools(["delegate_write", "read", "grep", "find", "ls", "write", "edit"])).toEqual([
				"read",
				"grep",
				"find",
				"ls",
				"write",
				"edit",
			]);
			expect(deriveWriterTools(["delegate_write", "read", "grep", "find", "ls", "edit"])).toEqual([]);
			const normalized = normalizeWriterRequest(writerRequest(workspace.root, head), workspace.root);
			let captured: CreateAgentSessionOptions | undefined;
			const fakeSession = {
				sessionId: "writer-child",
				messages: [],
			} as unknown as CreateAgentSessionResult["session"];
			const child = await createNativeWriterSession(
				{
					request: normalized,
					parentActiveTools: ["delegate_write", "read", "grep", "find", "ls", "write", "edit"],
				},
				async (options) => {
					captured = options;
					return { session: fakeSession } as CreateAgentSessionResult;
				},
			);
			expect(child.tools).toEqual(["read", "grep", "find", "ls", "write", "edit"]);
			expect(captured?.tools).toEqual(child.tools);
			expect(captured?.customTools?.map((tool) => tool.name)).toEqual([
				"read",
				"grep",
				"find",
				"ls",
				"write",
				"edit",
			]);
		} finally {
			await workspace.cleanup();
		}
	});

	it("allows explicit YOLO writer execution directly in a dirty parent workspace", async () => {
		const { cwd, head } = await createGitWorkspace();
		const normalized = normalizeWriterRequest(writerRequest(cwd, head), cwd);
		let captured: CreateAgentSessionOptions | undefined;
		const fakeSession = {
			model: testModel("faux", "faux"),
			messages: [fauxAssistantMessage("done")],
			prompt: async () => {
				const writeTool = captured?.customTools?.find((tool) => tool.name === "write");
				if (!writeTool) throw new Error("writer write tool missing");
				await writeTool.execute(
					"write",
					{ path: "src/yolo.ts", content: "yolo\n" },
					undefined,
					undefined,
					{} as ExtensionContext,
				);
			},
			abort: async () => {},
			dispose: () => {},
			extensionRunner: createNoopExtensionRunner(),
			getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
		} as unknown as CreateAgentSessionResult["session"];
		const result = await new NativeWriterRunner({
			createSession: async (options) => {
				captured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		}).run(normalized, ["read", "grep", "find", "ls", "write", "edit", "bash"], {
			model: testModel("faux", "faux"),
			directWorkspace: true,
			unsafeHostExec: true,
		});
		expect(result).toMatchObject({
			status: "completed",
			workspaceIsolation: "parent",
			workspaceRemoved: false,
		});
		expect(result.patchArtifact).toBeUndefined();
		expect(await readFile(join(cwd, "src", "yolo.ts"), "utf8")).toBe("yolo\n");
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toContain("src/yolo.ts");
	});

	it("keeps normal isolated writers contained even when an external request bit is present", async () => {
		const { cwd, head } = await createGitWorkspace();
		const external = await mkdtemp(join(tmpdir(), "ice-writer-isolated-external-"));
		tempDirs.push(external);
		const externalFile = join(external, "external.ts");
		await writeFile(externalFile, "base\n");
		const normalized = normalizeWriterRequest(writerRequest(cwd, head), cwd, { allowExternal: true });
		let captured: CreateAgentSessionOptions | undefined;
		const fakeSession = { messages: [] } as unknown as CreateAgentSessionResult["session"];
		await createNativeWriterSession(
			{
				request: normalized,
				parentActiveTools: ["delegate_write", "read", "grep", "find", "ls", "write", "edit"],
			},
			async (options) => {
				captured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		);
		const writeTool = captured?.customTools?.find((tool) => tool.name === "write");
		if (!writeTool) throw new Error("writer write tool missing");
		await expect(
			writeTool.execute(
				"write",
				{ path: externalFile, content: "changed\n" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/outside|approved|scope/i);
		expect(await readFile(externalFile, "utf8")).toBe("base\n");
	});

	it("rejects external writer scopes in normal isolated worktrees", async () => {
		const { cwd, head } = await createGitWorkspace();
		const external = await mkdtemp(join(tmpdir(), "ice-writer-isolated-scope-external-"));
		tempDirs.push(external);
		const externalFile = join(external, "external.ts");
		await writeFile(externalFile, "base\n");
		const normalized = normalizeWriterRequest(writerRequest(cwd, head), cwd, { allowExternal: true });
		normalized.scope = { roots: [external] };
		let captured: CreateAgentSessionOptions | undefined;
		const fakeSession = {
			model: testModel("faux", "faux"),
			messages: [fauxAssistantMessage("done")],
			prompt: async () => {
				const writeTool = captured?.customTools?.find((tool) => tool.name === "write");
				if (!writeTool) throw new Error("writer write tool missing");
				await writeTool.execute(
					"write",
					{ path: externalFile, content: "changed\n" },
					undefined,
					undefined,
					{} as ExtensionContext,
				);
			},
			abort: async () => {},
			dispose: () => {},
			getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
		} as unknown as CreateAgentSessionResult["session"];
		const result = await new NativeWriterRunner({
			createSession: async (options) => {
				captured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		}).run(normalized, ["read", "grep", "find", "ls", "write", "edit"], {
			model: testModel("faux", "faux"),
		});
		expect(result.status).toBe("failed");
		expect(await readFile(externalFile, "utf8")).toBe("base\n");
	});

	it("allows an authorized direct writer to mutate an external path outside its declared scope", async () => {
		const { cwd, head } = await createGitWorkspace();
		const external = await mkdtemp(join(tmpdir(), "ice-writer-authorized-external-"));
		tempDirs.push(external);
		const externalFile = join(external, "external.ts");
		const normalized = normalizeWriterRequest(writerRequest(cwd, head), cwd, { allowExternal: true });
		let captured: CreateAgentSessionOptions | undefined;
		const fakeSession = {
			model: testModel("faux", "faux"),
			messages: [fauxAssistantMessage("done")],
			prompt: async () => {
				const writeTool = captured?.customTools?.find((tool) => tool.name === "write");
				if (!writeTool) throw new Error("writer write tool missing");
				await writeTool.execute(
					"write",
					{ path: externalFile, content: "external\n" },
					undefined,
					undefined,
					{} as ExtensionContext,
				);
			},
			abort: async () => {},
			dispose: () => {},
			extensionRunner: createNoopExtensionRunner(),
			getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
		} as unknown as CreateAgentSessionResult["session"];
		const result = await new NativeWriterRunner({
			createSession: async (options) => {
				captured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		}).run(normalized, ["read", "grep", "find", "ls", "write", "edit", "bash"], {
			model: testModel("faux", "faux"),
			directWorkspace: true,
			unsafeHostExec: true,
		});
		expect(result.status).toBe("completed");
		expect(await readFile(externalFile, "utf8")).toBe("external\n");
	});

	it("rejects a writer request without the separate parent capability", async () => {
		const { cwd, head } = await createGitWorkspace();
		const normalized = normalizeWriterRequest(writerRequest(cwd, head), cwd);
		await expect(
			createNativeWriterSession(
				{ request: normalized, parentActiveTools: ["delegate", "read", "write", "edit"] },
				async () => {
					throw new Error("must not create a writer child");
				},
			),
		).rejects.toThrow(/delegate_write|capability/i);
	});

	it("collects an immutable bounded patch for completed writer edits without touching the parent", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const normalized = normalizeWriterRequest(writerRequest(cwd, head), cwd);
		let captured: CreateAgentSessionOptions | undefined;
		const fakeSession = {
			model: testModel("faux", "faux"),
			messages: [fauxAssistantMessage("done")],
			prompt: async () => {
				const writeTool = captured?.customTools?.find((tool) => tool.name === "write");
				if (!writeTool) throw new Error("writer write tool missing");
				await writeTool.execute(
					"write",
					{ path: "src/child.ts", content: "child\n" },
					undefined,
					undefined,
					{} as ExtensionContext,
				);
			},
			abort: async () => {},
			dispose: () => {},
			extensionRunner: createNoopExtensionRunner(),
			getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
		} as unknown as CreateAgentSessionResult["session"];
		const result = await new NativeWriterRunner({
			artifactRoot,
			createSession: async (options) => {
				captured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		}).run(normalized, ["delegate_write", "read", "grep", "find", "ls", "write", "edit"], {
			model: testModel("faux", "faux"),
		});
		expect(result).toMatchObject({ status: "completed", baseCommit: head, workspaceRemoved: true });
		expect(result.patchArtifact).toMatchObject({
			schemaVersion: 1,
			baseCommit: head,
			changedFileCount: 1,
			files: [{ path: "src/child.ts", change: "add" }],
		});
		const patchArtifact = result.patchArtifact!;
		expect(patchArtifact.patchBytes).toBeGreaterThan(0);
		expect(patchArtifact.patchSha256).toMatch(/^[a-f0-9]{64}$/);
		expect((await stat(patchArtifact.patchRef)).mode & 0o222).toBe(0);
		expect(await readFile(patchArtifact.patchRef, "utf8")).toContain("src/child.ts");
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");
		await expect(git(cwd, "cat-file", "-e", "HEAD:src/child.ts")).rejects.toThrow();
	});

	it("does not write writer blobs into the parent object store while collecting", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const workspace = await createWriterWorkspace(cwd, head);
		try {
			const newPath = join(workspace.root, "src", "object-store-isolation.ts");
			await writeFile(newPath, "object-store-isolation\n");
			const blobId = (await git(workspace.root, "hash-object", newPath)).trim();
			await expect(git(cwd, "cat-file", "-e", `${blobId}^{blob}`)).rejects.toThrow();

			const artifact = collectWriterPatchArtifact(
				workspace,
				{ runId: "object-store-isolation", status: "completed", baseCommit: head },
				{ scopeRoots: [join(workspace.root, "src")], artifactRoot },
			);
			expect(artifact).toBeDefined();
			await expect(git(cwd, "cat-file", "-e", `${blobId}^{blob}`)).rejects.toThrow();
		} finally {
			await workspace.cleanup();
		}
	});

	it("keeps patch bytes and afterSha256 consistent for CRLF content", async () => {
		const { cwd } = await createGitWorkspace();
		await writeFile(join(cwd, ".gitattributes"), "*.txt text eol=lf\n");
		await git(cwd, "add", ".gitattributes");
		await git(cwd, "commit", "-m", "configure text normalization");
		const head = (await git(cwd, "rev-parse", "HEAD")).trim();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const workspace = await createWriterWorkspace(cwd, head);
		let cleanWorkspace: Awaited<ReturnType<typeof createWriterWorkspace>> | undefined;
		try {
			const content = Buffer.from("first line\r\nsecond line\r\n");
			await writeFile(join(workspace.root, "src", "new.txt"), content);
			const artifact = collectWriterPatchArtifact(
				workspace,
				{ runId: "crlf-consistency", status: "completed", baseCommit: head },
				{ scopeRoots: [join(workspace.root, "src")], artifactRoot },
			);
			expect(artifact?.files).toEqual([
				{
					path: "src/new.txt",
					change: "add",
					afterSha256: createHash("sha256").update(content).digest("hex"),
				},
			]);

			cleanWorkspace = await createWriterWorkspace(cwd, head);
			await execFileAsync("git", ["apply", artifact!.patchRef], { cwd: cleanWorkspace.root, encoding: "utf8" });
			const applied = await readFile(join(cleanWorkspace.root, "src", "new.txt"));
			expect(createHash("sha256").update(applied).digest("hex")).toBe(artifact!.files[0]!.afterSha256);
		} finally {
			if (cleanWorkspace) await cleanWorkspace.cleanup();
			await workspace.cleanup();
		}
	});

	it("integrates a verified writer patch and runs the parent verifier", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const artifact = await createWriterArtifact(cwd, head, artifactRoot, "src/child.ts", "child\n");
		const verifier = vi.fn(async ({ parentRoot, changedPaths }: WriterPatchVerificationContext) => {
			expect(changedPaths).toEqual(["src/child.ts"]);
			expect(await readFile(join(parentRoot, "src", "child.ts"), "utf8")).toBe("child\n");
		});

		const result = await integrateWriterPatchArtifact(artifact, {
			cwd,
			scopeRoots: ["src"],
			verify: verifier,
		});

		expect(result).toMatchObject({ status: "applied", parentRoot: cwd, changedPaths: ["src/child.ts"] });
		expect(verifier).toHaveBeenCalledOnce();
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("?? src/child.ts\n");
	});

	it("rejects a patch inventory mismatch before apply", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const artifact = await createWriterArtifact(cwd, head, artifactRoot, "src/child.ts", "child\n");
		const file = artifact.files[0]!;
		const verifier = vi.fn(async () => {});

		await expect(
			integrateWriterPatchArtifact(
				{ ...artifact, files: [{ ...file, path: "src/other.ts" }] },
				{ cwd, scopeRoots: ["src"], verify: verifier },
			),
		).rejects.toThrow(/inventory|path/i);
		expect(verifier).not.toHaveBeenCalled();
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");
	});

	it("rejects a patch whose checked apply conflicts without mutating the parent", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const artifact = await createWriterArtifact(cwd, head, artifactRoot, "src/file.ts", "changed\n");
		const patch = (await readFile(artifact.patchRef, "utf8")).replace("-base\n", "-other\n");
		const patchRef = join(artifactRoot, "conflict.patch");
		await writeFile(patchRef, patch);
		const invalidArtifact = {
			...artifact,
			patchRef,
			patchBytes: Buffer.byteLength(patch),
			patchSha256: createHash("sha256").update(patch).digest("hex"),
		};
		const verifier = vi.fn(async () => {});

		await expect(
			integrateWriterPatchArtifact(invalidArtifact, { cwd, scopeRoots: ["src"], verify: verifier }),
		).rejects.toThrow(/apply|patch|context/i);
		expect(verifier).not.toHaveBeenCalled();
		expect(await readFile(join(cwd, "src", "file.ts"), "utf8")).toBe("base\n");
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");
	});

	it("reports when integration starts rollback", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const artifact = await createWriterArtifact(cwd, head, artifactRoot, "src/file.ts", "changed\n");
		const onRollback = vi.fn();

		await expect(
			integrateWriterPatchArtifact(artifact, {
				cwd,
				scopeRoots: ["src"],
				verify: async () => {
					throw new Error("parent verification failed");
				},
				onRollback,
			}),
		).rejects.toThrow(/parent verification failed/i);
		expect(onRollback).toHaveBeenCalledOnce();
	});

	it("resolves only genuine production writer artifacts and caps previews", async () => {
		const { cwd, head } = await createGitWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-writer-agent-"));
		tempDirs.push(agentDir);
		const artifact = await createWriterArtifact(
			cwd,
			head,
			join(agentDir, "artifacts", "writer"),
			"src/preview.ts",
			`${"x".repeat(40 * 1024)}\n`,
		);
		const inspected = inspectWriterPatchArtifact(artifact, cwd, agentDir);
		expect(inspected.status).toBe("inspected");
		expect(inspected.artifact.runId).toBe(artifact.runId);
		expect(inspected.previewBytes).toBeLessThanOrEqual(32 * 1024);
		expect(inspected.previewTruncated).toBe(true);
		expect(inspected.preview).toContain("preview.ts");

		const outside = await mkdtemp(join(tmpdir(), "ice-writer-outside-"));
		tempDirs.push(outside);
		const outsidePatch = join(outside, "proposal.patch");
		await writeFile(outsidePatch, await readFile(artifact.patchRef));
		expect(() => inspectWriterPatchArtifact({ ...artifact, patchRef: outsidePatch }, cwd, agentDir)).toThrow(
			/artifact|root|provenance/i,
		);

		const expectedPatch = artifact.patchRef;
		const symlinkTarget = join(outside, "target.patch");
		await writeFile(symlinkTarget, await readFile(expectedPatch));
		await rm(expectedPatch);
		await symlink(symlinkTarget, expectedPatch);
		expect(() => inspectWriterPatchArtifact(artifact, cwd, agentDir)).toThrow(/regular|symlink/i);
	});

	it("does not retain a proposal after a failed writer with partial edits", async () => {
		const { cwd, head } = await createGitWorkspace();
		const artifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(artifactRoot);
		const normalized = normalizeWriterRequest(writerRequest(cwd, head), cwd);
		let captured: CreateAgentSessionOptions | undefined;
		const fakeSession = {
			model: testModel("faux", "faux"),
			messages: [],
			prompt: async () => {
				const writeTool = captured?.customTools?.find((tool) => tool.name === "write");
				if (!writeTool) throw new Error("writer write tool missing");
				await writeTool.execute(
					"write",
					{ path: "src/partial.ts", content: "partial\n" },
					undefined,
					undefined,
					{} as ExtensionContext,
				);
				throw new Error("failed after edit");
			},
			abort: async () => {},
			dispose: () => {},
			getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
		} as unknown as CreateAgentSessionResult["session"];
		const result = await new NativeWriterRunner({
			artifactRoot,
			createSession: async (options) => {
				captured = options;
				return { session: fakeSession } as CreateAgentSessionResult;
			},
		}).run(normalized, ["delegate_write", "read", "grep", "find", "ls", "write", "edit"], {
			model: testModel("faux", "faux"),
		});
		expect(result).toMatchObject({ status: "failed", workspaceRemoved: true });
		expect(result.patchArtifact).toBeUndefined();
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");
	});

	it("enforces the actual changed-file and patch-byte caps", async () => {
		const manyFiles = await createGitWorkspace();
		const manyArtifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(manyArtifactRoot);
		const manyWorkspace = await createWriterWorkspace(manyFiles.cwd, manyFiles.head);
		try {
			for (let index = 0; index < 33; index++) {
				await writeFile(join(manyWorkspace.root, "src", `file-${index}.ts`), `${index}\n`);
			}
			expect(() =>
				collectWriterPatchArtifact(
					manyWorkspace,
					{ runId: "too-many", status: "completed", baseCommit: manyFiles.head },
					{ scopeRoots: [join(manyWorkspace.root, "src")], artifactRoot: manyArtifactRoot },
				),
			).toThrow(/32/);
		} finally {
			await manyWorkspace.cleanup();
		}

		const largeFile = await createGitWorkspace();
		const largeArtifactRoot = await mkdtemp(join(tmpdir(), "ice-writer-artifacts-"));
		tempDirs.push(largeArtifactRoot);
		const largeWorkspace = await createWriterWorkspace(largeFile.cwd, largeFile.head);
		try {
			await writeFile(join(largeWorkspace.root, "src", "large.ts"), "x".repeat(512 * 1024));
			expect(() =>
				collectWriterPatchArtifact(
					largeWorkspace,
					{ runId: "too-large", status: "completed", baseCommit: largeFile.head },
					{ scopeRoots: [join(largeWorkspace.root, "src")], artifactRoot: largeArtifactRoot },
				),
			).toThrow(/512.*bytes|exceeds/i);
		} finally {
			await largeWorkspace.cleanup();
		}
	});

	it("removes writer worktrees after cancellation and does not impose a post-start lifetime timeout", async () => {
		const runPending = async (waitPastStartupDeadline: boolean): Promise<WriterResult> => {
			const { cwd, head } = await createGitWorkspace();
			const controller = new AbortController();
			let abortCalls = 0;
			let promptStarted = false;
			const lifecycle: string[] = [];
			const shutdown = vi.fn(async () => {
				lifecycle.push("shutdown");
			});
			const fakeSession = {
				model: testModel("faux", "faux"),
				messages: [],
				prompt: async () => {
					promptStarted = true;
					return new Promise<void>(() => {});
				},
				abort: async () => {
					abortCalls++;
				},
				dispose: () => lifecycle.push("dispose"),
				extensionRunner: {
					hasHandlers: vi.fn((eventType: string) => eventType === "session_shutdown"),
					emit: shutdown,
				},
				getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
			} as unknown as CreateAgentSessionResult["session"];
			const request = normalizeWriterRequest({ ...writerRequest(cwd, head), timeoutMs: 25 }, cwd);
			let started = false;
			const promise = new NativeWriterRunner({
				createSession: async () => {
					started = true;
					return { session: fakeSession } as CreateAgentSessionResult;
				},
			}).run(request, ["delegate_write", "read", "grep", "find", "ls", "write", "edit"], {
				model: testModel("faux", "faux"),
				signal: controller.signal,
			});
			for (let attempt = 0; attempt < 20 && (!started || !promptStarted); attempt++)
				await new Promise((resolve) => setTimeout(resolve, 0));
			if (waitPastStartupDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				expect(abortCalls).toBe(0);
			}
			controller.abort();
			const result = await promise;
			expect(abortCalls).toBe(1);
			expect(shutdown).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
			expect(lifecycle).toEqual(["shutdown", "dispose"]);
			expect(result.workspaceRemoved).toBe(true);
			expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");
			return result;
		};
		await expect(runPending(false)).resolves.toMatchObject({ status: "cancelled" });
		await expect(runPending(true)).resolves.toMatchObject({ status: "cancelled" });
	});

	it("reports writer child failures without changing the parent", async () => {
		const { cwd, head } = await createGitWorkspace();
		const normalized = normalizeWriterRequest(writerRequest(cwd, head), cwd);
		const fakeSession = {
			model: testModel("faux", "faux"),
			messages: [],
			prompt: async () => {
				throw new Error("child failed");
			},
			abort: async () => {},
			dispose: () => {},
			getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
		} as unknown as CreateAgentSessionResult["session"];
		const result = await new NativeWriterRunner({
			createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
		}).run(normalized, ["delegate_write", "read", "grep", "find", "ls", "write", "edit"], {
			model: testModel("faux", "faux"),
		});
		expect(result).toMatchObject({ status: "failed", workspaceRemoved: true });
		expect(result.summary).toContain("child failed");
		expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");
	});

	it("keeps caller subsets and broader denies monotonic at native dispatch", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-agent-"));
		tempDirs.push(agentDir);
		const subset = normalizeSubagentRequest({ ...request(cwd), execution: { tools: ["read"] } }, cwd, {
			agentDir,
		});
		let subsetCapture: CreateAgentSessionOptions | undefined;
		await createNativeSubagentSession(
			{ request: subset, parentActiveTools: ["delegate", "read", "grep", "find", "ls"], agentDir },
			async (options) => {
				subsetCapture = options;
				return {
					session: { sessionId: "subset-child", messages: [] } as unknown as CreateAgentSessionResult["session"],
					extensionsResult: { extensions: [], errors: [], runtime: createExtensionRuntime() },
				};
			},
		);
		expect(subsetCapture?.tools).toEqual(["read"]);
		expect(subsetCapture?.settingsManager?.getMidRunCompaction()).toBe("resume");

		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { midRunCompaction: "off" } }));
		let explicitOffCapture: CreateAgentSessionOptions | undefined;
		await createNativeSubagentSession(
			{ request: subset, parentActiveTools: ["delegate", "read", "grep", "find", "ls"], agentDir },
			async (options) => {
				explicitOffCapture = options;
				return {
					session: {
						sessionId: "explicit-off-child",
						messages: [],
					} as unknown as CreateAgentSessionResult["session"],
					extensionsResult: { extensions: [], errors: [], runtime: createExtensionRuntime() },
				};
			},
		);
		expect(explicitOffCapture?.settingsManager?.getMidRunCompaction()).toBe("off");

		const settingsManager = SettingsManager.inMemory();
		settingsManager.setIceSettingsValue("global", { subagents: { restrictions: { denyTools: ["find"] } } });
		const denied = normalizeSubagentRequest({ ...request(cwd), execution: { tools: ["read", "find"] } }, cwd, {
			agentDir,
			settingsManager,
		});
		let deniedCapture: CreateAgentSessionOptions | undefined;
		await createNativeSubagentSession(
			{ request: denied, parentActiveTools: ["delegate", "read", "find"], agentDir },
			async (options) => {
				deniedCapture = options;
				return {
					session: { sessionId: "denied-child", messages: [] } as unknown as CreateAgentSessionResult["session"],
					extensionsResult: { extensions: [], errors: [], runtime: createExtensionRuntime() },
				};
			},
		);
		expect(deniedCapture?.tools).toEqual(["read"]);
		const forgedFind = deniedCapture?.customTools?.find((tool) => tool.name === "find");
		expect(forgedFind).toBeDefined();
		await expect(
			forgedFind!.execute(
				"find-denied-by-policy",
				{ pattern: "*", path: join(cwd, "src") },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			),
		).rejects.toMatchObject({ code: "capability_denied" });
	});

	it("returns a typed startup failure when writer session startup never settles", async () => {
		const { cwd, head } = await createGitWorkspace();
		const normalized = normalizeWriterRequest({ ...writerRequest(cwd, head), timeoutMs: 5 }, cwd);
		const result = await Promise.race([
			new NativeWriterRunner({ createSession: async () => new Promise<never>(() => {}) }).run(
				normalized,
				["read", "grep", "find", "ls", "write", "edit", "bash"],
				{ model: testModel("faux", "faux"), directWorkspace: true, unsafeHostExec: true },
			),
			new Promise<WriterResult>((_, reject) =>
				setTimeout(() => reject(new Error("writer startup timeout was not enforced")), 100),
			),
		]);
		expect(result).toMatchObject({
			status: "failed",
			workspaceRemoved: false,
			diagnostics: [{ code: "timeout" }],
		});
	});

	it("orderly shuts down a writer that finishes startup after the startup deadline", async () => {
		const { cwd, head } = await createGitWorkspace();
		const normalized = normalizeWriterRequest({ ...writerRequest(cwd, head), timeoutMs: 5 }, cwd);
		let resolveStartup: ((value: CreateAgentSessionResult) => void) | undefined;
		const startup = new Promise<CreateAgentSessionResult>((resolve) => {
			resolveStartup = resolve;
		});
		const lifecycle: string[] = [];
		const shutdown = vi.fn(async () => lifecycle.push("shutdown"));
		const fakeSession = {
			model: testModel("faux", "faux"),
			messages: [],
			abort: vi.fn(async () => lifecycle.push("abort")),
			dispose: vi.fn(() => lifecycle.push("dispose")),
			extensionRunner: {
				hasHandlers: vi.fn((eventType: string) => eventType === "session_shutdown"),
				emit: shutdown,
			},
		} as unknown as CreateAgentSessionResult["session"];
		const result = await new NativeWriterRunner({
			createSession: async () => startup,
		}).run(normalized, ["read", "grep", "find", "ls", "write", "edit", "bash"], {
			model: testModel("faux", "faux"),
			directWorkspace: true,
			unsafeHostExec: true,
		});
		expect(result).toMatchObject({ status: "failed", diagnostics: [{ code: "timeout" }] });
		resolveStartup?.({ session: fakeSession } as CreateAgentSessionResult);
		await vi.waitFor(() => expect(fakeSession.dispose).toHaveBeenCalledOnce());
		expect(shutdown).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
		expect(lifecycle).toEqual(["abort", "shutdown", "dispose"]);
	});

	it("exposes stateless writer inspect, reject, and integrate decisions", async () => {
		const { cwd, head } = await createGitWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-writer-agent-"));
		tempDirs.push(agentDir);
		const artifact = await createWriterArtifact(
			cwd,
			head,
			join(agentDir, "artifacts", "writer"),
			"src/child.ts",
			"child\n",
		);
		const previousAgentDir = process.env.ICE_CODING_AGENT_DIR;
		process.env.ICE_CODING_AGENT_DIR = agentDir;
		try {
			const registerTool = vi.fn();
			const registerCommand = vi.fn();
			let verifierFlag: string | undefined;
			const getActiveTools = () => ["inspect_writer_patch", "reject_writer_patch", "integrate_writer_patch"];
			iceSubagents({
				on: vi.fn(),
				getActiveTools,
				getFlag: () => verifierFlag,
				registerTool,
				registerCommand,
			} as unknown as ExtensionAPI);
			const tools = new Map(registerTool.mock.calls.map((call) => [call[0]?.name, call[0]]));
			const context = {
				cwd,
				isProjectTrusted: () => true,
				sessionManager: { getEntries: () => [] },
			} as unknown as ExtensionContext;

			const inspected = await tools
				.get("inspect_writer_patch")!
				.execute("inspect-writer", { artifact }, undefined, undefined, context);
			expect(inspected.details).toMatchObject({ status: "inspected", artifact: { runId: artifact.runId } });
			expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");

			const rejected = await tools
				.get("reject_writer_patch")!
				.execute("reject-writer", { artifact }, undefined, undefined, context);
			expect(rejected.details).toMatchObject({ status: "rejected", artifact: { runId: artifact.runId } });
			expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");

			const unavailable = await tools
				.get("integrate_writer_patch")!
				.execute("integrate-missing-verifier", { artifact }, undefined, undefined, context);
			expect(unavailable.details).toMatchObject({ status: "verifier_unavailable" });
			expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");

			verifierFlag = "[malformed";
			const malformedUpdates: unknown[] = [];
			const malformed = await tools
				.get("integrate_writer_patch")!
				.execute(
					"integrate-malformed-verifier",
					{ artifact },
					undefined,
					(update: unknown) => malformedUpdates.push(update),
					context,
				);
			expect(malformed.details).toMatchObject({ status: "verifier_unavailable" });
			const malformedProgress = malformedUpdates
				.map((update) => getProgressSnapshot((update as { details?: unknown }).details))
				.filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== undefined);
			expect(malformedProgress.at(-1)).toMatchObject({
				phase: "verification_failed",
				status: "failed",
				terminal: true,
			});
			expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");

			verifierFlag = JSON.stringify([process.execPath, "-e", "process.exit(0)"]);
			const updates: unknown[] = [];
			const integrated = await tools
				.get("integrate_writer_patch")!
				.execute("integrate-writer", { artifact }, undefined, (update: unknown) => updates.push(update), context);
			expect(integrated.details).toMatchObject({ status: "integrated", verification: { status: "passed" } });
			const progress = updates
				.map((update) => getProgressSnapshot((update as { details?: unknown }).details))
				.filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== undefined);
			expect(progress.map((snapshot) => `${snapshot.phase}/${snapshot.status}`)).toEqual([
				"validating/running",
				"inspected/running",
				"applying/running",
				"verifying/running",
				"integrated/completed",
			]);
			expect(progress.at(-1)).toMatchObject({ phase: "integrated", status: "completed", terminal: true });
			expect(await readFile(join(cwd, "src", "child.ts"), "utf8")).toBe("child\n");
			expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("?? src/child.ts\n");

			type ObservatoryViewHarness = {
				render(width: number): string[];
				handleInput(data: string): void;
			};
			type ObservatoryFactory = (
				tui: { requestRender(): void },
				theme: { fg(color: string, text: string): string },
				keybindings: KeybindingsManager,
				done: () => void,
			) => ObservatoryViewHarness;
			let view: ObservatoryViewHarness | undefined;
			const done = vi.fn();
			const custom = vi.fn(async (factory: unknown, options: unknown) => {
				view = (factory as ObservatoryFactory)(
					{ requestRender: vi.fn() },
					{ fg: (_color, text) => text },
					new KeybindingsManager(),
					done,
				);
				expect(options).toEqual({ overlay: true });
				const initial = view.render(240).join("\\n");
				expect(initial).toContain("RECENT");
				expect(initial).toContain(">✓");
				view.handleInput("\x1b[B");
				expect(view.render(240).join("\\n")).toContain(">✓ ------ reject_writer_patch");
				view.handleInput("\x1b[B");
				view.handleInput("\x1b[B");
				view.handleInput("\x1b[B");
				expect(view.render(240).join("\\n")).toContain(">✓ ------ integrate_writer_patch completed");
				view.handleInput("\n");
				const expanded = view.render(240).join("\\n");
				expect(expanded).toContain("verifier passed");
				view.handleInput("\n");
				expect(view.render(240).join("\\n")).not.toContain("verifier passed");
				view.handleInput("\x1b");
			});
			const agentsCommand = registerCommand.mock.calls.find((call) => call[0] === "agents")?.[1] as {
				handler: (args: string, commandContext: unknown) => Promise<void>;
			};
			const commandContext = {
				...context,
				mode: "tui",
				ui: { custom, notify: vi.fn() },
			};
			await agentsCommand.handler("", commandContext);
			const subagentsCommand = registerCommand.mock.calls.find((call) => call[0] === "subagents")?.[1] as {
				handler: (args: string, commandContext: unknown) => Promise<void>;
			};
			await subagentsCommand.handler("", commandContext);
			expect(custom).toHaveBeenCalledTimes(2);
			expect(custom.mock.calls.map((call) => call[1])).toEqual([{ overlay: true }, { overlay: true }]);
			expect(done).toHaveBeenCalledTimes(2);
			expect(view).toBeDefined();
		} finally {
			if (previousAgentDir === undefined) delete process.env.ICE_CODING_AGENT_DIR;
			else process.env.ICE_CODING_AGENT_DIR = previousAgentDir;
		}
	});
});

describe("ICE file/self delegation plan coverage", () => {
	it("validates selected MCP selectors and requires parent-owned dispatch", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-mcp-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "mcp-agent.md"),
			"---\nname: mcp-agent\ndescription: MCP agent\ntools: read\nmcp: [search/docs]\n---\nInspect.\n",
		);
		const normalized = normalizeSubagentRequest(
			{
				parentSessionId: "parent-1",
				role: "mcp-agent",
				task: "Inspect.",
				scope: { roots: ["src"] },
				cwd,
			},
			cwd,
			{ agentDir },
		);
		expect(normalized.selectedMcpTools).toEqual(["search/docs"]);
		await expect(
			createNativeSubagentSession(
				{ request: normalized, parentActiveTools: ["delegate", "read"] },
				async () => ({ session: { sessionId: "x", messages: [] } }) as never,
			),
		).rejects.toThrowError(/parent-owned adapter dispatch/i);
		const dispatched: Array<{ server: string; tool: string }> = [];
		const beforeTool = vi.fn(async () => {});
		let dispatchedResult: unknown;
		const created = await createNativeSubagentSession(
			{
				request: normalized,
				parentActiveTools: ["delegate", "read"],
				mcpDispatch: async (server, tool) => {
					dispatched.push({ server, tool });
					return { authorization: "Bearer mcp-secret", ok: true };
				},
				parentMcpTools: ["search/docs"],
				mcpToolAccess: new Map([["search/docs", "read-only"]]),
				beforeTool,
			},
			async (options) => {
				const mcpTool = options.customTools?.find(
					(tool) => tool.name === iceSubagentsModule.subagentMcpToolName("search/docs"),
				);
				expect(mcpTool).toBeDefined();
				dispatchedResult = await mcpTool!.execute("mcp-1", { q: "x" }, undefined, undefined, undefined as never);
				return { session: { sessionId: "child-mcp", messages: [] } } as never;
			},
		);
		expect(dispatched).toEqual([{ server: "search", tool: "docs" }]);
		expect(beforeTool).toHaveBeenCalledOnce();
		expect(dispatchedResult).toMatchObject({ content: [{ type: "text" }], isError: false });
		expect(JSON.stringify(dispatchedResult)).not.toContain("mcp-secret");
		expect(created.session.sessionId).toBe("child-mcp");

		const mutationAgent = join(agentDir, "agents", "mcp-mutation.md");
		await writeFile(
			mutationAgent,
			"---\nname: mcp-mutation\ndescription: MCP mutation\ntools: read\nmcp: [search/update]\n---\nInspect.\n",
		);
		const mutationRequest = normalizeSubagentRequest(
			{
				parentSessionId: "parent-1",
				role: "mcp-mutation",
				task: "Inspect.",
				scope: { roots: ["src"] },
				cwd,
			},
			cwd,
			{ agentDir },
		);
		await expect(
			createNativeSubagentSession(
				{
					request: mutationRequest,
					parentActiveTools: ["delegate", "read"],
					mcpDispatch: async () => ({ ok: true }),
					parentMcpTools: ["search/update"],
					mcpToolAccess: new Map([["search/update", "mutation"]]),
				},
				async () => ({ session: { sessionId: "should-not-start", messages: [] } }) as never,
			),
		).rejects.toThrowError(/read-only child/);

		const unknownAccessAgent = join(agentDir, "agents", "mcp-unknown.md");
		await writeFile(
			unknownAccessAgent,
			"---\nname: mcp-unknown\ndescription: MCP unknown\ntools: read\nmcp: [search/unknown]\n---\nInspect.\n",
		);
		const unknownAccessRequest = normalizeSubagentRequest(
			{
				parentSessionId: "parent-1",
				role: "mcp-unknown",
				task: "Inspect.",
				scope: { roots: ["src"] },
				cwd,
			},
			cwd,
			{ agentDir },
		);
		await expect(
			createNativeSubagentSession(
				{
					request: unknownAccessRequest,
					parentActiveTools: ["delegate", "read"],
					mcpDispatch: async () => ({ ok: true }),
					parentMcpTools: ["search/unknown"],
					mcpToolAccess: new Map([["search/unknown", "unknown"]]),
				},
				async () => ({ session: { sessionId: "should-not-start", messages: [] } }) as never,
			),
		).rejects.toThrowError(/classification/);
		await writeFile(
			join(agentDir, "agents", "mcp-bad.md"),
			"---\nname: mcp-bad\ndescription: Bad MCP\ntools: read\nmcp: [no-slash]\n---\nInspect.\n",
		);
		expect(() => resolveSubagentProfileResolution("mcp-bad", { cwd, agentDir })).toThrowError(/server\/tool/i);
	});
});
