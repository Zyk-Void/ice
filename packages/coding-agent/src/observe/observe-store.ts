import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
	createNodeSqliteFactory,
	type SqliteDatabase,
	type SqliteDatabaseFactory,
} from "@zykairotis/ice-storage-sqlite-node";
import type {
	ObserveHeader,
	ObserveItem,
	ObserveLane,
	ObservePersistence,
	ObserveRecorderEvent,
	ObserveState,
	ObserveThread,
} from "./observe-recorder.ts";

const MAX_REPLAY_EVENTS = 10_000;
/** Runs older than this are pruned when a store opens, so the shared database cannot grow without bound. */
export const OBSERVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ObserveRunSummary {
	runId: string;
	sessionId: string;
	mainThreadId: string;
	sessionName?: string;
	model: string | null;
	thinkingLevel: string | null;
	startedAt: number;
	endedAt?: number;
	status: "running" | "finished";
}

export interface ObserveReplayEvent {
	sequence: number;
	ts: number;
	type: ObserveRecorderEvent["type"];
	payload: ObserveRecorderEvent | { type: "header"; header: ObserveHeader };
}

export interface ObserveRunStore extends ObservePersistence {
	listRuns(limit?: number): ObserveRunSummary[];
	getRun(runId: string): ObserveRunSummary | undefined;
	getLatestRunForSession(sessionId: string): ObserveRunSummary | undefined;
	getEvents(runId: string, options?: { after?: number; limit?: number }): ObserveReplayEvent[];
	getLatestSequence(runId: string): number;
	getState(runId: string, options?: { limit?: number }): ObserveState | undefined;
}

interface RunRow {
	run_id: string;
	session_id: string;
	main_thread_id: string;
	session_name: string | null;
	model: string | null;
	thinking_level: string | null;
	started_at_ms: number;
	ended_at_ms: number | null;
	status: "running" | "finished";
}

interface EventRow {
	sequence: number;
	ts_ms: number;
	event_type: ObserveRecorderEvent["type"];
	payload_json: string;
}

function clampLimit(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 100;
	return Math.min(MAX_REPLAY_EVENTS, Math.max(1, Math.floor(value)));
}

function optionalText(value: string | undefined): string | null {
	return value ?? null;
}

function rowToRun(row: RunRow): ObserveRunSummary {
	return {
		runId: row.run_id,
		sessionId: row.session_id,
		mainThreadId: row.main_thread_id,
		...(row.session_name === null ? {} : { sessionName: row.session_name }),
		model: row.model,
		thinkingLevel: row.thinking_level,
		startedAt: row.started_at_ms,
		...(row.ended_at_ms === null ? {} : { endedAt: row.ended_at_ms }),
		status: row.status,
	};
}

function createSchema(db: SqliteDatabase): void {
	db.exec(`
CREATE TABLE IF NOT EXISTS observe_runs (
	run_id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	main_thread_id TEXT NOT NULL,
	session_name TEXT,
	model TEXT,
	thinking_level TEXT,
	started_at_ms INTEGER NOT NULL,
	ended_at_ms INTEGER,
	status TEXT NOT NULL CHECK (status IN ('running', 'finished'))
);
CREATE INDEX IF NOT EXISTS observe_runs_session_idx
	ON observe_runs (session_id, started_at_ms DESC);
CREATE TABLE IF NOT EXISTS observe_events (
	run_id TEXT NOT NULL REFERENCES observe_runs(run_id) ON DELETE CASCADE,
	sequence INTEGER NOT NULL,
	ts_ms INTEGER NOT NULL,
	event_type TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	PRIMARY KEY (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS observe_events_run_ts_idx
	ON observe_events (run_id, ts_ms, sequence);
`);
}

class SqliteObserveRunStore implements ObserveRunStore {
	private readonly db: SqliteDatabase;
	private readonly nextSequences = new Map<string, number>();
	private closed = false;

	constructor(db: SqliteDatabase) {
		this.db = db;
		createSchema(db);
	}

	recordRun(header: ObserveHeader): void {
		this.assertOpen();
		this.db
			.prepare(
				`INSERT INTO observe_runs
					(run_id, session_id, main_thread_id, session_name, model, thinking_level, started_at_ms, status)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'running')
				 ON CONFLICT(run_id) DO UPDATE SET
					session_name = excluded.session_name,
					model = excluded.model,
					thinking_level = excluded.thinking_level`,
			)
			.run(
				header.runId,
				header.sessionId,
				header.mainThreadId,
				optionalText(header.sessionName),
				header.model,
				header.thinkingLevel,
				header.startedAt,
			);
		if (!this.nextSequences.has(header.runId)) this.nextSequences.set(header.runId, 1);
	}

