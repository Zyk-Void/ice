# Audit: Managed Subagent Output Artifacts and Admission Redesign

## Superseding current-worktree verification

The audit snapshot below records the pre-implementation state at `881c9d261`; its 75.5% score, blocker list, and partial verdict are historical and are superseded by this follow-up. The current worktree implements the remaining durable-v2, output-lifecycle, Observatory, documentation, and closure work.

- Targeted verification from `packages/coding-agent`: 26 subagent-related test files passed, 581/581 tests.
- Repository check: active npm is `12.0.2`; `npm run check` passed, including pinned dependency/import/shrinkwrap/install-lock/type/browser checks.
- `git diff --check`: passed.
- Aggregate batch/review presentation is fixed at 16 KiB, matching the implementation and operator docs; it is not admission accounting.

Final symbol classification:

- Child/writer final-answer `maxOutputBytes` is rejected on new input. Remaining same-name limits are command-hook capture, child-safe adapter output, and Bash output bounds; durable-job checks/normalization retain the field only to validate and strip historical snapshots.
- `totalBudgetBytes` appears only in an explicit rejection guard; there is no batch output-admission ledger. Durable `plannedOutputBytes`/`reservedOutputBytes` are validated and removed only while decoding historical records; new job contracts/records do not expose or write them.
- Managed launch schemas and execution paths have no synchronous `background: false` option. User docs describe handle-based inspection and optional output reads.
- V1 `reportArtifact` path data is restricted to durable-history validation/cleanup and migration fixtures. New durable results use pathless v2 output refs; result clones, job inspection, and Observatory projections do not render legacy paths or artifact contents.
- `registerDurable()` and owner-scoped `finalizeRestore()` are wired into durable restore; artifact refs are released on terminal retention expiry. Tests cover durable restore/tamper/retention, aggregate and writer eviction, patch-artifact independence, and output ownership.

The implementation plan checkboxes are marked complete against this evidence. No commit was created.

> The sections below preserve the earlier audit report as historical context; do not use its stale findings as current blockers.

- Plan: `agent_docs/implementation/subagent-output-artifact-plan.md`
- Re-audited: 2026-09-24
- Worktree: `/home/mewtwo/Zks/ice/.worktrees/all-worktrees-experimental`
- Branch: `integration/all-worktrees-experimental`
- Audited HEAD: `881c9d261 feat(coding-agent): make managed subagent launches handle-only`
- Completion: **75.5%** (`37.0 / 49` scoreable units)
- Eligible for complete-remaining by default (`>85%`): **NO**
- User-authorized threshold override: **NOT USED**
- Audit mode: current source + current tests + fresh focused verification + fresh root repository gate
- Implementation source changed by this audit: **none**

## Verdict

**PARTIAL IMPLEMENTATION — 75.5% verified by the plan's 49 leaf units.**

The previous 68.4% audit is stale against current HEAD. Commit `881c9d261` materially completed the always-managed launch migration and additional process-local artifact ownership work:

- `delegate`, `delegate_batch`, `review_batch`, and `delegate_write` no longer expose `background`;
- the closed schemas reject `background: false`;
- delegate/batch/review/writer execution now returns managed handles at the accepted boundary;
- retained single-child output is released on eviction, resume supersession, explicit delete, and shutdown;
- managed batches hold an independent artifact reference so child deletion does not invalidate an aggregate result;
- managed batch/writer pruning and shutdown now release their output-artifact references.

The central v2 ordinary-output architecture is therefore substantially implemented: pathless opaque IDs, host-owned limits, output materialization, owner-scoped bounded reads, integrity checks, UTF-8 pagination, no output-length child abort, removal of caller final-answer caps, and removal of byte-reservation admission are all present.

The remaining work is concentrated in **durable persistence/migration and closure**:

