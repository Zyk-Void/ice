---
name: ice-subagent-configure
description: Configure ICE subagent settings, permission rules, depth and concurrency limits, disabled agents, and parent-owned lifecycle hooks. Use when asked to tune delegation, register hooks, troubleshoot subagent settings, or configure command-hook policy safely.
---

# Configure subagents

Read `../../../packages/coding-agent/docs/subagents-v2.md` relative to this skill directory, then inspect the relevant settings and source. Redact keys and never print full auth/settings blobs.

1. Identify global (`~/.ice/agent/settings.json`) versus trusted-project (`.ice/settings.json`) scope and preserve unrelated settings. Project settings can only narrow limits and rules.
2. Subagent settings live under `ice.subagents`: `defaultAgent`, `maxDepth`, `maxConcurrent`, `askTimeoutMs`, `permissions`, `agents`, `disabledAgents`, `compat`. Invalid values fail closed: no child launches until fixed.
3. Permission rules are `allow`/`ask`/`deny` lists of `tool` or `tool(pattern)`. Deny wins. A child never exceeds its parent. Mutations ask by default; only user/managed allow rules, `--sub-yolo`, or worktree isolation (edits only) raise that.
4. Hooks live under `ice.hooks`. Prefer trusted in-process handlers registered with `registerIceSubagentHook`. Agent files select optional hook IDs with `hooks:`; required global hooks always run.
5. Command hooks are a host-authority expansion. Obtain explicit approval before writing global command policy; project trust alone is insufficient. They are not a sandbox.
6. Validate with `ice agents validate` and provider-free tests. Do not spend provider tokens to validate settings.
7. Provide a rollback: the previous settings values and how to stop or delete running children with `agent_control`.
