/**
 * Local read-only observability dashboard server.
 *
 * Plain node:http + Server-Sent Events, no dependencies. Binds to loopback only and
 * exposes three read-only endpoints: the dashboard HTML, a JSON state snapshot, and a
 * live SSE event stream. It never accepts commands from the browser.
 *
 * Loopback does not separate OS accounts, so every route also requires the per-user
 * access token: from the `token` query parameter (which sets an HttpOnly cookie for the
 * dashboard's own requests), the cookie, or an `Authorization: Bearer` header.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import {
	type ObserveHeader,
	type ObserveRecorder,
	type ObserveRecorderEvent,
	type ObserveSessionLike,
	type ObserveState,
	type ObserveThread,
	startObserveRecorder,
} from "./observe-recorder.ts";
import type { ObserveReplayEvent, ObserveRunStore, ObserveRunSummary } from "./observe-store.ts";

/** Default dashboard port. */
export const OBSERVE_DEFAULT_PORT = 4649;
/** SSE heartbeat interval in ms (keeps proxies from closing idle connections). */
const HEARTBEAT_MS = 15_000;
const SHARED_POLL_MS = 500;
const COMBINED_RUN_LIMIT = 50;
const COMBINED_ITEM_LIMIT = 1_000;
const COMBINED_STATE_ITEM_LIMIT = 250;

type CombinedObserveState = ObserveState & {
	view: "all";
	liveRunId: string;
	runs: ObserveRunSummary[];
};

export interface ObserveServerOptions {
	/** Port to bind on 127.0.0.1 (default 4649). */
	port?: number;
	/** Reuse an already-running recorder, such as the always-on durable recorder. */
	recorder?: ObserveRecorder;
	/** Store used by the read-only historical replay endpoints. */
	replayStore?: ObserveRunStore;
	/** Access token every request must present. Defaults to a random per-process token. */
	token?: string;
}

export interface ObserveServer {
	url: string;
	/** Dashboard URL carrying the access token; open this in the browser. */
	dashboardUrl: string;
	port: number;
	/** True when another ICE process already owns the shared port. */
	shared?: boolean;
	close(): Promise<void>;
}

let dashboardHtml: string | undefined;

