# Timeout multiplexing for ICE subagents

> **Historical implementation snapshot.** This note describes the V1 timeout supervisor and `delegate*` APIs, not current V2 lifecycle/budget behavior. See the [current V2 guide](../packages/coding-agent/docs/subagents-v2.md) and [budget reference](../packages/coding-agent/docs/subagents-v2-reference.md).

## Scope and status

This document describes the timeout-supervision and managed-child behavior visible in the `subagent-timeout-multiplexing` worktree. It is documentation of the inspected implementation, not a proposal to add another scheduler or agent loop.

The feature has two related meanings:

1. **Managed single-child execution:** a parent can observe, retain, extend, resume, or stop several independently supervised child runs. Each run keeps its own timeout state and child session.
2. **Bounded batch execution:** `delegate_batch` and `review_batch` multiplex sibling tasks through a bounded scheduler. Batch timeout/cancellation controls queued and active tasks, while each task still runs through the same atomic child executor.

The child remains an ICE `AgentSession`; the supervisor owns timing and lifecycle control, not model reasoning. Child output remains evidence that the parent must verify and synthesize.

## Purpose and invariants

Timeout multiplexing addresses the case where a child reaches its initial execution/finalization budget while useful work is still in progress, or where the parent wants to stop waiting without creating a replacement child. The implementation preserves these invariants:

- one stable `runId` identifies the logical run;
- a retained run keeps the same child session, model, profile, scope, and effective tool authority;
- extending or detaching does not replay the initial prompt or silently widen capabilities;
- multiple retained children are independently addressable and do not share timeout state;
- a management wait expiring is not the same event as the child timing out;
- cancellation and terminal transitions are idempotent, and late child events cannot turn an explicit cancellation into success;
- terminal results are retained before lifecycle waiters are woken and are published at most once;
- timeout, cancellation, incomplete reports, and failed verification are not verified success.

## Lifecycle

### 1. Admission and running

`NativeSubagentRunner.runResolved()` creates the child session and, when a `SubagentRunSupervisorRegistry` is supplied, creates a supervisor for the normalized request. The supervisor starts an active-budget timer and exposes a launch-time `SubagentManagedHandle` (`runId`, and optionally `childSessionId`) through `onManagedHandle`.

A normal foreground call can await the final result. A managed foreground call (`delegate` with `background: true`) returns at admission while the same `runPromise` continues. Its eventual terminal result is retained and can be delivered through `onManagedResult` even if the launching caller stops awaiting the promise.

The supervisor records bounded runtime attention: phase, active elapsed/budget time, extension counters, remaining extension and retention budgets, recent tool activity, progress age, usage, and an optional repeated-failure advisory. Activity text is redacted and bounded; the advisory is informational and does not stop or steer the child.

### 2. Initial timeout: attention point

With supervision enabled, expiry of the active budget:

1. aborts the currently active child turn;
2. changes the supervisor to `awaiting_extension`;
3. records a bounded decision grace deadline;
4. preserves the same live session and bounded partial observation; and
5. exposes a `needs_time` result, which is nonterminal and pending verification.

The initial timeout is therefore a decision point for a managed run. If the supervisor is not enabled (for example, a directly constructed runner without a registry), the runner uses a hard control timeout and returns a terminal `timed_out` result instead.

If no decision arrives before the supervisor's decision grace period, the supervisor stops the run as `timed_out`. The production supervisor defaults visible in the source are a 120-second decision grace, a 10-minute maximum active/extension budget, and a separate two-minute detach-retention ceiling. The request/profile timeout is bounded by the public 1,000 ms to 600,000 ms range; the profile timeout is a default, not necessarily a hard ceiling when a larger request is allowed.

### 3. Parent decision

After `needs_time`, the owning parent can:

- **extend:** consume the run's remaining extension reserve and resume the same child;
- **detach:** stop blocking the parent. A running child continues in place; a paused child resumes under the separate retention pool;
- **wait/peek/inspect:** observe without changing the child budget or authority; or
- **stop:** abort and terminalize as cancellation.

