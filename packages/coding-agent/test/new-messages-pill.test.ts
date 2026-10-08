import type { AgentMessage } from "@zykairotis/ice-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai/compat";
import { Container, ScrollView, setKeybindings, Text, TuiAltScreen, VStack, visibleWidth } from "@zykairotis/ice-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { NewMessagesPill } from "../src/modes/interactive/components/new-messages-pill.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("new messages pill", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("hides while following and counts visible assistant turns after scrolling away", () => {
		const scroll = { isFollowingEnd: true };
		const messages: AgentMessage[] = [];
		const pill = new NewMessagesPill(scroll, () => messages, theme);
		expect(pill.render(80)).toEqual([]);
		scroll.isFollowingEnd = false;
		expect(pill.render(80).join("")).toContain("Jump to bottom (end)");
		messages.push(fauxAssistantMessage("first"));
		messages.push(fauxAssistantMessage("continued"));
		messages.push({ role: "user", content: "next", timestamp: 1 });
		messages.push(fauxAssistantMessage("second"));
		expect(pill.render(80).join("")).toContain("2 new messages");
	});

	it("ignores tool-only and blank assistant entries", () => {
		const messages: AgentMessage[] = [];
		const pill = new NewMessagesPill({ isFollowingEnd: false }, () => messages, theme);
		pill.render(80);
		messages.push(fauxAssistantMessage(fauxToolCall("read", { path: "a.txt" })));
		messages.push(fauxAssistantMessage("  "));
		expect(pill.render(80).join("")).toContain("Jump to bottom");
		messages.push(fauxAssistantMessage("text"));
		expect(pill.render(80).join("")).toContain("1 new message (end)");
	});

	it("clears the snapshot at bottom and after switching displayed transcripts", () => {
		const scroll = { isFollowingEnd: false };
		const messages: AgentMessage[] = [];
		let id = "parent";
		const pill = new NewMessagesPill(scroll, () => messages, theme, { getTranscriptId: () => id });
		pill.render(80);
		messages.push(fauxAssistantMessage("new"));
		expect(pill.render(80).join("")).toContain("1 new message");
		scroll.isFollowingEnd = true;
		expect(pill.render(80)).toEqual([]);
		scroll.isFollowingEnd = false;
		expect(pill.render(80).join("")).toContain("Jump to bottom");
		messages.push({ role: "user", content: "next", timestamp: 1 }, fauxAssistantMessage("newer"));
		id = "child";
		expect(pill.render(80).join("")).toContain("Jump to bottom");
	});

	it("uses configured keys and stays within narrow terminal widths", () => {
		setKeybindings(new KeybindingsManager({ "tui.altScreen.bottom": "ctrl+end" }));
		const pill = new NewMessagesPill({ isFollowingEnd: false }, () => [], theme);
		expect(pill.render(80).join("")).toContain("ctrl+end");
		for (const width of [0, 1, 5, 20, 80]) {
			expect(visibleWidth(pill.render(width)[0]!)).toBeLessThanOrEqual(width);
		}
	});

	it("hides outside fullscreen", () => {
		const pill = new NewMessagesPill({ isFollowingEnd: false }, () => [], theme, { isVisible: () => false });
		expect(pill.render(80)).toEqual([]);
	});

	it("scrolls up, renders new content, and handles End before the focused editor", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const tui = new TuiAltScreen(terminal);
		const messages: AgentMessage[] = [];
		const document = new Text(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), 0, 0);
		const scroll = new ScrollView(document, { follow: "end", primary: true });
		const pill = new NewMessagesPill(scroll, () => messages, theme);
		const inputs: string[] = [];
		const editor = {
			render: () => ["editor"],
			invalidate: () => {},
			handleInput: (data: string) => inputs.push(data),
		};
		const dock = new VStack([{ component: pill }, { component: editor }]);
		tui.addChild(new Container());
		tui.setLayoutRoot(new VStack([{ component: scroll, basis: 0, grow: 1 }, { component: dock }]));
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[5~");
			await terminal.waitForRender();
			expect(scroll.isFollowingEnd).toBe(false);
			messages.push(fauxAssistantMessage("new content"));
			tui.requestRender();
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("1 new message (end)");
			terminal.sendInput("\x1b[F");
			await terminal.waitForRender();
			expect(scroll.isFollowingEnd).toBe(true);
			expect(inputs).toEqual([]);
			expect(pill.render(80)).toEqual([]);
		} finally {
			tui.stop();
		}
	});
});
