import { setKeybindings, visibleWidth } from "@zykairotis/ice-tui";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type BashBackgroundCompletion, BashBackgroundRegistry } from "../src/core/tools/bash-background.ts";
import { ShellsPanelComponent } from "../src/modes/interactive/components/shells-panel.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ESC = "\x1b";
const ENTER = "\r";

const strip = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

function shellRegistry(now: number) {
	const registry = new BashBackgroundRegistry();
	const aborts = new Map<string, ReturnType<typeof vi.fn>>();
	const start = (
		command: string,
		startedAt: number,
		settled: Promise<{ text: string; isError: boolean }> = new Promise(() => {}),
	) => {
		const abort = vi.fn();
		const id = registry.adopt(command, startedAt, abort, settled, { origin: "model" });
		aborts.set(id, abort);
		return id;
	};
	const dev = start("npm run dev", now - 65_000);
	registry.appendOutput(dev, "\x1b[32mready\x1b[0m on http://localhost:5173\nprogress 10%\rprogress 100%\n");
	const test = start("./test.sh", now - 9_000);
	return { registry, aborts, dev, test };
}

describe("ShellsPanelComponent", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("lists running shells with runtimes and opens details with a live output tail", () => {
		const now = Date.parse("2026-10-10T10:00:00Z");
		const { registry, dev } = shellRegistry(now);
		const close = vi.fn();
		const panel = new ShellsPanelComponent(registry, new KeybindingsManager(), close, {
			now: () => now,
			tick: false,
		});
		const list = strip(panel.render(100));
		expect(list).toContain("Shells  2 running");
		// The newest running shell starts selected.
		expect(list.find((line) => line.startsWith("›"))).toContain("./test.sh");
		expect(
			list.some((line) => line.includes("bash-1") && line.includes("1m 5s") && line.includes("npm run dev")),
		).toBe(true);

		panel.handleInput(UP);
		panel.handleInput(ENTER);
		const details = strip(panel.render(100));
		expect(details[1]).toBe(`Shell details  ${dev}`);
		expect(details).toContain("Status:   running · started by the agent");
		expect(details).toContain("Runtime:  1m 5s");
		expect(details).toContain("Command:  npm run dev");
		// Escape sequences are stripped and a carriage-return redraw keeps its final state.
		expect(details).toContain("  ready on http://localhost:5173");
		expect(details).toContain("  progress 100%");
		expect(details.join("\n")).not.toContain("progress 10%");

		registry.appendOutput(dev, "GET / 200\n");
		expect(strip(panel.render(100))).toContain("  GET / 200");

		panel.handleInput(LEFT);
		expect(strip(panel.render(100))[1]).toBe("Shells  2 running");
		panel.handleInput(ESC);
		expect(close).toHaveBeenCalledOnce();
		panel.dispose();
		registry.dispose();
	});

	test("stops the selected shell, telling the model, and follows a shell in the foreground", () => {
		const now = Date.now();
		const { registry, aborts, dev, test: testId } = shellRegistry(now);
		const completions: BashBackgroundCompletion[] = [];
		registry.onComplete((completion) => completions.push(completion));
		const panel = new ShellsPanelComponent(registry, new KeybindingsManager(), () => {}, {
			now: () => now,
			tick: false,
		});

		panel.handleInput("f");
		const follow = strip(panel.render(100));
		expect(follow[1]).toContain(`Following ${testId}  live  ./test.sh`);
		expect(follow).toContain("No output yet.");

		panel.handleInput("x");
		expect(aborts.get(testId)).toHaveBeenCalledOnce();
		expect(completions).toMatchObject([{ taskId: testId, text: "Stopped by the user.", stoppedByUser: true }]);
		const stopped = strip(panel.render(100));
		expect(stopped).toContain(`Stopped ${testId}.`);
		// A stopped shell has no stop hint.
		expect(stopped.at(-1)).not.toContain("x stop");

		// The stopped shell stays in view until the user goes back to the list, which only shows running shells.
		expect(stopped[1]).toContain(`Following ${testId}  killed`);
		panel.handleInput(LEFT);
		panel.handleInput(LEFT);
		const list = strip(panel.render(100));
		expect(list[1]).toBe("Shells  1 running");
		expect(list.join("\n")).not.toContain(testId);
		panel.handleInput(DOWN);
		panel.handleInput(RIGHT);
		expect(strip(panel.render(100))[1]).toBe(`Shell details  ${dev}`);
		panel.dispose();
		registry.dispose();
	});

	test("opens straight on the details of a single shell and stays within the width", () => {
		const registry = new BashBackgroundRegistry();
		registry.adopt(`printf '%s' ${"x".repeat(300)}`, Date.now(), () => {}, new Promise(() => {}));
		const panel = new ShellsPanelComponent(registry, new KeybindingsManager(), () => {}, { tick: false });
		const lines = panel.render(40);
		expect(strip(lines)[1]).toBe("Shell details  bash-1");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		panel.dispose();
		registry.dispose();
	});

	test("leaves finished shells out of the list", async () => {
		const registry = new BashBackgroundRegistry();
		const id = registry.adopt("true", Date.now(), () => {}, Promise.resolve({ text: "done", isError: false }));
		await vi.waitFor(() => expect(registry.get(id)?.status).toBe("completed"));
		const panel = new ShellsPanelComponent(registry, new KeybindingsManager(), () => {}, { tick: false });
		const lines = strip(panel.render(100));
		expect(lines[1]).toBe("Shells  no running shells");
		expect(lines.join("\n")).not.toContain(id);
		panel.dispose();
		registry.dispose();
	});

	test("repaints when shell output arrives", async () => {
		const registry = new BashBackgroundRegistry();
		const id = registry.adopt("tail -f log", Date.now(), () => {}, new Promise(() => {}));
		const requestRender = vi.fn();
		const panel = new ShellsPanelComponent(registry, new KeybindingsManager(), () => {}, {
			requestRender,
			tick: false,
		});
		registry.appendOutput(id, "line\n");
		await vi.waitFor(() => expect(requestRender).toHaveBeenCalled(), { timeout: 1000 });
		panel.dispose();
		registry.dispose();
	});
});
