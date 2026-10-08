import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureWorktreeBaseline, createIsolatedWorktree } from "../src/subagents/isolation/worktree.ts";
import { runAgentsCli } from "../src/subagents/v2/cli.ts";
import { PRUNE_RECENT_MS, pruneOrphanedSubagents } from "../src/subagents/v2/prune.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ice-prune-"));
	roots.push(root);
	const repo = join(root, "repo");
	mkdirSync(repo);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	writeFileSync(join(repo, "a.txt"), "base\n");
	execFileSync("git", ["add", "a.txt"], { cwd: repo });
	execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "init"], {
		cwd: repo,
	});
	const sessionsRoot = join(root, "sessions");
	const sessionDir = join(sessionsRoot, "--project--");
	mkdirSync(sessionDir, { recursive: true });
	/** A subagent folder for `parentId`, with one transcript and optionally one isolated worktree. */
	const childFolder = (parentId: string, worktree?: "clean" | "changed") => {
		const folder = join(sessionDir, "subagents", parentId);
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, `2026-10-08T00-00-00-000Z_ag_${parentId}.jsonl`), "{}\n");
		if (worktree) {
			const worktreePath = join(folder, "worktrees", `ag_${parentId}`);
			createIsolatedWorktree(captureWorktreeBaseline(repo), worktreePath);
			if (worktree === "changed") writeFileSync(join(worktreePath, "a.txt"), "child work\n");
		}
		return folder;
	};
	const later = Date.now() + PRUNE_RECENT_MS + 60_000;
	return { repo, sessionsRoot, sessionDir, childFolder, later };
}

const worktreeCount = (repo: string) =>
	execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })
		.split("\n")
		.filter((line) => line.startsWith("worktree ")).length;

describe("ice agents prune", () => {
	it("lists orphaned folders without deleting them unless applied", () => {
		const { sessionsRoot, sessionDir, childFolder, later } = fixture();
		writeFileSync(join(sessionDir, "2026-10-08T00-00-00-000Z_live.jsonl"), "{}\n");
		const live = childFolder("live");
		const orphan = childFolder("gone");

		const dry = pruneOrphanedSubagents({ sessionsRoot, apply: false, now: later });
		expect(dry.folders).toEqual([expect.objectContaining({ path: orphan, action: "remove", transcripts: 1 })]);
		expect(existsSync(orphan)).toBe(true);

		const applied = pruneOrphanedSubagents({ sessionsRoot, apply: true, now: later });
		expect(applied.folders[0]).toMatchObject({ path: orphan, action: "remove" });
		expect(existsSync(orphan)).toBe(false);
		expect(existsSync(live)).toBe(true);
	});

	it("keeps a parent's children when the parent session moved to another session directory", () => {
		const { sessionsRoot, childFolder, later } = fixture();
		const other = join(sessionsRoot, "--other--");
		mkdirSync(other);
		writeFileSync(join(other, "2026-10-08T00-00-00-000Z_moved.jsonl"), "{}\n");
		const folder = childFolder("moved");
		expect(pruneOrphanedSubagents({ sessionsRoot, apply: true, now: later }).folders).toEqual([]);
		expect(existsSync(folder)).toBe(true);
	});

	it("skips folders changed in the last 10 minutes", () => {
		const { sessionsRoot, childFolder } = fixture();
		const folder = childFolder("fresh");
		const result = pruneOrphanedSubagents({ sessionsRoot, apply: true });
		expect(result.folders[0]).toMatchObject({ action: "keep", reasons: ["changed in the last 10 minutes"] });
		expect(existsSync(folder)).toBe(true);
	});

	it("removes clean worktrees through git and keeps worktrees with unapplied changes", () => {
		const { repo, sessionsRoot, childFolder, later } = fixture();
		const clean = childFolder("clean", "clean");
		const changed = childFolder("changed", "changed");
		expect(worktreeCount(repo)).toBe(3);

		const result = pruneOrphanedSubagents({ sessionsRoot, apply: true, now: later });
		const byPath = new Map(result.folders.map((folder) => [folder.path, folder]));
		expect(byPath.get(clean)).toMatchObject({ action: "remove", worktrees: 1 });
		expect(byPath.get(changed)).toMatchObject({ action: "keep" });
		expect(byPath.get(changed)!.reasons[0]).toContain("unapplied changes");
		expect(existsSync(clean)).toBe(false);
		expect(existsSync(changed)).toBe(true);
		// The clean worktree is unregistered from the repository, the changed one is untouched.
		expect(worktreeCount(repo)).toBe(2);
	});

	it("runs as ice agents prune and prints the plan", () => {
		const { sessionsRoot, childFolder } = fixture();
		childFolder("fresh");
		const output = runAgentsCli(["prune"], { cwd: sessionsRoot, agentDir: sessionsRoot, sessionsRoot });
		expect(output.exitCode).toBe(0);
		expect(output.stdout).toContain("Kept:");
		expect(output.stdout).toContain("changed in the last 10 minutes");
		expect(runAgentsCli(["prune"], { cwd: sessionsRoot, agentDir: join(sessionsRoot, "none") }).stdout).toBe(
			"No orphaned subagent data found.\n",
		);
	});
});
