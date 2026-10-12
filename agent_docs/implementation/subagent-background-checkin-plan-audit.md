# Final Repair Audit: Subagent Background Execution and Parent Check-In Implementation Plan

- Plan: `agent_docs/implementation/subagent-background-checkin-plan.md`
- Worktree: `/home/mewtwo/Zks/ice/.worktrees/all-worktrees-experimental`
- Branch: `integration/all-worktrees-experimental`
- Audited: 2026-09-23
- Independent-audit verdict before repair: **REPAIR REQUIRED**
- Fresh pre-repair completion: **92.6%** (`31.5 / 34`)
- Final completion after repair: **100.0%** (`34.0 / 34`)
- Fresh completion recheck: **100.0%** (`34.0 / 34`) on the current worktree snapshot; repaired integration trio **282/282**, lifecycle/durable **144/144**, routing/writer/RPC **109/109**, acceptance/adversarial **69 passed + 18 intentional skips**, root `check` exit 0 with `No fixes applied`
- Eligible for completion mode by default (`>85%`): **YES**
- Completion mode executed: **YES**
- User-authorized threshold override: **NOT USED**

## Verdict

**VERIFIED AFTER REPAIR.**

The previous 100% audit was not supported by the then-current regression evidence. An independent run found five failures in `ice-subagents.test.ts` and two failures in `ice-agent-view-integration.test.ts`, plus stale timeout/extension documentation and source guidance. A broader repair verification also exposed five foreground-assumption failures in `ice-subagent-readiness.test.ts`.

Those defects have now been repaired and rerun.

The final contract is:

- admitted managed children do **not** have a wall-clock lifetime deadline;
- elapsed time past the startup bound does not terminate an admitted child;
- explicit cancellation/stop remains the normal termination mechanism;
- child session **startup** deadline expiry is a startup **failure** with `diagnostic.code: "timeout"`, not a runtime `timed_out` terminal;
- historical `timed_out` / `needs_time` values remain in the shared vocabulary only for persisted/legacy compatibility and are documented as such;
- synchronous behavior-specific acceptance tests use `background:false` when they intentionally need to await the same child to completion;
- settings/profile documentation uses `startupTimeoutMs`, and current `manage_subagent` documentation contains no `extend` action.

## Scoring

The source plan has 34 leaf units, S0.1-S7.4.

Before repair, four units were not fully evidenced:

- S2.3 no-lifetime managed execution: PARTIAL (0.5)
- S5.3 writer stop/cleanup/startup-timeout contract: PARTIAL (0.5)
- S6.5 current docs/help wording: PARTIAL (0.5)
- S7.3 focused regression matrix: BROKEN (0.0)

All other units were verified.

```text
pre-repair = 100 * 31.5 / 34 = 92.647...% = 92.6%
final      = 100 * 34.0 / 34 = 100.0%
```

## Coverage ledger

