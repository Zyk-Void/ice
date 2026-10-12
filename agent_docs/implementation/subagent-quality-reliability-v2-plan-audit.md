# Audit: Subagent Quality & Reliability v2 Plan

- Plan: `agent_docs/implementation/subagent-quality-reliability-v2-plan.md`
- Audited: 2026-09-27T11:15:36+03:00
- Audited HEAD: `ac59bf4e50e30d390d78635857f444baa526115b`
- Pre-completion audit: **84.6%** (33.0 / 39.0)
- Current completion: **87.2%** (34.0 / 39.0)
- Eligible for complete-remaining by default (`>85%`): **YES at current score; implementation began under explicit user override from 84.6%**
- User-authorized threshold override: **USED**
- Implementation status: **CODE-SIDE REMAINING WORK COMPLETED; MODEL-BACKED VALIDATION BLOCKED BY LOCAL CREDENTIAL AVAILABILITY**

## Verdict

**SUBSTANTIAL COMPLETION WITH EXTERNAL VALIDATION BLOCKER.**

The user explicitly authorized completion below the default 85% gate. The remaining code-side gaps from the prior audit have now been implemented and verified:

- a model-backed subagent quality benchmark runner exists and is exposed through `quality:live`;
- the runner uses the production `NativeSubagentRunner`, records real route/reasoning/token/tool/evidence provenance, supports the fixed quality corpus, and can compare plain/structured/contract/context/file/batch/review modes;
- dynamic imports were removed from the benchmark path to preserve the repository's top-level-import invariant;
- follow-up repair request IDs are journaled durably before delivery and restored from parent-session custom entries, so duplicate detection and the repair budget survive extension/session reconstruction;
- high-risk reviewer recommendations now cover security, migration, refactor, and shared/core infrastructure cues while reusing `review_batch`;
- production quality telemetry now includes semantic worker tier, route source, and evidence-type counts, and the durable job envelope retains the new provenance;
- targeted tests, `corepack npm@12.0.2 run check`, and the full non-e2e `./test.sh` suite pass.

The remaining incomplete criteria all require **actual model-backed quality measurements**. A live smoke attempt was made with the repository's documented route `cx/gpt-5.6-luna`, but this local environment has no configured authentication for that route. The benchmark failed closed before any model run with `credentials_required`. These criteria are therefore BLOCKED rather than silently treated as verified.

## Scoring

- VERIFIED = 1.0
- PARTIAL = 0.5
- MISSING/BROKEN/BLOCKED = 0.0
- N/A = excluded

Current distribution:

- VERIFIED: 32
- PARTIAL: 4
- BLOCKED: 3
- MISSING: 0
- BROKEN: 0
- Score: `32 + (4 * 0.5) = 34.0`
- Completion: `100 * 34 / 39 = 87.179...` -> **87.2%**

## Coverage ledger

