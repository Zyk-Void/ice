import { type Component, truncateToWidth, visibleWidth } from "@zykairotis/ice-tui";
import { getSymbolPreset, sym } from "../theme/symbols.ts";
import { theme } from "../theme/theme.ts";

export interface SessionHeaderData {
	appName: string;
	version: string;
	/** Model id, or undefined before a model is selected. */
	model?: string;
	/** Thinking level for reasoning models; undefined hides it. */
	thinking?: string;
	cwd: string;
	/** Execution mode label (e.g. "build"); undefined hides the row. */
	mode?: string;
	/** Elevated capabilities shown in the mode row with risk color (e.g. "bash", "external"). */
	capabilities: readonly string[];
	/** Loaded resource summary (e.g. "3 context files · 61 skills"); empty hides the row. */
	loaded: string;
	/** One-line dim hint shown under the card. */
	hint: string;
	/** Full startup help shown under the card when expanded. */
	expandedHelp: string;
}

/** Block-letter wordmark. Full blocks render in the accent color, box-drawing shadows dimmed. */
const BLOCK_ART = [
	"██╗ ██████╗███████╗",
	"██║██╔════╝██╔════╝",
	"██║██║     █████╗  ",
	"██║██║     ██╔══╝  ",
	"██║╚██████╗███████╗",
	"╚═╝ ╚═════╝╚══════╝",
];

const ASCII_ART = [" ___ ____ _____ ", "|_ _/ ___| ____|", " | | |   |  _|  ", " | | |___| |___ ", "|___\\____|_____|"];

const ART_GAP = 3;
const LABEL_WIDTH = 11;
const MIN_INFO_WIDTH = 34;
const MAX_CARD_WIDTH = 100;

/** Truncate a path in the middle so both the root and the leaf stay visible. */
export function middleTruncate(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	const ellipsis = sym("ellipsis");
	const available = maxWidth - visibleWidth(ellipsis);
	if (available <= 1) return truncateToWidth(text, maxWidth, "");
	const tail = Math.ceil(available / 2);
	const head = available - tail;
	return `${text.slice(0, head)}${ellipsis}${text.slice(text.length - tail)}`;
}

function styleArtLine(line: string): string {
	return line.replace(/(█+)|([^█]+)/g, (_match, blocks: string | undefined, rest: string | undefined) =>
		blocks ? theme.bold(theme.fg("accent", blocks)) : theme.fg("dim", rest ?? ""),
	);
}

interface InfoRow {
	label: string;
	/** Plain text, used for width and truncation. */
	plain: string;
	/** Styled rendering of `plain`. */
	styled: string;
	/** Optional dim command hint right-aligned on the row when it fits. */
	hint?: string;
	/** Truncate in the middle (paths) instead of at the end. */
	middle?: boolean;
}

/**
 * Startup card: block-letter wordmark beside the session facts (model,
 * directory, mode with elevated capabilities, loaded resources). The wordmark
 * drops on narrow terminals; below 44 columns the box drops too.
 */
export class SessionHeaderComponent implements Component {
	private readonly getData: () => SessionHeaderData;
	private expanded: boolean;

	constructor(getData: () => SessionHeaderData, expanded = false) {
		this.getData = getData;
		this.expanded = expanded;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const data = this.getData();
		const title = `${theme.bold(theme.fg("accent", `${sym("logo")} ${data.appName.toUpperCase()}`))}  ${theme.fg("dim", `v${data.version}`)}`;
		const rows = this.buildRows(data);

		const lines: string[] = [];
		if (width < 44) {
			lines.push(truncateToWidth(title, width, sym("ellipsis")));
			for (const row of rows) lines.push(this.formatRow(row, width, false));
		} else {
			lines.push(...this.renderCard(title, rows, width));
		}

		lines.push(truncateToWidth(`  ${theme.fg("dim", data.hint)}`, width, sym("ellipsis")));
		if (this.expanded && data.expandedHelp) {
			lines.push("");
			for (const line of data.expandedHelp.split("\n")) {
				lines.push(truncateToWidth(` ${line}`, width, sym("ellipsis")));
			}
		}
		return lines;
	}

