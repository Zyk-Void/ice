import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import { stream as streamOpenAIResponses } from "../../../packages/ai/src/api/openai-responses.ts";
import type { Context, Model } from "../../../packages/ai/src/types.ts";
import {
	buildSubagentPrompt,
	deriveSubagentPromptCacheKey,
	normalizeSubagentRequest,
	type SubagentForkContextSource,
} from "../../../packages/coding-agent/src/ice-subagents.ts";

const BENCHMARK_NAME = "subagent-prompt-cache";
const RETENTION = "short" as const;
const STRUCTURAL_OUTPUT = ".artifacts/subagent-prompt-cache/structural.json";

type BenchmarkRequest = ReturnType<typeof normalizeSubagentRequest>;

type CapturedRequestPrefix = {
	instructions: unknown;
	input: unknown;
	tools: unknown;
	promptCacheKey: unknown;
};

type ChildMeasurement = {
	sessionId: string;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	requestPrefix: CapturedRequestPrefix;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requiredEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required when the prompt-cache benchmark is enabled`);
	return value;
}

function commonPrefixBytes(left: string, right: string): number {
	const leftBytes = Buffer.from(left, "utf8");
	const rightBytes = Buffer.from(right, "utf8");
	let index = 0;
	while (index < leftBytes.length && index < rightBytes.length && leftBytes[index] === rightBytes[index]) index += 1;
	return index;
}

function serializeRequestPrefix(prefix: CapturedRequestPrefix): string {
	return JSON.stringify(prefix);
}

function createBenchmarkModel(baseUrl: string, modelId: string): Model<"openai-responses"> {
	return {
		id: modelId,
		name: modelId,
		api: "openai-responses",
		provider: "approved-local",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 256,
	};
}

function createForkSource(): SubagentForkContextSource {
	return {
		getSessionId: () => "benchmark-parent",
		getLeafId: () => "benchmark-leaf",
		buildSessionContext: () => ({
			messages: [
				{ role: "user", content: "Shared parent inspection context.", timestamp: 1 },
				{ role: "user", content: "Shared parent follow-up context.", timestamp: 2 },
			],
		}),
	};
}

function benchmarkTools(): NonNullable<Context["tools"]> {
	return [
		{
			name: "read",
			description: "Read one file inside the approved benchmark scope.",
			parameters: Type.Object({ path: Type.String() }),
		},
	];
}

function productionChildContext(request: BenchmarkRequest): Context {
	return {
		systemPrompt: request.profile.systemPrompt,
		messages: [{ role: "user", content: buildSubagentPrompt(request), timestamp: 0 }],
		tools: benchmarkTools(),
	};
}

function capturePrefix(payload: unknown): CapturedRequestPrefix {
	if (!isRecord(payload)) throw new Error("OpenAI Responses request payload was not an object");
	return {
		instructions: payload.instructions ?? null,
		input: payload.input ?? null,
		tools: payload.tools ?? null,
		promptCacheKey: payload.prompt_cache_key ?? null,
	};
}

async function captureStructuralRequest(
	model: Model<"openai-responses">,
	request: BenchmarkRequest,
	sessionId: string,
	promptCacheKey: string,
): Promise<CapturedRequestPrefix> {
	let captured: CapturedRequestPrefix | undefined;
	const stream = streamOpenAIResponses(model, productionChildContext(request), {
		apiKey: "structural-no-network",
		sessionId,
		promptCacheKey,
		cacheRetention: RETENTION,
		maxTokens: 16,
		onPayload: (payload) => {
			captured = capturePrefix(payload);
		},
		fetch: async () =>
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
	});
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!captured) throw new Error("OpenAI Responses structural request payload was not captured");
	return captured;
}

async function runLiveChild(
	model: Model<"openai-responses">,
	apiKey: string,
	sessionId: string,
	promptCacheKey: string,
	request: BenchmarkRequest,
): Promise<ChildMeasurement> {
	let capturedPrefix: CapturedRequestPrefix | undefined;
	const result = await streamOpenAIResponses(model, productionChildContext(request), {
		apiKey,
		sessionId,
		promptCacheKey,
		cacheRetention: RETENTION,
		maxTokens: 16,
		timeoutMs: 120_000,
		onPayload: (payload) => {
			capturedPrefix = capturePrefix(payload);
		},
	}).result();
	if (!capturedPrefix) throw new Error("Provider request payload was not captured");
	return {
		sessionId,
		cacheReadTokens: result.usage.cacheRead,
		cacheWriteTokens: result.usage.cacheWrite,
		requestPrefix: capturedPrefix,
	};
}

async function createRequests(cwd: string): Promise<{
	firstRequest: BenchmarkRequest;
	secondRequest: BenchmarkRequest;
}> {
	await mkdir(join(cwd, "src"), { recursive: true });
	const baseRequest = normalizeSubagentRequest(
		{
			parentSessionId: "benchmark-parent",
			role: "self",
			task: "Benchmark sibling one.",
			scope: { roots: ["src"] },
			cwd,
			contextMode: "fork",
			self: { instructions: "Inspect the approved scope and report observed evidence.", capabilities: ["read"] },
		},
		cwd,
		{ agentDir: join(cwd, ".ice-agent"), parentContext: createForkSource() },
	);
	return {
		firstRequest: { ...baseRequest, task: "Benchmark sibling one." },
		secondRequest: { ...baseRequest, task: "Benchmark sibling two." },
	};
}

async function writeStructuralEvidence(
	model: Model<"openai-responses">,
	firstRequest: BenchmarkRequest,
	secondRequest: BenchmarkRequest,
	promptCacheKey: string,
): Promise<Record<string, unknown>> {
	const beforeFirst = await captureStructuralRequest(model, firstRequest, "benchmark-child-1", "benchmark-child-1");
	const beforeSecond = await captureStructuralRequest(model, secondRequest, "benchmark-child-2", "benchmark-child-2");
	const afterFirst = await captureStructuralRequest(model, firstRequest, "benchmark-child-1", promptCacheKey);
	const afterSecond = await captureStructuralRequest(model, secondRequest, "benchmark-child-2", promptCacheKey);
	const beforePrefixBytes = commonPrefixBytes(serializeRequestPrefix(beforeFirst), serializeRequestPrefix(beforeSecond));
	const afterPrefixBytes = commonPrefixBytes(serializeRequestPrefix(afterFirst), serializeRequestPrefix(afterSecond));
	if (beforeFirst.promptCacheKey === beforeSecond.promptCacheKey) throw new Error("Baseline cache keys unexpectedly matched");
	if (afterFirst.promptCacheKey !== promptCacheKey || afterSecond.promptCacheKey !== promptCacheKey) {
		throw new Error("Shared prompt cache key was not serialized for both siblings");
	}
	const firstPrompt = buildSubagentPrompt(firstRequest);
	const secondPrompt = buildSubagentPrompt(secondRequest);
	const taskMarker = "\n\nTask:\n\n";
	const taskOffset = firstPrompt.indexOf(taskMarker);
	if (taskOffset <= 0 || secondPrompt.indexOf(taskMarker) !== taskOffset) throw new Error("Sibling task boundary is unstable");
	if (firstPrompt.slice(0, taskOffset) !== secondPrompt.slice(0, taskOffset)) {
		throw new Error("Sibling shared prompt prefix is not byte-identical");
	}
	const report = {
		schemaVersion: 2,
		benchmark: BENCHMARK_NAME,
		status: "structural",
		cacheRetention: RETENTION,
		requestLayout: "native-child-equivalent",
		sessionsDistinct: true,
		promptCacheKey: { stableBefore: false, stableAfter: true },
		prefix: {
			commonPromptBytes: commonPrefixBytes(firstPrompt, secondPrompt),
			taskBoundaryBytes: Buffer.byteLength(firstPrompt.slice(0, taskOffset), "utf8"),
			commonRequestPrefixBytesBefore: beforePrefixBytes,
			commonRequestPrefixBytesAfter: afterPrefixBytes,
		},
	};
	const outputPath = resolve(process.env.ICE_PROMPT_CACHE_BENCHMARK_STRUCTURAL_OUTPUT ?? STRUCTURAL_OUTPUT);
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	return { ...report, outputPath };
}

async function runBenchmark(): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "ice-prompt-cache-benchmark-"));
	try {
		const { firstRequest, secondRequest } = await createRequests(cwd);
		const structuralModel = createBenchmarkModel("http://127.0.0.1:1/v1", "structural-model");
		const structuralKey = deriveSubagentPromptCacheKey(firstRequest, structuralModel, ["read"]);
		if (!structuralKey) throw new Error("Expected a derived fork prompt-cache key");
		const structural = await writeStructuralEvidence(structuralModel, firstRequest, secondRequest, structuralKey);

		if (process.env.ICE_PROMPT_CACHE_BENCHMARK !== "1") {
			console.log(JSON.stringify({ ...structural, liveStatus: "skipped", reason: "set ICE_PROMPT_CACHE_BENCHMARK=1" }));
			return;
		}
		if (process.env.ICE_PROMPT_CACHE_BENCHMARK_APPROVED !== "1") {
			console.log(JSON.stringify({ ...structural, liveStatus: "skipped", reason: "approval flag is required" }));
			return;
		}

		const apiKey = requiredEnvironment("ICE_PROMPT_CACHE_BENCHMARK_API_KEY");
		const baseUrl = requiredEnvironment("ICE_PROMPT_CACHE_BENCHMARK_BASE_URL");
		const modelId = requiredEnvironment("ICE_PROMPT_CACHE_BENCHMARK_MODEL");
		const model = createBenchmarkModel(baseUrl, modelId);
		const promptCacheKey = deriveSubagentPromptCacheKey(firstRequest, model, ["read"]);
		if (!promptCacheKey) throw new Error("Expected a derived live fork prompt-cache key");
		const first = await runLiveChild(model, apiKey, "benchmark-child-1", promptCacheKey, firstRequest);
		const second = await runLiveChild(model, apiKey, "benchmark-child-2", promptCacheKey, secondRequest);
		const outputPath = resolve(process.env.ICE_PROMPT_CACHE_BENCHMARK_OUTPUT ?? ".artifacts/subagent-prompt-cache/latest.json");
		const report = {
			schemaVersion: 2,
			benchmark: BENCHMARK_NAME,
			status: "completed",
			provider: model.provider,
			model: model.id,
			cacheRetention: RETENTION,
			requestLayout: "native-child-equivalent",
			promptCacheKey: { stableAcrossSiblings: true },
			sessions: [
				{ id: first.sessionId, cacheReadTokens: first.cacheReadTokens, cacheWriteTokens: first.cacheWriteTokens },
				{ id: second.sessionId, cacheReadTokens: second.cacheReadTokens, cacheWriteTokens: second.cacheWriteTokens },
			],
			structural,
		};
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		console.log(JSON.stringify({ ...report, outputPath }));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

runBenchmark().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
