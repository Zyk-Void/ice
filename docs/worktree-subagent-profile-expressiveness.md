# ICE profile expressiveness

> **Historical implementation snapshot.** This note describes the V1 profile contract and files that V2 replaced. It is not current subagent configuration documentation; see the [V2 guide](../packages/coding-agent/docs/subagents-v2.md) and [definition reference](../packages/coding-agent/docs/subagents-v2-reference.md). Source/status claims below are retained as historical evidence.

This document describes the profile, resource, tool, settings, model, sampling, and
parent-adapter behavior visible in this worktree. It is an implementation description,
not a proposal. The primary implementation is `packages/coding-agent/src/ice-subagents.ts`;
settings and hook composition are in `packages/coding-agent/src/ice-subagent-settings.ts`.
The operator-facing guide is
`packages/coding-agent/docs/subagent-user-guide.md`.

## Status and evidence boundary

- The source, tests, and guide named here were observed in the worktree.
- This documentation file is the only file written by this documentation operation. No
  source, test, changelog, or other documentation file was changed by this operation.
- The approved file tools did not expose Git metadata, so the branch name, HEAD SHA, and
  pre-existing index/worktree status could not be independently inspected. Consequently,
  this document does **not** claim that the observed implementation is committed. The
  implementation files above are described as the worktree baseline; this newly written
  file is uncommitted until a parent explicitly stages or commits it.
- Verification below is **visible test evidence** (assertions present in checked-in or
  worktree test files), not a claim that a test command was run in this operation. No
  command exit status was observed.

## Purpose and current shape

ICE keeps one authoritative reasoning/tool loop. A subagent profile supplies bounded
specialization (identity, instructions, requested tools, resources, and execution
preferences); it is not itself a permission grant. A launch is admitted only after the
parent's active tools, ICE settings, execution mode, project trust, resource integrity,
model policy, and any required hooks have been applied.

There are two profile kinds:

- **File agent**: a Markdown file in a user or trusted project agents directory.
- **Self-delegation**: the role `self`; it derives a bounded child profile from the
  parent's instruction snapshot and explicitly eligible child capabilities, with no
  profile file required.

The hardcoded bundled specialist catalog and aliases are empty in the observed source.
`SUBAGENT_PROFILES` and `SUBAGENT_PROFILE_ALIASES` are empty, and
`isBundledSubagentProfileName()` returns false. Use a file agent or `self` rather than
assuming old names such as `explore` or `review` still resolve.

Normal children use a fresh context by default. `fork` is an opt-in, sanitized and
bounded handoff of parent history. A child result remains subject to the parent-owned
bounded report and verification contract; a model claim is not proof of completion.

## File-agent configuration

### Locations and precedence

The default user agent directory is `~/.ice/agents`. With an explicit `agentDir` or
`ICE_CODING_AGENT_DIR`, the agent directory is `<agentDir>/agents`. Project agents are
found in the nearest `.ice/agents` under the working directory. Project definitions are
loaded only after project trust is established.

Precedence is global/user first, then trusted project. A complete global definition
wins a same-name project definition; bodies and tool lists are never merged. The
shadowed project path is surfaced in diagnostics. An untrusted project-only role fails
closed rather than becoming executable. Legacy files under the former global agent path
are inventoried by `getSubagentAgentMigrationManifest()` but are not silently loaded,
moved, overwritten, or deleted.

### Markdown shape

A profile needs lowercase kebab-case `name`, a nonempty `description`, and a nonempty
Markdown body. The body becomes the child system/instruction text after credential
redaction. Names are bounded to 64 characters and the body to 32 KiB.

```markdown
---
name: api-review
description: Review API compatibility and validation changes.
tools: [read, grep, find, ls]
tags: [api, review]
thinking: low
timeoutMs: 120000
max-output-bytes: 32768
temperature: 0.2
top-p: 0.8
color: accent
hidden: false
skills: [api-guidance]
prompts: [review-template]
context: [docs/api.md]
model: provider/primary-model
fallbackModel: provider/fallback-model
hooks: [api-review-gate]
---
Inspect the requested API surface. Return concrete findings with in-scope evidence
paths, and distinguish verified behavior from unrun checks.
```

Supported profile metadata observed in the loader is:

- `tools`: requested built-in or registered child-safe tool names. If omitted, the
  profile requests the built-in set `read`, `grep`, `find`, `ls`, `bash`, `edit`, and
  `write`.
