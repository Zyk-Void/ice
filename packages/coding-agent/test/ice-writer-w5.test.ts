import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import iceSubagents, {
	collectWriterPatchArtifact,
	createWriterWorkspace,
	type WriterPatchArtifact,
	type WriterResult,
} from "../src/ice-subagents.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const fauxRegistrations: Array<ReturnType<typeof registerFauxProvider>> = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
	return result.stdout;
}

async function createGitWorkspace(): Promise<{ cwd: string; head: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "ice-w5-git-"));
	tempDirs.push(cwd);
	await mkdir(join(cwd, "src"));
	await writeFile(join(cwd, "src", "file.ts"), "base\n");
	await git(cwd, "init");
	await git(cwd, "config", "user.email", "ice-w5@example.invalid");
	await git(cwd, "config", "user.name", "ICE W5");
	await git(cwd, "add", ".");
	await git(cwd, "commit", "-m", "base");
	return { cwd, head: (await git(cwd, "rev-parse", "HEAD")).trim() };
}

async function createArtifact(
	cwd: string,
	head: string,
	agentDir: string,
	files: Readonly<Record<string, string>>,
	runId = `w5-${Math.random().toString(36).slice(2, 10)}`,
): Promise<WriterPatchArtifact> {
	const workspace = await createWriterWorkspace(cwd, head);
	try {
		for (const [path, content] of Object.entries(files)) {
			const target = join(workspace.root, path);
			await mkdir(join(target, ".."), { recursive: true });
			await writeFile(target, content);
		}
		const artifact = collectWriterPatchArtifact(
			workspace,
			{ runId, status: "completed", baseCommit: head },
			{ scopeRoots: [join(workspace.root, "src")], artifactRoot: join(agentDir, "artifacts", "writer") },
		);
		if (!artifact) throw new Error("W5 fixture artifact was not collected");
		return artifact;
	} finally {
		await workspace.cleanup();
	}
}

async function createFauxRuntime() {
	const faux = registerFauxProvider();
	fauxRegistrations.push(faux);
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
	});
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [model],
	});
	return { faux, model, modelRegistry: new ModelRegistry(modelRuntime) };
}

interface W5ToolResult {
	isError?: boolean;
	details: unknown;
}

interface W5Tool {
	executionMode?: "sequential" | "parallel";
	execute: (...args: unknown[]) => Promise<W5ToolResult>;
}

interface W5Tools {
	get(name: string): W5Tool;
}

function registeredWriterTools(options: { verifier?: string; active?: string[] } = {}): W5Tools {
	const registered = new Map<string, W5Tool>();
	iceSubagents({
		on: () => {},
		getActiveTools: () =>
			options.active ?? [
				"delegate_write",
				"read",
				"grep",
				"find",
				"ls",
				"write",
				"edit",
				"inspect_writer_patch",
				"reject_writer_patch",
				"integrate_writer_patch",
			],
		getFlag: (name: string) => (name === "ice-verify" ? options.verifier : undefined),
		registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool as unknown as W5Tool),
	} as unknown as ExtensionAPI);
	return {
		get(name: string): W5Tool {
			const tool = registered.get(name);
			if (!tool) throw new Error(`W5 tool was not registered: ${name}`);
			return tool;
		},
	};
}

function toolDetails<T>(result: W5ToolResult): T {
	return result.details as T;
}

function writerContext(
	cwd: string,
	modelRegistry: ModelRegistry,
	model: Model<Api> | undefined,
	trusted = true,
): ExtensionContext {
	return {
		cwd,
		model,
		modelRegistry,
		isProjectTrusted: () => trusted,
		sessionManager: { getSessionId: () => "w5-parent" },
	} as unknown as ExtensionContext;
}

function verifier(exitCode: number, extra = ""): string {
	return JSON.stringify([process.execPath, "-e", `${extra};process.exit(${exitCode})`]);
}

