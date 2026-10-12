import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { RpcClient, type RpcEvent, RpcRequestError } from "../src/modes/rpc/rpc-client.ts";

async function withClient(script: string, run: (client: RpcClient) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "ice-rpc-contract-"));
	const path = join(dir, "child.mjs");
	writeFileSync(path, script);
	const client = new RpcClient({ cliPath: path });
	try {
		await client.start();
		await run(client);
	} finally {
		await client.stop();
		rmSync(dir, { recursive: true, force: true });
	}
}

const capabilities = {
	protocolVersion: 1,
	commands: ["get_capabilities"],
	features: [],
	limits: { maxInputLineBytes: 16 * 1024 * 1024 },
	host: { subagents: false },
};
const handshakeScript = `
import { createInterface } from "node:readline";
createInterface({input:process.stdin}).on("line", (line) => {
 const command = JSON.parse(line);
 if (command.type === "get_capabilities") process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data:${JSON.stringify(capabilities)}}) + "\\n");
});
`;

const responseData = {
	get_capabilities: capabilities,
	get_state: {
		thinkingLevel: "off",
		fastMode: false,
		fastModeAvailable: false,
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "fixture",
		leafId: null,
		sessionDir: "/tmp",
		persisted: false,
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
		cwd: "/tmp",
		autoRetryEnabled: false,
		isRetrying: false,
		retryAttempt: 0,
		isBashRunning: false,
		backgroundShellCount: 0,
	},
	compact: { summary: "fixture", firstKeptEntryId: "entry", tokensBefore: 1, estimatedTokensAfter: 1 },
	navigate_tree: { cancelled: false },
	bash: { output: "fixture", exitCode: 0, cancelled: false, truncated: false },
	cycle_model: null,
	switch_session: { cancelled: false },
	set_thinking_level: { level: "low" },
	get_queue: { steering: [], followUp: [] },
	clear_queue: { steering: [], followUp: [] },
	get_providers: { providers: [], hasCatalogError: false },
	get_models: { models: [], hasCatalogError: false },
	get_available_models: { models: [], hasMore: false },
	refresh_models: { aborted: false, timedOut: false, errors: [], hasCatalogError: false },
	get_entries: { entries: [], leafId: null, hasMore: false },
	list_sessions: { sessions: [], hasMore: false },
	get_diagnostics: { diagnostics: [], truncated: false },
	get_ui_state: { statuses: [], widgets: [], truncated: false },
	get_completions: { items: [], hasMore: false },
	get_messages: { messages: [], snapshot: "fixture", hasMore: false },
	get_tree: { tree: [], leafId: null, hasMore: false },
};

const echoScript = `
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
 const command = JSON.parse(line);
 process.stdout.write(JSON.stringify({type:"observed", command}) + "\\n");
 const data = (${JSON.stringify(responseData)})[command.type];
 process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, success:true, ...(data === undefined ? {} : {data})}) + "\\n");
});
`;

const cancellationScript = `
import { createInterface } from "node:readline";
const active = new Map();
function reply(command, result) { process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, ...result}) + "\\n"); }
createInterface({input:process.stdin}).on("line", (line) => {
 const command = JSON.parse(line);
 process.stdout.write(JSON.stringify({type:"observed", command}) + "\\n");
 if (command.type === "get_capabilities") reply(command, {success:true, data:${JSON.stringify(capabilities)}});
 else if (command.type === "cancel_request") {
  const target = active.get(command.requestId); active.delete(command.requestId);
  reply(command, {success:true, data:{accepted:!!target}});
  if (target) reply(target, {success:false, error:"cancelled", errorCode:"cancelled"});
 } else if (["compact", "navigate_tree", "bash"].includes(command.type)) active.set(command.id, command);
 else reply(command, {success:true, data:(${JSON.stringify(responseData)})[command.type]});
});
`;

