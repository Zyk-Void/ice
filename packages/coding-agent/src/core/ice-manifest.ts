import { readFileSync } from "node:fs";

export interface IceManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

/** Which manifest field supplied the resources. */
export type CompatibleManifestSource = "ice" | "legacy-pi";

export interface CompatibleManifestResult {
	manifest: IceManifest;
	source: CompatibleManifestSource;
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a package resource manifest, accepting the legacy `pi` field as a
 * one-way compatibility input.
 *
 * Precedence is strict and never merges: `ice` wins by presence, even when it is
 * malformed or null, so an explicit `ice: null` stays a hard null rather than
 * silently downgrading to a valid `pi` block. The returned `source` lets callers
 * tell an ICE-native package from a legacy one without inspecting raw JSON.
 */
export function readCompatibleManifest(packageJsonPath: string): CompatibleManifestResult | null {
	try {
		const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		if (!isObject(pkg)) {
			return null;
		}
		// `ice` wins when present (even null/invalid: intentional, no fallback).
		// Fall back to the legacy `pi` field only when `ice` is absent entirely.
		const hasIce = "ice" in pkg;
		const resourceManifest = hasIce ? pkg.ice : pkg.pi;
		if (!isObject(resourceManifest)) return null;

		const manifest: IceManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = resourceManifest[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return { manifest, source: hasIce ? "ice" : "legacy-pi" };
	} catch {
		return null;
	}
}

/** Compatibility wrapper for callers that do not need provenance. */
export function readIceManifest(packageJsonPath: string): IceManifest | null {
	return readCompatibleManifest(packageJsonPath)?.manifest ?? null;
}
