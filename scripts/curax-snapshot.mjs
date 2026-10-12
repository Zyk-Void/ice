import { createReadStream } from "node:fs";
import { link, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

const CURRENT_FILE = "current.json";
const ALLOWED_RUNTIME_ROOTS = new Set(["", "dist", "node_modules", "package.json"]);
const ICE_RUNTIME_PACKAGE_NAME = "@zykairotis/ice-coding-agent";
const ICE_WORKSPACE_PACKAGE_PREFIXES = [
	"node_modules/@zykairotis/ice-ai/",
	"node_modules/@zykairotis/ice-tui/",
	"node_modules/@zykairotis/ice-agent-core/",
	"node_modules/@zykairotis/ice-protocol/",
	"node_modules/@zykairotis/ice-client/",
	"node_modules/@zykairotis/ice-storage-sqlite-node/",
	"node_modules/@zykairotis/ice-coding-agent/",
];
const OPTIONAL_CLIPBOARD_PACKAGE_PREFIX = "node_modules/@zykairotis/ice-clipboard/";
const REQUIRED_RUNTIME_FILES = [
	"package.json",
	"dist/ice.js",
	"dist/core/agent-session.js",
	"dist/modes/rpc/rpc-mode.js",
	"node_modules/@zykairotis/ice-ai/package.json",
	"node_modules/@zykairotis/ice-ai/dist/index.js",
	"node_modules/@zykairotis/ice-tui/package.json",
	"node_modules/@zykairotis/ice-tui/dist/index.js",
	"node_modules/@zykairotis/ice-agent-core/package.json",
	"node_modules/@zykairotis/ice-agent-core/dist/index.js",
	"node_modules/@zykairotis/ice-protocol/package.json",
	"node_modules/@zykairotis/ice-protocol/dist/index.js",
	"node_modules/@zykairotis/ice-client/package.json",
	"node_modules/@zykairotis/ice-client/dist/index.js",
	"node_modules/@zykairotis/ice-storage-sqlite-node/package.json",
	"node_modules/@zykairotis/ice-storage-sqlite-node/dist/index.js",
];
const MANIFEST_KEYS = new Set(["schemaVersion", "artifact", "sha256", "version", "sourceCommit", "sourceDirty"]);
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateCurrentManifest(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("current.json must contain an object");
	}
	if (Object.keys(value).some((key) => !MANIFEST_KEYS.has(key))) {
		throw new Error("current.json contains unsupported fields");
	}
	if (value.schemaVersion !== 1) throw new Error("current.json schemaVersion must be 1");
	if (
		typeof value.artifact !== "string" ||
		value.artifact.length === 0 ||
		value.artifact !== basename(value.artifact) ||
		value.artifact.includes("\\") ||
		value.artifact.startsWith(".") ||
		!value.artifact.endsWith(".tgz")
	) {
		throw new Error("current.json artifact must be a tarball basename");
	}
	if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
		throw new Error("current.json sha256 must be a lowercase SHA-256 digest");
	}
	if (typeof value.version !== "string" || !VERSION_PATTERN.test(value.version)) {
		throw new Error("current.json version must be a package version");
	}
	if (value.sourceCommit !== null && (typeof value.sourceCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.sourceCommit))) {
		throw new Error("current.json sourceCommit must be a Git commit or null");
	}
	if (value.sourceDirty !== null && typeof value.sourceDirty !== "boolean") {
		throw new Error("current.json sourceDirty must be true, false, or null");
	}
	return value;
}

function normalizeArchivePath(rawPath) {
	const path = rawPath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
	if (!path || path === ".") return "";
	if (path.startsWith("/") || path.split("/").includes("..")) {
		throw new Error(`Runtime archive contains an unsafe path: ${rawPath}`);
	}
	return path;
}

