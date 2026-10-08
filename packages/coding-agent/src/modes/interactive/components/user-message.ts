import { Box, Container, Markdown, type MarkdownTheme, sliceByColumn, visibleWidth } from "@zykairotis/ice-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { resolveAppearanceColorFn } from "../appearance/appearance-resolve.ts";
import type { AppearanceSettingsV2 } from "../appearance/appearance-types.ts";
import {
	applyUserMessageFormat,
	renderUserMessageBorder,
	resolveUserMessagePresentation,
} from "../appearance/user-message-presentation.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message.
 *
 * Width invariant: every line returned by render(width) satisfies
 * visibleWidth(line) <= width. Inner content is budgeted first (requested
 * width minus side borders, minus clamped horizontal padding), then borders
 * wrap the already-budgeted rows.
 */
export class UserMessageComponent extends Container {
	private text: string;
	private formattedText: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private appearance: AppearanceSettingsV2["userMessage"] | null = null;
	private contentBox: Box | null = null;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();
		this.text = text;
		this.formattedText = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	setAppearance(appearance: AppearanceSettingsV2["userMessage"] | null): void {
		this.appearance = appearance;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.contentBox = this.buildBox(this.appearance?.paddingX ?? this.outputPad, this.appearance?.paddingY ?? 0);
		this.addChild(this.contentBox);
	}

	private buildBox(paddingX: number, paddingY: number): Box {
		const formatted = this.appearance ? applyUserMessageFormat(this.appearance.format, this.text) : this.text;
		this.formattedText = formatted;
		const appearance = this.appearance;
		const presentation = appearance
			? resolveUserMessagePresentation({
					...appearance,
					themeForeground: resolveAppearanceColorFn(appearance.foreground, "fg"),
					themeBackground: resolveAppearanceColorFn(appearance.background, "bg"),
					themeBorder: resolveAppearanceColorFn(appearance.borderColor, "fg"),
					customColor: (value: string) => resolveAppearanceColorFn({ kind: "custom", value }, "fg"),
				})
			: null;
		const background = appearance
			? resolveAppearanceColorFn(appearance.background, "bg")
			: (content: string) => theme.bg("userMessageBg", content);
		const foreground = presentation?.color ?? ((content: string) => theme.fg("userMessageText", content));
		const box = new Box(Math.max(0, paddingX), Math.max(0, paddingY), background);
		box.addChild(
			new Markdown(
				formatted,
				0,
				0,
				this.markdownTheme,
				{
					color: (content: string) => foreground(content),
				},
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: createMarkdownTransform("user", false, this.markdownTransformers),
				},
			),
		);
		return box;
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const borderStyle = this.appearance?.borderStyle ?? "none";
		const requestedPaddingX = this.appearance?.paddingX ?? this.outputPad;
		const paddingY = this.appearance?.paddingY ?? 0;
		const borderColor = this.appearance
			? resolveAppearanceColorFn(this.appearance.borderColor, "fg")
			: (content: string) => theme.fg("userMessageText", content);
		const sideWidth = borderStyle === "none" || borderStyle.startsWith("top-bottom-") ? 0 : 2;
		// Clamp horizontal padding so padding + content never exceed the inner
		// viewport. Box itself does not clamp (shared component).
		const maxPadding = Math.max(0, Math.floor((safeWidth - sideWidth) / 2));
		const paddingX = Math.max(0, Math.min(requestedPaddingX, maxPadding));
		this.clear();
		this.contentBox = this.buildBox(paddingX, paddingY);
		this.addChild(this.contentBox);
		const innerWidth = Math.max(1, safeWidth - sideWidth);
		let lines: string[];
		if (this.appearance?.fitToContent) {
			const target = fitTargetWidth(this.formattedText, paddingX, safeWidth, sideWidth);
			const outerTarget = Math.max(1, Math.min(safeWidth, target));
			const contentTarget = Math.max(1, outerTarget - sideWidth);
			lines = super.render(outerTarget).map((line) => fitLineToWidth(line, outerTarget));
			if (borderStyle === "none") return this.markZones(lines);
			const border = renderUserMessageBorder(borderStyle, outerTarget, borderColor);
			if (border.left || border.right) {
				lines = super.render(outerTarget).map((line) => fitLineToWidth(line, outerTarget));
				lines = lines.map((line) => `${border.left}${fitLineToWidth(line, contentTarget)}${border.right}`);
			}
			if (border.top) lines.unshift(border.top);
			if (border.bottom) lines.push(border.bottom);
			return this.markZones(lines);
		}
		lines = super.render(safeWidth).map((line) => fitLineToWidth(line, innerWidth + sideWidth));
		if (borderStyle === "none") return this.markZones(lines);
		const border = renderUserMessageBorder(borderStyle, safeWidth, borderColor);
		if (border.left || border.right) {
			lines = lines.map((line) => `${border.left}${fitLineToWidth(line, innerWidth)}${border.right}`);
		}
		if (border.top) lines.unshift(border.top);
		if (border.bottom) lines.push(border.bottom);
		return this.markZones(lines.map((line) => fitLineToWidth(line, safeWidth)));
	}

	private markZones(lines: string[]): string[] {
		if (lines.length === 0) {
			return lines;
		}
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}

export function fitLineToWidth(line: string, width: number): string {
	const safeWidth = Math.max(0, Math.floor(width));
	const current = visibleWidth(line);
	if (current === safeWidth) return line;
	if (current < safeWidth) return line + " ".repeat(safeWidth - current);
	return sliceByColumn(line, 0, safeWidth, true);
}

/**
 * Fit target derived from the unwrapped source model: longest source line
 * plus horizontal padding and side borders, clamped to the requested width.
 * Never measured from full-width Box/background rows.
 */
export function fitTargetWidth(source: string, paddingX: number, maxWidth: number, sideWidth: number): number {
	const safeMax = Math.max(1, Math.floor(maxWidth));
	let natural = 1;
	for (const line of source.split("\n")) {
		natural = Math.max(natural, visibleWidth(line));
	}
	return Math.max(1, Math.min(safeMax, natural + paddingX * 2 + sideWidth));
}

export function fitLinesToContent(lines: string[], maxWidth: number, sideWidth: number): string[] {
	const safeMax = Math.max(1, Math.floor(maxWidth));
	if (lines.length === 0) return lines;
	let natural = 1;
	for (const line of lines) {
		natural = Math.max(natural, Math.min(safeMax - sideWidth, visibleWidth(line)));
	}
	const target = Math.max(1, Math.min(safeMax - sideWidth, natural));
	return lines.map((line) => fitLineToWidth(line, target));
}
