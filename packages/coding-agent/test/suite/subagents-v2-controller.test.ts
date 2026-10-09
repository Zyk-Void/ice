import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	createIceSubagentController,
	getIceSubagentController,
	registerIceSubagentController,
} from "../../src/subagents/v2/controller.ts";
import { SubagentV2Runtime } from "../../src/subagents/v2/runtime.ts";
import type { V2RuntimeHost } from "../../src/subagents/v2/runtime-support.ts";
import { resolveSubagentsV2Settings } from "../../src/subagents/v2/settings.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

/** The runtime suite's host: a faux parent that records completions it would receive. */
async function setup(options: { repository?: boolean } = {}) {
	const harness = await createHarness();
	harnesses.push(harness);
	const cwd = options.repository ? join(harness.tempDir, "repo") : harness.tempDir;
	if (options.repository) {
		mkdirSync(cwd);
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", ...args], { cwd });
		git("init", "-q");
		writeFileSync(join(cwd, "a.txt"), "base\n");
		git("add", "a.txt");
		git("commit", "-q", "-m", "init");
	}
	const sessionManager = SessionManager.create(cwd, join(harness.tempDir, "sessions"));
	const sent: unknown[] = [];
	const parent = {
		sessionId: sessionManager.getSessionId(),
		sessionManager,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		getActiveToolNames: () => ["read", "grep", "find", "ls", "edit", "write", "agent_patch"],
		sendCustomMessage: vi.fn(async (message: unknown) => {
			sent.push(message);
		}),
	} as unknown as AgentSession;
	const host: V2RuntimeHost = {
		getParentSession: () => parent,
		agentDir: join(harness.tempDir, "agent"),
		userAgentsDir: join(harness.tempDir, "agents"),
		getSettings: () => resolveSubagentsV2Settings({ projectTrusted: false }),
		isProjectTrusted: () => options.repository === true,
		getParentMode: () => "build",
		isSubYolo: () => false,
		getAdapters: () => [],
	};
	return { harness, runtime: new SubagentV2Runtime(host), sent };
}

describe("subagent V2 controller", () => {
	it("launches a child, returns its turn result, and never delivers it to the parent", async () => {
		const { harness, runtime, sent } = await setup();
		harness.setResponses([fauxAssistantMessage("child report")]);
		const controller = createIceSubagentController(runtime);
		const launched: string[] = [];
		const result = await controller.start(
			{ agent: "explore", description: "explore task", prompt: "Summarize" },
			{ onLaunched: (id) => launched.push(id) },
		);
		expect(result).toMatchObject({ outcome: "completed", text: "child report", agent: "explore" });
		expect(result.model).toEqual({ provider: harness.getModel().provider, id: harness.getModel().id });
		expect(launched).toEqual([result.id]);
		await Promise.resolve();
		runtime.flushCompletions();
		expect(sent).toEqual([]);
		await runtime.shutdown();
	});

	it("returns an open worktree patch and previews it without inspecting it", async () => {
		const { harness, runtime } = await setup({ repository: true });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "child change\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const controller = createIceSubagentController(runtime);
		const result = await controller.start({
			agent: "general",
			description: "write task",
			prompt: "Change a.txt",
			isolation: "worktree",
		});
		expect(result).toMatchObject({ outcome: "completed", patchState: "open" });
		const preview = controller.preview(result.id);
		expect(preview?.changedPaths).toEqual([{ status: "M", path: "a.txt" }]);
		expect(preview?.patch).toContain("+child change");
		expect(controller.preview(result.id, 8)?.truncated).toBe(true);
		expect(controller.openPatches()).toEqual([
			expect.objectContaining({ id: result.id, agent: "general", description: "write task" }),
		]);
		// Preview never pins an artifact: applying still requires inspection through agent_patch.
		expect(runtime.registry.get(runtime.ownerSessionId(), result.id).patchArtifact).toBeUndefined();
		await expect(runtime.applyPatch(result.id)).rejects.toThrow(/Inspect this patch/);
		await runtime.shutdown();
	});

	it("lets another child read, but not write, an open patch worktree of the same parent", async () => {
		const { harness, runtime } = await setup({ repository: true });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "child change\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const controller = createIceSubagentController(runtime);
		const author = await controller.start({
			agent: "general",
			description: "write task",
			prompt: "Change a.txt",
			isolation: "worktree",
		});
		const root = controller.preview(author.id)!.root;
		const patched = join(root, "a.txt");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: patched }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("write", { path: patched, content: "tampered\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("reviewed"),
		]);
		const reviewer = await controller.start({
			agent: "general",
			description: "review task",
			prompt: "Review the patch",
			scope: { roots: [".", root] },
		});
		expect(reviewer.outcome).toBe("completed");
		const transcript = readFileSync(
			runtime.registry.get(runtime.ownerSessionId(), reviewer.id).transcriptPath,
			"utf8",
		);
		expect(transcript).toContain("child change");
		expect(transcript).toContain("is outside guarded root");
		expect(readFileSync(patched, "utf8")).toBe("child change\n");
		await runtime.shutdown();
	});

	it("rejects invalid tasks, resumes, and pre-aborted signals before launching", async () => {
		const { runtime } = await setup();
		const controller = createIceSubagentController(runtime);
		await expect(controller.start({ description: "", prompt: "x" })).rejects.toThrow(/Invalid subagent task/);
		await expect(controller.start({ description: "d", prompt: "x", resume: "other" } as never)).rejects.toThrow(
			/Invalid subagent task|cannot resume/,
		);
		const aborted = new AbortController();
		aborted.abort();
		await expect(controller.start({ description: "d", prompt: "x" }, { signal: aborted.signal })).rejects.toThrow(
			/Cancelled before launch/,
		);
		expect(runtime.registry.list(runtime.ownerSessionId())).toEqual([]);
		await runtime.shutdown();
	});

	it("is registered per owner and removed by its own unregister only", () => {
		const owner = {};
		const first = {
			version: 1 as const,
			start: async () => ({}) as never,
			stop: async () => {},
			preview: () => undefined,
			openPatches: () => [],
		};
		const second = {
			version: 1 as const,
			start: async () => ({}) as never,
			stop: async () => {},
			preview: () => undefined,
			openPatches: () => [],
		};
		const unregisterFirst = registerIceSubagentController(owner, first);
		expect(getIceSubagentController(owner)).toBe(first);
		registerIceSubagentController(owner, second);
		unregisterFirst();
		expect(getIceSubagentController(owner)).toBe(second);
		expect(getIceSubagentController({})).toBeUndefined();
	});
});
