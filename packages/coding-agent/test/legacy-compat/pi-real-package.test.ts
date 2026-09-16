import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { discoverAndLoadExtensions } from "../../src/core/extensions/loader.ts";

const PACKAGE_NAMES = ["pi-web-access", "pi-multi-skills", "pi-mcp-adapter"];

/**
 * Optional integration smoke over three real packages in the agent npm cache,
 * exercising the `package.json#pi` fallback and the approved historical import
 * aliases together.
 *
 * This is not the compatibility gate. Correctness must not depend on local
 * cache contents, because a clean CI environment skips every case here; the
 * deterministic repository fixtures in `extension-imports.test.ts`,
 * `pi-manifest-aliases.test.ts`, and `runtime-contracts.test.ts` are the gate.
 * Each case skips rather than fails when its package is absent.
 */
const cacheRoot = join(getAgentDir(), "npm", "node_modules");

function isInstalled(name: string): boolean {
	return existsSync(join(cacheRoot, name, "index.ts"));
}

describe("real installed pi packages load", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "ice-pi-real-"));
		agentDir = join(tempDir, "agent");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	for (const pkg of PACKAGE_NAMES) {
		it.skipIf(!isInstalled(pkg))(`loads ${pkg} end-to-end`, async () => {
			const entry = join(cacheRoot, pkg, "index.ts");

			const result = await discoverAndLoadExtensions([entry], tempDir, agentDir);
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			expect(result.extensions[0]?.sourceInfo.path).toBe(entry);
		});
	}
});
