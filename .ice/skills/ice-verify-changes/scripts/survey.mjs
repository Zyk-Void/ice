#!/usr/bin/env node
// Survey recent changes in this ICE worktree: which files changed, which area
// of the harness each belongs to, and whether the built `dist/` output (what the
// `ice` command actually runs) reflects them. Read-only: never builds, never writes.
//
// Usage: node survey.mjs [--base <ref> | --commit <ref>] [--json]
//   --base <ref>    compare against this ref (default: HEAD~3). Uncommitted and
//                   untracked files are always included.
//   --commit <ref>  historical mode: only what that one commit changed (ref^..ref).
//                   Working-tree changes are ignored; files touched again by
//                   later commits are flagged.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, sep } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const root = git("rev-parse", "--show-toplevel");
process.chdir(root);

const commit = option("--commit", undefined);
const base = commit ? `${commit}^` : option("--base", "HEAD~3");
const tip = commit ?? undefined; // undefined: compare against the working tree
try {
	git("rev-parse", "--verify", `${base}^{commit}`);
	if (tip) git("rev-parse", "--verify", `${tip}^{commit}`);
} catch {
	console.error(`Unknown ref: ${commit ?? base}`);
	process.exit(2);
}
const laterChanged = new Set(tip ? git("diff", "--name-only", tip, "HEAD").split("\n").filter(Boolean) : []);
const sourceTime = (path) => (tip ? Number(git("log", "-1", "--format=%ct", tip)) * 1000 : statSync(path).mtimeMs);

// ---- changed files -------------------------------------------------------

const status = new Map(); // path -> "M" | "A" | "D" | "R" | "?" (untracked)
const diffRange = tip ? [base, tip] : [base];
for (const line of git("diff", "--name-status", ...diffRange).split("\n").filter(Boolean)) {
	const [code, ...paths] = line.split("\t");
	status.set(paths[paths.length - 1], code[0]);
}
if (!tip) {
	for (const line of git("diff", "--name-status").split("\n").filter(Boolean)) {
		const [code, ...paths] = line.split("\t");
		status.set(paths[paths.length - 1], code[0]);
	}
	for (const path of git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean)) {
		if (!path.split("/").includes("node_modules")) status.set(path, "?");
	}
}

// Collapse big untracked trees (a freshly imported extension) to one entry.
const untrackedByTop = new Map();
for (const [path, code] of status) {
	if (code !== "?") continue;
	const top = path.split("/").slice(0, 2).join("/");
	untrackedByTop.set(top, (untrackedByTop.get(top) ?? 0) + 1);
}
const collapsed = new Set([...untrackedByTop].filter(([, n]) => n > 40).map(([top]) => top));
const files = [];
const collapsedSeen = new Set();
for (const [path, code] of [...status].sort()) {
	const top = path.split("/").slice(0, 2).join("/");
	if (code === "?" && collapsed.has(top)) {
		if (!collapsedSeen.has(top)) {
			collapsedSeen.add(top);
			files.push({ path: `${top}/ (${untrackedByTop.get(top)} untracked files)`, status: "?", tree: top });
		}
		continue;
	}
	files.push({ path, status: code });
}

// ---- categories ----------------------------------------------------------

