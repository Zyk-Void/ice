# Audit: ICE Blackhole Compaction Improvement Plan

- Plan: `agent_docs/implementation/ice-blackhole-compaction-improvement-plan.md`
- Audited: 2026-09-14
- Branch/worktree: `plugins-remapping` / `/home/mewtwo/Zks/ice/.worktrees/plugins-remapping`
- Completion: **97.2%** (`17.5 / 18.0` scoreable points)
- Eligible for complete-remaining mode (`>85%`): **YES — completion pass executed**
- Implementation code changed by this completion pass: **Yes — only the remaining scoped Cognee/Blackhole work**

## Verdict

The scoped implementation work is complete. Percent-only triggering, `[Last Actions]`, durable `[Running Agents]`, checkpoint recall, documentation, and tests all match the approved plan. The completion pass fixed the remaining checkpoint-recall defects: `checkpointRecall` now persists, checkpoint recall is independent of per-prompt `autoRecall`, the handoff contract uses bounded `results`, stale same-session handoffs are cleared before each relevant compaction attempt (including when checkpoint recall or Cognee is disabled), writes are atomic, timestamps fail closed, and Blackhole validates the host session before consuming the handoff.

All focused Blackhole/Cognee tests pass (**64/64**), TypeScript passes, Biome passes, and every constituent repository check passes. The only reason the normalized audit score is not 100% is an external toolchain wrapper issue: the literal root `corepack npm@12.0.2 run check` starts under npm 12.0.2 but its nested `npm run` resolves to npm 11.19.0 and fails `devEngines`. This is not an implementation defect and no source change is warranted to accommodate the wrong nested npm binary.

## Scoring normalization

The source plan contains prose bullets rather than checkboxes. The audit normalizes its explicit leaf requirements and verification statements into 18 atomic scoreable units. `VERIFIED = 1.0`, `PARTIAL = 0.5`, `MISSING/BROKEN/BLOCKED = 0.0`. The post-merge sync chain in plan line 69 is not scored because it is explicitly conditional on reaching merge-ready state.

## Coverage ledger