| ID | Plan unit | Status | Score | Evidence | Exact remaining work |
|---|---|---|---:|---|---|
| P0.1 | Reproducible quality fixture set exists | VERIFIED | 1.0 | `src/ice-subagent-quality-bench.ts`, quality fixtures, deterministic tests | - |
| P0.2 | Baseline report records exact route/reasoning/runtime metadata | PARTIAL | 0.5 | Dry artifact exists; live runner now records real model route, thinking, hashes, token/tool counts and outcomes, but no authenticated model run could be produced locally | Run `quality:live` with configured provider auth and persist the resulting Markdown/JSON artifact |
| P0.3 | Plain vs structured-report baseline is measured | PARTIAL | 0.5 | Runner supports `plain`, `structured`, and `contract`; dry comparison exists; authenticated measurement blocked | Execute fixed corpus across these modes with identical model/thinking |
| P0.4 | Self/file/batch/review paths are separately scored | PARTIAL | 0.5 | Live runner supports `file`, `batch`, `review` mode projections and records child profile/path provenance; no authenticated results yet | Run the live matrix and persist path-level results |
| P0.5 | Human-readable benchmark result artifact is produced | VERIFIED | 1.0 | `.artifacts/subagent-quality-bench/baseline-dry.md`; live CLI writes Markdown+JSON when authenticated | - |
| P1.1 | Every normalized run has bounded task contract + hash | VERIFIED | 1.0 | Task-contract normalization/hash implementation + tests | - |
| P1.2 | Parent guidance includes objective/context/deliverable/verification rules | VERIFIED | 1.0 | Delegation prompt guidance in `ice-subagents.ts` | - |
| P1.3 | Task contract does not expand authority | VERIFIED | 1.0 | Contract remains semantic; existing scope/tool admission retained | - |
| P1.4 | Existing callers/transcripts remain compatible | VERIFIED | 1.0 | Compatibility normalization + regression tests | - |
| P1.5 | Result exposes explore/standard/strict completion class | VERIFIED | 1.0 | Quality mode normalization/result formatting | - |
| P2.1 | Safe children receive applicable repository instruction chain | VERIFIED | 1.0 | Governing instruction contents injected with size/hash revalidation; nested/tamper tests | - |
| P2.2 | Context manifest is stable and visible | VERIFIED | 1.0 | Manifest hash/result/telemetry projection | - |
| P2.3 | Bootstrap grants no new authority | VERIFIED | 1.0 | Prompt-only context; ambient package/extensions remain disabled | - |
| P2.4 | Full conversation fork remains explicit | VERIFIED | 1.0 | Fork mode remains opt-in | - |
| P2.5 | Context benchmark demonstrates cross-file improvement without excess noise | BLOCKED | 0.0 | Live runner includes `contract` vs `contract-no-context`; smoke attempt stopped with `credentials_required` before a model call | Re-run with authenticated route and compare success/context overhead |
| P3.1 | Task class -> semantic tier -> ICE route is deterministic | VERIFIED | 1.0 | Explicit-model precedence fixed and tested | - |
| P3.2 | No hard-coded external provider/model names | VERIFIED | 1.0 | Tier aliases are host settings | - |
| P3.3 | Reasoning level is explicit in diagnostics | VERIFIED | 1.0 | Runtime/durable quality provenance includes reasoning level | - |
| P3.4 | Judgment/reviewer benchmark shows no reasoning downgrade | BLOCKED | 0.0 | Live runner records requested/applied reasoning and includes review cases; no authenticated benchmark available | Run review/judgment matrix at fixed route/thinking and compare |
| P3.5 | Mechanical tier can be cheaper/faster without authority change | VERIFIED | 1.0 | Route-tier settings + authority-isolation tests | - |
| P4.1 | Parent can diagnose why child is stuck | VERIFIED | 1.0 | Bounded supervisor/observatory state | - |
| P4.2 | Same-session repair is default recovery | VERIFIED | 1.0 | Owner-bound `manage_subagent follow_up` path | - |
| P4.3 | Repair count is bounded and durable | VERIFIED | 1.0 | `SUBAGENT_FOLLOW_UP_STATE_ENTRY_TYPE`; durable parent-session journal is written before delivery and restored on session start; follow-up test restores request IDs and confirms duplicate semantics | - |
| P4.4 | Repeat detection cannot kill a healthy run on one repeated read | VERIFIED | 1.0 | Advisory supervisor behavior + regression tests | - |
| P4.5 | User takeover overrides parent follow-up | VERIFIED | 1.0 | Follow-up/takeover test remains green | - |
| P5.1 | Output-bounded vs evidence-verified completion is distinct | VERIFIED | 1.0 | Assurance/result semantics | - |
| P5.2 | Required criteria cannot pass from prose alone | VERIFIED | 1.0 | Runtime evidence verification | - |
| P5.3 | Command/test evidence is runtime-observed | VERIFIED | 1.0 | Observed command/evidence binding | - |
| P5.4 | Structured-vs-plain default is chosen from benchmark data | BLOCKED | 0.0 | The live A/B/C mechanism now exists but no authenticated measurements can justify a data-driven default change | Run benchmark, compare verified success/evidence precision/overhead, then document any default change |
| P5.5 | High-risk reviewer policy reuses review_batch | VERIFIED | 1.0 | `recommendSubagentReviewerGate` now detects security/migration/refactor/shared/core-infra cues and recommends existing `review_batch`; quality-completion tests cover categories | - |
| P6.1 | Batch children have coverage/non-goal metadata | VERIFIED | 1.0 | Batch contract/synthesis | - |
| P6.2 | Exact duplicate siblings are caught | VERIFIED | 1.0 | Duplicate detector/tests | - |
| P6.3 | Independent-review overlap is allowed | VERIFIED | 1.0 | Batch synthesis policy/tests | - |
| P6.4 | Per-child full outputs remain addressable | VERIFIED | 1.0 | Output artifacts/managed handles | - |
| P6.5 | Contradictions remain visible | VERIFIED | 1.0 | Contradiction synthesis/tests | - |
| P7.1 | Failed benchmark can be traced to brief/context/route/tool/verification/lifecycle cause | PARTIAL | 0.5 | Production telemetry now carries worker tier, route source, evidence-type counts, reasoning, hashes, follow-ups, repeated failures and reviewer outcome. The live smoke failure is correctly classified as credential/configuration failure, but an authenticated quality-failure trace is not available | Demonstrate at least one authenticated failed quality case and trace its cause using emitted provenance |
| P7.2 | Telemetry remains local/redacted | VERIFIED | 1.0 | Bounded redaction tests | - |
| P7.3 | Benchmark comparison does not require raw task secrets | VERIFIED | 1.0 | Hash/provenance comparison + redaction | - |
| P7.4 | Observatory stays bounded under concurrency | VERIFIED | 1.0 | Bounded observatory/footer tests | - |

## Implemented completion work

### 1. Model-backed benchmark execution

