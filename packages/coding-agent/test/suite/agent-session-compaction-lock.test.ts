import type { AgentTool } from "@zykairotis/ice-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai";
import type { ExtensionAPI } from "@zykairotis/ice-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function abortFlag(signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve(true);
			return;
		}
		signal.addEventListener("abort", () => resolve(true), { once: true });
	});
}

interface GateExtension {
	factory: (ice: ExtensionAPI) => void;
	calls: () => number;
	release: () => void;
}

/**
 * session_before_compact handler that blocks on a test-controlled gate so a
 * compaction can be held mid-flight while the test drives other paths. Aborting
 * the compaction signal unblocks the handler with a cancellation result.
 */
function createGateExtension(): GateExtension {
	let callCount = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		factory: (ice: ExtensionAPI) => {
			ice.on("session_before_compact", async (event) => {
				callCount++;
				const aborted = await Promise.race([gate.then(() => false), abortFlag(event.signal)]);
				if (aborted) return { cancel: true };
				return {
					compaction: {
						summary: "gated summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			});
		},
		calls: () => callCount,
		release,
	};
}

function bulkTool(): AgentTool {
	return {
		name: "bulk",
		label: "Bulk",
		description: "Return a large result",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "x".repeat(10000) }], details: {} }),
	};
}

describe("agent session compaction lock", () => {
	it("skips the native auto compaction while another compaction holds the lock", async () => {
		const gate = createGateExtension();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3000, maxTokens: 100 }],
			settings: {
				compaction: {
					enabled: false,
					thresholdPercent: 1,
					midRunCompaction: "off",
					reserveTokens: 0,
					keepRecentTokens: 10,
				},
			},
			tools: [bulkTool()],
			extensionFactories: [gate.factory],
		});
		harnesses.push(harness);

		// Seed the session with a large tool turn so a manual compaction has
		// something to prepare.
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bulk", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("final"),
		]);
		await harness.session.prompt("start");

		// Manual compaction claims the lock and blocks inside session_before_compact.
		const compactPromise = harness.session.compact();
		await vi.waitFor(
			() => {
				expect(gate.calls()).toBe(1);
			},
			{ timeout: 1000, interval: 10 },
		);

		// The native auto path must refuse to start a second, concurrent compaction
		// while the lock is held; it would prepare from the same branch and append
		// a duplicate compaction entry.
		const autoCompaction = (
			harness.session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
			}
		)._runAutoCompaction;
		expect(await autoCompaction.call(harness.session, "threshold", false)).toBe(false);

		gate.release();
		await compactPromise;

		expect(gate.calls()).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it.each([false, true])(
		"runs a prompt queued during auto compaction unless the compaction is cancelled (cancel: %s)",
		async (cancel) => {
			const gate = createGateExtension();
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 3000, maxTokens: 100 }],
				settings: {
					compaction: {
						enabled: true,
						thresholdPercent: 1,
						midRunCompaction: "off",
						reserveTokens: 0,
						keepRecentTokens: 10,
					},
				},
				tools: [bulkTool()],
				extensionFactories: [gate.factory],
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bulk", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("final"),
				fauxAssistantMessage("queued answer"),
			]);
			const promptPromise = harness.session.prompt("start");
			await vi.waitFor(() => expect(gate.calls()).toBe(1), { timeout: 1000, interval: 10 });

			await harness.session.prompt("queued", { source: "rpc" });
			expect(harness.session.getFollowUpMessages()).toEqual(["queued"]);
			if (cancel) harness.session.abortCompaction();
			else gate.release();
			await promptPromise;
			await harness.session.waitForIdle();

			// Like a cancelled manual compaction, a cancelled auto compaction keeps the input queued.
			expect(harness.session.getFollowUpMessages()).toEqual(cancel ? ["queued"] : []);
			expect(harness.getPendingResponseCount()).toBe(cancel ? 1 : 0);
		},
	);

	it("preempts an in-flight auto compaction when compact() is called", async () => {
		const gate = createGateExtension();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3000, maxTokens: 100 }],
			settings: {
				compaction: {
					enabled: true,
					thresholdPercent: 1,
					midRunCompaction: "off",
					reserveTokens: 0,
					keepRecentTokens: 10,
				},
			},
			tools: [bulkTool()],
			extensionFactories: [gate.factory],
		});
		harnesses.push(harness);

		// The agent-end threshold check claims the lock and blocks at the gate.
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bulk", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("final"),
		]);
		const promptPromise = harness.session.prompt("start");
		await vi.waitFor(
			() => {
				expect(gate.calls()).toBe(1);
			},
			{ timeout: 1000, interval: 10 },
		);

		// Manual compaction preempts the blocked auto compaction and takes over.
		const compactPromise = harness.session.compact();
		await vi.waitFor(
			() => {
				expect(gate.calls()).toBe(2);
			},
			{ timeout: 1000, interval: 10 },
		);
		gate.release();

		await Promise.all([promptPromise, compactPromise]);

		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		const ends = harness.eventsOfType("compaction_end");
		expect(ends.map((event) => ({ reason: event.reason, aborted: event.aborted }))).toEqual([
			{ reason: "threshold", aborted: true },
			{ reason: "manual", aborted: false },
		]);
	});
});