- `tags`: up to eight lowercase kebab-case display/search tags, each at most 32 bytes.
  Tags are discoverability metadata, never authority.
- `thinking` or `thinkingLevel`: one of `off`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, `max`, or `ultra`. Invalid thinking metadata falls back to `low` with a
  diagnostic.
- `timeout` or `timeoutMs`: bounded and normalized to 1 second through 10 minutes;
  the default is 60 seconds. Invalid values fall back with a diagnostic, and out of
  range values are clamped.
- `max-output-bytes`, `maxOutputBytes`, or `max_output_bytes`: bounded to 1 KiB through
  64 KiB; the default is 24 KiB. Invalid values fall back and out of range values are
  clamped.
- `temperature`: finite number in `[0, 2]`; `top-p`, `topP`, or `top_p`: finite number
  in `[0, 1]`. Malformed or out-of-range values are rejected rather than silently
  ignored.
- `color`: a bounded semantic profile theme token. It affects presentation only.
- `hidden`: boolean. Hidden profiles are omitted from listing/search but remain directly
  resolvable by name subject to normal trust and policy.
- `skills`, `prompts`, and `context`: resource selections described below.
- `model`: an exact `provider/model` reference, and `fallbackModel` (or
  `fallback_model`): a distinct exact fallback reference. These are preferences subject
  to global routing policy, not credentials or arbitrary endpoints.
- `mcp`, `mcpTools`, or `mcp_tools`: up to 16 exact `server/tool` selectors, requiring a
  parent-owned MCP adapter at launch.
- `hooks`: bounded IDs selecting optional parent-owned hooks. Required hooks cannot be
  disabled by this selection.
- `ice-unsafe-host-exec` or `iceUnsafeHostExec`: an eligibility marker for an explicitly
  authorized unsafe host-execution path. It does not grant Bash, mutation, trust, or
  external access by itself.
- `ice-agent-pack`, `ice-agent-pack-source`, and `ice-agent-pack-sha256`: supported
  import/provenance metadata. Import provenance does not constitute permission approval.

Unknown frontmatter keys are rejected. In particular, arbitrary restriction maps,
provider-specific sampling objects, setup commands, endpoints, credentials, and
management/delegation tools are not profile fields.

## Self-delegation

`role: "self"` creates a parent-derived profile. The parent instruction snapshot is
authoritative; `self.instructions` is an additive task-specific addition and cannot
replace parent policy. The addition is at most 16 KiB and the combined snapshot at most
128 KiB. Self capabilities are bounded, must be recognized child tools or registered
child-safe adapters, and cannot include delegation, management, shutdown, or writer
control tools.

Parent skills are not inherited implicitly. Set `self.inheritSkills: true` to inherit
the parent's currently loaded, hash-checked skills, or select resources explicitly.
Self-delegation also supports explicit `self.mcp` selectors. It otherwise uses the
same scope, settings, tool narrowing, hooks, model, cancellation, and verification
boundaries as a file agent.

```json
{
  "role": "self",
  "task": "Trace request validation and report evidence.",
  "scope": { "roots": ["packages/coding-agent/src"] },
  "self": {
    "instructions": "Focus on validation boundaries; do not infer unobserved behavior.",
    "capabilities": ["read", "grep", "find", "ls"],
    "inheritSkills": false
  },
  "contextMode": "fresh"
}
```

## Resources

`skills`, `prompts`, and `context` are explicit resource selections, not free-form
instruction channels. Profile selections and invocation `resources` are combined.

- User resources win over trusted project resources with the same name.
- Skills resolve from the user skills directory or nearest trusted `.ice/skills`;
  prompts resolve similarly from `prompts`; context resources resolve from the current
  workspace context root.
- A selection may name an approved resource or an approved path under the relevant root.
  Canonical-path containment rejects escapes and symlink escapes.
- Each selected resource is a regular file of at most 64 KiB; each kind allows at most
  16 selections and all selected resources together are limited to 256 KiB.
- Source path, canonical path, and SHA-256 are recorded. `revalidateSubagentResources()`
  checks size, path, existence, and hash again before use. Changed or missing resources
  fail closed.
- Project resources require project trust. Ambient extensions, package resolution,
  installation, and unrelated project resource classes are not implicitly loaded by a
  child, including on the unsafe host path.

## Tool expressiveness and effective authority

