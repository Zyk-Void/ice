/**
 * Notices panel: one live view over the NoticeCenter, laid out like the Agent Hub. A filter bar picks
 * all notices, problems only, or one category; the list shows the selected filter and an inspector shows
 * the selected notice in full. Wide terminals show list and inspector side by side; narrow ones stack them.
 */
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@zykairotis/ice-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import {
	NOTICE_CATEGORIES,
	type Notice,
	type NoticeCategory,
	type NoticeCenter,
	orderNotices,
} from "../notice-center.ts";
import { sym } from "../theme/symbols.ts";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

export type NoticeFilter = "all" | "problems" | NoticeCategory;

const WIDE_WIDTH = 110;
/** List rows shown at once; the window follows the selection. */
const LIST_WINDOW = 14;
/** Inspector detail rows shown at once; page keys scroll through longer details. */
const DETAIL_WINDOW = 16;
const CATEGORY_WIDTH = 11;

const FILTER_LABELS: Record<NoticeFilter, string> = {
	all: "All",
	problems: "Problems",
	extensions: "Extensions",
	mcp: "MCP",
	tools: "Tools",
	skills: "Skills",
	prompts: "Prompts",
	themes: "Themes",
	compaction: "Compaction",
	subagents: "Subagents",
	model: "Model",
	session: "Session",
	console: "Console",
	updates: "Updates",
};

function isProblem(notice: Notice): boolean {
	return notice.kind === "error" || notice.kind === "warning";
}

function matches(notice: Notice, filter: NoticeFilter): boolean {
	if (filter === "all") return true;
	if (filter === "problems") return isProblem(notice);
	return notice.category === filter;
}

function mark(notice: Notice): string {
	switch (notice.kind) {
		case "error":
			return theme.fg("error", sym("error"));
		case "warning":
			return theme.fg("warning", sym("warning"));
		case "update":
			return theme.fg("accent", sym("update"));
		default:
			return theme.fg("dim", sym("separator"));
	}
}

