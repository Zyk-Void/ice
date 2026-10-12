# Fork subagent prompt-cache affinity

> **Historical implementation snapshot.** This note describes prompt-cache work in an earlier subagent worktree and is not a statement of the current V2 child contract. See the [Subagents V2 guide](../packages/coding-agent/docs/subagents-v2.md); source and branch-status claims below are historical evidence.

## Status and provenance

This document describes the fork prompt-cache implementation visible in the
`subagent-fork-prompt-cache` worktree.

- The branch name is recorded as `subagent-fork-prompt-cache` in
  `agent_docs/implementation/subagent-fork-prompt-cache-plan-audit.md`.
- A commit hash for `HEAD` was not exposed by the permitted file inspection, so
  this document intentionally does not claim a particular commit or commit
  ancestry.
- The recorded `git status --short` output in the audit run reports modified
  feature-bearing files (including `idea.md`, `package.json`, AI adapters, and
  coding-agent files). Therefore the implementation is present as working-tree
  changes relative to the inspected `HEAD`; it must not be treated as committed
  merely because the branch has an implementation audit.
- This file is newly created by the documentation pass and is also
  **uncommitted**. No source, test, or changelog file was changed by this pass.

The audit and generated evidence cited below are observations available in this
worktree, not a new verification run performed while writing this document.

## Purpose

Fork mode lets sibling subagents receive a bounded, sanitized projection of the
parent conversation while still starting with independent child sessions. The
prompt-cache feature adds a second identity for providers that support explicit
prompt-cache affinity:

- each forked child keeps its own conversation/session identity;
- siblings with the same stable contract can share a deterministic cache-affinity
  key for their common prompt prefix; and
- cache affinity is never used as a continuation identity, a Codex WebSocket
  identity, or a `previous_response_id`.

This is an optimization and routing hint, not a correctness mechanism. A
provider may decline to cache, expire the entry, or interpret the key according
to its own policy.

## Behavior

### Fork normalization

`normalizeSubagentRequest()` defaults `contextMode` to `"fresh"`. Setting
`contextMode: "fork"` requires a `parentContext` implementing
`SubagentForkContextSource`:

```ts
const request = normalizeSubagentRequest(
  {
    parentSessionId: "parent-session",
    role: "self",
    task: "Inspect the approved scope.",
    scope: { roots: ["src"] },
    cwd,
    contextMode: "fork",
    self: {
      instructions: "Report only observed evidence.",
      capabilities: ["read"],
    },
  },
  cwd,
  { agentDir, parentContext },
);
```

The parent projection is obtained from `buildSessionContext().messages`, not a
session clone or unrestricted branch export. The sanitizer retains only:

- user text;
- assistant text; and
- branch or compaction summaries.

It redacts credential-like text and drops thinking, tool calls, tool results,
images, custom parts, and empty content. The retained snapshot is immutable,
uses a deterministic recent suffix, and is bounded to 32 messages, 8 KiB per
message, and 64 KiB of aggregate UTF-8 content. The explicit context-packet
path is independent but shares a combined 64 KiB fork-plus-packet handoff
budget. Fork normalization does not call a provider or ask a model to summarize
anything.

A fork child still receives a fresh `SessionManager.inMemory()` history. Its
prompt contains the sanitized fork material and its own task, but it cannot see
a sibling's task or child transcript. Fresh mode has no fork snapshot and does
not receive a prompt-cache key.

### Prompt layout and shared boundary

`buildSubagentPrompt()` places invariant material before the task boundary where
safe. In fork mode the relevant order is:

1. ICE handoff marker and untrusted-data warning;
2. execution and optional token-budget notes;
3. role, canonicalized scope roots/targets, and selected prompt resources;
4. output-size and generic JSON report instructions;
5. sanitized fork context and explicit context-packet items;
6. `Task:` and the sibling-specific task; and
7. task-specific acceptance-criteria and output-schema requirements.

Scope roots, scope targets, and execution-tool allowlists are rendered in
canonical order because they are set-like authority data. Resource, MCP,
delegated-tool, and fork/context message order remains meaningful and is not
sorted merely to increase cache reuse. The task is deliberately after the
shared prefix and is excluded from the affinity key.

### Key derivation

`deriveSubagentPromptCacheKey(request, model, childTools, unsafeHostExec)`
returns `undefined` unless the normalized request is in fork mode. Otherwise it
returns an opaque value of the form:

