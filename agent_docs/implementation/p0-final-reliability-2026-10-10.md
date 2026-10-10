# Remaining P0 reliability closure — 2026-10-10

## Objective and scope

Complete the native runtime fork/import/teardown, extension factory lifecycle, message ordering/queued input, retry backoff, and terminal SSE backlog identified after the first two P0 batches. Reconcile the V2 roadmap against current code without silently expanding policy or API scope. Preserve concurrent workspace edits; no commit, push, Curax snapshot, credential copying, or reference-harness changes.

## Implemented

- `core/agent-session-runtime.ts`: fork settles before copying/mutating history; teardown waits for compaction/tree settlement; imports use exclusive copies and choose a fresh filename for existing basenames.
- `core/agent-session.ts`: explicit native-operation settlement barrier, separate from `isIdle`; context-only messages persist after tool results and enter the loop's next context through the existing next-turn refresh hook. Explicit `triggerTurn: false` never schedules another turn. Explicit delivery modes without that override retain steering/follow-up behavior.
- `core/extensions/loader.ts`: factory-time provider operations, flag defaults, and bus subscriptions are staged until factory success. Failed factories revoke their API and dispose loader-owned listeners. Event subscriptions return idempotent unsubscribe callbacks and use copy-on-write handler arrays. Tool/command/flag registrations validate their required shapes.
- `core/extensions/runner.ts`: invalidation disposes owned bus subscriptions; ordinary session disposal invalidates its runner.
- Direct `steer`/`followUp` interception runs input handlers once before expansion. With no handlers, enqueueing remains synchronous. Compaction queues input in the existing queues; successful manual compaction drains it, cancellation retains it without automatic restart.
- `ai/utils/retry.ts`: shared finite/timer-safe exponential backoff, default 60 seconds, optional assistant-policy `maxDelayMs`; settled sleep listeners detach. Native session and Codex exponential retry use the same helper.
- `ai/utils/provider-retry.ts`: malformed, negative, and non-finite delay headers fall back to ordinary backoff.
- `agent/proxy.ts`: trailing SSE lines and decoder state flush at EOF; missing terminal events produce explicit errors instead of unresolved results; terminal events stop reading and release the reader.
- `ai/api/openai-codex-responses.ts`: EOF frame flush and CRLF delimiter handling, including delimiters split across byte chunks.

## Regression evidence

New files:

- `coding-agent/test/suite/regressions/9340-runtime-session-settlement.test.ts`
- `coding-agent/test/suite/regressions/8423-extension-factory-transaction.test.ts`
- `coding-agent/test/suite/regressions/9340-message-queue-integrity.test.ts`
- `agent/test/proxy.test.ts`
- `ai/test/codex-sse-eof.test.ts`

Existing retry tests add invalid-header and exponential-cap cases. Discovery/runner fixtures now declare valid flag types. Existing compaction prompt/RPC tests assert accepted queueing rather than the superseded rejection contract.

Observed red-to-green failures covered active-turn fork mutation, imported-file overwrite, shutdown before hook settlement, factory registration/listener leaks, stale APIs, handler-list mutation, malformed registrations, invalid retry delays, missing SSE terminal events, extra custom-message turns, bypassed input handlers, and rejected compaction prompts. A stronger regression also caught session-state versus loop-context divergence and now verifies the next provider request sees the custom message.

## Verification and artifacts

Pinned npm: active and required `12.0.2`. Node: `v24.21.0`. All automated model tests use local fixtures/faux providers, not real APIs.

- `corepack npm@12.0.2 run check`: passed, including lint, dependency/import/install-lock checks, types, and browser smoke.
- Affected builds: AI `build:offline`, agent `build`, coding-agent `build`: passed. No catalog regeneration or dependency metadata change.
- `./test.sh`: passed after rebuilding runtime exports and updating superseded compaction expectations. Full output retained at `.artifacts/p0-final-reliability-2026-10-10/offline-suite.log`.
- Build survey: `ice` on PATH resolves to this worktree's `packages/coding-agent/dist/ice.js`; changed runtime files are fresh. Evidence: `.artifacts/p0-final-reliability-2026-10-10/build-survey.txt`.
- Live tmux smoke from `/tmp`, memory-only session, `cx/gpt-6-luna`, low thinking: startup and exact `P0_SMOKE_OK` reply observed. Plan-mode guard also exercised draft/propose/read-plan behavior; this was not a tool-free run. `/compact` correctly reported `Nothing to compact (session too small)`. A successful live-provider compaction was not certified. Captures: `tui-reply.txt`, `tui-compaction.txt` under the same artifact directory. Test tmux session was terminated.

## Boundaries

Factory staging does not roll back arbitrary extension filesystem/process/network effects or arbitrary effects during registration publication. Native settlement does not provide multi-process session-file locking or undo already-saved checkpoints. Cancelled compaction input remains recoverable through existing queue controls; it is not silently replayed on teardown. Live smoke does not certify cancellation races, every provider, or V2 UI/lifecycle behavior.

## V2 reconciliation (not claimed complete)

Current source corrects stale roadmap statements:

- SDK `agents` is implemented in `src/subagents/v2/sdk.ts`, with `attach`, `overview`, and approval responses. Direct child-control wrapper methods remain absent.
- RPC `get_subagents`, `subagents_update`, and `respond_subagent_approval` are implemented in `src/modes/rpc/rpc-mode.ts`; dedicated launch/stop/delete/output commands remain absent.
- Explicit parent-orphan pruning is implemented; automatic parent-session deletion cascade is a separate data-retention decision, not a reliability patch to apply blindly.
- Parent gate evaluator rebase remains a report-only comparison/enforcement migration task; `ice-safe-verify.ts` still owns explicit plan/build tool sets.
- Worktree host ceilings are implemented; user-configurable lower ceilings remain deferred.
- `subagents/isolation/apply.ts` refuses conflicts without applying a partial parent patch, but does not persist conflict artifacts.
- `subagents/results/v2-result.ts` conservatively caps assurance at observed evidence consistency: semantic criterion verification, executed verification-command assurance, and reviewer assurance are not wired. Background aggregate/artifact search parity remains deferred.

These are distinct follow-up scopes, not shipped capabilities or passing acceptance criteria. Workgraph distribution/fencing work, Cognee defaults, Curax snapshot publication, Git integration, and autonomous-mode certification remain outside this batch.
