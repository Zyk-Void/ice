import { fauxAssistantMessage } from "@zykairotis/ice-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionCommandContext } from "../../src/index.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

const io = vi.hoisted(() => ({ lines: [] as string[], input: undefined as ((line: string) => void) | undefined }));
vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	configureRawStdoutLimit: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => io.lines.push(line),
}));
vi.mock("../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));
vi.mock("../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, input: (line: string) => void) => {
		io.input = input;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

const replies = () => io.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
async function call(input: unknown, id: string): Promise<Record<string, unknown>> {
	io.input?.(JSON.stringify(input));
	await vi.waitFor(() => expect(replies().some((reply) => reply.id === id)).toBe(true));
	return replies().find((reply) => reply.id === id)!;
}

afterEach(() => {
	vi.restoreAllMocks();
	io.lines = [];
	io.input = undefined;
});

async function startHost(harness: Harness, methods: Partial<AgentSessionRuntime> = {}) {
	const listeners = {
		end: process.stdin.listeners("end") as NodeListener[],
		SIGTERM: process.listeners("SIGTERM"),
		SIGHUP: process.listeners("SIGHUP"),
	};
	const host = {
		session: harness.session,
		setRebindSession: vi.fn(),
		dispose: vi.fn(async () => {}),
	} as unknown as AgentSessionRuntime;
	Object.defineProperties(host, Object.getOwnPropertyDescriptors(methods));
	void runRpcMode(host);
	await vi.waitFor(() => expect(io.input).toBeDefined());
	await call({ id: "__bootstrap-ready", type: "get_capabilities" }, "__bootstrap-ready");
	io.lines = [];
	return () => {
		for (const listener of process.stdin.listeners("end") as NodeListener[])
			if (!listeners.end.includes(listener)) process.stdin.off("end", listener);
		for (const signal of ["SIGTERM", "SIGHUP"] as const)
			for (const listener of process.listeners(signal))
				if (!listeners[signal].includes(listener)) process.off(signal, listener);
	};
}

describe("RPC transition ordering", () => {
	test("failed runtime replacement blocks stale dispatch until an explicit recovery command", async () => {
		const harness = await createHarness();
		let available = true;
		let fail = true;
		const replace = vi.fn(async () => {
			if (fail) {
				available = false;
				throw new Error("synthetic creation failure");
			}
			available = true;
			return { cancelled: false };
		});
		const cleanup = await startHost(harness, {
			get isAvailable() {
				return available;
			},
			newSession: replace,
		});
		try {
			expect(await call({ id: "failed", type: "new_session" }, "failed")).toMatchObject({
				success: false,
				errorCode: "runtime_unavailable",
			});
			expect(await call({ id: "stale", type: "get_state" }, "stale")).toMatchObject({
				success: false,
				errorCode: "runtime_unavailable",
			});
			expect(await call({ id: "caps", type: "get_capabilities" }, "caps")).toMatchObject({ success: true });
			fail = false;
			expect(await call({ id: "recover", type: "new_session" }, "recover")).toMatchObject({ success: true });
			expect(await call({ id: "state", type: "get_state" }, "state")).toMatchObject({ success: true });
			expect(replace).toHaveBeenCalledTimes(2);
		} finally {
			cleanup();
			harness.cleanup();
		}
	});
	test("a captured command context cannot switch from an active model hook", async () => {
		let captured: ExtensionCommandContext | undefined;
		let checked = false;
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.registerCommand("capture", {
						handler: async (_args, ctx) => {
							captured = ctx;
						},
					});
					ice.on("agent_start", async () => {
						await expect(captured!.newSession()).rejects.toMatchObject({ errorCode: "busy" });
						checked = true;
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		const replace = vi.fn(async () => ({ cancelled: true }));
		const cleanupListeners = await startHost(harness, { newSession: replace });
		try {
			await call({ id: "capture", type: "prompt", message: "/capture" }, "capture");
			await call({ id: "prompt", type: "prompt", message: "hello" }, "prompt");
			await harness.session.waitForIdle();
			expect(checked).toBe(true);
			expect(replace).not.toHaveBeenCalled();
		} finally {
			cleanupListeners();
			harness.cleanup();
		}
	});

	test("adjacent prompt preflights execute in wire order", async () => {
		const harness = await createHarness();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prompt = vi.spyOn(harness.session, "prompt").mockImplementation(async (text, options) => {
			if (text === "first") await gate;
			options?.preflightResult?.(true);
		});
		const cleanupListeners = await startHost(harness);
		try {
			io.input?.(JSON.stringify({ id: "first", type: "prompt", message: "first" }));
			io.input?.(JSON.stringify({ id: "second", type: "prompt", message: "second" }));
			expect(prompt).toHaveBeenCalledTimes(1);
			release();
			await vi.waitFor(() => expect(replies().some((reply) => reply.id === "second")).toBe(true));
			expect(prompt.mock.calls.map(([text]) => text)).toEqual(["first", "second"]);
		} finally {
			release();
			cleanupListeners();
			harness.cleanup();
		}
	});
	test.each([
		{ type: "new_session" },
		{ type: "switch_session", sessionPath: "saved.jsonl" },
		{ type: "fork", entryId: "entry" },
		{ type: "clone" },
		{ type: "import_session", path: "saved.jsonl" },
	])("$type waits for rebind before adjacent prompt and state requests", async (command) => {
		const old = await createHarness();
		const next = await createHarness();
		old.sessionManager.appendCustomEntry("seed");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let rebind: Parameters<AgentSessionRuntime["setRebindSession"]>[0];
		let current = old.session;
		const bind = vi.spyOn(next.session, "bindExtensions");
		const promptOld = vi.spyOn(old.session, "prompt");
		const promptNext = vi.spyOn(next.session, "prompt").mockImplementation(async (_text, options) => {
			options?.preflightResult?.(true);
		});
		const replace = vi.fn(async () => {
			await gate;
			current = next.session;
			await rebind?.(current);
			return { cancelled: false };
		});
		const methods = {
			get session() {
				return current;
			},
			setRebindSession: (callback: Parameters<AgentSessionRuntime["setRebindSession"]>[0]) => {
				rebind = callback;
			},
			newSession: replace,
			switchSession: replace,
			fork: replace,
			importFromJsonl: replace,
		};
		const cleanupListeners = await startHost(old, methods);
		try {
			io.input?.(JSON.stringify({ id: "transition", ...command }));
			io.input?.(JSON.stringify({ id: "prompt", type: "prompt", message: "new target" }));
			io.input?.(JSON.stringify({ id: "state", type: "get_state" }));
			expect(promptOld).not.toHaveBeenCalled();
			expect(replies().some((reply) => reply.id === "state")).toBe(false);
			release();
			await vi.waitFor(() => expect(replies().some((reply) => reply.id === "state")).toBe(true));
			expect(promptOld).not.toHaveBeenCalled();
			expect(promptNext).toHaveBeenCalledOnce();
			expect(bind).toHaveBeenCalledOnce();
			expect(replies().filter((reply) => reply.type === "session_changed")).toEqual([
				expect.objectContaining({ previousSessionId: old.session.sessionId, sessionId: next.session.sessionId }),
			]);
			expect(replies().find((reply) => reply.id === "state")).toMatchObject({
				data: { sessionId: next.session.sessionId },
			});
		} finally {
			cleanupListeners();
			old.cleanup();
			next.cleanup();
		}
	});

	test("extension-initiated replacement fences queries without waiting on itself or nested hooks", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.registerCommand("replace", {
						handler: async (_args, ctx) => {
							await ctx.newSession();
						},
					});
				},
			],
		});
		const bind = vi.spyOn(harness.session, "bindExtensions");
		const replace = vi.fn(async () => {
			const options = bind.mock.calls[0]![0]!;
			await expect(options.commandContextActions!.newSession()).rejects.toMatchObject({ errorCode: "busy" });
			await options.uiContext!.confirm("Replace?", "Proceed");
			return { cancelled: true };
		});
		const cleanupListeners = await startHost(harness, { newSession: replace });
		try {
			io.input?.(JSON.stringify({ id: "prompt", type: "prompt", message: "/replace" }));
			await vi.waitFor(() => expect(replies().some((reply) => reply.method === "confirm")).toBe(true));
			io.input?.(JSON.stringify({ id: "state", type: "get_state" }));
			expect(replies().some((reply) => reply.id === "state")).toBe(false);
			const dialog = replies().find((reply) => reply.method === "confirm")!;
			io.input?.(JSON.stringify({ type: "extension_ui_response", id: dialog.id, confirmed: false }));
			await vi.waitFor(() => expect(replies().some((reply) => reply.id === "state")).toBe(true));
			expect(replies().find((reply) => reply.id === "prompt")).toMatchObject({ success: true });
			expect(replace).toHaveBeenCalledOnce();
		} finally {
			cleanupListeners();
			harness.cleanup();
		}
	});

	test("transition waits for delayed prompt preflight, but not for accepted streaming", async () => {
		const harness = await createHarness();
		let accept!: () => void;
		let settle!: () => void;
		const accepted = new Promise<void>((resolve) => {
			accept = resolve;
		});
		const streaming = new Promise<void>((resolve) => {
			settle = resolve;
		});
		vi.spyOn(harness.session, "prompt").mockImplementation(async (_message, options) => {
			await accepted;
			options?.preflightResult?.(true);
			await streaming;
		});
		const replace = vi.fn(async () => ({ cancelled: true }));
		const cleanupListeners = await startHost(harness, { newSession: replace });
		try {
			io.input?.(JSON.stringify({ id: "prompt", type: "prompt", message: "hello" }));
			io.input?.(JSON.stringify({ id: "switch", type: "new_session" }));
			expect(replace).not.toHaveBeenCalled();
			accept();
			await vi.waitFor(() => expect(replies().some((reply) => reply.id === "switch")).toBe(true));
			expect(replace).toHaveBeenCalledOnce();
		} finally {
			settle();
			cleanupListeners();
			harness.cleanup();
		}
	});

	test("reload fences later introspection while aborts bypass it", async () => {
		const harness = await createHarness();
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		vi.spyOn(harness.session, "reload").mockImplementation(() => gate);
		vi.spyOn(harness.session, "abort").mockResolvedValue();
		const cleanupListeners = await startHost(harness);
		try {
			io.input?.(JSON.stringify({ id: "reload", type: "reload" }));
			io.input?.(JSON.stringify({ id: "tools", type: "get_tools" }));
			await call({ id: "abort", type: "abort" }, "abort");
			expect(replies().some((reply) => reply.id === "tools")).toBe(false);
			finish();
			await vi.waitFor(() => expect(replies().some((reply) => reply.id === "tools")).toBe(true));
		} finally {
			finish();
			cleanupListeners();
			harness.cleanup();
		}
	});

	test("cancellation and failed transitions unblock requests; abort and dialog replies stay live", async () => {
		const harness = await createHarness();
		const bind = vi.spyOn(harness.session, "bindExtensions");
		const abort = vi.spyOn(harness.session, "abort").mockResolvedValue();
		let cancel = false;
		const replace = vi.fn(async () => {
			const ui = bind.mock.calls[0]![0]!.uiContext!;
			cancel = !(await ui.confirm("Switch?", "Confirm session replacement"));
			if (!cancel) throw new Error("creation failed");
			return { cancelled: true };
		});
		const cleanupListeners = await startHost(harness, { newSession: replace });
		try {
			for (const confirmed of [false, true]) {
				io.lines = [];
				io.input?.(JSON.stringify({ id: "switch", type: "new_session" }));
				io.input?.(JSON.stringify({ id: "state", type: "get_state" }));
				await call({ id: "abort", type: "abort" }, "abort");
				expect(replies().some((reply) => reply.id === "state")).toBe(false);
				const dialog = replies().find((reply) => reply.method === "confirm")!;
				io.input?.(JSON.stringify({ type: "extension_ui_response", id: dialog.id, confirmed }));
				await vi.waitFor(() => expect(replies().some((reply) => reply.id === "state")).toBe(true));
				expect(replies().find((reply) => reply.id === "switch")).toMatchObject(
					confirmed ? { success: false, error: "creation failed" } : { success: true, data: { cancelled: true } },
				);
			}
			expect(abort).toHaveBeenCalledTimes(2);
		} finally {
			cleanupListeners();
			harness.cleanup();
		}
	});
});

