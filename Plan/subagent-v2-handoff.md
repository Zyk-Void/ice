# Subagent V2 Handoff Plan (for Sol)

Written 2026-10-08 by Claude. Claude reviews the result later. Read this whole file, then `AGENTS.md` and `Plan/subagent-v2-management.md`, before doing anything.

- Worktree: `/home/mewtwo/Zks/ice/.worktrees/all-worktrees-experimental`
- Branch: `integration/all-worktrees-experimental` (not `void`). Do not switch branches.
- Package: `packages/coding-agent` unless stated. Paths below are relative to it unless they start with `packages/` or `Plan/`.
- Line numbers are from 2026-10-08 and may drift by a few lines; search for the quoted symbol if a line does not match.

---

## 0. Ground rules (mandatory, from `AGENTS.md`)

### Editing
- Read a file in full before editing it. Preserve the user's own uncommitted edits (list in section 0.3).
- Erasable TypeScript only (Node strip-only mode): no `enum`, `namespace`, parameter properties, `import =`. No `any` unless unavoidable. Top-level imports only: no `await import()`, no `import("pkg").Type`.
- Inline single-line helpers that have only one call site.
- Never hardcode key checks such as `matchesKey(data, "ctrl+x")`. Add defaults to `DEFAULT_APP_KEYBINDINGS` (`src/core/keybindings.ts`) or the TUI keybinding table (`packages/tui/src/keybindings.ts`), and show keys with `keyText(...)` from `src/modes/interactive/components/keybinding-hints.ts`.
- Comments: match the surrounding density; explain why, not what.
- Ask (stop and report) before removing functionality that looks intentional.

### Git
- Never: `git add -A`, `git add .`, `git stash`, `git reset --hard`, `git checkout .`, `git clean -fd`, `git commit --no-verify`, push, merge, release, deploy.
- Stage explicit paths only. Run `git status --short` before every commit and confirm nothing from section 0.3 is staged.
- Commit message: `{feat,fix,docs}(coding-agent): <concise message>`, optional body, last line `Co-Authored-By: <your model> <noreply@...>`.
- One commit per task (Task 1 is its own commit).

### Changelog
`packages/coding-agent/CHANGELOG.md`, under `## [Unreleased]`. Read the whole section first. Append bullets to the existing `### Added`, `### Changed`, `### Fixed`, `### Removed` subsections (they exist; never create duplicates). Released version sections are immutable.

### Commands
The active npm is 11.x; the repo requires npm 12.0.2. Use corepack:

```bash
# worktree root; must exit 0; read the full output (it runs biome --write, tsgo, and repo checks)
corepack npm@12.0.2 run check

# focused tests, run from packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts
# TUI package tests, from packages/tui
node ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts
```

- Never run the full vitest suite, `npm test`, or root `npm run build` (the root build calls plain `npm` = 11.x and fails, and the `ai` build regenerates the model catalog from the network).
- Rebuild the local `ice` command (`~/.local/bin/ice` -> `packages/coding-agent/dist/ice.js`):

```bash
cd packages/coding-agent
../../node_modules/.bin/tsgo -p tsconfig.build.json
../../node_modules/.bin/shx chmod +x dist/cli.js dist/ice.js dist/rpc-entry.js
corepack npm@12.0.2 run copy-assets
ice --version   # prints 0.83.0
# If Task 4 changes packages/tui, also: cd ../tui && corepack npm@12.0.2 run build
```

- Shell quirks: `rm` is aliased to interactive; use `command rm -f`. `python3` creates a `.venv` in the current directory; write helper scripts in Node instead. zsh fails on unquoted globs: quote `--include='*.ts'`.
- Live model smoke tests: `--model cx/gpt-6-luna`, in a scratch directory (not the repo), inside tmux:

```bash
tmux new-session -d -s ice-test -x 140 -y 40 -c /tmp/ice-smoke
tmux send-keys -t ice-test "ice --model cx/gpt-6-luna --ice-mode build" Enter
sleep 10 && tmux capture-pane -t ice-test -p
tmux kill-session -t ice-test
```

