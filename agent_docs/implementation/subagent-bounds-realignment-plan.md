# Subagent Bounds Realignment Plan

Status: proposal for review (not implemented). Target: `packages/coding-agent` subagent bounding after the output-artifact rework landed on the working tree (pathless owner-scoped artifacts, removal of caller-facing byte budgets).

## Evidence base

Six harness references under `/home/mewtwo/Zks/ice/Agent_harness_references/` were audited for how they bound subagent execution: claude-code, opencode, claw-code, oh-my-pi, openhands, prime-agent. Consensus findings:

- No harness enforces a per-subagent token budget. Nothing is model-settable anywhere.
- No harness imposes a wall-clock lifetime timeout on a child (oh-my-pi has `task.maxRuntimeMs` but defaults it to 0 = disabled).
- Oversized final answers are universally handled by spill-to-disk plus a small inline preview: claude-code 50k chars inline threshold then full file + 2 KB preview; opencode 2,000 lines / 50 KiB then full file + path hint with 7-day sweep; oh-my-pi always writes the full untruncated artifact, keeps 500 KB / 5,000 lines inline (tail), and shows a 5,000-char preview with a pathless `agent://<id>` reference.
- Three of six keep some turn/iteration ceiling: claw-code 32 iterations hardcoded, oh-my-pi a soft request-budget ladder (default 200: steer at N, soft-stop at 1.5x, hard abort at 1.5x+5), openhands `max_iterations` fallback 500.
- Concurrency is essentially uncapped (claude-code, opencode, claw-code, openhands: none; oh-my-pi: 32/session plus 100 running jobs).
- No harness caps the prompt handed to a child.
- claw-code never cleans up spilled files; opencode sweeps after 7 days; oh-my-pi evicts terminal job rows after 5 minutes but keeps artifacts.

