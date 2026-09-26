# Audit: Subagent Quality & Reliability v2 Plan

- Plan: `agent_docs/implementation/subagent-quality-reliability-v2-plan.md`
- Audited: 2026-09-27T02:18:00+03:00
- Implementation baseline: `341e0a1a9 feat(coding-agent): land output artifacts and subagent quality contract` plus `881c9d261 feat(coding-agent): make managed subagent launches handle-only`
- Completion: **74.4%** (29.0 / 39.0 scoreable acceptance units)
- Eligible for Complete-remaining by default (`>85%`): **NO**
- User-authorized threshold override: **NOT USED**

## Verdict

**REPAIR REQUIRED — substantial implementation exists, but the plan is not complete.**

The agent implemented most of the structural machinery: normalized task contracts, deterministic context manifests, assurance/evidence verification, batch duplicate/contradiction synthesis, output-artifact integration, lifecycle attention, quality telemetry helpers, settings-level mechanical/judgment route aliases, and extensive tests. The changed code is large and real rather than cosmetic.

However, several plan-critical behaviors are still absent or defective:

1. Phase-0 quality benchmarking is only a deterministic harness/scaffold. The live baseline entry point intentionally fails closed with `live_not_implemented`, no plain-vs-structured baseline was measured, no self/file/batch/review comparison was produced, and no human-readable benchmark artifact exists.
2. The context bootstrap hashes and lists applicable `AGENTS.md` files, but it does not mount or inject their contents as selected context resources. The child receives metadata and must decide to read the file itself.
3. Quality-tier routing has a precedence defect: a configured `mechanical`/`judgment` tier can overwrite an explicitly requested `execution.model`, contradicting the intended “explicit model wins” rule.
4. The quality telemetry schema defines reasoning/follow-up/repeated-failure/reviewer fields, but production result formatting does not populate those fields.
5. Follow-up repair is bounded, but its count/budget is not durable across persisted job state/restart.
6. The high-risk reviewer **capability** exists through `review_batch`, but the plan's selective high-risk reviewer **policy** is not implemented.
7. Benchmark-dependent acceptance items cannot be claimed complete because the benchmark evidence does not exist.

The source plan itself is stale: it still says “proposal for review (not implemented)” and leaves all acceptance boxes unchecked. This audit scores current code, not those checkboxes.

## Scoring

- VERIFIED = 1.0
- PARTIAL = 0.5
- MISSING/BROKEN/BLOCKED = 0.0
- N/A = excluded

Current distribution:

- VERIFIED: 26
- PARTIAL: 6
- MISSING: 6
- BROKEN: 1
- BLOCKED: 0
- Total score: `26 + (6 * 0.5) = 29.0`
- Completion: `100 * 29 / 39 = 74.3589...%` -> **74.4%**

## Coverage ledger

