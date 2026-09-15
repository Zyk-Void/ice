import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	ModelsRefreshOptions,
	ModelsRefreshResult,
	OpenAICompletionsCompat,
	ThinkingLevelMap,
} from "@zykairotis/ice-ai";

const PROVIDER = "omni";
export const DEFAULT_BASE_URL = "http://127.0.0.1:20128/v1";
const REQUEST_TIMEOUT_MS = 30000;

export function resolveBaseUrl(config?: ModelsFile): string {
	const configured = config?.providers?.[PROVIDER] as { baseUrl?: string } | undefined;
	return process.env.ICE_OMNI_BASE_URL ?? process.env.ICE_LOCAL_BASE_URL ?? configured?.baseUrl ?? DEFAULT_BASE_URL;
}

interface EndpointModel {
	id: unknown;
	context_length?: unknown;
	max_input_tokens?: unknown;
	max_output_tokens?: unknown;
	input_modalities?: unknown;
	capabilities?: {
		vision?: unknown;
		reasoning?: unknown;
		thinking?: unknown;
		contextWindow?: unknown;
		maxOutput?: unknown;
		thinkingFormat?: unknown;
		thinkingCanDisable?: unknown;
		thinkingLevelMap?: unknown;
		serviceTiers?: unknown;
	};
}

interface ModelsResponse {
	data?: EndpointModel[];
}

interface AuthFile {
	[provider: string]: { type?: string; key?: string } | undefined;
}

interface ModelsFile {
	providers?: Record<string, unknown>;
}

export type LocalModelsRefreshResult = { updated: boolean; count?: number; error?: string };

export type ProviderCatalogRefetchResult =
	| { ok: true; providerId: string; count: number }
	| { ok: false; providerId: string; error: string };

export interface ProviderCatalogSummary {
	id: string;
	name: string;
	modelCount: number;
	baseUrl?: string;
}

const LOCAL_PROVIDER_ID = PROVIDER;

async function loadLocalApiKey(agentDir: string): Promise<string> {
	const authPath = join(agentDir, "auth.json");
	const auth = JSON.parse(await readFile(authPath, "utf8")) as AuthFile;
	const apiKey = auth[PROVIDER]?.key ?? auth.local?.key;
	if (!apiKey) throw new Error(`missing ${PROVIDER} API key in ${authPath}`);
	return apiKey;
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (Number.isSafeInteger(value) && (value as number) > 0) return value as number;
	}
	return undefined;
}

function hasImageInput(entry: EndpointModel): boolean {
	if (entry.capabilities?.vision === true) return true;
	return Array.isArray(entry.input_modalities) && entry.input_modalities.includes("image");
}

const THINKING_LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
function parseThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("endpoint returned invalid thinkingLevelMap");
	}

	const map: ThinkingLevelMap = {};
	for (const [key, mapped] of Object.entries(value)) {
		if (
			!(THINKING_LEVEL_KEYS as readonly string[]).includes(key) ||
			(typeof mapped !== "string" && mapped !== null)
		) {
			throw new Error("endpoint returned invalid thinkingLevelMap");
		}
		map[key as (typeof THINKING_LEVEL_KEYS)[number]] = mapped;
	}
	return map;
}

function inferThinkingLevelMap(id: string, thinkingFormat: unknown): ThinkingLevelMap | undefined {
	const normalizedId = id.toLowerCase();
	if (thinkingFormat === "deepseek" && normalizedId.includes("deepseek-v4")) {
		return { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" };
	}
	// OmniRoute cx/ Codex routes accept OpenAI effort through max even when the
	// catalog omits thinkingFormat. Keep this off unprefixed aliases.
	if (isCxModel(id) && (thinkingFormat === undefined || thinkingFormat === "openai")) {
		return { xhigh: "xhigh", max: "max" };
	}
	if (thinkingFormat === "openai" && normalizedId.includes("gpt-5.6")) {
		return { xhigh: "xhigh", max: "max" };
	}
	switch (thinkingFormat) {
		case "claude-adaptive":
			return { minimal: null, xhigh: null, max: "max" };
		case "claude-budget":
			return { xhigh: "xhigh", max: "max" };
		case "gemini-level":
			return { minimal: "minimal", xhigh: null, max: null };
		case "gemini-budget":
			return { minimal: null, xhigh: null, max: null };
		case "kimi":
			return { minimal: null, xhigh: null, max: "max" };
		case "minimax":
			return { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null };
		case "hunyuan":
		case "step":
			return { minimal: null, xhigh: null, max: null };
		case "zai":
			return { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null };
		default:
			return undefined;
	}
}

function parseThinkingFormat(value: unknown): OpenAICompletionsCompat["thinkingFormat"] | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("endpoint returned invalid thinkingFormat");
	}
	return value;
}

