import { Text, type TUI, visibleWidth } from "@zykairotis/ice-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.ts";
import {
	classifyShellCommand,
	describeExploration,
	summarizeToolResult,
} from "../src/modes/interactive/components/tool-summary.ts";
import { setSymbolPreset } from "../src/modes/interactive/theme/symbols.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const fakeTui = { requestRender: () => {} } as unknown as TUI;

/** Custom tool whose collapsed renderer emits one line per result line, prefixed "r:". */
function tool(name: string): ToolDefinition<ReturnType<typeof Type.Any>, unknown> {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Any(),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		renderCall: (args) => new Text(`${name} ${(args as { label?: string }).label ?? ""}`.trim(), 0, 0),
		renderResult: (result, options) => {
			const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
			const lines = text.split("\n").map((line) => `r:${line}`);
			return new Text(`\n${options.expanded ? `full\n${lines.join("\n")}` : lines.join("\n")}\n`, 0, 0);
		},
	};
}

function row(name: string, args: Record<string, unknown>, definition = tool(name)): ToolExecutionComponent {
	return new ToolExecutionComponent(
		name,
		`${name}-${JSON.stringify(args)}`,
		args,
		{ compact: true },
		definition,
		fakeTui,
		process.cwd(),
	);
}

/** Bash rows use the built-in bash definition, which compact mode titles as "Ran <command>". */
const bash = (command: string) => row("bash", { command }, undefined as never);

const text = (lines: string[]) => lines.map((line) => stripAnsi(line).trimEnd());
const result = (output: string, isError = false) => ({ content: [{ type: "text", text: output }], isError });

describe("tool summaries", () => {
	test("describes exploration calls and leaves everything else ungrouped", () => {
		expect(describeExploration("read", { path: "a.ts", offset: 10, limit: 5 })).toEqual({
			verb: "Read",
			target: "a.ts:10-14",
		});
		expect(describeExploration("grep", { pattern: "foo", path: "src" })).toEqual({
			verb: "Search",
			target: "foo in src",
		});
		expect(describeExploration("ls", {})).toEqual({ verb: "List", target: "." });
		expect(describeExploration("bash", { command: "cat package.json" })).toEqual({
			verb: "Read",
			target: "cat package.json",
		});
		expect(describeExploration("bash", { command: "npm test" })).toBeUndefined();
		expect(describeExploration("edit", { path: "a.ts" })).toBeUndefined();
		expect(describeExploration("mcp__x__y", {})).toBeUndefined();
	});

	test("classifies read-only shell commands and keeps everything else as shell", () => {
		const cases: Array<[string, ReturnType<typeof classifyShellCommand>]> = [
			["cat package.json", "read"],
			["sed -n 1,40p src/a.ts | head -5", "read"],
			["git diff --stat", "read"],
			["cd src && rg foo", "search"],
			['find . -name "*.ts"', "search"],
			["ls -la", "list"],
			["sed -i s/a/b/ x.ts", "shell"],
			["cat a > b", "shell"],
			["echo $(whoami)", "shell"],
			["find . -name x -delete", "shell"],
			["npm test", "shell"],
			["git push", "shell"],
		];
		for (const [command, kind] of cases) expect([command, classifyShellCommand(command)]).toEqual([command, kind]);
	});

	test("summarizes empty, backgrounded, and edited results", () => {
		expect(summarizeToolResult("bash", result(""))).toBe("no output");
		expect(summarizeToolResult("bash", { ...result("partial"), details: { backgroundTaskId: "bash-2" } })).toBe(
			"moved to background as bash-2",
		);
		expect(summarizeToolResult("edit", { ...result("ok"), details: { diff: " 1 a\n-2 b\n+2 c\n+3 d" } })).toBe(
			"+2 -1",
		);
	});
});

