import type { AgentMessage } from "@zykairotis/ice-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import {
	IceAgentViewBridge,
	type IceSubagentApprovalAnswer,
	type IceSubagentOverview,
} from "../../src/ice-agent-view-bridge.ts";
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

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};

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
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

function overview(children: IceSubagentOverview["children"] = []): IceSubagentOverview {
	return {
		enabled: true,
		capacity: { running: children.filter((child) => child.running).length, queued: 0, max: 4 },
		maxDepth: 1,
		children,
		approvals: [
			{
				id: "approval-1",
				childId: "child-1",
				agent: "worker",
				name: "auth-review",
				tool: "bash",
				summary: "npm test",
				sessionRule: "bash:npm test",
				foreground: true,
				queuedAt: 1,
				deadline: 2,
			},
		],
		diagnostics: [],
	};
}

const runningChild: IceSubagentOverview["children"][number] = {
	id: "child-1",
	agent: "worker",
	name: "auth-review",
	description: "Review auth",
	state: "running",
	depth: 1,
	running: true,
	background: false,
	resident: true,
	finished: false,
	turns: 1,
	tokens: 100,
	cost: 0,
};

describe("RPC subagent overview", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("reads the overview, answers approvals, and pushes deduplicated updates", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		const bridge = new IceAgentViewBridge();
		let current = overview();
		const answers: Array<[string, IceSubagentApprovalAnswer]> = [];
		bridge.setSubagentControlSource({
			overview: () => current,
			respondToApproval: (approvalId, answer) => {
				answers.push([approvalId, answer]);
				return approvalId === "approval-1";
			},
			messages: () => undefined,
			control: async () => "",
		});

		try {
			void runRpcMode(createRuntimeHost(harness), { agentViewBridge: bridge });
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "get", type: "get_subagents" }));
			rpcIo.lineHandler?.(
				JSON.stringify({ id: "ok", type: "respond_subagent_approval", approvalId: "approval-1", answer: "deny" }),
			);
			rpcIo.lineHandler?.(
				JSON.stringify({
					id: "gone",
					type: "respond_subagent_approval",
					approvalId: "missing",
					answer: "allow-once",
				}),
			);
			rpcIo.lineHandler?.(
				JSON.stringify({ id: "bad", type: "respond_subagent_approval", approvalId: "approval-1", answer: "yes" }),
			);

			await vi.waitFor(() => {
				const lines = parseOutputLines();
				expect(lines).toContainEqual({
					id: "get",
					type: "response",
					command: "get_subagents",
					success: true,
					data: current,
				});
				expect(lines).toContainEqual({
					id: "ok",
					type: "response",
					command: "respond_subagent_approval",
					success: true,
					data: { accepted: true },
				});
				expect(lines).toContainEqual({
					id: "gone",
					type: "response",
					command: "respond_subagent_approval",
					success: true,
					data: { accepted: false },
				});
				expect(lines).toContainEqual(
					expect.objectContaining({ id: "bad", command: "respond_subagent_approval", success: false }),
				);
			});
			expect(answers).toEqual([
				["approval-1", "deny"],
				["missing", "allow-once"],
			]);

			const updateCount = () => parseOutputLines().filter((line) => line.type === "subagents_update").length;
			current = overview([runningChild]);
			bridge.setSubagentControlSource({
				overview: () => current,
				respondToApproval: () => false,
				messages: () => undefined,
				control: async () => "",
			});
			await vi.waitFor(() => expect(updateCount()).toBe(1));
			expect(parseOutputLines()).toContainEqual({ type: "subagents_update", overview: current });

			// An unchanged overview is not pushed again.
			bridge.setSubagentControlSource({
				overview: () => current,
				respondToApproval: () => false,
				messages: () => undefined,
				control: async () => "",
			});
			expect(updateCount()).toBe(1);
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("reads bounded, redacted child transcripts owned by the parent", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		const bridge = new IceAgentViewBridge();
		const liveMessages = [
			{ role: "user", content: "Review auth", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "Looking" }], apiKey: "sk-live-secret", timestamp: 2 },
		];
		bridge.connectLiveSessions({
			list: () => [
				{
					runId: "child-live",
					role: "worker",
					session: {
						messages: liveMessages,
						isStreaming: true,
						sessionManager: { getCwd: () => "/repo" },
					} as unknown as AgentSession,
				},
			],
			subscribe: () => () => {},
		});
		// Parked children are out of memory; the runtime reads their durable transcript.
		bridge.setSubagentControlSource({
			overview: () => overview(),
			respondToApproval: () => false,
			messages: (subagentId) =>
				subagentId === "child-parked"
					? {
							live: false,
							messages: [
								{ role: "user", content: "Map routes", timestamp: 1 },
								{ role: "assistant", content: [{ type: "text", text: "banana" }], token: "abc", timestamp: 2 },
							] as unknown as AgentMessage[],
						}
					: undefined,
			control: async () => "",
		});
		bridge.registerHistoricalSnapshot({
			runId: "child-old",
			role: "scout",
			status: "done",
			finishedAt: 3,
			messages: [{ role: "user", content: "Map routes", timestamp: 1 }] as unknown as AgentMessage[],
		});

		try {
			void runRpcMode(createRuntimeHost(harness), { agentViewBridge: bridge });
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			for (const [requestId, subagentId] of [
				["live", "child-live"],
				["parked", "child-parked"],
				["old", "child-old"],
				["parent", "parent"],
				["unknown", "nope"],
			]) {
				rpcIo.lineHandler?.(JSON.stringify({ id: requestId, type: "get_subagent_messages", subagentId }));
			}
			rpcIo.lineHandler?.(JSON.stringify({ id: "bad", type: "get_subagent_messages" }));

			await vi.waitFor(() => {
				const byId = new Map(parseOutputLines().map((line) => [line.id, line]));
				expect(byId.get("live")).toMatchObject({
					success: true,
					data: {
						live: true,
						messages: [
							{ role: "user", content: "Review auth" },
							{ role: "assistant", apiKey: "[REDACTED]" },
						],
					},
				});
				expect(byId.get("parked")).toMatchObject({
					success: true,
					data: {
						live: false,
						messages: [{ role: "user" }, { role: "assistant", token: "[REDACTED]" }],
					},
				});
				expect(byId.get("old")).toMatchObject({
					success: true,
					data: { live: false, messages: [{ role: "user", content: "Map routes" }] },
				});
				expect(byId.get("parent")).toMatchObject({ success: true, data: null });
				expect(byId.get("unknown")).toMatchObject({ success: true, data: null });
				expect(byId.get("bad")).toMatchObject({ success: false, command: "get_subagent_messages" });
			});
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("runs lifecycle actions through the subagent runtime", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		const bridge = new IceAgentViewBridge();
		const calls: Array<[string, string, string | undefined]> = [];
		bridge.setSubagentControlSource({
			overview: () => overview(),
			respondToApproval: () => false,
			messages: () => undefined,
			control: async (subagentId, action, message) => {
				if (subagentId === "missing") throw new Error("Unknown subagent: missing");
				calls.push([subagentId, action, message]);
				return `${action} ${subagentId}`;
			},
		});

		try {
			void runRpcMode(createRuntimeHost(harness), { agentViewBridge: bridge });
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			const send = (command: Record<string, unknown>) =>
				rpcIo.lineHandler?.(JSON.stringify({ type: "subagent_control", ...command }));
			send({ id: "stop", subagentId: "auth-review", action: "stop" });
			send({ id: "msg", subagentId: "child-1", action: "send", message: "Also check refresh tokens" });
			send({ id: "nomsg", subagentId: "child-1", action: "send" });
			send({ id: "bad", subagentId: "child-1", action: "explode" });
			send({ id: "missing", subagentId: "missing", action: "delete" });

			await vi.waitFor(() => {
				const byId = new Map(parseOutputLines().map((line) => [line.id, line]));
				expect(byId.get("stop")).toMatchObject({ success: true, data: { message: "stop auth-review" } });
				expect(byId.get("msg")).toMatchObject({ success: true, data: { message: "send child-1" } });
				expect(byId.get("nomsg")).toMatchObject({ success: false, command: "subagent_control" });
				expect(byId.get("bad")).toMatchObject({ success: false, command: "subagent_control" });
				expect(byId.get("missing")).toMatchObject({ success: false, error: "Unknown subagent: missing" });
			});
			expect(calls).toEqual([
				["auth-review", "stop", undefined],
				["child-1", "send", "Also check refresh tokens"],
			]);
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("runs patch actions through agent_patch and its extension hooks", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const executed: unknown[] = [];
		const results: Array<{ toolName: string; details: unknown; isError: boolean }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.registerTool({
						name: "agent_patch",
						label: "agent_patch",
						description: "Test patch tool",
						parameters: Type.Object({ action: Type.String(), id: Type.String() }),
						execute: async (_toolCallId, params) => {
							executed.push(params);
							if (params.action === "reject") throw new Error("Patch is not open.");
							return {
								content: [{ type: "text", text: `M src/auth.ts\n\n+fixed` }],
								details: { status: "open", changedPaths: [{ status: "M", path: "src/auth.ts" }] },
							};
						},
					});
					// Stands in for ice-safe-verify: apply is blocked until the approved plan is read.
					ice.on("tool_call", async (event) =>
						event.toolName === "agent_patch" && (event.input as { action?: string }).action === "apply"
							? { block: true, reason: "Read approved plan with read_plan before mutation" }
							: undefined,
					);
					ice.on("tool_result", async (event) => {
						results.push({ toolName: event.toolName, details: event.details, isError: event.isError });
						return undefined;
					});
				},
			],
		});

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			const send = (command: Record<string, unknown>) =>
				rpcIo.lineHandler?.(JSON.stringify({ type: "subagent_patch", subagentId: "child-1", ...command }));
			send({ id: "inspect", action: "inspect" });
			send({ id: "apply", action: "apply" });
			send({ id: "reject", action: "reject" });
			send({ id: "bad", action: "merge" });

			await vi.waitFor(() => {
				const byId = new Map(parseOutputLines().map((line) => [line.id, line]));
				expect(byId.get("inspect")).toMatchObject({
					success: true,
					data: { isError: false, text: "M src/auth.ts\n\n+fixed", details: { status: "open" } },
				});
				expect(byId.get("apply")).toMatchObject({
					success: true,
					data: { isError: true, text: "Read approved plan with read_plan before mutation" },
				});
				expect(byId.get("reject")).toMatchObject({
					success: true,
					data: { isError: true, text: "Patch is not open." },
				});
				expect(byId.get("bad")).toMatchObject({ success: false, command: "subagent_patch" });
			});
			// The blocked apply never reached the tool; inspect and reject ran and were reported to hooks.
			expect(executed).toEqual([
				{ action: "inspect", id: "child-1" },
				{ action: "reject", id: "child-1" },
			]);
			expect(results.map((result) => [result.toolName, result.isError])).toEqual([
				["agent_patch", false],
				["agent_patch", true],
			]);
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("reports agent_patch as unavailable when the mode does not offer it", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			rpcIo.lineHandler?.(
				JSON.stringify({ id: "inspect", type: "subagent_patch", subagentId: "child-1", action: "inspect" }),
			);
			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "inspect",
					type: "response",
					command: "subagent_patch",
					success: true,
					data: { isError: true, text: "agent_patch is not available in this session's current mode." },
				});
			});
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("returns null without a subagent runtime", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			rpcIo.lineHandler?.(JSON.stringify({ id: "get", type: "get_subagents" }));
			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "get",
					type: "response",
					command: "get_subagents",
					success: true,
					data: null,
				});
			});
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
});
