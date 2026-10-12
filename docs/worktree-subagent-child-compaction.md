# Native subagent child compaction

> **Historical implementation snapshot.** This note describes an earlier isolated worktree and legacy subagent path, not current V2 behavior. See the [Subagents V2 guide](../packages/coding-agent/docs/subagents-v2.md) and [architecture](../packages/coding-agent/docs/subagents-v2-architecture.md); treat branch, status, and source references below as historical evidence.

This document describes the child-compaction implementation visible in the
`subagent-child-compaction` worktree. It is intentionally scoped to native
subagent children; it does not describe a second compaction engine or a
parent-history compaction protocol.

## Repository and change-state notes

- **Worktree:** `.worktrees/subagent-child-compaction`
- **Branch:** `subagent-child-compaction` (recorded by the implementation audit
  at `agent_docs/implementation/subagent-child-compaction-plan-audit.md`).
- **HEAD:** the HEAD hash was not available through the file-only inspection
  used to prepare this document. No hash is inferred here.
- **Git status:** likewise not independently observable in this inspection.
  The audit records implementation and test files in this worktree, but does
  not establish whether each existing change is committed. Treat the source,
  test, changelog, and architecture-note references below as **observed
  worktree contents**, not as commit evidence.
- **This document:** `docs/worktree-subagent-child-compaction.md` is the one
  requested documentation change and is **new/uncommitted until a later Git
  commit records it**.

The distinction matters for release or merge decisions: the implementation
may be complete against its plan while the worktree still contains uncommitted
changes.

## Purpose

A native delegated child usually runs one long prompt, potentially involving
many model/tool turns. Its transcript can exceed the selected model's context
window even though the parent must retain the child's task objective, scope,
tool authority, and final-report contract. Child compaction addresses that
case by enabling the existing `AgentSession` automatic/overflow compaction
pipeline inside the child session.

The design goals are:

1. compact only the child transcript;
2. resume the same child session and model/tool authority after compaction;
3. preserve enough task, context-packet, acceptance, and report information for
   the child to finish correctly;
4. keep the parent's history and authority independent; and
5. expose bounded lifecycle metadata to parent observability without projecting
   the generated summary text.

This is a child-local memory operation, not a parent/child transcript merge.
The implementation reuses the core session-native compaction path rather than
introducing an OMP-style artifact protocol or a second summary engine.

## Behavior

### Default and explicit policy

`createNativeSubagentSession()` constructs a child `SettingsManager` and loads
its resources before creating the session. After that reload, if the effective
child setting `compaction.midRunCompaction` is undefined, the child applies a
local default of `"resume"`. An explicit value, including `"off"`, remains
authoritative. The override is child-local and does not change the parent's
compaction behavior.

The supported mid-run values are:

- `"off"`: do not compact between tool turns;
- `"pause"`: compact after a tool turn and leave continuation for a later
  prompt/decision; and
- `"resume"`: compact after a tool turn and continue the interrupted child
  turn.

Native overflow recovery remains enabled separately by
`compaction.enabled`. Thus a child with `midRunCompaction: "off"` can still use
native overflow recovery when the regular compaction setting is enabled.

### Threshold compaction

The core `AgentSession` checks after a tool turn. It requires a tool result,
enabled compaction, an available model, no active competing compaction, and a
non-aborted operation. It estimates context usage and compares it with the
configured threshold for the selected model. If compaction writes an entry,
the child rebuilds its in-memory message state from the session manager. In
`"resume"` mode, the interrupted work continues; in `"pause"` mode, the
session does not automatically continue the turn.

The normal settings are:

| Setting | Default | Meaning |
| --- | ---: | --- |
| `compaction.enabled` | `true` | Enable automatic and overflow compaction. |
| `compaction.thresholdPercent` | `85` | Percentage of the selected model context window at which automatic compaction is triggered. |
| `compaction.reserveTokens` | `16384` | Budget reserved for the compaction summary request/response. |
| `compaction.keepRecentTokens` | `20000` | Approximate recent context retained outside the summary. |
| `compaction.midRunCompaction` | `"off"` for ordinary sessions; child default is `"resume"` when unset | Mid-tool-loop behavior. |

