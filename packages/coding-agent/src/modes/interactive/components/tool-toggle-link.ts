/**
 * Click-to-toggle for tool cells. The fullscreen renderer owns the mouse and reports a click on an
 * OSC 8 hyperlink through its `openUrl` hook; tool cells wrap their title row in a link with this
 * internal scheme, and InteractiveMode routes it to the cell instead of a browser. Links are only
 * emitted in fullscreen mode: in the normal screen the terminal would try to open the URL itself.
 */
import { stripAnsi } from "../../../utils/ansi.ts";
import { keyText } from "./keybinding-hints.ts";

/** Scheme of links InteractiveMode handles itself; the fullscreen renderer keeps them out of terminal output. */
export const ICE_ACTION_URL_PREFIX = "ice-action:";

export function isIceActionUrl(url: string): boolean {
	return url.startsWith(ICE_ACTION_URL_PREFIX);
}

const TOGGLE_URL_PREFIX = `${ICE_ACTION_URL_PREFIX}toggle-tool/`;

let toggleLinksEnabled = false;

export function setToolToggleLinks(enabled: boolean): void {
	toggleLinksEnabled = enabled;
}

/** How to trigger an action bound to `key`, mentioning clicks when links are on. */
export function clickOrKeyHint(key: string): string {
	return toggleLinksEnabled ? `click or ${key}` : key;
}

/** How to expand a collapsed cell: the expand key, plus clicking when links are on. */
export function expandHint(): string {
	return clickOrKeyHint(keyText("app.tools.expand"));
}

/** `text` as a clickable internal link to `url` (unchanged when links are off). */
export function linkIceAction(text: string, url: string): string {
	if (!toggleLinksEnabled) return text;
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** One line as a toggle link for the cell `id` (unchanged when links are off). */
export function linkToolToggleLine(line: string, id: string): string {
	return linkIceAction(line, `${TOGGLE_URL_PREFIX}${encodeURIComponent(id)}`);
}

/** Wrap the first non-blank line (the cell's title row) in a toggle link for the cell `id`. */
export function linkToolToggle(lines: string[], id: string): string[] {
	const index = lines.findIndex((line) => stripAnsi(line).trim().length > 0);
	if (!toggleLinksEnabled || index < 0) return lines;
	const linked = [...lines];
	linked[index] = linkToolToggleLine(lines[index]!, id);
	return linked;
}

/** The cell id of a toggle URL, or undefined for any other URL. */
export function parseToolToggleUrl(url: string): string | undefined {
	if (!url.startsWith(TOGGLE_URL_PREFIX)) return undefined;
	try {
		return decodeURIComponent(url.slice(TOGGLE_URL_PREFIX.length));
	} catch {
		return undefined;
	}
}
