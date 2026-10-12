/**
 * Subagent V2 agent-directory discovery (Plan/subagent-rewrite.md section 7.3, P2.2).
 *
 * Mirrors Claude Code's markdownConfigLoader: project directories are collected
 * from cwd up to the git root, a nested repository inside the session project
 * does not truncate the walk, a linked worktree without its own agents directory
 * falls back to the main checkout, files are discovered recursively, and the
 * same physical file is loaded once.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { findGitPaths } from "../../core/footer-data-provider.ts";
import { AGENT_FILE_MAX_BYTES } from "./parse.ts";

export interface AgentDirectoryOptions {
	cwd: string;
	/** Root of the session project; a nested repository below it does not stop the walk. Defaults to cwd. */
	projectRoot?: string;
	/** Directory name below each project directory, `.ice/agents` or `.claude/agents`. */
	subdir?: string;
	home?: string;
}

const MAX_WALK_DEPTH = 64;
const MAX_FILES_PER_ROOT = 512;
const MAX_DIR_DEPTH = 8;

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isWithin(root: string, path: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Main checkout root for a linked worktree, or undefined for an ordinary repository. */
function mainCheckoutRoot(cwd: string): { worktreeRoot: string; mainRoot: string } | undefined {
	const paths = findGitPaths(resolve(cwd));
	if (!paths) return undefined;
	const worktreeRoot = canonical(paths.repoDir);
	const commonGitDir = canonical(paths.commonGitDir);
	const mainRoot = dirname(commonGitDir);
	// Only a standard `<main>/.git` common dir names a checked-out main worktree.
	if (canonical(join(mainRoot, ".git")) !== commonGitDir || mainRoot === worktreeRoot) return undefined;
	return { worktreeRoot, mainRoot };
}

/**
 * Walk boundary: the nearest git root, widened to the session project's git root
 * when the nearest root is a different repository nested inside the project.
 */
export function resolveProjectStopBoundary(cwd: string, projectRoot = cwd): string | undefined {
	const near = findGitPaths(resolve(cwd));
	if (!near) return undefined;
	const nearRoot = canonical(near.repoDir);
	const session = findGitPaths(resolve(projectRoot));
	if (!session) return nearRoot;
	const sessionRoot = canonical(session.repoDir);
	if (canonical(near.commonGitDir) === canonical(session.commonGitDir)) return nearRoot;
	return nearRoot !== sessionRoot && isWithin(sessionRoot, nearRoot) ? sessionRoot : nearRoot;
}

/** Existing project agent directories, most specific (cwd) first. Never includes $HOME. */
export function findProjectAgentDirectories(options: AgentDirectoryOptions): string[] {
	const subdir = options.subdir ?? join(CONFIG_DIR_NAME, "agents");
	const home = canonical(options.home ?? homedir());
	const boundary = resolveProjectStopBoundary(options.cwd, options.projectRoot ?? options.cwd);
	const dirs: string[] = [];
	let current = canonical(options.cwd);
	for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
		if (current === home) break;
		const candidate = join(current, subdir);
		if (isDirectory(candidate)) dirs.push(candidate);
		if (boundary === undefined || current === boundary) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	const worktree = mainCheckoutRoot(options.cwd);
	if (worktree && !dirs.includes(join(worktree.worktreeRoot, subdir))) {
		const fallback = join(worktree.mainRoot, subdir);
		if (isDirectory(fallback) && !dirs.includes(fallback)) dirs.push(fallback);
	}
	return dirs;
}

export interface DiscoveredAgentFile {
	path: string;
	root: string;
	content: string;
}

export interface AgentFileDiscovery {
	files: DiscoveredAgentFile[];
	diagnostics: Array<{ path: string; message: string }>;
}

/**
 * Recursive `*.md` listing under each root, in deterministic order. Symlinks are
 * followed only while the target stays inside its root. `seen` carries device/inode
 * identities across roots so one physical file loads once.
 */
export function listAgentMarkdownFiles(roots: readonly string[], seen = new Set<string>()): AgentFileDiscovery {
	const files: DiscoveredAgentFile[] = [];
	const diagnostics: AgentFileDiscovery["diagnostics"] = [];
	for (const root of roots) {
		if (!isDirectory(root)) continue;
		const canonicalRoot = canonical(root);
		let count = 0;
		let capped = false;
		const visit = (dir: string, depth: number): void => {
			if (depth > MAX_DIR_DEPTH || capped) return;
			let entries: string[];
			try {
				entries = readdirSync(dir).sort((left, right) => left.localeCompare(right));
			} catch {
				return;
			}
			for (const entry of entries) {
				if (capped) return;
				if (entry.startsWith(".")) continue;
				const path = join(dir, entry);
				let target: string;
				try {
					target = lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
				} catch {
					continue;
				}
				if (!isWithin(canonicalRoot, canonical(target))) {
					diagnostics.push({ path, message: "symlink target escapes the agents directory; skipped" });
					continue;
				}
				let stat: ReturnType<typeof statSync>;
				try {
					stat = statSync(target);
				} catch {
					continue;
				}
				if (stat.isDirectory()) {
					visit(path, depth + 1);
					continue;
				}
				if (!stat.isFile() || !entry.endsWith(".md")) continue;
				const identity = stat.ino ? `${stat.dev}:${stat.ino}` : canonical(target);
				if (seen.has(identity)) continue;
				seen.add(identity);
				if (++count > MAX_FILES_PER_ROOT) {
					capped = true;
					diagnostics.push({ path: root, message: `more than ${MAX_FILES_PER_ROOT} files; remainder skipped` });
					return;
				}
				if (stat.size > AGENT_FILE_MAX_BYTES) {
					diagnostics.push({ path, message: `file exceeds ${AGENT_FILE_MAX_BYTES} bytes; skipped` });
					continue;
				}
				try {
					files.push({ path, root, content: readFileSync(target, "utf8") });
				} catch (error) {
					diagnostics.push({
						path,
						message: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
			}
		};
		visit(root, 0);
	}
	return { files, diagnostics };
}
