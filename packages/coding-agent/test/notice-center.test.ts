import { setKeybindings, visibleWidth } from "@zykairotis/ice-tui";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { NoticesViewComponent } from "../src/modes/interactive/components/notices-view.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { MAX_NOTICES, NoticeCenter, type NoticeInput } from "../src/modes/interactive/notice-center.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type NotifyThis = {
	noticeCenter: NoticeCenter;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	showStatus: (message: string) => void;
};
const showExtensionNotify = (
	InteractiveMode.prototype as unknown as {
		showExtensionNotify(
			this: NotifyThis,
			message: string,
			type?: "info" | "warning" | "error",
			options?: { id?: string; sticky?: boolean },
		): void;
	}
).showExtensionNotify;

const notice = (id: string, overrides: Partial<NoticeInput> = {}): NoticeInput => ({
	id,
	kind: "warning",
	category: "extensions",
	source: "x",
	title: id,
	...overrides,
});

describe("NoticeCenter", () => {
	test("deduplicates by id, keeps the first-seen time, and counts repeats", () => {
		let now = 1;
		const center = new NoticeCenter(() => now);
		center.add(notice("safety:bash", { title: "Bash enabled", sticky: true, category: "session" }));
		now = 5;
		center.add(notice("safety:bash", { title: "Bash enabled again", sticky: true, category: "session" }));

		expect(center.list()).toEqual([
			{
				id: "safety:bash",
				kind: "warning",
				category: "session",
				source: "x",
				title: "Bash enabled again",
				sticky: true,
				createdAt: 1,
				updatedAt: 5,
				count: 2,
			},
		]);
	});

	test("badge counts leave out info and quiet notices", () => {
		const center = new NoticeCenter();
		center.add(notice("a"));
		center.add(notice("b", { kind: "error" }));
		center.add(notice("c", { kind: "update", category: "updates" }));
		center.add(notice("d", { kind: "info" }));
		center.add(notice("e", { kind: "error", quiet: true, category: "tools" }));

		expect(center.counts()).toEqual({ warning: 1, error: 1, update: 1 });
	});

	test("dismisses only non-sticky notices, clears by predicate, and notifies subscribers", () => {
		const center = new NoticeCenter();
		const listener = vi.fn();
		center.subscribe(listener);
		center.add(notice("sticky", { sticky: true }));
		center.add(notice("plain", { kind: "update" }));
		center.add(notice("tool-1", { category: "tools" }));
		center.add(notice("tool-2", { category: "tools" }));
		listener.mockClear();

		expect(center.dismiss("sticky")).toBe(false);
		expect(center.dismiss("plain")).toBe(true);
		expect(center.dismiss("missing")).toBe(false);
		expect(center.dismissWhere((entry) => entry.category === "tools" || entry.id === "sticky")).toBe(2);
		expect(center.list().map((entry) => entry.id)).toEqual(["sticky"]);
		expect(listener).toHaveBeenCalledTimes(2);
	});

	test("replaces derived groups, keeps surviving entries, and remembers dismissals", () => {
		let now = 1;
		const center = new NoticeCenter(() => now);
		const listener = vi.fn();
		center.subscribe(listener);
		center.replaceGroup("subagents", [notice("a"), notice("b")]);
		now = 2;
		listener.mockClear();
		center.replaceGroup("subagents", [notice("a"), notice("b")]);
		expect(listener).not.toHaveBeenCalled();

		center.dismiss("b");
		center.replaceGroup("subagents", [notice("a", { title: "a changed" }), notice("b"), notice("c")]);
		expect(center.list().map((entry) => [entry.id, entry.title, entry.createdAt])).toEqual([
			["a", "a changed", 1],
			["c", "c", 2],
		]);

		// Once "b" leaves the group, a later "b" is new again.
		center.replaceGroup("subagents", [notice("a")]);
		center.replaceGroup("subagents", [notice("a"), notice("b")]);
		expect(center.list().map((entry) => entry.id)).toEqual(["a", "b"]);
	});

	test("keeps at most MAX_NOTICES, dropping quiet and old notices first", () => {
		let now = 0;
		const center = new NoticeCenter(() => now++);
		center.add(notice("sticky", { sticky: true }));
		center.add(notice("loud"));
		for (let index = 0; index < MAX_NOTICES; index++) center.add(notice(`quiet-${index}`, { quiet: true }));
		const ids = center.list().map((entry) => entry.id);
		expect(ids).toHaveLength(MAX_NOTICES);
		expect(ids).toContain("sticky");
		expect(ids).toContain("loud");
		expect(ids).not.toContain("quiet-0");
	});
});

