/** Transcript and observatory TUI components (moved from ice-subagents.ts). */
import type { AgentMessage, AgentToolResult } from "@zykairotis/ice-agent-core";
import type { AssistantMessage } from "@zykairotis/ice-ai/compat";
import { type Component, Container, ScrollView, Spacer, Text, type TUI, truncateToWidth } from "@zykairotis/ice-tui";
import type { KeybindingsManager } from "../../core/extensions/types.ts";
import { type ReadonlySessionManager, sessionEntryToContextMessages } from "../../core/session-manager.ts";
import type { IceAgentViewBridge, IceAgentViewColor } from "../../ice-agent-view-bridge.ts";
import { AssistantMessageComponent } from "../../modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../../modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../modes/interactive/components/user-message.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { getMarkdownTheme } from "../../modes/interactive/theme/theme.ts";
import { redactCredentialText } from "../../utils/redact.ts";
import type { SubagentJobRegistry } from "../registry/jobs.ts";
import { isRecord } from "../results/report.ts";
import type { SubagentLiveSession, SubagentLiveSessionRegistry } from "../runtime/live-session.ts";
import { formatSubagentTelemetrySummary, type SubagentTelemetryStore } from "../telemetry/outcomes.ts";
import {
	type DurableSubagentJobResultView,
	type DurableSubagentJobViewSnapshot,
	durableJobEntryKeys,
	formatDurableSubagentJobDetail,
	formatObservatoryRows,
	isDurableJobInspectable,
	projectDurableSubagentJob,
	projectDurableSubagentJobResult,
	type SubagentCompletionInboxItem,
	type SubagentObservatoryStore,
} from "./observatory.ts";

function transcriptTextContent(message: AgentMessage): string {
	const content = (message as AgentMessage & { content?: unknown }).content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!isRecord(part)) return "";
			return part.type === "text" && typeof part.text === "string" ? part.text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

class SubagentTranscriptComponent extends Container {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly markdownTheme = getMarkdownTheme();
	private readonly messageProvider?: () => readonly AgentMessage[];
	private sessionManager: ReadonlySessionManager | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		sessionManager?: ReadonlySessionManager,
		messageProvider?: () => readonly AgentMessage[],
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.sessionManager = sessionManager;
		this.messageProvider = messageProvider;
		this.rebuild();
	}

	setSessionManager(sessionManager: ReadonlySessionManager | undefined): void {
		this.sessionManager = sessionManager;
		this.rebuild();
	}

	private renderLiveMessages(
		messages: readonly AgentMessage[],
		pendingTools: Map<string, ToolExecutionComponent>,
	): void {
		for (const message of messages) {
			if (message.role === "user") {
				const text = transcriptTextContent(message);
				if (!text) continue;
				if (this.children.length > 0) this.addChild(new Spacer(1));
				this.addChild(new UserMessageComponent(text, this.markdownTheme));
				continue;
			}
			if (message.role === "assistant") {
				this.addChild(new AssistantMessageComponent(message as AssistantMessage));
				for (const content of message.content) {
					if (content.type !== "toolCall") continue;
					const component = new ToolExecutionComponent(
						content.name,
						content.id,
						content.arguments,
						undefined,
						undefined,
						this.tui,
						this.sessionManager!.getCwd(),
					);
					pendingTools.set(content.id, component);
					this.addChild(component);
				}
				continue;
			}
			if (message.role === "toolResult") {
				const result = message as AgentToolResult<unknown> & { isError?: boolean };
				pendingTools.get(message.toolCallId)?.updateResult({
					content: result.content,
					details: result.details,
					isError: result.isError === true,
				});
				continue;
			}
			const text = transcriptTextContent(message);
			if (text) this.addChild(new Text(this.theme.fg("muted", text), 1, 0));
		}
	}

	rebuild(): void {
		this.clear();
		if (!this.sessionManager) {
			this.addChild(new Text(this.theme.fg("muted", "No live child session selected."), 1, 0));
			return;
		}
		const pendingTools = new Map<string, ToolExecutionComponent>();
		const liveMessages = this.messageProvider?.();
		if (liveMessages) {
			this.renderLiveMessages(liveMessages, pendingTools);
			return;
		}
		for (const entry of this.sessionManager.buildContextEntries()) {
			if (entry.type === "custom") {
				const content = entry.data === undefined ? "[custom session entry]" : JSON.stringify(entry.data);
				this.addChild(new Text(this.theme.fg("muted", redactCredentialText(content)), 1, 0));
				continue;
			}
			for (const message of sessionEntryToContextMessages(entry)) {
				if (message.role === "user") {
					const text = transcriptTextContent(message);
					if (!text) continue;
					if (this.children.length > 0) this.addChild(new Spacer(1));
					this.addChild(new UserMessageComponent(text, this.markdownTheme));
					continue;
				}
				if (message.role === "assistant") {
					this.addChild(new AssistantMessageComponent(message as AssistantMessage));
					for (const content of message.content) {
						if (content.type !== "toolCall") continue;
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							undefined,
							undefined,
							this.tui,
							this.sessionManager.getCwd(),
						);
						pendingTools.set(content.id, component);
						this.addChild(component);
					}
					continue;
				}
				if (message.role === "toolResult") {
					const result = message as AgentToolResult<unknown> & { isError?: boolean };
					pendingTools.get(message.toolCallId)?.updateResult({
						content: result.content,
						details: result.details,
						isError: result.isError === true,
					});
					continue;
				}
				const text = transcriptTextContent(message);
				if (text) this.addChild(new Text(this.theme.fg("muted", text), 1, 0));
			}
		}
	}
}

