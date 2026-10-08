# ICE vs OpenCode Subagents: Detailed Comparison and Audit Findings

> **Historical V1 comparison (2026-08-11).** This report compares the legacy subagent implementation and file paths from before the V2 rewrite. It is not a current comparison of ICE Subagents V2 against OpenCode. Treat ratings and capability statements as historical evidence only; see the [current V2 guide](../packages/coding-agent/docs/subagents-v2.md) and [architecture](../packages/coding-agent/docs/subagents-v2-architecture.md).

Date: 2026-08-11

## Scope

This document compares the implemented ICE subagent system with the OpenCode reference under `agent_references/opencode/`. It records the architecture comparison, capability differences, security audit findings, validation evidence, trade-offs, and overall ratings.

Compared ICE implementation:

- `packages/coding-agent/src/ice-subagents.ts`
- `packages/coding-agent/src/ice-subagent-jobs.ts`
- `packages/coding-agent/src/ice-subagent-observatory.ts`
- `packages/coding-agent/src/ice.ts`
- `idea.md`

Compared OpenCode implementation:

- `agent_references/opencode/packages/opencode/src/tool/task.ts`
- `agent_references/opencode/packages/opencode/src/agent/agent.ts`
- `agent_references/opencode/packages/opencode/src/agent/subagent-permissions.ts`
- `agent_references/opencode/packages/opencode/src/background/job.ts`
- `agent_references/opencode/packages/opencode/src/session/run-state.ts`
- `agent_references/opencode/packages/opencode/src/session/session.ts`
- `agent_references/opencode/packages/opencode/test/tool/task.test.ts`

## Executive conclusion

OpenCode is the stronger general-purpose subagent platform. It has richer configurable agents, per-agent model routing, composable permissions, persistent child sessions, resumable tasks, recursive depth controls, background promotion, and stronger first-class session UX.

ICE is stronger as a safety-oriented delegation layer. It defaults to read-only children, keeps Ice as the single authoritative loop, uses explicit scope and trust gates, validates structured results, bounds output/context/artifacts, isolates writers in worktrees, and requires parent-owned verification and integration.

The practical summary is:

- Choose OpenCode’s design when flexibility, session continuity, and agent specialization are the priority.
- Choose ICE’s design when containment, deterministic execution, provenance, verification, and safe mutation are the priority.
- ICE should borrow OpenCode’s agent registry, permission model, resumable child-session semantics, and lifecycle model without copying OpenCode’s broader default authority.

## Overall rating

| Area | OpenCode | ICE | Winner |
|---|---:|---:|---|
| Agent configurability | 9.5/10 | 7.5/10 | OpenCode |
| Model routing | 9.0/10 | 7.0/10 | OpenCode |
| Permission flexibility | 9.5/10 | 8.0/10 | OpenCode |
| Default security | 7.5/10 | 9.0/10 | ICE |
| Filesystem isolation | 7.0/10 | 9.0/10 | ICE |
| Writer safety and integration | 6.5/10 | 9.5/10 | ICE |
| Session persistence and resume | 9.5/10 | 7.0/10 | OpenCode |
| Background lifecycle | 9.0/10 | 8.0/10 | OpenCode |
| Cancellation and recovery safety | 8.0/10 | 8.5/10 | ICE |
| Structured result verification | 6.5/10 | 9.5/10 | ICE |
| Observability and UX | 9.0/10 | 8.0/10 | OpenCode |
| Defensive-boundary testing | 8.0/10 | 9.0/10 | ICE |
| Architecture maintainability | 9.0/10 | 7.0/10 | OpenCode |
| **Overall capability** | **8.6/10** | **8.3/10** | **OpenCode** |
| **Overall safety and correctness** | **7.8/10** | **8.9/10** | **ICE** |

These scores are qualitative engineering ratings based on the inspected source and tests, not benchmark measurements.

## Detailed comparison

### 1. Agent configuration and specialization — OpenCode wins

OpenCode models an agent as a first-class configuration object containing:

- Name and description
- `primary`, `subagent`, or `all` mode
- Permission rules
- Model and provider
- Variant
- System prompt
- Temperature and top-p
- Arbitrary options
- Maximum steps
- Hidden/internal status
- Enable/disable configuration

Evidence: `agent_references/opencode/packages/opencode/src/agent/agent.ts:35-55` and `:267-294`.