| ID | Plan unit | Status | Score | Evidence | Exact remaining work |
|---|---|---|---:|---|---|
| P1.1 | Percent-only config schema; required `compactAfterPercent`; default 85 | VERIFIED | 1.0 | `packages/coding-agent/examples/extensions/ice-blackhole/src/core/unified-config.ts:10-26` | - |
| P1.2 | Remove numeric token mode/env precedence; ignore legacy `compactAfterTokens`; resolver uses active context window | VERIFIED | 1.0 | `unified-config.ts:69-119`, `unified-config.ts:122-134` | - |
| P1.3 | Remove `/blackhole tokens`; percent-only settings/status/usage | VERIFIED | 1.0 | `packages/coding-agent/examples/extensions/ice-blackhole/index.ts:7-13`, `index.ts:37-42`, `index.ts:89-113` | - |
| P1.4 | Item 1 test matrix: default, env, legacy-ignore, save round-trip, settings values, context math | VERIFIED | 1.0 | `src/core/unified-config.test.ts:23-83`; integration settings/threshold coverage in `test/suite/blackhole-compaction.test.ts:47-169` | - |
| P2.1 | `[Last Actions]`: last ~10 tool actions, deterministic one-liners, same tool-summary mapping, error marker | VERIFIED | 1.0 | `src/core/build-sections.ts:24-49`; `src/core/brief.ts` exports the existing `toolOneLiner`; `src/core/sections.test.ts:17-39` | - |
| P2.2 | Last Actions is near the top and fresh-only across summary merges | VERIFIED | 1.0 | `src/core/format.ts:51-59`; `src/core/summarize.ts` includes `Last Actions` and treats it as volatile; `src/core/sections.test.ts:23-55` | - |
| P2.3 | Running-agent reconstruction from `event.branchEntries`, latest snapshots/completion messages, active statuses only | VERIFIED | 1.0 | `src/core/running-agents.ts:20-68`; invoked from `src/hooks/before-compact.ts:35-38` | - |
| P2.4 | Running Agents includes job id/role/status/inspect hint, cap 8, omitted when empty, no new state registry | VERIFIED | 1.0 | `src/core/running-agents.ts:23-24`, `:62-74`; `src/core/running-agents.test.ts:38-73` | - |
| P2.5 | Item 2 unit and suite coverage | VERIFIED | 1.0 | `src/core/sections.test.ts`, `src/core/running-agents.test.ts`; end-to-end summary assertion `test/suite/blackhole-compaction.test.ts:234-297` | - |
| P3.1 | `checkpointRecall` config default false + env + user setting/persistence | VERIFIED | 1.0 | Field/default/env/settings are present; `saveIceCogneeConfig()` now serializes `checkpointRecall`; `test/ice-cognee.test.ts` verifies save/load persistence. | - |
| P3.2 | Enabled Blackhole pre-compact performs one bounded recall from newest summarized user message, sharing caps/circuit and failing silently | VERIFIED | 1.0 | `checkpointRecallQuery()` selects the newest summarized user message; checkpoint recall no longer depends on per-prompt `autoRecall`; regression coverage verifies `checkpointRecall=true` with `autoRecall=false`. | - |
| P3.3 | Write the Cognee handoff file at `<agentDir>/ice-cognee/compaction-recall.json` with the planned contract | VERIFIED | 1.0 | Producer writes `{ generatedAt, query, results }` plus `hostSessionId`; result text is bounded/redacted and the file is committed with temp-file + rename. | - |
| P3.4 | Blackhole consumes handoff once, caps/marks it untrusted, deletes it, and never leaks stale recalls | VERIFIED | 1.0 | Producer clears prior same-session handoffs before relevant attempts and when disabled; consumer rejects stale/missing/invalid/future timestamps, validates host session, caps/marks untrusted, and deletes consume-once; hook consumes before its empty-summary cancel decision. | - |
| P3.5 | Remove dead `blackholeActive` argument from `shouldOwnCompactionSummary`; retain defensive tail filter | VERIFIED | 1.0 | `ice-cognee.ts:137-140`, call sites `:1130`, `:1863`; existing tail hygiene remains in Blackhole tail code | - |
| P3.6 | Item 3 tests listed in the plan | VERIFIED | 1.0 | Cognee enabled/inactive plus persistence/gating/stale-cleanup tests in `packages/coding-agent/test/ice-cognee.test.ts`; consume/delete/cap/absent/freshness/session tests in `src/core/checkpoint-recall.test.ts` | - |
| R1 | Settings/Cognee docs and `[Unreleased]` changelog updates | VERIFIED | 1.0 | `packages/coding-agent/docs/settings.md`, `docs/ice-cognee.md`, `docs/compaction.md`, `packages/coding-agent/CHANGELOG.md` | - |
| V1 | Focused Item 1-3 tests and Blackhole integration suite | VERIFIED | 1.0 | **6 files, 64/64 tests passed**, including Blackhole integration plus new persistence/gating/stale/freshness/session handoff regressions. | - |
| V2 | Repository `check` verification | PARTIAL | 0.5 | Root Biome stage completed (`1145 files`; it formatted one touched file during this pass). Exact wrapper `corepack npm@12.0.2 run check` then failed because nested `npm run` resolved to npm `11.19.0`. Final Biome verification was clean, and all remaining constituent checks passed directly: pinned deps, TS-relative imports, shrinkwrap, install-lock, `tsgo --noEmit`, browser smoke. | Fix/clarify the local toolchain invocation so the documented single check command succeeds under npm 12.0.2; source checks themselves are clean. |

**Score:** `(17 VERIFIED × 1.0) + (1 PARTIAL × 0.5) = 17.5 / 18 = 97.2%`.

## Findings

### Resolved — checkpoint-recall persistence and semantics

