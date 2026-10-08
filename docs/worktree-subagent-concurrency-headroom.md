# Subagent concurrency headroom

> **Historical implementation snapshot.** This note describes an earlier isolated worktree and legacy subagent scheduler, not current V2 behavior or limits. See the [Subagents V2 guide](../packages/coding-agent/docs/subagents-v2.md) and [reference](../packages/coding-agent/docs/subagents-v2-reference.md); treat branch, status, and source references below as historical evidence.

## Status and scope

This document describes the concurrency implementation visible in this worktree. It does not infer behavior from a branch name or commit history.

- Bundled default active-child concurrency: **4**.
- Bundled hard ceiling: **8**.
- Valid configured values: integers from **1 through 8**.
- The limit applies to read-only batch children and durable asynchronous jobs. A shared admission coordinator prevents those paths from exceeding the same effective ceiling when they run together.

The `.git` entry is present, but Git metadata was not available through the file-inspection tools used for this pass. Consequently, the branch name, exact `HEAD` SHA, and whether the pre-existing implementation files are committed or dirty are **not verified here**. No commit was made for this documentation change; the requested Markdown file is therefore an uncommitted worktree change at the end of this pass.

## Purpose and behavior

The feature raises the conservative batch/job default from 2 to 4 while retaining a small absolute maximum of 8. It is a bounded resource-admission feature, not a new planner or agent loop: Ice remains the authoritative reasoning and tool loop.

There are two layers of limits:

1. **Local scheduler limits.** A batch has a requested concurrency and a durable job registry has an active-job limit. The batch scheduler starts tasks in input order and the job registry promotes queued jobs in FIFO order.
2. **Shared admission.** When callers share a `SubagentConcurrencyAdmission`, every admitted child consumes one permit. A batch, a durable job, or a mixture of both cannot exceed that coordinator's cap. A release wakes waiting schedulers; wakeup callbacks are scheduling hints, not a second source of authority.

For a batch, tasks beyond local or shared capacity remain pending rather than starting. Cancellation, timeout, and fail-fast stop further admissions and mark not-yet-started tasks with a bounded status. Each finished task releases its permit and the scheduler pumps waiting work. Batch results retain deterministic input ordering, aggregate usage, and budget accounting.

For durable jobs, an accepted job is `created`/running if it gets a shared permit and `queued` otherwise. The default per-owner active-job limit is also 4, the queue limit is 8 jobs, and the owner aggregate planned-output reservation defaults to 256 KiB. A queued job is persisted before promotion. A `needs_time` managed run retains its permit until terminal settlement or cancellation, so resumed work cannot race with a newly admitted sibling. Persistence failure releases the permit and blocks further background scheduling in that registry.

## Configuration and precedence

The strict settings namespace is:

```json
{
  "subagents": {
    "concurrency": {
      "default": 4,
      "max": 8
    }
  }
}
```

`default` is the active-child count used when a batch or durable-job caller does not provide an explicit local concurrency. `max` is the effective shared admission ceiling. Both fields are optional; omitted values use 4 and 8 respectively. Parsing rejects unknown keys, non-integers, and values outside 1–8.

Settings are resolved as follows:

- Global values may raise the bundled default and cap, but never above 8.
- A trusted project value may only narrow the already selected global/bundled value. A lower project value wins.
- A trusted project value that attempts to raise either value is clamped and produces a diagnostic.
- Project concurrency settings are ignored when the project is untrusted and produce a diagnostic.
- If the selected default exceeds the selected cap, the default is clamped to the cap and its source is reported as `enforced`.

The RPC settings projection exposes `ice.subagents.concurrency.default` and `ice.subagents.concurrency.max` as integer fields with range 1–8, effective values, project override state, and project/global provenance. The interactive policy summary reports the resolved default, cap, source, and diagnostics. The setting fields are marked as not requiring restart, but the runtime coordinator is constructed at parent `agent_start`; the source does not show dynamic resizing of an already-created coordinator. Operators should verify a new session when changing the cap if live behavior matters.

## Architecture and API

### `ice-subagent-concurrency.ts`

