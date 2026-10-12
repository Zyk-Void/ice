import { applyChromeBorder, type Component, type TUI, truncateToWidth, visibleWidth } from "@zykairotis/ice-tui";
import type { IceAgentViewBridge, IceAgentViewDescriptor } from "../../../ice-agent-view-bridge.ts";
import type {
	SubagentCheckInState,
	SubagentRuntimeAttention,
	SubagentToolActivityOutcome,
} from "../../../subagents/runtime/view-state.ts";
import { createDefaultAppearance } from "../appearance/appearance-defaults.ts";
import { resolveAppearanceColorFn } from "../appearance/appearance-resolve.ts";
import type { SubagentChromeAppearance } from "../appearance/appearance-types.ts";
import { applyTextPresentation } from "../appearance/text-presentation.ts";
import { sym } from "../theme/symbols.ts";
import type { Theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

const DEFAULT_AGENT_CHROME = createDefaultAppearance().subagentChrome;
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
	readonly checkIn?: SubagentCheckInState;
}

export interface SubagentFooterSnapshot {
	readonly children: readonly SubagentFooterEntry[];
	readonly liveCount: number;
	/** Live children whose session is currently streaming. */
	readonly workingCount: number;
	/** Live children whose turn waits for a concurrency slot; the rest of liveCount is idle. */
	readonly queuedCount?: number;
	readonly retainedCount: number;
	readonly attentionCount: number;
	readonly mainAgentDisplayed: boolean;
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
	const elapsedSeconds = Math.floor(attention.activeElapsedMs / 1000);
	return `${elapsedSeconds}s elapsed`;
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
		recentActivities,
		...(runtime.repeatedFailure ? { repeatedFailureCount: runtime.repeatedFailure.count } : {}),
	});
}

function formatFooterCheckIn(state: SubagentCheckInState | undefined): string | undefined {
	if (!state) return undefined;
	if (state.delivery === "owner_unavailable") return "check-in overdue; owner unavailable";
	if (state.delivery === "due") return "check-in overdue; awaiting parent";
	if (state.delivery === "queued_for_parent") return "check-in pending parent review";
	if (state.delivery === "consumed") return "parent reviewing check-in";
	if (state.delivery === "acknowledged") return "check-in acknowledged";
	return state.nextDueAt === undefined ? "check-in armed" : `check-in due ${new Date(state.nextDueAt).toISOString()}`;
}

/** The main agent's name in the footer strip and view switcher. */
const ICE_LABEL = (): string => `${sym("logo")} ICE`;

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
		view.controlState === "awaiting-finalization" ||
		view.controlState === "final-report-requested" ||
		attention?.phase === "finalization" ||
		attention?.repeatedFailureCount !== undefined ||
		view.checkIn?.delivery === "due" ||
		view.checkIn?.delivery === "queued_for_parent" ||
		view.checkIn?.delivery === "consumed" ||
		view.checkIn?.delivery === "owner_unavailable"
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
					...(view.checkIn ? { checkIn: view.checkIn } : {}),
				});
			}),
	);
	const liveCount = children.filter((view) => view.live).length;
	const workingCount = views.filter(
		(view) => view.kind === "subagent" && view.live && view.status === "working",
	).length;
	const mainAgentDisplayed = views.some((view) => view.id === displayedId && view.kind === "parent");
	const selectedChild =
		children.find((view) => view.id === displayedId) ??
		(mainAgentDisplayed ? undefined : (children.find((view) => view.id === selectedViewId) ?? children[0]));
	return Object.freeze({
		children,
		liveCount,
		workingCount,
		retainedCount: children.filter((view) => view.retentionState === "reusable").length,
		attentionCount: children.filter((view) => view.needsAttention).length,
		mainAgentDisplayed,
		...(selectedChild
			? {
					selectedChild,
					selectedChildIndex: children.findIndex((view) => view.id === selectedChild.id) + 1,
				}
			: {}),
	});
}

export function formatAgentSwitcherLabel(view: IceAgentViewDescriptor): string {
	if (view.kind === "parent") return ICE_LABEL();
	const identity = view.taskId ?? view.runId?.slice(0, 8);
	return [view.role ?? view.label, identity ? `· ${identity}` : undefined].filter(Boolean).join(" ");
}