export function validateRuntimeArchive(archivePath, expectedVersion) {
	const result = spawnSync("tar", ["-tzf", basename(archivePath)], {
		cwd: dirname(archivePath),
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.status !== 0) {
		throw new Error(`Unable to validate runtime tarball: ${result.error?.message ?? result.stderr ?? "tar failed"}`);
	}

	const entries = result.stdout
		.split(/\r?\n/)
		.filter(Boolean)
		.map(normalizeArchivePath);
	const entrySet = new Set(entries);
	if (entrySet.size !== entries.length) throw new Error("Runtime tarball contains duplicate paths");
	const missing = REQUIRED_RUNTIME_FILES.filter((path) => !entrySet.has(path));
	if (missing.length > 0) {
		throw new Error(`Runtime tarball is missing required files: ${missing.join(", ")}`);
	}
	let packageJson;
	try {
		packageJson = JSON.parse(readArchiveMember(archivePath, "package.json"));
	} catch (error) {
		throw new Error(`Runtime tarball package.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (
		packageJson?.name !== ICE_RUNTIME_PACKAGE_NAME ||
		packageJson?.type !== "module" ||
		packageJson?.bin?.ice !== "dist/ice.js" ||
		typeof packageJson?.version !== "string" ||
		!VERSION_PATTERN.test(packageJson.version)
	) {
		throw new Error("Runtime tarball package.json does not describe the ICE coding-agent runtime");
	}
	if (expectedVersion !== undefined && packageJson.version !== expectedVersion) {
		throw new Error(`Runtime package version mismatch (expected ${expectedVersion}, found ${packageJson.version})`);
	}

	const forbidden = entries.filter((path) => {
		const lower = path.toLowerCase();
		if (/(^|\/)\.ice(\/|$)/.test(lower)) return true;
		if (/(^|\/)(test|tests|__tests__|__fixtures__)(\/|$)/.test(lower)) return true;
		if (/\.(?:test|spec)\.[^/]+$/i.test(path)) return true;
		if (/\.(?:d\.(?:ts|mts|cts)(?:\.map)?|map)$/i.test(path)) return true;
		if (!ALLOWED_RUNTIME_ROOTS.has(path.split("/")[0])) return true;
		if (path.startsWith("dist/")) {
			const runtimeRelativePath = path.slice("dist/".length);
			if (/(^|\/)(src|test|tests|docs|examples|sessions)(\/|$)/i.test(runtimeRelativePath)) return true;
			if (/(^|\/)(auth\.json|models\.json|settings\.json)$/i.test(runtimeRelativePath)) return true;
			if (/\.(?:d\.ts(?:\.map)?|map)$/i.test(path)) return true;
		}
		const workspacePrefix = ICE_WORKSPACE_PACKAGE_PREFIXES.find((prefix) => path.startsWith(prefix));
		if (workspacePrefix) {
			const packageRelativePath = path.slice(workspacePrefix.length);
			if (/(^|\/)(src|test|tests|docs|examples|sessions)(\/|$)/i.test(packageRelativePath)) return true;
			if (/(^|\/)(auth\.json|models\.json|settings\.json)$/i.test(packageRelativePath)) return true;
			if (/\.(?:d\.ts(?:\.map)?|map)$/i.test(path)) return true;
		}
		if (path.startsWith(OPTIONAL_CLIPBOARD_PACKAGE_PREFIX)) {
			const packageRelativePath = path.slice(OPTIONAL_CLIPBOARD_PACKAGE_PREFIX.length);
			if (/(^|\/)(src|test|tests)(\/|$)/i.test(packageRelativePath)) return true;
		}
		return false;
	});
	if (forbidden.length > 0) {
		throw new Error(`Runtime tarball contains excluded source or user data: ${forbidden.slice(0, 8).join(", ")}`);
	}

	return entries;
}

function readArchiveMember(archivePath, memberPath) {
	const result = spawnSync("tar", ["-xOzf", basename(archivePath), `./${memberPath}`], {
		cwd: dirname(archivePath),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.status !== 0) {
		throw new Error(result.error?.message ?? result.stderr ?? `tar could not read ${memberPath}`);
	}
	return result.stdout;
}

async function sha256File(filePath) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

export async function writeCurrentManifestAtomically(outputDirectory, manifest) {
	validateCurrentManifest(manifest);
	const temporaryPath = join(outputDirectory, `.${CURRENT_FILE}.${randomUUID()}.tmp`);
	const currentPath = join(outputDirectory, CURRENT_FILE);
	let file;
	try {
		file = await open(temporaryPath, "wx", 0o600);
		await file.writeFile(`${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
		await file.sync();
		await file.close();
		file = undefined;
		await rename(temporaryPath, currentPath);
	} finally {
		await file?.close().catch(() => {});
		await unlink(temporaryPath).catch(() => {});
	}
}

/** Validates and publishes an immutable tarball before atomically switching current.json. */
export async function publishSnapshotArtifact({ outputDirectory, temporaryArtifactPath, version, sourceCommit, sourceDirty }) {
	validateRuntimeArchive(temporaryArtifactPath, version);
	const sha256 = await sha256File(temporaryArtifactPath);
	const manifest = validateCurrentManifest({
		schemaVersion: 1,
		artifact: `ice-runtime-${version}-${sourceCommit?.slice(0, 12) ?? "unknown"}-${randomUUID()}.tgz`,
		sha256,
		version,
		sourceCommit,
		sourceDirty,
	});
	const artifactPath = join(outputDirectory, manifest.artifact);

	// Hard-linking the complete same-filesystem temporary archive publishes it atomically
	// without allowing a repeated name to replace an older immutable artifact.
	await link(temporaryArtifactPath, artifactPath);
	await unlink(temporaryArtifactPath);
	await writeCurrentManifestAtomically(outputDirectory, manifest);
	return { artifactPath, manifest };
}
