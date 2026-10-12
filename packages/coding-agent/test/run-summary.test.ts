import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	createRunSummary,
	formatRunSummary,
	RUN_SUMMARY_VERBS,
} from "../src/modes/interactive/components/run-summary.ts";
import { setSymbolPreset } from "../src/modes/interactive/theme/symbols.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("run summary line", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => setSymbolPreset("unicode"));

	it("names the run time and the time it finished", () => {
		setSymbolPreset("unicode");
		const endedAt = new Date(2026, 9, 11, 0, 53);
		const time = endedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
		expect(formatRunSummary(197_000, endedAt, "Worked")).toBe(`✻ Worked for 3m 17s · done ${time}`);
		expect(formatRunSummary(42_000, endedAt, "Sautéed")).toBe(`✻ Sautéed for 42s · done ${time}`);
		setSymbolPreset("ascii");
		expect(formatRunSummary(3_900_000, endedAt, "Brewed")).toBe(`* Brewed for 1h 5m - done ${time}`);
	});

	it("picks a verb and renders dim", () => {
		const line = createRunSummary(5_000, new Date(), () => 0.99).render(80)[0]!;
		expect(stripAnsi(line)).toContain(`${RUN_SUMMARY_VERBS.at(-1)} for 5s`);
		expect(line).not.toBe(stripAnsi(line));
	});
});
