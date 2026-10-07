import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyChildDelta } from "../src/subagents/isolation/apply.ts";
import { persistWorktreePatch, validateWorktreePatch } from "../src/subagents/isolation/patch-state.ts";
import {
	captureWorktreeBaseline,
	computeChildDelta,
	createIsolatedWorktree,
	removeIsolatedWorktree,
	WorktreeIsolationError,
} from "../src/subagents/isolation/worktree.ts";

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd })
		.toString()
		.trim();
}

function write(path: string, content: string | Buffer): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/** Repo with committed a.txt/b.txt, then parent WIP: staged edit, unstaged edit, untracked file. */
function dirtyRepo() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ice-wt-")));
	temps.push(root);
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q");
	write(join(repo, "a.txt"), "a1\na2\na3\na4\na5\n");
	write(join(repo, "b.txt"), "b\n");
	write(join(repo, ".gitignore"), "ignored.log\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
	write(join(repo, "b.txt"), "b staged\n");
	git(repo, "add", "b.txt");
	write(join(repo, "a.txt"), "a1 parent\na2\na3\na4\na5\n");
	write(join(repo, "wip/new.txt"), "untracked wip\n");
	write(join(repo, "ignored.log"), "noise\n");
	return { root, repo, worktree: join(root, "wt") };
}

const indexOf = (repo: string) => readFileSync(git(repo, "rev-parse", "--path-format=absolute", "--git-path", "index"));
const verified = { verify: async () => ({ status: "passed" as const }) };

