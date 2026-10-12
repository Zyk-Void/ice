import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { publishSnapshotArtifact, validateCurrentManifest, validateRuntimeArchive } from "./curax-snapshot.mjs";

const buildScript = fileURLToPath(new URL("./build-curax-snapshot.mjs", import.meta.url));
const runtimePackages = [
	["ice-ai", "dist/index.js"],
	["ice-tui", "dist/index.js"],
	["ice-agent-core", "dist/index.js"],
	["ice-protocol", "dist/index.js"],
	["ice-client", "dist/index.js"],
	["ice-storage-sqlite-node", "dist/index.js"],
];

async function createRuntimeArchive(directory, options = {}) {
	const runtimeDirectory = join(directory, `runtime-${Math.random().toString(36).slice(2)}`);
	await mkdir(runtimeDirectory, { recursive: true });
	if (options.legacyNestedLayout) {
		const packageRoot = join(runtimeDirectory, "node_modules/@zykairotis/ice-coding-agent");
		await mkdir(join(packageRoot, "dist"), { recursive: true });
		await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@zykairotis/ice-coding-agent", version: "0.83.0" }));
		await writeFile(join(packageRoot, "dist/ice.js"), "// legacy layout\\n");
	} else {
		const runtimePackageJson = {
			name: "@zykairotis/ice-coding-agent",
			version: options.packageVersion ?? "0.83.0",
			type: "module",
			bin: { ice: "dist/ice.js" },
			dependencies: Object.fromEntries(runtimePackages.map(([name]) => [`@zykairotis/${name}`, "0.83.0"])),
		};
		await writeFile(join(runtimeDirectory, "package.json"), JSON.stringify(runtimePackageJson));
		for (const runtimePath of ["dist/ice.js", "dist/core/agent-session.js", "dist/modes/rpc/rpc-mode.js"]) {
			const filePath = join(runtimeDirectory, runtimePath);
			await mkdir(join(filePath, ".."), { recursive: true });
			await writeFile(filePath, `// ${runtimePath} fixture\\n`);
		}
	}
	for (const [name, main] of runtimePackages) {
		const packageRoot = join(runtimeDirectory, "node_modules", "@zykairotis", name);
		await mkdir(join(packageRoot, main, ".."), { recursive: true });
		await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: `@zykairotis/${name}`, version: "0.83.0" }));
		await writeFile(join(packageRoot, main), "export {};\\n");
	}
	if (options.forbiddenPath) {
		const forbiddenPath = join(runtimeDirectory, options.forbiddenPath);
		await mkdir(join(forbiddenPath, ".."), { recursive: true });
		await writeFile(forbiddenPath, "not runtime content");
	}
	if (options.rootPath) {
		const userDataPath = join(runtimeDirectory, options.rootPath);
		await mkdir(join(userDataPath, ".."), { recursive: true });
		await writeFile(userDataPath, "not runtime content");
	}
	if (options.optionalClipboardSource) {
		const sourcePath = join(runtimeDirectory, "node_modules/@zykairotis/ice-clipboard/src/lib.rs");
		await mkdir(join(sourcePath, ".."), { recursive: true });
		await writeFile(sourcePath, "not runtime content");
	}
	if (options.externalTestDirectory) {
		const testPath = join(runtimeDirectory, "node_modules/isexe/test/index.js");
		await mkdir(join(testPath, ".."), { recursive: true });
		await writeFile(testPath, "not runtime content");
	}
	if (options.dependencyBuildArtifacts) {
		for (const buildPath of ["node_modules/isexe/index.js.map", "node_modules/@types/node/index.d.ts"]) {
			const filePath = join(runtimeDirectory, buildPath);
			await mkdir(join(filePath, ".."), { recursive: true });
			await writeFile(filePath, "not runtime content");
		}
	}
	const sdkSessionsPath = join(runtimeDirectory, "node_modules/@anthropic-ai/sdk/src/resources/beta/sessions/sessions.js");
	await mkdir(join(sdkSessionsPath, ".."), { recursive: true });
	await writeFile(sdkSessionsPath, "export const runtimeModule = true;\\n");

	const archivePath = join(directory, `fixture-${Math.random().toString(36).slice(2)}.tgz`);
	execFileSync("tar", ["--no-xattrs", "-czf", archivePath, "-C", runtimeDirectory, "."]);
	await rm(runtimeDirectory, { recursive: true, force: true });
	return archivePath;
}

async function createTempDirectory() {
	return mkdtemp(join(tmpdir(), "ice-curax-snapshot-test-"));
}

test("validates snapshot manifest fields and rejects path traversal or malformed identity", () => {
	const manifest = {
		schemaVersion: 1,
		artifact: "ice-runtime-0.83.0-build.tgz",
		sha256: "a".repeat(64),
		version: "0.83.0",
		sourceCommit: "b".repeat(40),
		sourceDirty: true,
	};
	assert.equal(validateCurrentManifest(manifest), manifest);
	assert.throws(() => validateCurrentManifest({ ...manifest, artifact: "../runtime.tgz" }), /basename/);
	assert.throws(() => validateCurrentManifest({ ...manifest, sha256: "not-a-digest" }), /SHA-256/);
	assert.throws(() => validateCurrentManifest({ ...manifest, version: "latest" }), /package version/);
	assert.throws(() => validateCurrentManifest({ ...manifest, sourceCommit: "unknown" }), /Git commit/);
	assert.throws(() => validateCurrentManifest({ ...manifest, schemaVersion: 2 }), /schemaVersion/);
});

