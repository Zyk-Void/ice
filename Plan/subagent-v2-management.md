# Subagent V2 Management Improvements

Status: Phases 0-4 committed (2026-10-08, a014a175a). Follow-ups 3-5 implemented; live verification completed after startup-setting fixes. Deferred items remain.

## Problem

The parent model manages subagents poorly, and the UI miscounts them:

- Finished children never end. They stay `idle` in memory (up to 8), then park to disk, and are removed only by an explicit `agent_control action=delete`. Nothing tells the model to delete them, so the roster, the agent strip, and `alt` cycling fill with dead children.
- The completion follow-up gives no next step and no status of siblings.
- The `agent` tool guidance is one paragraph; it does not cover when not to delegate, how to brief a child, polling, waiting, or reporting results to the user.
- Children are addressed only by 28-character IDs.
- Running children show `0 tok` / `0 turns`: usage reaches the registry only when the turn ends.
- Children waiting for a slot show `starting` instead of `queued`.
- `agents 0/4` counts only running turns; idle children are invisible in the footer.
- `maxConcurrent` has a hard ceiling of 24 that neither reference harness has.

## Reference findings (evidence)

| Topic | Claude Code (`Agent_harness_references/claude-code`) | Prime Agent (`Agent_harness_references/prime-agent`) | ICE today |
|---|---|---|---|
| Finished child | Terminal `completed`/`failed`/`killed`; output evicted; leaves the panel after `PANEL_GRACE_MS = 30_000` unless the UI retains it (`tasks/LocalAgentTask/LocalAgentTask.tsx`, `utils/task/framework.ts`) | Failed/cancelled children removed from the registry; parent teardown cancels descendants (`docs/rlm-runtime.md` failure modes) | Stays `idle` forever; delete only on request |
| Continue a child | `SendMessage` resumes from the saved transcript (`tools/AgentTool/resumeAgent.ts`) | `agent_message` to a retained child | `resume=<id>` revives from disk (works) |
| Cleanup guidance | Not needed (terminal by default) | "Delete a direct child explicitly with `await rlm.delete_subagent(child)` when it is no longer needed" (`src/core/prompts/rlm.ts`) | None |
| Delegation guidance | When not to use; writing the prompt; "never delegate understanding"; don't poll/peek; don't fabricate while waiting; result not visible to the user; parallel in one call (`tools/AgentTool/prompt.ts`) | End the turn instead of awaiting; spawn independents separately; delete when done (`src/core/prompts/rlm.ts`) | One paragraph |
| Identity | Optional `name`, used by `SendMessage` | Required `name`, unique among siblings | ID only |
| Concurrency | No cap | No cap; depth limit only (default 2) | default 4, hard ceiling 24 |

## Phases

Each phase is independently shippable, keeps the single authoritative Ice loop, and changes only the subagent extension, its runtime, and UI projections.

### Phase 0: Accurate counts (bug fix) — implemented

Changes:
- `ResidentChild.liveUsage` references the in-flight `TurnResultContext.usage`; cleared in `finishTurn` before the usage is added to the record (no double count).
- The runtime calls a new `V2RuntimeHost.onChildActivity` after each child assistant message; the extension maps it to `notifyHub` so the Hub, strip, and RPC `subagents_update` refresh during a turn.
- `overview()` and `describeChild()` report record usage plus `liveUsage`.
- `overview()` reports `state: "queued"` for a child whose turn is waiting for an admission slot (resident has a pending run, record still `starting`/`idle`, not yet admitted). Admission marks the resident as admitted.
- Footer: `agents R/M` gains `· N idle` when idle children exist.

Acceptance:
- A running child shows non-zero tokens after its first model response, before its turn ends.
- Totals after the turn equal the old end-of-turn totals.
- With `maxConcurrent: 1` and two children, the waiting one shows `queued`.

Tests: runtime overview test with a gated faux response (live tokens, queued state, no double count); footer idle count.

### Phase 1: Finished children retire automatically — implemented

Rule: a child whose turn ended and that is not resumed within a grace period leaves memory and the live views, but stays resumable.