Added:
- `packages/coding-agent/src/ice-subagent-quality-live-bench.ts`
- `packages/coding-agent/examples/subagent-quality-live-bench.ts`
- package script `quality:live`
- benchmark fixture agents and repository instruction fixture

The runner:
- uses the existing production `NativeSubagentRunner`;
- stages the fixed quality fixture repository;
- resolves provider/model through existing model runtime/auth infrastructure;
- records route, thinking, task/context hashes, tool allowlist, token/cache usage, assistant/tool calls, follow-ups, verification kind, criterion pass, evidence precision, reviewer outcomes, final status;
- supports plain, structured, contract, no-context contract, file, batch and review experiment modes;
- fails closed before model execution if route/auth is unavailable.

The benchmark module no longer uses a dynamic `await import()`; the live entrypoint imports it statically, preserving the repository rule against inline/dynamic imports.

### 2. Durable foreground repair ledger

Added a bounded append-only session custom-entry type:
- `ice-subagent-follow-up-v1`

Accepted follow-up request IDs are durably journaled **before** delivery. Failure to persist rolls back the in-memory admission and fails closed. On parent session start the runner restores validated owner-matching request-ID sets. Malformed/foreign/oversized entries are ignored.

This preserves:
- stable request-id idempotency;
- the three-follow-up repair ceiling;
- user-takeover authority;
- no extra child/tool authority.

### 3. High-risk reviewer gate

The existing reviewer-gate helper now recognizes bounded task-text cues for:
- security;
- migrations;
- refactors;
- shared runtime/infrastructure;
- core infrastructure.

It continues to reuse `review_batch`; no second reviewer framework was introduced.

### 4. Quality provenance

Production and durable result projections now include:
- semantic worker tier;
- route source;
- evidence-type counts (path/command/artifact/diff/blocked);
- existing reasoning/follow-up/repeated-failure/reviewer fields.

## Verification performed

1. Targeted completion/regression suite after durability changes:
   - `ice-subagents.test.ts`
   - `ice-subagent-quality-completion.test.ts`
   - `ice-subagent-quality-bench.test.ts`
   - `ice-subagent-quality-telemetry.test.ts`
   - `ice-subagent-jobs.test.ts`
   - Result: **5 files passed; 368 passed; 1 skipped; 0 failed**.

2. Repository gate:
   - `corepack npm@12.0.2 run check`
   - Result: **PASS**, 1191 files checked; formatter applied two local fixes; type/import/shrinkwrap/install-lock/browser-smoke checks all pass.

3. Full non-e2e suite:
   - `./test.sh`
   - Result: **PASS (exit 0)**.

4. Diff validation:
   - `git diff --check`
   - Result: **PASS**.

5. Model-backed smoke:
   - route: `cx/gpt-5.6-luna`
   - case: `q-focused-retry-limit`
   - mode: `contract`
   - repeats: 1
   - thinking: `max`
   - Result: **BLOCKED before model execution** with `credentials_required`: route unavailable or no configured authentication.
   - This proves the benchmark fails closed but does not provide model-quality evidence.

## Remaining blocker

The only remaining plan work is empirical/model-backed validation. This environment lacks authentication for the attempted `cx/gpt-5.6-luna` route. Until a provider/model route is authenticated in this local ICE environment, the following cannot honestly be marked VERIFIED:

- P2.5 context-bootstrap quality improvement;
- P3.4 judgment/reviewer reasoning non-regression;
- P5.4 data-driven plain-vs-structured default;
- the empirical portions of P0.2-P0.4 and P7.1.

Once credentials exist, run for example:

```bash
cd packages/coding-agent
ICE_QUALITY_BENCH_LIVE=1 \
ICE_QUALITY_BENCH_LIVE_MODEL=<provider/model> \
ICE_QUALITY_BENCH_LIVE_MODES=plain,structured,contract,contract-no-context,file,batch,review \
ICE_QUALITY_BENCH_LIVE_REPEATS=3 \
ICE_QUALITY_BENCH_LIVE_THINKING=max \
corepack npm@12.0.2 run quality:live -- <provider/model>
```

Then re-score the benchmark-dependent acceptance items from the generated live Markdown/JSON artifact.

## Next-agent queue

1. **Run authenticated live benchmark**
   - Dependency: configured local provider/model authentication.
   - No additional code implementation is currently required to start the experiment.
2. **Use live evidence to close P2.5, P3.4 and P5.4**
   - Change defaults only if measured evidence supports the change.
3. **Re-audit P0.2-P0.4 and P7.1 from the generated live artifact**
   - A 100% score is only valid if all empirical criteria pass.

## Completion boundary

The requested remaining **implementation** work is complete and verified. The plan is **87.2% evidence-verified** because three scoreable units are externally blocked by missing local model credentials and four units remain partially evidenced until a real benchmark is produced. No commit, push, merge, reset, or unrelated cleanup was performed.
