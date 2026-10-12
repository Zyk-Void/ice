import { fauxAssistantMessage } from "@zykairotis/ice-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { createHarness, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function seed(harness: Harness) {
	harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	await harness.session.prompt("first");
	await harness.session.prompt("second");
}

describe("native operation-scoped cancellation", () => {
	test("already-aborted calls do not abort the agent, spawn Bash, or move history", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const abort = vi.spyOn(harness.session.agent, "abort");
		const exec = vi.fn<BashOperations["exec"]>();
		const caller = new AbortController();
		caller.abort();
		const leaf = harness.sessionManager.getLeafId();
		await expect(harness.session.compact(undefined, { signal: caller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		await expect(
			harness.session.executeBash("synthetic", undefined, { operations: { exec }, signal: caller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		await expect(harness.session.navigateTree("missing", { signal: caller.signal })).resolves.toEqual({
			cancelled: true,
			aborted: true,
		});
		expect(exec).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
		expect(harness.sessionManager.getLeafId()).toBe(leaf);
	});

	test("caller cancellation reaches compaction authentication and releases its lock", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const entered = deferred();
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async (_model, options) => {
			entered.resolve();
			return new Promise<never>((_resolve, reject) =>
				options!.signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {
					once: true,
				}),
			);
		});
		const caller = new AbortController();
		const remove = vi.spyOn(caller.signal, "removeEventListener");
		const operation = harness.session.compact(undefined, { signal: caller.signal });
		const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
		await entered.promise;
		caller.abort();
		await rejected;
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	test("a cancelled compaction waits for a delayed hook and cannot save its returned summary", async () => {
		const entered = deferred();
		const release = deferred();
		let nativeSignal: AbortSignal | undefined;
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(ice) => {
					ice.on("session_before_compact", async (event) => {
						nativeSignal = event.signal;
						entered.resolve();
						await release.promise;
						return {
							compaction: {
								summary: "must not save",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		await seed(harness);
		const caller = new AbortController();
		let settled = false;
		const operation = harness.session.compact(undefined, { signal: caller.signal }).finally(() => {
			settled = true;
		});
		const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
		try {
			await entered.promise;
			caller.abort();
			expect(nativeSignal?.aborted).toBe(true);
			expect(settled).toBe(false);
			expect(harness.session.isCompacting).toBe(true);
			release.resolve();
			await rejected;
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		} finally {
			release.resolve();
			await operation.catch(() => {});
		}
	});

	test("tree cancellation preserves the old leaf across a delayed pre-navigation hook", async () => {
		const entered = deferred();
		const release = deferred();
		let nativeSignal: AbortSignal | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.on("session_before_tree", async (event) => {
						nativeSignal = event.signal;
						entered.resolve();
						await release.promise;
						return { summary: { summary: "must not save" } };
					});
				},
			],
		});
		harnesses.push(harness);
		await seed(harness);
		const leaf = harness.sessionManager.getLeafId();
		const caller = new AbortController();
		const remove = vi.spyOn(caller.signal, "removeEventListener");
		const operation = harness.session.navigateTree(harness.sessionManager.getEntries()[0]!.id, {
			summarize: true,
			signal: caller.signal,
		});
		try {
			await entered.promise;
			caller.abort();
			expect(nativeSignal?.aborted).toBe(true);
			release.resolve();
			await expect(operation).resolves.toEqual({ cancelled: true, aborted: true });
			expect(harness.sessionManager.getLeafId()).toBe(leaf);
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "branch_summary")).toBe(false);
			expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		} finally {
			release.resolve();
			await operation;
		}
	});

	test("targeted Bash cancellation leaves another Bash operation running and retains partial evidence", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const release = deferred();
		const caller = new AbortController();
		const remove = vi.spyOn(caller.signal, "removeEventListener");
		let neighbourSignal: AbortSignal | undefined;
		const target = harness.session.executeBash("target", undefined, {
			signal: caller.signal,
			operations: {
				exec: async (_command, _cwd, options) => {
					options.onData(Buffer.from("partial evidence"));
					return new Promise((resolve) =>
						options.signal!.addEventListener("abort", () => resolve({ exitCode: null }), { once: true }),
					);
				},
			},
		});
		const neighbour = harness.session.executeBash("neighbour", undefined, {
			operations: {
				exec: async (_command, _cwd, options) => {
					neighbourSignal = options.signal;
					await release.promise;
					return { exitCode: 0 };
				},
			},
		});
		try {
			caller.abort();
			await expect(target).resolves.toMatchObject({ output: "partial evidence", cancelled: true });
			expect(neighbourSignal?.aborted).toBe(false);
			expect(harness.session.isBashRunning).toBe(true);
			expect(harness.session.messages).toContainEqual(
				expect.objectContaining({
					role: "bashExecution",
					command: "target",
					output: "partial evidence",
					cancelled: true,
				}),
			);
			release.resolve();
			await expect(neighbour).resolves.toMatchObject({ exitCode: 0, cancelled: false });
			expect(harness.session.isBashRunning).toBe(false);
			expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		} finally {
			caller.abort();
			release.resolve();
			await Promise.all([target, neighbour]);
		}
	});

	test("successful Bash settlement detaches its caller listener", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const caller = new AbortController();
		const remove = vi.spyOn(caller.signal, "removeEventListener");
		let nativeSignal: AbortSignal | undefined;
		await harness.session.executeBash("synthetic", undefined, {
			signal: caller.signal,
			operations: {
				exec: async (_command, _cwd, options) => {
					nativeSignal = options.signal;
					return { exitCode: 0 };
				},
			},
		});
		caller.abort();
		expect(nativeSignal?.aborted).toBe(false);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
	});
});
