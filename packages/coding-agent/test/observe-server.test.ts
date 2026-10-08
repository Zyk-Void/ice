import { mkdtemp, rm } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextUsage } from "../src/core/extensions/types.ts";
import { type ObserveSessionLike, startObserveRecorder } from "../src/observe/observe-recorder.ts";
import { type ObserveServer, startObserveServer } from "../src/observe/observe-server.ts";
import { type ObserveRunStore, openObserveRunStore } from "../src/observe/observe-store.ts";

function createFakeSession(sessionId = "srv-test-session", sessionName = "server test") {
	const listeners = new Set<(event: unknown) => void>();
	const session: ObserveSessionLike & { emit(event: unknown): void } = {
		subscribe(listener: (event: unknown) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sessionId,
		sessionName,
		model: { provider: "anthropic", id: "test-model" },
		thinkingLevel: "low",
		getContextUsage(): ContextUsage | undefined {
			return { tokens: 500, contextWindow: 100000, percent: 0.5 };
		},
		emit(event: unknown) {
			for (const listener of listenerList()) listener(event);
		},
	};
	function listenerList() {
		return listeners;
	}
	return session;
}

function fetchText(url: string): Promise<{ status: number; body: string; contentType: string }> {
	return new Promise((resolve, reject) => {
		get(url, (res) => {
			let body = "";
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () =>
				resolve({
					status: res.statusCode ?? 0,
					body,
					contentType: String(res.headers["content-type"] ?? ""),
				}),
			);
		}).on("error", reject);
	});
}

describe("observe server", () => {
	const servers: ObserveServer[] = [];
	const stores: ObserveRunStore[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		while (servers.length > 0) {
			await servers.pop()!.close();
		}
		while (stores.length > 0) stores.pop()!.close();
		while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
	});

	it("serves the dashboard and state snapshot", async () => {
		const server = await startObserveServer(createFakeSession(), { port: 0 });
		servers.push(server);

		expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);

		const page = await fetchText(server.url);
		expect(page.status).toBe(200);
		expect(page.contentType).toContain("text/html");
		expect(page.body).toContain("ICE Observe");

		const state = await fetchText(`${server.url}/state`);
		expect(state.status).toBe(200);
		expect(state.contentType).toContain("application/json");
		const parsed = JSON.parse(state.body) as {
			sessionId: string;
			mainThreadId: string;
			items: unknown[];
			threads: Array<{ threadKey: string }>;
		};
		expect(parsed.sessionId).toBe("srv-test-session");
		expect(parsed.mainThreadId).toBe("srv-test-session");
		expect(parsed.items).toEqual([]);
		expect(parsed.threads.map((thread) => thread.threadKey)).toEqual(["srv-test-session"]);

		const missing = await fetchText(`${server.url}/nope`);
		expect(missing.status).toBe(404);
	});

	it("serves durable run listings and replay events", async () => {
		const session = createFakeSession();
		const store = await openObserveRunStore(":memory:");
		const recorder = startObserveRecorder(session, { pollMs: 0, persistence: store });
		const server = await startObserveServer(session, { port: 0, recorder, replayStore: store });
		servers.push(server);

		session.emit({ type: "compaction_start", reason: "manual" });
		const runId = recorder.getHeader().runId;
		const runs = await fetchText(`${server.url}/runs`);
		expect(runs.status).toBe(200);
		expect(JSON.parse(runs.body).runs[0]).toMatchObject({ runId, sessionId: "srv-test-session" });

		const replay = await fetchText(`${server.url}/replay/events?runId=${encodeURIComponent(runId)}`);
		expect(replay.status).toBe(200);
		expect(JSON.parse(replay.body).events.map((event: { type: string }) => event.type)).toContain("activity");

		const bySession = await fetchText(`${server.url}/replay?sessionId=srv-test-session`);
		expect(bySession.status).toBe(200);
		expect(JSON.parse(bySession.body).run.runId).toBe(runId);

		const state = await fetchText(`${server.url}/state?runId=${encodeURIComponent(runId)}`);
		expect(state.status).toBe(200);
		expect(JSON.parse(state.body).runId).toBe(runId);
	});

	it("shares an occupied port instead of failing a second observer", async () => {
		const first = await startObserveServer(createFakeSession(), { port: 0 });
		servers.push(first);
		const secondSession = createFakeSession();
		const secondStore = await openObserveRunStore(":memory:");
		const secondRecorder = startObserveRecorder(secondSession, { pollMs: 0, persistence: secondStore });
		const second = await startObserveServer(secondSession, {
			port: first.port,
			recorder: secondRecorder,
			replayStore: secondStore,
		});
		servers.push(second);

		expect(second.shared).toBe(true);
		expect(second.url).toBe(first.url);
		secondSession.emit({ type: "compaction_start", reason: "manual" });
		expect(secondStore.getEvents(secondRecorder.getHeader().runId).some((event) => event.type === "activity")).toBe(
			true,
		);
	});

	it("combines live events from a second run sharing the observer port", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ice-observe-server-"));
		tempDirs.push(directory);
		const firstStore = await openObserveRunStore(join(directory, "observability.sqlite"));
		const firstSession = createFakeSession("first-session", "first main");
		const firstRecorder = startObserveRecorder(firstSession, { pollMs: 0, persistence: firstStore });
		const first = await startObserveServer(firstSession, {
			port: 0,
			recorder: firstRecorder,
			replayStore: firstStore,
		});
		servers.push(first);
		stores.push(firstStore);

		const secondStore = await openObserveRunStore(join(directory, "observability.sqlite"));
		const secondSession = createFakeSession("second-session", "second main");
		const secondRecorder = startObserveRecorder(secondSession, { pollMs: 0, persistence: secondStore });
		const second = await startObserveServer(secondSession, {
			port: first.port,
			recorder: secondRecorder,
			replayStore: secondStore,
		});
		servers.push(second);
		stores.push(secondStore);
		expect(second.shared).toBe(true);

		const received: string[] = [];
		let resolveFirst: (() => void) | undefined;
		const firstFrame = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		const request = get(`${first.url}/events`, (response) => {
			response.setEncoding("utf-8");
			response.on("data", (chunk: string) => {
				received.push(chunk);
				resolveFirst?.();
				resolveFirst = undefined;
			});
		});
		request.on("error", () => {});
		await firstFrame;
		secondSession.emit({
			type: "tool_execution_start",
			toolCallId: "second-tool",
			toolName: "second-bash",
			args: { command: "echo second" },
		});
		await new Promise((resolve) => setTimeout(resolve, 800));
		const frames = received.join("");
		expect(frames).toContain("second-bash");
		expect(frames).toContain(secondRecorder.getHeader().runId);
		request.destroy();
	});

	it("streams live events over SSE", async () => {
		const session = createFakeSession();
		const server = await startObserveServer(session, { port: 0 });
		servers.push(server);

		const received: string[] = [];
		let resolveFirst: (() => void) | undefined;
		const firstFrame = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});

		const req = get(`${server.url}/events`, (res) => {
			res.setEncoding("utf-8");
			res.on("data", (chunk: string) => {
				received.push(chunk);
				if (resolveFirst) {
					resolveFirst();
					resolveFirst = undefined;
				}
			});
		});
		req.on("error", () => {});
		await firstFrame;

		// The first frame is the snapshot.
		expect(received.join("")).toContain("event: snapshot");

		session.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "echo hi" },
		});

		await new Promise((resolve) => setTimeout(resolve, 100));
		const frames = received.join("");
		expect(frames).toContain("event: activity");
		expect(frames).toContain("bash");

		req.destroy();
	});
});
