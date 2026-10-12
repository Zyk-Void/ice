import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@zykairotis/ice-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	configureRawStdoutLimit: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

// Never move test files into the user's real trash: report `trash` as unavailable so deletion unlinks.
vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return {
		...actual,
		execFile: ((command: string, ...rest: unknown[]) => {
			if (command !== "trash") return (actual.execFile as (...args: unknown[]) => unknown)(command, ...rest);
			const callback = rest[rest.length - 1] as (error: Error, stdout: string, stderr: string) => void;
			queueMicrotask(() => callback(new Error("trash unavailable"), "", ""));
			return undefined;
		}) as typeof actual.execFile,
	};
});

vi.mock("../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

interface ListenerSnapshot {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
}

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) process.off(signal, listener);
		}
	}
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		importFromJsonl: vi.fn(async () => ({ cancelled: true })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

interface Reply {
	success: boolean;
	command: string;
	data?: any;
	error?: string;
	errorCode?: string;
}

let nextId = 0;
async function call(command: Record<string, unknown>): Promise<Reply> {
	const id = `c${nextId++}`;
	rpcIo.lineHandler?.(JSON.stringify({ id, ...command }));
	let reply: Reply | undefined;
	await vi.waitFor(() => {
		reply = parseOutputLines().find((line) => line.id === id) as Reply | undefined;
		expect(reply).toBeDefined();
	});
	return reply as Reply;
}

async function withRpc(
	run: (harness: Harness) => Promise<void>,
	options: Parameters<typeof createHarness>[0] = {},
): Promise<void> {
	const listenerSnapshot = takeListenerSnapshot();
	const harness = await createHarness(options);
	try {
		void runRpcMode(createRuntimeHost(harness));
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		// The readiness handshake resolves only after session binding and event subscriptions.
		await call({ type: "get_capabilities" });
		await run(harness);
	} finally {
		harness.cleanup();
		restoreListeners(listenerSnapshot);
	}
}

describe("RPC session introspection", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("get_state reports cwd, context, retry, and shell state", async () => {
		await withRpc(async (harness) => {
			const reply = await call({ type: "get_state" });
			expect(reply.success).toBe(true);
			expect(reply.data).toMatchObject({
				cwd: harness.sessionManager.getCwd(),
				autoRetryEnabled: harness.session.autoRetryEnabled,
				isRetrying: false,
				retryAttempt: 0,
				isBashRunning: false,
				backgroundShellCount: 0,
			});
		});
	});

	test("lists tools with their active flag and validates set_active_tools", async () => {
		await withRpc(async (harness) => {
			const listed = await call({ type: "get_tools" });
			const tools = listed.data.tools as Array<{ name: string; active: boolean; parameters: unknown }>;
			expect(tools.length).toBeGreaterThan(0);
			for (const tool of tools) {
				expect(tool.active).toBe(harness.session.getActiveToolNames().includes(tool.name));
			}

			const unknown = await call({ type: "set_active_tools", toolNames: ["no-such-tool"] });
			expect(unknown).toMatchObject({ success: false, error: "Unknown tools: no-such-tool" });
			const malformed = await call({ type: "set_active_tools", toolNames: "read" });
			expect(malformed.success).toBe(false);

			const keep = tools.find((tool) => tool.active)?.name ?? "";
			const set = await call({ type: "set_active_tools", toolNames: [keep] });
			expect(set.success).toBe(true);
			expect(set.data.active).toContain(keep);
			expect(harness.session.getActiveToolNames()).toContain(keep);
		});
	});

	test("reads the system prompt, resources, and changelog without file contents", async () => {
		await withRpc(async (harness) => {
			const prompt = await call({ type: "get_system_prompt" });
			expect(prompt.data.text).toBe(harness.session.systemPrompt);

			const resources = await call({ type: "get_resources" });
			expect(resources.success).toBe(true);
			expect(resources.data).toMatchObject({
				contextFiles: expect.any(Array),
				skills: expect.any(Array),
				prompts: expect.any(Array),
				themes: expect.any(Array),
				extensions: expect.any(Array),
				diagnostics: expect.any(Array),
			});
			expect(JSON.stringify(resources.data)).not.toContain('"content"');

			const changelog = await call({ type: "get_changelog" });
			expect(changelog.success).toBe(true);
			expect(changelog.data.entries).toBeInstanceOf(Array);
		});
	});

	test("sets and reads scoped models, rejecting unknown models", async () => {
		await withRpc(async (harness) => {
			const model = harness.getModel();
			const set = await call({
				type: "set_scoped_models",
				models: [{ provider: model.provider, modelId: model.id, thinkingLevel: "low" }],
			});
			expect(set.data.models).toEqual([{ provider: model.provider, modelId: model.id, thinkingLevel: "low" }]);
			expect(harness.session.scopedModels.map((scoped) => scoped.model.id)).toEqual([model.id]);
			expect((await call({ type: "get_scoped_models" })).data.models).toEqual(set.data.models);

			const unknown = await call({ type: "set_scoped_models", models: [{ provider: "nope", modelId: "nope" }] });
			expect(unknown).toMatchObject({ success: false, error: "Model not found: nope/nope" });
			expect(harness.session.scopedModels).toHaveLength(1);

			await call({ type: "set_scoped_models", models: [] });
			expect(harness.session.scopedModels).toHaveLength(0);
		});
	});

	test("exports the branch as JSONL and rejects invalid session arguments", async () => {
		await withRpc(async (harness) => {
			const target = join(harness.tempDir, "export", "branch.jsonl");
			const exported = await call({ type: "export_jsonl", outputPath: target });
			expect(exported.data.path).toBe(target);
			expect(existsSync(target)).toBe(true);
			expect(JSON.parse(readFileSync(target, "utf-8").split("\n")[0]!)).toMatchObject({ type: "session" });

			expect((await call({ type: "list_sessions", scope: "everything" })).success).toBe(false);
			expect((await call({ type: "import_session" })).success).toBe(false);
			expect((await call({ type: "navigate_tree", targetId: "missing" })).error).toBe("Entry missing not found");
			expect((await call({ type: "set_entry_label", entryId: "missing", label: "x" })).error).toBe(
				"Entry missing not found",
			);
		});
	});

	test("labels an entry and navigates the tree to it", async () => {
		await withRpc(async (harness) => {
			harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			await harness.session.prompt("first");
			await harness.session.prompt("second");
			const entries = harness.sessionManager.getEntries();
			const first = entries.find((entry) => entry.type === "message" && entry.message.role === "user")!;

			const labeled = await call({ type: "set_entry_label", entryId: first.id, label: "  start  " });
			expect(labeled.data).toEqual({ entryId: first.id });
			expect(harness.sessionManager.getLabel(first.id)).toBe("start");
			await call({ type: "set_entry_label", entryId: first.id });
			expect(harness.sessionManager.getLabel(first.id)).toBeUndefined();

			const navigated = await call({ type: "navigate_tree", targetId: first.id });
			expect(navigated.success).toBe(true);
			// Selecting a user message rewinds to its parent and hands back the text for re-editing.
			expect(navigated.data).toMatchObject({ cancelled: false, editorText: "first" });
			expect(harness.sessionManager.getLeafId()).toBeNull();
		});
	});

	test("lists sessions for the working directory", async () => {
		await withRpc(
			async () => {
				const reply = await call({ type: "list_sessions" });
				expect(reply.success).toBe(true);
				expect(reply.data.sessions).toBeInstanceOf(Array);
				for (const info of reply.data.sessions) {
					expect(info).not.toHaveProperty("allMessagesText");
					expect(typeof info.modified).toBe("string");
				}
			},
			{ persistSession: true },
		);
	});

	test("reloads when idle, stops after the turn, and aborts idle operations", async () => {
		await withRpc(async () => {
			expect((await call({ type: "stop_after_turn" })).success).toBe(true);
			expect((await call({ type: "abort_compaction" })).success).toBe(true);
			expect((await call({ type: "abort_branch_summary" })).success).toBe(true);
			expect((await call({ type: "reload" })).success).toBe(true);
		});
	});
});

