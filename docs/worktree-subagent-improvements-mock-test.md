# Integrated subagent improvements and mock-test state

## Scope and status

This document records the subagent implementation visible in the
`subagent-improvements-mock-test` worktree. It is an implementation note, not a
claim that every optional live-provider or host-side path has been certified.
The parent Ice session remains the only model-driven reasoning and tool loop;
subagents are bounded child `AgentSession` runs and parent-owned adapters.

The repository-local status record identifies the working branch as
`feat/subagents` and records a dirty worktree with concurrent changes and a
historical/current snapshot of `HEAD` as
`7cbd8a676815cbfef3b03a4902269ede2ac2fbf1` (`progress.md`). Direct Git status,
branch, and commit inspection was not available through the file-only
inspection interface used for this document. Consequently:

- the branch and commit information above is reported as repository-local
  evidence, not independently rechecked Git output;
- the implementation files listed below must not be assumed to be all part of
  one commit;
- this file was created by this documentation task and should be treated as
  uncommitted until a normal Git status check confirms otherwise;
- no source, test, changelog, or other documentation file was intentionally
  modified by this task.

## Purpose and behavior

ICE adds controlled delegation while preserving Ice's small, inspectable loop.
The integrated surface supports:

- one foreground `delegate` child;
- one retained managed child when `delegate` is called with `background: true`;
- durable owner-scoped `delegate_async` jobs;
- bounded sibling fan-out through `delegate_batch`;
- typed read-only review fan-out through `review_batch`;
- separate worktree-based `delegate_write` and explicit parent-side writer
  inspection, rejection, and integration tools;
- `manage_subagent` lifecycle control for retained children; and
- read-only `/agents` and `/subagents` observability.

Safe delegation is read-only. The normal built-in child surface is the
intersection of the parent-active tools, the profile's requested tools, and
`read`, `grep`, `find`, and `ls`. A child cannot recursively delegate, inherit
ambient extensions, load Cognee/Blackhole automatically, or mutate the parent
workspace through ordinary delegation.

The explicit `--sub-yolo` path is different: it is a host-execution escape hatch,
not a sandbox. It requires explicit build mode, Bash authorization, project
trust, and the relevant parent capability. It permits only profile-requested
built-ins that remain active in the trusted parent. The implementation warns
that host filesystem, process, network, credential, and descendant-cleanup
boundaries are not independently isolated; cancellation is best effort.

## Architecture and API

### Child resolution and execution

`packages/coding-agent/src/ice-subagents.ts` is the integration point. It owns
request types, normalization, profile/resource resolution, scope checks,
report parsing, verification, the native runner, and the ICE-only tool
factories. `ice.ts` installs it as the hidden `ice-subagents` extension after
`ice-safe-verify`, and stock `ice` remains a separate entry point.

The runner creates a fresh in-memory `AgentSession` by default. `contextMode:
"fork"` is opt-in and does not clone a session: it sanitizes a bounded projection
of `buildSessionContext().messages`, retaining only bounded user/assistant text
and summaries. Thinking, tool calls/results, images, custom messages, and empty
content are dropped. Explicit context packets are also untrusted handoff data;
they do not grant authority.

Profiles are file agents or the special `self` profile. The current resolver
uses global-first file-agent lookup (`<agentDir>/agents`, normally
`~/.ice/agents`) and then a trusted project `.ice/agents` fallback. `self`
derives a bounded child from the parent instruction snapshot and selected
capability identities. There is no bundled specialist catalog in the current
source. Selected skills, prompts, and context are explicit, hash-checked,
source-tracked resources; child ambient discovery is disabled.

The principal public request fields are:

- `role`, `task`, and `scope.roots`; optional `scope.targets` narrows focus to
  existing canonical regular files;
- `context`, `contextPacket`, and `contextMode: "fresh" | "fork"`;
- `timeoutMs` and `execution` overrides for thinking, tools, output bytes,
  temperature, top-p, hooks, and (when globally enabled) an exact model;
- `resources` for explicitly selected skills, prompts, or context;
- `acceptanceCriteria` for parent-verified requirements;
- `preflight` for bounded command/path/environment presence checks; and
- `outputSchema` for a restricted nested payload in typed reports.

Ordinary delegation ingests the child's natural final assistant turn. Typed
flows (output schema, acceptance criteria, and review batches) use an internal
bounded structured report. Parsed reports include bounded summary/evidence and,
where requested, payload/findings/requirement claims. A report is not proof by
itself: `verifySubagentResult()` checks lineage, terminal status, completeness,
scope, evidence existence, payload shape, and acceptance claims. Unverified or
malformed claims remain diagnostics rather than becoming parent evidence.

### Model routing

