import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig, resolveCompactAfterTokens, saveConfig } from "./unified-config.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	delete process.env.ICE_CODING_AGENT_DIR;
	delete process.env.ICE_BLACKHOLE_COMPACT_AFTER_PERCENT;
});

function useConfig(raw: Record<string, unknown>): void {
	const directory = mkdtempSync(join(tmpdir(), "ice-blackhole-"));
	tempDirs.push(directory);
	mkdirSync(join(directory, "ice-blackhole"));
	writeFileSync(join(directory, "ice-blackhole", "ice-blackhole-config.json"), JSON.stringify(raw));
	process.env.ICE_CODING_AGENT_DIR = directory;
}

describe("ice-blackhole unified config", () => {
	it("resolves a percentage against the active model context window", () => {
		useConfig({ compactAfterPercent: 20 });
		const config = loadConfig();
		expect(config.compactAfterPercent).toBe(20);
		expect(resolveCompactAfterTokens(config, 272000)).toBe(54400);
		expect(resolveCompactAfterTokens(config, 64000)).toBe(12800);
	});

	it("defaults to an 85 percent threshold when nothing is configured", () => {
		useConfig({});
		const config = loadConfig();
		expect(config.compactAfterPercent).toBe(85);
		expect(DEFAULTS.compactAfterPercent).toBe(85);
		expect(resolveCompactAfterTokens(config, 272000)).toBe(231200);
	});

	it("ignores a legacy numeric threshold and applies the percent threshold", () => {
		useConfig({ compactAfterTokens: 50000 });
		const config = loadConfig();
		expect(config.compactAfterPercent).toBe(85);
		expect(resolveCompactAfterTokens(config, 272000)).toBe(231200);
	});

	it("honors the percent environment override and warns on invalid values", () => {
		useConfig({ compactAfterPercent: 20 });
		process.env.ICE_BLACKHOLE_COMPACT_AFTER_PERCENT = "70";
		expect(loadConfig().compactAfterPercent).toBe(70);
		process.env.ICE_BLACKHOLE_COMPACT_AFTER_PERCENT = "not-a-number";
		const warnings: string[] = [];
		expect(loadConfig((message) => warnings.push(message)).compactAfterPercent).toBe(20);
		expect(warnings).toHaveLength(1);
	});

	it("skips percentage mode when model context metadata is unavailable", () => {
		useConfig({ compactAfterPercent: 20 });
		const warnings: string[] = [];
		const config = loadConfig();
		expect(resolveCompactAfterTokens(config, undefined, (message) => warnings.push(message))).toBeUndefined();
		expect(warnings).toHaveLength(1);
	});

	it("persists the percent threshold and drops a legacy numeric field on save", () => {
		useConfig({ compactAfterTokens: 50000 });
		saveConfig({ compactAfterPercent: 20 });
		const raw = JSON.parse(
			readFileSync(join(tempDirs[0], "ice-blackhole", "ice-blackhole-config.json"), "utf8"),
		) as Record<string, unknown>;
		expect(raw.compactAfterPercent).toBe(20);
		expect(raw.compactAfterTokens).toBeUndefined();
	});

	it("keeps percentage mode when an unrelated setting is saved", () => {
		useConfig({ compactAfterPercent: 86 });
		saveConfig({ midRunCompaction: "resume" });
		const raw = JSON.parse(
			readFileSync(join(tempDirs[0], "ice-blackhole", "ice-blackhole-config.json"), "utf8"),
		) as Record<string, unknown>;
		expect(raw.compactAfterPercent).toBe(86);
		expect(loadConfig().compactAfterPercent).toBe(86);
	});
});