The threshold and summary budget are separate controls. In particular,
`reserveTokens` is not the percentage trigger.

### Overflow recovery

When the assistant response is from the current model and is a context
overflow or a recoverable length stop, the core session removes the failed or
truncated assistant message from the active agent state, compacts the prior
history, and retries the interrupted work. The recovery path is guarded to one
compact-and-retry attempt. If the attempt has already been used, the session
emits a failed overflow-compaction result rather than looping indefinitely.

A completed assistant response that is not retryable may still cause overflow
compaction, but it is not treated as an automatic continuation of that same
assistant response. Failed or cancelled summary generation does not create a
new compaction entry.

### Cancellation and failure

The core `AgentSession.abort()` calls `abortCompaction()` before waiting for the
agent to become idle. The child runner also observes the parent-provided
cancellation signal. A cancellation during summary generation therefore emits
an aborted compaction lifecycle event and terminates the child without sending
the planned post-compaction continuation request. Summary failures are
reported as failed lifecycle state and do not silently become successful child
reports.

### Repeated compaction

Each successful compaction appends a normal compaction entry to the child's
in-memory session manager. Later compaction can use the prior summary as
iterative history, while context reconstruction keeps only the latest relevant
summary plus entries after its boundary. The implementation has regression
coverage for two successive child compactions and checks that reconstruction
remains bounded rather than entering a compaction loop.

## Architecture and data flow

```text
parent delegate / runner
          |
          | normalized request, model, runtime, parent tool snapshot,
          | scope and cancellation
          v
createNativeSubagentSession()
  SettingsManager + resource loader
  child-local midRunCompaction default
  scoped child tool definitions
          |
          v
createAgentSession()
  SessionManager.inMemory(child cwd)
  existing AgentSession compaction engine
          |
          +--> threshold/overflow check
          |       |
          |       +--> prepare compacted range
          |       +--> summary request on child model route
          |       +--> append CompactionEntry
          |       +--> buildSessionContext()
          |       +--> optional resume
          |
          +--> child session events
                    |
                    v
          NativeSubagentRunner projection
             bounded parent events + view state
```

### Child session construction

`createNativeSubagentSession()` in
`packages/coding-agent/src/ice-subagents.ts`:

1. validates the normalized profile, resources, requested thinking level, and
   effective tools;
2. creates a child `SettingsManager` and `DefaultResourceLoader`;
3. disables ambient child packages/extensions/skills/prompt templates/themes
   and supplies only selected, validated resources and parent-owned adapters;
4. applies the child-local `midRunCompaction: "resume"` default after resource
   reload when no explicit value exists;
5. creates the session with the selected model/runtime, scoped custom tools,
   and `SessionManager.inMemory(options.request.cwd)`; and
6. returns the child `AgentSession`, effective tools, and bounded child prompt.

The same child `AgentSession` object owns the model, stream function, tool
registry, scope wrappers, and report protocol before and after compaction.
Compaction changes active context messages, not those authority-bearing
objects.

### Core compaction path

`packages/coding-agent/src/core/agent-session.ts` owns the lifecycle. Its
`_runAutoCompaction(reason, willRetry)` method:

- obtains summary authentication from the current session model;
- prepares a compactable branch range using the configured retention settings;
- emits `compaction_start`;
- calls the existing `compact()` implementation using the current model route,
  stream function, retry settings, and an abort signal;
- appends the resulting `CompactionEntry` to the session manager;
- calls `buildSessionContext()` and replaces the agent's active messages with
  the reconstructed context;
- emits `compaction_end`, including whether the operation will retry; and
- removes a retriable error/length assistant message again before calling the
  normal continuation path when `willRetry` is true.