OpenCode supports built-in agents such as `build`, `plan`, `general`, and `explore`, plus user/project-defined agents. Agent descriptions are exposed to the model for discovery.

ICE currently provides:

- Bundled `explore` and `review` roles
- User/project profile files
- Profile descriptions and system prompts
- Read-only tool declarations
- Fixed thinking levels
- Fixed timeout and output limits
- Current-parent model inheritance

Evidence: `packages/coding-agent/src/ice-subagents.ts:213-300` and profile resolution around `:981-1080`.

**OpenCode advantage:** new specialized agents can be added through configuration without changing the runner.

**ICE trade-off:** its profiles are safer and more constrained, but less expressive. Per-agent temperature, variants, step limits, and model configuration are not currently part of the profile contract.

### 2. Permission semantics — OpenCode wins flexibility; ICE wins conservative enforcement

OpenCode has a composable permission engine with:

- `allow`
- `ask`
- `deny`
- Wildcard patterns
- Tool-level rules
- Path-level rules
- External-directory rules
- Agent-specific rules
- User configuration overrides
- Parent deny propagation

Evidence: `agent_references/opencode/packages/opencode/src/agent/agent.ts:119-138`, `agent_references/opencode/packages/opencode/src/agent/subagent-permissions.ts:14-26`, and `src/permission/index.ts`.

OpenCode asks for delegation permission at execution time:

```ts
ctx.ask({
  permission: "task",
  patterns: [params.subagent_type],
  ...
})
```

Evidence: `agent_references/opencode/packages/opencode/src/tool/task.ts:119-129`.

ICE mainly uses capability intersection:

```ts
deriveSubagentTools(parentActiveTools, profile)
```

Evidence: `packages/coding-agent/src/ice-subagents.ts:2360-2379`.

Default ICE child capabilities are:

- `read`
- `grep`
- `find`
- `ls`

Mutation and Bash require separate explicit workflows and authorization.

**OpenCode advantage:** more expressive allow/ask/deny behavior and better interactive permission UX.

**ICE advantage:** a child cannot normally become more capable than the parent. The parent/tool intersection is easier to audit and more fail-closed than inheriting a child agent’s independent permission set.

### 3. Child session persistence and resume — OpenCode wins

OpenCode creates a persistent child session with:

- Stable session ID
- Parent session ID
- Agent identity
- Model metadata
- Permission state
- Full child message history
- Persistent tool output
- Resumability

Evidence: `agent_references/opencode/packages/opencode/src/tool/task.ts:156-172`.

It supports continuation using `task_id`:

```ts
task_id: previousTaskId
```

Evidence: `agent_references/opencode/packages/opencode/src/tool/task.ts:47-53` and `:136-138`.

ICE foreground child sessions are intentionally:

- Fresh
- In-memory
- Bounded
- Disposed after completion
- Returned as structured results

Evidence: `packages/coding-agent/src/ice-subagents.ts:3250-3273` and `:4080-4086`.

ICE fork mode preserves only a sanitized bounded context snapshot. It limits messages and bytes and drops thinking, tool calls, tool results, images, and custom parts.

Evidence: `packages/coding-agent/src/ice-subagents.ts:335-372` and `:2387-2570`.

**OpenCode advantage:** excellent interactive follow-up and continuity.

**ICE advantage:** avoids unbounded history growth, accidental parent-context leakage, and a second authoritative session store.

### 4. Background execution and promotion — OpenCode wins lifecycle flexibility

OpenCode supports:

- Foreground execution by default
- Explicit background execution
- Foreground-to-background promotion
- Resuming an existing background task
- Automatic completion notification
- Parent cancellation
- Child cancellation
- Background result injection into the parent session

Evidence: `agent_references/opencode/packages/opencode/src/tool/task.ts:256-345` and `src/session/run-state.ts:92-147`.

OpenCode can extend an existing job instead of launching a duplicate:

```ts
background.extend({ id: nextSession.id, run: runTask() })
```

ICE provides:

- `delegate_async`
- FIFO queueing
- Active concurrency limits
- Output reservations
- Durable append-only snapshots
- Owner-scoped inspection
- Owner-scoped cancellation
- Restart interruption state
- Completion inbox metadata

Evidence: `packages/coding-agent/src/ice-subagent-jobs.ts:513-995` and `packages/coding-agent/src/ice-subagents.ts:6612-6758`.