Exit ICE with `ctrl+d` on an empty editor. `ctrl+c` does not exit; text typed after it becomes a prompt.

### Test sets
Subagent set (run after every subagent change; baseline 337 passing):

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/suite/subagents-v2-runtime.test.ts test/suite/subagents-v2-results.test.ts test/suite/subagents-v2-hooks.test.ts test/suite/subagents-v2-sdk.test.ts test/suite/subagents-v2-budget.test.ts test/subagents-v2-extension.test.ts test/subagents-v2-cli-events.test.ts test/subagents-v2-hub.test.ts test/subagents-v2-registry.test.ts test/subagents-v2-contracts.test.ts test/subagents-v2-worktree.test.ts test/subagents-v2-permissions.test.ts test/subagents-v2-definitions.test.ts test/footer-width.test.ts test/ice-agent-view-bridge.test.ts test/subagent-footer.test.ts test/rpc-settings.test.ts test/ice-subagent-jobs.test.ts
```

UI set (run after footer/interactive/TUI changes): `test/footer-width.test.ts test/status-line.test.ts test/interactive-mode-status.test.ts test/tool-execution-component.test.ts test/compact-tool-rows.test.ts test/edit-tool-no-full-redraw.test.ts`.

Known unrelated failure: `test/appearance-baseline.test.ts` > "default user message preserves current box geometry" fails because of the user's uncommitted `paddingY: 1 -> 0` in `src/modes/interactive/appearance/appearance-defaults.ts`. Do not touch it.

Test conventions: faux provider only (`test/suite/harness.ts`, `createHarness({ extensionFactories, persistSession: true })`); no real provider calls in tests. Subagent runtime tests use the `setup()`/`host()`/`runOne()`/`task()`/`unfinished()` helpers at the top of `test/suite/subagents-v2-runtime.test.ts`. Fake timers: `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })` and always restore in `finally`.

### 0.3 The user's own uncommitted work: never stage, never revert
`Plan/subagent-rewrite.md`, `Plan/subagent-v2-regression-ledger.md`, `README.md`, all of top-level `docs/`, `html-communication/`, `idea.md`, `packages/coding-agent/README.md`, `packages/coding-agent/docs/{docs.json,extensions.md,index.md,observability.md,security.md,settings.md,subagents-v2.md,usage.md}`, `packages/coding-agent/docs/subagents-v2-architecture.md`, `packages/coding-agent/docs/subagents-v2-migration.md`, `packages/coding-agent/src/modes/interactive/appearance/appearance-defaults.ts`, `packages/coding-agent/src/modes/interactive/components/user-message.ts`, `packages/coding-agent/test/appearance-user-message-layout.test.ts`, `packages/tui/src/utils.ts`, `packages/tui/test/background-line.test.ts`.

Mixed files (both the user's and our edits; do not stage, list in the report): `packages/coding-agent/docs/rpc.md`, `packages/coding-agent/docs/subagents-v2-reference.md` (untracked, the user's file).

---

## 1. Context

### 1.1 History
Commits on this branch (newest first): `d55e28fdd` dock agent list removed + legacy footer capacity; `b9e02ab5a` `createIceSubagents` SDK helper; `af11a078b` V2 settings schema, RPC overview/approvals, navigation keys, diff tints; `30a4c24bc` legacy subagent tools removed; earlier commits built V2.

Uncommitted (this handoff's Task 1): Phases 0-4 of `Plan/subagent-v2-management.md`: live usage and `queued` state, retirement of finished children after 30 s, delegation guidance, completion next-actions, `agent_control wait` yields to user messages, child names, no concurrency ceiling, strip queued count.

### 1.2 ICE subagent V2 map (where things live)

| File | Role |
|---|---|
| `src/subagents/v2/extension.ts` | Registers `agent`, `agent_control`, `agent_patch`, `/agents`; tool descriptions (`AGENT_TOOL_DESCRIPTION`, `AGENT_TOOL_GUIDELINES`, `AGENT_CONTROL_DESCRIPTION`); live-session source for the view bridge; Hub source; lifecycle hooks `ice.on("session_start")` (~341) and `ice.on("session_shutdown")` (~389) |
| `src/subagents/v2/runtime.ts` | `SubagentV2Runtime`: owner state (`state()` ~136, throws `busy` at ~140 if an old owner exists), `launch()`, `runTurn()` (~855), `finishTurn()` (~1082), retirement (`scheduleRetire`/`retire`), `deliverCompletion()` (~1250), `flushCompletions()` (~1279), `completionTrailer()` (~1315), `resolveChildRef()`, `overview()`, `describeChild()`, `shutdown()` |
| `src/subagents/v2/runtime-support.ts` | `ResidentChild`, `OwnerState`, `V2RuntimeHost`, `SubagentV2Error`, constants: `COMPLETION_SUMMARY_LIMIT` (line 30, 4 KiB), `RESULT_TEXT_LIMIT` (48 KiB); `boundedText()` (~275) |
| `src/subagents/registry/registry.ts` | `ChildRegistry` (durable records in the parent session as custom entries), `ChildRecord`, `sessionJournal()` (~31), `waitFor()` (~317), `park()`, `delete()` |
| `src/subagents/registry/child-sessions.ts` | `childSessionDirectory(parentSessionDir, parentSessionId)` = `<sessionDir>/subagents/<parentSessionId>` (line 16) |
| `src/subagents/registry/admission.ts` | `SubagentConcurrencyAdmission` (no upper bound now) |
| `src/subagents/v2/settings.ts` | V2 `ice.subagents` schema and resolver |
| `src/subagents/ui/hub.ts` | Agent Hub view |
| `src/ice-agent-view-bridge.ts` | Bridge between the extension and host modes: live views, `IceSubagentOverview`, `setSubagentControlSource` |
| `src/modes/interactive/components/subagent-view-switcher.ts` | One-line agent strip above the footer |
| `src/modes/interactive/components/footer.ts` | Footer, `renderSubagentSegment()`, usage totals loops (~289 legacy, ~448 customized) |
| `src/modes/rpc/rpc-mode.ts`, `rpc-types.ts`, `rpc-client.ts` | `get_subagents`, `respond_subagent_approval`, `subagents_update` |
| `src/subagents/v2/sdk.ts` | `createIceSubagents()` |

---

## Task 1: Commit Phases 0-4 (small)

1. `git status --short` and `git diff --stat`. Expected own files:
   - `Plan/subagent-v2-management.md`, `Plan/subagent-v2-handoff.md`, `packages/coding-agent/CHANGELOG.md`
   - `src/ice-agent-view-bridge.ts`, `src/modes/interactive/components/footer.ts`, `src/modes/interactive/components/subagent-view-switcher.ts`, `src/modes/rpc/rpc-settings.ts`
   - `src/subagents/api/agent.ts`, `src/subagents/api/agent-control.ts`, `src/subagents/api/agent-patch.ts`, `src/subagents/contract/child-runtime-contract.ts`
   - `src/subagents/registry/admission.ts`, `src/subagents/registry/jobs.ts`, `src/subagents/registry/registry.ts`, `src/subagents/types.ts`, `src/subagents/ui/hub.ts`
   - `src/subagents/v2/extension.ts`, `src/subagents/v2/runtime.ts`, `src/subagents/v2/runtime-support.ts`, `src/subagents/v2/settings.ts`
   - tests: `test/footer-width.test.ts`, `test/ice-agent-view-bridge.test.ts`, `test/subagent-footer.test.ts`, `test/rpc-settings.test.ts`, `test/subagents-v2-extension.test.ts`, `test/subagents-v2-hub.test.ts`, `test/subagents-v2-contracts.test.ts`, `test/suite/subagents-v2-runtime.test.ts`, `test/suite/subagents-v2-sdk.test.ts`
   If `git status` shows any other modified file not in section 0.3, inspect its diff and report it; do not stage it blindly.
2. Run `corepack npm@12.0.2 run check` and the subagent set. Both must pass.
3. Stage exactly those paths and commit:
   `feat(coding-agent): retire finished subagents, add names and live counts, guide delegation`
   Body: one line per phase from `Plan/subagent-v2-management.md`.

Acceptance: `git status --short` afterwards lists only section 0.3 files and the two mixed docs.

---

## Task 2: Live verification (small)

1. Rebuild (section 0 commands).
2. Scratch dir: `mkdir -p /tmp/ice-smoke && printf 'alpha\n' > /tmp/ice-smoke/a.txt` (create a.txt..e.txt).
3. Read `~/.ice/agent/settings.json` in full. Set `ice.subagents.maxConcurrent` to `2` (create the keys if absent). Record the original value and restore it at the end. Change nothing else.
4. In tmux start `ice --model cx/gpt-6-luna --ice-mode build` in `/tmp/ice-smoke` and send: `Launch four named background explore subagents (names: read-a, read-b, read-c, read-d); each reads one of a.txt..d.txt and reports its content. Then wait for their results without polling.`
5. Capture the pane every few seconds and check:
   - [ ] Footer: `agents 2/2 · 2 queued` while running (format from `footer.ts` `renderSubagentSegment`).
   - [ ] Agent strip (line above the footer): `Agents 2 working · 2 queued ...`.
   - [ ] `left` on an empty editor opens the Hub: names shown in bold before descriptions, `queued` rows, running rows with growing `tok`; inspector shows `Usage: 0 turns + 1 running`.
   - [ ] Each completion message: `Subagent explore "read-a" (ag_...) finished: completed.`, then the report, then the `Next: continue it with resume=...` line and the sibling line.
   - [ ] About 30 s after a child finishes: it moves under `Finished (enter resumes and opens)` in the Hub and leaves the strip. Enter on it resumes and opens it.
   - [ ] Ask the model to run `agent_control action=wait` on a child that is still running (prompt it explicitly), then type any message: the wait ends within about a second with "Stopped waiting because the user sent a message".
   - [ ] `agent_control action=status id=read-a` works (ask the model).
   - [ ] Ask it to edit a.txt: the diff shows a `NN + ` gutter and tinted full-width rows.
6. Restore `settings.json`. Kill the tmux session.

Report every check as pass/fail with the relevant pane capture. Fix only clear bugs, each with a regression test, in a separate `fix(coding-agent): ...` commit.

---

## Task 3: Background completion message size (small)

Problem: `deliverCompletion()` (`src/subagents/v2/runtime.ts` ~1250) cuts the child's final answer with `boundedText(text, COMPLETION_SUMMARY_LIMIT)`; the limit is 4 KiB (`runtime-support.ts:30`) and the marker is just `\n[truncated]` (`boundedText`, `runtime-support.ts` ~275). Long reports reach the parent model cut, with no hint how to read the rest.

Change:
1. `COMPLETION_SUMMARY_LIMIT = 16 * 1024`.
2. In `deliverCompletion`, when `boundedText(...).truncated` is true, replace the generic marker with `\n[Report truncated at 16 KiB; read the full report with agent_control action=output id=<childId> offset=<bytes>]` (use the real child ID, and the byte length actually kept as the offset hint). Keep `boundedText` itself unchanged (other callers rely on it).
3. Keep the total message (summary plus trailer) bounded: summary limit plus the fixed trailer.

Tests (`test/suite/subagents-v2-runtime.test.ts`, near "delivers a background completion to the parent exactly once"):
- final answer of 20 KiB -> `parent.sent[0].content` contains the new marker with the child ID, and the summary part is at most 16 KiB;
- final answer of 10 KiB -> arrives intact, no marker.

Changelog `### Changed`: completion messages carry up to 16 KiB of the child's report and say how to read the rest.