export function formatAge(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** One terminal row: notice text is untrusted and may contain line breaks. */
function oneRow(text: string, width: number): string {
	return truncateToWidth(text.replace(/[\r\n]+/g, " "), Math.max(0, width), "…");
}

function pad(text: string, width: number): string {
	const truncated = oneRow(text, width);
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export class NoticesViewComponent implements Component {
	private readonly center: NoticeCenter;
	private readonly keybindings: KeybindingsManager;
	private readonly onClose: () => void;
	private readonly requestRender: () => void;
	private readonly copy: (text: string) => Promise<void>;
	private readonly now: () => number;
	private readonly unsubscribe: () => void;
	private filter: NoticeFilter = "all";
	/** Selected notice by id, so the selection stays put when notices are added or reordered. */
	private selectedId: string | undefined;
	private detailOffset = 0;
	private message: string | undefined;

	constructor(
		center: NoticeCenter,
		keybindings: KeybindingsManager,
		onClose: () => void,
		options: { requestRender?: () => void; copy?: (text: string) => Promise<void>; now?: () => number } = {},
	) {
		this.center = center;
		this.keybindings = keybindings;
		this.onClose = onClose;
		this.requestRender = options.requestRender ?? (() => {});
		this.copy = options.copy ?? copyToClipboard;
		this.now = options.now ?? Date.now;
		this.unsubscribe = center.subscribe(() => this.requestRender());
		// Open on the problems when there are any.
		if (center.list().some((notice) => isProblem(notice) && !notice.quiet)) this.filter = "problems";
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {}

	/** "All", "Problems", then each category that has notices. */
	private filters(): NoticeFilter[] {
		const present = new Set(this.center.list().map((notice) => notice.category));
		return ["all", "problems", ...NOTICE_CATEGORIES.filter((category) => present.has(category))];
	}

	private visible(): Notice[] {
		return orderNotices(this.center.list().filter((notice) => matches(notice, this.filter)));
	}

	private selectedIndex(notices: readonly Notice[]): number {
		const index = notices.findIndex((notice) => notice.id === this.selectedId);
		return index >= 0 ? index : 0;
	}

	private select(notice: Notice | undefined): void {
		if (notice?.id !== this.selectedId) this.detailOffset = 0;
		this.selectedId = notice?.id;
	}

	private moveFilter(delta: -1 | 1): void {
		const filters = this.filters();
		const index = Math.max(0, filters.indexOf(this.filter));
		this.filter = filters[(index + delta + filters.length) % filters.length]!;
		this.select(this.visible()[0]);
	}

	handleInput(data: string): void {
		const notices = this.visible();
		const index = this.selectedIndex(notices);
		const selected = notices[index];
		const kb = this.keybindings;
		this.message = undefined;
		if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "app.notices.show")) {
			this.onClose();
			return;
		}
		if (kb.matches(data, "tui.select.up")) this.select(notices[Math.max(0, index - 1)]);
		else if (kb.matches(data, "tui.select.down")) this.select(notices[Math.min(notices.length - 1, index + 1)]);
		else if (kb.matches(data, "tui.select.left")) this.moveFilter(-1);
		else if (kb.matches(data, "tui.select.right")) this.moveFilter(1);
		else if (kb.matches(data, "tui.select.pageUp"))
			this.detailOffset = Math.max(0, this.detailOffset - DETAIL_WINDOW);
		else if (kb.matches(data, "tui.select.pageDown")) this.detailOffset += DETAIL_WINDOW;
		else if (kb.matches(data, "app.notices.dismiss")) {
			if (!selected) return;
			if (!this.center.dismiss(selected.id)) this.message = "This notice describes active state and stays.";
			else this.select(notices[index + 1] ?? notices[index - 1]);
		} else if (kb.matches(data, "app.notices.clear")) {
			const removed = this.center.dismissWhere((notice) => matches(notice, this.filter));
			this.message = `Cleared ${removed} notice${removed === 1 ? "" : "s"} from ${FILTER_LABELS[this.filter]}.`;
			this.select(this.visible()[0]);
		} else if (kb.matches(data, "app.notices.copy")) {
			if (!selected) return;
			const text = [selected.title, `${selected.category} · ${selected.source}`, selected.detail ?? ""]
				.filter(Boolean)
				.join("\n");
			this.copy(text).then(
				() => {
					this.message = "Copied the notice to the clipboard.";
					this.requestRender();
				},
				(error: unknown) => {
					this.message = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
					this.requestRender();
				},
			);
		} else return;
		this.requestRender();
	}

	private header(): string {
		const all = this.center.list();
		const counts = this.center.counts();
		const quiet = all.filter((notice) => notice.quiet || notice.kind === "info").length;
		const parts = [
			counts.error > 0 ? theme.fg("error", `${counts.error} error${counts.error === 1 ? "" : "s"}`) : "",
			counts.warning > 0 ? theme.fg("warning", `${counts.warning} warning${counts.warning === 1 ? "" : "s"}`) : "",
			counts.update > 0 ? theme.fg("accent", `${counts.update} update${counts.update === 1 ? "" : "s"}`) : "",
			quiet > 0 ? `${quiet} logged` : "",
		].filter(Boolean);
		const summary = parts.length > 0 ? parts.join(theme.fg("muted", " · ")) : theme.fg("muted", "nothing to report");
		return `${theme.bold("Notices")}  ${summary}`;
	}

	private filterBar(width: number): string {
		const all = this.center.list();
		const tabs = this.filters().map((filter) => {
			const count = all.filter((notice) => matches(notice, filter)).length;
			const label = `${FILTER_LABELS[filter]} ${count}`;
			return filter === this.filter
				? theme.bg("selectedBg", theme.bold(` ${label} `))
				: theme.fg("muted", ` ${label} `);
		});
		return oneRow(tabs.join(" "), width);
	}

	private listLines(notices: readonly Notice[], width: number): string[] {
		if (notices.length === 0) {
			return [
				theme.fg(
					"muted",
					this.filter === "all" ? "No notices in this session." : `No ${FILTER_LABELS[this.filter]} notices.`,
				),
			];
		}
		const selected = this.selectedIndex(notices);
		const start = Math.max(0, Math.min(selected - Math.floor(LIST_WINDOW / 2), notices.length - LIST_WINDOW));
		const end = Math.min(notices.length, start + LIST_WINDOW);
		const now = this.now();
		const lines: string[] = [];
		if (start > 0) lines.push(theme.fg("dim", `  ↑ ${start} more`));
		for (let index = start; index < end; index++) {
			const notice = notices[index]!;
			const isSelected = index === selected;
			const suffix = `${notice.count > 1 ? ` ×${notice.count}` : ""} ${formatAge(now - notice.updatedAt)}`;
			const titleWidth = Math.max(4, width - 4 - CATEGORY_WIDTH - 1 - visibleWidth(suffix));
			const title = pad(notice.title, titleWidth);
			const styledTitle = isSelected ? theme.bold(title) : notice.quiet ? theme.fg("muted", title) : title;
			lines.push(
				oneRow(
					`${isSelected ? theme.fg("accent", "›") : " "} ${mark(notice)} ${theme.fg("dim", pad(notice.category, CATEGORY_WIDTH))} ${styledTitle}${theme.fg("dim", suffix)}`,
					width,
				),
			);
		}
		if (end < notices.length) lines.push(theme.fg("dim", `  ↓ ${notices.length - end} more`));
		return lines;
	}

	private inspectorLines(notice: Notice | undefined, width: number): string[] {
		if (!notice) return [];
		const now = this.now();
		const seen =
			notice.count > 1
				? `seen ${notice.count} times · first ${formatAge(now - notice.createdAt)} ago · last ${formatAge(now - notice.updatedAt)} ago`
				: `${formatAge(now - notice.updatedAt)} ago`;
		const lines = [
			...wrapTextWithAnsi(theme.bold(notice.title), width),
			theme.fg("dim", oneRow(`${notice.category} · ${notice.source} · ${seen}`, width)),
		];
		if (notice.sticky) lines.push(theme.fg("warning", "Active state; it clears when the state changes."));
		if (notice.detail) {
			const detail = notice.detail.split("\n").flatMap((line) => wrapTextWithAnsi(theme.fg("muted", line), width));
			this.detailOffset = Math.min(this.detailOffset, Math.max(0, detail.length - DETAIL_WINDOW));
			lines.push("", ...detail.slice(this.detailOffset, this.detailOffset + DETAIL_WINDOW));
			if (detail.length > DETAIL_WINDOW) {
				lines.push(
					theme.fg(
						"dim",
						`lines ${this.detailOffset + 1}-${Math.min(detail.length, this.detailOffset + DETAIL_WINDOW)} of ${detail.length} · ${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")} scroll`,
					),
				);
			}
		}
		return lines.map((line) => oneRow(line, width));
	}

	render(width: number): string[] {
		const notices = this.visible();
		const notice = notices[this.selectedIndex(notices)];
		this.selectedId = notice?.id;
		const lines = [this.header(), this.filterBar(width), ""];
		if (width >= WIDE_WIDTH && notice) {
			const left = Math.floor(width * 0.5);
			const right = width - left - 3;
			const list = this.listLines(notices, left);
			const inspector = this.inspectorLines(notice, right);
			const height = Math.max(list.length, inspector.length);
			for (let index = 0; index < height; index++)
				lines.push(`${pad(list[index] ?? "", left)} ${theme.fg("border", "│")} ${inspector[index] ?? ""}`);
		} else {
			lines.push(...this.listLines(notices, width));
			if (notice) lines.push("", ...this.inspectorLines(notice, width));
		}
		if (this.message) lines.push("", theme.fg("muted", oneRow(this.message, width)));
		const hints = [
			`${keyText("tui.select.up")}/${keyText("tui.select.down")} select`,
			`${keyText("tui.select.left")}/${keyText("tui.select.right")} filter`,
			`${keyText("app.notices.dismiss")} dismiss`,
			`${keyText("app.notices.clear")} clear filter`,
			`${keyText("app.notices.copy")} copy`,
			`${keyText("tui.select.cancel")} close`,
		];
		lines.push("", theme.fg("dim", oneRow(hints.join(" · "), width)));
		return lines;
	}
}
