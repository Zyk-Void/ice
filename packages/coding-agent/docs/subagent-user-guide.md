# ICE subagent user guide

Ice remains the only reasoning/tool loop. These controls belong to `ice`; ordinary `ice` does not load the delegation extension. Start with read-only delegation. Host command hooks and alternate routes are opt-in and do not provide a sandbox.

## Choose a tool

| Tool | Use |
|---|---|
| `list_subagent_profiles` | Discover file agents, self-delegation, sources, effective capabilities, and diagnostics |
| `delegate` | One foreground file-agent or self-delegated (role self) investigation |
| `delegate_async` | Owner-scoped durable background investigation |
| `delegate_batch` | Up to eight independently scoped sibling tasks |
| `review_batch` | Independent correctness/security/tests/regression reviewers |
| `manage_subagent` | Inspect, follow up, extend, or stop an eligible retained foreground run |
| `inspect_subagent_job`, `cancel_subagent_job` | Inspect/cancel owned background jobs |
| `delegate_write` | Separate build-only isolated writer workflow |

Background jobs are not restart-resumable live sessions. Restart preserves inspectable terminal/interrupted state and never automatically relaunches ambiguous work. Foreground follow-up reuses the native child, requires an owner-bound run ID and stable request ID, and rejects user-takeover conflicts.

## Self-delegation: no file required

Ask the parent to delegate an investigation, or use these `delegate` tool arguments:

```json
{
  "role": "self",
  "task": "Inspect the implementation and return verified file evidence.",
  "scope": { "roots": ["src"] },
  "execution": { "maxTurns": 8, "maxToolCalls": 20 },
  "contextMode": "fresh"
}
```

Use roots that exist in your repository. The facade snapshots the parent's actual effective system prompt and eligible active tools. `self.instructions` is an optional addition of up to 16 KiB, not a replacement for the parent snapshot. The combined snapshot is bounded to 128 KiB. Delegation, session management, shutdown, and writer-integration tools cannot be inherited. A low-level embedded host without a parent session must explicitly supply the instruction snapshot.

Ordinary children remain read-only. Trusted startup-authorized `--ice-mode build --ice-allow-bash --sub-yolo` makes requested mutation/Bash capabilities eligible; it does not grant tools missing from the parent or defeat deny policy. `review_batch` remains read-only even under a host-authorized parent. The separate `delegate_write` workflow is unchanged.

## Create a file agent

There are no bundled roles. Put a Markdown file in `~/.ice/agents/api-review.md` globally, or `.ice/agents/api-review.md` for a trusted project. An explicit `ICE_CODING_AGENT_DIR`/`agentDir` override uses `<agentDir>/agents` instead. On a name collision the complete global definition wins and the shadowed project source is surfaced in diagnostics; bodies are never merged. Legacy `~/.ice/agent/agents` files are inventoried by the migration manifest but are not loaded or moved automatically. For a one-off child without a file, use `role: "self"`; optional `self.capabilities` narrows the inherited, registered parent capability set. Self children get fresh history by default, optional sanitized fork handoff, independent budgets, parent-owned cancellation/verification, and no delegation/control tools.

```markdown
---
name: api-review
description: Review API compatibility and input-validation changes with file evidence.
tools: [read, grep, find, ls]
tags: [api, review]
temperature: 0.2
top-p: 0.8
---
Inspect the requested API surface. Return concrete findings with existing in-scope paths.
Distinguish verified behavior, risks, and unrun checks. Do not claim edits or passing tests without evidence.
```

