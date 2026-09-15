import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelAwareReserveTokens } from "../src/core/compaction/compaction.ts";
import {
	ATRIA_DAWN_PREVIEW_CONTEXT_TOKENS,
	ATRIA_DAWN_PREVIEW_MAX_OUTPUT_TOKENS,
	CX_MAX_CONTEXT_TOKENS,
	DEFAULT_BASE_URL,
	isCxModel,
	mapEndpointModels,
	refetchProviderCatalog,
	refreshLocalModelsForStartup,
	resolveBaseUrl,
	summarizeProviderCatalogs,
} from "../src/ice-provider.ts";

const tempDirs: string[] = [];
const originalLocalApiKey = process.env.ICE_LOCAL_API_KEY;
const originalOmniBaseUrl = process.env.ICE_OMNI_BASE_URL;
const originalLocalBaseUrl = process.env.ICE_LOCAL_BASE_URL;

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
	if (originalLocalApiKey === undefined) delete process.env.ICE_LOCAL_API_KEY;
	else process.env.ICE_LOCAL_API_KEY = originalLocalApiKey;
	if (originalOmniBaseUrl === undefined) delete process.env.ICE_OMNI_BASE_URL;
	else process.env.ICE_OMNI_BASE_URL = originalOmniBaseUrl;
	if (originalLocalBaseUrl === undefined) delete process.env.ICE_LOCAL_BASE_URL;
	else process.env.ICE_LOCAL_BASE_URL = originalLocalBaseUrl;
});