afterEach(async () => {
	for (const registration of fauxRegistrations.splice(0)) registration.unregister();
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("W5 writer workflow end-to-end adversarial gate", () => {
	it("serializes multiple writer tool calls to protect workspace boundaries", () => {
		const tools = registeredWriterTools();
		expect(tools.get("delegate_write").executionMode).toBe("sequential");
	});

	it("runs a faux writer through delegate_write, inspection, and successful integration", async () => {
		const { cwd, head } = await createGitWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-w5-agent-"));
		tempDirs.push(agentDir);
		const { faux, model, modelRegistry } = await createFauxRuntime();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "src/child.ts", content: "child\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("completed"),
		]);
		const previousAgentDir = process.env.ICE_CODING_AGENT_DIR;
		process.env.ICE_CODING_AGENT_DIR = agentDir;
		try {
			const tools = registeredWriterTools({ verifier: verifier(0) });
			const context = writerContext(cwd, modelRegistry, model);
			const delegated = await tools
				.get("delegate_write")
				.execute(
					"w5-delegate",
					{ task: "Create src/child.ts with one line.", baseCommit: head, scope: { roots: ["src"] } },
					undefined,
					undefined,
					context,
				);
			expect(delegated).toMatchObject({ isError: false, details: { result: { status: "completed" } } });
			const artifact = toolDetails<{ result: WriterResult }>(delegated).result.patchArtifact;
			if (!artifact) throw new Error("W5 faux writer returned no artifact");
			expect(artifact.files).toMatchObject([{ path: "src/child.ts", change: "add" }]);

			const inspected = await tools
				.get("inspect_writer_patch")
				.execute("w5-inspect", { artifact }, undefined, undefined, context);
			expect(inspected).toMatchObject({ isError: false, details: { status: "inspected" } });
			const integrated = await tools
				.get("integrate_writer_patch")
				.execute("w5-integrate", { artifact }, undefined, undefined, context);
			expect(integrated).toMatchObject({
				isError: false,
				details: { status: "integrated", verification: { status: "passed" } },
			});
			expect(await readFile(join(cwd, "src", "child.ts"), "utf8")).toBe("child\n");
			expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("?? src/child.ts\n");
		} finally {
			if (previousAgentDir === undefined) delete process.env.ICE_CODING_AGENT_DIR;
			else process.env.ICE_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("keeps rejection reusable and supports a multi-file integration", async () => {
		const { cwd, head } = await createGitWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-w5-agent-"));
		tempDirs.push(agentDir);
		const artifact = await createArtifact(cwd, head, agentDir, {
			"src/one.ts": "one\n",
			"src/two.ts": "two\n",
		});
		const previousAgentDir = process.env.ICE_CODING_AGENT_DIR;
		process.env.ICE_CODING_AGENT_DIR = agentDir;
		try {
			const tools = registeredWriterTools({ verifier: verifier(0) });
			const context = writerContext(
				cwd,
				new ModelRegistry(await ModelRuntime.create({ modelsPath: null })),
				undefined,
			);
			for (const id of ["reject-one", "reject-two"]) {
				const rejected = await tools
					.get("reject_writer_patch")
					.execute(id, { artifact }, undefined, undefined, context);
				expect(rejected).toMatchObject({ isError: false, details: { status: "rejected" } });
			}
			const reused = await tools
				.get("inspect_writer_patch")
				.execute("inspect-reused", { artifact }, undefined, undefined, context);
			expect(reused).toMatchObject({ isError: false, details: { artifact: { changedFileCount: 2 } } });
			const integrated = await tools
				.get("integrate_writer_patch")
				.execute("integrate-reused", { artifact }, undefined, undefined, context);
			expect(integrated).toMatchObject({ isError: false, details: { status: "integrated" } });
			expect(await readFile(join(cwd, "src", "one.ts"), "utf8")).toBe("one\n");
			expect(await readFile(join(cwd, "src", "two.ts"), "utf8")).toBe("two\n");
		} finally {
			if (previousAgentDir === undefined) delete process.env.ICE_CODING_AGENT_DIR;
			else process.env.ICE_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("rejects tampering, path escape, symlink replacement, and patch-limit metadata", async () => {
		const { cwd, head } = await createGitWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-w5-agent-"));
		const outside = await mkdtemp(join(tmpdir(), "ice-w5-outside-"));
		tempDirs.push(agentDir, outside);
		const artifact = await createArtifact(cwd, head, agentDir, { "src/tampered.ts": "safe\n" }, "tamper");
		const previousAgentDir = process.env.ICE_CODING_AGENT_DIR;
		process.env.ICE_CODING_AGENT_DIR = agentDir;
		try {
			const tools = registeredWriterTools();
			const context = writerContext(
				cwd,
				new ModelRegistry(await ModelRuntime.create({ modelsPath: null })),
				undefined,
			);
			const tamperedBytes = Buffer.from(`${await readFile(artifact.patchRef, "utf8")}tampered\n`);
			await chmod(artifact.patchRef, 0o644);
			await writeFile(artifact.patchRef, tamperedBytes);
			const tampered = await tools
				.get("inspect_writer_patch")
				.execute("tampered", { artifact }, undefined, undefined, context);
			expect(tampered).toMatchObject({ isError: true, details: { status: "artifact_invalid" } });

			const valid = await createArtifact(cwd, head, agentDir, { "src/escaped.ts": "safe\n" }, "escape");
			await writeFile(join(outside, "proposal.patch"), await readFile(valid.patchRef));
			const escaped = await tools
				.get("inspect_writer_patch")
				.execute(
					"escaped",
					{ artifact: { ...valid, patchRef: join(outside, "proposal.patch") } },
					undefined,
					undefined,
					context,
				);
			expect(escaped).toMatchObject({ isError: true, details: { status: "artifact_invalid" } });

			const symlinked = await createArtifact(cwd, head, agentDir, { "src/symlinked.ts": "safe\n" }, "symlinked");
			const expectedPath = symlinked.patchRef;
			await rm(expectedPath);
			await symlink(join(outside, "proposal.patch"), expectedPath);
			const symlinkResult = await tools
				.get("inspect_writer_patch")
				.execute("symlink", { artifact: symlinked }, undefined, undefined, context);
			expect(symlinkResult).toMatchObject({ isError: true, details: { status: "artifact_invalid" } });

			const invalidLimit = await tools
				.get("inspect_writer_patch")
				.execute("limit", { artifact: { ...valid, patchBytes: 512 * 1024 + 1 } }, undefined, undefined, context);
			expect(invalidLimit).toMatchObject({ isError: true, details: { status: "artifact_invalid" } });
			expect(
				createHash("sha256")
					.update(await readFile(valid.patchRef))
					.digest("hex"),
			).toBe(valid.patchSha256);
		} finally {
			if (previousAgentDir === undefined) delete process.env.ICE_CODING_AGENT_DIR;
			else process.env.ICE_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("rejects stale bases and dirty parents before applying a proposal", async () => {
		const { cwd, head } = await createGitWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-w5-agent-"));
		tempDirs.push(agentDir);
		const staleArtifact = await createArtifact(cwd, head, agentDir, { "src/stale.ts": "stale\n" }, "stale");
		await writeFile(join(cwd, "src", "new-base.ts"), "new base\n");
		await git(cwd, "add", "src/new-base.ts");
		await git(cwd, "commit", "-m", "advance base");
		const dirty = await createGitWorkspace();
		const dirtyArtifact = await createArtifact(
			dirty.cwd,
			dirty.head,
			agentDir,
			{ "src/dirty.ts": "dirty\n" },
			"dirty",
		);
		await writeFile(join(dirty.cwd, "unrelated.txt"), "operator\n");
		const previousAgentDir = process.env.ICE_CODING_AGENT_DIR;
		process.env.ICE_CODING_AGENT_DIR = agentDir;
		try {
			const tools = registeredWriterTools({ verifier: verifier(0) });
			const context = writerContext(
				cwd,
				new ModelRegistry(await ModelRuntime.create({ modelsPath: null })),
				undefined,
			);
			const stale = await tools
				.get("integrate_writer_patch")
				.execute("stale", { artifact: staleArtifact }, undefined, undefined, context);
			expect(stale).toMatchObject({ isError: true, details: { status: "integration_conflict" } });
			expect(await stat(join(cwd, "src", "stale.ts")).catch(() => undefined)).toBeUndefined();

			const dirtyContext = writerContext(
				dirty.cwd,
				new ModelRegistry(await ModelRuntime.create({ modelsPath: null })),
				undefined,
			);
			const dirtyResult = await tools
				.get("integrate_writer_patch")
				.execute("dirty", { artifact: dirtyArtifact }, undefined, undefined, dirtyContext);
			expect(dirtyResult).toMatchObject({ isError: true, details: { status: "integration_conflict" } });
			expect(await readFile(join(dirty.cwd, "unrelated.txt"), "utf8")).toBe("operator\n");
			expect(await stat(join(dirty.cwd, "src", "dirty.ts")).catch(() => undefined)).toBeUndefined();
		} finally {
			if (previousAgentDir === undefined) delete process.env.ICE_CODING_AGENT_DIR;
			else process.env.ICE_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("maps verifier failure and rollback conflict without claiming integration", async () => {
		const { cwd, head } = await createGitWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-w5-agent-"));
		tempDirs.push(agentDir);
		const artifact = await createArtifact(cwd, head, agentDir, { "src/file.ts": "proposal\n" }, "rollback");
		const previousAgentDir = process.env.ICE_CODING_AGENT_DIR;
		process.env.ICE_CODING_AGENT_DIR = agentDir;
		try {
			const tools = registeredWriterTools({ verifier: verifier(7) });
			const context = writerContext(
				cwd,
				new ModelRegistry(await ModelRuntime.create({ modelsPath: null })),
				undefined,
			);
			const failed = await tools
				.get("integrate_writer_patch")
				.execute("failed-verifier", { artifact }, undefined, undefined, context);
			expect(failed).toMatchObject({
				isError: true,
				details: { status: "verification_failed", verification: { status: "failed" } },
			});
			expect(await readFile(join(cwd, "src", "file.ts"), "utf8")).toBe("base\n");
			expect(await git(cwd, "status", "--porcelain=v1", "-uall")).toBe("");

			const conflictArtifact = await createArtifact(
				cwd,
				head,
				agentDir,
				{ "src/file.ts": "proposal-conflict\n" },
				"rollback-conflict",
			);
			const conflictTools = registeredWriterTools({
				verifier: verifier(7, 'require("fs").writeFileSync("src/file.ts", "verifier mutation\\n")'),
			});
			const conflict = await conflictTools
				.get("integrate_writer_patch")
				.execute("rollback-conflict", { artifact: conflictArtifact }, undefined, undefined, context);
			expect(conflict).toMatchObject({ isError: true, details: { status: "rollback_conflict" } });
			expect(await readFile(join(cwd, "src", "file.ts"), "utf8")).toBe("verifier mutation\n");
		} finally {
			if (previousAgentDir === undefined) delete process.env.ICE_CODING_AGENT_DIR;
			else process.env.ICE_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("returns failed, cancelled, and timed-out writer results without proposals", async () => {
		const { cwd, head } = await createGitWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-w5-agent-"));
		tempDirs.push(agentDir);
		const { faux, model, modelRegistry } = await createFauxRuntime();
		const previousAgentDir = process.env.ICE_CODING_AGENT_DIR;
		process.env.ICE_CODING_AGENT_DIR = agentDir;
		try {
			const tools = registeredWriterTools();
			const context = writerContext(cwd, modelRegistry, model);
			const failedContext = writerContext(
				cwd,
				new ModelRegistry(await ModelRuntime.create({ modelsPath: null })),
				undefined,
			);
			const failed = await tools.get("delegate_write").execute(
				"failed",
				{
					task: "Fail the writer by denying its complete capability.",
					baseCommit: head,
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				failedContext,
			);
			expect(failed).toMatchObject({ isError: true, details: { result: { status: "failed" } } });
			expect(toolDetails<{ result: WriterResult }>(failed).result.patchArtifact).toBeUndefined();

			const cancelledController = new AbortController();
			cancelledController.abort();
			const cancelled = await tools
				.get("delegate_write")
				.execute(
					"cancelled",
					{ task: "Cancel before startup.", baseCommit: head, scope: { roots: ["src"] } },
					cancelledController.signal,
					undefined,
					context,
				);
			expect(cancelled).toMatchObject({ isError: true, details: { result: { status: "cancelled" } } });
			expect(toolDetails<{ result: WriterResult }>(cancelled).result.patchArtifact).toBeUndefined();

			faux.setResponses([
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 100));
					return fauxAssistantMessage("late");
				},
			]);
			const timedOut = await tools
				.get("delegate_write")
				.execute(
					"timed-out",
					{ task: "Timeout the writer.", baseCommit: head, scope: { roots: ["src"] }, timeoutMs: 5 },
					undefined,
					undefined,
					context,
				);
			expect(timedOut).toMatchObject({ isError: true, details: { result: { status: "timed_out" } } });
			expect(toolDetails<{ result: WriterResult }>(timedOut).result.patchArtifact).toBeUndefined();
		} finally {
			if (previousAgentDir === undefined) delete process.env.ICE_CODING_AGENT_DIR;
			else process.env.ICE_CODING_AGENT_DIR = previousAgentDir;
		}
	});
});
