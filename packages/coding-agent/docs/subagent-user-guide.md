# ICE subagent user guide

Ice remains the only reasoning/tool loop. These controls belong to `ice`; ordinary `ice` does not load the delegation extension. Start with read-only delegation. Host command hooks and alternate routes are opt-in and do not provide a sandbox.

## Experimental V2 boundary

Subagents V2 (`agent`, `agent_control`, `agent_patch`; see [subagents-v2.md](./subagents-v2.md)) is now the default. This guide otherwise describes the legacy tool set, which the global `ice.subagents.v2: false` setting or `ICE_SUBAGENTS_V2=0` selects **instead of**, never alongside, V2. The legacy tools will be removed; implementation progress is recorded in `Plan/subagent-rewrite.md` at the repository root.

The gated worktree path gives a child bounded staged/unstaged/untracked parent WIP and reports only its own delta. Inspect before apply; applying requires a trusted build parent and current write authority. With a configured `--ice-verify` argv the verifier must pass or the apply rolls back; without one the patch is applied like your own edits and reported as unverified. Integration preserves the real index. Newer edits are never blindly overwritten during rollback. Inspect interrupted `applying` / `rollback_conflict` state and its retained recovery reference; do not replay it or delete recovery data. Unchanged worktrees are removed with an `unchanged` state, not a verification claim. Changed worktrees remain until an explicit apply/reject/delete decision.

Worktrees are not a sandbox. This slice refuses nested repositories/submodules, patch symlinks, file/directory replacements, external Git merge drivers, and child worktrees located inside the parent repository. Fixed host ceilings bound snapshots and patches. Raw artifacts remain byte-exact, while a text preview may replace non-UTF-8 bytes for display. Foreground multi-task `agent` calls include a bounded deterministic structural summary of child statuses, host-checked criterion/evidence coverage, shared evidence paths, and conservative explicit disagreements. It is bookkeeping—not semantic verification, consensus, or independent review approval. Child reports remain in invocation order. Background tasks return IDs and deliver independently; no durable aggregate batch handle is created. Large final-answer artifacts are retained owner-scoped and can be read in bounded ranges through `agent_control action=output`. The full V2 Hub, higher assurance, background aggregate synthesis, and legacy migration are not shipped.

Experimental V2 tasks enforce optional `maxTurns`, `maxTokens`, and `timeoutMs` limits after admission; absent limits introduce no lifetime deadline. `maxTurns` counts ordinary model requests, and `maxTokens` counts uncached input, cache writes, and output; cache reads are reported but not counted. On exhaustion, no new ordinary tool/model work runs; one tool-free wrap-up request may run, capped at 1,024 output tokens and a 30-second cancellation deadline. Its observed usage is additional to the ordinary allowance. Token usage is reported after responses, so an in-flight response can overshoot; this is not a hard billing cap. Cancellation of already-running providers/tools remains cooperative.

`budget_exhausted` survives restart. Renew it through `agent` with `resume`, a new prompt, and at least one explicit budget field no greater than its frozen ceiling; omitted fields inherit those ceilings. `agent_control send` does not renew exhausted work. Budgeted tasks temporarily disable automatic retry/compaction requests to stay within that envelope; unbudgeted tasks retain native behavior. Background requests acknowledge actual turn acceptance and surface rejected renewals rather than claiming they started.

### Experimental V2 typed results

`outputSchema`, nonempty `acceptance`, or `agent: "review"` selects a host-instructed structured report rather than ordinary prose. Schema normalization rejects remote references/executable validators and unsupported keywords before any sibling is accepted. A resume keeps the frozen schema; start a new child to change it.

Every acceptance string is required. The host assigns IDs `criterion-1`, `criterion-2`, etc. The child must report each status, and a `satisfied` claim needs nonempty observed path evidence. Missing/unsatisfied claims or invalid evidence make the outcome `failed`, even when the payload is schema-valid. Resume-added criteria apply only to that task and cannot remove the frozen launch criteria; their text is retained in the latest validation snapshot.

