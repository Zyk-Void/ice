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
	/** Execution mode label (e.g. "build"); undefined hides it. */
	mode?: string;
	/** Elevated capabilities shown after the mode with risk color (e.g. "bash", "external"). */
	capabilities: readonly string[];
	/** Loaded resource summary (e.g. "3 context files · 61 skills"); empty hides it. */
	loaded: string;
	/** One-line dim hint shown under the banner. */
	hint: string;
	/** Full startup help shown under the banner when expanded. */
	expandedHelp: string;
}

/** Three-row pixel penguin mascot, rendered in the accent color. */
const BLOCK_ART = [" ▄███▄ ", "█▀█▀█▀█", " ▀▄▄▄▀ "];

const ASCII_ART = [" (o>", "//\\\\", "V_/_"];

const ART_GAP = 2;
/** Below this many columns for the text, the penguin is dropped. */
const MIN_TEXT_WIDTH = 24;

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

/**
 * Compact startup banner: a small penguin beside three lines (name and
 * version; model, mode, and elevated capabilities; directory and loaded
 * resources). The penguin drops on narrow terminals.
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
		const art = getSymbolPreset() === "ascii" ? ASCII_ART : BLOCK_ART;
		const artWidth = Math.max(...art.map((line) => visibleWidth(line)));
		const showArt = width - artWidth - ART_GAP >= MIN_TEXT_WIDTH;
		const textWidth = Math.max(1, showArt ? width - artWidth - ART_GAP : width);
		const text = this.buildText(data, textWidth);

		const lines: string[] = [];
		for (let row = 0; row < Math.max(text.length, showArt ? art.length : 0); row++) {
			const left = showArt ? theme.fg("accent", (art[row] ?? "").padEnd(artWidth)) + " ".repeat(ART_GAP) : "";
			lines.push(`${left}${text[row] ?? ""}`.trimEnd());
		}

		lines.push(truncateToWidth(theme.fg("dim", data.hint), width, sym("ellipsis")));
		if (this.expanded && data.expandedHelp) {
			lines.push("");
			for (const line of data.expandedHelp.split("\n")) {
				lines.push(truncateToWidth(` ${line}`, width, sym("ellipsis")));
			}
		}
		return lines;
	}

	private buildText(data: SessionHeaderData, width: number): string[] {
		const ellipsis = sym("ellipsis");
		const separator = ` ${sym("separator")} `;
		const dimSeparator = theme.fg("dim", separator);

		const title = `${theme.bold(data.appName.toUpperCase())} ${theme.fg("dim", `v${data.version}`)}`;

		const modelPlain = data.model
			? `${data.model}${data.thinking ? `${separator}${data.thinking}` : ""}`
			: "no model";
		const modePlain = data.mode ? [data.mode, ...data.capabilities] : [];
		const sessionPlain = [modelPlain, ...modePlain].join(separator);
		const sessionStyled = [
			theme.fg("muted", modelPlain),
			...(data.mode ? [theme.fg("muted", data.mode)] : []),
			...(data.mode ? data.capabilities.map((capability) => theme.fg("error", capability)) : []),
		].join(dimSeparator);
		const session =
			visibleWidth(sessionPlain) <= width
				? sessionStyled
				: theme.fg("muted", truncateToWidth(sessionPlain, width, ellipsis));

		const withLoaded = data.loaded ? `${data.cwd}${separator}${data.loaded}` : data.cwd;
		const location =
			visibleWidth(withLoaded) <= width
				? `${theme.fg("muted", data.cwd)}${data.loaded ? `${dimSeparator}${theme.fg("dim", data.loaded)}` : ""}`
				: theme.fg("muted", middleTruncate(data.cwd, width));

		return [truncateToWidth(title, width, ellipsis), session, location];
	}
}
