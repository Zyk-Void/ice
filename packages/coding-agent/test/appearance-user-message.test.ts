import { describe, expect, test } from "vitest";
import { createDefaultAppearance } from "../src/modes/interactive/appearance/appearance-defaults.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("user message appearance", () => {
	test("default appearance matches baseline geometry", () => {
		initTheme("dark");
		const baseline = new UserMessageComponent("hello").render(20);
		const styled = new UserMessageComponent("hello");
		styled.setAppearance(createDefaultAppearance().userMessage);
		expect(styled.render(20).map(stripAnsi)).toEqual(baseline.map(stripAnsi));
	});

	test("default appearance preserves theme foreground color", () => {
		initTheme("dark");
		const baseline = new UserMessageComponent("hello").render(20).join("\n");
		const styled = new UserMessageComponent("hello");
		styled.setAppearance(createDefaultAppearance().userMessage);
		const withAppearance = styled.render(20).join("\n");
		// Theme fg must survive appearance application (regression: identity
		// customColor used to drop it).
		expect(withAppearance).toBe(baseline);
	});

	test("custom colors emit real ANSI sequences", () => {
		initTheme("dark");
		const component = new UserMessageComponent("hello");
		component.setAppearance({
			...createDefaultAppearance().userMessage,
			foreground: { kind: "custom", value: "#ff0000" },
			background: { kind: "custom", value: "#0000ff" },
		});
		const rendered = component.render(30).join("\n");
		expect(rendered).toContain("\x1b[38;2;255;0;0m");
		expect(rendered).toContain("\x1b[48;2;0;0;255m");
	});

	test("border styles render surrounding border rows", () => {
		initTheme("dark");
		const component = new UserMessageComponent("hello");
		component.setAppearance({ ...createDefaultAppearance().userMessage, borderStyle: "single" });
		const lines = component.render(30).map(stripAnsi);
		// Top border, the compact content row, bottom border.
		expect(lines).toHaveLength(3);
		expect(lines.some((line) => line.includes("┌"))).toBe(true);
		expect(lines.some((line) => line.includes("└"))).toBe(true);
	});

	test("format template and padding are honored", () => {
		initTheme("dark");
		const component = new UserMessageComponent("hello");
		component.setAppearance({
			...createDefaultAppearance().userMessage,
			format: "You: {message}",
			paddingX: 0,
			paddingY: 0,
		});
		const rendered = component.render(30).map(stripAnsi).join("\n");
		expect(rendered).toContain("You: hello");
	});
});