class SplitTranscriptComponent implements Component {
	private readonly left: Component;
	private readonly right: Component;
	private readonly theme: Theme;

	constructor(left: Component, right: Component, theme: Theme) {
		this.left = left;
		this.right = right;
		this.theme = theme;
	}

	invalidate(): void {
		this.left.invalidate?.();
		this.right.invalidate?.();
	}

	render(width: number): string[] {
		const dividerWidth = 1;
		const leftWidth = Math.max(1, Math.floor((width - dividerWidth) / 2));
		const rightWidth = Math.max(1, width - dividerWidth - leftWidth);
		const leftLines = this.left.render(leftWidth);
		const rightLines = this.right.render(rightWidth);
		const height = Math.max(leftLines.length, rightLines.length);
		return Array.from({ length: height }, (_, index) => {
			const left = truncateToWidth(leftLines[index] ?? "", leftWidth, "", true);
			const right = truncateToWidth(rightLines[index] ?? "", rightWidth, "", true);
			return `${left}${this.theme.fg("border", "│")}${right}`;
		});
	}
}

export function parseAgentsViewMode(args: string | undefined): "full" | "split" {
	return args?.trim().split(/\s+/)[0] === "split" ? "split" : "full";
}

export class SubagentObservatoryView extends Container {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly parentSessionManager: ReadonlySessionManager;
	private readonly viewMode: "full" | "split";
	private paneFocus: "parent" | "child" = "child";
	private readonly keybindings: KeybindingsManager;
	private readonly store: SubagentObservatoryStore;
	private readonly jobs?: SubagentJobRegistry;
	private readonly liveSessions: SubagentLiveSessionRegistry;
	private readonly agentViewBridge?: IceAgentViewBridge;
	private readonly completionInbox: readonly SubagentCompletionInboxItem[];
	private readonly telemetry: SubagentTelemetryStore;
	private readonly done: () => void;
	private readonly unsubscribe: () => void;
	private readonly unsubscribeJobs: () => void;
	private readonly unsubscribeLiveSessions: () => void;
	private unsubscribeAttachedSession: (() => void) | undefined;
	private attachedSession: SubagentLiveSession | undefined;
	private selectedIndex = 0;
	private readonly expandedKeys = new Set<string>();
	private inspectedJobId?: string;
	private inspectedJobDetail?: DurableSubagentJobResultView;
	private inspectionSelectionKey?: string;
	private inspectionNotice?: string;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		store: SubagentObservatoryStore,
		jobs: SubagentJobRegistry | undefined,
		liveSessions: SubagentLiveSessionRegistry,
		agentViewBridge: IceAgentViewBridge | undefined,
		completionInbox: readonly SubagentCompletionInboxItem[],
		telemetry: SubagentTelemetryStore,
		parentSessionManager: ReadonlySessionManager,
		viewMode: "full" | "split",
		done: () => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.store = store;
		this.jobs = jobs;
		this.liveSessions = liveSessions;
		this.agentViewBridge = agentViewBridge;
		this.completionInbox = completionInbox;
		this.telemetry = telemetry;
		this.parentSessionManager = parentSessionManager;
		this.viewMode = viewMode;
		this.done = done;
		this.unsubscribe = store.subscribe(() => this.refresh());
		this.unsubscribeJobs = jobs?.subscribe(() => this.refresh()) ?? (() => {});
		this.unsubscribeLiveSessions = liveSessions.subscribe(() => this.refresh());
		this.refresh();
	}

	handleInput(data: string): void {
		if (this.attachedSession) {
			if (
				this.keybindings.matches(data, "tui.select.cancel") ||
				this.keybindings.matches(data, "app.subagents.expand")
			) {
				this.detachSession();
				return;
			}
			if (this.viewMode === "full" && this.keybindings.matches(data, "tui.select.up")) {
				this.moveSelection(-1);
				this.attachSelected();
				return;
			}
			if (this.viewMode === "full" && this.keybindings.matches(data, "tui.select.down")) {
				this.moveSelection(1);
				this.attachSelected();
				return;
			}
			this.refresh();
			return;
		}
		if (this.inspectedJobId) {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.closeInspection();
				return;
			}
			this.refresh();
			return;
		}
		const keys = this.entryKeys();
		const count = keys.length;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.dispose();
			this.done();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			if (this.viewMode !== "split" || this.paneFocus === "child") this.moveSelection(-1, count);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			if (this.viewMode !== "split" || this.paneFocus === "child") this.moveSelection(1, count);
		} else if (this.keybindings.matches(data, "app.subagents.attach")) {
			this.attachSelected();
		} else if (this.keybindings.matches(data, "app.subagents.expand")) {
			if (this.viewMode === "split") this.paneFocus = this.paneFocus === "child" ? "parent" : "child";
			else if (this.selectedLiveSession()) this.attachSelected();
			else this.toggleSelected(keys[this.selectedIndex]);
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (this.selectedLiveSession()) this.attachSelected();
			else this.toggleSelected(keys[this.selectedIndex]);
		} else if (this.keybindings.matches(data, "app.subagents.inspect")) {
			this.inspectSelectedJob(keys[this.selectedIndex]);
		}
		this.refresh();
	}

	dispose(): void {
		this.unsubscribe();
		this.unsubscribeJobs();
		this.unsubscribeLiveSessions();
		this.unsubscribeAttachedSession?.();
	}

	private moveSelection(delta: number, count = this.entryKeys().length): void {
		this.selectedIndex = Math.min(Math.max(0, count - 1), Math.max(0, this.selectedIndex + delta));
	}

	private toggleSelected(key: string | undefined): void {
		if (!key) return;
		if (this.expandedKeys.has(key)) this.expandedKeys.delete(key);
		else this.expandedKeys.add(key);
	}

	private selectedForegroundRunId(): string | undefined {
		const foreground = [...this.store.getState().active, ...this.store.getState().recent];
		return foreground[this.selectedIndex]?.runId;
	}

	private selectedLiveSession(): SubagentLiveSession | undefined {
		return this.liveSessions.get(this.selectedForegroundRunId());
	}

	private attachSelected(): void {
		const runId = this.selectedForegroundRunId();
		if (this.agentViewBridge && this.viewMode === "full" && runId) {
			const view = this.agentViewBridge.getView(runId);
			if (view && view.kind !== "parent" && this.agentViewBridge.requestDisplay(view.id)) {
				this.dispose();
				this.done();
				return;
			}
		}

		const session = this.selectedLiveSession();
		if (!session) return;
		this.unsubscribeAttachedSession?.();
		this.attachedSession = session;
		this.unsubscribeAttachedSession = session.session.subscribe(() => this.refresh());
	}

	private detachSession(): void {
		this.unsubscribeAttachedSession?.();
		this.unsubscribeAttachedSession = undefined;
		this.attachedSession = undefined;
		this.refresh();
	}

	private inspectSelectedJob(jobId: string | undefined): void {
		this.inspectionNotice = undefined;
		const durableJobs = this.durableJobs();
		const foregroundCount = this.store.getState().active.length + this.store.getState().recent.length;
		const selectedDurableJobId = durableJobEntryKeys(durableJobs)[this.selectedIndex - foregroundCount];
		const job =
			jobId && selectedDurableJobId === jobId
				? durableJobs.find((candidate) => candidate.jobId === jobId)
				: undefined;
		if (!job || !isDurableJobInspectable(job.status)) {
			this.inspectionNotice = "Select a terminal background job to inspect.";
			return;
		}
		if (!this.jobs) {
			this.inspectionNotice = "Durable jobs are unavailable.";
			return;
		}
		try {
			const detail = projectDurableSubagentJobResult(this.jobs.inspect(job.jobId));
			if (!detail) {
				this.inspectionNotice = "Selected job has no terminal result.";
				return;
			}
			this.inspectedJobId = job.jobId;
			this.inspectedJobDetail = detail;
			this.inspectionSelectionKey = job.jobId;
		} catch {
			this.inspectionNotice = "Selected job is no longer retained.";
		}
	}

	private closeInspection(): void {
		const selectionKey = this.inspectionSelectionKey;
		this.inspectedJobId = undefined;
		this.inspectedJobDetail = undefined;
		this.inspectionSelectionKey = undefined;
		this.inspectionNotice = undefined;
		if (selectionKey) {
			const state = this.store.getState();
			const durableKeys = durableJobEntryKeys(this.durableJobs());
			const durableIndex = durableKeys.indexOf(selectionKey);
			const foregroundCount = state.active.length + state.recent.length;
			this.selectedIndex =
				durableIndex >= 0
					? foregroundCount + durableIndex
					: Math.min(this.selectedIndex, Math.max(0, foregroundCount + durableKeys.length - 1));
		}
		this.refresh();
	}

	private durableJobDetailRows(): string[] {
		const jobId = this.inspectedJobId;
		if (!jobId) return [];
		if (this.inspectedJobDetail) return formatDurableSubagentJobDetail(this.inspectedJobDetail);
		return [`Background Job ${jobId}`, "", "Job is no longer retained.", "Esc to return."];
	}

	private durableJobs(): readonly DurableSubagentJobViewSnapshot[] {
		return this.jobs?.list().map(projectDurableSubagentJob) ?? [];
	}

	private colorForObservatoryRow(row: string): IceAgentViewColor | undefined {
		for (const snapshot of [...this.store.getState().active, ...this.store.getState().recent]) {
			if (!snapshot.color) continue;
			const identifiers = [snapshot.taskId, snapshot.role, snapshot.runId?.slice(0, 6)].filter(
				(value): value is string => value !== undefined && value.length > 0,
			);
			if (identifiers.some((identifier) => row.includes(` ${identifier} `))) return snapshot.color;
		}
		return undefined;
	}

	private entryKeys(): readonly string[] {
		const durableJobs = this.durableJobs();
		return Object.freeze([
			...this.store.getState().active.map((entry) => entry.streamKey),
			...this.store.getState().recent.map((entry) => entry.streamKey),
			...durableJobEntryKeys(durableJobs),
		]);
	}

	private refresh(): void {
		const durableJobs = this.durableJobs();
		const attached = this.attachedSession;
		this.clear();
		if (this.viewMode === "split") {
			const selected = this.selectedLiveSession();
			const parentTranscript = new ScrollView(
				new SubagentTranscriptComponent(this.tui, this.theme, this.parentSessionManager),
				{ follow: "end", scrollbar: "auto" },
			);
			const childTranscript = new ScrollView(
				new SubagentTranscriptComponent(
					this.tui,
					this.theme,
					selected?.session.sessionManager,
					selected ? () => selected.session.messages : undefined,
				),
				{ follow: "end", scrollbar: "auto" },
			);
			this.addChild(
				new Text(
					this.theme.fg(
						"accent",
						`/agents split · ${this.paneFocus === "parent" ? "parent" : "child"} focused · Space switches · Esc closes`,
					),
					1,
					0,
				),
			);
			this.addChild(new SplitTranscriptComponent(parentTranscript, childTranscript, this.theme));
			this.tui.requestRender();
			return;
		}
		if (attached) {
			this.addChild(
				new Text(
					this.theme.fg(
						"accent",
						`Subagent ${attached.role} ${attached.runId} · Space/Esc returns · Up/Down switches child`,
					),
					1,
					0,
				),
			);
			this.addChild(
				new ScrollView(
					new SubagentTranscriptComponent(
						this.tui,
						this.theme,
						attached.session.sessionManager,
						() => attached.session.messages,
					),
					{ follow: "end", scrollbar: "auto" },
				),
			);
			this.tui.requestRender();
			return;
		}
		const rows = this.inspectedJobId
			? this.durableJobDetailRows()
			: [
					...formatObservatoryRows(
						this.store.getState(),
						this.selectedIndex,
						this.expandedKeys,
						durableJobs,
						this.completionInbox,
						new Set(this.liveSessions.list().map((session) => session.runId)),
						this.agentViewBridge?.getDisplayedId() === "parent"
							? undefined
							: this.agentViewBridge?.getDisplayedId(),
					),
					...(formatSubagentTelemetrySummary(this.telemetry.summary()).map((row) => row) ?? []),
					...(this.inspectionNotice ? ["", `! ${this.inspectionNotice}`] : []),
				];
		for (const [index, row] of rows.entries()) {
			const profileColor = this.colorForObservatoryRow(row);
			const color =
				index === 0
					? "accent"
					: row === "ACTIVE" || row === "BACKGROUND ACTIVE"
						? "success"
						: row === "RECENT" || row === "BACKGROUND RECENT"
							? "muted"
							: row === "VERIFICATION FAILED" || row.startsWith("! ")
								? "error"
								: (profileColor ?? "text");
			this.addChild(new Text(this.theme.fg(color, row), 1, 0));
		}
		this.tui.requestRender();
	}
}
