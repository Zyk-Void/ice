import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@zykairotis/ice-agent-core";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { Markdown, Text } from "@zykairotis/ice-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { CreateAgentSessionResult } from "../src/core/sdk.ts";
import { IceAgentViewBridge, type IceAgentViewColor } from "../src/ice-agent-view-bridge.ts";
import {
	createSubagentLiveSessionControl,
	NativeSubagentRunner,
	normalizeSubagentRequest,
	SubagentLiveSessionRegistry,
	type SubagentRequest,
	verifySubagentResult,
} from "../src/ice-subagents.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

function passiveSession(sessionId: string, cwd: string): AgentSession {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	return {
		sessionId,
		messages: [],
		isStreaming: false,
		autoCompactionEnabled: true,
		model: { provider: "faux", id: "faux" } as Model<Api>,
		sessionManager: { getCwd: () => cwd },
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as AgentSession;
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: text,
		stopReason: "stop",
	} as unknown as AgentMessage;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text } as unknown as AgentMessage;
}

class InteractiveChildSession {
	readonly sessionId = "child-session";
	readonly model = { provider: "faux", id: "faux" } as Model<Api>;
	readonly messages: AgentMessage[] = [];
	readonly promptCalls: Array<{ text: string; options?: Record<string, unknown> }> = [];
	readonly dispose = vi.fn();
	readonly abort = vi.fn(async () => {
		this.isStreaming = false;
	});
	readonly getSessionStats = vi.fn(() => ({
		tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
		cost: 0.5,
	}));
	readonly extensionRunner = {
		hasHandlers: vi.fn(() => false),
		emit: vi.fn(async () => undefined),
	};
	readonly sessionManager = {
		getCwd: () => this.cwd,
	};
	isStreaming = false;

	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly cwd: string;
	private readonly releaseInitialTurn: Promise<void>;
	private readonly onInitialTurnStarted: () => void;
	private readonly finalization: { text?: string; error?: Error; wait?: Promise<void> };

	constructor(
		cwd: string,
		releaseInitialTurn: Promise<void>,
		onInitialTurnStarted: () => void,
		finalization: { text?: string; error?: Error; wait?: Promise<void> } = {},
	) {
		this.cwd = cwd;
		this.releaseInitialTurn = releaseInitialTurn;
		this.onInitialTurnStarted = onInitialTurnStarted;
		this.finalization = finalization;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
		this.promptCalls.push({ text, options });
		if (this.promptCalls.length === 1) {
			this.isStreaming = true;
			this.onInitialTurnStarted();
			await this.releaseInitialTurn;
			this.messages.push(
				assistantMessage('{"summary":"conversation JSON, not final","evidence":{"paths":["src"]},"payload":{}}'),
			);
			this.isStreaming = false;
			return;
		}
		if (text === "steer child") {
			this.messages.push(
				userMessage(text),
				assistantMessage("Interactive work continued; this is not the final report."),
			);
			return;
		}
		if (text.startsWith("Your interactive work is complete.")) {
			if (this.finalization.wait) await this.finalization.wait;
			if (this.finalization.error) throw this.finalization.error;
			this.messages.push(
				assistantMessage(
					this.finalization.text ?? '{"summary":"verified final","evidence":{"paths":["src"]},"payload":{}}',
				),
			);
			return;
		}
		if (text.startsWith("[ICE VOID SUBAGENT REPORT REPAIR]")) {
			// One-time report-only repair: reply with the same invalid envelope text.
			this.messages.push(assistantMessage(this.finalization.text ?? ""));
			return;
		}
		throw new Error(`Unexpected child prompt: ${text}`);
	}
}

async function createWorkspace(): Promise<{ cwd: string; agentDir: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "ice-agent-view-integration-"));
	const agentDir = await mkdtemp(join(tmpdir(), "ice-agent-view-agent-"));
	tempDirs.push(cwd, agentDir);
	await mkdir(join(cwd, "src"));
	return { cwd, agentDir };
}