	private buildRows(data: SessionHeaderData): InfoRow[] {
		const separator = ` ${sym("separator")} `;
		const rows: InfoRow[] = [];
		const model = data.model ? `${data.model}${data.thinking ? `${separator}${data.thinking}` : ""}` : "no model";
		rows.push({ label: "model", plain: model, styled: model, hint: "/model" });
		rows.push({ label: "directory", plain: data.cwd, styled: data.cwd, middle: true });
		if (data.mode) {
			const plain = [data.mode, ...data.capabilities].join(separator);
			const styled = [data.mode, ...data.capabilities.map((capability) => theme.fg("error", capability))].join(
				theme.fg("dim", separator),
			);
			rows.push({ label: "mode", plain, styled });
		}
		if (data.loaded) rows.push({ label: "loaded", plain: data.loaded, styled: theme.fg("muted", data.loaded) });
		return rows;
	}

	private renderCard(title: string, rows: InfoRow[], width: number): string[] {
		const art = getSymbolPreset() === "ascii" ? ASCII_ART : BLOCK_ART;
		const artWidth = Math.max(...art.map((line) => visibleWidth(line)));
		const naturalInfoWidth = Math.max(
			visibleWidth(title),
			...rows.map((row) => LABEL_WIDTH + visibleWidth(row.plain) + (row.hint ? 2 + visibleWidth(row.hint) : 0)),
		);
		const maxContent = Math.min(MAX_CARD_WIDTH, width) - 4;
		const showArt = artWidth + ART_GAP + MIN_INFO_WIDTH <= maxContent;
		const infoOffset = showArt ? artWidth + ART_GAP : 0;
		const infoWidth = Math.max(1, Math.min(naturalInfoWidth, maxContent - infoOffset));
		const contentWidth = infoOffset + infoWidth;

		// Title, blank line, then facts; vertically centered against the wordmark.
		const info = [
			truncateToWidth(title, infoWidth, sym("ellipsis")),
			"",
			...rows.map((row) => this.formatRow(row, infoWidth, true)),
		];
		const height = showArt ? Math.max(art.length, info.length) : info.length;
		const infoTop = showArt ? Math.floor((height - info.length) / 2) : 0;
		const artTop = showArt ? Math.floor((height - art.length) / 2) : 0;

		const border = (text: string) => theme.fg("dim", text);
		const horizontal = sym("boxHorizontal").repeat(contentWidth + 2);
		const lines = [border(`${sym("boxTopLeft")}${horizontal}${sym("boxTopRight")}`)];
		for (let row = 0; row < height; row++) {
			const artLine = showArt ? (art[row - artTop] ?? "") : "";
			const left = showArt ? styleArtLine(artLine.padEnd(artWidth)) + " ".repeat(ART_GAP) : "";
			const right = info[row - infoTop] ?? "";
			const content = left + right;
			const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
			lines.push(`${border(sym("boxVertical"))} ${content}${padding} ${border(sym("boxVertical"))}`);
		}
		lines.push(border(`${sym("boxBottomLeft")}${horizontal}${sym("boxBottomRight")}`));
		return lines;
	}

	private formatRow(row: InfoRow, width: number, allowHint: boolean): string {
		const label = theme.fg("dim", row.label.padEnd(LABEL_WIDTH));
		const valueWidth = Math.max(4, width - LABEL_WIDTH);
		const fits = visibleWidth(row.plain) <= valueWidth;
		const value = fits
			? row.styled
			: row.middle
				? middleTruncate(row.plain, valueWidth)
				: truncateToWidth(row.plain, valueWidth, sym("ellipsis"));
		const line = `${label}${value}`;
		if (!allowHint || !row.hint) return truncateToWidth(line, width, sym("ellipsis"));
		const gap = width - visibleWidth(line) - visibleWidth(row.hint);
		return gap >= 2 ? `${line}${" ".repeat(gap)}${theme.fg("dim", row.hint)}` : line;
	}
}
