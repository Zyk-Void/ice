/**
 * Load Cognee-compatible env from ~/.cognee/.env (Claude/Codex shared file).
 * Only exposes non-secret routing keys into process resolution — never logs secrets.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeLegacyEnvironment } from "./core/legacy-compat/env.ts";

const COGNEE_ENV_KEYS = new Set([
	"COGNEE_API_KEY",
	"COGNEE_BASE_URL",
	"COGNEE_LOCAL_API_URL",
	"COGNEE_PLUGIN_DATASET",
	"COGNEE_DATASET",
	"COGNEE_SESSION_ID",
	"ICE_COGNEE_ENABLED",
	"ICE_COGNEE_RECALL",
	"ICE_COGNEE_REMEMBER",
	"ICE_COGNEE_CAPTURE",
	"ICE_COGNEE_CAPTURE_TOOLS",
	"ICE_COGNEE_IMPROVE",
	"ICE_COGNEE_BASE_URL",
	"ICE_COGNEE_DATASET",
]);

/** Parse KEY=VALUE lines (optional export prefix). Last value wins. */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const body = line.startsWith("export ") ? line.slice(7).trim() : line;
		const eq = body.indexOf("=");
		if (eq <= 0) continue;
		const key = body.slice(0, eq).trim();
		let value = body.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (COGNEE_ENV_KEYS.has(key) || key.startsWith("ICE_COGNEE_") || key.startsWith("COGNEE_")) {
			out[key] = value;
		}
	}
	return out;
}

/**
 * Merge file env under process env (process wins). Used so Claude's ~/.cognee/.env
 * supplies COGNEE_API_KEY / base URL when Ice was not launched with those exports.
 */
export async function loadMergedCogneeEnv(
	env: NodeJS.ProcessEnv = process.env,
	filePath = join(homedir(), ".cognee", ".env"),
): Promise<NodeJS.ProcessEnv> {
	let fileEnv: Record<string, string> = {};
	try {
		fileEnv = parseEnvFile(await readFile(filePath, "utf8"));
	} catch {
		fileEnv = {};
	}
	const merged: NodeJS.ProcessEnv = { ...normalizeLegacyEnvironment(fileEnv), ...normalizeLegacyEnvironment(env) };
	// Alias Claude local URL into our base URL if only LOCAL is set
	if (!merged.COGNEE_BASE_URL && !merged.ICE_COGNEE_BASE_URL && merged.COGNEE_LOCAL_API_URL) {
		merged.COGNEE_BASE_URL = merged.COGNEE_LOCAL_API_URL;
	}
	// Do not auto-map COGNEE_PLUGIN_DATASET (agent_sessions) — ICE default stays ice
	// unless ICE_COGNEE_DATASET or COGNEE_DATASET is set explicitly for Ice.
	return merged;
}

export function cogneeEnvPath(): string {
	return join(homedir(), ".cognee", ".env");
}