function request(cwd: string): SubagentRequest {
	return {
		parentSessionId: "parent-session",
		role: "self",
		self: { instructions: "Inspect the scoped repository and preserve concrete evidence." },
		task: "Inspect the scoped repository.",
		scope: { roots: ["src"] },
		cwd,
		// These tests exercise the structured steered-finalization protocol, which
		// only typed flows (outputSchema/acceptance criteria) still use.
		outputSchema: { type: "object", additionalProperties: false },
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ICE agent-view integration", () => {
	it("leaves stock InteractiveMode session selection unchanged when no ICE bridge is installed", () => {
		const parent = passiveSession("stock-parent", "/stock");
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			runtimeHost: { session: parent },
			agentViewBridge: undefined,
			displayedViewId: "parent",
			displayedViewKind: "parent",
			displayedSessionForRender: undefined,
		});
		const internal = mode as unknown as {
			session: AgentSession;
			displaySession: AgentSession;
			renderSession: AgentSession;
			isViewingSubagent: boolean;
		};
		expect(internal.session).toBe(parent);
		expect(internal.displaySession).toBe(parent);
		expect(internal.renderSession).toBe(parent);
		expect(internal.isViewingSubagent).toBe(false);
	});

	it("binds InteractiveMode display state to a child without replacing the authoritative parent runtime", async () => {
		const parent = passiveSession("parent-runtime", "/parent");
		const child = passiveSession("child-display", "/child");
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(parent);
		bridge.connectLiveSessions(registry);
		const release = registry.register({ runId: "run-display", role: "tester", session: child });

		const footer = {
			setDataProvider: vi.fn(),
			setSession: vi.fn(),
			setAutoCompactEnabled: vi.fn(),
		};
		const childUnsubscribe = vi.fn();
		(child as unknown as { subscribe: (listener: (event: AgentSessionEvent) => void) => () => void }).subscribe =
			vi.fn(() => childUnsubscribe);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			runtimeHost: { session: parent },
			agentViewBridge: bridge,
			isInitialized: true,
			displayedViewId: "parent",
			displayedViewKind: "parent",
			displayedInteractionMode: undefined,
			displayedControlState: undefined,
			displayedViewBound: true,
			displayedSessionUnsubscribe: undefined,
			footer,
			ui: { requestRender: vi.fn() },
		});
		const internal = mode as unknown as {
			handleAgentViewChange: () => Promise<void>;
			saveDisplayedViewState: () => void;
			restoreDisplayedViewState: (view: unknown) => void;
			getFooterDataProviderForView: (view: { id: string }) => unknown;
			renderDisplayedView: (view: unknown) => void;
			displayedViewId: string;
		};
		internal.saveDisplayedViewState = vi.fn();
		internal.restoreDisplayedViewState = vi.fn();
		internal.getFooterDataProviderForView = vi.fn((view) => ({ viewId: view.id }));
		internal.renderDisplayedView = vi.fn();

		expect(bridge.requestDisplay("run-display")).toBe(true);
		await internal.handleAgentViewChange();
		expect((mode as unknown as { runtimeHost: { session: AgentSession } }).runtimeHost.session).toBe(parent);
		expect(internal.displayedViewId).toBe("run-display");
		expect(footer.setSession).toHaveBeenLastCalledWith(child);
		expect(footer.setDataProvider).toHaveBeenCalledWith(expect.objectContaining({ viewId: "run-display" }));
		expect(footer.setAutoCompactEnabled).toHaveBeenLastCalledWith(true);

		bridge.returnToParent();
		await internal.handleAgentViewChange();
		expect((mode as unknown as { runtimeHost: { session: AgentSession } }).runtimeHost.session).toBe(parent);
		expect(internal.displayedViewId).toBe("parent");
		expect(footer.setSession).toHaveBeenLastCalledWith(parent);
		expect(childUnsubscribe).toHaveBeenCalledOnce();
		release();
	});

	it("uses InteractiveMode's real view-state save and restore path for independent drafts and scroll positions", async () => {
		const parent = passiveSession("parent-state", "/parent");
		const child = passiveSession("child-state", "/child");
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(parent);
		bridge.connectLiveSessions(registry);
		const release = registry.register({ runId: "run-state", role: "tester", session: child });
		const editor = {
			getExpandedText: vi.fn(() => "parent draft"),
			getText: vi.fn(() => "parent draft"),
			setText: vi.fn(),
		};
		const scrollView = {
			scrollTop: 17,
			isFollowingEnd: false,
			scrollToEnd: vi.fn(),
			scrollTo: vi.fn(),
		};
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			runtimeHost: { session: parent },
			agentViewBridge: bridge,
			displayedViewId: "parent",
			displayedViewKind: "parent",
			editor,
			transcriptScrollView: scrollView,
			options: { uiMode: "regular" },
			ui: { requestRender: vi.fn() },
		});
		const internal = mode as unknown as {
			saveDisplayedViewState: () => void;
			restoreDisplayedViewState: (view: NonNullable<ReturnType<IceAgentViewBridge["getView"]>>) => void;
			displayedViewId: string;
		};

		internal.saveDisplayedViewState();
		expect(bridge.getUiState("parent")).toMatchObject({
			editorDraft: "parent draft",
			scrollOffset: 17,
			followTranscript: false,
		});

		bridge.setUiState("run-state", { editorDraft: "child draft", scrollOffset: 42, followTranscript: false });
		internal.displayedViewId = "run-state";
		internal.restoreDisplayedViewState(bridge.getView("run-state")!);
		await Promise.resolve();
		expect(editor.setText).toHaveBeenLastCalledWith("child draft");
		expect(scrollView.scrollTo).toHaveBeenLastCalledWith(42);

		internal.displayedViewId = "parent";
		internal.restoreDisplayedViewState(bridge.getView("parent")!);
		await Promise.resolve();
		expect(editor.setText).toHaveBeenLastCalledWith("parent draft");
		expect(scrollView.scrollTo).toHaveBeenLastCalledWith(17);
		release();
	});

	it("renders live and historical child transcripts through InteractiveMode's normal session renderers", () => {
		initTheme("dark");
		const parent = passiveSession("parent-render", "/parent");
		const liveEntries = [{ type: "message", message: userMessage("live sentinel") }];
		const child = {
			...passiveSession("child-render", "/child"),
			sessionManager: {
				getCwd: () => "/child",
				getSessionName: () => undefined,
				buildContextEntries: () => liveEntries,
			},
		} as unknown as AgentSession;
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(parent);
		bridge.connectLiveSessions(registry);
		const release = registry.register({ runId: "run-render", role: "tester", session: child });
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			runtimeHost: { session: parent },
			agentViewBridge: bridge,
			loadedResourcesContainer: { clear: vi.fn() },
			keybindings: { getKeys: vi.fn(() => []) },
			chatContainer: { addChild: vi.fn() },
			displayedSessionForRender: undefined,
		});
		const internal = mode as unknown as {
			renderDisplayedView: (view: NonNullable<ReturnType<IceAgentViewBridge["getView"]>>) => void;
			clearDisplayedSessionUi: () => void;
			renderSessionEntries: (entries: unknown, options: unknown) => void;
			renderSessionItems: (items: unknown, options: unknown) => void;
			updatePendingMessagesDisplayForDisplayedView: (view: unknown) => void;
			updateAgentViewIdentity: (view: unknown) => void;
			updateTerminalTitleForSession: (session: unknown, view: unknown) => void;
		};
		internal.clearDisplayedSessionUi = vi.fn();
		internal.renderSessionEntries = vi.fn();
		internal.renderSessionItems = vi.fn();
		internal.updatePendingMessagesDisplayForDisplayedView = vi.fn();
		internal.updateAgentViewIdentity = vi.fn();
		internal.updateTerminalTitleForSession = vi.fn();

		internal.renderDisplayedView(bridge.getView("run-render")!);
		expect(internal.renderSessionEntries).toHaveBeenCalledWith(liveEntries, {
			updateFooter: true,
			populateHistory: false,
		});

		bridge.registerHistoricalSnapshot({
			runId: "run-history-render",
			role: "tester",
			status: "completed",
			finishedAt: Date.now(),
			messages: [userMessage("history sentinel")],
		});
		internal.renderDisplayedView(bridge.getView("run-history-render")!);
		expect(internal.renderSessionItems).toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ role: "user" })]),
			{ updateFooter: true },
		);
		release();
	});

	it("projects protocol messages out of historical child views while preserving user and tool content", () => {
		initTheme("dark");
		const parent = passiveSession("parent-projection", "/parent");
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(parent);
		const toolCall = {
			role: "assistant",
			content: [
				{ type: "text", text: "Inspecting source" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src" } },
			],
			stopReason: "toolUse",
		} as unknown as AgentMessage;
		const toolResult = {
			role: "toolResult",
			toolCallId: "tool-1",
			content: [{ type: "text", text: "source" }],
			isError: false,
		} as unknown as AgentMessage;
		bridge.registerHistoricalSnapshot({
			runId: "run-projection",
			role: "review",
			status: "completed",
			finishedAt: Date.now(),
			messages: [
				userMessage("[ICE VOID SUBAGENT HANDOFF] Inspect the scoped repository."),
				assistantMessage('{"summary":"internal report","evidence":{"paths":["src"]}}'),
				userMessage("Visible child note"),
				toolCall,
				toolResult,
				userMessage("[ICE VOID SUBAGENT WRAP UP] Finish from the current child state."),
				userMessage("Your interactive work is complete. Return the report."),
				assistantMessage('{"summary":"verified final","evidence":{"paths":["src"]}}'),
			],
			presentation: {
				delegatedTask: "Inspect the scoped repository.",
				scopeLabels: ["src"],
				authority: "safe",
				handoffMessageIndex: 0,
				wrapUpMessageMarker: "[ICE VOID SUBAGENT WRAP UP]",
				wrapUpMessageIndex: 5,
				finalizationMessageIndex: 6,
				finalReportMessageIndex: 7,
				protocolReportPending: false,
				finalResult: { status: "completed", verified: true, summary: "Verified final", evidencePaths: ["src"] },
			},
		});

		const chatContainer = { addChild: vi.fn() };
		const renderSessionItems = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			runtimeHost: { session: parent },
			agentViewBridge: bridge,
			loadedResourcesContainer: { clear: vi.fn() },
			keybindings: { getKeys: vi.fn(() => []) },
			chatContainer,
		});
		const internal = mode as unknown as {
			renderDisplayedView: (view: NonNullable<ReturnType<IceAgentViewBridge["getView"]>>) => void;
			clearDisplayedSessionUi: () => void;
			renderSessionItems: (items: readonly AgentMessage[], options: unknown) => void;
			updatePendingMessagesDisplayForDisplayedView: (view: unknown) => void;
			updateAgentViewIdentity: (view: unknown) => void;
			updateTerminalTitleForSession: (session: unknown, view: unknown) => void;
		};
		internal.clearDisplayedSessionUi = vi.fn();
		internal.renderSessionItems = renderSessionItems;
		internal.updatePendingMessagesDisplayForDisplayedView = vi.fn();
		internal.updateAgentViewIdentity = vi.fn();
		internal.updateTerminalTitleForSession = vi.fn();

		internal.renderDisplayedView(bridge.getView("run-projection")!);

		const rendered = renderSessionItems.mock.calls[0]?.[0] as readonly AgentMessage[];
		expect(renderSessionItems).toHaveBeenCalledWith(expect.any(Array), { updateFooter: true });
		expect(rendered).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "user", content: "Visible child note" }),
				expect.objectContaining({
					role: "assistant",
					content: expect.arrayContaining([expect.objectContaining({ type: "toolCall", id: "tool-1" })]),
				}),
				expect.objectContaining({ role: "toolResult", toolCallId: "tool-1" }),
			]),
		);
		expect(rendered).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "user", content: expect.stringContaining("[ICE VOID SUBAGENT HANDOFF]") }),
				expect.objectContaining({
					role: "user",
					content: expect.stringContaining("[ICE VOID SUBAGENT WRAP UP]"),
				}),
				expect.objectContaining({
					role: "user",
					content: expect.stringContaining("Your interactive work is complete."),
				}),
				expect.objectContaining({
					role: "assistant",
					content: '{"summary":"verified final","evidence":{"paths":["src"]}}',
				}),
			]),
		);
		expect(chatContainer.addChild).toHaveBeenCalledTimes(4);
	});

	it("keeps protocol projection active across generic child transcript rebuilds", () => {
		initTheme("dark");
		const parent = passiveSession("parent-rebuild", "/parent");
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(parent);
		bridge.registerHistoricalSnapshot({
			runId: "run-rebuild",
			role: "review",
			status: "completed",
			finishedAt: Date.now(),
			messages: [
				userMessage("[ICE VOID SUBAGENT HANDOFF] hidden handoff"),
				userMessage("Visible child note"),
				assistantMessage('{"summary":"hidden final","evidence":{"paths":["src"]}}'),
			],
			presentation: {
				delegatedTask: "Inspect the scoped repository.",
				handoffMessageIndex: 0,
				finalReportMessageIndex: 2,
				finalResult: { status: "completed", verified: true, summary: "Visible result" },
			},
		});
		bridge.requestDisplay("run-rebuild");

		const renderSessionItems = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			runtimeHost: { session: parent },
			agentViewBridge: bridge,
			displayedSessionForRender: undefined,
			chatContainer: { clear: vi.fn(), addChild: vi.fn() },
			keybindings: { getKeys: vi.fn(() => []) },
		});
		const internal = mode as unknown as {
			rebuildChatFromMessages: () => void;
			renderSessionItems: (items: readonly AgentMessage[], options: unknown) => void;
			renderSessionEntries: (entries: unknown, options?: unknown) => void;
		};
		internal.renderSessionItems = renderSessionItems;
		internal.renderSessionEntries = vi.fn();

		internal.rebuildChatFromMessages();

		const rendered = renderSessionItems.mock.calls[0]?.[0] as readonly AgentMessage[];
		expect(rendered).toEqual(expect.arrayContaining([expect.objectContaining({ content: "Visible child note" })]));
		expect(rendered).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ content: expect.stringContaining("[ICE VOID SUBAGENT HANDOFF]") }),
				expect.objectContaining({ content: expect.stringContaining("hidden final") }),
			]),
		);
		expect(internal.renderSessionEntries).not.toHaveBeenCalled();
	});

	it("keeps new, resume, clone, and compact lifecycle operations rooted on the parent while a child is displayed", async () => {
		const compact = vi.fn(async () => undefined);
		const parent = {
			...passiveSession("parent-lifecycle", "/parent"),
			compact,
			sessionManager: {
				getCwd: () => "/parent",
				getLeafId: () => "parent-leaf",
			},
		} as unknown as AgentSession;
		const child = passiveSession("child-lifecycle", "/child");
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(parent);
		bridge.connectLiveSessions(registry);
		const release = registry.register({ runId: "run-lifecycle", role: "coder", session: child });
		bridge.requestDisplay("run-lifecycle");

		const newSession = vi.fn(async () => ({ cancelled: false }));
		const switchSession = vi.fn(async () => ({ cancelled: false }));
		const fork = vi.fn(async () => ({ cancelled: false, selectedText: undefined }));
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			runtimeHost: { session: parent, newSession, switchSession, fork },
			agentViewBridge: bridge,
			clearStatusIndicator: vi.fn(),
			chatContainer: { addChild: vi.fn() },
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => ({ cancelled: true })),
			editor: { setText: vi.fn() },
		});
		const internal = mode as unknown as {
			session: AgentSession;
			handleClearCommand: () => Promise<void>;
			handleResumeSession: (path: string) => Promise<{ cancelled: boolean }>;
			handleCloneCommand: () => Promise<void>;
			handleCompactCommand: (instructions?: string) => Promise<void>;
		};

		expect(internal.session).toBe(parent);
		await internal.handleCompactCommand("parent compact");
		expect(compact).toHaveBeenCalledWith("parent compact");
		await internal.handleClearCommand();
		expect(newSession).toHaveBeenCalledOnce();
		await internal.handleResumeSession("/sessions/parent.jsonl");
		expect(switchSession).toHaveBeenCalledWith(
			"/sessions/parent.jsonl",
			expect.objectContaining({ projectTrustContextFactory: expect.any(Function) }),
		);
		await internal.handleCloneCommand();
		expect(fork).toHaveBeenCalledWith("parent-leaf", { position: "at" });
		expect(bridge.getDisplayedId()).toBe("run-lifecycle");
		expect(bridge.getView("run-lifecycle")?.session).toBe(child);
		release();
	});

	it("returns to the parent and releases child control when the authoritative parent session is replaced", () => {
		const parentA = passiveSession("parent-a", "/repo-a");
		const parentB = passiveSession("parent-b", "/repo-b");
		const child = passiveSession("child", "/repo-a");
		const control = createSubagentLiveSessionControl(child);
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(parentA);
		bridge.connectLiveSessions(registry);
		const release = registry.register({ runId: "run-old-lineage", role: "coder", session: child, control });
		bridge.requestDisplay("run-old-lineage");
		expect(bridge.requestTakeControl()).toEqual({ accepted: true, mode: "controlled" });
		expect(control.isControlled()).toBe(true);

		bridge.setParentSession(parentB);
		expect(bridge.getDisplayedId()).toBe("parent");
		expect(bridge.getDisplayedView()?.session).toBe(parentB);
		expect(control.isControlled()).toBe(false);
		release();
	});

	it("opens the local chooser from a child without changing the displayed view when it is cancelled", () => {
		const prompt = vi.fn(async () => undefined);
		const parent = { ...passiveSession("parent-chooser", "/repo"), prompt } as unknown as AgentSession;
		const child = passiveSession("child-chooser", "/repo");
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(parent);
		bridge.connectLiveSessions(registry);
		const release = registry.register({ runId: "run-chooser", role: "tester", session: child });
		bridge.requestDisplay("run-chooser");
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		const setFocus = vi.fn();
		const requestRender = vi.fn();
		const agentSwitcherContainer = { addChild: vi.fn(), clear: vi.fn() };
		Object.assign(mode, {
			runtimeHost: { session: parent },
			agentViewBridge: bridge,
			isInitialized: true,
			keybindings: { matches: vi.fn(() => false) },
			agentSwitcherContainer,
			ui: { setFocus, requestRender },
			editor: {},
		});
		const internal = mode as unknown as {
			openSubagentChooser: () => void;
			saveDisplayedViewState: () => void;
			agentSwitcher: { handleInput: (data: string) => void; isExpanded: () => boolean } | undefined;
		};
		internal.saveDisplayedViewState = vi.fn();
		internal.openSubagentChooser();
		expect(prompt).not.toHaveBeenCalled();
		expect(agentSwitcherContainer.addChild).toHaveBeenCalledOnce();
		expect(internal.agentSwitcher).toBeDefined();

		internal.agentSwitcher?.handleInput("\u001b");
		expect(bridge.getDisplayedId()).toBe("run-chooser");
		expect(agentSwitcherContainer.clear).not.toHaveBeenCalled();
		expect(internal.agentSwitcher?.isExpanded()).toBe(false);
		release();
	});

	it("routes Escape from a controlled child back to the parent without aborting the child", () => {
		const parent = passiveSession("parent-escape", "/repo");
		const abort = vi.fn();
		const child = { ...passiveSession("child-escape", "/repo"), abort } as unknown as AgentSession;
		const control = createSubagentLiveSessionControl(child);
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(parent);
		bridge.connectLiveSessions(registry);
		const release = registry.register({ runId: "run-escape", role: "coder", session: child, control });
		bridge.requestDisplay("run-escape");
		bridge.requestTakeControl();
		const defaultEditor: Record<string, unknown> = { onAction: vi.fn() };
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			runtimeHost: { session: parent },
			agentViewBridge: bridge,
			displayedViewId: "run-escape",
			displayedViewKind: "subagent",
			defaultEditor,
			ui: {},
		});
		(mode as unknown as { setupKeyHandlers: () => void }).setupKeyHandlers();
		(defaultEditor.onEscape as () => void)();
		expect(bridge.getDisplayedId()).toBe("parent");
		expect(control.isControlled()).toBe(false);
		expect(abort).not.toHaveBeenCalled();
		release();
	});

	it("checks reload readiness against the authoritative parent rather than the displayed child", async () => {
		const parent = { ...passiveSession("parent-reload", "/parent"), isStreaming: true } as unknown as AgentSession;
		const child = { ...passiveSession("child-reload", "/child"), isStreaming: false } as unknown as AgentSession;
		const bridge = new IceAgentViewBridge();
		const registry = new SubagentLiveSessionRegistry();
		bridge.setParentSession(parent);
		bridge.connectLiveSessions(registry);
		const release = registry.register({ runId: "run-reload", role: "tester", session: child });
		bridge.requestDisplay("run-reload");
		const showWarning = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, { runtimeHost: { session: parent }, agentViewBridge: bridge, showWarning });
		await (mode as unknown as { handleReloadCommand: () => Promise<void> }).handleReloadCommand();
		expect(showWarning).toHaveBeenCalledWith("Wait for the current response to finish before reloading.");
		release();
	});

	it("uses the authoritative runtime shutdown path while a child is displayed", async () => {
		const parent = passiveSession("parent-shutdown", "/parent");
		const childAbort = vi.fn();
		const child = { ...passiveSession("child-shutdown", "/child"), abort: childAbort } as unknown as AgentSession;
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(parent);
		bridge.connectLiveSessions(registry);
		const release = registry.register({ runId: "run-shutdown", role: "tester", session: child });
		bridge.requestDisplay("run-shutdown");
		const dispose = vi.fn(async () => undefined);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			runtimeHost: { session: parent, dispose },
			agentViewBridge: bridge,
			isShuttingDown: false,
			themeController: { disableAutoSync: vi.fn() },
			ui: { terminal: { drainInput: vi.fn(async () => undefined) } },
			stop: vi.fn(),
		});
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("test-exit");
		}) as never);
		try {
			await expect(
				(mode as unknown as { shutdown: (options: { fromSignal: true }) => Promise<void> }).shutdown({
					fromSignal: true,
				}),
			).rejects.toThrow("test-exit");
			expect(dispose).toHaveBeenCalledOnce();
			expect(childAbort).not.toHaveBeenCalled();
		} finally {
			exit.mockRestore();
			release();
		}
	});

	it("drops invalid live profile colors at the registry boundary", () => {
		const registry = new SubagentLiveSessionRegistry();
		const release = registry.register({
			runId: "run-invalid-color",
			role: "scout",
			session: passiveSession("child-invalid-color", "/repo"),
			color: "not-a-theme-token" as unknown as IceAgentViewColor,
		});

		expect(registry.get("run-invalid-color")).not.toHaveProperty("color");
		release();
	});

	it("keeps parent identity stable while cycling live and historical views and preserving UI state", () => {
		const bridge = new IceAgentViewBridge();
		const parent = passiveSession("parent", "/repo");
		const childA = passiveSession("child-a", "/repo");
		const childB = passiveSession("child-b", "/repo");
		(parent as unknown as { isStreaming: boolean }).isStreaming = true;
		(childB as unknown as { isStreaming: boolean }).isStreaming = true;
		const registry = new SubagentLiveSessionRegistry();
		bridge.setParentSession(parent);
		bridge.connectLiveSessions(registry);
		const releaseA = registry.register({ runId: "run-a", role: "scout", session: childA, color: "success" });
		const releaseB = registry.register({ runId: "run-b", role: "coder", session: childB, color: "warning" });

		expect(bridge.getView("run-a")).toMatchObject({ color: "success" });
		expect(bridge.getView("run-b")).toMatchObject({ color: "warning" });
		bridge.setUiState("parent", { editorDraft: "parent draft", followTranscript: false, scrollOffset: 4 });
		bridge.setUiState("run-a", { editorDraft: "child A draft", followTranscript: true, scrollOffset: 8 });
		bridge.setUiState("run-b", { editorDraft: "child B draft", followTranscript: false, scrollOffset: 12 });

		expect(bridge.getView("parent")?.session).toBe(parent);
		expect(bridge.cycleDisplayed(1)).toBe(true);
		expect(bridge.getDisplayedId()).toBe("run-a");
		expect(bridge.getView("run-a")?.session).toBe(childA);
		expect(parent.isStreaming).toBe(true);
		expect(childB.isStreaming).toBe(true);
		expect(bridge.getUiState("run-a")?.editorDraft).toBe("child A draft");
		expect(bridge.cycleDisplayed(1)).toBe(true);
		expect(bridge.getDisplayedId()).toBe("run-b");
		expect(bridge.getView("run-b")?.session).toBe(childB);
		expect(parent.isStreaming).toBe(true);
		expect(bridge.cycleDisplayed(1)).toBe(true);
		expect(bridge.getDisplayedId()).toBe("parent");
		expect(bridge.getView("parent")?.session).toBe(parent);

		bridge.registerHistoricalSnapshot({
			runId: "run-a",
			role: "scout",
			status: "completed",
			color: "success",
			finishedAt: Date.now(),
			messages: childA.messages,
		});
		releaseA();
		releaseB();
		expect(bridge.getView("run-a")).toMatchObject({ kind: "historical-subagent", color: "success" });
		expect(bridge.getView("run-a")?.session).toBeUndefined();
		expect(bridge.requestDisplay("run-a")).toBe(true);
		expect(bridge.getView("parent")?.session).toBe(parent);
	});

	it("disables child input during finalization even after controlled takeover", async () => {
		const session = passiveSession("child", "/repo");
		const control = createSubagentLiveSessionControl(session);
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(passiveSession("parent", "/repo"));
		bridge.connectLiveSessions(registry);
		const release = registry.register({ runId: "run-finalizing", role: "tester", session, control });

		expect(bridge.requestDisplay("run-finalizing")).toBe(true);
		expect(bridge.requestTakeControl()).toEqual({ accepted: true, mode: "controlled" });
		expect(bridge.getView("run-finalizing")).toMatchObject({ readOnly: false, interactionMode: "controlled" });
		expect(control.markSteered()).toBe(true);
		expect(bridge.requestTakeControl()).toEqual({ accepted: true, mode: "mirror" });
		expect(control.beginFinalization()).toBe(true);
		expect(control.requestFinalReport()).toBe(true);
		expect(bridge.getView("run-finalizing")).toMatchObject({
			readOnly: true,
			interactionMode: "mirror",
			controlState: "final-report-requested",
		});
		expect(bridge.requestTakeControl()).toMatchObject({ accepted: false });
		await expect(bridge.sendInput("run-finalizing", "too late")).rejects.toThrow(/no longer accepts|Take Control/);
		release();
	});

	it("routes a live child steer to the child and parses only the explicit final report", async () => {
		const { cwd, agentDir } = await createWorkspace();
		let startInitialTurn!: () => void;
		const initialTurnStarted = new Promise<void>((resolve) => {
			startInitialTurn = resolve;
		});
		let releaseInitialTurn!: () => void;
		const initialTurn = new Promise<void>((resolve) => {
			releaseInitialTurn = resolve;
		});
		const child = new InteractiveChildSession(cwd, initialTurn, startInitialTurn);
		const parent = passiveSession("parent", cwd);
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(parent);
		bridge.connectLiveSessions(registry);
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		const model = { provider: "faux", id: "faux" } as Model<Api>;
		const runner = new NativeSubagentRunner({
			agentDir,
			liveSessionRegistry: registry,
			agentViewBridge: bridge,
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});

		const runPromise = runner.runResolved(normalized, ["delegate", "read", "grep", "find", "ls"], {
			model,
			taskId: "interactive-task",
		});
		await initialTurnStarted;
		expect(bridge.getView(normalized.runId)).toMatchObject({
			kind: "subagent",
			live: true,
			readOnly: true,
			interactionMode: "mirror",
		});
		expect(bridge.requestDisplay(normalized.runId)).toBe(true);
		expect(bridge.requestTakeControl()).toEqual({ accepted: true, mode: "controlled" });
		await bridge.sendInput(normalized.runId, "steer child");
		expect(child.promptCalls[1]).toMatchObject({
			text: "steer child",
			options: { streamingBehavior: "steer", source: "interactive" },
		});

		releaseInitialTurn();
		expect(bridge.requestTakeControl()).toEqual({ accepted: true, mode: "mirror" });
		const result = await runPromise;
		expect(result).toMatchObject({ status: "completed", summary: "verified final", partial: false });
		expect(result.summary).not.toContain("conversation JSON");
		expect(child.promptCalls).toHaveLength(3);
		expect(child.promptCalls[2]?.text).toContain("Your interactive work is complete.");
		expect(verifySubagentResult(result, normalized)).toMatchObject({ verified: true });
		expect(bridge.getDisplayedView()).toMatchObject({ kind: "historical-subagent", readOnly: true, live: false });
		expect(bridge.getDisplayedView()?.presentation?.finalResult).toMatchObject({
			status: "completed",
			verified: true,
			summary: "verified final",
		});
		expect(bridge.getDisplayedView()?.session).toBeUndefined();
		expect(bridge.getView("parent")?.session).toBe(parent);
		expect(parent.messages).toEqual([]);
		// Completed children are retained for reuse, so the session stays alive after
		// the terminal historical snapshot replaces the live view.
		expect(child.dispose).not.toHaveBeenCalled();
		expect(runner.listRetainedChildren(normalized.parentSessionId).map((entry) => entry.runId)).toEqual([
			normalized.runId,
		]);
	});

	it("records verification failure in historical presentation before showing a terminal result", async () => {
		const { cwd, agentDir } = await createWorkspace();
		let startInitialTurn!: () => void;
		const initialTurnStarted = new Promise<void>((resolve) => {
			startInitialTurn = resolve;
		});
		let releaseInitialTurn!: () => void;
		const initialTurn = new Promise<void>((resolve) => {
			releaseInitialTurn = resolve;
		});
		const child = new InteractiveChildSession(cwd, initialTurn, startInitialTurn, {
			text: '{"summary":"bad evidence","evidence":{"paths":["missing"]},"payload":{}}',
		});
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(passiveSession("parent", cwd));
		bridge.connectLiveSessions(registry);
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		const runner = new NativeSubagentRunner({
			agentDir,
			liveSessionRegistry: registry,
			agentViewBridge: bridge,
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const runPromise = runner.runResolved(normalized, ["delegate", "read", "grep", "find", "ls"], {
			model: { provider: "faux", id: "faux" } as Model<Api>,
		});

		await initialTurnStarted;
		bridge.requestDisplay(normalized.runId);
		bridge.requestTakeControl();
		await bridge.sendInput(normalized.runId, "steer child");
		releaseInitialTurn();
		bridge.requestTakeControl();
		const result = await runPromise;

		expect(result).toMatchObject({ status: "completed", summary: "bad evidence" });
		expect(verifySubagentResult(result, normalized)).toMatchObject({ verified: false });
		expect(bridge.getView(normalized.runId)).toMatchObject({
			kind: "historical-subagent",
			status: "verification_failed",
			presentation: {
				finalResult: {
					status: "verification_failed",
					verified: false,
					summary: "bad evidence",
				},
			},
		});
		expect(bridge.getView(normalized.runId)?.presentation?.finalResult?.diagnostic).toContain(
			"Evidence path does not exist",
		);
	});

	it("renders the plain final answer in the terminal result card", () => {
		initTheme("dark");
		const chatContainer = { addChild: vi.fn() };
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			chatContainer,
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		});
		const internal = mode as unknown as {
			addSubagentFinalResult: (view: NonNullable<ReturnType<IceAgentViewBridge["getView"]>>) => void;
		};

		internal.addSubagentFinalResult({
			kind: "historical-subagent",
			id: "run-plain",
			label: "plain",
			live: false,
			readOnly: true,
			presentation: {
				reportMode: "plain_final_turn",
				finalResult: {
					status: "completed",
					verified: true,
					summary: "The answer is **rendered for the user**, not hidden in the transcript.",
				},
			},
		});

		expect(chatContainer.addChild).toHaveBeenCalledTimes(4);
		const finalAnswer = chatContainer.addChild.mock.calls[1]?.[0] as Markdown | undefined;
		expect(finalAnswer).toBeInstanceOf(Markdown);
		if (!finalAnswer) throw new Error("Expected the rendered plain final answer");
		const renderedAnswer = finalAnswer.render(200).join("\n");
		expect(renderedAnswer).toContain("rendered for the user");

		const finalCard = chatContainer.addChild.mock.calls[3]?.[0] as Text | undefined;
		expect(finalCard).toBeInstanceOf(Text);
		if (!finalCard) throw new Error("Expected the terminal result card");
		const renderedCard = finalCard.render(200).join("\n");
		expect(renderedCard).toContain("Completed");
		expect(renderedCard).not.toContain("Completed · plain final answer");
	});

	it("keeps a taken-over child alive after its initial turn for idle follow-ups, then finalizes on release", async () => {
		const { cwd, agentDir } = await createWorkspace();
		let startInitialTurn!: () => void;
		const initialTurnStarted = new Promise<void>((resolve) => {
			startInitialTurn = resolve;
		});
		let releaseInitialTurn!: () => void;
		const initialTurn = new Promise<void>((resolve) => {
			releaseInitialTurn = resolve;
		});
		const child = new InteractiveChildSession(cwd, initialTurn, startInitialTurn);
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(passiveSession("parent", cwd));
		bridge.connectLiveSessions(registry);
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		const runner = new NativeSubagentRunner({
			agentDir,
			liveSessionRegistry: registry,
			agentViewBridge: bridge,
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const runPromise = runner.runResolved(normalized, ["delegate", "read", "grep", "find", "ls"], {
			model: { provider: "faux", id: "faux" } as Model<Api>,
		});
		await initialTurnStarted;
		bridge.requestDisplay(normalized.runId);
		expect(bridge.requestTakeControl()).toEqual({ accepted: true, mode: "controlled" });
		releaseInitialTurn();
		await vi.waitFor(() => expect(child.isStreaming).toBe(false));
		await bridge.sendInput(normalized.runId, "steer child");
		expect(child.promptCalls[1]).toMatchObject({ text: "steer child", options: { source: "interactive" } });
		expect(child.promptCalls[1]?.options).not.toHaveProperty("streamingBehavior");
		expect(bridge.requestTakeControl()).toEqual({ accepted: true, mode: "mirror" });
		const result = await runPromise;
		expect(result).toMatchObject({ status: "completed", summary: "verified final" });
		expect(child.promptCalls).toHaveLength(3);
	});

	it("honors parent timeout while a child remains under control and releases the live session", async () => {
		const { cwd, agentDir } = await createWorkspace();
		let startInitialTurn!: () => void;
		const initialTurnStarted = new Promise<void>((resolve) => {
			startInitialTurn = resolve;
		});
		let releaseInitialTurn!: () => void;
		const initialTurn = new Promise<void>((resolve) => {
			releaseInitialTurn = resolve;
		});
		const child = new InteractiveChildSession(cwd, initialTurn, startInitialTurn);
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(passiveSession("parent", cwd));
		bridge.connectLiveSessions(registry);
		const normalized = normalizeSubagentRequest({ ...request(cwd), timeoutMs: 50 }, cwd, { agentDir });
		const runner = new NativeSubagentRunner({
			agentDir,
			liveSessionRegistry: registry,
			agentViewBridge: bridge,
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const runPromise = runner.runResolved(normalized, ["delegate", "read", "grep", "find", "ls"], {
			model: { provider: "faux", id: "faux" } as Model<Api>,
		});
		await initialTurnStarted;
		bridge.requestDisplay(normalized.runId);
		expect(bridge.requestTakeControl()).toMatchObject({ accepted: true, mode: "controlled" });
		releaseInitialTurn();
		const result = await runPromise;
		expect(result).toMatchObject({ status: "timed_out", partial: true });
		expect(child.abort).toHaveBeenCalled();
		expect(registry.get(normalized.runId)).toBeUndefined();
		expect(bridge.getView(normalized.runId)).toMatchObject({ kind: "historical-subagent", status: "timed_out" });
	});

	it("rejects malformed explicit final reports after steering instead of accepting conversational output", async () => {
		const { cwd, agentDir } = await createWorkspace();
		let startInitialTurn!: () => void;
		const initialTurnStarted = new Promise<void>((resolve) => {
			startInitialTurn = resolve;
		});
		let releaseInitialTurn!: () => void;
		const initialTurn = new Promise<void>((resolve) => {
			releaseInitialTurn = resolve;
		});
		const child = new InteractiveChildSession(cwd, initialTurn, startInitialTurn, { text: "not-json" });
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(passiveSession("parent", cwd));
		bridge.connectLiveSessions(registry);
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		const runner = new NativeSubagentRunner({
			agentDir,
			liveSessionRegistry: registry,
			agentViewBridge: bridge,
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const runPromise = runner.runResolved(normalized, ["delegate", "read", "grep", "find", "ls"], {
			model: { provider: "faux", id: "faux" } as Model<Api>,
		});
		await initialTurnStarted;
		bridge.requestDisplay(normalized.runId);
		bridge.requestTakeControl();
		await bridge.sendInput(normalized.runId, "steer child");
		releaseInitialTurn();
		bridge.requestTakeControl();
		const result = await runPromise;
		// A malformed final envelope after steered work is a preserved-artifact
		// protocol failure, never a verified completion and never conversational output.
		expect(result.status).toBe("verification_failed");
		expect(result.summary).not.toBe("conversation JSON, not final");
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("report_protocol_failure");
		expect(result.workArtifact?.reportProtocol).toMatchObject({ status: "malformed" });
	});

	it("keeps the non-steered fast path to a single bounded report turn", async () => {
		const { cwd, agentDir } = await createWorkspace();
		let startInitialTurn!: () => void;
		const initialTurnStarted = new Promise<void>((resolve) => {
			startInitialTurn = resolve;
		});
		let releaseInitialTurn!: () => void;
		const initialTurn = new Promise<void>((resolve) => {
			releaseInitialTurn = resolve;
		});
		const child = new InteractiveChildSession(cwd, initialTurn, startInitialTurn);
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		const runner = new NativeSubagentRunner({
			agentDir,
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const runPromise = runner.runResolved(normalized, ["delegate", "read", "grep", "find", "ls"], {
			model: { provider: "faux", id: "faux" } as Model<Api>,
		});
		await initialTurnStarted;
		releaseInitialTurn();
		const result = await runPromise;
		expect(result).toMatchObject({ status: "completed", summary: "conversation JSON, not final" });
		expect(child.promptCalls).toHaveLength(1);
	});

	it("enforces the bounded output cap on the explicit finalization response", async () => {
		const { cwd, agentDir } = await createWorkspace();
		let startInitialTurn!: () => void;
		const initialTurnStarted = new Promise<void>((resolve) => {
			startInitialTurn = resolve;
		});
		let releaseInitialTurn!: () => void;
		const initialTurn = new Promise<void>((resolve) => {
			releaseInitialTurn = resolve;
		});
		const oversized = JSON.stringify({ summary: "x".repeat(30_000), evidence: { paths: ["src"] } });
		const child = new InteractiveChildSession(cwd, initialTurn, startInitialTurn, { text: oversized });
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(passiveSession("parent", cwd));
		bridge.connectLiveSessions(registry);
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		const runner = new NativeSubagentRunner({
			agentDir,
			liveSessionRegistry: registry,
			agentViewBridge: bridge,
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const runPromise = runner.runResolved(normalized, ["delegate", "read", "grep", "find", "ls"], {
			model: { provider: "faux", id: "faux" } as Model<Api>,
		});
		await initialTurnStarted;
		bridge.requestDisplay(normalized.runId);
		bridge.requestTakeControl();
		await bridge.sendInput(normalized.runId, "steer child");
		releaseInitialTurn();
		bridge.requestTakeControl();
		const result = await runPromise;
		expect(result.status).toBe("verification_failed");
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("report_protocol_failure");
		expect(result.workArtifact?.reportProtocol).toMatchObject({ status: "truncated" });
	});

	it("still validates review findings on the explicit post-steering final report", async () => {
		const { cwd, agentDir } = await createWorkspace();
		let startInitialTurn!: () => void;
		const initialTurnStarted = new Promise<void>((resolve) => {
			startInitialTurn = resolve;
		});
		let releaseInitialTurn!: () => void;
		const initialTurn = new Promise<void>((resolve) => {
			releaseInitialTurn = resolve;
		});
		const invalidReview = JSON.stringify({
			summary: "review final",
			evidence: { paths: ["src"] },
			findings: [{ severity: "impossible", category: "correctness", claim: "bad", evidence: ["src"] }],
		});
		const child = new InteractiveChildSession(cwd, initialTurn, startInitialTurn, { text: invalidReview });
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(passiveSession("parent", cwd));
		bridge.connectLiveSessions(registry);
		const normalized = normalizeSubagentRequest({ ...request(cwd), role: "self" }, cwd, { agentDir });
		const runner = new NativeSubagentRunner({
			agentDir,
			liveSessionRegistry: registry,
			agentViewBridge: bridge,
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const runPromise = runner.runResolved(normalized, ["delegate", "read", "grep", "find", "ls"], {
			model: { provider: "faux", id: "faux" } as Model<Api>,
		});
		await initialTurnStarted;
		bridge.requestDisplay(normalized.runId);
		bridge.requestTakeControl();
		await bridge.sendInput(normalized.runId, "steer child");
		releaseInitialTurn();
		bridge.requestTakeControl();
		const result = await runPromise;
		expect(result.status).toBe("verification_failed");
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("report_protocol_failure");
		expect(result.workArtifact?.reportProtocol).toMatchObject({ status: "malformed" });
	});

	it("fails deterministically when the provider errors during the explicit finalization turn", async () => {
		const { cwd, agentDir } = await createWorkspace();
		let startInitialTurn!: () => void;
		const initialTurnStarted = new Promise<void>((resolve) => {
			startInitialTurn = resolve;
		});
		let releaseInitialTurn!: () => void;
		const initialTurn = new Promise<void>((resolve) => {
			releaseInitialTurn = resolve;
		});
		const child = new InteractiveChildSession(cwd, initialTurn, startInitialTurn, {
			error: new Error("finalization provider failed"),
		});
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(passiveSession("parent", cwd));
		bridge.connectLiveSessions(registry);
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		const runner = new NativeSubagentRunner({
			agentDir,
			liveSessionRegistry: registry,
			agentViewBridge: bridge,
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const runPromise = runner.runResolved(normalized, ["delegate", "read", "grep", "find", "ls"], {
			model: { provider: "faux", id: "faux" } as Model<Api>,
		});
		await initialTurnStarted;
		bridge.requestDisplay(normalized.runId);
		bridge.requestTakeControl();
		await bridge.sendInput(normalized.runId, "steer child");
		releaseInitialTurn();
		bridge.requestTakeControl();
		const result = await runPromise;
		expect(result.status).toBe("failed");
		expect(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toMatch(
			/finalization provider failed/,
		);
	});

	it("times out deterministically while the explicit finalization turn is pending", async () => {
		const { cwd, agentDir } = await createWorkspace();
		let startInitialTurn!: () => void;
		const initialTurnStarted = new Promise<void>((resolve) => {
			startInitialTurn = resolve;
		});
		let releaseInitialTurn!: () => void;
		const initialTurn = new Promise<void>((resolve) => {
			releaseInitialTurn = resolve;
		});
		const neverFinalizes = new Promise<void>(() => {});
		const child = new InteractiveChildSession(cwd, initialTurn, startInitialTurn, { wait: neverFinalizes });
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(passiveSession("parent", cwd));
		bridge.connectLiveSessions(registry);
		const normalized = normalizeSubagentRequest({ ...request(cwd), timeoutMs: 100 }, cwd, { agentDir });
		const runner = new NativeSubagentRunner({
			agentDir,
			liveSessionRegistry: registry,
			agentViewBridge: bridge,
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const runPromise = runner.runResolved(normalized, ["delegate", "read", "grep", "find", "ls"], {
			model: { provider: "faux", id: "faux" } as Model<Api>,
		});
		await initialTurnStarted;
		bridge.requestDisplay(normalized.runId);
		bridge.requestTakeControl();
		await bridge.sendInput(normalized.runId, "steer child");
		releaseInitialTurn();
		bridge.requestTakeControl();
		await vi.waitFor(() => expect(child.promptCalls).toHaveLength(3));
		expect(bridge.getView(normalized.runId)?.controlState).toBe("final-report-requested");
		const result = await runPromise;
		expect(result).toMatchObject({ status: "timed_out", diagnostics: [{ code: "timeout" }] });
		expect(child.abort).toHaveBeenCalled();
		expect(bridge.getView(normalized.runId)).toMatchObject({ kind: "historical-subagent", status: "timed_out" });
	});

	it("cancels deterministically while the explicit finalization turn is pending", async () => {
		const { cwd, agentDir } = await createWorkspace();
		let startInitialTurn!: () => void;
		const initialTurnStarted = new Promise<void>((resolve) => {
			startInitialTurn = resolve;
		});
		let releaseInitialTurn!: () => void;
		const initialTurn = new Promise<void>((resolve) => {
			releaseInitialTurn = resolve;
		});
		const neverFinalizes = new Promise<void>(() => {});
		const child = new InteractiveChildSession(cwd, initialTurn, startInitialTurn, { wait: neverFinalizes });
		const registry = new SubagentLiveSessionRegistry();
		const bridge = new IceAgentViewBridge();
		bridge.setParentSession(passiveSession("parent", cwd));
		bridge.connectLiveSessions(registry);
		const normalized = normalizeSubagentRequest(request(cwd), cwd, { agentDir });
		const controller = new AbortController();
		const runner = new NativeSubagentRunner({
			agentDir,
			liveSessionRegistry: registry,
			agentViewBridge: bridge,
			createSession: async () => ({ session: child }) as unknown as CreateAgentSessionResult,
		});
		const runPromise = runner.runResolved(normalized, ["delegate", "read", "grep", "find", "ls"], {
			model: { provider: "faux", id: "faux" } as Model<Api>,
			signal: controller.signal,
		});
		await initialTurnStarted;
		bridge.requestDisplay(normalized.runId);
		bridge.requestTakeControl();
		await bridge.sendInput(normalized.runId, "steer child");
		releaseInitialTurn();
		bridge.requestTakeControl();
		await vi.waitFor(() => expect(child.promptCalls).toHaveLength(3));
		expect(bridge.getView(normalized.runId)?.controlState).toBe("final-report-requested");
		controller.abort();
		const result = await runPromise;
		expect(result).toMatchObject({ status: "cancelled", partial: true });
		expect(child.abort).toHaveBeenCalled();
		expect(bridge.getView(normalized.runId)).toMatchObject({ kind: "historical-subagent", status: "cancelled" });
	});
});
