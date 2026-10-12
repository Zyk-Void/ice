import { existsSync, readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("first user message persistence", () => {
	it("writes the first user message before the provider responds, with one header", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const file = harness.sessionManager.getSessionFile()!;
		harness.sessionManager.appendCustomEntry("startup", { state: "ready" });
		expect(existsSync(file)).toBe(false);
		let savedBeforeResponse = false;
		let snapshot: unknown;
		harness.setResponses([
			() => {
				savedBeforeResponse = existsSync(file);
				if (savedBeforeResponse) snapshot = SessionManager.open(file).buildSessionContext().messages;
				return fauxAssistantMessage("saved");
			},
		]);
		await harness.session.prompt("do not lose this request");
		expect(savedBeforeResponse).toBe(true);
		expect(snapshot).toContainEqual(
			expect.objectContaining({ role: "user", content: [{ type: "text", text: "do not lose this request" }] }),
		);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines.filter((line) => JSON.parse(line).type === "session")).toHaveLength(1);
	});

	it("saves a user-only branch immediately and subsequent metadata once", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const originalFile = harness.sessionManager.getSessionFile()!;
		const userId = harness.sessionManager.appendMessage({
			role: "user",
			content: "first request",
			timestamp: Date.now(),
		});
		const branchFile = harness.sessionManager.createBranchedSession(userId)!;
		expect(existsSync(branchFile)).toBe(true);
		harness.sessionManager.appendCustomEntry("before-reply", { ok: true });
		harness.sessionManager.appendMessage(fauxAssistantMessage("reply"));
		const reopened = SessionManager.open(branchFile);
		expect(reopened.getEntries().map((entry) => entry.type)).toEqual(["message", "custom", "message"]);
		expect(reopened.getHeader()?.parentSession).toBe(originalFile);
		expect(
			readFileSync(branchFile, "utf8")
				.split("\n")
				.filter((line) => line && JSON.parse(line).type === "session"),
		).toHaveLength(1);
	});

	it("keeps metadata-only forks lazy and writes one header when a user arrives", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const setupId = harness.sessionManager.appendModelChange("faux", "setup");
		const file = harness.sessionManager.createBranchedSession(setupId)!;
		expect(existsSync(file)).toBe(false);
		harness.sessionManager.appendCustomEntry("setup", { ok: true });
		expect(existsSync(file)).toBe(false);
		harness.sessionManager.appendMessage({ role: "user", content: "first request", timestamp: Date.now() });
		expect(SessionManager.open(file).getEntries()).toHaveLength(3);
		expect(
			readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.filter((line) => JSON.parse(line).type === "session"),
		).toHaveLength(1);
	});

	it("keeps memory-only sessions memory-only", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "private", timestamp: Date.now() });
		expect(manager.getSessionFile()).toBeUndefined();
		expect(manager.getEntries()).toHaveLength(1);
	});
});
