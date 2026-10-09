import type { AgentMessage } from "@zykairotis/ice-agent-core";
import { type Component, type ScrollView, truncateToWidth, visibleWidth } from "@zykairotis/ice-tui";
import type { Theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import { ICE_ACTION_URL_PREFIX } from "./tool-toggle-link.ts";

/** Internal link on the pill; InteractiveMode routes a click on it to scroll the transcript to the end. */
export const JUMP_TO_BOTTOM_URL = `${ICE_ACTION_URL_PREFIX}scroll-bottom`;

export class NewMessagesPill implements Component {
	private readonly scrollView: Pick<ScrollView, "isFollowingEnd">;
	private readonly getMessages: () => readonly AgentMessage[];
	private readonly theme: Pick<Theme, "fg" | "bg">;
	private readonly options: { isVisible?: () => boolean; getTranscriptId?: () => string };
	private snapshot: number | undefined;
	private transcriptId: string | undefined;

	constructor(
		scrollView: Pick<ScrollView, "isFollowingEnd">,
		getMessages: () => readonly AgentMessage[],
		theme: Pick<Theme, "fg" | "bg">,
		options: { isVisible?: () => boolean; getTranscriptId?: () => string } = {},
	) {
		this.scrollView = scrollView;
		this.getMessages = getMessages;
		this.theme = theme;
		this.options = options;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const messages = this.getMessages();
		const transcriptId = this.options.getTranscriptId?.();
		if (transcriptId !== this.transcriptId || messages.length < (this.snapshot ?? 0)) {
			this.snapshot = undefined;
			this.transcriptId = transcriptId;
		}
		if (this.scrollView.isFollowingEnd || this.options.isVisible?.() === false) {
			this.snapshot = undefined;
			return [];
		}
		this.snapshot ??= messages.length;
		let count = 0;
		let previousAssistant = false;
		for (const message of messages.slice(this.snapshot)) {
			if (message.role === "assistant") {
				if (!message.content.some((part) => part.type === "text" && part.text.trim().length > 0)) continue;
				if (!previousAssistant) count++;
				previousAssistant = true;
			} else if (message.role === "user" || message.role === "toolResult") {
				previousAssistant = false;
			}
		}
		const key = keyText("tui.altScreen.bottom");
		const label = count > 0 ? `${count} new message${count === 1 ? "" : "s"}` : "Jump to bottom";
		const line = truncateToWidth(` ${label}${key ? ` (${key})` : ""} ↓ `, Math.max(0, width));
		return [
			" ".repeat(Math.max(0, Math.floor((width - visibleWidth(line)) / 2))) +
				`\x1b]8;;${JUMP_TO_BOTTOM_URL}\x1b\\${this.theme.bg("selectedBg", this.theme.fg("text", line))}\x1b]8;;\x1b\\`,
		];
	}
}