Use lowercase kebab-case names. Unknown profile metadata is rejected. Supported operational fields include tools, tags, thinking/thinkingLevel, timeout/timeoutMs, max-output-bytes, temperature, top-p, `color` (a bounded semantic theme token), `hidden`, skills, prompts, context, optional `hooks` IDs, exact `model`/`fallbackModel` references, and explicit `mcp` server/tool selectors (for example `mcp: [search/docs]`). Import provenance fields are retained. Models follow the deterministic order: explicit call model, else file primary, else file fallback, else the captured parent (duplicates collapse; omitted fields reach the parent). Each configured candidate is resolved through Ice's catalog with existing-auth, text input, usable context/output metadata, explicit reasoning requirements, and route-policy checks; availability failures advance with a bounded skip reason while policy denials reject the launch. Selected MCP tools are opt-in and dispatch only through the parent-owned adapter with hooks, budgets, cancellation, and bounded output; without parent authorization the launch fails closed. Global-first precedence applies throughout ice: an explicit call value beats an explicit global value, which beats a trusted-project value, then the profile/bundled default. Denies, mode restrictions, and trust requirements still win over any preference. `hidden` affects discovery only: hidden profiles are omitted from listing/search/suggestions but remain directly resolvable subject to normal trust and policy.

Global (user) > trusted project is the file-agent source precedence; bundled roles and aliases were removed. Profile tools are requests: effective tools are narrowed by the parent, execution mode, deny lists, and caller subset. Role expertise does not grant write/Bash/network authority. Source hashes are checked again before use. `review_batch` uses self-delegation with a bounded reviewer snapshot; explicitly named file agents remain available through delegate/delegate_batch.

## Bound a delegation

Example tool arguments:

```json
{
  "role": "api-review",
  "task": "Review request validation; report concrete defects with evidence.",
  "scope": { "roots": ["packages/coding-agent/src"], "targets": ["packages/coding-agent/src/ice-subagents.ts"] },
  "timeoutMs": 120000,
  "execution": { "thinking": "low", "tools": ["read", "grep"], "maxTurns": 8, "maxToolCalls": 20, "maxOutputBytes": 16384 },
  "contextMode": "fresh"
}
```

Roots are existing directories and are the authority boundary; targets are existing files used as focus. Selected resources add path access only through already-authorized tools. An explicit `execution.tools: []` creates a tool-free child, including no MCP tools; it never restores the full tool set. Final report repair consumes the same turn budget.

Use a bounded `contextPacket` for handoff facts. `fresh` is the default; `fork` is opt-in sanitized history, not a cloned live session. An optional restricted local `outputSchema` validates the nested `payload`; remote references and executable validators are forbidden. Schema validity never overrides evidence or mandatory acceptance failures.

## Skills and resources

File agents select `skills`, `prompts`, and `context` by bounded resource names. Invocation `resources` selections add explicitly chosen resources. Global same-name resources win over trusted project resources. Scope checks, regular-file checks, hashes, and resource size limits are rechecked before loading.

Self children do not implicitly load the parent's skill library. Set `self.inheritSkills: true` to inherit the parent's currently loaded skill files, or use `resources.skills` for a selected subset. Inherited selections are bounded to 16 skill files, 64 KiB per inherited file, and 256 KiB aggregate resources. Explicit same-name selections take precedence over inherited entries. Skill instructions never grant Bash, mutation, MCP, or controller tools.

Child sessions never resolve/install ambient packages or load ambient extensions, including under `--sub-yolo`. Their system prompt, skills, prompt templates, and context are explicit inputs. Parent extension configuration remains owned by the parent.

## Delegable extension tools

A trusted parent extension registers its ordinary tool with Ice and separately registers a child-safe adapter using the public `registerIceDelegableTool(ice.events, definition)` API. The descriptor includes a stable name, origin, actual parameter schema, host-owned access classification, and a child-scoped dispatch function. Registration alone does not activate the parent tool.

The adapter receives only immutable child identity, cwd, approved scope roots, and cancellation signal—not the parent session controller. It must enforce its own resource access; this interface is not a process sandbox. Runtime checks reject unknown classifications, management tools, built-in replacements, schema references, oversized inputs, revoked/replaced registrations, and tools no longer active in the parent. Mutations require explicit host authority. Hooks and tool-call reservations run before dispatch; outputs are redacted and bounded. Cancellation stops waiting promptly, while the adapter remains responsible for external cleanup.

A runnable, network-free example is `examples/extensions/ice-delegable-workspace-info.ts`:

```bash
ice --extension packages/coding-agent/examples/extensions/ice-delegable-workspace-info.ts
```

