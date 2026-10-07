import { type Component, Loader, type TUI, truncateToWidth } from "@zykairotis/ice-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import type { StatusIndicatorAppearance } from "../appearance/appearance-types.ts";
import { applyTextPresentation } from "../appearance/text-presentation.ts";
import { sym } from "../theme/symbols.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { formatTokens } from "./footer.ts";
import { keyText } from "./keybinding-hints.ts";

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: WorkingIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
	}

	/**
	 * Live appearance update for the currently mounted indicator. Subclasses
	 * rebind their constructor-captured color closures so customizer previews
	 * reach an active indicator without recreating it (and its timer).
	 */
	setAppearance(_appearance: StatusIndicatorAppearance): void {}

	dispose(): void {
		this.stop();
	}
}

/** Live facts shown next to the working label and on the detail row below it. */
export interface WorkingDetails {
	/** Turn start time (ms since epoch). */
	startedAt: number;
	/** Output tokens generated this turn. */
	outputTokens: number;
	/** True when outputTokens includes an estimate for a still-streaming message. */
	outputTokensEstimated: boolean;
	/** Thinking level for reasoning models; undefined hides it. */
	thinking?: string;
	/** Detail row text (running tool title or a tip); undefined hides the row. */
	detail?: string;
}

/** "0s", "42s", "1m 18s", "1h 02m". */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export class WorkingStatusIndicator extends StatusIndicator {
	private readonly appearanceState: { current?: StatusIndicatorAppearance };
	private getDetails: (() => WorkingDetails) | undefined;
	private readonly now: () => number;

	constructor(
		ui: TUI,
		message: string,
		indicator?: WorkingIndicatorOptions,
		appearance?: StatusIndicatorAppearance,
		now: () => number = Date.now,
	) {
		const state: { current?: StatusIndicatorAppearance } = { current: appearance };
		super(
			"working",
			ui,
			(spinner) => {
				const current = state.current;
				return current
					? applyTextPresentation({ ...current.label, foreground: current.indicator.color }, spinner)
					: theme.fg("accent", spinner);
			},
			(text) => {
				const current = state.current;
				return current ? applyTextPresentation(current.label, text) : theme.fg("muted", text);
			},
			message,
			indicator,
		);
		this.appearanceState = state;
		this.now = now;
	}

	override setAppearance(appearance: StatusIndicatorAppearance): void {
		this.appearanceState.current = appearance;
	}

	/** Show elapsed time, output tokens, thinking level, and a detail row. Refreshed on each spinner frame. */
	setDetails(getDetails: () => WorkingDetails): void {
		this.getDetails = getDetails;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.getDetails || lines.length < 2) return lines;
		const details = this.getDetails();
		const facts = [formatElapsed(this.now() - details.startedAt)];
		if (details.outputTokens > 0) {
			facts.push(`↓ ${details.outputTokensEstimated ? "~" : ""}${formatTokens(details.outputTokens)} tokens`);
		}
		if (details.thinking && details.thinking !== "off") facts.push(`thinking ${details.thinking}`);
		const interruptKey = keyText("app.interrupt");
		if (interruptKey) facts.push(`${interruptKey} to interrupt`);
		const suffix = theme.fg("dim", ` (${facts.join(` ${sym("separator")} `)})`);
		const [first = "", ...rest] = lines.slice(1);
		const result = [lines[0]!, truncateToWidth(first.trimEnd() + suffix, width, theme.fg("dim", sym("ellipsis")))];
		result.push(...rest);
		if (details.detail) {
			const gutter = `   ${theme.fg("dim", sym("gutter"))} `;
			result.push(
				truncateToWidth(gutter + theme.fg("dim", details.detail), width, theme.fg("dim", sym("ellipsis"))),
			);
		}
		return result;
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;
	private readonly appearanceState: { current?: StatusIndicatorAppearance };

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number, appearance?: StatusIndicatorAppearance) {
		const state: { current?: StatusIndicatorAppearance } = { current: appearance };
		const retryMessage = (seconds: number) =>
			`Retrying (${attempt}/${maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
		super(
			"retry",
			ui,
			(spinner) => {
				const current = state.current;
				return current
					? applyTextPresentation({ ...current.label, foreground: current.indicator.color }, spinner)
					: theme.fg("warning", spinner);
			},
			(text) => {
				const current = state.current;
				return current ? applyTextPresentation(current.label, text) : theme.fg("muted", text);
			},
			retryMessage(Math.ceil(delayMs / 1000)),
			appearance ? { frames: appearance.indicator.frames, intervalMs: appearance.indicator.intervalMs } : undefined,
		);
		this.appearanceState = state;
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	override setAppearance(appearance: StatusIndicatorAppearance): void {
		this.appearanceState.current = appearance;
		this.setIndicator({ frames: appearance.indicator.frames, intervalMs: appearance.indicator.intervalMs });
	}

	override dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

export type CompactionStatusReason = "manual" | "threshold" | "overflow";

export class CompactionStatusIndicator extends StatusIndicator {
	private readonly appearanceState: { current?: StatusIndicatorAppearance };

	constructor(ui: TUI, reason: CompactionStatusReason, appearance?: StatusIndicatorAppearance) {
		const state: { current?: StatusIndicatorAppearance } = { current: appearance };
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		const label =
			reason === "manual"
				? `Compacting context... ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
		super(
			"compaction",
			ui,
			(spinner) => {
				const current = state.current;
				return current
					? applyTextPresentation({ ...current.label, foreground: current.indicator.color }, spinner)
					: theme.fg("accent", spinner);
			},
			(text) => {
				const current = state.current;
				return current ? applyTextPresentation(current.label, text) : theme.fg("muted", text);
			},
			label,
			appearance ? { frames: appearance.indicator.frames, intervalMs: appearance.indicator.intervalMs } : undefined,
		);
		this.appearanceState = state;
	}

	override setAppearance(appearance: StatusIndicatorAppearance): void {
		this.appearanceState.current = appearance;
		this.setIndicator({ frames: appearance.indicator.frames, intervalMs: appearance.indicator.intervalMs });
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	private readonly appearanceState: { current?: StatusIndicatorAppearance };

	constructor(ui: TUI, appearance?: StatusIndicatorAppearance) {
		const state: { current?: StatusIndicatorAppearance } = { current: appearance };
		super(
			"branchSummary",
			ui,
			(spinner) => {
				const current = state.current;
				return current
					? applyTextPresentation({ ...current.label, foreground: current.indicator.color }, spinner)
					: theme.fg("accent", spinner);
			},
			(text) => {
				const current = state.current;
				return current ? applyTextPresentation(current.label, text) : theme.fg("muted", text);
			},
			`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
			appearance ? { frames: appearance.indicator.frames, intervalMs: appearance.indicator.intervalMs } : undefined,
		);
		this.appearanceState = state;
	}

	override setAppearance(appearance: StatusIndicatorAppearance): void {
		this.appearanceState.current = appearance;
		this.setIndicator({ frames: appearance.indicator.frames, intervalMs: appearance.indicator.intervalMs });
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
