# Audit: Subagent Fork Context and Prompt-Cache Reuse Plan

- Source plan: `/home/mewtwo/Zks/ice/.worktrees/subagent-improvements/agent_docs/implementation/subagent-fork-prompt-cache-plan.md`
- Implementation worktree: `/home/mewtwo/Zks/ice/.worktrees/subagent-fork-prompt-cache`
- Branch: `subagent-fork-prompt-cache`
- Final completion audit: 2026-09-14
- Completion before completion-mode implementation: **87.5%** (`17.5 / 20`)
- Final completion: **100.0%** (`20 / 20`)
- Eligible for Complete-remaining mode: **YES — completed**

## Verdict

The plan is fully implemented and verified. Forked subagents now derive a deterministic bounded `promptCacheKey` independently from child `sessionId`; adapters use the new identity only on cache-affinity channels that are independent from conversation continuation; Codex WebSocket/`previous_response_id` state and Anthropic-compatible session affinity remain child-session scoped.

The final completion pass closes the remaining prefix/measurement gaps. Provider-visible prompt serialization now canonicalizes only true set-like authority data (`scope.roots`, `scope.targets`, and execution-tool allowlists), while resource selections and provider-visible tool/MCP/delegated sequences preserve order and therefore remain part of cache identity. Generic output/report instructions have moved into the sibling-shared prefix before `Task:` while task-specific acceptance/output-schema requirements remain after the task boundary.

A new provider-free OpenAI Responses regression captures the real native-child-equivalent request layout and proves unique sibling session headers with a shared body cache key. The benchmark now uses that same production layout, performs a no-network structural adapter capture by default, emits bounded metric-only evidence, and retains live cache-usage measurement behind explicit approval flags.

No required plan unit remains partial, missing, broken, or blocked.

## Scoring method

The source plan contains 20 leaf checklist units. None are N/A because the implementation chose to ship cache-affinity reuse. VERIFIED = 1.0, PARTIAL = 0.5, MISSING/BROKEN/BLOCKED = 0. Final score: `20 / 20 = 100%`.

## Coverage ledger