```text
ice-fork-v1-<52 lowercase hexadecimal characters>
```

The value is a hash of bounded, normalized contract material. It includes the
provider/model identity and compatibility metadata, agent/profile identity and
source hashes, context mode, canonical scope sets, authority flags, execution
contract, timeout, child-tool sequence, resource provenance and source hashes,
context packet/fork contents, MCP authorization data, and delegated-tool
fingerprints. The task itself is excluded so sibling tasks can diverge after the
shared prefix. Raw prompts and credentials are not exposed as the key.

Changes to authority, model/provider route, profile/system prompt, selected
resources, provider-visible tool sequences, fork material, MCP authorization,
or other keyed contract inputs produce a different affinity. The key version is
part of the material (`v1`), allowing a future contract change to invalidate old
keys explicitly.

### Native session integration

`createNativeSubagentSession()` resolves the actual child tool surface first,
then derives the key with those final child tools. It returns the key as
`NativeSubagentSession.promptCacheKey` and wraps the child stream function so
that each provider call receives:

```ts
{
  sessionId: /* the child session identity, supplied by the session runtime */,
  promptCacheKey: /* the stable fork affinity, when retention is not "none" */
}
```

An existing caller-provided stream key wins. `cacheRetention: "none"` removes
the cache key at the stream boundary. The wrapper does not replace the child
session ID, merge child histories, or alter the authoritative tool and scope
checks.

The public AI seam is `StreamOptions.promptCacheKey`. It is documented as
cache-only: adapters may use it for prompt-cache request fields or cache-routing
headers, but must not use it for continuation state or response identifiers.
When the field is absent, compatible adapters may fall back to `sessionId` for
legacy behavior.

## Adapter/API boundary

The implementation intentionally treats provider cache affinity and
conversation continuation as separate channels when the provider permits it.
The visible adapter matrix in `idea.md` is summarized here:

| Adapter family | Cache-affinity use | Session/continuation use |
|---|---|---|
| OpenAI Responses, OpenAI Chat Completions, Azure Responses | `prompt_cache_key` request field (subject to adapter compatibility and retention rules) | Session-derived headers and provider continuation state |
| OpenAI Codex Responses | `prompt_cache_key` request field | Session-keyed headers, session-keyed WebSocket connections, and `previous_response_id` |
| Mistral Conversations | `promptCacheKey` request field and generated `x-affinity`; an explicit caller `x-affinity` header wins | `sessionId` remains the fallback identity |
| Anthropic-compatible routes | The cache-only field is ignored because the available channel is session affinity | Unique child `sessionId` is sent as `x-session-affinity` when the model compatibility flags enable it |
| Faux provider | Internal prompt-cache map key | Independent `sessionId` passed to the stream |

OpenAI and Codex adapters independently gate cache fields when retention is
`"none"`. Codex continuation bookkeeping remains keyed by the cache session
(the child session), and WebSocket reuse is session-scoped; a shared prompt key
does not cause one sibling to inherit another sibling's response ID or socket.
The Anthropic-compatible limitation is intentional: using the child session for
its only affinity channel preserves isolation rather than pretending that a
cache-only key can be separated safely.

## Configuration and usage

There is no global switch required to derive fork affinity. Callers opt into
fork mode on the subagent request. Normal provider retention remains the
adapter default (`"short"`); the existing `StreamOptions.cacheRetention` can be
set to `"long"` where the provider/model compatibility supports it, or to
`"none"` to disable cache affinity for that call. The legacy
`ICE_CACHE_RETENTION=long` environment setting is still recognized by the
provider adapters where documented by their existing behavior.

For a direct stream, the API shape is:

```ts
const stream = streamOpenAIResponses(model, context, {
  apiKey,
  sessionId: "child-a",
  promptCacheKey: "ice-fork-v1-…",
  cacheRetention: "short",
});
```

Applications normally should not manufacture this key. Let
`createNativeSubagentSession()` derive it from a normalized fork request so
scope, resources, tools, authority, and provider identity are included.

### Structural benchmark

The repository exposes a provider-free benchmark:

```bash
npm run ice:subagent-prompt-cache:bench
```

It builds two native-child-equivalent requests (profile system prompt,
`buildSubagentPrompt()` user message, and a representative `read` tool),
performs mocked OpenAI Responses captures, and writes metric-only evidence to:

```text
.artifacts/subagent-prompt-cache/structural.json
```