A profile declares `requestedTools`; the normalized compatibility `tools` field is not
a second permission system. Effective tools are an intersection, not a union:

```text
profile request
  ∩ caller execution.tools (when supplied)
  ∩ parent active tools
  ∩ execution-mode/host eligibility
  − global and trusted-project denyTools
  ∩ current registered adapter authority
```

In safe/read-only launches, the built-in eligible set is exactly `read`, `grep`, `find`,
and `ls`. A profile requesting `bash`, `edit`, or `write` is reported as
`requires_yolo` unless the explicitly authorized unsafe path is active. In a partial
parent/tool projection it may instead be `limited`. `execution.tools: []` is meaningful:
it creates a tool-free child and never falls back to read tools.

Unsafe built-in capability eligibility requires all of the relevant host gates: explicit
startup unsafe authorization, `build` mode, a trusted project, startup-authorized parent
Bash, and an interactive TUI or explicitly authorized RPC session. The requested
profile tools must still be active in the parent. Review children remain read-only.
Unsafe host execution is not a sandbox and does not manufacture tools absent from the
parent.

### Parent-owned extension tools

A trusted extension may register a child-safe adapter with
`registerIceDelegableTool(owner, definition)` from
`packages/coding-agent/src/ice-subagent-capabilities.ts`. The definition supplies a
stable name, origin, `read-only`/`mutation`/`unknown` classification, a bounded object
schema, description, and a dispatch function. Registration alone does not activate the
tool: the name must be active in the parent, requested by the profile/call, and remain
current. Management tools and replacements for built-in tools are rejected.

The adapter receives only immutable child identity, cwd, scope roots, and cancellation
signal. Its implementation must enforce its own external access and cancellation; this
interface is an authority adapter, not a process sandbox. Inputs and JSON schemas are
bounded and validated, outputs are redacted/bounded, and revocation or replacement
fails a captured child rather than silently switching implementation.

```typescript
registerIceDelegableTool(ice.events, {
  name: "workspace_info",
  origin: "example/workspace-info",
  access: "read-only",
  childSafe: true,
  description: "Return bounded workspace metadata.",
  parameters: Type.Object({}, { additionalProperties: false }),
  execute: async (_params, context) => ({ cwd: context.cwd }),
});
```

The runnable network-free example is
`packages/coding-agent/examples/extensions/ice-delegable-workspace-info.ts`.

### MCP selectors

MCP is explicit parent-adapter reuse, not child server discovery. A trusted parent
registers `registerIceSubagentMcpAdapter(owner, adapter)` with an authorization snapshot
containing the exact selector, installed parameter schema, and access classification.
The selected profile/call selector must:

1. use the exact `server/tool` form;
2. be present in the parent's snapshot;
3. include a bounded installed object schema;
4. have a trusted `read-only` or (only on the authorized mutation path) `mutation`
   classification; and
5. survive identity, schema, classification, and policy revalidation until dispatch.

ICE exposes a collision-resistant model-visible name through `subagentMcpToolName()` and
dispatches only through the parent adapter. Hooks, budgets, cancellation, argument
validation, output bounding, and deny lists still apply. No connection, authentication,
credential, or ambient MCP server is inherited. Missing adapters, schemas, unknown
classification, policy denial, or changed authorization fail closed.

## Settings and precedence

ICE settings live in the existing settings files: global
`<agentDir>/settings.json` (normally `~/.ice/agent/settings.json`) and trusted project
`.ice/settings.json`. The `ice` namespace is strict; unknown keys or malformed values
are rejected. Stock non-ICE settings behavior is not silently changed by this resolver.

```json
{
  "ice": {
    "subagents": {
      "enabled": true,
      "defaults": {
        "thinking": "low",
        "timeoutMs": 120000,
        "maxTurns": 12,
        "maxToolCalls": 40,
        "maxOutputBytes": 24576,
        "maxTotalTokens": 100000,
        "temperature": 0.2,
        "topP": 0.8
      },
      "allowedRoles": ["api-review", "self"],
      "roleDefaults": { "api-review": { "maxTurns": 8 } },
      "restrictions": {
        "maxTurns": 16,
        "maxToolCalls": 64,
        "maxTotalTokens": 200000,
        "denyRoles": ["untrusted-role"],
        "denyTools": ["bash", "write"]
      },
      "modelSelection": { "mode": "inherit-parent" }
    }
  }
}
```

