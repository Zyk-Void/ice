/**
 * Shells panel: one live view over the background shells (bash commands started with
 * `run_in_background` or moved there with ctrl+b). It replaces the editor while open, so the
 * transcript above stays visible. A list shows every shell; details show one shell's status,
 * runtime, command, and latest output; follow mode brings a shell's output to the foreground as a
 * taller, live tail. Shells can be stopped from any view.
 */
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@zykairotis/ice-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { BackgroundShellSnapshot, BashBackgroundRegistry } from "../../../core/tools/bash-background.ts";
import { formatShellRuntime } from "../../../core/tools/bash-shells.ts";
import { sym } from "../theme/symbols.ts";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/** List rows shown at once; the window follows the selection. */
const LIST_WINDOW = 10;
/** Output rows in the details view. */
const DETAIL_OUTPUT_ROWS = 8;
/** Output rows while following a shell. */
const FOLLOW_OUTPUT_ROWS = 24;
/** Command rows in the details view before it is cut. */
const COMMAND_ROWS = 3;
/** Live output can arrive many times a second; repaint at most this often. */
const RENDER_THROTTLE_MS = 100;

type View = "list" | "details" | "follow";

/** One terminal row: shell output and commands are untrusted and may hold control characters. */
function oneRow(text: string, width: number): string {
	return truncateToWidth(text.replace(/[\r\n\t]+/g, " "), Math.max(0, width), "…");
}

/** Strip terminal control sequences from command output before it is drawn inside the panel. */
function plainOutput(text: string): string {
	return (
		text
			.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "")
			// A carriage return redraws the line (progress bars); keep only the final state.
			.split("\n")
			.map((line) => line.slice(line.lastIndexOf("\r") + 1))
			.join("\n")
			.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
	);
}

function statusMark(shell: BackgroundShellSnapshot): string {
	switch (shell.status) {
		case "running":
			return theme.fg("accent", sym("bullet"));
		case "completed":
			return theme.fg("success", sym("toolSuccess"));
		case "failed":
			return theme.fg("error", sym("error"));
		default:
			return theme.fg("muted", sym("separator"));
	}
}

function statusText(shell: BackgroundShellSnapshot): string {
	const color =
		shell.status === "running"
			? "accent"
			: shell.status === "completed"
				? "success"
				: shell.status === "failed"
					? "error"
					: "muted";
	return theme.fg(color, shell.status);
}

export class ShellsPanelComponent implements Component {
	private readonly registry: BashBackgroundRegistry;
	private readonly keybindings: KeybindingsManager;
	private readonly onClose: () => void;
	private readonly requestRender: () => void;
	private readonly now: () => number;
	private readonly unsubscribe: () => void;
	private readonly ticker: ReturnType<typeof setInterval> | undefined;
	private renderTimer: ReturnType<typeof setTimeout> | undefined;
	private view: View = "list";
	/** Selected shell by id, so the selection stays put when shells start or finish. */
	private selectedId: string | undefined;
	private message: string | undefined;

	constructor(
		registry: BashBackgroundRegistry,
		keybindings: KeybindingsManager,
		onClose: () => void,
		options: { requestRender?: () => void; now?: () => number; initialShellId?: string; tick?: boolean } = {},
	) {
		this.registry = registry;
		this.keybindings = keybindings;
		this.onClose = onClose;
		this.requestRender = options.requestRender ?? (() => {});
		this.now = options.now ?? Date.now;
		this.unsubscribe = registry.onChange(() => this.scheduleRender());
		// Runtimes advance even when a shell prints nothing.
		this.ticker = options.tick === false ? undefined : setInterval(() => this.requestRender(), 1000);
		// One shell: open straight on its details. Several: start on the newest running one.
		const shells = registry.snapshots();
		const running = shells.filter((shell) => shell.status === "running");
		this.selectedId = options.initialShellId ?? (running.at(-1) ?? shells.at(-1))?.taskId;
		if (shells.length === 1) this.view = "details";
	}

	dispose(): void {
		this.unsubscribe();
		if (this.ticker) clearInterval(this.ticker);
		if (this.renderTimer) clearTimeout(this.renderTimer);
	}

