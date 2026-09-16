import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@zykairotis/ice-agent-core";
import { type AssistantMessage, type Context, fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai";
import type { ExtensionAPI, SessionEntry } from "@zykairotis/ice-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import iceBlackholeExtension from "../../examples/extensions/ice-blackhole/index.ts";
import { BLACKHOLE_MINIMAL_KEPT_SENTINEL } from "../../examples/extensions/ice-blackhole/src/core/tail.ts";
import { loadConfig } from "../../examples/extensions/ice-blackhole/src/core/unified-config.ts";
import type { SessionBeforeCompactEvent } from "../../src/core/extensions/types.ts";
import { createIceCogneeExtension } from "../../src/ice-cognee.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const configDirs: string[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of configDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	delete process.env.ICE_CODING_AGENT_DIR;
});

function configureBlackhole(
	midRunCompaction: "resume" | "pause" = "resume",
	tailBehavior: "ice-default" | "minimal" = "ice-default",
): void {
	const directory = mkdtempSync(join(tmpdir(), "ice-blackhole-suite-"));
	configDirs.push(directory);
	mkdirSync(join(directory, "ice-blackhole"));
	writeFileSync(
		join(directory, "ice-blackhole", "ice-blackhole-config.json"),
		JSON.stringify({
			compaction: "auto",
			compactionEngine: "blackhole",
			midRunCompaction,
			compactAfterPercent: 20,
			tailBehavior,
			memory: false,
		}),
	);
	process.env.ICE_CODING_AGENT_DIR = directory;
}

