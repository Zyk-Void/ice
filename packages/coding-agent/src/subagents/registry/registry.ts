/**
 * Subagent V2 ChildRegistry (Plan/subagent-rewrite.md sections 6.2-6.5 and 11, P5.1/P5.4-P5.9).
 *
 * The single owner of child identity and lifecycle. Every transition is
 * generation-checked and journaled into the parent session as an
 * extension-owned custom entry; the observatory, Hub, RPC, and CLI only read
 * snapshots and events. Children belong to one owner session: an ID from another
 * owner behaves exactly like an unknown ID.
 */
import type { SessionManager } from "../../core/session-manager.ts";
import {
	type ChildInstanceState,
	type ChildTurnOutcome,
	canTransitionChildState,
	recoverChildStateAfterRestart,
} from "./state-machine.ts";

export const CHILD_RECORD_ENTRY_TYPE = "ice-subagent-v2-child";
export const CHILD_COMPLETION_ENTRY_TYPE = "ice-subagent-v2-completion";
export const CHILD_DELIVERED_ENTRY_TYPE = "ice-subagent-v2-delivered";

/** Append-only parent-session journal. `flush` is a durable barrier. */
export interface ParentJournal {
	append(customType: string, data: unknown): void;
	flush(): void;
	entries(): ReadonlyArray<{ customType: string; data: unknown }>;
}

export function sessionJournal(sessionManager: SessionManager): ParentJournal {
	return {
		append: (customType, data) => {
			sessionManager.appendCustomEntry(customType, data);
		},
		flush: () => sessionManager.flushDurably(),
		entries: () =>
			sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "custom" ? [{ customType: entry.customType, data: entry.data }] : [])),
	};
}

export interface ChildUsage {
	inputTokens: number;
	outputTokens: number;
	cost: number;
	turns: number;
}

export interface ChildRecord {
	id: string;
	ownerSessionId: string;
	rootSessionId: string;
	parentChildId?: string;
	depth: number;
	agent: string;
	description: string;
	contractHash: string;
	transcriptPath: string;
	state: ChildInstanceState;
	generation: number;
	turnInFlight: boolean;
	lastTurnOutcome?: ChildTurnOutcome;
	blockedReasons?: readonly string[];
	usage: ChildUsage;
	createdAt: number;
	updatedAt: number;
}

export interface ChildCompletion {
	deliveryId: string;
	childId: string;
	ownerSessionId: string;
	agent: string;
	outcome: ChildTurnOutcome;
	/** Bounded summary; the full answer stays in the child transcript or an artifact. */
	summary: string;
	artifactRef?: string;
	at: number;
}

export interface ResidentChild {
	dispose(): Promise<void>;
}

export type RegistryEvent =
	| { type: "record"; record: ChildRecord }
	| { type: "completion"; completion: ChildCompletion };

export class ChildRegistryError extends Error {
	readonly code: "unknown_child" | "stale_generation" | "illegal_transition" | "not_parked" | "busy";
	constructor(code: ChildRegistryError["code"], message: string) {
		super(message);
		this.code = code;
	}
}

const emptyUsage = (): ChildUsage => ({ inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 });

export class ChildRegistry<H extends ResidentChild = ResidentChild> {
	private readonly journal: ParentJournal;
	private readonly now: () => number;
	private readonly records = new Map<string, ChildRecord>();
	private readonly residents = new Map<string, H>();
	private readonly revivals = new Map<string, Promise<H | undefined>>();
	private readonly parking = new Set<string>();
	private readonly completions = new Map<string, ChildCompletion>();
	private readonly delivered = new Set<string>();
	private readonly listeners = new Set<(event: RegistryEvent) => void>();

	constructor(journal: ParentJournal, now: () => number = Date.now) {
		this.journal = journal;
		this.now = now;
	}

	// --- reads -------------------------------------------------------------

	get(ownerSessionId: string, id: string): ChildRecord {
		const record = this.records.get(id);
		if (!record || record.ownerSessionId !== ownerSessionId || record.state === "deleted")
			throw new ChildRegistryError("unknown_child", `Unknown child ${id}.`);
		return record;
	}

	list(ownerSessionId: string): ChildRecord[] {
		return [...this.records.values()]
			.filter((record) => record.ownerSessionId === ownerSessionId && record.state !== "deleted")
			.sort((left, right) => left.createdAt - right.createdAt);
	}

	resident(ownerSessionId: string, id: string): H | undefined {
		this.get(ownerSessionId, id);
		return this.parking.has(id) ? undefined : this.residents.get(id);
	}

	pendingCompletions(ownerSessionId: string): ChildCompletion[] {
		return [...this.completions.values()].filter(
			(completion) => completion.ownerSessionId === ownerSessionId && !this.delivered.has(completion.deliveryId),
		);
	}

