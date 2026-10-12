import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

const io = vi.hoisted(() => ({
	lines: [] as string[],
	failure: undefined as "output_overflow" | "output_too_large" | undefined,
}));
vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	configureRawStdoutLimit: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		if (io.failure) {
			const code = io.failure;
			io.failure = undefined;
			throw Object.assign(new Error("synthetic output limit"), { code });
		}
		io.lines.push(line);
	},
}));
vi.mock("../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

const harnesses: Harness[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
	io.lines = [];
	io.failure = undefined;
});

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const records = () => io.lines.map((line) => JSON.parse(line) as Record<string, unknown>);

async function start(harness: Harness, methods: Partial<AgentSessionRuntime> = {}) {
	const input = new PassThrough();
	vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
	const exits = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
	const previousTerm = process.listeners("SIGTERM");
	const previousHup = process.listeners("SIGHUP");
	const dispose = vi.fn(async () => {});
	const host = {
		session: harness.session,
		setRebindSession: vi.fn(),
		dispose,
		...methods,
	} as unknown as AgentSessionRuntime;
	void runRpcMode(host);
	await vi.waitFor(() => expect(input.listenerCount("data")).toBe(1));
	cleanups.push(() => {
		input.removeAllListeners();
		input.destroy();
		for (const listener of process.listeners("SIGTERM"))
			if (!previousTerm.includes(listener)) process.off("SIGTERM", listener);
		for (const listener of process.listeners("SIGHUP"))
			if (!previousHup.includes(listener)) process.off("SIGHUP", listener);
	});
	return {
		input,
		exits,
		dispose,
		signal: process.listeners("SIGTERM").find((listener) => !previousTerm.includes(listener))!,
	};
}

describe("RPC shutdown settlement", () => {
	test("startup dialogs can receive replies before binding settles, while readiness waits", async () => {
		let answer: boolean | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.on("session_start", async (_event, ctx) => {
						answer = await ctx.ui.confirm("Startup", "Approve startup");
					});
				},
			],
		});
		harnesses.push(harness);
		const { input, exits } = await start(harness);
		input.write(`${JSON.stringify({ id: "ready", type: "get_capabilities" })}\n`);
		await vi.waitFor(() => expect(records().some((record) => record.method === "confirm")).toBe(true));
		expect(records().some((record) => record.id === "ready")).toBe(false);
		const dialog = records().find((record) => record.method === "confirm")!;
		input.write(`${JSON.stringify({ type: "extension_ui_response", id: dialog.id, confirmed: true })}\n`);
		await vi.waitFor(() => expect(records().some((record) => record.id === "ready")).toBe(true));
		expect(answer).toBe(true);
		input.end();
		await vi.waitFor(() => expect(exits).toHaveBeenCalledWith(0));
	});
	test("an oversized response becomes one small error without replaying or stopping the host", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { input, dispose, exits } = await start(harness);
		io.failure = "output_too_large";
		input.write(`${JSON.stringify({ id: "big", type: "get_state" })}\n`);
		await vi.waitFor(() => expect(records().some((record) => record.id === "big")).toBe(true));
		expect(records().filter((record) => record.id === "big")).toEqual([
			expect.objectContaining({ success: false, errorCode: "output_too_large" }),
		]);
		expect(dispose).not.toHaveBeenCalled();
		expect(exits).not.toHaveBeenCalled();
		input.end();
		await vi.waitFor(() => expect(exits).toHaveBeenCalledWith(0));
	});

	test("streamed output overflow closes transport instead of silently dropping state", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { exits, dispose } = await start(harness);
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		io.failure = "output_overflow";
		harness.session.setSessionName("effect remains committed");
		await vi.waitFor(() => expect(exits).toHaveBeenCalledWith(1));
		expect(harness.session.sessionName).toBe("effect remains committed");
		expect(dispose).toHaveBeenCalledOnce();
	});
	test("EOF consumes an unterminated record and flushes its response before disposal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { input, exits, dispose } = await start(harness);
		input.end(JSON.stringify({ id: "last", type: "get_state" }));
		await vi.waitFor(() => expect(exits).toHaveBeenCalledWith(0));
		expect(records().filter((record) => record.id === "last")).toEqual([
			expect.objectContaining({ success: true, command: "get_state" }),
		]);
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("EOF cancels queued commands, settles active hooks, and never disposes beneath them", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const delayed = gate();
		const reload = vi.spyOn(harness.session, "reload").mockImplementation(() => delayed.promise);
		const prompt = vi.spyOn(harness.session, "prompt");
		const { input, exits, dispose } = await start(harness);
		input.write(`${JSON.stringify({ id: "active", type: "reload" })}\n`);
		input.write(`${JSON.stringify({ id: "queued", type: "prompt", message: "never start" })}\n`);
		input.end();
		await vi.waitFor(() => expect(input.isPaused()).toBe(true));
		expect(dispose).not.toHaveBeenCalled();
		expect(exits).not.toHaveBeenCalled();
		delayed.resolve();
		await vi.waitFor(() => expect(exits).toHaveBeenCalledWith(0));
		expect(reload).toHaveBeenCalledOnce();
		expect(prompt).not.toHaveBeenCalled();
		expect(records().filter((record) => record.id === "queued")).toEqual([
			expect.objectContaining({ success: false, errorCode: "cancelled" }),
		]);
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("EOF resolves unavailable dialogs as cancellation without starting a delayed prompt", async () => {
		const entered = gate();
		const release = gate();
		let answer: boolean | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.on("input", async (_event, ctx) => {
						entered.resolve();
						answer = await ctx.ui.confirm("Wait?", "A closed input cannot answer");
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		const { input, exits, dispose } = await start(harness);
		input.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: "hello" })}\n`);
		await entered.promise;
		await vi.waitFor(() => expect(records().some((record) => record.method === "confirm")).toBe(true));
		input.end();
		await vi.waitFor(() => expect(answer).toBe(false));
		expect(dispose).not.toHaveBeenCalled();
		release.resolve();
		await vi.waitFor(() => expect(exits).toHaveBeenCalledWith(0));
		expect(harness.faux.state.callCount).toBe(0);
		expect(records().filter((record) => record.id === "prompt")).toEqual([
			expect.objectContaining({ success: false, errorCode: "cancelled" }),
		]);
	});

	test("repeated signals share one settlement path instead of exiting early", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const delayed = gate();
		vi.spyOn(harness.session, "reload").mockImplementation(() => delayed.promise);
		const { input, exits, dispose, signal } = await start(harness);
		input.write(`${JSON.stringify({ id: "reload", type: "reload" })}\n`);
		signal("SIGTERM");
		signal("SIGTERM");
		expect(dispose).not.toHaveBeenCalled();
		expect(exits).not.toHaveBeenCalled();
		delayed.resolve();
		await vi.waitFor(() => expect(exits).toHaveBeenCalledWith(143));
		expect(exits).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
	});
});
