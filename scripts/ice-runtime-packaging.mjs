import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const ICE_RUNTIME_PACKAGES = Object.freeze([
	{ directory: "packages/ai", name: "@zykairotis/ice-ai" },
	{ directory: "packages/tui", name: "@zykairotis/ice-tui" },
	{ directory: "packages/agent", name: "@zykairotis/ice-agent-core" },
	{ directory: "packages/protocol", name: "@zykairotis/ice-protocol" },
	{ directory: "packages/client", name: "@zykairotis/ice-client" },
	{ directory: "packages/storage/sqlite-node", name: "@zykairotis/ice-storage-sqlite-node" },
	{ directory: "packages/coding-agent", name: "@zykairotis/ice-coding-agent" },
]);

function fileSpecifier(fromDirectory, file) {
	const relativePath = relative(fromDirectory, file).replaceAll("\\", "/");
	return `file:${relativePath.startsWith(".") ? relativePath : `./${relativePath}`}`;
}

/** Packs the already-built first-party workspaces used by local-release. */
export function packIceRuntimePackages(repoRoot, tarballDirectory, run) {
	const tarballs = new Map();

	for (const pkg of ICE_RUNTIME_PACKAGES) {
		const packageJson = JSON.parse(readFileSync(join(repoRoot, pkg.directory, "package.json"), "utf8"));
		if (packageJson.name !== pkg.name) {
			throw new Error(`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.name}`);
		}

		const output = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", tarballDirectory], {
			capture: true,
			cwd: join(repoRoot, pkg.directory),
		});
		const parsed = JSON.parse(output);
		const packed = Array.isArray(parsed) ? parsed[0] : parsed[packageJson.name];
		if (!packed?.filename) {
			throw new Error(`npm pack did not return a filename for ${packageJson.name}`);
		}
		tarballs.set(pkg.name, join(tarballDirectory, packed.filename));
	}

	return tarballs;
}

/** Installs packed workspace tarballs and their npm-resolved runtime closure. */
export function installIceRuntimePackages(installDirectory, tarballs, options) {
	const dependencies = Object.fromEntries(
		ICE_RUNTIME_PACKAGES.map((pkg) => [pkg.name, fileSpecifier(installDirectory, tarballs.get(pkg.name))]),
	);
	const packageJson = `${JSON.stringify({ private: true, dependencies, overrides: dependencies }, undefined, "\t")}\n`;
	mkdirSync(installDirectory, { recursive: true });
	writeFileSync(join(installDirectory, "package.json"), packageJson);
	options.run(options.packageManager, ["install", ...options.installArgs], { cwd: installDirectory });
	if (options.createIceShim !== false) createIceShim(installDirectory);
}

function createIceShim(installDirectory) {
	const binDirectory = join(installDirectory, "node_modules", ".bin");
	if (process.platform === "win32") {
		if (existsSync(join(binDirectory, "ice.cmd"))) {
			writeFileSync(join(installDirectory, "ice.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\ice.cmd" %*\r\n');
			writeFileSync(join(installDirectory, "ice.ps1"), '& "$PSScriptRoot/node_modules/.bin/ice.ps1" @args\n');
			return;
		}
		writeFileSync(join(installDirectory, "ice.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\ice.exe" %*\r\n');
		writeFileSync(join(installDirectory, "ice.ps1"), '& "$PSScriptRoot/node_modules/.bin/ice.exe" @args\n');
		return;
	}
	symlinkSync(join("node_modules", ".bin", "ice"), join(installDirectory, "ice"));
}
