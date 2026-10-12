# Subagent Background Execution and Parent Check-In Implementation Plan

- Status: complete in `.worktrees/all-worktrees-experimental`; all 34 scoreable units are verified by the repaired focused matrix and clean repository gate
- Revised: 2026-09-23 (independent repair audit reconciled; no-lifetime tests, startup-deadline contract, docs, RPC/Observatory projections, and final verification are current)
- Target repo: /home/mewtwo/Zks/ice
- Verified worktree: /home/mewtwo/Zks/ice/.worktrees/all-worktrees-experimental
- Primary implementation area: packages/coding-agent
- Reference corpus: Agent_harness_references (read-only)
- Scope authority: idea.md and current ICE delegation contracts remain authoritative
- Requested direction: delegated children should continue in the background while the parent remains available; wall-clock child lifetime timeout/extension behavior should be replaced by bounded parent-model progress check-ins no more frequently than every two minutes

## Objective and success state

Replace timeout-driven subagent supervision with an owner-scoped, non-blocking background lifecycle in which the existing parent AgentSession periodically receives a bounded progress check-in for still-running children.

The finished behavior must satisfy all of the following:

1. A delegated child can continue without holding the parent tool call open until child completion.
2. The parent remains available for unrelated work while children run.
3. A running child is reviewed by the existing parent model no sooner than the configured check-in interval; default and minimum interval are 120,000 ms.
4. A check-in is advisory and supervisory. Elapsed time, stale progress, a missed check-in, or parent unavailability never by themselves terminate the child.
5. The parent can use existing owner-scoped controls to inspect, follow up, wait briefly, or stop the child. Timeout-only controls and statuses are removed from new-run semantics.
6. Child status, liveness/freshness, and check-in delivery are represented as separate state dimensions.
7. Multiple due children are coalesced into bounded parent work instead of creating one model turn per timer.
8. Durable delegate_async jobs keep durable ownership, bounded persistence, cancellation, retention, and restart-interruption semantics; process-local managed delegate runs remain process-local.
9. Batches/reviews and isolated writers adopt the same non-blocking parent lifecycle without weakening concurrency, isolation, verification, or output limits.
10. Existing parent provider retry, startup deadlines, tool/hook deadlines, explicit cancellation, waitMs bounds, output-byte limits, and admission/concurrency limits remain operational safeguards.
11. Stock Pi/upstream behavior is not changed; this remains ICE-native behavior.
12. No second parent model loop, polling model, or autonomous supervisor model is introduced.

## Scope and non-goals

### In scope

- delegate managed/background execution
- delegate_async durable job execution
- delegate_batch and review_batch
- delegate_write isolated writer execution
- manage_subagent controls and model-facing guidance
- SubagentRunSupervisor timeout-derived state
- subagent settings/profile timeout fields that currently represent child lifetime
- durable job snapshots where check-in metadata must survive owner-session absence
- AgentSession delivery seam for parent check-ins
- Observatory, /agents and /subagents, RPC/JSON details, footer/status projections
- tests, migration behavior, docs, and changelog

### Explicit non-goals

- Do not create a second AgentSession for the parent.
- Do not create a scheduler-owned provider client or background model loop.
- Do not make the child ask the parent model directly.
- Do not turn progress freshness into an automatic watchdog failure.
- Do not add recursive delegation or manager/worker trees.
- Do not make process-local delegate background handles durable.
- Do not relaunch durable jobs after restart.
- Do not weaken read-only capability derivation, owner checks, writer worktree isolation, result verification, or output/concurrency caps.
- Do not reinterpret provider startup timeout, request timeout, hook timeout, bounded waitMs, or shutdown cancellation as child lifetime timeout.
- Do not replay historical timed_out jobs as running.
- Do not treat a check-in message being queued as proof that the parent model reviewed it.
- Do not parse model prose for a check-in acknowledgement.

## Current-state evidence

### ICE architecture that should be reused

| Area | Evidence | Planning consequence |
|---|---|---|
| Parent/child authority | idea.md:343-351 - parent resolves immutable launch contract, child result is bounded evidence, parent owns integration/verification, background workers are owner-scoped | Check-ins must remain parent-owned metadata and must not let the child mutate policy or authority. |
| Planned direction | idea.md:562 - this plan is the declared sequential next step for non-blocking delegation and parent-model check-ins | Implement this as an ICE lifecycle change, not as an unrelated scheduler feature. |
| Optional managed foreground launch | packages/coding-agent/src/ice-subagents.ts:11191-11195 - delegate background option returns a retained managed handle after admission | Reuse the retained-run lifecycle instead of inventing another child runner. |
| Existing managed controls | packages/coding-agent/src/ice-subagents.ts:11215-11232,11385-11395 - inspect/peek/wait/extend/follow_up/stop/detach/resume/delete and bounded wait/message fields | Keep useful owner-scoped controls; remove timeout-only actions once timeout semantics disappear. |
| Managed run ownership | packages/coding-agent/src/ice-subagents.ts:8274-8279 - live supervisor lookup is parent-session scoped | Every check-in/control path must use the same owner identity. |
| Managed child survives tool return | packages/coding-agent/src/ice-subagents.ts:14377-14388 - background child continues after delegate returns and terminates on explicit abort/stop/session shutdown | The requested non-blocking primitive already exists; change the default/lifecycle rather than replacing execution. |
| Parent session queue | packages/coding-agent/src/core/agent-session.ts:247-248,1218-1229 - active sessions support safe steer/followUp delivery | Check-ins should use the parent queue, never call the provider independently. |
| Custom parent messages | packages/coding-agent/src/core/agent-session.ts:1487-1511 - sendCustomMessage supports triggerTurn plus followUp/nextTurn semantics | This is the preferred parent check-in injection seam. |
| Parent run state | packages/coding-agent/src/core/agent-session.ts:912-920 - isStreaming/isIdle expose current parent state | Delivery can be deterministic without a second loop. |
| Current lifetime supervisor | packages/coding-agent/src/ice-subagent-timeout-supervisor.ts:3-28,190-218 - running/awaiting_extension/terminal state, timed_out reason, decision grace, lifetime/retention timers | Remove lifetime/extension machinery from new execution while preserving reusable progress/activity collection. |
| Historical management vocabulary | packages/coding-agent/src/ice-subagent-timeout-supervisor.ts:89-124 - awaiting_extension and timed_out are current management states | New runs need a clean state vocabulary; historical persisted values remain readable. |
| Startup timeout is separate | packages/coding-agent/src/ice-subagents.ts:1730-1757 - awaitSubagentStartup has its own bounded startup timer | Preserve and rename/document this distinctly so timeout removal does not create unbounded startup hangs. |
| Durable ownership | packages/coding-agent/src/ice-subagent-jobs.ts:70-80,209-218 - durable records and registry options carry ownerSessionId plus persist/notify callbacks | Persist check-in scheduler metadata on the durable owner record, not in a global queue. |
| Owner-scoped inspection | packages/coding-agent/src/ice-subagent-jobs.ts:1218-1230 - accepted job IDs remain owner-inspectable, including tombstones | A missed check-in must not break later owner inspection. |
| Observatory progress | packages/coding-agent/src/ice-subagent-observatory.ts:144-190,208-220 - active/recent progress snapshots and typed progress details already exist | Build check-in snapshots from existing bounded observatory/runtime facts where possible. |
| Completion inbox | packages/coding-agent/src/ice-subagent-observatory.ts:236-270 - durable completion items are bounded, owner-visible metadata with resultRef | Check-in delivery and completion delivery should be distinct but follow the same owner-scoped safety principles. |
| Delegation remains bounded | packages/coding-agent/src/ice-subagents.ts:626-634 - delegation guidance and context packet limits are bounded | Check-in payloads must also be bounded and sanitized. |
| Identifier separation | packages/coding-agent/src/ice-subagents.ts:1710-1721 - foreground runId and durable jobId/resultRef are deliberately distinct | Check-in notices must carry typed identifiers and never blur foreground runId with durable jobId. |

