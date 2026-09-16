import { visibleWidth } from "@zykairotis/ice-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	IceAgentViewBridge,
	type IceAgentViewDescriptor,
	type IceAgentViewLiveSession,
	type IceAgentViewLiveSessionSource,
} from "../src/ice-agent-view-bridge.ts";
import type { SubagentRuntimeAttention } from "../src/ice-subagent-timeout-supervisor.ts";
import { createSubagentLiveSessionControl, SubagentLiveSessionRegistry } from "../src/ice-subagents.ts";
import {
	createSubagentFooterSnapshot,
	SubagentFooterSwitcher,
} from "../src/modes/interactive/components/subagent-view-switcher.ts";

function session(sessionId: string, isStreaming = false): AgentSession {
	return {
		sessionId,
		messages: [],
		isStreaming,
		sessionManager: { getCwd: () => "/repo" },
	} as unknown as AgentSession;
}

function runtimeAttention(overrides: Partial<SubagentRuntimeAttention> = {}): SubagentRuntimeAttention {
	return {
		phase: "working",
		state: "running",
		initialTimeoutMs: 120_000,
		activeBudgetMs: 120_000,
		activeElapsedMs: 45_000,
		totalExtendedMs: 0,
		extensionCount: 0,
		remainingExtendableMs: 480_000,
		lastActivities: [
			{
				toolCallId: "call-1",
				toolName: "grep",
				path: "src/core/agent.ts",
				action: 'grep "secret-token" src/core/agent.ts',
				status: "running",
				startedAtMs: 1,
			},
		],
		...overrides,
	};
}

function controlFor(child: AgentSession, attention: SubagentRuntimeAttention, awaitingExtension = false) {
	const control = createSubagentLiveSessionControl(child);
	if (awaitingExtension) control.markAwaitingExtension?.();
	return {
		...control,
		getRuntimeAttention: () => attention,
	};
}

function fakeTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	};
}