const rules = [
	[/^imported_extensions\/([^/]+)/, (m) => `imported extension: ${m[1]}`],
	[/^\.ice\//, () => "project skills and config (.ice)"],
	[/\/test\/|\.test\.ts$/, () => "tests"],
	[/^packages\/tui\//, () => "tui library"],
	[/^packages\/coding-agent\/src\/subagents\//, () => "subagents"],
	[/^packages\/coding-agent\/src\/core\/(keybindings|extensions\/runner)\.ts$/, () => "keybindings"],
	[/^packages\/coding-agent\/src\/modes\/interactive\//, () => "interactive TUI"],
	[/^packages\/coding-agent\/src\/core\/extensions\//, () => "extension host"],
	[/^packages\/coding-agent\/src\/(ice-safe-verify|core\/permissions)/, () => "modes and permissions"],
	[/^packages\/coding-agent\/src\/core\/compaction\//, () => "compaction"],
	[/^packages\/coding-agent\/src\/core\/tools\//, () => "built-in tools"],
	[/^packages\/coding-agent\/src\/(cli|ice|cli\.ts|main)/, () => "cli and startup"],
	[/^packages\/coding-agent\/src\//, () => "coding-agent core"],
	[/^packages\/ai\//, () => "ai and models"],
	[/^packages\/agent\//, () => "agent loop"],
	[/^packages\/(client|server|protocol)\//, (m) => `${m[1]} package`],
	[/(^|\/)(CHANGELOG|README)\.md$|^docs\/|\/docs\/|\.md$/, () => "docs"],
];
const categoryOf = (path) => {
	for (const [re, name] of rules) {
		const m = re.exec(path);
		if (m) return name(m);
	}
	return "other";
};

// ---- build freshness -----------------------------------------------------

// packages/<pkg>/src/<rest>.ts -> packages/<pkg>/dist/<rest>.js
const distOf = (path) => {
	const m = /^(packages\/[^/]+)\/src\/(.+)\.ts$/.exec(path);
	return m ? `${m[1]}/dist/${m[2]}.js` : undefined;
};

// Quoted literals on added lines survive compilation, so finding one in dist
// proves the new code is in the build (mtime alone can lie after a checkout).
const probesFor = (path, code) => {
	if (code === "D") return [];
	let diff = "";
	try {
		diff = code === "?" ? readFileSync(path, "utf8").split("\n").map((l) => `+${l}`).join("\n") : git("diff", ...diffRange, "--", path);
	} catch {
		return [];
	}
	const probes = new Set();
	for (const line of diff.split("\n")) {
		if (!line.startsWith("+") || line.startsWith("+++")) continue;
		for (const m of line.matchAll(/["'`]([A-Za-z0-9_.:/ -]{8,60})["'`]/g)) probes.add(m[1]);
	}
	return [...probes].slice(0, 6);
};

const results = [];
for (const file of files) {
	const category = file.tree ? categoryOf(`${file.tree}/x`) : categoryOf(file.path);
	const entry = { path: file.path, status: file.status, category, build: "n/a", detail: "" };
	const dist = file.tree ? undefined : distOf(file.path);
	if (dist && !/\.test\.ts$|\/test\//.test(file.path)) {
		if (file.status === "D") {
			entry.build = existsSync(dist) ? "stale" : "fresh";
			entry.detail = existsSync(dist) ? "source deleted but dist file remains" : "removed from dist too";
		} else if (!existsSync(dist)) {
			entry.build = "missing";
			entry.detail = `${dist} does not exist`;
		} else {
			const srcTime = sourceTime(file.path);
			const distTime = statSync(dist).mtimeMs;
			const probes = probesFor(file.path, file.status);
			const distText = readFileSync(dist, "utf8");
			const found = probes.filter((p) => distText.includes(p));
			const distNewer = distTime + 2000 >= srcTime;
			if (found.length > 0) {
				entry.build = "fresh";
				entry.detail = `${found.length}/${probes.length} added literals found in ${dist}`;
			} else {
				// No literal proof: type-only or comment-only edits compile to nothing, so mtime decides.
				entry.build = distNewer ? "fresh?" : "stale";
				entry.detail = `${probes.length === 0 ? "no literals to probe" : `0/${probes.length} literals found`}; dist ${distNewer ? "newer" : "older"} than ${tip ? "the commit" : "source"}`;
			}
			if (tip && laterChanged.has(file.path)) entry.detail += "; later commits changed this file again, so dist may not match this commit";
		}
	} else if (file.tree || /^imported_extensions\/|^\.ice\//.test(file.path)) {
		entry.build = "source";
		entry.detail = "loaded from source at startup, no build";
	} else if (/\.md$/.test(file.path)) {
		entry.build = "n/a";
		entry.detail = "documentation";
	}
	results.push(entry);
}

// ---- which `ice` runs -----------------------------------------------------

let iceBinary = { path: "", resolved: "", inWorktree: false };
try {
	const path = execFileSync("sh", ["-c", "command -v ice"], { encoding: "utf8" }).trim();
	const resolved = realpathSync(path);
	iceBinary = { path, resolved, inWorktree: !relative(root, resolved).startsWith("..") };
} catch {
	// no ice on PATH
}

const summary = {
	root,
	base,
	head: git("rev-parse", "--short", "HEAD"),
	iceBinary,
	distBuiltAt: existsSync("packages/coding-agent/dist/ice.js")
		? new Date(statSync("packages/coding-agent/dist/ice.js").mtimeMs).toISOString()
		: null,
	files: results,
};

if (flag("--json")) {
	console.log(JSON.stringify(summary, null, 2));
	process.exit(0);
}

const byCategory = new Map();
for (const r of results) {
	if (!byCategory.has(r.category)) byCategory.set(r.category, []);
	byCategory.get(r.category).push(r);
}
console.log(`root: ${root}`);
console.log(tip ? `commit: ${git("log", "-1", "--format=%h %s", tip)}  (HEAD: ${summary.head})` : `base: ${base}  head: ${summary.head}`);
console.log(`ice on PATH: ${iceBinary.path || "none"} -> ${iceBinary.resolved || "n/a"}${iceBinary.inWorktree ? " (this worktree)" : " (NOT this worktree)"}`);
console.log(`coding-agent dist built: ${summary.distBuiltAt ?? "no dist"}\n`);
for (const [category, items] of [...byCategory].sort((a, b) => b[1].length - a[1].length)) {
	console.log(`## ${category} (${items.length})`);
	for (const r of items) console.log(`- [${r.status}] ${r.path.split(sep).join("/")}  build=${r.build}${r.detail ? `  (${r.detail})` : ""}`);
	console.log("");
}
const stale = results.filter((r) => r.build === "stale" || r.build === "missing");
console.log(stale.length > 0 ? `STALE BUILD: ${stale.length} changed file(s) are not reflected in dist.` : "Build check: no stale files found.");
