/**
 * `ice agents prune`: remove subagent data whose parent session no longer exists.
 *
 * Child transcripts live in `<session-dir>/subagents/<parent-session-id>/` and isolated worktrees in its
 * `worktrees/` folder. Deleting a parent session in the session selector removes only the parent file, so
 * these stay behind. Prune is explicit and conservative:
 * - dry run unless `apply` is set;
 * - a folder is orphaned only when no `*_<parent-id>.jsonl` exists in any session directory;
 * - folders changed in the last 10 minutes are skipped (a session may be starting);
 * - a worktree whose files differ from its baseline holds unapplied work: it and its folder are kept;
 * - symlinks and anything outside the subagents folder are refused.
 */
import { lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { readWorktreeOwner, removeIsolatedWorktree, worktreeHasChanges } from "../isolation/worktree.ts";

export const PRUNE_RECENT_MS = 10 * 60 * 1000;

export interface PruneFolder {
	/** Absolute `<session-dir>/subagents/<parent-id>` path. */
	path: string;
	parentSessionId: string;
	transcripts: number;
	worktrees: number;
	action: "remove" | "keep";
	/** Why a folder is kept; empty when it is (or would be) removed. */
	reasons: string[];
}

export interface PruneResult {
	applied: boolean;
	folders: PruneFolder[];
}

function isDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function listDirectory(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

/** Newest modification time of a folder and its direct entries. */
function latestChange(path: string): number {
	let latest = statSync(path).mtimeMs;
	for (const name of listDirectory(path)) {
		try {
			latest = Math.max(latest, lstatSync(join(path, name)).mtimeMs);
		} catch {
			// Removed while scanning.
		}
	}
	return latest;
}

/**
 * Find (and with `apply`, remove) orphaned subagent folders under every session directory in `sessionsRoot`
 * (normally `~/.ice/agent/sessions`).
 */
export function pruneOrphanedSubagents(options: { sessionsRoot: string; apply: boolean; now?: number }): PruneResult {
	const now = options.now ?? Date.now();
	const sessionsRoot = resolve(options.sessionsRoot);
	const sessionDirs = listDirectory(sessionsRoot)
		.map((name) => join(sessionsRoot, name))
		.filter(isDirectory);
	// Parent IDs that still have a session file anywhere: moved sessions keep their children.
	const liveParents = new Set<string>();
	for (const dir of sessionDirs)
		for (const name of listDirectory(dir)) {
			const match = /_([^_]+)\.jsonl$/.exec(name);
			if (match) liveParents.add(match[1]!);
		}

	const folders: PruneFolder[] = [];
	for (const dir of sessionDirs) {
		const subagentsDir = join(dir, "subagents");
		if (!isDirectory(subagentsDir)) continue;
		for (const parentSessionId of listDirectory(subagentsDir)) {
			if (liveParents.has(parentSessionId)) continue;
			const path = join(subagentsDir, parentSessionId);
			if (!isDirectory(path)) continue; // Symlinks and files are never followed or removed.
			const reasons: string[] = [];
			if (now - latestChange(path) < PRUNE_RECENT_MS) reasons.push("changed in the last 10 minutes");
			const transcripts = listDirectory(path).filter((name) => name.endsWith(".jsonl")).length;
			const worktreesDir = join(path, "worktrees");
			const worktreeNames = isDirectory(worktreesDir) ? listDirectory(worktreesDir) : [];
			const removable: Array<{ repoRoot: string; worktreePath: string }> = [];
			for (const name of worktreeNames) {
				const worktreePath = join(worktreesDir, name);
				if (name.endsWith(".ice-owner.json")) continue;
				if (!isDirectory(worktreePath)) {
					reasons.push(`${name}: not a plain directory`);
					continue;
				}
				const owner = readWorktreeOwner(worktreePath);
				if (!owner || resolve(owner.worktreePath) !== resolve(worktreePath)) {
					reasons.push(`${name}: no matching ownership marker`);
					continue;
				}
				try {
					if (worktreeHasChanges(worktreePath, owner)) {
						reasons.push(`${name}: unapplied changes in ${worktreePath}`);
						continue;
					}
				} catch (error) {
					reasons.push(`${name}: cannot inspect (${error instanceof Error ? error.message : String(error)})`);
					continue;
				}
				removable.push({ repoRoot: owner.repoRoot, worktreePath });
			}
			const folder: PruneFolder = {
				path,
				parentSessionId,
				transcripts,
				worktrees: worktreeNames.filter((name) => !name.endsWith(".ice-owner.json")).length,
				action: reasons.length === 0 ? "remove" : "keep",
				reasons,
			};
			folders.push(folder);
			if (!options.apply || folder.action === "keep") continue;
			try {
				for (const worktree of removable) removeIsolatedWorktree(worktree.repoRoot, worktree.worktreePath);
				// Containment: only this exact folder directly under the session directory's subagents folder.
				if (!resolve(path).startsWith(`${resolve(subagentsDir)}${sep}`))
					throw new Error("outside subagents folder");
				rmSync(path, { recursive: true });
			} catch (error) {
				folder.action = "keep";
				folder.reasons.push(`removal failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return { applied: options.apply, folders };
}

export function formatPruneResult(result: PruneResult): string {
	if (result.folders.length === 0) return "No orphaned subagent data found.";
	const removed = result.folders.filter((folder) => folder.action === "remove");
	const kept = result.folders.filter((folder) => folder.action === "keep");
	const describe = (folder: PruneFolder) =>
		`  ${folder.path} (${folder.transcripts} transcript${folder.transcripts === 1 ? "" : "s"}, ${folder.worktrees} worktree${folder.worktrees === 1 ? "" : "s"})`;
	const lines: string[] = [];
	if (removed.length > 0)
		lines.push(result.applied ? "Removed:" : "Would remove (run with --apply to delete):", ...removed.map(describe));
	if (kept.length > 0)
		lines.push(
			"Kept:",
			...kept.flatMap((folder) => [describe(folder), ...folder.reasons.map((reason) => `    - ${reason}`)]),
		);
	return lines.join("\n");
}