describe("subagent V2 worktree isolation", () => {
	it("gives the child the exact dirty parent tree without touching the parent index", () => {
		const { repo, worktree } = dirtyRepo();
		const indexBefore = indexOf(repo);
		const baseline = captureWorktreeBaseline(join(repo, "wip"));
		expect(baseline.cwdOffset).toBe("wip");
		createIsolatedWorktree(baseline, worktree);
		expect(readFileSync(join(worktree, "a.txt"), "utf8")).toBe("a1 parent\na2\na3\na4\na5\n");
		expect(readFileSync(join(worktree, "b.txt"), "utf8")).toBe("b staged\n");
		expect(readFileSync(join(worktree, "wip/new.txt"), "utf8")).toBe("untracked wip\n");
		expect(existsSync(join(worktree, "ignored.log"))).toBe(false);
		expect(indexOf(repo)).toEqual(indexBefore);
		expect(git(repo, "status", "--porcelain")).toContain("?? wip/");
		removeIsolatedWorktree(repo, worktree);
		expect(existsSync(worktree)).toBe(false);
	});

	it("refuses child worktrees inside the parent without creating ownership metadata", () => {
		const { repo } = dirtyRepo();
		const destination = join(repo, "nested-child");
		expect(() => createIsolatedWorktree(captureWorktreeBaseline(repo), destination)).toThrow(
			/outside the parent repository/,
		);
		expect(existsSync(destination)).toBe(false);
		expect(existsSync(`${destination}.ice-owner.json`)).toBe(false);
	});

	it("attributes only the child's own changes to its delta", () => {
		const { repo, worktree } = dirtyRepo();
		const baseline = captureWorktreeBaseline(repo);
		createIsolatedWorktree(baseline, worktree);
		write(join(worktree, "a.txt"), "a1 parent\na2\na3\na4\na5 child\n");
		write(join(worktree, "c.txt"), "child new\n");
		git(worktree, "add", "c.txt");
		git(worktree, "commit", "-q", "-m", "child commit");
		const delta = computeChildDelta(baseline, worktree);
		expect(delta.empty).toBe(false);
		expect(delta.changedPaths).toEqual([
			{ status: "M", path: "a.txt" },
			{ status: "A", path: "c.txt" },
		]);
		expect(delta.patch).toContain("+a5 child");
		expect(delta.patch).not.toMatch(/^[-+]a1/m);
		expect(delta.patch).not.toContain("untracked wip");
		expect(computeChildDelta(baseline, worktree).finalTree).toBe(delta.finalTree);
	});

	it("applies onto an unchanged parent, preserving its WIP and index", async () => {
		const { repo, worktree } = dirtyRepo();
		const indexBefore = indexOf(repo);
		const baseline = captureWorktreeBaseline(repo);
		createIsolatedWorktree(baseline, worktree);
		write(join(worktree, "a.txt"), "a1 parent\na2\na3\na4\na5 child\n");
		write(join(worktree, "bin.dat"), Buffer.from([0, 1, 2, 255]));
		const delta = computeChildDelta(baseline, worktree);
		expect(await applyChildDelta(baseline, delta.finalTree, verified)).toMatchObject({
			status: "applied",
			writtenPaths: ["a.txt", "bin.dat"],
			verification: { status: "passed" },
		});
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a1 parent\na2\na3\na4\na5 child\n");
		expect([...readFileSync(join(repo, "bin.dat"))]).toEqual([0, 1, 2, 255]);
		expect(readFileSync(join(repo, "wip/new.txt"), "utf8")).toBe("untracked wip\n");
		expect(indexOf(repo)).toEqual(indexBefore);
	});

	it("preserves non-UTF-8 textual patch bytes in the pinned artifact and integration", async () => {
		const { root, repo, worktree } = dirtyRepo();
		write(join(repo, "raw.txt"), Buffer.from([0x61, 0xff, 0x0a]));
		const baseline = captureWorktreeBaseline(repo);
		createIsolatedWorktree(baseline, worktree);
		write(join(worktree, "raw.txt"), Buffer.from([0x62, 0xff, 0x0a]));
		const delta = computeChildDelta(baseline, worktree);
		expect(delta.patchBytes.includes(0xff)).toBe(true);
		const directory = join(root, "patches");
		const artifact = persistWorktreePatch(directory, baseline, worktree, "contract", delta);
		expect(readFileSync(artifact.patchRef)).toEqual(delta.patchBytes);
		expect(validateWorktreePatch(artifact, directory, baseline, "contract").patchBytes).toEqual(delta.patchBytes);
		expect(await applyChildDelta(baseline, delta.finalTree, verified)).toMatchObject({ status: "applied" });
		expect(readFileSync(join(repo, "raw.txt"))).toEqual(Buffer.from([0x62, 0xff, 0x0a]));
	});

	it("explicitly refuses file/directory replacements without parent effects", async () => {
		const { repo, worktree } = dirtyRepo();
		const baseline = captureWorktreeBaseline(repo);
		createIsolatedWorktree(baseline, worktree);
		rmSync(join(worktree, "a.txt"));
		write(join(worktree, "a.txt/new.txt"), "child\n");
		expect(() => computeChildDelta(baseline, worktree)).toThrow(/file\/directory replacements are unsupported/);
		rmSync(join(worktree, "a.txt"), { recursive: true });
		write(join(worktree, "a.txt"), readFileSync(join(repo, "a.txt")));
		rmSync(join(worktree, "wip"), { recursive: true });
		write(join(worktree, "wip"), "replacement\n");
		git(worktree, "add", "-A");
		const index = indexOf(repo);
		await expect(
			applyChildDelta(baseline, computeChildDelta(baseline, worktree).finalTree, verified),
		).rejects.toThrow(/file\/directory replacements are unsupported/);
		expect(readFileSync(join(repo, "wip/new.txt"), "utf8")).toBe("untracked wip\n");
		expect(indexOf(repo)).toEqual(index);
	});

	it("rolls back when durable apply acknowledgement fails", async () => {
		const { repo, worktree } = dirtyRepo();
		const before = readFileSync(join(repo, "a.txt"));
		const index = indexOf(repo);
		const baseline = captureWorktreeBaseline(repo);
		createIsolatedWorktree(baseline, worktree);
		write(join(worktree, "a.txt"), "child\n");
		expect(
			await applyChildDelta(baseline, computeChildDelta(baseline, worktree).finalTree, {
				...verified,
				commit: () => {
					throw new Error("ack failed");
				},
			}),
		).toMatchObject({ status: "verification_failed", details: "ack failed" });
		expect(readFileSync(join(repo, "a.txt"))).toEqual(before);
		expect(indexOf(repo)).toEqual(index);
	});

	it("preserves newer staging performed during verification", async () => {
		const { repo, worktree } = dirtyRepo();
		const before = readFileSync(join(repo, "a.txt"));
		const baseline = captureWorktreeBaseline(repo);
		createIsolatedWorktree(baseline, worktree);
		write(join(worktree, "a.txt"), "child\n");
		let staged: Buffer | undefined;
		expect(
			await applyChildDelta(baseline, computeChildDelta(baseline, worktree).finalTree, {
				verify: async () => {
					git(repo, "add", "a.txt");
					staged = indexOf(repo);
					return { status: "passed" };
				},
			}),
		).toMatchObject({ status: "verification_failed", details: expect.stringContaining("index changed") });
		expect(indexOf(repo)).toEqual(staged);
		expect(readFileSync(join(repo, "a.txt"))).toEqual(before);
		expect(git(repo, "show", ":a.txt")).toBe("child");
	});

	it("merges non-overlapping concurrent parent edits and keeps unrelated ones", async () => {
		const { repo, worktree } = dirtyRepo();
		const baseline = captureWorktreeBaseline(repo);
		createIsolatedWorktree(baseline, worktree);
		write(join(worktree, "a.txt"), "a1 parent\na2\na3\na4\na5 child\n");
		const delta = computeChildDelta(baseline, worktree);
		// Parent keeps working after the spawn.
		write(join(repo, "a.txt"), "a1 parent again\na2\na3\na4\na5\n");
		write(join(repo, "later.txt"), "parent later\n");
		expect(await applyChildDelta(baseline, delta.finalTree, verified)).toMatchObject({
			status: "applied",
			writtenPaths: ["a.txt"],
		});
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a1 parent again\na2\na3\na4\na5 child\n");
		expect(readFileSync(join(repo, "later.txt"), "utf8")).toBe("parent later\n");
	});

	it("reports a true conflict and writes nothing", async () => {
		const { repo, worktree } = dirtyRepo();
		const baseline = captureWorktreeBaseline(repo);
		createIsolatedWorktree(baseline, worktree);
		write(join(worktree, "a.txt"), "a1 child\na2\na3\na4\na5\n");
		const delta = computeChildDelta(baseline, worktree);
		write(join(repo, "a.txt"), "a1 parent conflicting\na2\na3\na4\na5\n");
		const outcome = await applyChildDelta(baseline, delta.finalTree, verified);
		expect(outcome.status).toBe("conflict");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a1 parent conflicting\na2\na3\na4\na5\n");
	});

	it("rolls back a failed verifier without disturbing parent staging or WIP", async () => {
		const { repo, worktree } = dirtyRepo();
		const before = readFileSync(join(repo, "a.txt"));
		const index = indexOf(repo);
		const baseline = captureWorktreeBaseline(repo);
		createIsolatedWorktree(baseline, worktree);
		write(join(worktree, "a.txt"), "child\n");
		write(join(worktree, "nested/new.txt"), "new\n");
		const delta = computeChildDelta(baseline, worktree);
		const result = await applyChildDelta(baseline, delta.finalTree, {
			verify: async () => ({ status: "failed", exitCode: 7 }),
		});
		expect(result.status).toBe("verification_failed");
		expect(readFileSync(join(repo, "a.txt"))).toEqual(before);
		expect(existsSync(join(repo, "nested/new.txt"))).toBe(false);
		expect(indexOf(repo)).toEqual(index);
		expect(readFileSync(join(repo, "wip/new.txt"), "utf8")).toBe("untracked wip\n");
	});

	it("preserves newer verifier edits instead of overwriting them during rollback", async () => {
		const { repo, worktree } = dirtyRepo();
		const beforeB = readFileSync(join(repo, "b.txt"));
		const baseline = captureWorktreeBaseline(repo);
		createIsolatedWorktree(baseline, worktree);
		write(join(worktree, "a.txt"), "child a\n");
		write(join(worktree, "b.txt"), "child b\n");
		const result = await applyChildDelta(baseline, computeChildDelta(baseline, worktree).finalTree, {
			verify: async () => {
				write(join(repo, "a.txt"), "newer parent\n");
				return { status: "passed" };
			},
		});
		expect(result).toMatchObject({ status: "rollback_conflict", paths: ["a.txt"] });
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("newer parent\n");
		expect(readFileSync(join(repo, "b.txt"))).toEqual(beforeB);
	});

	it("refuses scoped/protected changes and symlinks before any write", async () => {
		const { root, repo, worktree } = dirtyRepo();
		const baseline = captureWorktreeBaseline(repo);
		createIsolatedWorktree(baseline, worktree);
		write(join(worktree, "b.txt"), "outside scope\n");
		await expect(
			applyChildDelta(baseline, computeChildDelta(baseline, worktree).finalTree, {
				...verified,
				scopeRoots: [join(repo, "wip")],
			}),
		).rejects.toThrow(/outside the frozen scope/);
		write(join(worktree, ".env"), "not a credential\n");
		await expect(
			applyChildDelta(baseline, computeChildDelta(baseline, worktree).finalTree, verified),
		).rejects.toThrow(/protected environment/);
		rmSync(join(worktree, ".env"));
		symlinkSync(root, join(worktree, "escape"));
		await expect(
			applyChildDelta(baseline, computeChildDelta(baseline, worktree).finalTree, verified),
		).rejects.toThrow(/symlinks/);
		expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("b staged\n");
	});

	it("preserves file modes and handles regular-file deletion", async () => {
		const { repo, worktree } = dirtyRepo();
		chmodSync(join(repo, "a.txt"), 0o600);
		const baseline = captureWorktreeBaseline(repo);
		createIsolatedWorktree(baseline, worktree);
		chmodSync(join(worktree, "a.txt"), 0o755);
		rmSync(join(worktree, "b.txt"));
		const index = indexOf(repo);
		expect(await applyChildDelta(baseline, computeChildDelta(baseline, worktree).finalTree, verified)).toMatchObject({
			status: "applied",
		});
		expect(statSync(join(repo, "a.txt")).mode & 0o777).toBe(0o711);
		expect(existsSync(join(repo, "b.txt"))).toBe(false);
		expect(indexOf(repo)).toEqual(index);
	});

	it("includes staged additions even if they subsequently become ignored", () => {
		const { repo, worktree } = dirtyRepo();
		write(join(repo, "staged.log"), "staged exact\n");
		git(repo, "add", "staged.log");
		write(join(repo, ".gitignore"), "*.log\n");
		createIsolatedWorktree(captureWorktreeBaseline(repo), worktree);
		expect(readFileSync(join(worktree, "staged.log"), "utf8")).toBe("staged exact\n");
	});

	it("refuses executable merge drivers and unowned cleanup", async () => {
		const { repo, worktree } = dirtyRepo();
		const baseline = captureWorktreeBaseline(repo);
		createIsolatedWorktree(baseline, worktree);
		write(join(worktree, "a.txt"), "child\n");
		git(repo, "config", "merge.trap.driver", "exit 99");
		await expect(
			applyChildDelta(baseline, computeChildDelta(baseline, worktree).finalTree, verified),
		).rejects.toThrow(/external merge drivers/);
		writeFileSync(`${worktree}.ice-owner.json`, JSON.stringify({ repoRoot: "/wrong", worktreePath: worktree }));
		expect(() => removeIsolatedWorktree(repo, worktree)).toThrow(/ownership/);
		expect(existsSync(worktree)).toBe(true);
	});

	it("snapshots raw bytes without running repository clean filters", () => {
		const { root, repo, worktree } = dirtyRepo();
		const marker = join(root, "filter-ran");
		const script = join(root, "filter.cjs");
		write(
			script,
			`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdin.pipe(process.stdout);`,
		);
		git(repo, "config", "filter.trap.clean", `${process.execPath} ${script}`);
		git(repo, "config", "filter.trap.smudge", `${process.execPath} ${script}`);
		write(join(repo, ".gitattributes"), "*.txt filter=trap text eol=crlf\n");
		write(join(repo, "raw.txt"), "raw\r\nbytes\r\n");
		const baseline = captureWorktreeBaseline(repo);
		expect(existsSync(marker)).toBe(false);
		createIsolatedWorktree(baseline, worktree);
		expect(existsSync(marker)).toBe(false);
		expect(readFileSync(join(worktree, "raw.txt"))).toEqual(readFileSync(join(repo, "raw.txt")));
	});

	it("does not execute post-checkout hooks when creating an isolated worktree", () => {
		const { root, repo, worktree } = dirtyRepo();
		const marker = join(root, "hook-ran");
		const hook = join(repo, ".git/hooks/post-checkout");
		write(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`);
		chmodSync(hook, 0o755);
		createIsolatedWorktree(captureWorktreeBaseline(repo), worktree);
		expect(existsSync(marker)).toBe(false);
	});

	it("bounds tracked dirty data as well as untracked data before capture", () => {
		const { repo } = dirtyRepo();
		truncateSync(join(repo, "a.txt"), 257 * 1024 * 1024);
		expect(() => captureWorktreeBaseline(repo)).toThrow(/snapshot.*byte/i);
	});

	it("refuses nested repositories and repositories without commits", () => {
		const { repo } = dirtyRepo();
		const nested = join(repo, "vendor/lib");
		mkdirSync(nested, { recursive: true });
		git(nested, "init", "-q");
		write(join(nested, "x.txt"), "x");
		expect(() => captureWorktreeBaseline(repo)).toThrow(WorktreeIsolationError);
		expect(() => captureWorktreeBaseline(repo)).toThrow(/nested repository vendor\/lib\//);
		const empty = realpathSync(mkdtempSync(join(tmpdir(), "ice-wt-empty-")));
		temps.push(empty);
		git(empty, "init", "-q");
		expect(() => captureWorktreeBaseline(empty)).toThrow(/at least one commit/);
	});
});