| ID | Plan unit | Status | Score | Evidence | Exact remaining work |
|---|---|---|---:|---|---|
| P0.1 | Reproducible quality fixture set exists | VERIFIED | 1.0 | `packages/coding-agent/src/ice-subagent-quality-bench.ts`; `packages/coding-agent/test/ice-subagent-quality-bench.test.ts`; targeted quality suite passed | - |
| P0.2 | Baseline report records exact route/reasoning/runtime metadata | PARTIAL | 0.5 | Benchmark record/renderer models route, thinking, hashes, tools, timing, token/tool/follow-up/verification fields in `ice-subagent-quality-bench.ts`, but no actual baseline report artifact exists | Execute and persist a baseline report with exact provider/model, reasoning, runtime, hashes, tools, token/cache counts, follow-ups, verification, and outcome metadata |
| P0.3 | Plain vs structured-report baseline is measured | MISSING | 0.0 | `packages/coding-agent/test/ice-subagent-quality-bench.test.ts` only validates deterministic harness behavior; live baseline is skipped/unimplemented | Run the same fixtures under plain, structured, and structured+contract modes and store results |
| P0.4 | Self/file/batch/review paths are separately scored | MISSING | 0.0 | No persisted baseline/report comparing these paths was found | Add fixture/run dimensions for self, file-agent, batch, and review and score each independently |
| P0.5 | Human-readable benchmark result artifact is produced | MISSING | 0.0 | No quality benchmark result artifact exists under `agent_docs`; renderer support alone is not an artifact | Produce a Markdown benchmark artifact adjacent to this plan/audit |
| P1.1 | Every normalized run has bounded task contract + hash | VERIFIED | 1.0 | `ice-subagent-task-contract.ts:278-313,354-380`; normalized request carries contract/hash in `ice-subagents.ts:1120-1126` | - |
| P1.2 | Parent guidance includes objective/context/deliverable/verification rules | VERIFIED | 1.0 | `ice-subagents.ts:678-687` explicitly briefs zero-context children, known facts/paths, exact deliverable, verification, non-goals, sibling independence, parent synthesis | - |
| P1.3 | Task-contract fields do not alter scope/tool authority | VERIFIED | 1.0 | Semantic fields are normalized separately; scope/tool allowlists continue through existing authority paths; comments at `ice-subagents.ts:950-957` state non-authority semantics | - |
| P1.4 | Existing callers/transcripts remain compatible | VERIFIED | 1.0 | Defaults in `ice-subagent-task-contract.ts:278-351` preserve legacy calls; changed-path regression tests pass | - |
| P1.5 | Result shows explore/standard/strict completion class | VERIFIED | 1.0 | `ice-subagents.ts:11757-11763` formats quality mode; task-contract derivation at `ice-subagent-task-contract.ts:316-351` | - |
| P2.1 | Safe children automatically receive applicable repo instructions without ambient loading | PARTIAL | 0.5 | Instruction discovery/hash is implemented in `ice-subagent-context-bootstrap.ts:323-397`, but module contract explicitly says output contains metadata only (`:15-33`); renderer `:590-602` lists filenames/hash, not contents | Inject selected, hash-verified instruction **contents** as bounded read-only child context resources, while keeping ambient context/packages/extensions disabled |
| P2.2 | Context manifest hash is stable and visible | VERIFIED | 1.0 | Manifest canonical hash `ice-subagent-context-bootstrap.ts:573-580`; prompt rendering includes hash `:590-596`; result carries `contextManifestHash` at `ice-subagents.ts:8646-8650` | - |
| P2.3 | Auto bootstrap does not grant tool/MCP/network authority | VERIFIED | 1.0 | Bootstrap is metadata/read-only and authority-neutral; security framing at `ice-subagent-context-bootstrap.ts:23-33,99-100`; tool authority remains existing runtime allowlist | - |
| P2.4 | Full conversation fork remains explicit | VERIFIED | 1.0 | Fresh/default context behavior retained; fork-specific cache path gated by `contextMode === "fork"` in `ice-subagents.ts:5561-5563` | - |
| P2.5 | Context benchmark improves cross-file success without material irrelevant context | MISSING | 0.0 | No before/after quality benchmark exists; live benchmark path is unimplemented | Add focused lookup + cross-file before/after measurements and context-byte/noise reporting |
| P3.1 | Task class -> semantic tier -> ICE route is deterministic | BROKEN | 0.0 | Tier mapping exists, but normalization spreads tier route after explicit `execution.model`; the configured tier can overwrite explicit model around `ice-subagents.ts:5276-5277,5359-5377`; no route-tier precedence tests found | Fix precedence so explicit execution model wins; add tests for explicit model > tier > profile/config fallback and durable route replay |
| P3.2 | No hard-coded external provider/model names | VERIFIED | 1.0 | Mechanical/judgment resolve from settings through existing route machinery; no provider/model literal is hard-coded in the tier policy | - |
| P3.3 | Reasoning level explicit in run diagnostics | PARTIAL | 0.5 | `ice-subagent-quality-telemetry.ts` defines/renders `reasoningLevel`, but production call at `ice-subagents.ts:11765-11776` does not pass it | Carry resolved thinking level into run/result provenance and production telemetry/observatory output |
| P3.4 | Judgment/reviewer benchmarks show no reasoning downgrade regression | MISSING | 0.0 | No live/current benchmark report exists | Benchmark current self/profile reasoning vs inherited/judgment settings with identical routes |
| P3.5 | Mechanical tasks can use configured cheaper/faster tier without authority change | VERIFIED | 1.0 | Tier mapping/config path exists and model selection does not grant tools/scope; authority remains independent | - |
| P4.1 | Parent can tell why child is stuck without transcript noise | VERIFIED | 1.0 | Supervisor retains bounded activity/repeated-failure state; `ice-subagent-timeout-supervisor.test.ts:106-135` verifies advisory data while run remains alive | - |
| P4.2 | Same-session repair is default recovery recommendation | VERIFIED | 1.0 | Result/recovery path recommends owner-bound same-session `manage_subagent follow_up`; existing native child follow-up path is retained | - |
| P4.3 | Repair count is bounded and durable | PARTIAL | 0.5 | Follow-up budget is bounded and idempotent in runtime, but follow-up count/budget is not persisted in `ice-subagent-jobs.ts`; source search shows `followUpCount` only in telemetry helper | Persist repair/follow-up count and budget-consumed state in durable job/run provenance and restore fail-closed |
| P4.4 | Repeat detection cannot terminate a healthy run on one repeated read | VERIFIED | 1.0 | Advisory-only repeated-failure test `ice-subagent-timeout-supervisor.test.ts:106-135`; supervisor remains `running` | - |
| P4.5 | User takeover overrides parent follow-up | VERIFIED | 1.0 | `ice-subagents.test.ts:6851-6908` queues/idempotently dedupes follow-up then rejects follow-up after controlled user takeover | - |
| P5.1 | Parent distinguishes output-bounded from evidence-verified work | VERIFIED | 1.0 | Assurance levels in `ice-subagent-assurance.ts`; result formatter distinguishes quality/assurance and plain-bounds semantics | - |
| P5.2 | Required criteria cannot pass from model prose alone | VERIFIED | 1.0 | Runtime verification path binds criteria/evidence; `ice-subagents.ts:9731-9756` verifies before completed status; assurance tests passed | - |
| P5.3 | Command/test evidence is tied to runtime-observed state | VERIFIED | 1.0 | Observed bash commands/evidence paths are supplied to assurance annotation at `ice-subagents.ts:9731-9740`; assurance module rejects unsupported claims | - |
| P5.4 | Structured-vs-plain default chosen from benchmark data | MISSING | 0.0 | No benchmark data exists; live baseline entry is still unimplemented | Run A/B/C benchmark before asserting the default is evidence-based; document selected default and tradeoff |
| P5.5 | High-risk reviewer policy reuses review_batch | PARTIAL | 0.5 | `review_batch` exists and is documented for correctness/security/tests/regression at `ice-subagents.ts:16092-16098`, but no task-policy maps security-sensitive/refactor/migration/shared-infra work to selective review | Add bounded parent policy/recommendation for high-risk task categories; do not auto-review trivial work |
| P6.1 | Batch children have explicit coverage/non-goal metadata | VERIFIED | 1.0 | Batch task includes scope targets, kind, deliverable, constraints, nonGoals, criteria at `ice-subagents.ts:1129-1148`; synthesis emits per-child coverage at `ice-subagent-batch-synthesis.ts:141-165` | - |
| P6.2 | Exact duplicate sibling assignments are caught | VERIFIED | 1.0 | `findExactDuplicateBatchTasks` at `ice-subagent-batch-synthesis.ts:100-129`; dedicated tests pass | - |
| P6.3 | Independent-review overlap remains allowed | VERIFIED | 1.0 | Duplicate detector explicitly does not treat overlapping scope as duplicate `ice-subagent-batch-synthesis.ts:100-105`; test covers overlap | - |
| P6.4 | Per-child full outputs remain addressable | VERIFIED | 1.0 | Batch child artifacts are retained/addressable; ownership tests in `ice-subagents.test.ts:1587-1601,1703` and output-artifact tests pass | - |
| P6.5 | Contradictions surfaced to parent synthesis | VERIFIED | 1.0 | Deterministic finding/requirement contradiction synthesis implemented and tested in `ice-subagent-batch-synthesis.test.ts:189-315` | - |
| P7.1 | Failed benchmark can be traced to brief/context/route/tool/verification/lifecycle cause | PARTIAL | 0.5 | Telemetry/weak-run diagnostic helpers exist, but there is no real failed benchmark and production does not populate route reasoning/follow-up/repeated-failure/reviewer fields | Wire all quality telemetry fields to real runtime state, then demonstrate traceability with a benchmark failure fixture/report |
| P7.2 | Telemetry remains local and redacted | VERIFIED | 1.0 | Bounded/redacted telemetry implementation/tests in `ice-subagent-quality-telemetry.ts` and `ice-subagent-quality-telemetry.test.ts` | - |
| P7.3 | Comparing runs does not require raw task secrets | VERIFIED | 1.0 | Hashes/structured metadata support comparison; telemetry tests verify secret redaction and bounded strings | - |
| P7.4 | Observatory remains bounded under concurrent children | VERIFIED | 1.0 | Bounded footer/observatory snapshots and activity truncation are tested; e.g. `subagent-footer.test.ts:98-145` feeds 64 activities into bounded snapshot logic | - |