1. `delegate_async` still persists the legacy `reportArtifact` envelope instead of v2 `output`;
2. production does not call `SubagentOutputArtifactStore.registerDurable()` or `finalizeRestore()`;
3. durable v2 retention expiry/release therefore does not exist;
4. legacy `reportArtifact.path` is still formatted into user/model-visible output;
5. durable Observatory projection cannot expose v2 capture metadata yet;
6. docs/changelog still advertise removed `background: false` and child `maxOutputBytes` behavior;
7. the main subagent suite has one stale assertion requiring the removed phrase “output budget”;
8. the root quality gate currently fails on one unused helper, `terminalProgressPhase`.

The architecture marker in `idea.md` should remain planned/not-implemented until durable v2 integration, docs, and all closure gates are green.

## Scoring

The plan has **49 leaf scoreable units**, S0.1 through S9.8.

- VERIFIED = `1.0`
- PARTIAL = `0.5`
- MISSING/BROKEN/BLOCKED = `0.0`

Current totals:

- VERIFIED: **31**
- PARTIAL: **12**
- MISSING: **5**
- BROKEN: **1**
- BLOCKED: **0**
- Score: **37.0 / 49 = 75.5102...% -> 75.5%**

## Stage summary

| Stage | Score | Status |
|---|---:|---|
| S0 — Baseline/contracts | **2.5 / 3** | Core contract frozen; final categorized symbol ledger still incomplete |
| S1 — Artifact store | **4.0 / 4** | **Verified** |
| S2 — Read path | **4.0 / 4** | **Verified** |
| S3 — Result integration | **4.0 / 4** | **Verified** for ordinary child/writer terminal output |
| S4 — Remove final-answer byte controls | **5.0 / 5** | **Verified**; hook capture bound intentionally remains |
| S5 — Remove byte admission | **4.5 / 5** | Core removal verified; aggregate presentation value/testing not reconciled to plan |
| S6 — Artifact lifecycle | **2.0 / 5** | Single-run release verified; batch/writer mostly wired; durable v2 absent |
| S7 — Always-managed launches | **4.5 / 5** | Runtime/schema migration verified; user docs/changelog still stale |
| S8 — Migration/UI/RPC/docs | **3.0 / 6** | Legacy normalization/RPC migrated; durable v2/UI/docs incomplete |
| S9 — Closure verification | **3.5 / 8** | Many focused suites green, but main suite and root gate currently red |

## Coverage ledger