function parseServiceTiers(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.some((tier) => typeof tier !== "string" || tier.length === 0)) {
		throw new Error("endpoint returned invalid serviceTiers");
	}
	return [...value];
}

export const CX_MAX_CONTEXT_TOKENS = 272000;

// Atria's gateway currently reports this model with a stale 128K context and no
// output limit. The public Atria API documents a 256K context and a 65,536-token
// maximum output for Atria-Dawn-Preview.
export const ATRIA_DAWN_PREVIEW_CONTEXT_TOKENS = 256000;
export const ATRIA_DAWN_PREVIEW_MAX_OUTPUT_TOKENS = 65536;

function isAtriaDawnPreviewModel(id: string): boolean {
	return /(?:^|\/)atria-dawn-preview$/iu.test(id);
}

export function isCxModel(id: string): boolean {
	return /^cx\//i.test(id);
}

function isLocalCodexResponsesModel(id: string): boolean {
	return /^cx\/gpt-5\.6(?:-|$)/i.test(id);
}

function mapOneEndpointModel(entry: EndpointModel, ids: Set<string>) {
	if (typeof entry.id !== "string" || entry.id.length === 0 || ids.has(entry.id)) {
		throw new Error("endpoint returned invalid or duplicate model ID");
	}
	ids.add(entry.id);
	const capabilities = entry.capabilities ?? {};
	const rawContextWindow = firstPositiveInteger(
		capabilities.contextWindow,
		entry.context_length,
		entry.max_input_tokens,
	);
	const rawMaxTokens = firstPositiveInteger(capabilities.maxOutput, entry.max_output_tokens, rawContextWindow);
	if (rawContextWindow === undefined) {
		throw new Error(`${entry.id}: invalid contextWindow`);
	}
	if (rawMaxTokens === undefined) {
		throw new Error(`${entry.id}: invalid maxOutput`);
	}
	const contextWindow = isAtriaDawnPreviewModel(entry.id)
		? ATRIA_DAWN_PREVIEW_CONTEXT_TOKENS
		: isCxModel(entry.id)
			? Math.min(rawContextWindow, CX_MAX_CONTEXT_TOKENS)
			: rawContextWindow;
	const maxTokens = isAtriaDawnPreviewModel(entry.id)
		? Math.min(rawMaxTokens, ATRIA_DAWN_PREVIEW_MAX_OUTPUT_TOKENS)
		: Math.min(rawMaxTokens, contextWindow);
	const thinkingFormat = parseThinkingFormat(capabilities.thinkingFormat);
	const serviceTiers = parseServiceTiers(capabilities.serviceTiers);
	const fastCapable =
		isLocalCodexResponsesModel(entry.id) && (serviceTiers === undefined || serviceTiers.includes("priority"));
	const thinkingLevelMap =
		parseThinkingLevelMap(capabilities.thinkingLevelMap) ?? inferThinkingLevelMap(entry.id, thinkingFormat);
	const compat: OpenAICompletionsCompat | undefined = thinkingFormat
		? {
				thinkingFormat,
				// OmniRoute / OpenAI-compatible gateways accept reasoning_effort
				// and translate it to the advertised native format.
				supportsReasoningEffort: true,
				...(typeof capabilities.thinkingCanDisable === "boolean"
					? { thinkingCanDisable: capabilities.thinkingCanDisable }
					: {}),
			}
		: undefined;
	return {
		id: entry.id,
		name: entry.id,
		api: fastCapable ? "openai-responses" : "openai-completions",
		reasoning: capabilities.reasoning === true || capabilities.thinking === true,
		input: hasImageInput(entry) ? ["text", "image"] : ["text"],
		contextWindow,
		maxTokens,
		...(serviceTiers ? { serviceTiers } : fastCapable ? { serviceTiers: ["priority"] } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		...(compat ? { compat } : {}),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

export function mapEndpointModels(response: ModelsResponse) {
	if (!Array.isArray(response.data) || response.data.length === 0) throw new Error("endpoint returned no models");

	const ids = new Set<string>();
	const models = [];
	let firstError: Error | undefined;
	for (const entry of response.data) {
		try {
			models.push(mapOneEndpointModel(entry, ids));
		} catch (error) {
			firstError ??= error instanceof Error ? error : new Error(String(error));
		}
	}
	if (models.length === 0) throw firstError ?? new Error("endpoint returned no models");
	return models;
}

export async function refreshLocalModels(agentDir: string): Promise<LocalModelsRefreshResult> {
	try {
		const modelsPath = join(agentDir, "models.json");
		const apiKey = await loadLocalApiKey(agentDir);

		let config: ModelsFile = {};
		try {
			config = JSON.parse(await readFile(modelsPath, "utf8")) as ModelsFile;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const baseUrl = resolveBaseUrl(config);

		const response = await fetch(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`model endpoint returned HTTP ${response.status}`);
		const models = mapEndpointModels((await response.json()) as ModelsResponse);

		config.providers ??= {};
		config.providers[PROVIDER] = {
			baseUrl,
			api: "openai-completions",
			apiKey,
			authHeader: true,
			models,
		};
		delete config.providers.local;

		process.env.ICE_LOCAL_API_KEY = apiKey;
		const temporaryPath = join(dirname(modelsPath), `.models.json.ice-${process.pid}`);
		await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
		await rename(temporaryPath, modelsPath);
		return { updated: true, count: models.length };
	} catch (error) {
		return { updated: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function refreshLocalModelsForStartup(
	agentDir: string,
	_options: {
		skip?: boolean;
		refresh?: () => Promise<LocalModelsRefreshResult>;
		onFailure: (error: string) => void;
	},
): Promise<void> {
	try {
		process.env.ICE_LOCAL_API_KEY = await loadLocalApiKey(agentDir);
	} catch {}
}

export function summarizeProviderCatalogs(runtime: {
	getProviders(): readonly { id: string; name?: string; baseUrl?: string }[];
	getModels(providerId?: string): readonly unknown[];
}): ProviderCatalogSummary[] {
	return runtime.getProviders().map((provider) => ({
		id: provider.id,
		name: provider.name ?? provider.id,
		modelCount: runtime.getModels(provider.id).length,
		...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
	}));
}

export async function refetchProviderCatalog(options: {
	providerId: string;
	agentDir: string;
	refreshRuntime: (options: ModelsRefreshOptions) => Promise<ModelsRefreshResult>;
	refreshLocal?: (agentDir: string) => Promise<LocalModelsRefreshResult>;
	countModels?: (providerId: string) => number;
	isLocalProvider?: boolean;
	signal?: AbortSignal;
}): Promise<ProviderCatalogRefetchResult> {
	const providerId = options.providerId;
	const isLocal = options.isLocalProvider ?? providerId === LOCAL_PROVIDER_ID;
	if (isLocal) {
		const refreshLocal = options.refreshLocal ?? refreshLocalModels;
		const written = await refreshLocal(options.agentDir);
		if (!written.updated) {
			return { ok: false, providerId, error: written.error ?? "unknown error" };
		}
		const runtimeResult = await options.refreshRuntime({
			providers: [providerId],
			allowNetwork: false,
		});
		if (runtimeResult.aborted) return { ok: false, providerId, error: "timed out" };
		const runtimeError = firstRefreshError(runtimeResult.errors);
		if (runtimeError) return { ok: false, providerId, error: runtimeError };
		return { ok: true, providerId, count: written.count ?? 0 };
	}

	const runtimeResult = await options.refreshRuntime({
		providers: [providerId],
		allowNetwork: true,
		force: true,
		signal: options.signal,
	});
	if (runtimeResult.aborted) return { ok: false, providerId, error: "timed out" };
	const runtimeError = firstRefreshError(runtimeResult.errors);
	if (runtimeError) return { ok: false, providerId, error: runtimeError };
	return { ok: true, providerId, count: options.countModels?.(providerId) ?? 0 };
}

function firstRefreshError(errors: ReadonlyMap<string, Error>): string | undefined {
	const error = errors.values().next().value;
	return error?.message;
}
