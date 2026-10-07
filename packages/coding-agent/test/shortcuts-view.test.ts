import { visibleWidth } from "@zykairotis/ice-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ShortcutsViewComponent } from "../src/modes/interactive/components/shortcuts-view.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const sections = [
	{
		title: "Compose",
		rows: [
			{ key: "/", label: "Commands" },
			{ key: "!", label: "Shell command" },
		],
	},
	{ title: "Session", rows: [{ key: "Escape", label: "Interrupt" }] },
];

describe("ShortcutsViewComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders sections side by side when they fit", () => {
		const view = new ShortcutsViewComponent(sections, "any key closes", () => {});
		expect(view.render(80).map((line) => stripAnsi(line))).toEqual([
			"",
			"  Keyboard shortcuts",
			"",
			"  Compose            Session",
			"  /  Commands        Escape  Interrupt",
			"  !  Shell command",
			"",
			"  any key closes",
		]);
	});

	it("stacks sections on narrow terminals and stays within width", () => {
		const lines = new ShortcutsViewComponent(sections, "any key closes", () => {}).render(20);
		expect(lines.map((line) => stripAnsi(line))).toContain("  Session");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
	});

	it("closes on any key", () => {
		const onClose = vi.fn();
		new ShortcutsViewComponent(sections, "", onClose).handleInput("x");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