**OpenCode advantage:** foreground and background are lifecycle states of the same persistent child session.

**ICE advantage:** durable state transitions are bounded and fail-closed. Jobs are not silently relaunched after restart, and non-idempotent work is not automatically replayed.

### 5. Recursive delegation — OpenCode wins capability

OpenCode supports bounded nesting. It walks the parent chain and rejects launches after a configured depth:

Evidence: `agent_references/opencode/packages/opencode/src/tool/task.ts:104-117`.

It disables recursive task launching by default through child permission rules, while allowing configured depth to enable hierarchy.

Evidence: `agent_references/opencode/packages/opencode/src/tool/task.ts:143-155`.

ICE disables recursion entirely:

- Child extensions disabled
- MCP disabled
- `delegate` unavailable to children
- `delegate_write` unavailable to children
- No recursive scheduler

Evidence: `packages/coding-agent/src/ice-subagents.ts:3171-3181` and `:3245-3267`.

**OpenCode advantage:** supports coordinator/investigator/reviewer hierarchies.

**ICE rationale:** avoids recursive cost explosion, nested authority confusion, complex cancellation trees, and context multiplication.

### 6. Model routing — OpenCode wins flexibility; ICE wins determinism

OpenCode lets an agent specify a model and provider. The task runner uses the child’s configured model or falls back to the parent model.

Evidence: `agent_references/opencode/packages/opencode/src/agent/agent.ts:44-51` and `src/tool/task.ts:181-183`.

This supports:

- Cheap exploration models
- Strong review models
- Specialized providers
- Per-agent cost optimization
- Different reasoning variants

ICE explicitly requires the exact current parent `Model` object for delegated children.

Evidence: `packages/coding-agent/src/ice-subagents.ts:6496`, `:6616`, and `:6764`.

**OpenCode advantage:** operational optimization and specialization.

**ICE advantage:** exact same-model comparisons, stable provenance, no hidden provider switching, predictable cost accounting, and easier benchmark interpretation.

### 7. Tool breadth — OpenCode wins capability

OpenCode’s default `explore` agent can use:

- `grep`
- `glob`
- `list`
- `bash`
- `webfetch`
- `websearch`
- `read`

Evidence: `agent_references/opencode/packages/opencode/src/agent/agent.ts:196-217`.

ICE’s default roles only use:

- `read`
- `grep`
- `find`
- `ls`

Bash, edit, and write require explicit unsafe or writer paths.

**OpenCode advantage:** broader repository and web investigation without additional parent orchestration.

**ICE advantage:** default children cannot execute commands, use the network, access MCP, mutate files, load extensions, or delegate recursively.

### 8. Scope and filesystem policy — ICE wins

OpenCode relies primarily on permission rules and external-directory policy:

Evidence: `agent_references/opencode/packages/opencode/src/agent/agent.ts:108-125`.

ICE performs explicit scope normalization and canonicalization:

- Scope roots must exist
- Scope roots must be directories
- Scope roots must remain within the parent workspace
- Paths are resolved relative to child cwd
- `.git` can be denied
- Resource roots are tracked separately
- Evidence paths are canonicalized
- Writer paths reject deletes, renames, gitlinks, symlinks, and unsupported statuses

Evidence: `packages/coding-agent/src/ice-subagents.ts:2570-2672`, `:2000-2063`, `:1274-1339`, and `:2935-3070`.

ICE also includes checks for:

- Profile symlink escapes
- Resource mutation
- Writer patch path escapes
- Artifact symlink replacement
- Evidence paths outside scope
- Git metadata access

**Important limitation:** path authorization and filesystem use are still not a kernel-level atomic boundary. The current defense rejects symlink components and revalidates canonical scope immediately before use, but descriptor-relative operations or true isolated execution are still needed to fully eliminate TOCTOU races.

### 9. Mutation and writer workflows — ICE wins significantly

OpenCode’s normal task model lets a permitted child edit directly in the project session.

ICE separates writing into a dedicated workflow:

