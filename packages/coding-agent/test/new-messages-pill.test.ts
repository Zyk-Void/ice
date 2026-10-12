import type { AgentMessage } from "@zykairotis/ice-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@zykairotis/ice-ai/compat";
import { Container, ScrollView, setKeybindings, Text, TuiAltScreen, VStack, visibleWidth } from "@zykairotis/ice-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { JUMP_TO_BOTTOM_URL, NewMessagesPill } from "../src/modes/interactive/components/new-messages-pill.ts";
import { TranscriptDocument } from "../src/modes/interactive/components/sticky-prompt.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

vi.mock("../src/utils/tools-manager.ts", () => ({ ensureTool: vi.fn().mockResolvedValue("/tmp/test-tool") }));

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

	it("scrolls to the end when the pill is clicked", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const document = new Text(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), 0, 0);
		const scroll = new ScrollView(document, { follow: "end", primary: true });
		const opened: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			openUrl: (url) => {
				opened.push(url);
				if (url === JUMP_TO_BOTTOM_URL) scroll.scrollToEnd();
			},
		});
		const pill = new NewMessagesPill(scroll, () => [], theme);
		const editor = { render: () => ["editor"], invalidate: () => {}, handleInput: () => {} };
		tui.addChild(new Container());
		tui.setLayoutRoot(
			new VStack([
				{ component: scroll, basis: 0, grow: 1 },
				{ component: new VStack([{ component: pill }, { component: editor }]) },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[5~");
			await terminal.waitForRender();
			const row = terminal.getViewport().findIndex((line) => line.includes("Jump to bottom"));
			expect(row).toBeGreaterThanOrEqual(0);
			const col = terminal.getViewport()[row]!.indexOf("Jump") + 1;
			terminal.sendInput(`\x1b[<0;${col};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${col};${row + 1}m`);
			await terminal.waitForRender();
			expect(opened).toEqual([JUMP_TO_BOTTOM_URL]);
			expect(scroll.isFollowingEnd).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it.each([
		[80, 24],
		[40, 12],
	])("keeps the pill directly above the prompt below activity at %ix%i", async (columns, rows) => {
		const terminal = new VirtualTerminal(columns, rows);
		const tui = new TuiAltScreen(terminal);
		const chat = new Container();
		chat.addChild(new Text(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), 0, 0));
		const document = new TranscriptDocument(chat);
		document.addChild(chat);
		const pending = new Container();
		pending.addChild(new Text("Queued prompt", 0, 0));
		const status = new Container();
		status.addChild(new Text("Thinking...\nRunning read", 0, 0));
		const widgets = new Container();
		widgets.addChild(new Text("Above-editor widget", 0, 0));
		const editor = new Text("PROMPT TOP BORDER\n> prompt\nPROMPT BOTTOM BORDER", 0, 0);
		const layoutReady = new Error("layout ready");
		// Run the production composition path, stopping before unrelated startup handlers.
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		Object.assign(mode, {
			runtimeHost: {
				session: {
					scopedModels: [],
					messages: [],
					sessionId: "test-session",
					settingsManager: { getQuietStartup: () => true, getFullscreenScrollbar: () => "hidden" },
				},
			},
			renderer: tui,
			ui: tui,
			options: { uiMode: "fullscreen" },
			displayedViewId: "parent",
			documentContainer: document,
			pendingMessagesContainer: pending,
			statusContainer: status,
			widgetContainerAbove: widgets,
			widgetContainerBelow: new Container(),
			editorContainer: new VStack([{ component: editor }]),
			editor,
			agentSwitcherContainer: new Container(),
			footerContainer: new Text("Footer", 0, 0),
			registerSignalHandlers: () => {},
			getChangelogForDisplay: () => undefined,
			renderWidgets: () => {},
			setupKeyHandlers: () => {
				throw layoutReady;
			},
		});
		await expect(mode.init()).rejects.toBe(layoutReady);
		tui.start();
		try {
			await terminal.waitForRender();
			// Stay far enough from the end that removing activity rows cannot reach the bottom.
			terminal.sendInput("\x1b[H");
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const pillRow = viewport.findIndex((line) => line.includes("Jump to bottom"));
			expect(pillRow).toBeGreaterThan(0);
			expect(viewport.slice(pillRow - 4, pillRow).map((line) => line.trim())).toEqual([
				"Queued prompt",
				"Thinking...",
				"Running read",
				"Above-editor widget",
			]);
			expect(viewport[pillRow + 1]?.trimEnd()).toBe("PROMPT TOP BORDER");

			status.clear();
			pending.clear();
			widgets.clear();
			tui.requestRender();
			await terminal.waitForRender();
			const idleViewport = terminal.getViewport();
			const idlePillRow = idleViewport.findIndex((line) => line.includes("Jump to bottom"));
			expect(idlePillRow).toBeGreaterThanOrEqual(0);
			expect(idleViewport[idlePillRow + 1]?.trimEnd()).toBe("PROMPT TOP BORDER");
		} finally {
			tui.stop();
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