Once its `workspace_info` parent tool is active, self delegation can inherit it; a file agent can request it in `tools`. Names omitted by a specialist or per-call tool subset remain unavailable.

## Selected MCP tools

Use `mcp: [docs/search]` in file frontmatter, or `self.mcp: ["docs/search"]` for self delegation. These are exact host-authorized `server/tool` selectors, not server discovery requests.

The already-connected parent MCP extension must register `registerIceSubagentMcpAdapter(ice.events, adapter)`. Its authorization snapshot must contain actual installed tool schemas and explicit `read-only`, `mutation`, or `unknown` classifications from host policy. Unknown, missing-schema, unauthorized, or mode-disallowed operations fail before child creation. `examples/ice-mcp-adapter.ts` provides the typed integration helper for an existing backend.

ICE creates collision-resistant model-visible names, validates arguments, checks permissions and required hooks, shares tool budgets, propagates cancellation, preserves MCP error results, and limits redacted output. Queued/running work detects changed schemas, classifications, adapter identity, and deny policy. No new connection, authentication, or credentials are granted by a selector. An adapter must restrict its existing external resources and honor cancellation; cancellation cannot undo a call already performed.

**Compatibility boundary:** this release supports the explicit parent-owned adapter contract. Independently installed MCP extensions that do not register that contract are not silently adapted. There is no claim of live certification for every external MCP server or provider. Missing adapters fail closed instead of loading a new child extension.

## Settings

Use existing global `<agentDir>/settings.json` (normally `~/.ice/agent/settings.json`) and trusted project `.ice/settings.json` files. Preserve unrelated keys. `ice` opts into global-first ordinary settings across startup, session switches, reload, and scoped saves; stock `ice` remains project-first. Explicit false/zero/empty values win, nested leaves merge, and an explicitly supplied global resource/package array replaces the matching project configuration array. Explicit invocation preferences still specialize allowed values within caps. `/settings` exposes common controls and an effective-policy view; RPC reports preference source and whether a project override actually wins.

```json
{
  "ice": {
    "subagents": {
      "enabled": true,
      "defaults": { "maxTurns": 12, "maxToolCalls": 40, "timeoutMs": 120000, "maxTotalTokens": 100000 },
      "restrictions": { "denyTools": ["bash", "edit", "write"], "maxTurns": 16 },
      "modelSelection": { "mode": "inherit-parent" }
    }
  }
}
```

Deny wins. Empty allowed-role lists are neutral. Invalid policy blocks admission. Settings changes affect future launches and revoke active/queued authority at safe boundaries rather than silently granting more capability. Turn/tool limits remain settings-contract controls and are not duplicated in profile frontmatter. Profile `temperature` is passed through typed stream options when supported; `top-p` is mapped to `top_p` only for OpenAI-compatible adapters. Anthropic temperature and non-OpenAI top-p requests are omitted with a bounded provider-compatibility diagnostic. Sampling preferences apply to work and the bounded final report.

### Optional aggregate token budget

`execution.maxTotalTokens` and `ice.subagents.defaults.maxTotalTokens` opt into a soft cumulative work-token ceiling. The charged formula is `inputTokens + outputTokens + cacheWriteTokens`; cache reads remain visible in usage but are excluded from the ceiling. Provider-reported usage is preferred. Missing or invalid provider usage is estimated from the actual request context and output and is marked with `~` in observability; mixed provider/estimated runs are reported as mixed.

The limit reserves `min(4096, max(1024, floor(maxTotalTokens * 0.10)))` tokens for one bounded tool-free final report. Ordinary work stops before that reserve when possible; reaching the full work allowance also exhausts ordinary work. A single in-flight provider response may overshoot because usage is charged when it completes; observed usage is never clipped or refunded. The bounded final-report request is issued only on routes that honor a hard per-request output authority and only when the reserve can safely cover the complete finalizer request context plus bounded output; otherwise the parent returns a deterministic bounded partial result and does not issue another explanation request. Token limits are independent from turns, tool calls, timeout, context occupancy, and the UTF-8 result-size cap. They are not a dollar-cost guarantee. Built-in provider adapters receive a runtime output authority when possible; unknown/custom APIs are aggregate-soft, never receive the finalization model request, and must not be described as hard-capped.