`ice-subagent-routing.ts` keeps Ice's model catalog and credentials authoritative.
The default is exact parent-model inheritance without catalog work. When global
`ice.subagents.modelSelection.mode` is `configured`, an exact requested model
may be resolved through the existing `ModelRuntime`; file-agent
`fallbackModel` is considered in deterministic primary/fallback/parent order.
Missing credentials, missing catalog entries, policy denial, and incompatible
capabilities produce bounded skip/rejection behavior rather than credential
expansion or silent rerouting. Durable jobs capture the selected route and
capability hash; a changed captured route is rejected.

### Preflight and host adapters

`ice-subagent-preflight.ts` evaluates up to eight parent-declared requirements
without consuming a child run:

- `command` resolves a bare executable name on `PATH` without executing it;
- `path` checks only inside approved scope roots; and
- `env-present` reports presence only and never exposes the value.

`ice-subagent-capabilities.ts` provides the parent-owned extension seam for
additional child-safe tools. Registration requires a bounded data-only schema,
explicit access classification, a child-safe marker, and a live authorization
check. Parent management/control tools and built-in replacements cannot be
registered as delegated adapters. `registerIceSubagentMcpAdapter()` provides a
similar parent-owned seam for explicitly selected MCP server/tool pairs; ICE
does not discover servers or authenticate on a child's behalf.

`ice-subagent-command-hooks.ts` implements the separate host-owned exact-command
hook boundary. Commands require absolute executable/cwd identities and SHA-256
hashes for the executable and declared files. The handler uses `shell: false`, a
small explicit locale environment, bounded JSON input/output, approval and
trust/build/Bash checks, cancellation, and best-effort process-tree cleanup.
Command hooks are not a sandbox and identity checking cannot substitute for an
OS-level isolation boundary.

### Settings and lifecycle hooks

`ice-subagent-settings.ts` parses the strict `ice.subagents` and `ice.hooks`
namespaces. Supported subagent settings include enabled state, defaults,
role defaults, allowlists, deny-first role/tool restrictions, model-selection
mode, and concurrency. Unknown keys and removed aggregate token/turn/tool-call
controls fail closed. Global settings are authoritative first; project settings
are used only after project trust. Empty allowlists add no restriction, while
deny lists remain authoritative.

Hooks are parent-owned and ordered deterministically. Required global hooks cannot
be weakened by project/role/call layers. Decision hooks return `continue`,
`deny`, or `ask`; deny is sticky and absent headless approval fails closed.
Observational hooks cannot change execution facts. Hook payloads, reasons,
context additions, and records are bounded and redacted. Intent records are
persisted/awaited before a required handler is entered, which preserves a
crash-recovery boundary without creating a second controller.

### Concurrency, retention, and durable jobs

`ice-subagent-concurrency.ts` is the shared admission policy for batches and
jobs. The bundled default is four active children and the hard ceiling is eight.
Trusted global settings may configure values up to that ceiling; trusted project
settings can narrow but not raise them. Shared permits prevent batch and durable
paths from exceeding the same active-child cap.

`SubagentRunSupervisor` in `ice-subagent-timeout-supervisor.ts` owns bounded
runtime attention without owning the child loop. A soft deadline produces
`needs_time`/`awaiting_extension`, not an invented terminal timeout. It tracks
bounded activity, usage, retry state, repeated-failure advisories, active
budget, extension reserve, and a separate detach-retention pool. Management
`wait` is event-driven and capped at 60 seconds; `waitExpired` describes only the
management window. `stop` deterministically produces cancellation. Managed
terminal results are retained before waiters are woken, and only bounded recent
results/child histories remain in memory.

`SubagentJobRegistry` in `ice-subagent-jobs.ts` owns durable asynchronous
read-only jobs. It persists append-only snapshots, captures the accepted route
and execution contract, reserves planned output bytes, enforces owner identity,
maintains FIFO queueing, releases permits/reservations exactly once, and marks
stale active or queued work `interrupted` during restore rather than relaunching
it. The visible defaults are two active durable jobs, an eight-job queue, a
256 KiB owner aggregate output budget, and 32 retained terminal records. A
persistence failure blocks further scheduling. Completion notification is
metadata-only and advisory; durable state remains authoritative.

### Observability and telemetry

`ice-subagent-observatory.ts` projects runtime facts into bounded sanitized
snapshots. It covers foreground, batch, review, managed, durable, and writer
phases, including retry, compaction, tool activity, evidence counts, verifier
state, rollback, and conflicts. Durable overlays show metadata-only ACTIVE,
QUEUED, and RECENT sections. Explicit terminal inspection produces an ephemeral
bounded result projection; it does not inject results into parent context. A
persisted completion inbox is derived once when an overlay opens and is not an
interactive scheduler.

