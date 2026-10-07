#!/usr/bin/env node

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { installIceRuntimePackages, ICE_RUNTIME_PACKAGES, packIceRuntimePackages } from "./ice-runtime-packaging.mjs";
import { publishSnapshotArtifact, validateRuntimeArchive } from "./curax-snapshot.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const codingAgentPackageName = "@zykairotis/ice-coding-agent";

function printUsage() {
	console.log(`Usage: npm run build:curax-snapshot -- --out <directory>

Packages the already-built ICE RPC runtime and its npm dependency closure into an
immutable .tgz, then atomically updates <directory>/current.json. The required output directory must be outside this repository. This command does not build ICE.

The archive root contains the coding-agent package (including dist/ice.js) and
its node_modules closure. ICE source, tests, user data, dependency tests, and
build metadata, type declarations, and source maps are excluded. Third-party source-like files are retained only
when they are runtime modules required by a dependency. Before publication,
the extracted archive must pass offline metadata and bounded JSON-RPC startup.
`);
}

function parseArgs(args) {
	let outputDirectory;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--help") return { help: true };
		if (argument === "--out") {
			outputDirectory = args[++index];
			if (!outputDirectory || outputDirectory.startsWith("--")) throw new Error("--out requires a directory");
			continue;
		}
		throw new Error(`Unknown option: ${argument}`);
	}
	if (!outputDirectory) throw new Error("An output directory is required. Use --out <directory>.");
	return { help: false, outputDirectory: resolve(outputDirectory) };
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const capture = options.capture === true;
	// npm scripts may be launched through Corepack while PATH still contains a
	// different system npm. Keep child pack/install commands on the same npm.
	const npmEntrypoint = command === "npm" ? process.env.npm_execpath : undefined;
	const result = spawnSync(npmEntrypoint ? process.execPath : command, npmEntrypoint ? [npmEntrypoint, ...args] : args, {
		cwd: options.cwd,
		encoding: "utf8",
		shell: !npmEntrypoint && command === "npm" && process.platform === "win32",
		stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
	});
	if (result.error || result.status !== 0) {
		throw new Error(`Command failed: ${[command, ...args].join(" ")}${result.error ? ` (${result.error.message})` : ""}`);
	}
	return result.stdout ?? "";
}

function isInsidePath(child, parent) {
	const path = relative(parent, child);
	return path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path));
}

function assertOutputOutsideRepository(outputDirectory) {
	const canonicalRoot = realpathSync(repoRoot);
	const resolvedOutput = resolve(outputDirectory);
	if (isInsidePath(resolvedOutput, canonicalRoot)) {
		throw new Error(`Output directory must be outside the repository: ${resolvedOutput}`);
	}

	let ancestor = resolvedOutput;
	while (!existsSync(ancestor)) ancestor = dirname(ancestor);
	const canonicalAncestor = realpathSync(ancestor);
	if (isInsidePath(canonicalAncestor, canonicalRoot)) {
		throw new Error(`Output directory resolves inside the repository: ${resolvedOutput}`);
	}
	return resolvedOutput;
}