Where ICE is currently ahead of every reference (keep these): pathless hash-verified owner-scoped artifacts (others return raw filesystem paths), strict untrusted-input shape caps, fail-closed settings, deterministic queue admission, tombstoned retention expiry, and closed background-injection truncation gap (opencode's injected completion bypasses its own truncation).

Where ICE is behind (fix in this plan): inline projection far too small (8 KiB vs 50k chars), artifact cap 512 KiB where others keep everything, retention failure flips a completed result to verification_failed (others return content regardless), no run-shape ceiling at all after removing `maxTurns` (others keep a host-owned one), concurrency the strictest of all six with a benchmark mandate attached to its own constants, context-handoff caps the only ones in the field, plus leftover dead code and misleading `*_budget_exhausted` error codes from the removed budget admission.

## Non-goals

- Keep the pathless artifact design, owner scoping, symlink-safe verified reads, and bounded tombstones. Do not return raw filesystem paths to the model.
- Keep untrusted-input shape caps (roles, tags, output schema, acceptance criteria, evidence paths).
- Do not reintroduce caller- or model-settable budgets. All limits in this plan are host-owned; global settings may narrow, never raise beyond host constants (except where a benchmark justifies raising the bundled default).
- No second loop, no recursive delegation, no change to the single authoritative Ice loop.

## Phase 1 — Dead code and semantic debt (low risk, first)

1. Remove `SUBAGENT_BATCH_LIMITS.defaultBudgetBytes` ([ice-subagents.ts:618](../../packages/coding-agent/src/ice-subagents.ts)) — defined, referenced nowhere.
2. Rename error codes to match what they now enforce: `batch_budget_exhausted` -> `batch_admission_exhausted` (used for active managed-batch limit, result-ledger full, managed-writer limit) and `job_budget_exhausted` -> `job_admission_exhausted`. Update diagnostic mapping, TUI/observatory renderers, and tests.
3. Remove the dead legacy spill mechanism in `ice-subagents.ts`: `writeSubagentReportArtifact` (no src callers), `SubagentReportArtifact` type, `SUBAGENT_REPORT_ARTIFACT_LIMITS`, `reportArtifactRoot` option plumbing where it only serves legacy validation, and `removeRetainedReportArtifact`.
4. Simplify legacy durable-snapshot handling in `ice-subagent-jobs.ts`: strip `reportArtifact` (and `budget`) at normalize time and drop the `legacyReportArtifacts` map and round-trip re-persist. Old snapshots rewrite clean on next persist; legacy artifact files under the report root get a one-time best-effort sweep at restore.
   - Risk: sessions persisted by very old builds lose their legacy spill files. Accepted: content was already duplicated in normalized results, and `inlineTruncated` results remain addressable via the new artifact store only for new runs.
5. Verify `PersistedSubagentJobResultEnvelope` shrinks to `SubagentJobResultEnvelope` after step 4.

Tests: update `ice-subagent-jobs.test.ts` legacy-snapshot fixtures; add one asserting a v1 snapshot carrying `reportArtifact` normalizes and re-persists without it.

## Phase 2 — Final-answer presentation parity (main friction fix)

1. Raise the inline final-answer projection: `SUBAGENT_OUTPUT_ARTIFACT_LIMITS.inlineBytes` 8 KiB -> 48 KiB (matches claude-code's 50k-char threshold). Keep head-keeping (`truncateSubagentOutput` behavior) so the answer's opening survives inline; the artifact holds the full text.
2. Raise the per-artifact cap: `maxArtifactBytes` 512 KiB -> 4 MiB, and raise the matching guard inside `validateLimits` (it currently rejects configured caps above 512 KiB) so store construction still works. Owner cap (16 MiB) and global cap (128 MiB) unchanged; at 4 MiB artifacts the owner cap still bounds ~4 oversized answers, which is the intended pressure.
3. Retention-failure semantics: in the job registry `finishJob` path, stop downgrading `completed` -> `verification_failed` when `retainDurable` fails. Keep terminal status, keep the inline projection, keep the `output_artifact_unavailable` diagnostic, set `captureStatus: "artifact_unavailable"`. Rationale: claude-code returns the original block when persistence fails; artifact availability must stay distinct from verification (the changelog already claims this — the code currently contradicts it).
4. Raise batch/review presentation cap `SUBAGENT_BATCH_PRESENTATION_LIMIT_BYTES` 16 KiB -> 64 KiB, and ensure every batch/review task row carries its `output` projection (inline text + artifact id) so the parent can `read_subagent_output` full content per child rather than depending on the aggregate cap.

Tests: inline projection at 48 KiB boundary (UTF-8 safe cut, tail beyond), artifact at 4 MiB, retention-failure keeps `completed` + diagnostic (regression test), batch presentation at 64 KiB with per-row artifact ids.

## Phase 3 — Run-shape bounds: add the missing ceiling, remove the inconsistent one

1. Remove the enforced profile wall-clock timeout for all subagent paths. `profile.timeoutMs` (file-agent frontmatter, self default 120 s, `SUBAGENT_PROFILE_LIMITS` max 10 min) currently still kills non-managed runner paths; managed paths bypass via `noLifetimeTimeout`. Change: accept and record `timeoutMs` as advisory provenance (route snapshot / preflight digest), never enforce. Wrap-up reserve logic keys off the new setting below instead of the profile timeout.
2. Add host-owned defense-in-depth `ice.subagents.maxRuntimeMs` (settings namespace already exists; default 0 = disabled, exactly oh-my-pi's posture). When nonzero, an advisory wrap-up is injected at the reserve window and the child is aborted at the deadline; this covers provider stream hangs and runaway children without a mandatory lifetime cap. Global settings may set it; trusted project settings may only tighten.
3. Add the host-owned soft request-budget ladder (replaces the removed caller-facing `maxTurns` with something children cannot see or set): `SUBAGENT_REQUEST_BUDGET_LADDER = { defaultRequests: 300, softStopRatio: 1.25, hardAbortRatio: 1.5 }` applied to observed assistant requests per child run. At the default budget the host injects an advisory steering notice ("wrap up and produce your final answer"); free-running turns are soft-stopped at 1.25x; hard abort with a typed `request_budget_exhausted` status at 1.5x. Mirrors oh-my-pi's proven ladder with a more generous default; counts come from the already-observed turn telemetry. Not caller-settable; global settings may lower the default, never raise it.
4. Optional (recommend deferring unless review wants it): opencode-style doom-loop guard — three identical consecutive tool calls (same tool + serialized args hash) inject one steering notice. Cheap tail-risk win, but adds loop-state machinery; defer to a follow-up plan.

Tests: advisory `timeoutMs` recorded not enforced (child runs past old 10-min cap in a faux-provider test); `maxRuntimeMs` fires abort when set and is inert at 0; budget ladder steer/soft-stop/hard-abort transitions with bounded diagnostics; settings-narrowing semantics.

## Phase 4 — Concurrency and queue realignment (benchmark-gated)

1. Raise `SUBAGENT_CONCURRENCY_LIMITS`: `bundledDefault` 4 -> 8, `hardCap` 8 -> 24. The module's own design authority requires benchmark justification; run `packages/coding-agent/test/ice-subagent-concurrency.bench.test.ts` locally and record results in this plan file before landing. Evidence from references: oh-my-pi allows 32 concurrent spawns and 100 running jobs; claude-code and opencode impose no cap at all.
2. Raise `SUBAGENT_JOB_QUEUE_LIMIT` 8 -> 16 to keep queue headroom proportional to the new active default. Retention (32 terminal jobs) unchanged — references show no better scheme.
3. Keep trusted-project-narrowing semantics and the "project cannot raise global" clamp exactly as-is.

Benchmark record (2026-09-27, `ICE_BENCH_CONCURRENCY=1`, no network, no tokens; simulated 20 ms children, 8 tasks per level, warm pass per level; event-loop lag stays at 0.00 ms up through the bundled default of 8):

```
concurrency | wall ms | peak active | max event-loop lag ms
          1 |   163.5 |           1 | 0.00
          2 |    82.0 |           2 | 0.00
          4 |    41.1 |           4 | 0.00
          8 |    20.6 |           8 | 0.00
```

Wall time scales linearly down to the per-child work floor with no scheduler-induced lag at 8 active children. Note: the batch API is itself capped at 8 tasks (`SUBAGENT_BATCH_LIMITS.maxTasks`), so levels above 8 exercise the shared admission ceiling only through the durable-job path; a jobs-path bench remains future work.

Tests: existing concurrency policy tests updated for new constants; bench run recorded; queue admission at 16.

## Phase 5 — Context handoff relaxation

Raise, don't remove (keeps AGENTS.md bounded-injection compliance while removing the practical friction no other harness imposes):

- Context packet: `maxItemBytes` 8 KiB -> 32 KiB, `maxTotalBytes` 64 KiB -> 256 KiB.
- Fork handoff: `maxMessages` 32 -> 64, `maxMessageBytes` 8 KiB -> 32 KiB, `maxTotalBytes` 64 KiB -> 256 KiB.
- Combined packet/fork handoff budget: 64 KiB -> 256 KiB.
- Selected resources: `MAX_SELECTED_RESOURCE_BYTES` 64 KiB -> 128 KiB per file, `MAX_SELECTED_RESOURCES_BYTES` 256 KiB -> 512 KiB aggregate.

Tests: boundary tests at new caps; oversized-item rejection diagnostics unchanged.

## Phase 6 — Docs, changelog, verification

- `packages/coding-agent/CHANGELOG.md` under `[Unreleased]`: Changed (inline projection, artifact cap, presentation cap, concurrency defaults, advisory timeout), Added (request-budget ladder, `maxRuntimeMs`), Removed (enforced profile timeout, dead spill path, legacy report-artifact round-trip), Fixed (retention failure no longer flips completion).
- `idea.md`: bounds-realignment note under the subagent section distinguishing host-owned fixed bounds from removed caller budgets.
- `docs/subagent-user-guide.md` and `docs/settings.md`: new/renamed diagnostics, `ice.subagents.maxRuntimeMs`, request-budget telemetry.
- Verification: targeted vitest for touched files via `/usr/bin/node node_modules/vitest/vitest.mjs --run` (note: bare `node` is a vite-plus shim in this environment), then `./test.sh` for the non-e2e suite, then `corepack npm@12.0.2 run check` with both npm versions recorded. Land as small reviewable commits per phase; no commit without explicit user request.

## Risks

| Change | Risk | Mitigation |
|---|---|---|
| 48 KiB inline | More parent context consumed per delegation | Still 4x under claude-code's per-message aggregate; batch presentation cap separately bounds fanout |
| 4 MiB artifacts | Larger disk use per owner | Owner/global caps unchanged; retention release already wired |
| No enforced profile timeout | Old behavior change for file agents that relied on it | Advisory recording + `maxRuntimeMs` opt-in; changelog under Breaking-adjacent Changed |
| Request-budget ladder | Could steer legitimately long children | Default 300 requests is ~1.5x oh-my-pi's and far above observed normals; telemetry + diagnostics make it visible; settings can lower |
| Concurrency raise | Host resource pressure | Benchmark-gated per the module's own design authority; hard cap retained (24) unlike references |

## Open questions for the reviewer

1. Inline projection: 48 KiB (claude-code parity) vs a more conservative 32 KiB?
2. Hard concurrency cap: 24, 32, or remove entirely after the benchmark?
3. Doom-loop guard: in scope now or deferred?
4. Request-budget default: 300 requests, or align with oh-my-pi's 200?
5. Legacy durable-snapshot normalization: keep indefinitely (current) or time-box and drop in a stated release?