`ice-agent-view-bridge.ts` connects live foreground children to the ordinary
InteractiveMode shell. Views default to mirror mode. Take Control is explicit;
steered children receive a bounded finalization turn before parent synthesis.
Historical child views are redacted, bounded, and read-only.

`ice-subagent-telemetry.ts` stores at most 256 session-local, redacted outcome
records. It summarizes first-pass verification, extension recovery, malformed
reports, verification failures, required-criterion progress, steering, usage,
and profile outcomes. It sends no external telemetry.

## Configuration and usage

### Basic request shape

The following illustrates the request contract; actual tool dispatch occurs
through the model-visible ICE tool rather than by importing the runner in a
normal CLI session:

```json
{
  "role": "self",
  "task": "Inspect the parser and report concrete evidence.",
  "scope": { "roots": ["packages/coding-agent/src"] },
  "contextPacket": [
    { "id": "goal", "kind": "parent_note", "content": "Do not modify files." }
  ],
  "acceptanceCriteria": [
    {
      "id": "evidence",
      "requirement": "Return at least one in-scope evidence path",
      "evidence": "path"
    }
  ],
  "outputSchema": {
    "type": "object",
    "properties": { "risk": { "type": "string" } },
    "required": ["risk"],
    "additionalProperties": false
  }
}
```

The implementation accepts `contextPacket` as an object with an `items` array;
the array form above is only shorthand pseudocode for the same conceptual
request and should be adapted to the installed tool schema. Keep scope roots
relative where possible, use `scope.targets` only for existing regular files,
and treat task/context/resource text as untrusted data.

### Settings shape

A representative bounded settings namespace is:

```json
{
  "ice": {
    "subagents": {
      "enabled": true,
      "defaults": { "thinking": "medium", "timeoutMs": 120000, "maxOutputBytes": 24576 },
      "restrictions": {
        "maxTimeoutMs": 300000,
        "maxOutputBytes": 49152,
        "denyRoles": [],
        "denyTools": ["write"]
      },
      "modelSelection": { "mode": "inherit-parent" },
      "concurrency": { "default": 4, "max": 8 }
    }
  }
}
```

For a project file agent, establish project trust first. A configured model
requires the global `configured` model-selection mode and an exact
`provider/model` reference; it does not enable provider discovery or login.
Hooks additionally require explicit parent-owned handler/command policy and do
not become executable merely because a project is trusted.

For unsafe host execution, launch ICE only with the explicit build/Bash/approval
boundary appropriate to the client, for example `--ice-mode build
--ice-allow-bash --sub-yolo`. Print/JSON/headless use is rejected for this
escape hatch, and the implementation does not advertise a `--no-sandbox` mode.

Writer execution is a separate workflow: normal `delegate_write` requires a
clean parent Git worktree, an exact local 40-character base SHA, a temporary
detached worktree, scoped read/write tools, and explicit parent-side
`inspect_writer_patch` plus `integrate_writer_patch` decisions. Integration
requires a configured `--ice-verify`; rejection leaves the immutable proposal
available for reuse.

## Verification evidence visible in this worktree

The strongest deterministic integrated test is
`packages/coding-agent/test/ice-delegate-mvp.test.ts`. It uses the Faux provider,
temporary directories, the real `iceSubagents` factory, and mocked extension
context. The repository's `progress.md` records nine passing MVP scenarios for
registration, fresh/selected context, parent-history isolation, provenance and
verification, malformed/model/mode gates, cancellation, timeout attention,
unsafe gating, and confirmed unsafe batch/review dispatch. The test source
also visibly asserts that no parent entry is appended for cancellation and that
Faux calls are used instead of live provider traffic.

Focused lower-level evidence present in the source tree includes:

- `ice-subagent-routing.test.ts`: parent inheritance, exact route opt-in,
  credential non-expansion, capability-hash capture, policy denial, and
  primary/fallback/parent selection;
- `ice-subagent-preflight.test.ts`: bounded normalization, non-executing PATH
  lookup, missing command handling, environment-presence redaction, scope
  checks, and no authority expansion;
- `ice-subagent-command-hooks.test.ts`: explicit environment, authority and
  approval gates, script identity changes, output floods, hanging commands,
  and malformed decision JSON;
- `ice-subagent-result-contract.test.ts`: valid/malformed/truncated reports,
  payload and requirement validation, repair behavior, and parent verification;
- `ice-subagent-jobs.test.ts` and `ice-subagent-durable-journal.test.ts`:
  persistence, queue/admission, owner scope, cancellation, restore, retention,
  notification, and failure handling;
- `ice-subagents-adversarial.test.ts`: redaction, evidence/scope rejection,
  resource and lifecycle adversarial cases;
