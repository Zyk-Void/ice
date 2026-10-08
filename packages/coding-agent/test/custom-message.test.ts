import { Text } from "@zykairotis/ice-tui";
import { describe, expect, test } from "vitest";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("CustomMessageComponent", () => {
	test("provides output padding to custom renderers and updates it", () => {
		initTheme("dark");
		const optionsSeen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			optionsSeen.push(options);
			return new Text("custom", options.outputPad, 0);
		};
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "custom",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, renderer, undefined, 1);

		expect(optionsSeen).toEqual([{ expanded: false, outputPad: 1 }]);
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith(" custom")),
		).toBe(true);

		component.setOutputPad(0);

		expect(optionsSeen.at(-1)).toEqual({ expanded: false, outputPad: 0 });
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("custom")),
		).toBe(true);
	});

	test("collapses long subagent_completed output to head and tail until expanded", () => {
		initTheme("dark");
		const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		const message: CustomMessage = {
			role: "custom",
			customType: "subagent_completed",
			content: body,
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message);
		const collapsed = component.render(60).map(stripAnsi).join("\n");

		expect(collapsed).toContain("line 1");
		expect(collapsed).toContain("line 20");
		expect(collapsed).not.toContain("line 10");
		expect(collapsed).toContain("13 more lines");

		component.setExpanded(true);
		const expanded = component.render(60).map(stripAnsi).join("\n");

		expect(expanded).toContain("line 10");
		expect(expanded).not.toContain("more lines");
	});
});
