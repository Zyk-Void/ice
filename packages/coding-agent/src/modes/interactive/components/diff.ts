import { truncateToWidth, visibleWidth } from "@zykairotis/ice-tui";
import * as Diff from "diff";
import { createDefaultAppearance } from "../appearance/appearance-defaults.ts";
import type { DiffAppearance } from "../appearance/appearance-types.ts";
import { applyTextPresentation } from "../appearance/text-presentation.ts";
import { theme } from "../theme/theme.ts";

let activeDiffAppearance: DiffAppearance | undefined;

export function setDiffAppearance(appearance: DiffAppearance | undefined): void {
	activeDiffAppearance = appearance ? structuredClone(appearance) : undefined;
}

function diffStyle(kind: keyof DiffAppearance, text: string): string {
	if (activeDiffAppearance) return applyTextPresentation(activeDiffAppearance[kind], text);
	const token = kind === "added" ? "toolDiffAdded" : kind === "removed" ? "toolDiffRemoved" : "toolDiffContext";
	return theme.fg(token, text);
}

type DiffKind = "added" | "removed" | "context";

const DEFAULT_DIFF_APPEARANCE = createDefaultAppearance().diff;

/** A user-customized diff appearance styles whole rows itself, as before. */
function customizedAppearance(): DiffAppearance | undefined {
	return activeDiffAppearance && JSON.stringify(activeDiffAppearance) !== JSON.stringify(DEFAULT_DIFF_APPEARANCE)
		? activeDiffAppearance
		: undefined;
}

/** Row background for a changed line; undefined for context, customized appearances, and non-hex themes. */
function rowBackground(kind: DiffKind): string | undefined {
	if (kind === "context" || customizedAppearance()) return undefined;
	return theme.getDiffBgAnsi(kind, "line");
}

/** Mark a changed word: a stronger tint on tinted rows, inverse video otherwise. */
function highlightWord(kind: "added" | "removed", text: string): string {
	const row = rowBackground(kind);
	const word = theme.getDiffBgAnsi(kind, "word");
	return row && word ? `${word}${text}${row}` : theme.inverse(text);
}

/**
 * One diff row: a gutter with the line number and sign, then the content. Changed rows on
 * hex themes get a tinted background across `width` (or the content when no width is given).
 */
function renderRow(kind: DiffKind, lineNum: string, content: string, width: number | undefined): string {
	const sign = kind === "added" ? "+" : kind === "removed" ? "-" : " ";
	const custom = customizedAppearance();
	if (custom) return diffStyle(kind, `${lineNum} ${sign} ${content}`);
	const gutterToken = kind === "added" ? "toolDiffAdded" : kind === "removed" ? "toolDiffRemoved" : "dim";
	const gutter = theme.fg(gutterToken, `${lineNum} ${sign} `);
	const row = rowBackground(kind);
	if (!row) return gutter + diffStyle(kind, content);
	let line = gutter + content;
	if (width !== undefined) line = truncateToWidth(line, width, "…");
	const padding = width === undefined ? 0 : Math.max(0, width - visibleWidth(line));
	return `${row}${line}${row}${" ".repeat(padding)}\x1b[49m`;
}

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Compute word-level diff and highlight the changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += highlightWord("removed", value);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += highlightWord("added", value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
	/** Pad tinted rows to this width (and truncate longer ones) so the background spans the view. */
	width?: number;
}

/**
 * Render a diff string: a line-number/sign gutter, tinted rows for added and removed lines,
 * and a stronger tint on changed words of a single-line modification.
 */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	const { width } = options;
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(diffStyle("context", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				result.push(renderRow("removed", removed.lineNum, removedLine, width));
				result.push(renderRow("added", added.lineNum, addedLine, width));
			} else {
				// Show all removed lines first, then all added lines
				for (const removed of removedLines) {
					result.push(renderRow("removed", removed.lineNum, replaceTabs(removed.content), width));
				}
				for (const added of addedLines) {
					result.push(renderRow("added", added.lineNum, replaceTabs(added.content), width));
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			result.push(renderRow("added", parsed.lineNum, replaceTabs(parsed.content), width));
			i++;
		} else {
			// Context line
			result.push(renderRow("context", parsed.lineNum, replaceTabs(parsed.content), width));
			i++;
		}
	}

	return result.join("\n");
}
