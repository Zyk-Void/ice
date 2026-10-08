# Subagent V2 live verification — 2026-10-08

Task 2: done after the user requested completion of the remaining review gaps. The initial stopped attempt is preserved below as historical evidence.

## Completed verification

- Startup bug fixed in `9931b03f9`: footer/Hub initialization used default settings before `session_start`. The attached parent supplies settings during early initialization. Trusted project limits are preserved in `9e1af319f`; untrusted projects remain ignored.
- Rebuilt coding-agent using the handoff commands; `ice --version` is `0.83.0`.
- Launched `ice --model cx/gpt-6-luna --ice-mode build` in tmux `ice-sol-review`, 140×40, cwd `/tmp/ice-smoke`. Each child explicitly selected `omni/cx/gpt-6-luna`; session tool arguments and Hub model confirm the route. No definitions or authority settings changed.
- Global `ice.subagents.maxConcurrent` originally absent; temporarily set to 2, then restored the complete original settings file byte-for-byte. Owned tmux session closed; user `stack` session preserved.

| Check | Result and evidence under `.artifacts/sol-subagent-v2-handoff/review-live/` |
| --- | --- |
| Footer capacity and queue | Pass: `006`–`008.ansi.txt`, `agents 2/2 · 2 queued` |
| Strip working and queue | Pass: same captures, `Agents 2 working · 2 queued` |
| Left opens Hub; names/queue/live usage | Pass: queued row observed in direct pane capture; ANSI Hub captures confirm bold names. `010`–`012.ansi.txt`: read-c grows 1.9k→4.0k tokens while running. `055`→`059.ansi.txt`: inspector shows 0 turns + 1 running, 2143→5736 tokens |
| Four complete reports and trailers | Pass: `session-evidence.json` contains all four named headers, exact alpha/beta/gamma/delta reports, resume/delete hints and sibling lines; relevant pane captures `009`–`016.ansi.txt` |
| Retirement and Enter reopen | Pass: `030`–`032.ansi.txt` show 0 active/4 finished and no strip; `033`–`034.ansi.txt` show read-b reopened with its original transcript and one idle strip entry |
| User message interrupts wait | Pass: submitted 04:50:44.916Z; tool result 04:50:45.102Z, 186 ms later; child still running. `interrupt.txt` captures the result within 757 ms |
| Status by name | Pass: actual tool arguments `action=status,id=read-a`, result parked/completed in `session-evidence.json` and `diff.txt` |
| Edit gutter and full-width tints | Pass: `diff.txt` shows `1 - alpha` and `1 + alpha verified`; `diff-full-width.txt` retains trailing spaces and ANSI backgrounds red 57,14,16 / green 23,48,31 through the row edge |

The four-read prompt also asked each child to read e.txt in a separate second call, making in-flight usage observable. A separate wait-probe read eight short scratch sections in order to keep the child running for the interruption check. The parent used exactly one wait call; there was no polling. Scratch a.txt now contains `alpha verified\n`.

Automated regressions: early global concurrency; early trusted/untrusted project limits. Initial red cases reproduced capacity 4 instead of 2 and 3 instead of trusted project 1. Final required subagent set: 352 passed /18 files. UI plus pill/usage set: 120 passed /8 files. Required root check exits 0 before each fix commit.

The timed capture helper stopped with a missing-pane error after the intentionally closed session; existing captures and session evidence were already saved. This is helper shutdown noise, not an ICE failure.

## Initial attempt (superseded)

- Branch: integration/all-worktrees-experimental; baseline commit a014a175a.
- Rebuilt coding-agent with tsgo, executable permissions, and copy-assets. ice --version: 0.83.0.
- Scratch directory: /tmp/ice-smoke; tmux: ice-sol-handoff; parent model: cx/gpt-6-luna.
- Global ice.subagents.maxConcurrent was absent. Set it to 2 temporarily, then restored settings.json byte-for-byte (cmp exit 0).
- The requested four named background explore reads completed correctly: alpha, beta, gamma, delta.
- Hub showed read-a through read-d, final usage, and Finished after retirement. Enter reopened read-a with its transcript.
- Mismatch: saved maxConcurrent=2, but the live footer/Hub showed capacity 4. No queued-state or wait-interruption assertion was certified.
- The user-scope explore definition selected omni/antigravity/gemini-3.8-flash-tiered. The parent launch used the required cx/gpt-6-luna; child route equality was not observed.
- Initial strip briefly showed four idle while footer showed four running, then updated to four working. Captures alone do not establish a stable bug.
- Diff tint, running usage growth, and wait-yield checks remain unverified because this task stopped on the mismatch.

Pane captures: .artifacts/sol-subagent-v2-handoff/task2-{startup,dispatch,completions,hub,retired,reopened}.txt.
No model claims were used as verification of unobserved checks. No definitions or authority settings were changed.