For batch/review calls, `totalTokenBudget` atomically reserves each task's resolved `maxTotalTokens`; a task without a resolved token ceiling cannot enter a token-budgeted batch. Unused reservations are released on settlement or cancellation, while actual overshoot and charged usage remain visible. Durable jobs persist the accepted optional ceiling and safe-boundary terminal summary; they do not resume an in-flight model session after restart.

## Optional child routes

To enable exact per-call routing, explicitly set **global** `ice.subagents.modelSelection.mode` to `configured`. Then request:

```json
{ "execution": { "model": "provider/exact-model-id", "thinking": "low" } }
```

Choose an existing configured route from Ice's catalog; do not paste a key or construct an endpoint. Omitting call and file model fields preserves the exact parent object. The adapter does not discover models, authenticate, or expand credentials. Candidates run in call/primary/fallback/parent order: missing credentials, unavailable routes, or incomplete capability metadata advance to the next candidate with a bounded skip reason, while route-policy denials reject the launch. Unsupported requested thinking fails before the child is launched. Admission fallback never replays an edit or external action with uncertain outcome. Foreground/batch recovery has at most two attempts and requires explicit native evidence of a retryable startup failure before a child session or tool effect exists. Runtime stream failures are terminal, even when no final report was produced. Retry attempts share the original elapsed-time, output, turn, and usage accounting; startup time does not reset the execution timer. Durable jobs retain the selected provider/model identity, ordered candidates and skips, route fingerprint, effective tool names, adapter fingerprints, and resource identity hash; stale or unavailable captured routes fail explicitly at promotion instead of silently rerouting, and restart never auto-relaunches ambiguous work. Writer routing remains separate and inherits the parent.

## Parent-owned in-process hooks

Declare hooks under `ice.hooks.definitions`. Events include `subagent.beforeLaunch`, `subagent.beforeTool`, `subagent.beforeAccept` and observational started/afterTool/checkpoint/attention/completed/failed/timedOut/cancelled events.

A trusted parent extension can import `registerIceSubagentHook` from `@zykairotis/ice-coding-agent`, register with `ice.events` as the owner identity, and unregister on shutdown. This is a direct trusted-code registration API, not an authorization message on the event bus. Embedded hosts can instead pass `hookHandlers` to `iceSubagents()`.

Decision handlers return `{outcome:"continue"|"deny"|"ask", reason?:string}`. Only beforeLaunch may return bounded `contextAdditions`; the parent redacts and revalidates them. Observers cannot authorize work or erase failures. Required handlers cannot be removed by role/call selections. Global definitions win ID collisions; required status cannot be downgraded by a colliding definition. Unregistration/replacement of a captured handler fails closed. Optional profile `hooks` and `execution.hooks` selections are unioned; an explicitly empty selection excludes optional hooks when no other selector adds them.

Hook intents request native durable acknowledgement before handlers run. Persistent parent sessions are required; `--no-session` cannot satisfy that boundary. Cancellation/deadline covers intent acknowledgement and dispatch. Missing outcomes remain unresolved after restart and are never automatically replayed.

## Optional command hooks: host authority

Command hooks require all of:

1. A **global**, host-reviewed `ice.hooks.commandPolicy` with `enabled:true`.
2. An exact hook ID mapped to a literal argv array, absolute executable and cwd, and SHA-256 identities.
3. Trusted project and authoritative `build` mode with startup-authorized parent Bash.
4. `approval:"ask"` plus interactive approval, or explicit host policy `approval:"allow"` for unattended use.
5. A persistent parent session and acknowledged intent.

A trusted project cannot enable command policy for itself. Plan/review command execution is denied. A hook's returned `ask` decision is a separate approval from approval to execute the command.

Policy shape (placeholders must be replaced with reviewed local values):

