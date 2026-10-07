/** Canonical path and scope helpers for subagent tools (moved from ice-subagents.ts). */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function isPathWithin(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(!isAbsolute(pathFromRoot) && !pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..")
	);
}

export function isApprovedSubagentPath(
	path: string,
	scopeRoots: readonly string[],
	resourceRoots: readonly string[] = [],
): boolean {
	return scopeRoots.some((root) => isPathWithin(root, path)) || resourceRoots.some((root) => isPathWithin(root, path));
}

export function uniquePaths(paths: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const path of paths) {
		if (seen.has(path)) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}

export function loadedSkillResourceReadRoots(skills: readonly { filePath: string }[]): string[] {
	const roots: string[] = [];
	for (const skill of skills) {
		let dir: string;
		try {
			dir = dirname(canonicalPath(skill.filePath));
		} catch {
			continue;
		}
		roots.push(dir);
	}
	return uniquePaths(roots);
}

export function canonicalPath(path: string): string {
	return realpathSync(path);
}

export function resolveScopeCandidate(candidate: string): string {
	let current = candidate;
	const suffix: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return candidate;
		suffix.unshift(basename(current));
		current = parent;
	}
	return resolve(canonicalPath(current), ...suffix);
}