| ID | Plan unit | Status | Score | Current evidence | Exact remaining work |
|---|---|---|---:|---|---|
| S0.1 | Record/classify current symbol inventory | PARTIAL | 0.5 | Current audit categorizes removed/output/hook/legacy symbols, but no final maintained forbidden-symbol ledger exists. | Finish categorized S9.8 sweep after migration; explain every intentional legacy/hook/provider occurrence. |
| S0.2 | Freeze v2 output types/constants | VERIFIED | 1.0 | `ice-subagent-output-artifacts.ts` defines fixed host limits, pathless v2 ref, capture states, output/read contracts. | - |
| S0.3 | Add inverse large-output regressions | VERIFIED | 1.0 | Ordinary and writer large-output regressions exist; output/result and writer-focused files run successfully apart from the unrelated stale core assertion. | - |
| S1.1 | Create focused output-artifact module | VERIFIED | 1.0 | `packages/coding-agent/src/ice-subagent-output-artifacts.ts` owns output storage/read/integrity behavior. | - |
| S1.2 | Opaque ID + owner-aware registry | VERIFIED | 1.0 | Store generates opaque UUID refs, owner-checks lookups, public artifact ref has no path. | - |
| S1.3 | Actual-byte storage accounting | VERIFIED | 1.0 | Store enforces actual stored-byte owner/global limits at capture; no launch reservation API exists. | - |
| S1.4 | Safe release/orphan primitives | VERIFIED | 1.0 | Store implements release, durable registration primitive, restore-finalization primitive and safe disposal; focused artifact tests pass. | Production durable wiring is scored under S6.4/S6.5. |
| S2.1 | Final-answer materializer | VERIFIED | 1.0 | Materializer implements inline-complete/artifact-complete/artifact-truncated/artifact-unavailable with redaction and UTF-8-safe bounds. | - |
| S2.2 | Add `read_subagent_output` tool | VERIFIED | 1.0 | Schema `ice-subagents.ts:11005-11018`; tool is registered at session setup and accepts opaque ID + byte range only. | - |
| S2.3 | Owner + integrity checks | VERIFIED | 1.0 | Cross-owner/unknown lookups fail closed; read path verifies file size/hash/type and rejects path authority. | - |
| S2.4 | UTF-8 pagination | VERIFIED | 1.0 | Store validates byte boundaries and returns authoritative next offset; focused artifact tests pass. | - |
| S3.1 | Capture terminal final answer only | VERIFIED | 1.0 | Ordinary terminal result paths use v2 output; partial provider/runtime evidence is not represented as a complete terminal artifact. | - |
| S3.2 | Split structured parser bound from retention | VERIFIED | 1.0 | Structured parsing is fixed-host bounded independently from output storage; no streaming output-byte abort remains. | - |
| S3.3 | Update `verifySubagentResult` | VERIFIED | 1.0 | Verification uses output completeness/materialization independently of removed caller cap; result-contract tests pass. | - |
| S3.4 | Writer result integration | VERIFIED | 1.0 | `ice-writer-w5.test.ts:177-255` proves no writer maxOutputBytes input, pathless v2 final-output artifact, and independent patch artifact. | - |
| S4.1 | Remove streaming `output_truncated` control | VERIFIED | 1.0 | Output length no longer owns a child abort/control race; long final-output tests reach terminal handling. | - |
| S4.2 | Remove child execution `maxOutputBytes` | VERIFIED | 1.0 | New execution schema/normalization rejects removed final-answer cap. | - |
| S4.3 | Remove profile/settings final-answer cap | VERIFIED | 1.0 | Profile/settings child final-answer aliases are removed/rejected; command-hook `maxOutputBytes` remains intentionally separate. | - |
| S4.4 | Remove writer `maxOutputBytes` input | VERIFIED | 1.0 | Writer schema omits field and normalizer rejects legacy call input; writer test asserts this. | - |
| S4.5 | Remove retry output-budget arithmetic | VERIFIED | 1.0 | Recovery path no longer subtracts remaining final-answer bytes. | - |
| S5.1 | Delete batch/review `totalBudgetBytes` API | VERIFIED | 1.0 | Closed schemas omit field; compatibility guard rejects removed input. | - |
| S5.2 | Delete batch output ledger/reservation | VERIFIED | 1.0 | No production `SubagentBatchBudgetLedger`; scheduler uses concurrency/admission rather than output reservations. | - |
| S5.3 | Remove batch/review budget projections | PARTIAL | 0.5 | Output-budget result/preflight projection is gone, but current aggregate presentation uses 16 KiB while plan specifies 32 KiB and no explicit 8-child presentation-cap closure test was found. | Choose/document one fixed value (16 KiB is safer if intentional) and add deterministic aggregate presentation test. |
| S5.4 | Remove durable planned/reserved output admission | VERIFIED | 1.0 | `plannedOutputBytes`/`reservedOutputBytes` remain only in legacy persisted decode/normalization; no new reservation admission. | - |
| S5.5 | Replace mixed job budget inspection with scheduling state | VERIFIED | 1.0 | Durable inspection uses active/queued scheduling state rather than output-byte reservation budget. | - |
| S6.1 | Process-local single-run retention/delete lifecycle | VERIFIED | 1.0 | `releaseOutputArtifact` + `forgetRetainedManagedResult` at `ice-subagents.ts:7832-7846`; eviction, resume supersession and delete route through it. Test `ice-subagents.test.ts:1306-1403` proves old artifact becomes unreadable on resume/delete. | - |
| S6.2 | Managed batch/review artifact lifecycle | PARTIAL | 0.5 | Aggregate owns references via `outputArtifactIds`; pruning/shutdown release them (`ice-subagents.ts:13144-13164,16247-16248`). Test `1410-1484` proves child deletion does not invalidate aggregate-owned artifact. | Add explicit aggregate eviction/prune test proving final owner release makes artifact unreadable; add planned multi-child presentation/lifetime case. |
| S6.3 | Managed writer artifact lifecycle | PARTIAL | 0.5 | `releaseManagedWriterOutput` and pruning/shutdown release text output without touching patch artifact (`ice-subagents.ts:13227-13243,16238-16239`). | Add deterministic prune/eviction read-after-release test and explicit no-cross-delete regression for patch artifact. |
| S6.4 | Durable v2 result persistence/rehydration | MISSING | 0 | `SubagentJobResultEnvelope` still has legacy `reportArtifact?: SubagentReportArtifact` (`ice-subagent-jobs.ts:135`) and no `output?: SubagentOutput`; production has no caller of `registerDurable()` or `finalizeRestore()`. | Persist/validate/clone v2 output, restore terminal refs into shared store, call finalizeRestore only after durable restore, preserve interrupted/no-replay semantics. |
| S6.5 | Durable retention expiry for v2 | MISSING | 0 | Durable v2 ref is not persisted, so 32-record retention cannot release v2 artifact/accounting. | Release v2 store reference on durable full-result eviction while retaining safe v1 legacy cleanup. |
| S7.1 | Remove `background` schema fields | VERIFIED | 1.0 | Current delegate/writer/batch/review schemas contain no background property; `ice-subagents.test.ts:8658-8673` asserts rejection. | - |
| S7.2 | Delete synchronous delegate branch | VERIFIED | 1.0 | `ice-subagents.ts:14789-14825` returns at managed-handle admission; no `params.background` branch exists. | - |
| S7.3 | Delete synchronous batch/review branches | VERIFIED | 1.0 | Batch returns accepted handle at `:15691-15710`; review at `:15959-15979`; no synchronous opt-out remains. | - |
| S7.4 | Delete synchronous writer branch | VERIFIED | 1.0 | Writer returns accepted handle after admission/preflight (`:13749-13771`); W5 helper explicitly waits later for terminal result. | - |
| S7.5 | Remove stale synchronous guidance/examples | PARTIAL | 0.5 | Runtime descriptions/tests migrated, but `docs/subagent-user-guide.md:20` and `CHANGELOG.md:163` still tell users `background:false` exists. | Remove stale docs/changelog wording and describe always-managed flow. |
| S8.1 | Normalize legacy durable output fields | VERIFIED | 1.0 | Legacy planned/reserved output fields are decode/normalization-only and removed from new records. | - |
| S8.2 | Keep legacy v1 artifact validator internal-only | PARTIAL | 0.5 | v2 refs are pathless, but durable envelope still carries v1 `reportArtifact` and formatter exposes `reportArtifact.path` at `ice-subagents.ts:11527`. | Make v1 path object legacy decode/cleanup-only; never render path; new durable output must use v2. |
| S8.3 | Update Observatory/TUI | PARTIAL | 0.5 | Reservation-budget projection is gone, but durable v2 captureStatus/stored-byte/availability metadata cannot be projected until S6.4 exists. | Add bounded v2 terminal materialization metadata after durable integration; no content/path. |
| S8.4 | Update RPC settings/schemas | VERIFIED | 1.0 | Child `ice.subagents.defaults.maxOutputBytes` RPC setting is removed; current tool schemas reject `background`; output read remains through normal owner-scoped tool execution. | - |
| S8.5 | Update docs/changelog | MISSING | 0 | User guide/settings docs still contain child `maxOutputBytes`; user guide/changelog still contain `background:false`; no `read_subagent_output` guide entry found. | Migrate docs/changelog, preserve hook-output cap documentation, document handle -> inspect -> optional read flow and fixed host limits. |
| S8.6 | Mark architecture implemented only after verification | MISSING | 0 | `idea.md` correctly remains planned because durable migration and closure are incomplete. | Flip only after all required gates pass. |
| S9.1 | Focused artifact/result/security suite | VERIFIED | 1.0 | In fresh 4-file run, artifact store + result-contract + jobs pass; only failure is a stale assertion in the broad `ice-subagents.test.ts`. | - |
| S9.2 | Single-child/readiness/recovery closure | PARTIAL | 0.5 | Delegate/readiness focused files pass and lifecycle release is implemented, but broad core file is currently 1 test red because it still requires removed “output budget” wording at `ice-subagents.test.ts:698`. | Update stale assertion to the new no-output-budget contract and rerun. |
| S9.3 | Batch/review scheduler closure | PARTIAL | 0.5 | Scheduler/handle behavior is implemented and adversarial matrix passes; broad core file currently red and S6.2 aggregate-eviction closure test is missing. | Add aggregate eviction/presentation test, fix stale core assertion, rerun. |
| S9.4 | Durable jobs/restart/retention closure | PARTIAL | 0.5 | Current jobs test file passes, but it cannot verify absent durable v2 persist/re-register/retention behavior. | Implement S6.4/S6.5 and add restart/tamper/retention v2 fixtures. |
| S9.5 | Writer closure suite | PARTIAL | 0.5 | Fresh writer suite passes and handle-only writer path is present; explicit output-artifact prune/release/no-cross-delete regression still missing. | Add S6.3 lifecycle regressions and rerun writer matrix. |
| S9.6 | Settings/profile/hook/RPC/Observatory closure | PARTIAL | 0.5 | Fresh 9-file matrix passes **119/119**; durable Observatory v2 metadata remains incomplete. | Finish S8.3, then rerun same matrix. |
| S9.7 | Root check with npm 12.0.2 | BROKEN | 0 | Fresh `corepack npm@12.0.2 run check` exits 1: Biome reports unused `terminalProgressPhase` at `ice-subagents.ts:11748`. | Remove/use the stale helper and rerun full root gate. |
| S9.8 | Final forbidden-symbol audit + coverage ledger | MISSING | 0 | Durable v1 path, stale docs, legacy compatibility fields and incomplete durable store wiring remain; final closure sweep cannot pass. | Run categorized final sweep only after S6-S8 completion and explain allowed hook/provider/legacy decoder occurrences. |