	subscribe(listener: (event: RegistryEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	// --- lifecycle ---------------------------------------------------------

	/** Durably record acceptance. Throws when the journal cannot flush; the caller must not launch. */
	accept(
		input: Omit<ChildRecord, "state" | "generation" | "turnInFlight" | "usage" | "createdAt" | "updatedAt">,
	): ChildRecord {
		if (this.records.has(input.id)) throw new ChildRegistryError("illegal_transition", `Child ${input.id} exists.`);
		const at = this.now();
		const record: ChildRecord = {
			...input,
			state: "starting",
			generation: 1,
			turnInFlight: true,
			usage: emptyUsage(),
			createdAt: at,
			updatedAt: at,
		};
		this.journal.append(CHILD_RECORD_ENTRY_TYPE, record);
		this.journal.flush();
		this.records.set(record.id, record);
		this.emit({ type: "record", record });
		return record;
	}

	/** Generation-checked transition; a stale caller cannot affect a replacement state. */
	transition(
		ownerSessionId: string,
		id: string,
		expectedGeneration: number,
		to: ChildInstanceState,
		patch: Partial<Pick<ChildRecord, "turnInFlight" | "lastTurnOutcome" | "blockedReasons" | "usage">> = {},
		durable = false,
	): ChildRecord {
		const record = this.get(ownerSessionId, id);
		if (record.generation !== expectedGeneration)
			throw new ChildRegistryError(
				"stale_generation",
				`Child ${id} changed since generation ${expectedGeneration}.`,
			);
		if (record.state !== to && !canTransitionChildState(record.state, to))
			throw new ChildRegistryError("illegal_transition", `Child ${id} cannot go from ${record.state} to ${to}.`);
		const next: ChildRecord = {
			...record,
			...patch,
			...(to === "blocked" ? {} : { blockedReasons: undefined }),
			state: to,
			generation: record.generation + 1,
			updatedAt: this.now(),
		};
		this.journal.append(CHILD_RECORD_ENTRY_TYPE, next);
		if (durable) this.journal.flush();
		this.records.set(id, next);
		this.emit({ type: "record", record: next });
		return next;
	}

	attach(ownerSessionId: string, id: string, handle: H): void {
		this.get(ownerSessionId, id);
		this.residents.set(id, handle);
	}

	/**
	 * Park an idle child: detach before dispose so no caller can obtain a session
	 * mid-dispose (OMP lifecycle invariant). Transcript and contract remain.
	 */
	async park(ownerSessionId: string, id: string): Promise<ChildRecord> {
		const record = this.get(ownerSessionId, id);
		if (record.state !== "idle")
			throw new ChildRegistryError("illegal_transition", `Child ${id} is ${record.state}, not idle.`);
		const handle = this.residents.get(id);
		this.parking.add(id);
		this.residents.delete(id);
		try {
			const parked = this.transition(ownerSessionId, id, record.generation, "parked");
			await handle?.dispose();
			return parked;
		} finally {
			this.parking.delete(id);
		}
	}

	/**
	 * Revive a parked child. Concurrent callers share one revival. The reviver
	 * validates authority (validateChildResume) and returns a handle, or blocked
	 * reasons; a blocked child performs no model turn.
	 */
	revive(
		ownerSessionId: string,
		id: string,
		reviver: (record: ChildRecord) => Promise<{ handle: H } | { blocked: readonly string[] }>,
	): Promise<H | undefined> {
		const record = this.get(ownerSessionId, id);
		const existing = this.revivals.get(id);
		if (existing) return existing;
		if (record.state === "idle" && this.residents.has(id)) return Promise.resolve(this.residents.get(id));
		if (record.state !== "parked" && record.state !== "blocked")
			return Promise.reject(new ChildRegistryError("not_parked", `Child ${id} is ${record.state}.`));
		if (record.state === "blocked" && this.residents.has(id))
			return Promise.reject(new ChildRegistryError("busy", `Child ${id} is waiting on an approval.`));
		const revival = (async () => {
			const outcome = await reviver(record);
			const current = this.get(ownerSessionId, id);
			if ("blocked" in outcome) {
				if (current.state !== "blocked")
					this.transition(ownerSessionId, id, current.generation, "blocked", { blockedReasons: outcome.blocked });
				return undefined;
			}
			const from =
				current.state === "blocked" ? this.transition(ownerSessionId, id, current.generation, "parked") : current;
			this.residents.set(id, outcome.handle);
			this.transition(ownerSessionId, id, from.generation, "idle");
			return outcome.handle;
		})().finally(() => this.revivals.delete(id));
		this.revivals.set(id, revival);
		return revival;
	}

	/**
	 * Destructive delete: tombstone durably first, then dispose and clean up.
	 * A tombstoned child is never restored, even if cleanup fails.
	 */
	async delete(ownerSessionId: string, id: string, cleanup?: (record: ChildRecord) => Promise<void>): Promise<void> {
		const record = this.get(ownerSessionId, id);
		if (!canTransitionChildState(record.state, "deleted"))
			throw new ChildRegistryError("busy", `Stop child ${id} before deleting it (state ${record.state}).`);
		const handle = this.residents.get(id);
		this.residents.delete(id);
		const tombstone = this.transition(ownerSessionId, id, record.generation, "deleted", {}, true);
		await handle?.dispose();
		await cleanup?.(tombstone);
	}

	/**
	 * Resolve once every listed child satisfies `done`, or when the bound expires.
	 * Subscribes to transitions; never polls.
	 */
	waitFor(
		ownerSessionId: string,
		ids: readonly string[],
		done: (record: ChildRecord) => boolean,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<{ records: ChildRecord[]; timedOut: boolean }> {
		const snapshot = () => ids.map((id) => this.get(ownerSessionId, id));
		const initial = snapshot();
		if (initial.every(done)) return Promise.resolve({ records: initial, timedOut: false });
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (timedOut: boolean, error?: unknown) => {
				unsubscribe();
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve({ records: snapshot(), timedOut });
			};
			const unsubscribe = this.subscribe((event) => {
				if (event.type !== "record" || !ids.includes(event.record.id)) return;
				try {
					if (snapshot().every(done)) finish(false);
				} catch (error) {
					finish(false, error);
				}
			});
			const onAbort = () => finish(true);
			if (signal?.aborted) return finish(true);
			signal?.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(() => finish(true), timeoutMs);
		});
	}

	// --- completion inbox --------------------------------------------------

	/** Durably record one turn completion for later delivery. */
	recordCompletion(completion: ChildCompletion): void {
		this.get(completion.ownerSessionId, completion.childId);
		if (this.completions.has(completion.deliveryId)) return;
		this.journal.append(CHILD_COMPLETION_ENTRY_TYPE, completion);
		this.journal.flush();
		this.completions.set(completion.deliveryId, completion);
		this.emit({ type: "completion", completion });
	}

	/**
	 * Claim a completion for delivery. The delivered marker is written durably
	 * before the caller sends, so a crash can lose a notification (it stays
	 * visible in the inbox) but never deliver it twice.
	 */
	claimDelivery(ownerSessionId: string, deliveryId: string): ChildCompletion | undefined {
		const completion = this.completions.get(deliveryId);
		if (!completion || completion.ownerSessionId !== ownerSessionId || this.delivered.has(deliveryId))
			return undefined;
		this.journal.append(CHILD_DELIVERED_ENTRY_TYPE, { deliveryId });
		this.journal.flush();
		this.delivered.add(deliveryId);
		return completion;
	}

	// --- restart -----------------------------------------------------------

	/**
	 * Rebuild from the journal after a process restart. Resident states park, an
	 * in-flight turn is marked `interrupted`, and tombstones stay deleted.
	 */
	restore(): ChildRecord[] {
		this.records.clear();
		this.completions.clear();
		this.delivered.clear();
		for (const entry of this.journal.entries()) {
			if (entry.customType === CHILD_RECORD_ENTRY_TYPE) {
				const record = entry.data as ChildRecord;
				this.records.set(record.id, record);
			} else if (entry.customType === CHILD_COMPLETION_ENTRY_TYPE) {
				const completion = entry.data as ChildCompletion;
				this.completions.set(completion.deliveryId, completion);
			} else if (entry.customType === CHILD_DELIVERED_ENTRY_TYPE) {
				this.delivered.add((entry.data as { deliveryId: string }).deliveryId);
			}
		}
		const recovered: ChildRecord[] = [];
		for (const record of [...this.records.values()]) {
			const next = recoverChildStateAfterRestart(record.state, record.turnInFlight);
			if (next.state === record.state) continue;
			const updated: ChildRecord = {
				...record,
				state: next.state,
				generation: record.generation + 1,
				turnInFlight: false,
				...(next.interruptedTurn ? { lastTurnOutcome: "interrupted" as const } : {}),
				updatedAt: this.now(),
			};
			this.journal.append(CHILD_RECORD_ENTRY_TYPE, updated);
			this.records.set(record.id, updated);
			recovered.push(updated);
		}
		return recovered;
	}

	/** Dispose every resident child without changing durable state (session shutdown). */
	async disposeAll(): Promise<void> {
		const handles = [...this.residents.values()];
		this.residents.clear();
		await Promise.allSettled(handles.map((handle) => handle.dispose()));
	}

	private emit(event: RegistryEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
