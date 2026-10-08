/**
 * V2 dirty-baseline worktrees. Raw blobs and a temporary index preserve the
 * logical working tree without filters, hooks, or writes to the real index.
 * Worktrees share Git objects; this is workspace isolation, not a sandbox.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	type Stats,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertNoSymlinkComponents } from "../tools/scoped-tools.ts";

export const WORKTREE_LIMITS = Object.freeze({
	maxSnapshotBytes: 256 * 1024 * 1024,
	maxSnapshotFiles: 20_000,
	maxUntrackedBytes: 64 * 1024 * 1024,
	maxUntrackedFiles: 20_000,
	maxChangedFiles: 512,
	maxPatchBytes: 8 * 1024 * 1024,
	maxTransactionBytes: 16 * 1024 * 1024,
});

export class WorktreeIsolationError extends Error {
	readonly code:
		| "not_a_repository"
		| "no_commits"
		| "nested_repository"
		| "baseline_too_large"
		| "git_failed"
		| "unsafe_path"
		| "ownership";
	constructor(code: WorktreeIsolationError["code"], message: string) {
		super(message);
		this.code = code;
	}
}

/** Never inherit Git routing/config overrides from the parent shell. */
export function worktreeGit(
	cwd: string,
	args: readonly string[],
	options: { env?: Record<string, string>; input?: string | Buffer; allowExit?: number[] } = {},
): { stdout: Buffer; status: number } {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	try {
		const stdout = execFileSync(
			"git",
			[
				"-c",
				"core.quotepath=off",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"core.untrackedCache=false",
				"-c",
				"core.splitIndex=false",
				"-c",
				"merge.renormalize=false",
				...args,
			],
			{
				cwd,
				env: {
					...env,
					GIT_AUTHOR_NAME: "ice-subagent",
					GIT_AUTHOR_EMAIL: "ice-subagent@localhost",
					GIT_COMMITTER_NAME: "ice-subagent",
					GIT_COMMITTER_EMAIL: "ice-subagent@localhost",
					GIT_TERMINAL_PROMPT: "0",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_ATTR_NOSYSTEM: "1",
					GIT_NO_LAZY_FETCH: "1",
					...options.env,
				},
				input: options.input,
				maxBuffer:
					args[0] === "cat-file" ? WORKTREE_LIMITS.maxSnapshotBytes : WORKTREE_LIMITS.maxPatchBytes + 1024 * 1024,
				timeout: 60_000,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		return { stdout, status: 0 };
	} catch (error) {
		const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
		if (failure.status !== undefined && options.allowExit?.includes(failure.status))
			return { stdout: failure.stdout ?? Buffer.alloc(0), status: failure.status };
		throw new WorktreeIsolationError(
			"git_failed",
			`git ${args[0]} failed: ${failure.stderr?.toString("utf8").trim().slice(0, 4096) || String(error)}`,
		);
	}
}

export function worktreeGitText(cwd: string, args: readonly string[], env?: Record<string, string>): string {
	return worktreeGit(cwd, args, env ? { env } : {})
		.stdout.toString("utf8")
		.trim();
}

function splitZ(bytes: Buffer): string[] {
	const decoded = bytes.toString("utf8");
	if (!Buffer.from(decoded).equals(bytes))
		throw new WorktreeIsolationError("unsafe_path", "Git paths must be valid UTF-8.");
	return decoded.split("\0").filter(Boolean);
}

/** No symlink ancestors, nested repositories, metadata paths, or lexical escapes. */
export function resolveWorktreePath(root: string, path: string): string {
	if (
		!path ||
		path.split(/[\\/]/).some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
		path.includes("\0")
	)
		throw new WorktreeIsolationError("unsafe_path", `Unsafe patch path: ${path}`);
	const absolute = resolve(root, path);
	if (!absolute.startsWith(`${root}${sep}`))
		throw new WorktreeIsolationError("unsafe_path", `Path escapes repository: ${path}`);
	assertNoSymlinkComponents(dirname(absolute));
	let ancestor = dirname(absolute);
	while (ancestor !== root) {
		if (existsSync(join(ancestor, ".git")))
			throw new WorktreeIsolationError("nested_repository", `Path crosses nested repository: ${path}`);
		ancestor = dirname(ancestor);
	}
	return absolute;
}

export interface RawTreeEntry {
	path: string;
	mode: "100644" | "100755" | "120000";
	blob: string;
}

export function readRawTree(root: string, tree: string): RawTreeEntry[] {
	return splitZ(worktreeGit(root, ["ls-tree", "-r", "-z", tree]).stdout).map((record) => {
		const tab = record.indexOf("\t");
		const [mode, type, blob] = record.slice(0, tab).split(" ");
		const path = record.slice(tab + 1);
		if (type !== "blob" || !["100644", "100755", "120000"].includes(mode!))
			throw new WorktreeIsolationError("nested_repository", `Unsupported tree entry: ${path}`);
		resolveWorktreePath(root, path);
		return { path, mode: mode as RawTreeEntry["mode"], blob: blob! };
	});
}

/** Bound all data before reading it; neither clean filters nor fsmonitor run. */
export function snapshotWorktree(root: string): string {
	const cached = splitZ(worktreeGit(root, ["ls-files", "--stage", "-z"]).stdout);
	if (cached.some((entry) => entry.startsWith("160000 ") || !/^\d+ [0-9a-f]+ 0\t/.test(entry)))
		throw new WorktreeIsolationError(
			"nested_repository",
			"Worktree isolation refuses submodules and unmerged indexes.",
		);
	const untracked = splitZ(worktreeGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout);
	const nested = untracked.find((path) => path.endsWith("/"));
	if (nested)
		throw new WorktreeIsolationError(
			"nested_repository",
			`Worktree isolation does not cross nested repository ${nested}`,
		);
	if (untracked.length > WORKTREE_LIMITS.maxUntrackedFiles)
		throw new WorktreeIsolationError("baseline_too_large", "Too many untracked files.");
	const paths = [...new Set([...cached.map((entry) => entry.slice(entry.indexOf("\t") + 1)), ...untracked])].sort();
	if (paths.length > WORKTREE_LIMITS.maxSnapshotFiles)
		throw new WorktreeIsolationError("baseline_too_large", "Too many snapshot files.");
	const untrackedSet = new Set(untracked);
	let bytes = 0;
	let untrackedBytes = 0;
	const files: Array<{ path: string; absolute: string; size: number; mode: RawTreeEntry["mode"] }> = [];
	for (const path of paths) {
		const absolute = resolveWorktreePath(root, path);
		let stat: Stats;
		try {
			stat = lstatSync(absolute);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!stat.isFile() && !stat.isSymbolicLink())
			throw new WorktreeIsolationError(
				"unsafe_path",
				`Snapshot path is not a file: ${path}; file/directory replacements are unsupported`,
			);
		bytes += stat.size;
		if (untrackedSet.has(path)) untrackedBytes += stat.size;
		if (bytes > WORKTREE_LIMITS.maxSnapshotBytes || untrackedBytes > WORKTREE_LIMITS.maxUntrackedBytes)
			throw new WorktreeIsolationError(
				"baseline_too_large",
				"Snapshot exceeds the hard byte ceiling; commit or ignore large files first.",
			);
		files.push({
			path,
			absolute,
			size: stat.size,
			mode: stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644",
		});
	}
	const dir = mkdtempSync(join(tmpdir(), "ice-index-"));
	try {
		const env = { GIT_INDEX_FILE: join(dir, "index") };
		worktreeGit(root, ["read-tree", "--empty"], { env });
		const entries = files.map((file) => {
			const content =
				file.mode === "120000" ? Buffer.from(readlinkSync(file.absolute)) : readFileSync(file.absolute);
			if (content.length !== file.size)
				throw new WorktreeIsolationError("git_failed", `File changed during snapshot: ${file.path}`);
			const blob = worktreeGit(root, ["hash-object", "-w", "--no-filters", "--stdin"], { input: content })
				.stdout.toString("ascii")
				.trim();
			return `${file.mode} ${blob}\t${file.path}\0`;
		});
		worktreeGit(root, ["update-index", "-z", "--index-info"], { env, input: entries.join("") });
		return worktreeGitText(root, ["write-tree"], env);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export interface WorktreeBaseline {
	repoRoot: string;
	headCommit: string;
	baselineCommit: string;
	baselineTree: string;
	cwdOffset: string;
}

export function captureWorktreeBaseline(cwd: string): WorktreeBaseline {
	let repoRoot: string;
	try {
		repoRoot = realpathSync(worktreeGitText(cwd, ["rev-parse", "--show-toplevel"]));
	} catch {
		throw new WorktreeIsolationError("not_a_repository", "Worktree isolation needs a git repository.");
	}
	let headCommit: string;
	try {
		headCommit = worktreeGitText(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
	} catch {
		throw new WorktreeIsolationError("no_commits", "Worktree isolation needs at least one commit.");
	}
	const baselineTree = snapshotWorktree(repoRoot);
	const baselineCommit = worktreeGitText(repoRoot, [
		"commit-tree",
		baselineTree,
		"-p",
		headCommit,
		"-m",
		"ice subagent baseline",
	]);
	const offset = relative(repoRoot, realpathSync(cwd));
	return { repoRoot, headCommit, baselineCommit, baselineTree, cwdOffset: offset.split(sep).join("/") };
}

export interface WorktreeOwner {
	repoRoot: string;
	worktreePath: string;
	baselineCommit: string;
}
const ownerFile = (path: string) => `${path}.ice-owner.json`;

/** Create without checkout (no filters/hooks); materialize and verify raw bytes. */
export function createIsolatedWorktree(baseline: WorktreeBaseline, worktreePath: string): void {
	worktreePath = resolve(worktreePath);
	assertNoSymlinkComponents(worktreePath);
	if (worktreePath === baseline.repoRoot || worktreePath.startsWith(`${baseline.repoRoot}${sep}`))
		throw new WorktreeIsolationError("ownership", "Isolated worktrees must live outside the parent repository.");
	if (existsSync(worktreePath)) throw new WorktreeIsolationError("ownership", "Worktree destination already exists.");
	mkdirSync(dirname(worktreePath), { recursive: true, mode: 0o700 });
	const owner: WorktreeOwner = { repoRoot: baseline.repoRoot, worktreePath, baselineCommit: baseline.baselineCommit };
	writeFileSync(ownerFile(worktreePath), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
	try {
		worktreeGit(baseline.repoRoot, [
			"worktree",
			"add",
			"--detach",
			"--no-checkout",
			"--quiet",
			worktreePath,
			baseline.baselineCommit,
		]);
		for (const entry of readRawTree(worktreePath, baseline.baselineTree)) {
			const absolute = resolveWorktreePath(worktreePath, entry.path);
			mkdirSync(dirname(absolute), { recursive: true });
			const content = worktreeGit(baseline.repoRoot, ["cat-file", "blob", entry.blob]).stdout;
			if (entry.mode === "120000") symlinkSync(content.toString("utf8"), absolute);
			else {
				writeFileSync(absolute, content);
				chmodSync(absolute, entry.mode === "100755" ? 0o755 : 0o644);
			}
		}
		worktreeGit(worktreePath, ["read-tree", baseline.baselineTree]);
		if (snapshotWorktree(worktreePath) !== baseline.baselineTree)
			throw new WorktreeIsolationError("git_failed", "Materialized worktree differs from the captured baseline.");
	} catch (error) {
		if (existsSync(join(worktreePath, ".git"))) removeIsolatedWorktree(baseline.repoRoot, worktreePath);
		else rmSync(ownerFile(worktreePath), { force: true });
		throw error;
	}
}

export function assertOwnedWorktree(repoRoot: string, worktreePath: string): void {
	assertNoSymlinkComponents(worktreePath);
	assertNoSymlinkComponents(ownerFile(worktreePath));
	const owner = JSON.parse(readFileSync(ownerFile(worktreePath), "utf8")) as WorktreeOwner;
	if (
		owner.repoRoot !== repoRoot ||
		owner.worktreePath !== resolve(worktreePath) ||
		!/^[0-9a-f]{40,64}$/.test(owner.baselineCommit)
	)
		throw new WorktreeIsolationError("ownership", "Worktree ownership marker does not match.");
	const listed = splitZ(worktreeGit(repoRoot, ["worktree", "list", "--porcelain", "-z"]).stdout);
	if (!listed.includes(`worktree ${resolve(worktreePath)}`))
		throw new WorktreeIsolationError("ownership", "Worktree is not registered to its owning repository.");
}

/** The ownership marker of a host-owned isolated worktree; undefined when it is missing or malformed. */
export function readWorktreeOwner(worktreePath: string): WorktreeOwner | undefined {
	try {
		const owner = JSON.parse(readFileSync(ownerFile(worktreePath), "utf8")) as Partial<WorktreeOwner>;
		return typeof owner.repoRoot === "string" &&
			typeof owner.worktreePath === "string" &&
			typeof owner.baselineCommit === "string"
			? { repoRoot: owner.repoRoot, worktreePath: owner.worktreePath, baselineCommit: owner.baselineCommit }
			: undefined;
	} catch {
		return undefined;
	}
}

/** True when an owned worktree differs from the baseline it started from, i.e. it holds work not yet applied. */
export function worktreeHasChanges(worktreePath: string, owner: WorktreeOwner): boolean {
	return (
		snapshotWorktree(worktreePath) !==
		worktreeGitText(owner.repoRoot, ["rev-parse", `${owner.baselineCommit}^{tree}`])
	);
}

/** Shared GC root, keyed by the exact owned path rather than a model-selected name. */
export function worktreeSnapshotRef(worktreePath: string): string {
	return `refs/ice/subagent-v2/worktrees/${createHash("sha256").update(resolve(worktreePath)).digest("hex")}`;
}

/** Force removal is permitted only for an exact host-owned isolated worktree. */
export function removeIsolatedWorktree(repoRoot: string, worktreePath: string): void {
	assertOwnedWorktree(repoRoot, worktreePath);
	worktreeGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
	worktreeGit(repoRoot, ["update-ref", "-d", worktreeSnapshotRef(worktreePath)]);
	rmSync(ownerFile(worktreePath));
}

export interface ChildDelta {
	finalTree: string;
	empty: boolean;
	changedPaths: Array<{ status: string; path: string }>;
	/** Byte-exact proposal; patch is a lossy display preview only. */
	patchBytes: Buffer;
	patch: string;
	patchTruncated: boolean;
}

/** Raw binary-capable patch; oversized proposals fail rather than apply hidden data. */
export function deltaFromTree(baseline: WorktreeBaseline, finalTree: string): ChildDelta {
	const fields = splitZ(
		worktreeGit(baseline.repoRoot, [
			"diff-tree",
			"-r",
			"--no-renames",
			"--name-status",
			"-z",
			baseline.baselineTree,
			finalTree,
		]).stdout,
	);
	const changedPaths: ChildDelta["changedPaths"] = [];
	for (let index = 0; index < fields.length; index += 2)
		changedPaths.push({ status: fields[index]!, path: fields[index + 1]! });
	if (changedPaths.length > WORKTREE_LIMITS.maxChangedFiles)
		throw new WorktreeIsolationError("baseline_too_large", "Child delta exceeds the changed-file ceiling.");
	const patch = worktreeGit(baseline.repoRoot, [
		"diff-tree",
		"-r",
		"-p",
		"--binary",
		"--no-renames",
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		baseline.baselineTree,
		finalTree,
	]).stdout;
	if (patch.length > WORKTREE_LIMITS.maxPatchBytes)
		throw new WorktreeIsolationError("baseline_too_large", "Child delta exceeds the patch byte ceiling.");
	return {
		finalTree,
		empty: changedPaths.length === 0,
		changedPaths,
		patchBytes: patch,
		patch: patch.toString("utf8"),
		patchTruncated: false,
	};
}

export function computeChildDelta(baseline: WorktreeBaseline, worktreePath: string): ChildDelta {
	assertOwnedWorktree(baseline.repoRoot, worktreePath);
	return deltaFromTree(baseline, snapshotWorktree(worktreePath));
}

/** Exact real-index digest, including flags and staging metadata. */
export function worktreeIndexHash(repoRoot: string): string {
	const path = worktreeGitText(repoRoot, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