Supported settings are `enabled`, preference `defaults`, `allowedRoles`, per-role
`roleDefaults`, deny-first `restrictions`, and `modelSelection.mode` (`inherit-parent`
or `configured`). Preference fields are `thinking`, `timeoutMs`, `maxTurns`,
`maxToolCalls`, `maxOutputBytes`, `maxTotalTokens`, `temperature`, and `topP`, all
with bounded ranges validated by `parseIceSubagentSettings()`.

The effective ICE contract is resolved by `resolveIceSubagentContract()`:

1. bundled/runtime defaults provide a base;
2. trusted project and global defaults/role defaults are composed with **global-first**
   semantics (an explicit global value wins a project value);
3. a per-call value wins over settings within the applicable caps; and
4. the most restrictive global/project cap is applied as an enforced ceiling.

The implementation retains the source of each effective value (`bundled`, `global`,
`project`, `global-role`, `project-role`, `call`, or `enforced`) and bounded diagnostics.
Empty allowlists mean no additional allow restriction. Nonempty allowlists intersect;
`denyRoles`, `denyTools`, disabled settings, mode restrictions, trust, and required
policy checks win over preferences. Project settings are ignored until trusted. An
invalid relevant settings file blocks delegation rather than causing permissive defaults.
Settings reloads affect future admission and revoke authority at safe boundaries; they
do not silently expand an already captured child.

## Per-call API and usage

The public facade registers the following model-facing tools in
`ice-subagents.ts`:

- `list_subagent_profiles({ query? })`: observational discovery. It reports requested
  versus effective tools, availability, settings sources, model candidates/skips, MCP
  availability, tags, and diagnostics. Hidden profiles are omitted. A query miss
  returns bounded suggestions and available names.
- `delegate(request)`: one foreground file-agent or self child. It accepts `role`,
  `task`, `scope`, optional `self`, context, `contextPacket`, `contextMode`, top-level
  `timeoutMs`, `execution`, `resources`, acceptance criteria, preflight requirements,
  and a restricted local `outputSchema`.
- `delegate_async(request)`: the same request contract with an owner-scoped durable job
  acceptance path; it returns acceptance metadata without awaiting the child.
- `delegate_batch({ tasks, concurrency?, totalBudgetBytes?, totalTokenBudget?, timeoutMs?, failFast? })`:
  up to eight independently scoped sibling tasks, using each task's profile/request
  contract and bounded aggregate budgets.
- `review_batch({ tasks, concurrency?, totalBudgetBytes?, totalTokenBudget?, timeoutMs?, failFast? })`:
  typed correctness/security/tests/regressions reviewers. Reviewers use bounded
  self-delegation and remain read-only, including under unsafe parent authority.
- `manage_subagent({ runId, action, additionalMs?, requestId?, message?, wait? })`:
  inspect, extend, follow up, or stop the same retained foreground child. Follow-up
  cannot widen its captured scope or tools; `requestId` is required for idempotency.
- `inspect_subagent_job({ jobId })` and `cancel_subagent_job({ jobId })`: inspect or
  cancel owned durable work.
- `delegate_write(...)`: separate writer workflow; profile expressiveness does not add
  writer authority. Normal writers use isolated workspaces and return patch artifacts.

A bounded request with execution preferences looks like this:

```json
{
  "role": "api-review",
  "task": "Review request validation and report concrete defects.",
  "scope": {
    "roots": ["packages/coding-agent/src"],
    "targets": ["packages/coding-agent/src/ice-subagents.ts"]
  },
  "execution": {
    "thinking": "low",
    "tools": ["read", "grep"],
    "maxTurns": 8,
    "maxToolCalls": 20,
    "maxOutputBytes": 16384,
    "temperature": 0.2,
    "topP": 0.8
  },
  "resources": { "skills": ["api-guidance"] },
  "contextMode": "fresh"
}
```

`scope.roots` must name existing directories (up to 16); `scope.targets` must name
existing regular files inside those roots (up to 16). Roots are the authority boundary;
targets narrow focus and do not expand it. Task text is bounded to 16 KiB. Context
packets, acceptance criteria, preflight checks, output schemas, and final result
serialization are independently bounded and validated.

## Sampling and model behavior

