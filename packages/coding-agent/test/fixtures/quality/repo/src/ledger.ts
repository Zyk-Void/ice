import { DEFAULT_BATCH_SIZE, RETRY_LIMIT } from "./config.ts";
import { withLateFee } from "./pricing.ts";
import { type AuditEntry, AuditRing } from "./ring.ts";
import { sum } from "./sum.ts";

export interface Sale {
	label: string;
	amountCents: number;
}

/** Records kiosk sales, tracks the cents balance, and keeps the audit log. */
export class Ledger {
	readonly audit: AuditRing;
	readonly sales: Sale[] = [];

	constructor(auditCapacity?: number) {
		this.audit = new AuditRing(auditCapacity);
	}

	recordSale(label: string, amountCents: number): void {
		this.sales.push({ label, amountCents });
		this.audit.record(`sale:${label}`);
	}

	outstandingBalanceCents(): number {
		return sum(this.sales.map((sale) => sale.amountCents));
	}

	lateFeeBalanceCents(): number {
		return withLateFee(this.outstandingBalanceCents());
	}

	auditSnapshot(): AuditEntry[] {
		return this.audit.snapshot();
	}
}

/** Number of times the kiosk retries a failed sync before giving up. */
export function syncRetryBudget(): number {
	return RETRY_LIMIT;
}

export function batchSize(): number {
	return DEFAULT_BATCH_SIZE;
}
