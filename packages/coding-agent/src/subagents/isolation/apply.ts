/** Baseline-aware V2 integration. Verifier and durable acknowledgement belong to the parent. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { type IceVerifierState, pathIsWithin, validateMutationPath } from "../../ice-safe-verify.ts";
import {
	deltaFromTree,
	readRawTree,
	resolveWorktreePath,
	snapshotWorktree,
	WORKTREE_LIMITS,
	type WorktreeBaseline,
	worktreeGit,
	worktreeGitText,
	worktreeIndexHash,
} from "./worktree.ts";

export type ApplyOutcome =
	| { status: "applied"; writtenPaths: string[]; verification: IceVerifierState }
	| { status: "empty" }
	| { status: "conflict"; details: string }
	| { status: "changed_during_apply"; path: string }
	| { status: "verification_failed"; details: string; verification?: IceVerifierState }
	| { status: "rollback_conflict"; details: string; paths: string[]; verification?: IceVerifierState };

export interface ApplyRecovery {
	repoRoot: string;
	indexHash: string;
	parentTree: string;
	paths: Array<{ path: string; before?: { base64: string; mode: number }; after?: { sha256: string; mode: number } }>;
}

export interface ApplyOptions {
	scopeRoots?: readonly string[];
	verify: (root: string) => Promise<IceVerifierState>;
	/** Recheck live authority before mutation and after the asynchronous verifier. */
	authorize?: () => void;
	/** Durable integration intent before effects. No interrupted apply is replayed. */
	beforeWrite?: (recovery: ApplyRecovery) => void;
	/** Failure here is an apply failure: rollback while preimages remain resident. */
	commit?: () => void;
}

interface FileImage {
	data: Buffer;
	mode: number;
}
interface Step {
	path: string;
	absolute: string;
	before?: FileImage;
	after?: FileImage;
}

