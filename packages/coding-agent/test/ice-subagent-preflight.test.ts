import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeSubagentRequest, type SubagentRequest } from "../src/ice-subagents.ts";
import {
	evaluateSubagentPreflight,
	formatSubagentPreflight,
	normalizeSubagentPreflightRequirements,
} from "../src/subagents/runtime/preflight.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

async function workspace(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "ice-preflight-"));
	tempDirs.push(cwd);
	await mkdir(join(cwd, "bin"), { recursive: true });
	await mkdir(join(cwd, "src"), { recursive: true });
	return cwd;
}

describe("subagent preflight normalization", () => {
	it("normalizes bounded requirements and defaults required to true", () => {
		const normalized = normalizeSubagentPreflightRequirements([
			{ id: "chromium", kind: "command", value: "chromium" },
			{ id: "schema", kind: "path", value: "src", required: false },
			{ id: "database-url", kind: "env-present", value: "DATABASE_URL", required: true },
		]);
		expect(normalized).toEqual([
			{ id: "chromium", kind: "command", value: "chromium", required: true },
			{ id: "schema", kind: "path", value: "src", required: false },
			{ id: "database-url", kind: "env-present", value: "DATABASE_URL", required: true },
		]);
	});

	it("rejects command probes that are not bare executable names", () => {
		for (const value of ["./chromium", "chromium --headless", "a && b", "$(echo hi)", "/usr/bin/chromium", "a|b"]) {
			expect(() => normalizeSubagentPreflightRequirements([{ id: "bad", kind: "command", value }])).toThrow(
				/bare executable name/,
			);
		}
	});

	it("rejects invalid env names, duplicate IDs, oversized values, and unknown kinds", () => {
		expect(() => normalizeSubagentPreflightRequirements([{ id: "bad", kind: "env-present", value: "A B" }])).toThrow(
			/environment variable/,
		);
		expect(() =>
			normalizeSubagentPreflightRequirements([
				{ id: "same", kind: "command", value: "a" },
				{ id: "same", kind: "command", value: "b" },
			]),
		).toThrow(/unique/);
		expect(() =>
			normalizeSubagentPreflightRequirements([{ id: "big", kind: "command", value: "a".repeat(513) }]),
		).toThrow();
		expect(() =>
			normalizeSubagentPreflightRequirements([{ id: "x", kind: "docker" as never, value: "postgres" }]),
		).toThrow(/unsupported kind/);
	});

	it("caps the number of requirements", () => {
		const tooMany = Array.from({ length: 9 }, (_, index) => ({
			id: `cmd-${index}`,
			kind: "command" as const,
			value: `cmd-${index}`,
		}));
		expect(() => normalizeSubagentPreflightRequirements(tooMany)).toThrow(/at most 8/);
	});
});

