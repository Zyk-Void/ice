import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "test",
	name: "test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://codex.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};
const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString(
	"base64",
);
const apiKey = `test.${payload}.test`;

describe("Codex terminal SSE frames", () => {
	afterEach(() => vi.unstubAllGlobals());
	it.each(["", "\n", "\n\n", "\r\n\r\n"])("flushes terminal frame with suffix %j", async (suffix) => {
		const text = `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}${suffix}`;
		const bytes = new TextEncoder().encode(text);
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
					controller.close();
				},
			}),
		);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
		const result = await stream(model, { messages: [] }, { apiKey, transport: "sse" }).result();
		expect(result.stopReason).toBe("stop");
	});
});