1. Parent must satisfy Git preconditions.
2. Writer receives a temporary detached worktree.
3. Writer gets scoped read/edit/write tools.
4. Bash, network, MCP, extensions, and delegation are disabled.
5. Parent collects changed files.
6. Parent creates a bounded patch artifact.
7. Parent validates artifact provenance and hashes.
8. Parent can inspect or reject the artifact.
9. Parent integrates only after explicit approval and verifier configuration.
10. Integration performs preimage checks.
11. Verification runs.
12. Failure triggers compare-and-swap-style rollback.

Evidence: `packages/coding-agent/src/ice-subagents.ts:1115-1195`, `:1470-1550`, `:1907-1998`, and `:6004-6457`.

**ICE advantage:** better protection of unrelated parent work, stale-state detection, explicit review, verification, and rollback.

**OpenCode advantage:** simpler and faster direct editing when the configured permission policy is trusted.

### 10. Result protocol and verification — ICE wins

OpenCode’s task result is primarily text-oriented:

```text
<task id="..." state="completed">
  <task_result>
    text
  </task_result>
</task>
```

Evidence: `agent_references/opencode/packages/opencode/src/tool/task.ts:56-78`.

The parent interprets the child’s text.

ICE requires structured output containing:

- Summary
- Evidence paths
- Optional findings
- Run ID
- Parent session ID
- Profile/source
- Child session ID
- Status
- Output byte count
- Partial/truncation state
- Diagnostics
- Usage
- Recovery metadata

Evidence: `packages/coding-agent/src/ice-subagents.ts:420-700` and `:2830-3070`.

ICE verifies:

- Run lineage
- Parent-session lineage
- Role/source identity
- Completed status
- Nonempty summary
- Output limits
- Evidence path existence
- Evidence scope
- Reviewer finding shape
- Finding evidence scope

ICE explicitly does not claim semantic truth. Its verification says semantic claims remain unresolved.

Evidence: `packages/coding-agent/src/ice-subagents.ts:3064-3069`.

### 11. Output budgets and retry accounting — ICE wins

ICE bounds:

- Task count
- Concurrency
- Output bytes
- Context packet bytes
- Fork context bytes
- Evidence paths
- Findings
- Durable snapshot size
- Writer patch size
- Changed file count
- Retry attempts

Evidence: `packages/coding-agent/src/ice-subagents.ts:266-370`, `:4098-4220`, and `:4416-4453`; `packages/coding-agent/src/ice-subagent-jobs.ts:1-20`.

Recovery is:

- Same model
- Maximum two attempts
- Typed retry classification
- Immutable request/context reuse
- Aggregate usage tracking
- Attempt provenance

OpenCode has agent step limits, but not the same typed byte-level budget and retry provenance model.

### 12. Context handoff — mixed

OpenCode’s fresh task prompt explicitly requires the parent to provide complete context because a new child does not automatically inherit the current context.

Evidence: `agent_references/opencode/packages/opencode/src/tool/task.txt:15-16`.

OpenCode’s resumable child sessions provide strong continuity.

ICE supports:

- `fresh` context
- Sanitized bounded `fork` context
- Typed context packets: `parent_note`, `verified_fact`, `evidence_ref`, and `artifact_ref`
- Credential redaction before handoff
- Explicit combined context budget

Evidence: `packages/coding-agent/src/ice-subagents.ts:312-333` and `:2387-2570`.

**OpenCode advantage:** full continuation of an existing child.

**ICE advantage:** explicit trust categories, redaction, byte bounds, and no accidental full-transcript inheritance.

### 13. Parent/child cancellation — mixed

OpenCode cancellation follows the persistent session tree and can cancel the parent, direct children, and descendants.

Evidence: `agent_references/opencode/packages/opencode/src/session/run-state.ts:112-147`.

ICE supports:

- Foreground abort signals
- Async job cancellation
- Batch cancellation
- Queue cancellation
- Parent-run cancellation
- Session-shutdown cancellation
- Bash process-tree termination

Evidence: `packages/coding-agent/src/ice-subagents.ts:739-865`, `:4525-4708`; `packages/coding-agent/src/ice-subagent-jobs.ts:665-703`, `:768-789`.

**OpenCode advantage:** natural hierarchical cancellation through persistent sessions.

**ICE advantage:** explicit bounded job control and no silent relaunch.

**Shared limitation:** cancellation is best-effort for non-cooperative workers, detached descendants, filesystem effects, network effects, and unsafe host execution.

### 14. Persistence and restart behavior — mixed

OpenCode persists complete child sessions and message histories in its session database. This is stronger for interactive resume and inspection.

