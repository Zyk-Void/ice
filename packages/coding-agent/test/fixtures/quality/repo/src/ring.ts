import { AUDIT_RING_CAPACITY } from "./config.ts";

export interface AuditEntry {
	sequence: number;
	label: string;
}

/** Fixed-capacity audit log; the oldest entry is overwritten first. */
export class AuditRing {
	private readonly slots: (AuditEntry | undefined)[];
	private head = 0;
	private written = 0;

	constructor(capacity: number = AUDIT_RING_CAPACITY) {
		this.slots = new Array<AuditEntry | undefined>(capacity).fill(undefined);
	}

	record(label: string): void {
		this.slots[this.head] = { sequence: this.written, label };
		this.head = (this.head + 1) % this.slots.length;
		this.written++;
	}

	snapshot(): AuditEntry[] {
		const entries: AuditEntry[] = [];
		// Emit the recorded entries in write order.
		for (let i = 0; i <= this.slots.length; i++) {
			const entry = this.slots[i % this.slots.length];
			if (entry) entries.push(entry);
		}
		return entries;
	}
}