## Reference-harness comparison

### Overall similarity conclusion

No inspected harness implements the exact requested policy of “every running child causes a child-specific parent-model review every two minutes.”

The ICE design is therefore not parity with one harness. It is a deliberate composition of established patterns:

- Claude Code: return a background handle promptly, let the parent continue, expose output/status/stop, and notify on completion.
- Prime Agent: route recurring work into the existing session prompt queue rather than creating another model loop.
- Oh My Pi: owner-scope async delivery, retention, progress, and missing-owner handling.
- OpenCode: keep process-local background registries explicitly process-local and use generation/sequence guards against stale completion races.
- OpenHands: separate immediate launch acknowledgement from the later startup outcome/follow-up.
- Claw Code: treat heartbeat/freshness as diagnostic state distinct from execution status and explicit stop control.

The two-minute value also has a useful Claude Code analogue, but the meaning is different: Claude Code uses 120 seconds as an auto-background threshold, not a recurring parent check-in interval.

### Reference decision ledger

| Harness | Direct evidence | Adopt / adapt | Explicitly do not copy |
|---|---|---|---|
| Claude Code | Agent_harness_references/claude-code/src/tools/AgentTool/AgentTool.tsx:70-76 - optional auto-background after 120,000 ms; :146-154 and :1039-1050 - async_launched handle returns immediately; :1327-1330 - parent is told it will be notified and can inspect progress | Adopt immediate background acceptance, completion notification, explicit status/output inspection, stop controls, and a bounded “background work is ongoing” parent contract. The 120 s value supports the requested cadence as a reasonable minimum but not its semantics. | Do not treat Claude’s auto-background timer as proof of recurring parent review. Do not require filesystem output polling as ICE’s primary control plane. |
| Claude Code TaskStop | Agent_harness_references/claude-code/src/tools/TaskStopTool/TaskStopTool.ts:12-32,60-76 - explicit task ID and stop validation | Preserve explicit owner-scoped stop as the termination mechanism. | Do not auto-stop because of elapsed time. |
| Oh My Pi | Agent_harness_references/oh-my-pi/packages/coding-agent/src/async/job-manager.ts:82-107 - running/completed/failed/cancelled plus ownerId; :134-150 - owned completion delivery only through owner sink, missing sinks do not leak to another owner; :195-213 - owner-scoped registration/query and progress | Adopt strict owner routing, bounded retention, one-owner delivery, and dead-letter/pending semantics when the owner is not live. | Do not route a missing owner’s check-in to a global/default parent. Do not use retention expiry as a runtime timeout. |
| Prime Agent | Agent_harness_references/prime-agent/packages/coding-agent/docs/long-running-agents.md:13-31 - heartbeat/schedule feed the existing session prompt queue; :114-120 - user and agent-managed recurring heartbeat surfaces | This is the closest model-loop analogue. Adapt the queue pattern to child-specific check-ins delivered into the one existing parent AgentSession. | Do not import a general cron/daemon/autonomy subsystem merely to implement subagent check-ins. |
| OpenCode | Agent_harness_references/opencode/packages/core/src/background-job.ts:113-129 - scoped process-local registry is explicitly non-durable; :133-164 - token and sequence suppress stale settles and retain newest output | Keep managed delegate runs process-local and use generation/sequence identity to invalidate stale timers/delivery callbacks. | Do not pretend process-local handles survive restart. |
| OpenHands | Agent_harness_references/openhands/src/api/launch-child-conversation-client-tool.ts:54-59 - immediate acknowledgement followed by a later follow-up startup result; Agent_harness_references/openhands/src/services/child-conversation-launch.ts:50-65 - startup/poll identity and isolation metadata | Separate admission acknowledgement, startup result, periodic progress check-in, and terminal completion as distinct events. Keep writer isolation explicit in notices. | Do not copy cloud polling as periodic parent supervision; it only solves asynchronous startup/status discovery. |
| Claw Code | Agent_harness_references/claw-code/rust/crates/runtime/src/task_registry.rs:214-235 - heartbeat freshness projected separately into active/blocked/finished views; :249-268 - stop is explicit; :271-296 - update/output are separate operations | Adopt the separation between liveness/freshness and execution state. “Stale” may raise parent attention but never becomes automatic failure. | Do not map freshness to terminal status. |