| ID | Plan unit | Status | Score | Evidence | Exact remaining work |
|---|---|---|---:|---|---|
| P9.1 | Adapter/faux tests capture `sessionId`, derived cache key, request payload prefix, and retention for parent/two forked children | VERIFIED | 1.0 | `packages/coding-agent/test/ice-subagent-prompt-cache.test.ts` performs four provider-free OpenAI Responses adapter captures for the same two siblings (baseline unique cache keys vs shared derived key), records `session_id`, retention, body cache key, system/user/tool payload layout, and compares the same sibling pair before/after. The benchmark structural path uses the same adapter-level capture. | - |
| P9.2 | Confirm fork packet construction is byte/deterministically stable for identical parent context | VERIFIED | 1.0 | Existing fork normalization coverage plus `test/ice-subagents.test.ts` stable sibling-key tests and the new provider request-shape regression prove identical shared fork material up to task divergence. | - |
| P9.3 | Document provider adapters that conflate/separate cache and continuation affinity | VERIFIED | 1.0 | `idea.md` contains the adapter-boundary matrix for OpenAI Responses/Chat/Azure, Codex, Mistral, Anthropic-compatible, and Faux routes. | - |
| P9.4 | Audit ordering of system appendices, tools, fork messages, context packet, resources, and task | VERIFIED | 1.0 | `buildSubagentPrompt()` ordering is explicitly asserted in `test/ice-subagents.test.ts`; native session creation keeps profile system prompt structural and the new adapter-level test verifies the serialized provider layout. | - |
| P9.5 | Move invariant/shared material before child-specific task text where safe | VERIFIED | 1.0 | `packages/coding-agent/src/ice-subagents.ts` now emits generic max-report/output protocol instructions before `authorizedTaskHandoff`; task-specific acceptance criteria and output schema remain after the task. Tests assert generic report instructions precede `Task:`. Structural evidence reports a 954-byte common prompt prefix and task boundary at 927 bytes. | - |
| P9.6 | Canonically order incidental sets/maps | VERIFIED | 1.0 | `scope.roots`, `scope.targets`, and execution-tool allowlists are canonicalized both in cache-key material and provider-visible prompt text. Provider-visible resource/tool/MCP/delegated ordering is intentionally preserved in both request semantics and cache identity rather than sorted only in the hash. Tests prove equivalent scope/execution permutations yield identical prompt/key while reordered provider-visible sequences yield different keys. | - |
| P9.7 | Preserve redaction/scope filtering exactly | VERIFIED | 1.0 | Existing normalized scope/redaction paths remain authoritative; cache identity emits only a hash and the full focused coding-agent suite is green. | - |
| P9.8 | Add typed `promptCacheKey` separate from `sessionId` | VERIFIED | 1.0 | `packages/ai/src/types.ts` defines `promptCacheKey`; `createNativeSubagentSession()` derives/injects it without replacing session identity. | - |
| P9.9 | Use cache key only for cache affinity, never WebSocket/session/`previous_response_id` continuation | VERIFIED | 1.0 | OpenAI/Codex body key paths are separated; Anthropic-compatible `x-session-affinity` uses `sessionId`; Codex WebSocket regression proves no cross-sibling continuation leakage. | - |
| P9.10 | Derive affinity from stable hash/ID of safe common inputs, not raw prompt text | VERIFIED | 1.0 | `deriveSubagentPromptCacheKey()` hashes normalized bounded contract material and emits `ice-fork-v1-<hash>`; raw prompt text/secrets are not used as the exposed key. | - |
| P9.11 | Adapters unable to safely separate concepts retain unique child session IDs | VERIFIED | 1.0 | Anthropic-compatible routes retain unique `sessionId` in `x-session-affinity`; Fireworks regression verifies this even with a shared `promptCacheKey`. | - |
| P9.12 | Two forked children sharing cache affinity retain distinct conversation/session IDs | VERIFIED | 1.0 | Native-child tests retain distinct in-memory managers/session IDs; Faux demonstrates cache sharing across sessions; new OpenAI Responses adapter regression captures `child-a` and `child-b` session headers while both use one shared body cache key. | - |
| P9.13 | No child receives another child's `previous_response_id` or WebSocket continuation | VERIFIED | 1.0 | `packages/ai/test/openai-codex-stream.test.ts` same-key/different-session WebSocket regression uses separate connections and proves sibling B starts without sibling A's response ID. | - |
| P9.14 | Different tool/profile/system contracts produce different cache affinity | VERIFIED | 1.0 | Coding-agent invalidation tests cover tool-order/contract changes, profile source hash, and system-prompt changes. | - |
| P9.15 | Trust/resource changes invalidate/recompute affinity | VERIFIED | 1.0 | Tests cover trust, unsafe authority, resource source hash, MCP authorization changes, and provider-visible resource/MCP sequence identity. | - |
| P9.16 | `cacheRetention: "none"` disables body cache reuse | VERIFIED | 1.0 | Native wrapper clears `promptCacheKey`; OpenAI/Mistral adapter regressions verify body omission. | - |
| P9.17 | Add opt-in benchmark recording cached-input usage on an approved provider | VERIFIED | 1.0 | `benchmarks/subagent-prompt-cache/src/cli.ts` uses native-child-equivalent context (profile system prompt + `buildSubagentPrompt()` user message + representative `read` tool), records live cacheRead/cacheWrite when explicitly approved, and never requires live credentials for normal verification. README documents the opt-in contract. | - |
| P9.18 | Record before/after request-prefix bytes and cache-key stability | VERIFIED | 1.0 | Default benchmark execution performs no-network OpenAI Responses payload capture and writes `.artifacts/subagent-prompt-cache/structural.json`: `commonPromptBytes=954`, `taskBoundaryBytes=927`, request-prefix bytes `1181` before and after, `stableBefore=false`, `stableAfter=true`, `sessionsDistinct=true`. No raw prompts/request bodies/secrets are persisted. | - |
| P9.19 | Add changelog entry for user-visible performance behavior | VERIFIED | 1.0 | AI and coding-agent changelogs document prompt-cache affinity behavior. | - |
| P9.20 | Update `idea.md` for explicit cache-affinity architecture | VERIFIED | 1.0 | `idea.md` documents deterministic fork cache affinity and the per-adapter cache/session boundary. | - |

## Completion-mode changes

The final 87.5% → 100% pass changed only the remaining in-scope surfaces:

- `packages/coding-agent/src/ice-subagents.ts`
  - canonicalizes provider-visible scope/execution sets consistently with key material;
  - preserves semantic/provider-visible resource/tool sequence identity in the key;
  - moves invariant report/output instructions before task divergence.
- `packages/coding-agent/test/ice-subagents.test.ts`
  - asserts report/output prefix ordering;
  - distinguishes true set canonicalization from provider-visible sequence identity.
