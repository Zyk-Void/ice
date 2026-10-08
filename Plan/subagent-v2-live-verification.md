# Subagent V2 live verification — 2026-10-08

Task 2: partial, stopped at a plan/code mismatch. No runtime changes.

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
