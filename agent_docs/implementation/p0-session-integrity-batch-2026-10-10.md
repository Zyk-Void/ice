# P0 session integrity and cancellation batch — 2026-10-10

## Scope

Continuation of `p0-reliability-batch-2026-10-10.md`. Implemented bounded native compaction/tree cancellation guards and three session integrity corrections. Earlier first-message persistence, generated-summary validation, fail-closed Bash routing, provider pricing, agent-loop cancellation, and concurrent UI changes remain preserved.

This is source verification, not installed-runtime certification or completion of the entire upstream audit.

## Reproduced failures and fixes

### Unterminated session JSONL tails

**Red:** three deterministic tests showed a new record joined directly to the existing unterminated tail. On reload, the loader skipped the joined line, losing valid records or the new entry.

**Fix:** `SessionManager._persist()` opens the existing append path with one read/append descriptor, checks the last byte, and prefixes a newline when needed. It does not truncate or erase the previous bytes. Tests cover UTF-8 user content, ordinary metadata appends, and malformed partial tails. Opening a current-version session alone remains non-repairing.

**Limits:** malformed lines still use existing skip behavior; this separates records rather than validating/reconstructing partial JSON. There is no multi-process writer lock, transaction, or power-loss durability guarantee.

### Fork context boundaries and branch provenance

**Red:** a fork that filtered labels left `CompactionEntry.firstKeptEntryId` pointing at a removed entry, dropping retained messages from rebuilt context. Branch summaries recorded the destination/root rather than the abandoned leaf.

**Fix:** `createBranchedSession()` builds an O(n) map from each removed label to the next retained path entry, remaps compaction boundaries, and retains parent re-chaining. `branchWithSummary()` captures the source leaf before moving to the destination. Regression coverage verifies memory-only and persisted forks, source-file preservation, consecutive labels, and root/non-root destinations.

**Limits:** historical stored `fromId` values are not rewritten. Imported runtime filename collisions and active-turn fork settlement remain separate work in `AgentSessionRuntime`.

### Native compaction and tree-navigation cancellation

**Red:** tree navigation could mutate the leaf during manual compaction; a second navigation replaced the first abort controller; an aborted awaiting tree hook still saved its supplied summary. Authentication received no cancellation signal, automatic compaction could ignore synchronous start cancellation, and a post-save completion callback could still request an overflow retry. A final regression also showed manual cancellation was lost while awaiting active-run settlement.

**Fixes in `AgentSession`:**

- Manual, automatic, and tree operations retain local controller references and clear shared fields only when still their owner.
- Summarization auth passes the operation signal through `ModelRuntime.getAuth`, checks it before/after awaits, and never swallows cancellation in the custom-stream fallback.
- Manual compaction exposes its controller before active-run settlement. It stops the agent/retry directly rather than calling `abort()` and aborting its own newly owned compaction controller.
- Manual and automatic compaction check cancellation after extension work and before saving. Automatic compaction owns its controller before auth/start callbacks and stops dispatch immediately on cancellation.
- Tree navigation rejects while native compaction or another tree navigation is active. Compaction rejects/skips while tree navigation owns its controller. Aborted tree hooks/auth return cancelled without moving the leaf or writing a summary.
- Automatic cancellation during post-save hooks/events prevents retry/continuation. Already-saved checkpoints remain in durable history.
- Manual cancellation retains the existing `Compaction cancelled` message and `AbortError` classification. Existing characterization tests were preserved rather than weakened.

**Limits:** native entry-point guards do not police arbitrary direct `SessionManager` mutations by extensions. They do not make `waitForIdle` a general settlement barrier for manual compaction/tree operations. Runtime teardown/fork settlement needs its own inspection and tests. A suggested broad `isIdle` change was not applied because making compaction wait on its own lock could deadlock.

## Files changed in this batch

Source:

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/session-manager.ts` (earlier persistence changes preserved)

Regressions:

- `packages/coding-agent/test/session-manager/unterminated-tail.test.ts`
- `packages/coding-agent/test/session-manager/fork-integrity.test.ts`
- `packages/coding-agent/test/suite/regressions/9178-tree-during-compaction.test.ts`
- `packages/coding-agent/test/suite/regressions/9340-compaction-auth-cancellation.test.ts`

Docs:

- `packages/coding-agent/docs/compaction.md`
- `packages/coding-agent/docs/sessions.md`
- `packages/coding-agent/CHANGELOG.md` (Unreleased only)
- `idea.md` (implemented versus remaining roadmap)
- This report.

## Verification

All regression suite model requests use the existing `createHarness` and faux provider. No real inference, MCP servers, build, or user settings changes were used.

| Check | Exit/result |
|---|---|
| Unterminated-tail tests before fix | 1; three reproduced failures |
| Tree ownership tests before fix | 1; three reproduced failures |
| Compaction auth/start cancellation tests before fix | 1; three failures |
| Post-save retry cancellation before fix | 1; returned true despite cancellation |
| Fork integrity tests before fix | 1; three failures |
| Active-run-settlement cancellation before final repair | 1; cancellation returned success |
| Final focused run (17 test files) | 0; 161 tests passed |
| `corepack npm@12.0.2 run check` final | 0; active npm 12.0.2 |
| `./test.sh` final | 0 |
| `git diff --check` | 0 |

The check includes lint/formatting, pinned dependency/import/install metadata checks, TypeScript, and browser smoke. Test and check artifacts are retained under `.artifacts/ice-p0-session-integrity-2026-10-10/`.

## Remaining priorities

1. Reinspect runtime fork/import filename integrity, active-turn in-memory fork settlement, and teardown settlement without widening the single-loop architecture or making compaction await itself.
2. Transactional extension initialization and listener cleanup.
3. Custom-message/tool-result ordering and queued input handling.
4. Bounded retry delays and terminal SSE-frame flushing.
5. Reconcile remaining V2 SDK/RPC/delegation items with current implementation, then runtime rebuilding/live verification.

Workgraph distribution and lease-CAS limitations, Cognee defaults, Curax snapshot publication, commits/pushes/merges, and broader architecture changes remain explicit decisions. No such actions were performed.
