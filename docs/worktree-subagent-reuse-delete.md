# ICE subagent reuse and delete

> **Historical implementation snapshot.** This note documents the legacy `NativeSubagentRunner` / `manage_subagent` lifecycle, replaced by V2's `agent` and `agent_control` APIs. See the [current V2 guide](../packages/coding-agent/docs/subagents-v2.md) and [architecture](../packages/coding-agent/docs/subagents-v2-architecture.md).

This document describes the foreground native subagent lifecycle implemented in the checked-out `packages/coding-agent` tree. It covers the retained-session registry used by `NativeSubagentRunner`, the `manage_subagent` facade, and the historical transcript projection. It does not describe durable background jobs or the separate isolated writer workflow.

## Purpose

A successfully completed foreground child is retained instead of immediately disposing its `AgentSession`. The parent can either:

- resume that exact child session with additional instructions, preserving its conversation history; or
- explicitly delete the retained child, releasing its session and removing its matching historical view snapshot.

The feature is deliberately bounded and fail-closed. Reuse is not a new launch: the original model, profile, scope, and tool set cannot be widened by a resume request. Every resume rechecks current parent authority and creates a new run identity for result lineage.

## Lifecycle

1. **Launch.** `NativeSubagentRunner.run()` normalizes a `SubagentRequest` and delegates to `runResolved()`. A fresh run creates one child session and installs a mutable execution-policy box used by the child tool, stream, and turn-stop wrappers.
2. **Terminal result.** The runner records a terminal status and registers a bounded historical snapshot with `IceAgentViewBridge` when a child session exists.
3. **Retention decision.** Only status `completed` is reusable. The exact child session, normalized request, selected tools, model, trust/host-execution state, and policy box are stored in the runner's retained registry. Failed and cancelled children are disposed rather than added as reusable handles; their view snapshots are history-only.
4. **List.** `listRetainedChildren(parentSessionId)` exposes bounded metadata filtered by owning parent session. It does not expose the session object or mutable runtime state.
5. **Resume.** `resumeRuntime()` validates ownership, completion, message bounds, reuse budget, current authority, and cancellation before claiming the handle. It removes the old handle while the run is in flight, re-points the same policy box at the new run, and invokes the same session with the new message. Successful completion republishes exactly one retained handle under a new run ID.
6. **Delete or eviction.** `deleteRetainedChild()` removes an owned terminal handle, removes its historical snapshot, awaits shutdown, and disposes the child. Adding a ninth retained child evicts the oldest handle and releases it. `shutdown()` awaits disposal of every remaining retained child and clears the registry.

A resume that fails before execution restores the retained handle. A resumed execution that reaches a non-completed terminal status is not re-retained, so a revoked or otherwise failed reuse cannot remain reusable.

## APIs

The APIs below are exported or public methods in `packages/coding-agent/src/ice-subagents.ts`.

### `NativeSubagentRunner.run(request, parentActiveTools, options?)`

Normalizes and starts a fresh foreground child. A successful completed result causes retention under the new run's ID.

**Parameters:**

- `request` (`SubagentRequest`): Role, task, scope, and optional execution/resource settings.
- `parentActiveTools` (`readonly string[]`): Tools currently active in the parent; delegation and child capabilities are narrowed against this set.
- `options` (`NativeSubagentRunOptions`): Parent-owned model, settings, trust, authority, hooks, MCP, cancellation, event, and budget inputs. This is the fresh-run surface.

**Returns:** `Promise<SubagentResult>` — the bounded structured child result.

### `NativeSubagentRunner.runResolved(normalized, parentActiveTools, options?)`

Runs an already normalized request. `resumeRuntime()` uses this method with a `resume` option internally; callers should normally use `run()` for a fresh request and `resumeRuntime()` for reuse.

**Returns:** `Promise<SubagentResult>` — the terminal or bounded partial result produced by the child runtime.

### `NativeSubagentRunner.listRetainedChildren(parentSessionId)`

Returns immutable, owner-filtered metadata for retained terminal children. The result is an array of `RetainedSubagentChild` values:

```typescript
interface RetainedSubagentChild {
  runId: string;
  role: string;
  terminalStatus: string;
  finishedAt: number;
  resumeCount: number;
}
```

**Parameters:**

- `parentSessionId` (`string`): Parent session identity used for ownership filtering.

**Returns:** `readonly RetainedSubagentChild[]` — frozen metadata; no child session or transcript is returned.

### `NativeSubagentRunner.resumeRuntime(runId, parentSessionId, message, parentActiveTools, options?)`

Continues a retained completed child in its original `AgentSession`.

**Parameters:**

- `runId` (`string`): Current retained handle ID.
- `parentSessionId` (`string`): Owning parent session ID. A different owner is rejected.
- `message` (`string`): Nonempty follow-up instruction, at most 8 KiB by UTF-8 byte length.
- `parentActiveTools` (`readonly string[]`): Current parent tool activation set. `delegate` must remain active, and previously authorized ordinary tools must still be active.
- `options` (`NativeSubagentResumeOptions`): Optional signal, model runtime, MCP runtime, hook-runtime factory, and `isAuthorityStillValidFor` callback. It intentionally omits `model`, `unsafeHostExec`, and `projectTrusted`; those values are reused from the retained child.

