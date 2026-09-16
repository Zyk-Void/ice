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
		expect(snapshot.fields.every((item) => !item.description?.includes("/secret/extension.ts"))).toBe(true);
		expect(field(snapshot, "terminal.showImages").restartRequired).toBe(true);
		expect(field(snapshot, "terminal.showImages").hostOnly).toBe(true);
	});

	it("projects effective shared subagent concurrency policy through RPC settings", async () => {
		const manager = SettingsManager.inMemory({
			ice: { subagents: { concurrency: { default: 6, max: 7 } } },
		});
		manager.setIceSettingsValue("project", {
			subagents: { concurrency: { default: 2, max: 3 } },
		} as never);
		await manager.flush();

		const snapshot = createRpcSettingsSnapshot(createContext(manager));
		expect(field(snapshot, "ice.subagents.concurrency.default")).toMatchObject({
			value: 6,
			effectiveValue: 2,
			projectOverride: true,
			effectiveSource: "project",
			kind: "number",
			constraints: { min: 1, max: 8, integer: true },
		});
		expect(field(snapshot, "ice.subagents.concurrency.max")).toMatchObject({
			value: 7,
			effectiveValue: 3,
			projectOverride: true,
			effectiveSource: "project",
		});
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
		const manager = SettingsManager.inMemory({
			ice: {
				subagents: { enabled: false, allowedRoles: ["explore"], restrictions: { denyRoles: ["explore"] } },
			},
		});
		manager.setIceSettingsValue("project", {
			subagents: { enabled: true, allowedRoles: [], restrictions: { denyRoles: [] } },
		} as never);
		await manager.flush();
		const snapshot = createRpcSettingsSnapshot(createContext(manager));
		expect(field(snapshot, "ice.subagents.enabled").effectiveValue).toBe(false);
		expect(field(snapshot, "ice.subagents.allowedRoles").effectiveValue).toEqual(["explore"]);
	});

	it("attributes malformed global and project ICE policies to their actual source", async () => {
		const invalidIce = { subagents: { defaults: { maxOutputBytes: "not-a-number" } } } as never;
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

	it("labels the subagent result byte cap as an output authority", () => {
		const settingsManager = SettingsManager.inMemory();
		const snapshot = createRpcSettingsSnapshot(
			createContext(settingsManager, { getExtensionSettings: () => [createExtensionSettings()] }),
		);

		const bytes = field(snapshot, "ice.subagents.defaults.maxOutputBytes");
		expect(bytes.label).toBe("Subagent result size cap");
		expect(bytes.description).toMatch(/not model tokens or cost/i);
	});
});