describe("RPC background shells", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	function adoptShell(harness: Harness, initialOutput: string) {
		const abort = vi.fn();
		const taskId = harness.session.bashBackground.adopt(
			"sleep 100",
			Date.now(),
			abort,
			new Promise<{ text: string; isError: boolean }>(() => {}),
			{ origin: "user", initialOutput },
		);
		return { taskId, abort };
	}

	test("lists shells without output and follows output without consuming the model cursor", async () => {
		await withRpc(async (harness) => {
			const { taskId } = adoptShell(harness, "hello ");

			const listed = await call({ type: "get_shells" });
			expect(listed.data.shells).toHaveLength(1);
			expect(listed.data.shells[0]).toMatchObject({ taskId, status: "running", origin: "user", totalChars: 6 });
			expect(listed.data.shells[0]).not.toHaveProperty("output");

			harness.session.bashBackground.appendOutput(taskId, "world");
			const first = await call({ type: "get_shell", shellId: taskId });
			expect(first.data).toMatchObject({ output: "hello world", outputOffset: 0 });
			const next = await call({ type: "get_shell", shellId: taskId, sinceChars: 6 });
			expect(next.data).toMatchObject({ output: "world", outputOffset: 6 });
			const past = await call({ type: "get_shell", shellId: taskId, sinceChars: 99 });
			expect(past.data).toMatchObject({ output: "", outputOffset: 11 });

			// The model's own read still sees the output the client already fetched.
			const read = await harness.session.bashBackground.read(taskId);
			expect(read?.newOutput).toBe("world");

			expect((await call({ type: "get_shell", shellId: "bash-99" })).data).toBeNull();
			expect((await call({ type: "get_shell", shellId: taskId, sinceChars: -1 })).success).toBe(false);
			expect((await call({ type: "get_state" })).data.backgroundShellCount).toBe(1);
		});
	});

	test("kill_shell stops a running shell once and reports unknown ids", async () => {
		await withRpc(async (harness) => {
			const { taskId, abort } = adoptShell(harness, "");
			expect((await call({ type: "kill_shell", shellId: taskId })).data).toEqual({ stopped: true });
			expect(abort).toHaveBeenCalledTimes(1);
			expect((await call({ type: "kill_shell", shellId: taskId })).data).toEqual({ stopped: false });
			expect((await call({ type: "kill_shell", shellId: "bash-99" })).data).toEqual({ stopped: false });
			expect((await call({ type: "kill_shell" })).success).toBe(false);
			const detail = await call({ type: "get_shell", shellId: taskId });
			expect(detail.data.shell).toMatchObject({ status: "killed", finalText: "Stopped by the user." });
		});
	});

	test("background_bash releases foreground calls", async () => {
		await withRpc(async (harness) => {
			const release = vi.fn();
			harness.session.bashBackground.registerForeground("call-1", "npm test", release);
			expect((await call({ type: "background_bash" })).data).toEqual({ released: 1 });
			expect(release).toHaveBeenCalledTimes(1);
			expect((await call({ type: "background_bash" })).data).toEqual({ released: 0 });
		});
	});

	test("pushes coalesced shells_update events and skips identical ones", async () => {
		await withRpc(async (harness) => {
			const { taskId } = adoptShell(harness, "a");
			const updates = () => parseOutputLines().filter((line) => line.type === "shells_update");
			await vi.waitFor(() => expect(updates()).toHaveLength(1));

			harness.session.bashBackground.appendOutput(taskId, "b");
			harness.session.bashBackground.appendOutput(taskId, "c");
			await vi.waitFor(() => expect(updates()).toHaveLength(2));
			expect(updates()[1]).toMatchObject({ shells: [{ taskId, totalChars: 3 }] });
			expect(JSON.stringify(updates())).not.toContain('"output"');
		});
	});

	test("reports extension flags and shortcuts and runs a shortcut with RPC chrome text", async () => {
		const handled: string[] = [];
		await withRpc(
			async () => {
				const flags = await call({ type: "get_flags" });
				expect(flags.data.flags).toEqual([
					expect.objectContaining({ name: "rpc-demo", type: "string", default: "a", value: "a" }),
				]);
				const shortcuts = await call({ type: "get_shortcuts" });
				expect(shortcuts.data.shortcuts).toEqual([
					expect.objectContaining({ shortcut: "ctrl+alt+y", description: "demo shortcut" }),
				]);

				expect(await call({ type: "invoke_shortcut", shortcut: "ctrl+alt+q" })).toMatchObject({
					success: false,
					errorCode: "not_found",
				});
				expect((await call({ type: "invoke_shortcut", shortcut: "Ctrl+Alt+Y" })).success).toBe(true);
				expect(handled).toEqual(["rpc"]);
				expect((await call({ type: "get_ui_state" })).data).toMatchObject({
					header: ["head"],
					footer: ["foot"],
				});
			},
			{
				extensionFactories: [
					(ice) => {
						ice.registerFlag("rpc-demo", { type: "string", default: "a" });
						ice.registerShortcut("ctrl+alt+y", {
							description: "demo shortcut",
							handler: (ctx) => {
								handled.push(ctx.mode);
								ctx.ui.setHeader(() => ({ render: () => [], invalidate: () => {} }), { rpcText: ["head"] });
								ctx.ui.setFooter(() => ({ render: () => [], invalidate: () => {} }), { rpcText: ["foot"] });
							},
						});
					},
				],
			},
		);
	});

	test("completes command names, command arguments, and paths", async () => {
		await withRpc(
			async (harness) => {
				writeFileSync(join(harness.tempDir, "notes-rpc.txt"), "x");
				const names = await call({ type: "get_completions", prefix: "/pic" });
				expect(names.data).toMatchObject({ kind: "command", replace: "/pic" });
				expect(names.data.items).toEqual([expect.objectContaining({ value: "/pick", source: "extension" })]);

				const args = await call({ type: "get_completions", prefix: "/pick al" });
				expect(args.data).toMatchObject({ kind: "argument", replace: "al", items: [{ value: "alpha" }] });

				const paths = await call({ type: "get_completions", prefix: "./notes-r" });
				expect(paths.data.kind).toBe("path");
				expect(paths.data.items.map((item: { value: string }) => item.value)).toContain("./notes-rpc.txt");
			},
			{
				extensionFactories: [
					(ice) => {
						ice.registerCommand("pick", {
							description: "pick one",
							handler: async () => {},
							getArgumentCompletions: (prefix) =>
								["alpha", "beta"]
									.filter((value) => value.startsWith(prefix))
									.map((value) => ({ value, label: value })),
						});
					},
				],
				persistSession: true,
			},
		);
	});

	test("lists RPC-backed built-ins and reports cache waste in session stats", async () => {
		await withRpc(async () => {
			const commands = (await call({ type: "get_commands" })).data.commands as Array<Record<string, unknown>>;
			expect(commands).toContainEqual(
				expect.objectContaining({ name: "compact", source: "builtin", rpcCommand: "compact" }),
			);
			expect(commands.some((command) => command.name === "quit")).toBe(false);

			const stats = await call({ type: "get_session_stats" });
			expect(stats.data.cacheWaste).toEqual({ missedTokens: 0, missedCost: 0, missCount: 0 });
		});
	});

	test("attaches host files to a prompt and rejects missing ones", async () => {
		await withRpc(
			async (harness) => {
				writeFileSync(join(harness.tempDir, "context.txt"), "attached body");
				harness.setResponses([fauxAssistantMessage("ok")]);
				const missing = await call({
					type: "prompt",
					message: "hi",
					attachments: [{ type: "file", path: "missing.txt" }],
				});
				expect(missing).toMatchObject({ success: false, errorCode: "not_found" });

				const sent = await call({
					type: "prompt",
					message: "hi",
					attachments: [{ type: "file", path: "context.txt" }],
				});
				expect(sent.success).toBe(true);
				await vi.waitFor(() => expect(harness.eventsOfType("agent_end")).toHaveLength(1));
				const user = harness.session.messages.find((message) => message.role === "user")!;
				const text = JSON.stringify(user.content);
				expect(text).toContain("attached body");
				expect(text).toContain(join(harness.tempDir, "context.txt"));
			},
			{ persistSession: true },
		);
	});

	test("exports inline content and manages session files inside session directories only", async () => {
		await withRpc(
			async (harness) => {
				const exported = await call({
					type: "export_jsonl",
					outputPath: join(harness.tempDir, "inline.jsonl"),
					includeContent: true,
				});
				expect(exported.data.content.split("\n")[0]).toContain('"type":"session"');

				const sessionDir = harness.sessionManager.getSessionDir();
				const other = join(sessionDir, "other.jsonl");
				mkdirSync(sessionDir, { recursive: true });
				writeFileSync(other, readFileSync(exported.data.path, "utf-8"));

				expect((await call({ type: "rename_session", sessionPath: other, name: " renamed " })).success).toBe(true);
				expect(readFileSync(other, "utf-8")).toContain('"name":"renamed"');
				expect((await call({ type: "rename_session", sessionPath: other, name: " " })).errorCode).toBe(
					"invalid_argument",
				);

				const outside = join(harness.tempDir, "outside.jsonl");
				writeFileSync(outside, "{}\n");
				expect((await call({ type: "delete_session", sessionPath: outside })).errorCode).toBe("invalid_argument");
				expect((await call({ type: "rename_session", sessionPath: outside, name: "x" })).errorCode).toBe(
					"not_found",
				);
				expect(existsSync(outside)).toBe(true);
				expect(
					(await call({ type: "delete_session", sessionPath: harness.sessionManager.getSessionFile()! }))
						.errorCode,
				).toBe("busy");
				expect(
					(await call({ type: "delete_session", sessionPath: join(sessionDir, "gone.jsonl") })).errorCode,
				).toBe("not_found");
				expect((await call({ type: "delete_session", sessionPath: other })).data).toEqual({ method: "unlink" });
				expect(existsSync(other)).toBe(false);
			},
			{ persistSession: true },
		);
	});
});
