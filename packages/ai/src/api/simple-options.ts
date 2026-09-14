import type {
	Api,
	Context,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
} from "../types.ts";
import { estimateContextTokens } from "../utils/estimate.ts";

const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;

export function clampMaxTokensToContext(model: Model<Api>, context: Context, maxTokens: number): number {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}

/** Clamp a request to runtime authority without ever widening it. Provider null means unset. */
export function clampMaxTokensToHardLimit(
	maxTokens: number | null | undefined,
	hardMaxOutputTokens: number | undefined,
): number | undefined {
	const requested = maxTokens ?? undefined;
	if (hardMaxOutputTokens === undefined) return requested;
	if (!Number.isFinite(hardMaxOutputTokens) || hardMaxOutputTokens <= 0) {
		throw new Error("hardMaxOutputTokens must be a positive finite number.");
	}
	if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
		throw new Error("maxTokens must be a positive finite number when a hard output authority is supplied.");
	}
	return requested === undefined ? hardMaxOutputTokens : Math.min(requested, hardMaxOutputTokens);
}

/** Reapply the runtime output authority after an adapter payload callback. */
export function enforceHardMaxTokensInRecord(
	payload: Record<string, unknown>,
	field: string,
	hardMaxOutputTokens: number | undefined,
): void {
	if (hardMaxOutputTokens === undefined) return;
	const value = payload[field];
	if (value !== undefined && value !== null && typeof value !== "number") {
		throw new Error(`${field} must be a number when a hard output authority is supplied.`);
	}
	payload[field] = clampMaxTokensToHardLimit(value as number | null | undefined, hardMaxOutputTokens);
}

export function buildBaseOptions(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	apiKey?: string,
): Omit<StreamOptions, "toolChoice"> & { toolChoice?: "auto" | "none" } {
	const samplingParams =
		model.samplingParams || options?.samplingParams
			? { ...model.samplingParams, ...options?.samplingParams }
			: undefined;
	return {
		serviceTier: options?.serviceTier,
		temperature: options?.temperature,
		samplingParams,
		maxTokens: clampMaxTokensToHardLimit(
			clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
			options?.hardMaxOutputTokens,
		),
		hardMaxOutputTokens: options?.hardMaxOutputTokens,
		toolChoice: options?.toolChoice,
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
		fetch: options?.fetch,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		promptCacheKey: options?.promptCacheKey,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		env: options?.env,
	};
}

export function clampReasoning(
	effort: ThinkingLevel | undefined,
): Exclude<ThinkingLevel, "xhigh" | "max" | "ultra"> | undefined {
	return effort === "xhigh" || effort === "max" || effort === "ultra" ? "high" : effort;
}

export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
	hardMaxOutputTokens?: number,
): { maxTokens: number; thinkingBudget: number } {
	const defaultBudgets: ThinkingBudgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
	};
	const budgets = { ...defaultBudgets, ...customBudgets };

	const minOutputTokens = 1024;
	if (hardMaxOutputTokens !== undefined && (!Number.isFinite(hardMaxOutputTokens) || hardMaxOutputTokens <= 0)) {
		throw new Error("hardMaxOutputTokens must be a positive finite number.");
	}
	if (hardMaxOutputTokens !== undefined && hardMaxOutputTokens < minOutputTokens) {
		throw new Error("hardMaxOutputTokens is below the minimum ordinary output size.");
	}
	const level = clampReasoning(reasoningLevel)!;
	let thinkingBudget = budgets[level]!;
	const modelCeiling =
		hardMaxOutputTokens === undefined ? modelMaxTokens : Math.min(modelMaxTokens, hardMaxOutputTokens);
	const maxTokens =
		baseMaxTokens === undefined ? modelCeiling : Math.min(baseMaxTokens + thinkingBudget, modelCeiling);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	}

	return { maxTokens, thinkingBudget };
}
