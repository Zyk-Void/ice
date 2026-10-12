# ICE Subagent Research Findings

> Historical (V1 subagent era, last updated before 2026-09-11). Subagents V2 replaced this plan; see `packages/coding-agent/docs/subagents-v2.md`, `Plan/subagent-rewrite.md`, and the Near-Term Roadmap in `idea.md`.

_Last updated: 2026-08-08_

## Executive conclusion

ICE can add subagents without adding a second agent framework or replacing Ice's authoritative loop.

The strongest design is:

- expose delegation through one ICE-owned `delegate` tool loaded only by `ice`;
- keep the parent `AgentSession` authoritative for decomposition, mode/policy, integration, verification, and user-facing completion;
- create each child as a fresh native `AgentSession` with an in-memory history and explicit model/tool scope;
- start with only bundled foreground read-only `explore` and `review` roles;
- disable child extensions and ambient skills, prompt templates, themes, and context-file discovery by default so the worker runtime is intentionally small and predictable;
- allow Phase A to pass only explicitly selected, trusted, hash-validated skills, prompt templates, and context files;
- derive child tools from the parent's currently active tools intersected with the role/runtime allowlist;
- return a compact typed result instead of copying the child transcript into the parent;
- propagate cancellation and hard budgets;
- keep configurable roles/resources explicit and independently gated; make parallel fan-out, writers/worktrees, recursion, and background jobs later capability layers rather than defaults.

The local references agree on the important invariants even though their implementations differ: **isolate context, narrow permissions, track lineage, bound execution, treat child output as evidence, and keep mutation integration parent-owned**.

The current ICE tree already contains enough native primitives for a strong foreground MVP. In particular, `createAgentSession({ tools })` supplies an actual tool allowlist, `SessionManager.inMemory()` can provide a clean child history, `AgentSession.subscribe()` exposes lifecycle events, and `AgentSession.abort()/waitForIdle()` provide a deterministic cancellation boundary. The existing subprocess subagent example remains useful as a compatibility and process-isolation reference, but it is not the only viable execution path.

Phase B1 bounded sibling read fanout, Phase B2 typed reviewer orchestration, Phase B3.1 deterministic cross-model reviewer routing, Phase B4 parent-owned launch preflight/digest, Phase B5 selective typed context packets, Phase B6.1 sanitized fork snapshots, and Phase B7.1 bounded typed transient recovery are implemented over the same atomic `runResolved()` executor, with B7.1 frozen after independent audit. Reviewer results remain independently scoped and verified, deterministic, and contradiction-preserving; model selection changes compute only and records task/dimension/default/parent provenance. Preflight records resolved model, effective tools, exact scope roots, budget reservations, trust, selected-resource provenance, packet metadata, and fork metadata before launch; only a bounded digest enters parent context. Explicit packet and sanitized fork content enter only the fresh child handoff as untrusted data. Fork mode uses `buildSessionContext().messages`, strict allowlisting, shared credential redaction, deterministic UTF-8 caps, and a combined packet/fork budget; it never clones sessions or imports `getBranch()` state. B7.1 retries only explicitly typed transient provider/startup failures once, reuses the immutable normalized contract and context, aggregates usage/output, and delays batch fail-fast until logical-task recovery is terminal. The parent remains the sole synthesizer. Writers, chains, background jobs, fallback model policy, and Hivemind remain future phases.

---

## Current repository state relevant to this work

- Active branch inspected: `void`.
- At the time of this research snapshot, subagent implementation had not started; the current V1 implementation is tracked in `progress.md` and `task_plan.md`.
- Existing unrelated/concurrent changes in ICE provider, model-store, Cognee, tests, and planning files must be preserved.
- Local reference roots:
  - `agent_references/oh-my-pi`
  - `agent_references/opencode`
  - `agent_references/ii-agent`
  - `agent_references/claw-code`
  - `agent_references/openhands`
- Ice's own compatible example:
  - `packages/coding-agent/examples/extensions/subagent/index.ts`
  - `packages/coding-agent/examples/extensions/subagent/agents.ts`
  - `packages/coding-agent/examples/extensions/subagent/README.md`

No reference implementation should be copied wholesale. The useful target is a ICE-native contract built from the common safety/lifecycle patterns.

Phase A is implemented in `packages/coding-agent/src/ice-subagents.ts`: user/project role resolution is provenance- and hash-bound, user context selection is isolated under `$ICE_AGENT_DIR/context/`, selected skills receive exact resource read roots, selected prompt bodies reach child execution, selected resources are capped before reading at 64 KiB per file and 256 KiB in aggregate, project trust is required for project sources, and extensions remain excluded. The runner consumes one resolved launch contract without rediscovery. Phase B1/B2 parallel read and typed review layers plus B3.1 model routing, B4 preflight/digest, and B5 context packets reuse that runner; fallback/retry, fork-context sanitization, and writer/background semantics remain future phases.

M10/M11 verification is complete for the deterministic delegation path: parent-owned lineage, terminal/partial-result verification, parent-side evidence bounds, unresolved review claims, foreground/durable-async timeout forwarding, and unsafe foreground `review` rejection are covered by `181/181` focused verification tests plus the Faux-provider integration suite at `9/9`. The seven-file foreground delegation regression shard passes `263/263`. Root `npm run check` reaches only the inherited `packages/ai/test/openai-completions-tool-choice.test.ts:1410` `maxTokensField` TypeScript error.

---

# 1. What ICE already has

## 1.1 Native child-session construction

`packages/coding-agent/src/core/sdk.ts` exposes `createAgentSession()` and supports the controls needed for a child runtime:

- explicit `cwd`;
- explicit model and thinking level;
- `SessionManager` injection;
- a `tools` allowlist;
- an `excludeTools` denylist;
- `noTools` modes;
- custom tools;
- a custom `ResourceLoader`;
- shared or separately constructed `ModelRuntime` and settings.

Important detail: when `tools` is supplied, it is not merely an initial UI selection. The SDK passes it to `AgentSession` as `allowedToolNames`; `AgentSession` filters built-in, extension, and custom tools against that allowlist when rebuilding the registry. This is the right primitive for child capability narrowing.

## 1.2 Clean child history

The SDK example in `core/sdk.ts` already demonstrates `SessionManager.inMemory()`. For a foreground worker this gives the child an independent history without creating a durable user session by default.

This directly supports the desired rule:

> inherit selected resources and task context, not the parent's full conversation transcript.

## 1.3 Lifecycle and cancellation

`AgentSession` already provides:

- `subscribe(listener)` for session events;
- `prompt()` for execution;
- `abort()` for current work;
- `waitForIdle()`;
- `isIdle`;
- model switching through `setModel()`;
- tool control through `setActiveToolsByName()`.

Internally, Ice already propagates abort signals through agent requests, compaction, retries, bash, and extension tool execution. A subagent layer should compose with this machinery rather than inventing a parallel cancellation system.

## 1.4 Tool registration seam

Ice extensions can `registerTool()`, and tool execution receives an `AbortSignal` plus progress callback. That means ICE can expose a parent-side delegation tool while keeping child execution in a separate module.

Recommended ownership boundary:

```text
Ice parent AgentSession
    -> hidden ICE `delegate` extension/tool
        -> SubagentManager / SubagentRunner
            -> fresh native child AgentSession
                -> in-memory child history
                -> strict read-only tool allowlist
                -> no extension/skill/template/theme/context-file discovery
                -> child result envelope
        -> parent verification/integration
```

The `delegate` extension should be loaded from `ice.ts`, not added to stock `ice`. ICE's existing guarded-build mode remains the parent policy authority: `ice.getActiveTools()` supplies the current parent tool set, and the child receives only the intersection of that set with the role/runtime allowlist. This preserves Ice's loop/session authority and avoids a second permission universe.

## 1.5 Model routing

ICE already has a canonical model runtime/catalog and ICE provider work. A subagent profile should select a model through this existing model layer. The subagent subsystem should not implement another provider registry and should not depend specifically on the ICE provider.

---

# 2. Ice's existing subagent extension example

## Sources

- `packages/coding-agent/examples/extensions/subagent/index.ts`
- `packages/coding-agent/examples/extensions/subagent/agents.ts`
- `packages/coding-agent/examples/extensions/subagent/README.md`

## Useful patterns

The example is the best compatibility baseline for the tool UX:

- a `subagent` tool;
- named agent definitions;
- isolated child context;
- `single`, `parallel`, and `chain` modes;
- model/tool/system-prompt overrides;
- project-vs-user agent discovery;
- explicit trust confirmation for project-controlled agents;
- bounded parallelism;
- progress streaming;
- cancellation via `SIGTERM` with `SIGKILL` escalation;
- capped parent-visible output;
- usage/model/exit metadata.