## Constraints and invariants

### Parent-loop invariant

There is exactly one authoritative parent AgentSession and one normal parent provider/retry pipeline.

A check-in is delivered through that session. The scheduler may decide when a check-in is due, but it must never call a model provider directly.

### Child-session invariant

A running child keeps the same:

- child session identity
- resolved model
- profile
- scope roots/targets
- effective tool authority
- resource contract
- hook contract
- verification contract
- retry settings

A check-in does not recreate or widen the child.

### Ownership invariant

Every runtime/check-in record is tied to the same parentSessionId/ownerSessionId already used by the child or durable job.

If the owner session is absent, closed, or replaced:

- never deliver to another session
- never fall back to a global model
- retain/coalesce only the bounded owner-scoped pending metadata needed for later inspection/delivery
- do not stop the child solely because the parent is absent
- do not repeatedly enqueue duplicate check-ins while no owner can consume them

### Status invariant

Keep three independent dimensions:

1. Execution state
   - queued
   - starting
   - running
   - completed
   - failed
   - cancelled
   - interrupted
   - verification_failed
   - historical timed_out may be read from old records only

2. Liveness/freshness
   - fresh
   - stale
   - unknown
   - transport-dead when there is positive transport/session evidence
   - advisory only unless an independent terminal failure is observed

3. Check-in delivery
   - armed
   - due
   - queued_for_parent
   - consumed
   - acknowledged
   - owner_unavailable
   - suppressed_terminal

Do not overload execution status with “checkin_due”, “stale”, or “awaiting_parent”.

### Safety-bound invariant

Remove only child lifetime timeout behavior.

Preserve independently justified bounds:

- child startup timeout
- provider request/retry policy
- hook/tool-specific deadlines
- manage_subagent waitMs
- output-byte budgets
- context limits
- queue/admission/concurrency limits
- explicit AbortSignal cancellation
- session/process shutdown cancellation
- worktree setup/cleanup bounds where already present

### Historical-data invariant

Existing persisted terminal rows with timed_out remain valid history. They are not rewritten into failure/cancelled and are never resumed automatically as running.

New execution should not emit timed_out as a child lifetime terminal state.

### Untrusted-output invariant

Child summaries, tool names, paths, diagnostics, and partial output included in a check-in are untrusted observations.

They must be redacted, length-bounded, structurally separated from the fixed parent instruction, and must not be interpreted as new system/developer policy.

## Target design

### 1. Introduce one owner-scoped CheckInCoordinator

Add a small lifecycle component owned by the parent/subagent integration layer, not by the provider layer.

Suggested responsibilities:

- arm a child after admission/startup
- maintain one generation token and monotonically increasing checkInSequence per live child
- compute the next due time
- build a bounded snapshot from existing runtime/observatory state
- coalesce multiple due children for the same parent
- deliver through the existing AgentSession
- observe a transport/session acknowledgement
- re-arm only after acknowledgement
- cancel pending timers/notices on terminal state, explicit stop, or shutdown
- persist only minimal durable scheduling metadata for delegate_async jobs

Do not create a generic cron subsystem.

### 2. Check-in policy contract

Introduce a policy concept independent from execution timeout:

- checkInIntervalMs
  - default: 120000
  - minimum: 120000
  - values below the minimum are rejected, not silently clamped
- firstDueAt
  - admission/startup reference point + effective checkInIntervalMs
- nextDueAt
  - acknowledgedAt + effective checkInIntervalMs
- one outstanding check-in per child maximum
- no lifetime deadline and no extension budget

If startup itself is slow, the child startup deadline remains separate. Arm the first runtime check-in only after the child is admitted into a live running state, while retaining admission/startup events independently.

### 3. Exact scheduler semantics

For each child:

1. Admission creates generation G and sequence 0.
2. Once running, arm dueAt = runningAt + interval.
3. When due:
   - if already terminal, suppress and disarm
   - otherwise increment sequence and create one pending item
   - take a bounded current snapshot
4. Parent coordinator merges all currently due items for the same owner into one bounded check-in notice where practical.
5. Delivery uses the existing parent session.
6. While a notice is outstanding, no second timer may enqueue another notice for that child.
7. When the notice is confirmed consumed and its parent turn settles, mark it acknowledged.
8. Re-arm from acknowledgedAt + interval.
9. If the child becomes terminal at any point, invalidate the generation, cancel the timer, suppress stale callbacks, and allow the normal completion path to win.
10. If the owner is unavailable, keep only one owner-scoped overdue marker and latest bounded snapshot metadata. Do not generate a two-minute backlog.
11. When the owner becomes available, deliver one overdue check-in containing elapsed overdue duration and the latest current snapshot.

Timer callbacks must verify generation + sequence + live execution state before mutating anything. Follow OpenCode’s token/sequence idea rather than relying on timer cancellation alone.

### 4. Parent delivery seam

Prefer AgentSession.sendCustomMessage rather than direct prompt/provider calls.

The target call semantics should be equivalent to:

- customType: subagent_checkin
- details: typed, bounded SubagentCheckInNotice
- fixed parent-facing content describing that this is an ICE supervisory check-in
- options:
  - triggerTurn: true
  - deliverAs: followUp

Why this seam:

- packages/coding-agent/src/core/agent-session.ts:1502-1511 already routes followUp when streaming and triggers a turn when idle.
- It avoids a check-then-act race around isStreaming.
- It never needs steer, so a check-in does not interrupt an active user/model turn.
- It stays inside the normal parent retry/tool loop.

Do not call AgentSession.prompt from a timer unless tests prove a narrower existing API is required.

### 5. Acknowledgement semantics

