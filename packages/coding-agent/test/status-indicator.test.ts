import type { TUI } from "@zykairotis/ice-tui";
import { visibleWidth } from "@zykairotis/ice-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	formatElapsed,
	IdleStatus,
	RetryStatusIndicator,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { setSymbolPreset } from "../src/modes/interactive/theme/symbols.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps idle status at the same height as status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});

	it("formats elapsed time like Codex", () => {
		expect([0, 42_000, 78_000, 3_720_000].map(formatElapsed)).toEqual(["0s", "42s", "1m 18s", "1h 02m"]);
	});

	it("appends elapsed, tokens, thinking, and interrupt hint, with a detail row", () => {
		initTheme("dark");
		setSymbolPreset("unicode");
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Frosting...", { frames: ["*"] }, undefined, () => 78_000);
		indicator.setDetails(() => ({
			startedAt: 0,
			outputTokens: 6600,
			outputTokensEstimated: true,
			thinking: "high",
			detail: "Running $ npm test",
		}));

		const lines = indicator.render(120).map((line) => stripAnsi(line).trimEnd());
		expect(lines).toEqual([
			"",
			" * Frosting... (1m 18s · ↓ ~6.6k tokens · thinking high)",
			"   ⎿ Running $ npm test",
		]);
		for (const line of indicator.render(30)) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		indicator.dispose();
	});

	it("animates custom heartbeat frames and stops repainting after disposal", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Working...", {
			frames: ["▁", "▂", "▅", "█", "▁"],
			intervalMs: 100,
		});
		expect(stripAnsi(indicator.render(40).join("\n"))).toContain("▁ Working...");
		vi.advanceTimersByTime(300);
		expect(stripAnsi(indicator.render(40).join("\n"))).toContain("█ Working...");
		indicator.dispose();
		const count = requestRender.mock.calls.length;
		vi.advanceTimersByTime(2000);
		expect(requestRender).toHaveBeenCalledTimes(count);
	});

	it("renders only the label without a details provider", () => {
		initTheme("dark");
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Working...", { frames: ["*"] });
		expect(indicator.render(40).map((line) => stripAnsi(line).trimEnd())).toEqual(["", " * Working..."]);
		indicator.dispose();
	});
});
