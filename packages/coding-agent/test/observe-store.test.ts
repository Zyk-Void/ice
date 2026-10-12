import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextUsage } from "../src/core/extensions/types.ts";
import { type ObserveSessionLike, startObserveRecorder } from "../src/observe/observe-recorder.ts";
import { OBSERVE_RETENTION_MS, openObserveRunStore } from "../src/observe/observe-store.ts";

function createFakeSession() {
	const listeners = new Set<(event: unknown) => void>();
	const session: ObserveSessionLike & { emit(event: unknown): void } = {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sessionId: "durable-session",
		sessionName: "durable test",
		model: { provider: "test", id: "model" },
		thinkingLevel: "low",
		getContextUsage(): ContextUsage | undefined {
			return { tokens: 10, contextWindow: 1000, percent: 0.01 };
		},
		emit(event) {
			for (const listener of listeners) listener(event);
		},
	};
	return session;
}

describe("observe run store", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("persists every projected event and supports replay after shutdown", async () => {
		const directory = mkdtempSync(join("/tmp", "ice-observe-store-"));
		tempDirs.push(directory);
		const databasePath = join(directory, "observability.sqlite");
		const store = await openObserveRunStore(databasePath);
		const session = createFakeSession();
		const recorder = startObserveRecorder(session, { pollMs: 0, persistence: store });

		session.emit({ type: "message_start", message: { role: "user", content: "replay me", timestamp: Date.now() } });
		session.emit({ type: "compaction_start", reason: "manual" });
		const runId = recorder.getHeader().runId;
		const liveEvents = store.getEvents(runId);
		expect(liveEvents.map((event) => event.type)).toEqual(["thread", "activity", "activity"]);
		expect(liveEvents[1].payload).toMatchObject({ type: "activity", item: { text: "replay me" } });
		recorder.stop();

		const reopened = await openObserveRunStore(databasePath);
		const run = reopened.getRun(runId);
		expect(run).toMatchObject({
			sessionId: "durable-session",
			status: "finished",
		});
		const replay = reopened.getEvents(runId, { after: 1, limit: 1 });
		expect(replay).toHaveLength(1);
		expect(replay[0].sequence).toBe(2);
		reopened.close();
	});

	it("redacts credentials from persisted history but keeps the live view intact", async () => {
		const store = await openObserveRunStore(":memory:");
		const session = createFakeSession();
		const recorder = startObserveRecorder(session, { pollMs: 0, persistence: store });
		const prompt = 'curl -H "Authorization: Bearer sk-live-123" --data api_key=abc123 https://example.test';
		session.emit({ type: "message_start", message: { role: "user", content: prompt, timestamp: Date.now() } });
		session.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "deploy", token: "plain-secret-value" },
		});
		const runId = recorder.getHeader().runId;
		const persisted = JSON.stringify(store.getEvents(runId));
		expect(persisted).not.toContain("sk-live-123");
		expect(persisted).not.toContain("abc123");
		expect(persisted).not.toContain("plain-secret-value");
		expect(persisted).toContain("[REDACTED]");
		expect(JSON.stringify(recorder.getState())).toContain("sk-live-123");
		recorder.stop();
	});

	it("folds every event of a long run into its replay state", async () => {
		const store = await openObserveRunStore(":memory:");
		const header = (model: string) => ({
			runId: "long",
			sessionId: "s",
			mainThreadId: "s",
			mainThreadName: "main",
			model,
			thinkingLevel: null,
			context: undefined,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			startedAt: Date.now(),
		});
		for (let index = 0; index <= 10_050; index++) store.recordEvent({ type: "header" }, header(`model-${index}`));
		expect(store.getState("long")?.model).toBe("model-10050");
		store.close();
	});

	it("prunes runs older than the retention window when opened", async () => {
		const directory = mkdtempSync(join("/tmp", "ice-observe-store-"));
		tempDirs.push(directory);
		const databasePath = join(directory, "observability.sqlite");
		const store = await openObserveRunStore(databasePath);
		const header = (runId: string, startedAt: number) => ({
			runId,
			sessionId: "s",
			mainThreadId: "s",
			mainThreadName: "main",
			model: null,
			thinkingLevel: null,
			context: undefined,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			startedAt,
		});
		const old = header("old", Date.now() - OBSERVE_RETENTION_MS - 60_000);
		store.recordEvent({ type: "header" }, old);
		store.recordEvent({ type: "header" }, header("fresh", Date.now()));
		store.close();

		const reopened = await openObserveRunStore(databasePath);
		expect(reopened.getRun("old")).toBeUndefined();
		expect(reopened.getEvents("old")).toEqual([]);
		expect(reopened.getRun("fresh")).toBeDefined();
		reopened.close();
	});

	it("persists polled headers only when they change", async () => {
		const directory = mkdtempSync(join("/tmp", "ice-observe-store-"));
		tempDirs.push(directory);
		const store = await openObserveRunStore(join(directory, "observability.sqlite"));
		const session = createFakeSession();
		const recorder = startObserveRecorder(session, { pollMs: 5, persistence: store });
		const runId = recorder.getHeader().runId;

		await new Promise((resolve) => setTimeout(resolve, 60));
		const headers = () => store.getEvents(runId).filter((event) => event.type === "header");
		expect(headers()).toHaveLength(1);

		Object.assign(session, { thinkingLevel: "high" });
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(headers()).toHaveLength(2);
		recorder.stop();
		store.close();
	});
});
