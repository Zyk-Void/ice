import { Markdown } from "@zykairotis/ice-tui";
import { describe, expect, test } from "vitest";
import { defaultMarkdownTheme } from "../../tui/test/test-themes.ts";
import { createDefaultAppearance } from "../src/modes/interactive/appearance/appearance-defaults.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("appearance baseline (W0)", () => {
	test("default user message preserves current box geometry", () => {
		initTheme("dark");
		const component = new UserMessageComponent("hello");
		const lines = component.render(20);
		// Default user messages are compact: no vertical padding (paddingY 0).
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0]!)).toContain("hello");
	});

	test("default assistant appearance preserves stock rendering", () => {
		initTheme("dark");
		const message = { role: "assistant", content: [{ type: "text", text: "hello **world**" }] } as never;
		const stock = new AssistantMessageComponent(message, false, getMarkdownTheme());
		const styled = new AssistantMessageComponent(message, false, getMarkdownTheme());
		styled.setAssistantAppearance(createDefaultAppearance().assistantMessage);
		expect(styled.render(60).map(stripAnsi)).toEqual(stock.render(60).map(stripAnsi));
	});

	test("default system-card appearance preserves stock shell", () => {
		initTheme("dark");
		const message = { role: "custom", customType: "notice", content: "hello" } as never;
		const stock = new CustomMessageComponent(message, undefined, getMarkdownTheme());
		const styled = new CustomMessageComponent(
			message,
			undefined,
			getMarkdownTheme(),
			1,
			createDefaultAppearance().systemCards,
		);
		expect(styled.render(40).map(stripAnsi)).toEqual(stock.render(40).map(stripAnsi));
	});

	test("default footer appearance preserves stock rendering", () => {
		initTheme("dark");
		const session = {
			state: { model: undefined, thinkingLevel: "off" },
			sessionManager: {
				getEntries: () => [],
				getCwd: () => "/tmp/project",
				getSessionName: () => undefined,
			},
			getContextUsage: () => ({ percent: 0, contextWindow: 128000 }),
			modelRuntime: { isUsingOAuth: () => false },
		} as never;
		const provider = {
			getGitBranch: () => "main",
			getAvailableProviderCount: () => 1,
			getExtensionStatuses: () => new Map(),
		} as never;
		const stock = new FooterComponent(session, provider);
		const styled = new FooterComponent(session, provider);
		styled.setAppearance(createDefaultAppearance().footer);
		expect(styled.render(80).map(stripAnsi)).toEqual(stock.render(80).map(stripAnsi));
	});

	test("default Bash appearance preserves stock top-bottom geometry and content", () => {
		initTheme("dark");
		const ui = { requestRender: () => {} } as never;
		const stock = new BashExecutionComponent("printf hello", ui);
		stock.appendOutput("hello");
		stock.setComplete(0, false);
		const styled = new BashExecutionComponent("printf hello", ui, false, createDefaultAppearance().bash);
		styled.setBashAppearance(createDefaultAppearance().bash);
		styled.appendOutput("hello");
		styled.setComplete(0, false);
		expect(styled.render(48).map(stripAnsi)).toEqual(stock.render(48).map(stripAnsi));
		stock.dispose();
		styled.dispose();
	});

	test("default tool appearance preserves generic fallback content", () => {
		initTheme("dark");
		const ui = { requestRender: () => {} } as never;
		const result = { content: [{ type: "text", text: "done" }], isError: false };
		const stock = new ToolExecutionComponent(
			"__appearance_baseline__",
			"stock",
			{},
			{ showImages: false },
			undefined,
			ui,
			process.cwd(),
		);
		stock.markExecutionStarted();
		stock.setArgsComplete();
		stock.updateResult(result);
		const styled = new ToolExecutionComponent(
			"__appearance_baseline__",
			"styled",
			{},
			{ showImages: false, toolsAppearance: createDefaultAppearance().tools },
			undefined,
			ui,
			process.cwd(),
		);
		styled.markExecutionStarted();
		styled.setArgsComplete();
		styled.updateResult(result);
		expect(styled.render(48).map(stripAnsi)).toEqual(stock.render(48).map(stripAnsi));
	});

	test("markdown tables use bordered unicode output by default", () => {
		const markdown = new Markdown("| a | b |\n| --- | --- |\n| 1 | 2 |", 0, 0, defaultMarkdownTheme);
		const rendered = markdown.render(30).map(stripAnsi).join("\n");
		expect(rendered).toContain("┌");
		expect(rendered).toContain("│");
		expect(rendered).toContain("└");
	});
});
