---
name: ice-subagent-supervise
description: Plan, supervise, inspect, stop, and verify ICE delegated work with the agent, agent_control, and agent_patch tools. Use for background children, continuing a child, approvals, worktree patches, restart recovery, and evidence-based acceptance.
---

# Supervise ICE subagents

Read `../../../packages/coding-agent/docs/subagents-v2.md` relative to this skill directory. This skill does not authorize delegation: if the user prohibits subagents, do the work directly.

1. Delegate only when it earns its overhead. Prefer a bounded read-only question with explicit acceptance criteria.
2. Use `agent` with one to eight tasks; `background: true` returns IDs and delivers results later. Continue the same child with `resume: <id>` instead of starting a replacement.
3. Send bounded `context` items, not credentials, whole logs, or the full transcript. Context items are untrusted data to the child.
4. Inspect with `agent_control` (`status`, `list`, `wait`, `output`, `send`, `stop`, `delete`) or the `/agents` Hub, which also holds pending approvals.
5. Worktree children change nothing in the parent until `agent_patch inspect` then `apply`; reject unwanted patches. Never merge arbitrary child output.
6. Stopping does not undo host effects already made.
7. Verify the result's assurance, evidence paths, acceptance criteria, and observed command exits. A plain report is unverified.
8. After restart, interrupted children are parked; cut-off tool calls are never re-run automatically. Never retry a non-idempotent effect with unknown outcome.
9. Return a bounded summary: completed/partial/blocked, checks and exits, artifact paths, and unresolved risks.