describe("ice provider model mapping", () => {
	it("maps endpoint limits and capabilities exactly", () => {
		expect(
			mapEndpointModels({
				data: [
					{
						id: "vendor/model",
						capabilities: {
							vision: true,
							reasoning: true,
							contextWindow: 400000,
							maxOutput: 128000,
							thinkingFormat: "openai",
							thinkingCanDisable: true,
							thinkingLevelMap: { ultra: "native-ultra" },
						},
					},
				],
			}),
		).toMatchObject([
			{
				id: "vendor/model",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 400000,
				maxTokens: 128000,
				thinkingLevelMap: { ultra: "native-ultra" },
				compat: {
					thinkingFormat: "openai",
					supportsReasoningEffort: true,
					thinkingCanDisable: true,
				},
			},
		]);
	});

	it("infers only verified current route mappings", () => {
		const models = mapEndpointModels({
			data: [
				{
					id: "cmc/deepseek/deepseek-v4-pro",
					capabilities: {
						reasoning: true,
						contextWindow: 1000000,
						maxOutput: 384000,
						thinkingFormat: "deepseek",
					},
				},
				{
					id: "cx/gpt-5.6-luna",
					capabilities: {
						reasoning: true,
						contextWindow: 272000,
						maxOutput: 128000,
						thinkingFormat: "openai",
					},
				},
			],
		});

		expect(models[0]?.thinkingLevelMap).toEqual({
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
		expect(models[1]?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
		expect(models[1]?.thinkingLevelMap?.ultra).toBeUndefined();
		expect(models[0]?.api).toBe("openai-completions");
		expect(models[0]?.serviceTiers).toBeUndefined();
		expect(models[1]?.api).toBe("openai-responses");
		expect(models[1]?.serviceTiers).toEqual(["priority"]);
	});

	it("exposes xhigh and max for cx/ models without endpoint thinkingFormat", () => {
		const models = mapEndpointModels({
			data: [
				{
					id: "cx/gpt-5.6-luna",
					capabilities: { reasoning: true, contextWindow: 272000, maxOutput: 128000 },
				},
				{
					id: "cx/gpt-5.6-sol",
					capabilities: { reasoning: true, contextWindow: 272000, maxOutput: 128000 },
				},
				{
					id: "cx/gpt-5.6-terra",
					capabilities: { reasoning: true, contextWindow: 272000, maxOutput: 128000 },
				},
				{
					id: "cx/gpt-6-astra",
					capabilities: { reasoning: true, contextWindow: 272000, maxOutput: 128000 },
				},
				{
					id: "gpt-5.6-luna",
					capabilities: { reasoning: true, contextWindow: 872000, maxOutput: 128000 },
				},
			],
		});

		for (const model of models.slice(0, 4)) {
			expect(model?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
		}
		expect(models[4]?.thinkingLevelMap).toBeUndefined();
	});

	it("preserves explicit service tiers and only enables priority for the verified route", () => {
		const models = mapEndpointModels({
			data: [
				{
					id: "cx/gpt-5.6-review",
					capabilities: {
						reasoning: true,
						contextWindow: 272000,
						maxOutput: 128000,
						thinkingFormat: "openai",
						serviceTiers: ["default", "priority"],
					},
				},
				{
					id: "other/gpt-5.6",
					capabilities: {
						reasoning: true,
						contextWindow: 272000,
						maxOutput: 128000,
						thinkingFormat: "openai",
						serviceTiers: ["priority"],
					},
				},
			],
		});

		expect(models[0]?.api).toBe("openai-responses");
		expect(models[0]?.serviceTiers).toEqual(["default", "priority"]);
		expect(models[1]?.api).toBe("openai-completions");
		expect(models[1]?.serviceTiers).toEqual(["priority"]);
	});

	it("preserves supported endpoint thinking formats", () => {
		const [model] = mapEndpointModels({
			data: [
				{
					id: "custom/qwen",
					capabilities: {
						reasoning: true,
						contextWindow: 128000,
						maxOutput: 8192,
						thinkingFormat: "qwen",
					},
				},
			],
		});

		expect(model?.compat).toEqual({ thinkingFormat: "qwen", supportsReasoningEffort: true });
	});

	it("accepts every native thinking format exposed by the local endpoint", () => {
		const formats = [
			"claude-adaptive",
			"claude-budget",
			"gemini-level",
			"gemini-budget",
			"kimi",
			"minimax",
			"hunyuan",
			"step",
		] as const;

		const models = mapEndpointModels({
			data: formats.map((thinkingFormat, index) => ({
				id: `vendor/${thinkingFormat}-${index}`,
				capabilities: { reasoning: true, contextWindow: 128000, maxOutput: 8192, thinkingFormat },
			})),
		});

		expect(models.map((model) => model.compat?.thinkingFormat)).toEqual(formats);
		expect(models.every((model) => model.compat?.supportsReasoningEffort === true)).toBe(true);
	});

	it("accepts nullable optional capability metadata", () => {
		const [model] = mapEndpointModels({
			data: [
				{
					id: "vendor/plain",
					capabilities: {
						contextWindow: 128000,
						maxOutput: 8192,
						thinkingFormat: null,
						thinkingLevelMap: null,
						serviceTiers: null,
					},
				},
			],
		});

		expect(model?.compat).toBeUndefined();
		expect(model?.thinkingLevelMap).toBeUndefined();
		expect(model?.serviceTiers).toBeUndefined();
	});

	it("preserves a new endpoint thinking format without invalidating the catalog", () => {
		const [model] = mapEndpointModels({
			data: [
				{
					id: "vendor/future-reasoning",
					capabilities: {
						reasoning: true,
						contextWindow: 128000,
						maxOutput: 8192,
						thinkingFormat: "future-native-format",
					},
				},
			],
		});

		expect(model?.compat).toMatchObject({ thinkingFormat: "future-native-format", supportsReasoningEffort: true });
	});

	it("rejects incomplete limits instead of guessing", () => {
		expect(() => mapEndpointModels({ data: [{ id: "broken", capabilities: {} }] })).toThrow("contextWindow");
	});

	it("maps OmniRoute top-level limits and skips models that still have none", () => {
		const models = mapEndpointModels({
			data: [
				{
					id: "inf/claude-sonnet-4-6",
					context_length: 1000000,
					max_output_tokens: 128000,
					input_modalities: ["text", "image"],
					capabilities: { reasoning: true, vision: true, thinking: true },
				},
				{
					id: "un/glm-5.2",
					context_length: 200000,
					capabilities: { reasoning: true },
				},
				{ id: "aihorde/Dreamshaper", capabilities: { reasoning: false } },
			],
		});

		expect(models.map((model) => model.id)).toEqual(["inf/claude-sonnet-4-6", "un/glm-5.2"]);
		expect(models[0]).toMatchObject({
			contextWindow: 1000000,
			maxTokens: 128000,
			input: ["text", "image"],
			reasoning: true,
		});
		expect(models[1]).toMatchObject({ contextWindow: 200000, maxTokens: 200000, input: ["text"] });
	});

	it("corrects the incomplete Atria Dawn metadata from OmniRoute", () => {
		const [model] = mapEndpointModels({
			data: [
				{
					id: "Atri/Atria-Dawn-Preview",
					context_length: 128000,
					capabilities: { reasoning: true },
				},
			],
		});

		expect(model).toMatchObject({
			contextWindow: ATRIA_DAWN_PREVIEW_CONTEXT_TOKENS,
			maxTokens: ATRIA_DAWN_PREVIEW_MAX_OUTPUT_TOKENS,
		});
	});

	it("caps all cx/ models to a maximum context window of 272000 tokens", () => {
		expect(CX_MAX_CONTEXT_TOKENS).toBe(272000);
		expect(isCxModel("cx/gpt-5.6-sol")).toBe(true);
		expect(isCxModel("CX/GPT-5.6-LUNA")).toBe(true);
		expect(isCxModel("other/gpt-5.6")).toBe(false);

		const models = mapEndpointModels({
			data: [
				{
					id: "cx/gpt-5.6-sol",
					context_length: 872000,
					max_output_tokens: 128000,
					capabilities: { reasoning: true },
				},
				{
					id: "cx/gpt-5.3-codex-spark",
					capabilities: {
						reasoning: true,
						contextWindow: 400000,
						maxOutput: 400000,
					},
				},
				{
					id: "cx/gpt-5.5",
					capabilities: {
						reasoning: true,
						contextWindow: 272000,
						maxOutput: 128000,
					},
				},
				{
					id: "non-cx/gpt-5.6",
					capabilities: {
						reasoning: true,
						contextWindow: 872000,
						maxOutput: 128000,
					},
				},
			],
		});

		expect(models[0]?.contextWindow).toBe(272000);
		expect(models[0]?.maxTokens).toBe(128000);
		expect(models[1]?.contextWindow).toBe(272000);
		expect(models[1]?.maxTokens).toBe(272000);
		expect(models[2]?.contextWindow).toBe(272000);
		expect(models[2]?.maxTokens).toBe(128000);
		expect(models[3]?.contextWindow).toBe(872000);
		expect(models[3]?.maxTokens).toBe(128000);
	});
});

describe("ice startup model refresh", () => {
	it("does not fetch a catalog when a cached local catalog exists", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ice-provider-cached-"));
		tempDirs.push(agentDir);
		delete process.env.ICE_LOCAL_API_KEY;
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ omni: { type: "api_key", key: "cached-secret" } }));
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { omni: { models: [{}] } } }));
		const refresh = vi.fn(async () => ({ updated: true, count: 1 }));
		const onFailure = vi.fn();

		await expect(refreshLocalModelsForStartup(agentDir, { refresh, onFailure })).resolves.toBeUndefined();
		expect(refresh).not.toHaveBeenCalled();
		expect(process.env.ICE_LOCAL_API_KEY).toBe("cached-secret");
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("does not block or fetch when no cached local catalog exists", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ice-provider-cold-"));
		tempDirs.push(agentDir);
		const refresh = vi.fn(async () => ({ updated: true, count: 1 }));

		await expect(refreshLocalModelsForStartup(agentDir, { refresh, onFailure: vi.fn() })).resolves.toBeUndefined();
		expect(refresh).not.toHaveBeenCalled();
	});

	it("does not refresh in explicit offline mode but keeps cached auth usable", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ice-provider-offline-"));
		tempDirs.push(agentDir);
		delete process.env.ICE_LOCAL_API_KEY;
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ omni: { type: "api_key", key: "offline-secret" } }));
		const refresh = vi.fn(async () => ({ updated: true, count: 1 }));

		await refreshLocalModelsForStartup(agentDir, { skip: true, refresh, onFailure: vi.fn() });

		expect(refresh).not.toHaveBeenCalled();
		expect(process.env.ICE_LOCAL_API_KEY).toBe("offline-secret");
	});
});