## Findings

### Critical / High

#### H1 — Quality-tier routing violates explicit-model precedence

The route-tier overlay can replace an explicit `execution.model`. This is a semantic routing bug, not merely missing test coverage. The implementation intends explicit execution choice to win, but tier-derived `requestedModel` is spread later in normalization.

Evidence:
- `packages/coding-agent/src/ice-subagents.ts:5276-5277`
- `packages/coding-agent/src/ice-subagents.ts:5359-5377`
- No `mechanical`/`judgment` route precedence integration tests were found under `packages/coding-agent/test`.

Impact: a parent explicitly selecting a child model can silently get another configured tier model.

#### H2 — Phase-0 benchmark decision gate was bypassed

The plan intentionally required baseline measurement before changing defaults/routing. The implementation created the harness but did not run the required experiment.

Evidence:
- `packages/coding-agent/test/ice-subagent-quality-bench.test.ts`: deterministic fixture/scoring tests; live path is gated/skipped.
- `packages/coding-agent/src/ice-subagent-quality-bench.ts`: live baseline entry fails closed with `live_not_implemented`.
- No human-readable benchmark result artifact under `agent_docs`.

Impact: claims that standard/strict defaults, context bootstrap, routing tiers, or reviewer policy improve subagent quality are currently unproven.

