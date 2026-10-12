# Subagents V2 reference

This is the schema and runtime reference for the current ICE subagent system. For a first-time walkthrough, see [Subagents V2](subagents-v2.md). The V2 tools are installed by the `ice` launcher; `ICE_SUBAGENTS_V2` and `ice.subagents.v2` do not select a separate implementation.

## Agent definition sources and precedence

Native Markdown files require frontmatter `name`, `description`, and a non-empty prompt body. JSON definitions in `ice.subagents.agents` and `--agents` use a `prompt` property instead of a Markdown body. Sources are considered from lowest to highest precedence; a later definition replaces the entire earlier definition with the same name, rather than merging its fields:

1. Built-ins: `general`, `explore`, `plan`, `review`, `worker`.
2. Installed package agent directories.
3. User files under `~/.ice/agents/**/*.md` (or `<agentDir>/agents` for an explicitly configured agent directory).
4. Global `ice.subagents.agents` settings.
5. `.claude/agents/**/*.md` when global `ice.subagents.compat.claudeAgents` is `true`.
6. Trusted project `.ice/agents/**/*.md`, searched from the current directory toward the Git root; nearer project definitions win within this source.
7. Trusted project `ice.subagents.agents` settings.
8. The `--agents '<json>'` startup flag.
9. An optional configured managed-agent source/policy, which has locked precedence and cannot be disabled. No managed directory is searched unless the host configures one.

`.claude/agents` compatibility maps recognized fields; unsupported fields can be dropped with diagnostics. Native `.ice/agents` files are strict. `ice agents list` reports active, shadowed, disabled, and invalid definitions, and `ice agents prune [--apply]` lists or removes subagent data whose parent session was deleted; project definitions are not activated until project trust is established.

## Agent frontmatter and JSON fields

The Markdown `name` and `description` fields are required. JSON definitions take their name from the map key and require `description` and `prompt`. Native frontmatter rejects unknown fields. The prompt body and JSON `prompt` are capped at 64 KiB; agent files are capped at 128 KiB.