The compaction request is therefore a child request on the child's selected
route. It is not a request through the parent's transcript and does not
reconstruct authority from summary prose.

### Parent observability projection

`NativeSubagentRunner` subscribes to child `AgentSession` events. A core
`compaction_start` becomes `subagent_compaction_start`; a core
`compaction_end` becomes `subagent_compaction_end`. The projected fields are:

- `compactionReason`: `"manual" | "threshold" | "overflow"`;
- `compactionStatus`: `"started" | "completed" | "aborted" | "failed"`; and
- `compactionWillRetry`: whether core intends to retry/continue after a
  successful compaction.

The `SubagentEvent` contract deliberately has no summary field. The runner
updates `IceAgentViewBridge` with `{ compacting: true/false }`, and the
observatory reducer maps the start event to phase `"compacting"` and the end
event back to the prior activity phase (or `"running"`). Historical snapshots
retain bounded child state for the normal view, but parent verification still
uses the authoritative child result/session state rather than the presentation
projection.

## API reference

### `createNativeSubagentSession`

Creates a native child `AgentSession` with validated scoped tools and
child-local resource/settings state.

**Signature:**

```typescript
createNativeSubagentSession(
  options: NativeSubagentSessionOptions,
  createSession?: (options: CreateAgentSessionOptions) =>
    Promise<CreateAgentSessionResult>,
): Promise<NativeSubagentSession>
```

**Important parameters:**

- `options.request` (`NormalizedSubagentRequest`): normalized task, profile,
  scope, resources, context packet/fork state, acceptance contract, and
  execution settings.
- `options.parentActiveTools` (`readonly string[]`): the parent's active tool
  snapshot. The child effective tool set is derived from this and the profile;
  compaction does not broaden it.
- `options.model` (`Model<Api> | undefined`): the selected child model. The
  same model object/route is used for ordinary child work and summary calls.
- `options.modelRuntime` (`ModelRuntime | undefined`): runtime used by the
  child session's provider/model path.
- `options.agentDir` (`string | undefined`): settings/resource root for the
  child.
- `options.unsafeHostExec` (`boolean | undefined`): explicit trusted YOLO
  execution mode. This affects the tool surface and host-execution policy; it
  is not enabled by compaction.
- `options.sessionStartEvent`: optional session-start event.
- `options.mcpDispatch`, `parentMcpTools`, `mcpToolAccess`: optional
  parent-owned MCP adapters/allowlist. The child does not load an ambient MCP
  adapter itself.
- `options.reportOnly`, `tokenBudgetLedger`, and `shouldStopAfterTurn`:
  optional parent-owned report/budget/turn controls that remain attached to
  the same session across compaction.

**Returns:** `NativeSubagentSession`, containing `session`, `profile`,
`tools`, and the generated `prompt`.

**Example:**

```typescript
const child = await createNativeSubagentSession({
  request: normalizedRequest,
  parentActiveTools: ["delegate", "read", "grep", "find", "ls"],
  model,
  modelRuntime,
  agentDir,
});

await child.session.prompt(child.prompt, {
  expandPromptTemplates: false,
  source: "extension",
});
```

The example starts a child; it does not manually compact. Automatic threshold
and overflow decisions happen inside `AgentSession`.

### `NativeSubagentRunner.runResolved`

Runs a previously normalized request and returns the bounded verified child
result.

**Signature:**

```typescript
runResolved(
  normalized: NormalizedSubagentRequest,
  parentActiveTools: readonly string[],
  options?: NativeSubagentRunOptions,
): Promise<SubagentResult>
```

`NativeSubagentRunOptions` includes `model`, `modelRuntime`, `signal`,
`unsafeHostExec`, `agentDir` (through the runner), `onEvent`, runtime
attention/managed-result callbacks, hook/MCP adapters, and optional token
budget state. `onEvent` is the integration point for observing child
compaction without receiving summary contents.

