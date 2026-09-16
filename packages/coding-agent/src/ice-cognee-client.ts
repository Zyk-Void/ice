export type CogneeErrorKind =
	| "auth_failed"
	| "server_error"
	| "unreachable"
	| "timeout"
	| "aborted"
	| "not_found"
	| "malformed"
	| "response_too_large";

export class CogneeError extends Error {
	readonly kind: CogneeErrorKind;
	readonly status: number | undefined;

	constructor(kind: CogneeErrorKind, message: string, status?: number) {
		super(message);
		this.name = "CogneeError";
		this.kind = kind;
		this.status = status;
	}
}

export interface CogneeClientConfig {
	baseUrl: string;
	dataset: string;
	apiKey?: string;
	recallBudgetMs: number;
	maxResponseChars: number;
}

export interface RecallResult {
	text: string;
	score?: number;
	metadata?: Record<string, unknown>;
}

export interface RememberRequest {
	text: string;
	nodeSet: string;
	dataset?: string;
	sessionId?: string;
}

export interface RememberEntryRequest {
	entry: Record<string, unknown>;
	dataset?: string;
	sessionId: string;
}

export interface ImproveRequest {
	dataset?: string;
	sessionIds?: string[];
}

export interface CogneeClientDependencies {
	fetch?: typeof fetch;
}

