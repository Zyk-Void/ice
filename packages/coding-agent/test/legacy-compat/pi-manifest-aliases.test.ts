import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExtensionsCached } from "../../src/core/extensions/loader.ts";
import { DefaultPackageManager } from "../../src/core/package-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

/**
 * The compatibility contract is one chain, not two: a package discovered from
 * `package.json#pi` must supply a real extension whose `@earendil-works/*`
 * imports resolve and whose default export actually executes. Discovery alone
 * (runtime-contracts) and import resolution alone (extension-imports) each
 * prove only half of it.
 */
describe("pi manifest fallback to earendil alias resolution", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "ice-pi-chain-"));
		agentDir = join(tempDir, "agent");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers a pi-manifest package and executes its earendil-importing extension", async () => {
		const packageDir = join(agentDir, "npm", "node_modules", "pi-chain-package");
		// Outside the default scan dirs (extensions/, skills/, ...): only the
		// pi manifest entry makes this discoverable, so the manifest seam is
		// load-bearing rather than shadowed by the directory fallback.
		const extensionPath = join(packageDir, "src", "chain.ts");
		mkdirSync(join(packageDir, "src"), { recursive: true });

		// Every supported earendil specifier in one factory body.
		writeFileSync(
			extensionPath,
			[
				'import * as codingAgent from "@earendil-works/pi-coding-agent";',
				'import * as agentCore from "@earendil-works/pi-agent-core";',
				'import * as tui from "@earendil-works/pi-tui";',
				'import * as ai from "@earendil-works/pi-ai";',
				'import * as aiCompat from "@earendil-works/pi-ai/compat";',
				'import * as aiOauth from "@earendil-works/pi-ai/oauth";',
				'import * as aiProviders from "@earendil-works/pi-ai/providers/all";',
				"export default function chainExtension(ice) {",
				"\tvoid codingAgent; void agentCore; void tui;",
				"\tvoid ai; void aiCompat; void aiOauth; void aiProviders;",
				'\tice.registerCommand("chain-command", { handler: async () => {} });',
				"}",
			].join("\n"),
		);
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "pi-chain-package",
				version: "1.0.0",
				pi: { extensions: ["./src"] },
			}),
		);

		const packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			// inMemory() stores packages in the global (user) scope, so
			// resolve() finds the package under agentDir.
			settingsManager: SettingsManager.inMemory({ packages: ["npm:pi-chain-package"] }),
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
		expect(result.extensions[0]?.commands.has("chain-command")).toBe(true);
	});
});
