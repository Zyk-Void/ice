# ICE Changelog

ICE-specific changelog for this fork. Entries here record behavior that is not covered by the per-package
`packages/*/CHANGELOG.md` files; those files are intentionally left untouched by this document.

## [Unreleased] — branch `integration/all-worktrees-experimental`

Baseline: `15b577875` (HEAD) plus the uncommitted staged, unstaged, and untracked changes in
`.worktrees/all-worktrees-experimental` (67 paths), reviewed 2026-09-23. Entries describe the working tree as it
exists; this document is not a test report.

### Added

**Subagent background execution with parent check-ins** (`src/ice-subagent-checkin.ts`)
- `SubagentCheckInCoordinator` delivers bounded, redacted progress snapshots for managed `delegate`,
  `delegate_write`, `delegate_batch`/`review_batch` siblings, and durable `delegate_async` jobs.
- Default and minimum interval is 120 s (`SUBAGENT_CHECKIN_INTERVAL_MS`); notices are coalesced per owner and
  delivered as a `subagent_checkin` custom message through the existing parent AgentSession follow-up queue.
- A notice is re-armed only after the parent turn consumes and settles it. A queued notice is never treated as
  proof that the parent reviewed it, and overdue notices or stale progress never fail or stop a child.
- Delivery and freshness are explicit (`fresh`, `stale`, `unknown`, `transport-dead`; check-in armed, due, queued
  for parent, parent reviewing, acknowledged, owner unavailable).
- Durable job records persist check-in metadata (sequence, timestamps, overdue/pending) and restore it across
  restart. Typed notice details survive the RPC JSON event path.

**Managed handles by default for `delegate`, `delegate_batch`, `review_batch`, `delegate_write`**
- Each tool returns an owner-scoped handle after launch preflight/admission instead of holding the parent tool
  call for child completion; `background: false` selects the synchronous legacy path.
- New `inspect_subagent_batch` and `cancel_subagent_batch` tools provide deterministic owner-scoped aggregate
  inspection and cancellation; per-child run IDs remain individually manageable through `manage_subagent`.

**Durable observability run history** (`src/observe/observe-recorder.ts`, `observe-store.ts`)
- Always on for agent runs: projected message, tool, subagent, compaction, retry, skill, and queue events are
  appended to `observability.sqlite` in ICE's agent directory (normally `~/.ice/agent/observability.sqlite`).
- The database is a forensic projection separate from the canonical session JSONL: it never replaces or mutates
  session history, payloads use the same redaction ceiling as the live recorder, and replay is capped at 10,000
  events.
- Activity updates are recorded so a replay shows the evolution of a tool call rather than only its final state.
- Adds the pinned `@zykairotis/ice-storage-sqlite-node@0.83.0` dependency (lockfile, shrinkwrap, and install-lock
  updated). Failure to open the store degrades to a warning and does not block the run.

**Opt-in live dashboard** (`ice --observe[=port]`, `observe-server.ts`, `observe-dashboard.html`)
- Read-only browser view of the live event grid; the server binds `127.0.0.1` only and accepts no commands (no
  prompts, aborts, or settings changes).
- Default port 4649; `--observe=<port>` is validated to 1-65535; an already-serving port is shared instead of
  duplicated.
- The dashboard reuses the always-on recorder, so it cannot create a second event stream, and its pulse bars use
  stable epoch-anchored bins so they do not reshuffle near moving time-window edges.
- Documented in `docs/observability.md`; the HTML asset is added to `copy-assets`.

**Skill hot reload**
- `computeSkillsSignature()` builds an mtime+size signature over skill source paths (recursive, skipping dot
  entries and `node_modules`, including ignore files, without reading file contents);
  `ResourceLoader.refreshSkillsIfChanged()` reloads only when the signature changed.
- Prompt submission re-scans skills, so `/skill:name` expansion and the `<available_skills>` system-prompt
  section always reflect the current files.
- Interactive mode polls every 5 s while idle and rebuilds autocomplete; RPC `get_commands` refreshes before
  listing commands.

**Plain final-turn result ingestion**
- Ordinary `delegate` and `delegate_async` runs ingest the child's natural final assistant answer instead of
  forcing a JSON-only finalization turn. Typed flows (`outputSchema`, acceptance criteria, and
  `review_batch`/batch review tasks) keep the strict bounded structured final-report protocol with parse/repair
  and schema/evidence verification.
- Plain results carry `reportMode: "plain_final_turn"` through results, telemetry, the observatory, durable job
  inspection, and live views, and are verified only for lineage and output bounds
  (`verification.kind: "plain_bounds"`, `structuredVerified: false`); no evidence-path or payload claims are
  verified.
- Steered finalization asks for plain prose in plain mode and the structured JSON report in typed mode.

**New subagent settings**
- Preferences: `checkInIntervalMs` (integer, minimum 120000) and `startupTimeoutMs`.
- Restrictions: `maxStartupTimeoutMs` (1-600000), alongside the existing output, deny-role, and deny-tool
  restrictions.
- Resolved values and provenance are exposed through the existing settings projections. RPC renames
  `ice.subagents.defaults.timeoutMs` to `ice.subagents.defaults.startupTimeoutMs` ("Subagent startup timeout",
  "Maximum time to start a child session, in milliseconds; does not limit child execution time").

### Changed

