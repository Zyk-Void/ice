import type { AgentMessage } from "@zykairotis/ice-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	IceAgentViewBridge,
	type IceAgentViewLiveSession,
	type IceAgentViewLiveSessionSource,
} from "../src/ice-agent-view-bridge.ts";

function fakeSession(sessionId: string, messages: readonly AgentMessage[] = []): AgentSession {
	return {
		sessionId,
		messages,
		isStreaming: false,
		sessionManager: { getCwd: () => "/repo" },
	} as unknown as AgentSession;
}

function createLiveSource(): {
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

describe("ICE agent view bridge", () => {
	it("exposes the subagent overview and approval answers, failing soft without a source", () => {
		const bridge = new IceAgentViewBridge();
		expect(bridge.getSubagentOverview()).toBeUndefined();
		expect(bridge.respondToSubagentApproval("r1", "deny")).toBe(false);
		const overview = {
			enabled: true,
			capacity: { running: 0, queued: 0, max: 4 },
			maxDepth: 0,
			children: [],
			approvals: [],
			diagnostics: [],
		};
		const respond = vi.fn(() => true);
		const listener = vi.fn();
		bridge.subscribe(listener);
		bridge.setSubagentControlSource({
			overview: () => overview,
			respondToApproval: respond,
			messages: () => undefined,
			control: async () => "",
		});
		expect(listener).toHaveBeenCalledOnce();
		expect(bridge.getSubagentOverview()).toBe(overview);
		expect(bridge.respondToSubagentApproval("r1", "allow-session")).toBe(true);
		expect(respond).toHaveBeenCalledWith("r1", "allow-session");
		bridge.setSubagentControlSource({
			overview: () => {
				throw new Error("no parent session");
			},
			respondToApproval: respond,
			messages: () => undefined,
			control: async () => "",
		});
		expect(bridge.getSubagentOverview()).toBeUndefined();
	});

	it("keeps parent, live, and historical views distinct and replaces live with history", () => {
		const bridge = new IceAgentViewBridge();
		const parent = fakeSession("parent");
		const child = fakeSession("child", [{ role: "assistant", content: "finished" }] as unknown as AgentMessage[]);
		const liveSource = createLiveSource();
		bridge.setParentSession(parent);
		bridge.connectLiveSessions(liveSource.source);
		liveSource.set([{ runId: "run-1", role: "scout", session: child }]);

		expect(bridge.listViews().map((view) => [view.id, view.kind])).toEqual([
			["parent", "parent"],
			["run-1", "subagent"],
		]);
		bridge.registerHistoricalSnapshot({
			runId: "run-1",
			role: "scout",
			status: "completed",
			finishedAt: 2,
			messages: child.messages,
		});
		expect(bridge.listViews().filter((view) => view.id === "run-1")).toHaveLength(1);
		expect(bridge.getView("run-1")?.kind).toBe("subagent");

		expect(bridge.requestDisplay("run-1")).toBe(true);
		expect(bridge.getDisplayedId()).toBe("run-1");
		liveSource.set([]);
		expect(bridge.getDisplayedView()?.kind).toBe("historical-subagent");
		expect(bridge.getDisplayedView()?.readOnly).toBe(true);
	});

	it("retains bounded, redacted, deeply immutable historical messages", () => {
		const bridge = new IceAgentViewBridge();
		const original = {
			role: "assistant",
			content: [{ type: "text", text: "api_key=secret-value" }],
		} as unknown as AgentMessage;
		bridge.registerHistoricalSnapshot({
			runId: "run-secret",
			role: "review",
			status: "failed",
			finishedAt: 4,
			messages: [original],
		});

		const snapshot = bridge.getView("run-secret")?.messages;
		expect(snapshot?.[0]).toMatchObject({ content: [{ text: "api_key=[REDACTED]" }] });
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot?.[0])).toBe(true);
		expect(Object.isFrozen((snapshot?.[0] as unknown as { content: readonly unknown[] }).content)).toBe(true);
		(original as unknown as { content: [{ type: string; text: string }] }).content[0].text = "changed";
		expect((snapshot?.[0] as unknown as { content: readonly [{ text: string }] }).content[0].text).toBe(
			"api_key=[REDACTED]",
		);

		for (let index = 0; index < 33; index += 1) {
			bridge.registerHistoricalSnapshot({
				runId: `run-${index}`,
				role: "scout",
				status: "completed",
				finishedAt: index,
				messages: [],
			});
		}
		expect(bridge.listViews().filter((view) => view.kind === "historical-subagent")).toHaveLength(32);
		expect(bridge.getView("run-secret")).toBeUndefined();
		expect(bridge.getView("run-0")).toBeUndefined();
		expect(bridge.getView("run-32")?.kind).toBe("historical-subagent");
	});

	it("swallows observer failures and rejects unknown display IDs", () => {
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(fakeSession("parent"));
		const listener = vi.fn(() => {
			throw new Error("observer failure");
		});
		bridge.subscribe(listener);
		bridge.registerHistoricalSnapshot({
			runId: "run-1",
			role: "scout",
			status: "completed",
			finishedAt: 1,
			messages: [],
		});
		// The failing listener cannot prevent later calls or change the selected view.
		expect(listener).toHaveBeenCalled();
		expect(bridge.requestDisplay("missing")).toBe(false);
		expect(bridge.getDisplayedId()).toBe("parent");
	});

	it("preserves an explicit verification state in bounded historical presentation", () => {
		const bridge = new IceAgentViewBridge();
		bridge.registerHistoricalSnapshot({
			runId: "run-verified",
			role: "review",
			status: "completed",
			finishedAt: 5,
			messages: [],
			presentation: {
				delegatedTask: "Review the scoped source.",
				finalResult: { status: "completed", verified: true, summary: "Checked" },
			},
		});

		const presentation = bridge.getView("run-verified")?.presentation;
		expect(presentation?.finalResult).toEqual({ status: "completed", verified: true, summary: "Checked" });
		expect(Object.isFrozen(presentation)).toBe(true);
		expect(Object.isFrozen(presentation?.finalResult)).toBe(true);
	});
});
