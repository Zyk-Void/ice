import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingItem } from "@zykairotis/ice-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegisteredSettings } from "../src/core/extensions/types.ts";
import { SettingsManager, type SettingsStorage } from "../src/core/settings-manager.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "../src/core/source-info.ts";
import {
	applyRpcSetting,
	createRpcSettingsSnapshot,
	type RpcSettingsContext,
	type RpcSettingsField,
} from "../src/modes/rpc/rpc-settings.ts";

const tempDirectories: string[] = [];

function createTempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "ice-rpc-settings-"));
	tempDirectories.push(directory);
	return directory;
}

function field(snapshot: ReturnType<typeof createRpcSettingsSnapshot>, key: string): RpcSettingsField {
	const found = snapshot.fields.find((item) => item.key === key);
	if (!found) throw new Error(`Missing field ${key}`);
	return found;
}

function createContext(
	settingsManager: SettingsManager,
	overrides: Partial<RpcSettingsContext> = {},
): RpcSettingsContext {
	return {
		cwd: "/workspace/project",
		settingsManager,
		...overrides,
	};
}

function createExtensionSettings(): RegisteredSettings {
	const sourceInfo: SourceInfo = createSyntheticSourceInfo("/secret/extension.ts", { source: "test-extension" });
	const items: SettingItem[] = [
		{
			id: "mode",
			label: "Mode",
			description: "Extension mode",
			currentValue: "safe",
			values: ["safe", "fast"],
		},
		{
			id: "submenu",
			label: "Legacy submenu",
			currentValue: "configured",
			submenu: () => undefined as never,
		},
	];
	return {
		name: "demo",
		sourceInfo,
		items,
		onChange: vi.fn((id: string, value: string) => {
			if (id === "mode") items[0].currentValue = value;
		}),
	};
}

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("RPC settings bridge", () => {
	it("serializes the versioned schema and every supported field kind without secrets or paths", () => {
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "local",
			trackingId: "secret-tracking-id",
			enabledModels: ["local/*"],
			packages: ["npm:example-package"],
		});
		const snapshot = createRpcSettingsSnapshot(
			createContext(settingsManager, { getExtensionSettings: () => [createExtensionSettings()] }),
		);

		expect(snapshot.protocolVersion).toBe(1);
		expect(snapshot.cwd).toBe("/workspace/project");
		expect(snapshot.projectTrusted).toBe(true);
		expect(new Set(snapshot.fields.map((item) => item.kind))).toEqual(
			new Set(["boolean", "select", "number", "text", "string-list", "package-sources"]),
		);
		expect(snapshot.fields.some((item) => item.key === "trackingId")).toBe(false);
		expect(snapshot.fields.some((item) => item.key === "extensions")).toBe(false);
		expect(snapshot.fields.some((item) => item.key === "extension.demo.submenu")).toBe(false);
		expect(field(snapshot, "ice.subagents.maxConcurrent")).toMatchObject({
			label: "Subagent concurrency",
			value: 4,
			effectiveValue: 4,
		});
		expect(snapshot.fields.every((item) => !item.description?.includes("/secret/extension.ts"))).toBe(true);
		expect(field(snapshot, "terminal.showImages").restartRequired).toBe(true);
		expect(field(snapshot, "terminal.showImages").hostOnly).toBe(true);
	});

	it("projects the subagent V2 settings the runtime enforces", async () => {
		const manager = SettingsManager.inMemory({
			ice: { subagents: { maxConcurrent: 6, maxDepth: 2, defaultAgent: "explore", disabledAgents: ["a"] } },
		});
		manager.setIceSettingsValue("project", {
			subagents: { maxConcurrent: 3, maxDepth: 4, disabledAgents: ["b"] },
		});
		await manager.flush();

		const snapshot = createRpcSettingsSnapshot(createContext(manager));
		expect(field(snapshot, "ice.subagents.maxConcurrent")).toMatchObject({
			value: 6,
			effectiveValue: 3,
			projectOverride: true,
			effectiveSource: "project",
			kind: "number",
			restartRequired: true,
			constraints: { min: 1, integer: true },
		});
		// A project can only lower the ceiling.
		expect(field(snapshot, "ice.subagents.maxDepth")).toMatchObject({ effectiveValue: 2, effectiveSource: "global" });
		expect(field(snapshot, "ice.subagents.defaultAgent").effectiveValue).toBe("explore");
		expect(field(snapshot, "ice.subagents.disabledAgents").effectiveValue).toEqual(["a", "b"]);
		expect(field(snapshot, "ice.subagents.askTimeoutMs")).toMatchObject({ scope: "global", effectiveValue: 600_000 });
		for (const legacy of ["concurrency.default", "concurrency.max", "defaults.thinking", "allowedRoles"])
			expect(snapshot.fields.some((item) => item.key === `ice.subagents.${legacy}`)).toBe(false);
	});

	it("validates subagent writes against the V2 schema", async () => {
		const context = createContext(SettingsManager.inMemory());
		await expect(
			applyRpcSetting(context, { key: "ice.subagents.defaultAgent", scope: "global", value: "Not Valid" }),
		).rejects.toMatchObject({ code: "invalid_value" });
		await expect(
			applyRpcSetting(context, { key: "ice.subagents.maxConcurrent", scope: "global", value: 0 }),
		).rejects.toMatchObject({ code: "out_of_range" });
		// No upper ceiling: the user decides how many subagents may run at once.
		const many = await applyRpcSetting(context, { key: "ice.subagents.maxConcurrent", scope: "global", value: 50 });
		expect(field(many, "ice.subagents.maxConcurrent").effectiveValue).toBe(50);
		await expect(
			applyRpcSetting(context, { key: "ice.subagents.askTimeoutMs", scope: "project", value: 5_000 }),
		).rejects.toMatchObject({ code: "scope_not_supported" });
		const snapshot = await applyRpcSetting(context, {
			key: "ice.subagents.defaultAgent",
			scope: "global",
			value: "reviewer",
		});
		expect(field(snapshot, "ice.subagents.defaultAgent").effectiveValue).toBe("reviewer");
	});

	it("reports ignored legacy subagent keys without blocking delegation", async () => {
		const manager = SettingsManager.inMemory({ ice: { subagents: { concurrency: { max: 3 } } } });
		manager.setIceSettingsValue("project", { subagents: { allowedRoles: ["explore"] } });
		await manager.flush();
		const snapshot = createRpcSettingsSnapshot(createContext(manager));
		expect(snapshot.diagnostics.filter((diagnostic) => diagnostic.code === "ice_deprecated_setting")).toEqual([
			expect.objectContaining({ scope: "global", message: expect.stringContaining("ice.subagents.concurrency") }),
			expect.objectContaining({ scope: "project", message: expect.stringContaining("ice.subagents.allowedRoles") }),
		]);
		expect(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "ice_policy_error")).toBe(false);
		expect(field(snapshot, "ice.subagents.enabled").effectiveValue).toBe(true);
		expect(field(snapshot, "ice.subagents.maxConcurrent").effectiveValue).toBe(4);
	});

	it("reports project precedence and persists global and project values across fresh managers", async () => {
		const root = createTempDirectory();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const context = createContext(manager, { cwd });

		await applyRpcSetting(context, { key: "quietStartup", scope: "global", value: false });
		await applyRpcSetting(context, { key: "quietStartup", scope: "project", value: true });

		const snapshot = createRpcSettingsSnapshot(context);
		expect(field(snapshot, "quietStartup")).toMatchObject({
			value: false,
			effectiveValue: true,
			projectOverride: true,
		});

		const fresh = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		expect(fresh.getGlobalSettings().quietStartup).toBe(false);
		expect(fresh.getProjectSettings().quietStartup).toBe(true);
		expect(fresh.getQuietStartup()).toBe(true);
	});

	it("projects deny-first ICE settings instead of displaying a permissive value", async () => {
		const manager = SettingsManager.inMemory({ ice: { subagents: { enabled: false } } });
		manager.setIceSettingsValue("project", { subagents: { enabled: true } });
		await manager.flush();
		const snapshot = createRpcSettingsSnapshot(createContext(manager));
		expect(field(snapshot, "ice.subagents.enabled")).toMatchObject({
			effectiveValue: false,
			effectiveSource: "global",
		});

		const invalid = SettingsManager.inMemory({ ice: { subagents: { maxDepth: 9 } } });
		expect(field(createRpcSettingsSnapshot(createContext(invalid)), "ice.subagents.enabled").effectiveValue).toBe(
			false,
		);
	});

	it("attributes malformed global and project ICE policies to their actual source", async () => {
		const invalidIce = { subagents: { maxConcurrent: "not-a-number" } } as never;
		const globalInvalid = SettingsManager.inMemory({ ice: invalidIce });
		const globalSnapshot = createRpcSettingsSnapshot(createContext(globalInvalid));
		expect(globalSnapshot.diagnostics).toContainEqual({
			code: "ice_policy_error",
			scope: "global",
			message: "ICE security-sensitive settings are invalid; delegation is blocked",
		});

		const projectInvalid = SettingsManager.inMemory();
		projectInvalid.setIceSettingsValue("project", invalidIce);
		await projectInvalid.flush();
		const projectSnapshot = createRpcSettingsSnapshot(createContext(projectInvalid));
		expect(projectSnapshot.diagnostics).toContainEqual({
			code: "ice_policy_error",
			scope: "project",
			message: "ICE security-sensitive settings are invalid; delegation is blocked",
		});

		const bothInvalid = SettingsManager.inMemory({ ice: invalidIce });
		bothInvalid.setIceSettingsValue("project", invalidIce);
		await bothInvalid.flush();
		const bothDiagnostics = createRpcSettingsSnapshot(createContext(bothInvalid)).diagnostics;
		expect(bothDiagnostics.filter((diagnostic) => diagnostic.code === "ice_policy_error")).toEqual([
			expect.objectContaining({ scope: "global" }),
			expect.objectContaining({ scope: "project" }),
		]);
	});

	it("does not treat an untrusted project policy as effective authority", () => {
		const manager = SettingsManager.inMemory({}, { projectTrusted: false });
		const snapshot = createRpcSettingsSnapshot(createContext(manager));
		expect(snapshot.projectTrusted).toBe(false);
		expect(snapshot.diagnostics.some((diagnostic) => diagnostic.scope === "project")).toBe(false);
	});

	it("reports a failed settings write without presenting it as persisted", async () => {
		let globalContent: string | undefined;
		let globalReads = 0;
		const storage: SettingsStorage = {
			withLock(scope, callback) {
				if (scope === "global" && globalReads++ > 0) throw new Error("locked");
				const next = callback(globalContent);
				if (scope === "global" && next !== undefined) globalContent = next;
			},
		};
		const manager = SettingsManager.fromStorage(storage);
		manager.setSettingValue("global", "quietStartup", true);
		await manager.flush();
		const snapshot = createRpcSettingsSnapshot(createContext(manager));
		expect(snapshot.diagnostics).toContainEqual({
			code: "settings_io_error",
			scope: "global",
			message: "Unable to read or persist global settings",
		});
		expect(globalContent).toBeUndefined();
	});

	it("updates boolean, select, number, text, list, and package-source values", async () => {
		const manager = SettingsManager.inMemory();
		const context = createContext(manager);

		await applyRpcSetting(context, { key: "quietStartup", scope: "global", value: true });
		await applyRpcSetting(context, { key: "transport", scope: "global", value: "websocket" });
		await applyRpcSetting(context, { key: "editorPaddingX", scope: "global", value: 3 });
		await applyRpcSetting(context, { key: "defaultProvider", scope: "global", value: "local" });
		await applyRpcSetting(context, { key: "enabledModels", scope: "global", value: ["local/*", "cloud/model"] });
		await applyRpcSetting(context, {
			key: "packages",
			scope: "global",
			value: [{ source: "npm:example", autoload: false, extensions: ["*.ts"] }],
		});

		expect(manager.getQuietStartup()).toBe(true);
		expect(manager.getTransport()).toBe("websocket");
		expect(manager.getEditorPaddingX()).toBe(3);
		expect(manager.getDefaultProvider()).toBe("local");
		expect(manager.getEnabledModels()).toEqual(["local/*", "cloud/model"]);
		expect(manager.getPackages()).toEqual([{ source: "npm:example", autoload: false, extensions: ["*.ts"] }]);
	});

	it("rejects unknown keys, invalid types, options, numeric bounds, scopes, and untrusted project writes", async () => {
		const manager = SettingsManager.inMemory({}, { projectTrusted: false });
		const context = createContext(manager);

		await expect(
			applyRpcSetting(context, { key: "doesNotExist", scope: "global", value: true }),
		).rejects.toMatchObject({
			code: "unknown_key",
		});
		await expect(
			applyRpcSetting(context, { key: "quietStartup", scope: "global", value: "true" }),
		).rejects.toMatchObject({
			code: "invalid_type",
		});
		await expect(
			applyRpcSetting(context, { key: "transport", scope: "global", value: "invalid" }),
		).rejects.toMatchObject({
			code: "invalid_option",
		});
		await expect(
			applyRpcSetting(context, { key: "editorPaddingX", scope: "global", value: 4 }),
		).rejects.toMatchObject({
			code: "out_of_range",
		});
		await expect(
			applyRpcSetting(context, { key: "defaultProjectTrust", scope: "project", value: "always" }),
		).rejects.toMatchObject({ code: "scope_not_supported" });
		await expect(
			applyRpcSetting(context, { key: "quietStartup", scope: "project", value: true }),
		).rejects.toMatchObject({
			code: "project_untrusted",
		});
	});

	it("applies declarative extension settings and omits submenu callbacks", async () => {
		const extension = createExtensionSettings();
		const manager = SettingsManager.inMemory();
		const context = createContext(manager, { getExtensionSettings: () => [extension] });

		const snapshot = await applyRpcSetting(context, {
			key: "extension.demo.mode",
			scope: "global",
			value: "fast",
		});

		expect(extension.onChange).toHaveBeenCalledWith("mode", "fast");
		expect(field(snapshot, "extension.demo.mode").effectiveValue).toBe("fast");
		expect(snapshot.fields.some((item) => item.key === "extension.demo.submenu")).toBe(false);
	});

	it("rejects unsafe nested package-source filter strings", async () => {
		const manager = SettingsManager.inMemory();
		const context = createContext(manager);

		await expect(
			applyRpcSetting(context, {
				key: "packages",
				scope: "global",
				value: [{ source: "npm:example", extensions: ["safe", "bad\u0000path"] }],
			}),
		).rejects.toMatchObject({ code: "invalid_value" });

		await expect(
			applyRpcSetting(context, {
				key: "packages",
				scope: "global",
				value: [{ source: "npm:\u0000example" }],
			}),
		).rejects.toMatchObject({ code: "invalid_value" });
	});

	it("returns a structured persistence error when the settings lock fails", async () => {
		let writes = 0;
		const storage: SettingsStorage = {
			withLock(scope, callback) {
				if (scope === "global" && writes++ > 0) {
					const error = Object.assign(new Error("locked"), { code: "ELOCKED" });
					throw error;
				}
				callback(undefined);
			},
		};
		const manager = SettingsManager.fromStorage(storage);

		await expect(
			applyRpcSetting(createContext(manager), { key: "quietStartup", scope: "global", value: true }),
		).rejects.toMatchObject({ code: "persistence_failed", scope: "global" });
	});

	it("does not expose legacy subagent keys as writable settings", async () => {
		const context = createContext(SettingsManager.inMemory());
		await expect(
			applyRpcSetting(context, { key: "ice.subagents.concurrency.max", scope: "global", value: 4 }),
		).rejects.toMatchObject({ code: "unknown_key" });
	});
});
