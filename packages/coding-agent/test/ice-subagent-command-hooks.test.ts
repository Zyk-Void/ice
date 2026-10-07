import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIceCommandHookHandler, parseIceCommandHookPolicy } from "../src/subagents/hooks/command-hooks.ts";
import type { IceHookDecisionInput } from "../src/subagents/settings.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(source: string) {
	const cwd = mkdtempSync(join(tmpdir(), "ice-command-hook-"));
	dirs.push(cwd);
	const script = join(cwd, "hook.mjs");
	writeFileSync(script, source);
	const executable = realpathSync(process.execPath);
	const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
	const policy = parseIceCommandHookPolicy({
		enabled: true,
		approval: "allow",
		commands: {
			audit: { argv: [executable, script], cwd, sha256: hash(executable), files: { [script]: hash(script) } },
		},
	});
	const input: IceHookDecisionInput = {
		hook: {
			id: "audit",
			event: "subagent.beforeLaunch",
			kind: "command",
			required: true,
			roles: undefined,
			timeoutMs: 500,
			maxOutputBytes: 1024,
			source: { layer: "global", trusted: true },
			order: 0,
		},
		event: "subagent.beforeLaunch",
		ownerSessionId: "parent",
		runId: "run",
		payload: {},
	};
	return { cwd, script, policy, input };
}

describe("host-owned command hooks", () => {
	it("uses bounded JSON and an explicit environment rather than inheriting secrets", async () => {
		const f = fixture(
			'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => console.log(JSON.stringify({schemaVersion:1,outcome:"continue",reason:JSON.parse(data).runId+":"+Object.keys(process.env).sort().join(",")})));',
		);
		const handler = createIceCommandHookHandler({ policy: f.policy, workspace: f.cwd, isAuthorized: () => true });
		expect(await handler(f.input)).toMatchObject({ outcome: "continue", reason: "run:LANG,LC_ALL" });
	});
	it("blocks missing build authority and missing headless approval", async () => {
		const f = fixture('console.log("must not run")');
		await expect(
			createIceCommandHookHandler({ policy: f.policy, workspace: f.cwd, isAuthorized: () => false })(f.input),
		).rejects.toThrow(/trusted build/);
		await expect(
			createIceCommandHookHandler({
				policy: { ...f.policy, approval: "ask" },
				workspace: f.cwd,
				isAuthorized: () => true,
			})(f.input),
		).rejects.toThrow(/approval/);
	});
	it("rejects changed scripts before spawn", async () => {
		const f = fixture('console.log("initial")');
		writeFileSync(f.script, 'console.log("changed")');
		await expect(
			createIceCommandHookHandler({ policy: f.policy, workspace: f.cwd, isAuthorized: () => true })(f.input),
		).rejects.toThrow(/identity changed/);
	});
	it("bounds output floods", async () => {
		const f = fixture('process.stdout.write("x".repeat(100000)); setInterval(()=>{},1000);');
		await expect(
			createIceCommandHookHandler({ policy: f.policy, workspace: f.cwd, isAuthorized: () => true })(f.input),
		).rejects.toThrow(/stdout limit/);
	});
	it("terminates a hanging command at the deadline", async () => {
		const f = fixture("setInterval(()=>{},1000);");
		f.input.hook.timeoutMs = 30;
		await expect(
			createIceCommandHookHandler({ policy: f.policy, workspace: f.cwd, isAuthorized: () => true })(f.input),
		).rejects.toThrow(/deadline/);
	});
	it("rejects malformed decision output", async () => {
		const f = fixture('console.log("allow")');
		await expect(
			createIceCommandHookHandler({ policy: f.policy, workspace: f.cwd, isAuthorized: () => true })(f.input),
		).rejects.toThrow(/decision JSON/);
	});
});
