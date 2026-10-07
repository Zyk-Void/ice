/** Host-owned immutable patch bytes. The journal pins identity; model arguments never supply a manifest. */
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathIsWithin } from "../../ice-safe-verify.ts";
import { assertNoSymlinkComponents } from "../tools/scoped-tools.ts";
import type { ApplyRecovery } from "./apply.ts";
import {
	type ChildDelta,
	deltaFromTree,
	WORKTREE_LIMITS,
	type WorktreeBaseline,
	worktreeGit,
	worktreeGitText,
	worktreeSnapshotRef,
} from "./worktree.ts";

export interface WorktreePatchArtifact {
	finalTree: string;
	baselineTree: string;
	contractHash: string;
	patchRef: string;
	patchSha256: string;
	patchBytes: number;
}

function writeDurableArtifact(path: string, bytes: string | Buffer, mode: number): void {
	const fd = openSync(path, "wx", mode);
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	if (process.platform !== "win32") {
		const directory = openSync(dirname(path), "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	}
}

export function persistWorktreePatch(
	directory: string,
	baseline: WorktreeBaseline,
	worktreePath: string,
	contractHash: string,
	delta: ChildDelta,
): WorktreePatchArtifact {
	directory = resolve(directory);
	assertNoSymlinkComponents(directory);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const canonical = realpathSync(directory);
	if (pathIsWithin(baseline.repoRoot, canonical) || pathIsWithin(worktreePath, canonical))
		throw new Error("Patch artifacts must live outside the parent and child worktrees.");
	const bytes = delta.patchBytes;
	if (bytes.length > WORKTREE_LIMITS.maxPatchBytes) throw new Error("Patch artifact exceeds the byte ceiling.");
	const patchSha256 = createHash("sha256").update(bytes).digest("hex");
	const patchRef = join(canonical, `${delta.finalTree}-${patchSha256}.patch`);
	try {
		writeDurableArtifact(patchRef, bytes, 0o444);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		assertNoSymlinkComponents(patchRef);
		if (!lstatSync(patchRef).isFile() || !readFileSync(patchRef).equals(bytes))
			throw new Error("Existing patch artifact was tampered with.");
	}
	// GC does not reliably enumerate linked-worktree private refs. A shared ref
	// pins both the final tree and its baseline; ownership-checked cleanup drops it.
	const pinnedCommit = worktreeGitText(worktreePath, [
		"commit-tree",
		delta.finalTree,
		"-p",
		baseline.baselineCommit,
		"-m",
		"ice inspected patch",
	]);
	worktreeGit(worktreePath, ["update-ref", worktreeSnapshotRef(worktreePath), pinnedCommit]);
	return Object.freeze({
		finalTree: delta.finalTree,
		baselineTree: baseline.baselineTree,
		contractHash,
		patchRef,
		patchSha256,
		patchBytes: bytes.length,
	});
}

/** Recovery preimages stay owner-private and are never injected into model context. */
export function persistPatchRecovery(directory: string, recovery: ApplyRecovery): string {
	assertNoSymlinkComponents(directory);
	const path = join(directory, `${randomUUID()}.recovery.json`);
	writeDurableArtifact(path, JSON.stringify(recovery), 0o600);
	return path;
}

export function validateWorktreePatch(
	artifact: WorktreePatchArtifact,
	directory: string,
	baseline: WorktreeBaseline,
	contractHash: string,
): ChildDelta {
	if (artifact.baselineTree !== baseline.baselineTree || artifact.contractHash !== contractHash)
		throw new Error("Patch artifact no longer matches the frozen child contract.");
	const expected = resolve(directory, `${artifact.finalTree}-${artifact.patchSha256}.patch`);
	if (
		artifact.patchRef !== expected ||
		!/^[0-9a-f]{40,64}$/.test(artifact.finalTree) ||
		!/^[0-9a-f]{64}$/.test(artifact.patchSha256)
	)
		throw new Error("Patch artifact identity is invalid.");
	assertNoSymlinkComponents(expected);
	const stats = lstatSync(expected);
	if (!stats.isFile() || stats.size !== artifact.patchBytes || stats.size > WORKTREE_LIMITS.maxPatchBytes)
		throw new Error("Patch artifact is not a bounded regular file.");
	const bytes = readFileSync(expected);
	if (createHash("sha256").update(bytes).digest("hex") !== artifact.patchSha256)
		throw new Error("Patch artifact hash changed.");
	const delta = deltaFromTree(baseline, artifact.finalTree);
	if (!bytes.equals(delta.patchBytes)) throw new Error("Patch artifact differs from its pinned tree.");
	return delta;
}
