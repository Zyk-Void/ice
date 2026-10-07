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

	test("renders the wordmark beside model, directory, mode, and loaded resources", () => {
		const lines = strip(new SessionHeaderComponent(() => data()).render(120));
		expect(lines[0]).toMatch(/^╭─+╮$/);
		expect(lines[1]).toMatch(/^│ ██╗ ██████╗███████╗ {3}❄ ICE {2}v1\.2\.3 +│$/);
		expect(lines[3]).toMatch(/^│ ██║██║ {5}█████╗ {5}model {6}gpt-test · high +\/model │$/);
		expect(lines[4]).toContain("directory  ~/work/project");
		expect(lines[5]).toContain("mode       build · bash · external");
		expect(lines[6]).toContain("loaded     2 skills");
		expect(lines[7]).toMatch(/^╰─+╯$/);
		expect(lines[8]).toBe("  ctrl+o details");
		expect(new Set(lines.slice(0, 8).map((line) => visibleWidth(line))).size).toBe(1);
	});

	test("uses the ASCII wordmark with the ascii symbol preset", () => {
		setSymbolPreset("ascii");
		const lines = strip(new SessionHeaderComponent(() => data()).render(120));
		setSymbolPreset("unicode");
		expect(lines[0]).toMatch(/^\+-+\+$/);
		expect(lines[2]).toContain("|_ _/ ___| ____|");
		for (const line of lines) expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
	});

	test("drops the wordmark when narrow and never exceeds the terminal width", () => {
		const longCwd = `~/${"very-long-directory/".repeat(8)}leaf`;
		for (const width of [44, 60, 120]) {
			const lines = new SessionHeaderComponent(() => data({ cwd: longCwd })).render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(strip(lines).some((line) => line.includes("…") && line.includes("leaf"))).toBe(true);
		}
		expect(strip(new SessionHeaderComponent(() => data()).render(50)).join("\n")).not.toContain("██");
	});

	test("falls back to plain rows on narrow terminals and appends help when expanded", () => {
		const header = new SessionHeaderComponent(() => data({ mode: undefined, capabilities: [], loaded: "" }), true);
		const lines = strip(header.render(30));
		expect(lines[0]).toBe("❄ ICE  v1.2.3");
		expect(lines.some((line) => line.startsWith("╭"))).toBe(false);
		expect(lines.some((line) => line.startsWith("mode ") || line.startsWith("loaded "))).toBe(false);
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