A queued notice is not yet acknowledged.

Acknowledgement is a session-lifecycle fact:

- the custom check-in message has been consumed into a parent agent turn; and
- the corresponding parent processing settles.

Do not require the model to emit a magic acknowledgement token.

Implementation order:

1. Prove whether existing message/runtime events can correlate a specific custom message noticeId through consumption and settlement.
2. If they can, reuse them.
3. If they cannot, add the narrowest internal receipt/event necessary to correlate noticeId with consumption/settlement.
4. Do not add a second orchestration loop merely to obtain acknowledgements.

If the parent provider turn ultimately fails after its normal bounded retry path:

- keep the check-in as unacknowledged/overdue
- do not stop the child
- do not hot-loop a new provider request
- surface the pending state and retry only through the normal owner-session opportunity/queue semantics

### 6. Check-in notice schema

Define one bounded typed envelope, for example SubagentCheckInNotice:

- schemaVersion
- noticeId
- ownerSessionId
- createdAt
- dueCount
- children[] with:
  - runId or durable jobId, never an ambiguous generic id
  - resultRef when applicable
  - role
  - model
  - executionStatus
  - elapsedMs
  - phase
  - currentTool/currentPath when already sanitized
  - lastProgressAt / progressAgeMs
  - liveness freshness/advisory
  - bounded recent activity summaries
  - bounded usage/retry facts already exposed by observatory
  - isolation kind for writers
  - terminal race flag if terminal state was observed while constructing the notice

Hard requirements:

- cap number of children per notice to the owner’s actual bounded active set
- cap bytes per child and aggregate notice bytes
- redact through existing credential redaction helpers
- use existing SubagentProgressSnapshot/SubagentManagedObservation projections where possible
- do not embed arbitrary raw transcripts
- preserve resultRef/artifact indirection for large output
- format child-originated strings as data, not instructions

### 7. Parent decision vocabulary

For a running child the parent model should have a small, truthful action set:

- continue: take no control action; acknowledgement simply re-arms the next check-in
- peek/inspect: inspect bounded current state
- follow_up: send a bounded owner message into the same child session
- wait: bounded explicit wait when the parent intentionally wants synchronization
- stop: explicit cancellation/termination
- detach only if a distinct non-timeout lifecycle meaning remains after default background execution
- resume/delete only for retained terminal children as today

Timeout-derived actions should not survive as misleading no-ops:

- remove extend from new-run guidance and schema once no lifetime budget exists
- remove awaiting_extension / needs_time from new execution
- remove decisionGraceMs, extension reserve/count, and retention-as-extension accounting from new supervision
- audit detach separately; if its only remaining purpose was timeout retention, remove it rather than preserving dead API surface

### 8. Completion race

Terminal completion has precedence over periodic check-in.

Required race behavior:

- terminal before timer callback: no check-in
- timer callback before terminal but before delivery: refresh state; suppress if now terminal and allow completion notification
- terminal after parent notice queued: parent may see “completed since snapshot”; completion notice/result remains authoritative
- stale generation/sequence callback: no-op
- stop and natural completion race: one terminal result only
- no duplicate completion plus timeout terminal

### 9. Durable delegate_async behavior

Durable jobs remain a separate contract from managed delegate.

Persist only the durable policy needed to reconstruct the owner job contract:

- effective checkInIntervalMs
- no raw repeated notice bodies

Keep live scheduler state process-local:

- checkInSequence
- lastCheckInAcknowledgedAt
- pendingSince / overdueSince

This live delivery state is intentionally not restored because a process restart interrupts every in-flight durable job and never replays its worker or check-in timer. Persisting it across that boundary would create stale notices without a live child.

Keep existing behavior:

- ownerSessionId controls inspect/cancel/delivery
- bounded queue/concurrency/output budget
- append-only/session-native durable snapshot strategy
- accepted job IDs stay inspectable via retained result/tombstone semantics
- restart interrupts in-flight jobs; no automatic replay

On restart:

- interrupted terminal jobs do not re-arm timers
- old timed_out terminal rows stay historical
- a persisted “pending check-in” from a job that is now interrupted is cleared/suppressed by terminal reconciliation

### 10. Batch and review behavior

Convert batch/review child execution to the same non-blocking primitive only after single-child behavior is proven.

Requirements:

- preserve max task count and concurrency admission
- return an aggregate acceptance promptly rather than waiting for all children
- keep batchId/taskId identity separate from runId/jobId
- expose child run handles/result references sufficient for later inspection
- coalesce simultaneously due siblings into one parent check-in when possible
- never create N parent model turns for N children due in the same window
- preserve deterministic result ordering independent of completion order
- preserve reviewer model-routing and verification contracts
- normal completion can emit one aggregate completion notice plus bounded per-child result references
- if explicit aggregate retrieval is missing after non-blocking conversion, add the smallest owner-scoped aggregate inspection surface rather than making the original tool block again

### 11. Isolated writer behavior

delegate_write can become non-blocking only after all writer preflight/isolation guarantees have succeeded.

Acceptance boundary:

- validate clean parent/base commit
- create/validate isolated worktree
- resolve child authority
- only then return the background accepted handle

While the writer runs:

- keep worktree identity in the managed record
- include isolation/base-commit facts in bounded check-ins
- do not allow a check-in to grant wider tools
- explicit stop must trigger existing cleanup/rollback guarantees

On completion:

- preserve patch/change observation and parent verification
- preserve cleanup and stale/dirty parent checks
- never merge/apply writer output automatically because a check-in occurred

### 12. Settings and migration

Replace child-lifetime configuration with explicit check-in configuration.

Target naming:

- ice.subagents.checkInIntervalMs
- role/profile override with an equivalent check-in interval field if role-local control is still desired

Migration rules:

- default/minimum 120000 ms
- reject values below minimum
- do not silently reinterpret legacy timeoutMs as checkInIntervalMs; the meanings are different
- remove timeout-only UI/settings labels from new-run configuration
- keep a separately named startupTimeoutMs or equivalent internal operational deadline where startup currently needs a bound
- preserve parser support only where required to read historical persisted data; do not expose historical timeout state as a live setting