An extension or retention continuation waits for the prior abort to settle before prompting the same session. A continuation may reach `needs_time` again, in which case the same decision process repeats until the applicable bound is exhausted.

### 4. Terminal completion and cleanup

A valid final report passes through the existing parent-side result verification path. On terminal completion or terminal failure, the runner stores the result before ending the supervisor state, invokes the terminal observer once, unsubscribes runtime observers, and cleans up the child session. Up to 32 retained terminal results are available for bounded post-terminal observation; older entries are evicted.

Terminal states are projected as `completed`, `failed`, `cancelled`, `timed_out`, or `verification_failed`. `needs_time` and `running` are nonterminal.

## APIs

### `SubagentRunSupervisor<TResult>`

Implemented in `packages/coding-agent/src/ice-subagent-timeout-supervisor.ts`. Constructor options include:

- `runId`, optional `childSessionId`, and positive `initialTimeoutMs`;
- required `abort`, `resume`, and `stop` callbacks;
- optional `maxTotalBudgetMs`, `maxRetentionMs`, `decisionGraceMs`, clock, and timer adapters;
- optional `onChange(snapshot)` for advisory presentation updates.

Important methods:

- `getSnapshot()` returns the frozen runtime snapshot.
- `waitForLifecycleChange(signal?)` waits for a state transition without polling and cleans up on transition or abort.
- `getTimeoutPromise()` resolves when the active budget reaches the attention point.
- `extend(additionalMs)` resumes from `awaiting_extension`, requiring an integer of at least 1,000 ms and no more than the remaining extension reserve.
- `retain(additionalMs)` resumes from `awaiting_extension` using the separate retention pool. The granted time is capped by remaining retention.
- `finish(result, status?)` stores a terminal callback result exactly once.
- `terminate(status?)` closes runner-owned terminal state without storing a callback result.
- `pauseForControlledWait()` / `resumeFromControlledWait()` pause/resume the active execution clock while controlled input is pending.
- `stop("cancelled" | "timed_out")` aborts and terminalizes idempotently, awaiting an in-flight continuation.
- `shutdown()` stops a nonterminal run as cancelled.

`SubagentRunSupervisorRegistry<TResult>` provides `register`, `get`, `list`, `remove`, and `shutdownAll`. The default registry capacity is 16 supervisors. The production factory supplies a registry; direct callers that omit one still get ordinary child execution but not the managed runtime API.

### `NativeSubagentRunner` management methods

Implemented in `packages/coding-agent/src/ice-subagents.ts`:

- `getRuntimeAttention(runId, parentSessionId)` returns bounded attention only for the owning parent.
- `peekRuntime(runId, parentSessionId)` returns a `SubagentManagedObservation` immediately. It is observational and does not consume budget. Terminal observations can come from the retained-result ledger after supervisor cleanup.
- `waitRuntime(runId, parentSessionId, waitMs, signal?)` waits event-driven for a running child to change state. `waitMs` must be 1–60,000 ms; the default exposed by the tool is 30,000 ms. A still-running child at the deadline is returned with `waitExpired: true`, not `timed_out`.
- `detachRuntime(runId, parentSessionId)` is idempotent. It retains a running child in place or resumes a paused child from the two-minute detach pool.
- `extendRuntime(runId, parentSessionId, additionalMs)` delegates to `extend` and only accepts an `awaiting_extension` child.
- `stopRuntime(runId, parentSessionId)` delegates to cancellation and returns the same retained terminal result on repeated calls.
- `followUpRuntime(runId, parentSessionId, requestId, message)` queues a bounded, untrusted follow-up through the existing child steering path. IDs are deduplicated; messages are limited to 8 KiB; follow-up is rejected outside a working, non-takeover state and cannot widen scope or tools.
- `getRetainedManagedResult` and `noteManagedTerminalResult` implement bounded, owner-scoped, exactly-once terminal retention.
- `shutdown()` stops all supervisors and clears owner, detached-run, follow-up, and retained-result state.

`SubagentManagedObservation` contains `runId`, `childState`, `terminal`, `waitExpired`, optional `attention`, and optional `result`. `SubagentManagedHandle` contains `runId` and optional `childSessionId`.