Sampling is typed per profile/settings/call and then mapped to provider-compatible
stream options. The visible compatibility test verifies `temperature` and OpenAI
`samplingParams.top_p` for an OpenAI-completions model. For an Anthropic model marked
without temperature support, the options are omitted and a bounded
`provider_option_unsupported` diagnostic is recorded. `top-p` is not sent to
non-OpenAI-compatible adapters. Sampling applies to the work request and bounded final
report where the route supports it.

The default model is the exact parent `Model` object. Explicit routing is opt-in through
global `ice.subagents.modelSelection.mode: "configured"` and an exact call `execution.model`
or profile `model`/`fallbackModel`. Candidate order is:

```text
explicit call model → profile primary model → profile fallback model → captured parent
```

Duplicates collapse. Catalog absence, missing configured authentication, incomplete
capability metadata, or an unsupported requested thinking level can skip a candidate with
a bounded reason. Route-policy denial rejects rather than rerouting around policy. ICE
never discovers models, constructs endpoints, or expands credentials. A durable/captured
route stores provider/model identity plus a capability hash, not credentials; changed
capabilities fail promotion instead of silently rerouting. A different candidate may be
used only for a proven retry-safe startup failure before a child identity or external
effect exists. Runtime failures and uncertain tool effects are not replayed.

`maxTotalTokens` is an optional soft cumulative budget charged as input + output + cache
write tokens (cache reads remain visible but are excluded). It is independent from turns,
tool calls, timeout, output bytes, and context limits; it is not a dollar-cost guarantee.
Built-in provider paths can apply a hard per-request output authority where supported;
unknown/custom APIs remain aggregate-soft. Batch token budgets reserve each task's
resolved ceiling and release unused reservations on settlement.

## Hooks and policy adapters

Profile `hooks` and call `execution.hooks` select optional IDs. The parent always resolves
required hooks first; optional selections are unioned, and an explicit empty selection
excludes optional hooks but cannot remove required ones. Decision events are
`subagent.beforeLaunch`, `subagent.beforeTool`, and `subagent.beforeAccept`; observational
events include started, afterTool, checkpoint, attention, completed, failed, timedOut,
and cancelled. In-process handlers register with `registerIceSubagentHook(owner, id,
handler)` or are supplied to the facade. Only `beforeLaunch` may add bounded context;
hooks cannot add tools, scope, resources, or budgets. Missing/changed handlers, required
outcomes, cancellation, and approval requests fail closed.

Command hooks are a separate host-authorized feature and are not granted by a profile.
They require global host-reviewed policy, trusted project/build/Bash gates, explicit
approval semantics, persistent session state, and executable/script hashes. They remain
host-account execution and are not a sandbox.

## Visible verification evidence

The following assertions were observed in the worktree:

- `packages/coding-agent/test/ice-subagent-profile-controls.test.ts` checks unknown
  security metadata rejection, bounded `temperature`/`top-p`, hidden-profile direct
  resolution versus discovery omission, requested/effective sampling listing, provider
  compatibility mapping, and profile/call hook selection.
- `packages/coding-agent/test/ice-subagent-settings.test.ts` checks strict settings
  parsing, bounded defaults and role overrides, global/project/call precedence, deny-first
  caps and role/tool denials, empty allowlist semantics, invalid-settings fail-closed
  behavior, reload behavior, restricted output schemas, and tool narrowing.
- `packages/coding-agent/test/ice-subagent-routing.test.ts` checks parent identity by
  default, configured exact routes, missing authentication, non-secret route snapshots,
  capability-change rejection, primary/fallback/parent ordering, and policy denial.
- `packages/coding-agent/test/ice-subagent-capabilities.test.ts` checks owner-isolated
  registration, schema and management-tool rejection, mutation narrowing, revocation,
  immutable child dispatch context, cancellation, bounded/redacted output, MCP-name
  collision resistance, self instruction inheritance, explicit skill inheritance, and
  tool-free children.
- `packages/coding-agent/test/ice-subagent-readiness.test.ts` checks real facade behavior
  for parent instruction snapshots, MCP dispatch/schema/policy gates, external adapter
  dispatch and revocation, model fallback and startup-only recovery, durable route and
  resource fingerprints, queued catalog-change rejection, and self discovery.
- `packages/coding-agent/test/ice-subagent-result-contract.test.ts` checks the bounded
  report protocol, custom payload validation, parent-envelope caps, preserved observed
  work artifacts on malformed reports, one-shot repair, and the rule that malformed or
  unverified reports cannot fabricate evidence.