	recordEvent(event: ObserveRecorderEvent, header: ObserveHeader): void {
		this.assertOpen();
		this.recordRun(header);
		const sequence = this.nextSequences.get(header.runId) ?? 1;
		const payload = event.type === "header" ? { type: "header" as const, header } : event;
		const timestamp = event.type === "activity" || event.type === "activity_update" ? event.item.ts : Date.now();
		this.db
			.prepare(
				`INSERT INTO observe_events (run_id, sequence, ts_ms, event_type, payload_json)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(header.runId, sequence, timestamp, event.type, JSON.stringify(payload));
		this.nextSequences.set(header.runId, sequence + 1);
	}

	finishRun(runId: string, endedAt: number): void {
		if (this.closed) return;
		this.db
			.prepare("UPDATE observe_runs SET ended_at_ms = ?, status = 'finished' WHERE run_id = ?")
			.run(endedAt, runId);
	}

	listRuns(limit = 100): ObserveRunSummary[] {
		this.assertOpen();
		return this.db
			.prepare("SELECT * FROM observe_runs ORDER BY started_at_ms DESC LIMIT ?")
			.all<RunRow>(clampLimit(limit))
			.map(rowToRun);
	}

	getRun(runId: string): ObserveRunSummary | undefined {
		this.assertOpen();
		const row = this.db.prepare("SELECT * FROM observe_runs WHERE run_id = ?").get<RunRow>(runId);
		return row ? rowToRun(row) : undefined;
	}

	getLatestRunForSession(sessionId: string): ObserveRunSummary | undefined {
		this.assertOpen();
		const row = this.db
			.prepare("SELECT * FROM observe_runs WHERE session_id = ? ORDER BY started_at_ms DESC LIMIT 1")
			.get<RunRow>(sessionId);
		return row ? rowToRun(row) : undefined;
	}

	getEvents(runId: string, options?: { after?: number; limit?: number }): ObserveReplayEvent[] {
		this.assertOpen();
		const after = Number.isSafeInteger(options?.after) && (options?.after ?? 0) >= 0 ? (options?.after ?? 0) : 0;
		const rows = this.db
			.prepare(
				"SELECT sequence, ts_ms, event_type, payload_json FROM observe_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
			)
			.all<EventRow>(runId, after, clampLimit(options?.limit));
		return rows.map((row) => ({
			sequence: row.sequence,
			ts: row.ts_ms,
			type: row.event_type,
			payload: JSON.parse(row.payload_json) as ObserveReplayEvent["payload"],
		}));
	}

	getLatestSequence(runId: string): number {
		this.assertOpen();
		const row = this.db
			.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM observe_events WHERE run_id = ?")
			.get<{ sequence: number }>(runId);
		return row?.sequence ?? 0;
	}

	getState(runId: string, options?: { limit?: number }): ObserveState | undefined {
		this.assertOpen();
		const run = this.getRun(runId);
		if (!run) return undefined;
		let header: ObserveHeader = {
			runId: run.runId,
			sessionId: run.sessionId,
			mainThreadId: run.mainThreadId,
			mainThreadName: run.sessionName || `main · ${run.sessionId.slice(0, 10)}`,
			sessionName: run.sessionName,
			model: run.model,
			thinkingLevel: run.thinkingLevel,
			context: undefined,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			startedAt: run.startedAt,
		};
		const items = new Map<number, ObserveItem>();
		const lanes = new Map<string, ObserveLane>();
		const threads = new Map<string, ObserveThread>();
		for (const event of this.getEvents(runId, { limit: options?.limit ?? MAX_REPLAY_EVENTS })) {
			const payload = event.payload;
			if (payload.type === "header" && "header" in payload) {
				header = payload.header;
			} else if (payload.type === "activity") {
				items.set(payload.item.id, { ...payload.item, runId: payload.item.runId || runId });
			} else if (payload.type === "activity_update") {
				items.set(payload.item.id, { ...payload.item, runId: payload.item.runId || runId });
			} else if (payload.type === "lane") {
				lanes.set(payload.lane.streamKey, payload.lane);
			} else if (payload.type === "thread") {
				threads.set(payload.thread.threadKey, payload.thread);
			}
		}
		return { ...header, items: [...items.values()], lanes: [...lanes.values()], threads: [...threads.values()] };
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Observe run store is closed");
	}
}

export async function openObserveRunStore(
	databasePath: string,
	factory: SqliteDatabaseFactory = createNodeSqliteFactory(),
): Promise<ObserveRunStore> {
	await mkdir(dirname(databasePath), { recursive: true });
	const db = await factory.open(databasePath);
	db.exec("PRAGMA journal_mode=WAL");
	// Checkpoints reuse the WAL file but never shrink it; truncate it back to 64 MiB after each one.
	db.exec("PRAGMA journal_size_limit=67108864");
	db.exec("PRAGMA synchronous=FULL");
	db.exec("PRAGMA busy_timeout=5000");
	const store = new SqliteObserveRunStore(db);
	// foreign_keys is off, so ON DELETE CASCADE does not fire; delete events explicitly.
	const cutoff = Date.now() - OBSERVE_RETENTION_MS;
	db.prepare(
		"DELETE FROM observe_events WHERE run_id IN (SELECT run_id FROM observe_runs WHERE started_at_ms < ?)",
	).run(cutoff);
	db.prepare("DELETE FROM observe_runs WHERE started_at_ms < ?").run(cutoff);
	return store;
}
