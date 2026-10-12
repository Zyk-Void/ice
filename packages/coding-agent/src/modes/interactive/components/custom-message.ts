import type { TextContent } from "@zykairotis/ice-ai";
import type { Component } from "@zykairotis/ice-tui";
import { applyChromeBorder, Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@zykairotis/ice-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { BASH_BACKGROUND_COMPLETED_CUSTOM_TYPE } from "../../../core/tools/bash-background.ts";
import { formatShellRuntime } from "../../../core/tools/bash-shells.ts";
import { SUBAGENT_COMPLETED_CUSTOM_TYPE } from "../../../subagents/v2/runtime-support.ts";
import { resolveAppearanceColorFn } from "../appearance/appearance-resolve.ts";
import type { SystemCardAppearance } from "../appearance/appearance-types.ts";
import { applyTextPresentation } from "../appearance/text-presentation.ts";
import { sym } from "../theme/symbols.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import { linkToolToggleLine } from "./tool-toggle-link.ts";

/** Default-rendered custom types that collapse to head/tail lines until expanded. */
const COLLAPSIBLE_CUSTOM_TYPES: ReadonlySet<string> = new Set([SUBAGENT_COMPLETED_CUSTOM_TYPE]);

/** What the session records with a background shell completion (older entries may lack fields). */
interface BashCompletionDetails {
	taskId?: string;
	command?: string;
	description?: string;
	isError?: boolean;
	exitCode?: number;
	durationMs?: number;
	stoppedByUser?: boolean;
}

/** One status line for a finished background shell, e.g. `Background command "Run tests" completed (exit code 0)`. */
function bashCompletionLine(details: BashCompletionDetails): string {
	const label = details.description ?? details.command ?? details.taskId ?? "command";
	const exit = details.exitCode !== undefined ? ` (exit code ${details.exitCode})` : "";
	const [mark, status] = details.stoppedByUser
		? [theme.fg("muted", sym("separator")), "was stopped"]
		: details.isError
			? [theme.fg("error", sym("error")), `failed${exit}`]
			: [theme.fg("success", sym("toolSuccess")), `completed${exit}`];
	const duration =
		details.durationMs !== undefined ? theme.fg("dim", ` · ${formatShellRuntime(details.durationMs)}`) : "";
	return `${mark} ${theme.fg("text", `Background command "${label}" ${status}`)}${duration}`;
}
const COLLAPSED_HEAD_LINES = 4;
const COLLAPSED_TAIL_LINES = 3;

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 * Extension custom renderers keep precedence: appearance only styles the
 * default ICE shell.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;
	private outputPad: number;
	private cardAppearance: SystemCardAppearance | null = null;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		cardAppearance: SystemCardAppearance | null = null,
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.cardAppearance = cardAppearance;

		this.addChild(new Spacer(1));

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		this.rebuild();
	}

	/** Click/expand-key toggle id for messages that collapse to one line; undefined for other messages. */
	getToggleId(): string | undefined {
		if (this.customRenderer || this.message.customType !== BASH_BACKGROUND_COMPLETED_CUSTOM_TYPE) return undefined;
		const details = (this.message.details ?? {}) as BashCompletionDetails;
		return `bash-completed:${details.taskId ?? ""}:${this.message.timestamp}`;
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad !== outputPad) {
			this.outputPad = outputPad;
			this.rebuild();
		}
	}

	setCardAppearance(appearance: SystemCardAppearance | null): void {
		this.cardAppearance = appearance;
		this.rebuild();
	}

	private cardLabel(text: string): string {
		if (!this.cardAppearance) return theme.fg("customMessageLabel", text);
		return applyTextPresentation(this.cardAppearance.label, text);
	}

	private cardBody(text: string): string {
		if (!this.cardAppearance) return theme.fg("customMessageText", text);
		return applyTextPresentation(this.cardAppearance.body, text);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.customComponent || !this.cardAppearance || this.cardAppearance.borderStyle === "none") return lines;
		const spacer = lines.length > 0 ? [lines[0] ?? ""] : [];
		const body = lines.slice(spacer.length);
		return [
			...spacer,
			...applyChromeBorder(
				body,
				width,
				this.cardAppearance.borderStyle,
				resolveAppearanceColorFn(this.cardAppearance.borderColor, "fg"),
			),
		];
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		// Remove previous content component
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(
					this.message,
					{ expanded: this._expanded, outputPad: this.outputPad },
					theme,
				);
				if (component) {
					// Custom renderer provides its own styled component
					this.customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		// A background shell completion is one plain status line; its output shows when expanded.
		const toggleId = this.getToggleId();
		if (toggleId !== undefined) {
			const line = bashCompletionLine((this.message.details ?? {}) as BashCompletionDetails);
			const component = new Container();
			component.addChild(new Text(this._expanded ? line : linkToolToggleLine(line, toggleId), 0, 0));
			if (this._expanded) component.addChild(new Text(theme.fg("dim", this.messageText()), 2, 0));
			this.customComponent = component;
			this.addChild(component);
			return;
		}

		// Default rendering uses our box. Recreate it so appearance-owned
		// padding/background are structural rather than cosmetic overlays.
		if (this.cardAppearance) {
			this.box = new Box(
				this.cardAppearance.paddingX,
				this.cardAppearance.paddingY,
				resolveAppearanceColorFn(this.cardAppearance.background, "bg"),
			);
		}
		this.addChild(this.box);
		this.box.clear();

		// Default rendering: label + content
		const label = this.cardLabel(`\x1b[1m[${this.message.customType}]\x1b[22m`);
		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Spacer(1));

		const text = this.messageText();

		if (!this._expanded && COLLAPSIBLE_CUSTOM_TYPES.has(this.message.customType)) {
			const sourceLines = text.split("\n");
			const hidden = sourceLines.length - COLLAPSED_HEAD_LINES - COLLAPSED_TAIL_LINES;
			if (hidden > 1) {
				const head = sourceLines.slice(0, COLLAPSED_HEAD_LINES).join("\n");
				const tail = sourceLines.slice(-COLLAPSED_TAIL_LINES).join("\n");
				this.addBody(head);
				this.box.addChild(
					new Text(
						this.cardBody(`... ${hidden} more lines (`) +
							theme.fg("dim", keyText("app.tools.expand")) +
							this.cardBody(" to expand)"),
						0,
						0,
					),
				);
				this.addBody(tail);
				return;
			}
		}
		this.addBody(text);
	}

	private messageText(): string {
		if (typeof this.message.content === "string") return this.message.content;
		return this.message.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}

	private addBody(text: string): void {
		this.box.addChild(
			new Markdown(text, 0, 0, this.markdownTheme, {
				color: (value: string) => this.cardBody(value),
			}),
		);
	}
}