describe("InteractiveMode extension notify routing", () => {
	function createThis(): NotifyThis {
		return { noticeCenter: new NoticeCenter(), showWarning: vi.fn(), showError: vi.fn(), showStatus: vi.fn() };
	}

	test("warnings with an id become deduplicated notices instead of transcript rows", () => {
		const fake = createThis();
		showExtensionNotify.call(fake, "Bash is enabled", "warning", { id: "safety:bash", sticky: true });
		showExtensionNotify.call(fake, "Bash is enabled", "warning", { id: "safety:bash", sticky: true });

		expect(fake.showWarning).not.toHaveBeenCalled();
		expect(fake.noticeCenter.list()).toMatchObject([
			{ id: "safety:bash", kind: "warning", category: "session", sticky: true, count: 2 },
		]);
	});

	test("warnings and errors without an id stay in the chat and are also kept as notices", () => {
		const fake = createThis();
		showExtensionNotify.call(fake, "careful", "warning");
		showExtensionNotify.call(fake, "MCP server github failed to start\nspawn ENOENT", "error");
		showExtensionNotify.call(fake, "fyi", "info", { id: "ignored-for-info" });

		expect(fake.showWarning).toHaveBeenCalledWith("careful");
		expect(fake.showError).toHaveBeenCalled();
		expect(fake.showStatus).toHaveBeenCalledWith("fyi");
		expect(fake.noticeCenter.list().map((entry) => [entry.kind, entry.category, entry.title, entry.detail])).toEqual([
			["warning", "extensions", "careful", undefined],
			["error", "mcp", "MCP server github failed to start", "MCP server github failed to start\nspawn ENOENT"],
		]);
	});
});

describe("InteractiveMode runtime console capture", () => {
	test("keeps console output as notices while the TUI runs and passes it through otherwise", () => {
		const original = vi.fn();
		const realWarn = console.warn;
		console.warn = original;
		const fake = Object.assign(Object.create(InteractiveMode.prototype), {
			noticeCenter: new NoticeCenter(),
			isShuttingDown: false,
			ui: { isRunning: true },
		}) as any;
		try {
			fake.captureRuntimeConsole();
			console.warn("MCP server %s failed:", "github", "spawn ENOENT");
			console.log("debug detail");
			expect(original).not.toHaveBeenCalled();
			fake.ui.isRunning = false;
			console.warn("after stop");
			expect(original).toHaveBeenCalledWith("after stop");
			fake.restoreConsole();
			expect(console.warn).toBe(original);
		} finally {
			fake.restoreConsole?.();
			console.warn = realWarn;
		}
		expect(
			fake.noticeCenter.list().map((entry: any) => [entry.kind, entry.category, entry.title, !!entry.quiet]),
		).toEqual([
			["warning", "mcp", "MCP server github failed: spawn ENOENT", false],
			["info", "console", "debug detail", true],
		]);
	});
});

describe("InteractiveMode /notices <prompt>", () => {
	function createThis(streaming: boolean) {
		const calls: unknown[][] = [];
		const fake = Object.assign(Object.create(InteractiveMode.prototype), {
			noticeCenter: new NoticeCenter(),
			editor: { setText: vi.fn(), addToHistory: vi.fn() },
			ui: { requestRender: vi.fn() },
			pendingUserInputs: [],
			onInputCallback: (text: string) => calls.push(["input", text]),
			beginPreparingPrompt: (text: string) => calls.push(["preparing", text]),
			flushPendingBashComponents: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			showWarning: vi.fn(),
		}) as any;
		Object.defineProperty(fake, "session", {
			value: {
				isCompacting: false,
				isStreaming: streaming,
				sendCustomMessage: async (message: any, options: unknown) => calls.push(["custom", message, options]),
				prompt: async (text: string, options: unknown) => calls.push(["prompt", text, options]),
			},
		});
		fake.noticeCenter.add({ id: "e", kind: "error", category: "mcp", source: "x", title: "MCP server down" });
		return { fake, calls };
	}

	test("attaches the notices report to the next turn and submits the prompt", async () => {
		const { fake, calls } = createThis(false);
		await fake.promptWithNotices("/notices why is mcp failing", "why is mcp failing");
		expect(fake.editor.addToHistory).toHaveBeenCalledWith("/notices why is mcp failing");
		const [custom, preparing, input] = calls as any[];
		expect(custom[1]).toMatchObject({ customType: "notices", display: true });
		expect(custom[1].content).toContain("1. [error] MCP server down");
		expect(custom[2]).toEqual({ deliverAs: "nextTurn" });
		expect(preparing).toEqual(["preparing", "why is mcp failing"]);
		expect(input).toEqual(["input", "why is mcp failing"]);
	});

	test("steers the report and prompt into a running turn", async () => {
		const { fake, calls } = createThis(true);
		await fake.promptWithNotices("/notices check this", "check this");
		expect(calls.map((call) => call[0])).toEqual(["custom", "prompt"]);
		expect(calls[0]![2]).toEqual({ deliverAs: "steer" });
		expect(calls[1]).toEqual(["prompt", "check this", { streamingBehavior: "steer" }]);
	});
});

