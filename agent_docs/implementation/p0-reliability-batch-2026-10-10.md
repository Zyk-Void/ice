# P0 reliability batch — 2026-10-10

## Scope and status

Implemented and source-verified: failed user Bash routing, generated-summary validation, and first-user-message persistence. This is the first bounded batch of the remaining correctness backlog, not completion of the upstream audit, Subagents V2 roadmap, or runtime delivery.

The older baseline is recorded in `agent_docs/pi-upstream/2026-10-04/coding-core.md`. Current code was reinspected rather than replaying upstream patches wholesale. Existing UI, provider-pricing, agent-loop, and nested Workgraph changes were preserved.

## Implemented behavior

### User Bash routing fails closed

- `packages/coding-agent/src/core/extensions/runner.ts`, `ExtensionRunner.emitUserBash`: handler exceptions emit an extension error and reject the routing call. Malformed responses also reject; subsequent handlers and local execution are not reached.
- `undefined` remains deliberate pass-through. A response needs custom `operations.exec`, a complete `BashResult`, or both. Complete results retain precedence at the callers.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, `handleBashCommand`: catches routing errors before constructing a Bash component or executing/recording a command. Returning normally lets the existing submit handler exit Bash input mode.
- RPC already catches rejected routing calls and returns a command error; no second RPC execution path was added.
- Boundary: effects performed inside a handler before it throws are not rolled back. Direct SDK `executeBash` callers are responsible for choosing their routing policy.

### Generated summaries must be complete text

- `packages/coding-agent/src/core/compaction/compaction.ts`, `completeSummarization`: strips tools and tool selection on copied request inputs, preserving provider/auth/stream seams, cache isolation, and configured transient retries.
- Validates after transient retries: only `stopReason: "stop"`, nonblank text, and no tool-call blocks are accepted. Length truncation, tool use, blank output, errors, and aborts cannot become native summaries.
- Cancellation observed after provider completion is classified as aborted. History and split-turn callers throw `AbortError`; branch generation retains its `{ aborted: true }` contract.
- Tests assert rejected compaction does not create entries or replace active history.
- Boundary: completion/shape validation is not semantic verification. Extension-owned summaries bypass native generation. Navigation and session-mutation races beyond this generation boundary remain a separate batch.

### Save the request before waiting for the reply

- `packages/coding-agent/src/core/session-manager.ts`, `_persist`: metadata-only startup stays lazy; the first user or assistant message writes the header and buffered entries immediately. Subsequent entries append.
- `createBranchedSession`: user-only paths are written immediately, with matching persistence state to prevent duplicate headers. Metadata-only forks remain lazy.
- Memory-only sessions still write no files. `flushDurably` remains the explicit fsync barrier; ordinary saving is not a power-loss durability guarantee.
- Boundary: this does not implement malformed JSONL tail repair, imported fork collision handling, active-turn fork settlement, or compaction-boundary remapping after label filtering.

## Documentation

Operator and extension contracts are documented in:

- `packages/coding-agent/docs/extensions.md` — `user_bash` return/failure behavior.
- `packages/coding-agent/docs/compaction.md` — generated-summary validation and its limits.
- `packages/coding-agent/docs/sessions.md` — first-message persistence and durability boundaries.
- `packages/coding-agent/CHANGELOG.md` — three Unreleased fixes.
- `idea.md` — implemented versus remaining correctness work.

## Regression files

- `packages/coding-agent/test/suite/user-bash-routing.test.ts`
- `packages/coding-agent/test/interactive-mode-bash-routing.test.ts`
- `packages/coding-agent/test/suite/compaction-summary-validation.test.ts`
- `packages/coding-agent/test/suite/first-message-persistence.test.ts`
- `packages/coding-agent/test/session-manager/tree-traversal.test.ts` — updated user-only fork expectation while retaining duplicate-entry checks.

Suite tests use the existing harness and faux provider; no real inference requests were used.

## Verification

- First-message regression before implementation: exit 1, two failures (missing request before provider response and missing user-only branch file).
- Focused Bash routing: exit 0, nine runner tests plus one interactive test.
- Persistence plus session-manager tests: exit 0, 100 tests at the initial milestone; metadata-only-fork coverage was added afterward and passed in the final offline suite.
- Expanded compaction validation plus existing transient-retry regression: exit 0, 18 tests.
- Combined targeted run before the final coverage expansion: exit 0, 174 passed, two skipped.
- Initial full offline run: exit 1. Manual cancellation was misclassified as failure by the new rejection path. Restoring `AbortError` fixed this; the existing abort-backoff regression was not weakened.
- Final `corepack npm@12.0.2 run check`: exit 0. Active npm: `12.0.2`. Includes formatting/lint, pinned dependency/import/lock checks, TypeScript, and browser smoke.
- Final `./test.sh`: exit 0. Full log: `/tmp/ice-p0-batch-offline-tests-final.log`; initial failed log: `/tmp/ice-p0-batch-offline-tests.log`.
- Final `git diff --check`: exit 0.

No build, live-provider certification, Curax snapshot, settings changes, commit, push, merge, or branch deletion was performed. Source checks do not certify stale installed `dist`.

## Next bounded work

1. Reinspect and fix compaction cancellation/navigation races and session JSONL/fork integrity with isolated regressions.
2. Reinspect transactional extension initialization/listener cleanup and custom-message/tool-result ordering.
3. Reinspect bounded retry delays and terminal SSE frame flushing.
4. Reconcile the V2 roadmap against current SDK/RPC implementation before changing those APIs; dated backlog entries are not implementation authority.
5. Rebuild affected runtime packages and perform live verification when authorized. Keep live provider inference on the configured `cx/gpt-6-luna` smoke route.
6. Keep Workgraph distribution, its same-assignee lease metadata CAS limitation, Cognee defaults, Curax publication, and external Git side effects as explicit decisions rather than silently changing them.