Also audit error/help strings such as packages/coding-agent/src/ice-subagents.ts:4707-4712 that currently instruct callers to use timeoutMs.

### 13. Observability and UX

Reuse existing Observatory projections.

Show, without implying failure:

- running/background
- elapsed time
- next check-in due / overdue
- last acknowledged check-in
- pending parent review
- phase/current bounded tool/path
- freshness advisory
- owner unavailable when relevant
- completion/resultRef

Do not show:

- red timeout countdown for a runtime that no longer has a lifetime deadline
- “needs extension”
- “will terminate in …”
- “timed out” for a new run that simply ran a long time

Keep ordinary print/headless output bounded and preserve existing JSON/RPC typed-details behavior.

## Dependency order

1. Freeze state model and parent-delivery contract with tests.
2. Implement the check-in coordinator and parent-session receipt semantics.
3. Convert one managed delegate path and remove runtime lifetime timeout from that path.
4. Migrate manage_subagent actions/statuses.
5. Extend the coordinator to durable delegate_async with persistence/owner-unavailable behavior.
6. Convert batch/review without breaking deterministic aggregation.
7. Convert isolated writer after writer admission/isolation preflight.
8. Migrate settings/profile/RPC/TUI/observability surfaces.
9. Remove obsolete timeout/extension code only after all paths no longer depend on it.
10. Run full focused regression and migration verification.

Do not begin by deleting the timeout supervisor. First create the replacement lifecycle and move callers, then remove dead lifetime logic.

## Stage 0 - Contract freeze and test scaffolding

- [x] S0.1 Define the independent execution, liveness, and check-in-delivery state vocabularies in tests before implementation.
  - Evidence: packages/coding-agent/src/ice-subagent-timeout-supervisor.ts:89-124 currently mixes lifetime attention with execution state.
  - Target: packages/coding-agent/test/ice-subagent-timeout-supervisor.test.ts or a new focused ice-subagent-checkin.test.ts.
  - Acceptance: tests demonstrate that stale/overdue/pending-parent states are non-terminal and cannot become timed_out.
  - Verify: focused test file passes.
  - Depends on: none.

- [x] S0.2 Add deterministic fake-clock cases for first due, acknowledgement-based re-arm, no-overlap, stale timer generation, and terminal-before-due races.
  - Target: new coordinator test file.
  - Acceptance: no wall-clock sleeps; every scheduling rule can be tested deterministically.
  - Verify: focused fake-clock suite passes.
  - Depends on: S0.1.

- [x] S0.3 Add parent-session delivery tests proving the intended sendCustomMessage semantics.
  - Evidence: packages/coding-agent/src/core/agent-session.ts:1487-1511.
  - Target: packages/coding-agent/test/custom-message.test.ts, packages/coding-agent/test/suite/agent-session-queue.test.ts, or a new focused queue test.
  - Acceptance: idle parent triggers one turn; streaming parent receives followUp after the active turn; no steer/interruption occurs.
  - Verify: focused AgentSession queue/custom-message suites pass.
  - Depends on: none.

- [x] S0.4 Prove an acknowledgement correlation seam.
  - Target: AgentSession/runtime event tests.
  - Acceptance: a noticeId can be correlated to actual consumption plus settle without parsing model prose; if existing events are insufficient, the test documents the required narrow new internal event.
  - Verify: focused lifecycle event test passes.
  - Depends on: S0.3.

## Stage 1 - CheckInCoordinator and parent injection

- [x] S1.1 Implement an owner-scoped coordinator with generation + sequence guards and one outstanding notice per child.
  - Likely files: packages/coding-agent/src/ice-subagent-checkin.ts (new) or a narrowly named sibling module; minimal integration in ice-subagents.ts.
  - Reference: Agent_harness_references/opencode/packages/core/src/background-job.ts:126-164 for token/sequence race suppression.
  - Acceptance: arm/due/coalesce/ack/re-arm/terminal invalidation are explicit and deterministic.
  - Verify: S0 fake-clock suite.
  - Depends on: S0.1-S0.2.

- [x] S1.2 Build the bounded sanitized SubagentCheckInNotice from existing runtime/observatory projections.
  - Evidence: packages/coding-agent/src/ice-subagent-observatory.ts:144-220.
  - Acceptance: no raw transcript, credential-like data is redacted, child-originated text is capped, IDs remain typed.
  - Verify: adversarial long-output/secret/path cases.
  - Depends on: S1.1.

- [x] S1.3 Deliver notices through parent AgentSession.sendCustomMessage with triggerTurn + followUp semantics.
  - Evidence: packages/coding-agent/src/core/agent-session.ts:1502-1511.
  - Acceptance: one existing parent loop only; busy parents are not interrupted; idle parents can review immediately.
  - Verify: S0.3 plus integration test with a live fake parent session.
  - Depends on: S0.3-S0.4, S1.1.

- [x] S1.4 Implement consumption/settlement acknowledgement and acknowledgement-based scheduling.
  - Acceptance: nextDueAt is derived from acknowledgedAt, not enqueue time; provider failure leaves one pending overdue notice and does not hot-loop.
  - Verify: transient retry, final provider failure, busy parent, and delayed follow-up tests.
  - Depends on: S0.4, S1.3.

- [x] S1.5 Add owner-unavailable coalescing.
  - Reference: Agent_harness_references/oh-my-pi/packages/coding-agent/src/async/job-manager.ts:134-150.
  - Acceptance: no cross-owner fallback, no two-minute backlog, one overdue marker/latest bounded snapshot, child continues.
  - Verify: close/replace owner session test.
  - Depends on: S1.1-S1.4.

## Stage 2 - Managed delegate conversion and timeout removal

