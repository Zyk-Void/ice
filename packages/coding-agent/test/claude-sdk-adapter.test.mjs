import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ClaudeSdkClient, readRecords, validateClientConfig } from "../src/claude-sdk/adapter.ts";

const config = { version: 1, baseUrl: "http://127.0.0.1:20129", tokenFile: "/unused", models: ["claude-haiku-4-5-20251001"] };
const model = { id: config.models[0], provider: "claude-sdk", api: "claude-sdk", baseUrl: config.baseUrl, reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const tool = { name: "echo", description: "Echo", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
const context = { systemPrompt: "This is ICE / pi. Keep /home/me/.pi/config and user instructions unchanged.", messages: [{ role: "user", content: "Hello", timestamp: 1 }], tools: [tool] };
const opaque = () => randomBytes(32).toString("hex");
const usage = { input: 3, output: 2, cacheRead: 5, cacheWrite: 1 };
const turn = (content = [{ type: "text", text: "OK" }], stopReason = "stop") => ({ content, stopReason, usage });
function response(handle, message = turn()) {
  return ndjson([{ type: "ready", version: 1, handle, transport: "claude-agent-sdk", billing: "external" }, { type: "turn", handle, message }]);
}
function ndjson(records) { return new Response(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { headers: { "Content-Type": "application/x-ndjson" } }); }
function fixture(t, implementation) {
  const key = opaque(); const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/cancel")) return Response.json({ cancelled: true });
    requests.push({ url, options }); return implementation(url, options);
  });
  return { client: new ClaudeSdkClient(config, async () => key), requests, key };
}
test("configuration refuses remote, credentialed, redirected and non-root URLs", () => {
  for (const baseUrl of ["https://example.invalid", "http://localhost:20129", "http://127.0.0.1:20129/proxy", "http://name:pass@127.0.0.1:20129", "http://127.0.0.1:20129/?next=evil", "http://127.0.0.1"]) assert.throws(() => validateClientConfig({ ...config, baseUrl }));
  assert.equal(validateClientConfig(config).baseUrl, config.baseUrl);
});
test("text transport emits a single terminal event and preserves actual ICE prompt", async (t) => {
  const { client, requests } = fixture(t, () => response(opaque()));
  const events = [];
  for await (const event of client.stream(model, context, { sessionId: "text" })) events.push(event);
  assert.equal(events.filter((event) => event.type === "done").length, 1);
  assert.equal(events.find((event) => event.type === "text_delta").delta, "OK");
  const result = events.at(-1).message;
  assert.equal(result.usage.totalTokens, 11);
  assert.equal(result.diagnostics[0].details.billing, "external");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.systemPrompt, context.systemPrompt);
  assert.deepEqual(payload.tools[0].parameters, tool.parameters);
  assert.equal(requests[0].options.redirect, "error"); await client.close();
});
test("onPayload replacement is applied but hard output cap cannot be removed", async (t) => {
  const { client, requests } = fixture(t, () => response(opaque()));
  let seenResponse = false;
  const output = await client.stream(model, context, { sessionId: "hooks", hardMaxOutputTokens: 100,
    onPayload: (payload) => ({ ...payload, systemPrompt: "custom", maxTokens: undefined }),
    onResponse: (value) => { seenResponse = value.status === 200; },
  }).result();
  assert.equal(output.stopReason, "stop"); assert.equal(seenResponse, true);
  assert.equal(JSON.parse(requests[0].options.body).systemPrompt, "custom");
  assert.equal(JSON.parse(requests[0].options.body).maxTokens, 100); await client.close();
});
test("payload hook cannot swap the authenticated session envelope", async (t) => {
  const { client, requests } = fixture(t, () => response(opaque()));
  const output = await client.stream(model, context, { sessionId: "hook", onPayload: (payload) => ({ ...payload, sessionId: "other" }) }).result();
  assert.equal(output.stopReason, "error"); assert.equal(requests.length, 0); await client.close();
});
test("tool turn and signed thinking reach the native ICE loop unchanged", async (t) => {
  const content = [{ type: "thinking", thinking: "reasoning", thinkingSignature: "fixture-signature" }, { type: "toolCall", id: "call-1", name: "echo", arguments: { text: "hello" } }];
  const { client } = fixture(t, () => response(opaque(), turn(content, "toolUse")));
  const output = await client.stream(model, context, { sessionId: "tool" }).result();
  assert.equal(output.stopReason, "toolUse"); assert.deepEqual(output.content, content); await client.close();
});
test("two ICE sessions never share a native bridge handle", async (t) => {
  const handles = [opaque(), opaque(), opaque()];
  let index = 0;
  const { client, requests } = fixture(t, () => response(handles[index++]));
  await client.stream(model, context, { sessionId: "a" }).result();
  await client.stream(model, context, { sessionId: "b" }).result();
  await client.stream(model, context, { sessionId: "a" }).result();
  const bodies = requests.map((request) => JSON.parse(request.options.body));
  assert.notEqual(bodies[0].sessionId, bodies[1].sessionId);
  assert.equal(bodies[2].sessionId, bodies[0].sessionId);
  assert.equal(bodies[2].handle, handles[0]); await client.close();
});
test("unknown or forbidden tool calls are never forwarded to ICE", async (t) => {
  const { client } = fixture(t, () => response(opaque(), turn([{ type: "toolCall", id: "call", name: "arbitrary", arguments: {} }], "toolUse")));
  const output = await client.stream(model, context, { sessionId: "unknown" }).result();
  assert.equal(output.stopReason, "error"); assert.equal(output.content.length, 0); await client.close();
});
test("toolChoice none is honored even if upstream returns a tool", async (t) => {
  const { client, requests } = fixture(t, () => response(opaque(), turn([{ type: "toolCall", id: "call", name: "echo", arguments: {} }], "toolUse")));
  const output = await client.stream(model, context, { sessionId: "no-tools", toolChoice: "none" }).result();
  assert.equal(output.stopReason, "error"); assert.deepEqual(JSON.parse(requests[0].options.body).tools, []); await client.close();
});
test("server errors do not trigger provider fallback or reflect raw provider messages", async (t) => {
  const { client, requests } = fixture(t, () => ndjson([{ type: "error", code: "subscription_required", message: "[REDACTED_SECRET]" }]));
  const output = await client.stream(model, context, { sessionId: "auth" }).result();
  assert.equal(output.stopReason, "error"); assert.equal(output.errorMessage.includes("[REDACTED_SECRET]"), false);
  assert.equal(output.errorMessage.includes("No API fallback"), true); assert.equal(requests.length, 1); await client.close();
});
for (const malformed of ["no-ready", "duplicate-terminal", "truncated", "bad-json"]) {
  test(`invalid NDJSON ${malformed} fails closed`, async (t) => {
    const handle = opaque();
    const ready = { type: "ready", version: 1, handle, transport: "claude-agent-sdk", billing: "external" };
    const final = { type: "turn", handle, message: turn() };
    const { client } = fixture(t, () => malformed === "no-ready" ? ndjson([final]) : malformed === "duplicate-terminal" ? ndjson([ready, final, final]) : new Response(malformed === "truncated" ? JSON.stringify(ready) : "garbled\n", { headers: { "Content-Type": "application/x-ndjson" } }));
    const output = await client.stream(model, context, { sessionId: malformed }).result();
    assert.equal(output.stopReason, "error"); await client.close();
  });
}
test("pre-aborted requests never reach the network", async (t) => {
  const { client, requests } = fixture(t, () => response(opaque()));
  const controller = new AbortController(); controller.abort();
  const output = await client.stream(model, context, { sessionId: "abort", signal: controller.signal }).result();
  assert.equal(output.stopReason, "aborted"); assert.equal(requests.length, 0); await client.close();
});
test("text is delivered before the final frame, without duplication", { timeout: 3000 }, async (t) => {
  const handle = opaque(); let finish;
  const encoder = new TextEncoder();
  const { client } = fixture(t, () => new Response(new ReadableStream({ start(controller) {
    const send = (value) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
    send({ type: "ready", version: 1, handle, transport: "claude-agent-sdk", billing: "external" });
    send({ type: "text_delta", delta: "Hello " });
    finish = () => {
      send({ type: "text_delta", delta: "world" });
      send({ type: "turn", handle, message: turn([{ type: "text", text: "Hello world" }]) });
      controller.close();
    };
  } }), { headers: { "Content-Type": "application/x-ndjson" } }));
  const deltas = []; let final;
  for await (const event of client.stream(model, context, { sessionId: "stream" })) {
    if (event.type === "text_delta") { deltas.push(event.delta); if (deltas.length === 1) finish(); }
    if (event.type === "done") final = event.message;
  }
  assert.equal(deltas.join(""), "Hello world");
  assert.deepEqual(final.content, [{ type: "text", text: "Hello world" }]); await client.close();
});
test("inconsistent preview cannot release a tool invocation", async (t) => {
  const handle = opaque();
  const { client } = fixture(t, () => ndjson([
    { type: "ready", version: 1, handle, transport: "claude-agent-sdk", billing: "external" },
    { type: "text_delta", delta: "inconsistent" },
    { type: "turn", handle, message: turn([{ type: "toolCall", id: "call", name: "echo", arguments: {} }], "toolUse") },
  ]));
  const events = [];
  for await (const event of client.stream(model, context, { sessionId: "bad-preview" })) events.push(event);
  assert.equal(events.some((event) => event.type === "toolcall_end"), false);
  assert.equal(events.at(-1).type, "error"); await client.close();
});
test("UTF-8 and JSON can cross arbitrary response chunks", async () => {
  const encoded = new TextEncoder().encode(`${JSON.stringify({ text: "unicode \u03c0" })}\n`);
  const body = new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const records = await readRecords(new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }));
  assert.equal(records[0].text, "unicode \u03c0");
});
