# Subagent prompt-cache benchmark

This harness verifies the forked-subagent cache-affinity contract using the same request layout as a native read-only child: the resolved child profile is the system prompt, `buildSubagentPrompt()` is the user message, and a representative `read` tool definition is attached.

Running the command with no credentials performs a **provider-free structural capture** through the OpenAI Responses adapter. A mock fetch prevents network access while `onPayload` records only bounded request-shape metrics. The run writes `.artifacts/subagent-prompt-cache/structural.json` and verifies:

- two siblings keep distinct session IDs;
- the legacy/baseline cache keys differ while the new derived key is stable across siblings;
- both siblings serialize the shared cache key through the adapter;
- the native-child-equivalent prompt prefix is byte-identical through the task boundary;
- before/after common serialized request-prefix byte counts are recorded.

No raw prompts, provider request bodies, credentials, or model responses are written to the evidence file.

```bash
npm run ice:subagent-prompt-cache:bench
```

A live cache-usage measurement remains explicit opt-in and is never required by normal tests or CI:

```bash
ICE_PROMPT_CACHE_BENCHMARK=1 \
ICE_PROMPT_CACHE_BENCHMARK_APPROVED=1 \
ICE_PROMPT_CACHE_BENCHMARK_BASE_URL=http://127.0.0.1:20128/v1 \
ICE_PROMPT_CACHE_BENCHMARK_API_KEY=... \
ICE_PROMPT_CACHE_BENCHMARK_MODEL=... \
npm run ice:subagent-prompt-cache:bench
```

`BASE_URL`, credentials, and model must refer to a local or otherwise approved OpenAI Responses-compatible endpoint. The live run sends two sibling requests with distinct `sessionId` values and one derived `promptCacheKey`, and records provider-reported `cacheRead`/`cacheWrite` token counts plus the provider-free structural evidence. Output defaults to `.artifacts/subagent-prompt-cache/latest.json`; override it with `ICE_PROMPT_CACHE_BENCHMARK_OUTPUT`.

Override the provider-free evidence path with `ICE_PROMPT_CACHE_BENCHMARK_STRUCTURAL_OUTPUT` when needed.