| Field | Meaning |
|---|---|
| `tools` | Requested tool names/globs; a list or comma-separated string. Omitted or `"*"` requests child-safe tools active in the parent, still subject to policy. |
| `disallowedTools` | Remove matching requested tools. |
| `model` | `inherit`, one provider/model reference, or an ordered candidate list (maximum 8). Default is the exact parent model. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`. |
| `permissionMode` | `inherit`, `plan`, `review`, `build`, or `bubble`. `bubble` changes approval routing; it does not add tools. `plan` and `review` deny direct edits/writes and mutation adapters; Bash/external-directory subjects are at most `ask` and remain parent/approval gated. |
| `permissions` | Definition-level `allow`, `ask`, and `deny` rule lists. Definition rules cannot by themselves lift the default child mutation ceiling. |
| `maxTurns`, `maxTokens`, `timeoutMs` | Optional per-task budget ceilings. Omitted values are unlimited; there is no default lifetime timeout. |
| `isolation` | `none` or `worktree`. A task-level isolation choice can request a worktree for that launch. |
| `contextFiles` | Whether to include eligible project instruction/context files; trust and scope still apply. |
| `skills`, `prompts`, `context` | Explicitly selected resources from the parent's eligible resources; they do not load arbitrary ambient extensions. |
| `mcp` | Explicit MCP `server/tool` selectors (globs are supported); dispatch uses the parent's authorized adapter. |
| `requiredMcpServers` | Keep the definition unavailable unless the parent exposes an MCP server matching each entry to subagents. |
| `hooks` | Optional hook IDs selected for this agent; required global hooks still run. |
| `initialPrompt` | Bounded text that opens the child's first turn, before the task prompt; never repeated on resume. |
| `spawns` | Reserved: children cannot launch subagents yet, so this has no effect. |
| `color`, `hidden`, `tags` | Presentation and discovery metadata; `hidden` suppresses normal callable listing. |
| `temperature`, `topP` | Optional model sampling settings. |
| `background` | The schema accepts this legacy-compatible field, but launch backgrounding is controlled by the top-level `agent` request's `background` field. |

Agent names match `^[a-z0-9][a-z0-9-]{0,63}$`. Description length is at most 1,024 characters. Selected list fields are bounded to 64 entries and 256 characters per entry; see `src/subagents/definitions/schema.ts` for authoritative limits.

## Settings

V2 settings live under `ice.subagents` in `~/.ice/agent/settings.json`; trusted project settings may be placed in `.ice/settings.json`.

```json
{
  "ice": {
    "subagents": {
      "defaultAgent": "general",
      "maxDepth": 0,
      "maxConcurrent": 4,
      "askTimeoutMs": 600000,
      "disabledAgents": [],
      "permissions": {
        "deny": ["bash(git push*)", "write(**/.env*)"]
      },
      "agents": {},
      "compat": {
        "claudeAgents": false,
        "modelAliases": {}
      }
    }
  }
}
```

| Setting | Default | Bounds / behavior |
|---|---:|---|
| `enabled` | `true` | `false` in either scope blocks new launches; existing children stay manageable through `agent_control`. A project cannot re-enable delegation the global setting disabled. |
| `defaultAgent` | `general` | Agent name used when a task omits `agent`. |
| `maxDepth` | `0` | Integer 0–4. Reserved: children cannot launch subagents yet, so values above 0 have no effect. A project setting can reduce, not raise, the global ceiling. |
| `maxConcurrent` | `4` | Integer of at least 1; no upper limit. Turns beyond it queue. A project setting can reduce, not raise, the global value. Each `agent` call accepts at most 8 tasks. Applies to new sessions. |
| `askTimeoutMs` | 600000 (10 minutes) | Integer 1,000–3,600,000; global approval timeout. Timeout denies the request. |
| `permissions` | no extra rules | Rule lists are composed across scopes; the most restrictive matching decision wins. |
| `agents` | none | JSON definition map; user and trusted-project sources are separate. |
| `disabledAgents` | none | Names disabled across scopes; managed definitions cannot be disabled. |
| `compat.claudeAgents` | `false` | Global opt-in to read `.claude/agents` compatibility files. |
| `compat.modelAliases` | `{}` | Global model-alias map used by compatibility parsing. |
| `v2` | ignored | Obsolete rollout key retained for settings compatibility; it does not enable/disable V2. |

Invalid V2 settings and unknown keys fail closed with diagnostics: new launches are refused until the scope is repaired. Keys of the removed legacy system (`defaults`, `allowedRoles`, `roleDefaults`, `restrictions`, `modelSelection`, `concurrency`, `routeTiers`) are ignored and reported as warnings by `ice agents validate` and as `ice_deprecated_setting` RPC settings diagnostics. RPC settings expose `enabled`, `defaultAgent`, `maxConcurrent`, `maxDepth`, `askTimeoutMs`, and `disabledAgents`; `permissions`, `agents`, and `compat` are edited in settings files only. Project definitions and project settings are considered only when the project is trusted. Project permission rules may narrow authority but cannot authorize unattended mutation. See [Settings](settings.md) for the broader settings merge and trust rules.

## Permission rule grammar and evaluation

A rule is a tool name/glob, optionally followed by a subject pattern:

```text
bash(npm test*)
edit(src/**)
mcp__github__*
*
```

For file paths, `*` matches within one path component and `**` crosses components. For non-path subjects, `*` matches arbitrary text. Bash is split into command subjects at shell separators; all pieces must be allowed. Command substitution (`$()`, backticks, process substitution) is opaque and cannot be auto-allowed.

The effective result is the most restrictive matching decision: `deny` > `ask` > `allow`. No match uses the operation's fallback. ICE then applies non-overridable mode caps and the parent ceiling. For subagents, edit/write, Bash, and mutation-capable adapters default to `ask`; a user-scope or managed allow, authorized `--sub-yolo`, or (for edit/write only) worktree isolation can raise the child ceiling, but the parent decision remains a hard cap. Project-scope rules are not ceiling raisers. Unknown adapter access fails safe as mutation.

| Agent mode | Effect |
|---|---|
| `inherit` | No additional mode cap beyond the frozen parent and child policy. |
| `plan` | Read-only; edits/writes and mutation adapters deny; Bash and external-directory access ask. |
| `review` | Edits/writes and mutation adapters deny; Bash/external-directory access is at most `ask` and remains constrained by parent policy/approval. |
| `build` | Does not itself grant authority; the child mutation ceiling and parent rules still apply. |
| `bubble` | Routes child `ask` decisions to the parent approval surface; does not widen authority. |

`--sub-yolo` is a launch flag, not an agent permission mode. It requires an explicit build parent, trusted project, active startup-authorized parent Bash, and an approval-capable TUI or explicitly authorized RPC session. It never overrides deny, project trust, scope, parent mode, or absent parent tools. This is not a sandbox.

## `agent` request schema

`agent` accepts an object with `tasks` (1–8 entries) and optional top-level `background`.

Each task requires:

- `description`: 1–120 characters;
- `prompt`: non-empty, at most 64 KiB;
- optional `agent` or `resume` (a child ID or name; not both).
- optional `name` for a new child: `^[a-z0-9][a-z0-9-]{0,39}# Subagents V2 reference

This is the schema and runtime reference for the current ICE subagent system. For a first-time walkthrough, see [Subagents V2](subagents-v2.md). The V2 tools are installed by the `ice` launcher; `ICE_SUBAGENTS_V2` and `ice.subagents.v2` do not select a separate implementation.

## Agent definition sources and precedence

Native Markdown files require frontmatter `name`, `description`, and a non-empty prompt body. JSON definitions in `ice.subagents.agents` and `--agents` use a `prompt` property instead of a Markdown body. Sources are considered from lowest to highest precedence; a later definition replaces the entire earlier definition with the same name, rather than merging its fields:

1. Built-ins: `general`, `explore`, `plan`, `review`, `worker`.
2. Installed package agent directories.
3. User files under `~/.ice/agents/**/*.md` (or `<agentDir>/agents` for an explicitly configured agent directory).
4. Global `ice.subagents.agents` settings.
5. `.claude/agents/**/*.md` when global `ice.subagents.compat.claudeAgents` is `true`.
6. Trusted project `.ice/agents/**/*.md`, searched from the current directory toward the Git root; nearer project definitions win within this source.
7. Trusted project `ice.subagents.agents` settings.
8. The `--agents '<json>'` startup flag.
9. An optional configured managed-agent source/policy, which has locked precedence and cannot be disabled. No managed directory is searched unless the host configures one.

`.claude/agents` compatibility maps recognized fields; unsupported fields can be dropped with diagnostics. Native `.ice/agents` files are strict. `ice agents list` reports active, shadowed, disabled, and invalid definitions, and `ice agents prune [--apply]` lists or removes subagent data whose parent session was deleted; project definitions are not activated until project trust is established.

## Agent frontmatter and JSON fields

The Markdown `name` and `description` fields are required. JSON definitions take their name from the map key and require `description` and `prompt`. Native frontmatter rejects unknown fields. The prompt body and JSON `prompt` are capped at 64 KiB; agent files are capped at 128 KiB.

| Field | Meaning |
|---|---|
| `tools` | Requested tool names/globs; a list or comma-separated string. Omitted or `"*"` requests child-safe tools active in the parent, still subject to policy. |
| `disallowedTools` | Remove matching requested tools. |
| `model` | `inherit`, one provider/model reference, or an ordered candidate list (maximum 8). Default is the exact parent model. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`. |
| `permissionMode` | `inherit`, `plan`, `review`, `build`, or `bubble`. `bubble` changes approval routing; it does not add tools. `plan` and `review` deny direct edits/writes and mutation adapters; Bash/external-directory subjects are at most `ask` and remain parent/approval gated. |
| `permissions` | Definition-level `allow`, `ask`, and `deny` rule lists. Definition rules cannot by themselves lift the default child mutation ceiling. |
| `maxTurns`, `maxTokens`, `timeoutMs` | Optional per-task budget ceilings. Omitted values are unlimited; there is no default lifetime timeout. |
| `isolation` | `none` or `worktree`. A task-level isolation choice can request a worktree for that launch. |
| `contextFiles` | Whether to include eligible project instruction/context files; trust and scope still apply. |
| `skills`, `prompts`, `context` | Explicitly selected resources from the parent's eligible resources; they do not load arbitrary ambient extensions. |
| `mcp` | Explicit MCP `server/tool` selectors (globs are supported); dispatch uses the parent's authorized adapter. |
| `requiredMcpServers` | Keep the definition unavailable unless the parent exposes an MCP server matching each entry to subagents. |
| `hooks` | Optional hook IDs selected for this agent; required global hooks still run. |
| `initialPrompt` | Bounded text that opens the child's first turn, before the task prompt; never repeated on resume. |
| `spawns` | Reserved: children cannot launch subagents yet, so this has no effect. |
| `color`, `hidden`, `tags` | Presentation and discovery metadata; `hidden` suppresses normal callable listing. |
| `temperature`, `topP` | Optional model sampling settings. |
| `background` | The schema accepts this legacy-compatible field, but launch backgrounding is controlled by the top-level `agent` request's `background` field. |

Agent names match `^[a-z0-9][a-z0-9-]{0,63}$`. Description length is at most 1,024 characters. Selected list fields are bounded to 64 entries and 256 characters per entry; see `src/subagents/definitions/schema.ts` for authoritative limits.

## Settings

V2 settings live under `ice.subagents` in `~/.ice/agent/settings.json`; trusted project settings may be placed in `.ice/settings.json`.

```json
{
  "ice": {
    "subagents": {
      "defaultAgent": "general",
      "maxDepth": 0,
      "maxConcurrent": 4,
      "askTimeoutMs": 600000,
      "disabledAgents": [],
      "permissions": {
        "deny": ["bash(git push*)", "write(**/.env*)"]
      },
      "agents": {},
      "compat": {
        "claudeAgents": false,
        "modelAliases": {}
      }
    }
  }
}
```

| Setting | Default | Bounds / behavior |
|---|---:|---|
| `enabled` | `true` | `false` in either scope blocks new launches; existing children stay manageable through `agent_control`. A project cannot re-enable delegation the global setting disabled. |
| `defaultAgent` | `general` | Agent name used when a task omits `agent`. |
| `maxDepth` | `0` | Integer 0–4. Reserved: children cannot launch subagents yet, so values above 0 have no effect. A project setting can reduce, not raise, the global ceiling. |
| `maxConcurrent` | `4` | Integer of at least 1; no upper limit. Turns beyond it queue. A project setting can reduce, not raise, the global value. Each `agent` call accepts at most 8 tasks. Applies to new sessions. |
| `askTimeoutMs` | 600000 (10 minutes) | Integer 1,000–3,600,000; global approval timeout. Timeout denies the request. |
| `permissions` | no extra rules | Rule lists are composed across scopes; the most restrictive matching decision wins. |
| `agents` | none | JSON definition map; user and trusted-project sources are separate. |
| `disabledAgents` | none | Names disabled across scopes; managed definitions cannot be disabled. |
| `compat.claudeAgents` | `false` | Global opt-in to read `.claude/agents` compatibility files. |
| `compat.modelAliases` | `{}` | Global model-alias map used by compatibility parsing. |
| `v2` | ignored | Obsolete rollout key retained for settings compatibility; it does not enable/disable V2. |

Invalid V2 settings and unknown keys fail closed with diagnostics: new launches are refused until the scope is repaired. Keys of the removed legacy system (`defaults`, `allowedRoles`, `roleDefaults`, `restrictions`, `modelSelection`, `concurrency`, `routeTiers`) are ignored and reported as warnings by `ice agents validate` and as `ice_deprecated_setting` RPC settings diagnostics. RPC settings expose `enabled`, `defaultAgent`, `maxConcurrent`, `maxDepth`, `askTimeoutMs`, and `disabledAgents`; `permissions`, `agents`, and `compat` are edited in settings files only. Project definitions and project settings are considered only when the project is trusted. Project permission rules may narrow authority but cannot authorize unattended mutation. See [Settings](settings.md) for the broader settings merge and trust rules.

## Permission rule grammar and evaluation

A rule is a tool name/glob, optionally followed by a subject pattern:

```text
bash(npm test*)
edit(src/**)
mcp__github__*
*
```

For file paths, `*` matches within one path component and `**` crosses components. For non-path subjects, `*` matches arbitrary text. Bash is split into command subjects at shell separators; all pieces must be allowed. Command substitution (`$()`, backticks, process substitution) is opaque and cannot be auto-allowed.

The effective result is the most restrictive matching decision: `deny` > `ask` > `allow`. No match uses the operation's fallback. ICE then applies non-overridable mode caps and the parent ceiling. For subagents, edit/write, Bash, and mutation-capable adapters default to `ask`; a user-scope or managed allow, authorized `--sub-yolo`, or (for edit/write only) worktree isolation can raise the child ceiling, but the parent decision remains a hard cap. Project-scope rules are not ceiling raisers. Unknown adapter access fails safe as mutation.

| Agent mode | Effect |
|---|---|
| `inherit` | No additional mode cap beyond the frozen parent and child policy. |
| `plan` | Read-only; edits/writes and mutation adapters deny; Bash and external-directory access ask. |
| `review` | Edits/writes and mutation adapters deny; Bash/external-directory access is at most `ask` and remains constrained by parent policy/approval. |
| `build` | Does not itself grant authority; the child mutation ceiling and parent rules still apply. |
| `bubble` | Routes child `ask` decisions to the parent approval surface; does not widen authority. |

`--sub-yolo` is a launch flag, not an agent permission mode. It requires an explicit build parent, trusted project, active startup-authorized parent Bash, and an approval-capable TUI or explicitly authorized RPC session. It never overrides deny, project trust, scope, parent mode, or absent parent tools. This is not a sandbox.

## `agent` request schema

`agent` accepts an object with `tasks` (1–8 entries) and optional top-level `background`.

Each task requires:

- `description`: 1–120 characters;
- `prompt`: non-empty, at most 64 KiB;
, unique among the session's children. `resume`, `agent_control`, and `agent_patch` accept it wherever a child ID is accepted.

Optional task fields:

- `model`, `thinking`, `isolation`;
- `scope.roots` (1–32) and `scope.targets` (up to 32);
- `outputSchema` and up to 16 `acceptance` claims (1,024 characters each);
- up to 16 context items, each with an `id` (1–64 characters), a kind (`parent_note`, `verified_fact`, `evidence_ref`, `artifact_ref`), and `content` (1–32 KiB);
- `maxTurns`, `maxTokens`, and `timeoutMs` positive integers.

A task has one description/prompt contract; a resume request continues the frozen child contract and cannot replace its model, tools, permissions, or scope. Structurally validated output and accepted claims are not semantic proof; assurance is derived from host-observed state.

## `agent_control` actions

`agent_control` requires `action` from this list:

| Action | Purpose |
|---|---|
| `status` | Inspect one child. |
| `list` | List children owned by the current parent session. |
| `wait` | Wait once for one or more children (up to 8 IDs; one wait is capped at 30 minutes). Ends early when the user queues a message or presses `ctrl+b`; background completions arrive as messages, so repeated waits are unnecessary. |
| `send` | Send a `message`, `followup`, or `interrupt` to a child. |
| `resume` | Revive a parked child when the frozen contract still passes authority checks. |
| `stop` | Cancel the current child turn; it is cooperative for already-running effects. |
| `delete` | Stop the child if it is running, then delete its record and clean up owned resources. |
| `output` | Read a child final-answer artifact using byte `offset` and `length`; one read is capped at 48 KiB. |
| `agents` | Inspect definition diagnostics and availability. |

Child IDs are owner-scoped and have the form `ag_` plus 26 lowercase base32 characters. A child launched with a `name` can be referred to by that name instead.

A child whose turn settled is parked 30 seconds later unless it is running again, waited on, integrating a patch, or shown in the interactive view: it leaves memory and the live views but stays listed (as finished in the Agent Hub) and resumable until deleted. A child stopped before its first turn ran is removed. Multi-task display groups use `agg_` identifiers; a group identifier is not a child ID.

## `agent_patch` actions

`agent_patch` requires a child ID and one of:

- `inspect`: validate and show bounded metadata/preview for its isolated delta;
- `apply`: integrate the reviewed delta into the parent workspace under the parent policy/mode gate;
- `reject`: record rejection and clean up the child worktree.

Apply is optimistic-concurrency guarded, not a filesystem lock or atomic transaction. A configured `--ice-verify` is run as a parent-owned command and must pass. Without a verifier, the integration remains unverified. Interrupted integration is not automatically replayed.

## Events and hooks

### Extension event channel

`ice:subagent` publishes bounded lifecycle metadata only (no prompt, final answer, or secret):

`subagent_start`, `subagent_turn_start`, `subagent_turn_end`, `subagent_parked`, `subagent_revived`, `subagent_blocked`, `subagent_interrupted`, `subagent_end`, `subagent_patch`, `subagent_completion_queued`, `subagent_permission_request`.

### `ice.hooks`

Decision hooks are `subagent.beforeLaunch`, `subagent.beforeTool`, and `subagent.beforeAccept`. Observation hooks currently dispatched by V2 are `subagent.started`, `subagent.afterTool`, `subagent.completed`, `subagent.failed`, `subagent.timedOut`, and `subagent.cancelled`. `beforeLaunch` may add bounded, explicitly untrusted context; other hooks do not grant capabilities. Required decision hooks that fail or time out block the operation. Hook intents are journaled before execution; outcome records are bounded and redacted. Agent definitions may select optional hook IDs with `hooks`; required global hooks still apply.

The shared legacy settings parser still recognizes `subagent.checkpoint` and `subagent.attention`, but V2 does not dispatch periodic check-in events. Do not depend on those event names for V2 behavior.

## Persistence and output limits

Child transcripts are ordinary session files below:

```text
<parent-session-directory>/subagents/<parent-session-id>/
```

The first child entry stores the versioned, hashed frozen runtime contract. The registry journal and child transcript are distinct: registry state owns lifecycle and delivery; the transcript stores the child conversation. The parent must have a saved session.

Final answers are redacted and retained separately from raw transcripts. Current host limits include 48 KiB inline output, 4 MiB per output artifact, 48 KiB maximum per `agent_control output` read, 16 MiB retained per owner, and 128 MiB globally. Artifact availability/retention failure does not prove task success or stop the child. See `src/subagents/results/output-artifacts.ts` for current exact limits.