- `ice-writer-w5.test.ts`: provider-free writer proposal, tampering, path and
  symlink cases, stale/dirty parents, verifier failure, rollback conflict,
  cancellation, timeout, and state preservation; and
- `ice-subagent-observatory.test.ts`, `ice-agent-view-bridge.test.ts`, and
  `ice-agent-view-integration.test.ts`: bounded projections, live/history view
  rules, durable metadata views, and observability behavior.

`progress.md` and `task_plan.md` record historical focused results, including
`9/9` for the MVP integration file, `170/170` for the W5/W4 writer gate,
`236/236` for a frozen six-file regression surface at one point in the recorded
sequence, and `31/31` benchmark-side tests for the read-only harness. Those are
recorded results, not commands executed by this documentation task. The same
records state that focused Biome and `git diff --check` checks were clean at the
reported checkpoints.

The repository-local records also report that `npm run check`/`tsgo` reached a
pre-existing TypeScript diagnostic in
`packages/ai/test/openai-completions-tool-choice.test.ts:1410` involving
`maxTokensField`. This document does not re-run or independently validate that
status. The optional live writer routes and live-provider/MCP certification are
explicitly pending or separate from the Faux-provider tests.

## Limitations and non-goals

- `--sub-yolo` is authorized host execution, not process/filesystem/network
  sandboxing. The delegated Bash environment is allowlisted, but allowlisting
  variables is not equivalent to isolating the host or its descendants.
- Scope checks and writer integration use bounded validation and optimistic
  concurrency; no OS/repository lock provides literal atomic filesystem
  compare-and-swap. Symlink/TOCTOU and descendant-cleanup risks therefore
  remain deployment limitations, especially for unsafe host execution.
- Parent verification is authoritative for completion. Model confidence,
  prose, claimed commands, claimed evidence, and hook observations do not
  establish success.
- Durable restore marks work interrupted and never automatically relaunches
  ambiguous work. Background batch facades, background writers, priority
  control, recursive delegation, automatic result ingestion, and Hivemind
  coordination are not part of this integrated slice.
- Live model routing, live MCP adapters, command-hook deployment, and W5B live
  writer certification require separate trusted-environment testing. Faux
  provider and mocked adapter tests cannot prove those production boundaries.
- Retention is bounded and local: managed children, terminal results, telemetry,
  reports, activity, and observatory views can expire or be evicted. Oversized
  reports may be represented by bounded local artifact metadata rather than
  inline output.
- The public package README still describes upstream Ice as having no built-in
  subagents. This worktree's ICE-specific behavior is wired through the hidden
  extension and `ice` entry point, not through stock `ice`; users should follow
  ICE-specific command/settings surfaces rather than infer behavior from that
  upstream paragraph.

## Evidence paths

Primary implementation and integration paths are listed here for review:

- `packages/coding-agent/src/ice-subagents.ts`
- `packages/coding-agent/src/ice-subagent-routing.ts`
- `packages/coding-agent/src/ice-subagent-preflight.ts`
- `packages/coding-agent/src/ice-subagent-capabilities.ts`
- `packages/coding-agent/src/ice-subagent-command-hooks.ts`
- `packages/coding-agent/src/ice-subagent-settings.ts`
- `packages/coding-agent/src/ice-subagent-concurrency.ts`
- `packages/coding-agent/src/ice-subagent-timeout-supervisor.ts`
- `packages/coding-agent/src/ice-subagent-jobs.ts`
- `packages/coding-agent/src/ice-subagent-observatory.ts`
- `packages/coding-agent/src/ice-agent-view-bridge.ts`
- `packages/coding-agent/src/ice-subagent-telemetry.ts`
- `packages/coding-agent/src/ice.ts`
- `packages/coding-agent/src/index.ts`
- `packages/coding-agent/test/ice-delegate-mvp.test.ts`
- `packages/coding-agent/test/ice-subagent-routing.test.ts`
- `packages/coding-agent/test/ice-subagent-preflight.test.ts`
- `packages/coding-agent/test/ice-subagent-command-hooks.test.ts`
- `packages/coding-agent/test/ice-subagent-result-contract.test.ts`
- `packages/coding-agent/test/ice-subagent-jobs.test.ts`
- `packages/coding-agent/test/ice-subagent-durable-journal.test.ts`
- `packages/coding-agent/test/ice-subagents-adversarial.test.ts`
- `packages/coding-agent/test/ice-writer-w5.test.ts`
- `packages/coding-agent/test/ice-subagent-observatory.test.ts`
- `packages/coding-agent/test/ice-agent-view-bridge.test.ts`
- `packages/coding-agent/test/ice-agent-view-integration.test.ts`
- `progress.md`
- `task_plan.md`
- `idea.md`