describe("ice provider catalog refetch", () => {
	it("resolves base URL with default fallback, config, and environment overrides", () => {
		expect(DEFAULT_BASE_URL).toBe("http://127.0.0.1:20128/v1");
		expect(resolveBaseUrl()).toBe("http://127.0.0.1:20128/v1");

		expect(
			resolveBaseUrl({
				providers: { omni: { baseUrl: "http://127.0.0.1:20128/v1" } },
			}),
		).toBe("http://127.0.0.1:20128/v1");

		process.env.ICE_LOCAL_BASE_URL = "http://127.0.0.1:9999/v1";
		expect(resolveBaseUrl()).toBe("http://127.0.0.1:9999/v1");

		process.env.ICE_OMNI_BASE_URL = "http://127.0.0.1:8888/v1";
		expect(resolveBaseUrl()).toBe("http://127.0.0.1:8888/v1");
	});

	it("summarizes configured providers with model counts and base URLs", () => {
		expect(
			summarizeProviderCatalogs({
				getProviders: () => [
					{ id: "omni", name: "omni", baseUrl: "http://127.0.0.1:20128/v1" },
					{ id: "anthropic", name: "Anthropic" },
				],
				getModels: (providerId) => (providerId === "omni" ? [{}, {}] : [{}]),
			}),
		).toEqual([
			{ id: "omni", name: "omni", modelCount: 2, baseUrl: "http://127.0.0.1:20128/v1" },
			{ id: "anthropic", name: "Anthropic", modelCount: 1 },
		]);
	});

	it("writes the OmniRoute catalog then reloads models.json without a network runtime refresh", async () => {
		const refreshLocal = vi.fn(async () => ({ updated: true, count: 4 }));
		const refreshRuntime = vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() }));

		await expect(
			refetchProviderCatalog({
				providerId: "omni",
				agentDir: "/tmp/ice-agent",
				refreshLocal,
				refreshRuntime,
				countModels: () => 99,
			}),
		).resolves.toEqual({ ok: true, providerId: "omni", count: 4 });

		expect(refreshLocal).toHaveBeenCalledWith("/tmp/ice-agent");
		expect(refreshRuntime).toHaveBeenCalledWith({ providers: ["omni"], allowNetwork: false });
	});

	it("force-refreshes a non-local provider and never writes the local catalog", async () => {
		const refreshLocal = vi.fn(async () => ({ updated: true, count: 1 }));
		const refreshRuntime = vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() }));
		const signal = new AbortController().signal;

		await expect(
			refetchProviderCatalog({
				providerId: "anthropic",
				agentDir: "/tmp/ice-agent",
				refreshLocal,
				refreshRuntime,
				countModels: (providerId) => (providerId === "anthropic" ? 7 : 0),
				signal,
			}),
		).resolves.toEqual({ ok: true, providerId: "anthropic", count: 7 });

		expect(refreshLocal).not.toHaveBeenCalled();
		expect(refreshRuntime).toHaveBeenCalledWith({
			providers: ["anthropic"],
			allowNetwork: true,
			force: true,
			signal,
		});
	});

	it("does not reload the runtime when the local endpoint write fails", async () => {
		const refreshRuntime = vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() }));

		await expect(
			refetchProviderCatalog({
				providerId: "omni",
				agentDir: "/tmp/ice-agent",
				refreshLocal: async () => ({ updated: false, error: "model endpoint returned HTTP 503" }),
				refreshRuntime,
			}),
		).resolves.toEqual({
			ok: false,
			providerId: "omni",
			error: "model endpoint returned HTTP 503",
		});
		expect(refreshRuntime).not.toHaveBeenCalled();
	});

	it("returns a timeout error when the runtime refresh is aborted", async () => {
		await expect(
			refetchProviderCatalog({
				providerId: "anthropic",
				agentDir: "/tmp/ice-agent",
				refreshRuntime: async () => ({ aborted: true, errors: new Map<string, Error>() }),
			}),
		).resolves.toEqual({ ok: false, providerId: "anthropic", error: "timed out" });
	});
});

describe("ice compaction reserve", () => {
	it("uses advertised max output without consuming more than half the context", () => {
		expect(modelAwareReserveTokens(400000, 128000)).toBe(128000);
		expect(modelAwareReserveTokens(1000000, 512000)).toBe(500000);
	});
});
