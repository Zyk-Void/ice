import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ClaudeSdkClient } from "../src/claude-sdk/adapter.ts";

const config = { version: 1, baseUrl: "http://127.0.0.1:20129", tokenFile: "/unused", models: ["claude-haiku-4-5-20251001"] };
const model = { id: config.models[0], provider: "claude-sdk", api: "claude-sdk", baseUrl: config.baseUrl, reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const context = { systemPrompt: "ICE identity", messages: [{ role: "user", content: "test", timestamp: 1 }], tools: [{ name: "echo", description: "echo", parameters: { type: "object" } }] };
const opaque = () => randomBytes(32).toString("hex");
function fixture(t, content, preview = "") {
  const handle = opaque(); let requests = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/cancel")) return Response.json({ cancelled: true });
    requests++;
    const records = [{ type: "ready", version: 1, handle, transport: "claude-agent-sdk", billing: "external" }, ...(preview ? [{ type: "text_delta", delta: preview }] : []), { type: "turn", handle, message: { content, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" } }];
    return new Response(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
  });
  return { client: new ClaudeSdkClient(config, async () => opaque()), count: () => requests };
}
test("previewed text and later text retain separate event indices", async (t) => {
  const blocks = [{ type: "text", text: "first" }, { type: "thinking", thinking: "signed", thinkingSignature: "sig" }, { type: "text", text: "last" }];
  const { client } = fixture(t, blocks, "fir");
  const events = [];
  for await (const event of client.stream(model, context, { sessionId: "mixed" })) events.push(structuredClone(event));
  assert.equal(events.at(-1).type, "done");
  assert.deepEqual(events.at(-1).message.content, blocks);
  assert.deepEqual(events.filter((event) => event.type === "text_end").map((event) => [event.contentIndex, event.content]), [[0, "first"], [2, "last"]]);
  assert.deepEqual(events.filter((event) => event.type === "thinking_end").map((event) => event.contentIndex), [1]);
  await client.close();
});
test("a preview cannot be retroactively assigned to a later text block", async (t) => {
  const { client } = fixture(t, [{ type: "thinking", thinking: "signed", thinkingSignature: "sig" }, { type: "text", text: "later" }], "lat");
  const output = await client.stream(model, context, { sessionId: "invalid-index" }).result();
  assert.equal(output.stopReason, "error");
  await client.close();
});
for (const toolChoice of ["required", "any", { type: "tool", name: "echo" }]) {
  test(`unsupported forced tool selection is rejected before inference: ${JSON.stringify(toolChoice)}`, async (t) => {
    const { client, count } = fixture(t, [{ type: "text", text: "OK" }]);
    const output = await client.stream(model, context, { sessionId: "forced", toolChoice }).result();
    assert.equal(output.stopReason, "error");
    assert.equal(count(), 0);
    await client.close();
  });
}
