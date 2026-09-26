import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isSubagentOutput,
	SubagentOutputArtifactStore,
	type SubagentOutputArtifactStoreLimits,
} from "../src/ice-subagent-output-artifacts.ts";

const roots: string[] = [];
const stores: SubagentOutputArtifactStore[] = [];

function artifactFilePath(root: string, ownerSessionId: string, artifactId: string): string {
	const ownerDirectory = createHash("sha256").update(ownerSessionId, "utf8").digest("hex");
	return join(root, ownerDirectory, artifactId, "output.txt");
}

function createStore(limits: Partial<SubagentOutputArtifactStoreLimits> = {}) {
	const root = mkdtempSync(join(tmpdir(), "ice-subagent-output-"));
	roots.push(root);
	const store = new SubagentOutputArtifactStore({
		artifactRoot: root,
		limits: {
			inlineBytes: 4,
			maxArtifactBytes: 16,
			defaultReadBytes: 4,
			maxReadBytes: 8,
			maxOwnerBytes: 16,
			maxGlobalBytes: 32,
			...limits,
		},
	});
	stores.push(store);
	return { root, store };
}

afterEach(() => {
	for (const store of stores.splice(0)) store.dispose();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("subagent output artifacts", () => {
	it("keeps a short final answer inline without creating an artifact", () => {
		const { store } = createStore();

		const output = store.capture({ ownerSessionId: "owner-a", text: "done" });

		expect(output).toMatchObject({
			text: "done",
			textBytes: 4,
			originalBytes: 4,
			inlineTruncated: false,
			captureStatus: "inline_complete",
		});
		expect(output.artifact).toBeUndefined();
	});

	it("stores a long final answer behind an opaque owner-scoped reference", () => {
		const { store } = createStore();
		const output = store.capture({ ownerSessionId: "owner-a", text: "hello world" });
		const artifact = output.artifact;

		expect(output).toMatchObject({
			text: "hell",
			textBytes: 4,
			originalBytes: 11,
			inlineTruncated: true,
			captureStatus: "artifact_complete",
		});
		expect(artifact).toMatchObject({ schemaVersion: 2, storedBytes: 11, originalBytes: 11, truncated: false });
		expect(artifact?.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(artifact).not.toHaveProperty("path");

		const first = store.read({ ownerSessionId: "owner-a", artifactId: artifact!.id, offset: 0, length: 4 });
		const second = store.read({
			ownerSessionId: "owner-a",
			artifactId: artifact!.id,
			offset: first.nextOffset,
			length: 8,
		});

		expect(first).toMatchObject({ text: "hell", offset: 0, bytesRead: 4, totalBytes: 11, eof: false });
		expect(second).toMatchObject({ text: "o world", offset: 4, bytesRead: 7, totalBytes: 11, eof: true });
	});

	it("rejects unknown and cross-owner artifact IDs with the same error", () => {
		const { store } = createStore();
		const output = store.capture({ ownerSessionId: "owner-a", text: "hello world" });
		const artifactId = output.artifact!.id;

		for (const requestedId of [artifactId, "00000000-0000-4000-8000-000000000000"]) {
			expect(() => store.read({ ownerSessionId: "owner-b", artifactId: requestedId })).toThrow(
				"Subagent output artifact was not found.",
			);
		}
	});

	it("paginates UTF-8 without splitting code points and rejects an interior offset", () => {
		const { store } = createStore({ inlineBytes: 1, maxArtifactBytes: 16 });
		const output = store.capture({ ownerSessionId: "owner-a", text: "a🙂z" });
		const artifactId = output.artifact!.id;

		const first = store.read({ ownerSessionId: "owner-a", artifactId, offset: 0, length: 3 });
		const second = store.read({ ownerSessionId: "owner-a", artifactId, offset: first.nextOffset, length: 4 });

		expect(first).toMatchObject({ text: "a", bytesRead: 1, nextOffset: 1 });
		expect(second).toMatchObject({ text: "🙂", bytesRead: 4, nextOffset: 5 });
		expect(() => store.read({ ownerSessionId: "owner-a", artifactId, offset: 2, length: 4 })).toThrow(
			"Artifact offset must be on a UTF-8 boundary.",
		);
	});

	it("marks per-artifact truncation and storage quota exhaustion without losing the inline text", () => {
		const truncated = createStore({ inlineBytes: 2, maxArtifactBytes: 4 });
		const oversized = truncated.store.capture({ ownerSessionId: "owner-a", text: "abcdefgh" });
		expect(oversized).toMatchObject({
			text: "ab",
			originalBytes: 8,
			inlineTruncated: true,
			captureStatus: "artifact_truncated",
			artifact: { storedBytes: 4, originalBytes: 8, truncated: true },
		});
		expect(
			truncated.store.read({ ownerSessionId: "owner-a", artifactId: oversized.artifact!.id, offset: 0, length: 8 })
				.text,
		).toBe("abcd");

		const quota = createStore({ inlineBytes: 2, maxArtifactBytes: 8, maxOwnerBytes: 2 });
		const unavailable = quota.store.capture({ ownerSessionId: "owner-a", text: "abcdef" });
		expect(unavailable).toMatchObject({
			text: "ab",
			inlineTruncated: true,
			captureStatus: "artifact_unavailable",
		});
		expect(unavailable.artifact).toBeUndefined();
	});

	it("redacts stored text and re-registers durable artifacts after restart", () => {
		const { root, store } = createStore({
			inlineBytes: 4,
			maxArtifactBytes: 32,
			maxOwnerBytes: 128,
			maxGlobalBytes: 256,
		});
		const source = "Bearer secret";
		const output = store.capture({ ownerSessionId: "owner-a", text: source, lifecycle: "durable" });
		const artifact = output.artifact!;
		expect(artifact.storedBytes).toBeGreaterThan(artifact.originalBytes);

		const restored = new SubagentOutputArtifactStore({
			artifactRoot: root,
			limits: { inlineBytes: 4, maxArtifactBytes: 32 },
		});
		stores.push(restored);
		expect(restored.registerDurable("owner-a", artifact)).toBe(true);
		restored.finalizeRestore("owner-a");
		const saved = restored.read({ ownerSessionId: "owner-a", artifactId: artifact.id, length: 32 });
		expect(saved.text).toBe("Bearer [REDACTED]");
		expect(saved.text).not.toContain("secret");
	});

	it("sweeps process-local orphan artifacts but preserves registered durable output", () => {
		const { root, store } = createStore({
			inlineBytes: 4,
			maxArtifactBytes: 32,
			maxOwnerBytes: 128,
			maxGlobalBytes: 256,
		});
		const durable = store.capture({ ownerSessionId: "owner-a", text: "durable output", lifecycle: "durable" });
		const ephemeral = store.capture({ ownerSessionId: "owner-a", text: "temporary output" });
		const otherOwner = store.capture({ ownerSessionId: "owner-b", text: "other owner output" });
		const restored = new SubagentOutputArtifactStore({
			artifactRoot: root,
			limits: { inlineBytes: 4, maxArtifactBytes: 32 },
		});
		stores.push(restored);
		expect(restored.registerDurable("owner-a", durable.artifact!)).toBe(true);
		restored.finalizeRestore("owner-a");

		expect(existsSync(artifactFilePath(root, "owner-a", durable.artifact!.id))).toBe(true);
		expect(existsSync(artifactFilePath(root, "owner-a", ephemeral.artifact!.id))).toBe(false);
		expect(existsSync(artifactFilePath(root, "owner-b", otherOwner.artifact!.id))).toBe(true);
		expect(restored.read({ ownerSessionId: "owner-a", artifactId: durable.artifact!.id }).text).toBe(
			"durable output",
		);
	});

	it("does not follow a symlinked artifact root", () => {
		const target = mkdtempSync(join(tmpdir(), "ice-subagent-output-target-"));
		const alias = `${target}-alias`;
		roots.push(target, alias);
		symlinkSync(target, alias, "dir");
		const store = new SubagentOutputArtifactStore({
			artifactRoot: alias,
			limits: { inlineBytes: 4, maxArtifactBytes: 16 },
		});
		stores.push(store);

		const output = store.capture({ ownerSessionId: "owner-a", text: "long enough" });
		expect(output.captureStatus).toBe("artifact_unavailable");
		expect(readdirSync(target)).toEqual([]);
	});

	it("rejects tampered artifact bytes before returning a chunk", () => {
		const { root, store } = createStore();
		const output = store.capture({ ownerSessionId: "owner-a", text: "hello world" });
		const path = artifactFilePath(root, "owner-a", output.artifact!.id);
		unlinkSync(path);
		writeFileSync(path, "tampered data");

		expect(() => store.read({ ownerSessionId: "owner-a", artifactId: output.artifact!.id })).toThrow(
			"Subagent output artifact integrity check failed.",
		);
	});

	it("rejects persisted artifact objects that contain a filesystem path", () => {
		const { store } = createStore();
		const output = store.capture({ ownerSessionId: "owner-a", text: "hello world" });
		expect(isSubagentOutput({ ...output, artifact: { ...output.artifact, path: "/tmp/output.txt" } })).toBe(false);
	});

	it("promotes capture ownership to a durable per-job reference", () => {
		const { store } = createStore();
		const output = store.capture({ ownerSessionId: "owner-a", text: "hello world" });
		const artifactId = output.artifact!.id;
		expect(store.retainDurable("owner-a", output.artifact!, "durable:job:job-1")).toBe(true);
		expect(store.release({ ownerSessionId: "owner-a", artifactId })).toBe(false);
		expect(store.read({ ownerSessionId: "owner-a", artifactId }).text).toBe("hell");
		expect(store.release({ ownerSessionId: "owner-a", artifactId, referenceId: "durable:job:job-1" })).toBe(true);
		expect(() => store.read({ ownerSessionId: "owner-a", artifactId })).toThrow(
			"Subagent output artifact was not found.",
		);
	});

	it("releases a retained artifact only for its owner", () => {
		const { store } = createStore();
		const output = store.capture({ ownerSessionId: "owner-a", text: "hello world" });
		const artifactId = output.artifact!.id;

		expect(store.release({ ownerSessionId: "owner-b", artifactId })).toBe(false);
		expect(store.read({ ownerSessionId: "owner-a", artifactId }).text).toBe("hell");
		expect(store.release({ ownerSessionId: "owner-a", artifactId })).toBe(true);
		expect(() => store.read({ ownerSessionId: "owner-a", artifactId })).toThrow(
			"Subagent output artifact was not found.",
		);
	});

	it("keeps an artifact until every logical owner releases its idempotent reference", () => {
		const { store } = createStore();
		const output = store.capture({ ownerSessionId: "owner-a", text: "hello world" });
		const artifactId = output.artifact!.id;

		expect(store.retain({ ownerSessionId: "owner-b", artifactId, referenceId: "batch:one" })).toBe(false);
		expect(store.retain({ ownerSessionId: "owner-a", artifactId, referenceId: "batch:one" })).toBe(true);
		expect(store.retain({ ownerSessionId: "owner-a", artifactId, referenceId: "batch:one" })).toBe(true);
		expect(store.release({ ownerSessionId: "owner-a", artifactId, referenceId: "unknown" })).toBe(false);
		expect(store.release({ ownerSessionId: "owner-a", artifactId })).toBe(true);
		expect(store.read({ ownerSessionId: "owner-a", artifactId }).text).toBe("hell");
		expect(store.release({ ownerSessionId: "owner-a", artifactId, referenceId: "batch:one" })).toBe(true);
		expect(store.release({ ownerSessionId: "owner-a", artifactId, referenceId: "batch:one" })).toBe(false);
		expect(() => store.read({ ownerSessionId: "owner-a", artifactId })).toThrow(
			"Subagent output artifact was not found.",
		);
	});
});
