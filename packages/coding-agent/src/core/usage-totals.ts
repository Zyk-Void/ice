import type { Usage } from "@zykairotis/ice-ai/compat";
import type { SessionEntry } from "./session-manager.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

/** Read extension-owned billing data without adding it to model context. */
export function subagentUsageFromEntry(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "custom" || entry.customType !== "subagent_usage") return undefined;
	const data: unknown = entry.data;
	if (!data || typeof data !== "object" || !("usage" in data)) return undefined;
	const usage = data.usage;
	if (!usage || typeof usage !== "object") return undefined;
	if (
		!("input" in usage) ||
		!("output" in usage) ||
		!("cacheRead" in usage) ||
		!("cacheWrite" in usage) ||
		!("cost" in usage)
	)
		return undefined;
	const { input, output, cacheRead, cacheWrite, cost } = usage;
	if (
		typeof input !== "number" ||
		typeof output !== "number" ||
		typeof cacheRead !== "number" ||
		typeof cacheWrite !== "number" ||
		typeof cost !== "number"
	)
		return undefined;
	if (
		![input, output, cacheRead, cacheWrite].every((value) => Number.isSafeInteger(value) && value >= 0) ||
		!Number.isFinite(cost) ||
		cost < 0
	)
		return undefined;
	const totalTokens = input + output + cacheRead + cacheWrite;
	if (!Number.isSafeInteger(totalTokens)) return undefined;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

/** Group attributable assistant usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		let key: string | undefined;
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usage = entry.message.usage;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			key = "Tools/summaries";
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			key = "Tools/summaries";
			usage = entry.usage;
		} else {
			usage = subagentUsageFromEntry(entry);
			if (usage) key = "Subagents";
		}
		if (!key || !usage) continue;

		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}