Citations must be canonical in-scope files successfully accessed with `read`, file-targeted `grep`, `edit`, or `write` during that task. An existing file, directory search/listing, child command prose, adapter result, sibling citation, or earlier-task access does not establish evidence. Observation begins after approval and file metadata is checked again before validation; concurrent changes can invalidate it. This remains an optimistic filesystem check, not content attestation or a sandbox.

Results carry `validation` with report mode, observed paths, required claim states, payload/findings where accepted, reason, and assurance. `validation.verified` means the report/evidence/claim gate passed—not semantic correctness. String criteria explicitly retain `semanticVerified: false`; current assurance is at most `evidence_checked`, never `criteria_verified`, `verification_executed`, or `review_verified`. Plain output is `unverified_plain`. Review findings are optional (`findings` omitted equals `[]`) and remain untrusted claims, not independent approval to integrate.

For foreground multi-task calls, the ordered reports are preceded by a bounded batch summary. It compares acceptance claims only when normalized criterion text matches across children (not positional `criterion-N` IDs), and disagreements are surfaced rather than averaged. The summary uses checked paths/findings from host-validated snapshots and does not establish semantic correctness.

The latest redacted projection and validation survive parking, restart, and unchanged-worktree cleanup. Interrupted recovery cannot return an older snapshot as the current turn's result. Only the actual final response is used; empty or truncated final responses cannot promote intermediate JSON. Reports larger than the existing 24 KiB parser ceiling fail this experimental structured gate while the original native transcript remains available; the separate inline projection remains 48 KiB. Larger final answers are captured in the existing owner-scoped artifact store (4 MiB per artifact, 16 MiB per owner, 128 MiB global ceilings) and can be read with `agent_control action=output id=<child-id> offset=<byte-offset> [length=<bytes>]`. Reads are redacted, integrity-checked UTF-8 chunks of at most 48 KiB; continue at the returned `nextOffset`. The durable artifact reference survives restart and is released when a newer result replaces it or the child is deleted. Capture failures preserve the inline projection and are reported separately from execution. Tool text is capped at 64 KiB; background aggregate synthesis and higher-assurance parity remain unfinished.

## Choose a tool

| Tool | Use |
|---|---|
| `list_subagent_profiles` | Discover file agents, self-delegation, sources, effective capabilities, and diagnostics |
| `delegate` | One file-agent or self-delegated (role self) investigation; defaults to a managed background handle |
| `delegate_async` | Owner-scoped durable background investigation |
| `delegate_batch` | Up to eight independently scoped sibling tasks |
| `review_batch` | Independent correctness/security/tests/regression reviewers |
| `manage_subagent` | Inspect, peek, wait, follow up, stop, resume, or delete an eligible retained child or writer run |
| `inspect_subagent_job`, `cancel_subagent_job` | Inspect/cancel owned background jobs |
| `read_subagent_output` | Read a bounded UTF-8 chunk from an owner-bound final-answer artifact |
| `delegate_write` | Separate build-only isolated writer workflow |

Delegation is for fan-out: use these tools only when the work splits into two or more children. Do a simple single task directly in the parent loop instead of delegating it, and never wrap a lone task in a one-item batch.

