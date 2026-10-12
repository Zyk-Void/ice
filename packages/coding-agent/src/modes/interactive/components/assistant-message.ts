import type { AssistantMessage } from "@zykairotis/ice-ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@zykairotis/ice-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { resolveAppearanceColorFn } from "../appearance/appearance-resolve.ts";
import type { AppearanceSettingsV2 } from "../appearance/appearance-types.ts";
import { styleThinkingBlockText } from "../appearance/thinking-presentation.ts";
import { sym } from "../theme/symbols.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { markOsc133Zone } from "./osc133-zone.ts";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private thinkingAppearance: AppearanceSettingsV2["thinking"]["block"] | null = null;
	private assistantAppearance: AppearanceSettingsV2["assistantMessage"] | null = null;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private bulletText = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setThinkingAppearance(appearance: AppearanceSettingsV2["thinking"]["block"] | null): void {
		this.thinkingAppearance = appearance;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setAssistantAppearance(appearance: AppearanceSettingsV2["assistantMessage"] | null): void {
		this.assistantAppearance = appearance ? structuredClone(appearance) : null;
	}

	/** Prefix each assistant text block with a bullet and hang-indent its continuation lines. */
	setBulletText(enabled: boolean): void {
		if (this.bulletText === enabled) return;
		this.bulletText = enabled;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const configuredAppearance = this.assistantAppearance;
		const appearance =
			configuredAppearance &&
			!(
				configuredAppearance.paddingX === 0 &&
				configuredAppearance.paddingY === 0 &&
				configuredAppearance.borderStyle === "none" &&
				configuredAppearance.background.kind === "terminal-default"
			)
				? configuredAppearance
				: null;
		const chars = appearance ? assistantBorderChars(appearance.borderStyle) : null;
		const borderWidth = chars?.sides ? 2 : 0;
		const paddingX = appearance?.paddingX ?? 0;
		const paddingY = appearance?.paddingY ?? 0;
		const innerWidth = Math.max(1, width - borderWidth - paddingX * 2);
		let lines = super.render(innerWidth);

		if (appearance) {
			const background = resolveAppearanceColorFn(appearance.background, "bg");
			const borderColor = resolveAppearanceColorFn(appearance.borderColor, "fg");
			const contentWidth = Math.max(1, width - borderWidth);
			const decorateBody = (line: string): string => {
				const clipped = truncateToWidth(line, innerWidth, "");
				const raw = `${" ".repeat(paddingX)}${clipped}`;
				return background(raw + " ".repeat(Math.max(0, contentWidth - visibleWidth(raw))));
			};
			lines = [
				...Array.from({ length: paddingY }, () => decorateBody("")),
				...lines.map(decorateBody),
				...Array.from({ length: paddingY }, () => decorateBody("")),
			];
			if (chars) {
				if (chars.sides) {
					const horizontalWidth = Math.max(0, width - 2);
					lines = [
						borderColor(`${chars.tl}${chars.h.repeat(horizontalWidth)}${chars.tr}`),
						...lines.map((line) => `${borderColor(chars.v)}${line}${borderColor(chars.v)}`),
						borderColor(`${chars.bl}${chars.h.repeat(horizontalWidth)}${chars.br}`),
					];
				} else {
					// Top-bottom-only styles: horizontal rules across the full width,
					// no side columns reserved or drawn.
					lines = [borderColor(chars.h.repeat(width)), ...lines, borderColor(chars.h.repeat(width))];
				}
			}
		}

		if (this.hasToolCalls) return lines;
		return markOsc133Zone(lines);
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const markdown = new Markdown(
					content.text.trim(),
					this.bulletText ? 0 : this.outputPad,
					0,
					this.markdownTheme,
					undefined,
					{ transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers) },
				);
				this.contentContainer.addChild(this.bulletText ? new BulletBlock(markdown) : markdown);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show one static label for each run of thinking blocks when hidden.
					// showByDefault:false means newly created components start hidden unless
					// the mode passes an explicit visibility flag.
					const hiddenLabel = this.thinkingAppearance?.hiddenLabel ?? this.hiddenThinkingLabel;
					if (!hiddenLabel.trim()) continue;
					const hiddenForeground = this.thinkingAppearance
						? resolveAppearanceColorFn(this.thinkingAppearance.foreground, "fg")
						: (content: string) => theme.fg("thinkingText", content);
					const hiddenStyled = this.thinkingAppearance
						? hiddenForeground(styleThinkingBlockText(hiddenLabel, this.thinkingAppearance.styles, theme))
						: theme.italic(theme.fg("thinkingText", hiddenLabel));
					this.contentContainer.addChild(new Text(hiddenStyled, this.outputPad, 0));
				} else {
					// Render each run of thinking blocks as one Markdown section.
					this.contentContainer.addChild(
						new Markdown(
							thinkingBlocks.join("\n\n"),
							this.outputPad,
							0,
							this.markdownTheme,
							{
								color: (text: string) => {
									const styled = this.thinkingAppearance
										? styleThinkingBlockText(text, this.thinkingAppearance.styles, theme)
										: theme.fg("thinkingText", text);
									if (!this.thinkingAppearance) return styled;
									return resolveAppearanceColorFn(this.thinkingAppearance.foreground, "fg")(styled);
								},
								italic: this.thinkingAppearance ? this.thinkingAppearance.styles.includes("italic") : true,
							},
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
							},
						),
					);
				}
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}

		// Hidden thinking with an empty label leaves only spacing; render nothing instead of a blank line.
		if (this.contentContainer.children.every((child) => child instanceof Spacer)) {
			this.contentContainer.clear();
		}
	}
}

/** Renders a child with a leading bullet on its first line and a two-column hanging indent. */
class BulletBlock implements Component {
	private readonly child: Component;

	constructor(child: Component) {
		this.child = child;
	}

	invalidate(): void {
		this.child.invalidate();
	}

	render(width: number): string[] {
		const lines = this.child.render(Math.max(1, width - 2));
		return lines.map((line, index) => (index === 0 ? `${theme.fg("text", sym("bullet"))} ${line}` : `  ${line}`));
	}
}

function assistantBorderChars(
	style: AppearanceSettingsV2["assistantMessage"]["borderStyle"],
): { tl: string; tr: string; bl: string; br: string; h: string; v: string; sides: boolean } | null {
	switch (style) {
		case "none":
			return null;
		case "top-bottom-single":
			return { tl: "", tr: "", bl: "", br: "", h: "─", v: "", sides: false };
		case "top-bottom-double":
			return { tl: "", tr: "", bl: "", br: "", h: "═", v: "", sides: false };
		case "top-bottom-bold":
			return { tl: "", tr: "", bl: "", br: "", h: "━", v: "", sides: false };
		case "double":
			return { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", sides: true };
		case "round":
			return { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", sides: true };
		case "bold":
			return { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃", sides: true };
		case "single-double":
			return { tl: "╓", tr: "╖", bl: "╙", br: "╜", h: "─", v: "║", sides: true };
		case "double-single":
			return { tl: "╒", tr: "╕", bl: "╘", br: "╛", h: "═", v: "│", sides: true };
		case "classic":
			return { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", sides: true };
		default:
			return { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", sides: true };
	}
}