describe("compact tool rows", () => {
	beforeAll(() => {
		initTheme("dark");
		setSymbolPreset("unicode");
	});

	test("shell rows read 'Ran <command>' with the first output lines and a more hint", () => {
		const component = bash("ls src && echo ok");
		component.updateResult(result("one\ntwo\nthree\nfour\nfive"));
		expect(text(component.render(80))).toEqual([
			"",
			"✓ Ran ls src && echo ok",
			"  ⎿ one",
			"    two",
			"    three",
			"    … +2 lines ( to expand)",
		]);
	});

	test("compact shell and edit verbs use the tool title color", () => {
		const shell = bash("echo ok");
		shell.updateResult(result("ok"));
		expect(shell.render(60)[1]).toContain(theme.fg("toolTitle", theme.bold("Ran")));
		const edit = row("edit", { path: "a.ts", edits: [] }, undefined as never);
		edit.updateResult(result("ok"));
		expect(edit.render(60)[1]).toContain(theme.fg("toolTitle", theme.bold("Edited")));
	});

	test("running shell rows show 'Running' and the live tail", () => {
		const running = bash("npm run build");
		running.markExecutionStarted();
		running.updateResult(result("1\n2\n3\n4\n5"), true);
		expect(text(running.render(60))).toEqual([
			"",
			"› Running npm run build",
			"  ⎿ … +2 lines",
			"    3",
			"    4",
			"    5",
		]);
	});

	test("failed rows show the first lines in the error color", () => {
		const failed = bash("npm test");
		failed.updateResult(result("e1\ne2\ne3\ne4\ne5\ne6\ne7", true));
		expect(text(failed.render(60)).slice(2)).toEqual([
			"  ⎿ e1",
			"    e2",
			"    e3",
			"    e4",
			"    e5",
			"    … +2 lines ( to expand)",
		]);
	});

	test("other tools show their own collapsed renderer preview (diffs, statuses)", () => {
		const component = row("manage_subagent", { label: "wait" });
		component.updateResult(result("state: running\nchecks: 2"));
		expect(text(component.render(60))).toEqual([
			"",
			"✓ manage_subagent wait",
			"  ⎿ r:state: running",
			"    r:checks: 2",
		]);

		component.setExpanded(true);
		expect(text(component.render(60))).toEqual([
			"",
			"✓ manage_subagent wait",
			"  ⎿ full",
			"    r:state: running",
			"    r:checks: 2",
		]);
	});

	test("edit rows show the path, change counts, and the diff", () => {
		const edit = row("edit", { path: "src/demo.txt", edits: [] }, undefined as never);
		edit.updateResult({
			content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/demo.txt." }],
			details: { diff: " 1 alpha\n-2 beta\n+2 BETA\n 3 gamma" },
			isError: false,
		});
		const lines = text(edit.render(60));
		expect(lines[1]).toBe("✓ Edited src/demo.txt (+1 -1)");
		expect(lines[2]).toMatch(/^ {2}⎿ /);
		expect(lines.slice(2).join("\n")).toContain("beta");
		expect(lines.slice(2).join("\n")).toContain("BETA");
	});

	test("markers distinguish pending, success, and error without relying on color", () => {
		const component = bash("echo ok");
		expect(stripAnsi(component.renderBullet())).toBe("›");
		component.updateResult(result("ok"));
		expect(stripAnsi(component.renderBullet())).toBe("✓");
		component.updateResult(result("failed", true));
		expect(stripAnsi(component.renderBullet())).toBe("✗");
		setSymbolPreset("ascii");
		expect(stripAnsi(component.renderBullet())).toBe("x");
		component.updateResult(result("ok"));
		expect(stripAnsi(component.renderBullet())).toBe("+");
		component.updateResult(result("running"), true);
		expect(stripAnsi(component.renderBullet())).toBe(">");
		setSymbolPreset("unicode");
	});

	test("caps collapsed commands on wide terminals and reveals the full command when expanded", () => {
		const command = `echo ${"argument-".repeat(40)}\necho second-line`;
		const component = bash(command);
		component.updateResult(result("output"));
		const collapsed = component.render(240);
		for (const line of collapsed) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		expect(stripAnsi(collapsed[1]!)).toContain("…");
		component.setExpanded(true);
		const expanded = text(component.render(80));
		expect(expanded.join("\n")).toContain("second-line");
		expect(expanded.join("").replace(/\s/g, "")).toContain(command.replace(/\s/g, ""));
		for (const line of component.render(80)) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	test("rows never exceed the render width", () => {
		const component = bash("x".repeat(200));
		component.updateResult(result("y".repeat(300)), true);
		for (const line of component.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});
});

describe("ToolGroupComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setSymbolPreset("unicode");
	});

	test("lists each exploration call under an Explored header", () => {
		const group = new ToolGroupComponent(false);
		const read = row("read", { path: "AGENTS.md" });
		const search = row("grep", { pattern: "createWindow", path: "src" });
		const list = bash("ls main");
		for (const member of [read, search, list]) group.add(member);
		search.updateResult(result("x"));
		list.updateResult(result("y"));
		read.updateResult(result("z"), true);

		expect(text(group.render(60))).toEqual([
			"",
			"› Exploring",
			"  ⎿ Read AGENTS.md",
			"    Search createWindow in src",
			"    List ls main",
		]);

		read.updateResult(result("z"));
		expect(text(group.render(60))[1]).toBe("✓ Explored");
		expect(group.render(60)[1]).toContain(theme.fg("toolTitle", theme.bold("Explored")));
		expect(group.isOpen()).toBe(true);
	});

	test("keeps failures visible, closes the run, and expands to full rows", () => {
		const group = new ToolGroupComponent(false);
		const ok = row("read", { path: "a.ts" });
		const missing = row("read", { path: "missing.ts" });
		group.add(ok);
		group.add(missing);
		ok.updateResult(result("a"));
		missing.updateResult(result("ENOENT", true));

		expect(text(group.render(60))).toEqual([
			"",
			"✗ Explored",
			"  ⎿ Read a.ts",
			"    Read missing.ts",
			"  ✗ read",
			"    ⎿ ENOENT",
		]);
		expect(group.isOpen()).toBe(false);

		group.setExpanded(true);
		expect(text(group.render(60))).toEqual([
			"",
			"✓ read",
			"  ⎿ full",
			"    r:a",
			"✗ read",
			"  ⎿ full",
			"    r:ENOENT",
		]);
	});

	test("caps grouped exploration paths on ultrawide terminals", () => {
		const group = new ToolGroupComponent(false);
		const member = row("read", { path: "long/path/".repeat(40) });
		member.updateResult(result("ok"));
		group.add(member);
		for (const line of group.render(240)) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		expect(stripAnsi(group.render(240)[2]!)).toContain("…");
	});

	test("caps long runs with a more hint", () => {
		const group = new ToolGroupComponent(false);
		for (let index = 0; index < 9; index++) {
			const member = row("read", { path: `f${index}.ts` });
			group.add(member);
			member.updateResult(result("x"));
		}
		const lines = text(group.render(60));
		expect(lines).toHaveLength(2 + 6);
		expect(lines.at(-1)).toBe("    … +4 more ( to expand)");
	});
});