`checkpointRecall` is now serialized by `saveIceCogneeConfig()` and survives reloads. Its checkpoint behavior is independent of per-prompt `autoRecall`, matching the separate setting and documented opt-in semantics.

### Resolved — handoff contract and stale-data lifecycle

The producer now writes the approved bounded `results` contract, adds host-session identity, and commits the file atomically with temp-file + rename. Before relevant compactions it clears a prior same-session handoff; this also runs when checkpoint recall or Cognee is disabled so a recent file cannot be injected once after a toggle-off. Empty/failed recalls therefore cannot preserve an older same-session payload.

Blackhole consumes the handoff before making its empty-summary cancel decision. The consumer fails closed on missing, invalid, future, or expired timestamps, validates the host session, caps the rendered data, labels it untrusted, and deletes valid/invalid same-session payloads consume-once. A handoff tagged for another host session is not consumed.

### Remaining verification/tooling issue — exact `npm run check` wrapper

`corepack npm@12.0.2 run check` still fails after its Biome stage because a nested `npm run` resolves to npm 11.19.0 and trips the repo's npm-12.0.2 `devEngines` requirement. Every substantive constituent check succeeds directly. This is an environment/Corepack shim issue, not remaining plan implementation work.

## Verification performed

- Focused + integration Vitest command covering all affected Blackhole/Cognee files — **PASS: 6 files, 64/64 tests**.
- `./node_modules/.bin/biome check --error-on-warnings` on the touched source/test files — **PASS, no fixes required** after final edits.
- `./node_modules/.bin/tsgo --noEmit` after final edits — **PASS**.
- `node scripts/check-pinned-deps.mjs` — **PASS**.
- `node scripts/check-ts-relative-imports.mjs` — **PASS**.
- `node scripts/generate-coding-agent-shrinkwrap.mjs --check` — **PASS**.
- `node scripts/generate-coding-agent-install-lock.mjs --check` — **PASS**.
- `node scripts/check-browser-smoke.mjs` — **PASS**.
- Structured pnpm Vitest helper — **not applicable** because this repository declares npm; it exits before executing tests.
- Exact root `corepack npm@12.0.2 run check` — Biome stage runs, then **environment failure** because nested `npm run` resolves npm 11.19.0 instead of required 12.0.2.

## Plan gaps discovered during audit

These are outside the approved plan denominator and are not blockers for this completion.

1. **Cross-process overwrite remains possible at the fixed handoff path.** Host-session tagging prevents one session from consuming another session's payload, and cleanup preserves a payload tagged for another session. Because the approved contract uses the single fixed `<agentDir>/ice-cognee/compaction-recall.json` path, two simultaneous writers could still replace one another's file. Eliminating that would require a session-scoped filename or a locking/protocol change beyond this plan.
2. **Last Actions error correlation remains name-based.** Error attribution selects the latest action with the same tool name rather than a tool-call id. This is low risk for sequential execution but could be tightened separately for parallel same-tool calls.

## Next-agent fix queue

There is no remaining implementation work required by `ice-blackhole-compaction-improvement-plan.md`.

Optional follow-ups only:
1. Make the fixed-path Cognee handoff fully cross-process isolated with a separate protocol/design change.
2. Correlate `[Last Actions]` failures by tool-call id if parallel same-tool execution becomes relevant.
3. Repair the local Corepack/npm shim so nested `npm run` stays on npm 12.0.2 and the literal one-shot repository check exits 0.

## Blockers

No implementation blocker remains. The sole scored partial is the external nested-npm wrapper mismatch; all underlying source, formatting, type, lock, import, browser-smoke, focused, and integration checks pass.

## Complete-remaining result

**IMPLEMENTATION COMPLETE.** The fresh pre-edit audit was **86.1%**, satisfying the skill's strict `>85%` takeover gate. After this completion pass, all implementation/documentation/test units are VERIFIED. The normalized audit is **97.2%** only because V2 retains a half-point deduction for the local npm/Corepack wrapper environment issue.