- [x] S2.1 Make the normal delegated child path return a managed background acceptance after admission while the same child session continues.
  - Evidence: packages/coding-agent/src/ice-subagents.ts:11191-11195 and :14377-14388 already implement the optional primitive.
  - Acceptance: no duplicate runner/session is created; returned runId is the live owner-scoped handle.
  - Verify: packages/coding-agent/test/ice-subagents.test.ts and ice-subagent-reuse-delete.test.ts.
  - Depends on: Stage 1.

- [x] S2.2 Arm the first check-in only when the child reaches live running state.
  - Acceptance: startup failure produces startup failure, not a periodic check-in; first running check-in is never earlier than 120 s effective interval.
  - Verify: startup-success/failure fake clock tests.
  - Depends on: S2.1.

- [x] S2.3 Remove child lifetime expiry from the managed path while preserving startup/provider/tool/hook/shutdown bounds.
  - Evidence: packages/coding-agent/src/ice-subagent-timeout-supervisor.ts:190-218 contains lifetime timers; packages/coding-agent/src/ice-subagents.ts:1730-1757 contains a distinct startup bound.
  - Acceptance: a healthy child running beyond the old timeout remains running until completion or explicit cancellation.
  - Verify: former timeout test advanced past old budget stays non-terminal; startup timeout still fails as intended.
  - Depends on: S2.2.

- [x] S2.4 Migrate manage_subagent away from timeout-only actions and messaging.
  - Evidence: packages/coding-agent/src/ice-subagents.ts:11215-11232,11385-11395,13943-13950.
  - Acceptance: inspect/peek/wait/follow_up/stop plus terminal resume/delete remain truthful; extend/needs_time/awaiting_extension are removed from new-run semantics; detach is either given a distinct non-timeout meaning or removed.
  - Verify: ice-subagent-timeout-multiplexing.test.ts and ice-subagent-reuse-delete.test.ts updated to the new lifecycle.
  - Depends on: S2.3.

- [x] S2.5 Preserve completion-vs-check-in race correctness.
  - Acceptance: exactly one terminal completion result; stale timer callbacks no-op; no timeout terminal can race completion.
  - Verify: deterministic completion-at-due-boundary tests.
  - Depends on: S1.1, S2.3.

## Stage 3 - Durable delegate_async

- [x] S3.1 Extend durable job records with the effective check-in interval; running check-in sequence state remains process-local because restart interrupts jobs without replay.
  - Evidence: packages/coding-agent/src/ice-subagent-jobs.ts:70-80,209-218.
  - Acceptance: the effective check-in interval survives the supported persistence boundary; live sequence/ack/overdue state remains process-local and is discarded when restart reconciliation marks the job interrupted. Repeated raw notice bodies are never persisted.
  - Verify: packages/coding-agent/test/ice-subagent-durable-journal.test.ts and ice-subagent-jobs.test.ts.
  - Depends on: Stage 2.

- [x] S3.2 Route durable check-ins only to the owning parent session and coalesce when the owner is absent.
  - Evidence: packages/coding-agent/src/ice-subagent-jobs.ts:1218-1230 owner-only inspection; Oh My Pi owner-sink reference above.
  - Acceptance: another session cannot inspect, consume, or receive the notice.
  - Verify: cross-session denial and owner-reconnect tests.
  - Depends on: S3.1, S1.5.

- [x] S3.3 Preserve restart interruption/no-replay semantics.
  - Acceptance: a restart-loaded previously running job is interrupted/terminal according to current policy; no check-in timer is re-armed and no worker is relaunched.
  - Verify: durable restart recovery tests.
  - Depends on: S3.1.

- [x] S3.4 Keep completion inbox distinct from periodic check-in metadata.
  - Evidence: packages/coding-agent/src/ice-subagent-observatory.ts:236-270.
  - Acceptance: completion is not lost because a check-in is pending, and a pending check-in is suppressed once terminal completion is reconciled.
  - Verify: completion-during-owner-absence test.
  - Depends on: S3.1-S3.3.

## Stage 4 - Batch and review conversion

- [x] S4.1 Convert delegate_batch to aggregate background acceptance without weakening task-count/concurrency/output reservations.
  - Target: packages/coding-agent/src/ice-subagents.ts batch executor and packages/coding-agent/test/ice-subagent-concurrency.test.ts.
  - Acceptance: parent tool returns after all children are admitted, not after all complete; child identities remain inspectable.
  - Verify: delayed-child fixture proves parent is free while children still run.
  - Depends on: Stage 2.

- [x] S4.2 Coalesce due sibling check-ins.
  - Acceptance: up to the bounded active sibling set due in one window results in one parent check-in turn, not N turns; each child keeps its own sequence/ack state.
  - Verify: 8-child fake-clock test with one parent notice.
  - Depends on: S4.1, Stage 1.

- [x] S4.3 Preserve deterministic aggregate ordering/result references.
  - Acceptance: result order follows task definition, not completion order; aggregate completion points to bounded child results/artifacts.
  - Verify: reverse-completion-order test.
  - Depends on: S4.1.

- [x] S4.4 Convert review_batch with the same lifecycle while preserving reviewer routing and verification.
  - Acceptance: background review cannot widen model/tool policy; final reviewer aggregation remains verifiable.
  - Verify: existing routing/result-contract suites plus new background case.
  - Depends on: S4.1-S4.3.

## Stage 5 - Isolated writer conversion

- [x] S5.1 Establish the writer acceptance point only after isolation preflight/worktree creation succeeds.
  - Evidence: idea.md:350 and existing writer W5 contracts.
  - Target: packages/coding-agent/src/ice-subagents.ts writer path.
  - Acceptance: caller never receives a “running writer” handle for a failed/invalid worktree setup.
  - Verify: packages/coding-agent/test/ice-writer-w5.test.ts.
  - Depends on: Stage 2.

- [x] S5.2 Attach writer isolation/base-commit metadata to bounded check-ins.
  - Acceptance: parent can distinguish read-only child from isolated writer without exposing arbitrary Git output.
  - Verify: writer check-in projection test.
  - Depends on: S5.1, S1.2.