#### `SUBAGENT_CONCURRENCY_LIMITS`

Constant limits object:

- `min`: 1
- `bundledDefault`: 4
- `hardCap`: 8

#### `resolveSubagentConcurrencyPolicy(input)`

Resolves a `ResolvedSubagentConcurrencyPolicy` from optional parsed global/project settings.

**Parameters:**

- `global` (`ParsedIceSubagentSettings | undefined`): Parsed global ICE settings.
- `project` (`ParsedIceSubagentSettings | undefined`): Parsed project ICE settings.
- `projectTrusted` (`boolean | undefined`): Whether project settings may participate. The pure resolver defaults this flag to `true`; the SettingsManager integration supplies the actual trust state.

**Returns:** `ResolvedSubagentConcurrencyPolicy` containing `defaultConcurrency`, `maxConcurrency`, source labels for each value, and redacted bounded diagnostics.

Example:

```typescript
const policy = resolveSubagentConcurrencyPolicy({
  global: parseIceSettings({
    subagents: { concurrency: { default: 6, max: 7 } },
  }).subagents,
  project: parseIceSettings({
    subagents: { concurrency: { default: 2, max: 3 } },
  }).subagents,
  projectTrusted: true,
});
// policy.defaultConcurrency === 2
// policy.maxConcurrency === 3
```

#### `SubagentConcurrencyAdmission`

A shared, synchronous permit counter.

- `constructor(maxActive: number)`: accepts only safe integers 1–8 and throws otherwise.
- `active` (`number`): current permits held.
- `capacity` (`number`): configured coordinator capacity.
- `tryAcquire()` (`boolean`): obtains one permit, or returns `false` at capacity.
- `release()` (`void`): returns one permit. Releasing without a held permit throws an invariant error.
- `onRelease(listener)` (`() => void`): registers a wakeup listener and returns an unsubscribe function. Listener errors are ignored because listeners are non-authoritative.

The caller owns release discipline. A permit is released exactly once by the batch or job lifecycle, including cancellation and persistence-failure paths.

### Batch integration (`ice-subagents.ts`)

`SubagentBatchRunOptions` accepts:

- `concurrency` (`number | undefined`): per-batch requested concurrency. It must be an integer from 1 through the effective policy cap.
- `concurrencyPolicy` (`ResolvedSubagentConcurrencyPolicy | undefined`): resolved default/cap; absent means bundled batch limits.
- `admission` (`SubagentConcurrencyAdmission | undefined`): shared coordinator; pass the parent coordinator to combine batches with durable jobs.

`runResolvedSubagentBatch(tasks, parentActiveTools, runner, options)` performs preflight, then admits at most both the requested local concurrency and the shared capacity. The public tool schemas cap a batch at 8 tasks and expose optional `concurrency`, `totalBudgetBytes`, `totalTokenBudget`, `timeoutMs`, and `failFast`. `review_batch` uses the same scheduler and admission path.

Batch lifecycle callbacks include `task_queued`, `task_admitted`, and `task_skipped`. A skipped task is never launched. `onEvent` remains an observation hook; it does not grant capacity.

Conceptual call:

```typescript
const result = await runResolvedSubagentBatch(tasks, parentTools, runner, {
  concurrency: 4,
  concurrencyPolicy: policy,
  admission: parentAdmission,
  totalBudgetBytes: 256 * 1024,
});
```

The task list itself is bounded to 1–8 unique identifier-bearing tasks. Output reservations and optional token reservations are checked before launch and reconciled from observed results. Those budgets are independent of concurrency.

### Durable-job integration (`ice-subagent-jobs.ts`)

`SubagentJobRegistry` accepts an optional `admission`. Its `maxActiveJobs` defaults to the resolved default (4) and cannot exceed 8; the shared coordinator is the final cross-path ceiling. `launch()` consumes a permit before persistence and queues when either local active capacity or shared admission is unavailable. `pump()` promotes the oldest queued job after a release. `inspect()` reports `ownerActiveJobs`, `ownerQueuedJobs`, and `ownerActiveJobsCap` when shared admission is enabled.

