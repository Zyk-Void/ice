import { fauxAssistantMessage } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("#9178 session tree navigation ownership", () => {
	it("rejects navigation while manual compaction holds the lock", async () => {
		const entered = gate();
		const resume = gate();
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 4096 } },
			extensionFactories: [
				(ice) => {
					ice.on("session_before_compact", async (event) => {
						entered.release();
						await resume.promise;
						return {
							compaction: {
								summary: "checkpoint",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("original answer")]);
		await harness.session.prompt("original request");
		const target = harness.sessionManager.getEntries()[0].id;
		const originalLeaf = harness.sessionManager.getLeafId();
		const pending = harness.session.compact();
		await entered.promise;
		try {
			await expect(harness.session.navigateTree(target)).rejects.toThrow(/compaction|summarization/i);
			expect(harness.sessionManager.getLeafId()).toBe(originalLeaf);
		} finally {
			resume.release();
			await pending;
		}
	});

	it("does not navigate after cancellation while a tree hook is awaiting", async () => {
		const entered = gate();
		const resume = gate();
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.on("session_before_tree", async () => {
						entered.release();
						await resume.promise;
						return { summary: { summary: "stale branch checkpoint" } };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("request");
		const target = harness.sessionManager.getEntries()[0].id;
		const originalLeaf = harness.sessionManager.getLeafId();
		const pending = harness.session.navigateTree(target, { summarize: true });
		await entered.promise;
		harness.session.abortBranchSummary();
		resume.release();
		expect(await pending).toMatchObject({ cancelled: true, aborted: true });
		expect(harness.sessionManager.getLeafId()).toBe(originalLeaf);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "branch_summary")).toBe(false);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("cancels branch authentication without changing the leaf or dispatching a summary", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("request");
		const target = harness.sessionManager.getEntries()[0].id;
		const originalLeaf = harness.sessionManager.getLeafId();
		const entered = gate();
		const resume = gate();
		let signal: AbortSignal | undefined;
		const originalGetAuth = harness.session.modelRuntime.getAuth.bind(harness.session.modelRuntime);
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async (model, options) => {
			signal = options?.signal;
			entered.release();
			await resume.promise;
			return originalGetAuth(model);
		});
		harness.setResponses([fauxAssistantMessage("must not be consumed")]);
		const pending = harness.session.navigateTree(target, { summarize: true });
		await entered.promise;
		harness.session.abortBranchSummary();
		resume.release();
		expect(await pending).toMatchObject({ cancelled: true, aborted: true });
		expect(signal?.aborted).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getLeafId()).toBe(originalLeaf);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("rejects prompts while tree navigation owns its controller", async () => {
		const entered = gate();
		const resume = gate();
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.on("session_before_tree", async () => {
						entered.release();
						await resume.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("request");
		const target = harness.sessionManager.getEntries()[0].id;
		const pending = harness.session.navigateTree(target);
		await entered.promise;
		harness.setResponses([fauxAssistantMessage("must not be consumed")]);
		let preflight: boolean | undefined;
		try {
			await expect(
				harness.session.prompt("late request", {
					source: "rpc",
					preflightResult: (success) => {
						preflight = success;
					},
				}),
			).rejects.toThrow(/tree is being navigated/);
			expect(preflight).toBe(false);
			expect(harness.session.getFollowUpMessages()).toEqual([]);
		} finally {
			resume.release();
			await pending;
		}
		await harness.session.waitForIdle();
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("rejects a second navigation while the first owns its controller", async () => {
		const entered = gate();
		const resume = gate();
		let calls = 0;
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.on("session_before_tree", async () => {
						calls++;
						if (calls === 1) {
							entered.release();
							await resume.promise;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("request");
		const target = harness.sessionManager.getEntries()[0].id;
		const pending = harness.session.navigateTree(target);
		await entered.promise;
		try {
			await expect(harness.session.navigateTree(target)).rejects.toThrow(/compaction|summarization/i);
			expect(calls).toBe(1);
			await expect(harness.session.compact()).rejects.toThrow(/summarization/i);
		} finally {
			resume.release();
			await pending;
		}
	});
});
