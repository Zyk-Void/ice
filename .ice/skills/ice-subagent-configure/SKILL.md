---
name: ice-subagent-configure
description: Configure ICE subagent settings, permission rules, depth and concurrency limits, disabled agents, and parent-owned lifecycle hooks. Use when asked to tune delegation, register hooks, troubleshoot subagent settings, or configure command-hook policy safely.
---

# Configure subagents

Read `../../../packages/coding-agent/docs/subagents-v2.md` relative to this skill directory (reference: `subagents-v2-reference.md`; legacy migration: `subagents-v2-migration.md`), then inspect the relevant settings and source. Redact keys and never print full auth/settings blobs.

1. Identify global (`~/.ice/agent/settings.json`) versus trusted-project (`.ice/settings.json`) scope and preserve unrelated settings. Project `ice.subagents` is read only when the project is trusted. It can only narrow: `maxDepth` and `maxConcurrent` take the lower value, and project permission rules add to user rules.
2. Subagent settings live under `ice.subagents`:
   - `enabled`: `false` blocks new launches; existing children stay manageable.
   - `defaultAgent` (default `general`), `maxDepth` (0-4, default 0), `maxConcurrent` (default 4), `askTimeoutMs`.
   - `permissions`: `allow`/`ask`/`deny` lists.
   - `agents`, `disabledAgents`, `compat` (`claudeAgents`, `modelAliases`).
   - Unknown keys or invalid values fail closed: that scope's values are dropped, diagnostics are reported, and the parent refuses every launch (`Invalid parent settings`) until fixed.
   - Keys of the removed legacy system (`concurrency`, `defaults`, `roleDefaults`, `restrictions`, `modelSelection`, and similar) are ignored with deprecation notices. Remove them when migrating.
   - `v2` is accepted and ignored.
3. Permission rules are `allow`/`ask`/`deny` lists of `tool` or `tool(pattern)`. Deny wins. A child never exceeds its parent. Mutations ask by default; only user/managed allow rules, `--sub-yolo`, or worktree isolation (edits only) raise that.
   - `--sub-yolo` grants host authority: children read outside the parent directory without prompts. Git metadata and symlinks stay denied. It is not a sandbox.
4. Hooks live under `ice.hooks`: `enabled`, `definitions`, `commandPolicy`. Each definition sets `id`, `event`, `roles`, `kind` (`in-process` or `command`), `timeoutMs`, `maxOutputBytes`, and `required` (default `true`).
   - Required hooks always run. Agent files select optional hook IDs with `hooks:`.
   - Prefer trusted in-process handlers registered with `registerIceSubagentHook(owner, id, handler)`, exported from the package index.
   - Hook context and results are untrusted data and cannot grant capabilities.
5. Command hooks are a host-authority expansion. They need an explicit `commandPolicy`; a required command hook stays disabled without one. Obtain explicit approval before writing global command policy; project trust alone is insufficient. They are not a sandbox.
6. Inspect and validate without provider tokens:
   - `ice agents validate [path...]` (exit 1 on invalid).
   - `ice agents list [--json]`.
   - `ice agents prune [--apply] [--json]`: lists orphaned subagent data; deletes only with `--apply`.
   - Provider-free tests for settings changes. Do not spend provider tokens to validate settings.
7. Provide a rollback: the previous settings values, and how to stop or remove running children with `agent_control` (`action` one of `status`, `wait`, `send`, `resume`, `stop`, `delete`, `output`, `list`, `agents`; `stop` and `delete` take `id`).