## Limitations

The example launches a separate `ice` subprocess with JSONL output. That gives a useful process boundary, but it is still an example-level orchestration layer:

- context isolation is **not** filesystem isolation;
- a shared `cwd` means workers can still collide on files;
- subprocess JSONL becomes an extra protocol boundary;
- project-agent trust is explicit, but workspace mutation isolation is not provided;
- result semantics are mostly presentation-oriented rather than a durable run contract;
- background lifecycle, resume, and ownership are outside its scope.

## ICE decision

Preserve its simple tool semantics and trust model, but do not make subprocess orchestration the only architecture.

For the first native ICE implementation, prefer an **in-process child `AgentSession` backend** when the child can be built with:

1. an in-memory session;
2. a strict tool allowlist;
3. a controlled resource loader that cannot silently activate untrusted project extensions;
4. no recursive delegation tool;
5. parent-owned cancellation and timeout.

Retain a subprocess runner as a possible backend/fallback when process isolation, CLI parity, or crash containment is more important. The result contract should be backend-independent.

---

# 3. Reference implementation findings

## 3.1 Oh My Ice — strongest production task/executor reference

### Sources

- `agent_references/oh-my-pi/packages/coding-agent/src/task/index.ts`
- `agent_references/oh-my-pi/packages/coding-agent/src/task/types.ts`
- `agent_references/oh-my-pi/packages/coding-agent/src/task/executor.ts`
- `agent_references/oh-my-pi/packages/coding-agent/src/task/discovery.ts`
- `agent_references/oh-my-pi/packages/coding-agent/src/task/parallel.ts`
- `agent_references/oh-my-pi/packages/coding-agent/src/task/worktree.ts`
- async/job and registry modules under the same package for later phases.

### What is worth borrowing

- delegation is modeled as an explicit task/run contract, not an arbitrary nested prompt;
- child contexts are independent;
- discovery precedence is deterministic;
- output can be schema-validated;
- request/runtime/output budgets are explicit;
- concurrency is bounded and abort-aware;
- recursion is gated;
- partial/failure states are represented explicitly;
- isolated writer workers can produce patches/branches from worktrees;
- parent integration remains a separate concern.

### What not to copy into MVP

Oh My Ice contains machinery for durable artifacts, worktree backends, async jobs, agent registries, revival, and richer fork-specific APIs. ICE should borrow the contracts and failure semantics without importing the whole subsystem.

### ICE decision

Use Oh My Ice as the primary reference for:

- `SubagentRequest`/`SubagentResult` shape;
- budget semantics;
- bounded parallelism;
- later writer worktree isolation;
- partial result handling.

---

## 3.2 OpenCode — strongest lineage and permission reference

### Sources

- `agent_references/opencode/packages/opencode/src/tool/task.ts`
- `agent_references/opencode/packages/opencode/src/agent/subagent-permissions.ts`
- `agent_references/opencode/packages/opencode/src/background/job.ts`
- `agent_references/opencode/packages/opencode/test/tool/task.test.ts`
- `agent_references/opencode/packages/opencode/test/permission-task.test.ts`

### What is worth borrowing

- explicit parent-child session lineage;
- foreground-by-default execution;
- named subagent type;
- model inheritance/override;
- parent-abort propagation;
- resumable task identity in later phases;
- child permissions derived from parent policy rather than inherited unrestricted;
- nested task/delegation denied by default;
- background work separated into a real job lifecycle instead of a boolean fire-and-forget mode.

### Critical negative finding

A parent-linked child session does not itself create a workspace sandbox. Session lineage and filesystem isolation must remain separate capabilities.

### ICE decision

Adopt:

```text
child effective capabilities = parent allowed capabilities INTERSECT profile allowed capabilities
```

A child must never gain a tool, directory, network capability, MCP, credential scope, or delegation permission that the parent did not possess.

---

## 3.3 II-Agent — strongest run/event state reference

### Sources

- `agent_references/ii-agent/src/ii_agent/agents/agent.py`
- `agent_references/ii-agent/src/ii_agent/agents/tools/task.py`
- `agent_references/ii-agent/src/ii_agent/agents/runs/events.py`
- `agent_references/ii-agent/src/ii_agent/agents/runs/models.py`
- `agent_references/ii-agent/src/ii_agent/tasks/types.py`

### What is worth borrowing

- delegation produces a run with identity and state;
- events include parent linkage and delegated origin;
- cancellation is associated with the parent/run;
- stateless/read-oriented worker patterns are explicit;
- terminal statuses are typed rather than inferred from prose;
- persistence and sandbox lifecycle are separate layers.

### ICE decision

Even if MVP run state is in memory, define the lifecycle as if it could later be persisted. Do not make status depend on parsing child text.

---

## 3.4 Claw Code — strongest task packet, worker health, and evidence model

### Useful sources

- `agent_references/claw-code/rust/crates/runtime/src/task_packet.rs`
- `agent_references/claw-code/rust/crates/runtime/src/task_registry.rs`
- `agent_references/claw-code/rust/crates/runtime/src/worker_boot.rs`
- `agent_references/claw-code/rust/crates/runtime/src/session_control.rs`
- `agent_references/claw-code/rust/crates/runtime/src/permissions.rs`
- `agent_references/claw-code/rust/crates/runtime/src/report_schema.rs`

### What is worth borrowing

- validate a task packet before execution;
- make objective, scope, acceptance criteria, report requirements, and escalation behavior explicit;
- distinguish ready/running/stalled/transport-dead states;
- prefer typed startup/handshake state to terminal scraping;
- evaluate hard denials before weaker permission rules;
- distinguish claims from evidence;
- attach confidence/sensitivity/provenance to reports where useful.

### ICE decision

Do not add Claw Code's control plane. Borrow the validation/evidence discipline for parent verification and future long-running workers.

---

## 3.5 OpenHands — secondary architecture reference

The vendored checkout is primarily Agent Canvas and points the actual current Agent/Agent Server implementation to a separate SDK repository. It contains integration-level delegation references, but the full current subagent runtime is not available locally enough to justify source-level claims.

Useful conceptual distinction only:

- agent loop;
- conversation/event state;
- workspace/sandbox provider.

ICE should preserve those boundaries. Do not infer a concrete OpenHands subagent API from this checkout.

---

# 4. Cross-reference synthesis

| Concern | Best local evidence | ICE decision |
|---|---|---|
| Simple tool UX | Ice subagent example | Keep one explicit delegation tool |
| Fresh child context | Ice example, Oh My Ice | New child session; no parent transcript cloning |
| Native session execution | Ice `createAgentSession()` | Preferred foreground backend if resource isolation is controlled |
| Process isolation | Ice subagent example | Optional backend/fallback, not the semantic contract |
| Tool restriction | Ice SDK + OpenCode | Hard allowlist; derive by intersection |
| Parent-child identity | OpenCode, II-Agent | Stable run + parent + child IDs |
| Run lifecycle | II-Agent, Claw Code | Typed state machine |
| Output/result schema | Oh My Ice, Claw Code | Compact typed envelope + artifact handle |
| Cancellation | Ice core, Ice example, OpenCode | Parent abort always propagates |
| Time/request/output budgets | Oh My Ice | Hard caps, partial result on interruption |
| Parallelism | Ice example, Oh My Ice | Bounded; later than single-child MVP |
| Recursive delegation | OpenCode, Oh My Ice | Off in MVP; depth-limited later |
| Mutation isolation | Oh My Ice | Worktree/container provider before parallel writers |
| Background jobs | OpenCode, Oh My Ice | Later only with durable lifecycle |
| Verification | Claw Code + ICE guarded build | Parent-owned evidence gate |
| Project-agent trust | Ice example | Explicit trust before repo-controlled profiles |

---

# 5. Recommended ICE architecture

## 5.1 Feature ownership

Subagents should be a **ICE first-class feature implemented through Ice's extension/tool seam**, not a replacement core loop.

Proposed internal layering:

```text
ice.ts
  -> loads hidden ICE subagent extension/factory
      -> registers `delegate`
          -> SubagentManager
              -> bundled role resolver (V1)
              -> policy/capability resolver using parent active tools
              -> NativeAgentSessionRunner
                   -> stripped child ResourceLoader
                   -> SessionManager.inMemory()
              -> result normalizer
              -> parent verification adapter

V2+ may add trusted profile discovery and an optional subprocess runner only if benchmarks justify them.
```

Candidate module layout, subject to implementation review:

