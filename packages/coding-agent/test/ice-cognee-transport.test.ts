import type { ReadableStreamReadResult } from "node:stream/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CogneeClientConfig, CogneeError, createCogneeClient } from "../src/ice-cognee-client.ts";

const BYTE_LIMIT = 128 * 1024;
const encoder = new TextEncoder();

function clientWith(fetchImpl: typeof fetch, overrides: Partial<CogneeClientConfig> = {}) {
	return createCogneeClient(
		{
			baseUrl: "http://cognee.invalid/",
			dataset: "transport-test",
			recallBudgetMs: 50,
			maxResponseChars: 100,
			...overrides,
		},
		{ fetch: fetchImpl },
	);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function streamResponse(init: ResponseInit = {}, cancelImpl: () => Promise<void> = async () => {}) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const cancel = vi.fn(cancelImpl);
	const body = new ReadableStream<Uint8Array>(
		{
			start(value) {
				controller = value;
			},
			cancel,
		},
		{ highWaterMark: 0 },
	);
	return { response: new Response(body, init), body, controller, cancel };
}

describe("ice-cognee bounded transport", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new Error("Unexpected real fetch"))),
		);
	});

	afterEach(() => {
		const pendingTimers = vi.getTimerCount();
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		expect(pendingTimers).toBe(0);
	});

	it("uses one deadline across delayed headers and delayed body", async () => {
		let bodyTimer: ReturnType<typeof setTimeout>;
		const stream = streamResponse({}, async () => clearTimeout(bodyTimer));
		const headers = deferred<Response>();
		const fetchImpl = vi.fn(() => headers.promise);
		setTimeout(() => {
			headers.resolve(stream.response);
			bodyTimer = setTimeout(() => {
				stream.controller.enqueue(encoder.encode('["late"]'));
				stream.controller.close();
			}, 30);
		}, 30);
		const settled = vi.fn();
		const result = clientWith(fetchImpl)
			.recall("query")
			.catch((error: unknown) => {
				settled();
				return error;
			});
		await vi.advanceTimersByTimeAsync(49);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(await result).toMatchObject({ kind: "timeout" });
		expect(stream.cancel).toHaveBeenCalledOnce();
		expect(stream.body.locked).toBe(false);
	});

	it("times out a stalled stream without waiting for stalled cancellation", async () => {
		const stream = streamResponse({}, () => new Promise<void>(() => {}));
		let signal: AbortSignal | null | undefined;
		const client = clientWith(async (_input, init) => {
			signal = init?.signal;
			return stream.response;
		});
		const result = client.recall("query").catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(50);
		expect(await result).toMatchObject({ kind: "timeout" });
		expect(signal?.aborted).toBe(true);
		expect(stream.cancel).toHaveBeenCalledOnce();
		expect(stream.body.locked).toBe(false);
	});

	it("rejects unknown-length excess bytes before reading the rest of the stream", async () => {
		const stream = streamResponse();
		stream.controller.enqueue(new Uint8Array(BYTE_LIMIT));
		stream.controller.enqueue(new Uint8Array(1));
		await expect(clientWith(async () => stream.response).recall("query")).rejects.toMatchObject({
			kind: "response_too_large",
		});
		expect(stream.cancel).toHaveBeenCalledOnce();
		expect(stream.body.locked).toBe(false);
	});

	it("counts UTF-8 transport bytes rather than decoded characters", async () => {
		const payload = JSON.stringify(["é".repeat(BYTE_LIMIT / 2)]);
		expect(payload.length).toBeLessThan(BYTE_LIMIT);
		await expect(clientWith(async () => new Response(payload)).recall("query")).rejects.toMatchObject({
			kind: "response_too_large",
		});
	});

	it("accepts exactly 128 KiB before applying the separate output character cap", async () => {
		const payload = `["${"x".repeat(BYTE_LIMIT - 4)}"]`;
		await expect(clientWith(async () => new Response(payload)).recall("query")).resolves.toEqual([
			{ text: "x".repeat(100) },
		]);
	});

	it("rejects a declared over-limit body without acquiring a reader", async () => {
		const stream = streamResponse({ headers: { "content-length": String(BYTE_LIMIT + 1) } });
		const getReader = vi.spyOn(stream.body, "getReader");
		await expect(clientWith(async () => stream.response).recall("query")).rejects.toMatchObject({
			kind: "response_too_large",
		});
		expect(getReader).not.toHaveBeenCalled();
		expect(stream.cancel).toHaveBeenCalledOnce();
	});

	it.each(["", "-1", "+2", "2.0", "2e0", "0x2", "NaN", "Infinity", "2junk", "2, 2", "9007199254740992"])(
		"rejects invalid Content-Length %j as malformed",
		async (length) => {
			const stream = streamResponse({ headers: { "content-length": length } });
			await expect(clientWith(async () => stream.response).recall("query")).rejects.toMatchObject({
				kind: "malformed",
			});
			expect(stream.cancel).toHaveBeenCalledOnce();
		},
	);

	it.each(["1", "3"])("rejects a Content-Length mismatch of %s", async (length) => {
		await expect(
			clientWith(async () => new Response("[]", { headers: { "content-length": length } })).recall("query"),
		).rejects.toMatchObject({ kind: "malformed" });
	});

	it("does not compare decoded bytes to an encoded Content-Length", async () => {
		await expect(
			clientWith(
				async () =>
					new Response('["decoded"]', {
						headers: { "content-length": "5", "content-encoding": "gzip" },
					}),
			).recall("query"),
		).resolves.toEqual([{ text: "decoded" }]);
	});

	it("still bounds decoded bytes when Content-Length describes a compressed body", async () => {
		await expect(
			clientWith(
				async () =>
					new Response(`"${"x".repeat(BYTE_LIMIT)}"`, {
						headers: { "content-length": "5", "content-encoding": "gzip" },
					}),
			).recall("query"),
		).rejects.toMatchObject({ kind: "response_too_large" });
	});

	it("honors a pre-aborted parent before calling fetch", async () => {
		const parent = new AbortController();
		parent.abort(new Error("Already cancelled"));
		const fetchImpl = vi.fn(async () => new Response("[]"));
		await expect(clientWith(fetchImpl).recall("query", { signal: parent.signal })).rejects.toMatchObject({
			kind: "aborted",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("cancels mid-body, removes the parent listener, and retains aborted classification", async () => {
		const parent = new AbortController();
		const addListener = vi.spyOn(parent.signal, "addEventListener");
		const removeListener = vi.spyOn(parent.signal, "removeEventListener");
		const stream = streamResponse();
		stream.controller.enqueue(encoder.encode('["partial'));
		const result = clientWith(async () => stream.response)
			.recall("query", { signal: parent.signal })
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(10);
		parent.abort(new CogneeError("malformed", "Parent cancellation reason"));
		await vi.advanceTimersByTimeAsync(100);
		expect(await result).toMatchObject({ kind: "aborted" });
		expect(stream.cancel).toHaveBeenCalledOnce();
		expect(stream.body.locked).toBe(false);
		expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0][1]);
	});

	it("normalizes successful chunked UTF-8 JSON, preserves request binding, and releases its reader", async () => {
		const stream = streamResponse();
		const payload = encoder.encode(
			JSON.stringify({ results: [{ text: "café", score: 0.8, metadata: { source: "test" } }] }),
		);
		const split = payload.indexOf(0xc3) + 1;
		stream.response.headers.set("content-length", String(payload.byteLength));
		stream.controller.enqueue(payload.slice(0, split));
		stream.controller.enqueue(payload.slice(split));
		stream.controller.close();
		const parent = new AbortController();
		const removeListener = vi.spyOn(parent.signal, "removeEventListener");
		const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => stream.response);
		await expect(clientWith(fetchImpl).recall("query", { topK: 1, signal: parent.signal })).resolves.toEqual([
			{ text: "café", score: 0.8, metadata: { source: "test" } },
		]);
		expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
			datasets: ["transport-test"],
			topK: 1,
		});
		expect(stream.body.locked).toBe(false);
		expect(stream.cancel).not.toHaveBeenCalled();
		expect(removeListener).toHaveBeenCalledOnce();
	});

	it.each(["{broken", "", '{"unexpected":true}'])("classifies malformed recall payload %j", async (payload) => {
		await expect(clientWith(async () => new Response(payload)).recall("query")).rejects.toMatchObject({
			kind: "malformed",
		});
	});

	it.each([
		[401, "auth_failed"],
		[403, "auth_failed"],
		[404, "not_found"],
		[408, "server_error"],
		[429, "server_error"],
		[500, "server_error"],
		[400, "malformed"],
	])("preserves HTTP %i classification %s without consuming its body", async (status, kind) => {
		const stream = streamResponse({ status: Number(status), headers: { "content-length": "invalid" } });
		const getReader = vi.spyOn(stream.body, "getReader");
		await expect(clientWith(async () => stream.response).recall("query")).rejects.toMatchObject({ kind, status });
		expect(getReader).not.toHaveBeenCalled();
		expect(stream.cancel).toHaveBeenCalledOnce();
	});

	it("classifies fetch rejection as unreachable", async () => {
		await expect(
			clientWith(async () => {
				throw new TypeError("Offline");
			}).recall("query"),
		).rejects.toMatchObject({
			kind: "unreachable",
		});
	});

	it("classifies a mid-body transport failure as unreachable", async () => {
		const stream = streamResponse();
		const result = clientWith(async () => stream.response)
			.recall("query")
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(0);
		stream.controller.error(new Error("Connection reset"));
		expect(await result).toMatchObject({ kind: "unreachable" });
		expect(stream.body.locked).toBe(false);
	});

	it("observes a late fetch rejection after a header timeout", async () => {
		const headers = deferred<Response>();
		const result = clientWith(() => headers.promise)
			.recall("query")
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(50);
		expect(await result).toMatchObject({ kind: "timeout" });
		headers.reject(new Error("Late fetch rejection"));
		await vi.advanceTimersByTimeAsync(0);
	});

	it("cancels a late response and observes a late cleanup rejection", async () => {
		const headers = deferred<Response>();
		const cleanup = deferred<void>();
		const stream = streamResponse({}, () => cleanup.promise);
		const result = clientWith(() => headers.promise)
			.recall("query")
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(50);
		expect(await result).toMatchObject({ kind: "timeout" });
		headers.resolve(stream.response);
		await vi.advanceTimersByTimeAsync(0);
		expect(stream.cancel).toHaveBeenCalledOnce();
		cleanup.reject(new Error("Late cancellation rejection"));
		await vi.advanceTimersByTimeAsync(0);
	});

	it("observes late read rejection and synchronous cancellation failure without masking timeout", async () => {
		const read = deferred<ReadableStreamReadResult<Uint8Array>>();
		const stream = streamResponse();
		const reader = stream.body.getReader();
		vi.spyOn(stream.body, "getReader").mockReturnValue(reader);
		vi.spyOn(reader, "read").mockImplementation(() => read.promise);
		vi.spyOn(reader, "cancel").mockImplementation(() => {
			throw new Error("Cancel failed");
		});
		const result = clientWith(async () => stream.response)
			.recall("query")
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(50);
		expect(await result).toMatchObject({ kind: "timeout" });
		expect(stream.body.locked).toBe(false);
		read.reject(new Error("Late read rejection"));
		await vi.advanceTimersByTimeAsync(0);
	});

	it("checks elapsed budget when queued reads prevent the timer callback from running", async () => {
		const stream = streamResponse();
		const reader = stream.body.getReader();
		vi.spyOn(stream.body, "getReader").mockReturnValue(reader);
		vi.spyOn(reader, "read").mockImplementation(async () => {
			vi.setSystemTime(Date.now() + 60);
			return { done: false, value: encoder.encode(" ") };
		});
		await expect(clientWith(async () => stream.response).recall("query")).rejects.toMatchObject({ kind: "timeout" });
		expect(reader.read).toHaveBeenCalledOnce();
		expect(stream.body.locked).toBe(false);
	});

	it("rejects JSON decoding that finishes after its deadline", async () => {
		const parse = JSON.parse;
		vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
			vi.setSystemTime(Date.now() + 60);
			return parse(text);
		});
		await expect(clientWith(async () => new Response("[]")).recall("query")).rejects.toMatchObject({
			kind: "timeout",
		});
	});

	it.each(["timeout", "aborted"])("does not swallow rememberEntry %s during body decoding", async (kind) => {
		const stream = streamResponse();
		const parent = new AbortController();
		const result = clientWith(async () => stream.response)
			.rememberEntry({ entry: {}, sessionId: "test" }, { signal: parent.signal, timeoutMs: 20 })
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(0);
		if (kind === "aborted") parent.abort();
		await vi.advanceTimersByTimeAsync(20);
		expect(await result).toMatchObject({ kind });
		expect(stream.cancel).toHaveBeenCalledOnce();
	});

	it.each(["", "{broken", "null"])("retains rememberEntry optional acknowledgement handling for %j", async (body) => {
		await expect(
			clientWith(async () => new Response(body)).rememberEntry({ entry: {}, sessionId: "test" }),
		).resolves.toEqual({});
	});

	it("decodes a normal rememberEntry acknowledgement", async () => {
		await expect(
			clientWith(async () => new Response('{"entry_id":"e1"}')).rememberEntry({
				entry: {},
				sessionId: "test",
			}),
		).resolves.toEqual({ entryId: "e1" });
	});

	it("cancels unread write acknowledgements and preserves optional agent 404 handling", async () => {
		const streams = [202, 202, 404, 404].map((status) =>
			streamResponse({ status }, () => new Promise<void>(() => {})),
		);
		let next = 0;
		const client = clientWith(async () => streams[next++].response);
		await expect(client.remember({ text: "test", nodeSet: "test" })).resolves.toBeUndefined();
		await expect(client.improve()).resolves.toBeUndefined();
		await expect(client.registerAgent({ agentSessionName: "test" })).resolves.toBeUndefined();
		await expect(client.unregisterAgent({ agentSessionName: "test" })).resolves.toBeUndefined();
		for (const stream of streams) expect(stream.cancel).toHaveBeenCalledOnce();
	});
});