Successful `delegate`, `delegate_async`, `delegate_batch`, `review_batch`, and `delegate_write` calls return owner-scoped managed handles after their accepted preflight/admission boundary; they do not offer a synchronous launch opt-out. Continue with `manage_subagent` for a foreground child or writer, `inspect_subagent_batch`/`cancel_subagent_batch` for batch/review aggregates, and `inspect_subagent_job`/`cancel_subagent_job` for durable jobs. `delegate_write` returns only after clean-parent/base-commit checks and isolated-worktree setup succeed. Managed runs use advisory owner-session check-ins no more frequently than every 120 seconds and have no child lifetime deadline. Check-ins are coalesced through the existing parent AgentSession, re-armed after consumption and settlement, and do not interrupt the parent or stop children. An overdue notice, stale progress, failed parent review, or unavailable owner never fails/stops the child. Durable jobs are not restart-resumable live sessions: restart preserves inspectable terminal/interrupted state and never relaunches ambiguous work. Foreground follow-up reuses the native child, requires an owner-bound run ID and stable request ID, and rejects user-takeover conflicts. An eligible completed foreground child is retained as a live reusable session (bounded to 8 per runner, oldest terminal child evicted and released) so `resume` can continue it in place and `delete` can release it; resume mints a new run ID with `resumedFromRunId` provenance, revalidates profile/resources/trust/tool authority fail-closed, and cannot widen the original model, profile, scope, or tools.

## Brief a child like a zero-context collaborator

A child sees none of the parent conversation. Terse task strings produce shallow work, so state the objective and why it matters, the relevant paths and line hints, facts already verified, approaches already ruled out, the exact deliverable, how to verify it (command, test, or check the child can run with its approved tools), and what not to touch. Keep sibling scopes independent and perform synthesis in the parent.