ICE persists durable async job snapshots as append-only custom session entries:

- Job status
- Queue metadata
- Model label
- Owner session
- Run reference
- Result projection
- Verification projection
- Diagnostics
- Usage

On restart, active/queued jobs become `interrupted` rather than being silently relaunched.

Evidence: `packages/coding-agent/src/ice-subagent-jobs.ts:705-761`.

**OpenCode advantage:** complete child conversation persistence.

**ICE advantage:** conservative restart semantics that avoid replaying non-idempotent work, mutations, network operations, or provider requests.

### 15. Observability and UX — OpenCode wins session UX; ICE wins bounded operational telemetry

OpenCode child sessions participate in the normal session system:

- Parent-child session tree
- Session API
- Child listing
- Persistent messages
- Task metadata
- Background state
- CLI subagent views

Evidence: `agent_references/opencode/packages/opencode/src/session/session.ts:451-452`, `:598-619`, and `src/cli/cmd/run/subagent-data.ts`.

ICE has a dedicated observatory with:

- Active child registry
- Parent/child split view
- Progress snapshots
- Tool activity
- Durable job rows
- Completion inbox
- Bounded transcript view
- Runtime status projections

Evidence: `packages/coding-agent/src/ice-subagent-observatory.ts` and `packages/coding-agent/src/ice-subagents.ts:6994-7029`.

**OpenCode advantage:** natural session navigation, full transcripts, and platform APIs.

**ICE advantage:** bounded projections, local-only observability by default, and separation between operational metadata and child result bodies.

### 16. Tool discoverability — OpenCode wins

OpenCode dynamically describes available agents and filters hidden or denied entries for the caller.

Evidence: `agent_references/opencode/packages/opencode/src/tool/registry.ts:250-330` and `test/tool/task.test.ts`.

ICE has `list_subagent_profiles`, which returns:

- Role name
- Description
- Source
- Exact source path
- Read-only tools
- Unsafe declaration

Evidence: `packages/coding-agent/src/ice-subagents.ts:6459-6490`.

OpenCode’s model-facing descriptions are richer because they include agent modes and permission-aware availability. ICE should improve its profile listing and delegation prompt descriptions.

### 17. Architecture and maintainability — OpenCode wins

OpenCode separates:

- Agent registry
- Task tool
- Permission engine
- Session service
- Background job service
- Run-state service
- Prompt service
- CLI rendering
- HTTP/API session endpoints

ICE’s central `ice-subagents.ts` is approximately 7,154 lines and contains:

- Profile resolution
- Resource resolution
- Scope validation
- Context sanitization
- Child session construction
- Foreground runner
- Recovery
- Batch scheduler
- Reviewer orchestration
- Writer workspaces
- Patch creation
- Patch inspection
- Patch integration
- Unsafe execution authorization
- Tool definitions
- Observatory wiring
- Command registration

ICE has extracted jobs and observatory code, but the central runner remains very large.

**OpenCode advantage:** clearer service boundaries and easier independent evolution.

**ICE advantage:** security logic is centralized and the single-loop boundary is visible, but the file is now large enough that this benefit is diminishing.

### 18. Security posture — ICE wins by default

OpenCode’s default explore agent allows Bash, webfetch, websearch, and repository read/search tools.

Evidence: `agent_references/opencode/packages/opencode/src/agent/agent.ts:196-217`.

ICE’s normal child roles cannot:

- Execute commands
- Use the network
- Use MCP
- Modify files
- Load extensions
- Recursively delegate
- Expand credentials

Unsafe host execution requires:

- Explicit `--sub-yolo`
- Explicit build mode
- Explicit Bash enablement
- Trusted project
- Interactive TUI
- Parent Bash capability
- Startup authorization

Evidence: `packages/coding-agent/src/ice-subagents.ts:126-178` and `:5877-5910`.

ICE is safer by default, although explicit unsafe mode remains host execution rather than a sandbox.

## Confirmed ICE security findings and fixes

### Finding 1 — unsafe delegated Bash inherited the host environment

**Severity:** High.

Original problem:

- Unsafe child Bash used `exposeSessionEnvironment: false`.
- That option only removed Ice session metadata such as `ICE_SESSION_ID`.
- The shared Bash implementation still called `getShellEnv()`.
- `getShellEnv()` spread `process.env`, exposing unrelated host variables.

