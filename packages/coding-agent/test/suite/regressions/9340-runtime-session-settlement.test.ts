import { copyFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function runtimeHarness(extension: ExtensionFactory = () => {}, persistSession = false) {
	const harness = await createHarness({
		persistSession,
		extensionFactories: [extension],
		settings: { compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 } },
	});
	cleanups.push(harness.cleanup);
	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
				noContextFiles: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: harness.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const services = await createAgentSessionServices({
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
		},
	});
	const runtime = new AgentSessionRuntime(harness.session, services, factory);
	await harness.session.bindExtensions({});
	cleanups.push(() => runtime.dispose());
	return { harness, runtime };
}

async function seed(harness: Harness) {
	harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
	await harness.session.prompt("first request");
	await harness.session.prompt("second request");
}

describe("runtime settlement and import integrity", () => {
	it.each(["new", "dispose"] as const)("waits for an aborted tree hook before %s", async (action) => {
		const entered = deferred();
		const release = deferred();
		let shutdownBeforeRelease = false;
		let released = false;
		const { harness, runtime } = await runtimeHarness((ice) => {
			ice.on("session_shutdown", () => {
				shutdownBeforeRelease = !released;
			});
			ice.on("session_before_tree", async () => {
				entered.resolve();
				await release.promise;
				return { summary: { summary: "cancelled summary" } };
			});
		});
		await seed(harness);
		const originalLeaf = harness.sessionManager.getLeafId();
		const navigation = harness.session.navigateTree(harness.sessionManager.getEntries()[0].id, { summarize: true });
		await entered.promise;
		let settled = false;
		const replacement = (action === "new" ? runtime.newSession() : runtime.dispose()).then(() => {
			settled = true;
		});
		// Drain ready microtasks; the pending hook must be the settlement barrier.
		for (let i = 0; i < 20; i++) await Promise.resolve();
		const settledBeforeRelease = settled;
		released = true;
		release.resolve();
		const result = await navigation;
		await replacement;
		expect(settledBeforeRelease).toBe(false);
		expect(shutdownBeforeRelease).toBe(false);
		expect(result).toMatchObject({ cancelled: true, aborted: true });
		expect(harness.sessionManager.getLeafId()).toBe(originalLeaf);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "branch_summary")).toBe(false);
	});

	it("waits for a cancelled manual compaction hook before shutdown", async () => {
		const entered = deferred();
		const release = deferred();
		let shutdownBeforeRelease = false;
		let released = false;
		const { harness, runtime } = await runtimeHarness((ice) => {
			ice.on("session_before_compact", async () => {
				entered.resolve();
				await release.promise;
				return { cancel: true };
			});
			ice.on("session_shutdown", () => {
				shutdownBeforeRelease = !released;
			});
		});
		await seed(harness);
		const compaction = harness.session.compact().catch((error: unknown) => error);
		await entered.promise;
		const replacement = runtime.newSession();
		for (let i = 0; i < 20; i++) await Promise.resolve();
		released = true;
		release.resolve();
		const result = await compaction;
		await replacement;
		expect(result).toMatchObject({ name: "AbortError" });
		expect(shutdownBeforeRelease).toBe(false);
	});

	it("settles an in-memory active tool before mutating fork history", async () => {
		const entered = deferred();
		let sourceIdAtAbort: string | undefined;
		const { harness, runtime } = await runtimeHarness((ice) => {
			ice.registerTool({
				name: "block",
				label: "Block",
				description: "Await cancellation",
				parameters: Type.Object({}),
				execute: (_id, _params, signal, _update, ctx) =>
					new Promise((resolve) => {
						entered.resolve();
						signal?.addEventListener(
							"abort",
							() => {
								sourceIdAtAbort = ctx.sessionManager.getSessionId();
								resolve({ content: [{ type: "text", text: "cancelled" }], details: {} });
							},
							{ once: true },
						);
					}),
			});
		});
		await seed(harness);
		const sourceId = harness.session.sessionId;
		const target = harness.sessionManager.getLeafId()!;
		harness.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);
		const prompt = harness.session.prompt("block now");
		await entered.promise;
		await runtime.fork(target, { position: "at" });
		await prompt;
		expect(sourceIdAtAbort).toBe(sourceId);
		expect(runtime.session.sessionId).not.toBe(sourceId);
		expect(runtime.session.messages.some((message) => message.role === "toolResult")).toBe(false);
	});

	it("does not overwrite a different saved session with the imported basename", async () => {
		const { harness, runtime } = await runtimeHarness(() => {}, true);
		await seed(harness);
		const originalPath = runtime.session.sessionFile!;
		const originalBytes = readFileSync(originalPath);
		const external = SessionManager.create(harness.tempDir, join(harness.tempDir, "external"));
		external.appendMessage({ role: "user", content: "imported request", timestamp: 1 });
		const collidingPath = join(harness.tempDir, basename(originalPath));
		copyFileSync(external.getSessionFile()!, collidingPath);
		await runtime.importFromJsonl(collidingPath);
		expect(readFileSync(originalPath, "utf8")).toBe(originalBytes.toString("utf8"));
		expect(runtime.session.sessionFile).not.toBe(originalPath);
		expect(
			runtime.session.messages.some((message) => message.role === "user" && message.content === "imported request"),
		).toBe(true);
	});
});
