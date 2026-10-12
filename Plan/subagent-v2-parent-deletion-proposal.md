# Parent deletion and retained child data: investigation

Task 6 of the Sol handoff, 2026-10-08. Investigation and proposal only; no runtime or selector changes.

## Observed behavior

Session replacement is already covered: `AgentSessionRuntime.teardownCurrent()` emits `session_shutdown` for new/resume/fork, disposal emits quit, and the V2 extension calls `runtime.shutdown()`. Shutdown aborts runs, waits for settlement, and disposes residents. This is separate from deletion of an inactive parent's file.

The selector's `deleteSessionFile()` in `src/modes/interactive/components/session-selector.ts` passes only the parent JSONL path to trash or unlink. It neither emits a deletion event nor consults child data. Child sessions live under `<sessionDir>/subagents/<parentId>/`. Explicit V2 child deletion has its own worktree removal path; selector parent deletion does not use it.

A scratch fixture was created through the actual V2 runtime with the faux provider. Its general child used worktree isolation, completed one turn, and retained a change to a.txt. The runtime was shut down before deleting its parent. The local ICE selector was opened in tmux with:

```text
ice --model cx/gpt-6-luna --ice-mode build --session-dir /tmp/ice-smoke/task6-GNatzl/sessions --resume
```

Only `sol-task6-delete-parent` was listed. Ctrl+D opened confirmation; Enter removed it. The selector then reported no sessions in the current folder. No live provider request was made.

Before deletion: parent, child transcript, and worktree all existed. Afterwards:

```text
parentExists: false
childExists: true
worktreeExists: true
parent: /tmp/ice-smoke/task6-GNatzl/sessions/2026-10-08T04-22-43-194Z_01a119bf-cefa-7632-83f5-b2fc7d75ceac.jsonl
child: /tmp/ice-smoke/task6-GNatzl/sessions/subagents/01a119bf-cefa-7632-83f5-b2fc7d75ceac/2026-10-08T04-22-43-277Z_ag_gedmeuucb4xwhgymzjzgobkmq6.jsonl
worktree: /tmp/ice-smoke/task6-GNatzl/sessions/subagents/01a119bf-cefa-7632-83f5-b2fc7d75ceac/worktrees/ag_gedmeuucb4xwhgymzjzgobkmq6
```

`git worktree list --porcelain` still listed the child as a detached worktree. Its directory contained the child JSONL and worktrees directory. The scratch fixture is retained for review; no user session was deleted.

Full local evidence: `.artifacts/sol-subagent-v2-handoff/task6-fixture.json`, `task6-after.json`, and `task6-selector-{before,confirm,after}.txt`. These are ignored artifacts, not committed session contents.

## Options

| Option | Benefit | Tradeoff |
| --- | --- | --- |
| Generic session-deleted extension event | Keeps the selector independent of subagent storage; extensions can mark ownership and offer cleanup | Requires an upstream-compatible lifecycle API, including inactive sessions, event timing, and failure behavior; deletion must not imply permission to destroy unreviewed child work |
| Delete the sibling subagents directory from the selector | Small direct cleanup path | Couples core UI to ICE layout; permanent recursive removal could defeat trash recovery, lose patches, and leave git worktree metadata or durable output references behind |
| Explicit `ice agents prune` command | Keeps core UI compatible and makes retention/cleanup a reviewable user action | Orphans remain until pruning; missing parents alone are insufficient evidence of safe deletion |

Recommend the explicit prune command first. Default it to an inventory/dry run and require explicit selection before destructive cleanup. Validate owned frozen contracts and canonical containment; detect active owners and relocated/trashed parents; retain dirty worktrees and unresolved integration/recovery data unless independently reviewed. Use the existing owned-worktree cleanup path, reconcile output references, and retain a tombstone or manifest for audit/recovery. A missing JSONL must not automatically authorize deletion. A generic deletion event can later mark candidates without changing this retention policy.

Prime Agent's `docs/rlm-runtime.md` documents descendant cancellation on parent teardown and durable tombstones on explicit child deletion while retaining transcripts/artifacts. That is evidence for separating runtime shutdown from artifact retention; it does not establish a parent-selector cascade cleanup feature.

## Limits

The probe demonstrates one completed child with an unapplied worktree change. Crash recovery, trash restoration, concurrent processes, moved sessions, and malformed ownership records were not exercised. No cleanup implementation or keybinding/schema/legacy removal is proposed in this task's code changes.
