import { visibleWidth } from "@zykairotis/ice-tui";
import { describe, expect, test } from "vitest";
import { createDefaultAppearance } from "../src/modes/interactive/appearance/appearance-defaults.ts";
import { resolveAppearanceColorFn } from "../src/modes/interactive/appearance/appearance-resolve.ts";
import { validateAppearance } from "../src/modes/interactive/appearance/appearance-validate.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getThemeByName, initTheme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderWith(appearance: ReturnType<typeof createDefaultAppearance>["userMessage"], width: number): string[] {
	initTheme("dark");
	const component = new UserMessageComponent("hello");
	component.setAppearance(appearance);
	return component.render(width);
}

describe("user message layout width invariant (F0)", () => {
	const styles = [
		"none",
		"single",
		"double",
		"round",
		"bold",
		"classic",
		"single-double",
		"double-single",
		"top-bottom-single",
		"top-bottom-double",
		"top-bottom-bold",
	] as const;
	const widths = [1, 2, 3, 10, 30, 80];
	for (const style of styles) {
		for (const width of widths) {
			test(`${style} fits within requested width ${width}`, () => {
				const lines = renderWith({ ...createDefaultAppearance().userMessage, borderStyle: style }, width);
				expect(lines.length).toBeGreaterThan(0);
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			});
		}
	}

	test("default user-message padding keeps text centered in its background row", () => {
		const appearance = createDefaultAppearance().userMessage;
		expect(appearance.paddingY).toBe(0);
		const centered = renderWith(appearance, 30);
		const tight = renderWith({ ...appearance, paddingY: 0 }, 30);
		expect(centered).toEqual(tight);
		const padded = renderWith({ ...appearance, paddingY: 1 }, 30);
		expect(padded).toHaveLength(centered.length + 2);
	});

	test("padding variants preserve the width invariant", () => {
		for (const paddingX of [0, 1, 2, 4]) {
			const lines = renderWith(
				{ ...createDefaultAppearance().userMessage, borderStyle: "single", paddingX, paddingY: 2 },
				30,
			);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(30);
			}
		}
	});

	test("fit-to-content renders compact width without overflow", () => {
		const full = renderWith(
			{ ...createDefaultAppearance().userMessage, borderStyle: "single", fitToContent: false },
			80,
		);
		const fit = renderWith(
			{ ...createDefaultAppearance().userMessage, borderStyle: "single", fitToContent: true },
			80,
		);
		const fullWidth = Math.max(...full.map((line) => visibleWidth(line)));
		const fitWidth = Math.max(...fit.map((line) => visibleWidth(line)));
		expect(fullWidth).toBe(80);
		expect(fitWidth).toBeLessThan(80);
		expect(fitWidth).toBeGreaterThan(0);
		for (const line of fit) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});

	test("styled/ANSI content is truncated by visible columns, not raw slicing", () => {
		initTheme("dark");
		const component = new UserMessageComponent("hello world, this is a long message with emoji 🎉 and CJK 汉字");
		component.setAppearance({
			...createDefaultAppearance().userMessage,
			borderStyle: "single",
			styles: ["bold"],
		});
		for (const width of [10, 20, 30]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});

describe("shared appearance color resolver (F1)", () => {
	test("theme token accent renders through accent, not userMessageText", () => {
		initTheme("dark");
		const accent = resolveAppearanceColorFn({ kind: "theme", token: "accent" }, "fg")("x");
		const userMessageText = resolveAppearanceColorFn({ kind: "theme", token: "userMessageText" }, "fg")("x");
		expect(accent).not.toBe(userMessageText);
		expect(accent).toBe(getThemeByName("dark")?.fg("accent", "x"));
	});

	test("theme references stay live across theme switches", () => {
		initTheme("dark");
		const darkAccent = resolveAppearanceColorFn({ kind: "theme", token: "accent" }, "fg")("x");
		initTheme("light");
		const lightAccent = resolveAppearanceColorFn({ kind: "theme", token: "accent" }, "fg")("x");
		expect(lightAccent).toBe(getThemeByName("light")?.fg("accent", "x"));
		expect(lightAccent).not.toBe(darkAccent);
	});

	test("background role resolves bg tokens and rejects fg tokens", () => {
		initTheme("dark");
		const bg = resolveAppearanceColorFn({ kind: "theme", token: "userMessageBg" }, "bg")("x");
		expect(bg).toBe(getThemeByName("dark")?.bg("userMessageBg", "x"));
		const result = validateAppearance({
			...createDefaultAppearance(),
			userMessage: { ...createDefaultAppearance().userMessage, background: { kind: "theme", token: "accent" } },
		});
		expect(result.valid).toBe(false);
	});

	test("terminal-default and none pass through distinctly", () => {
		expect(resolveAppearanceColorFn({ kind: "terminal-default" }, "fg")("x")).toContain("\x1b[39m");
		expect(resolveAppearanceColorFn({ kind: "terminal-default" }, "bg")("x")).toContain("\x1b[49m");
		expect(resolveAppearanceColorFn({ kind: "none" }, "fg")("x")).toBe("x");
	});

	test("invalid tokens and custom syntax are rejected", () => {
		const bad = validateAppearance({
			...createDefaultAppearance(),
			userMessage: {
				...createDefaultAppearance().userMessage,
				foreground: { kind: "theme", token: "nope-not-a-token" },
			},
		});
		expect(bad.valid).toBe(false);
		expect(bad.appearance.userMessage.foreground).toEqual({ kind: "theme", token: "userMessageText" });
	});

	test("user message honors an exact non-default semantic token", () => {
		initTheme("dark");
		const component = new UserMessageComponent("hello");
		component.setAppearance({
			...createDefaultAppearance().userMessage,
			foreground: { kind: "theme", token: "accent" },
		});
		const rendered = component.render(30).join("\n");
		expect(rendered).toContain(getThemeByName("dark")?.fg("accent", "hello") ?? "accent");
		expect(stripAnsi(rendered)).toContain("hello");
	});
});
