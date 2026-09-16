import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExtensionsCached } from "../../src/core/extensions/loader.ts";
import { LEGACY_PI_EXTENSION_ALIASES } from "../../src/core/legacy-compat/extension-aliases.ts";
import { DefaultPackageManager } from "../../src/core/package-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

/**
 * The compatibility contract is one chain, not two: a package discovered from
 * `package.json#pi` must supply a real extension whose approved historical
 * imports resolve and whose default export actually executes. Discovery alone
 * (runtime-contracts) and import resolution alone (extension-imports) each
 * prove only half of it, so both approved families are exercised here.
 */
const FAMILIES = ["@earendil-works", "@mariozechner"] as const;

/** `@earendil-works` -> `earendil-works`. */
function familySlug(family: string): string {
	return family.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
}

describe("pi manifest fallback to legacy alias resolution", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "ice-pi-chain-"));
		agentDir = join(tempDir, "agent");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.each(FAMILIES)("discovers a pi-manifest package and executes its %s extension", async (family) => {
		const slug = familySlug(family);
		const packageName = `pi-chain-${slug}`;
		const command = `chain-command-${slug}`;
		const packageDir = join(agentDir, "npm", "node_modules", packageName);
		// Outside the default scan dirs (extensions/, skills/, ...): only the
		// pi manifest entry makes this discoverable, so the manifest seam is
		// load-bearing rather than shadowed by the directory fallback.
		const extensionPath = join(packageDir, "src", "chain.ts");
		mkdirSync(join(packageDir, "src"), { recursive: true });

		// Every approved specifier of this family in one factory body, read from
		// the production table so the fixture cannot drift from the contract.
		const specifiers = Object.keys(LEGACY_PI_EXTENSION_ALIASES).filter((specifier) =>
			specifier.startsWith(`${family}/`),
		);
		expect(specifiers).toHaveLength(7);
		const imports = specifiers.map((specifier, index) => `import * as m${index} from "${specifier}";`);
		const voids = specifiers.map((_, index) => `void m${index};`);

		writeFileSync(
			extensionPath,
			[
				...imports,
				"export default function chainExtension(ice) {",
				`\t${voids.join(" ")}`,
				`\tice.registerCommand("${command}", { handler: async () => {} });`,
				"}",
			].join("\n"),
		);
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: packageName,
				version: "1.0.0",
				pi: { extensions: ["./src"] },
			}),
		);

		const packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			// inMemory() stores packages in the global (user) scope, so
			// resolve() finds the package under agentDir.
			settingsManager: SettingsManager.inMemory({ packages: [`npm:${packageName}`] }),
		});

		const resources = await packageManager.resolve();
		expect(resources.extensions.map((e) => e.path)).toContain(extensionPath);

		// Guard both seams: an undiscovered extension yields an empty path
		// list (not a load error), so the resolved paths must be asserted too.
		expect(resources.extensions).toHaveLength(1);
		expect(resources.extensions[0]?.path).toBe(extensionPath);

		const result = await loadExtensionsCached(
			resources.extensions.map((e) => e.path),
			tempDir,
			undefined,
		);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.commands.has(command)).toBe(true);
	});
});
