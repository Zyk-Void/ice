import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../../src/core/extensions/loader.ts";

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

	// Namespace imports verify resolution of every supported current upstream
	// specifier without coupling the assertions to any particular named export.
	it.each([
		["@earendil-works/pi-coding-agent", "pi-coding-agent"],
		["@earendil-works/pi-agent-core", "pi-agent-core"],
		["@earendil-works/pi-tui", "pi-tui"],
		["@earendil-works/pi-ai", "pi-ai"],
		["@earendil-works/pi-ai/compat", "pi-ai-compat"],
		["@earendil-works/pi-ai/oauth", "pi-ai-oauth"],
		["@earendil-works/pi-ai/providers/all", "pi-ai-providers"],
	])("resolves %s to its ICE equivalent", async (specifier, command) => {
		const result = await loadExtension(
			"pi-import.ts",
			`
				import * as upstream from "${specifier}";
				export default function(ice) {
					void upstream;
					ice.registerCommand("${command}", { handler: async () => {} });
				}
			`,
		);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.commands.has(command)).toBe(true);
	});

	it("resolves every supported earendil specifier in one extension", async () => {
		const result = await loadExtension(
			"pi-all.ts",
			`
				import * as codingAgent from "@earendil-works/pi-coding-agent";
				import * as agentCore from "@earendil-works/pi-agent-core";
				import * as tui from "@earendil-works/pi-tui";
				import * as ai from "@earendil-works/pi-ai";
				import * as aiCompat from "@earendil-works/pi-ai/compat";
				import * as aiOauth from "@earendil-works/pi-ai/oauth";
				import * as aiProviders from "@earendil-works/pi-ai/providers/all";
				export default function(ice) {
					void codingAgent;
					void agentCore;
					void tui;
					void ai;
					void aiCompat;
					void aiOauth;
					void aiProviders;
					ice.registerCommand("pi-all", { handler: async () => {} });
				}
			`,
		);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.commands.has("pi-all")).toBe(true);
	});

	it("does not resolve an unsupported earendil subpath", async () => {
		const result = await loadExtension(
			"pi-unknown.ts",
			`
				import * as unknownSub from "@earendil-works/pi-ai/providers/not-supported";
				export default function(ice) {
					void unknownSub;
					ice.registerCommand("pi-unknown", { handler: async () => {} });
				}
			`,
		);
		expect(result.extensions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.error).toContain("@earendil-works/pi-ai/providers/not-supported");
	});

	it("does not resolve historical pi package specifiers", async () => {
		const result = await loadExtension(
			"legacy-pi.ts",
			`
				import { getAgentDir } from "@mariozechner/pi-coding-agent";
				export default function(ice) {
					void getAgentDir;
					ice.registerCommand("legacy-pi", { handler: async () => {} });
				}
			`,
		);
		expect(result.extensions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.error).toContain("pi-coding-agent");
	});
});
