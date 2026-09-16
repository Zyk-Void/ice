import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEGACY_PI_EXTENSION_ALIASES } from "../../src/core/legacy-compat/extension-aliases.ts";

/**
 * Compiled-runtime smoke. The built loader and Bun executable must carry the
 * same approved alias policy as the source loader, because Node/Jiti and Bun
 * resolve through different mechanics and a build can silently drop the overlay.
 *
 * Build execution is gated by repository policy, so these are opt-in and must
 * be run only after an authorized fresh build:
 *
 *   ICE_BUILT_SMOKE=1 ICE_BINARY_SMOKE=1 \
 *     node ../../node_modules/vitest/dist/cli.js \
 *     --run test/legacy-compat/built-runtime-smoke.test.ts
 *
 * Source-level parity (`extension-alias-parity.test.ts`) is the always-on gate.
 * These tests add the "did the build actually carry it" layer and are skipped by
 * default so stale `dist/` output cannot turn the normal suite red.
 */
const here = dirname(fileURLToPath(import.meta.url));
const BUILT_LOADER = resolve(here, "../../dist/core/extensions/loader.js");
const BUN_BINARY = resolve(here, "../../dist/ice");
const require = createRequire(import.meta.url);

const FAMILIES = ["@earendil-works", "@mariozechner"] as const;
const UNSUPPORTED_SPECIFIERS = [
	"@earendil-works/pi-ai/providers/not-supported",
	"@mariozechner/pi-ai/providers/not-supported",
] as const;

interface BuiltExtensionLoadResult {
	extensions: Array<{ commands: Map<string, unknown> }>;
	errors: Array<{ path: string; error: string }>;
}

interface BuiltLoaderModule {
	getExtensionAliasMaps(): {
		virtualModules: Readonly<Record<string, unknown>>;
		nodeAliases: Readonly<Record<string, string>>;
	};
	discoverAndLoadExtensions(paths: string[], cwd: string, agentDir?: string): Promise<BuiltExtensionLoadResult>;
}

function loadBuiltLoader(): BuiltLoaderModule {
	return require(BUILT_LOADER) as BuiltLoaderModule;
}

function binaryEnvironment(tempDir: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		ICE_CODING_AGENT_DIR: join(tempDir, "agent"),
		NO_COLOR: "1",
	};
}

describe.skipIf(process.env.ICE_BUILT_SMOKE !== "1")("built Node runtime alias compatibility", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "ice-built-smoke-"));
		extensionsDir = join(tempDir, "extensions");
		mkdirSync(extensionsDir);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("ships the approved alias policy in both built runtime maps", () => {
		expect(existsSync(BUILT_LOADER)).toBe(true);
		const built = loadBuiltLoader();
		expect(typeof built.getExtensionAliasMaps).toBe("function");

		const { virtualModules, nodeAliases } = built.getExtensionAliasMaps();
		for (const [legacy, canonical] of Object.entries(LEGACY_PI_EXTENSION_ALIASES)) {
			expect(virtualModules).toHaveProperty(legacy);
			// Built Node must use the exact virtual-module key, not Jiti's
			// prefix-based alias map, or unknown legacy subpaths would be rewritten.
			expect(nodeAliases).not.toHaveProperty(legacy);
			expect(virtualModules[legacy]).toBe(virtualModules[canonical]);
		}
	});

	it.each(FAMILIES)("loads a built extension importing every approved %s specifier", async (family) => {
		const specifiers = Object.keys(LEGACY_PI_EXTENSION_ALIASES).filter((specifier) =>
			specifier.startsWith(`${family}/`),
		);
		expect(specifiers).toHaveLength(7);

		const imports = specifiers.map((specifier, index) => `import * as m${index} from "${specifier}";`);
		const voids = specifiers.map((_, index) => `void m${index};`);
		const extensionPath = join(extensionsDir, "built-smoke.ts");
		writeFileSync(
			extensionPath,
			[
				...imports,
				"export default function builtSmoke(ice) {",
				`\t${voids.join(" ")}`,
				'\tice.registerCommand("built-smoke", { handler: async () => {} });',
				"}",
			].join("\n"),
		);

		const built = loadBuiltLoader();
		const result = await built.discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.commands.has("built-smoke")).toBe(true);
	});

	it.each(UNSUPPORTED_SPECIFIERS)("rejects the unsupported built import %s", async (specifier) => {
		const extensionPath = join(extensionsDir, "built-unknown.ts");
		writeFileSync(
			extensionPath,
			[
				`import * as unsupported from "${specifier}";`,
				"export default function builtUnknown(ice) {",
				"\tvoid unsupported;",
				'\tice.registerCommand("built-unknown", { handler: async () => {} });',
				"}",
			].join("\n"),
		);

		const built = loadBuiltLoader();
		const result = await built.discoverAndLoadExtensions([extensionPath], tempDir, tempDir);
		expect(result.extensions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.error).toContain(specifier);
	});
});

describe.skipIf(process.env.ICE_BINARY_SMOKE !== "1")("compiled Bun binary alias compatibility", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "ice-binary-smoke-"));
		extensionsDir = join(tempDir, "extensions");
		mkdirSync(extensionsDir);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads all approved historical aliases through the compiled Bun executable", () => {
		expect(existsSync(BUN_BINARY)).toBe(true);
		const specifiers = Object.keys(LEGACY_PI_EXTENSION_ALIASES);
		expect(specifiers).toHaveLength(14);

		const imports = specifiers.map((specifier, index) => `import * as m${index} from "${specifier}";`);
		const voids = specifiers.map((_, index) => `void m${index};`);
		const extensionPath = join(extensionsDir, "binary-approved.ts");
		writeFileSync(
			extensionPath,
			[
				...imports,
				"export default function binaryApproved(ice) {",
				`\t${voids.join(" ")}`,
				'\tice.registerFlag("binary-legacy-smoke", { type: "boolean", description: "binary alias smoke" });',
				"}",
			].join("\n"),
		);

		const result = spawnSync(BUN_BINARY, ["--offline", "--no-extensions", "--extension", extensionPath, "--help"], {
			cwd: tempDir,
			encoding: "utf8",
			env: binaryEnvironment(tempDir),
		});

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("--binary-legacy-smoke");
	});

	it.each(UNSUPPORTED_SPECIFIERS)("rejects the unsupported binary import %s", (specifier) => {
		expect(existsSync(BUN_BINARY)).toBe(true);
		const extensionPath = join(extensionsDir, "binary-unknown.ts");
		writeFileSync(
			extensionPath,
			[
				`import * as unsupported from "${specifier}";`,
				"export default function binaryUnknown(ice) {",
				"\tvoid unsupported;",
				'\tice.registerCommand("binary-unknown", { handler: async () => {} });',
				"}",
			].join("\n"),
		);

		const result = spawnSync(
			BUN_BINARY,
			["--offline", "--no-extensions", "--extension", extensionPath, "--print", "binary smoke"],
			{
				cwd: tempDir,
				encoding: "utf8",
				env: binaryEnvironment(tempDir),
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Failed to load extension");
		expect(result.stderr).toContain(specifier);
	});
});
