import { type Component, Container, type ScrollView, truncateToWidth, visibleWidth } from "@zykairotis/ice-tui";
import type { Theme } from "../theme/theme.ts";
import { ICE_ACTION_URL_PREFIX } from "./tool-toggle-link.ts";
import { UserMessageComponent } from "./user-message.ts";

/** Internal link on the sticky prompt; InteractiveMode routes a click on it to scroll back to that prompt. */
export const JUMP_TO_PROMPT_URL = `${ICE_ACTION_URL_PREFIX}scroll-prompt`;

interface PromptRow {
	row: number;
	text: string;
}

/**
 * Transcript document that records the row where each user prompt starts while it renders, so the
 * sticky prompt needs no second pass over the transcript. User prompts are direct children of `chat`.
 */
export class TranscriptDocument extends Container {
	private readonly chat: Container;
	private promptRows: PromptRow[] = [];

	constructor(chat: Container) {
		super();
		this.chat = chat;
	}

	/** Prompt start rows from the latest render, in transcript order. */
	get prompts(): readonly PromptRow[] {
		return this.promptRows;
	}

	override render(width: number): string[] {
		const lines: string[] = [];
		const prompts: PromptRow[] = [];
		for (const child of this.children) {
			for (const part of child === this.chat ? this.chat.children : [child]) {
				if (part instanceof UserMessageComponent) prompts.push({ row: lines.length, text: part.getText() });
				for (const line of part.render(width)) lines.push(line);
			}
		}
		this.promptRows = prompts;
		return lines;
	}
}

/**
 * One-row header above the fullscreen transcript naming the prompt whose answer is on screen. It shows
 * only while scrolled away from the end with that prompt above the viewport; a click jumps to the prompt.
 */
export class StickyPromptHeader implements Component {
	private readonly document: Pick<TranscriptDocument, "prompts">;
	private readonly scrollView: Pick<ScrollView, "scrollTop" | "isFollowingEnd">;
	private readonly theme: Pick<Theme, "fg" | "bg">;
	private readonly isVisible: () => boolean;
	private target: number | undefined;

	constructor(
		document: Pick<TranscriptDocument, "prompts">,
		scrollView: Pick<ScrollView, "scrollTop" | "isFollowingEnd">,
		theme: Pick<Theme, "fg" | "bg">,
		isVisible: () => boolean = () => true,
	) {
		this.document = document;
		this.scrollView = scrollView;
		this.theme = theme;
		this.isVisible = isVisible;
	}

	/** Transcript row of the prompt shown in the header, or undefined while hidden. */
	get targetRow(): number | undefined {
		return this.target;
	}

	invalidate(): void {}

	render(width: number): string[] {
		this.target = undefined;
		if (!this.isVisible() || this.scrollView.isFollowingEnd || width <= 0) return [];
		const top = this.scrollView.scrollTop;
		const prompts = this.document.prompts;
		let owner: PromptRow | undefined;
		for (let index = prompts.length - 1; index >= 0; index--) {
			if (prompts[index]!.row <= top) {
				owner = prompts[index];
				break;
			}
		}
		if (!owner || owner.row === top) return [];
		this.target = owner.row;
		const firstLine = owner.text.split("\n").find((line) => line.trim().length > 0) ?? "";
		const label = truncateToWidth(` ❯ ${firstLine.trim().replace(/\s+/g, " ")}`, width, "…");
		const padded = label + " ".repeat(Math.max(0, width - visibleWidth(label)));
		const row = this.theme.bg("userMessageBg", this.theme.fg("userMessageText", padded));
		return [`\x1b]8;;${JUMP_TO_PROMPT_URL}\x1b\\${row}\x1b]8;;\x1b\\`];
	}
}