```typescript
const result = await new NativeSubagentRunner({ agentDir }).runResolved(
  normalizedRequest,
  ["delegate", "read"],
  {
    model,
    modelRuntime,
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "subagent_compaction_start") {
        // Display bounded lifecycle state only.
      }
    },
  },
);
```

**Returns:** `SubagentResult`. A successful result contains the bounded final
summary/evidence contract; cancellation, timeout, verification, and child
protocol failures remain distinguishable terminal outcomes.

### `SubagentEvent` compaction fields

The child lifecycle event union includes `subagent_compaction_start` and
`subagent_compaction_end`. These common fields identify the run, parent/child
session, profile, and status. Compaction-specific fields are:

```typescript
type SubagentCompactionReason = "manual" | "threshold" | "overflow";
type SubagentCompactionStatus = "started" | "completed" | "aborted" | "failed";

interface CompactionProjection {
  compactionReason?: SubagentCompactionReason;
  compactionStatus?: SubagentCompactionStatus;
  compactionWillRetry?: boolean;
}
```

Summary text, raw compacted messages, and unrestricted paths are intentionally
not part of this projection. Paths in other child events are normalized and
scope-filtered by the runner.

## Configuration and usage

### Settings file

The normal settings schema is available in
`packages/coding-agent/docs/settings.md`. A child can use a project/agent
settings file such as:

```json
{
  "compaction": {
    "enabled": true,
    "thresholdPercent": 85,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "midRunCompaction": "resume"
  }
}
```

For child defaults, omitting `midRunCompaction` has the same effective result
as `"resume"` after child resource loading. To explicitly disable mid-run
child compaction while retaining overflow recovery, set:

```json
{
  "compaction": {
    "enabled": true,
    "midRunCompaction": "off"
  }
}
```

An explicit `"pause"` is useful when a host wants the child to stop at the
post-tool compaction boundary. The ordinary interactive session default
remains `"off"`; this feature does not silently change the parent's setting.

### Public delegation

The normal user-facing path is the native delegation surface (`delegate`,
foreground or the supported managed forms), which normalizes the task and
scope before invoking `NativeSubagentRunner`. Callers should provide:

- a specific task and approved scope;
- explicit context packet items for handoff information;
- acceptance criteria when report semantics must be checked; and
- a bounded `timeoutMs` and, where needed, a cancellation signal.

A child report should contain only observed, scope-valid evidence. Compaction
is not a reason to loosen that contract.

## Verification evidence visible in this worktree

The following evidence is recorded in the worktree. This documentation pass
inspected the files but did not execute the commands; the command results below
are therefore attributed to the existing audit rather than claimed as a fresh
run.

### Source and test evidence

- `packages/coding-agent/src/ice-subagents.ts` contains the child-local default,
  in-memory session construction, event projection, and `compacting` view
  updates.
- `packages/coding-agent/src/core/agent-session.ts` contains the shared
  threshold/overflow pipeline, compaction abort handling, session-context
  reconstruction, and one-attempt overflow guard.
- `packages/coding-agent/src/ice-agent-view-bridge.ts` defines the bounded
  `compacting` presentation flag.
- `packages/coding-agent/src/ice-subagent-observatory.ts` defines the
  `compacting` phase and restores the prior activity phase on completion.
- `packages/coding-agent/test/ice-subagents.test.ts` contains regression cases
  for:
  - explicit `midRunCompaction: "off"` versus the child default;
  - long-running child overflow compaction and continuation;
  - preservation of model, tools, and scope;
  - cancellation while summary generation is in flight;
  - preservation of task objective, acceptance, and report semantics;
  - model-driven tool work after compaction; and
  - two repeated compactions with bounded reconstruction.
- `packages/coding-agent/test/ice-subagent-observatory.test.ts` checks that
  observatory state enters `compacting`, then returns to the prior activity
  phase, without requiring summary content in the event projection.

### Audit-reported checks

`agent_docs/implementation/subagent-child-compaction-plan-audit.md` reports a
fresh audit dated 2026-09-14 with all 16 scoreable plan units verified (the
conditional terminal-child-reuse item is marked N/A because that feature is not
integrated in this worktree). It reports:

