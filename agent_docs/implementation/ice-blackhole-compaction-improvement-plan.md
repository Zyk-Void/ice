# ICE Blackhole Compaction Improvement Plan

Status: approved, in progress (2026-09-14). Work happens on branch `plugins-remapping`; the extension source of truth is `packages/coding-agent/examples/extensions/ice-blackhole/`, with working copies under `user-extensions/ice-blackhole/` (both worktrees) and the live copy at `~/.ice/agent/extensions/ice-blackhole/`.

## Background

Blackhole is ICE's optional deterministic (LLM-free) compaction engine. Research findings that shape this plan:

- `compactAfterPercent` (1-99) already exists with percent-first precedence and resolves against the active model's context window (`Math.floor(contextWindow * percent / 100)`). The settings row is already percent-only. The numeric path survives through the `compactAfterTokens` default (81,000), the `/blackhole tokens` command, and `ICE_BLACKHOLE_COMPACT_AFTER_TOKENS`.
- The user's live config (`~/.ice/agent/ice-blackhole/ice-blackhole-config.json`) currently stores `compactAfterTokens: 81000`, `compaction: "manual"`, `midRunCompaction: "off"` — so no self-triggering happens today; Blackhole only supplies summaries for compactions started by core (native 85% threshold, manual `/compact`).
- The summary pipeline (`filterNoise` -> `normalize` -> `buildSections` -> `formatSummary`) produces: Session Goal, Files And Changes, Commits, Outstanding Context, User Preferences, plus a brief transcript (last 120 lines). Recent model actions are only implicitly present (buried in the transcript, or still in the kept tail under `ice-default` tail behavior).
- Subagents have no extension events and no listing API. Child sessions run with `noExtensions: true`, so nothing inside a subagent run is observable. Observable surfaces: `subagent.*` hooks via `registerIceSubagentHook(ice.events, ...)`, session entries of type `ice-subagent-job-v1` (job snapshots), custom messages `ice-subagent-job-completion`, and tool events for `delegate*` tools.
- Foreground `delegate` calls block their turn, so they can never span a compaction. Only background/async jobs can be "running" across a compaction, and those already persist snapshots as session entries.
- Cognee integration is one-way today: Cognee reads Blackhole's config file to defer summary ownership (`compactionSummaryMode`), and its `session_compact` handler stores the final summary into Cognee memory and injects it once on the next turn. Recall is turn-scoped via `before_agent_start` system-prompt append. There is no memory content inside the checkpoint itself.
- Extension load order is `[before-user inline] -> [user extensions] -> [normal inline]`, so at `session_before_compact` Cognee (before-user inline) runs before Blackhole (user extension). Last writer wins for compaction results; `cancel` short-circuits.
- `shouldOwnCompactionSummary(mode, blackholeActive)` ignores its second argument; `defer` and `auto` are behaviorally identical (dead parameter).
- Blackhole's `ice-cognee-recall` filter in `src/core/tail.ts` is defensive only — no producer exists on this branch (recall is a system-prompt append, not a session message).

## Item 1: Percent-only trigger, default 85%

Goal: Blackhole triggers at a percentage of the active model's context window, period. No numeric token mode.

Changes (`examples/extensions/ice-blackhole`):

- `src/core/unified-config.ts`:
  - `UnifiedConfig` drops `compactAfterTokens`; `compactAfterPercent` becomes required with default `85`.
  - Remove the `positiveInteger` validator use, the `ICE_BLACKHOLE_COMPACT_AFTER_TOKENS` env override, and the percent/tokens mutual-exclusivity branch in `loadConfig`. `saveConfig` no longer deletes the "other" threshold field.
  - Legacy configs that still store `compactAfterTokens` are ignored silently (no per-turn warning spam); percent default applies.
  - `resolveCompactAfterTokens` keeps its name (it still resolves to a token count) but loses the tokens branch.
- `index.ts`: remove `/blackhole tokens <count>`; update usage string, threshold row label ("Blackhole compaction threshold"), display value (`${config.compactAfterPercent}%`, no `?? 20` fallback), and `/blackhole status`.
- Env: keep `ICE_BLACKHOLE_COMPACT_AFTER_PERCENT`.

Layering note: Blackhole mid-run trigger at 85% is the primary trigger; Ice core's native 85% boundary check is the backstop; the 95% mid-run safety net (already on this branch) is the last resort.