describe("subagent preflight evaluation", () => {
	it("finds executables on PATH without executing anything", async () => {
		const cwd = await workspace();
		const executable = join(cwd, "bin", "fake-tool");
		await writeFile(executable, "#!/bin/sh\nexit 0\n");
		await chmod(executable, 0o755);
		const requirements = normalizeSubagentPreflightRequirements([
			{ id: "fake-tool", kind: "command", value: "fake-tool" },
		]);
		const evaluation = evaluateSubagentPreflight(requirements, {
			cwd,
			scopeRoots: [cwd],
			environment: { PATH: join(cwd, "bin") } as NodeJS.ProcessEnv,
		});
		expect(evaluation.blocked).toBe(false);
		expect(evaluation.checks[0]).toMatchObject({ id: "fake-tool", state: "FOUND" });
		expect(evaluation.summary).toContain("fake-tool: FOUND");
	});

	it("reports unavailable for a non-executable or missing command and blocks when required", async () => {
		const cwd = await workspace();
		const plain = join(cwd, "bin", "not-executable");
		await writeFile(plain, "data");
		const requirements = normalizeSubagentPreflightRequirements([
			{ id: "not-exec", kind: "command", value: "not-executable" },
			{ id: "missing", kind: "command", value: "definitely-missing-tool", required: false },
		]);
		const evaluation = evaluateSubagentPreflight(requirements, {
			cwd,
			scopeRoots: [cwd],
			environment: { PATH: join(cwd, "bin") } as NodeJS.ProcessEnv,
		});
		expect(evaluation.checks[0]).toMatchObject({ state: "UNAVAILABLE", required: true });
		expect(evaluation.checks[1]).toMatchObject({ state: "UNAVAILABLE", required: false });
		expect(evaluation.blocked).toBe(true);
		expect(evaluation.failedRequiredIds).toEqual(["not-exec"]);
	});

	it("reports env presence without leaking values", async () => {
		const cwd = await workspace();
		const secretValue = "super-secret-database-password-12345";
		const requirements = normalizeSubagentPreflightRequirements([
			{ id: "database-url", kind: "env-present", value: "DATABASE_URL" },
			{ id: "absent-var", kind: "env-present", value: "DEFINITELY_ABSENT_VAR" },
		]);
		const evaluation = evaluateSubagentPreflight(requirements, {
			cwd,
			scopeRoots: [cwd],
			environment: { DATABASE_URL: secretValue } as NodeJS.ProcessEnv,
		});
		expect(evaluation.checks[0]).toMatchObject({ state: "PRESENT" });
		expect(evaluation.checks[1]).toMatchObject({ state: "ABSENT" });
		expect(evaluation.summary).not.toContain(secretValue);
		expect(JSON.stringify(evaluation)).not.toContain(secretValue);
	});

	it("keeps path probes inside the approved scope", async () => {
		const cwd = await workspace();
		await writeFile(join(cwd, "src", "file.ts"), "x\n");
		const requirements = normalizeSubagentPreflightRequirements([
			{ id: "in-scope", kind: "path", value: "src/file.ts" },
			{ id: "out-scope", kind: "path", value: "../elsewhere" },
			{ id: "missing-in-scope", kind: "path", value: "src/missing.ts", required: false },
		]);
		const evaluation = evaluateSubagentPreflight(requirements, {
			cwd,
			scopeRoots: [join(cwd, "src")],
			environment: {} as NodeJS.ProcessEnv,
		});
		expect(evaluation.checks[0]).toMatchObject({ state: "FOUND" });
		expect(evaluation.checks[1]).toMatchObject({ state: "OUT_OF_SCOPE" });
		expect(evaluation.checks[2]).toMatchObject({ state: "UNAVAILABLE", required: false });
		// The required out-of-scope check blocks; optional missing does not.
		expect(evaluation.blocked).toBe(true);
		const optionalOnly = evaluateSubagentPreflight([requirements[2]!], {
			cwd,
			scopeRoots: [join(cwd, "src")],
			environment: {} as NodeJS.ProcessEnv,
		});
		expect(optionalOnly.blocked).toBe(false);
	});

	it("rejects absolute path probes outside scope", async () => {
		const cwd = await workspace();
		const requirements = normalizeSubagentPreflightRequirements([{ id: "abs", kind: "path", value: "/etc/passwd" }]);
		const evaluation = evaluateSubagentPreflight(requirements, {
			cwd,
			scopeRoots: [cwd],
			environment: {} as NodeJS.ProcessEnv,
		});
		expect(evaluation.checks[0]).toMatchObject({ state: "OUT_OF_SCOPE" });
		expect(evaluation.blocked).toBe(true);
	});

	it("returns an empty non-blocking evaluation without requirements", () => {
		const evaluation = evaluateSubagentPreflight([], {
			cwd: "/tmp",
			scopeRoots: ["/tmp"],
			environment: {} as NodeJS.ProcessEnv,
		});
		expect(evaluation.checks).toEqual([]);
		expect(evaluation.blocked).toBe(false);
		expect(formatSubagentPreflight([])).toBe("");
	});
});

describe("subagent preflight request integration", () => {
	it("normalizes preflight metadata without expanding child authority", async () => {
		const cwd = await workspace();
		const baseRequest: SubagentRequest = {
			parentSessionId: "parent-preflight",
			role: "self",
			self: { instructions: "Inspect the approved scope and preserve concrete evidence." },
			task: "Inspect.",
			scope: { roots: ["src"] },
			cwd,
		};
		const withoutPreflight = normalizeSubagentRequest(baseRequest, cwd);
		const withPreflight = normalizeSubagentRequest(
			{
				...baseRequest,
				preflight: [{ id: "tool", kind: "command", value: "tool" }],
			},
			cwd,
		);
		// Preflight metadata never changes the derived tool authority of the child.
		expect(withPreflight.profile.requestedTools).toEqual(withoutPreflight.profile.requestedTools);
		expect(withPreflight.scope).toEqual(withoutPreflight.scope);
		expect(withPreflight.preflight).toEqual([{ id: "tool", kind: "command", value: "tool", required: true }]);
		expect(withoutPreflight.preflight).toEqual([]);
	});
});