/** "1 working · 2 idle"; "none live" when no child session is resident. */
function liveCounts(snapshot: SubagentFooterSnapshot): string[] {
	const queued = snapshot.queuedCount ?? 0;
	const idle = snapshot.liveCount - snapshot.workingCount - queued;
	const parts = [
		...(snapshot.workingCount > 0 ? [`${snapshot.workingCount} working`] : []),
		...(queued > 0 ? [`${queued} queued`] : []),
		...(idle > 0 ? [`${idle} idle`] : []),
	];
	return parts.length > 0 ? parts : ["none live"];
}

function padVisible(text: string, width: number): string {
	const truncated = truncateToWidth(text, Math.max(0, width), "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/**
 * One-line agent status strip above the footer: live children, the displayed view, and the
 * navigation keys. Management (focus, stop, delete, approvals) lives in the Agent Hub.
 */
export class SubagentFooterSwitcher implements Component {
	private readonly unsubscribe: () => void;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly bridge: IceAgentViewBridge;
	private disposed = false;
	private appearance: SubagentChromeAppearance | null = null;
	private footerSnapshot: SubagentFooterSnapshot = Object.freeze({
		children: Object.freeze([]),
		liveCount: 0,
		workingCount: 0,
		retainedCount: 0,
		attentionCount: 0,
		mainAgentDisplayed: false,
	});

	constructor(tui: TUI, theme: Theme, bridge: IceAgentViewBridge) {
		this.tui = tui;
		this.theme = theme;
		this.bridge = bridge;
		this.refresh();
		this.unsubscribe = bridge.subscribe(() => {
			this.refresh();
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

	render(width: number): string[] {
		const rows = this.renderStrip(width);
		if (rows.length === 0 || !this.appearance || this.appearance.borderStyle === "none" || width < 8) return rows;
		return applyChromeBorder(
			rows,
			width,
			this.appearance.borderStyle,
			resolveAppearanceColorFn(this.appearance.borderColor, "fg"),
		);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	private refresh(): void {
		const displayedId = this.bridge.getDisplayedId();
		const snapshot = createSubagentFooterSnapshot(this.bridge.listViews(), displayedId, displayedId);
		// Views carry no queue state, and their streaming flag is only sampled on bridge events (a turn that starts
		// later still reads idle); the runtime overview knows which live children run and which wait for a slot.
		const overview = this.bridge.getSubagentOverview()?.children.filter((child) => child.resident);
		const queuedCount = overview?.filter((child) => child.state === "queued").length ?? 0;
		const workingCount = overview
			? overview.filter((child) => child.running && child.state !== "queued").length
			: snapshot.workingCount;
		this.footerSnapshot = Object.freeze({ ...snapshot, workingCount, queuedCount });
	}

	private renderStrip(width: number): string[] {
		const snapshot = this.footerSnapshot;
		if (snapshot.children.length === 0) return [];
		const selected = snapshot.selectedChild;
		const selectedPosition = selected ? `${snapshot.selectedChildIndex}/${snapshot.children.length}` : undefined;
		const counts = [
			...liveCounts(snapshot),
			snapshot.retainedCount > 0 ? `${snapshot.retainedCount} retained` : undefined,
			snapshot.attentionCount > 0 ? `${snapshot.attentionCount} needs attention` : undefined,
		]
			.filter((part): part is string => part !== undefined)
			.join(" · ");
		// On the main agent the strip only names it; key hints show while viewing a child, where they are needed.
		const summary = snapshot.mainAgentDisplayed
			? `Agents ${counts} · ${ICE_LABEL()}`
			: `Agents ${counts}${selected ? ` · [${selectedPosition} ${selected.label}] ${selected.status}` : ""} · ${keyText("app.interrupt")} ${ICE_LABEL()} · ${keyText("app.subagents.previous")}/${keyText("app.subagents.next")} switch`;
		const countOnly = [
			`Agents ${snapshot.children.length}`,
			snapshot.attentionCount > 0 ? `!${snapshot.attentionCount} attention` : undefined,
			...liveCounts(snapshot),
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
					formatFooterCheckIn(selected.checkIn),
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
}