Impact:

A delegated unsafe child could read unrelated cloud credentials, package registry tokens, service keys, and other host configuration through its shell environment.

Relevant shared code:

- `packages/coding-agent/src/core/tools/bash.ts`
- `packages/coding-agent/src/utils/shell.ts`

Fix applied:

- Added `createDelegatedShellEnvironment()` in `ice-subagents.ts`.
- Unsafe delegated Bash uses a `spawnHook` to replace the inherited environment with an explicit allowlist.
- Removed home, user, identity, and XDG configuration variables from the delegated environment.
- Retained only execution-related values such as `PATH`, locale, shell, terminal, and temporary-directory variables.

Regression coverage:

- `ice-subagents-adversarial.test.ts` verifies AWS, GitHub, Ice session, home, and other credential-bearing variables are removed.

### Finding 2 — scoped filesystem access had a TOCTOU symlink race

**Severity:** High.

Original problem:

- `assertSubagentScopePath()` validated a path.
- The wrapper then called the underlying filesystem tool separately.
- A concurrent process could replace a directory/file with a symlink between validation and use.

Impact:

A path that initially appeared inside an approved scope could resolve outside the scope during the actual read, write, edit, grep, find, or ls operation.

Fix applied:

- Added symlink-component inspection before scoped use.
- Revalidated canonical scope membership immediately before passing the path to the underlying tool.
- Existing writer/artifact protections also reject symlink paths and verify hashes/provenance.

Important remaining limitation:

This reduces the race window but is not a kernel-level atomic authorization/use boundary. Full elimination requires descriptor-relative filesystem operations with symlink restrictions or an independently isolated workspace/runtime.

Regression coverage:

- Existing adversarial tests cover resource symlink replacement.
- Existing writer tests cover symlink replacement and patch/artifact escapes.
- Updated writer scope expectations to accept the explicit symlink rejection diagnostic.

## ICE strengths

ICE is materially stronger in these areas:

1. **Read-only-by-default delegation**
   - Normal children receive only read/search tools.
   - Bash, network, MCP, extensions, mutation, and recursion are disabled by default.

2. **Parent-owned authority**
   - Ice remains the single authoritative reasoning and tool loop.
   - Delegation is a ICE extension/tool rather than a competing controller.

3. **Structured result verification**
   - Child results require lineage, bounded summaries, evidence paths, and valid status.
   - Reviewer findings require structured evidence.

4. **Output/context/resource bounds**
   - Byte-level caps exist across output, context packets, fork context, evidence, jobs, snapshots, and patches.

5. **Same-model determinism**
   - Children use the exact current parent model.
   - No profile can silently route to another provider/model.

6. **Writer isolation**
   - Normal writers use detached worktrees.
   - Parent worktree remains clean during child mutation.

7. **Patch provenance and integration safety**
   - Artifacts are hashed, bounded, immutable, and path-checked.
   - Integration uses preimage checks, verification, postimage checks, and rollback conflict detection.

8. **Conservative restart behavior**
   - Incomplete durable jobs become `interrupted` rather than being replayed automatically.

## ICE weaknesses relative to OpenCode

1. **Agent profiles are less expressive**
   - No per-agent model, provider, variant, temperature, top-p, or step settings.

2. **Permission model is less composable**
   - No generalized path/tool/agent `allow`/`ask`/`deny` matrix comparable to OpenCode.

3. **Foreground child sessions are ephemeral**
   - No normal `task_id`-style continuation of the complete child transcript.

4. **Background promotion is incomplete**
   - No seamless conversion of a running foreground child into a durable background child session.

5. **No bounded recursive hierarchy**
   - Recursion is disabled rather than configurable by depth.

6. **Narrower default tools**
   - Explore/review children cannot use Bash or web tools in the normal path.

7. **Observatory is not a full session system**
   - It projects child state rather than making children first-class persistent sessions.

8. **Central implementation is too large**
   - `ice-subagents.ts` combines too many responsibilities and should be decomposed over time.

9. **Filesystem authorization is not fully race-safe**
   - Symlink rejection and revalidation reduce risk but do not replace descriptor-relative operations or isolation.

10. **Cancellation remains best-effort in unsafe mode**
    - Detached descendants and external side effects may survive cancellation.

## OpenCode strengths to consider adopting

