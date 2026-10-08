import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@zykairotis/ice-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { createDefaultAppearance } from "../appearance/appearance-defaults.ts";
import type { ToolAppearance } from "../appearance/appearance-types.ts";
import { applyTextPresentation, toolStateBackground } from "../appearance/text-presentation.ts";
import { sym } from "../theme/symbols.ts";
import { theme } from "../theme/theme.ts";
import { renderDiff } from "./diff.ts";
import { COMPACT_TOOL_MAX_WIDTH, resultTextLines, summarizeToolResult } from "./tool-summary.ts";
import { expandHint, linkToolToggle, linkToolToggleLine } from "./tool-toggle-link.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	/** Optional appearance override; defaults reproduce current rendering. */
	toolsAppearance?: ToolAppearance;
	/**
	 * Render as a bullet row with a one-line outcome under a gutter instead of a
	 * padded background box. Full renderer output appears only when expanded.
	 */
	compact?: boolean;
}

export type ToolExecutionState = "pending" | "success" | "error";

/** Collapsed compact rows: live tail while running, head on error or completion, renderer preview otherwise. */
const COMPACT_RUNNING_TAIL_LINES = 3;
const COMPACT_ERROR_HEAD_LINES = 5;
const COMPACT_OUTPUT_HEAD_LINES = 3;
const COMPACT_PREVIEW_LINES = 5;
const COMPACT_DIFF_PREVIEW_LINES = 14;

