import { Container, getOsc8LinkAtColumn, Text, visibleWidth } from "@zykairotis/ice-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	JUMP_TO_PROMPT_URL,
	StickyPromptHeader,
	TranscriptDocument,
} from "../src/modes/interactive/components/sticky-prompt.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function transcript() {
	const chat = new Container();
	const document = new TranscriptDocument(chat);
	document.addChild(new Text("header", 0, 0));
	document.addChild(chat);
	chat.addChild(new UserMessageComponent("first prompt\nsecond line"));
	chat.addChild(new Text(Array.from({ length: 10 }, (_, i) => `answer ${i}`).join("\n"), 0, 0));
	chat.addChild(new UserMessageComponent("  \n  next   prompt  "));
	chat.addChild(new Text(Array.from({ length: 10 }, (_, i) => `reply ${i}`).join("\n"), 0, 0));
	return document;
}

describe("sticky prompt", () => {
	beforeAll(() => initTheme("dark"));

	it("records where each user prompt starts while the transcript renders", () => {
		const document = transcript();
		const lines = document.render(60);
		expect(document.prompts.map((prompt) => prompt.text)).toEqual([
			"first prompt\nsecond line",
			"  \n  next   prompt  ",
		]);
		for (const { row, text } of document.prompts) {
			const promptLines = new UserMessageComponent(text).render(60);
			expect(lines.slice(row, row + promptLines.length)).toEqual(promptLines);
		}
	});

	it("names the prompt above the viewport only while scrolled away from the end", () => {
		const document = transcript();
		document.render(60);
		const [first, second] = document.prompts;
		const scroll = { scrollTop: 0, isFollowingEnd: false };
		const header = new StickyPromptHeader(document, scroll, theme);

		expect(header.render(60)).toEqual([]);
		scroll.scrollTop = first!.row;
		expect(header.render(60)).toEqual([]);

		scroll.scrollTop = first!.row + 3;
		const line = header.render(60)[0]!;
		expect(stripAnsi(line).trimEnd()).toBe(" ❯ first prompt");
		expect(visibleWidth(line)).toBe(60);
		expect(getOsc8LinkAtColumn(line, 5)).toBe(JUMP_TO_PROMPT_URL);
		expect(header.targetRow).toBe(first!.row);

		scroll.scrollTop = second!.row + 2;
		expect(stripAnsi(header.render(60)[0]!).trimEnd()).toBe(" ❯ next prompt");
		expect(header.targetRow).toBe(second!.row);

		scroll.isFollowingEnd = true;
		expect(header.render(60)).toEqual([]);
		expect(header.targetRow).toBeUndefined();
	});

	it("hides outside fullscreen and truncates long prompts", () => {
		const chat = new Container();
		const document = new TranscriptDocument(chat);
		document.addChild(chat);
		chat.addChild(new UserMessageComponent("x".repeat(200)));
		chat.addChild(new Text("a\nb\nc\nd", 0, 0));
		document.render(40);
		const scroll = { scrollTop: 3, isFollowingEnd: false };
		expect(new StickyPromptHeader(document, scroll, theme, () => false).render(40)).toEqual([]);
		const line = new StickyPromptHeader(document, scroll, theme).render(20)[0]!;
		expect(visibleWidth(line)).toBe(20);
		expect(stripAnsi(line)).toContain("…");
	});
});
