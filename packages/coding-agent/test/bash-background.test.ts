import { describe, expect, it, vi } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { type BashBackgroundCompletion, BashBackgroundRegistry } from "../src/core/tools/bash-background.ts";

type BashResult = { content: Array<{ type: string; text?: string }>; details?: { backgroundTaskId?: string } };

function runBash(registry: BashBackgroundRegistry, command: string, onUpdate?: (text: string) => void) {
	const tool = createBashToolDefinition(process.cwd(), { background: registry, exposeSessionEnvironment: false });
	return tool.execute(
		"call-1",
		{ command },
		undefined,
		(update) => onUpdate?.(update.content.map((block) => ("text" in block ? block.text : "")).join("")),
		undefined as never,
	) as Promise<BashResult>;
}

describe("bash background release", () => {
	it("returns output so far, keeps the process running, and reports the final output once", async () => {
		const registry = new BashBackgroundRegistry();
		const completions: BashBackgroundCompletion[] = [];
		registry.onComplete((completion) => completions.push(completion));
		let seen = "";
		const call = runBash(registry, "echo first; sleep 1; echo second", (text) => {
			seen = text;
		});

		await vi.waitFor(() => expect(seen).toContain("first"), { timeout: 5000 });
		expect(registry.hasReleasable()).toBe(true);
		expect(registry.releaseAll()).toBe(1);

		const result = await call;
		expect(result.details?.backgroundTaskId).toBe("bash-1");
		expect(result.content[0]?.text).toContain("first");
		expect(result.content[0]?.text).not.toContain("second");
		expect(registry.hasReleasable()).toBe(false);
		expect(registry.runningCount()).toBe(1);
		expect(registry.list()).toMatchObject([{ taskId: "bash-1", command: "echo first; sleep 1; echo second" }]);

		await vi.waitFor(() => expect(completions).toHaveLength(1), { timeout: 5000 });
		expect(completions[0]).toMatchObject({ taskId: "bash-1", isError: false });
		expect(completions[0]!.text).toContain("second");
		expect(registry.runningCount()).toBe(0);
	});

	it("leaves unreleased calls in the foreground and reports failures normally", async () => {
		const registry = new BashBackgroundRegistry();
		await expect(runBash(registry, "echo ok")).resolves.toMatchObject({ content: [{ text: "ok\n" }] });
		await expect(runBash(registry, "exit 3")).rejects.toThrow("Command exited with code 3");
		expect(registry.hasReleasable()).toBe(false);
	});

	it("kills background processes on dispose without emitting completions", async () => {
		const registry = new BashBackgroundRegistry();
		const listener = vi.fn();
		registry.onComplete(listener);
		let started = false;
		const call = runBash(registry, "echo go; sleep 30", (text) => {
			if (text.includes("go")) started = true;
		});
		await vi.waitFor(() => expect(started).toBe(true), { timeout: 5000 });
		registry.releaseAll();
		await call;
		registry.dispose();
		expect(registry.runningCount()).toBe(0);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(listener).not.toHaveBeenCalled();
	});
});