- Managed children, batch/review siblings, writers, and durable jobs run without a child lifetime deadline and
  are supervised by advisory check-ins; elapsed time, overdue notices, and stale progress never terminate a
  child, and cancellation is explicit. This supersedes the subagent timeout-multiplexing and extension-reserve
  model.
- `manage_subagent` actions are now `inspect`, `peek`, `wait`, `follow_up`, `stop`, `detach`, `resume`, `delete`.
  `wait` blocks for at most `waitMs` and reports `waitExpired` without changing child state; `detach` retains the
  same live child without spending a runtime budget; `stop` cancels. `resume` (completed children only) and
  `delete` (owner-scoped, idempotent) keep their existing ownership and no-widening semantics.
- `SubagentSupervisorState` is narrowed to `running | terminal` and `SubagentSupervisorStopReason` to
  `cancelled`. The extension reserve, `awaiting_extension` state, `timeoutContinuationMessageMarker`
  presentation, and the `extendRuntime`/`markAwaitingExtension`/`resumeFromExtension` live-session controls are
  removed from the agent-view bridge.
- Subagent footer and observatory reporting shift from execution budget to check-ins: entries show
  `<n>s elapsed · check-ins active` plus the check-in delivery state, and `IceAgentViewDescriptor` and the
  observatory snapshot expose `checkIn` and `mainAgentDisplayed` instead of active budget, total extended, and
  remaining-extendable fields.
- The authoritative parent session is exposed to the agent-view bridge in interactive, print, JSON, and RPC
  transports (`setParentSession`); supervisory notices reuse that session and never create a second loop.
- Compaction paths are serialized behind one in-flight lock: `isCompacting` and the prompt-submit guard now
  cover the in-flight compaction, `compact()` re-checks the lock after preempting an in-flight compaction,
  compaction settings are read after the lock is claimed, and manual/automatic paths can no longer both append
  compaction entries.
- Local Codex fast-mode matching is expanded to the verified `cx/gpt-6-luna` and `cx/gpt-6-sol` routes alongside
  `cx/gpt-5.6*`.
- Blackhole summary extraction: file-operation context is passed into section building, noise stripping preserves
  any non-noise remainder, repeated tool-error collapsing supports headers without reference lists, scope-change
  goals respect the 8-item cap, tool-argument extraction tolerates missing arguments, and an already-completed
  concurrent compaction is treated as success.
- Documentation: `docs/subagent-user-guide.md` (managed-by-default handles, check-ins, new `manage_subagent`
  surface), `docs/settings.md` (`startupTimeoutMs`, `checkInIntervalMs`), `docs/skills.md` (hot reload), new
  `docs/observability.md`, and `idea.md` (new "Subagent Background Execution and Parent Check-Ins" section
  replacing the timeout-multiplexing section).
- SDK and test scaffolding implement the new `refreshSkillsIfChanged` loader method
  (`examples/sdk/12-full-control.ts`, `test/utilities.ts`, `test/sdk-skills.test.ts`).

### Fixed

- An `error` stop reason observed after the run signal was aborted is reclassified as `aborted` in the agent
  loop, so a cancellation artifact is no longer surfaced, retried, or compacted as a provider failure.
- Concurrent compactions no longer append duplicate compaction entries, and prompt submission is rejected while
  a compaction is actually in flight rather than only while an abort controller exists.
- Blackhole no longer drops tool-input noise incorrectly, misattributes file activity without file-operation
  context, truncates scope-change goals silently, or reports an absorbed duplicate compaction as a failure.
- The observability dashboard's pulse bars no longer reshuffle near moving time-window edges.

### Removed

- Subagent `timeoutMs` preference and `maxTimeoutMs` restriction. They are replaced by `startupTimeoutMs` and
  `maxStartupTimeoutMs`; a legacy `timeoutMs` key now fails closed as an unknown preference key, and durable job
  contracts keep an optional legacy `timeoutMs` field only for migration.
- `manage_subagent` `extend`, the extension reserve, the `awaiting_extension` supervisor state, the `timed_out`
  supervisor stop reason, and the runtime budget footer fields.
- Forced JSON-only finalization for plain (non-typed) delegation results.

### Tests added or reworked

- `test/ice-subagent-checkin.test.ts`, `test/observe-recorder.test.ts`, `test/observe-server.test.ts`,
  `test/observe-store.test.ts`, `test/skills-hot-reload.test.ts`, `test/ice-provider-fast-mode.test.ts`,
  `test/suite/agent-session-compaction-lock.test.ts`.
- Reworked for the lifecycle change: `test/ice-subagents.test.ts`, `test/ice-subagent-timeout-*.test.ts`,
  `test/ice-subagent-jobs.test.ts`, `test/ice-subagent-settings.test.ts`, `test/ice-subagent-observatory.test.ts`,
  `test/subagent-footer.test.ts`, `test/ice-writer-w5.test.ts`, `test/ice-delegate-mvp.test.ts`,
  `test/ice-subagent-readiness.test.ts`, `test/suite/agent-session-queue.test.ts`, `test/rpc-jsonl.test.ts`,
  `test/rpc-settings.test.ts`, plus `packages/agent/test/agent-loop.test.ts` for the abort reclassification.

### Planning artifacts

- `agent_docs/implementation/subagent-background-checkin-plan.md` (implementation plan, status: complete in this
  worktree) and `agent_docs/implementation/subagent-background-checkin-plan-audit.md` (independent audit,
  pre-repair verdict `REPAIR REQUIRED`). These are planning and audit records, not described behavior.