## Findings

### High — durable jobs still use legacy output persistence

`packages/coding-agent/src/ice-subagent-jobs.ts:135` still stores:

```ts
reportArtifact?: SubagentReportArtifact;
```

There is no durable `SubagentOutput` field. The v2 store already implements `registerDurable()` and `finalizeRestore()`, but repository search finds **no production caller**. This is the largest architectural gap because durable output is the only artifact path that must survive process restart.

### High — closure gates are currently red

Fresh verification found two failures:

1. Broad subagent matrix: **333/334 passed**. The single failure is `packages/coding-agent/test/ice-subagents.test.ts:698`, whose regex still requires the removed words `output budget` in `manage_subagent` guidance.
2. Root gate: `corepack npm@12.0.2 run check` fails on unused `terminalProgressPhase` at `packages/coding-agent/src/ice-subagents.ts:11748`.

These are small fixes, but until rerun successfully S9.2/S9.3 and S9.7 cannot be marked verified.

### Medium — process-local lifecycle is substantially better than the prior audit

The prior audit incorrectly said retained result, batch, and writer release were unwired. Current HEAD now has:

- single result release helper and exact delete/evict/resume wiring;
- independent aggregate reference ownership and batch prune/shutdown release;
- writer prune/shutdown release separate from patch artifacts.

