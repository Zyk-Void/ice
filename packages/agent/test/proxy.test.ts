import { fauxAssistantMessage, getModel } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.ts";

const options = { authToken: "test", proxyUrl: "https://proxy.invalid" };
const model = getModel("openai", "gpt-4o-mini");
const usage = fauxAssistantMessage("").usage;

describe("proxy SSE termination", () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each(["", "\n", "\r\n"])("consumes a terminal frame ending with %j", async (suffix) => {
		const payload = `data: ${JSON.stringify({ type: "done", reason: "stop", usage })}${suffix}`;
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(payload)));
		const stream = streamProxy(model, { messages: [] }, options);
		const events = [];
		for await (const event of stream) events.push(event.type);
		expect(events).toEqual(["done"]);
		expect((await stream.result()).stopReason).toBe("stop");
	});

	it("reports premature EOF instead of leaving result pending", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('data: {"type":"start"}\n')));
		const stream = streamProxy(model, { messages: [] }, options);
		const events = [];
		for await (const event of stream) events.push(event.type);
		expect(events).toEqual(["start", "error"]);
		expect((await stream.result()).errorMessage).toContain("terminal");
	});

	it("stops reading once a terminal event arrives", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(`data: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n`),
				);
			},
			cancel,
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
		const stream = streamProxy(model, { messages: [] }, options);
		for await (const _event of stream) {
			/* drain */
		}
		expect((await stream.result()).stopReason).toBe("stop");
		await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
	});
});