function getDashboardHtml(): string {
	dashboardHtml ??= readFileSync(new URL("./observe-dashboard.html", import.meta.url), "utf-8");
	return dashboardHtml;
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
	response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function isLoopbackHost(host: string | undefined): boolean {
	return host !== undefined && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
}

const TOKEN_COOKIE = "ice_observe_token";

/**
 * Read the per-user dashboard token, creating it (mode 0600) on first use. Every ICE
 * process of the same OS user shares it, so a dashboard on a shared port stays reachable.
 */
export function loadObserveToken(path: string): string {
	try {
		const existing = readFileSync(path, "utf-8").trim();
		if (existing) return existing;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const token = randomBytes(32).toString("hex");
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(path, `${token}\n`, { mode: 0o600, flag: "wx" });
		return token;
	} catch (error) {
		// Another process created it first; use theirs.
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return readFileSync(path, "utf-8").trim();
		throw error;
	}
}

function tokensMatch(presented: string | undefined, expected: string): boolean {
	if (!presented) return false;
	const a = Buffer.from(presented);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(header: string | undefined): string | undefined {
	for (const part of header?.split(";") ?? []) {
		const [name, ...value] = part.trim().split("=");
		if (name === TOKEN_COOKIE) return value.join("=");
	}
	return undefined;
}

function writeJson(response: ServerResponse, value: unknown, status = 200): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

function queryNumber(value: string | null): number | undefined {
	if (value === null || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function startObserveServer(
	session: ObserveSessionLike,
	options?: ObserveServerOptions,
): Promise<ObserveServer> {
	const port = options?.port ?? OBSERVE_DEFAULT_PORT;
	const token = options?.token ?? randomBytes(32).toString("hex");
	const recorder = options?.recorder ?? startObserveRecorder(session);
	const replayStore = options?.replayStore;
	const clients = new Set<ServerResponse>();
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let sharedPoller: ReturnType<typeof setInterval> | undefined;
	const tailSequences = new Map<string, number>();
	let knownRunIds = new Set<string>();
	let lastRunSignature = "";

	function currentRunSummary(header: ObserveHeader): ObserveRunSummary {
		return {
			runId: header.runId,
			sessionId: header.sessionId,
			mainThreadId: header.mainThreadId,
			...(header.sessionName ? { sessionName: header.sessionName } : {}),
			model: header.model,
			thinkingLevel: header.thinkingLevel,
			startedAt: header.startedAt,
			status: "running",
		};
	}

	function listCombinedRuns(): ObserveRunSummary[] {
		const current = currentRunSummary(recorder.getHeader());
		const stored = replayStore?.listRuns(COMBINED_RUN_LIMIT) ?? [];
		const runs = new Map(stored.map((run) => [run.runId, run]));
		runs.set(current.runId, { ...runs.get(current.runId), ...current });
		return [...runs.values()].sort((left, right) => right.startedAt - left.startedAt).slice(0, COMBINED_RUN_LIMIT);
	}

	function buildCombinedState(runs = listCombinedRuns()): CombinedObserveState {
		const current = recorder.getState();
		const states = runs
			.map((run) => {
				if (run.runId === current.runId) return current;
				return replayStore?.getState(run.runId, { limit: COMBINED_STATE_ITEM_LIMIT });
			})
			.filter((state): state is ObserveState => state !== undefined);
		const items = states
			.flatMap((state) => state.items.map((item) => ({ ...item, runId: item.runId || state.runId })))
			.sort((left, right) => left.ts - right.ts || left.runId.localeCompare(right.runId) || left.id - right.id)
			.slice(-COMBINED_ITEM_LIMIT);
		const threads = new Map<string, ObserveThread>();
		for (const state of states) {
			for (const thread of state.threads) {
				const runId = thread.runId || state.runId;
				threads.set(`${runId}:${thread.threadKey}`, { ...thread, runId });
			}
		}
		return {
			...current,
			view: "all",
			liveRunId: current.runId,
			runs,
			items,
			lanes: states.flatMap((state) =>
				state.lanes.map((lane) => (lane.runId ? lane : { ...lane, runId: state.runId })),
			),
			threads: [...threads.values()],
		};
	}

	function removeClient(client: ServerResponse): void {
		clients.delete(client);
		if (clients.size === 0 && sharedPoller) {
			clearInterval(sharedPoller);
			sharedPoller = undefined;
		}
	}

	function broadcast(event: string, data: unknown): void {
		for (const client of clients) {
			if (!client.writable || client.destroyed) {
				removeClient(client);
				continue;
			}
			try {
				writeSse(client, event, data);
			} catch {
				removeClient(client);
			}
		}
	}

	function publishReplayEvent(event: ObserveReplayEvent, runId: string): void {
		const payload = event.payload;
		if (payload.type === "activity") broadcast("activity", { ...payload.item, runId: payload.item.runId || runId });
		else if (payload.type === "activity_update")
			broadcast("activity_update", { ...payload.item, runId: payload.item.runId || runId });
		else if (payload.type === "lane") broadcast("lane", payload.lane);
		else if (payload.type === "thread")
			broadcast("thread", { ...payload.thread, runId: payload.thread.runId || runId });
		else if ("header" in payload) broadcast("header", payload.header);
	}

	function initializeTailCursors(runs: ObserveRunSummary[]): void {
		knownRunIds = new Set(runs.map((run) => run.runId));
		for (const run of runs) {
			if (run.runId !== recorder.getHeader().runId && replayStore && !tailSequences.has(run.runId)) {
				tailSequences.set(run.runId, replayStore.getLatestSequence(run.runId));
			}
		}
	}

	function broadcastCombinedSnapshot(): void {
		const runs = listCombinedRuns();
		initializeTailCursors(runs);
		broadcast("snapshot", buildCombinedState(runs));
	}

	function pollSharedRuns(): void {
		if (!replayStore || clients.size === 0) return;
		const runs = listCombinedRuns();
		const hasNewRun = runs.some((run) => !knownRunIds.has(run.runId));
		if (hasNewRun) broadcastCombinedSnapshot();
		const signature = JSON.stringify(runs.map((run) => [run.runId, run.status, run.endedAt]));
		if (signature !== lastRunSignature) {
			lastRunSignature = signature;
			broadcast("runs", runs);
		}
		for (const run of runs) {
			if (run.runId === recorder.getHeader().runId) continue;
			const cursor = tailSequences.get(run.runId);
			if (cursor === undefined) {
				tailSequences.set(run.runId, replayStore.getLatestSequence(run.runId));
				continue;
			}
			const events = replayStore.getEvents(run.runId, { after: cursor, limit: 500 });
			for (const event of events) {
				tailSequences.set(run.runId, event.sequence);
				publishReplayEvent(event, run.runId);
			}
		}
	}

	function startSharedPoller(): void {
		if (!replayStore || sharedPoller) return;
		sharedPoller = setInterval(pollSharedRuns, SHARED_POLL_MS);
	}

	const unsubscribeRecorder = recorder.subscribe((event: ObserveRecorderEvent) => {
		if (event.type === "activity") broadcast("activity", event.item);
		else if (event.type === "activity_update") broadcast("activity_update", event.item);
		else if (event.type === "lane") broadcast("lane", event.lane);
		else if (event.type === "thread") broadcast("thread", event.thread);
		else broadcast("header", recorder.getHeader());
	});

	const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
		if (!isLoopbackHost(request.headers.host)) {
			response.writeHead(403, { "content-type": "text/plain" });
			response.end("forbidden");
			return;
		}
		const parsedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
		const pathname = parsedUrl.pathname;
		const queryToken = parsedUrl.searchParams.get("token") ?? undefined;
		const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
		const viaQuery = tokensMatch(queryToken, token);
		if (!viaQuery && !tokensMatch(bearer, token) && !tokensMatch(cookieToken(request.headers.cookie), token)) {
			response.writeHead(401, { "content-type": "text/plain" });
			response.end("unauthorized: open the dashboard URL printed by ICE");
			return;
		}
		if (pathname === "/" || pathname.startsWith("/index")) {
			response.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				// The page URL may carry the access token; never leak it through a Referer header.
				"referrer-policy": "no-referrer",
				...(viaQuery ? { "set-cookie": `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` } : {}),
			});
			response.end(getDashboardHtml());
			return;
		}
		if (pathname === "/state") {
			if (parsedUrl.searchParams.get("view") === "all") {
				writeJson(response, buildCombinedState());
				return;
			}
			const requestedRunId = parsedUrl.searchParams.get("runId");
			if (requestedRunId && replayStore) {
				const state = replayStore.getState(requestedRunId);
				if (!state) {
					writeJson(response, { error: "run not found" }, 404);
					return;
				}
				writeJson(response, state);
			} else {
				writeJson(response, recorder.getState());
			}
			return;
		}
		if (replayStore && pathname === "/runs") {
			writeJson(response, { runs: replayStore.listRuns(queryNumber(parsedUrl.searchParams.get("limit"))) });
			return;
		}
		if (replayStore && (pathname === "/replay" || pathname === "/replay/events" || pathname.startsWith("/replay/"))) {
			let pathRunId: string | undefined;
			if (pathname.startsWith("/replay/") && pathname !== "/replay/events") {
				try {
					pathRunId = decodeURIComponent(pathname.slice("/replay/".length));
				} catch {
					writeJson(response, { error: "malformed run id" }, 400);
					return;
				}
			}
			const requestedRunId = pathRunId || parsedUrl.searchParams.get("runId") || undefined;
			const requestedSessionId = parsedUrl.searchParams.get("sessionId") || undefined;
			const run = requestedRunId
				? replayStore.getRun(requestedRunId)
				: requestedSessionId
					? replayStore.getLatestRunForSession(requestedSessionId)
					: undefined;
			if (!run) {
				writeJson(response, { error: "run not found" }, 404);
				return;
			}
			const events = replayStore.getEvents(run.runId, {
				after: queryNumber(parsedUrl.searchParams.get("after")),
				limit: queryNumber(parsedUrl.searchParams.get("limit")),
			});
			writeJson(response, { run, events });
			return;
		}
		if (pathname === "/events") {
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const runs = listCombinedRuns();
			initializeTailCursors(runs);
			writeSse(response, "snapshot", buildCombinedState(runs));
			clients.add(response);
			startSharedPoller();
			const remove = (): void => removeClient(response);
			response.on("error", remove);
			request.on("close", remove);
			return;
		}
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("not found");
	});

	heartbeat = setInterval(() => {
		for (const client of clients) {
			if (!client.writable || client.destroyed) {
				removeClient(client);
				continue;
			}
			try {
				client.write(": ping\n\n");
			} catch {
				clients.delete(client);
			}
		}
	}, HEARTBEAT_MS);

	return new Promise((resolve, reject) => {
		let settled = false;
		server.once("error", (error: NodeJS.ErrnoException) => {
			if (settled || error.code !== "EADDRINUSE") {
				if (!settled) reject(error);
				return;
			}
			settled = true;
			if (heartbeat) clearInterval(heartbeat);
			if (sharedPoller) clearInterval(sharedPoller);
			unsubscribeRecorder();
			resolve({
				url: `http://127.0.0.1:${port}`,
				dashboardUrl: `http://127.0.0.1:${port}/?token=${token}`,
				port,
				shared: true,
				close: async () => {
					recorder.stop();
				},
			});
		});
		// Prevent post-start listener errors from becoming uncaught process errors.
		server.on("error", () => {});
		server.listen(port, "127.0.0.1", () => {
			settled = true;
			const address = server.address();
			const boundPort = typeof address === "object" && address !== null ? address.port : port;
			resolve({
				url: `http://127.0.0.1:${boundPort}`,
				dashboardUrl: `http://127.0.0.1:${boundPort}/?token=${token}`,
				port: boundPort,
				close: () =>
					new Promise<void>((resolveClose) => {
						if (heartbeat) clearInterval(heartbeat);
						if (sharedPoller) clearInterval(sharedPoller);
						unsubscribeRecorder();
						recorder.stop();
						for (const client of clients) {
							client.end();
						}
						clients.clear();
						server.close(() => resolveClose());
					}),
			});
		});
	});
}