S6.1 is now verified. S6.2/S6.3 remain partial only because the plan's explicit eviction/no-cross-delete verification cases are not yet present.

### Medium — handle-only launch migration is implemented, docs are not

Current source contains no launch `background` property or `params.background` branch. Schema tests reject the field, and delegate/batch/review/writer all return accepted handles.

However:
- `packages/coding-agent/docs/subagent-user-guide.md:20` still instructs users to set `background: false`;
- `packages/coding-agent/CHANGELOG.md:163` still documents synchronous `background:false`.

This is documentation drift against current runtime.

### Medium — legacy report path remains visible

`packages/coding-agent/src/ice-subagents.ts:11527` still formats the absolute v1 `reportArtifact.path`. The v2 public contract is pathless, but the migration is not complete until v1 path-bearing data is decode/cleanup-only.

### Medium — docs still advertise removed child output controls

The user guide still contains child `execution.maxOutputBytes` examples (`subagent-user-guide.md:32` and others), while runtime now rejects that input. `read_subagent_output` is not documented. The command-hook `maxOutputBytes` entry is separate and should remain.

### Low/plan reconciliation — aggregate presentation is 16 KiB, plan says 32 KiB

The current formatter uses a stricter 16 KiB aggregate/result presentation bound. This is safe, but the plan explicitly froze 32 KiB. Choose one deliberate contract, document it, and add the multi-child cap test rather than leaving an unexplained mismatch.