- [x] S5.3 Preserve stop/cleanup/verification races.
  - Acceptance: explicit stop cleans up according to existing guarantees; natural completion still returns observed patch/change evidence; no automatic merge/apply.
  - Verify: W5 stop, tamper, stale-parent, cleanup, verifier-failure regressions.
  - Depends on: S5.1-S5.2.

## Stage 6 - Settings, APIs, observability, and docs

- [x] S6.1 Add checkInIntervalMs resolution with default/minimum 120000 ms.
  - Target: settings schema/resolution in packages/coding-agent/src/ice-subagents.ts and related settings modules.
  - Acceptance: global/project/profile precedence remains deterministic; values below minimum fail visibly.
  - Verify: packages/coding-agent/test/ice-subagent-settings.test.ts and ice-subagent-profile-controls.test.ts.
  - Depends on: Stage 2.

- [x] S6.2 Remove live timeoutMs/extension semantics from tool/profile/settings surfaces and rename operational startup bounds distinctly.
  - Evidence: packages/coding-agent/src/ice-subagents.ts:4707-4712 currently directs callers toward timeoutMs.
  - Acceptance: no user-facing field implies a child lifetime timeout; startup deadlines remain bounded.
  - Verify: schema snapshots/settings/RPC tests.
  - Depends on: S6.1, all converted execution paths.

- [x] S6.3 Update Observatory and owner views with next-check-in/overdue/pending-parent facts.
  - Target: packages/coding-agent/src/ice-subagent-observatory.ts, IceAgentViewBridge, /agents and /subagents projections.
  - Acceptance: stale/overdue is visually advisory and does not masquerade as terminal failure.
  - Verify: packages/coding-agent/test/ice-subagent-observatory.test.ts, ice-agent-view-bridge.test.ts, ice-agent-view-integration.test.ts, subagent-footer.test.ts as applicable.
  - Depends on: S1.2, Stage 3.

- [x] S6.4 Preserve typed RPC/JSON behavior.
  - Acceptance: check-in fields appear only in structured details/events; ordinary print remains bounded and stable unless intentionally documented.
  - Verify: rpc-jsonl.test.ts, rpc.test.ts, relevant command-schema/settings tests.
  - Depends on: S6.3.

- [x] S6.5 Update prompts/help/changelog/idea documentation.
  - Acceptance: no surviving instructions tell the model to extend a runtime timeout; docs explain background acceptance, periodic check-ins, explicit stop, owner absence, and historical timed_out records.
  - Verify: repository search for stale phrases plus changelog tests.
  - Depends on: S2.4, S6.1-S6.4.

## Stage 7 - Cleanup and release verification

- [x] S7.1 Delete obsolete lifetime supervisor branches only after no live path depends on them.
  - Target: packages/coding-agent/src/ice-subagent-timeout-supervisor.ts and callers.
  - Acceptance: no decision grace, extension budget, execution expiry timer, needs_time, or new-run timed_out production path remains; reusable activity/progress logic is moved rather than duplicated if still needed.
  - Verify: TypeScript references/search plus focused lifecycle tests.
  - Depends on: Stages 2-6.

- [x] S7.2 Verify no unbounded duplicate timer/listener retention.
  - Acceptance: terminal/stop/shutdown removes timers and listeners; one pending notice max per child; repeated cycles do not leak handles.
  - Verify: fake timer leak test and process-exit/shutdown test.
  - Depends on: S7.1.

- [x] S7.3 Run the focused regression matrix.
  - Acceptance: every matrix row below is green.
  - Verify: 26 selected test files passed with 594 tests green and 18 intentional skips; the repaired `ice-subagents.test.ts`, `ice-agent-view-integration.test.ts`, and `ice-subagent-readiness.test.ts` reran together at 282/282 after formatting.
  - Depends on: all prior stages.

- [x] S7.4 Run npm run check from repository root after focused suites are green.
  - Acceptance: lint/typecheck/format contract passes with no unrelated file rewrites.
  - Verify: `corepack npm@12.0.2 run check` exited 0 on the final pass with `Checked 1167 files ... No fixes applied`; pinned deps, TS imports, shrinkwrap/install-lock, `tsgo --noEmit`, and browser smoke all passed.
  - Depends on: S7.3.

## Verification matrix

| Scenario | Required outcome | Primary test area |
|---|---|---|
| Single delegated child admitted | parent receives handle promptly; child continues | ice-subagents.test.ts |
| Child completes before first due | completion only; no stale check-in | new check-in suite |
| Child exceeds old timeout | still running; no timed_out/needs_time | timeout-supervisor migration suite |
| First due boundary | no earlier than 120000 ms effective interval | fake-clock suite |
| Parent idle at due | one custom check-in triggers parent turn | custom-message / AgentSession queue |
| Parent busy at due | followUp queued; active turn not interrupted | AgentSession queue |
| Parent busy for multiple intervals | one outstanding notice only | check-in suite |
| Two or more siblings due | one coalesced parent turn with per-child entries | batch/check-in suite |
| Parent check-in settles | next due based on acknowledgement time | fake-clock suite |
| Parent model transient failure | existing retry applies; no child termination | agent-session-retry + check-in integration |
| Parent model terminal failure | notice remains overdue; no hot loop; child continues | check-in integration |
| Owner session absent | no cross-owner delivery; one overdue marker | jobs/check-in integration |
| Owner returns | one current overdue notice delivered | jobs/check-in integration |
| Child completes while notice pending | terminal result wins; stale timer suppressed | race suite |
| Explicit stop | child cancellation and cleanup remain deterministic | timeout-multiplexing/reuse/writer |
| follow_up | same child session receives bounded message | reuse-delete/managed lifecycle |
| bounded wait | waitMs remains bounded; timeout is observer wait only | timeout-multiplexing migration |
| process-local managed run restart | not recovered as durable | managed lifecycle |
| durable job restart | interrupted/no replay; no timer re-arm | durable-journal/jobs |
| historical timed_out record | readable historical terminal state only | persistence migration |
| batch reverse completion | deterministic task ordering | concurrency/batch |
| review background | model routing + verification unchanged | routing/result contract |
| isolated writer background | worktree/base-commit/isolation preserved | ice-writer-w5.test.ts |
| long/hostile child output | bounded/redacted/non-instructional notice | adversarial suite |
| cancellation at due instant | exactly one terminal outcome | fake-clock race suite |
| shutdown with pending check-in | timers/listeners cleared; no late parent call | process-exit/runtime |
| RPC/JSON | typed details preserved | rpc-jsonl/rpc |
| TUI/Observatory | advisory check-in/freshness shown without timeout semantics | observatory/view/footer |