function assertBuiltWorkspacePackages() {
	for (const pkg of ICE_RUNTIME_PACKAGES) {
		const packageRoot = join(repoRoot, pkg.directory);
		const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		if (packageJson.name !== pkg.name) {
			throw new Error(`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.name}`);
		}
		const main = typeof packageJson.main === "string" ? packageJson.main.replace(/^\.\//, "") : undefined;
		if (main && !existsSync(join(packageRoot, main))) {
			throw new Error(`Built runtime entry is missing: ${pkg.directory}/${main}; build ICE before packaging a snapshot.`);
		}
		if (!existsSync(join(packageRoot, "dist"))) {
			throw new Error(`Built runtime output is missing: ${pkg.directory}/dist; build ICE before packaging a snapshot.`);
		}
	}
	const codingAgentRoot = join(repoRoot, "packages/coding-agent");
	for (const entry of ["dist/ice.js", "dist/core/agent-session.js", "dist/modes/rpc/rpc-mode.js"]) {
		if (!existsSync(join(codingAgentRoot, entry))) {
			throw new Error(`Built ICE launcher runtime file is missing: packages/coding-agent/${entry}; build ICE before packaging a snapshot.`);
		}
	}
}

function removeTreeEntry(path) {
	if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function pruneInternalPackage(packageRoot) {
	for (const name of ["README.md", "CHANGELOG.md", "docs", "examples", "npm-shrinkwrap.json", "src", "test", "tests"]) {
		removeTreeEntry(join(packageRoot, name));
	}

	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Runtime package contains a symlink that is not portable: ${path}`);
			if (entry.isDirectory()) {
				if (["src", "test", "tests"].includes(entry.name.toLowerCase())) {
					removeTreeEntry(path);
				} else {
					visit(path);
				}
			} else if (entry.isFile() && /\.(?:d\.(?:ts|mts|cts)(?:\.map)?|map)$/i.test(entry.name)) {
				removeTreeEntry(path);
			}
		}
	};
	visit(packageRoot);
}

function pruneRuntimeDist(distDirectory) {
	const testDirectoryNames = new Set(["test", "tests", "__tests__", "__fixtures__"]);
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (testDirectoryNames.has(entry.name.toLowerCase())) {
					removeTreeEntry(path);
				} else {
					visit(path);
				}
			} else if (
				entry.isFile() &&
				(/\.(?:d\.(?:ts|mts|cts)(?:\.map)?|map)$/i.test(entry.name) || /\.(?:test|spec)\.[^.]+$/i.test(entry.name))
			) {
				removeTreeEntry(path);
			}
		}
	};
	visit(distDirectory);
}

// Third-party src/ can be the package's actual runtime entry, so preserve it.
// Remove only unneeded tests, TypeScript declarations, and source maps here.
function pruneDependencyBuildArtifacts(nodeModulesDirectory) {
	const testDirectoryNames = new Set(["test", "tests", "__tests__", "__fixtures__"]);
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (testDirectoryNames.has(entry.name.toLowerCase())) {
					removeTreeEntry(path);
				} else {
					visit(path);
				}
			} else if (
				entry.isFile() &&
				(/\.(?:test|spec)\.[^.]+$/i.test(entry.name) || /\.(?:d\.(?:ts|mts|cts)(?:\.map)?|map)$/i.test(entry.name))
			) {
				removeTreeEntry(path);
			}
		}
	};
	visit(nodeModulesDirectory);
}

function prepareRuntimeTree(runtimeDirectory, version) {
	const codingAgentPackage = join(runtimeDirectory, "node_modules", ...codingAgentPackageName.split("/"));
	if (!existsSync(codingAgentPackage)) throw new Error(`Installed runtime package is missing: ${codingAgentPackageName}`);
	const codingAgentManifest = JSON.parse(readFileSync(join(codingAgentPackage, "package.json"), "utf8"));
	if (codingAgentManifest.name !== codingAgentPackageName || codingAgentManifest.version !== version) {
		throw new Error("Installed coding-agent package identity does not match the snapshot version");
	}
	const packageDist = join(codingAgentPackage, "dist");
	const runtimeDist = join(runtimeDirectory, "dist");
	if (!existsSync(packageDist) || existsSync(runtimeDist)) {
		throw new Error("Unable to stage the coding-agent dist directory at the snapshot root");
	}
	cpSync(packageDist, runtimeDist, { recursive: true });
	pruneRuntimeDist(runtimeDist);
	removeTreeEntry(codingAgentPackage);

	for (const pkg of ICE_RUNTIME_PACKAGES) {
		if (pkg.name === codingAgentPackageName) continue;
		const packageRoot = join(runtimeDirectory, "node_modules", ...pkg.name.split("/"));
		if (!existsSync(packageRoot)) throw new Error(`Installed runtime package is missing: ${pkg.name}`);
		pruneInternalPackage(packageRoot);
	}

	// This optional N-API package loads its compiled platform binary at runtime;
	// Rust sources and build inputs are not part of the runtime closure.
	const clipboardPackage = join(runtimeDirectory, "node_modules/@zykairotis/ice-clipboard");
	for (const name of ["src", "test", "tests", "README.md", "index.d.ts", "build.rs", "Cargo.toml", ".yarnrc.yml", "exp.ts"]) {
		removeTreeEntry(join(clipboardPackage, name));
	}

	// Npm's temporary local-tarball manifest, lock files, and shims are not part
	// of the runtime. The root package and root node_modules match Curax's layout.
	removeTreeEntry(join(runtimeDirectory, "package-lock.json"));
	removeTreeEntry(join(runtimeDirectory, "node_modules", ".package-lock.json"));
	removeTreeEntry(join(runtimeDirectory, "node_modules", ".bin"));
	for (const name of ["ice", "ice.cmd", "ice.ps1"]) removeTreeEntry(join(runtimeDirectory, name));
	pruneDependencyBuildArtifacts(join(runtimeDirectory, "node_modules"));
	writeFileSync(join(runtimeDirectory, "package.json"), `${JSON.stringify(codingAgentManifest, null, "\t")}\n`);
}

function assertNoSymlinks(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error(`Runtime tree contains a non-portable symlink: ${path}`);
		if (entry.isDirectory()) assertNoSymlinks(path);
	}
}

function readSourceState() {
	const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
	const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	if (commit.error || commit.status !== 0 || status.error || status.status !== 0) {
		return { sourceCommit: null, sourceDirty: null };
	}
	return {
		sourceCommit: commit.stdout.trim(),
		sourceDirty: status.stdout.length > 0,
	};
}

function createTarball(outputDirectory, runtimeDirectory, temporaryName) {
	const runtimePath = relative(outputDirectory, runtimeDirectory).replaceAll("\\", "/");
	const args = ["--no-xattrs", "-czf", temporaryName, "-C", runtimePath, "."];
	const result = spawnSync("tar", args, { cwd: outputDirectory, stdio: "inherit" });
	if (result.error || result.status !== 0) {
		throw new Error(`Unable to create runtime tarball${result.error ? `: ${result.error.message}` : ""}`);
	}
}

function smokeEnvironment(directory) {
	const environment = {};
	const allowedVariables = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL"]);
	for (const [name, value] of Object.entries(process.env)) {
		if (allowedVariables.has(name.toUpperCase()) && value !== undefined) environment[name] = value;
	}
	const homeDirectory = join(directory, "home");
	const agentDirectory = join(directory, "agent");
	const sessionDirectory = join(directory, "sessions");
	for (const path of [homeDirectory, agentDirectory, sessionDirectory, join(directory, "tmp")]) {
		mkdirSync(path, { recursive: true });
	}
	return {
		...environment,
		HOME: homeDirectory,
		USERPROFILE: homeDirectory,
		XDG_CONFIG_HOME: join(homeDirectory, ".config"),
		TMPDIR: join(directory, "tmp"),
		TMP: join(directory, "tmp"),
		TEMP: join(directory, "tmp"),
		ICE_CODING_AGENT_DIR: agentDirectory,
		ICE_CODING_AGENT_SESSION_DIR: sessionDirectory,
		ICE_OFFLINE: "1",
	};
}

function runSnapshotSmokeCommand(label, launcherPath, args, cwd, environment, input) {
	console.log(`$ node dist/ice.js ${args.join(" ")}`);
	const result = spawnSync(process.execPath, [launcherPath, ...args], {
		cwd,
		env: environment,
		encoding: "utf8",
		input,
		maxBuffer: 8 * 1024 * 1024,
		timeout: 15_000,
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (result.error || result.status !== 0) {
		const diagnostics = [result.error?.message, result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join("\n").slice(-6000);
		throw new Error(`Snapshot runtime smoke verification failed (${label}, exit ${String(result.status)}): ${diagnostics}`);
	}
	return result.stdout ?? "";
}

function verifySnapshotRuntime(archivePath, verificationDirectory, expectedVersion) {
	validateRuntimeArchive(archivePath, expectedVersion);
	mkdirSync(verificationDirectory, { recursive: true });
	const extraction = spawnSync("tar", ["-xzf", basename(archivePath), "-C", verificationDirectory], {
		cwd: dirname(archivePath),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (extraction.error || extraction.status !== 0) {
		throw new Error(`Snapshot runtime smoke verification failed (extract): ${extraction.error?.message ?? extraction.stderr ?? "tar failed"}`);
	}
	assertNoSymlinks(verificationDirectory);
	const packageJson = JSON.parse(readFileSync(join(verificationDirectory, "package.json"), "utf8"));
	if (packageJson.version !== expectedVersion || packageJson.bin?.ice !== "dist/ice.js") {
		throw new Error("Snapshot runtime smoke verification failed (root package metadata mismatch)");
	}
	const environment = smokeEnvironment(join(verificationDirectory, ".smoke"));
	const launcherPath = join(verificationDirectory, "dist/ice.js");
	const versionOutput = runSnapshotSmokeCommand(
		"offline version",
		launcherPath,
		["--offline", "--version"],
		verificationDirectory,
		environment,
	);
	if (!versionOutput.includes(expectedVersion)) {
		throw new Error(`Snapshot runtime smoke verification failed (expected version ${expectedVersion}, got ${versionOutput.trim()})`);
	}
	runSnapshotSmokeCommand("offline model metadata", launcherPath, ["--offline", "--list-models"], verificationDirectory, environment);
	const rpcOutput = runSnapshotSmokeCommand(
		"RPC get_state",
		launcherPath,
		["--mode", "rpc"],
		verificationDirectory,
		environment,
		`${JSON.stringify({ type: "get_state", id: "snapshot-runtime-smoke" })}\n`,
	);
	const stateResponse = rpcOutput
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return undefined;
			}
		})
		.find((message) => message?.id === "snapshot-runtime-smoke" && message?.type === "response");
	if (!stateResponse?.success || stateResponse.command !== "get_state") {
		throw new Error("Snapshot runtime smoke verification failed (RPC get_state response missing or unsuccessful)");
	}
	console.log("Snapshot extracted-runtime smoke passed: offline metadata and RPC get_state.");
}

export async function buildCuraxSnapshot(outputPath) {
	const outputDirectory = assertOutputOutsideRepository(outputPath);
	mkdirSync(outputDirectory, { recursive: true });
	const canonicalOutputDirectory = realpathSync(outputDirectory);
	if (isInsidePath(canonicalOutputDirectory, realpathSync(repoRoot))) {
		throw new Error(`Output directory resolves inside the repository: ${canonicalOutputDirectory}`);
	}

	const packageJson = JSON.parse(readFileSync(join(repoRoot, "packages/coding-agent/package.json"), "utf8"));
	const version = packageJson.version;
	const buildId = randomUUID();
	const stagingDirectory = join(canonicalOutputDirectory, `.ice-curax-snapshot-${buildId}`);
	const tarballDirectory = join(stagingDirectory, "tarballs");
	const runtimeDirectory = join(stagingDirectory, "runtime");
	const temporaryArtifactName = `.ice-runtime-${buildId}.partial.tgz`;
	const temporaryArtifactPath = join(canonicalOutputDirectory, temporaryArtifactName);

	try {
		assertBuiltWorkspacePackages();
		mkdirSync(tarballDirectory, { recursive: true });
		const tarballs = packIceRuntimePackages(repoRoot, tarballDirectory, run);
		installIceRuntimePackages(runtimeDirectory, tarballs, {
			createIceShim: false,
			installArgs: ["--omit=dev", "--ignore-scripts"],
			packageManager: "npm",
			run,
		});
		prepareRuntimeTree(runtimeDirectory, version);
		assertNoSymlinks(runtimeDirectory);
		createTarball(canonicalOutputDirectory, runtimeDirectory, temporaryArtifactName);
		verifySnapshotRuntime(temporaryArtifactPath, join(stagingDirectory, "verification"), version);

		const sourceState = readSourceState();
		const published = await publishSnapshotArtifact({
			outputDirectory: canonicalOutputDirectory,
			temporaryArtifactPath,
			version,
			...sourceState,
		});
		console.log(`Wrote immutable ICE Curax snapshot: ${published.artifactPath}`);
		console.log(`Updated ${join(canonicalOutputDirectory, "current.json")}`);
		console.log(`ICE launcher: ${published.manifest.artifact} -> dist/ice.js --mode rpc`);
		return published;
	} finally {
		removeTreeEntry(stagingDirectory);
		removeTreeEntry(temporaryArtifactPath);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printUsage();
		return;
	}
	await buildCuraxSnapshot(options.outputDirectory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