```json
{
  "ice": {
    "hooks": {
      "enabled": true,
      "definitions": [{ "id": "launch-audit", "kind": "command", "event": "subagent.beforeLaunch", "required": true, "timeoutMs": 1500, "maxOutputBytes": 8192 }],
      "commandPolicy": {
        "enabled": true,
        "approval": "ask",
        "commands": {
          "launch-audit": {
            "argv": ["/absolute/canonical/node", "/absolute/project/hooks/audit.mjs"],
            "cwd": "/absolute/project",
            "sha256": "REPLACE_WITH_EXECUTABLE_SHA256",
            "files": { "/absolute/project/hooks/audit.mjs": "REPLACE_WITH_SCRIPT_SHA256" }
          }
        }
      }
    }
  }
}
```

Hash executable and script bytes locally; do not install policy automatically. `files` pins reviewed scripts/resources but is not a sandbox or an automatic transitive dependency manifest. Review every interpreter argument and imported dependency. Do not authorize shells, dynamic loaders, package managers, or scripts that execute repository text without independent review.

Input is bounded JSON on stdin with schemaVersion, event, ownerSessionId, runId, attempt, role, and redacted payload. Output must be one JSON object:

```json
{ "schemaVersion": 1, "outcome": "continue", "reason": "Policy checks passed" }
```

No shell interpolation occurs. Environment is limited to `LANG` and `LC_ALL`; argv is literal, not templated. stdin is capped at 32 KiB, stdout/stderr are independently capped, and deadlines/cancellation terminate the process tree best-effort. Raw stderr is not returned as policy evidence.

**Not a sandbox:** the process still has the host account's filesystem and network authority, can independently read credential files, and may leave irreversible effects. Executable hash checks have host-filesystem TOCTOU limitations. Do not use command hooks for untrusted/unattended execution without an independent containment boundary. Never retry an ambiguous side effect automatically.

## Observe, disable, recover

Use `/agents` or `/subagents` for bounded state and child views. Mirror view is read-only; explicit Take Control changes control ownership. Verify returned paths, required criteria, and actual checks before accepting completion.

To stop new admissions set `ice.subagents.enabled:false`. Use owner inspect/cancel for retained jobs. Disable command execution independently with global `ice.hooks.commandPolicy.enabled:false`; disable alternate routes by restoring `inherit-parent`. Do not delete journals or relaunch unresolved effects. Inspect missing outcomes before deciding recovery.

## Migration and rollback

Run `list_subagent_profiles` before changing files. It reports legacy files in `~/.ice/agent/agents`, intended `~/.ice/agents` destinations, and collisions. Review each pair and manually copy/move only the approved file; never overwrite a destination just to make a role appear. There is no silent old-path compatibility lookup. Unknown former built-ins such as `explore` must be replaced with `self` or an explicit file agent. Agent paths change; settings/auth locations do not.

Disable new admissions with `ice.subagents.enabled: false`, then inspect/cancel existing owned jobs. Disable command policy independently and unregister external adapters. Do not delete journals, reroute queued jobs, or relaunch work with unresolved external effects. A source-code rollback must preserve pre-existing work and must not automatically move user agent files.

## Troubleshooting

- **Unknown role metadata:** remove/correct unsupported fields; never assume ignored restrictions apply.
- **Required hook missing:** load/register the trusted parent handler or correct the command ID/policy. Do not silently mark it optional.
- **Persistent session required:** omit `--no-session`; no durable hook claim is available in memory-only mode.
- **Hash changed:** review changes and update approved hashes explicitly; do not auto-accept new bytes.
- **Route unavailable/capabilities changed:** inspect Ice's configured catalog; do not substitute a different route silently.
- **Needs time:** inspect and extend/stop the existing eligible child rather than spawning a duplicate.
- **Verified=false:** preserve failures and evidence. A valid payload or hook approval is not proof of completion.

The implementation plan and reproducible verification packet are in `agent_docs/implementation/subagent-self-delegation-model-fallback-plan.md` and `.artifacts/ice-self-user-ready-20260910/`. The static operator explainer is `html-communication/subagent-user-ready.html`.
