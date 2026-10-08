import { visibleWidth } from "@zykairotis/ice-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { IceAgentViewBridge, type IceAgentViewDescriptor } from "../src/ice-agent-view-bridge.ts";
import {
	createSubagentFooterSnapshot,
	SubagentFooterSwitcher,
} from "../src/modes/interactive/components/subagent-view-switcher.ts";
import {
	createSubagentLiveSessionControl,
	SubagentLiveSessionRegistry,
} from "../src/subagents/runtime/live-session.ts";
import type { SubagentRuntimeAttention } from "../src/subagents/runtime/supervisor.ts";

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
		lifetimeDeadline: false,
		activeElapsedMs: 45_000,
		observedPathCount: 1,
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

function controlFor(child: AgentSession, attention: SubagentRuntimeAttention) {
	const control = createSubagentLiveSessionControl(child);
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
					presentation: {
						runtimeAttention: runtimeAttention({
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
		expect(snapshot.selectedChild).toMatchObject({ id: "run-attention", status: "WORKING" });
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

	it("projects registry check-in updates into the owner view and keeps overdue advisory", () => {
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(session("parent"));
		const live = new SubagentLiveSessionRegistry();
		bridge.connectLiveSessions(live);
		const child = session("child", true);
		const release = live.register({ runId: "run-check-in", role: "explore", session: child });
		live.updateCheckInState("run-check-in", {
			delivery: "owner_unavailable",
			sequence: 1,
			pendingSince: 121_000,
		});

		try {
			const views = bridge.listViews();
			const snapshot = createSubagentFooterSnapshot(views, "run-check-in", "run-check-in");
			expect(views.find((entry) => entry.id === "run-check-in")).toMatchObject({
				status: "working",
				checkIn: { delivery: "owner_unavailable", sequence: 1 },
			});
			expect(snapshot).toMatchObject({
				attentionCount: 1,
				selectedChild: { status: "WORKING", needsAttention: true },
			});
		} finally {
			release();
		}
	});

	it("surfaces owner-unavailable check-ins as advisory attention without changing execution status", () => {
		const checkIn = { delivery: "owner_unavailable" as const, sequence: 2, pendingSince: 121_000 };
		const snapshot = createSubagentFooterSnapshot([view({ status: "working", checkIn })], "run-footer", "run-footer");

		expect(snapshot).toMatchObject({
			liveCount: 1,
			attentionCount: 1,
			selectedChild: {
				status: "WORKING",
				needsAttention: true,
				checkIn: { delivery: "owner_unavailable", sequence: 2 },
			},
		});
	});

	it("identifies the displayed main agent instead of falling back to the first child", () => {
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(session("parent"));
		const live = new SubagentLiveSessionRegistry();
		bridge.connectLiveSessions(live);
		const releaseFirst = live.register({
			runId: "run-first",
			role: "explorer",
			taskId: "first-task",
			session: session("first", true),
		});
		const releaseSecond = live.register({
			runId: "run-second",
			role: "reviewer",
			taskId: "second-task",
			session: session("second", true),
		});
		const switcher = new SubagentFooterSwitcher({ requestRender: vi.fn() } as never, fakeTheme() as never, bridge);

		try {
			const text = switcher.render(120).join("\n");
			expect(text).toContain("2 working");
			expect(text).toContain("[Main agent] MAIN");
			expect(text).not.toContain("[1/2 explorer · first-task]");
			expect(text).toMatch(/switch · \S* ?manage/);
			expect(text).not.toMatch(/ main · /);
		} finally {
			switcher.dispose();
			releaseFirst();
			releaseSecond();
		}
	});

	it("counts running and queued children from the runtime overview, not the streaming flag", () => {
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(session("parent"));
		const live = new SubagentLiveSessionRegistry();
		bridge.connectLiveSessions(live);
		const releases = [
			// run-a has not started streaming yet; the runtime overview already reports it running.
			live.register({ runId: "run-a", role: "explorer", taskId: "a", session: session("a") }),
			live.register({ runId: "run-b", role: "explorer", taskId: "b", session: session("b") }),
			live.register({ runId: "run-c", role: "explorer", taskId: "c", session: session("c") }),
		];
		const child = (id: string, state: string) => ({
			id,
			agent: "explorer",
			description: id,
			state,
			depth: 0,
			running: state !== "idle",
			background: true,
			resident: true,
			finished: false,
			turns: 0,
			tokens: 0,
			cost: 0,
		});
		bridge.setSubagentControlSource({
			overview: () => ({
				enabled: true,
				capacity: { running: 1, queued: 1, max: 1 },
				maxDepth: 0,
				children: [child("run-a", "running"), child("run-b", "queued"), child("run-c", "idle")],
				approvals: [],
				diagnostics: [],
			}),
			respondToApproval: () => false,
		});
		const switcher = new SubagentFooterSwitcher({ requestRender: vi.fn() } as never, fakeTheme() as never, bridge);
		try {
			expect(switcher.render(140).join("\n")).toContain("Agents 1 working · 1 queued · 1 idle");
		} finally {
			switcher.dispose();
			for (const release of releases) release();
		}
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
		const switcher = new SubagentFooterSwitcher({ requestRender: vi.fn() } as never, fakeTheme() as never, bridge);

		try {
			const wide = switcher.render(120);
			const text = wide.join("\n");
			expect(text).toContain("1 working · 1 idle");
			expect(text).toContain("1 retained");
			expect(text).toContain("1 needs attention");
			expect(text).toContain("[2/3 reviewer · api-review] IDLE");
			// A child view leads with the key back to the main agent.
			expect(text).toMatch(/IDLE · \S* ?main · /);
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
		const switcher = new SubagentFooterSwitcher({ requestRender: vi.fn() } as never, fakeTheme() as never, bridge);

		try {
			const text = switcher.render(120).join("\n");
			expect(text).toContain("none live");
			expect(text).toContain("1 retained");
			expect(text).toContain("COMPLETED");
			expect(text).not.toContain("…");

			bridge.requestDisplay("run-failed");
			expect(switcher.render(120).join("\n")).toContain("FAILED");
		} finally {
			switcher.dispose();
		}
	});
});
