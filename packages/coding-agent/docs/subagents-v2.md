# Subagents V2

Subagents V2 is ICE's current subagent system. It provides file-defined agents, the `agent`, `agent_control`, and `agent_patch` tools, one deny-first permission evaluator, durable child sessions, and optional Git worktree isolation. The legacy `delegate*` tool family has been removed. There is no V2 rollout flag: `ICE_SUBAGENTS_V2` and `ice.subagents.v2` are not required.

This guide documents behavior in the `ice` launcher. SDK applications install the same extension with `createIceSubagents()` (see [SDK](sdk.md)); RPC clients read the overview with `get_subagents`, receive `subagents_update` events, and answer approvals with `respond_subagent_approval` (see [RPC](rpc.md)).

## Quick start

Create a user agent at `~/.ice/agents/security-review.md`:

```markdown
---
name: security-review
description: Review a change for security defects.
tools:
  - read
  - grep
  - find
  - ls
permissionMode: review
---
Review the requested code. For each finding, give severity, file and line, a concrete failure scenario, and a suggested fix. Separate verified facts from assumptions.
```

Validate and inspect discovery:

```bash
ice agents validate ~/.ice/agents/security-review.md
ice agents list
ice agents list --json
```

Start `ice` in a saved session and ask it to use `security-review` for a specific task. ICE sends the available-agent listing to the model; a separate listing-tool call is not needed. In the interactive TUI, `/agents` opens the Agent Hub. `/agents new <name>` creates a user agent; `/agents new <name> --project` creates a project agent and requires project trust.

Project agents can live in `.ice/agents/**/*.md`. ICE does not load project definitions until the project is trusted. A project agent file is executable prompt/configuration input, not a security boundary.

## Agent definitions

An agent is Markdown with YAML frontmatter and a non-empty body. The frontmatter `name` is the agent identity; the filename is only a path. Native frontmatter is strict: unknown keys and invalid values make the definition unavailable. The body becomes the agent's system-prompt contribution.

The available built-ins are `general`, `explore`, `plan`, `review`, and `worker`. Built-ins are replaceable by a higher-precedence definition with the same name, except managed definitions, which are locked. Definitions from project paths require trust. See the [definition and settings reference](subagents-v2-reference.md) for fields, source precedence, and limits.

An omitted model inherits the parent's exact current model. Agent definitions can request tools, but a request never adds a tool that the parent lacks or the child policy denies. The default agent is `general`.

## The three tools

### `agent`

Launch one to eight children in a single request, or continue a child by name or ID. Each task includes a short description and a self-contained prompt; children do not receive the parent's full transcript. A task may also specify an agent, model/thinking preference, scope, output schema, acceptance claims, selected context, and optional budget.

```json
{
  "tasks": [
    {
      "agent": "explore",
      "description": "Trace the settings merge",
      "prompt": "Find where global and trusted-project ICE subagent settings are merged. Return the relevant files and verified behavior.",
      "scope": { "roots": ["packages/coding-agent/src"] }
    },
    {
      "agent": "review",
      "description": "Check permission regressions",
      "prompt": "Review the same settings path for permission-widening or fail-open behavior.",
      "scope": { "roots": ["packages/coding-agent/src"] }
    }
  ]
}
```

Every child has a name that is unique in its session and never reused, even after delete: the task's `name` (for example `auth-review`), or an automatic one from a pool of 100 (`atlas`, `mesa`, …; suffixed as `atlas-2` once the pool is used up). `resume`, `agent_control`, and `agent_patch` accept the name or the ID, and results and completion messages show both. Children cannot launch subagents of their own.

By default, the parent waits for the work and receives bounded reports. While it waits, the tool row shows one live line per child (status mark, name, agent, state, tokens, current tool call). In the interactive TUI, `Ctrl+B` moves the wait to the background and the parent is free again. Set the top-level `background` to `true` to receive child names and IDs immediately.

