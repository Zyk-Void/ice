import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildRepoOrientationPacket,
	buildSubagentContextManifest,
	renderSubagentContextManifestSection,
	SUBAGENT_CONTEXT_BOOTSTRAP_LIMITS,
	type SubagentContextManifest,
	selectInstructionChain,
} from "../src/ice-subagent-context-bootstrap.ts";

const createdDirs: string[] = [];

afterEach(() => {
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTree(): string {
	const dir = mkdtempSync(join(tmpdir(), "ice-context-bootstrap-"));
	createdDirs.push(dir);
	return dir;
}

function write(tree: string, rel: string, content: string): void {
	const abs = join(tree, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
}

function expectedSha(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

describe("selectInstructionChain", () => {
	it("selects the root AGENTS.md with the root instructions reason", () => {
		const tree = makeTree();
		write(tree, "AGENTS.md", "root rules\n");
		write(tree, "src/a.ts", "export {};\n");

		const chain = selectInstructionChain({ cwd: tree, roots: [], targets: ["src/a.ts"] });

		expect(chain).toHaveLength(1);
		expect(chain[0]).toMatchObject({
			relativePath: "AGENTS.md",
			reason: "root instructions",
			bytes: Buffer.byteLength("root rules\n", "utf8"),
			sha256: expectedSha("root rules\n"),
		});
		expect(chain[0]?.absolutePath).toBe(join(tree, "AGENTS.md"));
	});

	it("selects nested AGENTS.md only when it governs a target", () => {
		const tree = makeTree();
		write(tree, "AGENTS.md", "root rules\n");
		write(tree, "src/AGENTS.md", "src rules\n");
		write(tree, "docs/AGENTS.md", "docs rules\n");
		write(tree, "src/a.ts", "export {};\n");

		const chain = selectInstructionChain({ cwd: tree, roots: [], targets: ["src/a.ts"] });

		expect(chain.map((entry) => entry.relativePath)).toEqual(["AGENTS.md", "src/AGENTS.md"]);
		expect(chain[1]?.reason).toBe("governs target src/a.ts");
	});

	it("deduplicates shared ancestors and picks deterministic reasons per file", () => {
		const tree = makeTree();
		write(tree, "AGENTS.md", "root rules\n");
		write(tree, "src/AGENTS.md", "src rules\n");
		write(tree, "src/nested/AGENTS.md", "nested rules\n");
		write(tree, "src/nested/a.ts", "export {};\n");
		write(tree, "src/b.ts", "export {};\n");
		write(tree, "src/nested/c.ts", "export {};\n");

		const chain = selectInstructionChain({
			cwd: tree,
			roots: [],
			targets: ["src/nested/a.ts", "src/b.ts", "src/nested/c.ts"],
		});

		expect(chain.map((entry) => entry.relativePath)).toEqual(["AGENTS.md", "src/AGENTS.md", "src/nested/AGENTS.md"]);
		expect(chain.map((entry) => entry.reason)).toEqual([
			"root instructions",
			"governs target src/b.ts",
			"governs target src/nested/a.ts",
		]);
	});

	it("selects AGENTS.md governing an approved root directory", () => {
		const tree = makeTree();
		write(tree, "libs/AGENTS.md", "libs rules\n");

		const chain = selectInstructionChain({ cwd: tree, roots: ["libs"], targets: [] });

		expect(chain).toHaveLength(1);
		expect(chain[0]?.relativePath).toBe("libs/AGENTS.md");
		expect(chain[0]?.reason).toBe("governs root libs");
	});

	it("rejects a symlinked AGENTS.md without following it", () => {
		const tree = makeTree();
		write(tree, "real-agents.md", "real rules\n");
		write(tree, "evil/placeholder", "x");
		symlinkSync(join(tree, "real-agents.md"), join(tree, "evil", "AGENTS.md"));

		const chain = selectInstructionChain({ cwd: tree, roots: [], targets: ["evil/x.ts"] });

		expect(chain).toEqual([]);
	});

	it("rejects AGENTS.md behind a symlinked directory", () => {
		const tree = makeTree();
		write(tree, "real/AGENTS.md", "real rules\n");
		write(tree, "real/a.ts", "export {};\n");
		symlinkSync(join(tree, "real"), join(tree, "alias"), "dir");

		const chain = selectInstructionChain({ cwd: tree, roots: [], targets: ["alias/a.ts"] });

		expect(chain).toEqual([]);
	});

	it("rejects targets and roots that escape cwd and never selects outside content", () => {
		const tree = makeTree();
		write(tree, "AGENTS.md", "root rules\n");
		write(tree, "outside/AGENTS.md", "OUTSIDE-RULES\n");

		const chain = selectInstructionChain({
			cwd: tree,
			roots: [".."],
			targets: ["../outside/a.ts"],
		});

		expect(chain.map((entry) => entry.relativePath)).toEqual(["AGENTS.md"]);
		expect(JSON.stringify(chain)).not.toContain("outside");
	});

	it("skips missing files and trees without AGENTS.md without throwing", () => {
		const tree = makeTree();
		write(tree, "src/a.ts", "export {};\n");

		expect(selectInstructionChain({ cwd: tree, roots: [], targets: ["missing/deep/a.ts"] })).toEqual([]);
	});

	it("caps the instruction count and records over-cap files as omitted", () => {
		const tree = makeTree();
		const targets: string[] = [];
		for (let index = 1; index <= 20; index++) {
			const name = `d${String(index).padStart(2, "0")}`;
			write(tree, `${name}/AGENTS.md`, `rules ${index}\n`);
			write(tree, `${name}/a.ts`, "export {};\n");
			targets.push(`${name}/a.ts`);
		}

		const chain = selectInstructionChain({ cwd: tree, roots: [], targets });
		const manifest = buildSubagentContextManifest({ cwd: tree, roots: [], targets });

		expect(chain).toHaveLength(SUBAGENT_CONTEXT_BOOTSTRAP_LIMITS.maxInstructionFiles);
		const relativePaths = chain.map((entry) => entry.relativePath);
		expect(relativePaths).toEqual([...relativePaths].sort());
		expect(relativePaths[0]).toBe("d01/AGENTS.md");
		expect(relativePaths[15]).toBe("d16/AGENTS.md");
		const capOmissions = manifest.omitted.filter((entry) => entry.reason.includes("instruction file limit"));
		expect(capOmissions.map((entry) => entry.identifier)).toEqual([
			"d17/AGENTS.md",
			"d18/AGENTS.md",
			"d19/AGENTS.md",
			"d20/AGENTS.md",
		]);
	});

	it("skips instruction files over the per-file byte cap and records the omission", () => {
		const tree = makeTree();
		write(tree, "big/AGENTS.md", "a".repeat(SUBAGENT_CONTEXT_BOOTSTRAP_LIMITS.maxInstructionFileBytes + 1));
		write(tree, "big/a.ts", "export {};\n");
		write(tree, "small/AGENTS.md", "small rules\n");
		write(tree, "small/a.ts", "export {};\n");

		const chain = selectInstructionChain({ cwd: tree, roots: [], targets: ["big/a.ts", "small/a.ts"] });
		const manifest = buildSubagentContextManifest({ cwd: tree, roots: [], targets: ["big/a.ts", "small/a.ts"] });

		expect(chain.map((entry) => entry.relativePath)).toEqual(["small/AGENTS.md"]);
		expect(manifest.omitted).toContainEqual({
			identifier: "big/AGENTS.md",
			reason: `exceeds per-file limit of ${SUBAGENT_CONTEXT_BOOTSTRAP_LIMITS.maxInstructionFileBytes} bytes`,
		});
	});
});

describe("buildRepoOrientationPacket", () => {
	it("is deterministic, includes the package name, roots, and target lines", () => {
		const tree = makeTree();
		write(tree, "package.json", JSON.stringify({ name: "fixture-pkg" }));
		write(tree, "src/core/loop.ts", "export {};\n");
		write(tree, "src/a.ts", "export {};\n");

		const input = { cwd: tree, roots: ["src/core"], targets: ["src/a.ts", "src/core/loop.ts"] };
		const packet = buildRepoOrientationPacket(input);

		expect(packet.text).toContain("Repository orientation packet");
		expect(packet.text).toContain("package: fixture-pkg");
		expect(packet.text).toContain("root .");
		expect(packet.text).toContain("- src/");
		expect(packet.text).toContain("- package.json");
		expect(packet.text).toContain("root src/core");
		expect(packet.text).toContain("target src/a.ts: parent src, file a.ts");
		expect(packet.text).toContain("target src/core/loop.ts: parent core, file loop.ts");
		expect(packet.bytes).toBe(Buffer.byteLength(packet.text, "utf8"));
		expect(packet.sha256).toBe(expectedSha(packet.text));
		expect(buildRepoOrientationPacket(input)).toEqual(packet);
	});

	it("truncates at a line boundary within the 8 KiB cap without splitting characters", () => {
		const tree = makeTree();
		const targets: string[] = [];
		for (let index = 0; index < 300; index++) {
			const name = `t${String(index).padStart(4, "0")}-with-a-long-name-for-truncation-\u00e9\u00e5.ts`;
			targets.push(`src/${name}`);
		}

		const packet = buildRepoOrientationPacket({ cwd: tree, roots: [], targets });

		expect(packet.bytes).toBeLessThanOrEqual(SUBAGENT_CONTEXT_BOOTSTRAP_LIMITS.maxOrientationPacketBytes);
		expect(packet.text.endsWith("[orientation packet truncated]")).toBe(true);
		expect(packet.text).not.toContain("\uFFFD");
		expect(packet.bytes).toBe(Buffer.byteLength(packet.text, "utf8"));
		expect(buildRepoOrientationPacket({ cwd: tree, roots: [], targets })).toEqual(packet);
	});
});

describe("buildSubagentContextManifest", () => {
	it("yields an empty manifest with a stable hash for empty trees", () => {
		const treeA = makeTree();
		const treeB = makeTree();

		const manifestA = buildSubagentContextManifest({ cwd: treeA, roots: [], targets: [] });
		const manifestB = buildSubagentContextManifest({ cwd: treeB, roots: [], targets: [] });

		expect(manifestA.entries).toEqual([]);
		expect(manifestA.omitted).toEqual([]);
		expect(manifestA.totalBytes).toBe(0);
		expect(manifestA.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(manifestA.hash).toBe(manifestB.hash);
	});

	it("is hash-stable for equal trees and changes when instruction content changes", () => {
		const treeA = makeTree();
		write(treeA, "AGENTS.md", "rules v1\n");
		write(treeA, "src/AGENTS.md", "src rules v1\n");
		write(treeA, "src/a.ts", "export {};\n");
		const treeB = makeTree();
		write(treeB, "AGENTS.md", "rules v1\n");
		write(treeB, "src/AGENTS.md", "src rules v1\n");
		write(treeB, "src/a.ts", "export {};\n");

		const input = { cwd: treeA, roots: [], targets: ["src/a.ts"] };
		const manifestA = buildSubagentContextManifest(input);
		const manifestB = buildSubagentContextManifest({ cwd: treeB, roots: [], targets: ["src/a.ts"] });

		expect(manifestA.entries).toEqual(manifestB.entries);
		expect(manifestA.omitted).toEqual(manifestB.omitted);
		expect(manifestA.totalBytes).toBe(manifestB.totalBytes);
		expect(manifestA.hash).toBe(manifestB.hash);

		write(treeB, "src/AGENTS.md", "src rules v2\n");
		const manifestChanged = buildSubagentContextManifest({ cwd: treeB, roots: [], targets: ["src/a.ts"] });
		expect(manifestChanged.hash).not.toBe(manifestA.hash);
	});

	it("classifies entries as untrusted repo instructions and attaches the orientation packet", () => {
		const tree = makeTree();
		write(tree, "AGENTS.md", "root rules\n");
		write(tree, "src/AGENTS.md", "src rules\n");
		write(tree, "src/a.ts", "export {};\n");

		const manifest = buildSubagentContextManifest({ cwd: tree, roots: [], targets: ["src/a.ts"] });

		expect(manifest.entries.map((entry) => entry.identifier)).toEqual([
			"AGENTS.md",
			"orientation-packet",
			"src/AGENTS.md",
		]);
		for (const entry of manifest.entries) {
			expect(entry.sourceType === "instruction" || entry.sourceType === "repo_map").toBe(true);
			expect(entry.trust).toBe("untrusted_repo");
		}
		const instructionEntries = manifest.entries.filter((entry) => entry.sourceType === "instruction");
		expect(instructionEntries.map((entry) => entry.reasonSelected)).toEqual([
			"root instructions",
			"governs target src/a.ts",
		]);
		const orientation = manifest.entries.find((entry) => entry.identifier === "orientation-packet");
		expect(orientation?.sourceType).toBe("repo_map");
		expect(orientation?.reasonSelected).toBe("orientation packet");
		expect(manifest.totalBytes).toBe(manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0));
	});

	it("records symlink and cwd-escape rejections in omitted", () => {
		const tree = makeTree();
		write(tree, "real/AGENTS.md", "real rules\n");
		write(tree, "real/a.ts", "export {};\n");
		symlinkSync(join(tree, "real"), join(tree, "alias"), "dir");
		write(tree, "outside/AGENTS.md", "OUTSIDE-RULES\n");

		const manifest = buildSubagentContextManifest({
			cwd: tree,
			roots: [".."],
			targets: ["alias/a.ts", "../outside/a.ts"],
		});

		expect(manifest.omitted).toContainEqual({
			identifier: "alias/AGENTS.md",
			reason: "rejected: AGENTS.md is behind a symlinked directory",
		});
		expect(manifest.omitted).toContainEqual({ identifier: "..", reason: "path escapes cwd" });
		expect(manifest.omitted).toContainEqual({ identifier: "../outside/a.ts", reason: "path escapes cwd" });
		expect(manifest.entries.some((entry) => entry.identifier.includes("outside"))).toBe(false);
	});

	it("never includes instruction file content in the manifest or rendered section", () => {
		const tree = makeTree();
		write(tree, "AGENTS.md", "TOPSECRET-INSTRUCTION-CONTENT\n");
		write(tree, "src/a.ts", "export {};\n");

		const manifest = buildSubagentContextManifest({ cwd: tree, roots: [], targets: ["src/a.ts"] });
		const rendered = renderSubagentContextManifestSection(manifest);

		expect(JSON.stringify(manifest)).not.toContain("TOPSECRET-INSTRUCTION-CONTENT");
		expect(rendered).not.toContain("TOPSECRET-INSTRUCTION-CONTENT");
	});
});

describe("renderSubagentContextManifestSection", () => {
	function sampleManifest(): SubagentContextManifest {
		const tree = makeTree();
		write(tree, "AGENTS.md", "root rules\n");
		write(tree, "src/AGENTS.md", "src rules\n");
		write(tree, "src/a.ts", "export {};\n");
		return buildSubagentContextManifest({ cwd: tree, roots: [], targets: ["src/a.ts"] });
	}

	it("lists identifiers with bytes and reasons plus the untrusted framing line", () => {
		const manifest = sampleManifest();

		const rendered = renderSubagentContextManifestSection(manifest);

		expect(rendered).toContain("## Subagent context manifest");
		expect(rendered).toContain("- AGENTS.md (");
		expect(rendered).toContain("root instructions");
		expect(rendered).toContain("- src/AGENTS.md (");
		expect(rendered).toContain("governs target src/a.ts");
		expect(rendered).toContain("- orientation-packet (");
		expect(rendered).toContain("manifest hash:");
		expect(rendered).toContain("untrusted repository guidance");
		expect(rendered).toContain("read-only");
		expect(rendered).toContain("grant no tools");
		expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(
			SUBAGENT_CONTEXT_BOOTSTRAP_LIMITS.maxManifestSectionBytes,
		);
		expect(renderSubagentContextManifestSection(manifest)).toBe(rendered);
	});

	it("honors the 4 KiB section cap deterministically for oversized entries", () => {
		const manifest: SubagentContextManifest = {
			entries: [
				{
					sourceType: "instruction",
					identifier: "x".repeat(2000),
					sha256: "0".repeat(64),
					bytes: 2000,
					reasonSelected: "y".repeat(2000),
					trust: "untrusted_repo",
				},
			],
			omitted: [],
			totalBytes: 2000,
			hash: "a".repeat(64),
		};

		const rendered = renderSubagentContextManifestSection(manifest);

		expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(
			SUBAGENT_CONTEXT_BOOTSTRAP_LIMITS.maxManifestSectionBytes,
		);
		expect(rendered.endsWith("[context manifest section truncated]")).toBe(true);
		expect(renderSubagentContextManifestSection(manifest)).toBe(rendered);
	});
});