```text
packages/coding-agent/src/subagents/
  types.ts
  profiles.ts
  discovery.ts
  policy.ts
  runner.ts
  native-runner.ts
  subprocess-runner.ts        # optional/later if needed
  result.ts
  events.ts
  extension.ts
```

Do not create all files merely to match this diagram. Start with the smallest separable set and split only when responsibilities become real.

## 5.2 Execution backend decision

### Preferred MVP backend: native child `AgentSession`

Benefits:

- no JSONL subprocess protocol to maintain;
- direct typed events;
- native `abort()/waitForIdle()`;
- reuse the same model runtime/catalog;
- in-memory session is straightforward;
- SDK tool allowlisting is already enforced by the child registry;
- easier deterministic unit tests.

V1 should deliberately use a stripped child resource environment rather than attempting selective inheritance:

```text
noExtensions: true
noSkills: true
noPromptTemplates: true
noThemes: true
noContextFiles: true
systemPrompt: <ICE bundled role prompt>
```

Consequences:

- no user extension hooks execute in the child;
- no project extension hooks execute in the child;
- `ice-cognee`, `ice-safe-verify`, Blackhole extensions, and `delegate` are not loaded into the child;
- no repository `AGENTS.md`/context file is implicitly injected into the child; relevant repository instructions must be deliberately included in the handoff if required;
- no skill or prompt-template discovery can silently widen behavior;
- child tools are an explicit `read`/`grep`/`find`/`ls` allowlist further intersected with the parent's active tools;
- no shell/Bash in V1.

This makes resource discovery a V2 feature rather than a V1 safety dependency. Tests must still verify that the loader flags and tool registry produce exactly this effective runtime.

### Optional backend: `ice` subprocess

Use when ICE explicitly wants:

- process crash containment;
- CLI-level parity;
- a harder process boundary;
- compatibility with external Ice agent definitions.

The public request/result/lifecycle contract should not care which backend ran the child.

---

# 6. Core contracts

The exact TypeScript names may change, but the semantics should be fixed before implementation.

## 6.1 `SubagentProfile`

```ts
interface SubagentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  thinkingLevel?: string;
  tools: string[];
  maxTurns?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowDelegation?: boolean;
  mutationMode: "read-only" | "isolated-write";
}
```

Rules:

- role definitions describe desired capability; parent policy still caps it;
- `allowDelegation` is `false` for MVP;
- no free-form caller permission escalation field;
- a model cannot request tools for itself.

## 6.2 `SubagentRequest`

```ts
interface SubagentRequest {
  profile: string;
  task: string;
  scope?: {
    roots?: string[];
    exclude?: string[];
  };
  context?: SubagentContextRef[];
  model?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
```

The task must be self-contained. The parent should pass only selected context, file references, summaries, or artifacts. Never clone the entire parent transcript by default.

## 6.3 `SubagentRun`

```ts
type SubagentStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "verification_failed";

interface SubagentRun {
  runId: string;
  parentSessionId: string;
  childSessionId: string;
  profile: string;
  status: SubagentStatus;
  startedAt?: string;
  endedAt?: string;
}
```

Terminal transitions are idempotent. A late child event after cancellation cannot turn a run back into success.

## 6.4 `SubagentResult`

```ts
interface SubagentResult {
  runId: string;
  parentSessionId: string;
  childSessionId: string;
  profile: string;
  status: SubagentStatus;
  summary: string;
  partial: boolean;
  artifacts?: SubagentArtifact[];
  evidence?: SubagentEvidence[];
  changedPaths?: string[];
  usage?: unknown;
  diagnostics?: {
    failureCode?: string;
    message?: string;
    stderrTail?: string;
  };
  verification?: SubagentVerification;
}
```

The parent-visible `summary` is bounded. If full output is retained, store it separately and return an artifact handle. Never inject an unbounded child transcript into parent context.

---

# 7. Context and memory boundary

## Parent -> child

Default transfer:

- task;
- role/system prompt;
- approved cwd/scope;
- explicitly selected file/context references;
- optional compact parent-generated handoff summary.

Do **not** transfer by default:

- full parent message history;
- parent hidden scratch state;
- unrelated retrieved memory;
- all parent tools;
- all parent extensions;
- arbitrary environment secrets.

## Child -> parent

Transfer:

- compact result summary;
- structured evidence;
- artifact handles;
- measured usage/status;
- actual changed paths only when observed by the workspace layer;
- verification outcomes.

Do not transfer:

- raw child transcript as normal parent history;
- raw internal tool logs without truncation/redaction;
- child instructions as trusted control text.

## Blackhole compaction

Each child owns its own history/compaction state. Parent and child compaction histories must never merge.

The `SubagentResult` envelope is the memory/context boundary. If a long child run compacts, only its compact final evidence/result crosses back to the parent.

Lineage metadata and terminal status should live outside compaction-sensitive natural-language content wherever practical.

## Cognee

Cognee memory should not make parent and child memory implicitly global.

MVP recommendation:

- automatic Cognee recall/write **off for children** unless explicitly enabled by a profile/policy;
- if enabled later, include `runId`/profile/session scoping;
- retrieved memory remains untrusted reference data;
- child memory access must obey the same parent capability intersection;
- never let memory results alter permissions, task mode, or delegation depth.

---

# 8. Permission model

## Invariant

A child can only lose capabilities relative to its parent.

```text
parentAllowed = ice.getActiveTools()
childEffective = parentAllowed ∩ profileAllowed ∩ runtimePolicyAllowed
```

For ICE V1, `ice-safe-verify` remains the source of parent mode/tool policy. The subagent extension observes the current active tool set and narrows it; it does not reinterpret plan/build state itself. This means adding `delegate` to the appropriate guarded-build tool lists is the only mode integration needed for V1.

Explicit denial wins.

Capabilities should eventually be modeled independently:

- read files;
- search/list files;
- execute shell;
- write/edit/apply patch;
- network;
- MCP/connectors;
- credentials/secrets;
- external directories;
- memory/Cognee;
- spawn subagent;
- background execution.

MVP profiles:

### `explore`

- read/search/list only;
- no Bash unless a safe read-only command layer exists;
- no edit/write;
- no network by default;
- no MCP by default;
- no delegation;
- no persistent memory write.

### `review`

- same capability floor as `explore`;
- prompt optimized for correctness, regression, security, and evidence;
- may receive explicit diff/file context;
- no mutation.

A future `build`/`writer` profile must not merely add `edit` and `write` to the shared working tree. It should require a `WorkspaceProvider` that gives an isolated worktree/container/remote workspace and returns a patch/branch/evidence bundle.

---

# 9. Role/profile strategy

## V1: bundled roles only

Do not make profile discovery part of the first release. Ship `explore` and `review` as ICE-owned TypeScript definitions with fixed prompts, fixed read-only tool sets, and explicit default budgets.

Reasons:

- avoids project/user profile trust and shadowing during the runner's first safety-critical iteration;
- keeps tool schemas stable;
- makes tests deterministic;
- makes the child runtime independent of repository-controlled executable/configuration resources;
- reduces the number of failure surfaces while cancellation, lineage, and result semantics are being proven.

The model may choose among allowed bundled roles, but it may not submit arbitrary system prompts or raw permission lists.

## V2: trusted configurable profiles

After the V1 runner is stable, add deterministic user/project profile discovery if measured use cases justify it.

Recommended source order:

1. ICE bundled profiles;
2. trusted user profiles;
3. trusted project profiles only after project trust is established.

Every non-bundled resolved profile must carry provenance:

```text
name, source, sourcePath, sourceHash, trusted
```

A project file must never silently shadow a trusted user/bundled profile. Revalidate the selected profile immediately before execution because files may change after discovery. Unknown, disabled, untrusted, or disallowed profiles fail before child creation.

---

# 10. Lifecycle, cancellation, and budgets

## State machine

```text
created -> running -> completed
                  -> failed
                  -> cancelled
                  -> timed_out
                  -> verification_failed
```

`completed` means the child finished successfully. It does **not** mean the parent accepted its claims.

## Cancellation

Parent/user abort must:

1. mark the run cancellation-requested;
2. abort the child runner;
3. wait for child idle/exit;
4. retain bounded partial output/evidence;
5. transition exactly once to `cancelled` unless a stronger terminal failure was already recorded.

For a subprocess backend, retain graceful termination followed by forced kill. For native `AgentSession`, call `abort()` and await `waitForIdle()`.

## Budgets

MVP should have hard caps for at least:

- wall-clock timeout;
- parent-visible output bytes;
- maximum active children = 1.

Add request/turn/token budgets where the native accounting surface is reliable. Budget exhaustion should produce a typed terminal/partial result, not generic text.

Do not auto-retry an interrupted child unless the failure is explicitly classified as transient and retry-safe.

