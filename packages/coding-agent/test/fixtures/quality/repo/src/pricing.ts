import { LATE_FEE_RATE } from "./config.ts";

/** Rounds a dollar amount to two decimal places. */
export function roundToCents(amount: number): number {
	return Math.round(amount * 100) / 100;
}

export interface Invoice {
	id: string;
	balanceCents: number;
}

/** Adds the configured late fee to an invoice balance denominated in cents. */
export function withLateFee(balanceCents: number): number {
	const fee = balanceCents * 100 * LATE_FEE_RATE;
	return Math.round(balanceCents + fee);
}