| ID | Plan unit | Final status | Score | Evidence |
|---|---|---|---:|---|
| S0.1 | Separate execution/liveness/delivery states | VERIFIED | 1.0 | Typed coordinator state and check-in suite green. |
| S0.2 | Deterministic fake-clock scheduler/races | VERIFIED | 1.0 | `ice-subagent-checkin.test.ts` green in the 144-test lifecycle group. |
| S0.3 | Parent AgentSession delivery semantics | VERIFIED | 1.0 | `suite/agent-session-queue.test.ts` green. |
| S0.4 | Consumption/settlement acknowledgement | VERIFIED | 1.0 | Queue/check-in tests green; no model-prose acknowledgement. |
| S1.1 | Owner-scoped coordinator with generation/sequence guards | VERIFIED | 1.0 | Coordinator source + check-in tests. |
| S1.2 | Bounded/redacted typed notice | VERIFIED | 1.0 | Check-in/adversarial coverage green. |
| S1.3 | Existing AgentSession follow-up delivery | VERIFIED | 1.0 | Queue/check-in tests green. |
| S1.4 | Ack-based re-arm | VERIFIED | 1.0 | Fake-clock lifecycle coverage green. |
| S1.5 | Owner-unavailable coalescing | VERIFIED | 1.0 | Check-in/observatory coverage green. |
| S2.1 | Default non-blocking managed delegate | VERIFIED | 1.0 | Main integration suite 245/245 green. |
| S2.2 | Arm after live admission | VERIFIED | 1.0 | Main/check-in lifecycle tests green. |
| S2.3 | Remove managed lifetime expiry | VERIFIED | 1.0 | Repaired tests now explicitly prove survival beyond the former deadline followed by explicit cancellation; `ice-subagents.test.ts` 245/245 and agent-view integration 27/27. |
| S2.4 | Remove timeout-only management actions | VERIFIED | 1.0 | No `extend` in live `manage_subagent`; source fallback wording repaired; timeout-multiplexing suite green. |
| S2.5 | Completion/check-in race correctness | VERIFIED | 1.0 | Retained-run/check-in suites green. |
| S3.1 | Durable check-in interval persistence | VERIFIED | 1.0 | Jobs/durable-journal suites green; interval-only persistence contract is explicit in the plan. |
| S3.2 | Owner-only durable check-ins | VERIFIED | 1.0 | Jobs/check-in coverage green. |
| S3.3 | Restart interruption/no replay | VERIFIED | 1.0 | Durable journal/jobs suites green. |
| S3.4 | Completion inbox distinct from periodic state | VERIFIED | 1.0 | Jobs/observatory coverage green. |
| S4.1 | Background batch acceptance | VERIFIED | 1.0 | Main/concurrency suites green. |
| S4.2 | Sibling check-in coalescing | VERIFIED | 1.0 | Check-in/concurrency suites green. |
| S4.3 | Deterministic aggregate ordering | VERIFIED | 1.0 | Main/result-contract/concurrency suites green. |
| S4.4 | Review batch lifecycle | VERIFIED | 1.0 | Routing/result-contract/concurrency suites green. |
| S5.1 | Writer acceptance after isolation preflight | VERIFIED | 1.0 | W5/main integration suites green. |
| S5.2 | Writer isolation/base-commit check-in facts | VERIFIED | 1.0 | W5/observatory coverage green. |
| S5.3 | Writer stop/cleanup/startup contract | VERIFIED | 1.0 | Writer post-admission lifetime test migrated to explicit cancellation; writer startup deadline is consistently `failed + timeout diagnostic`; main 245/245 and W5 suite green. |
| S6.1 | Check-in interval settings resolution | VERIFIED | 1.0 | Settings suite green. |
| S6.2 | Startup-specific timeout naming | VERIFIED | 1.0 | Public settings/tool/profile surfaces use startup semantics; startup deadline result contract is now consistent for reader/writer. |
| S6.3 | Observatory/TUI advisory check-in state | VERIFIED | 1.0 | Observatory, bridge, footer, and agent-view integration suites green. |
| S6.4 | Typed RPC/JSON check-in details | VERIFIED | 1.0 | RPC JSON/settings/command-schema tests green. |
| S6.5 | Current docs/help/changelog/idea semantics | VERIFIED | 1.0 | `docs/settings.md` no longer advertises `extend` or profile `timeoutMs`; source fallback no longer says “extend”; profile example uses supported `startupTimeoutMs`. |
| S7.1 | Obsolete lifetime-supervisor behavior removed | VERIFIED | 1.0 | Supervisor has no lifetime timer/decision grace/extension path; compatibility statuses are documented as historical. |
| S7.2 | Timer/listener cleanup bounded | VERIFIED | 1.0 | Check-in/reuse-delete/agent-view suites green. |
| S7.3 | Focused regression matrix green | VERIFIED | 1.0 | 26 selected files: **594 passed, 18 skipped, 0 failed**. Repaired main/view/readiness suites reran together **282/282** after formatting. |
| S7.4 | Root repository gate green | VERIFIED | 1.0 | Final `corepack npm@12.0.2 run check` exit 0 with `Checked 1167 files ... No fixes applied`; pinned deps, imports, lockfiles, typecheck, browser smoke all passed. |

## Repairs made

### 1. Migrated stale lifetime-timeout tests

`packages/coding-agent/test/ice-subagents.test.ts`

- writer cleanup test now verifies an admitted writer survives beyond the startup deadline and terminates only after explicit cancellation;
- child deadline test now verifies an admitted reader survives beyond the startup deadline and terminates only after explicit cancellation;
- retained-child timeout test now verifies retained cancellation/history/delete behavior instead of waiting for a nonexistent lifetime timeout;
- startup-never-settles and late-startup tests now assert the explicit startup contract: `status: "failed"` plus timeout diagnostic.

`packages/coding-agent/test/ice-agent-view-integration.test.ts`

- controlled child now remains live beyond the former deadline until explicit cancellation;
- pending finalization turn likewise remains live and is explicitly cancelled;
- historical view status is `cancelled`, not `timed_out`.

### 2. Resolved startup-timeout status contract

`packages/coding-agent/src/ice-subagents.ts`

- startup control reason renamed internally from `timed_out` to `deadline_exceeded`;
- reader startup deadline now emits a startup failure rather than a runtime timed-out terminal;
- reader and writer startup deadline behavior is now consistent: `failed` with `diagnostic.code: "timeout"`;
- historical `timed_out` / `needs_time` compatibility is documented directly on `SubagentStatus`.

### 3. Removed stale extension/timeout guidance

`packages/coding-agent/src/ice-subagents.ts`