### Medium

#### M1 — Repository instructions are discovered but not actually delivered as instruction content

The bootstrap securely discovers and hashes governing `AGENTS.md` files, but the rendered child prompt only includes metadata. The module explicitly documents that it outputs no file content.

Evidence:
- `ice-subagent-context-bootstrap.ts:15-33`
- `ice-subagent-context-bootstrap.ts:323-397`
- `ice-subagent-context-bootstrap.ts:584-602`
- `ice-subagents.ts:5284-5291,5736-5738`

Impact: a fresh child can still miss critical repo rules unless it independently chooses to read the listed file.

#### M2 — Quality telemetry schema is ahead of production wiring

The helper supports `reasoningLevel`, `followUpCount`, `repeatedFailureCount`, `reviewerUsed`, and `reviewerOutcome`, but runtime formatting currently supplies only hashes/mode/assurance/report/evidence/criteria/status.

Evidence:
- `ice-subagent-quality-telemetry.ts:54-63,148-166`
- `ice-subagents.ts:11765-11776`

Impact: observability cannot yet diagnose several quality regressions the plan explicitly targeted.

#### M3 — Repair budget is bounded but not durable

Runtime follow-up is owner-bound/idempotent and bounded, but the repair count does not survive durable persistence/restart.

Evidence:
- `ice-subagents.test.ts:6851-6908`
- `ice-subagent-jobs.ts` contains result quality fields but no persisted follow-up/repair counter.
- Source search finds `followUpCount` in the telemetry helper, not durable job/runtime state.

