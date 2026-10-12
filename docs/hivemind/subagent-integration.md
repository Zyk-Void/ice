# Hivemind Integration with ICE Subagents

> **Historical proposal.** Hivemind is not implemented. This document was written against the V1 `delegate` / `SubagentExecutor` contract, which Subagents V2 replaced. Do not use those names as current APIs; any future Hivemind work must be redesigned against the [current V2 guide](../../packages/coding-agent/docs/subagents-v2.md) and [architecture](../../packages/coding-agent/docs/subagents-v2-architecture.md).

**Status:** Unimplemented target; this proposal's V1 API assumptions are superseded.

## Dependency direction

```text
Ice core
  ^
  |
ICE subagent runtime
  ^
  |
ICE Hivemind
```

Hivemind depends on the subagent system. The subagent system must not depend on Hivemind.

A single `delegate` run must remain useful and testable when Hivemind is disabled.

## Prerequisites

Do not implement the full Hivemind coordinator before these subagent properties are proven:

- native child `AgentSession` lifecycle is deterministic;
- fresh child history is isolated from the parent;
- child resource discovery can be stripped;
- parent-active-tool intersection is enforced;
- `SubagentResult` and evidence contracts are stable;
- cancellation and timeout settle cleanly;
- bounded parallel read workers are reliable enough for controlled fan-out;
- usage/accounting can be aggregated without double counting.

## Atomic worker primitive

`delegate` remains the public primitive for one worker:

```text
Parent
  -> delegate(SubagentRequest)
      -> SubagentExecutor.run()
          -> child AgentSession
      -> SubagentResult
```

Hivemind should call the same internal `SubagentExecutor`, not simulate public tool calls.

```text
Parent
  -> hivemind(HiveRequest)
      -> HivemindCoordinator
          -> SubagentExecutor.run(task A)
          -> SubagentExecutor.run(task B)
          -> SubagentExecutor.run(task C)
      -> HiveResult
```

This provides one implementation of:

- role resolution;
- capability narrowing;
- model routing;
- child creation;
- cancellation;
- timeout;
- event capture;
- result normalization.

## Parent tool surface

Recommended eventual parent-facing tools:

```text
delegate   one bounded worker
hivemind   explicit bounded multi-worker run
```

Do not expose separate model-facing tools for queen election, worker membership, votes, memory mutation, topology changes, and task queues in the first release. Those are coordinator internals.

The `hivemind` tool should remain compact. Conceptual request:

```json
{
  "objective": "Review the subagent implementation",
  "strategy": "fanout",
  "tasks": [
    { "id": "architecture", "role": "explore", "task": "Trace control flow and invariants." },
    { "id": "tests", "role": "explore", "task": "Inspect test coverage and missing cases." },
    { "id": "security", "role": "review", "task": "Look for capability or trust boundary failures." }
  ],
  "consensus": "evidence_quorum"
}
```

The parent remains responsible for choosing those tasks. Automatic decomposition can be evaluated later and must not become a hidden second planner.

## Capability derivation

Each worker uses the same invariant as `delegate`:

```text
workerEffective
  = parentActiveTools
    ∩ roleAllowed
    ∩ subagentRuntimePolicy
    ∩ hiveTaskPolicy
```

For the first read-only Hivemind release, `hiveTaskPolicy` adds no tools. Workers remain capped to the proven read-only subagent surface.

Hivemind cannot grant:

- Bash;
- edit/write;
- network/MCP;
- credentials;
- Cognee or durable memory access;
- recursive `delegate`;
- another `hivemind` call.

## Role strategy

Do not begin with Ruflo-style catalogs of dozens of agents.

Use the existing small role vocabulary and vary the assignment:

```text
explore + architecture focus
explore + tests focus
explore + dependency focus
review  + security focus
review  + regression focus
review  + adversarial assumptions
```

This keeps privileges understandable and makes worker specialization primarily a prompt/task concern rather than a permission concern.

Trusted custom profiles can be added through the subagent V2 profile system later.

## Handoff rules

### Parent to worker

Each task gets only:

- explicit objective;
- role instructions;
- scope;
- selected context/artifact references;
- selected Hivemind board entries if dependency requires them;
- output/evidence contract;
- remaining per-task budget.

Never pass:

- full parent transcript;
- raw sibling transcript;
- all board state by default;
- arbitrary secrets;
- policy text that permits capability widening.

### Worker to Hivemind

Ingest only the bounded `SubagentResult` plus observed execution metadata.

The coordinator normalizes worker evidence into board claims. It does not trust worker-provided status, usage, or changed-path claims when those values can be measured independently.

## Shared board integration

Initial workers do not receive `hive_read` or `hive_publish` tools.

Instead:

1. worker A finishes;
2. coordinator normalizes A's evidence into typed board entries;
3. parent/coordinator selects relevant entries for dependent worker B;
4. B receives those entries in its bounded handoff packet.

This gives safe chain/pipeline behavior without a new child tool surface.

Later, if long-lived concurrent workers demonstrate a need for mid-run coordination, consider two scoped tools:

```text
hive_read     read selected run-scoped typed entries
hive_publish  publish bounded typed claim/evidence entry
```

They must be scoped to one hive ID, use schema validation, redact secrets, and remain unable to schedule work or change permissions.

## Events

Hivemind events should wrap existing subagent events rather than duplicate them:

```text
hive_created
hive_started
hive_task_scheduled
hive_task_completed
hive_task_failed
hive_claim_added
hive_decision_updated
hive_aggregating
hive_completed
hive_partial
hive_cancelled
hive_timed_out
```

Every task event references both `hiveId` and the underlying `runId`.

## Cancellation

Parent cancellation:

1. marks the hive cancellation-requested;
2. stops scheduling unscheduled tasks;
3. aborts every active `SubagentRun` through the existing runner;
4. waits for terminal settlement within a bounded shutdown window;
5. preserves already-settled results/evidence;
6. returns a bounded `cancelled`/`partial` aggregate according to policy.

No worker becomes detached merely because it was launched by Hivemind.

## Writer integration later

Writer hives are a separate milestone.

Required shape:

```text
parent
  -> HivemindCoordinator
      -> writer A -> worktree A -> patch A
      -> writer B -> worktree B -> patch B
  -> parent compares patches
  -> deterministic tests/verification
  -> parent applies/merges/rejects
```

Consensus can recommend a patch. It cannot merge or authorize the mutation.

## Stock Ice compatibility

Like `delegate`, Hivemind is ICE-owned functionality loaded through `ice`. Stock `ice` should not gain the Hivemind coordinator unless an upstream-neutral shared primitive is independently justified.
