# Subagent V2 Session Fixes Plan

Written 2026-10-08 by Claude after auditing session `01a119e6-6421-75b3-aea4-f54cfb1e26f3`
(`~/.ice/agent/sessions/--home-mewtwo-Zks-ice-Agent_harness_references--/2026-10-08T05-04-51-745Z_01a119e6-….jsonl`)
and the V2 source at `be2090765`. Paths are relative to `packages/coding-agent` unless stated.

Ground rules, commands, test sets, and the user's protected files are the same as `Plan/subagent-v2-handoff.md` section 0.
Every task: regression test first (red), fix, focused tests, subagent set, `corepack npm@12.0.2 run check`, one commit.

---

## 1. What happened in the audited session (evidence)

Timeline from the session JSONL (UTC):

| Time | Event |
|---|---|
| 05:06 | Parent launches 8 background `explore` children (`opencode-gap`, `ohmypi-gap`, `clawcode-gap`, `primeagent-gap`, `ice-v2-inventory`, `claudecode-gap`, `codex-gap`, `openhands-gap`). |
| 05:17–05:24 | Six children complete. Each gets `completion` + `delivered` journal entries at completion time, but the `subagent_completed` messages reach the transcript only at 05:24:51, when the parent's turn ends (they waited in the agent follow-up queue). |
| 05:25:21 | `clawcode-gap` completes; `completion` + `delivered` written. **No `subagent_completed` message is ever persisted.** |
| 05:26:56 | `codex-gap` completes; same. **No message ever persisted.** |
| 05:27:27 | Parent assistant message ends `stopReason=aborted`, `OpenAI Responses stream ended before a terminal response event`. |
| 05:27:32 → 05:31 | User: "hey". Model: "Claw Code and Codex inspections are still running." (both had finished 2–6 min earlier). |
| 07:27 | Session resumed (old build: no roster entry). User asks three times to check; model refuses: "I can't poll background-agent status." |
| later | User runs `/agents`: `Warning: Shut down the previous owner before replacing the parent session.` Footer shows no `agents` segment. |

Not used: asking the session's agent over RPC. That would append turns to the user's real session; the JSONL already holds the evidence.

---

## 2. Findings (ranked)

### F1 (critical): background completions are lost when the parent turn ends abnormally
- `flushCompletions()` (`src/subagents/v2/runtime.ts` ~1307) calls `registry.claimDelivery()`, which durably writes `ice-subagent-v2-delivered`, **before** the message reaches the transcript.
- While the parent streams, `sendCustomMessage(..., { deliverAs: "followUp" })` (`src/core/agent-session.ts` ~1533) only enqueues into `agent.followUp`.
- On `stopReason` `error`/`aborted` the loop returns without draining follow-ups (`packages/agent/src/agent-loop.ts` ~196), and the interactive abort path calls `session.clearQueue()` → `agent.clearAllQueues()` (`interactive-mode.ts` ~5286, callers ~2035/2574/3359), which silently drops custom messages (only user text is restored to the editor).
- The completion is then marked delivered but never seen; it is never retried, not even after a restart.
- Result: the model believes finished children are still running.

### F2 (critical): after an in-process session switch the new runtime binds to the old session
- Every session switch (`/resume`, `/new`, fork) creates new extension instances (`AgentSessionRuntime.createRuntime`).
- The new instance calls `agentViewBridge.setSubagentControlSource(...)` at load time (`src/subagents/v2/extension.ts` ~344). `publish()` triggers `overview()` → `runtime.state()` while the bridge still points at the **old, already shut down** parent (the bridge is updated later in `rebindCurrentSession`, `interactive-mode.ts` ~2136).
- The new runtime creates its owner for the old session (and `registry.restore()` can append recovery entries to the old session file). After `setParentSession(new)`, `state()` throws `busy` ("Shut down the previous owner…") forever.
- Consequences: `/agents` fails, the footer `agents` segment and agent strip disappear (`getSubagentOverview` swallows the error), the post-resume roster (added in `be2090765`) is silently skipped because `renderChildRoster` swallows the same error, and `agent`/`agent_control` fail in the resumed session.