function source(): {
	source: IceAgentViewLiveSessionSource;
	set: (sessions: readonly IceAgentViewLiveSession[]) => void;
} {
	let sessions: readonly IceAgentViewLiveSession[] = [];
	const listeners = new Set<() => void>();
	return {
		source: {
			list: () => sessions,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		set: (next) => {
			sessions = next;
			for (const listener of listeners) listener();
		},
	};
}

function view(overrides: Partial<IceAgentViewDescriptor> = {}): IceAgentViewDescriptor {
	return {
		kind: "subagent",
		id: "run-footer",
		label: "reviewer · footer",
		role: "reviewer",
		runId: "run-footer",
		live: true,
		readOnly: true,
		status: "working",
		...overrides,
	};
}

describe("subagent footer observability", () => {
	it("derives a frozen bounded snapshot with counts, attention, selection, and safe activity", () => {
		const activities = Array.from({ length: 64 }, (_, index) => ({
			toolCallId: `call-${index}`,
			toolName: `tool-${index}`,
			path: `src/${index}.ts`,
			status: "ok" as const,
			startedAtMs: index,
		}));
		const snapshot = createSubagentFooterSnapshot(
			[
				view({
					id: "run-live",
					presentation: { runtimeAttention: runtimeAttention({ lastActivities: activities }) },
				}),
				view({
					id: "run-attention",
					controlState: "awaiting-extension",
					presentation: {
						runtimeAttention: runtimeAttention({
							state: "awaiting_extension",
							repeatedFailure: { action: "bash secret-token", count: 2 },
						}),
					},
				}),
				view({
					id: "run-history",
					kind: "historical-subagent",
					live: false,
					status: "completed",
					presentation: {
						runtimeAttention: runtimeAttention({
							state: "terminal",
							lastActivities: [
								{
									toolCallId: "stale",
									toolName: "bash",
									status: "running",
									startedAtMs: 1,
								},
							],
						}),
					},
				}),
			],
			"run-attention",
			"run-attention",
		);

		expect(snapshot).toMatchObject({ liveCount: 2, retainedCount: 0, attentionCount: 1 });
		expect(snapshot.selectedChild).toMatchObject({ id: "run-attention", status: "AWAITING EXTENSION" });
		expect(snapshot.selectedChildIndex).toBe(2);
		expect(snapshot.children[0]?.attention?.recentActivities).toEqual([
			expect.objectContaining({ toolName: "tool-61", path: "src/61.ts" }),
			expect.objectContaining({ toolName: "tool-62", path: "src/62.ts" }),
			expect.objectContaining({ toolName: "tool-63", path: "src/63.ts" }),
		]);
		expect(snapshot.children[0]?.attention?.recentActivities[2]).not.toHaveProperty("action");
		expect(snapshot.children[2]?.attention?.recentActivities).toEqual([]);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.children)).toBe(true);
		expect(Object.isFrozen(snapshot.children[0])).toBe(true);

		const finalizing = createSubagentFooterSnapshot(
			[
				view({
					presentation: { runtimeAttention: runtimeAttention({ phase: "finalization" }) },
				}),
			],
			undefined,
			"run-footer",
		);
		expect(finalizing).toMatchObject({ attentionCount: 1, selectedChild: { status: "FINALIZING" } });
	});

	it("keeps active and retained children readable in collapsed and narrow layouts", () => {
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(session("parent"));
		const live = new SubagentLiveSessionRegistry();
		bridge.connectLiveSessions(live);
		const working = session("working", true);
		const attention = session("attention", false);
		live.register({
			runId: "run-working",
			role: "explorer",
			taskId: "source-map",
			session: working,
			control: controlFor(working, runtimeAttention()),
		});
		live.register({
			runId: "run-attention",
			role: "reviewer",
			taskId: "api-review",
			session: attention,
			control: controlFor(
				attention,
				runtimeAttention({
					state: "awaiting_extension",
					repeatedFailure: { action: 'bash "secret-token"', count: 2 },
					lastActivities: [
						{
							toolCallId: "failed-call",
							toolName: "bash",
							path: "src/api.ts",
							action: 'bash "secret-token"',
							status: "error",
							startedAtMs: 1,
							finishedAtMs: 5,
						},
					],
				}),
				true,
			),
		});
		bridge.registerHistoricalSnapshot({
			runId: "run-completed",
			role: "tester",
			taskId: "finished",
			status: "completed",
			retentionState: "reusable",
			finishedAt: 10,
			messages: [],
		});
		bridge.requestDisplay("run-attention");
		const switcher = new SubagentFooterSwitcher(
			{ requestRender: vi.fn() } as never,
			fakeTheme() as never,
			{ matches: () => false } as never,
			bridge,
			vi.fn(),
			false,
		);

		try {
			const wide = switcher.render(120);
			const text = wide.join("\n");
			expect(text).toContain("2 active");
			expect(text).toContain("1 retained");
			expect(text).toContain("1 needs attention");
			expect(text).toContain("[2/3 reviewer · api-review] AWAITING EXTENSION");
			expect(text).toContain("! bash src/api.ts");
			expect(text).toContain("45s elapsed");
			expect(text).not.toContain("secret-token");
			expect(wide).toHaveLength(2);

			for (const width of [20, 43, 60, 71, 72, 120]) {
				const lines = switcher.render(width);
				expect(
					lines.every((line) => visibleWidth(line) <= width),
					`width=${width}`,
				).toBe(true);
				if (width < 44) expect(lines).toHaveLength(1);
				if (width >= 72) expect(lines).toHaveLength(2);
			}
		} finally {
			switcher.dispose();
		}
	});

	it("uses stable terminal wording for retained completed and failed children", () => {
		const bridge = new IceAgentViewBridge();
		bridge.registerHistoricalSnapshot({
			runId: "run-completed",
			role: "reviewer",
			status: "completed",
			retentionState: "reusable",
			finishedAt: 10,
			messages: [],
		});
		bridge.registerHistoricalSnapshot({
			runId: "run-failed",
			role: "tester",
			status: "failed",
			finishedAt: 11,
			messages: [],
		});
		const switcher = new SubagentFooterSwitcher(
			{ requestRender: vi.fn() } as never,
			fakeTheme() as never,
			{ matches: () => false } as never,
			bridge,
			vi.fn(),
			false,
		);

		try {
			const text = switcher.render(120).join("\n");
			expect(text).toContain("0 active");
			expect(text).toContain("1 retained");
			expect(text).toContain("COMPLETED");
			expect(text).not.toContain("…");

			bridge.requestDisplay("run-failed");
			expect(switcher.render(120).join("\n")).toContain("FAILED");
		} finally {
			switcher.dispose();
		}
	});

	it("preserves selection through reordering and chooses the nearest child after removal", () => {
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(session("parent"));
		const live = source();
		bridge.connectLiveSessions(live.source);
		const first = session("first", true);
		const second = session("second", true);
		const firstEntry: IceAgentViewLiveSession = {
			runId: "run-first",
			role: "first",
			taskId: "first",
			session: first,
		};
		const secondEntry: IceAgentViewLiveSession = {
			runId: "run-second",
			role: "second",
			taskId: "second",
			session: second,
		};
		live.set([firstEntry, secondEntry]);
		bridge.requestDisplay("run-first");
		const requestRender = vi.fn();
		const switcher = new SubagentFooterSwitcher(
			{ requestRender } as never,
			fakeTheme() as never,
			{ matches: () => false } as never,
			bridge,
			vi.fn(),
			true,
		);

		try {
			live.set([secondEntry, firstEntry]);
			expect(requestRender).toHaveBeenCalled();
			expect(switcher.render(100).join("\n")).toMatch(/> ● first · first/);
			live.set([secondEntry]);
			expect(switcher.render(100).join("\n")).toMatch(/> ● second · second/);
		} finally {
			switcher.dispose();
		}
	});
});