A background result arrives as a `subagent_completed` message, delivered only when the parent is idle; results that finish together arrive as one message. A result counts as delivered only once the message is in the parent transcript, so an aborted or failed parent turn cannot lose it. Each message carries up to 16 KiB of the report and says how to read the rest with `agent_control action=output`.

`scope.roots` is the path boundary for supported child file tools. Optional `scope.targets` focuses the task on existing files inside those roots; it does not expand the roots. Scope checks are enforced at the tool boundary, not by prompt wording.

### `agent_control`

Manage an existing child, by name or ID, with `status`, `list`, `wait`, `send`, `resume`, `stop`, `delete`, `output`, or `agents`. The model is told not to poll in a loop, but to check once when you ask about subagents. `send` distinguishes a queued `message`, a later `followup`, and an `interrupt` of the current turn. `output` reads a retained final-answer artifact in bounded ranges; it does not expose the raw tool transcript. Operations are owner-session scoped.

### `agent_patch`

Only for a child started with `isolation: "worktree"`. Use `inspect` before deciding, then explicitly `apply` or `reject`. Applying is a parent mutation: it passes through parent policy and the ICE mode gate. If `--ice-verify` is configured, it must pass; without a verifier, an applied patch is reported as unverified, not verified. ICE does not automatically apply a child patch.

## Permissions and safety

A child cannot be more permissive than its parent for the same operation. Its effective capability set is also limited by its definition, invocation, trust/mode policy, scope, and registered adapter policy.

Permission rules use `allow`, `ask`, or `deny`; the most restrictive matching rule wins (`deny` over `ask` over `allow`). A project rule can narrow authority but cannot grant unattended mutation. By default, child file reads follow parent authority; child edits/writes, Bash, and mutation-capable adapters ask. `plan` and `review` modes hard-deny direct edit/write tools and mutation-capable adapters; their Bash and external-directory subjects are at most `ask`, never auto-allowed by a rule or `--sub-yolo`, and still require parent policy and approval. For a strict no-shell review, omit Bash from the agent's requested tools. If an approval is required but there is no approval-capable UI, the operation is denied rather than implicitly allowed.

`--sub-yolo` is an explicit elevated-host-execution option, not a sandbox bypass. It is accepted only when the parent is in explicit build mode, the project is trusted, the parent has startup-authorized Bash, and an approval-capable interactive TUI or authorized RPC session is present. It can raise only child capabilities already active in the parent; it cannot defeat deny rules, scope, plan/review restrictions, or missing parent tools. Treat it as access to the host user account.

**Permissions are not isolation.** A Bash child still runs as the ICE process user and may access the host filesystem, network, and environment according to its actual process permissions. Worktree isolation separates files/Git state for patch review; it is not a process, network, or credential sandbox. Use a container, VM, or other OS-level boundary for untrusted or unattended execution. See [Security](security.md) and [Containerization](containerization.md).

## Worktree isolation

A worktree child starts from a captured snapshot of the parent's current Git tree, including staged, unstaged, and untracked work within the supported snapshot limits. Its patch represents only the child's changes relative to that baseline, so pre-existing parent edits are not attributed to the child. The parent can inspect the result before applying it.

Patch integration uses baseline and pre/postimage checks to avoid overwriting changes made after inspection and to preserve parent staging. Rollback is compare-before-restore, not an operating-system atomic transaction. Worktree setup requires a Git repository with a commit and refuses unsupported nested repositories/submodules and unsafe cases. Worktrees share the repository's Git object database; they do not sandbox Bash or other processes.

The built-in `worker` agent requests worktree isolation. Isolation raises the child edit/write ceiling for the isolated tree; it does not implicitly authorize Bash or external effects.

## Persistence, continuation, and budgets

Subagents require a saved parent session; `--no-session` is unsupported. Each child is an ordinary Ice `AgentSession` with its own durable transcript. A frozen, hashed runtime contract records the resolved model, tools, permissions, scope, resources, and other launch choices before the child starts. A later definition or settings change does not silently rewrite that child contract.