### F3 (high): the model refuses to check subagents when the user asks
- `AGENT_TOOL_GUIDELINES` (`extension.ts` ~72): "Do not poll with agent_control status or wait…". The model generalized this to refuse explicit user requests three times.
- The guideline must forbid polling loops, not answering the user.

### F4 (high): the main chat shows nothing while a foreground `agent` call runs
- `agent.execute` ignores `onUpdate`, and the tool has no `renderCall`/`renderResult` (`extension.ts` ~450). A foreground delegation is a bare spinner. `ctrl+b` (`app.tasks.background` → `releaseBlockingWaits`, `interactive-mode.ts` ~3404) works, but the only hint is the status line.

### F5 (medium): V2 source mismatches (confirmed from the session's own inventory)
- `initialPrompt` is parsed and frozen into the contract (`runtime.ts` ~512, `contract/serialize.ts` ~60) but nothing consumes it.
- `requiredMcpServers`: `callableAgents()` calls `callableAgentDefinitions(active)` without the available server list (`runtime.ts` ~248), so any agent with `requiredMcpServers` is never callable.
- Recursion: `agent` is in `MANAGEMENT_TOOLS` (`src/subagents/tools/adapters.ts` ~58), so children can never spawn; `maxDepth > 1` and depth fields are unreachable. This matches the AGENTS.md rule "No recursive delegation by default", but the settings/docs imply it works.

### F6 (medium): returning to the main agent is hard to discover
- `app.subagents.parent` = `shift+alt+left` (`src/core/keybindings.ts` ~118). In a child view nothing on screen says how to get back; the strip shows `alt+left/alt+right switch · left manage`.

### F7 (low): footer is wider than needed (compact status line, `footer.ts` `renderStatusLine` ~167)
Observed: `build · bash · external  ~/Zks/ice/Agent_harness_references  ⎇ observibility-ui   cx/gpt-6-luna xhigh  84% of 272k  ⚠ 3 · ↑ update · f2`.

### F8 (low): a child cut off by shutdown reports `cancelled`
- Shutdown aborts running turns, so `finishTurn` records `cancelled`, the same as a user stop. The model cannot tell that the child was interrupted by a session switch and should usually be resumed.

---

## 3. Tasks

### Task A: Durable, idle-only completion delivery (F1)
Design:
1. Never send completions through the follow-up queue. `flushCompletions()` returns without sending while the parent is streaming or compacting (`parent.isStreaming` / `isCompacting`); the `agent_settled` hook already re-flushes.
2. When idle, send **one** `subagent_completed` message that batches every pending completion (each section as today, plus one shared trailer), with `triggerTurn: true`. This uses the non-streaming `_runAgentPrompt` path, which persists the message at `message_end`.
3. Mark delivered only after the message is persisted: put `deliveryIds` in `details`; subscribe to the parent's `message_end` (extension event) for `customType === "subagent_completed"` and call `claimDelivery` per ID. Keep an in-memory `sending` set to avoid double sends during the turn; clear it on `agent_settled`, so anything still unclaimed is resent.
4. On restart, every unclaimed completion is pending and is delivered on the first `agent_settled` (and is listed in the roster meanwhile).
Tests (`test/suite/subagents-v2-runtime.test.ts` and the lifecycle suite):
- completion while the parent streams, then the turn ends with `stopReason: "error"` → message delivered once after settle;
- completion while streaming, then `session.clearQueue()` (abort path) → still delivered;
- three completions while busy → one batched message listing all three; no duplicates after more settles;
- restart with an unclaimed completion → delivered once.
Changelog `### Fixed`.

### Task B: Bind each runtime to its own session (F2)
Design (two layers):
1. In `extension.ts`, keep a module-level `WeakSet<AgentSession>` of parents that emitted `session_shutdown` in any instance. The runtime host's `getParentSession` returns `undefined` for a retired parent; `session_start` removes the current parent from the set (covers `reload`, which keeps the same `AgentSession`).
2. In `SubagentV2Runtime.state()`: if an owner exists for a different session and that owner has no running resident, retire it (clear timers, dispose residents asynchronously) and continue instead of throwing `busy`. Keep `busy` only when the old owner still runs a child.
Tests (lifecycle suite, real `AgentSessionRuntime`): call `newSession()`/`switchSession()` *without* `bindExtensions` first, render overview (simulated footer), then bind → `overview()` works, `/agents` source rows load, the old session file gains no entries after its shutdown, and the roster appears after resume.
Changelog `### Fixed`.

