import {
	applyChromeBorder,
	type Component,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@zykairotis/ice-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { IceAgentViewBridge, IceAgentViewDescriptor } from "../../../ice-agent-view-bridge.ts";
import type {
	SubagentRuntimeAttention,
	SubagentToolActivityOutcome,
} from "../../../ice-subagent-timeout-supervisor.ts";
import { createDefaultAppearance } from "../appearance/appearance-defaults.ts";
import { resolveAppearanceColorFn } from "../appearance/appearance-resolve.ts";
import type { SubagentChromeAppearance } from "../appearance/appearance-types.ts";
import { applyTextPresentation } from "../appearance/text-presentation.ts";
import type { Theme } from "../theme/theme.ts";

const DEFAULT_AGENT_CHROME = createDefaultAppearance().subagentChrome;
const MAX_VISIBLE_ROWS = 4;
const NARROW_TERMINAL_WIDTH = 72;
const COMPACT_IDENTITY_WIDTH = 44;

export interface SubagentFooterActivity {
	readonly toolName: string;
	readonly path?: string;
	readonly status: SubagentToolActivityOutcome;
}

export interface SubagentFooterAttention {
	readonly phase: SubagentRuntimeAttention["phase"];
	readonly state: SubagentRuntimeAttention["state"];
	readonly activeElapsedMs: number;
	readonly activeBudgetMs: number;
	readonly totalExtendedMs: number;
	readonly remainingExtendableMs: number;
	readonly recentActivities: readonly SubagentFooterActivity[];
	readonly repeatedFailureCount?: number;
}

export interface SubagentFooterEntry {
	readonly id: string;
	readonly label: string;
	readonly kind: "subagent" | "historical-subagent";
	readonly live: boolean;
	readonly retentionState?: "reusable" | "history-only";
	readonly status: string;
	readonly needsAttention: boolean;
	readonly attention?: SubagentFooterAttention;
}

export interface SubagentFooterSnapshot {
	readonly children: readonly SubagentFooterEntry[];
	readonly liveCount: number;
	readonly retainedCount: number;
	readonly attentionCount: number;
	readonly selectedChild?: SubagentFooterEntry;
	readonly selectedChildIndex?: number;
}

function boundedFooterText(text: string, maxWidth = 128): string {
	return truncateToWidth(
		text
			.replace(/[\u0000-\u001f\u007f]/g, " ")
			.replace(/ +/g, " ")
			.trim(),
		maxWidth,
		"…",
	);
}

function formatFooterActivity(activity: SubagentFooterActivity): string {
	const marker =
		activity.status === "error"
			? "!"
			: activity.status === "running"
				? "…"
				: activity.status === "aborted"
					? "×"
					: "✓";
	const location = [activity.toolName, activity.path].filter((part): part is string => Boolean(part)).join(" ");
	return `${marker} ${boundedFooterText(location, 96)}`;
}

function formatFooterTiming(attention: SubagentFooterAttention): string | undefined {
	if (attention.activeBudgetMs <= 0) return undefined;
	const elapsedSeconds = Math.floor(attention.activeElapsedMs / 1000);
	const remainingSeconds =
		attention.state === "awaiting_extension"
			? Math.floor(attention.remainingExtendableMs / 1000)
			: Math.max(0, Math.floor((attention.activeBudgetMs - attention.activeElapsedMs) / 1000));
	const remainingLabel = attention.state === "awaiting_extension" ? "extendable" : "left";
	const extension = attention.totalExtendedMs > 0 ? ` · +${Math.floor(attention.totalExtendedMs / 1000)}s` : "";
	return `${elapsedSeconds}s elapsed · ${remainingSeconds}s ${remainingLabel}${extension}`;
}

function footerAttention(view: IceAgentViewDescriptor): SubagentFooterAttention | undefined {
	const runtime = view.presentation?.runtimeAttention;
	if (!runtime) return undefined;
	const recentActivities = Object.freeze(
		runtime.lastActivities
			.slice(-3)
			.filter((activity) => view.live || activity.status !== "running")
			.map((activity) =>
				Object.freeze({
					toolName: boundedFooterText(activity.toolName, 64),
					...(activity.path ? { path: boundedFooterText(activity.path, 96) } : {}),
					status: activity.status,
				}),
			),
	);
	return Object.freeze({
		phase: runtime.phase,
		state: runtime.state,
		activeElapsedMs: runtime.activeElapsedMs,
		activeBudgetMs: runtime.activeBudgetMs,
		totalExtendedMs: runtime.totalExtendedMs,
		remainingExtendableMs: runtime.remainingExtendableMs,
		recentActivities,
		...(runtime.repeatedFailure ? { repeatedFailureCount: runtime.repeatedFailure.count } : {}),
	});
}

function footerStatus(view: IceAgentViewDescriptor, attention: SubagentFooterAttention | undefined): string {
	if (view.kind === "parent") return "MAIN";
	if (!view.live) return (view.status ?? "history").replaceAll("_", " ").replaceAll("-", " ").toUpperCase();
	if (attention?.phase === "finalization" && (view.controlState === undefined || view.controlState === "working"))
		return "FINALIZING";
	if (view.controlState && view.controlState !== "working")
		return view.controlState.replaceAll("-", " ").toUpperCase();
	return (view.status ?? "LIVE").toUpperCase();
}

function hasFooterAttention(view: IceAgentViewDescriptor, attention: SubagentFooterAttention | undefined): boolean {
	if (!view.live) return false;
	return (
		view.controlState === "awaiting-extension" ||
		view.controlState === "awaiting-finalization" ||
		view.controlState === "final-report-requested" ||
		attention?.state === "awaiting_extension" ||
		attention?.phase === "finalization" ||
		attention?.repeatedFailureCount !== undefined
	);
}

/** Derive the bounded footer projection from one bridge-owned view snapshot. */
export function createSubagentFooterSnapshot(
	views: readonly IceAgentViewDescriptor[],
	selectedViewId: string | undefined,
	displayedId: string,
): SubagentFooterSnapshot {
	const children = Object.freeze(
		views
			.filter(
				(view): view is IceAgentViewDescriptor & { readonly kind: "subagent" | "historical-subagent" } =>
					view.kind !== "parent",
			)
			.map((view) => {
				const attention = footerAttention(view);
				return Object.freeze({
					id: view.id,
					label: boundedFooterText(formatAgentSwitcherLabel(view)),
					kind: view.kind,
					live: view.live,
					...(view.retentionState ? { retentionState: view.retentionState } : {}),
					status: footerStatus(view, attention),
					needsAttention: hasFooterAttention(view, attention),
					...(attention ? { attention } : {}),
				});
			}),
	);
	const liveCount = children.filter((view) => view.live).length;
	const selectedChild =
		children.find((view) => view.id === displayedId) ??
		children.find((view) => view.id === selectedViewId) ??
		children[0];
	return Object.freeze({
		children,
		liveCount,
		retainedCount: children.filter((view) => view.retentionState === "reusable").length,
		attentionCount: children.filter((view) => view.needsAttention).length,
		...(selectedChild
			? {
					selectedChild,
					selectedChildIndex: children.findIndex((view) => view.id === selectedChild.id) + 1,
				}
			: {}),
	});
}

export function agentSwitcherStatus(view: IceAgentViewDescriptor): string {
	if (view.kind === "parent") return "MAIN";
	if (!view.live) return (view.status ?? "history").toUpperCase();
	if (view.controlState && view.controlState !== "working")
		return view.controlState.replaceAll("-", " ").toUpperCase();
	if (view.interactionMode === "controlled") return "CONTROLLED";
	return (view.status ?? "LIVE").toUpperCase();
}

export function formatAgentSwitcherLabel(view: IceAgentViewDescriptor): string {
	if (view.kind === "parent") return "Main agent";
	const identity = view.taskId ?? view.runId?.slice(0, 8);
	return [view.role ?? view.label, identity ? `· ${identity}` : undefined].filter(Boolean).join(" ");
}

function padVisible(text: string, width: number): string {
	const truncated = truncateToWidth(text, Math.max(0, width), "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/** Compact selector mounted in InteractiveMode's bottom dock. */
export class SubagentFooterSwitcher implements Component {
	private selectedIndex = 0;
	private views: readonly IceAgentViewDescriptor[] = [];
	private readonly unsubscribe: () => void;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly bridge: IceAgentViewBridge;
	private readonly done: () => void;
	private expanded: boolean;
	private disposed = false;
	private actionMessage: string | undefined;
	private appearance: SubagentChromeAppearance | null = null;
	private footerSnapshot: SubagentFooterSnapshot = Object.freeze({
		children: Object.freeze([]),
		liveCount: 0,
		retainedCount: 0,
		attentionCount: 0,
	});

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		bridge: IceAgentViewBridge,
		done: () => void,
		expanded = true,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.bridge = bridge;
		this.done = done;
		this.expanded = expanded;
		this.refreshViews(true);
		this.unsubscribe = bridge.subscribe(() => {
			this.refreshViews(false);
			this.tui.requestRender();
		});
	}

	setAppearance(appearance: SubagentChromeAppearance | null): void {
		this.appearance = appearance ? structuredClone(appearance) : null;
		this.tui.requestRender();
	}

	private isCustomized(): boolean {
		return Boolean(this.appearance && JSON.stringify(this.appearance) !== JSON.stringify(DEFAULT_AGENT_CHROME));
	}

	private styleSelected(text: string): string {
		if (!this.appearance || !this.isCustomized()) return this.theme.bg("selectedBg", this.theme.fg("text", text));
		return applyTextPresentation(
			{
				foreground: this.appearance.selectedForeground,
				background: this.appearance.selectedBackground,
				styles: this.appearance.selectedStyles,
			},
			text,
		);
	}

	private styleView(view: IceAgentViewDescriptor, text: string, viewing: boolean): string {
		if (!this.appearance || !this.isCustomized())
			return viewing
				? this.theme.fg(view.color ?? "accent", text)
				: this.theme.fg(view.color ?? "muted", text);
		const footerView = this.footerSnapshot.children.find((entry) => entry.id === view.id);
		if (footerView?.needsAttention) return applyTextPresentation(this.appearance.attention, text);
		if (view.kind === "subagent" && view.live && view.controlState === "awaiting-extension")
			return applyTextPresentation(this.appearance.attention, text);
		const status = String(view.status ?? "").toLowerCase();
		if (status.includes("fail") || status.includes("error"))
			return applyTextPresentation(this.appearance.failed, text);
		if (view.live) return applyTextPresentation(this.appearance.running, text);
		if (view.kind === "subagent") return applyTextPresentation(this.appearance.completed, text);
		return applyTextPresentation(this.appearance.muted, text);
	}

	render(width: number): string[] {
		if (this.views.length === 0) return [];
		if (!this.expanded) return this.renderCollapsed(width);
		const rows = width < NARROW_TERMINAL_WIDTH ? this.renderNarrow(width) : this.renderWide(width);
		if (!this.appearance || this.appearance.borderStyle === "none" || width < 8) return rows;
		return applyChromeBorder(
			rows,
			width,
			this.appearance.borderStyle,
			resolveAppearanceColorFn(this.appearance.borderColor, "fg"),
		);
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.refreshViews(false);
		this.tui.requestRender();
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
			this.close();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
			this.moveSelection(-1);
			return;
		}
		if (
			this.keybindings.matches(data, "tui.select.down") ||
			matchesKey(data, Key.down) ||
			matchesKey(data, Key.right)
		) {
			this.moveSelection(1);
			return;
		}
		const selected = this.views[this.selectedIndex];
		if (selected?.kind === "subagent" && selected.live && selected.controlState === "awaiting-extension") {
			if (data === "e" || data === "E") {
				const attention = this.bridge.getRuntimeAttention(selected.id);
				const preferredMs = attention?.phase === "finalization" ? 30_000 : 60_000;
				const additionalMs = Math.min(preferredMs, attention?.remainingExtendableMs ?? preferredMs);
				if (additionalMs < 1_000) {
					this.actionMessage = "No extension budget remains";
					this.tui.requestRender();
					return;
				}
				this.actionMessage = `Extending ${Math.round(additionalMs / 1000)}s…`;
				void this.bridge.extendRuntime(selected.id, additionalMs).catch((error) => {
					this.actionMessage = error instanceof Error ? error.message : String(error);
					this.tui.requestRender();
				});
				this.tui.requestRender();
				return;
			}
			if (data === "x" || data === "X") {
				this.actionMessage = "Stopping subagent…";
				void this.bridge.stopRuntime(selected.id).catch((error) => {
					this.actionMessage = error instanceof Error ? error.message : String(error);
					this.tui.requestRender();
				});
				this.tui.requestRender();
				return;
			}
		}
		if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
			const selected = this.views[this.selectedIndex];
			if (selected && this.bridge.requestDisplay(selected.id)) this.close();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	private close(): void {
		this.setExpanded(false);
		this.done();
	}

	private moveSelection(delta: number): void {
		if (this.views.length === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + this.views.length) % this.views.length;
		this.tui.requestRender();
	}

	private refreshViews(initial: boolean): void {
		const previousId = this.views[this.selectedIndex]?.id;
		const displayedId = this.bridge.getDisplayedId();
		this.views = this.bridge.listViews();
		const preferredId = initial ? displayedId : previousId;
		const preferredIndex = preferredId ? this.views.findIndex((view) => view.id === preferredId) : -1;
		if (preferredIndex >= 0) this.selectedIndex = preferredIndex;
		else this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.views.length - 1));
		this.footerSnapshot = createSubagentFooterSnapshot(this.views, this.views[this.selectedIndex]?.id, displayedId);
	}

	private renderCollapsed(width: number): string[] {
		const snapshot = this.footerSnapshot;
		if (snapshot.children.length === 0) return [];
		const selected = snapshot.selectedChild;
		const selectedPosition = selected ? `${snapshot.selectedChildIndex}/${snapshot.children.length}` : undefined;
		const counts = [
			`${snapshot.liveCount} active`,
			snapshot.retainedCount > 0 ? `${snapshot.retainedCount} retained` : undefined,
			snapshot.attentionCount > 0 ? `${snapshot.attentionCount} needs attention` : undefined,
		]
			.filter((part): part is string => part !== undefined)
			.join(" · ");
		const selectedSummary = selected ? ` · [${selectedPosition} ${selected.label}] ${selected.status}` : "";
		const summary = `Agents ${counts}${selectedSummary} · /agents`;
		const countOnly = [
			`Agents ${snapshot.children.length}`,
			snapshot.attentionCount > 0 ? `!${snapshot.attentionCount} attention` : undefined,
			`${snapshot.liveCount} active`,
			snapshot.retainedCount > 0 ? `${snapshot.retainedCount} retained` : undefined,
		]
			.filter((part): part is string => part !== undefined)
			.join(" · ");
		const detailParts = selected
			? [
					selected.attention?.recentActivities.length
						? selected.attention.recentActivities.map(formatFooterActivity).join(" · ")
						: undefined,
					selected.attention ? formatFooterTiming(selected.attention) : undefined,
					selected.attention?.repeatedFailureCount !== undefined
						? `${selected.attention.repeatedFailureCount} recent failures`
						: undefined,
				]
					.filter((part): part is string => part !== undefined)
					.join(" · ")
			: "";
		const detail = detailParts ? `  ${detailParts}` : "";
		if (width < COMPACT_IDENTITY_WIDTH) return [this.styleCollapsed(padVisible(countOnly, width), selected)];
		if (width < NARROW_TERMINAL_WIDTH || !detail) return [this.styleCollapsed(padVisible(summary, width), selected)];
		return [
			this.styleCollapsed(padVisible(summary, width), selected),
			this.styleCollapsed(padVisible(detail, width), selected),
		];
	}

	private styleCollapsed(text: string, selected: SubagentFooterEntry | undefined): string {
		if (!this.appearance || !this.isCustomized()) return this.theme.fg("accent", text);
		if (selected?.needsAttention || this.footerSnapshot.attentionCount > 0)
			return applyTextPresentation(this.appearance.attention, text);
		return applyTextPresentation(selected?.live ? this.appearance.running : this.appearance.muted, text);
	}

	private renderWide(width: number): string[] {
		const displayedId = this.bridge.getDisplayedId();
		const windowStart = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(MAX_VISIBLE_ROWS / 2),
				Math.max(0, this.views.length - MAX_VISIBLE_ROWS),
			),
		);
		const visibleViews = this.views.slice(windowStart, windowStart + MAX_VISIBLE_ROWS);
		const lines = [this.theme.fg("accent", "Agents")];
		for (let offset = 0; offset < visibleViews.length; offset += 1) {
			const index = windowStart + offset;
			const view = visibleViews[offset]!;
			const selected = index === this.selectedIndex;
			const viewing = view.id === displayedId;
			const selectionMarker = selected ? ">" : " ";
			const typeMarker = view.kind === "parent" ? "◆" : view.live ? "●" : "○";
			const suffix = viewing ? " · viewing" : "";
			const footerView = this.footerSnapshot.children.find((entry) => entry.id === view.id);
			const attention = footerView?.attention;
			const time = attention?.activeBudgetMs
				? ` · ${Math.floor(attention.activeElapsedMs / 1000)}/${Math.floor(attention.activeBudgetMs / 1000)}s`
				: "";
			const latestActivity = attention?.recentActivities.at(-1);
			const activity = selected && latestActivity ? ` · ${formatFooterActivity(latestActivity)}` : "";
			const status = `${footerView?.status ?? agentSwitcherStatus(view)}${time}${activity}${suffix}`;
			const prefix = `  ${selectionMarker} ${typeMarker} `;
			const statusWidth = Math.min(30, Math.max(12, visibleWidth(status)));
			const labelWidth = Math.max(1, width - visibleWidth(prefix) - statusWidth - 2);
			const row = `${prefix}${padVisible(formatAgentSwitcherLabel(view), labelWidth)}  ${padVisible(status, statusWidth)}`;
			const styled = selected
				? this.styleSelected(padVisible(row, width))
				: this.styleView(view, padVisible(row, width), viewing);
			lines.push(styled);
		}
		const hiddenBefore = windowStart;
		const hiddenAfter = Math.max(0, this.views.length - (windowStart + visibleViews.length));
		const hidden =
			hiddenBefore || hiddenAfter
				? ` · ${hiddenBefore ? `↑${hiddenBefore}` : ""}${hiddenBefore && hiddenAfter ? " " : ""}${hiddenAfter ? `↓${hiddenAfter}` : ""}`
				: "";
		const selectedView = this.views[this.selectedIndex];
		const attentionHint =
			selectedView?.kind === "subagent" && selectedView.live && selectedView.controlState === "awaiting-extension"
				? " · E extend · X stop"
				: "";
		const actionHint = this.actionMessage ? ` · ${this.actionMessage}` : "";
		lines.push(
			(this.isCustomized() && this.appearance
				? (text: string) => applyTextPresentation(this.appearance!.muted, text)
				: (text: string) => this.theme.fg("dim", text))(
				padVisible(
					`  ↑↓/←→ browse · Enter open${attentionHint} · Esc close · /agents split details${hidden}${actionHint}`,
					width,
				),
			),
		);
		return lines;
	}

	private renderNarrow(width: number): string[] {
		const view = this.views[this.selectedIndex];
		if (!view) return [];
		const displayed = view.id === this.bridge.getDisplayedId();
		const typeMarker = view.kind === "parent" ? "◆" : view.live ? "●" : "○";
		const marker = displayed ? "●" : ">";
		const footerView = this.footerSnapshot.children.find((entry) => entry.id === view.id);
		const status = `${footerView?.status ?? agentSwitcherStatus(view)}${displayed ? " · viewing" : ""}`;
		const row = `Agents  ${marker} ${typeMarker} ${formatAgentSwitcherLabel(view)}  ${status}`;
		const styledRow = this.styleView(view, padVisible(row, width), displayed);
		const attentionHint =
			view.kind === "subagent" && view.live && view.controlState === "awaiting-extension"
				? " · E extend · X stop"
				: "";
		return [
			styledRow,
			this.isCustomized() && this.appearance
				? applyTextPresentation(
						this.appearance.muted,
						padVisible(`        ↑↓/←→ browse · Enter open${attentionHint} · Esc close`, width),
					)
				: this.theme.fg("dim", padVisible(`        ↑↓/←→ browse · Enter open${attentionHint} · Esc close`, width)),
		];
	}
}

export { SubagentFooterSwitcher as SubagentViewSwitcher };