- `packages/coding-agent/test/ice-subagent-prompt-cache.test.ts`
  - new no-network OpenAI Responses adapter-level sibling request-shape regression.
- `benchmarks/subagent-prompt-cache/src/cli.ts`
  - native-child-equivalent production layout for structural and live measurement;
  - provider-free adapter capture by default;
  - bounded metric-only structural evidence;
  - live provider measurement remains approval-gated.
- `benchmarks/subagent-prompt-cache/README.md`
  - documents structural and live modes and privacy/approval behavior.
- `.artifacts/subagent-prompt-cache/structural.json`
  - generated ignored structural evidence; contains metrics only.

## Verification performed

Fresh final verification in `/home/mewtwo/Zks/ice/.worktrees/subagent-fork-prompt-cache`:

- `node /home/mewtwo/Zks/ice/node_modules/vitest/dist/cli.js --run test/ice-subagents.test.ts test/ice-subagent-prompt-cache.test.ts` from `packages/coding-agent` -> **PASS, 223/223**.
- Seven touched AI suites (`azure-openai-base-url`, `faux-provider`, `fireworks-models`, `mistral-reasoning-mode`, `openai-codex-stream`, `openai-completions-prompt-cache`, `openai-responses-compat`) -> **PASS, 148/148**.
- `/home/mewtwo/Zks/ice/node_modules/.bin/tsgo --noEmit -p benchmarks/subagent-prompt-cache/tsconfig.json` -> **PASS**.
- `/home/mewtwo/Zks/ice/node_modules/.bin/tsx benchmarks/subagent-prompt-cache/src/cli.ts` with no provider credentials -> **PASS**, provider-free structural adapter capture; live request path skipped by design.
- Structural evidence -> native-child-equivalent layout, distinct sessions, stable shared cache key, 954 common prompt bytes, 927-byte task boundary, 1181 common serialized request-prefix bytes before/after.
- `node /home/mewtwo/.cache/node/corepack/v1/npm/12.0.2/bin/npm-cli.js run check` -> **PASS**, exit 0; Biome checked 1140 files and formatted the new test, pinned-dependency/import/shrinkwrap/install-lock/type/browser-smoke gates all passed.
- Focused coding-agent tests rerun after formatting -> **PASS, 223/223**.
- Touched AI tests rerun after formatting -> **PASS, 148/148**.
- `git diff --check` -> **PASS**.

## Plan gaps discovered during completion

No new requirement was added. The final pass clarified one existing P9.6 design boundary: provider-visible sequence order must not be canonicalized only in the hash. Either the actual serialized request must be canonicalized too, or the order must remain part of cache identity. The implementation now follows that rule.

A stale-build trap was also found while adding P9.1 coverage: importing the package's emitted `dist` adapter exercised older output. The new request-shape regression imports the current AI source adapter so it verifies the branch implementation being audited. Production build/check remains green.

## Next-agent fix queue

None. All 20 scoreable plan units are VERIFIED.

## Blockers

None.

A live external-provider cache-read benchmark was not executed because no approved endpoint/key/model was supplied. That is intentionally optional: the plan requires an opt-in live harness and provider-free mandatory structural assertions, both of which are implemented and verified.

## Independent self-completion verification

A second fresh pass was performed directly in this session without delegating implementation or review to a local agent/subagent. The current worktree independently scores **100.0% (20/20)** before any new source mutation, so no additional implementation edit was justified.

Fresh direct verification:

- coding-agent fork/cache regressions -> **PASS, 223/223**;
- seven touched AI adapter suites -> **PASS, 148/148**;
- benchmark TypeScript gate -> **PASS**;
- provider-free native-child-equivalent structural benchmark -> **PASS** with distinct sessions, `stableBefore=false`, `stableAfter=true`, `commonPromptBytes=954`, `taskBoundaryBytes=927`, and `commonRequestPrefixBytesBefore/commonRequestPrefixBytesAfter=1181/1181`;
- exact npm 12 repository `check` -> **PASS**, exit 0, `Checked 1140 files ... No fixes applied`;
- `git diff --check` -> **PASS**.

The minimality review produced only generic low-risk large-file heuristics; every touched adapter it named has focused regression coverage in the verified AI suites, so no additional split/refactor is required by this plan.

## Completion-mode gate

**COMPLETE.** Original completion-mode entry audit: **87.5%**. Independent self-completion re-audit: **100.0% (20/20)**. Final audit: **100.0% (20/20)**. No required criterion remains unverified or blocked.
