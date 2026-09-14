import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	OpenAIResponsesCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Usage,
} from "../types.ts";
import { splitDeferredTools } from "../utils/deferred-tools.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import {
	classifyRequestContextMode,
	extractProviderErrorFields,
	forgetSuccessfulResponseId,
	hashOpaqueId,
	inputItemCount,
	isContinuationDiagEnabled,
	isStalePreviousResponseError,
	lastSuccessfulResponseIdHash,
	logContinuationError,
	logContinuationRequest,
	logContinuationResponse,
	nextContinuationRequestSequence,
	rememberSuccessfulResponseId,
} from "../utils/provider-continuation-diag.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.ts";
import { buildBaseOptions, clampMaxTokensToHardLimit, enforceHardMaxTokensInRecord } from "./simple-options.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// OpenAI Responses rejects max_output_tokens below 16: upstream issue #6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

function detectSessionAffinityFormat(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">) {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses ICE_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("ICE_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
	};
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

function formatOpenAIResponsesError(error: unknown): string {
	return formatProviderError(normalizeProviderError(error), "OpenAI API error");
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

/**
 * Generate function for OpenAI Responses API
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			// Create OpenAI client
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const promptCacheKey = cacheRetention === "none" ? undefined : options?.promptCacheKey;
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				context.tools,
				compat.supportsOpenAIGrammarTools,
			);
			const client = createClient(model, context, apiKey, options?.headers, options?.fetch, cacheSessionId);
			let params = buildParams(model, context, options, compat, grammarToolInputProperties, promptCacheKey);
			const corePreviousResponseId =
				"previous_response_id" in params
					? (params as ResponseCreateParamsStreaming & { previous_response_id?: string }).previous_response_id
					: undefined;
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			if (options?.hardMaxOutputTokens !== undefined) {
				const payload = params as unknown as Record<string, unknown>;
				enforceHardMaxTokensInRecord(payload, "max_output_tokens", options.hardMaxOutputTokens);
				const maxTokens = payload.max_output_tokens as number;
				if (maxTokens < OPENAI_RESPONSES_MIN_OUTPUT_TOKENS) {
					if (options.hardMaxOutputTokens < OPENAI_RESPONSES_MIN_OUTPUT_TOKENS) {
						throw new Error("hardMaxOutputTokens is below the provider minimum output floor.");
					}
					payload.max_output_tokens = OPENAI_RESPONSES_MIN_OUTPUT_TOKENS;
				}
			}
			const finalParams = params as ResponseCreateParamsStreaming & {
				previous_response_id?: string;
				prompt_cache_key?: string;
				store?: boolean;
				input?: unknown;
			};
			const diagEnabled = isContinuationDiagEnabled(model.provider, options?.env);
			const requestSequence = diagEnabled ? nextContinuationRequestSequence() : 0;
			const sessionKey = options?.sessionId ?? null;
			if (diagEnabled) {
				const previousResponseId = finalParams.previous_response_id;
				const previousResponseIdPresent = Boolean(previousResponseId);
				const inputCount = inputItemCount(finalParams.input);
				const messageCount = context.messages?.length ?? 0;
				logContinuationRequest(
					{
						timestamp: new Date().toISOString(),
						requestSequence,
						iceSessionIdHash: hashOpaqueId(sessionKey),
						provider: model.provider,
						model: model.id,
						api: model.api,
						baseUrl: model.baseUrl,
						corePreviousResponseIdPresent: Boolean(corePreviousResponseId),
						previousResponseIdPresent,
						previousResponseIdHash: hashOpaqueId(previousResponseId),
						lastSuccessfulResponseIdHash: lastSuccessfulResponseIdHash(sessionKey),
						idsEqual:
							previousResponseIdPresent && sessionKey
								? hashOpaqueId(previousResponseId) === lastSuccessfulResponseIdHash(sessionKey)
								: null,
						extensionInjectedPreviousResponseId: !corePreviousResponseId && previousResponseIdPresent,
						requestContextMode: classifyRequestContextMode({
							previousResponseIdPresent,
							inputItemCount: inputCount,
							messageCount,
						}),
						inputItemCount: inputCount,
						messageCount,
						toolCount: context.tools?.length ?? 0,
						store: typeof finalParams.store === "boolean" ? finalParams.store : null,
						sessionAffinityHash: hashOpaqueId(cacheSessionId),
						clientRequestHash: hashOpaqueId(cacheSessionId),
						promptCacheKeyHash: hashOpaqueId(finalParams.prompt_cache_key),
					},
					options?.env,
				);
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			let staleContinuationRetried = false;
			let startEmitted = false;
			for (;;) {
				try {
					const { data: openaiStream, response } = await retryProviderRequest(
						() => client.responses.create(params, requestOptions).withResponse(),
						{
							maxRetries: options?.maxRetries,
							maxRetryDelayMs: options?.maxRetryDelayMs,
							signal: options?.signal,
						},
					);
					const responseHeaders = headersToRecord(response.headers);
					await options?.onResponse?.({ status: response.status, headers: responseHeaders }, model);
					stream.push({ type: "start", partial: output });
					startEmitted = true;

					await processResponsesStream(openaiStream, output, stream, model, {
						serviceTier: options?.serviceTier,
						grammarToolInputProperties,
						applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
					});
					if (diagEnabled) {
						logContinuationResponse(
							{
								timestamp: new Date().toISOString(),
								requestSequence,
								status: response.status,
								responseIdPresent: Boolean(output.responseId),
								responseIdHash: hashOpaqueId(output.responseId),
								stopReason: output.stopReason,
								codexlbWorkerId: responseHeaders["x-codexlb-worker-id"] ?? null,
								codexlbAccountId: responseHeaders["x-codexlb-account-id"] ?? null,
								codexlbUpstreamId: responseHeaders["x-codexlb-upstream-id"] ?? null,
								codexlbPrevRespSource: responseHeaders["x-codexlb-prev-resp-source"] ?? null,
								codexlbAffinityKind: responseHeaders["x-codexlb-affinity-kind"] ?? null,
							},
							options?.env,
						);
					}
					break;
				} catch (error) {
					if (diagEnabled) {
						const fields = extractProviderErrorFields(error);
						logContinuationError(
							{
								timestamp: new Date().toISOString(),
								requestSequence,
								status: fields.status,
								previousResponseIdHash: hashOpaqueId(finalParams.previous_response_id),
								providerCode: fields.code,
								providerMessage: fields.message,
								providerParam: fields.param,
							},
							options?.env,
						);
					}
					const canRetryStaleContinuation =
						!staleContinuationRetried &&
						!startEmitted &&
						!options?.signal?.aborted &&
						isStalePreviousResponseError(error);
					if (!canRetryStaleContinuation) {
						throw error;
					}
					staleContinuationRetried = true;
					forgetSuccessfulResponseId(sessionKey);
					delete finalParams.previous_response_id;
					params = finalParams;
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			if (
				diagEnabled &&
				(output.stopReason === "stop" || output.stopReason === "toolUse" || output.stopReason === "length")
			) {
				rememberSuccessfulResponseId(sessionKey, output.responseId);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// Streaming scratch buffers are only used during parsing; never persist them.
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatOpenAIResponsesError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

function createClient(
	model: Model<"openai-responses">,
	context: Context,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
) {
	const compat = getCompat(model);
	const headers: ProviderHeaders = { ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
		}
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat> = getCompat(model),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		context.tools,
		compat.supportsOpenAIGrammarTools,
	),
	promptCacheKey?: string,
) {
	const toolPlacement = splitDeferredTools(context, compat.supportsToolSearch);
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		deferredTools: toolPlacement.deferred,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
	});

	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	const disableImplicitPromptCache = cacheRetention === "none" && compat.supportsExplicitPromptCacheMode;
	const params: ResponseCreateParamsStreaming & { prompt_cache_options?: { mode: "explicit" } } = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key:
			cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(promptCacheKey ?? options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: disableImplicitPromptCache ? { mode: "explicit" } : undefined,
		store: false,
	};

	if (options?.maxTokens || options?.hardMaxOutputTokens !== undefined) {
		const maxTokens = clampMaxTokensToHardLimit(options.maxTokens, options.hardMaxOutputTokens)!;
		if (maxTokens < OPENAI_RESPONSES_MIN_OUTPUT_TOKENS && options.hardMaxOutputTokens !== undefined) {
			throw new Error("hardMaxOutputTokens is below the provider minimum output floor.");
		}
		params.max_output_tokens = Math.max(maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (toolPlacement.immediate.length > 0) {
		params.tools = convertResponsesTools(toolPlacement.immediate, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
	}

	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
		if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
	}

	// Last so custom keys override the named request fields.
	if (options?.samplingParams) {
		Object.assign(params, options.samplingParams);
	}
	if (options?.hardMaxOutputTokens !== undefined) {
		const maxTokens = clampMaxTokensToHardLimit(params.max_output_tokens, options.hardMaxOutputTokens)!;
		if (maxTokens < OPENAI_RESPONSES_MIN_OUTPUT_TOKENS) {
			throw new Error("hardMaxOutputTokens is below the provider minimum output floor.");
		}
		params.max_output_tokens = maxTokens;
	}

	return params;
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
