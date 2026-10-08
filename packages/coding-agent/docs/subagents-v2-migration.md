# Migrating to Subagents V2

ICE Subagents V2 is the current and only subagent implementation. This guide maps the removed legacy delegation surfaces to V2 and explains which configuration must be rewritten. For current behavior, see [Subagents V2](subagents-v2.md) and its [reference](subagents-v2-reference.md).

## What changed

The legacy `delegate`, `delegate_async`, `delegate_batch`, `review_batch`, `delegate_write`, `manage_subagent`, job/batch inspection, and writer-patch tools were replaced by three tools:

- `agent` launches one task, a bounded task list, a background task, or a continuation;
- `agent_control` manages child lifecycle, approvals, and bounded final-answer output;
- `agent_patch` inspects, applies, or rejects a worktree-isolated child delta.

The rollout switch is gone. Remove `ICE_SUBAGENTS_V2` from launch environments and do not rely on `ice.subagents.v2`; the latter is accepted and ignored for configuration compatibility. V2 is installed by the `ice` launcher. There is no automatic legacy-tool mode.

## Tool migration map

| Legacy use | V2 form |
|---|---|
| `delegate` | `agent` with one item in `tasks`. |
| `delegate_batch` | `agent` with multiple independent `tasks` (up to 8). |
| `delegate_async` | `agent` with one task and top-level `background: true`. |
| `review_batch` | `agent` with one or more tasks using the `review` agent. |
| `manage_subagent` follow-up | `agent` with `resume: "ag_…"`, or `agent_control` `send` with `message`, `followup`, or `interrupt`. |
| Job/run status or wait | `agent_control` with `status`, `list`, or `wait`. |
| Cancel/stop a child | `agent_control` with `stop`; delete only after it is stopped. |
| Read a retained long answer | `agent_control` with `output` and bounded byte offsets. This does not read raw transcripts. |
| Old writer patch inspection/integration | Launch with `isolation: "worktree"`, inspect through `agent_patch`, then explicitly `apply` or `reject`. |
| Old writer role | A file-defined `worker` or custom agent with `isolation: worktree`; patch application remains parent-owned. |

A V2 child has one durable `ag_` identity. Old run/job/batch IDs and tool schemas are not interchangeable with it. Multi-task display groups are not child identities.

## Agent file migration

Create or update files under `~/.ice/agents/` or a trusted project `.ice/agents/` directory. V2 identity is the frontmatter `name`; the body is the system prompt. Use `ice agents validate <file>` after every conversion and `ice agents list` to check the resolved source and shadowing.

Common field replacements reported by the validator include:

| Removed legacy key | V2 form |
|---|---|
| `fallbackModel` | `model: [primary, fallback, inherit]` (ordered candidates) |
| `thinkingLevel` | `thinking` |
| `top_p` / `top-p` | `topP` |
| `mcpTools` / `mcp_tools` | `mcp` with explicit `server/tool` selectors |
| `adapters` | `tools` with child-safe adapter tool names |
| `iceUnsafeHostExec` | Explicit authorized `--sub-yolo` or a reviewed user/managed permission rule; this does not bypass the parent ceiling. |

Native V2 definitions reject unknown keys. `ice agents validate` reports known replacement suggestions. Do not assume that a V1 setting with a similar name has the same meaning or authority in V2.

The old special `self` role is not a V2 execution mode. Define a normal named agent with an explicit prompt if you need a particular role; the ordinary built-in `general` agent is available by default.

## Settings migration

Move supported subagent configuration under the current `ice.subagents` schema, for example:

```json
{
  "ice": {
    "subagents": {
      "defaultAgent": "general",
      "maxDepth": 0,
      "maxConcurrent": 4,
      "permissions": {
        "deny": ["bash(git push*)", "write(**/.env*)"]
      }
    }
  }
}
```

See the [settings reference](subagents-v2-reference.md#settings) for all supported keys. V1 role catalogs, allowlists, route-selection settings, and per-role defaults are not automatically translated. Project settings and project agent files require project trust; project settings may narrow concurrency/depth and permission authority, never grant an unattended allow.

Agent directories changed over the history of ICE. Current sources include `~/.ice/agents/**/*.md` and trusted `.ice/agents/**/*.md`; the old `~/.ice/agent/agents` path is not a current discovery root. Do not move/delete old files automatically. Keep a copy, rewrite them, validate each file, and inspect `ice agents list` for shadowed or disabled definitions.

## Safe migration sequence

1. Preserve the existing agent files and settings outside the repository. Do not copy credentials into agent prompts or docs.
2. Remove reliance on the V2 rollout switch; it is no longer needed.
3. Convert each active agent file to the strict V2 schema and rename the old fields above.
4. Replace each old tool call with the appropriate V2 tool; retain a self-contained task description/prompt and explicit scope.
5. Recheck the requested tool list and permission rules. V2 children default to asking before mutation; `plan` and `review` remain read-only. No project file may grant itself more authority.
6. Validate and inspect definitions:

   ```bash
   ice agents validate
   ice agents list
   ```

7. Start a saved parent session, run a small read-only task first, then separately test any approved mutation or worktree patch path.
8. Inspect `agent_patch` output before applying it. Configure and run `--ice-verify` when deterministic verification is required. Do not treat an unverified apply as a pass.

## Integration notes

V2 child sessions require a persistent parent session; launches with `--no-session` are unsupported. Interrupted tool calls are never automatically replayed. A dedicated V2 SDK configuration API and dedicated RPC agent-management API are not provided; use the `ice` launcher and documented tool surface rather than assuming the old extension/tool API carries over.

Permission rules and worktrees are not a sandbox. The child process runs with the host user's actual filesystem, process, network, and credential access. Use OS/container isolation for untrusted or unattended jobs.