function trimBlankLines(lines: string[]): string[] {
	const isBlank = (line: string) => stripAnsi(line).trim() === "";
	let start = 0;
	let end = lines.length;
	while (start < end && isBlank(lines[start]!)) start++;
	while (end > start && isBlank(lines[end - 1]!)) end--;
	return lines.slice(start, end);
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	/** The cell a click on this row toggles: itself, or the group that lays it out. */
	private toggleId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private toolsAppearance: ToolAppearance | null = null;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;
	private readonly compact: boolean;
	private leadingSpacer = true;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.toggleId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.toolsAppearance = options.toolsAppearance ?? null;
		this.ui = ui;
		this.cwd = cwd;
		this.compact = options.compact ?? false;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => this.toolBg("pending", text));
		this.contentText = new Text("", 1, 1, (text: string) => this.toolBg("pending", text));
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	/** Appearance-driven tool state background; falls back to theme tokens. */
	private toolBg(state: "pending" | "success" | "error", text: string): string {
		const appearance = this.toolsAppearance;
		if (!appearance) {
			return state === "pending"
				? theme.bg("toolPendingBg", text)
				: state === "error"
					? theme.bg("toolErrorBg", text)
					: theme.bg("toolSuccessBg", text);
		}
		return toolStateBackground(
			{ ...createDefaultAppearance(), tools: appearance } as Parameters<typeof toolStateBackground>[0],
			state,
		)(text);
	}

	/** Appearance-driven title/output styling; falls back to theme tokens. */
	private toolTitle(text: string): string {
		if (!this.toolsAppearance) return theme.fg("toolTitle", theme.bold(text));
		return applyTextPresentation(this.toolsAppearance.title, text);
	}

	private toolOutput(text: string): string {
		if (!this.toolsAppearance) return theme.fg("toolOutput", text);
		return applyTextPresentation(this.toolsAppearance.output, text);
	}

	setToolsAppearance(appearance: ToolAppearance | null): void {
		this.toolsAppearance = appearance;
		this.updateDisplay();
	}

	private createCallFallback(): Component {
		return new Text(this.toolTitle(this.toolName), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new Text(this.toolOutput(output), 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	getToolCallId(): string {
		return this.toolCallId;
	}

	setToggleId(id: string): void {
		this.toggleId = id;
	}

	getToolName(): string {
		return this.toolName;
	}

	getArgs(): unknown {
		return this.args;
	}

	getState(): ToolExecutionState {
		return this.isPartial ? "pending" : this.result?.isError ? "error" : "success";
	}

	/** Tools with renderShell "self" draw their own framing and never merge into compact groups. */
	rendersOwnShell(): boolean {
		return this.hasRendererDefinition() && this.getRenderShell() === "self";
	}

	/** Grouped members omit the blank line that separates standalone transcript items. */
	setLeadingSpacer(enabled: boolean): void {
		this.leadingSpacer = enabled;
	}

	/** State-specific glyph: pending arrow, completed check, or failure cross. */
	renderBullet(): string {
		const state = this.getState();
		const color = state === "error" ? "error" : state === "success" ? "success" : "muted";
		return theme.fg(color, sym(state === "error" ? "error" : state === "success" ? "toolSuccess" : "toolPending"));
	}

	/** Diff text of a finished edit, when the result carries one. */
	private getEditDiff(): string | undefined {
		const details = this.result?.details;
		return details && typeof details === "object" && "diff" in details && typeof details.diff === "string"
			? details.diff
			: undefined;
	}

	/** Call title lines, without bullet or body. Shell calls read "Ran <command>", edits "Edited <path> (+a -r)". */
	renderTitleLines(width: number): string[] {
		const editPath =
			this.toolName === "edit" && this.args && typeof this.args === "object" && "path" in this.args
				? this.args.path
				: undefined;
		if (this.compact && typeof editPath === "string") {
			const diff = this.getEditDiff();
			const verb = this.toolTitle(this.isPartial ? "Edit" : this.result?.isError ? "Edit failed" : "Edited");
			const stats =
				diff && this.result ? ` ${theme.fg("dim", `(${summarizeToolResult("edit", this.result)})`)}` : "";
			return [
				truncateToWidth(`${verb} ${theme.fg("toolTitle", editPath)}${stats}`, Math.max(1, width), sym("ellipsis")),
			];
		}
		const command =
			this.toolName === "bash" && this.args && typeof this.args === "object" && "command" in this.args
				? this.args.command
				: undefined;
		if (this.compact && typeof command === "string" && command.trim()) {
			const [firstLine = "", ...rest] = command.trim().split("\n");
			const verb = this.toolTitle(this.isPartial && this.executionStarted ? "Running" : "Ran");
			if (this.expanded) {
				return wrapTextWithAnsi(`${verb} ${theme.fg("toolTitle", command.trim())}`, Math.max(1, width));
			}
			const text = rest.length > 0 ? `${firstLine} ${sym("ellipsis")}` : firstLine;
			return [truncateToWidth(`${verb} ${theme.fg("toolTitle", text)}`, Math.max(1, width), sym("ellipsis"))];
		}
		const component = this.callRendererComponent ?? this.createCallFallback();
		const lines = component.render(Math.max(1, width));
		return lines.length > 0 ? lines : [this.toolTitle(this.toolName)];
	}

	/**
	 * Output lines for a collapsed row: live tail while running, head on error,
	 * the first output lines for shell commands, otherwise the tool's own
	 * collapsed renderer preview (edit diffs, subagent status) capped in height.
	 */
	renderCollapsedBodyLines(width: number): string[] {
		if (!this.result) return [];
		const lines = resultTextLines(this.result);
		const dim = (text: string) => theme.fg("dim", text);
		const more = (hidden: number) =>
			linkToolToggleLine(dim(`${sym("ellipsis")} +${hidden} lines (${expandHint()} to expand)`), this.toggleId);
		if (this.isPartial) {
			const tail = lines.slice(-COMPACT_RUNNING_TAIL_LINES);
			const hidden = lines.length - tail.length;
			return [...(hidden > 0 ? [dim(`${sym("ellipsis")} +${hidden} lines`)] : []), ...tail.map(dim)];
		}
		if (this.result.isError) {
			const head = lines.slice(0, COMPACT_ERROR_HEAD_LINES);
			const hidden = lines.length - head.length;
			return [...head.map((line) => theme.fg("error", line)), ...(hidden > 0 ? [more(hidden)] : [])];
		}
		const diff = this.toolName === "edit" ? this.getEditDiff() : undefined;
		if (diff) {
			const diffLines = trimBlankLines(renderDiff(diff, { width }).split("\n"));
			return diffLines.length > COMPACT_DIFF_PREVIEW_LINES
				? [...diffLines.slice(0, COMPACT_DIFF_PREVIEW_LINES), more(diffLines.length - COMPACT_DIFF_PREVIEW_LINES)]
				: diffLines;
		}
		const details = this.result.details;
		if (details && typeof details === "object" && "backgroundTaskId" in details) {
			return [dim(summarizeToolResult(this.toolName, this.result))];
		}
		if (this.toolName !== "bash" && this.resultRendererComponent) {
			const preview = trimBlankLines(this.resultRendererComponent.render(Math.max(1, width)));
			if (preview.length > 0) {
				const limit =
					this.toolName === "edit" || this.toolName === "write"
						? COMPACT_DIFF_PREVIEW_LINES
						: COMPACT_PREVIEW_LINES;
				return preview.length > limit ? [...preview.slice(0, limit), more(preview.length - limit)] : preview;
			}
		}
		if (lines.length === 0) return [dim(summarizeToolResult(this.toolName, this.result))];
		const head = lines.slice(0, COMPACT_OUTPUT_HEAD_LINES);
		return [...head.map(dim), ...(lines.length > head.length ? [more(lines.length - head.length)] : [])];
	}

	/** Bullet row, then the collapsed outcome (or the full result when expanded) under a gutter. */
	renderCompact(width: number): string[] {
		if (!this.expanded) width = Math.min(width, COMPACT_TOOL_MAX_WIDTH);
		const lines: string[] = this.leadingSpacer ? [""] : [];
		const titleLines = this.renderTitleLines(width - 2);
		lines.push(`${this.renderBullet()} ${titleLines[0]}`, ...titleLines.slice(1).map((line) => `  ${line}`));

		const bodyWidth = Math.max(1, width - 4);
		const editDiff = this.toolName === "edit" ? this.getEditDiff() : undefined;
		const body = trimBlankLines(
			this.expanded && this.result && !this.result.isError && editDiff
				? renderDiff(editDiff, { width: bodyWidth }).split("\n")
				: this.expanded && this.result && this.toolName !== "edit"
					? (this.resultRendererComponent?.render(bodyWidth) ??
						resultTextLines(this.result).map((line) => this.toolOutput(line)))
					: this.renderCollapsedBodyLines(bodyWidth),
		);
		body.forEach((line, index) => {
			const prefix = index === 0 ? `  ${theme.fg("dim", sym("gutter"))} ` : "    ";
			lines.push(prefix + truncateToWidth(line, bodyWidth, theme.fg("dim", sym("ellipsis"))));
		});

		if (this.expanded) {
			for (const image of this.imageComponents) lines.push(...image.render(width));
		}
		return lines;
	}

	override render(width: number): string[] {
		return linkToolToggle(this.renderCell(width), this.toggleId);
	}

	private renderCell(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}

		// Edit draws its own diff shell; compact mode renders the diff under the gutter instead.
		if (this.compact && (!this.rendersOwnShell() || this.toolName === "edit")) {
			return this.renderCompact(width);
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				return [];
			}

			const lines: string[] = [];
			if (contentLines.length > 0) {
				lines.push("");
				lines.push(...contentLines);
			}
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					lines.push(...spacer.render(width));
				}
				const imageComponent = this.imageComponents[i];
				if (imageComponent) {
					lines.push(...imageComponent.render(width));
				}
			}
			return lines;
		}

		return super.render(width);
	}

	private updateDisplay(): void {
		const state = this.isPartial ? "pending" : this.result?.isError ? "error" : "success";
		const bgFn = (text: string): string => this.toolBg(state, text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => this.toolOutput(s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = this.toolTitle(this.toolName);
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
