/**
 * ICE subagent concurrency admission: the hard ceiling and the FIFO permit
 * coordinator behind `ice.subagents.maxConcurrent`.
 *
 * Ice remains the sole authoritative reasoning/tool loop; this module owns only
 * bounded resource admission.
 */

export const SUBAGENT_CONCURRENCY_LIMITS = {
	min: 1,
	/** Bundled default active children for read-only/bounded work. */
	bundledDefault: 8,
} as const;

/**
 * Shared permit accounting across synchronous batches and asynchronous jobs.
 * A caller cannot exceed the shared ceiling by mixing admission paths. Permits
 * must be released exactly once; releasing more permits than acquired is an
 * internal invariant failure.
 */
export class SubagentConcurrencyAdmission {
	private count = 0;
	private readonly releaseListeners = new Set<() => void>();
	readonly maxActive: number;

	constructor(maxActive: number) {
		// No upper bound: the user owns the memory, CPU, and rate-limit tradeoff; excess turns queue.
		if (!Number.isSafeInteger(maxActive) || maxActive < SUBAGENT_CONCURRENCY_LIMITS.min) {
			throw new Error(
				`Subagent concurrency admission cap must be an integer of at least ${SUBAGENT_CONCURRENCY_LIMITS.min}.`,
			);
		}
		this.maxActive = maxActive;
	}

	get active(): number {
		return this.count;
	}

	get capacity(): number {
		return this.maxActive;
	}

	tryAcquire(): boolean {
		if (this.count >= this.maxActive) return false;
		this.count++;
		return true;
	}

	release(): void {
		if (this.count === 0) {
			throw new Error("Subagent concurrency admission released more permits than acquired.");
		}
		this.count--;
		if (this.count < this.maxActive) {
			for (const listener of [...this.releaseListeners]) {
				try {
					listener();
				} catch {
					// Wakeup listeners are non-authoritative scheduling hints.
				}
			}
		}
	}

	onRelease(listener: () => void): () => void {
		this.releaseListeners.add(listener);
		return () => this.releaseListeners.delete(listener);
	}
}
