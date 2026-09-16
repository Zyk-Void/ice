import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@zykairotis/ice-coding-agent";

export type CompactionMode = "auto" | "manual" | "off";
export type CompactionEngine = "blackhole" | "ice-default";
export type MidRunCompaction = "resume" | "pause" | "off";
export type TailBehavior = "ice-default" | "minimal";

export interface UnifiedConfig {
	compaction: CompactionMode;
	compactionEngine: CompactionEngine;
	midRunCompaction: MidRunCompaction;
	tailBehavior: TailBehavior;
	compactAfterPercent: number;
	memory: boolean;
}

export const DEFAULTS: UnifiedConfig = {
	compaction: "auto",
	compactionEngine: "blackhole",
	midRunCompaction: "off",
	tailBehavior: "minimal",
	compactAfterPercent: 85,
	memory: false,
};

const CONFIG_DIR = "ice-blackhole";
const CONFIG_FILE = "ice-blackhole-config.json";

function configPath(): string {
	return join(process.env.ICE_CODING_AGENT_DIR?.trim() || getAgentDir(), CONFIG_DIR, CONFIG_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
	return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
}

function validPercent(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 99;
}

function parseRawConfig(warn?: (message: string) => void): Record<string, unknown> {
	const path = configPath();
	if (!existsSync(path)) return {};
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(value) ? value : {};
	} catch (error) {
		warn?.(`blackhole: failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

function parseEnvNumber(name: string, raw: string | undefined, warn?: (message: string) => void): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		warn?.(`blackhole: invalid ${name} value "${raw}"; ignoring`);
		return undefined;
	}
	return value;
}

export function loadConfig(warn?: (message: string) => void): UnifiedConfig {
	const raw = parseRawConfig(warn);
	const merged: UnifiedConfig = {
		compaction: enumValue(raw.compaction, ["auto", "manual", "off"], DEFAULTS.compaction),
		compactionEngine: enumValue(raw.compactionEngine, ["blackhole", "ice-default"], DEFAULTS.compactionEngine),
		midRunCompaction: enumValue(raw.midRunCompaction, ["resume", "pause", "off"], DEFAULTS.midRunCompaction),
		tailBehavior: enumValue(raw.tailBehavior, ["ice-default", "minimal"], DEFAULTS.tailBehavior),
		compactAfterPercent: DEFAULTS.compactAfterPercent,
		memory: raw.memory === true,
	};

	const envCompaction = process.env.ICE_BLACKHOLE_COMPACTION;
	if (envCompaction !== undefined) {
		merged.compaction = enumValue(envCompaction.trim().toLowerCase(), ["auto", "manual", "off"], merged.compaction);
	}
	const envEngine = process.env.ICE_BLACKHOLE_COMPACTION_ENGINE;
	if (envEngine !== undefined) {
		merged.compactionEngine = enumValue(
			envEngine.trim().toLowerCase(),
			["blackhole", "ice-default"],
			merged.compactionEngine,
		);
	}
	const envMidRun = process.env.ICE_BLACKHOLE_MID_RUN_COMPACTION;
	if (envMidRun !== undefined) {
		merged.midRunCompaction = enumValue(
			envMidRun.trim().toLowerCase(),
			["resume", "pause", "off"],
			merged.midRunCompaction,
		);
	}

	const percentFromEnv = parseEnvNumber(
		"ICE_BLACKHOLE_COMPACT_AFTER_PERCENT",
		process.env.ICE_BLACKHOLE_COMPACT_AFTER_PERCENT,
		warn,
	);
	const configuredPercent = percentFromEnv ?? raw.compactAfterPercent;
	if (configuredPercent !== undefined) {
		if (validPercent(configuredPercent)) {
			merged.compactAfterPercent = configuredPercent;
		} else {
			warn?.(
				`blackhole: compactAfterPercent must be a finite number from 1 to 99; ignoring ${String(configuredPercent)}`,
			);
		}
	}

	// Legacy numeric configs (compactAfterTokens) are ignored; the percent threshold applies.

	return merged;
}

export function resolveCompactAfterTokens(
	config: UnifiedConfig,
	contextWindow: number | undefined,
	warn?: (message: string) => void,
): number | undefined {
	if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
		warn?.(
			"blackhole: percentage threshold requires a positive active model context window; skipping automatic compaction",
		);
		return undefined;
	}
	return Math.floor(contextWindow * (config.compactAfterPercent / 100));
}

export function saveConfig(patch: Partial<UnifiedConfig>): UnifiedConfig {
	const current = loadConfig();
	const next = { ...current, ...patch };
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return loadConfig();
}

export const getConfigPath = configPath;
