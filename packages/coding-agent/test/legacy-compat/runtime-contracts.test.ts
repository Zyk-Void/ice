import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readIceManifest } from "../../src/core/ice-manifest.ts";
import { compatibleBlackholeConfigPath, compatibleCogneeStorageDir } from "../../src/core/legacy-compat/cognee.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { hasTrustRequiringProjectResources } from "../../src/core/trust-manager.ts";
import { SubagentJobRegistry } from "../../src/ice-subagent-jobs.ts";
import { getThemeByName, initTheme, setTheme, stopThemeWatcher } from "../../src/modes/interactive/theme/theme.ts";
import { getIceSettingsCommandSchemaResult, invokeIceSettingsCommand } from "../../src/modes/rpc/rpc-command-schema.ts";
import { applyRpcSetting } from "../../src/modes/rpc/rpc-settings.ts";

const roots: string[] = [];
const registries: SubagentJobRegistry[] = [];
function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "ice-legacy-contract-"));
	roots.push(root);
	return root;
}
function put(root: string, name: string, text: string): string {
	const parts = name.split("/");
	parts.pop();
	mkdirSync(join(root, ...parts), { recursive: true });
	const path = join(root, name);
	writeFileSync(path, text);
	return path;
}
afterEach(async () => {
	await Promise.all(registries.splice(0).map((r) => r.shutdown()));
	stopThemeWatcher();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("legacy runtime contracts", () => {
	it("reads and writes the ice settings namespace", async () => {
		const root = fixture();
		const file = put(
			root,
			".ice/agent/settings.json",
			JSON.stringify({
				theme: "dark",
				ice: { subagents: { enabled: false, restrictions: { denyTools: ["bash"] } } },
			}),
		);
		const manager = SettingsManager.create(root, join(root, ".ice/agent"));
		expect(manager.getIceSettingsValue("global")?.subagents?.enabled).toBe(false);
		manager.setIceSettingsValue("global", { subagents: { enabled: false, defaults: { maxOutputBytes: 1_024 } } });
		await manager.flush();
		expect(manager.drainErrors()).toEqual([]);
		const stored = JSON.parse(readFileSync(file, "utf8"));
		expect(stored).toMatchObject({
			theme: "dark",
			ice: { subagents: { enabled: false, defaults: { maxOutputBytes: 1_024 } } },
		});
	});

	it("reads ice package manifests and falls back to the legacy pi field", () => {
		const root = fixture();
		const file = put(root, "package.json", JSON.stringify({ pi: { extensions: ["old.ts"] } }));
		expect(readIceManifest(file)?.extensions).toEqual(["old.ts"]);
		writeFileSync(file, JSON.stringify({ ice: { extensions: ["new.ts"] }, pi: { extensions: ["old.ts"] } }));
		expect(readIceManifest(file)?.extensions).toEqual(["new.ts"]);
		writeFileSync(file, JSON.stringify({ ice: null, pi: { extensions: ["old.ts"] } }));
		expect(readIceManifest(file)).toBeNull();
	});

	it("does not execute project extensions before trust, and does not load .pi extensions", async () => {
		const root = fixture();
		const agentDir = join(root, "user");
		mkdirSync(agentDir);
		put(
			root,
			".pi/extensions/legacy.ts",
			'export default (api) => { api.registerCommand("legacy-probe", { description: "probe", handler: async () => {} }); };',
		);
		expect(hasTrustRequiringProjectResources(root)).toBe(false);
		const iceExtension = put(
			root,
			".ice/extensions/legacy.ts",
			'export default (api) => { api.registerCommand("legacy-probe", { description: "probe", handler: async () => {} }); };',
		);
		const before = createHash("sha256").update(readFileSync(iceExtension)).digest("hex");
		expect(hasTrustRequiringProjectResources(root)).toBe(true);
		vi.stubEnv("ICE_OFFLINE", "1");
		const settingsManager = SettingsManager.create(root, agentDir, { projectTrusted: false });
		const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager });
		await loader.reload();
		expect(loader.getExtensions().extensions).toHaveLength(0);
		settingsManager.setProjectTrusted(true);
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions.some((e) => e.commands.has("legacy-probe"))).toBe(true);
		expect(createHash("sha256").update(readFileSync(iceExtension)).digest("hex")).toBe(before);
	});

	it("restores ice journal records as interrupted, never dispatches them, and preserves owner isolation", () => {
		const persist = vi.fn();
		const notify = vi.fn();
		const registry = new SubagentJobRegistry({ ownerSessionId: "owner-a", persist, notify });
		registries.push(registry);
		const snapshot = {
			schemaVersion: 1,
			sequence: 1,
			job: {
				schemaVersion: 1,
				jobId: "old-job",
				ownerSessionId: "owner-a",
				launchLeafId: "leaf-a",
				role: "explore",
				status: "running",
				createdAt: "2026-01-01T00:00:00.000Z",
				startedAt: "2026-01-01T00:00:01.000Z",
				plannedOutputBytes: 24576,
				resultRef: "job:old-job",
			},
		};
		const ignored = { type: "custom", customType: "piv-subagent-job-v1", data: snapshot };
		registry.restore([ignored]);
		expect(registry.list()).toEqual([]);
		const entry = { type: "custom", customType: "ice-subagent-job-v1", data: snapshot };
		const frozenBytes = JSON.stringify(entry);
		registry.restore([entry]);
		expect(registry.list()).toMatchObject([{ job: { jobId: "old-job", status: "interrupted" } }]);
		expect(JSON.stringify(entry)).toBe(frozenBytes);
		registry.restore([
			{ ...entry, data: { ...snapshot, job: { ...snapshot.job, ownerSessionId: "another-owner" } } },
		]);
		expect(registry.list()).toHaveLength(0);
	});

	it("uses ice RPC schema and keys", async () => {
		const manager = SettingsManager.inMemory({ ice: { subagents: { enabled: false } } });
		const context = { cwd: "/workspace", settingsManager: manager };
		const schema = getIceSettingsCommandSchemaResult(context).schema!;
		expect(schema.schemaId).toBe("ice.settings");
		await invokeIceSettingsCommand(
			context,
			{
				schemaId: "ice.settings",
				schemaRevision: schema.revision,
				arguments: { "ice.subagents.enabled": false },
				options: { scope: "global" },
			},
			false,
		);
		await expect(
			invokeIceSettingsCommand(
				context,
				{
					schemaId: "pi.settings",
					schemaRevision: schema.revision,
					arguments: { "ice.subagents.enabled": true },
				},
				false,
			),
		).rejects.toMatchObject({ errorCode: "stale" });
		await applyRpcSetting(context, { scope: "global", key: "ice.subagents.enabled", value: false });
		expect(manager.getIceSettingsValue("global")?.subagents?.enabled).toBe(false);
	});

	it("uses the ice theme global", () => {
		initTheme("dark");
		const key = Symbol.for("@zykairotis/ice-coding-agent:theme");
		const globals = globalThis as Record<symbol, unknown>;
		expect(globals[key]).toBeDefined();
		setTheme("light");
		expect((globals[key] as { name: string }).name).toBe("light");
		expect(getThemeByName("dark")?.name).toBe("dark");
	});

	it("selects only ice Cognee and Blackhole paths", () => {
		const root = fixture();
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		mkdirSync(join(agentDir, "pi-cognee"));
		put(agentDir, "pi-blackhole/pi-blackhole-config.json", "{}");
		expect(compatibleCogneeStorageDir(agentDir)).toBe(join(agentDir, "ice-cognee"));
		expect(compatibleBlackholeConfigPath(agentDir)).toBe(
			join(agentDir, "ice-blackhole", "ice-blackhole-config.json"),
		);
	});
});