The default run does not need credentials and does not make a network request.
A live measurement is separately approval-gated and requires an explicitly
approved OpenAI Responses-compatible endpoint, model, and API key:

```bash
ICE_PROMPT_CACHE_BENCHMARK=1 \
ICE_PROMPT_CACHE_BENCHMARK_APPROVED=1 \
ICE_PROMPT_CACHE_BENCHMARK_BASE_URL=http://127.0.0.1:20128/v1 \
ICE_PROMPT_CACHE_BENCHMARK_API_KEY=... \
ICE_PROMPT_CACHE_BENCHMARK_MODEL=... \
npm run ice:subagent-prompt-cache:bench
```

The live output records provider-reported cache-read/cache-write token counts,
not prompts or request bodies. Output defaults to
`.artifacts/subagent-prompt-cache/latest.json` and can be overridden with
`ICE_PROMPT_CACHE_BENCHMARK_OUTPUT`; the structural path can be overridden with
`ICE_PROMPT_CACHE_BENCHMARK_STRUCTURAL_OUTPUT`.

## Visible verification evidence

The following evidence is present in the worktree:

1. `packages/coding-agent/test/ice-subagent-prompt-cache.test.ts` captures the
   current OpenAI Responses adapter with a mocked fetch. It checks distinct
   `session_id` values for two siblings, baseline per-session keys versus one
   derived key, `short` retention, serialized system/user/tool payloads, and a
   stable prefix through the task boundary.
2. `packages/coding-agent/test/ice-subagents.test.ts` covers sanitized fork
   sourcing and immutability, UTF-8/message/aggregate limits, metadata-only
   preflight, fresh child histories, sibling isolation, stable key derivation,
   invalidation, set canonicalization, and order-sensitive provider-visible
   sequences.
3. `benchmarks/subagent-prompt-cache/src/cli.ts` exercises the same production
   request layout through the OpenAI Responses adapter and records only bounded
   metrics.
4. `.artifacts/subagent-prompt-cache/structural.json` records the observed
   provider-free result:

   ```json
   {
     "status": "structural",
     "requestLayout": "native-child-equivalent",
     "sessionsDistinct": true,
     "promptCacheKey": { "stableBefore": false, "stableAfter": true },
     "prefix": {
       "commonPromptBytes": 954,
       "taskBoundaryBytes": 927,
       "commonRequestPrefixBytesBefore": 1181,
       "commonRequestPrefixBytesAfter": 1181
     }
   }
   ```

5. `agent_docs/implementation/subagent-fork-prompt-cache-plan-audit.md` records
   the final audit as 20/20 plan units and reports, from the implementation
   worktree, focused coding-agent tests passing at 223/223, seven touched AI
   suites passing at 148/148, the benchmark TypeScript gate passing, the
   provider-free benchmark passing, the repository check passing, and
   `git diff --check` passing. Those are recorded audit results; they are not
   being represented as commands rerun by this documentation-only change.

The recorded live-provider portion was not run because no approved endpoint,
key, and model were supplied. This is expected: provider-free structural
verification is the mandatory normal path, while live cache usage is explicit
opt-in.

## Limitations and follow-ups

- A shared key expresses intended cache affinity, not a guaranteed cache hit.
  Provider support, minimum cacheable prefix lengths, TTLs, routing, model
  deployment, and billing semantics remain provider-specific.
- Providers without a safe independent cache channel retain child-session
  affinity or ignore the cache-only field. Anthropic-compatible routes are the
  explicit example.
- Cache identity is for the stable prefix only. It must not be used to resume a
  conversation, share a Codex WebSocket, or transfer `previous_response_id`.
- Fork context is bounded and lossy by design. Thinking, tool activity, images,
  custom parts, tool results, and older messages can be dropped; the resulting
  child is not a full transcript clone.
- Prompt layout and provider serialization can evolve. Any change to the
  stable-contract material or its ordering should update the key version and
  structural evidence rather than silently reusing an incompatible key.
- The current live benchmark covers OpenAI Responses. Follow-up work should
  collect repeated measurements against each approved provider family, retain
  exact route/model/retention metadata, and verify that cache-read/write counts
  match the provider's documented semantics without recording secrets or raw
  prompts.
- The feature has existing AI and coding-agent changelog entries and an
  architecture note in `idea.md`; this documentation pass intentionally did not
  modify those files.