	invalidate(): void {}

	private scheduleRender(): void {
		this.renderTimer ??= setTimeout(() => {
			this.renderTimer = undefined;
			this.requestRender();
		}, RENDER_THROTTLE_MS);
	}

	private shells(): BackgroundShellSnapshot[] {
		// Running shells first (oldest first), then finished ones, newest first.
		const all = this.registry.snapshots();
		return [
			...all.filter((shell) => shell.status === "running"),
			...all.filter((shell) => shell.status !== "running").reverse(),
		];
	}

	private selectedIndex(shells: readonly BackgroundShellSnapshot[]): number {
		const index = shells.findIndex((shell) => shell.taskId === this.selectedId);
		return index >= 0 ? index : 0;
	}

	handleInput(data: string): void {
		const shells = this.shells();
		const index = this.selectedIndex(shells);
		const selected = shells[index];
		const kb = this.keybindings;
		this.message = undefined;
		if (kb.matches(data, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		if (kb.matches(data, "app.shells.stop")) {
			if (!selected) return;
			this.message = this.registry.kill(selected.taskId, { notify: true })
				? `Stopped ${selected.taskId}.`
				: `${selected.taskId} is already ${selected.status}.`;
		} else if (this.view === "list") {
			if (kb.matches(data, "tui.select.up")) this.selectedId = shells[Math.max(0, index - 1)]?.taskId;
			else if (kb.matches(data, "tui.select.down"))
				this.selectedId = shells[Math.min(shells.length - 1, index + 1)]?.taskId;
			else if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.right")) {
				if (selected) this.view = "details";
			} else if (kb.matches(data, "app.shells.follow")) {
				if (selected) this.view = "follow";
			} else return;
		} else if (kb.matches(data, "tui.select.left")) {
			// Back: follow -> details -> list.
			this.view = this.view === "follow" ? "details" : "list";
		} else if (this.view === "details" && kb.matches(data, "app.shells.follow")) {
			this.view = "follow";
		} else if (this.view === "details" && kb.matches(data, "tui.select.confirm")) {
			this.onClose();
			return;
		} else return;
		this.requestRender();
	}

	private header(shells: readonly BackgroundShellSnapshot[]): string {
		const running = shells.filter((shell) => shell.status === "running").length;
		const finished = shells.length - running;
		const parts = [
			running > 0 ? theme.fg("accent", `${running} running`) : "",
			finished > 0 ? theme.fg("muted", `${finished} finished`) : "",
		].filter(Boolean);
		return `${theme.bold("Shells")}  ${parts.length > 0 ? parts.join(theme.fg("muted", " · ")) : theme.fg("muted", "no background shells")}`;
	}

	private listLines(shells: readonly BackgroundShellSnapshot[], width: number): string[] {
		if (shells.length === 0) {
			return [
				theme.fg(
					"muted",
					"No background shells. Commands the agent starts with run_in_background, or that you move to the background, appear here.",
				),
			];
		}
		const selected = this.selectedIndex(shells);
		const start = Math.max(0, Math.min(selected - Math.floor(LIST_WINDOW / 2), shells.length - LIST_WINDOW));
		const end = Math.min(shells.length, start + LIST_WINDOW);
		const now = this.now();
		const lines: string[] = [];
		if (start > 0) lines.push(theme.fg("dim", `  ↑ ${start} more`));
		for (let index = start; index < end; index++) {
			const shell = shells[index]!;
			const isSelected = index === selected;
			const runtime = formatShellRuntime((shell.endedAt ?? now) - shell.startedAt).padStart(7);
			const prefix = `${isSelected ? theme.fg("accent", "›") : " "} ${statusMark(shell)} ${theme.fg("dim", shell.taskId.padEnd(8))} ${theme.fg("dim", runtime)}  `;
			const command = shell.command.split("\n", 1)[0] ?? "";
			lines.push(oneRow(`${prefix}${isSelected ? theme.bold(command) : command}`, width));
		}
		if (end < shells.length) lines.push(theme.fg("dim", `  ↓ ${shells.length - end} more`));
		return lines;
	}

	private outputLines(shell: BackgroundShellSnapshot, rows: number, width: number): string[] {
		// A finished shell's final text holds its output and exit status; a stopped one only has a note.
		const source =
			shell.status === "killed"
				? `${shell.output.trimEnd()}\n[${shell.finalText ?? "Stopped."}]`
				: shell.status === "running" || !shell.finalText
					? shell.output
					: shell.finalText;
		const text = plainOutput(source).trim();
		if (!text) return [theme.fg("muted", shell.status === "running" ? "No output yet." : "No output.")];
		const wrapped = text.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 2)));
		const shown = wrapped.slice(-rows).map((line) => `  ${theme.fg("toolOutput", line)}`);
		return wrapped.length > rows ? [theme.fg("dim", `  … ${wrapped.length - rows} earlier lines`), ...shown] : shown;
	}

	private detailLines(shell: BackgroundShellSnapshot, width: number, rows: number): string[] {
		const label = (name: string) => theme.fg("muted", name.padEnd(10));
		const now = this.now();
		const commandLines = shell.command.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 10)));
		const command = commandLines
			.slice(0, COMMAND_ROWS)
			.map((line, index) => `${index === 0 ? label("Command:") : " ".repeat(10)}${line}`);
		if (commandLines.length > COMMAND_ROWS)
			command.push(`${" ".repeat(10)}${theme.fg("dim", `… ${commandLines.length - COMMAND_ROWS} more lines`)}`);
		return [
			`${label("Status:")}${statusText(shell)}${theme.fg("dim", ` · ${shell.origin === "model" ? "started by the agent" : "moved to the background by you"}`)}`,
			`${label("Runtime:")}${formatShellRuntime((shell.endedAt ?? now) - shell.startedAt)}`,
			...command,
			"",
			label("Output:"),
			...this.outputLines(shell, rows, width),
		].map((line) => oneRow(line, width));
	}

	private hints(selected: BackgroundShellSnapshot | undefined): string {
		const running = selected?.status === "running";
		const stop = running ? [`${keyText("app.shells.stop")} stop`] : [];
		if (this.view === "list") {
			return [
				`${keyText("tui.select.up")}/${keyText("tui.select.down")} select`,
				`${keyText("tui.select.confirm")} details`,
				`${keyText("app.shells.follow")} follow`,
				...stop,
				`${keyText("tui.select.cancel")} close`,
			].join(" · ");
		}
		if (this.view === "details") {
			return [
				`${keyText("tui.select.left")} back`,
				`${keyText("app.shells.follow")} follow`,
				...stop,
				`${keyText("tui.select.cancel")}/${keyText("tui.select.confirm")} close`,
			].join(" · ");
		}
		return [`${keyText("tui.select.left")} back`, ...stop, `${keyText("tui.select.cancel")} close`].join(" · ");
	}

	render(width: number): string[] {
		const shells = this.shells();
		const selected = shells[this.selectedIndex(shells)];
		this.selectedId = selected?.taskId;
		if (!selected) this.view = "list";
		const rule = theme.fg("border", sym("boxHorizontal").repeat(Math.max(0, width)));
		const lines = [rule];
		if (this.view === "list" || !selected) {
			lines.push(this.header(shells), "", ...this.listLines(shells, width));
		} else if (this.view === "details") {
			lines.push(
				`${theme.bold("Shell details")}  ${theme.fg("dim", selected.taskId)}`,
				"",
				...this.detailLines(selected, width, DETAIL_OUTPUT_ROWS),
			);
		} else {
			const live = selected.status === "running" ? theme.fg("accent", "live") : statusText(selected);
			lines.push(
				oneRow(
					`${theme.bold(`Following ${selected.taskId}`)}  ${live}  ${theme.fg("dim", selected.command.split("\n", 1)[0] ?? "")}`,
					width,
				),
				"",
				...this.outputLines(selected, FOLLOW_OUTPUT_ROWS, width).map((line) => oneRow(line, width)),
			);
		}
		if (this.message) lines.push("", theme.fg("muted", oneRow(this.message, width)));
		lines.push("", theme.fg("dim", oneRow(this.hints(selected), width)));
		return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
	}
}