**Returns:** `Promise<SubagentResult>` — a new execution result with a new `runId` and `resumedFromRunId` set to the superseded handle ID.

### `NativeSubagentRunner.deleteRetainedChild(runId, parentSessionId)`

Forgets an owned retained terminal child and releases its session.

**Parameters:**

- `runId` (`string`): Retained handle to remove.
- `parentSessionId` (`string`): Owner identity required for deletion.

**Returns:** `Promise<{ runId: string; deleted: boolean }>` — `deleted: true` when the handle and session were removed; `false` for an unknown or already-forgotten handle. Active children and handles claimed by an in-flight resume are rejected with a stop-first diagnostic.

### `manage_subagent`

The model-facing lifecycle tool exposes these actions in `manageSubagentParameters`:

- `resume`: requires `runId` and `message`; forwards current parent active tools and parent-owned authority/hook checks to `resumeRuntime()`.
- `delete`: forwards `runId` and the current parent session ID to `deleteRetainedChild()` and returns an idempotent status message.
- `inspect`, `extend`, `follow_up`, and `stop`: remain live-runtime controls and are not substitutes for enumerating retained handles.

The schema bounds `runId` to 1–128 characters using `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`. Resume messages are bounded to 8 KiB by schema and runtime validation. Invalid arguments or lifecycle violations are returned as an error tool result with a redacted diagnostic.

## State, persistence, and observability

### Runner state

Retention is an in-memory `Map` owned by each `NativeSubagentRunner`; it is not a durable session store. Each retained entry contains the live session object and internal execution state, including the normalized request and mutable policy box. The map is cleared by `shutdown()`, and there is no restart recovery path for these live foreground sessions. Durable `delegate_async` jobs are a separate feature with separate persistence and must not be treated as reusable foreground sessions.

The limits are constants in `ice-subagents.ts`:

- at most **8 retained terminal children per runner**;
- at most **8 resume cycles per retained child** (`resumeCount` is carried to the replacement handle).

The oldest retained entry is evicted first. Eviction awaits `shutdownChildSession()`, which emits the child shutdown event and then calls `session.dispose()`.

### Historical views

Terminal cleanup registers a redacted, read-only historical snapshot with `IceAgentViewBridge`. A completed child is marked `retentionState: "reusable"`; other terminal results are marked `"history-only"`. Historical views are presentation state, not executable sessions. The bridge bounds them to 32 views and bounds copied messages to the most recent 96 messages, 16 KiB per message, and 256 KiB total message bytes.

Deletion calls `removeHistoricalSnapshot(runId)` for the deleted handle. A resume publishes a new snapshot for its new run ID; the old run's historical snapshot is not automatically deleted by `resumeRuntime()` and may remain as bounded read-only history until evicted. Historical views cannot be taken over or used to send input.

## Authority and persistence rules on resume

Before consuming a handle, `resumeRuntime()` fails closed when any of the following is true:

- the handle is missing, owned by another parent, non-completed, already being resumed, or over the reuse limit;
- the message is blank or exceeds 8 KiB;
- the parent no longer activates `delegate`;
- the parent cancellation signal is already aborted;
- the retained profile or resources no longer validate;
- unsafe host execution was retained but the project is no longer trusted or parent Bash is no longer active;
- a delegated tool was replaced/revoked, selected MCP authority changed, or a previously retained ordinary child tool is no longer active in the parent;
- the optional current settings/authority callback rejects the reconstructed request, including changed limits, deny policy, route, hooks, trust, or resource state.

The resumed request copies the retained scope, profile, resources, model, host-execution flag, and trust state. No resume parameter supplies a replacement model, profile, scope, or tool list. The effective tool policy additionally intersects retained tools with the current parent active tools. The retained session's wrappers read the shared policy box, which is re-pointed before the resumed prompt; if authority is revoked during the run, the wrapper fails closed at the next safe boundary. A thrown pre-start resume restores the old retained handle; a failed resumed execution is not republished.

A new run ID is intentional: result verification can preserve lineage through `resumedFromRunId` without treating a continuation as the original execution. The child conversation itself remains continuous because the same session and message history are reused.

## Usage and configuration

The ordinary user-facing entry point is the `manage_subagent` tool, when the delegation extension is loaded. A host integration can use the runner API directly:

```typescript
const retained = runner.listRetainedChildren(parentSessionId);
const handle = retained[0];

if (handle) {
  const continued = await runner.resumeRuntime(
    handle.runId,
    parentSessionId,
    "Re-check the finding and report only verified evidence.",
    currentParentActiveTools,
    { isAuthorityStillValidFor: () => currentPolicyStillAllowsReuse() },
  );

  // The new ID is continued.runId; the old ID is in continued.resumedFromRunId.
  await runner.deleteRetainedChild(continued.runId, parentSessionId);
}
```