After a process restart, an in-flight turn is marked interrupted and the child is parked. Closing or switching sessions (`/resume`, `/new`, fork, quit) stops running children the same way: their turn ends `interrupted`, and the result appears in the session as soon as it is resumed, without starting a turn. ICE does **not** replay a tool call whose result was not recorded; its effects are unknown, so inspect the workspace or external system before repeating an operation. To continue, explicitly resume the child. Resume rechecks current parent authority; if required tools, model, trust, or policy are no longer available, ICE blocks the continuation rather than widening authority.

After a compaction or a resume, the parent model gets one hidden list of the session's children (name, ID, agent, state, last outcome), so it continues them instead of launching duplicates. A forked session does not take over its source session's children (two sessions never write the same child transcript or worktree); it is told which children stayed behind, and using one of them returns a clear error. Their names stay reserved in the fork.

Child usage is billed to the parent: every child turn appends a `subagent_usage` entry, which the footer, `/session` totals, and the cost breakdown (`Subagents` bucket) include, without changing the parent's context usage. Opening a session recorded before these entries existed adds one backfill entry per child for any uncovered usage.

Deleting a parent session in the session selector leaves its children's transcripts and worktrees on disk. `ice agents prune` lists subagent folders whose parent session no longer exists in any session directory; `ice agents prune --apply` removes them. It keeps folders changed in the last 10 minutes and worktrees with unapplied changes (and their transcripts).

`maxTurns`, `maxTokens`, and `timeoutMs` are optional. There is no default lifetime timeout. A configured budget stops ordinary work at exhaustion and allows one bounded, tool-free wrap-up request. `maxTokens` uses reported uncached input, cache writes, and output; cache reads remain visible in usage but do not count toward that limit. These are usage-based controls, not a guarantee about provider billing. Limits and recovery details are in the [reference](subagents-v2-reference.md).

## Agent Hub, MCP, hooks, and events

In the interactive TUI, `/agents` (or `left` on an empty editor) shows the roster, pending approvals, child state, and usage. Rows lead with a status mark and the name; finished children are listed under Finished with how their last turn ended, and long lists scroll with the selection. It can open a live child view; viewing is separate from control. In a child view, Escape returns to the main agent; the agent strip shows that key. The Hub is a view over the child registry, not a second session store or agent loop.

A definition may select `mcp: ["server/tool"]` entries. ICE does not start a new MCP server for a child: selected calls pass through the parent's already-authorized MCP adapter, and their authority cannot exceed the parent tool. See the reference for restrictions.

Subagent lifecycle hooks use the existing `ice.hooks` mechanism. Decision hooks can deny launch, a tool call, or result acceptance; observations report lifecycle facts. Hook context and tool results are untrusted data and cannot grant capabilities. Extensions can also observe the bounded metadata-only `ice:subagent` event channel. Hook and event names are listed in the [reference](subagents-v2-reference.md).

## Current implementation boundaries

- The `ice` launcher installs V2 as the only subagent system; there is no V1/V2 switch and the old `delegate*` tools are gone.
- Children cannot launch subagents; `ice.subagents.maxDepth` is reserved and values above 0 have no effect yet.
- Automated tests use the faux provider. Live TUI checks with a real model covered launch, queueing, background delivery around an aborted turn, `Ctrl+B`, session switching, and the Agent Hub; they do not certify every provider.
- Subagent findings and reports are model output. Structured validation can check shape and observed evidence, but it cannot establish semantic correctness by itself. Run and inspect the required verifier yourself.

## Related documentation

- [Schema, settings, tools, hooks, and event reference](subagents-v2-reference.md)
- [Implementation architecture and invariants](subagents-v2-architecture.md)
- [Migration from the legacy subagent tools](subagents-v2-migration.md)
- [Settings](settings.md), [Security](security.md), and [Containerization](containerization.md)
- [Rewrite plan and phase history](https://github.com/Zykairotis/ice/blob/void/Plan/subagent-rewrite.md) (engineering history; its phase table is not the current user guide)
