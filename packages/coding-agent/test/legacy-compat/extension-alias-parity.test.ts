import { describe, expect, it } from "vitest";
import { getExtensionAliasMaps } from "../../src/core/extensions/loader.ts";
import { LEGACY_PI_EXTENSION_ALIASES } from "../../src/core/legacy-compat/extension-aliases.ts";

/**
 * Node/Jiti and Bun use different resolution mechanics, so the two maps can
 * drift apart silently. Both are built from the one policy table; this contract
 * pins that they agree on every approved alias, that each alias reuses its
 * canonical target rather than resolving a second copy, and that unapproved
 * Pi-like specifiers stay unresolved in both runtimes.
 */
const CANONICAL_TARGETS = [
	"@zykairotis/ice-coding-agent",
	"@zykairotis/ice-agent-core",
	"@zykairotis/ice-tui",
	"@zykairotis/ice-ai",
	"@zykairotis/ice-ai/compat",
	"@zykairotis/ice-ai/oauth",
	"@zykairotis/ice-ai/providers/all",
];

const UNAPPROVED_SPECIFIERS = [
	"@earendil-works/pi-ai/providers/not-supported",
	"@mariozechner/pi-ai/providers/not-supported",
	"@mariozechner/pi-coding-agent/not-supported",
	"@other/pi-coding-agent",
];

describe("extension alias parity", () => {
	it("pins the policy table to the approved inventory and targets", () => {
		expect(Object.keys(LEGACY_PI_EXTENSION_ALIASES)).toHaveLength(14);
		expect(new Set(Object.values(LEGACY_PI_EXTENSION_ALIASES))).toEqual(new Set(CANONICAL_TARGETS));
	});

	it("applies every approved alias through the exact virtual-module policy", () => {
		const { virtualModules, nodeAliases } = getExtensionAliasMaps();
		for (const [legacy, canonical] of Object.entries(LEGACY_PI_EXTENSION_ALIASES)) {
			expect(virtualModules).toHaveProperty(legacy);
			// Jiti's alias option is prefix-based, so historical specifiers must not
			// appear there: exact virtual-module keys are shared by Node/Jiti and Bun.
			expect(nodeAliases).not.toHaveProperty(legacy);
			expect(virtualModules[legacy]).toBe(virtualModules[canonical]);
		}
	});

	it("leaves canonical ICE and typebox targets intact", () => {
		const { virtualModules, nodeAliases } = getExtensionAliasMaps();
		for (const canonical of CANONICAL_TARGETS) {
			expect(virtualModules[canonical]).toBeDefined();
			expect(typeof nodeAliases[canonical]).toBe("string");
		}
		for (const shared of ["typebox", "typebox/compile", "typebox/value"]) {
			expect(virtualModules[shared]).toBeDefined();
			expect(typeof nodeAliases[shared]).toBe("string");
		}
	});

	it("leaves unapproved Pi-like specifiers unresolved in both runtimes", () => {
		const { virtualModules, nodeAliases } = getExtensionAliasMaps();
		for (const specifier of UNAPPROVED_SPECIFIERS) {
			expect(virtualModules).not.toHaveProperty(specifier);
			expect(nodeAliases).not.toHaveProperty(specifier);
		}
	});
});