export interface CogneeClient {
	recall(
		query: string,
		options?: {
			topK?: number;
			sessionId?: string;
			scope?: string[];
			signal?: AbortSignal;
			timeoutMs?: number;
		},
	): Promise<RecallResult[]>;
	remember(request: RememberRequest, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
	/** Claude/OpenClaw-style session cache write: QA or Trace entry. */
	rememberEntry(
		request: RememberEntryRequest,
		options?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<{ entryId?: string }>;
	/** Bridge session cache into the permanent graph (Claude SessionEnd /improve). */
	improve(request?: ImproveRequest, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
	registerAgent(
		request: { agentSessionName: string; sessionId?: string; datasetNames?: string[] },
		options?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<void>;
	unregisterAgent(
		request: { agentSessionName: string },
		options?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<void>;
}

interface RequestSignal {
	signal: AbortSignal;
	timedOut: () => boolean;
	throwIfAborted: () => void;
	cleanup: () => void;
}

function createRequestSignal(timeoutMs: number, parentSignal?: AbortSignal): RequestSignal {
	const controller = new AbortController();
	const budgetMs = Math.max(1, timeoutMs);
	const deadline = Date.now() + budgetMs;
	let didTimeout = false;
	const onTimeout = () => {
		if (controller.signal.aborted) return;
		didTimeout = true;
		controller.abort();
	};
	const timeout = setTimeout(onTimeout, budgetMs);
	const onAbort = () => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) onAbort();
	else parentSignal?.addEventListener("abort", onAbort, { once: true });

	return {
		signal: controller.signal,
		timedOut: () => {
			if (Date.now() >= deadline) onTimeout();
			return didTimeout;
		},
		throwIfAborted: () => {
			if (Date.now() >= deadline) onTimeout();
			controller.signal.throwIfAborted();
		},
		cleanup: () => {
			clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", onAbort);
		},
	};
}

async function withRequestSignal<T>(operation: () => Promise<T>, requestSignal: RequestSignal): Promise<T> {
	requestSignal.throwIfAborted();
	const { signal } = requestSignal;
	let onAbort = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([
			Promise.resolve().then(() => {
				requestSignal.throwIfAborted();
				return operation();
			}),
			aborted,
		]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function cancelBody(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null): void {
	try {
		// Cancellation can stall or reject; neither may delay or replace the request result.
		void body?.cancel().catch(() => {});
	} catch {
		// A closed or already locked stream may also reject cancellation synchronously.
	}
}

function buildUrl(baseUrl: string, path: string): string {
	const url = new URL(baseUrl);
	url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
	url.search = "";
	url.hash = "";
	return url.toString();
}

function headers(apiKey: string | undefined, contentType?: string): Headers {
	const result = new Headers({ accept: "application/json" });
	if (contentType) result.set("content-type", contentType);
	if (apiKey) result.set("x-api-key", apiKey);
	return result;
}

function classifyStatus(status: number): CogneeErrorKind {
	if (status === 401 || status === 403) return "auth_failed";
	if (status === 404) return "not_found";
	if (status >= 500 || status === 408 || status === 429) return "server_error";
	return "malformed";
}

const MAX_RECALL_RESPONSE_BYTES = 128 * 1024;

function responseLimit(response: Response, maxBytes: number): number | undefined {
	const header = response.headers.get("content-length");
	if (header === null) return undefined;
	const contentLength = Number(header);
	if (!/^\d+$/.test(header) || !Number.isSafeInteger(contentLength)) {
		throw new CogneeError("malformed", "Cognee returned an invalid Content-Length");
	}
	if (contentLength > maxBytes) {
		throw new CogneeError("response_too_large", "Cognee response exceeded the configured limit");
	}
	return contentLength;
}

async function readJson(response: Response, transportMaxBytes: number, requestSignal: RequestSignal): Promise<unknown> {
	const contentLength = responseLimit(response, transportMaxBytes);
	const reader = response.body?.getReader();
	const decoder = new TextDecoder();
	let complete = false;
	let bytes = 0;
	let text = "";
	try {
		if (reader) {
			while (true) {
				const { done, value } = await withRequestSignal(() => reader.read(), requestSignal);
				if (done) {
					complete = true;
					break;
				}
				bytes += value.byteLength;
				if (bytes > transportMaxBytes) {
					throw new CogneeError("response_too_large", "Cognee response exceeded the configured limit");
				}
				text += decoder.decode(value, { stream: true });
			}
		}
		const encoding = response.headers.get("content-encoding");
		// Fetch decodes compressed bodies, but Content-Length describes the encoded bytes.
		if (contentLength !== undefined && (!encoding || encoding === "identity") && bytes !== contentLength) {
			throw new CogneeError("malformed", "Cognee response did not match Content-Length");
		}
		text += decoder.decode();
		requestSignal.throwIfAborted();
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new CogneeError("malformed", "Cognee returned malformed JSON");
		}
	} finally {
		if (reader) {
			if (!complete) cancelBody(reader);
			reader.releaseLock();
		}
	}
}

function normalizeRecall(payload: unknown): RecallResult[] {
	const values = Array.isArray(payload)
		? payload
		: payload !== null && typeof payload === "object"
			? ((payload as { results?: unknown; data?: unknown }).results ?? (payload as { data?: unknown }).data)
			: undefined;
	if (!Array.isArray(values)) throw new CogneeError("malformed", "Cognee recall returned an unexpected shape");

	return values.flatMap((value): RecallResult[] => {
		if (typeof value === "string") return [{ text: value }];
		if (value === null || typeof value !== "object") return [];
		const item = value as { text?: unknown; score?: unknown; metadata?: unknown; content?: unknown };
		const text =
			typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : undefined;
		if (!text) return [];
		return [
			{
				text,
				...(typeof item.score === "number" ? { score: item.score } : {}),
				...(item.metadata !== null && typeof item.metadata === "object"
					? { metadata: item.metadata as Record<string, unknown> }
					: {}),
			},
		];
	});
}

async function request<T>(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	config: CogneeClientConfig,
	parentSignal: AbortSignal | undefined,
	timeoutMs: number | undefined,
	handleResponse: (response: Response, signal: RequestSignal) => Promise<T>,
): Promise<T> {
	const requestSignal = createRequestSignal(timeoutMs ?? config.recallBudgetMs, parentSignal);
	let response: Response | undefined;
	try {
		requestSignal.throwIfAborted();
		response = await withRequestSignal(async () => {
			const result = await fetchImpl(url, { ...init, signal: requestSignal.signal });
			// A fetch implementation may ignore abort and deliver headers after the deadline.
			if (requestSignal.signal.aborted) cancelBody(result.body);
			return result;
		}, requestSignal);
		requestSignal.throwIfAborted();
		const result = await handleResponse(response, requestSignal);
		requestSignal.throwIfAborted();
		return result;
	} catch (error) {
		if (requestSignal.timedOut()) throw new CogneeError("timeout", "Cognee request timed out");
		if (requestSignal.signal.aborted) throw new CogneeError("aborted", "Cognee request was aborted");
		if (error instanceof CogneeError) throw error;
		throw new CogneeError("unreachable", "Cognee service is unreachable");
	} finally {
		requestSignal.cleanup();
		if (response && !response.bodyUsed) cancelBody(response.body);
	}
}

async function assertOk(response: Response, action: string): Promise<void> {
	if (response.ok) return;
	const kind = classifyStatus(response.status);
	throw new CogneeError(kind, `Cognee ${action} failed with HTTP ${response.status}`, response.status);
}

export function createCogneeClient(
	config: CogneeClientConfig,
	dependencies: CogneeClientDependencies = {},
): CogneeClient {
	const fetchImpl = dependencies.fetch ?? fetch;

	return {
		async recall(query, options = {}) {
			const scope = options.scope && options.scope.length > 0 ? options.scope : ["session", "trace", "graph"];
			const payload = await request(
				fetchImpl,
				buildUrl(config.baseUrl, "/api/v1/recall"),
				{
					method: "POST",
					headers: headers(config.apiKey, "application/json"),
					body: JSON.stringify({
						query,
						topK: options.topK ?? 5,
						onlyContext: true,
						scope,
						...(options.sessionId ? { sessionId: options.sessionId } : {}),
						datasets: [config.dataset],
					}),
				},
				config,
				options.signal,
				options.timeoutMs,
				async (response, signal) => {
					await assertOk(response, "recall");
					return readJson(response, MAX_RECALL_RESPONSE_BYTES, signal);
				},
			);
			const results = normalizeRecall(payload).slice(0, options.topK ?? 5);
			let remaining = config.maxResponseChars;
			return results.flatMap((result) => {
				if (remaining <= 0) return [];
				const text = result.text.slice(0, remaining);
				remaining -= text.length;
				return text ? [{ ...result, text }] : [];
			});
		},

		async remember(input, options = {}) {
			const form = new FormData();
			form.set("datasetName", input.dataset ?? config.dataset);
			form.set("node_set", input.nodeSet);
			form.set("run_in_background", "true");
			if (input.sessionId) form.set("session_id", input.sessionId);
			form.set("data", new Blob([input.text], { type: "text/plain" }), "ice-cognee.txt");
			await request(
				fetchImpl,
				buildUrl(config.baseUrl, "/api/v1/remember"),
				{ method: "POST", headers: headers(config.apiKey), body: form },
				config,
				options.signal,
				options.timeoutMs ?? Math.max(config.recallBudgetMs, 30_000),
				(response) => assertOk(response, "remember"),
			);
		},

		async rememberEntry(input, options = {}) {
			return request(
				fetchImpl,
				buildUrl(config.baseUrl, "/api/v1/remember/entry"),
				{
					method: "POST",
					headers: headers(config.apiKey, "application/json"),
					body: JSON.stringify({
						entry: input.entry,
						dataset_name: input.dataset ?? config.dataset,
						session_id: input.sessionId,
					}),
				},
				config,
				options.signal,
				options.timeoutMs ?? 30_000,
				async (response, signal) => {
					await assertOk(response, "remember/entry");
					try {
						const payload = (await readJson(response, config.maxResponseChars, signal)) as {
							entry_id?: unknown;
						} | null;
						return typeof payload?.entry_id === "string" ? { entryId: payload.entry_id } : {};
					} catch (error) {
						if (
							error instanceof CogneeError &&
							(error.kind === "malformed" || error.kind === "response_too_large")
						) {
							return {};
						}
						throw error;
					}
				},
			);
		},

		async improve(input = {}, options = {}) {
			await request(
				fetchImpl,
				buildUrl(config.baseUrl, "/api/v1/improve"),
				{
					method: "POST",
					headers: headers(config.apiKey, "application/json"),
					body: JSON.stringify({
						// ImprovePayloadDTO (Cognee 1.4): camelCase
						datasetName: input.dataset ?? config.dataset,
						...(input.sessionIds && input.sessionIds.length > 0 ? { sessionIds: input.sessionIds } : {}),
						runInBackground: true,
					}),
				},
				config,
				options.signal,
				options.timeoutMs ?? 120_000,
				(response) => assertOk(response, "improve"),
			);
		},

		async registerAgent(input, options = {}) {
			const body: Record<string, unknown> = {
				agent_session_name: input.agentSessionName,
				type: "api",
				memory_mode: "hybrid",
				source: "api",
			};
			if (input.sessionId) body.session_id = input.sessionId;
			if (input.datasetNames && input.datasetNames.length > 0) body.dataset_names = input.datasetNames;
			await request(
				fetchImpl,
				buildUrl(config.baseUrl, "/api/v1/agents/register"),
				{
					method: "POST",
					headers: headers(config.apiKey, "application/json"),
					body: JSON.stringify(body),
				},
				config,
				options.signal,
				options.timeoutMs ?? 15_000,
				async (response) => {
					if (response.status === 404) return;
					await assertOk(response, "agents/register");
				},
			);
		},

		async unregisterAgent(input, options = {}) {
			await request(
				fetchImpl,
				buildUrl(config.baseUrl, "/api/v1/agents/unregister"),
				{
					method: "POST",
					headers: headers(config.apiKey, "application/json"),
					body: JSON.stringify({ agent_session_name: input.agentSessionName }),
				},
				config,
				options.signal,
				options.timeoutMs ?? 15_000,
				async (response) => {
					if (response.status === 404) return;
					await assertOk(response, "agents/unregister");
				},
			);
		},
	};
}