---

# 11. Events and observability

The parent/TUI should not need to render the full child transcript.

Recommended bounded events:

```text
subagent_created
subagent_started
subagent_progress
subagent_tool_start
subagent_tool_end
subagent_completed
subagent_failed
subagent_cancelled
subagent_timed_out
```

Every event carries `runId`, `parentSessionId`, and `childSessionId` where available.

Progress payload should be intentionally small:

- profile;
- phase/latest operation label;
- elapsed time;
- request/token counters if known;
- capped output tail;
- no unbounded tool result body.

Later, the TUI can render a collapsible task tree. The event contract should be usable equally by interactive, JSON, and RPC modes.

---

# 12. Parent-side verification

A child is a worker, not an authority.

Before integrating a child result, the parent verifies applicable claims against actual state.

Minimum gate:

1. run ID and parent linkage match the active record;
2. terminal status is acceptable;
3. result is within schema/size limits;
4. referenced paths normalize inside allowed scope;
5. claimed files/evidence exist where applicable;
6. repository checks run against real state when required;
7. unresolved risks are retained rather than rewritten away.

For read-only workers, verification mostly means checking evidence and cited paths.

For future writers, parent verification must inspect the actual patch/branch and run required tests. Model prose must never be accepted as proof of mutation or test success.

---

# 13. MVP boundary

## Include

- one foreground child at a time;
- one ICE-only `delegate` tool;
- bundled TypeScript `explore` and `review` roles only;
- fresh native child `AgentSession` with `SessionManager.inMemory()`;
- `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, and `noContextFiles` enabled for the child;
- bundled role system prompt injected explicitly;
- strict child `read`/`grep`/`find`/`ls` allowlist intersected with `ice.getActiveTools()` and runtime policy;
- no child delegation tool;
- explicit model override through existing model catalog;
- parent-child/run IDs;
- bounded progress;
- cancellation propagation;
- wall-clock timeout;
- bounded structured result;
- parent verification step;
- unit/integration tests.

## Explicitly exclude

- autonomous swarm/planner;
- recursive agent trees;
- parallel children;
- chain mode;
- shared-tree writer agents;
- worktree merging;
- background/detached jobs;
- remote workers;
- durable database registry;
- implicit project-agent trust;
- implicit Cognee sharing;
- unrestricted Bash/network/MCP inheritance;
- full child transcript injection.

This narrow first slice is intentional. It proves the contract before adding fan-out and mutation complexity.

---

# 14. Expansion path after MVP

## Phase 2 — configurable roles, context, observability

- explicit context attachments/artifact refs;
- trusted user/project role overrides with provenance, precedence, and revalidation;
- selectively re-enable safe child resources only when a concrete use case and tests justify them;
- richer progress/event rendering;
- usage accounting;
- optional child compaction policies;
- optional scoped Cognee read access;
- continuation/resume only after run IDs are stable.

## Phase 3 — parallel and chain execution

- bounded worker semaphore;
- submitted-task cap;
- deterministic result ordering;
- partial batch results;
- abort stops new scheduling;
- chain receives only bounded previous result, never raw transcript;
- cost/usage aggregation.

Read-heavy independent tasks are the first valid fan-out use case.

## Phase 4 — isolated writer workers

Introduce a `WorkspaceProvider` abstraction:

```text
create(run) -> isolated workspace
capture(run) -> patch/branch + changed paths
cleanup(run)
```

Potential backends:

- Git worktree;
- container;
- remote workspace.

Parent owns patch inspection, tests, conflict resolution, and merge/apply.

## Phase 5 — background/durable jobs

Only after the run contract is stable:

- durable registry;
- owner-scoped cancel;
- completion notification;
- status/list APIs;
- restart recovery;
- retention policy;
- resume semantics;
- task tree UI.

Background is a lifecycle feature, not `background: true` on the MVP runner.

---

# 15. Failure modes to design against

## Context contamination

Failure: child receives too much parent transcript or dumps its transcript back.

Control: explicit handoff + compact result envelope.

## Capability escalation

Failure: child role enables Bash/network/write/delegation because those tools exist in the parent process.

Control: hard allowlist intersection and explicit deny.

## Project prompt/extension trust escalation

Failure: child `cwd` causes user/project agents, extensions, skills, templates, themes, or context files to influence execution unexpectedly.

Control in V1: disable all of those resource classes in the child loader and inject only the bundled role prompt. Project trust/profile discovery is therefore not on the V1 execution path. V2 may selectively re-enable trusted resources with provenance and tests.

## Recursive explosion

Failure: worker can call the delegation tool and fan out recursively.

Control: delegation tool absent from MVP child allowlists. Later add explicit `maxDepth`.

## Shared-tree write races

Failure: parallel agents edit the same checkout.

Control: no writers before isolated workspace provider; no parallel mutation in shared tree.

## Orphan work

Failure: parent stops while child continues.

Control: owner-scoped abort, await terminal state, shutdown cleanup.

## Output/context explosion

Failure: child returns enormous logs/transcript.

Control: bounded summary + artifact storage + truncation metadata.

## False success

Failure: child says tests passed or files changed when they did not.

Control: structured evidence + parent verification against actual state.

## Hidden cost amplification

Failure: fan-out multiplies tokens/API requests unexpectedly.

Control: single-child MVP, explicit budgets, later aggregate usage and concurrency caps.

---

# 16. Required test matrix

## MVP tests

- child session starts with empty/fresh conversation history;
- selected handoff context is present and unrelated parent history is absent;
- child loader has `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, and `noContextFiles` enabled;
- user/project extension hooks do not run in the child;
- `ice-cognee`, `ice-safe-verify`, Blackhole extensions, and `delegate` are absent from the child runtime;
- `tools` allowlist prevents non-role tools from entering the child registry;
- parent active-tool removal removes the same capability from the child;
- child cannot call `delegate` in MVP;
- only bundled `explore`/`review` roles resolve in V1;
- model override resolves exactly or fails clearly;
- parent cancellation reaches child and settles deterministically;
- timeout produces `timed_out`, not generic `failed`;
- partial output is marked on cancellation/timeout/truncation;
- result summary obeys byte cap;
- full child transcript is not appended to parent history;
- child failure cannot be presented as parent success;
- event ordering includes stable lineage IDs;
- child compaction/history does not mutate parent history;
- concurrent unrelated parent worktree changes remain untouched.

## Later parallel tests

- active worker cap is enforced;
- one worker failure does not erase settled sibling results;
- abort stops new scheduling;
- output ordering is deterministic;
- aggregate usage is correct.

## Later writer tests

- each writer receives a separate workspace;
- changed paths come from filesystem/Git observation, not model claims;
- patch capture works for success and partial failure;
- cleanup is idempotent;
- parent refuses unverified patch integration;
- conflicts are surfaced, never silently resolved by last writer wins.

## Later background tests

- jobs survive parent turn completion according to policy;
- owner cancellation works after reconnect;
- duplicate completion delivery is idempotent;
- restart recovery produces a valid terminal/running state;
- retention cleanup never deletes an active job.

---

# 17. Recommended first implementation sequence

