/** Writer worktree workspace, patch collection, inspection, and integration (moved from ice-subagents.ts). */
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { IceVerifierState } from "../../ice-safe-verify.ts";
import { hashSource } from "../definitions/legacy-profiles.ts";
import { isRecord } from "../results/report.ts";
import { SubagentError } from "../runtime/helpers.ts";
import { canonicalPath, isPathWithin } from "../tools/paths.ts";
import {
	type ReadonlyWriterPatchArtifact,
	WRITER_PATCH_LIMITS,
	WRITER_PATCH_PREVIEW_LIMIT_BYTES,
	type WriterLaunchPreflight,
	type WriterPatchArtifact,
	type WriterPatchFile,
	type WriterResult,
	type WriterWorkspace,
} from "../types.ts";
import type { SubagentProgressSnapshot } from "../ui/observatory.ts";

function runWriterGit(cwd: string, args: readonly string[]): string {
	try {
		return execFileSync("git", [...args], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trimEnd();
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new SubagentError("writer_precondition", `Git preflight failed: ${detail}`);
	}
}

export async function validateWriterLaunchPreflight(cwd: string, baseCommit: string): Promise<WriterLaunchPreflight> {
	if (!/^[0-9a-f]{40}$/.test(baseCommit)) {
		throw new SubagentError("writer_precondition", "Writer baseCommit must be a full 40-character lowercase SHA.");
	}
	const parentRoot = canonicalPath(runWriterGit(cwd, ["rev-parse", "--show-toplevel"]));
	const resolvedBase = runWriterGit(cwd, ["rev-parse", "--verify", `${baseCommit}^{commit}`]);
	if (resolvedBase !== baseCommit) {
		throw new SubagentError("writer_precondition", "Writer baseCommit did not resolve to the requested SHA.");
	}
	const parentHead = runWriterGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (parentHead !== baseCommit) {
		throw new SubagentError("writer_precondition", "Writer baseCommit must equal the current parent HEAD.");
	}
	const statusPorcelain = runWriterGit(cwd, ["status", "--porcelain=v1", "-uall"]);
	if (statusPorcelain !== "") {
		throw new SubagentError(
			"writer_precondition",
			"Writer parent worktree is not clean according to git status --porcelain=v1 -uall.",
		);
	}
	return { parentRoot, parentHead, baseCommit, statusPorcelain };
}

export async function createWriterWorkspace(parentCwd: string, baseCommit: string): Promise<WriterWorkspace> {
	const preflight = await validateWriterLaunchPreflight(parentCwd, baseCommit);
	const temporaryRoot = mkdtempSync(join(tmpdir(), "ice-writer-"));
	const worktreeRoot = join(temporaryRoot, "worktree");
	try {
		execFileSync("git", ["worktree", "add", "--detach", worktreeRoot, baseCommit], {
			cwd: preflight.parentRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		rmSync(temporaryRoot, { recursive: true, force: true });
		const detail = error instanceof Error ? error.message : String(error);
		throw new SubagentError("writer_workspace_failure", `Could not create writer worktree: ${detail}`);
	}
	let cleaned = false;
	return {
		parentRoot: preflight.parentRoot,
		root: realpathSync(worktreeRoot),
		baseCommit,
		cleanup: async () => {
			if (cleaned) return;
			cleaned = true;
			let failure: unknown;
			try {
				execFileSync("git", ["worktree", "remove", "--force", worktreeRoot], {
					cwd: preflight.parentRoot,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				failure = error;
			}
			rmSync(temporaryRoot, { recursive: true, force: true });
			if (failure) {
				const detail = failure instanceof Error ? failure.message : String(failure);
				throw new SubagentError("writer_workspace_failure", `Could not remove writer worktree: ${detail}`);
			}
		},
	};
}

export function hasGitPathComponent(path: string): boolean {
	return path.split(sep).some((component) => component === ".git");
}

interface WriterStatusEntry {
	indexStatus: string;
	worktreeStatus: string;
	path: string;
}

function writerPatchFailure(message: string): SubagentError {
	return new SubagentError("writer_patch_failure", message);
}

function freezeWriterPatchArtifact(artifact: WriterPatchArtifact): ReadonlyWriterPatchArtifact {
	const files = Object.freeze(artifact.files.map((file) => Object.freeze({ ...file })));
	return Object.freeze({ ...artifact, files });
}

function runWriterGitBuffer(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Buffer {
	try {
		return execFileSync("git", [...args], {
			cwd,
			env,
			encoding: "buffer",
			stdio: ["ignore", "pipe", "pipe"],
		}) as Buffer;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw writerPatchFailure(`Git patch collection failed: ${detail}`);
	}
}

function runWriterGitInput(cwd: string, args: readonly string[], input: Buffer): Buffer {
	try {
		return execFileSync("git", [...args], {
			cwd,
			encoding: "buffer",
			input,
			stdio: ["pipe", "pipe", "pipe"],
		}) as Buffer;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw writerPatchFailure(`Git patch integration failed: ${detail}`);
	}
}

function parseWriterStatus(status: Buffer): WriterStatusEntry[] {
	const entries: WriterStatusEntry[] = [];
	let offset = 0;
	while (offset < status.length) {
		if (offset + 3 >= status.length || status[offset + 2] !== 0x20) {
			throw writerPatchFailure("Writer status inventory was malformed.");
		}
		const indexStatus = String.fromCharCode(status[offset]!);
		const worktreeStatus = String.fromCharCode(status[offset + 1]!);
		const end = status.indexOf(0, offset + 3);
		if (end === -1) throw writerPatchFailure("Writer status inventory was not NUL terminated.");
		const pathBytes = status.subarray(offset + 3, end);
		const path = pathBytes.toString("utf8");
		if (!path || !Buffer.from(path, "utf8").equals(pathBytes)) {
			throw writerPatchFailure("Writer changed paths must be valid UTF-8 paths.");
		}
		if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
			throw writerPatchFailure(`Writer changed path uses an unsupported rename or copy: ${path}`);
		}
		entries.push({ indexStatus, worktreeStatus, path });
		offset = end + 1;
	}
	return entries;
}

function assertWriterText(bytes: Buffer, path: string): void {
	if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
		throw writerPatchFailure(`Writer changed path is not a regular UTF-8 text file: ${path}`);
	}
}

function resolveWriterPatchPath(root: string, rawPath: string, scopeRoots: readonly string[]): string {
	if (isAbsolute(rawPath)) throw writerPatchFailure(`Writer changed path is absolute: ${rawPath}`);
	const candidate = resolve(root, rawPath);
	const relativePath = relative(root, candidate);
	if (!relativePath || isAbsolute(relativePath) || relativePath.startsWith(`..${sep}`) || relativePath === "..") {
		throw writerPatchFailure(`Writer changed path escapes its worktree: ${rawPath}`);
	}
	const repoPath = relativePath.split(sep).join("/");
	if (hasGitPathComponent(relativePath)) throw writerPatchFailure(`Writer changed Git metadata: ${rawPath}`);
	if (!scopeRoots.some((scopeRoot) => isPathWithin(scopeRoot, candidate))) {
		throw writerPatchFailure(`Writer changed path outside the approved scope: ${rawPath}`);
	}
	const pathComponents = relativePath.split(sep);
	const lastComponent = pathComponents[pathComponents.length - 1];
	let current = root;
	for (const component of pathComponents) {
		current = join(current, component);
		try {
			const stats = lstatSync(current);
			if (stats.isSymbolicLink()) throw writerPatchFailure(`Writer changed path is a symlink: ${rawPath}`);
			if (!stats.isDirectory() && current !== candidate && component !== lastComponent) {
				throw writerPatchFailure(`Writer changed path has a non-directory ancestor: ${rawPath}`);
			}
		} catch (error) {
			if (error instanceof SubagentError) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
			throw writerPatchFailure(`Writer changed path cannot be inspected: ${rawPath}`);
		}
	}
	return repoPath;
}

interface WriterPatchChange {
	path: string;
	before?: Buffer;
	after: Buffer;
	file: WriterPatchFile;
}

function writerPatchChanges(
	workspace: WriterWorkspace,
	entries: readonly WriterStatusEntry[],
	scopeRoots: readonly string[],
): WriterPatchChange[] {
	if (entries.length > WRITER_PATCH_LIMITS.maxChangedFiles) {
		throw writerPatchFailure(`Writer changed more than ${WRITER_PATCH_LIMITS.maxChangedFiles} files.`);
	}
	const changes = entries.map((entry) => {
		const path = resolveWriterPatchPath(workspace.root, entry.path, scopeRoots);
		const statuses = new Set([entry.indexStatus, entry.worktreeStatus]);
		if ([...statuses].some((status) => status === "D" || status === "U" || status === "T")) {
			throw writerPatchFailure(
				`Writer changed path uses an unsupported deletion, conflict, or type change: ${path}`,
			);
		}
		if (![...statuses].every((status) => status === " " || status === "M" || status === "A" || status === "?")) {
			throw writerPatchFailure(`Writer changed path uses an unsupported Git status: ${path}`);
		}
		const absolutePath = resolve(workspace.root, path);
		let after: Buffer;
		try {
			const stats = lstatSync(absolutePath);
			if (!stats.isFile()) throw writerPatchFailure(`Writer changed path is not a regular file: ${path}`);
			after = readFileSync(absolutePath);
		} catch (error) {
			if (error instanceof SubagentError) throw error;
			throw writerPatchFailure(`Writer changed file disappeared: ${path}`);
		}
		assertWriterText(after, path);
		const isAdd = entry.indexStatus === "?" || entry.worktreeStatus === "?" || statuses.has("A");
		if (isAdd) {
			return {
				path,
				after,
				file: {
					path,
					change: "add" as const,
					afterSha256: hashSource(after),
				},
			};
		}
		let before: Buffer;
		try {
			before = runWriterGitBuffer(workspace.root, ["show", `HEAD:${path}`]);
		} catch (error) {
			if (error instanceof SubagentError) throw error;
			throw writerPatchFailure(`Writer base file cannot be read: ${path}`);
		}
		assertWriterText(before, path);
		return {
			path,
			before,
			after,
			file: {
				path,
				change: "modify" as const,
				beforeSha256: hashSource(before),
				afterSha256: hashSource(after),
			},
		};
	});
	return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function runWriterRawDiff(cwd: string, args: readonly string[]): Buffer {
	try {
		return execFileSync("git", [...args], {
			cwd,
			encoding: "buffer",
			stdio: ["ignore", "pipe", "pipe"],
		}) as Buffer;
	} catch (error) {
		const result = error as { status?: number; stdout?: unknown };
		const stdout = Buffer.isBuffer(result.stdout)
			? result.stdout
			: Buffer.from(typeof result.stdout === "string" ? result.stdout : "");
		if (result.status === 1) return stdout;
		const detail = error instanceof Error ? error.message : String(error);
		throw writerPatchFailure(`Raw writer diff failed: ${detail}`);
	}
}

function collectWriterPatchBytes(changes: readonly WriterPatchChange[]): Buffer {
	const snapshotRoot = mkdtempSync(join(tmpdir(), "ice-writer-snapshots-"));
	const beforeRoot = join(snapshotRoot, "a");
	const afterRoot = join(snapshotRoot, "b");
	mkdirSync(beforeRoot);
	mkdirSync(afterRoot);
	try {
		return Buffer.concat(
			changes.map((change) => {
				const beforePath = change.before === undefined ? "/dev/null" : join(beforeRoot, ...change.path.split("/"));
				const afterPath = join(afterRoot, ...change.path.split("/"));
				const beforeDiffPath = change.before === undefined ? "/dev/null" : relative(snapshotRoot, beforePath);
				const afterDiffPath = relative(snapshotRoot, afterPath);
				mkdirSync(dirname(afterPath), { recursive: true });
				if (change.before !== undefined) {
					mkdirSync(dirname(beforePath), { recursive: true });
					writeFileSync(beforePath, change.before);
				}
				writeFileSync(afterPath, change.after);
				return runWriterRawDiff(snapshotRoot, [
					"diff",
					"--no-index",
					"--no-ext-diff",
					"--no-textconv",
					"--no-color",
					"--full-index",
					"--binary",
					"--src-prefix=",
					"--dst-prefix=",
					beforeDiffPath,
					afterDiffPath,
				]);
			}),
		);
	} finally {
		rmSync(snapshotRoot, { recursive: true, force: true });
	}
}

export interface WriterPatchCollectionOptions {
	scopeRoots: readonly string[];
	artifactRoot?: string;
}

export interface WriterPatchVerificationContext {
	parentRoot: string;
	baseCommit: string;
	artifact: ReadonlyWriterPatchArtifact;
	changedPaths: readonly string[];
}

export interface WriterPatchIntegrationOptions {
	cwd: string;
	scopeRoots: readonly string[];
	verify: (context: WriterPatchVerificationContext) => void | Promise<void>;
	onRollback?: () => void;
}

export interface WriterPatchIntegrationResult {
	status: "applied";
	parentRoot: string;
	baseCommit: string;
	changedPaths: string[];
	artifact: ReadonlyWriterPatchArtifact;
}

export function collectWriterPatchArtifact(
	workspace: WriterWorkspace,
	run: Pick<WriterResult, "runId" | "status" | "baseCommit">,
	options: WriterPatchCollectionOptions,
): WriterPatchArtifact | undefined {
	if (run.status !== "completed") return undefined;
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(run.runId)) {
		throw writerPatchFailure("Writer patch run ID is invalid.");
	}
	if (run.baseCommit !== workspace.baseCommit)
		throw writerPatchFailure("Writer patch base commit does not match its workspace.");
	const status = runWriterGitBuffer(workspace.root, ["status", "--porcelain=v1", "-z", "-uall"]);
	const entries = parseWriterStatus(status);
	const ignoredEntries = parseWriterStatus(
		runWriterGitBuffer(workspace.root, ["status", "--porcelain=v1", "-z", "--ignored", "-uall"]),
	).filter((entry) => entry.indexStatus === "!" || entry.worktreeStatus === "!");
	if (ignoredEntries.length > 0) {
		throw writerPatchFailure(`Writer changed ignored paths that cannot be proposed: ${ignoredEntries[0]!.path}`);
	}
	const changes = writerPatchChanges(workspace, entries, options.scopeRoots);
	const files = changes.map((change) => change.file);
	const patch = collectWriterPatchBytes(changes);
	if (patch.byteLength > WRITER_PATCH_LIMITS.maxPatchBytes) {
		throw writerPatchFailure(`Writer patch exceeds ${WRITER_PATCH_LIMITS.maxPatchBytes} bytes.`);
	}
	const artifactRoot = resolve(options.artifactRoot ?? join(getAgentDir(), "artifacts", "writer"));
	if (isPathWithin(workspace.parentRoot, artifactRoot) || isPathWithin(workspace.root, artifactRoot)) {
		throw writerPatchFailure("Writer patch artifacts cannot be written inside a writer or parent worktree.");
	}
	const runDirectory = join(artifactRoot, run.runId);
	const patchRef = join(runDirectory, "proposal.patch");
	try {
		mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
		const canonicalArtifactRoot = canonicalPath(artifactRoot);
		if (
			isPathWithin(workspace.parentRoot, canonicalArtifactRoot) ||
			isPathWithin(workspace.root, canonicalArtifactRoot)
		) {
			throw writerPatchFailure("Writer patch artifacts resolve inside a writer or parent worktree.");
		}
		mkdirSync(runDirectory, { mode: 0o700 });
		writeFileSync(patchRef, patch, { flag: "wx", mode: 0o444 });
		chmodSync(patchRef, 0o444);
	} catch (error) {
		rmSync(runDirectory, { recursive: true, force: true });
		const detail = error instanceof Error ? error.message : String(error);
		throw writerPatchFailure(`Writer patch artifact could not be written: ${detail}`);
	}
	return {
		schemaVersion: 1,
		runId: run.runId,
		baseCommit: run.baseCommit,
		changedFileCount: files.length,
		patchBytes: patch.byteLength,
		patchSha256: hashSource(patch),
		patchRef,
		files,
	};
}

function validateWriterPatchArtifactShape(artifact: WriterPatchArtifact): void {
	if (!isRecord(artifact) || artifact.schemaVersion !== 1) {
		throw writerPatchFailure("Writer patch artifact schema is unsupported.");
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(artifact.runId)) {
		throw writerPatchFailure("Writer patch artifact run ID is invalid.");
	}
	if (!/^[0-9a-f]{40}$/.test(artifact.baseCommit)) {
		throw writerPatchFailure("Writer patch artifact base commit is invalid.");
	}
	if (
		!Number.isInteger(artifact.changedFileCount) ||
		artifact.changedFileCount < 0 ||
		artifact.changedFileCount > WRITER_PATCH_LIMITS.maxChangedFiles
	) {
		throw writerPatchFailure("Writer patch artifact changed-file count is invalid.");
	}
	if (
		!Number.isInteger(artifact.patchBytes) ||
		artifact.patchBytes < 0 ||
		artifact.patchBytes > WRITER_PATCH_LIMITS.maxPatchBytes
	) {
		throw writerPatchFailure("Writer patch artifact byte count is invalid.");
	}
	if (!/^[a-f0-9]{64}$/.test(artifact.patchSha256)) {
		throw writerPatchFailure("Writer patch artifact digest is invalid.");
	}
	if (
		typeof artifact.patchRef !== "string" ||
		artifact.patchRef.length === 0 ||
		Buffer.byteLength(artifact.patchRef) > 4096
	) {
		throw writerPatchFailure("Writer patch artifact reference is invalid.");
	}
	if (!Array.isArray(artifact.files) || artifact.files.length !== artifact.changedFileCount) {
		throw writerPatchFailure("Writer patch artifact file inventory is inconsistent.");
	}
	const paths = new Set<string>();
	for (const file of artifact.files) {
		if (
			!isRecord(file) ||
			typeof file.path !== "string" ||
			file.path.length === 0 ||
			Buffer.byteLength(file.path) > 4096
		) {
			throw writerPatchFailure("Writer patch artifact contains an invalid file path.");
		}
		if (
			file.path.startsWith("/") ||
			file.path.includes("\0") ||
			file.path.split("/").some((part) => part === "" || part === "." || part === "..")
		) {
			throw writerPatchFailure(`Writer patch artifact path is not normalized: ${file.path}`);
		}
		if (paths.has(file.path)) throw writerPatchFailure(`Writer patch artifact repeats a file path: ${file.path}`);
		paths.add(file.path);
		if (file.change !== "add" && file.change !== "modify") {
			throw writerPatchFailure(`Writer patch artifact uses an unsupported change: ${file.path}`);
		}
		if (!/^[a-f0-9]{64}$/.test(file.afterSha256 ?? "")) {
			throw writerPatchFailure(`Writer patch artifact after hash is invalid: ${file.path}`);
		}
		if (file.change === "add") {
			if (file.beforeSha256 !== undefined) throw writerPatchFailure(`Added file has a before hash: ${file.path}`);
		} else if (!/^[a-f0-9]{64}$/.test(file.beforeSha256 ?? "")) {
			throw writerPatchFailure(`Writer patch artifact before hash is invalid: ${file.path}`);
		}
	}
}

export interface WriterPatchInspection {
	status: "inspected";
	artifact: ReadonlyWriterPatchArtifact;
	parentRoot: string;
	preview: string;
	previewBytes: number;
	previewTruncated: boolean;
}

export type WriterWorkflowStatus =
	| "inspected"
	| "rejected"
	| "integrated"
	| "verification_failed"
	| "integration_conflict"
	| "rollback_conflict"
	| "artifact_invalid"
	| "verifier_unavailable";

export interface WriterWorkflowToolResult {
	status: WriterWorkflowStatus;
	progress?: SubagentProgressSnapshot;
	artifact?: ReadonlyWriterPatchArtifact;
	parentRoot?: string;
	changedPaths?: readonly string[];
	preview?: string;
	previewBytes?: number;
	previewTruncated?: boolean;
	verification?: IceVerifierState;
	message?: string;
}

function resolveProductionWriterPatchPath(artifact: WriterPatchArtifact, agentDir: string): string {
	const expectedPatchPath = resolve(agentDir, "artifacts", "writer", artifact.runId, "proposal.patch");
	let expectedCanonical: string;
	let actualCanonical: string;
	try {
		const expectedStats = lstatSync(expectedPatchPath);
		if (expectedStats.isSymbolicLink() || !expectedStats.isFile())
			throw writerPatchFailure("Production writer artifact is not a regular file.");
		expectedCanonical = canonicalPath(expectedPatchPath);
		const actualStats = lstatSync(resolve(artifact.patchRef));
		if (actualStats.isSymbolicLink() || !actualStats.isFile())
			throw writerPatchFailure("Writer patch reference is not a regular file.");
		actualCanonical = canonicalPath(resolve(artifact.patchRef));
	} catch (error) {
		if (error instanceof SubagentError) throw error;
		throw writerPatchFailure("Production writer artifact patch cannot be inspected.");
	}
	if (actualCanonical !== expectedCanonical) {
		throw writerPatchFailure("Writer patch reference is outside its production artifact path.");
	}
	return expectedCanonical;
}

export function inspectWriterPatchArtifact(
	artifact: WriterPatchArtifact,
	cwd: string,
	agentDir = getAgentDir(),
): WriterPatchInspection {
	validateWriterPatchArtifactShape(artifact);
	const patchPath = resolveProductionWriterPatchPath(artifact, agentDir);
	const patch = readFileSync(patchPath);
	if (patch.byteLength !== artifact.patchBytes || hashSource(patch) !== artifact.patchSha256) {
		throw writerPatchFailure("Writer patch bytes do not match the artifact hash/digest.");
	}
	const parentRoot = canonicalPath(runWriterGit(cwd, ["rev-parse", "--show-toplevel"]));
	const scopeRoots = normalizeWriterIntegrationScope(cwd, parentRoot, [parentRoot]);
	const expectedPaths = artifact.files
		.map((file) => resolveWriterPatchPath(parentRoot, file.path, scopeRoots))
		.sort((left, right) => left.localeCompare(right));
	const patchPaths = parseWriterPatchInventory(
		runWriterGitInput(parentRoot, ["apply", "--numstat", "-z", "-p1"], patch),
	);
	if (patchPaths.length !== expectedPaths.length || patchPaths.some((path, index) => path !== expectedPaths[index])) {
		throw writerPatchFailure("Writer patch paths do not match the artifact inventory.");
	}
	const previewBytes = Math.min(patch.byteLength, WRITER_PATCH_PREVIEW_LIMIT_BYTES);
	return {
		status: "inspected",
		artifact: freezeWriterPatchArtifact(artifact),
		parentRoot,
		preview: patch.subarray(0, previewBytes).toString("utf8"),
		previewBytes,
		previewTruncated: patch.byteLength > previewBytes,
	};
}

function normalizeWriterIntegrationScope(cwd: string, parentRoot: string, scopeRoots: readonly string[]): string[] {
	if (!Array.isArray(scopeRoots) || scopeRoots.length === 0 || scopeRoots.length > 16) {
		throw new SubagentError("invalid_scope", "Writer integration scope must contain 1-16 roots.");
	}
	const roots: string[] = [];
	for (const rawRoot of scopeRoots) {
		if (typeof rawRoot !== "string" || rawRoot.length === 0 || Buffer.byteLength(rawRoot) > 4096) {
			throw new SubagentError("invalid_scope", "Writer integration scope roots must be bounded paths.");
		}
		let root: string;
		try {
			root = canonicalPath(resolve(cwd, rawRoot));
		} catch {
			throw new SubagentError("invalid_scope", `Writer integration scope root does not exist: ${rawRoot}`);
		}
		try {
			if (!statSync(root).isDirectory())
				throw new SubagentError("invalid_scope", `Writer integration scope root is not a directory: ${rawRoot}`);
		} catch (error) {
			if (error instanceof SubagentError) throw error;
			throw new SubagentError("invalid_scope", `Writer integration scope root cannot be inspected: ${rawRoot}`);
		}
		if (!isPathWithin(parentRoot, root)) {
			throw new SubagentError("invalid_scope", `Writer integration scope root is outside the parent: ${rawRoot}`);
		}
		if (!roots.includes(root)) roots.push(root);
	}
	return roots;
}

function parseWriterPatchInventory(bytes: Buffer): string[] {
	if (bytes.length === 0) return [];
	const paths: string[] = [];
	let offset = 0;
	while (offset < bytes.length) {
		const end = bytes.indexOf(0, offset);
		if (end === -1) throw writerPatchFailure("Writer patch inventory was not NUL terminated.");
		const record = bytes.subarray(offset, end);
		const firstTab = record.indexOf(0x09);
		const secondTab = firstTab === -1 ? -1 : record.indexOf(0x09, firstTab + 1);
		if (firstTab <= 0 || secondTab <= firstTab + 1) throw writerPatchFailure("Writer patch inventory was malformed.");
		const additions = record.subarray(0, firstTab).toString("ascii");
		const deletions = record.subarray(firstTab + 1, secondTab).toString("ascii");
		if (!/^\d+$/.test(additions)) throw writerPatchFailure("Writer patch additions count was malformed.");
		if (!/^\d+$/.test(deletions)) throw writerPatchFailure("Writer patch deletions count was malformed.");
		const pathBytes = record.subarray(secondTab + 1);
		const path = pathBytes.toString("utf8");
		if (!path || !Buffer.from(path, "utf8").equals(pathBytes))
			throw writerPatchFailure("Writer patch path was malformed.");
		paths.push(path);
		offset = end + 1;
	}
	return paths.sort((left, right) => left.localeCompare(right));
}

interface WriterRollbackSnapshot {
	path: string;
	existed: boolean;
	bytes?: Buffer;
	mode?: number;
	beforeSha256?: string;
	afterSha256: string;
	change: "add" | "modify";
}

function snapshotWriterParentPath(parentRoot: string, file: Readonly<WriterPatchFile>): WriterRollbackSnapshot {
	const absolutePath = resolve(parentRoot, file.path);
	try {
		const stats = lstatSync(absolutePath);
		if (stats.isSymbolicLink() || !stats.isFile())
			throw writerPatchFailure(`Writer integration path is not a regular file: ${file.path}`);
		const bytes = readFileSync(absolutePath);
		const expected = file.change === "modify" ? file.beforeSha256 : undefined;
		if (file.change === "add")
			throw writerPatchFailure(`Added writer path already exists in the parent: ${file.path}`);
		if (expected !== hashSource(bytes))
			throw writerPatchFailure(`Writer integration preimage hash changed: ${file.path}`);
		return {
			path: file.path,
			existed: true,
			bytes,
			mode: stats.mode & 0o7777,
			beforeSha256: hashSource(bytes),
			afterSha256: file.afterSha256!,
			change: "modify",
		};
	} catch (error) {
		if (error instanceof SubagentError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			if (file.change !== "add") throw writerPatchFailure(`Writer integration preimage disappeared: ${file.path}`);
			return {
				path: file.path,
				existed: false,
				afterSha256: file.afterSha256!,
				change: "add",
			};
		}
		throw writerPatchFailure(`Writer integration preimage cannot be inspected: ${file.path}`);
	}
}

function validateWriterPostimage(parentRoot: string, file: Readonly<WriterPatchFile>): void {
	const absolutePath = resolve(parentRoot, file.path);
	try {
		const stats = lstatSync(absolutePath);
		if (stats.isSymbolicLink() || !stats.isFile())
			throw writerPatchFailure(`Writer integration result is not a regular file: ${file.path}`);
		if (hashSource(readFileSync(absolutePath)) !== file.afterSha256) {
			throw writerPatchFailure(`Writer integration postimage hash is invalid: ${file.path}`);
		}
	} catch (error) {
		if (error instanceof SubagentError) throw error;
		throw writerPatchFailure(`Writer integration result disappeared: ${file.path}`);
	}
}

function writerIntegrationStatus(file: Pick<Readonly<WriterPatchFile>, "path" | "change">): WriterStatusEntry {
	return {
		path: file.path,
		indexStatus: file.change === "add" ? "?" : " ",
		worktreeStatus: file.change === "add" ? "?" : "M",
	};
}

function sameWriterStatus(left: WriterStatusEntry, right: WriterStatusEntry): boolean {
	return left.indexStatus === right.indexStatus && left.worktreeStatus === right.worktreeStatus;
}

function writerStatusMap(parentRoot: string): Map<string, WriterStatusEntry> {
	return new Map(
		parseWriterStatus(runWriterGitBuffer(parentRoot, ["status", "--porcelain=v1", "-z", "-uall"])).map((entry) => [
			entry.path,
			entry,
		]),
	);
}

function cleanWriterStatus(path: string): WriterStatusEntry {
	return { path, indexStatus: " ", worktreeStatus: " " };
}

function validateWriterIntegrationStatus(parentRoot: string, files: readonly Readonly<WriterPatchFile>[]): void {
	const actual = writerStatusMap(parentRoot);
	const expected = new Map(files.map((file) => [file.path, writerIntegrationStatus(file)]));
	if (
		actual.size !== expected.size ||
		[...actual.entries()].some(([path, entry]) => {
			const expectedEntry = expected.get(path);
			return !expectedEntry || !sameWriterStatus(entry, expectedEntry);
		})
	) {
		throw new SubagentError(
			"integration_conflict",
			"Parent worktree changed unexpectedly during writer verification.",
		);
	}
}

type WriterRollbackCurrent = { kind: "missing" } | { kind: "file"; bytes: Buffer } | { kind: "unknown" };

function inspectWriterRollbackPath(parentRoot: string, path: string): WriterRollbackCurrent {
	try {
		const stats = lstatSync(resolve(parentRoot, path));
		if (stats.isSymbolicLink() || !stats.isFile()) return { kind: "unknown" };
		return { kind: "file", bytes: readFileSync(resolve(parentRoot, path)) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		return { kind: "unknown" };
	}
}

function restoreWriterParentSnapshots(parentRoot: string, snapshots: readonly WriterRollbackSnapshot[]): void {
	const statuses = writerStatusMap(parentRoot);
	const actions: Array<{ snapshot: WriterRollbackSnapshot; remove: boolean }> = [];
	const conflicts: string[] = [];
	for (const snapshot of snapshots) {
		const current = inspectWriterRollbackPath(parentRoot, snapshot.path);
		const status = statuses.get(snapshot.path) ?? cleanWriterStatus(snapshot.path);
		const expected = writerIntegrationStatus(snapshot);
		const clean = cleanWriterStatus(snapshot.path);
		if (snapshot.change === "modify") {
			if (
				current.kind === "file" &&
				hashSource(current.bytes) === snapshot.beforeSha256 &&
				sameWriterStatus(status, clean)
			) {
				continue;
			}
			if (
				current.kind === "file" &&
				hashSource(current.bytes) === snapshot.afterSha256 &&
				sameWriterStatus(status, expected)
			) {
				actions.push({ snapshot, remove: false });
				continue;
			}
		} else {
			if (current.kind === "missing" && sameWriterStatus(status, clean)) continue;
			if (
				current.kind === "file" &&
				hashSource(current.bytes) === snapshot.afterSha256 &&
				sameWriterStatus(status, expected)
			) {
				actions.push({ snapshot, remove: true });
				continue;
			}
		}
		conflicts.push(snapshot.path);
	}
	for (const { snapshot, remove } of actions) {
		const absolutePath = resolve(parentRoot, snapshot.path);
		if (remove) {
			rmSync(absolutePath, { force: true });
			continue;
		}
		if (!snapshot.bytes) throw writerPatchFailure(`Writer rollback snapshot is incomplete: ${snapshot.path}`);
		rmSync(absolutePath, { force: true });
		mkdirSync(dirname(absolutePath), { recursive: true });
		writeFileSync(absolutePath, snapshot.bytes);
		if (snapshot.mode !== undefined) chmodSync(absolutePath, snapshot.mode);
	}
	if (conflicts.length > 0) {
		throw new SubagentError(
			"rollback_conflict",
			`Writer rollback conflicts at ${conflicts.join(", ")}; newer or unknown parent state was preserved.`,
		);
	}
}

export async function integrateWriterPatchArtifact(
	artifact: WriterPatchArtifact,
	options: WriterPatchIntegrationOptions,
): Promise<WriterPatchIntegrationResult> {
	validateWriterPatchArtifactShape(artifact);
	const transactionArtifact = freezeWriterPatchArtifact(artifact);
	if (!options || typeof options.cwd !== "string" || typeof options.verify !== "function") {
		throw writerPatchFailure("Writer integration requires a parent cwd and verifier.");
	}
	const parentRoot = canonicalPath(runWriterGit(options.cwd, ["rev-parse", "--show-toplevel"]));
	const patchPath = resolve(options.cwd, transactionArtifact.patchRef);
	let canonicalPatchPath: string;
	try {
		const stats = lstatSync(patchPath);
		if (stats.isSymbolicLink() || !stats.isFile())
			throw writerPatchFailure("Writer patch reference is not a regular file.");
		canonicalPatchPath = canonicalPath(patchPath);
	} catch (error) {
		if (error instanceof SubagentError) throw error;
		throw writerPatchFailure(`Writer patch reference cannot be read: ${artifact.patchRef}`);
	}
	if (isPathWithin(parentRoot, canonicalPatchPath)) {
		throw writerPatchFailure("Writer patch reference cannot be inside the parent worktree.");
	}
	let patch: Buffer;
	try {
		patch = readFileSync(canonicalPatchPath);
	} catch {
		throw writerPatchFailure(`Writer patch reference cannot be read: ${artifact.patchRef}`);
	}
	if (patch.byteLength !== transactionArtifact.patchBytes || hashSource(patch) !== transactionArtifact.patchSha256) {
		throw writerPatchFailure("Writer patch bytes do not match the artifact hash/digest.");
	}
	const preflight = await validateWriterLaunchPreflight(options.cwd, transactionArtifact.baseCommit);
	const scopeRoots = normalizeWriterIntegrationScope(options.cwd, preflight.parentRoot, options.scopeRoots);
	const expectedPaths = transactionArtifact.files
		.map((file) => resolveWriterPatchPath(parentRoot, file.path, scopeRoots))
		.sort((left, right) => left.localeCompare(right));
	const patchPaths = parseWriterPatchInventory(
		runWriterGitInput(parentRoot, ["apply", "--numstat", "-z", "-p1"], patch),
	);
	if (patchPaths.length !== expectedPaths.length || patchPaths.some((path, index) => path !== expectedPaths[index])) {
		throw writerPatchFailure("Writer patch paths do not match the artifact inventory.");
	}
	const snapshots = transactionArtifact.files.map((file) => snapshotWriterParentPath(parentRoot, file));
	let transactionStarted = false;
	try {
		runWriterGitInput(parentRoot, ["apply", "--check", "-p1"], patch);
		transactionStarted = true;
		runWriterGitInput(parentRoot, ["apply", "-p1"], patch);
		for (const file of transactionArtifact.files) validateWriterPostimage(parentRoot, file);
		try {
			await options.verify({
				parentRoot,
				baseCommit: transactionArtifact.baseCommit,
				artifact: transactionArtifact,
				changedPaths: Object.freeze([...expectedPaths]),
			});
		} catch (error) {
			throw new SubagentError(
				"verification_failure",
				`Parent verification failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		for (const file of transactionArtifact.files) validateWriterPostimage(parentRoot, file);
		validateWriterIntegrationStatus(parentRoot, transactionArtifact.files);
		return {
			status: "applied",
			parentRoot,
			baseCommit: transactionArtifact.baseCommit,
			changedPaths: expectedPaths,
			artifact: transactionArtifact,
		};
	} catch (error) {
		if (transactionStarted) {
			try {
				options.onRollback?.();
			} catch {
				// Rollback observability is non-authoritative and must not affect recovery.
			}
			try {
				restoreWriterParentSnapshots(parentRoot, snapshots);
			} catch (rollbackError) {
				if (rollbackError instanceof SubagentError) throw rollbackError;
				throw writerPatchFailure(
					`Writer integration failed and rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
				);
			}
		}
		throw error;
	}
}