Changes:
- After a turn settles (`completed`, `failed`, `budget_exhausted`, `cancelled`) and the child has no pending turn, foreground wait, open patch operation, or controlled view, schedule parking after `RETIRE_GRACE_MS = 30_000` (same as Claude Code's panel grace). A new turn cancels the timer. Parking already keeps the transcript and contract on disk; `resume=<id>` revives it.
- The agent strip and `alt` cycling list only resident children (unchanged), so retired children disappear from them automatically.
- Agent Hub: split the roster into "Active" (starting, queued, running, idle, blocked) and "Finished" (parked). The header counts active children; finished ones stay listed below for inspection, resume, and delete.
- Auto-delete children that never ran a turn (`usage.turns === 0` after a turn cancelled while queued, no patch state). They hold no transcript work.
- `overview().children[*]` adds `finished: boolean` so RPC clients can make the same split.

Not in this phase: deleting parked children with transcripts automatically. Their transcripts are the audit trail and the resume source; the model or user deletes them.

Acceptance:
- 30 s after a background child completes with no follow-up, it is parked and absent from the strip and `alt` cycling; the Hub lists it under Finished; `resume=<id>` continues it with full context.
- A child cancelled while queued disappears from the roster.

Tests: runtime test with injected timers (retire after grace, timer cancelled by a new turn, never retire a child with an open patch); Hub grouping test.

### Phase 2: Model guidance — implemented

Changes:
- `agent` tool: keep the description short and move guidance into `promptGuidelines`, adapted from both references:
  - delegate independent, context-heavy, or parallel work; do a known file read, lookup, or 2-3 file search yourself;
  - write a complete brief: goal and why, what is known or ruled out, exact paths, expected output and length; never delegate understanding;
  - launch independent tasks in one call; use `background=true` only when you have other work;
  - do not poll: background completions arrive as messages; do not use `agent_control wait` in a loop; while waiting, report status, never invented results;
  - the child's report is not shown to the user: summarize it;
  - continue a child with `resume=<id or name>` when its context helps; delete children you will not need again.
- `agent_control`: fix "delete (remove a stopped child)" to "delete (stop if running, then remove)"; describe `wait` as a bounded one-time wait, not polling.
- Completion follow-up: append sibling status ("2 other subagents still running: a, b") and next actions ("continue with resume=<id>; delete with agent_control action=delete when no longer needed").
- `agent_control wait` ends early when the user queues a message (polled every 250 ms) or presses `ctrl+b`, and says why; previously the user could not reach the parent until the wait timed out.
- Not done: the foreground-result trailer (foreground calls already return every report together).

Acceptance: guidelines appear in the system prompt with the `agent` tool active; follow-ups include sibling status and next actions.

Tests: extension test for guideline presence; runtime test for the follow-up text.

### Phase 3: Names — implemented

Changes:
- `agent` task field `name` (optional, `^[a-z0-9][a-z0-9-]{0,39}$`), unique among the owner's non-deleted children; a duplicate fails the whole batch before acceptance.
- Persist `name` in `ChildRecord` (optional field; existing records restore unchanged).
- `resume`, `agent_control id/ids`, and RPC accept a name or an ID; ambiguous or unknown names fail with the candidate list.
- Hub, strip, footer, completion messages show `name` when set.

Acceptance: a child launched with `name: "auth-review"` can be resumed, messaged, inspected, and deleted by that name, also after restart.

Tests: name validation, uniqueness, resolution, restart persistence.

### Phase 4: Concurrency without a hard ceiling — implemented

Changes:
- Remove the 24 ceiling: `maxConcurrent` accepts any integer >= 1 (default stays 4). `SubagentConcurrencyAdmission` drops the hard-cap check; `SUBAGENT_CONCURRENCY_LIMITS.hardCap` is removed (the leftover legacy job registry keeps its own literal limit).
- The agent strip counts queued children separately from idle ones.
- Keep: project settings may only lower the user value; excess turns queue (visible as `queued`).
- RPC settings field drops its `max` constraint.

Rationale: the cap protected memory/CPU and provider rate limits, but the user owns those tradeoffs; the queue and the visible count already make load observable.

Acceptance: `maxConcurrent: 50` is accepted and enforced.

### Deferred

- Slimmer common `agent` schema (advanced fields grouped or documented as optional).
- Fork (inherit parent context and prompt cache).
- Child-to-parent messages during a turn.
- Child usage folded into parent session totals: completed in handoff Task 5 (see Follow-ups).
- Parent-session cascade cleanup on session deletion (plan P5.8).

## Verification per phase

- Focused unit and faux-provider suite tests listed per phase.
- `corepack npm@12.0.2 run check`.
- Rebuild `coding-agent` and smoke-test in tmux with `cx/gpt-6-luna`: launch background children, watch live tokens, queued labels, retirement after 30 s, resume by name.

## Follow-ups

- Task 2 — done (`9931b03f9`, `9e1af319f`): early initialization honors global settings and existing trusted project limits. Live Luna checks cover queue/capacity, Hub usage, completion, retirement/reopen, wait interruption, name-based status, and tinted edit rows.
- Task 3 — done (`e75542224`, `8801d3c6e`): background reports carry up to 16 KiB with a report-relative byte-offset continuation hint; inline/artifact remainder reads, error-prefix and multibyte cases, and bounded sibling trailers pass.
- Task 4 — done (`5cb1169f9`): fullscreen unseen-message pill uses the configured transcript-bottom key; component/integration tests and live scroll/count/End check pass.
- Task 5 — done (`4de4c6815`): durable child usage enters parent billing totals and the Subagents cost bucket; context accounting stays unchanged; persistence, validation, and footer tests pass.
