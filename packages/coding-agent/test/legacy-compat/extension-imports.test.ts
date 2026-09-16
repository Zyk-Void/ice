import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../../src/core/extensions/loader.ts";
import { LEGACY_PI_EXTENSION_ALIASES } from "../../src/core/legacy-compat/extension-aliases.ts";

/**
 * The compatibility contract is an exact inventory, not a pattern. Both
 * approved historical families are listed here explicitly so that adding a
 * wildcard or prefix policy cannot pass unnoticed, and so removing an approved
 * specifier fails here rather than silently at runtime.
 */
const EXPECTED_SPECIFIERS = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/compat",
	"@earendil-works/pi-ai/oauth",
	"@earendil-works/pi-ai/providers/all",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@mariozechner/pi-agent-core",
	"@mariozechner/pi-ai",
	"@mariozechner/pi-ai/compat",
	"@mariozechner/pi-ai/oauth",
	"@mariozechner/pi-ai/providers/all",
	"@mariozechner/pi-coding-agent",
	"@mariozechner/pi-tui",
].sort();

/** Runtime mappings come from the one production table, never a second copy. */
const APPROVED_SPECIFIERS = Object.keys(LEGACY_PI_EXTENSION_ALIASES).sort();

const FAMILIES = ["@earendil-works", "@mariozechner"] as const;

/** `@earendil-works/pi-ai/compat` -> `earendil-works-pi-ai-compat`. */
function commandNameFor(specifier: string): string {
	return specifier.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
}

describe("extension imports", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ice-extension-imports-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function loadExtension(fileName: string, source: string) {
		fs.writeFileSync(path.join(extensionsDir, fileName), source);
		return discoverAndLoadExtensions([], tempDir, tempDir);
	}

	it("approves exactly the documented historical specifier inventory", () => {
		expect(APPROVED_SPECIFIERS).toEqual(EXPECTED_SPECIFIERS);
	});

	it("loads an extension that imports ICE specifiers", async () => {
		const result = await loadExtension(
			"ice-imports.ts",
			`
				import { getAgentDir } from "@zykairotis/ice-coding-agent";
				import { Agent } from "@zykairotis/ice-agent-core";
				import { getCapabilities } from "@zykairotis/ice-tui";
				export default function(ice) {
					void getAgentDir;
					void Agent;
					void getCapabilities;
					ice.registerCommand("ice-imports", { handler: async () => {} });
				}
			`,
		);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.commands.has("ice-imports")).toBe(true);
	});

	// Namespace imports verify resolution of every approved historical specifier
	// without coupling the assertions to any particular named export.
	it.each(APPROVED_SPECIFIERS)("resolves %s to its ICE equivalent", async (specifier) => {
		const command = commandNameFor(specifier);
		const result = await loadExtension(
			"pi-import.ts",
			`
				import * as historical from "${specifier}";
				export default function(ice) {
					void historical;
					ice.registerCommand("${command}", { handler: async () => {} });
				}
			`,
		);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.commands.has(command)).toBe(true);
	});

	it.each(FAMILIES)("resolves every approved %s specifier in one extension", async (family) => {
		const specifiers = APPROVED_SPECIFIERS.filter((specifier) => specifier.startsWith(`${family}/`));
		expect(specifiers).toHaveLength(7);
		const imports = specifiers.map((specifier, index) => `import * as m${index} from "${specifier}";`);
		const voids = specifiers.map((_, index) => `void m${index};`);
		const command = `all-${commandNameFor(family)}`;
		const result = await loadExtension(
			`pi-all-${commandNameFor(family)}.ts`,
			`
				${imports.join("\n\t\t\t\t")}
				export default function(ice) {
					${voids.join("\n\t\t\t\t\t")}
					ice.registerCommand("${command}", { handler: async () => {} });
				}
			`,
		);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.commands.has(command)).toBe(true);
	});

	// Both historical pi-ai roots must land on the ICE compat entrypoint, not
	// the narrower core entrypoint: only compat carries the deprecated stream
	// helpers that unchanged extensions still call.
	it.each(["@earendil-works/pi-ai", "@mariozechner/pi-ai"])(
		"resolves %s through the ICE compat entrypoint",
		async (specifier) => {
			const result = await loadExtension(
				"pi-ai-root.ts",
				`
					import * as ai from "${specifier}";
					export default function(ice) {
						if (typeof ai.streamAnthropic !== "function") {
							throw new Error("pi-ai root did not resolve to the ICE compat entrypoint");
						}
						ice.registerCommand("pi-ai-root", { handler: async () => {} });
					}
				`,
			);
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			expect(result.extensions[0]?.commands.has("pi-ai-root")).toBe(true);
		},
	);

	// Exact-match only: an unapproved subpath of an approved family must stay
	// unresolved rather than being guessed at by a prefix rewrite.
	it.each([
		"@earendil-works/pi-ai/providers/not-supported",
		"@mariozechner/pi-ai/providers/not-supported",
		"@mariozechner/pi-coding-agent/not-supported",
	])("does not resolve the unsupported subpath %s", async (specifier) => {
		const result = await loadExtension(
			"pi-unknown.ts",
			`
				import * as unknownSub from "${specifier}";
				export default function(ice) {
					void unknownSub;
					ice.registerCommand("pi-unknown", { handler: async () => {} });
				}
			`,
		);
		expect(result.extensions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.error).toContain(specifier);
	});
});