1. Define `SubagentProfile`, `SubagentRequest`, `SubagentRun`, `SubagentResult`, and status/error codes.
2. Implement bundled TypeScript `explore` and `review` roles only.
3. Register a hidden ICE `delegate` extension through `ice.ts` and add `delegate` to the appropriate `ice-safe-verify` active-tool lists.
4. Implement capability derivation from `ice.getActiveTools()` intersected with the role/runtime allowlist.
5. Construct the V1 child loader with `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, and `noContextFiles`, plus an explicit bundled role system prompt.
6. Build the native `AgentSession` runner with `SessionManager.inMemory()` and the existing `ModelRuntime`.
7. Add timeout + parent abort propagation.
8. Normalize child events into bounded subagent events.
9. Produce the structured result envelope with output cap and partial-state semantics.
10. Add parent-side verification helpers.
11. Add offline unit tests and a faux-provider integration fixture, including negative tests proving disabled child resources do not execute.
12. Only after those pass, benchmark native-session versus subprocess execution and decide whether a second backend has enough value to maintain.
13. Treat custom profile discovery, selective resource inheritance, and profile trust as V2 work rather than MVP prerequisites.

---

# 18. Adjacent ICE systems

## Guarded build

Subagents should strengthen, not bypass, ICE's guarded build model.

- planning/review workers can gather evidence;
- the parent remains the approval/verification authority;
- future writer workers return isolated patches for parent review;
- no child should implicitly transition the parent from plan to build mode.

## Model catalog / ICE provider

- role model selection should use the existing model runtime/catalog;
- provider-specific implementation details stay below the subagent layer;
- a profile may request an exact model, but policy can reject or replace it;
- missing auth must fail predictably before expensive child startup.

## Blackhole

- child compaction is child-local;
- parent never consumes a raw child compaction transcript;
- only the bounded final result/evidence crosses the boundary;
- Blackhole remains compatible because it operates inside a session rather than becoming the orchestration layer.

## Cognee

Existing ICE Cognee work remains orthogonal. Child memory sharing must be explicit and least-privilege; the subagent runtime should work correctly with Cognee disabled.

---

# 19. Decisions now considered strong enough to lock

1. **Parent remains authoritative.**
2. **The model-facing tool name is `delegate`, and it is ICE-only.**
3. **Fresh native child `AgentSession` context is the default.**
4. **One foreground read-only child is the MVP.**
5. **`explore` and `review` are bundled TypeScript roles; custom profile discovery is V2.**
6. **V1 child resource discovery is off: no extensions, skills, templates, themes, or context files.**
7. **`ice-safe-verify` remains parent mode authority; child tools are derived from `ice.getActiveTools()` and narrowed by role/runtime policy.**
8. **The V1 child tool floor is only `read`, `grep`, `find`, and `ls`; no Bash, network, MCP, mutation, memory adapter, or delegation.**
9. **Tool/capability intersection is deny-first and non-escalating.**
10. **Recursive delegation is disabled in MVP.**
11. **Result is typed, bounded, and treated as evidence.**
12. **Cancellation and timeout are first-class terminal states.**
13. **Parallel fan-out waits until the single-child contract is proven.**
14. **Writer agents wait for workspace isolation.**
15. **Background work waits for durable job semantics.**
16. **Model routing reuses ICE's existing model runtime.**
17. **Parent/child memory and compaction remain isolated unless policy explicitly bridges them later.**
18. **The implementation preserves Ice's loop and uses extension/tool seams rather than creating a competing orchestrator.**
19. **Native `AgentSession` execution is the preferred MVP backend; subprocess execution is retained only as a reference/fallback until a benchmark proves it deserves ongoing maintenance.**

---

# 20. Open design questions for implementation, not blockers for planning

The broad V1 architecture is now locked. Remaining questions should be answered by tests/prototypes:

- Which stable session identifier should be exposed as `parentSessionId`/`childSessionId` for in-memory children?
- Should the handoff packet be rendered as one structured user message or split between explicit role system prompt plus bounded task/evidence instructions?
- Where should full-but-bounded child artifacts live if parent-visible output is truncated?
- Which usage counters are reliable enough for an MVP hard request/token budget versus observability-only accounting?
- Should child core auto-compaction inherit normal Ice settings or use a tighter worker-specific setting for long read tasks?
- After the native runner is proven, is a subprocess backend valuable enough to maintain for process isolation/CLI compatibility?
- In V2, which resource classes should be selectively re-enabled first, if any, and under what trust/provenance rules?

These questions do not change the core architecture above.

# 21. W1-W11 executable acceptance ledger

This ledger closes the deterministic evidence-traceability gap without adding production code, duplicate tests, or new behavior. It records the current `HEAD` (`7cbd8a676815cbfef3b03a4902269ede2ac2fbf1`) and a dirty worktree containing unrelated/concurrent changes; results were captured against that tree.

All Vitest commands below ran from `packages/coding-agent`.

| Scope | Existing acceptance evidence | Command/result | Status |
|---|---|---|---|
| W1 isolated writer foundation | `ice-subagents.test.ts`: clean/dirty HEAD gates, base SHA validation, detached worktree, scoped tools, confinement, cleanup, parent preservation | C1: 7 files, `263/263`, exit 0 | PASS / FROZEN |
| W2 bounded writer artifacts | `ice-subagents.test.ts`: status inventory, artifact hashes, object-store isolation, CRLF consistency, caps, failed-writer proposal suppression | C1: `263/263`, exit 0 | PASS / FROZEN |
| W3 parent integration and rollback | `ice-subagents.test.ts`, `ice-subagents-adversarial.test.ts`, `ice-safe-verify.test.ts`: preimage/inventory/apply gates, verifier failure, rollback and conflict preservation | C1: `263/263`, exit 0 | PASS / FROZEN |
| W4 proposal workflow | Writer workflow tests: canonical artifact path, inspect/reject/integrate, mandatory verifier, reuse, verifier failure and rollback | C1: `263/263`, exit 0 | PASS / FROZEN |
| W5A automated writer hardening | `ice-writer-w5.test.ts`: Faux success, multi-file changes, rejection/reuse, tampering, path/symlink/cap attacks, stale/dirty parents, verifier failure, rollback conflict, cancel/timeout | C1: `263/263`, exit 0 | PASS / FROZEN |
| W5B live provider certification | `examples/w5-writer-dogfood.ts` supports `cx/gpt-5.6-luna` and `cx/deepseek/deepseek-v4-flash`; no live JSONL result was supplied | C5a/C5b: NOT RUN; external evidence required | PENDING EXTERNAL CERTIFICATION |
| W6 observatory/TUI | `ice-subagent-observatory.test.ts` and related tests: lifecycle snapshots, rendering/redaction, writer phases, command aliases, update isolation | C1: `263/263`, exit 0 | PASS / FROZEN for deterministic implementation |
| W7.1 one-owner durable job | `ice-subagent-jobs.test.ts`: persist-before-launch, owner isolation, cancellation/shutdown settlement, stale restore, notification ordering, retention | C1: `263/263`, exit 0 | PASS / FROZEN |
| W7.2 bounded job scheduling | Jobs tests: FIFO queue, active/queue caps, aggregate reservations, queued cancellation, exact release, fail-closed persistence, shutdown/restore | C1: `263/263`, exit 0 | PASS / FROZEN |
| W8.1 durable observatory metadata | Jobs/observatory tests: post-persistence subscription, active/FIFO/terminal projection, bounded metadata, no result bodies | C1: `263/263`, exit 0 | PASS / FROZEN |
| W8.2 terminal result inspection | Observatory/subagent tests: terminal-only inspection, frozen bounded projection, invalid-path rejection, no scheduler/session mutation | C1: `263/263`, exit 0 | PASS / FROZEN |
| W8.3 completion inbox | Observatory/subagent tests: persisted metadata validation, deduplication, ordering, cap, frozen-on-open behavior, no result-body reads | C1: `263/263`, exit 0 | PASS / FROZEN |
| W9 unsafe host execution | `ice-subagents.test.ts`, `ice-safe-verify.test.ts`, `ice-delegate-mvp.test.ts`: startup/runtime gates, trust/Bash checks, interactive TUI confirmation or RPC startup authorization, best-effort cancellation warning, post-launch recheck, no retry for unsafe runs, async/batch/review enablement, duplicate-flag rejection | Targeted RPC regressions: `3/3`; headless rejection: `1/1`; exit 0 | PASS / CONTRACT-HARDENED / NOT A SANDBOX |
| Milestone 10 parent verification | Lineage, terminal status, non-partial completion, evidence bounds, path scope, unresolved review claims | C2: 2 files, `181/181`, exit 0 | VERIFIED |
| Milestone 11 Faux integration | Real `iceSubagents` factory: registration, context isolation, gates, completion, review claims, cancellation, foreground/async timeout, `--sub-yolo`, confirmed unsafe review/batch delegation | C3: 1 file, `9/9`, exit 0 | VERIFIED for deterministic Faux path |

## 21.1 Canonical command records

- **C1:** `cd packages/coding-agent && npx vitest run test/ice-subagents.test.ts test/ice-subagents-adversarial.test.ts test/ice-safe-verify.test.ts test/ice-writer-w5.test.ts test/ice-subagent-jobs.test.ts test/ice-subagent-observatory.test.ts test/ice-delegate-mvp.test.ts --testTimeout=60000` -> 7 files passed, `263/263`, exit 0.
- **C2:** `cd packages/coding-agent && npx vitest run test/ice-subagents.test.ts test/ice-safe-verify.test.ts` -> 2 files passed, `181/181`, exit 0.
- **C3:** `cd packages/coding-agent && npx vitest run test/ice-delegate-mvp.test.ts --testTimeout=60000` -> 1 file passed, `9/9`, exit 0.
- **C4:** targeted Biome on the seven ICE test files -> clean, exit 0; standalone Biome on all 12 benchmark TypeScript files -> clean, exit 0; `git diff --check` -> no diagnostics, exit 0.
- **C4 root check:** `npm run check` reaches only the inherited `packages/ai/test/openai-completions-tool-choice.test.ts:1410` `maxTokensField` TypeScript error; no new ICE diagnostic is present.
- **C5a/C5b:** W5B live-provider routes are documented but not run; no certification result is claimed.

This ledger separates implementation closure, deterministic/local acceptance, and external production-provider certification. No roadmap W10-W13 capability work is implemented or claimed; M12/M13 are Milestone names, not roadmap W12 work.

# 22. M12-M13 executable acceptance ledger

Status: **M12 COMPLETE / VERIFIED / FROZEN; M13 COMPLETE / VERIFIED / FROZEN**. The old artifacts below remain historical and are not canonical. The production native-only policy remains unchanged.

The repaired harness uses the existing `NativeSubagentRunner` for both adapters and records typed resource-loader and CLI contract vectors, startup metrics, honest end-RSS availability, memory summaries, cleanup, and maintenance rationale. `m13:verify` consumed exactly the four full-budget M12 runs, then executed C1/C2/C3 and recorded observed counts, exit codes, Git SHA, and dirty-worktree qualification.

| Scope | Artifact | Result | Status |
|---|---|---|---|
| Historical M12/M13 run set | `.artifacts/m12/2f72fc84-edc3-4635-95bc-d08bd2b1e0a9/`, `.artifacts/m12/67e78886-c006-4b05-9f94-afcb6e9c1843/`, `.artifacts/m12/6a4ec429-ef91-4522-841d-f91dc7bc6cfb/`, `.artifacts/m12/ccaa8af7-2e47-4edf-b05c-f9ceaadaf08d/`, `.artifacts/m13/m13-1786289209293/` | Previous reports used labels-only compatibility evidence and hard-coded C1/C2/C3 counts | HISTORICAL / NOT CANONICAL |
| M12 cold performance | `.artifacts/m12/99f421f8-228b-4137-a44e-092895359713/` | 30 repetitions; schema-v2; all hard gates pass; decision `native-only` | PASS / CANONICAL |
| M12 warm performance | `.artifacts/m12/d6222038-23e7-4ca9-a8ce-1770dc96db37/` | 5 warmups + 100 measured repetitions; schema-v2; all hard gates pass; decision `native-only` | PASS / CANONICAL |
| M12 safety | `.artifacts/m12/67457e73-cd91-452b-b0a0-154ebf94a369/` | 50 repetitions across the exact four safety workloads; terminal/cancellation/orphan/cleanup gates pass | PASS / CANONICAL |
| M12 compatibility | `.artifacts/m12/430338fe-ddb8-45f6-a0ee-fdaaee129df9/` | 3 repetitions with complete resource-loader and CLI contract vectors; compatibility/resource gates pass | PASS / CANONICAL |
| M13 policy | `packages/coding-agent/src/ice-subagents.ts` and `.artifacts/m13/m13-1786296433961/policy.json` | Native default, no fallback, no automatic routing, rollback without state migration | PASS / FROZEN |
| M13 acceptance artifact | `.artifacts/m13/m13-1786296433961/acceptance.json` | Schema-v2; exact four M12 sources; observed C1 `263/263`, C2 `181/181`, C3 `9/9`; exit codes 0; dirty qualification retained | PASS / CANONICAL |

The benchmark is synthetic boundary evidence, not live provider certification. W5B remains `PENDING EXTERNAL CERTIFICATION`; exhaustive B8 matrices remain optional. No roadmap W10-W13 capability work is implemented or claimed.


---

# 23. ICE versus Prime-Agent subagent comparison

_Last reviewed: 2026-08-11. Read-only comparison of the local `agent_references/prime-agent` checkout against the current ICE tree. The reference checkout was not modified and live-provider certification is not claimed._

## Executive verdict

Prime-Agent is the stronger **live recursive agent runtime**. ICE is the stronger **bounded delegation, verification, and mutation-integrity layer**. Prime-Agent wins dynamic orchestration; ICE wins constrained reproducibility and evidence-backed execution.

- Overall capability: **Prime-Agent 8.8/10; ICE 7.5/10**.
- Safety/reliability fit for ICE’s stated goals: **ICE 9.0/10; Prime-Agent 8.0/10**.
- This is not a universal product ranking: the scores weight different objectives.

## Evidence reviewed

### ICE

- `idea.md`: ownership boundaries, safety rules, frozen phases, explicit non-goals, and deferred recursion/background capabilities.
- `packages/coding-agent/src/ice-subagents.ts`: roles, scopes, resource provenance, context packets, fork sanitization, native sessions, writers, batches, reviews, recovery, observability, and tool registration.
- `packages/coding-agent/src/ice-subagent-jobs.ts`: durable jobs, FIFO queueing, owner budgets, cancellation, interruption, persistence, projections, and retention.
- `packages/coding-agent/src/ice-subagent-observatory.ts`: bounded progress/workflow snapshots, redaction, result inspection, and completion metadata.
- `packages/coding-agent/src/ice-agent-packs.ts`: bounded Ruflo role import, frontmatter checks, source hashing, conflict handling, and limits.
- ICE tests: `ice-subagents*.test.ts`, `ice-subagent-jobs.test.ts`, `ice-subagent-observatory.test.ts`, and `ice-delegate-mvp.test.ts`.

### Prime-Agent

- `packages/coding-agent/src/core/agent-session-runtime.ts`: top-level/subagent runtime ownership, nested runtimes, child creation/deletion, and cleanup.
- `packages/coding-agent/src/core/rlm-runtime.ts`: spawn handles, child registry/list/delete APIs, model matching, and runtime host contracts.
- `packages/coding-agent/src/core/agent-messages.ts`: parent/child/sibling topology, message delivery, receipts, limits, rate limiting, and reachability authorization.
- `packages/coding-agent/src/core/agent-observe.ts`: agent listing, snapshots, and bounded recent-message inspection.
- `packages/coding-agent/src/core/prompts/rlm.ts`: model-facing runtime, messaging, observation, and cleanup doctrine.
- `packages/coding-agent/src/core/rlm-max-depth.ts`: configurable recursion-depth state.
- `packages/coding-agent/src/modes/agents-view/` and `modes/daemon/daemon-supervisor*.ts`: interactive views, session persistence, process supervision, ownership, and recovery infrastructure.
- Tests: recursion, family messaging, observe skill, message skill, and observe-session suites.

## Overall rating table

Ratings measure capability fit for each dimension, not line count or implementation quality.

| Dimension | ICE | Prime-Agent | Winner | Reason |
|---|---:|---:|---|---|
| Basic delegation | 8.5 | 8.5 | Tie | Both use native Ice child-session/runtime seams. ICE has stronger result contracts; Prime-Agent has stronger live lifecycle. |
| Typed results/evidence | 9.5 | 7.5 | ICE | Bounded schemas, evidence paths, findings, verification, provenance, and contradiction preservation. |
| Verification/correctness gates | 9.0 | 7.5 | ICE | Parent verification is authoritative; observed artifacts override model claims. |
| Writer isolation/patch integrity | 9.5 | 7.5 | ICE | Worktrees, scoped tools, hashes, preimages, non-fuzzy integration, rollback, and conflict detection. |
| Safety/authority boundaries | 9.0 | 8.0 | ICE | Read-only defaults, capability narrowing, disabled child resources, fixed recursion boundary, fail-closed paths. |
| Durable bounded jobs | 9.0 | 8.5 | ICE | Owner scope, FIFO queue, reservations, persistence-before-promotion, interruption, retention, bounded projections. |
| Recursive delegation | 5.0 | 9.5 | Prime-Agent | Nested RLM runtimes and descendant cleanup; ICE explicitly disables recursion. |
| Live parent/child messaging | 4.5 | 9.5 | Prime-Agent | Family-scoped messaging, queueing, steering/follow-up, receipts, limits, and authorization. |
| Live child observation | 6.5 | 9.0 | Prime-Agent | Live snapshots and recent messages versus ICE progress/terminal projections. |
| Foreground lifecycle control | 6.5 | 9.0 | Prime-Agent | List, inspect, delete, retain, cancel, and nested cleanup. |
| Daemon/session persistence | 6.5 | 9.5 | Prime-Agent | Persistent live runtime/session fabric versus ICE durable job metadata/results. |
| Subagent UI/operations | 7.0 | 9.0 | Prime-Agent | Agents views, messages, hierarchy, and session navigation. |
| Depth/model routing | 5.5 | 9.0 | Prime-Agent | Configurable `/rlm-max-depth` and model matching versus exact-parent-model/fixed-depth policy. |
| **Overall capability** | **7.5** | **8.8** | **Prime-Agent** | Broader live orchestration. |
| **Safety/reliability fit** | **9.0** | **8.0** | **ICE** | Narrower authority and stronger evidence/integration gates. |

## Where Prime-Agent wins

### 1. Recursive delegation and runtime trees

Prime-Agent treats each child as a first-class runtime. A child can create descendants, retain them, inspect them, delete them, forward nested events, and participate in descendant cancellation/cleanup. Runtime metadata includes child/parent identity, runtime kind, model, session name, status, and cleanup state.

ICE’s `delegate`, `delegate_batch`, and `review_batch` are intentionally flat. Child extensions, MCP, and recursive delegation remain disabled. This prevents recursive explosion and preserves one authoritative parent loop, but it cannot naturally express planner -> researcher -> specialist -> reviewer trees.

**Prime-Agent advantage:** dynamic decomposition and multi-level investigations. **ICE advantage:** simpler authority, accounting, cancellation, and testing.

### 2. Live family-scoped messaging

Prime-Agent’s `agent_message` supports parent, child, and sibling addressing, roster discovery, broadcasts, queued delivery, automatic/steer/follow-up modes, receipts, persisted message events, queue limits, message-size limits, rate limiting, and nuclear-family reachability checks.

ICE passes an immutable launch packet and returns a typed result. It has no equivalent live ICE message bus.

**Prime-Agent advantage:** redirect a running child, request clarification, or coordinate siblings without restarting. **ICE advantage:** immutable handoffs are easier to replay, redact, bound, and verify; free-form messages remain untrusted.

### 3. Live rollout observation

Prime-Agent’s `agent_observe` can list agents, inspect a target snapshot, and retrieve bounded recent messages. It reveals what a child is doing, not merely whether a job exists.

ICE’s observatory exposes phases, tool activity, attempts, timing, diagnostics, writer state, durable metadata, terminal results, and completion metadata. It deliberately avoids arbitrary transcript ingestion and steering.

**Prime-Agent wins active debugging and supervision.** ICE wins context minimization and leakage resistance.

### 4. Foreground lifecycle control

Prime-Agent supports direct lookup by ID/name, ambiguity detection, deletion, retained completed children, nested cleanup, cleanup-failure tracking, descendant cancellation, and child-update forwarding.

ICE supports startup/runtime cancellation, timeout, durable-job cancellation, queued cancellation, restart interruption, terminal retention, and owner-only inspection, but not the same general live-child registry.

**Prime-Agent wins** when children are managed as live sessions rather than one-shot calls.

### 5. Configurable recursion depth

Prime-Agent’s `/rlm-max-depth` supports default, environment, global, inherited, and per-chat sources. Tests cover immediate changes, next-turn prompt changes, persistence failure, stale errors, and rollback.

ICE has a fixed non-recursive policy. This is a deliberate non-goal, not an implementation defect.

**Prime-Agent wins flexibility; ICE wins predictability.**

### 6. Daemon-backed live session fabric

Prime-Agent integrates children with daemon supervisors, session catalogs, leases, process supervision, restart/recovery journals, inactive-session visibility, and child update events. Children remain operationally addressable beyond one foreground turn.

ICE persists append-only job snapshots and bounded terminal projections. It intentionally interrupts active work on restart rather than ambiguously relaunching it and does not preserve a general live conversational child through restart.

**Prime-Agent wins reconnection and long-running orchestration.** **ICE’s fail-closed interruption is safer for non-idempotent work.**

### 7. Interactive agents UI

Prime-Agent has agents views, child summaries, message rendering, hierarchy display, inactive-session visibility, session navigation, and daemon-backed updates.

ICE has W6/W8 observatory overlays, full/split transcript views, bounded progress, terminal inspection, durable job sections, and completion metadata. It explicitly defers TUI job actions, live inbox state, steering, queue authority, result ingestion, and auto-resume.

**Prime-Agent wins operational fleet management.**

### 8. Model and depth flexibility

Prime-Agent includes RLM model matching and child model identity. ICE requires delegated children and durable jobs to use the exact current parent `Model` object; per-role routing, fallback models, and arbitrary child model selection are deferred/disallowed.

**Prime-Agent wins specialist routing.** **ICE wins same-model reproducibility and predictable capability/cost accounting.**

## Where ICE matches or wins

### 1. Typed, bounded, evidence-oriented results

ICE’s result types distinguish completed, failed, cancelled, timed-out, and verification-failed states; evidence paths from prose; partial output from trusted completion; attempts; logical task status from aggregate batch status; and model claims from parent verification. Durable projections reject invalid statuses, malformed timestamps, oversized text, invalid paths/findings, inconsistent IDs, and non-terminal snapshots without matching state.

Prime-Agent has strong runtime/session types, but its differentiator is coordination rather than this same evidence-first result boundary.

### 2. Capability narrowing and resource isolation

ICE derives child tools from parent active tools and role/runtime policy. Read-only children use `read`, `grep`, `find`, and `ls`; writers have a separate scoped set. Child extensions, MCP, Cognee/Blackhole/guard extensions, credentials, ambient skills, templates, themes, and context discovery are disabled unless explicitly selected and validated.

Prime-Agent has strong family/depth/runtime controls, but its RLM system is broader: Python skills, messaging, observation, refinement, lifecycle, and recursion are available according to installed capabilities. Prime-Agent therefore has more operational power and a larger authority surface.

### 3. Writer isolation and patch integrity

ICE’s W1-W5 are materially strong in the reviewed writer path: clean-parent and exact-HEAD gates; detached isolated worktrees; scoped tools without Git/Bash/network/delegation; actual Git/filesystem inventory; UTF-8 text-only artifacts; rejection of symlinks, gitlinks, binary/ignored/scope-escaping paths; bounded files/bytes; exact artifact provenance and hashes; preimage/postimage checks; non-fuzzy integration; mandatory verification; rollback conflict detection; and no silent merge/rebase/commit/push.

The local Prime-Agent evidence shows broad workspace/process infrastructure, but does not establish a stronger equivalent to this frozen W1-W5 patch protocol.

### 4. Durable owner-scoped jobs

ICE’s W7.1/W7.2 provides one owner-scoped durable read-only job with append-only snapshots, persistence-before-promotion, owner-only inspection/cancellation, active/queued limits, FIFO admission, aggregate output reservations, deterministic queued cancellation, restart interruption, terminal retention, and bounded verified projections.

Prime-Agent wins persistent live sessions; ICE wins this narrower bounded-job contract.

### 5. Immutable handoffs, fork sanitization, and redaction

ICE’s B5/B6.1 context packets and fork snapshots are immutable, bounded, redacted, UTF-8-safe, and separate from child transcript state. It does not clone the entire parent branch or blindly inject history.

### 6. Bounded typed recovery

ICE’s B7.1 permits two total attempts only for explicitly classified transient startup/provider failures, reusing the immutable request/context, aggregating usage/output, recording provenance, and avoiding fallback model selection. This is less flexible but stronger for deterministic review.

## Capability versus safety scorecard

| Evaluation lens | ICE | Prime-Agent | Interpretation |
|---|---:|---:|---|
| Feature breadth | 7.5 | 9.5 | Prime-Agent exposes substantially more live orchestration. |
| Live collaboration | 5.5 | 9.5 | Messaging, observation, recursion, and steering dominate in Prime-Agent. |
| Bounded reproducibility | 9.5 | 7.5 | ICE has immutable contracts, same-model policy, and bounded retries. |
| Evidence/verification | 9.5 | 7.5 | ICE makes observed artifacts authoritative. |
| Mutation safety | 9.5 | 7.5 | ICE’s reviewed writer protocol is narrowly stronger. |
| Default authority minimization | 9.0 | 8.0 | ICE starts narrower and keeps expensive capabilities opt-in. |
| Long-running orchestration | 7.0 | 9.5 | Prime-Agent’s daemon/session runtime is more complete. |
| Operational debugging | 7.0 | 9.0 | Prime-Agent adds transcript observation and mature agent views. |
| Cost/control predictability | 9.0 | 8.0 | Exact model, aggregate budgets, and bounded attempts favor ICE. |
| Architecture fit for ICE | 9.5 | 7.5 | Copying Prime-Agent wholesale would conflict with ICE’s minimal-loop direction. |

## Recommended ICE improvements based on Prime-Agent wins

### Priority 1: bounded live observation

Add a read-only API over the existing live-session registry for direct-child listing, status/phase/model/tool-count/timing inspection, and capped recent transcript previews. Enforce owner/parent-child scope, preserve redaction/byte caps, and never inject observation output into trusted result state automatically.

### Priority 2: controlled parent follow-up

Allow a parent to send a new bounded follow-up to a running child while preserving the original immutable launch contract. Cap count/bytes/rate; keep permissions, model, workspace, and trust unchanged; define cancellation/follow-up races deterministically.

### Priority 3: explicit depth policy before recursion

Define inherited/per-task depth, descendant count, aggregate output/token/time budgets, duplicate-task detection, and cleanup guarantees before enabling recursion. Default depth should remain `0` or `1`.

### Priority 4: family-scoped messaging only if needed

If sibling collaboration is justified, allow only parent/child/sibling routes with bounded size/count/rate, receipts, persisted events, and untrusted-data semantics. No messages should mutate policy or become trusted results without verification.

### Priority 5: retain the current job/daemon boundary

Do not replace the durable job registry with live daemon children until evidence shows interruption/reconnect is insufficient. Any future live daemon layer needs ownership/leases, descendant cleanup, credential lifetime rules, restart state transitions, retention/redaction, and deterministic cancellation races.

## What not to copy

- Do not add a second planner/controller or replace Ice’s authoritative loop.
- Do not enable recursion by default.
- Do not expose unrestricted cross-session messaging.
- Do not inject raw child transcripts into parent history.
- Do not silently inherit extensions, skills, MCP, credentials, or network access.
- Do not add automatic model fallback solely for feature parity.
- Do not auto-resume interrupted non-idempotent work.
- Do not treat multiple model reports as proof without deterministic verification.
- Do not claim sandboxing from session lineage alone.
- Do not turn `/agents` into job-management authority without ownership and race semantics.

## Final comparison

| Question | ICE | Prime-Agent |
|---|---|---|
| Bounded child investigation? | Yes, with typed evidence and parent verification. | Yes, with native runtime/session management. |
| Recursive descendants? | No, intentionally disabled/deferred. | Yes, with RLM/depth controls. |
| Live parent/child communication? | No equivalent ICE message bus. | Yes, family-scoped `agent_message`. |
| Live transcript inspection? | Progress/terminal observatory, not equivalent recent-message inspection. | Yes, via `agent_observe`. |
| Cancel/delete live child? | Cancellation exists; retained live-child deletion is narrower. | Yes, with runtime deletion/cleanup. |
| Daemon reconnect? | Durable metadata/results; active work interrupts on restart. | Yes, daemon-supervised runtime/session infrastructure. |
| Safe writers? | Isolated worktrees and parent-owned patch integration. | Broad workspace/runtime support; no stronger local patch evidence. |
| Trusted output by default? | No; verification mandatory. | Messages/results remain model-generated and should be treated as untrusted. |
| Dynamic agent fleets? | Not currently. | Yes. |
| Auditable bounded mutation? | Yes, particularly W1-W5. | Not demonstrated as stronger in the reviewed evidence. |

## Final conclusion

> **Prime-Agent is the stronger live multi-agent runtime; ICE is the stronger controlled delegation and verification layer.**

Prime-Agent’s clearest wins are recursive runtime trees, family messaging, live observation, child lifecycle control, configurable depth/model routing, daemon-backed persistence, and operational UI. ICE’s clearest wins are typed evidence, parent-owned verification, capability/resource narrowing, immutable context boundaries, bounded recovery, durable owner-scoped jobs, and isolated writer patch integrity.

The highest-value parity work is bounded live observation followed by controlled parent follow-up. Recursive delegation, family messaging, and daemon-backed live persistence should remain opt-in and gated by measured need, aggregate budgets, ownership, redaction, and deterministic recovery tests.

---

# 22. Cognee review (2026-08-12)

Implementation follow-up (2026-08-13): `agent_docs/ice-cognee-compaction-benchmark-2026-08-13.md`. Items 1–4 plus lastRecallKey TTL, Blackhole minimal tail, and `$project` datasets are implemented. Split read/write circuits and jsonl rotation remain open.

Full write-up (architecture, ranked defects, live install/config inventory, redacted):  
`agent_docs/ice-cognee-findings-2026-08-12.md`

Read-only review of `ice-cognee.ts`, `ice-cognee-client.ts`, `ice-cognee-env.ts`, `ice-cognee-observer.ts`, `docs/ice-cognee.md`, `docs/compaction.md`, Ice compaction hooks, and `test/ice-cognee.test.ts`, plus live files under `~/.ice/agent/ice-cognee`, `~/.cognee`, `~/.cognee-plugin`, and `/home/mewtwo/Zykairotis/cognee`. Other models listed dead env keys, stale `lastRecallKey`, unbounded `observations.jsonl`, bash `"cognee"` substring exclusion, and doctor latency. Those are real but not the highest-value defects.

Live snapshot 2026-08-12: API `127.0.0.1:8211` Cognee 1.4.0 healthy; `ice` dataset `ice`; Claude dataset `agent_sessions`; `captureTools` already off; Blackhole package installed so `auto` defers on this host; native compaction `enabled: false`; `observations.jsonl` 7.99 MB / 15,114 lines; `sessions/` 7,504 write-only files.

## How Cognee compaction actually works

Ice owns the compact trigger and session rewrite. Extensions may supply the summary via `session_before_compact`; last non-cancel result wins (`runner.ts` last-writer-wins). If no extension returns `compaction`, native `compact()` writes the structured Goal/Constraints/Progress/Decisions/Next-Steps summary.

Cognee then:

1. `session_before_compact`: if `shouldOwnCompactionSummary` is true, three parallel recalls (`session`/`trace`/`graph`, 4s/4s/6s) become the **Ice compact summary**. If false (Blackhole config present, or mode `defer`), it only stores a local file-ops QA anchor.
2. Native or Blackhole then writes the real summary (when Cognee deferred).
3. `session_compact`: session-cache QA of the final summary + pending-queue `/remember` of that summary (`autoRemember: "compaction"`).

Default is `compactionSummaryMode: "auto"`. `shouldOwnCompactionSummary("auto", false)` is **true**. Blackhole is optional. So a default `ice` install **without** Blackhole replaces native structured compaction with a recall dump. That contradicts `docs/compaction.md` ("Cognee does not trigger or implement compaction") and `idea.md` (Ice owns compaction; Cognee is a derived-memory adapter).

`own` does not read `preparation.messagesToSummarize`. It queries Cognee with `previousSummary ?? reason`. That is not a conversation summary.

Recall injects a `customType: "ice-cognee-recall"` message. `before_agent_start` messages persist as `custom_message` session entries (`docs/extensions.md`, `agent-session.ts` `message_end`). `convertToLlm` sends them as user text. They therefore consume tokens every later turn, enter `messagesToSummarize`, land in the compact summary, get queued as permanent remember, and can be recalled again (echo loop).

Compact then next prompt is racy: `_checkCompaction` runs **before** `before_agent_start`. `storeEntry` is fire-and-forget, so the first post-compact recall often misses the checkpoint it just created.

## Ranked defects (highest value first)

1. **Recall is persistent session history, not transient context.** Inject via turn-scoped `systemPrompt` append, or otherwise keep it out of `custom_message` entries.
2. **Default `auto` without Blackhole steals compaction.** `auto` should always defer. Keep `own` explicit. If `own` remains, summarize `messagesToSummarize` (+ previousSummary/fileOps); never replace the chat checkpoint with three recall dumps. Skip network on `reason === "overflow"` / `willRetry`.
3. **First post-compact prompt misses the checkpoint.** Keep `lastCompactSummary` in runtime and prepend it to the next recall inject; optionally await the session-cache write in `session_compact`.
4. **Idle improve races in-flight capture.** `agent_settled` fires `runImprove` without waiting for `storeEntry`. Shutdown already `waitForBackground()`. Stamp `lastImproveAt` on completion, not dispatch (audit #4).
5. **`lastRecallKey` is set before success** and never expires. A failed recall permanently skips the same prompt, including after circuit cooldown.
6. **One circuit for recall and remember.** Recall timeouts can pause compaction remember.
7. **Capture flood.** Every `read`/`grep`/`ls`/`find` is posted. The bash `"cognee"` substring is real but smaller; per-turn trace cap or write/edit/bash-only default is the real capture fix. `/cognee` commands are slash commands, not tools — they never hit `tool_result`.
8. **Precompact QA is noise** when deferring (file-list dummy QA). The useful write is the post-compact checkpoint.
9. **`rebuildClient` drops `maxResponseChars` to `recallMaxChars`** after any `/cognee` toggle.
10. Hygiene already listed: unused `COGNEE_RECALL_TIMEOUT`/`BUDGET`; unbounded `observations.jsonl` and `warmup/`; session-map write-only; `enqueuePendingRemember` `.tmp` leak (audit #3); `saves.prompt` increments before a write.

Do not start with recall retry/backoff or doctor per-scope hits. Those add latency or UI without fixing the compaction/session contract.
