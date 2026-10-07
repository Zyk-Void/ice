# Subagents V2

Subagents V2 is the ICE subagent system: three tools, file-defined agents, and one permission model. The legacy delegation tools were removed.

V2 needs a saved session (it does not work with `--no-session`), because child transcripts and their frozen settings are written to disk.

## Agents

An agent is a Markdown file with frontmatter. The body is its system prompt.

```markdown
---
name: security-review
description: Use for security-focused review of a change.
tools: [read, grep, find, bash]
model: [omni/cx/gpt-5.6-luna, inherit]
thinking: high
permissionMode: review
---
You review code for security defects. For each finding give severity, location, and a fix.
```

ICE looks for agents in these places, from lowest to highest priority. A later source replaces an earlier agent with the same `name`:

1. built-in agents: `general`, `explore`, `plan`, `review`, `worker`
2. installed packages
3. `~/.ice/agents/**/*.md`
4. `ice.subagents.agents` in your global settings
5. `.claude/agents/**/*.md`, only when `ice.subagents.compat.claudeAgents` is `true`
6. `.ice/agents/**/*.md` in every folder from your current directory up to the git root (needs project trust)
7. `ice.subagents.agents` in project settings (needs project trust)
8. the `--agents '<json>'` flag
9. managed policy, which cannot be overridden or disabled

The file name does not matter; `name` in the frontmatter does. Markdown files without a `name` are ignored, so you can keep notes next to agents. A file with a `name` that fails validation is reported and skipped.

Useful commands:

- `ice agents list [--json]` lists every agent, where it came from, and what it overrides.
- `ice agents validate [file...]` checks agent files and exits with code 1 if any are invalid. It names the replacement for keys that changed, for example `fallbackModel` → `model: [primary, fallback, inherit]`.
- `/agents new <name> [--project]` creates a valid starter file.

The model sees the list of usable agents automatically; it does not need to call a tool first.

## Tools

- `agent` starts one to eight subagents, or continues one with `resume: <id>`. By default it waits and returns each report. With `background: true` it returns the IDs at once and each result arrives later as a follow-up message. Press `ctrl+b` while it waits to move the wait to the background.
- `agent_control` manages subagents by ID: `status`, `list`, `wait`, `output`, `send`, `resume`, `stop`, `delete`, `agents`.
- `agent_patch` reviews the changes of a subagent that ran with `isolation: worktree`: `inspect`, `apply`, `reject`.

## Permissions

A subagent can never do more than its parent could do with the same command.

- Reading and searching follow the parent.
- Edits, shell commands, and tools that change things **ask** by default. In the foreground you get a prompt. In the background the request waits in the Agent Hub. Without any way to ask (for example print mode), the request is denied.
- These defaults are raised only by `--sub-yolo`, by allow rules in your own (user or managed) settings, or, for edits only, by worktree isolation.
- Rules from the project itself can only make things stricter. A repository cannot give its own agents permission to run shell commands unattended.
- Plan and review modes block edits regardless of any setting.

Rules look like `tool` or `tool(pattern)`:

```json
{
  "ice": {
    "subagents": {
      "permissions": {
        "allow": ["bash(npm test*)"],
        "ask": ["bash(git *)"],
        "deny": ["bash(git push*)", "write(**/.env*)"]
      }
    }
  }
}
```

Deny beats ask, and ask beats allow. A shell command with several parts (`a && b`) must pass for every part. A command that uses `$(...)` or backticks always asks.

Permissions are not a sandbox. A subagent's shell runs as your user.

## Worktree isolation

With `isolation: worktree` (the built-in `worker` uses it), the subagent works in a separate git worktree that starts from your current files, including uncommitted and untracked changes. Its patch contains only its own changes.

`agent_patch apply` merges the patch into your files without touching the git index, and writes nothing if your files changed in a conflicting way. If you configured a verifier with `--ice-verify`, it must pass or the apply is rolled back; otherwise the apply is reported as unverified, the same as your own edits. Nested repositories and submodules are not supported.

## The Agent Hub

`/agents` opens the Hub: pending approvals, every subagent with its state and token use, and details for the selected one. Default keys (configurable in keybindings):

| Key | Action |
|---|---|
| ↑ / ↓ | select |
| Enter or → | open the subagent's live view |
| `s` | stop its current turn |
| `D` | delete it (it must be stopped) |
| `y` / `n` | approve or deny its pending request |
| Esc | close |

## Budgets and recovery

- Optional `maxTurns`, `maxTokens`, and `timeoutMs` limit a subagent. There are no limits by default. `maxTokens` counts new input, cache writes, and output, not cache reads. When a limit is reached the subagent gets one short, tool-free turn to report.
- If ICE stops while a subagent is working, the subagent is restored as parked and its turn is marked interrupted. Tool calls that were cut off are never re-run automatically; the next turn is told about them.
- Continuing a subagent uses the same model, tools, and permissions it started with. If the parent has since lost any of them, it refuses and explains why.

## Events

Extensions can observe subagents on the event bus channel `ice:subagent`. Events: `subagent_start`, `subagent_turn_start`, `subagent_turn_end`, `subagent_parked`, `subagent_revived`, `subagent_blocked`, `subagent_interrupted`, `subagent_end`, `subagent_patch`, `subagent_completion_queued`, `subagent_permission_request`. Each carries the child ID, agent name, owner session, depth, and state, never prompts or output.

## MCP tools

An agent file can give its subagent MCP tools with `mcp: [server/tool, ...]` (globs allowed, for example `github/*`). Only tools the parent may already use are offered: the parent must have its `mcp` tool, and the tool must be listed by the parent's MCP adapter (for pi-mcp-adapter, tools approved in `approveTools` count as changes, the rest as read-only). Calls run through the parent's `mcp` tool and follow the same permission rules as other tools, so tools that change things ask by default.

## Hooks

The `ice.hooks` settings and `registerIceSubagentHook` handlers apply to V2 subagents too. Decision hooks can stop work: `subagent.beforeLaunch` runs before a subagent is created and may add short context for its first turn, `subagent.beforeTool` runs before each tool the subagent uses, and `subagent.beforeAccept` runs before a finished turn is accepted (a deny marks the turn failed). Observation hooks report `subagent.started`, `subagent.afterTool`, `subagent.completed`, `subagent.failed`, `subagent.timedOut` (a budget ran out), and `subagent.cancelled`. An agent file selects optional hooks with `hooks: [id, ...]`; required global hooks always run. A required hook that fails or times out blocks the action, and each hook is journaled before it runs.

## Not done yet

The full V2 plan is in `Plan/subagent-rewrite.md`. Still open: removing the legacy tools and making V2 the default, SDK and RPC agent APIs, the `subagent.checkpoint` and `subagent.attention` hook events (V2 has no periodic check-ins), and the proposed keyboard navigation (decision D26).