---

## Task 4: "N new messages" jump-to-bottom pill (medium; not subagent related)

User request (screenshot of Claude Code): when the transcript is scrolled up in fullscreen mode and new content arrives, show a pill like `3 new messages (end) ↓` just above the input area. Jumping (key or the pill's key) scrolls to the bottom and hides it.

### Reference: Claude Code
`/home/mewtwo/Zks/ice/Agent_harness_references/claude-code/src/components/FullscreenLayout.tsx`
- Props `newMessageCount` / `onPillClick` (lines ~60-66): count 0 shows "Jump to bottom", >0 shows "N new messages".
- Lines ~70-160: when the view first leaves the bottom ("sticky breaks"), snapshot the message count; the divider sits after the last message that existed then. Jumping calls `scrollToBottom()` and clears the snapshot.
- `countUnseenAssistantTurns()` (~200-225): counts assistant turns with visible text after the snapshot; tool-use-only assistant entries and progress entries do not count; consecutive assistant entries are one turn.
- `NewMessagesPill` component (~491); rendered only when not hidden, visible, and no overlay (~372).

### ICE internals
- `packages/tui/src/components/scroll-view.ts`: `ScrollView` with `follow: "end"`; `isFollowingEnd` getter (~65), `scrollToEnd()` (~164), `scrollTop`, `viewportHeight`. No change events: derive state at render time.
- `packages/tui/src/tui-alt-screen.ts`: implicit scroll view (~149), `scrollToBottom()` (~321), key handling for `tui.altScreen.bottom` (~403).
- `packages/tui/src/keybindings.ts`: `tui.altScreen.bottom` default `end` (~163). Line ~87 binds `["end", "ctrl+end", "ctrl+e"]` to an editor action (check which): verify which handler receives `end` in fullscreen with focus in the editor before choosing the pill's key text. If `end` is consumed by the editor, add a new app action (for example `app.transcript.jumpToBottom`, default `ctrl+end`) to `DEFAULT_APP_KEYBINDINGS` and wire it in `interactive-mode.ts` like other `onAction` handlers (~3420-3450), conditional on the pill being visible so it falls through otherwise (`onConditionalAction`).
- `src/modes/interactive/interactive-mode.ts`:
  - `transcriptScrollView` field (~414), created at ~972 with the document container.
  - Fullscreen layout (~985-997): `dock = new TuiLayouts.VStack([pendingMessagesContainer, statusContainer, widgetContainerAbove, editorContainer, widgetContainerBelow, agentSwitcherContainer, footerContainer])`, then `fullscreenLayoutRoot = VStack([transcriptScrollView (grow), dock])`.
  - View state save/restore uses `isFollowingEnd` (~2174-2188).
  - Inline (non-fullscreen) mode has no `transcriptScrollView`: show no pill there.

### Design
1. New component `src/modes/interactive/components/new-messages-pill.ts`:
   - constructor takes the `ScrollView`, a function returning the current transcript messages (`() => this.session.messages`, or for a displayed subagent view, that session's messages; check `getDisplayedView()` usage in `interactive-mode.ts`), and the theme.
   - `render(width)`: if `scrollView.isFollowingEnd`, clear the snapshot and return `[]`. Otherwise, on the first render after following stops, snapshot `messages.length`; count unseen assistant turns since the snapshot with the same rules as Claude Code (assistant messages with non-empty text content; consecutive assistant messages count once; tool results and tool-only assistant messages do not count). Render one centered line: `N new message(s) (<key>) ↓`, or `Jump to bottom (<key>) ↓` when N is 0. Style with theme tokens (for example `theme.bg("selectedBg", theme.fg("text", ...))`), truncate to width, never wider than the terminal.
2. Mount it in the dock above `pendingMessagesContainer` (first VStack entry, `shrink: 1, minSize: 0`), only in fullscreen.
3. Jump action: `transcriptScrollView.scrollToEnd()` plus request render; the next render clears the snapshot.
4. Re-render: the pill reads state at render time, so scroll and streaming renders update it automatically. Verify that scrolling triggers a render.

### Tests
- `test/new-messages-pill.test.ts`: a fake `ScrollView` stand-in (`{ isFollowingEnd }`) and message arrays: following -> `[]`; scrolled up then two assistant text messages appended -> `2 new messages`; tool-only assistant message does not count; back at bottom -> `[]` and the snapshot resets; width truncation.
- If a real `ScrollView` is easy to drive from the TUI tests, add one integration test that scrolls up, appends, jumps, and asserts `isFollowingEnd`.

Changelog `### Added`: the fullscreen "N new messages" jump-to-bottom pill, with its key.
Live check: fullscreen ICE (`--ui-mode fullscreen`), scroll up during a long answer, see the pill count, press the key.

---

## Task 5: Subagent usage in parent totals (medium)

Problem: child tokens and cost show only in the Agent Hub. The parent's footer totals (`footer.ts` legacy ~289-305 and customized ~448-460 loops), `/session` stats (`AgentSession.getSessionStats()`, `src/core/agent-session.ts` ~3380-3410), and the per-model cost breakdown (`getUsageCostBreakdown()`, `src/core/usage-totals.ts`, used by `interactive-mode.ts` ~7245) ignore them.

### Reference: Prime Agent
`/home/mewtwo/Zks/ice/Agent_harness_references/prime-agent/packages/coding-agent/src/core/agent-session.ts`
- `attributeChildUsage()` (~1216): adds child usage to the parent assistant message's usage for billable totals, but restores `totalTokens` so the parent's context-window measurement is unchanged.
- ~11000-11030: appends a `child_usage_attributed` session entry (`appendChildUsageAttribution(parentEntryId, childUsage, aggregateUsage, origin)`) and re-applies it on reload.
- Doc: `.../prime-agent/packages/coding-agent/docs/rlm-runtime.md` section "Usage and Cost Attribution" (~175-186).

### Design for ICE (simpler: a separate entry, no mutation of assistant messages)
1. In `finishTurn()` (`runtime.ts` ~1082), after the registry update, append a durable parent custom entry through the parent session manager (same mechanism as `sessionJournal()` in `registry.ts` ~31): `customType: "subagent_usage"`, `data: { childId, agent, usage: { input, output, cacheRead, cacheWrite, cost } }` from `resultContext.usage`. Skip when all values are 0.
2. `src/core/usage-totals.ts`: export `subagentUsageFromEntry(entry): Usage | undefined` that returns a `Usage` for `entry.type === "custom" && entry.customType === "subagent_usage"` (validate field types; ignore malformed). This keeps core generic: it reads a custom entry by type, and no subagent imports go into core.
3. Add that usage into the three totals loops (footer legacy, footer customized, `getSessionStats`). In `getUsageCostBreakdown()` put it under a `Subagents` key.
4. Never add it to context usage (`getContextUsage()`); context is the parent model's window only.
5. Footer cost display: if child cost > 0, show `$<total> (+$<child> subagents)` only if it fits; otherwise the total alone.

### Tests
- runtime: after a child turn, the parent session manager has one `subagent_usage` entry with the turn's usage (use the `setup()` parent with a real `SessionManager`).
- `usage-totals`: malformed entries ignored; breakdown has a `Subagents` bucket.
- footer: totals include child cost; context percentage unchanged.

Changelog `### Changed`: session cost totals include subagent usage.

---

## Task 6: Child data when a parent session ends or is deleted (investigate and propose only)

Corrected scope: switching sessions is already handled. `AgentSessionRuntime.teardownCurrent()` (`src/core/agent-session-runtime.ts` ~167) emits `session_shutdown` with reason `new`/`resume`/`fork`/`quit` (type `SessionShutdownEvent`, `src/core/extensions/types.ts` ~635), and the extension's `session_shutdown` handler (`extension.ts` ~389) calls `runtime.shutdown()`, which stops running children and disposes residents.

Open gap: deleting a parent session from the session selector (`src/modes/interactive/components/session-selector.ts`, `deleteSessionFile()` ~645, called at ~833) removes only the `.jsonl` (via `trash` or `unlink`). The children's transcripts under `childSessionDirectory(sessionDir, sessionId)` = `<sessionDir>/subagents/<sessionId>/` (`child-sessions.ts:16`) remain, and so can child git worktrees (removed elsewhere by `removeIsolatedWorktree`, see `runtime.delete()`).

Do not implement. The fix touches core session-selector code, which must stay upstream-compatible, and needs the user's decision. Write a proposal in your report:
- confirm the gap by creating a session with a subagent, deleting it in the selector, and listing what remains on disk;
- list the options, for example (a) a generic "session deleted" extension event that the subagent extension handles, (b) deleting a sibling `subagents/<id>/` directory in `deleteSessionFile`, (c) an `ice agents prune` CLI command that removes orphaned child directories and worktrees;
- recommend one with its tradeoff.

Reference: Prime Agent cancels descendants on parent teardown and keeps child artifacts on disk after deletion with a tombstone (`rlm-runtime.md` ~171 and failure-mode table ~235-245).

---

## Task 7: Docs status (small)

- `Plan/subagent-v2-management.md`: add a short status line per task you finished (Tasks 3-5) under a new "Follow-ups" heading.
- Do not edit `Plan/subagent-rewrite.md` (the user's uncommitted file). In the report, list its stale statements: it says the SDK `agents` option (P9.5) and RPC agent/approval commands (P9.6) are deferred; both now exist (`createIceSubagents` in `src/subagents/v2/sdk.ts`; `get_subagents`, `respond_subagent_approval`, `subagents_update` in `src/modes/rpc/`).

---

## Not in scope (needs the user's decision)

- Removing the unused `app.subagents.expand` / `app.subagents.inspect` keybindings (`src/core/keybindings.ts` ~114-115).
- A slimmer `agent` tool schema (15 task fields today, `src/subagents/api/agent.ts`).
- Fork (child inherits the parent's context and prompt cache; Claude Code `src/tools/AgentTool/forkSubagent.ts`).
- Child-to-parent messages during a turn (Prime `agent_message`, `prompts/rlm.ts` ~160-185).
- Removing legacy subagent code (`src/subagents/registry/jobs.ts`, `src/subagents/ui/observatory.ts`, `src/subagents/definitions/legacy-profiles.ts`, `src/subagents/runtime/supervisor.ts`, `src/subagents/runtime/checkin.ts`, legacy parts of `src/subagents/types.ts`).

---

## Reference index (for reading, never edit `Agent_harness_references/`)

Claude Code (`/home/mewtwo/Zks/ice/Agent_harness_references/claude-code/src/`):
- `tools/AgentTool/prompt.ts` (~99-113 "Writing the prompt", "Never delegate understanding"; ~232-287 when-not-to-use and usage notes: don't poll, result not visible to the user, parallel launches).
- `tasks/LocalAgentTask/LocalAgentTask.tsx` (~279-300 kill, ~415-454 completion: terminal status, `evictAfter`), `utils/task/framework.ts:28` `PANEL_GRACE_MS = 30_000`.
- `tools/AgentTool/resumeAgent.ts` (resume from transcript), `tools/SendMessageTool/` (continue an agent by name or ID).
- `components/FullscreenLayout.tsx` (new-messages pill; Task 4).

Prime Agent (`/home/mewtwo/Zks/ice/Agent_harness_references/prime-agent/packages/coding-agent/`):
- `docs/rlm.md` (~64-117 spawn handles, list/delete, lifecycle), `docs/rlm-runtime.md` (~138-151 child execution, ~165-186 registry and usage attribution, ~235-245 failure modes).
- `src/core/prompts/rlm.ts` (~160-185 spawn/delete guidance, ~207-232 `buildSubagentGuidance`).
- `src/core/agent-session.ts` (~1216 `attributeChildUsage`, ~11000-11030 attribution entries).

---

## Report format (Claude reviews this)

For each task: status (done / partial / skipped and why); files changed; tests added (names); the exact check and test commands with pass/fail counts; commit hash and message; deviations from this plan and why; anything you were unsure about. For Task 2 include the pane captures. For Task 6 include the on-disk evidence and the recommendation. End with `git status --short` output.