- retained-child fallback guidance now says inspect/peek/wait/follow up/stop; no “extend”.

`packages/coding-agent/docs/settings.md`

- removed live `manage_subagent.extend` documentation;
- explains bounded wait/detach and no lifetime deadline;
- changed profile example from `timeoutMs` to `startupTimeoutMs`;
- describes startup/output limits rather than lifetime timeout/output limits.

### 4. Reconciled background-default acceptance tests

The expanded matrix exposed five stale readiness tests whose assertions required child work to have completed immediately after `delegate` returned.

`packages/coding-agent/test/ice-subagent-readiness.test.ts`

Those behavior-specific tests now set `background:false`, which waits for the **same no-lifetime child** and is the supported compatibility path for tests that need synchronous prompt/MCP/fallback assertions.

## Verification performed

### Main repaired integration suite

```bash
node /home/mewtwo/Zks/ice/node_modules/vitest/dist/cli.js --run test/ice-subagents.test.ts
```

Result: **245/245 PASS**.

### Agent-view integration

```bash
node /home/mewtwo/Zks/ice/node_modules/vitest/dist/cli.js --run test/ice-agent-view-integration.test.ts
```

Result: **27/27 PASS**.

### Core lifecycle/durable group

8 files:

- `ice-subagent-checkin.test.ts`
- `suite/agent-session-queue.test.ts`
- `ice-subagent-settings.test.ts`
- `ice-subagent-timeout-supervisor.test.ts`
- `ice-subagent-timeout-multiplexing.test.ts`
- `ice-subagent-jobs.test.ts`
- `ice-subagent-durable-journal.test.ts`
- `ice-subagent-reuse-delete.test.ts`

Result: **144/144 PASS**.

### Batch/routing/writer/observability/RPC group

9 files:

- `ice-subagent-concurrency.test.ts`
- `ice-subagent-result-contract.test.ts`
- `ice-subagent-routing.test.ts`
- `ice-writer-w5.test.ts`
- `ice-subagent-observatory.test.ts`
- `ice-agent-view-bridge.test.ts`
- `subagent-footer.test.ts`
- `rpc-jsonl.test.ts`
- `rpc-settings.test.ts`

Result: **109/109 PASS**.

### Additional acceptance/adversarial/RPC group

7 selected files:

- `ice-subagent-profile-controls.test.ts`
- `ice-subagent-preflight.test.ts`
- `ice-subagent-capabilities.test.ts`
- `ice-subagent-readiness.test.ts`
- `ice-subagents-adversarial.test.ts`
- `rpc.test.ts`
- `rpc-command-schema.test.ts`

Result: **69 PASS, 18 SKIPPED, 0 FAIL** (6 files passed, 1 intentionally skipped).

### Post-format repair rerun

```bash
node /home/mewtwo/Zks/ice/node_modules/vitest/dist/cli.js --run \
  test/ice-subagents.test.ts \
  test/ice-agent-view-integration.test.ts \
  test/ice-subagent-readiness.test.ts
```

Result: **282/282 PASS**.

### Final repository gate

```bash
corepack npm@12.0.2 run check
```

Final result: **PASS, exit 0**.

```text
Checked 1167 files in 947ms. No fixes applied.
packages/coding-agent/npm-shrinkwrap.json is up to date.
packages/coding-agent/install-lock is up to date.
```

The gate also passed pinned dependency validation, TypeScript relative-import validation, shrinkwrap/install-lock validation, `tsgo --noEmit`, and browser smoke.

## Source and documentation sweep

Fresh searches after repair found:

- no startup test still expecting `status: "timed_out"`;
- no old post-admission “actual child deadline” timeout test;
- no agent-view timeout expectation for controlled/finalizing managed children;
- no `wait, extend` guidance in `ice-subagents.ts`;
- no `manage_subagent` documentation advertising `extend`;
- no profile example using `timeoutMs`;
- no startup control path using `startup.kind === "timed_out"` or resolving startup control to `"timed_out"`.

The remaining `timed_out` / `needs_time` members are compatibility vocabulary/projections and are explicitly documented as historical/persisted compatibility rather than current managed-run outcomes.

## Files changed by this repair

- `packages/coding-agent/src/ice-subagents.ts`
- `packages/coding-agent/docs/settings.md`
- `packages/coding-agent/test/ice-subagents.test.ts`
- `packages/coding-agent/test/ice-agent-view-integration.test.ts`
- `packages/coding-agent/test/ice-subagent-readiness.test.ts`
- `agent_docs/implementation/subagent-background-checkin-plan.md`
- `agent_docs/implementation/subagent-background-checkin-plan-audit.md`

No unrelated work was reset, cleaned, reverted, committed, merged, pushed, or published.

## Next-agent fix queue

None for this plan.

## Blockers

None for this plan.