### A. First-class agent registry

Add a dedicated agent/profile registry with typed fields for:

- Name
- Description
- Mode
- Prompt
- Tools/capabilities
- Model policy
- Variant/thinking level
- Step limit
- Permission rules
- Visibility
- Source/provenance

Keep ICE’s trust rules and prohibit project profiles from weakening global safety constraints.

### B. Permission-aware model-facing discovery

Improve `list_subagent_profiles` and tool descriptions to show:

- Which roles are available
- Which are allowed by current parent policy
- Which require approval
- Which tools each role can actually use
- Whether the role is read-only, isolated-writer, or unsafe-host
- Model provenance
- Timeout and output budgets

### C. Resumable child session identity

Add optional continuation for read-only children using a durable child session/result reference, while preserving the fresh bounded default.

A safe design would separate:

- Full transcript persistence
- Bounded parent result projection
- Parent context ingestion

Do not automatically inject the entire child transcript into the parent.

### D. Foreground-to-background promotion

Add a bounded promotion path:

- Foreground child starts in a durable session/job record.
- If the parent is interrupted, the child may be promoted only when policy allows.
- Promotion must persist before detaching.
- Completion must be delivered once.
- Mutating work must not be promoted without an isolated workspace.

### E. Configurable recursion depth

If recursive delegation is added, require:

- Explicit configuration
- Hard maximum depth
- Per-run node budget
- Aggregate output/token budget
- Owner-scoped cancellation
- No recursive writers by default
- No recursive unsafe host execution
- Parent verification at every boundary

### F. Decompose the central runner

Potential boundaries:

- `ice-subagent-profiles.ts`
- `ice-subagent-resources.ts`
- `ice-subagent-scope.ts`
- `ice-subagent-runner.ts`
- `ice-subagent-recovery.ts`
- `ice-subagent-batch.ts`
- `ice-subagent-writer.ts`
- `ice-subagent-tools.ts`
- `ice-subagent-policy.ts`

This should be done incrementally, with no behavior change and focused tests per boundary.

## OpenCode features ICE should not copy directly

1. **Broad default explore authority**
   - Do not enable Bash/web/network by default for repository-derived tasks.

2. **Child permission expansion beyond parent capability**
   - Preserve the parent/tool intersection unless an explicit policy grants more authority.

3. **Automatic background replay after restart**
   - Do not silently rerun interrupted work.

4. **Direct shared-worktree mutation as the default**
   - Preserve isolated writer worktrees and explicit integration.

5. **Unbounded or weakly bounded recursion**
   - Any hierarchy must have hard depth, cost, and cancellation limits.

## Validation evidence

Focused ICE validation performed during this comparison/fix cycle:

- Focused subagent tests: **225 passed** across 5 test files.
- Earlier full subagent-focused suite: **243 passed** across 6 test files.
- Direct TypeScript check was run but remained blocked by two unrelated pre-existing model-ID errors in:
  - `packages/ai/test/context-overflow.test.ts`
  - `packages/ai/test/total-tokens.test.ts`
- Full `npm run check` was also blocked by the environment resolving npm 11.17.0 while the repository requires npm 12.0.2 for nested npm commands.

The focused test results validate the implemented delegation contracts but do not prove semantic correctness of child claims or eliminate the remaining filesystem TOCTOU limitation.

## Final recommendation

ICE should not try to become a full OpenCode clone. Its strongest differentiator is a controlled, verifiable, safety-first delegation layer around Ice’s existing loop.

The highest-value roadmap is:

1. Keep the read-only default and writer isolation.
2. Add a typed agent registry with richer profile metadata.
3. Add permission-aware discovery and approval without weakening parent policy.
4. Add optional resumable child sessions with bounded parent projections.
5. Add safe foreground-to-background promotion.
6. Consider bounded recursion only after lifecycle and cancellation semantics are mature.
7. Decompose `ice-subagents.ts` without changing behavior.
8. Replace path-check/recheck filesystem access with descriptor-relative or isolated operations before advertising stronger sandbox claims.

Overall judgment:

- **OpenCode:** better general-purpose capability and user workflow.
- **ICE:** better default safety, verification, mutation control, and deterministic delegation.
- **Best target:** ICE’s safety boundary combined with OpenCode’s agent registry, permission UX, session continuity, and lifecycle model.
