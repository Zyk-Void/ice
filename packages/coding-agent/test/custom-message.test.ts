import { Text } from "@zykairotis/ice-tui";
import { describe, expect, test } from "vitest";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { setSymbolPreset } from "../src/modes/interactive/theme/symbols.ts";
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

	test.each(["subagent_completed"])("collapses long %s output to head and tail until expanded", (customType) => {
		initTheme("dark");
		const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		const message: CustomMessage = {
			role: "custom",
			customType,
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

	test("renders a background shell completion as one plain line that expands to its output", () => {
		initTheme("dark");
		setSymbolPreset("unicode");
		const message: CustomMessage = {
			role: "custom",
			customType: "bash_background_completed",
			content: "Background command bash-3 finished: systemctl restart xtts\n\nRestarted.\nlistening on 8020",
			display: true,
			details: {
				taskId: "bash-3",
				command: "systemctl restart xtts",
				description: "Restart XTTS service with patched server",
				isError: false,
				exitCode: 0,
				durationMs: 12_000,
			},
			timestamp: 1,
		};
		const component = new CustomMessageComponent(message);
		expect(component.getToggleId()).toBe("bash-completed:bash-3:1");
		const collapsed = component
			.render(100)
			.map((line) => stripAnsi(line).trimEnd())
			.filter(Boolean);
		expect(collapsed).toEqual([
			'✓ Background command "Restart XTTS service with patched server" completed (exit code 0) · 12s',
		]);
		// No card background: only the plain status line is styled.
		expect(component.render(100).join("")).not.toContain("\x1b[48");

		component.setExpanded(true);
		const expanded = component.render(100).map(stripAnsi).join("\n");
		expect(expanded).toContain("listening on 8020");

		const failed = new CustomMessageComponent({
			...message,
			details: { taskId: "bash-4", command: "npm test", isError: true, exitCode: 1, durationMs: 3_000 },
		});
		expect(failed.render(100).map(stripAnsi).join("")).toContain(
			'Background command "npm test" failed (exit code 1)',
		);
	});
});
