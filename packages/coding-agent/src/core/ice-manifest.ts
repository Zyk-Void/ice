import { readFileSync } from "node:fs";

export interface IceManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readIceManifest(packageJsonPath: string): IceManifest | null {
	try {
		const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		if (!isObject(pkg)) {
			return null;
		}
		// `ice` wins when present (even null/invalid: intentional, no fallback).
		// Fall back to the legacy `pi` field only when `ice` is absent entirely.
		const resourceManifest = "ice" in pkg ? pkg.ice : pkg.pi;
		if (!isObject(resourceManifest)) return null;

		const manifest: IceManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = resourceManifest[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