describe("RpcClient command contract", () => {
	test("bounds retained requests while reserving capacity for cancellation", async () => {
		const script = handshakeScript.replace(
			"});",
			` else if (command.type === "cancel_request") process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data:{accepted:false}}) + "\\n");\n});`,
		);
		await withClient(script, async (client) => {
			const pending = Array.from({ length: 256 }, () => client.getState().catch((error: unknown) => error));
			await expect(client.getState()).rejects.toMatchObject({ errorCode: "busy" });
			expect(await client.cancelRequest("unknown")).toBe(false);
			await client.stop();
			await Promise.all(pending);
			expect((client as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size).toBe(0);
		});
	});

	test("rejects oversized submission before writing and bounds event collection", async () => {
		await withClient(echoScript, async (client) => {
			const seen: unknown[] = [];
			client.onEvent((event) => seen.push(event));
			await expect(client.prompt("x".repeat(16 * 1024 * 1024))).rejects.toMatchObject({
				errorCode: "input_too_large",
			});
			await client.getState();
			expect(seen).toHaveLength(1);
		});
		const client = new RpcClient();
		const callers = Array.from({ length: 4 }, () => new AbortController());
		const collections = callers.map((caller) =>
			client.collectEvents(10000, caller.signal).catch((error: unknown) => error),
		);
		await expect(client.collectEvents()).rejects.toMatchObject({ errorCode: "busy" });
		for (const caller of callers) caller.abort();
		await Promise.all(collections);
		const collection = expect(client.collectEvents()).rejects.toMatchObject({ errorCode: "output_overflow" });
		const handle = (client as unknown as { handleLine(line: string): void }).handleLine.bind(client);
		const event = JSON.stringify({ type: "fixture", text: "x".repeat(512 * 1024) });
		for (let i = 0; i < 33; i++) handle(event);
		await collection;
		expect((client as unknown as { eventListeners: unknown[] }).eventListeners).toHaveLength(0);
	});
	test.each(["compact", "navigate_tree", "bash"] as const)(
		"%s caller signals send targeted cancellation and clean pending work",
		async (type) => {
			await withClient(cancellationScript, async (client) => {
				const observed: Array<{ type?: string; id?: string; requestId?: string }> = [];
				client.onEvent((event) => {
					const command = (event as unknown as { command?: { type?: string; id?: string; requestId?: string } })
						.command;
					if (command) observed.push(command);
				});
				const caller = new AbortController();
				const remove = vi.spyOn(caller.signal, "removeEventListener");
				const operation =
					type === "compact"
						? client.compact("instructions", { signal: caller.signal })
						: type === "navigate_tree"
							? client.navigateTree("entry", { signal: caller.signal })
							: client.bash("synthetic", { signal: caller.signal });
				const rejected = expect(operation).rejects.toMatchObject({ errorCode: "cancelled", command: type });
				await vi.waitFor(() => expect(observed.some((command) => command.type === type)).toBe(true));
				caller.abort();
				await rejected;
				await client.getState();
				expect(observed.find((command) => command.type === "cancel_request")).toMatchObject({
					requestId: observed.find((command) => command.type === type)!.id,
				});
				expect(observed.filter((command) => command.type === type)).toHaveLength(1);
				expect(JSON.stringify(observed)).not.toContain('"signal"');
				expect((client as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size).toBe(0);
				expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
			});
		},
	);

	test("operation deadlines are transmitted and caller listeners detach after success", async () => {
		await withClient(echoScript, async (client) => {
			const observed: unknown[] = [];
			client.onEvent((event) => observed.push(event));
			const caller = new AbortController();
			const remove = vi.spyOn(caller.signal, "removeEventListener");
			await client.compact("instructions", { timeoutMs: 300000, signal: caller.signal });
			await client.navigateTree("entry", { timeoutMs: 20, signal: caller.signal, summarize: true });
			await client.bash("synthetic", { timeoutMs: 10, signal: caller.signal, excludeFromContext: true });
			caller.abort();
			await client.getState();
			expect(observed.slice(0, 3)).toEqual([
				{
					type: "observed",
					command: { id: "req_1", type: "compact", customInstructions: "instructions", timeoutMs: 300000 },
				},
				{
					type: "observed",
					command: { id: "req_2", type: "navigate_tree", targetId: "entry", summarize: true, timeoutMs: 20 },
				},
				{
					type: "observed",
					command: { id: "req_3", type: "bash", command: "synthetic", excludeFromContext: true, timeoutMs: 10 },
				},
			]);
			expect(JSON.stringify(observed)).not.toMatch(/cancel_request|"signal"/);
			expect(remove).toHaveBeenCalledTimes(3);
		});
	});

	test("already-aborted signals and invalid operation deadlines never write a command", async () => {
		await withClient(echoScript, async (client) => {
			const observed: unknown[] = [];
			client.onEvent((event) => observed.push(event));
			const caller = new AbortController();
			caller.abort();
			await expect(client.bash("must not execute", { signal: caller.signal })).rejects.toMatchObject({
				errorCode: "cancelled",
			});
			await expect(client.compact(undefined, { timeoutMs: 300001 })).rejects.toMatchObject({
				errorCode: "invalid_argument",
			});
			await expect(client.navigateTree("entry", { timeoutMs: 0 })).rejects.toMatchObject({
				errorCode: "invalid_argument",
			});
			await client.getState();
			expect(observed).toHaveLength(1);
		});
	});

	test("a response timeout sends cancellation without pretending remote settlement", async () => {
		await withClient(cancellationScript, async (client) => {
			const observed: unknown[] = [];
			client.onEvent((event) => observed.push(event));
			vi.useFakeTimers();
			try {
				const rejected = expect(client.bash("synthetic", { timeoutMs: 10 })).rejects.toMatchObject({
					errorCode: "timeout",
				});
				await vi.waitFor(() => expect(observed).toHaveLength(1));
				await vi.advanceTimersByTimeAsync(5010);
				await rejected;
				await client.getState();
				expect(observed).toContainEqual({
					type: "observed",
					command: { id: "req_2", type: "cancel_request", requestId: "req_1" },
				});
				expect((client as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	test("startup waits for a capability response rather than a fixed initialization delay", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ice-rpc-ready-"));
		const path = join(dir, "child.mjs");
		writeFileSync(
			path,
			`
import { createInterface } from "node:readline";
createInterface({input:process.stdin}).on("line", (line) => {
 const command = JSON.parse(line);
 process.stdout.write(JSON.stringify({type:"session_info_changed", name:"initializing"}) + "\\n");
 setTimeout(() => process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data:${JSON.stringify(capabilities)}}) + "\\n"), 250);
});
`,
		);
		const client = new RpcClient({ cliPath: path, startupTimeoutMs: 2000 });
		let started = false;
		let initializing = false;
		client.onEvent((event) => {
			if (event.type === "session_info_changed") initializing = true;
		});
		try {
			const startup = client.start().then(() => {
				started = true;
			});
			await vi.waitFor(() => expect(initializing).toBe(true));
			expect(started).toBe(false);
			await startup;
			expect(started).toBe(true);
		} finally {
			await client.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("startup rejects malformed capability data and silence, cleaning the spawned process", async () => {
		for (const script of [
			"process.stdin.resume();",
			echoScript.replace(JSON.stringify(capabilities), "null"),
			echoScript.replace('"features":[]', '"features":null'),
			echoScript.replace('"protocolVersion":1', '"protocolVersion":2'),
		]) {
			const dir = mkdtempSync(join(tmpdir(), "ice-rpc-start-fail-"));
			const path = join(dir, "child.mjs");
			writeFileSync(path, script);
			const client = new RpcClient({ cliPath: path, startupTimeoutMs: 200 });
			try {
				await expect(client.start()).rejects.toThrow(/Timeout|Invalid RPC capability|Invalid RPC response/);
				expect((client as unknown as { process: unknown }).process).toBeNull();
				expect((client as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size).toBe(0);
			} finally {
				await client.stop();
				rmSync(dir, { recursive: true, force: true });
			}
		}
		await expect(new RpcClient({ startupTimeoutMs: 0 }).start()).rejects.toThrow("startupTimeoutMs");
	});
	test("rejects mismatched response commands instead of resolving with unrelated data", async () => {
		await withClient(
			`
import { createInterface } from "node:readline";
createInterface({input:process.stdin}).on("line", (line) => {
 const command = JSON.parse(line);
 process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type === "get_capabilities" ? command.type : "wrong-command", success:true, data:${JSON.stringify(capabilities)}}) + "\\n");
});
`,
			async (client) => {
				await expect(client.getState()).rejects.toMatchObject({
					errorCode: "invalid_response",
					command: "get_state",
				});
			},
		);
	});

	test("throwing subscribers and reporters do not hide events or skip other listeners", async () => {
		const onListenerError = vi.fn((_error: Error, _event: RpcEvent) => {
			throw new Error("reporter failed");
		});
		const client = new RpcClient({ onListenerError });
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		client.onEvent(() => {
			throw new Error("subscriber failed");
		});
		const seen: unknown[] = [];
		client.onEvent((event) => seen.push(event));
		const handle = (client as unknown as { handleLine(line: string): void }).handleLine.bind(client);
		try {
			for (const line of ["not json", "null", "[]", '{"type":"response","id":"late","success":true}']) handle(line);
			handle('{"type":"shells_update","shells":[]}');
			handle('{"type":"extension_ui_request","id":"dialog","method":"confirm","title":"T","message":"M"}');
			expect(seen).toHaveLength(2);
			expect(onListenerError).toHaveBeenCalledTimes(2);
			expect(onListenerError.mock.calls[0]?.[0]).toMatchObject({ message: "subscriber failed" });
		} finally {
			stderr.mockRestore();
		}
	});

	test("writes extension dialog replies without overwriting IDs or leaking pending requests", async () => {
		await withClient(echoScript, async (client) => {
			const observed: unknown[] = [];
			client.onEvent((event) => observed.push(event));
			for (const fields of [{ confirmed: true }, { value: "chosen" }, { cancelled: true as const }]) {
				await client.respondToExtensionUI({ type: "extension_ui_response", id: "dialog-id", ...fields });
			}
			await client.getState(); // Flush the child's preceding input records.
			expect(observed.slice(0, 3)).toEqual([
				{ type: "observed", command: { type: "extension_ui_response", id: "dialog-id", confirmed: true } },
				{ type: "observed", command: { type: "extension_ui_response", id: "dialog-id", value: "chosen" } },
				{ type: "observed", command: { type: "extension_ui_response", id: "dialog-id", cancelled: true } },
			]);
			expect((client as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size).toBe(0);
		});
		await expect(
			new RpcClient().respondToExtensionUI({ type: "extension_ui_response", id: "x", cancelled: true }),
		).rejects.toThrow("Client not started");
	});

	test("retains bounded per-process stderr and rejects pending work on stop", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ice-rpc-stderr-"));
		const path = join(dir, "child.mjs");
		writeFileSync(path, `${handshakeScript}\nprocess.stderr.write("x".repeat(100000));`);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const client = new RpcClient({ cliPath: path });
		try {
			await client.start();
			await vi.waitFor(() => expect(client.getStderr()).toHaveLength(64 * 1024));
			const request = client.getState();
			const rejected = expect(request).rejects.toThrow("RPC client stopped");
			await client.stop();
			await rejected;
			writeFileSync(path, handshakeScript);
			await client.start();
			expect(client.getStderr()).toBe("");
		} finally {
			await client.stop();
			stderr.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("stop rejects active idle/event collectors and removes their timers and subscriptions", async () => {
		await withClient(echoScript, async (client) => {
			const idle = expect(client.waitForIdle()).rejects.toThrow("RPC client stopped");
			const events = expect(client.collectEvents()).rejects.toThrow("RPC client stopped");
			await client.stop();
			await Promise.all([idle, events]);
			expect((client as unknown as { eventListeners: unknown[] }).eventListeners).toHaveLength(0);
			await expect(client.waitForIdle()).rejects.toThrow("RPC client stopped");
		});
	});

	test("a collector unsubscribing cannot starve another idle waiter", async () => {
		const client = new RpcClient();
		const events = client.collectEvents(100);
		const idle = client.waitForIdle(100);
		(client as unknown as { handleLine(line: string): void }).handleLine('{"type":"agent_settled"}');
		await expect(events).resolves.toEqual([{ type: "agent_settled" }]);
		await expect(idle).resolves.toBeUndefined();
	});

	test("all void wrappers reject server errors with structured details", async () => {
		await withClient(
			`
import { createInterface } from "node:readline";
createInterface({input:process.stdin}).on("line", (line) => {
 const command = JSON.parse(line);
 const result = command.type === "get_capabilities" ? {success:true, data:${JSON.stringify(capabilities)}} : {success:false, error:"Rejected", errorCode:"busy", errorDetails:{field:"mode"}};
 process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, ...result}) + "\\n");
});
`,
			async (client) => {
				for (const invoke of [
					() => client.prompt("hello"),
					() => client.steer("hello"),
					() => client.followUp("hello"),
					() => client.abort(),
					() => client.setFastMode(true),
					() => client.setSteeringMode("all"),
					() => client.setFollowUpMode("all"),
					() => client.setAutoCompaction(true),
					() => client.setAutoRetry(true),
					() => client.abortRetry(),
					() => client.abortBash(),
					() => client.abortCompaction(),
					() => client.abortBranchSummary(),
					() => client.abortModelsRefresh(),
					() => client.setSessionName("name"),
					() => client.setEntryLabel("entry"),
					() => client.reload(),
					() => client.stopAfterTurn(),
				]) {
					await expect(invoke()).rejects.toBeInstanceOf(RpcRequestError);
				}
				await expect(client.promptAndWait("rejected")).rejects.toBeInstanceOf(RpcRequestError);
				expect((client as unknown as { eventListeners: unknown[] }).eventListeners).toHaveLength(0);
				await expect(client.getState()).rejects.toMatchObject({
					errorCode: "busy",
					errorDetails: { field: "mode" },
					command: "get_state",
				});
			},
		);
	});

	test("forwards cached provider and filtered model queries", async () => {
		await withClient(echoScript, async (client) => {
			const observed: unknown[] = [];
			client.onEvent((event) => observed.push(event));
			await client.getProviders();
			await client.getModels({ provider: "faux", availableOnly: true });
			await client.refreshModels({ providers: ["faux"], allowNetwork: true, force: true, timeoutMs: 30000 });
			await client.abortModelsRefresh();
			await client.getEntries("entry", 10);
			await client.listSessionsPage({ scope: "all", cursor: "path", limit: 20, query: "needle" });
			await expect(client.refreshModels({ timeoutMs: 40000 })).rejects.toMatchObject({
				errorCode: "invalid_argument",
			});
			expect(observed).toEqual([
				{ type: "observed", command: { id: "req_1", type: "get_providers" } },
				{ type: "observed", command: { id: "req_2", type: "get_models", provider: "faux", availableOnly: true } },
				{
					type: "observed",
					command: {
						id: "req_3",
						type: "refresh_models",
						providers: ["faux"],
						allowNetwork: true,
						force: true,
						timeoutMs: 30000,
					},
				},
				{ type: "observed", command: { id: "req_4", type: "abort_models_refresh" } },
				{ type: "observed", command: { id: "req_5", type: "get_entries", since: "entry", limit: 10 } },
				{
					type: "observed",
					command: {
						id: "req_6",
						type: "list_sessions",
						scope: "all",
						cursor: "path",
						limit: 20,
						query: "needle",
					},
				},
			]);
		});
	});

	test("forwards prompt, bash, direction, cwd and discovery options over the wire", async () => {
		await withClient(echoScript, async (client) => {
			const observed: unknown[] = [];
			client.onEvent((event) => observed.push(event));
			await client.prompt("/literal", undefined, { streamingBehavior: "followUp", expandPromptTemplates: false });
			await client.bash("echo ok", { excludeFromContext: true });
			await client.cycleModel("backward");
			await client.switchSession("old.jsonl", "/tmp");
			expect(await client.setThinkingLevel("ultra")).toEqual({ level: "low" });
			await client.getCapabilities();
			await client.getQueue();
			await client.clearQueue();
			expect(observed).toEqual([
				{
					type: "observed",
					command: {
						id: "req_1",
						type: "prompt",
						message: "/literal",
						streamingBehavior: "followUp",
						expandPromptTemplates: false,
					},
				},
				{ type: "observed", command: { id: "req_2", type: "bash", command: "echo ok", excludeFromContext: true } },
				{ type: "observed", command: { id: "req_3", type: "cycle_model", direction: "backward" } },
				{
					type: "observed",
					command: { id: "req_4", type: "switch_session", sessionPath: "old.jsonl", cwd: "/tmp" },
				},
				{ type: "observed", command: { id: "req_5", type: "set_thinking_level", level: "ultra" } },
				{ type: "observed", command: { id: "req_6", type: "get_capabilities" } },
				{ type: "observed", command: { id: "req_7", type: "get_queue" } },
				{ type: "observed", command: { id: "req_8", type: "clear_queue" } },
			]);
		});
	});
});