function readImage(absolute: string): FileImage | undefined {
	try {
		const stat = lstatSync(absolute);
		if (!stat.isFile() || stat.isSymbolicLink())
			throw new Error(
				`Integration requires regular files: ${absolute}; file/directory replacements are unsupported`,
			);
		return { data: readFileSync(absolute), mode: stat.mode & 0o7777 };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function sameImage(left: FileImage | undefined, right: FileImage | undefined): boolean {
	return !left || !right ? left === right : left.mode === right.mode && left.data.equals(right.data);
}

function writeImage(step: Step, image: FileImage | undefined): void {
	if (!image) {
		rmSync(step.absolute, { force: true });
		return;
	}
	mkdirSync(dirname(step.absolute), { recursive: true });
	const temporary = join(dirname(step.absolute), `.ice-apply-${randomUUID()}`);
	try {
		writeFileSync(temporary, image.data, { flag: "wx", mode: image.mode });
		chmodSync(temporary, image.mode);
		renameSync(temporary, step.absolute);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function restoreImages(root: string, written: readonly Step[]): string[] {
	const conflicts: string[] = [];
	for (const step of [...written].reverse()) {
		try {
			resolveWorktreePath(root, step.path);
			const current = readImage(step.absolute);
			if (sameImage(current, step.before)) continue;
			if (!sameImage(current, step.after)) {
				conflicts.push(step.path);
				continue;
			}
			writeImage(step, step.before);
		} catch {
			conflicts.push(step.path);
		}
	}
	return conflicts;
}

async function lockPaths<T>(paths: readonly string[], operation: () => Promise<T>, index = 0): Promise<T> {
	if (index === paths.length) return operation();
	return withFileMutationQueue(paths[index]!, () => lockPaths(paths, operation, index + 1));
}

/**
 * Merge only the child delta. Preserve the index byte-for-byte, require successful
 * verification and postimages, and restore only our unchanged postimages on failure.
 * OS-level writers are not locked: pre/post checks are optimistic concurrency, not
 * an atomic filesystem transaction or a sandbox.
 */
export async function applyChildDelta(
	baseline: WorktreeBaseline,
	finalTree: string,
	options: ApplyOptions,
): Promise<ApplyOutcome> {
	if (!options || typeof options.verify !== "function")
		throw new Error("Patch apply requires a configured parent verifier.");
	const { repoRoot } = baseline;
	return withFileMutationQueue(join(repoRoot, ".git", "ice-v2-integration"), async () => {
		options.authorize?.();
		const delta = deltaFromTree(baseline, finalTree);
		if (delta.empty) {
			options.commit?.();
			return { status: "empty" };
		}
		const scopes = options.scopeRoots ?? [repoRoot];
		const finalEntries = new Map(readRawTree(repoRoot, finalTree).map((entry) => [entry.path, entry]));
		const baseEntries = new Map(readRawTree(repoRoot, baseline.baselineTree).map((entry) => [entry.path, entry]));
		for (const { path } of delta.changedPaths) {
			const absolute = resolveWorktreePath(repoRoot, path);
			if (!scopes.some((scope) => pathIsWithin(scope, absolute)))
				throw new Error(`Patch path is outside the frozen scope: ${path}`);
			const protectedReason = validateMutationPath(path, repoRoot, repoRoot);
			if (protectedReason) throw new Error(protectedReason);
			if (finalEntries.get(path)?.mode === "120000" || baseEntries.get(path)?.mode === "120000")
				throw new Error(`Patch symlinks are not supported: ${path}`);
		}
		// merge-tree can run a custom merge driver. Refuse that boundary rather than
		// executing repository-configured commands as an implicit isolation effect.
		const drivers = worktreeGit(repoRoot, ["config", "--get-regexp", "^merge\\..*\\.driver$"], { allowExit: [1] });
		if (drivers.stdout.length > 0) throw new Error("Patch integration refuses configured external merge drivers.");
		const indexBefore = worktreeIndexHash(repoRoot);
		const oursTree = snapshotWorktree(repoRoot);
		let resultTree = finalTree;
		if (oursTree !== baseline.baselineTree) {
			const oursCommit = worktreeGitText(repoRoot, [
				"commit-tree",
				oursTree,
				"-p",
				baseline.baselineCommit,
				"-m",
				"ice parent",
			]);
			const theirsCommit = worktreeGitText(repoRoot, [
				"commit-tree",
				finalTree,
				"-p",
				baseline.baselineCommit,
				"-m",
				"ice child",
			]);
			const merge = worktreeGit(
				repoRoot,
				[
					"merge-tree",
					"--write-tree",
					"--no-messages",
					`--merge-base=${baseline.baselineCommit}`,
					oursCommit,
					theirsCommit,
				],
				{ allowExit: [1] },
			);
			const lines = merge.stdout.toString("utf8").trim().split("\n");
			if (merge.status === 1) return { status: "conflict", details: lines.slice(1).join("\n").slice(0, 4096) };
			resultTree = lines[0]!;
		}
		const mergedEntries = new Map(readRawTree(repoRoot, resultTree).map((entry) => [entry.path, entry]));
		const oursEntries = new Map(readRawTree(repoRoot, oursTree).map((entry) => [entry.path, entry]));
		const changed = deltaFromTree({ ...baseline, baselineTree: oursTree }, resultTree).changedPaths;
		const allowedPaths = new Set(delta.changedPaths.map((entry) => entry.path));
		const steps: Step[] = changed.map(({ path }) => {
			if (!allowedPaths.has(path)) throw new Error(`Merge introduced a path outside the child delta: ${path}`);
			const absolute = resolveWorktreePath(repoRoot, path);
			const before = readImage(absolute);
			const ours = oursEntries.get(path);
			if (ours?.mode === "120000") throw new Error(`Parent integration path is a symlink: ${path}`);
			const actualBlob = before
				? worktreeGit(repoRoot, ["hash-object", "--no-filters", "--stdin"], { input: before.data })
						.stdout.toString("ascii")
						.trim()
				: undefined;
			if (actualBlob !== ours?.blob || (before && (before.mode & 0o111 ? "100755" : "100644") !== ours?.mode))
				throw new Error(`Parent path changed during reconciliation: ${path}`);
			const afterEntry = mergedEntries.get(path);
			if (afterEntry?.mode === "120000") throw new Error(`Merged path is a symlink: ${path}`);
			const mode =
				afterEntry?.mode === "100755" ? (before?.mode ?? 0o644) | 0o111 : (before?.mode ?? 0o644) & ~0o111;
			return {
				path,
				absolute,
				before,
				after: afterEntry
					? { data: worktreeGit(repoRoot, ["cat-file", "blob", afterEntry.blob]).stdout, mode }
					: undefined,
			};
		});
		if (
			steps.reduce((bytes, step) => bytes + (step.before?.data.length ?? 0) + (step.after?.data.length ?? 0), 0) >
			WORKTREE_LIMITS.maxTransactionBytes
		)
			throw new Error("Patch integration exceeds the transaction byte ceiling.");
		return lockPaths(steps.map((step) => step.absolute).sort(), async () => {
			if (worktreeIndexHash(repoRoot) !== indexBefore) return { status: "changed_during_apply", path: "Git index" };
			for (const step of steps) {
				resolveWorktreePath(repoRoot, step.path);
				if (!sameImage(readImage(step.absolute), step.before))
					return { status: "changed_during_apply", path: step.path };
			}
			options.authorize?.();
			options.beforeWrite?.({
				repoRoot,
				indexHash: indexBefore,
				parentTree: oursTree,
				paths: steps.map((step) => ({
					path: step.path,
					...(step.before
						? { before: { base64: step.before.data.toString("base64"), mode: step.before.mode } }
						: {}),
					...(step.after
						? {
								after: {
									sha256: createHash("sha256").update(step.after.data).digest("hex"),
									mode: step.after.mode,
								},
							}
						: {}),
				})),
			});
			const written: Step[] = [];
			let verification: IceVerifierState | undefined;
			try {
				for (const step of steps) {
					resolveWorktreePath(repoRoot, step.path);
					if (!sameImage(readImage(step.absolute), step.before))
						throw new Error(`Parent path changed during apply: ${step.path}`);
					writeImage(step, step.after);
					written.push(step);
				}
				verification = await options.verify(repoRoot);
				if (verification.status !== "passed")
					throw new Error(verification.failureMessage ?? `Verifier ${verification.status}`);
				options.authorize?.();
				for (const step of steps) {
					resolveWorktreePath(repoRoot, step.path);
					if (!sameImage(readImage(step.absolute), step.after))
						throw new Error(`Postimage changed during verification: ${step.path}`);
				}
				if (worktreeIndexHash(repoRoot) !== indexBefore)
					throw new Error("Parent index changed during verification; newer staging was preserved.");
				if (snapshotWorktree(repoRoot) !== resultTree)
					throw new Error("Parent working tree changed during verification; unrelated changes were preserved.");
				options.commit?.();
				return { status: "applied", writtenPaths: steps.map((step) => step.path), verification };
			} catch (error) {
				const details = error instanceof Error ? error.message : String(error);
				const paths = restoreImages(repoRoot, written);
				return paths.length > 0
					? { status: "rollback_conflict", details, paths, verification }
					: { status: "verification_failed", details, verification };
			}
		});
	});
}