### Tool surface

`manage_subagent` accepts `runId` plus one of `peek`, `wait`, `inspect`, `extend`, `follow_up`, `detach`, or `stop`. `additionalMs` is bounded to at least 1,000 ms; `waitMs` is bounded to 60,000 ms; `requestId` and follow-up `message` are bounded. `extend` normally waits for the continuation, or returns immediately when `wait: false`.

The foreground `delegate` tool accepts `background: true`. It returns the managed handle as soon as admission is complete and instructs the parent to use `manage_subagent` rather than launching a duplicate. This option is distinct from `delegate_async`: the latter is the durable job API and has its own persisted job registry and owner/queue semantics.

### Batch APIs

`runResolvedSubagentBatch()` and `runResolvedReviewBatch()` use `SubagentBatchRunOptions`:

- up to 8 tasks;
- default concurrency 2, maximum 4;
- aggregate output budget default 256 KiB;
- optional aggregate token budget;
- optional positive batch `timeoutMs`, `signal`, `failFast`, and lifecycle/event callbacks.

The scheduler reserves output (and optional token) capacity before launching work, preserves input order, and invokes each task through `runResolved()`. Batch timeout or parent cancellation aborts active children and marks queued tasks without launching them. `failFast` stops queued work and aborts siblings after a task fails or fails verification. A batch does not replace the per-child supervisor; it multiplexes task scheduling around it.

## Cancellation, timeout, and recovery semantics

### Cancellation

The parent `AbortSignal` is composed into startup, prompting, child tool policy, and batch control. Cancellation before startup returns a partial `cancelled` result and late startup completion is aborted and shut down. Cancellation during a prompt aborts the child and returns a partial terminal result. A detached child remains tied to the launching parent signal; explicit `stop` or parent shutdown also cancels it.

`SubagentRunSupervisor.stop()` changes state to terminal before awaiting callbacks, invokes the child abort, waits for any in-flight resume/retention continuation, and returns the runner's terminal result. Concurrent and repeated stops are idempotent. An explicit cancellation or timeout classification owns the terminal status even if the aborted child later rejects with a generic error.

### Timeout and management-wait separation

There are three distinct clocks:

- the child active execution/finalization budget;
- the supervisor decision grace after an active-budget timeout; and
- the caller's bounded `manage_subagent` wait window.

Only the first can produce the supervisor attention point; the second can terminalize an undecided child as `timed_out`; the third only controls how long the management tool call waits. A management wait expiry returns the latest state with `waitExpired: true` and leaves a running child retained.

### Recovery

`runSubagentWithRecovery()` permits at most one retry after the initial attempt. It retries only an explicitly typed, retryable startup failure with no child session, no turns, no partial output, and no work artifact. It does not retry cancellation, timeout, verification failure, malformed results, policy/scope/trust/resource/auth failures, budget exhaustion, or child tool failures. The second attempt reuses the normalized request and stable run identity while reducing the remaining time/output budget; it is suppressed if a cancellation, timeout, or fail-fast stop gate is active.

A `needs_time` result is not terminal and is not published as a durable completion. It must be extended, retained, or stopped. Recovery and timeout supervision therefore do not create a fallback child or silently replay work.

## Usage examples

### Managed foreground launch

```typescript
const response = await delegate({
  role: "self",
  self: { instructions: "Inspect the approved scope.", capabilities: ["read", "grep", "find", "ls"] },
  task: "Map the relevant files and report evidence.",
  scope: { roots: ["src"] },
  timeoutMs: 120_000,
  background: true,
});

// Use the returned managed.runId with the same owning parent session:
await manage_subagent({ runId, action: "peek" });
await manage_subagent({ runId, action: "wait", waitMs: 30_000 });
await manage_subagent({ runId, action: "extend", additionalMs: 60_000 });
// Or: await manage_subagent({ runId, action: "detach" });
// Or: await manage_subagent({ runId, action: "stop" });
```

The exact tool wrapper supplies the parent session ID; callers of the runner APIs must supply it explicitly. A `wait` response with `waitExpired: true` should be followed by another observation or an explicit decision, not interpreted as child timeout.

