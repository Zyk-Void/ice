import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import {
	type BashBackgroundCompletion,
	BashBackgroundRegistry,
	FOREGROUND_MESSAGE_GRACE_MS,
	MAX_FINISHED_SHELLS,
	MAX_OUTPUT_CHARS,
	summarizeShellCommand,
} from "../src/core/tools/bash-background.ts";
import { createBashKillToolDefinition, createBashOutputToolDefinition } from "../src/core/tools/bash-shells.ts";

type BashResult = { content: Array<{ type: string; text?: string }>; details?: { backgroundTaskId?: string } };

function runBash(
	registry: BashBackgroundRegistry,
	command: string,
	onUpdate?: (text: string) => void,
	ctx?: ExtensionContext,
) {
	const tool = createBashToolDefinition(process.cwd(), { background: registry, exposeSessionEnvironment: false });
	return tool.execute(
		"call-1",
		{ command },
		undefined,
		(update) => onUpdate?.(update.content.map((block) => ("text" in block ? block.text : "")).join("")),
		ctx ?? (undefined as never),
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

	it("lets a quick command finish but moves a slow one to the background when the user queues a message", async () => {
		const registry = new BashBackgroundRegistry();
		const ctx = { hasPendingMessages: () => true } as ExtensionContext;
		const quick = await runBash(registry, "echo done", undefined, ctx);
		expect(quick.details?.backgroundTaskId).toBeUndefined();
		expect(text(quick)).toContain("done");

		const startedAt = Date.now();
		const slow = await runBash(registry, "echo started; sleep 30", undefined, ctx);
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(FOREGROUND_MESSAGE_GRACE_MS);
		expect(slow.details?.backgroundTaskId).toBe("bash-1");
		expect(text(slow)).toContain("The user sent a message while this command ran");
		expect(text(slow)).toContain("started");
		expect(registry.get("bash-1")).toMatchObject({ status: "running", origin: "user" });
		registry.dispose();
	}, 15_000);

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

function runBackground(registry: BashBackgroundRegistry, command: string) {
	const tool = createBashToolDefinition(process.cwd(), { background: registry, exposeSessionEnvironment: false });
	return tool.execute(
		"call-bg",
		{ command, run_in_background: true },
		undefined,
		undefined,
		undefined as never,
	) as Promise<BashResult>;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("");
}

describe("summarizeShellCommand", () => {
	it("keeps a one-line command and shortens a script to its first line", () => {
		expect(summarizeShellCommand("npm test")).toBe("npm test");
		expect(summarizeShellCommand("python3 - <<'PY'\nprint(1)\nPY\n")).toBe("python3 - <<'PY' (+2 more lines)");
	});
});

describe("background shells started by the model", () => {
	it("returns at once and lets bash_output read new output, then wait for the exit", async () => {
		const registry = new BashBackgroundRegistry();
		const output = createBashOutputToolDefinition(registry);
		const started = await runBackground(registry, "echo one; sleep 0.4; echo two; sleep 0.4; echo three");
		expect(started.details?.backgroundTaskId).toBe("bash-1");
		expect(text(started)).toContain("bash_output");
		expect(registry.get("bash-1")).toMatchObject({ status: "running", origin: "model" });

		await vi.waitFor(() => expect(registry.get("bash-1")?.output).toContain("one"), { timeout: 5000 });
		const first = text(await output.execute("o1", { id: "bash-1" }, undefined, undefined, undefined as never));
		expect(first).toContain("bash-1: running");
		expect(first).toContain("one");

		const last = text(
			await output.execute("o2", { id: "bash-1", wait_seconds: 10 }, undefined, undefined, undefined as never),
		);
		expect(last).toContain("bash-1: completed");
		// Only output written since the previous check is repeated (the status line names the command).
		const newOutput = last.split("\n\n")[1] ?? "";
		expect(newOutput).not.toContain("one");
		expect(newOutput).toContain("two");
		expect(last).toContain("three");
		expect(registry.runningCount()).toBe(0);
		registry.dispose();
	});

	it("ends a bash_output wait early when the user queues a message", async () => {
		const registry = new BashBackgroundRegistry();
		const output = createBashOutputToolDefinition(registry);
		await runBackground(registry, "sleep 30");
		let pending = false;
		const ctx = { hasPendingMessages: () => pending } as ExtensionContext;
		setTimeout(() => {
			pending = true;
		}, 100);
		const startedAt = Date.now();
		const result = text(await output.execute("o", { id: "bash-1", wait_seconds: 60 }, undefined, undefined, ctx));
		expect(Date.now() - startedAt).toBeLessThan(5000);
		expect(result).toContain("bash-1: running");
		expect(result).toContain("the user sent a message");
		registry.dispose();
	});

	it("lists shells, stops one with bash_kill without a completion, and rejects unknown ids", async () => {
		const registry = new BashBackgroundRegistry();
		const completions: BashBackgroundCompletion[] = [];
		registry.onComplete((completion) => completions.push(completion));
		await runBackground(registry, "sleep 30");
		const output = createBashOutputToolDefinition(registry);
		expect(text(await output.execute("o", {}, undefined, undefined, undefined as never))).toContain(
			"bash-1: running",
		);
		const kill = createBashKillToolDefinition(registry);
		expect(text(await kill.execute("k", { id: "bash-1" }, undefined, undefined, undefined as never))).toBe(
			"Stopped bash-1.",
		);
		expect(registry.get("bash-1")?.status).toBe("killed");
		await expect(kill.execute("k2", { id: "bash-9" }, undefined, undefined, undefined as never)).rejects.toThrow(
			/Unknown background shell/,
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(completions).toEqual([]);
		registry.dispose();
	});

	it("tells the model when the user stops a shell", async () => {
		const registry = new BashBackgroundRegistry();
		const completions: BashBackgroundCompletion[] = [];
		registry.onComplete((completion) => completions.push(completion));
		await runBackground(registry, "sleep 30");
		expect(registry.kill("bash-1", { notify: true })).toBe(true);
		expect(registry.kill("bash-1", { notify: true })).toBe(false);
		expect(completions).toMatchObject([{ taskId: "bash-1", isError: true, text: "Stopped by the user." }]);
		registry.dispose();
	});

	it("keeps writing a user-backgrounded call's later output to its shell", async () => {
		const registry = new BashBackgroundRegistry();
		let seen = "";
		const call = runBash(registry, "echo before; sleep 0.5; echo after", (value) => {
			seen = value;
		});
		await vi.waitFor(() => expect(seen).toContain("before"), { timeout: 5000 });
		registry.releaseAll();
		await call;
		await vi.waitFor(() => expect(registry.get("bash-1")?.status).toBe("completed"), { timeout: 5000 });
		expect(registry.get("bash-1")).toMatchObject({ origin: "user" });
		expect(registry.get("bash-1")?.output).toContain("after");
		const read = await registry.read("bash-1");
		// "before" was already in the tool result the model received.
		expect(read?.newOutput).not.toContain("before");
		expect(read?.newOutput).toContain("after");
		registry.dispose();
	});

	it("retains only the newest output and a bounded number of finished shells", async () => {
		const registry = new BashBackgroundRegistry();
		const id = registry.adopt("gen", Date.now(), () => {}, new Promise(() => {}), { origin: "model" });
		registry.appendOutput(id, "a".repeat(MAX_OUTPUT_CHARS));
		registry.appendOutput(id, "tail");
		const read = await registry.read(id);
		expect(read?.shell.output.endsWith("tail")).toBe(true);
		expect(read?.shell.output.length).toBe(MAX_OUTPUT_CHARS);
		// Nothing unread was dropped beyond the 4 characters the tail pushed out.
		expect(read?.omittedChars).toBe(4);

		for (let index = 0; index < MAX_FINISHED_SHELLS + 5; index++) {
			registry.adopt(`job ${index}`, Date.now(), () => {}, Promise.resolve({ text: "", isError: false }));
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(registry.snapshots().filter((shell) => shell.status !== "running")).toHaveLength(MAX_FINISHED_SHELLS);
		registry.dispose();
	});
});

describe("bash timeouts for background shells", () => {
	it("treats timeout 0 as no timeout and rejects invalid timeouts before starting a shell", async () => {
		const registry = new BashBackgroundRegistry();
		const tool = createBashToolDefinition(process.cwd(), { background: registry, exposeSessionEnvironment: false });
		const run = (timeout: number) =>
			tool.execute(
				"t",
				{ command: "sleep 30", timeout, run_in_background: true },
				undefined,
				undefined,
				undefined as never,
			);
		await expect(run(-1)).rejects.toThrow("Invalid timeout");
		expect(registry.snapshots()).toEqual([]);
		await run(0);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(registry.get("bash-1")?.status).toBe("running");
		registry.dispose();
	});
});