Equivalent model-facing calls are:

```json
{
  "runId": "child-run-id",
  "action": "resume",
  "message": "Re-check the finding and report only verified evidence."
}
```

```json
{
  "runId": "child-run-id",
  "action": "delete"
}
```

Relevant settings remain the existing parent subagent settings. For example:

```json
{
  "ice": {
    "subagents": {
      "enabled": true,
      "defaults": {
        "timeoutMs": 120000,
        "maxTurns": 12,
        "maxToolCalls": 40,
        "maxOutputBytes": 24576
      },
      "restrictions": {
        "denyTools": ["bash", "edit", "write"]
      }
    }
  }
}
```

Settings and authority changes affect future work and can revoke a retained child's reuse at the resume boundary. They cannot be used by a resume request to grant new capabilities. Host execution remains opt-in and is not a sandbox.

## Visible verification evidence

The checked-out tree contains focused coverage in `packages/coding-agent/test/ice-subagent-reuse-delete.test.ts`. Its tests exercise:

- completed-child retention without disposal;
- same-session continuation, preserved messages, new run identity, and `resumedFromRunId`;
- idempotent deletion and single disposal;
- parent ownership checks and stale/deleted-handle rejection;
- active-child stop-first deletion behavior;
- blank/oversized resume messages without consuming the reuse budget;
- eight-child retention and oldest-first eviction;
- the eight-cycle reuse limit;
- authority revocation, parent tool removal, MCP revocation, and cancellation before startup;
- concurrent resume/delete protection;
- awaited runner shutdown disposal;
- resumed-run policy dispatch and live-child stop followed by disposal.

A cached Vitest results file at `packages/coding-agent/node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json` records `test/ice-subagent-reuse-delete.test.ts` with `failed: false`. This is cached evidence, not a test execution performed for this document; the same cache also records a failure in `ice-agent-view-integration.test.ts`, so it must not be represented as a clean full-suite result. No test or type-check command was run during this documentation-only task.

The package changelog has an `Unreleased` `Added` entry describing this feature, but this document does not infer commit provenance from that entry.

## Repository and worktree status

The inspection was restricted to the `subagent-reuse-delete` worktree. The available file tools did not expose Git metadata, so the exact branch name, `HEAD` SHA, and whether the pre-existing source, test, and changelog entries are committed cannot be independently verified here. The implementation and tests described above are observed in the checked-out files, not asserted to belong to a particular commit.

This file, `docs/worktree-subagent-reuse-delete.md`, is the only file changed by this documentation task and is uncommitted unless a later caller explicitly commits it. No source, test, changelog, or other file was modified by this task.

## Limitations and follow-ups

- Retained foreground sessions are process-local and memory-only. A restart, runner replacement, or explicit shutdown loses the reusable handle; use durable jobs when restart-visible job state is required, but do not assume those jobs can resume an in-flight model session.
- There is no `manage_subagent` list action. Integrations need to expose `listRetainedChildren()` or otherwise retain the returned run ID so users can select a handle.
- Only verified `completed` results are reusable. Failed, cancelled, timed-out, truncated, or otherwise non-completed executions are not continuation candidates, even when their read-only historical snapshots remain visible.
- Resume reuses the original session and authority identity. It is not a clean-context retry and cannot change model, profile, scope, tools, trust, or host-execution mode.
- Retention and historical-view limits are independent. Deleting a retained handle removes its matching view, but resuming creates a new view while the old run's bounded historical view can remain.
- The parent still must verify the resumed structured result and evidence. Retention, a valid payload, and a historical transcript do not establish semantic correctness.
- Disposal and cancellation are best-effort at the underlying process/session boundary; the runner awaits its own shutdown/disposal path but cannot undo external effects already performed by a child tool or adapter.
- The focused source tests provide strong lifecycle coverage, but this documentation task did not rerun them or `npm run check`; those checks should be run by the integrating change owner.

## Source map

- `packages/coding-agent/src/ice-subagents.ts` — `NativeSubagentRunner`, retention limits/state, `resumeRuntime()`, `deleteRetainedChild()`, `listRetainedChildren()`, terminal cleanup, and `manage_subagent` schema/facade.
- `packages/coding-agent/src/ice-agent-view-bridge.ts` — bounded historical snapshots and deletion of historical views.
- `packages/coding-agent/src/ice-subagent-settings.ts` — subagent defaults, restrictions, and current settings resolution used by authority revalidation.
- `packages/coding-agent/docs/subagent-user-guide.md` — operator-facing delegation, settings, authority, and troubleshooting guidance.
- `packages/coding-agent/test/ice-subagent-reuse-delete.test.ts` — focused lifecycle tests.
- `packages/coding-agent/CHANGELOG.md` — existing `Unreleased` feature entry; not changed here.
