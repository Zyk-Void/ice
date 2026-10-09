import { visibleWidth } from "@zykairotis/ice-tui";
import { beforeAll, describe, expect, test } from "vitest";
import {
	middleTruncate,
	SessionHeaderComponent,
	type SessionHeaderData,
} from "../src/modes/interactive/components/session-header.ts";
import { getSymbolTable, resolveDefaultSymbolPreset, setSymbolPreset } from "../src/modes/interactive/theme/symbols.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const strip = (lines: string[]) => lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));

function data(overrides: Partial<SessionHeaderData> = {}): SessionHeaderData {
	return {
		appName: "ice",
		version: "1.2.3",
		model: "gpt-test",
		thinking: "high",
		cwd: "~/work/project",
		mode: "build",
		capabilities: ["bash", "external"],
		loaded: "2 skills",
		hint: "ctrl+o details",
		expandedHelp: "line one\nline two",
		...overrides,
	};
}

describe("SessionHeaderComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setSymbolPreset("unicode");
	});

	test("renders a compact three-line banner beside the penguin", () => {
		const lines = strip(new SessionHeaderComponent(() => data()).render(120));
		expect(lines).toEqual([
			" ▄███▄   ICE v1.2.3",
			"█▀█▀█▀█  gpt-test · high · build · bash · external",
			" ▀▄▄▄▀   ~/work/project · 2 skills",
			"ctrl+o details",
		]);
	});

	test("uses the ASCII penguin with the ascii symbol preset", () => {
		setSymbolPreset("ascii");
		const lines = strip(new SessionHeaderComponent(() => data()).render(120));
		setSymbolPreset("unicode");
		expect(lines[1]).toBe("//\\\\  gpt-test - high - build - bash - external");
		for (const line of lines) expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
	});

	test("drops loaded resources before truncating the directory and never exceeds the width", () => {
		const longCwd = `~/${"very-long-directory/".repeat(8)}leaf`;
		for (const width of [30, 44, 60, 120]) {
			const lines = new SessionHeaderComponent(() => data({ cwd: longCwd })).render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const location = strip(lines)[2];
			expect(location).toContain("…");
			expect(location).toContain("leaf");
			expect(location).not.toContain("skills");
		}
	});

	test("drops the penguin on narrow terminals and appends help when expanded", () => {
		const header = new SessionHeaderComponent(() => data({ mode: undefined, capabilities: [], loaded: "" }), true);
		const lines = strip(header.render(30));
		expect(lines.slice(0, 3)).toEqual(["ICE v1.2.3", "gpt-test · high", "~/work/project"]);
		expect(lines.slice(-2)).toEqual([" line one", " line two"]);
	});
});

describe("symbols", () => {
	test("middleTruncate keeps both ends", () => {
		setSymbolPreset("unicode");
		expect(middleTruncate("abcdefghij", 7)).toBe("abc…hij");
		expect(middleTruncate("short", 10)).toBe("short");
	});

	test("ascii preset is plain 7-bit and every glyph is one cell wide", () => {
		for (const glyph of Object.values(getSymbolTable("ascii"))) {
			expect(/^[\x20-\x7e]+$/.test(glyph)).toBe(true);
		}
		for (const glyph of Object.values(getSymbolTable("unicode"))) {
			expect(visibleWidth(glyph)).toBe(1);
		}
	});

	test("resolves ascii for dumb terminals and non-UTF-8 locales", () => {
		expect(resolveDefaultSymbolPreset({ TERM: "dumb" })).toBe("ascii");
		expect(resolveDefaultSymbolPreset({ LANG: "C" })).toBe("ascii");
		expect(resolveDefaultSymbolPreset({ LANG: "en_US.UTF-8" })).toBe("unicode");
		expect(resolveDefaultSymbolPreset({})).toBe("unicode");
	});
});