## Risks and mitigations

### Risk: timer causes re-entrant parent provider calls

Mitigation:
- timers only enqueue through AgentSession.sendCustomMessage
- use triggerTurn + followUp semantics
- no direct provider call
- no steer for periodic check-ins

### Risk: acknowledgement is ambiguous

Mitigation:
- correlate noticeId to session consumption/settlement
- add a narrow internal receipt event if current events cannot prove it
- never parse assistant prose for “ack”

### Risk: eight children produce eight model turns

Mitigation:
- owner-level due queue
- coalesce due children
- one outstanding check-in per child
- re-arm only after acknowledgement

### Risk: child runs forever after parent disappears

Requested semantics forbid elapsed-time auto-kill. Mitigation is observability and bounded delivery state, not a hidden lifetime timeout:
- one owner-unavailable overdue marker
- explicit shutdown/session cancellation remains
- durable restart still interrupts/no-replays
- operators can inspect/stop explicitly
- no repeated model-call backlog

### Risk: removing timeout accidentally removes startup/tool safety

Mitigation:
- name startupTimeoutMs distinctly
- keep provider retry/request bounds
- keep hook/tool deadlines
- keep waitMs as an observer bound
- tests separately prove each survives lifetime-timeout removal

### Risk: child output prompt-injects the parent check-in

Mitigation:
- fixed parent instruction separated from child observations
- existing redaction
- hard byte limits
- structured fields
- large output by resultRef/artifact
- explicit wording that child text is untrusted data

### Risk: historical data/schema regression

Mitigation:
- read old timed_out records as terminal history
- do not rewrite them
- schema/version migrations tested
- never auto-resume old running/timed_out entries

### Risk: batch conversion loses final aggregate results

Mitigation:
- retain child run/result references
- deterministic aggregate completion record
- add only the smallest owner-scoped aggregate inspection surface if required after async conversion

### Risk: writer backgrounding weakens isolation

Mitigation:
- background acceptance occurs after isolation preflight
- same worktree and authority stay attached to run
- no check-in control may widen tools or auto-apply changes

## Rollback and recovery

Implementation should be staged so the old timeout path can remain intact until the new check-in path has proven single-child behavior.

Safe rollout sequence:

1. Add coordinator/tests without routing production calls to it.
2. Enable for one managed delegate path behind an ICE-internal capability/feature switch if needed for dogfood.
3. Prove parent delivery, races, and cleanup.
4. Migrate durable jobs.
5. Migrate batches/reviews.
6. Migrate writers.
7. Change settings/schema defaults and remove timeout-only API surface.
8. Delete dead timeout lifetime code last.

Rollback before Stage 7 should consist of routing launches back to the prior supervisor path, not reverting persistence formats or deleting user data.

Once persisted check-in metadata ships, rollback readers must tolerate/ignore the new optional fields.

## Definition of done

The implementation is complete only when all of the following are verified:

- [x] Normal delegated work is non-blocking after admission and the parent can continue unrelated work.
- [x] First and later parent check-ins are never scheduled more frequently than the effective minimum/default 120000 ms policy.
- [x] Later check-ins are re-armed from acknowledgement, not timer enqueue.
- [x] Parent busy state uses safe followUp semantics and never periodic steer.
- [x] Multiple due children can be coalesced into one bounded parent review.
- [x] No child lifetime timeout, extension budget, decision grace, needs_time, awaiting_extension, or new-run timed_out path remains.
- [x] Startup/provider/tool/hook/wait/output/concurrency/cancellation/shutdown bounds remain.
- [x] Explicit stop remains the normal parent termination mechanism.
- [x] Check-in state, liveness/freshness, and execution status are independent.
- [x] Missing owner sessions cannot receive through another owner or create an unbounded notice backlog.
- [x] Durable jobs remain owner-scoped, restart-interrupted, non-replayed, bounded, inspectable, and cancellable.
- [x] Managed delegate remains process-local.
- [x] Batch/review deterministic ordering, routing, verification, and concurrency limits remain.
- [x] Writer worktree/base-commit/isolation/verification/cleanup guarantees remain.
- [x] Historical timed_out records remain readable but cannot drive new runtime behavior.
- [x] Check-in payloads are bounded, redacted, typed, and treat child output as untrusted data.
- [x] Observatory/TUI/RPC surfaces describe check-in/overdue state without implying timeout failure.
- [x] Focused lifecycle, race, persistence, batch, writer, settings, RPC, and observability tests pass.
- [x] npm run check passes after focused suites.
- [x] No unrelated concurrent workspace changes were modified.

## Implementation guidance for the next agent

The critical architectural choice is not “replace one timer with another timer.” It is:

child runtime continues independently + bounded scheduler marks review due + existing parent AgentSession receives one owner-scoped custom follow-up/turn + session lifecycle acknowledges review + scheduler re-arms.

The closest external design is Prime Agent’s heartbeat-to-existing-session-queue architecture combined with Claude Code’s background task handle and Oh My Pi’s owner-scoped async delivery. ICE’s recurring child-specific parent review is intentionally a new composition.

Do not start by deleting ice-subagent-timeout-supervisor.ts. First prove the parent check-in delivery/ack path, migrate the managed delegate path, and only then remove lifetime-specific supervisor state that has no remaining caller.
