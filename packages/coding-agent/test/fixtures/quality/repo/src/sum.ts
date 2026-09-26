/** Dependency-free numeric helpers. */
export function sum(values: readonly number[]): number {
	let total = 0;
	for (const value of values) total += value;
	return total;
}

export function mean(values: readonly number[]): number {
	if (values.length === 0) return 0;
	return sum(values) / values.length;
}

export function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}