#### M4 — Selective high-risk review policy is absent

`review_batch` is implemented and suitable, but no policy classifies security-sensitive changes, migrations, broad refactors, or high-impact shared infrastructure for review.

Evidence:
- `ice-subagents.ts:16092-16098`
- `packages/coding-agent/docs/subagent-user-guide.md:13,74`

### Low

#### L1 — Plan status/checklist is stale

The plan still says proposal/not implemented and leaves every acceptance checkbox empty despite a large implementation commit. This is not a runtime defect, but it makes agent handoff misleading.

#### L2 — Standard package-script verification is blocked by local npm version

The checkout requires npm 12.0.2, while the available npm is 11.19.0. Direct Vitest execution works, but `npm run check` cannot be used in this environment until npm matches the repository's declared dev engine.

## Verification performed

1. Inspected current branch/status and implementation commits.
2. Compared all 39 atomic acceptance criteria in the plan against current source/tests.
3. Core quality suite via installed Vitest binary:
   - `ice-subagent-task-contract.test.ts`
   - `ice-subagent-context-bootstrap.test.ts`
   - `ice-subagent-assurance.test.ts`
   - `ice-subagent-batch-synthesis.test.ts`
   - `ice-subagent-quality-bench.test.ts`
   - `ice-subagent-quality-telemetry.test.ts`
   - Result: **156 passed, 1 skipped**.
4. Broader changed-path test sweep:
   - Initial repository-root run: **518 passed, 1 failed, 2 skipped**.
   - The one failure was CWD-sensitive `ice-delegate-mvp.test.ts`, which expected package-relative `src/cli.ts`.
   - Reran from `packages/coding-agent`: **9 passed, 0 failed**.
   - Conclusion: no product failure established by that initial failure.
5. `npm run test ...` / package-script wrapper could not start because this environment has npm 11.19.0 while the repository declares npm 12.0.2.
6. Confirmed there is no existing `.ai-bridge` directory in this worktree, so no handoff mirror was created.

## Plan gaps discovered during audit

These are implementation-quality issues uncovered while testing the stated plan; they do not change the denominator above:

1. **Explicit-model precedence needs an invariant test.** The plan says route precedence tests, but it should state the exact precedence contract: explicit execution model > explicit profile/file-agent route > semantic tier alias > configured/default parent route, with durable snapshot replay preserving the chosen route.
2. **Context manifest durability is underspecified.** The manifest hash reaches results, but the complete manifest metadata is not persisted for replay/inspection. If “durable manifest” is required literally, persist the bounded manifest or a reconstructible equivalent.
3. **Production telemetry wiring needs an acceptance-level integration test.** Unit-testing the telemetry helper is insufficient; one real run should assert emitted reasoning/follow-up/repeated-failure/reviewer fields.
4. **Benchmark artifact naming/location should be standardized** so future audits can deterministically find the current baseline.

## Next-agent fix queue

1. **Fix route-tier precedence and add route tests**
   - Why: P3.1 is BROKEN and can silently violate an explicit model request.
   - Evidence: `ice-subagents.ts:5276-5277,5359-5377`.
   - Change: ensure semantic tier aliases fill only an unset route, or apply tier first then explicit execution/profile overrides. Preserve durable route snapshot authority.
   - Verify: tests for explicit model vs mechanical/judgment, profile model vs tier, no-tier unchanged parent route, fallback/capability filtering, durable replay.
   - Depends on: nothing.