describe("optional Blackhole compaction extension", () => {
	it("registers all Blackhole settings and persists changes", async () => {
		configureBlackhole();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3000, maxTokens: 100 }],
			extensionFactories: [iceBlackholeExtension],
		});
		harnesses.push(harness);

		const settings = harness.session.extensionRunner
			.getRegisteredSettings()
			.find((entry) => entry.name === "blackhole");
		expect(settings?.items.map((item) => item.id)).toEqual([
			"compaction",
			"compaction-engine",
			"mid-run-compaction",
			"threshold",
			"tail-behavior",
			"memory",
		]);
		const threshold = settings?.items.find((item) => item.id === "threshold");
		expect(threshold?.label).toBe("Blackhole compaction threshold");
		expect(threshold?.values).toContain("25%");
		expect(threshold?.currentValue).toBe(`${loadConfig().compactAfterPercent}%`);
		settings?.onChange("threshold", "25%");
		expect(loadConfig().compactAfterPercent).toBe(25);
		expect(loadConfig().midRunCompaction).toBe("resume");
	});

	it("compacts at a percentage threshold and resumes before a later request", async () => {
		configureBlackhole();
		expect(loadConfig().compactionEngine).toBe("blackhole");
		expect(loadConfig().midRunCompaction).toBe("resume");
		let sawResume = false;
		const bulkTool: AgentTool = {
			name: "bulk",
			label: "Bulk",
			description: "Return a large result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "x".repeat(10000) }], details: {} }),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3000, maxTokens: 100 }],
			settings: {
				compaction: {
					enabled: true,
					thresholdPercent: 99,
					midRunCompaction: "off",
					reserveTokens: 0,
					keepRecentTokens: 500,
				},
			},
			tools: [bulkTool],
			extensionFactories: [iceBlackholeExtension],
		});
		harnesses.push(harness);

		const toolResponses: Array<(context: Context) => AssistantMessage> = Array.from(
			{ length: 8 },
			() => (context: Context) => {
				if (JSON.stringify(context.messages).includes("Context was auto-compacted mid-task")) sawResume = true;
				return fauxAssistantMessage(fauxToolCall("bulk", {}), { stopReason: "toolUse" });
			},
		);
		harness.setResponses([
			...toolResponses,
			(context: Context) => {
				if (JSON.stringify(context.messages).includes("Context was auto-compacted mid-task")) sawResume = true;
				return fauxAssistantMessage("continued");
			},
		]);

		await harness.session.prompt("start");
		await vi.waitFor(
			() => {
				expect(sawResume).toBe(true);
			},
			{ timeout: 1000, interval: 10 },
		);

		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length).toBeGreaterThan(
			0,
		);
	});

	it("uses provider context usage for the Blackhole threshold", async () => {
		configureBlackhole();
		const bulkTool: AgentTool = {
			name: "bulk",
			label: "Bulk",
			description: `Return a small result ${"schema ".repeat(1000)}`,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "x".repeat(2000) }], details: {} }),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3000, maxTokens: 100 }],
			settings: {
				compaction: {
					enabled: true,
					thresholdPercent: 99,
					midRunCompaction: "off",
					reserveTokens: 0,
					keepRecentTokens: 100,
				},
			},
			tools: [bulkTool],
			extensionFactories: [iceBlackholeExtension],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bulk", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued"),
		]);

		await harness.session.prompt("start");
		await vi.waitFor(
			() => {
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).not.toHaveLength(
					0,
				);
			},
			{ timeout: 1000, interval: 10 },
		);
	});

	it("does not resume after a completed response without a tool turn", async () => {
		configureBlackhole();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3000, maxTokens: 100 }],
			settings: {
				compaction: {
					enabled: true,
					thresholdPercent: 99,
					midRunCompaction: "off",
					reserveTokens: 0,
					keepRecentTokens: 500,
				},
			},
			extensionFactories: [iceBlackholeExtension],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("x".repeat(10000));
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("minimal tail summarizes the kept window instead of leaving Ice's recent tokens", async () => {
		configureBlackhole("resume", "minimal");
		const harness = await createHarness({ extensionFactories: [iceBlackholeExtension] });
		harnesses.push(harness);
		const result = await harness.session.extensionRunner.emit({
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "keep-entry",
				messagesToSummarize: [
					{ role: "user", content: "Old summarized turn", timestamp: Date.now() } as AgentMessage,
				],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 40000,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 20000 },
			},
			branchEntries: [
				{
					type: "message",
					id: "keep-entry",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "x".repeat(8000), timestamp: Date.now() },
				},
			],
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		} as SessionBeforeCompactEvent);
		expect(result).toMatchObject({
			compaction: {
				firstKeptEntryId: BLACKHOLE_MINIMAL_KEPT_SENTINEL,
				details: { engine: "blackhole", tailBehavior: "minimal" },
			},
		});
	});

	it("lists running background subagent jobs and recent actions in the summary", async () => {
		configureBlackhole();
		const harness = await createHarness({ extensionFactories: [iceBlackholeExtension] });
		harnesses.push(harness);
		const branchEntries = [
			{
				type: "custom",
				id: "job-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: "ice-subagent-job-v1",
				data: {
					schemaVersion: 1,
					sequence: 1,
					job: { jobId: "job-1", role: "explore", status: "running", createdAt: new Date().toISOString() },
				},
			},
			{
				type: "message",
				id: "keep-entry",
				parentId: "job-1",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "recent user turn", timestamp: Date.now() } as AgentMessage,
			},
		] as SessionEntry[];
		const result = await harness.session.extensionRunner.emit({
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "keep-entry",
				messagesToSummarize: [
					{
						role: "assistant",
						content: [{ type: "toolCall", name: "Read", arguments: { file_path: "/tmp/a.ts" } }],
						timestamp: Date.now(),
					} as unknown as AgentMessage,
					{
						role: "toolResult",
						toolName: "Read",
						content: "file body",
						isError: false,
						timestamp: Date.now(),
					} as unknown as AgentMessage,
				],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 40000,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 20000 },
			},
			branchEntries,
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		} as SessionBeforeCompactEvent);
		expect(result).toMatchObject({
			compaction: {
				details: { engine: "blackhole", runningAgents: 1 },
			},
		});
		expect(result?.compaction?.summary).toContain("[Running Agents]");
		expect(result?.compaction?.summary).toContain("explore (running) job job-1: re-check via inspect_subagent_job");
		expect(result?.compaction?.summary).toContain("[Last Actions]");
		expect(result?.compaction?.summary).toContain('Read "/tmp/a.ts"');
	});

	it("uses the last compaction summary when Blackhole and Cognee are both enabled", async () => {
		configureBlackhole();
		const fakeFetch: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
			if (url.endsWith("/api/v1/recall")) return new Response("[]", { status: 200 });
			return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
		};
		const compactionEvent = (): SessionBeforeCompactEvent => ({
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "keep-entry",
				messagesToSummarize: [
					{ role: "user", content: "Keep this compaction input", timestamp: Date.now() } as AgentMessage,
				],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 10 },
			},
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		});
		const run = async (extensions: Array<(ice: ExtensionAPI) => void>) => {
			const storageDir = mkdtempSync(join(tmpdir(), "ice-blackhole-cognee-"));
			configDirs.push(storageDir);
			const harness = await createHarness({ extensionFactories: extensions });
			harnesses.push(harness);
			await harness.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
			const result = await harness.session.extensionRunner.emit(compactionEvent());
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			return result;
		};
		const makeCognee = () => {
			const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-hooks-"));
			configDirs.push(storageDir);
			return createIceCogneeExtension({
				storageDir,
				apiKey: "test-key",
				env: { ICE_COGNEE_DATASET: "ice", ICE_COGNEE_IMPROVE: "false" },
				fetch: fakeFetch,
			});
		};

		const cogneeLast = await run([iceBlackholeExtension, makeCognee()]);
		expect(cogneeLast).toMatchObject({ compaction: { details: { engine: "blackhole" } } });

		const blackholeLast = await run([makeCognee(), iceBlackholeExtension]);
		expect(blackholeLast).toMatchObject({ compaction: { details: { engine: "blackhole" } } });
	});

	it("suspends retries after a failed compaction and allows one resume turn", async () => {
		configureBlackhole();
		let compactionAttempts = 0;
		const cancelCompaction = (ice: ExtensionAPI): void => {
			ice.on("session_before_compact", () => {
				compactionAttempts++;
				return { cancel: true };
			});
		};
		const bulkTool: AgentTool = {
			name: "bulk",
			label: "Bulk",
			description: "Return a large result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "x".repeat(10000) }], details: {} }),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3000, maxTokens: 100 }],
			settings: {
				compaction: {
					enabled: false,
					thresholdPercent: 99,
					midRunCompaction: "off",
					reserveTokens: 0,
					keepRecentTokens: 500,
				},
			},
			tools: [bulkTool],
			extensionFactories: [iceBlackholeExtension, cancelCompaction],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bulk", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bulk", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued"),
		]);

		await harness.session.prompt("start");
		await vi.waitFor(
			() => {
				expect(harness.faux.state.callCount).toBeGreaterThanOrEqual(2);
			},
			{ timeout: 1000, interval: 10 },
		);
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(compactionAttempts).toBe(1);
	});

	it("pauses after compaction without injecting a resume request", async () => {
		configureBlackhole("pause");
		const bulkTool: AgentTool = {
			name: "bulk",
			label: "Bulk",
			description: "Return a large result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "x".repeat(10000) }], details: {} }),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3000, maxTokens: 100 }],
			settings: {
				compaction: {
					enabled: true,
					thresholdPercent: 99,
					midRunCompaction: "off",
					reserveTokens: 0,
					keepRecentTokens: 500,
				},
			},
			tools: [bulkTool],
			extensionFactories: [iceBlackholeExtension],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("bulk", {}), { stopReason: "toolUse" })]);

		await harness.session.prompt("start");
		await vi.waitFor(
			() => {
				expect(
					harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length,
				).toBeGreaterThan(0);
			},
			{ timeout: 1000, interval: 10 },
		);

		expect(harness.faux.state.callCount).toBeGreaterThanOrEqual(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(0);
	});
});