The runtime reinforces this with a host-owned task contract. Optional `kind` (`explore`, `research`, `review`, `implement`, `verify`), `deliverable`, `constraints`, `nonGoals`, and declarative `verification` hints (commands are declarations only; runtime authority still comes from the child's approved tools) are accepted by `delegate`, `delegate_async`, and batch tasks. Normalization derives a bounded, redacted, hash-stamped contract and a quality mode shown in the result:

- `explore` — plain results allowed and explicitly labeled evidence-limited; the default for legacy calls without a kind.
- `standard` — evidence-backed completion expected.
- `strict` — acceptance criteria, an output schema, review verification, or `verification.mode: "review"` forces the structured report gate.

Results also carry an assurance level derived only from runtime-observed state: `unverified_plain` (bounds-checked only), `evidence_checked`, `criteria_verified`, `verification_executed` (a declared verification command was actually executed successfully by the child), or `review_verified`. Model prose alone can never raise the level.

## Self-delegation: no file required

Ask the parent to delegate an investigation, or use these `delegate` tool arguments:

```json
{
  "role": "self",
  "task": "Inspect the implementation and return verified file evidence.",
  "scope": { "roots": ["src"] },
  "checkInIntervalMs": 120000,
  "contextMode": "fresh"
}
```

Use roots that exist in your repository. The facade snapshots the parent's actual effective system prompt and eligible active tools. `self.instructions` is an optional addition of up to 16 KiB, not a replacement for the parent snapshot. The combined snapshot is bounded to 128 KiB. Delegation, session management, shutdown, and writer-integration tools cannot be inherited. A low-level embedded host without a parent session must explicitly supply the instruction snapshot.

Useful role-diverse fan-out patterns that fit the bounded scheduler: a scout for fast repository discovery feeding a stronger synthesis you perform in the parent; two independent reviewers on different dimensions; researcher siblings partitioned by subsystem; an implementer writer plus a separate tester; mechanical scouts fanning out to one judgment-heavy reviewer. Siblings never delegate recursively, and you reconcile their disagreement rather than averaging it away.

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

Use lowercase kebab-case names. Unknown profile metadata is rejected. Supported operational fields include tools, `adapters` (explicit parent-owned adapter IDs, for example `adapters: [example/workspace-info]`), tags, thinking/thinkingLevel, `checkInIntervalMs` (default/minimum 120000 for managed/durable execution), `startupTimeoutMs` for bounded child startup/admission only, temperature, top-p, `color` (a bounded semantic theme token), `hidden`, skills, prompts, context, optional `hooks` IDs, exact `model`/`fallbackModel` references, and explicit `mcp` server/tool selectors (for example `mcp: [search/docs]`). Import provenance fields are retained. Final-answer retention uses fixed host limits rather than a profile field. Models follow the deterministic order: explicit call model, else file primary, else file fallback, else the captured parent (duplicates collapse; omitted fields reach the parent). Each configured candidate is resolved through Ice's catalog with existing-auth, text input, usable context/output metadata, explicit reasoning requirements, and route-policy checks; availability failures advance with a bounded skip reason while policy denials reject the launch. Selected MCP tools are opt-in and dispatch only through the parent-owned adapter with hooks, timeout, cancellation, and bounded output; without parent authorization the launch fails closed. Global-first precedence applies throughout ice: an explicit call value beats an explicit global value, which beats a trusted-project value, then the profile/bundled default. Denies, mode restrictions, and trust requirements still win over any preference. `hidden` affects discovery only: hidden profiles are omitted from listing/search/suggestions but remain directly resolvable subject to normal trust and policy.

Global (user) > trusted project is the file-agent source precedence; bundled roles and aliases were removed. Profile tools are requests: effective tools are narrowed by the parent, execution mode, deny lists, and caller subset. Role expertise does not grant write/Bash/network authority. Source hashes are checked again before use. `review_batch` uses self-delegation with a bounded reviewer snapshot; explicitly named file agents remain available through delegate/delegate_batch.

## Bound a delegation

Example tool arguments:

```json
{
  "role": "api-review",
  "task": "Review request validation; report concrete defects with evidence.",
  "scope": { "roots": ["packages/coding-agent/src"], "targets": ["packages/coding-agent/src/ice-subagents.ts"] },
  "checkInIntervalMs": 120000,
  "execution": { "thinking": "low", "tools": ["read", "grep"] },
  "contextMode": "fresh"
}
```

Roots are existing directories and are the authority boundary; targets are existing files used as focus. Selected resources add path access only through already-authorized tools. An explicit `execution.tools: []` creates a tool-free child, including no MCP tools; it never restores the full tool set. Final report repair stays within the same output, authority, and cancellation contract; managed background execution has no lifetime deadline.

Use a bounded `contextPacket` for handoff facts. `fresh` is the default; `fork` is opt-in sanitized history, not a cloned live session. An optional restricted local `outputSchema` validates the nested `payload`; remote references and executable validators are forbidden. Schema validity never overrides evidence or mandatory acceptance failures.

## Skills and resources

File agents select `skills`, `prompts`, and `context` by bounded resource names. Invocation `resources` selections add explicitly chosen resources. Global same-name resources win over trusted project resources. Scope checks, regular-file checks, hashes, and resource size limits are rechecked before loading.

Self children do not implicitly load the parent's skill library. Set `self.inheritSkills: true` to inherit the parent's currently loaded skill files, or use `resources.skills` for a selected subset. Inherited selections are bounded to 16 skill files, 64 KiB per inherited file, and 256 KiB aggregate resources. Explicit same-name selections take precedence over inherited entries. Skill instructions never grant Bash, mutation, MCP, or controller tools.

Child sessions never resolve/install ambient packages or load ambient extensions, including under `--sub-yolo`. Their system prompt, skills, prompt templates, and context are explicit inputs. Parent extension configuration remains owned by the parent.

## Delegable extension tools

A trusted parent extension registers its ordinary tool with Ice and separately registers a child-safe adapter using the public `registerIceDelegableTool(ice.events, definition)` API. The descriptor includes an explicit stable `adapterId`, a model-visible tool name, origin, actual parameter schema, host-owned access classification, and a child-scoped dispatch function. Registration alone does not activate the parent tool. A profile may request the adapter identity with `adapters: [example/workspace-info]`; this selects the parent-owned registration independently of its ordinary built-in `tools` list. Adapter IDs are not inferred from `origin`, and profile text cannot create or authorize an adapter.

The adapter receives only immutable child identity, cwd, approved scope roots, and cancellation signal—not the parent session controller. It must enforce its own resource access; this interface is not a process sandbox. Runtime checks reject unknown classifications, management tools, built-in replacements, schema references, oversized inputs, revoked/replaced registrations, and tools no longer active in the parent. Mutations require explicit host authority. Hooks run before dispatch; outputs are redacted and bounded. Cancellation stops waiting promptly, while the adapter remains responsible for external cleanup.

A runnable, network-free example is `examples/extensions/ice-delegable-workspace-info.ts`:

```bash
ice --extension packages/coding-agent/examples/extensions/ice-delegable-workspace-info.ts
```

Once its `workspace_info` parent tool is active, self delegation can inherit it; a file agent can request it directly in `tools` or select its parent adapter with `adapters: [example/workspace-info]`. Names omitted by a specialist or per-call tool subset remain unavailable. Adapter selectors are default-disabled: without a matching active parent registration, they remain unavailable and the launch fails closed.

## Selected MCP tools

Use `mcp: [docs/search]` in file frontmatter, or `self.mcp: ["docs/search"]` for self delegation. These are exact host-authorized `server/tool` selectors, not server discovery requests.

The already-connected parent MCP extension must register `registerIceSubagentMcpAdapter(ice.events, adapter)`. Its authorization snapshot must contain actual installed tool schemas and explicit `read-only`, `mutation`, or `unknown` classifications from host policy. Unknown, missing-schema, unauthorized, or mode-disallowed operations fail before child creation. `examples/ice-mcp-adapter.ts` provides the typed integration helper for an existing backend.

ICE creates collision-resistant model-visible names, validates arguments, checks permissions and required hooks, shares parent policy and cancellation, preserves MCP error results, and limits redacted output. Queued/running work detects changed schemas, classifications, adapter identity, and deny policy. No new connection, authentication, or credentials are granted by a selector. An adapter must restrict its existing external resources and honor cancellation; cancellation cannot undo a call already performed.

**Compatibility boundary:** this release supports the explicit parent-owned adapter contract. Independently installed MCP extensions that do not register that contract are not silently adapted. There is no claim of live certification for every external MCP server or provider. Missing adapters fail closed instead of loading a new child extension.

## Settings

Use existing global `<agentDir>/settings.json` (normally `~/.ice/agent/settings.json`) and trusted project `.ice/settings.json` files. Preserve unrelated keys. `ice` opts into global-first ordinary settings across startup, session switches, reload, and scoped saves; stock `ice` remains project-first. Explicit false/zero/empty values win, nested leaves merge, and an explicitly supplied global resource/package array replaces the matching project configuration array. Explicit invocation preferences still specialize allowed values within caps. `/settings` exposes common controls and an effective-policy view; RPC reports preference source and whether a project override actually wins.

```json
{
  "ice": {
    "subagents": {
      "enabled": true,
      "defaults": { "checkInIntervalMs": 120000, "startupTimeoutMs": 120000 },
      "restrictions": { "denyTools": ["bash", "edit", "write"], "maxStartupTimeoutMs": 300000 },
      "modelSelection": { "mode": "inherit-parent" }
    }
  }
}
```

Deny wins. Empty allowed-role lists are neutral. Invalid policy blocks admission. Settings changes affect future launches and revoke active/queued authority at safe boundaries rather than silently granting more capability. `startupTimeoutMs` and `maxStartupTimeoutMs` bound child session startup only; they do not limit a running child's lifetime. Final-answer length does not limit execution; host-owned storage and presentation ceilings are described below. Per-child turn and tool-call ceilings are not exposed or enforced. Profile `temperature` is passed through typed stream options when supported; `top-p` is mapped to `top_p` only for OpenAI-compatible adapters. Anthropic temperature and non-OpenAI top-p requests are omitted with a bounded provider-compatibility diagnostic. Sampling preferences apply to work and the bounded final report.

### Final output and artifact retrieval

Final-answer length does not abort a child or block admission. Each terminal answer is credential-redacted and receives a 48 KiB UTF-8-safe inline projection. Larger answers may have an opaque owner-bound artifact reference; `read_subagent_output` retrieves explicit byte ranges using a default 16 KiB chunk and a 64 KiB maximum. Reads verify ownership, file identity, size, hash, and UTF-8 boundaries. Artifacts contain final assistant answers only, never transcripts or tool output. The 4 MiB per-artifact, 16 MiB per-owner, and 128 MiB global ceilings are fixed host storage safeguards; capture failure is reported separately from execution. Batch/review tool text has a separate fixed 64 KiB presentation ceiling, and every batch row keeps its own output projection and artifact id so a single child's full answer stays addressable. Artifact presence does not imply verification; structured parsing and evidence verification remain independent.

Process-local child, batch, review, and writer outputs live only while their retained result owner remains. Durable terminal job output references are restored under the job owner's identity and released when full results expire; in-flight jobs become interrupted on restart and are never replayed. Writer text artifacts are separate from writer patch proposals.

### Usage telemetry and execution limits

Subagent token counts are observational only. `SubagentResult.usage` and related telemetry retain provider-reported input, output, cache-read, cache-write, and cost values when available; they do not authorize or enforce aggregate token ceilings. Provider/runtime failures remain terminal errors, while explicit cancellation and genuine provider/tool/hook/startup deadlines retain their independent semantics.

Managed `delegate`, `delegate_batch`, `review_batch`, `delegate_write`, and durable `delegate_async` runs have no wall-clock lifetime timeout. Periodic check-ins are advisory. Explicit stop/cancellation/shutdown, startup controls, provider/tool/hook deadlines, queue/concurrency limits, and bounded host-owned result retention remain separate safeguards. ICE does not expose or enforce per-child model-turn or tool-call ceilings. Batch and review scheduling uses task/concurrency limits, not output-byte reservations. Removed legacy `maxTotalTokens`, `totalTokenBudget`, `maxTurns`, and `maxToolCalls` fields are rejected rather than silently ignored. Historical durable snapshots are normalized by stripping removed fields before validation and rewriting; an in-flight model session is never resumed after restart.

## Optional child routes

To enable exact per-call routing, explicitly set **global** `ice.subagents.modelSelection.mode` to `configured`. Then request:

```json
{ "execution": { "model": "provider/exact-model-id", "thinking": "low" } }
```

Choose an existing configured route from Ice's catalog; do not paste a key or construct an endpoint. Omitting call and file model fields preserves the exact parent object. The adapter does not discover models, authenticate, or expand credentials. Candidates run in call/primary/fallback/parent order: missing credentials, unavailable routes, or incomplete capability metadata advance to the next candidate with a bounded skip reason, while route-policy denials reject the launch. Unsupported requested thinking fails before the child is launched. Admission fallback never replays an edit or external action with uncertain outcome. Foreground/batch recovery has at most two attempts and requires explicit native evidence of a retryable startup failure before a child session or tool effect exists. Runtime stream failures are terminal, even when no final report was produced. Recovery is bounded to startup-only safe retries; final-answer byte length is not an execution budget. Durable jobs retain the selected provider/model identity, ordered candidates and skips, route fingerprint, effective tool names, adapter fingerprints, and resource identity hash; stale or unavailable captured routes fail explicitly at promotion instead of silently rerouting, and restart never auto-relaunches ambiguous work. Writer routing remains separate and inherits the parent.

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
- **Check-in overdue:** inspect the same owner-bound run and decide whether to follow up, wait, stop, or continue; overdue/stale status is advisory and does not time out the child.
- **Verified=false:** preserve failures and evidence. A valid payload or hook approval is not proof of completion.

The implementation plan and reproducible verification packet are in `agent_docs/implementation/subagent-self-delegation-model-fallback-plan.md` and `.artifacts/ice-self-user-ready-20260910/`. The static operator explainer is `html-communication/subagent-user-ready.html`.
