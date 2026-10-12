import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session append after an unterminated JSONL tail", () => {
	it.each(["user", "custom"] as const)("preserves a valid final record before appending %s", (kind) => {
		const dir = mkdtempSync(join(tmpdir(), "ice-session-tail-"));
		dirs.push(dir);
		const manager = SessionManager.create(dir, dir);
		const userId = manager.appendMessage({ role: "user", content: "original 雪", timestamp: Date.now() });
		const file = manager.getSessionFile()!;
		const unterminated = readFileSync(file, "utf8").trimEnd();
		writeFileSync(file, unterminated);
		const reopened = SessionManager.open(file);
		expect(readFileSync(file, "utf8")).toBe(unterminated);
		if (kind === "user") reopened.appendMessage({ role: "user", content: "next request", timestamp: Date.now() });
		else reopened.appendCustomEntry("next", { ok: true });
		const bytes = readFileSync(file, "utf8");
		expect(bytes.startsWith(`${unterminated}\n`)).toBe(true);
		const loaded = SessionManager.open(file);
		expect(loaded.getEntries()).toHaveLength(2);
		expect(loaded.getEntries()[0].id).toBe(userId);
		expect(loaded.getEntries()[1].parentId).toBe(userId);
	});

	it("separates but does not erase a malformed partial tail", () => {
		const dir = mkdtempSync(join(tmpdir(), "ice-session-tail-"));
		dirs.push(dir);
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "original", timestamp: Date.now() });
		const file = manager.getSessionFile()!;
		appendFileSync(file, '{"type":"message","partial":');
		const original = readFileSync(file, "utf8");
		const reopened = SessionManager.open(file);
		reopened.appendCustomEntry("after-partial", { ok: true });
		expect(readFileSync(file, "utf8").startsWith(`${original}\n`)).toBe(true);
		expect(SessionManager.open(file).getEntries()).toHaveLength(2);
	});
});