test("enforces Curax root layout, package identity, and payload exclusions", async () => {
	const directory = await createTempDirectory();
	try {
		const archivePath = await createRuntimeArchive(directory);
		const entries = validateRuntimeArchive(archivePath, "0.83.0");
		assert.ok(entries.includes("package.json"));
		assert.ok(entries.includes("dist/ice.js"));
		assert.ok(entries.includes("dist/core/agent-session.js"));
		assert.ok(entries.includes("dist/modes/rpc/rpc-mode.js"));
		assert.ok(entries.includes("node_modules/@anthropic-ai/sdk/src/resources/beta/sessions/sessions.js"));
		assert.ok(!entries.includes("node_modules/@zykairotis/ice-coding-agent/dist/rpc-entry.js"));
		for (const privateFile of ["auth.json", "models.json", "settings.json"]) {
			assert.ok(!entries.some((entry) => entry === privateFile || entry.endsWith(`/${privateFile}`)));
		}

		const oldLayoutArchive = await createRuntimeArchive(directory, { legacyNestedLayout: true });
		assert.throws(() => validateRuntimeArchive(oldLayoutArchive), /missing required files/);
		const mismatchedPackageArchive = await createRuntimeArchive(directory, { packageVersion: "0.83.1" });
		assert.throws(() => validateRuntimeArchive(mismatchedPackageArchive, "0.83.0"), /version mismatch/);
		const incompleteArchive = await createRuntimeArchive(directory, { forbiddenPath: "dist/src/internal.ts" });
		assert.throws(() => validateRuntimeArchive(incompleteArchive), /excluded source or user data/);
		const privateDataArchive = await createRuntimeArchive(directory, { forbiddenPath: "dist/auth.json" });
		assert.throws(() => validateRuntimeArchive(privateDataArchive), /excluded source or user data/);
		const optionalSourceArchive = await createRuntimeArchive(directory, { optionalClipboardSource: true });
		assert.throws(() => validateRuntimeArchive(optionalSourceArchive), /excluded source or user data/);
		const dependencyTestArchive = await createRuntimeArchive(directory, { externalTestDirectory: true });
		assert.throws(() => validateRuntimeArchive(dependencyTestArchive), /excluded source or user data/);
		const dependencyBuildArchive = await createRuntimeArchive(directory, { dependencyBuildArtifacts: true });
		assert.throws(() => validateRuntimeArchive(dependencyBuildArchive), /excluded source or user data/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("publishes immutable artifacts with a byte-accurate digest and atomically switches current.json", async () => {
	const directory = await createTempDirectory();
	try {
		const firstTemp = await createRuntimeArchive(directory);
		const first = await publishSnapshotArtifact({
			outputDirectory: directory,
			temporaryArtifactPath: firstTemp,
			version: "0.83.0",
			sourceCommit: "c".repeat(40),
			sourceDirty: true,
		});
		const firstBytes = await readFile(first.artifactPath);
		assert.equal(first.manifest.sha256, createHash("sha256").update(firstBytes).digest("hex"));
		assert.equal(first.manifest.sourceDirty, true);
		assert.equal(first.manifest.sourceCommit, "c".repeat(40));
		assert.equal(first.manifest.artifact, first.artifactPath.split(/[\\/]/).at(-1));

		const secondTemp = await createRuntimeArchive(directory);
		const second = await publishSnapshotArtifact({
			outputDirectory: directory,
			temporaryArtifactPath: secondTemp,
			version: "0.83.0",
			sourceCommit: "c".repeat(40),
			sourceDirty: true,
		});
		assert.notEqual(second.manifest.artifact, first.manifest.artifact);
		assert.deepEqual(await readFile(first.artifactPath), firstBytes);
		assert.deepEqual(JSON.parse(await readFile(join(directory, "current.json"), "utf8")), second.manifest);
		assert.ok((await readdir(directory)).every((name) => !name.endsWith(".tmp")));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("artifact validation failure leaves the previously published current.json untouched", async () => {
	const directory = await createTempDirectory();
	try {
		const firstTemp = await createRuntimeArchive(directory);
		await publishSnapshotArtifact({
			outputDirectory: directory,
			temporaryArtifactPath: firstTemp,
			version: "0.83.0",
			sourceCommit: "d".repeat(40),
			sourceDirty: false,
		});
		const previousPointer = await readFile(join(directory, "current.json"));
		const invalidTemp = await createRuntimeArchive(directory, { rootPath: "sessions/session.jsonl" });
		await assert.rejects(
			publishSnapshotArtifact({
				outputDirectory: directory,
				temporaryArtifactPath: invalidTemp,
				version: "0.83.0",
				sourceCommit: "d".repeat(40),
				sourceDirty: false,
			}),
			/excluded source or user data/,
		);
		assert.deepEqual(await readFile(join(directory, "current.json")), previousPointer);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the build command requires an output directory and documents it in help", () => {
	const help = spawnSync(process.execPath, [buildScript, "--help"], { encoding: "utf8" });
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /--out <directory>/);

	const missingOutput = spawnSync(process.execPath, [buildScript], { encoding: "utf8" });
	assert.equal(missingOutput.status, 1);
	assert.match(missingOutput.stderr, /output directory is required/i);
});