- `packages/coding-agent/docs/subagent-user-guide.md` provides the corresponding
  operator examples for file agents, self-delegation, settings, resources, adapters,
  routing, hooks, and rollback/troubleshooting boundaries.

These are source-level observations only. They should be confirmed by the repository's
normal targeted test/check workflow before release or a completion claim.

## Limitations and follow-ups

1. **No Git state claim is possible here.** The approved read adapter denied Git metadata,
   so a parent should inspect branch/HEAD and pre-existing dirty files before staging this
   document.
2. **Profiles are expressive but deliberately bounded.** There are no arbitrary provider
   options, variants, endpoint definitions, executable setup fields, unrestricted
   permissions, or recursive delegation fields. Additions should remain typed, bounded,
   parent-policy-controlled, and covered by negative tests.
3. **File profiles are not a sandbox.** Scope checks, adapter contracts, redaction, and
   policy narrowing reduce authority, but host execution still needs an independent
   filesystem/process/network/credential boundary. Unsafe host execution and command
   hooks are especially not isolation.
4. **MCP support is adapter-contract-only.** An independently installed MCP extension is
   not silently adapted. A host must provide actual schemas, classifications, dispatch,
   cancellation, and external cleanup. There is no claim of certification for every MCP
   server or provider.
5. **Provider compatibility is selective.** Sampling preferences may be omitted with a
   diagnostic on providers that do not support them. Custom APIs cannot be described as
   hard output-capped merely because an aggregate budget was requested.
6. **Model fallback is admission/retry constrained.** Missing routes can be skipped, but
   policy denials and post-effect/runtime failures are terminal. Captured durable routes
   fail on identity/capability drift rather than silently finding a replacement.
7. **Settings and resource changes are revocations, not grants.** A changed setting,
   profile, resource, adapter, hook, or model capability can invalidate queued/active
   authority. Operators must inspect unresolved outcomes rather than automatically
   replaying external effects.
8. **Legacy migration is manual.** The migration manifest is non-destructive; it does not
   move old agent files or resolve collisions automatically.
9. **Verification remains parent-owned.** A valid shape, hook approval, or profile match
   is not evidence that the requested task succeeded. Parents must inspect returned paths,
   actual checks, required acceptance criteria, and unrun diagnostics.

## Relevant API index

### `packages/coding-agent/src/ice-subagents.ts`

- `resolveSubagentProfileResolution(role, options)`: resolve a trusted file profile.
- `resolveSelfSubagentProfile(options)`: construct the bounded parent-derived profile.
- `listSubagentProfiles(options, query?)` and `suggestSubagentProfiles(...)`: discovery
  and bounded suggestions.
- `resolveSubagentResources(selection, options)` and
  `revalidateSubagentResources(resources)`: resolve and integrity-check explicit files.
- `deriveEffectiveSubagentTools(options)`, `deriveSubagentTools(...)`, and
  `normalizeSubagentRequest(request, cwd, options)`: derive and freeze launch authority.
- `normalizeSubagentExecutionOverride(profile, execution)`: validate per-call preferences.
- `createNativeSubagentSession(...)` and `NativeSubagentRunner`: create/run the native
  child loop using the normalized contract.
- `registerIceSubagentMcpAdapter(owner, adapter)` and `subagentMcpToolName(selector)`:
  register and expose selected parent-owned MCP capabilities.

### `packages/coding-agent/src/ice-subagent-settings.ts`

- `parseIceSubagentSettings(input)` and `parseIceSettings(input)`: strict settings
  parsing with bounded ranges.
- `resolveIceSubagentContract(input)`: precedence, caps, allowlists, denials, values,
  sources, and diagnostics.
- `narrowIceSubagentTools(options)`: pure profile/parent/mode/deny intersection.
- `resolveIceSubagentHooks(input)` and `parseIceHooksSettings(input)`: required/optional
  hook composition.
- `registerIceSubagentHook(owner, id, handler)`: trusted parent handler registration.

### `packages/coding-agent/src/ice-subagent-capabilities.ts` and `ice-subagent-routing.ts`

- `registerIceDelegableTool`, `getIceDelegableTools`, and `resolveIceDelegableTools`:
  owner-bound extension adapter lifecycle and capability narrowing.
- `resolveIceSubagentRoute`, `resolveIceSubagentCandidates`, and
  `snapshotIceSubagentRoute`: opt-in catalog routing, bounded fallback, and non-secret
  route capture.