### Direct runner setup

```typescript
const supervisors = new SubagentRunSupervisorRegistry<SubagentResult>();
const runner = new NativeSubagentRunner({
  agentDir,
  supervisorRegistry: supervisors,
});

const result = await runner.runResolved(normalizedRequest, parentActiveTools, {
  model,
  onManagedHandle: (handle) => recordHandle(handle),
  onManagedResult: (terminal) => recordTerminal(terminal),
});
```

To enable managed behavior, the runner must be given a supervisor registry (as the production ICE factory does). `normalizedRequest.timeoutMs` controls the initial child budget; management actions control later decisions.

## Visible verification evidence

No test or check command was run during this documentation-only inspection. The following repository-visible evidence was read and is reported with that limitation:

- `packages/coding-agent/test/ice-subagent-timeout-multiplexing.test.ts` visibly covers supervisor-state projection, lifecycle-waiter settlement, nonmutating peek, detach and wait, stable run/session identity, management wait expiry, parent ownership, wait bounds, two independent retained children, managed admission, abandoned launch promises, in-place retention, separate retention budget, exactly-once terminal publication, and idempotent cancellation.
- `packages/coding-agent/test/ice-subagent-timeout-supervisor.test.ts` visibly covers bounded tool calls, timeout defaults, `needs_time` and same-session extension, repeated resumed-turn interruption, controlled-wait accounting, durable-job nonterminal handling, UI extension/stop controls, and bounded activity/error enrichment.
- `packages/coding-agent/src/ice-subagent-timeout-supervisor.ts` contains the supervisor state machine, separate active/extension and retention budgets, event-driven lifecycle waiters, redacted activity snapshots, and idempotent stop/finish behavior.
- `packages/coding-agent/src/ice-subagents.ts` contains the runner management APIs, managed `delegate` admission path, `manage_subagent` schema/dispatch, batch scheduler, and recovery wrapper.
- `.ai-bridge/current-plan.md` records `COMPLETE — 100.0%`, a focused timeout/multiplexing matrix of `258/258` tests, and a passing exact root check. This is a visible project record, not an independently rerun result in this inspection; its cited audit path is outside this approved worktree and was not used as direct evidence.
- `task_plan.md` records the separate B1 bounded sibling-read fanout contract: up to eight tasks, concurrency bounds, reservation-before-launch, deterministic ordering, and cancellation/timeout handling. Its status statements are likewise project records rather than commands run here.

## Limitations and follow-ups

- Supervisor state and retained terminal results are in-memory in `NativeSubagentRunner`; they are not a restart-resumable durable record. Durable `delegate_async` jobs are a separate feature and do not make foreground managed runs durable.
- Detach retention is bounded to the configured two-minute pool and does not provide indefinite background execution. A child that remains undecided until decision grace/retention is exhausted becomes terminal rather than auto-resuming.
- Management is owner-scoped. A different parent session cannot peek, wait, extend, follow up, or stop the run, and supervisor capacity/result retention are bounded.
- Cancellation is best-effort at the underlying session/tool boundary. The implementation awaits the available child idle/continuation boundary, but it cannot guarantee containment of external host processes or detached descendants.
- A management wait is not a progress stream; callers must issue another bounded observation. Activity is intentionally limited to recent, redacted records.
- Timeout multiplexing does not add automatic fallback models, retries for timed-out work, duplicate replacement children, recursive delegation, consensus, or automatic result ingestion.
- Batch scheduling remains bounded and parent-owned; there is no unbounded queue, priority/fairness policy, background batch facade, or cross-job budget ledger in this feature.
- Parent verification remains mandatory. A completed child result is not automatically trusted, and a partial/timeout/cancelled result must not be presented as verified success.

## Commit boundary

The worktree's `.git` metadata was not readable through the available inspection tools, so the branch name, exact `HEAD` SHA, and porcelain status were not observable. The target document was not present in the initial visible file listing and is created by this task. No source, test, changelog, or other documentation file was intentionally modified by this task. A Git-capable parent should verify the final status and commit association; this document makes no claim that it is committed.