## Verification performed

### 1. Artifact/result/core/jobs matrix

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run \
  test/ice-subagent-output-artifacts.test.ts \
  test/ice-subagent-result-contract.test.ts \
  test/ice-subagents.test.ts \
  test/ice-subagent-jobs.test.ts
```

Result: **FAIL — 3 files passed, 1 file failed; 333/334 tests passed.**

Only failure:

```text
test/ice-subagents.test.ts:698
expected manage_subagent description to match
/preserves run ID.*model.*profile.*scope.*tool authority.*output budget/i
```

The runtime description correctly omits the removed output-budget concept. The test assertion is stale.

### 2. Delegate/readiness/writer/settings/profile/hook/Observatory/RPC/adversarial matrix

```bash
node ../../node_modules/vitest/dist/cli.js --run \
  test/ice-delegate-mvp.test.ts \
  test/ice-subagent-readiness.test.ts \
  test/ice-writer-w5.test.ts \
  test/ice-subagent-settings.test.ts \
  test/ice-subagent-profile-controls.test.ts \
  test/ice-subagent-command-hooks.test.ts \
  test/ice-subagent-observatory.test.ts \
  test/rpc-settings.test.ts \
  test/ice-subagents-adversarial.test.ts
```

Result: **PASS — 9 files, 119/119 tests.**

### 3. Root repository gate

```bash
corepack npm@12.0.2 run check
```

Result: **FAIL**.

Biome checked 1169 files and stopped on one warning promoted to failure:

```text
packages/coding-agent/src/ice-subagents.ts:11748:10
lint/correctness/noUnusedVariables
terminalProgressPhase is unused
```

No automatic fixes were applied.

## Plan gaps / clarifications discovered during audit

### 1. Shared store instance must own durable restoration

Ordinary output capture and `read_subagent_output` already use the same production `outputArtifacts` instance. Durable restore must register refs into that **same** store before calling `finalizeRestore()`; a second store would make valid persisted refs unreadable.

### 2. Reference ownership is already necessary for aggregates

The batch implementation now demonstrates why a simple “delete artifact when child disappears” rule is wrong: the aggregate adds its own reference, so deleting the child must leave aggregate output readable. Durable ownership should use the same explicit-reference principle.

### 3. Hook output caps remain unrelated

Remaining command-hook `maxOutputBytes` is intentional. The final forbidden-symbol audit must classify it rather than remove it.

### 4. Decide 16 KiB vs 32 KiB explicitly

Current implementation uses 16 KiB for aggregate/presentation formatting. Prefer retaining 16 KiB unless measured context needs justify 32 KiB, then update the plan/docs/tests to the chosen constant.

## Next-agent fix queue

1. **Repair the two current verification failures**
   - Update `ice-subagents.test.ts:698` so it verifies preserved run/model/profile/scope/tool authority **without requiring the removed output-budget phrase**.
   - Remove or use `terminalProgressPhase` at `ice-subagents.ts:11748`.
   - Verify: rerun the 4-file matrix and `corepack npm@12.0.2 run check`.
   - Dependency: none.

2. **Persist and restore durable v2 output**
   - Add bounded `output?: SubagentOutput` to `SubagentJobResultEnvelope`.
   - Clone/validate/persist pathless v2 metadata.
   - When terminal durable output is retained, register its durable reference in the shared store.
   - During restore, re-register all valid retained terminal v2 refs, then call `finalizeRestore()`.
   - Keep nonterminal restart behavior interrupted/no-replay.
   - Verify terminal artifact survives registry/process reconstruction and tampered/missing artifact becomes unavailable without rewriting historical execution status.

3. **Implement durable v2 retention release**
   - Release the v2 artifact reference/accounting when the existing 32-full-result retention evicts it.
   - Keep v1 path cleanup as legacy-only behavior.
   - Add 33rd-result eviction regression and restart retention test.
   - Depends on item 2.

4. **Finish legacy-v1 public projection cleanup**
   - Stop rendering `reportArtifact.path`.
   - Restrict v1 path data to decode/validation/cleanup internals.
   - New durable results use v2 output only.
   - Verify user/model/RPC projections contain no absolute artifact path.
   - Depends on item 2 for final durable shape.

5. **Close batch/writer lifecycle verification**
   - Batch: force retained aggregate eviction/prune and prove artifact becomes unreadable after final reference releases.
   - Writer: force managed-writer prune and prove textual output releases while writer patch artifact remains valid.
   - Add multi-child aggregate presentation-cap regression.
   - Reconcile/document 16 KiB vs 32 KiB.
   - Depends on current code only.

6. **Finish durable Observatory projection**
   - Project capture status, inline/stored byte counts, artifact availability/truncation only.
   - Never project artifact content/path.
   - Verify Observatory/RPC snapshots.
   - Depends on item 2.

7. **Migrate user docs and changelog**
   - Remove child final-answer `maxOutputBytes` examples while preserving command-hook output-capture limit docs.
   - Remove `background: false` instructions/history that describe it as current behavior.
   - Document always-managed launch flow: handle -> inspect/manage -> optional `read_subagent_output`.
   - Document fixed host limits, process-local vs durable retention, and v1 legacy behavior.
   - Record chosen aggregate presentation bound.
   - Depends on final decisions from items 2-6.

8. **Run final closure / forbidden-symbol audit**
   - Rerun all focused matrices.
   - Run `corepack npm@12.0.2 run check`.
   - Categorize every remaining occurrence of `background`, child/writer final-answer `maxOutputBytes`, `totalBudgetBytes`, `plannedOutputBytes`, `reservedOutputBytes`, `reportArtifact.path`, `registerDurable`, `finalizeRestore`, and hook/provider output caps.
   - Update `idea.md` from planned to implemented only after every gate is green.

## Blockers

No external blocker was found.

Remaining blockers are in-repository:

- durable v2 persistence/restore/retention;
- legacy v1 public-path cleanup;
- durable Observatory output metadata;
- docs/changelog migration;
- missing batch/writer lifecycle closure tests;
- one stale subagent assertion;
- one root-check lint warning.

At **75.5%**, this plan is **not eligible** for Complete-remaining mode under the default strict `>85%` threshold.

## Workspace safety

The worktree was already one commit ahead of origin at audit start:

```text
881c9d261 feat(coding-agent): make managed subagent launches handle-only
```

The adjacent audit file was already modified when this audit began. This audit updated only that audit artifact. It did **not** reset, discard, clean, stage, commit, merge, push, or modify implementation source.