### Task C: Let the user ask for status (F3)
- Reword the guideline: "Do not poll in a loop (repeated agent_control status/wait or sleep). When the user asks about subagents, check once with agent_control action=list or status and report."
- Same wording in `AGENT_CONTROL_DESCRIPTION`.
- Test: system prompt contains the new sentence (`test/suite/subagents-v2-sdk.test.ts` existing guidance assertions).

### Task D: Live progress for foreground delegation (F4)
- In `agent.execute`, call `onUpdate` (throttled, at most ~4/s) with one line per child: status mark, name, agent, state, live tokens, last tool activity (reuse `overview()` children and the Hub's `statusMark`; move `statusMark`/`label` to a shared module).
- Add `renderCall` (agent names + descriptions) and `renderResult` (collapsed: one line per child with outcome and tokens; expanded: current text) following existing tool renderers (`src/core/tools/*` `renderCall`/`renderResult` patterns).
- Footer line of the rendered call while running: `<ctrl+b> to background` via `keyText("app.tasks.background")`.
- Tests: `test/tool-execution-component.test.ts`-style render test for the agent tool (running, done, narrow width); SDK test that `onUpdate` fires during a foreground run.

### Task E: V2 source mismatches (F5)
- `requiredMcpServers`: pass available MCP server names from the parent's adapters (`parentMcpAdapters` / `mcpDelegableTools`) into `callableAgentDefinitions`. Test: an agent requiring `github` is callable only when an adapter exposes it.
- `initialPrompt`: decide (see section 4); recommended: prepend it to the first turn's prompt in `launch()`, never on `resume`. Test: first child request contains it once.
- Recursion: keep disabled (AGENTS.md). Make it honest: clamp/diagnose `maxDepth > 1` in `settings.ts`, and state "children cannot launch subagents" in `docs/subagents-v2.md` (user-owned doc: report the needed sentence instead of editing if it is still uncommitted).

### Task F: Return to the main agent (F6)
- In a child view, add a conditional `app.subagents.parent` alternative: `escape` on an empty editor while viewing a child returns to the main agent (only when no turn is streaming in that view, so Escape still aborts).
- Show `<shift+alt+left> main` in the agent strip while a child view is displayed (`subagent-view-switcher.ts`).
- Tests: strip text in a child view; Escape handling falls through when streaming.

### Task G: Compact footer, moderately (F7)
Proposed (status-line footer only):
- `84% of 272k` → `84%/272k`.
- Notices `⚠ 3 · ↑ update · f2` → `⚠ 3 ↑ f2` (keep the warning count; the update arrow alone; the key hint stays).
- Mode/capabilities `build · bash · external` → `build bash ext` (risk color unchanged; `ext` = external).
- Keep cwd, branch, model, thinking as they are; the existing shrink rules already middle-truncate cwd.
- Tests: `test/footer-width.test.ts` / `test/status-line.test.ts` snapshots at 80/120/160 columns.

### Task H: Interrupted, not cancelled (F8)
- When `finishTurn` runs because the owner is closing (`state.closed`), record outcome `interrupted` (already a valid `ChildTurnOutcome`; restart recovery uses it) so the completion and roster say "interrupted; resume to continue".
- Test: extend "keeps a background completion pending through shutdown…" to expect `interrupted`.

### Task I: Live verification
After A–H: rebuild, then in tmux with `cx/gpt-6-luna` in `/tmp/ice-smoke`:
1. Launch 3 background children, press Escape mid-turn while one completes → its completion still arrives.
2. `/resume` another session and back → `/agents` works, footer shows `agents`, the roster is injected once.
3. Ask "check the subagents" → the model calls `agent_control list` once.
4. Foreground delegation → live rows in chat, `ctrl+b` backgrounds it, completion arrives later.
5. Open a child view → strip shows the return key; Escape on an empty editor returns to main.

---

## 4. Decisions (user, 2026-10-08)
1. Task E `initialPrompt`: implement; prepend on the first turn only, never on `resume`.
2. Task F: yes; Escape on an empty editor in a child view returns to main (falls through while that view streams), plus the strip hint.
3. Task G: apply the recommended abbreviations (`84%/272k`, `⚠ 3 ↑ f2`, `build bash ext`).
4. Task D: live child rows only for foreground `agent` calls.

## 5. Order
B → A → H → C → D → F → G → E → I. B first: A, the roster, and every UI fix depend on a working owner after resume.

## 6. Status (2026-10-08)

| Task | Commit | Result |
|---|---|---|
| B owner binding | `6f687ebba` | Done. Retired parents are never bound; an idle stale owner is released instead of throwing `busy`. Lifecycle test reproduces the stale render and the write into the closed session file (red before). |
| A durable delivery | `d0569f44f` | Done. Idle-only, batched (max 4), claimed on `message_end` or a finished send, resent if dropped. Abort-path test red before, green after. |
| H interrupted | `8225f98be` | Done. |
| C status on request | `22d841c5e` | Done. |
| D live rows | `47785432a` | Done with the default tool renderer (running tail + summary line); no custom `renderCall`/`renderResult` needed. Live activity = latest tool call. |
| F main-agent key | `7e1a0d751` | Escape already returned to main from a child view (`interactive-mode.ts` onEscape); added the `escape main` strip hint. |
| G footer | `01a746612` | Done. |
| E mismatches | `ded1bc851` | `requiredMcpServers` uses the parent's MCP servers (also in preflight); `initialPrompt` opens the first turn; `maxDepth` described as reserved, tool description says subagents cannot nest. Docs under `docs/` are user-owned and were not edited. |
| I live check | `4f06953a6` | Live (`cx/gpt-6-luna`, `/tmp/ice-smoke2`): live rows + ctrl+b; 3 completions during a streaming turn, Escape abort, delivered as one message after the abort; a 4th delivered after the next turn; `/new` then `/resume` back, `/agents` works, footer `agents 0/8`, roster injected once; "check the subagents" used `agent_control list`; child view strip `escape main` and Escape returns. Live run found two more issues, fixed in this commit: strip showed a just-started foreground child as idle; the move-to-background message used IDs. |

## 7. Follow-up: limitations and handoff items (2026-10-08)

| Item | Commit | Result |
|---|---|---|
| Results pending at resume | `f82215572` | Delivered at `session_start` (startup/resume) without a turn. |
| Old-session billing | `f3cc5a240` | One backfill `subagent_usage` entry per uncovered child, idempotent. |
| Forked sessions | `ec9fa90fb`, `b55c681b9` | Children stay with the source session; fork notice once; clear error; names reserved. `b55c681b9` repaired `ec9fa90fb`, which broke ID references without an owner (caught by the extension tests). |
| `ice agents prune` | `7ec723c70` | Dry run by default; keeps recent folders, changed worktrees, unknown worktrees, symlinks. Real `~/.ice/agent/sessions`: no orphans. |
| Legacy removal | `30294ca92`, `ceb2bf547`, `420cbe698`, `043288f24` | Removed job registry, Observatory, observe lanes producer, supervisor, check-ins, legacy profile loader, tool derivation, 58 unused `types.ts` exports, two unused keybindings. ~9,700 lines. Kept helpers in `definitions/paths.ts`, display types in `runtime/view-state.ts`. `30294ca92` left `observe-server.test.ts` failing; fixed in `420cbe698`. |
| Docs (user files, uncommitted) | — | `docs/subagents-v2.md`, `docs/subagents-v2-reference.md`, `docs/observability.md`, `Plan/subagent-rewrite.md` updated. `subagents-v2-reference.md` is duplicated (the file contains itself twice from line 124); not deduplicated. |
| Live compaction | — | `/compact` at 62k tokens: roster injected once; model resumed `keeper` by ID (after two schema mistakes it corrected itself). |

Verification: `corepack npm@12.0.2 run check` exit 0; subagent/UI sets 465 passed; 77 related test files (1,068 tests) passed. `./test.sh` could not run: nested `npm run` uses npm 11.x, which `devEngines` rejects.