2. **Finish Phase-0 benchmark and persist the report**
   - Why: P0.2-P0.5, P2.5, P3.4, and P5.4 depend on actual benchmark evidence.
   - Evidence: live baseline currently `live_not_implemented`; no report artifact exists.
   - Change: implement live runner using existing production delegate path; run fixed corpus for plain/structured/structured+contract and self/file/batch/review; record route/reasoning/runtime/token/cache/tool/follow-up/evidence/reviewer/final-outcome provenance; render Markdown + JSON.
   - Verify: deterministic dry fixture plus controlled live baseline where credentials are available; repeated runs per plan when practical.
   - Depends on: Fix queue item 1 first so routing evidence is trustworthy.

3. **Deliver applicable AGENTS.md contents, not only metadata**
   - Why: P2.1 is only partial.
   - Evidence: `ice-subagent-context-bootstrap.ts:15-33,584-602`.
   - Change: inject selected, bounded, hash-verified instruction contents as read-only context resources below system/tool policy. Continue rejecting symlinks/escapes/oversize files and keep ambient packages/extensions/context disabled.
   - Verify: nested AGENTS fixture proves the child prompt/context contains applicable instruction text; safe/YOLO authority remains identical except pre-existing authorized tools; hash-change revalidation passes.
   - Depends on: none, but benchmark item 2 should measure the before/after effect.

4. **Wire resolved reasoning and complete quality telemetry into production**
   - Why: P3.3 and P7.1 are partial.
   - Evidence: helper fields exist but `ice-subagents.ts:11765-11776` omits them.
   - Change: propagate semantic tier, resolved reasoning, follow-up count, repeated-failure count, reviewer use/outcome, and evidence type counts from runtime-owned state into result/job/observatory telemetry. Keep values bounded/redacted.
   - Verify: one end-to-end run/result projection test plus durable-job inspection test; no raw task secret in serialized telemetry.
   - Depends on: item 1 for correct route/tier provenance.

5. **Make repair count durable**
   - Why: P4.3 is partial.
   - Evidence: runtime follow-up is bounded/idempotent; persisted job state has no repair counter.
   - Change: persist host-owned follow-up/repair count and consumed repair budget in durable run/job state; restore without widening authority; historical records default conservatively.
   - Verify: restart/reload fixture retains count and rejects budget overflow; takeover and request-id idempotency remain green.
   - Depends on: telemetry item 4 if the same durable field is reused.

6. **Add selective high-risk review policy**
   - Why: P5.5 is partial.
   - Evidence: `review_batch` capability exists, but no high-risk classifier/recommendation path exists.
   - Change: introduce bounded host/parent policy that recommends/requires existing `review_batch` for security-sensitive changes, broad refactors, migrations, shared infrastructure, or deterministic-verification gaps. Do not review trivial tasks automatically.
   - Verify: policy classification tests and reviewer-use telemetry; benchmark reviewer precision/false positives.
   - Depends on: benchmark item 2 and telemetry item 4.

7. **Re-run benchmark gates and choose defaults from evidence**
   - Why: P2.5, P3.4, and P5.4 remain MISSING until measured.
   - Change: compare context bootstrap, reasoning/tier policy, and plain-vs-structured modes using the fixed corpus; document minimum-detectable improvement and overhead.
   - Verify: report shows no unexplained category regression, evidence precision, verified-task success, token/runtime overhead, and repair intervention rate.
   - Depends on: items 1-6 as applicable.

8. **Update plan/checklist/status only after verification**
   - Why: current plan metadata is stale and misleading.
   - Change: once above items are verified, update status and checkboxes with evidence references. Do not mark benchmark-dependent items complete without the artifact.
   - Verify: re-run this coverage ledger; no incomplete unit omitted.
   - Depends on: all prior items.

## Blockers

- **Environment/tooling:** standard npm package scripts are blocked until npm 12.0.2 is available; current npm is 11.19.0. Direct `node_modules/.bin/vitest` verification is usable meanwhile.
- **Live-model benchmark:** requires usable model credentials/runtime. If unavailable in CI/local environment, the live benchmark portion remains BLOCKED rather than VERIFIED.

## Complete-remaining eligibility

**NO.** Current audited completion is **74.4%**, below the skill's default strict threshold of `>85%`. No user override was given. This audit therefore did not edit implementation code.
