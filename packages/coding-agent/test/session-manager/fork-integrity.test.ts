import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const message = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });

describe("session fork and branch provenance", () => {
	it.each([false, true])("remaps a label compaction boundary in a fork (persistent=%s)", (persistent) => {
		const dir = mkdtempSync(join(tmpdir(), "ice-fork-boundary-"));
		dirs.push(dir);
		const manager = persistent ? SessionManager.create(dir, dir) : SessionManager.inMemory();
		const original = manager.appendMessage(message("older request"));
		const label = manager.appendLabelChange(original, "boundary");
		manager.appendLabelChange(original, "boundary updated");
		const kept = manager.appendMessage(message("request that must survive"));
		const compact = manager.appendCompaction("older history checkpoint", label, 100);
		const before = manager.buildSessionContext().messages;
		const sourceFile = manager.getSessionFile();
		const forkFile = manager.createBranchedSession(compact);
		if (forkFile && sourceFile) {
			expect(SessionManager.open(forkFile).buildSessionContext().messages).toEqual(before);
			expect(SessionManager.open(sourceFile).getEntry(compact)).toMatchObject({ firstKeptEntryId: label });
		}
		expect(manager.buildSessionContext().messages).toEqual(before);
		const entry = manager.getEntry(compact);
		expect(entry?.type === "compaction" ? entry.firstKeptEntryId : undefined).toBe(kept);
		expect(manager.getEntry(kept)?.parentId).toBe(original);
	});

	it.each([false, true])("records the abandoned leaf, not the destination (root=%s)", (root) => {
		const manager = SessionManager.inMemory();
		const destination = manager.appendMessage(message("destination"));
		const abandoned = manager.appendMessage(message("abandoned branch"));
		const summary = manager.branchWithSummary(root ? null : destination, "branch checkpoint");
		const entry = manager.getEntry(summary);
		expect(entry?.type === "branch_summary" ? entry.fromId : undefined).toBe(abandoned);
		expect(entry?.parentId).toBe(root ? null : destination);
	});
});