Tests: default percent, env override, legacy `compactAfterTokens` ignored, `saveConfig` round-trip, settings row values, trigger math against a known context window.

## Item 2: Summary remembers recent actions + running agents (todolist deferred)

### 2a. "Last Actions" section

Dedicated section near the top of the summary: the last ~10 assistant tool actions as one-liners (`* Tool "arg"` + error marker), extracted deterministically from the summarize source (same `TOOL_SUMMARY_FIELDS` mapping the brief uses). Fresh-only on merge (like Outstanding Context) so stale items never survive. Rationale: with `minimal` tail everything recent is buried mid-transcript; with `ice-default` tail the newest actions stay only in the kept tail. After compaction the model should see "what was I just doing" immediately.

### 2b. "Running Agents" section (phase 1: entries scan)

At `session_before_compact`, scan `event.branchEntries` for `ice-subagent-job-v1` custom entries (latest snapshot per job id) and `ice-subagent-job-completion` custom messages. Jobs whose latest state is `created | queued | running | needs_time` with no completion are listed under "Running Agents": job id, role/profile, status, plus a hint to re-inspect via `inspect_subagent_job`. Cap the list (8). Omit the section when empty. No new extension state, no hook registry in this phase; the live `registerIceSubagentHook` registry is phase 2 only if testing shows the snapshot lags job state.

### Deferred

- Todolist capture: `TodoWrite` is currently in the extension's `NOISE_TOOLS` filter; enabling it later means un-filtering or reading session entries. Explicitly out of scope per user instruction.

Tests: extraction unit tests with synthetic blocks/entries; suite test asserting the summary contains "Running Agents" when an in-flight job snapshot entry exists.

## Item 3: Cognee checkpoint recall handoff (default-off)

Goal: make the checkpoint self-sufficient with durable memory when the next user prompt is too vague to seed a good recall query ("continue"). Default-off because Cognee already injects recall every turn plus the once-only `lastCompactSummary` injection after compaction — default-on would pay that cost redundantly.

Mechanism (file handoff; Blackhole gains no Cognee client):

- `src/ice-cognee.ts` (core): new config field `checkpointRecall: boolean` (default `false`; env `ICE_COGNEE_CHECKPOINT_RECALL`). When enabled and Blackhole compaction is active, the `session_before_compact` handler (which runs before Blackhole in load order) performs one bounded recall query seeded from the last user message in `messagesToSummarize` (existing budget/char caps, circuit breaker) and writes `<agentDir>/ice-cognee/compaction-recall.json` (`{ generatedAt, query, results }`). Failures are silent.
- Blackhole `before-compact` hook: after building the summary, read that file if present, append a capped "Relevant Memory" section (marked as untrusted reference data), and delete the file (consume-once) so stale recalls never leak into later compactions. Absent file = no-op.
- Cleanups while in the area: drop the dead `blackholeActive` parameter from `shouldOwnCompactionSummary` (update its tests); keep the `ice-cognee-recall` tail filter as hygiene.

Tests: cognee writes the file when enabled and blackhole active (fake fetch), does not when disabled; blackhole consumes-and-deletes, capped; no section when file absent.

## Rollout and verification

- Tests per item as listed; then the affected files via `node ../../node_modules/vitest/dist/cli.js --run test/...` from `packages/coding-agent`, plus `corepack npm@12.0.2 run check` (branch-declared npm version).
- Docs: blackhole threshold row and new summary sections in `packages/coding-agent/docs/settings.md`; `checkpointRecall` + handoff in `packages/coding-agent/docs/ice-cognee.md`; CHANGELOG entries under `[Unreleased]`.
- Sync chain after merge-ready state: `examples/extensions/ice-blackhole` -> `user-extensions/ice-blackhole` (void + plugins-remapping) -> `~/.ice/agent/extensions/ice-blackhole`. Blackhole-only changes go live by file copy; `ice-cognee.ts` (core) changes need a release build to reach the local install.

## Non-goals

- No core agent-loop changes (no new extension events for subagents, no competing compaction engine).
- No todolist capture in this round.
- No Blackhole-side Cognee HTTP client; the file is the contract.
- No change to who writes summaries: Blackhole owns them when its engine is selected; Cognee stores memory.