At parent startup, `ice-subagents.ts` resolves settings, constructs one `SubagentConcurrencyAdmission(policy.maxConcurrency)`, and passes it to the durable registry and batch calls. The same parent lifecycle also supplies `maxActiveJobs: policy.defaultConcurrency`. This is the key headroom boundary: a batch and a durable job in one parent session share permits rather than maintaining independent ceilings.

## Usage guidance

Use the default policy for ordinary read-heavy fanout. Set a lower project value for a repository or machine that needs less provider/process pressure. Use a higher value only in trusted global settings and only after local measurements; 8 is an enforced ceiling, not a performance recommendation.

A batch's explicit `concurrency` may be lower than the configured default for a single operation. It may not exceed the effective `max`, even though the schema's absolute maximum is 8. Durable jobs do not expose a separate per-call way to bypass the registry or shared cap.

For verification-only local scheduler measurements, the opt-in benchmark is:

```text
ICE_BENCH_CONCURRENCY=1 node ../../node_modules/vitest/dist/cli.js --run test/ice-subagent-concurrency.bench.test.ts
```

The benchmark uses eight simulated 20 ms, no-network child workloads and checks levels 1, 2, 4, and 8, including peak active children and sampled event-loop lag. It is skipped unless the environment variable is set and does not consume provider tokens.

## Verification evidence visible in this worktree

The following are static artifacts visible here; no test command was run during this documentation pass, so these are not claims of a passing execution:

- `packages/coding-agent/test/ice-subagent-concurrency.test.ts` covers bundled and configured policy resolution, global/project precedence, untrusted-project diagnostics, cap/default clamping, permit accounting, release wakeups, durable FIFO queueing, retained `needs_time` permits, cancellation, persistence failure, mixed job/batch admission, and combined concurrent batches.
- `packages/coding-agent/test/ice-subagent-concurrency.bench.test.ts` defines the opt-in provider-free benchmark described above.
- `packages/coding-agent/test/rpc-settings.test.ts` contains a static RPC projection case asserting global values 6/7, trusted project effective values 2/3, project provenance, and integer constraints 1–8.
- `packages/coding-agent/src/ice-subagents.ts` passes the resolved policy and shared admission into batch execution and creates the coordinator/registry at parent startup.
- `packages/coding-agent/src/modes/rpc/rpc-settings.ts` declares both settings fields and projects effective policy values.
- `packages/coding-agent/CHANGELOG.md` and `idea.md` record a representative benchmark result of approximately 160.2/82.2/41.3/20.8 ms at concurrency 1/2/4/8 with 0.00 ms sampled maximum event-loop lag. That result is recorded repository evidence, not independently rerun evidence from this pass.

The concurrency source header refers to `agent_docs/implementation/subagent-concurrency-headroom-plan.md`; that path was not present in the inspected worktree, so this document does not treat that missing plan as evidence.

## Limitations and follow-ups

- The benchmark is synthetic and local. It does not establish provider throughput, rate-limit safety, memory behavior, or a production latency guarantee.
- The hard cap is a process/session policy, not OS isolation, a provider quota, or a dollar-cost guarantee. Unsafe host execution remains a separate explicitly authorized path and is not made safe by this scheduler.
- Durable queue FIFO and per-batch input ordering are implemented, but there is no documented global fairness or starvation guarantee across multiple batch callers and durable-job registries sharing one coordinator.
- A coordinator's cap is fixed when the parent startup handler creates it. Although settings fields are presented as live/non-restart settings and batches resolve policy at invocation, the inspected code does not implement permit resizing or migration for an existing coordinator. A follow-up should define and test live-setting semantics.
- Admission is in-process and synchronous. Multiple parent processes or sessions do not share one coordinator, so aggregate host/provider pressure across sessions is outside this feature.
- Cancellation is best effort: already-running child work receives abort signals, while queued work is marked without being launched. Child/provider compliance with abort remains an executor concern.
- Queue and output limits remain independent controls. A task can be denied for batch budget, token budget, queue capacity, persistence, or policy even when a concurrency permit is available.