- `ice-subagents.test.ts`: PASS, 225/225;
- `ice-subagent-observatory.test.ts`: PASS, 22/22;
- `test/suite/agent-session-compaction.test.ts`: PASS, 21/21;
- TypeScript no-emit, pinned-dependency, relative-import, lockfile,
  browser-smoke, and `git diff --check` gates: PASS; and
- a direct npm 12.0.2 `run check`: PASS, with the audit separately noting a
  shell-specific nested npm version caveat for the composite command.

These results are useful verification evidence, but they are not a substitute
for rerunning the checks after any later source or environment change.

## Limitations and follow-ups

1. **No terminal-child reuse integration.** The audit marks the conditional
   resume-after-prior-compaction reuse scenario N/A. Revisit it when terminal
   child reuse is integrated.
2. **Summary contents remain child-local.** Parent observability receives
   lifecycle metadata only. A host that needs the summary must use the
   authoritative child/session/result path under its existing ownership and
   verification rules; it should not extend `SubagentEvent` with raw summary
   text merely for display.
3. **In-memory lifetime.** `SessionManager.inMemory()` means the child session
   is not a durable independent history. Once the child is shut down, only the
   bounded result and allowed historical presentation remain. This feature does
   not add durable child transcript replay.
4. **Compaction is not a guarantee of completion.** A summary request can fail,
   be cancelled, or leave the child unable to fit the next request. The one
   overflow recovery attempt is deliberate; callers should use a smaller task,
   tighter context packet, larger-context model, or more conservative retention
   when recovery is insufficient.
5. **Provider/runtime limits still apply.** Summary generation uses the child
   model route and provider behavior. Tool, timeout, token-budget, scope,
   authority, and report limits are independent of compaction and remain in
   force.
6. **Threshold estimation is approximate.** The core uses provider usage when
   available and conservative message estimates otherwise. `keepRecentTokens`
   is an approximate retention target, not a strict byte-for-byte promise.
7. **Extension ownership can affect summary generation.** The shared core can
   offer `session_before_compact` to an explicitly loaded extension. Child
   resource loading disables ambient extensions; only deliberately supplied,
   parent-owned adapters/capabilities participate. Extension cancellation or
   failure must still be treated as a non-successful compaction.
8. **Git state is not documented as clean or committed here.** Before merge,
   inspect the actual worktree status and HEAD with normal repository tooling,
   then commit this documentation and the intended implementation changes as a
   reviewed unit.

## Source index

- `packages/coding-agent/src/ice-subagents.ts` — native child creation, runner,
  event projection, and child view updates.
- `packages/coding-agent/src/core/agent-session.ts` — shared compaction events,
  abort behavior, threshold checks, overflow recovery, and reconstruction.
- `packages/coding-agent/src/core/compaction/compaction.ts` — compaction
  settings, threshold defaults, token estimation, and summary preparation.
- `packages/coding-agent/src/core/settings-manager.ts` — settings schema and
  `midRunCompaction` resolution.
- `packages/coding-agent/src/ice-agent-view-bridge.ts` — bounded live/historical
  child presentation metadata.
- `packages/coding-agent/src/ice-subagent-observatory.ts` — observatory phase
  reduction.
- `packages/coding-agent/test/ice-subagents.test.ts` — native child
  regressions.
- `packages/coding-agent/test/ice-subagent-observatory.test.ts` — lifecycle
  projection regression.
- `packages/coding-agent/docs/compaction.md` and
  `packages/coding-agent/docs/settings.md` — general compaction/configuration
  reference.
- `packages/coding-agent/CHANGELOG.md` — recorded added-feature entry.
- `idea.md` — architecture note describing child-local reuse and bounded
  projection.
- `agent_docs/implementation/subagent-child-compaction-plan-audit.md` — plan
  closure and audit-reported verification evidence.