describe("RPC request cancellation", () => {
	test("a queued replacement can cancel without replay or overtaking its predecessor", async () => {
		const harness = await createHarness();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(harness.session, "reload").mockImplementation(() => gate);
		const replacement = vi.fn(async () => ({ cancelled: false }));
		const cleanup = await startHost(harness, { newSession: replacement });
		try {
			io.input?.(JSON.stringify({ id: "reload", type: "reload" }));
			io.input?.(JSON.stringify({ id: "replace", type: "new_session" }));
			io.input?.(JSON.stringify({ id: "later", type: "get_state" }));
			expect(await call({ id: "cancel", type: "cancel_request", requestId: "replace" }, "cancel")).toMatchObject({
				data: { accepted: true },
			});
			expect(replies().some((reply) => reply.id === "later")).toBe(false);
			release();
			await vi.waitFor(() => expect(replies().some((reply) => reply.id === "later")).toBe(true));
			expect(replies().filter((reply) => reply.id === "replace")).toEqual([
				expect.objectContaining({ success: false, errorCode: "cancelled" }),
			]);
			expect(replacement).not.toHaveBeenCalled();
		} finally {
			release();
			cleanup();
			harness.cleanup();
		}
	});
	test("cancels queued native requests without breaking a preceding transition barrier", async () => {
		const harness = await createHarness();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(harness.session, "reload").mockImplementation(() => gate);
		const compact = vi.spyOn(harness.session, "compact");
		const navigate = vi.spyOn(harness.session, "navigateTree");
		const bash = vi.spyOn(harness.session, "executeBash");
		const cleanup = await startHost(harness);
		try {
			io.input?.(JSON.stringify({ id: "reload", type: "reload" }));
			for (const command of [
				{ type: "compact" },
				{ type: "navigate_tree", targetId: "missing" },
				{ type: "bash", command: "must not execute" },
			]) {
				io.input?.(JSON.stringify({ id: command.type, ...command }));
			}
			io.input?.(JSON.stringify({ id: "state", type: "get_state" }));
			for (const requestId of ["compact", "navigate_tree", "bash"])
				expect(
					await call({ id: `cancel:${requestId}`, type: "cancel_request", requestId }, `cancel:${requestId}`),
				).toMatchObject({ success: true, data: { accepted: true } });
			expect(replies().some((reply) => reply.id === "state")).toBe(false);
			expect(replies().some((reply) => reply.id === "compact")).toBe(false);
			release();
			await vi.waitFor(() => expect(replies().some((reply) => reply.id === "state")).toBe(true));
			for (const id of ["compact", "navigate_tree", "bash"])
				expect(replies().filter((reply) => reply.id === id)).toEqual([
					expect.objectContaining({ success: false, errorCode: "cancelled" }),
				]);
			for (const spy of [compact, navigate, bash]) expect(spy).not.toHaveBeenCalled();
			expect(await call({ id: "late", type: "cancel_request", requestId: "bash" }, "late")).toMatchObject({
				data: { accepted: false },
			});
		} finally {
			release();
			cleanup();
			harness.cleanup();
		}
	});

	test("Bash deadlines abort the owned execution, retain partial history, and settle before replacement", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.on("user_bash", () => ({
						operations: {
							exec: async (_command, _cwd, options) => {
								options.onData(Buffer.from("partial evidence"));
								return new Promise((resolve) =>
									options.signal!.addEventListener("abort", () => resolve({ exitCode: null }), { once: true }),
								);
							},
						},
					}));
				},
			],
		});
		const replace = vi.fn(async () => ({ cancelled: true }));
		const abort = vi.spyOn(harness.session, "abort");
		const cleanup = await startHost(harness, { newSession: replace });
		try {
			io.input?.(JSON.stringify({ id: "bash", type: "bash", command: "synthetic", timeoutMs: 20 }));
			io.input?.(JSON.stringify({ id: "new", type: "new_session" }));
			await vi.waitFor(() => expect(replies().some((reply) => reply.id === "new")).toBe(true));
			expect(replies().filter((reply) => reply.id === "bash" && reply.type === "response")).toEqual([
				expect.objectContaining({ success: false, errorCode: "timeout" }),
			]);
			expect(harness.session.messages).toContainEqual(
				expect.objectContaining({ role: "bashExecution", cancelled: true, output: "partial evidence" }),
			);
			expect(abort).not.toHaveBeenCalled();
			expect(replace).toHaveBeenCalledOnce();
			expect(await call({ id: "late", type: "cancel_request", requestId: "bash" }, "late")).toMatchObject({
				data: { accepted: false },
			});
		} finally {
			cleanup();
			harness.cleanup();
		}
	});

	test("cancellation during a stalled user-Bash hook prevents host fallback but keeps the latch until settlement", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = vi.fn();
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.on("user_bash", async () => {
						entered();
						await gate;
					});
				},
			],
		});
		const exec = vi.spyOn(harness.session, "executeBash");
		const replace = vi.fn(async () => ({ cancelled: true }));
		const cleanup = await startHost(harness, { newSession: replace });
		try {
			io.input?.(JSON.stringify({ id: "bash", type: "bash", command: "must not execute" }));
			io.input?.(JSON.stringify({ id: "new", type: "new_session" }));
			await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
			expect(await call({ id: "cancel", type: "cancel_request", requestId: "bash" }, "cancel")).toMatchObject({
				data: { accepted: true },
			});
			expect(replace).not.toHaveBeenCalled();
			release();
			await vi.waitFor(() => expect(replies().some((reply) => reply.id === "new")).toBe(true));
			expect(exec).not.toHaveBeenCalled();
			expect(replies().find((reply) => reply.id === "bash")).toMatchObject({ errorCode: "cancelled" });
		} finally {
			release();
			cleanup();
			harness.cleanup();
		}
	});

	test("live targeted cancellation bypasses a full admission queue", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness();
		vi.spyOn(harness.session, "reload").mockImplementation(() => gate);
		const compact = vi.spyOn(harness.session, "compact");
		const cleanup = await startHost(harness);
		try {
			io.input?.(JSON.stringify({ id: "reload", type: "reload" }));
			io.input?.(JSON.stringify({ id: "target", type: "compact" }));
			for (let i = 0; i < 254; i++) io.input?.(JSON.stringify({ id: `query:${i}`, type: "get_state" }));
			expect(await call({ id: "overflow", type: "get_state" }, "overflow")).toMatchObject({ errorCode: "busy" });
			expect(await call({ id: "cancel", type: "cancel_request", requestId: "target" }, "cancel")).toMatchObject({
				data: { accepted: true },
			});
			release();
			await vi.waitFor(() => expect(replies().some((reply) => reply.id === "query:253")).toBe(true));
			expect(replies().find((reply) => reply.id === "target")).toMatchObject({ errorCode: "cancelled" });
			expect(compact).not.toHaveBeenCalled();
		} finally {
			release();
			cleanup();
			harness.cleanup();
		}
	});

	test("post-save compaction cancellation retains the checkpoint but suppresses queued continuation", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = vi.fn();
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(ice) => {
					ice.on("session_before_compact", (event) => ({
						compaction: {
							summary: "saved checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					ice.on("session_compact", async () => {
						entered();
						await gate;
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const cleanup = await startHost(harness);
		try {
			io.input?.(JSON.stringify({ id: "compact", type: "compact" }));
			await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
			await call({ id: "queue", type: "follow_up", message: "must remain queued" }, "queue");
			expect(await call({ id: "cancel", type: "cancel_request", requestId: "compact" }, "cancel")).toMatchObject({
				data: { accepted: true },
			});
			release();
			await vi.waitFor(() => expect(replies().some((reply) => reply.id === "compact")).toBe(true));
			expect(replies().find((reply) => reply.id === "compact")).toMatchObject({ errorCode: "cancelled" });
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(harness.session.getFollowUpMessages()).toEqual(["must remain queued"]);
			expect(harness.faux.state.callCount).toBe(2);
		} finally {
			release();
			cleanup();
			harness.cleanup();
		}
	});

	test("request deadlines start at admission even while the command waits for a transition", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness();
		vi.spyOn(harness.session, "reload").mockImplementation(() => gate);
		const compact = vi.spyOn(harness.session, "compact");
		const cleanup = await startHost(harness);
		vi.useFakeTimers();
		try {
			io.input?.(JSON.stringify({ id: "reload", type: "reload" }));
			io.input?.(JSON.stringify({ id: "compact", type: "compact", timeoutMs: 20 }));
			await vi.advanceTimersByTimeAsync(20);
			expect(replies().some((reply) => reply.id === "compact")).toBe(false);
			release();
			await vi.waitFor(() => expect(replies().some((reply) => reply.id === "compact")).toBe(true));
			expect(replies().find((reply) => reply.id === "compact")).toMatchObject({ errorCode: "timeout" });
			expect(compact).not.toHaveBeenCalled();
		} finally {
			release();
			vi.useRealTimers();
			cleanup();
			harness.cleanup();
		}
	});
});

describe("RPC input and discovery contract", () => {
	test("parse errors never echo credential-bearing input snippets", async () => {
		const harness = await createHarness();
		const cleanup = await startHost(harness);
		try {
			io.input?.('{"token":"secret-parse-credential", broken');
			await vi.waitFor(() =>
				expect(replies()).toContainEqual(
					expect.objectContaining({ command: "parse", errorCode: "invalid_request" }),
				),
			);
			expect(JSON.stringify(replies())).not.toContain("secret-parse-credential");
		} finally {
			cleanup();
			harness.cleanup();
		}
	});
	test("inline attachments, command completions, safe diagnostics and UI text snapshots", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.registerCommand("inspect-data", { description: "Inspect data", handler: async () => {} });
				},
			],
		});
		const bind = vi.spyOn(harness.session, "bindExtensions");
		const prompt = vi.spyOn(harness.session, "prompt").mockImplementation(async (_message, options) => {
			options?.preflightResult?.(true);
		});
		const cleanup = await startHost(harness);
		try {
			await call(
				{
					id: "attached",
					type: "prompt",
					message: "analyze",
					attachments: [
						{ type: "text", name: "example.txt", text: "/inspect-data is untrusted file content" },
						{ type: "image", name: "image.png", data: "base64", mimeType: "image/png" },
					],
				},
				"attached",
			);
			expect(prompt).toHaveBeenCalledWith(
				expect.stringContaining("untrusted file content"),
				expect.objectContaining({
					expandPromptTemplates: false,
					images: [{ type: "image", data: "base64", mimeType: "image/png" }],
				}),
			);
			expect(
				await call({ id: "completion", type: "get_completions", prefix: "/inspect", limit: 1 }, "completion"),
			).toMatchObject({ data: { items: [{ value: "/inspect-data", source: "extension" }], hasMore: false } });
			vi.spyOn(harness.session.modelRuntime, "getError").mockReturnValue("Bearer secret-credential");
			const diagnostics = await call({ id: "diagnostics", type: "get_diagnostics" }, "diagnostics");
			expect(diagnostics).toMatchObject({
				data: { diagnostics: [expect.objectContaining({ code: "catalog_error", severity: "error" })] },
			});
			expect(JSON.stringify(diagnostics)).not.toContain("secret-credential");
			const ui = bind.mock.calls[0]![0]!.uiContext!;
			ui.setStatus("status", "hello");
			ui.setWidget("widget", ["one", "two"], { placement: "belowEditor" });
			expect(await call({ id: "ui", type: "get_ui_state" }, "ui")).toMatchObject({
				data: {
					statuses: [{ key: "status", text: "hello" }],
					widgets: [{ key: "widget", lines: ["one", "two"], placement: "belowEditor" }],
					truncated: false,
				},
			});
			const factory = vi.fn(() => ({ render: () => ["terminal-only"], invalidate: () => {} }));
			ui.setWidget("widget", factory, { rpcText: ["headless projection"] });
			expect(factory).not.toHaveBeenCalled();
			expect(await call({ id: "projected-ui", type: "get_ui_state" }, "projected-ui")).toMatchObject({
				data: { widgets: [{ key: "widget", lines: ["headless projection"] }] },
			});
			ui.setWidget("widget", undefined);
			expect(await call({ id: "clear-ui", type: "get_ui_state" }, "clear-ui")).toMatchObject({
				data: { widgets: [] },
			});
			ui.setWidget("stale", ["old extension widget"]);
			await call({ id: "reload-ui", type: "reload" }, "reload-ui");
			expect(await call({ id: "fresh-ui", type: "get_ui_state" }, "fresh-ui")).toMatchObject({
				data: { widgets: [], statuses: [] },
			});
		} finally {
			cleanup();
			harness.cleanup();
		}
	});
	test("native cached catalog and direct settings changes invalidate RPC snapshots without secrets", async () => {
		const harness = await createHarness();
		const cleanup = await startHost(harness);
		try {
			await harness.session.modelRuntime.getAvailable();
			harness.session.settingsManager.setTransport("sse");
			await vi.waitFor(() => expect(replies()).toContainEqual({ type: "catalog_changed" }));
			expect(replies()).toContainEqual({ type: "settings_changed" });
			expect(JSON.stringify(replies().filter((record) => record.type === "catalog_changed"))).not.toContain(
				"faux-key",
			);
			const callback = vi.fn();
			const detach = harness.session.settingsManager.subscribeChanges(callback);
			detach();
			harness.session.settingsManager.setTransport("auto");
			await Promise.resolve();
			expect(callback).not.toHaveBeenCalled();
		} finally {
			cleanup();
			harness.cleanup();
		}
	});

	test("message/model/tree pages are bounded and reject stale or unknown cursors", async () => {
		const harness = await createHarness({ models: [{ id: "one" }, { id: "two" }, { id: "three" }] });
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const cleanup = await startHost(harness);
		try {
			const first = await call({ id: "messages", type: "get_messages", limit: 1 }, "messages");
			const data = first.data as { messages: unknown[]; nextCursor: string; hasMore: boolean };
			expect(data.messages).toHaveLength(1);
			expect(data.hasMore).toBe(true);
			expect(
				await call({ id: "next", type: "get_messages", limit: 1, cursor: data.nextCursor }, "next"),
			).toMatchObject({ data: { messages: [expect.objectContaining({ role: "assistant" })] } });
			harness.sessionManager.appendCustomEntry("invalidate");
			expect(
				await call({ id: "stale", type: "get_messages", limit: 1, cursor: data.nextCursor }, "stale"),
			).toMatchObject({ success: false, errorCode: "stale" });
			const modelPage = await call({ id: "models", type: "get_models", limit: 1 }, "models");
			expect(modelPage).toMatchObject({
				data: { models: [expect.any(Object)], hasMore: true, nextCursor: expect.any(String) },
			});
			expect(
				await call({ id: "missing-model", type: "get_models", cursor: "missing", limit: 1 }, "missing-model"),
			).toMatchObject({ errorCode: "not_found" });
			const root = harness.sessionManager.getTree()[0]!;
			expect(await call({ id: "tree", type: "get_tree", limit: 1 }, "tree")).toMatchObject({
				data: { parentId: null, tree: [{ entry: { id: root.entry.id }, children: [], hasChildren: true }] },
			});
			expect(
				await call({ id: "children", type: "get_tree", parentId: root.entry.id, limit: 1 }, "children"),
			).toMatchObject({
				data: { parentId: root.entry.id, tree: [{ entry: { parentId: root.entry.id }, children: [] }] },
			});
		} finally {
			cleanup();
			harness.cleanup();
		}
	});
	test("entry pages use append IDs and retain the current leaf snapshot", async () => {
		const harness = await createHarness();
		const cleanupListeners = await startHost(harness);
		try {
			const ids = Array.from({ length: 5 }, (_value, index) =>
				harness.sessionManager.appendCustomEntry(`entry-${index}`),
			);
			expect(await call({ id: "first", type: "get_entries", limit: 2 }, "first")).toMatchObject({
				data: {
					entries: ids.slice(0, 2).map((id) => expect.objectContaining({ id })),
					nextCursor: ids[1],
					hasMore: true,
					leafId: ids[4],
				},
			});
			expect(await call({ id: "next", type: "get_entries", since: ids[1], limit: 2 }, "next")).toMatchObject({
				data: {
					entries: ids.slice(2, 4).map((id) => expect.objectContaining({ id })),
					nextCursor: ids[3],
					hasMore: true,
				},
			});
			expect(await call({ id: "last", type: "get_entries", since: ids[3], limit: 2 }, "last")).toMatchObject({
				data: { entries: [expect.objectContaining({ id: ids[4] })], hasMore: false },
			});
			expect(
				await call({ id: "missing", type: "get_entries", since: "missing", limit: 2 }, "missing"),
			).toMatchObject({ success: false, errorCode: "not_found" });
			expect(await call({ id: "bad", type: "get_entries", limit: 0 }, "bad")).toMatchObject({
				success: false,
				errorCode: "invalid_argument",
			});
		} finally {
			cleanupListeners();
			harness.cleanup();
		}
	});

	test("session pages search locally and use deterministic path cursors for tied timestamps", async () => {
		const harness = await createHarness();
		const cleanupListeners = await startHost(harness);
		const date = new Date("2026-01-01T00:00:00Z");
		vi.spyOn(SessionManager, "list").mockResolvedValue(
			["c", "a", "b"].map((id) => ({
				id,
				path: `/sessions/${id}.jsonl`,
				cwd: "/project",
				created: date,
				modified: date,
				name: `Name ${id}`,
				messageCount: 2,
				firstMessage: "first",
				allMessagesText: id === "c" ? "unrelated" : "needle",
			})),
		);
		try {
			expect(await call({ id: "first", type: "list_sessions", query: "NEEDLE", limit: 1 }, "first")).toMatchObject({
				data: {
					sessions: [expect.objectContaining({ id: "a" })],
					hasMore: true,
					nextCursor: "/sessions/a.jsonl",
				},
			});
			expect(
				await call(
					{ id: "next", type: "list_sessions", query: "needle", limit: 1, cursor: "/sessions/a.jsonl" },
					"next",
				),
			).toMatchObject({ data: { sessions: [expect.objectContaining({ id: "b" })], hasMore: false } });
			expect(await call({ id: "missing", type: "list_sessions", cursor: "missing" }, "missing")).toMatchObject({
				success: false,
				errorCode: "not_found",
			});
			expect(await call({ id: "bad", type: "list_sessions", query: "x".repeat(257) }, "bad")).toMatchObject({
				success: false,
				errorCode: "invalid_argument",
			});
			const first = replies().find((reply) => reply.id === "first");
			expect(JSON.stringify(first)).not.toContain("allMessagesText");
		} finally {
			cleanupListeners();
			harness.cleanup();
		}
	});
	test("catalog refresh is explicit, cache-only by default, and omits raw failure secrets", async () => {
		const harness = await createHarness();
		const cleanupListeners = await startHost(harness);
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([[harness.getModel().provider, new Error("secret-provider-response")]]),
		});
		try {
			const response = await call(
				{ id: "refresh", type: "refresh_models", providers: [harness.getModel().provider] },
				"refresh",
			);
			expect(refresh).toHaveBeenCalledWith(
				expect.objectContaining({
					allowNetwork: false,
					providers: [harness.getModel().provider],
					signal: expect.any(AbortSignal),
				}),
			);
			expect(response).toMatchObject({
				success: true,
				data: { aborted: false, timedOut: false, errors: [expect.objectContaining({ errorCode: "failed" })] },
			});
			expect(JSON.stringify(response)).not.toContain("secret-provider-response");
			expect(replies()).toContainEqual(expect.objectContaining({ type: "models_changed" }));
			expect(await call({ id: "unknown", type: "refresh_models", providers: ["missing"] }, "unknown")).toMatchObject(
				{ success: false, errorCode: "not_found" },
			);
			expect(await call({ id: "invalid", type: "refresh_models", timeoutMs: 40000 }, "invalid")).toMatchObject({
				success: false,
				errorCode: "invalid_argument",
			});
			vi.stubEnv("ICE_OFFLINE", "1");
			expect(await call({ id: "offline", type: "refresh_models", allowNetwork: true }, "offline")).toMatchObject({
				success: false,
				errorCode: "denied",
			});
			expect(refresh).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllEnvs();
			cleanupListeners();
			harness.cleanup();
		}
	});

	test("catalog refresh deadline and live abort release waiting transitions", async () => {
		const harness = await createHarness();
		const replace = vi.fn(async () => ({ cancelled: true }));
		const cleanupListeners = await startHost(harness, { newSession: replace });
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(async (options) => {
			return new Promise((resolve) => {
				options!.signal!.addEventListener("abort", () => resolve({ aborted: true, errors: new Map() }), {
					once: true,
				});
			});
		});
		try {
			for (const abort of [false, true]) {
				io.lines = [];
				refresh.mockClear();
				replace.mockClear();
				io.input?.(JSON.stringify({ id: "refresh", type: "refresh_models", timeoutMs: abort ? 10000 : 20 }));
				io.input?.(JSON.stringify({ id: "new", type: "new_session" }));
				await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
				if (abort) {
					expect(replace).not.toHaveBeenCalled();
					await call({ id: "abort", type: "abort_models_refresh" }, "abort");
				}
				await vi.waitFor(() => expect(replies().some((reply) => reply.id === "new")).toBe(true));
				expect(replies().find((reply) => reply.id === "refresh")).toMatchObject({
					success: true,
					data: { aborted: true, timedOut: !abort },
				});
				expect(replace).toHaveBeenCalledOnce();
			}
		} finally {
			cleanupListeners();
			harness.cleanup();
		}
	});
	test("provider and all-model introspection uses only cached non-secret status", async () => {
		const harness = await createHarness();
		const cleanupListeners = await startHost(harness);
		const runtime = harness.session.modelRuntime;
		const auth = vi.spyOn(runtime, "getAuth");
		const check = vi.spyOn(runtime, "checkAuth");
		const refresh = vi.spyOn(runtime, "refresh");
		const credentials = vi.spyOn(runtime, "listCredentials");
		const status = vi
			.spyOn(runtime, "getProviderAuthStatus")
			.mockReturnValue({ configured: true, source: "stored", label: "secret-status-label" });
		runtime.getModel(harness.getModel().provider, harness.getModel().id)!.headers = {
			Authorization: "secret-model-header",
		};
		try {
			const providers = await call({ id: "providers", type: "get_providers" }, "providers");
			expect(providers).toMatchObject({
				success: true,
				data: {
					hasCatalogError: false,
					providers: expect.arrayContaining([
						expect.objectContaining({
							id: harness.getModel().provider,
							auth: { configured: true, source: "stored", type: "api_key" },
							modelCount: 1,
						}),
					]),
				},
			});
			expect(JSON.stringify(providers)).not.toMatch(/faux-key|secret-status-label|secret-model-header/);
			const models = await call(
				{ id: "models", type: "get_models", provider: harness.getModel().provider },
				"models",
			);
			expect(models).toMatchObject({
				success: true,
				data: {
					hasCatalogError: false,
					models: [
						expect.objectContaining({
							id: harness.getModel().id,
							contextWindow: harness.getModel().contextWindow,
						}),
					],
				},
			});
			expect(JSON.stringify(models)).not.toContain("secret-model-header");
			expect(await call({ id: "missing", type: "get_models", provider: "missing" }, "missing")).toMatchObject({
				success: false,
				errorCode: "not_found",
			});
			expect(await call({ id: "invalid", type: "get_models", availableOnly: "false" }, "invalid")).toMatchObject({
				success: false,
				errorCode: "invalid_argument",
			});
			for (const spy of [auth, check, refresh, credentials]) expect(spy).not.toHaveBeenCalled();
			expect(status).toHaveBeenCalled();
		} finally {
			cleanupListeners();
			harness.cleanup();
		}
	});
	test("model-change notifications omit current and previous private request headers", async () => {
		const harness = await createHarness({ models: [{ id: "one" }, { id: "two" }] });
		const cleanupListeners = await startHost(harness);
		harness.getModel().headers = { Authorization: "previous-private-header" };
		harness.session.modelRuntime.getModel(harness.getModel().provider, "two")!.headers = {
			Authorization: "next-private-header",
		};
		try {
			await call({ id: "model", type: "set_model", provider: harness.getModel().provider, modelId: "two" }, "model");
			const event = replies().find((reply) => reply.type === "model_changed");
			expect(event).toMatchObject({ model: { id: "two" }, previousModel: { id: "one" } });
			expect(JSON.stringify(event)).not.toMatch(/private-header|"headers"/);
			for (const type of ["get_state", "get_available_models", "cycle_model"] as const) {
				const snapshot = await call({ id: `public:${type}`, type }, `public:${type}`);
				expect(JSON.stringify(snapshot)).not.toMatch(/private-header|"headers"/);
			}
		} finally {
			cleanupListeners();
			harness.cleanup();
		}
	});

	test("streams model, effective configuration, applied-settings and reload notifications", async () => {
		const harness = await createHarness({ models: [{ id: "one" }, { id: "two", reasoning: false }] });
		const cleanupListeners = await startHost(harness);
		try {
			await call({ id: "fast", type: "set_fast_mode", enabled: true }, "fast");
			expect(replies()).toContainEqual(
				expect.objectContaining({
					type: "configuration_changed",
					configuration: expect.objectContaining({ fastMode: true }),
				}),
			);
			await call({ id: "model", type: "set_model", provider: harness.getModel().provider, modelId: "two" }, "model");
			expect(replies()).toContainEqual(
				expect.objectContaining({
					type: "model_changed",
					source: "set",
					model: expect.objectContaining({ id: "two" }),
				}),
			);
			harness.session.syncSettingsFromManager();
			expect(replies()).toContainEqual({ type: "settings_applied" });
			await call({ id: "reload", type: "reload" }, "reload");
			expect(replies()).toContainEqual({ type: "resources_changed", reason: "reload" });
		} finally {
			cleanupListeners();
			harness.cleanup();
		}
	});
	test("rejects malformed mutations without changing settings and survives primitives", async () => {
		const harness = await createHarness();
		const oldEnd = process.stdin.listeners("end") as NodeListener[];
		const bind = vi.spyOn(harness.session, "bindExtensions");
		const oldTerm = process.listeners("SIGTERM");
		const oldHup = process.listeners("SIGHUP");
		const switchSession = vi.fn(async () => ({ cancelled: true }));
		const host = {
			session: harness.session,
			setRebindSession: vi.fn(),
			dispose: vi.fn(async () => {}),
			switchSession,
		} as unknown as AgentSessionRuntime;
		try {
			void runRpcMode(host);
			await vi.waitFor(() => expect(io.input).toBeDefined());
			const ui = bind.mock.calls[0]?.[0]?.uiContext;
			ui?.setWorkingMessage("Preparing...");
			ui?.setWorkingVisible(true);
			ui?.setWorkingIndicator({ frames: ["."], intervalMs: 100 });
			expect(replies()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ method: "setWorkingMessage", message: "Preparing..." }),
					expect.objectContaining({ method: "setWorkingVisible", visible: true }),
					expect.objectContaining({ method: "setWorkingIndicator", options: { frames: ["."], intervalMs: 100 } }),
				]),
			);
			for (const value of [null, 1, "prompt", [], true]) {
				io.input?.(JSON.stringify(value));
			}
			await vi.waitFor(() => expect(replies().filter((r) => r.errorCode === "invalid_request")).toHaveLength(5));
			const before = harness.session.steeringMode;
			for (const [type, fields] of [
				["set_steering_mode", { mode: "broken" }],
				["set_follow_up_mode", { mode: null }],
				["set_thinking_level", { level: "bogus" }],
				["set_auto_retry", { enabled: "false" }],
				["prompt", { message: [], streamingBehavior: "later" }],
				["set_scoped_models", { models: [{ provider: "faux", modelId: "faux", thinkingLevel: "bogus" }] }],
			] as const) {
				expect(await call({ id: type, type, ...fields }, type)).toMatchObject({
					success: false,
					errorCode: "invalid_argument",
				});
			}
			expect(harness.session.steeringMode).toBe(before);
			expect(await call({ id: "unknown", type: "toString" }, "unknown")).toMatchObject({
				success: false,
				errorCode: "unknown_command",
			});
			const discovery = await call({ id: "caps", type: "get_capabilities" }, "caps");
			expect(discovery).toMatchObject({
				success: true,
				data: {
					protocolVersion: 1,
					commands: expect.arrayContaining(["get_shells", "get_queue", "get_command_schema"]),
					limits: { maxInputLineBytes: 16 * 1024 * 1024 },
					host: { subagents: false },
				},
			});
			expect(await call({ id: "think", type: "set_thinking_level", level: "ultra" }, "think")).toMatchObject({
				success: true,
				data: { level: harness.session.thinkingLevel },
			});
			await call({ id: "steer", type: "steer", message: "pending" }, "steer");
			expect(await call({ id: "queue", type: "get_queue" }, "queue")).toMatchObject({
				success: true,
				data: { steering: ["pending"], followUp: [] },
			});
			expect(await call({ id: "clear", type: "clear_queue" }, "clear")).toMatchObject({
				success: true,
				data: { steering: ["pending"], followUp: [] },
			});
			expect(harness.session.pendingMessageCount).toBe(0);
			await call(
				{ id: "switch", type: "switch_session", sessionPath: "saved.jsonl", cwd: harness.tempDir },
				"switch",
			);
			expect(switchSession).toHaveBeenCalledWith("saved.jsonl", { cwdOverride: harness.tempDir });
			expect(await call({ id: "state", type: "get_state" }, "state")).toMatchObject({
				success: true,
				data: {
					leafId: harness.sessionManager.getLeafId(),
					persisted: false,
					sessionDir: harness.sessionManager.getSessionDir(),
				},
			});
		} finally {
			harness.cleanup();
			for (const listener of process.stdin.listeners("end") as NodeListener[])
				if (!oldEnd.includes(listener)) process.stdin.off("end", listener);
			for (const listener of process.listeners("SIGTERM"))
				if (!oldTerm.includes(listener)) process.off("SIGTERM", listener);
			for (const listener of process.listeners("SIGHUP"))
				if (!oldHup.includes(listener)) process.off("SIGHUP", listener);
		}
	});
});