describe("NoticesViewComponent", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	const plain = (lines: string[]) => lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");

	function panel(center: NoticeCenter, width = 100) {
		const copied: string[] = [];
		const close = vi.fn();
		const view = new NoticesViewComponent(center, new KeybindingsManager(), close, {
			copy: async (text) => {
				copied.push(text);
			},
			now: () => 120_000,
		});
		return { view, close, copied, text: () => plain(view.render(width)) };
	}

	test("opens on problems, filters by category, and shows the selected notice in the inspector", () => {
		const center = new NoticeCenter(() => 0);
		center.add(notice("pkg", { kind: "update", category: "updates", title: "Package updates available" }));
		center.add(
			notice("ext", {
				kind: "error",
				title: "before_agent_start handler failed: boom",
				detail: "Error: boom\n    at hook",
			}),
		);
		center.add(notice("tool", { kind: "error", category: "tools", quiet: true, title: "bash failed: exit 1" }));
		const { view, text } = panel(center);

		let output = text();
		expect(output).toContain("Notices  1 error · 1 update · 1 logged");
		expect(output).toContain(" Problems 2 ");
		expect(output).toContain("before_agent_start handler failed: boom");
		expect(output).toContain("at hook");
		expect(output).not.toContain("Package updates available");

		view.handleInput("\x1b[C");
		view.handleInput("\x1b[C");
		output = text();
		expect(output).toContain("bash failed: exit 1");
		expect(output).not.toContain("handler failed");

		view.handleInput("\x1b[D");
		view.handleInput("\x1b[D");
		view.handleInput("\x1b[D");
		output = text();
		expect(output).toContain("Package updates available");
		expect(output).toContain("bash failed: exit 1");
	});

	test("dismisses, clears the current filter, copies, keeps sticky notices, and closes", async () => {
		const center = new NoticeCenter(() => 0);
		center.add(notice("safety", { title: "Bash enabled", sticky: true, category: "session" }));
		center.add(notice("ext-1", { title: "first failure", kind: "error" }));
		center.add(notice("ext-2", { title: "second failure", kind: "error" }));
		const { view, close, copied, text } = panel(center);

		view.handleInput("c");
		await Promise.resolve();
		expect(copied).toHaveLength(1);
		expect(copied[0]).toContain("extensions · x");

		view.handleInput("d");
		expect(center.list()).toHaveLength(2);
		view.handleInput("x");
		expect(center.list().map((entry) => entry.id)).toEqual(["safety"]);
		expect(text()).toContain("Cleared 1 notice from Problems.");

		view.handleInput("d");
		expect(text()).toContain("This notice describes active state and stays.");
		view.handleInput("\x1b");
		expect(close).toHaveBeenCalledOnce();
	});

	test("scrolls long details, stacks on narrow terminals, and stops listening after dispose", () => {
		const center = new NoticeCenter(() => 0);
		const detail = Array.from({ length: 40 }, (_, index) => `detail line ${index}`).join("\n");
		center.add(notice("long", { kind: "error", detail }));
		const requestRender = vi.fn();
		const view = new NoticesViewComponent(center, new KeybindingsManager(), () => {}, {
			requestRender,
			now: () => 0,
		});
		const render = (width = 80) => plain(view.render(width));

		expect(render()).toContain("lines 1-16 of 40");
		view.handleInput("\x1b[6~");
		expect(render()).toContain("detail line 16");
		expect(render()).not.toContain("detail line 0\n");
		for (const line of view.render(60)) expect(visibleWidth(line)).toBeLessThanOrEqual(60);

		view.dispose();
		requestRender.mockClear();
		center.add(notice("late"));
		expect(requestRender).not.toHaveBeenCalled();
	});
});
