# ICE Subagent V2 Rewrite Plan

Status: approved design; planning artifact only, nothing in this document is implemented by this edit
Date: 2026-10-07
Base: integration/all-worktrees-experimental at 2d38c5ad5
User direction: clean-break V2; Claude Code + Prime Agent logic/UI, OMP-style operational UX, Codex-style subagent control UX
Reference root: /home/mewtwo/Zks/ice/Agent_harness_references
Target implementation root: packages/coding-agent/src/subagents/

### Progress

| Phase | Status | Notes |
|---|---|---|
| 0 | Done | `idea.md` V2 section; `Plan/subagent-v2-regression-ledger.md`; type-only contracts in `src/subagents/{definitions,contract,registry,permissions,api}` + `test/subagents-v2-contracts.test.ts` |
| 1.1 | Done | Result modules moved to `src/subagents/results/` (move-only) |
| 1.2 | Partial | `ice-subagent-concurrency.ts` moved to `subagents/registry/admission.ts`. Renaming its interfaces off legacy job/run IDs is deferred to P5.4/P5.5, because it changes behavior-bearing names |
| 1.3 | Done | `ice-subagents.ts` split into 21 modules under `src/subagents/` by a checker-driven codemod. 524 declarations verified token-identical except added `export` (one format-only rewrap) |
| 1.4 | Partial | Observatory and transcript components moved to `subagents/ui/`. `ice-agent-view-bridge.ts` and `subagent-view-switcher.ts` stay as interactive-mode integration points until P8 |
| 1.5 | Done | `ice-subagents.ts` is a 79-line re-export barrel. Satellite modules moved under `subagents/` too. Largest remaining files: `legacy-extension.ts` (3.4k lines, the tool registration closure) and `runtime/runner.ts` (2.5k lines, one class) |
| 1 tests | Done | `test/ice-subagents.test.ts` split into 12 themed files + `test/ice-subagents-harness.ts`; 253 cases token-identical; split log in the ledger |
| 2 | Done (not wired) | `src/subagents/definitions/{parse,discover,builtin,precedence,load,listing}.ts` + `test/subagents-v2-definitions.test.ts`. Discovery, parsing, precedence, trust, compat, built-ins, cache, and listing deltas are pure modules. Wiring (listing delta on turn start, reload watcher, settings keys) lands with the V2 tools in P6.0. An invalid higher-precedence file does not block a lower valid one (Claude Code behavior): today all 7 `~/.ice/agents` files fail on `fallbackModel`, so the built-in `explore`/`review`/`worker` would win until they are migrated |
| 3 | Done except P3.4 (not wired) | `src/subagents/permissions/{rules,subjects,evaluate,derive-child,approval}.ts` + `test/subagents-v2-permissions.test.ts`: rule parsing and globs (bare `*` allowed), per-subcommand Bash subjects (redirections are not separators; command substitution never auto-allows), external_directory subjects, fail-safe adapter classes, deny > ask > allow evaluator with plan/review limits, child mutation ceiling with raisers, exhaustive child <= parent check (2,520 cases), gated recursion, approval broker (automated check, foreground prompt, background inbox with timeout, headless/no-channel deny, owner disconnect). Mode presets live in `evaluate.ts#modeLimit` (no separate presets.ts). P3.4 (rebasing the parent gate in ice-safe-verify onto the evaluator with a report-only period) is deferred to the wiring step so the live parent gate is not changed without a comparison run |
| 4 | Done except P4.5 (not wired) | `src/subagents/tools/resolve.ts` (live parent-tool resolver: `*`/names/globs, disallowedTools, management/unknown/non-child-safe exclusion with diagnostics, MCP only via explicit selector, gated delegation tools), `src/subagents/contract/{serialize,validate-resume}.ts` (`ag_`/`agg_` IDs, redacted deep-frozen contract, canonical hash that survives JSON round-trips, hash-checked parse, resume blocks on revoked/changed tools, lost sub-yolo, build-to-plan switch for mutation-capable children, unavailable model, other owner, tombstone; active tools clamped to the frozen set) + `test/subagents-v2-contract-runtime.test.ts`. Contract rules now carry their origin scope; contract records agentMode/parentMode/worktree. `agent`/`agent_control`/`agent_patch` added to the management denylist. P4.5 (removing unsafeHostExec branches) happens when the V2 session factory replaces the legacy one in P5/P6. `redactCredentialText` only covers key=value and Bearer forms; widening it is a separate change |
| 5 | Core done; P5.4/P5.5 pending (not wired) | `src/subagents/registry/{registry,child-sessions}.ts`, `src/subagents/runtime/budgets.ts` + `test/subagents-v2-registry.test.ts`. ChildRegistry: durable accept (flush failure means no launch), generation-checked transitions, owner scoping that hides other owners, detach-before-dispose parking, coalesced revival that can end `blocked` with no turn, stop-before-delete with a durable tombstone ahead of cleanup, crash restore (in-flight turn becomes `interrupted`, resident states park, tombstones stay deleted), at-most-once completion delivery (durable delivered marker before send), subscription-based `waitFor`. Child transcripts are ordinary session files under `<parent-session-dir>/subagents/<parent-session-id>/` whose first entry is the hash-verified contract; interrupted tool calls produce a recovery notice and are never replayed. Optional maxTurns/maxTokens/timeoutMs budgets with one wrap-up turn. P5.4 (retire the legacy live/job/observatory/batch stores) and P5.5 (bind FIFO admission to registry turns) happen with the V2 runner in P6, since they replace live runtime paths |
| 6 | First runnable slice behind the gate | `src/subagents/v2/{settings,session-factory,runtime,extension}.ts`, gate in `ice.ts` (`ICE_SUBAGENTS_V2=1` or global `ice.subagents.v2: true`; legacy and V2 tool sets never load together), V2 keys accepted by the legacy settings parser. Tests: `test/subagents-v2-extension.test.ts`, `test/suite/subagents-v2-runtime.test.ts` (real child AgentSessions through the faux provider: frozen-contract foreground run with durable transcript, child write denied with no approval channel, allowed by interactive approval or authorized sub-yolo, plan parent blocks sub-yolo, background completion delivered once, restart then revive under the frozen contract, revoked parent tool blocks, bad batch launches nothing). Implements P4.5 (one factory, no sub-yolo tool branch), P5.5 (FIFO admission per turn), P6.0-P6.6 for `agent` and `agent_control`. Deferred: `agent_patch` + worktree isolation (P7), batch synthesis/review routing and typed outputSchema/assurance through `agent` (P6.7), Ctrl+B detach (P6.8), in-turn budget enforcement (only limits are frozen today), parent pi-mcp tools for children (only registered delegable adapters today), P3.4 parent gate rebase, Hub (P8). V2 needs a persistent parent session (`--no-session` launches fail with the durable-journal error) |

### Revision 2 (review pass)

The review fixed these gaps and contradictions in revision 1:

1. **Default child policy was undefined.** Under strict monotonicity, a parent in build mode with Bash would hand Bash to every `tools: ["*"]` child with no approval. Today, without `--sub-yolo`, children are read-only. Added section 9.7, which keeps the safe default.
2. **Recursion contradiction.** Section 9.4 always removed management tools, so `spawns` (D18) could never work. Section 9.4 now adds a gated exception.
3. **`fallbackModel` was dropped** although every existing `~/.ice/agents/*.md` file uses it. `model` now accepts an ordered candidate list (sections 7.4 and 23).
4. **The listing delta did not survive compaction.** Section 7.6 now requires a full re-list after compaction, branch switch, and session resume.
5. **No rollout gate.** Old and new tool sets must never both be visible to the model. Added the `ice.subagents.v2` gate (P0.4, P6.0, section 23).
6. **The model-override policy was vague.** Section 12.1 now defines it.
7. **Blocked children and concurrency.** Section 9.6 now covers how a child blocked on approval interacts with `maxConcurrent`.
8. **Isolation vs authority.** Section 14.1 now states that a worktree never creates write authority.
9. Added a "Start here" section (27) for the first implementation session.

---

## 1. Objective

Replace the current ICE subagent internals with one coherent V2 subsystem while preserving the safety, verification, writer, durability, and interactive behaviors already proven in this branch.

The target deliberately combines four reference strengths instead of cloning one harness:

1. **Claude Code for agent definitions and discovery**
   - file-defined agents;
   - frontmatter name as identity;
   - recursive discovery;
   - cwd-to-git-root project lookup;
   - worktree fallback and inode deduplication;
   - deterministic precedence and shadow diagnostics;
   - automatic model-visible agent listing.

2. **Prime Agent for the child-session model and primary UI structure**
   - every child is a real AgentSession with its own persistent session identity;
   - child runtime is derived from the parent runtime envelope rather than created as a competing loop;
   - durable and live session information are reconciled for the UI;
   - the main chat gets a compact child-summary entry and the full agent view is hierarchical, searchable, and directly actionable;
   - parent/child lineage and recursive usage remain observable even when recursion is disabled by default.

3. **Oh My Pi for operational lifecycle and isolation**
   - live child instances can become idle, park, and cold-revive from disk;
   - the resolved runtime contract required for revival is persisted, not merely the transcript;
   - Agent Hub behavior includes transcript focus, steer/follow-up, revive, stop/kill, status, usage, and artifacts;
   - isolated writers inherit the exact dirty parent baseline and return an agent-only delta;
   - patch integration is baseline-aware and conflict-safe.

4. **Codex for explicit control semantics**
   - spawn, message/follow-up/interrupt, wait, resume, and close are distinct lifecycle operations;
   - model-facing status updates are structured;
   - child configuration starts from the live parent configuration;
   - the parent model is inherited by default and overrides are explicit.

ICE remains authoritative for its existing contract layer: bounded typed results, task contracts, acceptance criteria, runtime-owned evidence verification, assurance levels, hash-pinned context/resources, redaction, deterministic cancellation, bounded retries, writer patch validation, parent verification, and fail-closed trust behavior.

### Success state

When V2 is complete:

- the model sees available agents without first calling a listing tool;
- one AgentDefinition model drives file, settings, flag, SDK, and built-in agents;
- one capability/permission algebra governs both parent and children;
- every child has one durable ID and one authoritative lifecycle record;
- foreground, background, retained, parked, and resumed children use the same runtime and registry;
- the old runId/jobId/batchId/resultRef taxonomy is removed from the model-facing API;
- the model-facing API is reduced to agent, agent_control, and agent_patch;
- /agents is a live Prime/OMP-style Agent Hub over the same registry, not a second state store;
- isolated workers can see the exact parent WIP at spawn while producing only their own delta;
- an existing child can be cold-revived deterministically without silently gaining, losing, or re-resolving authority;
- old subagent tool names and old settings shapes are gone at the shipped boundary;
- all existing safety/adversarial/result-contract behavior that remains applicable is ported and passing.

---

## 2. Scope and non-goals

### In scope

- agent definition schema, discovery, precedence, validation, reload, and listing;
- built-in agents;
- shared permission evaluator and parent-to-child authority derivation;
- live tool resolution from the parent registry;
- child AgentSession creation;
- durable child persistence and cold revival;
- one registry and one ID space;
- foreground/background execution and completion delivery;
- continuation, steering, waiting, stopping, deletion, and output inspection;
- optional child budgets;
- opt-in recursion infrastructure with depth zero by default;
- dirty-parent worktree isolation and conflict-aware patch application;
- Agent Hub and child-focus UX;
- lifecycle events and parent-owned hooks;
- CLI, SDK, RPC, settings, documentation, and test migration;
- removal of the old model-facing subagent APIs after V2 parity is proven.

### Explicit non-goals

- no second reasoning loop, planner, provider SDK, model registry, session store, or compaction engine;
- no claim that permission rules are a sandbox;
- no remote/cloud workers;
- no swarm/team coordinator or shared autonomous task board;
- no automatic recursive delegation; maxDepth defaults to 0;
- no per-agent long-term memory in V2;
- no embeddings-based agent selection;
- no external telemetry by default;
- no compatibility shim for old public subagent tools/settings after V2 ships;
- no automatic rewriting of user agent files;
- no automatic replay of interrupted tool calls after a process crash;
- no direct edits to Agent_harness_references.

---

## 3. Locked decisions

These are no longer open questions for this plan.

| ID | Decision | Locked choice |
|---|---|---|
| D1 | Overall reference strategy | Best-of-harness: Claude definitions, Prime session/UI model, OMP lifecycle/isolation UX, Codex control UX |
| D2 | Compatibility | Clean-break V2; old model-facing tools/settings are removed after migration tests pass |
| D3 | Capability monotonicity | Strict: childAuthority is always a subset of current parentAuthority |
| D4 | Tool availability | A child can only narrow tools that are live, active, and child-safe in the parent |
| D5 | Built-ins | general, explore, plan, review, worker |
| D6 | Agent identity | Frontmatter name, not filename |
| D7 | Discovery | Recursive agent directories with cwd-to-git-root search, worktree fallback, and inode dedupe |
| D8 | Project precedence | Trusted project definitions can override user definitions |
| D9 | Claude compatibility | Optional .claude/agents source, off by default |
| D10 | Native schema strictness | Unknown keys in .ice/agents are errors; compat files may warn on unsupported keys |
| D11 | Delegation guidance | Advice, not the current hard two-or-more-children rule |
| D12 | Model-facing API | agent, agent_control, agent_patch only |
| D13 | Persistence | Persist transcript plus the complete resolved runtime contract needed for exact revival |
| D14 | Crash recovery | Never blindly replay an interrupted tool call; resume with an explicit recovery turn |
| D15 | Existing-child semantics | Definition changes do not mutate an existing child; its resolved contract is frozen |
| D16 | Authority revocation on resume | If the current parent cannot still authorize the frozen child contract, fail before a model turn; do not silently narrow or widen |
| D17 | sub-yolo | Approval preset only; it never widens parent authority, trust, mode, scope, or tool availability |
| D18 | Recursion | Infrastructure supports spawns + maxDepth, default maxDepth = 0 |
| D19 | Dirty parent isolation | Worktree children see the captured staged, unstaged, and untracked baseline |
| D20 | Patch apply | Baseline-aware three-way/conflict-safe integration; ambiguous conflicts fail without mutating the parent |
| D21 | Continuation | Per-task resume in agent plus agent_control send/resume over one canonical runtime operation |
| D22 | Background approval | Interactive ask has a configurable timeout, default 10 minutes; headless without an approval client denies immediately |
| D23 | self profile | Removed as a distinct built-in; general is the default identity |
| D24 | Child retention | Child artifacts live with the parent session and cascade-delete when that parent session is deleted |
| D25 | Rewrite strategy | Preserve proven external behavior/contracts, but replace the internal registry/tool taxonomy decisively |

---

## 4. Current-state evidence and invariants

The rewrite must treat existing proven behavior as a contract, not as disposable prototype code.

### 4.1 Repository architecture constraints

AGENTS.md:20-42 establishes the governing constraints:

- Ice remains the single authoritative reasoning/tool loop.
- Policy, recovery, durable tasks, workspaces, and delegation belong behind stable hooks/adapters/session entries.
- plan and review remain read-only regardless of profile capability.
- deny wins; missing headless approval fails closed.
- permission prompting is not process/filesystem/network isolation.
- interrupted non-idempotent tools must never be blindly replayed.
- writers use isolated worktrees/workspaces unless an explicitly authorized trusted mode says otherwise.
- result claims never outrank observed verification.
- recursive delegation is off by default.
- large outputs are artifacts with bounded context summaries.

idea.md:318-346 records the currently intended native-child architecture and the rule that child tools are derived from parent-active capabilities. idea.md:398-418 makes durable resume, writer isolation, fail-closed approvals, bounded budgets, deterministic cleanup, and no blind side-effect replay prerequisites for stronger autonomy.

### 4.2 Existing behavior already implemented

The current branch already contains separate but real implementations for:

- NativeSubagentRunner and retained/reusable children;
- durable owner-scoped background jobs;
- bounded FIFO concurrency;
- observatory/progress state;
- live foreground child viewing through the normal InteractiveMode shell;
- typed task contracts and acceptance criteria;
- assurance/evidence validation;
- output artifacts and bounded retention;
- check-in scheduling;
- transient-startup retry classification;
- writer worktree/patch validation and rollback handling;
- settings and parent-owned hook gates.

Representative evidence:

- packages/coding-agent/src/ice-subagents.ts:6977 - SubagentLiveSessionRegistry.
- packages/coding-agent/src/ice-subagent-timeout-supervisor.ts:447 - SubagentRunSupervisorRegistry.
- packages/coding-agent/src/ice-subagent-jobs.ts:1211 - SubagentJobRegistry.
- packages/coding-agent/src/ice-subagents.ts:13682-13685 - multiple stores are constructed together today.
- packages/coding-agent/src/ice-subagents.ts:16896-16906 - durable job persistence is parent-owned and restored from session entries.
- packages/coding-agent/src/ice-subagents.ts:7280 onward - normal child session factory.
- packages/coding-agent/src/ice-subagents.ts:7605 onward - separate writer session factory and yolo/direct-workspace branch.
- packages/coding-agent/src/ice-subagent-capabilities.ts:17-31 - parent-owned child-safe adapter contract.
- packages/coding-agent/src/ice-subagent-capabilities.ts:55-77 - current parent-management denylist.
- packages/coding-agent/src/ice-subagent-settings.ts:35-51 - current namespaced settings surface.
- packages/coding-agent/src/ice-subagent-settings.ts:168-180 - maxTurns/maxToolCalls are currently explicitly rejected.
- packages/coding-agent/src/ice-subagent-assurance.ts:3-16 - evidence is runtime-owned, not model-trusted.

### 4.3 Existing tests that become V2 regression contracts

The following existing tests must be mapped to V2 equivalents before old code is removed:

- packages/coding-agent/test/ice-subagents-adversarial.test.ts:86-354
  - credential stripping;
  - symlink replacement/path escape;
  - resource mutation before launch;
  - bounded/redacted fork context;
  - transient startup vs terminal partial-output failures;
  - cancellation/timeout between bounded retries;
  - concurrent retry bounds;
  - evidence scope validation.

- packages/coding-agent/test/ice-subagent-settings.test.ts:98-233, 346-412, 521-740
  - deny-first composition;
  - tool narrowing without authority expansion;
  - invalid settings fail closed;
  - reload revalidation;
  - hook ask/deny fail-closed behavior;
  - parent/user ownership of steering.

- packages/coding-agent/test/ice-subagent-jobs.test.ts:177-469
  - durable acceptance is persisted before launch;
  - the accepted execution contract is persisted;
  - concurrency admission queues correctly;
  - a failed initial persistence prevents launch;
  - restart normalizes interrupted running state.

- packages/coding-agent/test/ice-subagent-reuse-delete.test.ts:149-675
  - retain and resume the same child session;
  - owner scoping;
  - unknown/stale/deleted handles fail closed;
  - active child must be stopped before destructive delete;
  - authority revocation prevents resume;
  - parent tool revocation prevents resume;
  - retained model/profile/authority do not silently change;
  - concurrent resume/delete races are rejected;
  - shutdown disposes retained sessions;
  - resumed tool wrappers use the resumed turn policy.

- packages/coding-agent/test/ice-writer-w5.test.ts:172-455
  - writer operations serialize where required;
  - final-answer retention stays host-owned;
  - inspect before integrate;
  - tamper/path/symlink/size checks;
  - stale-base rejection;
  - verifier failure does not claim integration;
  - rollback conflict is surfaced;
  - no implicit child lifetime timeout.

These tests may be renamed or split, but their relevant invariants must not disappear.

---

## 5. Reference findings: adopt, adapt, reject

### 5.1 Claude Code: definition and discovery authority

Adopt:

- Agent_harness_references/claude-code/src/utils/markdownConfigLoader.ts:191-289
  - project stop-boundary logic;
  - cwd-to-git-root directory walk.

- Agent_harness_references/claude-code/src/utils/markdownConfigLoader.ts:297-429
  - managed/user/project source loading;
  - worktree fallback to the main checkout;
  - inode-based duplicate suppression;
  - per-cwd memoization.

- Agent_harness_references/claude-code/src/tools/AgentTool/loadAgentsDir.ts:73-133
  - one definition schema for Markdown/JSON concepts.

- Agent_harness_references/claude-code/src/tools/AgentTool/loadAgentsDir.ts:193-221
  - deterministic source precedence and shadow retention.

- Agent_harness_references/claude-code/src/tools/AgentTool/loadAgentsDir.ts:296-382
  - frontmatter name is identity;
  - Markdown without name is not an agent;
  - invalid named definitions produce diagnostics.

- Agent_harness_references/claude-code/src/tools/AgentTool/prompt.ts:40-63
  - automatic agent listing and cache-friendly delta delivery.

- Agent_harness_references/claude-code/src/tools/AgentTool/agentToolUtils.ts:70-225
  - resolve requested tools against the live available-tool set.

Adapt:

- ICE native .ice/agents is stricter than Claude: unknown native keys fail rather than merely warning.
- .claude/agents compatibility mode is permissive enough to load known fields and report unsupported extras.
- ICE keeps its task-contract/evidence layer, which Claude Code does not replace.

Reject:

- any child permission behavior that can become more permissive than the current parent;
- relying on an ephemeral child transcript/runtime contract when ICE needs deterministic cold revival;
- copying Claude's exact built-in catalog or exact UI.

### 5.2 Prime Agent: child runtime and primary UI model

Adopt:

- Agent_harness_references/prime-agent/packages/coding-agent/src/core/rlm-runtime.ts:14-104, 272-321
  - durable child identity;
  - explicit parent lineage;
  - child runtime options derived from the parent;
  - publish addressable session state before exposing the child as live.

- Agent_harness_references/prime-agent/packages/coding-agent/src/core/agent-session.ts:9957-10099
  - create a real persistent child AgentSession;
  - derive model/thinking/tool envelope from the parent;
  - separate cancel from delete;
  - preserve semantic parent/spawn identity.

- Agent_harness_references/prime-agent/packages/coding-agent/src/core/agent-session.ts:10680-10834
  - tree-aware child inspection;
  - quiescence/wait logic that re-snapshots descendants instead of assuming a static set.

- Agent_harness_references/prime-agent/packages/coding-agent/src/modes/agents-view/agents-view-state.ts:15-95, 192-295
  - reconcile live and saved session data;
  - stable UI identity aliases;
  - parent/child rows, recursive cost, descendant counts, and persisted inactive state.

- Agent_harness_references/prime-agent/packages/coding-agent/src/modes/interactive/components/subagent-summary-line.ts:9-55
  - a compact main-session entry summarizing direct child states.

- Agent_harness_references/prime-agent/packages/coding-agent/src/modes/agents-view/agents-view-mode.ts:948-993
  - keybinding-driven actions for open, reply, follow-up, expand, delete, and related controls.

Adapt:

- ICE uses ordinary AgentSession + standard Ice loop, not Prime's RLM programming surface.
- ICE has one V2 child registry rather than reconciling multiple independent authoritative stores.
- tree metadata is retained even with maxDepth = 0 because it makes future opt-in recursion and UI lineage straightforward.

Reject:

- unrestricted recursion;
- a child-specific reasoning loop;
- treating saved display metadata as sufficient runtime state.

### 5.3 Oh My Pi: lifecycle, revival, Hub UX, and dirty-baseline worktrees

Adopt:

- Agent_harness_references/oh-my-pi/packages/coding-agent/src/registry/agent-registry.ts:1-32
  - explicit running/idle/parked/aborted lifecycle vocabulary.

- Agent_harness_references/oh-my-pi/packages/coding-agent/src/registry/agent-lifecycle.ts:235-356
  - detach before dispose when parking;
  - coalesce concurrent revives;
  - never expose a session that is mid-dispose.

- Agent_harness_references/oh-my-pi/packages/coding-agent/src/registry/agent-lifecycle.ts:358-430
  - cold revival from persisted state;
  - stale-ref validation;
  - tombstone explicit kills so disk scans cannot resurrect them.

- Agent_harness_references/oh-my-pi/packages/coding-agent/src/task/persisted-revive.ts:43-57, 102-205
  - transcript alone is insufficient;
  - cold revival reconstructs the exact runtime contract from persisted host-owned init data;
  - active tools are clamped to the persisted set.

- Agent_harness_references/oh-my-pi/docs/agent-hub.md:1-93
  - live roster + inspector;
  - wide split / narrow swap;
  - focus child transcript;
  - steer running, prompt idle, revive parked;
  - usage/artifact/worktree metadata;
  - distinct kill vs transcript/history behavior.

- Agent_harness_references/oh-my-pi/packages/coding-agent/src/task/worktree.ts:38-53, 185-267
  - baseline captures HEAD + staged + unstaged + untracked data;
  - child delta is calculated relative to the synthetic dirty baseline.

- Agent_harness_references/oh-my-pi/packages/coding-agent/src/task/worktree.ts:580-715
  - plain apply, then three-way, then baseline-WIP replay strategy;
  - WIP-only files are not accidentally attributed to the agent.

Adapt:

- ICE keeps its existing writer patch manifest, path/tamper checks, verifier, and assurance semantics.
- baseline snapshot size limits must be explicit and configurable within a hard host ceiling.
- nested repositories either receive their own baseline record or are rejected as unsupported isolation boundaries; never silently cross them.

Reject:

- process-global registry authority if it conflicts with ICE owner/session scoping;
- wildcard spawning as a default.

### 5.4 Codex: explicit control UX

Adopt:

- Agent_harness_references/codex/codex-rs/core/src/tools/handlers/multi_agents_spec.rs:166-200
  - message existing agent with an explicit interrupt option.

- Agent_harness_references/codex/codex-rs/core/src/tools/handlers/multi_agents_spec.rs:204-262
  - distinguish message-only from follow-up-that-triggers-a-turn semantics.

- Agent_harness_references/codex/codex-rs/core/src/tools/handlers/multi_agents_spec.rs:265-313
  - explicit resume and wait semantics.

- Agent_harness_references/codex/codex-rs/core/src/tools/handlers/multi_agents/wait.rs:95-219
  - bounded wait that subscribes to status rather than polling mutable maps.

- Agent_harness_references/codex/codex-rs/core/src/tools/handlers/multi_agents/send_input.rs:47-133
  - ensure a persisted target is loadable before sending;
  - interrupt is explicit;
  - sending starts or steers through the normal turn-input path.

- Agent_harness_references/codex/codex-rs/core/src/agent/child_config.rs:123-193
  - child/resume configuration starts from the current parent turn snapshot, including cwd and approval profile.

- Agent_harness_references/codex/codex-rs/core/src/agent/role.rs:50-127
  - roles are typed overlays on a parent-derived configuration rather than an independent runtime.

Adapt:

- Codex exposes several separate tools; ICE exposes the same semantics through agent_control actions to keep the model-facing surface small.
- ICE resume is stricter: a previously frozen resolved contract must still be authorized by the current parent or the turn fails before execution.

Reject:

- any role/config override that expands the parent's effective capability envelope;
- exposing separate spawn/send/wait/resume/close tool names.

### 5.5 OpenCode and existing ICE: permission mechanics

Use OpenCode-style command/path pattern matching where it improves subject matching, especially command arity, but keep ICE's stronger rule:

**the child result of permission evaluation can never be more permissive than the parent result for the same operation.**

Existing ICE parent-owned adapters and assurance/evidence validation remain authoritative where they are stricter.

---

## 6. Target architecture and invariants

### 6.1 Single authoritative flow

The runtime path is:

~~~
Parent AgentSession
  -> agent / agent_control / agent_patch
  -> AgentDefinition resolver
  -> parent capability snapshot
  -> monotonic authority derivation
  -> resolved ChildRuntimeContract
  -> one ChildRegistry admission slot
  -> child SessionManager + ordinary AgentSession
  -> normal Ice reasoning/tool loop
  -> host-owned events / observations / evidence
  -> bounded typed result + artifacts
  -> parent verification / integration
~~~

There is no child planner, provider client, compactor, or model registry separate from Ice.

### 6.2 One source of lifecycle truth

ChildRegistry is authoritative for child identity and lifecycle. The observatory, completion inbox, Agent Hub, RPC stream, and CLI are projections/subscribers.

Do not preserve separate authoritative maps corresponding to today's live-session registry, job registry, observatory registry, managed-batch registry, or timeout registry.

### 6.3 Separate instance lifecycle from turn outcome

A durable child instance and an individual child turn are different concepts.

Child instance states:

- starting
- running
- idle
- parked
- stopping
- blocked
- aborted
- deleted

Turn outcomes:

- completed
- failed
- cancelled
- interrupted
- budget_exhausted

A completed turn normally leaves a reusable child idle. Parking disposes the live AgentSession while retaining the frozen runtime contract and transcript. Delete is destructive and tombstoned before artifact cleanup.

### 6.4 One durable child ID

Use one public child ID: ag_<base32>.

Optional batch/group IDs use agg_<base32> only as a view/synthesis handle; they are not a second child identity.

Internal provider turn IDs may exist but are never required to address a child from the model-facing API.

### 6.5 Parent ownership

Every child record carries:

- owner parent session ID;
- root session ID;
- parent child ID when recursion is enabled;
- depth;
- creation turn;
- source definition identity/hash.

All status, wait, send, resume, stop, delete, output, patch, UI, SDK, and RPC operations validate owner/root lineage. A stale ID from another parent fails closed without revealing unrelated child data.

---

## 7. Agent definitions and discovery

### 7.1 Definition sources

Definition sources, low to high precedence:

1. built-in;
2. package;
3. user Markdown: ~/.ice/agents/**/*.md;
4. user settings: ice.subagents.agents;
5. trusted project Markdown from cwd up to git root: .ice/agents/**/*.md;
6. trusted project settings: ice.subagents.agents;
7. CLI / SDK ephemeral definitions.

Managed configuration is modeled separately as a policy/lock layer. A managed policy may pin, disable, or replace a named definition, but the resolver records it as managed/locked rather than pretending it is an ordinary shadowable user definition.

Optional compatibility source:

- .claude/agents/**/*.md, project-scoped, disabled unless ice.subagents.compat.claudeAgents = true.

### 7.2 Managed root

V2 does not hard-code /etc/ice/agents.

Use an explicitly configured managed root, initially ICE_MANAGED_DIR when supplied by the existing host/enterprise configuration path. If absent, there is no managed agent directory. Managed files are read-only from the Agent Manager.

### 7.3 Discovery rules

- Walk cwd upward to the canonical Git root.
- Do not read project definitions above the resolved project boundary.
- Preserve Claude-style worktree fallback to the main checkout when the worktree has no matching agent directory.
- Do not let a nested Git repository incorrectly truncate the owning project's definition search.
- Recursively discover Markdown files.
- Follow symlinks only when canonical containment remains inside the source root.
- Deduplicate by device/inode where the platform exposes them; canonical-path fallback otherwise.
- A Markdown file without frontmatter name is ignored as non-agent documentation.
- A named but invalid file appears in diagnostics and is not active.
- Untrusted project definitions are discoverable as metadata for UI diagnostics but never injected into the model's active agent list and never used as prompts.

### 7.4 Identity and schema

Native .ice/agents schema:

~~~yaml
---
name: security-review
description: Use for security-focused review
tools: [read, grep, find, bash]
disallowedTools: [edit, write]
model: inherit
thinking: high
permissionMode: review
permissions:
  deny: ["bash(git push*)"]
  ask: ["bash(*)"]
maxTurns: 40
maxTokens: 120000
timeoutMs: null
background: false
isolation: none
contextFiles: true
skills: [tdd]
prompts: []
context: []
mcp: ["github/*"]
requiredMcpServers: [github]
hooks: [audit-bash]
initialPrompt: "/review"
spawns: []
color: purple
hidden: false
tags: [review]
temperature: 0.2
topP: 0.9
---
System prompt body
~~~

Rules:

- name is required and matches ^[a-z0-9][a-z0-9-]{0,63}$.
- description is required for active agents.
- body is the child system-prompt contribution.
- native .ice definitions reject unknown keys with a field-level diagnostic.
- .claude compat definitions may ignore unsupported keys with warnings.
- tools accepts a YAML sequence or Claude-compatible comma string.
- omitted tools or ["*"] means all child-safe parent-active tools before disallowedTools and policy narrowing.
- model defaults to inherit. It accepts `inherit`, one exact `provider/model` reference, or an ordered candidate list such as `[omni/cx/gpt-5.6-luna, opencode-go/muse-spark-1.3-contributor, inherit]`.
  - Candidates resolve deterministically: the first candidate with an available route and existing credentials wins, and skipped candidates are recorded as diagnostics.
  - The list replaces today's `model` + `fallbackModel` pair. `fallbackModel` is not a native V2 key.
  - When the list does not end with `inherit`, an unresolvable list makes the agent `limited`, not silently parent-model.
  - Model aliases exist only in compat mode and require an explicit mapping.
- maxTurns, maxTokens, and timeoutMs are optional, nullable budgets. No default child lifetime timeout is introduced.
- spawns is a list of allowed agent names. maxDepth remains a global/session ceiling; both checks must permit recursion.
- reserved provenance keys for ICE packages may be carried as host metadata but do not enter prompt text.

### 7.5 Built-ins

| Name | Default tool intent | Mode | Isolation | Purpose |
|---|---|---|---|---|
| general | all child-safe parent-active tools | inherit | none | default general delegate |
| explore | read/search + non-mutating shell subject to policy | plan | none | codebase/research exploration |
| plan | read/search only | plan | none | implementation planning |
| review | read/search + approved verification commands | review | none | structured review/findings |
| worker | parent-authorized build tools | build | worktree | implementation worker |

All built-ins have spawns: [] by default.

A user/project definition may shadow a built-in unless managed policy locks that name.

There is no separate self built-in. Calls that omit agent use ice.subagents.defaultAgent, default general.

Existing user files `~/.ice/agents/explore.md`, `review.md`, and `worker.md` will shadow the built-ins of the same name. This is intended, and `/agents` and `ice agents list` show the shadowing.

A user `worker` that omits `isolation` gets `isolation: none`. Built-in defaults are never merged into a shadowing definition: the winning definition is used whole, as in Claude Code.

### 7.6 Listing and reload

Active agent list is sent to the model automatically as a bounded custom message delta, not baked into the agent tool schema.

Listing entry:

- name;
- description;
- summarized tool envelope;
- optional model lock;
- availability diagnostic only when limited.

Invalid, shadowed, untrusted, disabled, or missing-MCP agents are visible in human/CLI diagnostics but not advertised as callable.

Cache by cwd + trust/settings epoch. Invalidate on:

- agent-directory watcher change;
- settings change;
- trust transition;
- package/plugin reload;
- /reload.

Running/parked existing children keep their frozen resolved contract after definition reload.

Delta lifecycle:

- The first turn of a session receives the full callable list.
- Later turns receive add/remove/change deltas only when the callable set changes.
- **Full re-list** after compaction (`session_compact`), branch or tree navigation, session resume or reload, and model change. In each case earlier delta messages may no longer be in context.
- The listing logic computes "what the model has seen" from the delta entries in the current branch's context, not from a process-global variable. This mirrors Claude Code's reconstruction from prior `agent_listing_delta` attachments (`utils/attachments.ts:1479-1548`).
- The listing is bounded: if the callable set exceeds the byte cap, list names + one-line descriptions and point to `agent_control action=agents` for detail.

---

## 8. Settings model

Keep the existing namespace: ice.subagents.

Target shape:

~~~jsonc
{
  "ice": {
    "subagents": {
      "enabled": true,
      "defaultAgent": "general",
      "maxConcurrent": 4,
      "maxDepth": 0,
      "askTimeoutMs": 600000,
      "defaults": {
        "model": "inherit",
        "thinking": "medium",
        "maxTurns": null,
        "maxTokens": null,
        "timeoutMs": null,
        "background": false,
        "checkInIntervalMs": 300000,
        "startupTimeoutMs": 600000
      },
      "routeTiers": {
        "mechanical": "cx/gpt-6-luna",
        "judgment": "cx/gpt-6-sol"
      },
      "permissions": {
        "deny": ["bash(git push*)", "write(**/.env*)"],
        "ask": ["bash(*)", "external_directory(*)"],
        "allow": ["read", "grep", "find", "ls"]
      },
      "agents": {},
      "disabledAgents": [],
      "compat": {
        "claudeAgents": false,
        "modelAliases": {}
      }
    }
  }
}
~~~

Notes:

- Keep existing hard numeric/string bounds and add bounds for new fields.
- Old allowedRoles, roleDefaults, restrictions, modelSelection, and concurrency.default/max do not remain as shipped aliases.
- Loading an old key returns an explicit V2 migration error rather than silently changing behavior.
- restrictions.denyRoles maps conceptually to deny agent(name), but migration is documented, not automatic.
- old denyTools maps conceptually to permission deny rules.
- roleDefaults moves into agents.<name> or the file definition.
- maxConcurrent replaces the old two-number default/max shape with one effective user ceiling plus a hard host ceiling.
- route tier selection remains parent-controlled and cannot select a model/provider outside parent/session authorization.

---

## 9. Permission and capability algebra

### 9.1 Core invariant

For every operation O:

**ChildDecision(O) must be no more permissive than ParentDecision(O).**

Ordering from least to most permissive:

deny < ask < allow

Therefore:

- parent deny -> child deny, always;
- parent ask -> child may ask or deny, never allow;
- parent allow -> child may allow, ask, or deny.

A profile, call argument, mode preset, session grant, compat file, or sub-yolo flag cannot violate this relation.

### 9.2 Rule grammar

Rules use:

- tool
- tool(pattern)

Examples:

- read(src/**)
- edit(packages/**)
- bash(git status*)
- bash(git push*)
- agent(explore)
- mcp__github__*
- external_directory(/tmp/work/**)

Subject extraction is tool-specific:

- file tools -> canonicalized path relative to child cwd/scope;
- bash -> command subject plus arity-aware prefixes;
- agent -> requested definition name;
- MCP -> exact registered tool name;
- external_directory -> canonical target root.

Unknown subject type or adapter access class fails closed.

### 9.3 Parent evaluation

One evaluator is used by the parent and children.

Parent layers include:

1. built-in mode/safety ceiling;
2. user policy;
3. trusted project policy;
4. managed policy;
5. CLI/session policy;
6. explicit parent session grants.

deny wins among matching rules.

plan and review mode ceilings are hard upper bounds and cannot be weakened by a profile.

### 9.4 Child derivation

At child creation:

~~~
parentToolSet = live active parent tools
candidateTools = parentToolSet
               - parent management tools
               - tools classified unknown/unsafe for child dispatch

definitionTools = apply AgentDefinition.tools to candidateTools
definitionTools = remove AgentDefinition.disallowedTools
callTools       = narrow by call scope/targets
effectiveTools  = definitionTools intersect callTools

childRules = monotonic_narrow(
  parentEffectiveRules,
  agentPermissions,
  permissionModePreset,
  callScopeRules,
  spawnRules
)
~~~

External adapters are eligible only when:

- registered by the parent;
- active/authorized in the parent;
- childSafe = true;
- access is read-only or mutation, never unknown;
- their exact fingerprint is captured in the child contract.

No child may activate an MCP server, extension, custom tool, Bash, edit, or write capability absent from the parent.

Recursion exception to the management-tool removal: `agent` and `agent_control` (never `agent_patch`) are re-added to a child only when **all** of these hold:

- the frozen contract's `spawns` is non-empty;
- `depth < maxDepth`;
- the parent itself has `agent` active;
- the parent decision for `agent(<name>)` is not deny.

The child's `agent` tool may resolve only names in `spawns`. Every other management tool stays removed. With the default `maxDepth = 0` the exception never applies.

### 9.5 Presets

| Preset | Effect |
|---|---|
| plan | narrows to read/search and explicitly non-mutating command subjects; mutating operations deny |
| review | plan-like ceiling plus parent-authorized verification commands |
| build | may retain parent-authorized edit/write within scope; Bash remains governed by parent + child rules |
| bubble | retains parent decisions and bubbles child ask decisions to the parent approval surface |
| sub-yolo | removes child-local ask friction only where the already-evaluated parent decision is allow; parent ask/deny, trust, scope, mode, and tool absence remain binding |

sub-yolo is not an alternate session factory and never selects unsafeHostExec.

### 9.6 Approval handling

Foreground interactive child:

- automated hooks/checks run first;
- child ask appears in the parent UI with child identity and operation summary;
- options: allow once, allow for this parent session where supported, deny.

Background interactive child:

- request enters Agent Hub inbox;
- child is blocked, not busy-looping;
- default timeout 10 minutes, configurable within host bounds;
- timeout -> deny.

Headless:

- print/json or RPC without an attached approval client -> immediate deny;
- RPC with approval support emits approval_request and awaits bounded approval_response;
- disconnect or deadline -> deny.

All approval events are owner-scoped and redact secrets.

A child blocked on approval keeps its admission slot, because it holds a live session and partial turn state. The timeout bounds this. The main-session summary and Hub show `blocked` separately so a stalled queue is visible.

If every slot is held by blocked children, new admissions queue. No child is evicted automatically.

### 9.7 Default child policy (safe default)

Monotonicity alone is not enough: a parent with an `allow` decision for Bash would pass `allow` to every `tools: ["*"]` child. That would weaken today's behavior, where children are read-only without `--sub-yolo`.

The child preset therefore adds a **child mutation ceiling** before any agent rule applies:

| Subject class | Child default | Can be raised to allow by |
|---|---|---|
| read/search, read-only adapters, read-only MCP | parent decision | n/a |
| edit/write | `ask` | `--sub-yolo`; user or managed `ice.subagents.permissions.allow`; `isolation: worktree` (writes stay in the worktree, apply still needs `agent_patch`) |
| bash | `ask` | `--sub-yolo`; user or managed `ice.subagents.permissions.allow` with a command pattern |
| mutation adapters, MCP of unknown or mutation access | `ask` | user or managed allow rule naming the tool |
| `external_directory` | parent decision, never above `ask` | managed allow only |

Rules:

- **Project-scope rules (project settings, project agent files, `.claude/agents` compat) can only narrow** (add `ask`/`deny`) for child mutation subjects. They can never raise a mutation subject to `allow`. A cloned repository must not be able to grant its own agents unattended Bash. This reflects AGENTS.md: "Treat repositories … as untrusted data, never policy."
- In every case the result is still capped by the parent decision (section 9.1).
- With the ceiling and the headless rule (section 9.6), a background or headless child with no approval client and no explicit allow is effectively read-only. That matches today's default.

---

## 10. Resolved ChildRuntimeContract

Every new child launch produces one immutable, host-owned resolved contract before execution.

Suggested shape:

~~~ts
interface ChildRuntimeContract {
  version: 2;
  id: string;
  ownerSessionId: string;
  rootSessionId: string;
  parentChildId?: string;
  depth: number;

  agent: {
    name: string;
    source: string;
    sourcePath?: string;
    sourceHash: string;
    resolvedDefinitionHash: string;
  };

  prompt: {
    system: string;
    initialPrompt?: string;
    contextFiles: boolean;
    resourceHashes: Array<{ id: string; sha256: string }>;
  };

  model: {
    provider: string;
    model: string;
    thinking: string;
    temperature?: number;
    topP?: number;
  };

  capabilities: {
    tools: Array<{ name: string; adapterId?: string; fingerprint?: string; access: string }>;
    permissionRules: NormalizedRule[];
    scopeRoots: string[];
    targets?: string[];
    mcpServers: string[];
    spawns: string[];
    maxDepth: number;
    subYolo: boolean; // revival requires the same or stricter state (D16/D17)
  };

  result: {
    outputSchema?: object;
    acceptance: string[];
    taskContract: SubagentTaskContract;
  };

  budgets: {
    maxTurns?: number;
    maxTokens?: number;
    timeoutMs?: number;
    startupTimeoutMs: number;
  };

  isolation: {
    mode: "none" | "worktree";
    baselineId?: string;
    worktreePath?: string;
  };

  createdAt: string;
}
~~~

Contract creation rules:

- derive only after trust, definition validation, parent tool snapshot, permission evaluation, route/model resolution, context/resource validation, and scope normalization;
- redact/normalize before persistence;
- calculate a canonical contract hash;
- persist acceptance before creating a live child;
- running children never consult changed definition files to mutate this contract;
- call-time task text may change on later turns, but runtime authority/model/isolation contract does not silently re-resolve.

---

## 11. Persistence, registry, and cold revival

### 11.1 File layout

Child transcript:

<parent-session-dir>/subagents/<ag_id>.jsonl

The child transcript begins with a host-owned V2 init/session entry containing the complete ChildRuntimeContract or a lossless normalized representation of it.

Parent session stores a compact extension-owned index entry:

- id;
- child transcript path;
- agent name;
- contract hash;
- lifecycle state;
- parent/root lineage;
- timestamps;
- last turn outcome;
- usage summary;
- artifact refs;
- worktree/patch refs;
- tombstone state.

The parent index is navigation/state metadata, not the sole source needed to recreate runtime authority.

### 11.2 Registry

packages/coding-agent/src/subagents/registry/registry.ts owns:

- IDs;
- parent/root lineage;
- instance lifecycle;
- live AgentSession reference when resident;
- contract ref/hash;
- admission slot;
- current turn metadata;
- unread completion/approval counters;
- usage summaries;
- artifacts and isolation metadata.

The observatory, completion inbox, UI, CLI, SDK, RPC, and hooks consume registry snapshots/events.

### 11.3 Admission and concurrency

Preserve current bounded FIFO behavior.

- Persist accepted child record/contract before launch.
- Admission queue is owner/root aware.
- Cancellation while queued never launches the child.
- maxConcurrent is bounded by a hard host ceiling.
- foreground and background children consume the same concurrency pool unless a later measured policy justifies separate pools.
- a resumed/parked child must reacquire execution capacity before starting a new turn.
- no polling loops for completion; registry emits/subscribes to state transitions.

### 11.4 Parking

An idle retained child may be parked after a bounded idle TTL.

Parking transaction:

1. mark a park intent against the exact registry generation/ref;
2. allow same-tick resume/send to cancel before detach;
3. atomically detach live session from the registry;
4. set lifecycle = parked;
5. dispose the old AgentSession;
6. keep transcript, contract, result artifacts, and lineage.

No caller may receive a session that is mid-dispose.

### 11.5 Cold revival

Revival:

1. validate owner/root identity and tombstone;
2. coalesce concurrent revival requests;
3. read the persisted V2 runtime contract;
4. verify its hash and required artifacts/resources;
5. verify the current parent still has at least the exact frozen capability envelope;
6. if any required parent tool/adapter/permission/model authorization was revoked, set blocked with a diagnostic and perform no model turn;
7. reopen the child SessionManager;
8. recreate an ordinary AgentSession using the frozen prompt/model/tool/rule/scope/isolation contract;
9. clamp active tools to the persisted set even if the current parent gained more tools;
10. attach the session to the same registry ref;
11. transition parked -> idle;
12. only then admit a follow-up turn.

Definition changes after creation never mutate the child contract. The UI may report sourceHash drift.

### 11.6 Crash/interruption

On process restart:

- a persisted child that was running/starting is restored as parked with lastTurnOutcome = interrupted;
- any in-flight tool call is recorded as interrupted metadata only;
- no tool is replayed automatically;
- the next explicit resume/follow-up adds a host recovery message naming the interrupted tool/call if known;
- the model decides how to recover under the same frozen authority;
- external side effects are never inferred as complete from missing acknowledgements.

### 11.7 Delete and tombstones

- stop aborts the current turn and leaves the durable child instance recoverable.
- delete first writes a tombstone, then disposes/rejects worktree state, then removes child files/artifacts according to retention policy.
- deleted/tombstoned children are never rediscovered as parked.
- deleting a parent session cascades its subagent directory and child metadata.
- explicit child deletion remains owner-scoped and idempotent.

---

## 12. Model-facing API

Exactly three model-facing tools.

### 12.1 agent

~~~ts
{
  tasks: Array<{
    agent?: string;
    resume?: string;
    description: string;
    prompt: string;

    model?: string;
    thinking?: Level;
    isolation?: "none" | "worktree";
    scope?: { roots: string[]; targets?: string[] };

    outputSchema?: object;
    acceptance?: string[];
    context?: ContextItem[];

    maxTurns?: number;
    maxTokens?: number;
    timeoutMs?: number;
  }>;
  background?: boolean;
}
~~~

Validation:

- 1..8 tasks.
- For a new task, resume is absent and agent defaults to defaultAgent.
- For a resumed task, resume identifies an existing child; agent/model/thinking/isolation/tool authority cannot be overridden.
- A resumed task may provide a new bounded prompt/description and turn-specific acceptance/context that does not widen runtime authority.
- new task model/thinking overrides must satisfy parent model/provider policy:
  - the model must exist in the parent's live model registry;
  - its credentials must already be resolvable without new login or credential expansion;
  - it must not be blocked by the provider/model allow rules in settings;
  - thinking must be supported by the resolved model, and unsupported levels are clamped with a diagnostic as today.

  A rejected override fails the task at preflight, before any child exists.
- batch order is deterministic.
- 2+ tasks may create agg_<id> for display/synthesis only.
- foreground waits for requested tasks and returns bounded results.
- background persists/admits tasks and returns child IDs immediately.
- Ctrl+B on an interactive foreground wait detaches the parent wait into background without aborting the children.

### 12.2 agent_control

Target schema:

~~~ts
{
  id?: string;
  ids?: string[];
  action:
    | "status"
    | "wait"
    | "send"
    | "resume"
    | "stop"
    | "delete"
    | "output"
    | "list"
    | "agents";

  message?: string;
  delivery?: "message" | "followup" | "interrupt";
  timeoutMs?: number;
}
~~~

Semantics:

- status: snapshot one/many children.
- wait: subscribe until selected child/children reach a requested terminal turn outcome or until a bounded timeout; do not spin/poll.
- send:
  - message: queue a message for delivery at a safe message boundary; does not start an idle child turn;
  - followup: queue and trigger a new turn if idle; steer safely if running;
  - interrupt: request cancellation of the current turn, wait for the runtime to settle its cancellation boundary, then submit the follow-up.
  - sending to parked auto-revives after authority validation.
- resume: explicitly revive a parked child to idle without submitting task text.
- stop: abort current/queued turn, retain child session/history.
- delete: destructive child removal after stop; tombstone first.
- output: return bounded latest result plus artifact refs; full data stays in artifacts/history.
- list: child instance roster for the current owner/root.
- agents: available AgentDefinition diagnostics including active, shadowed, invalid, disabled, untrusted, and missing-MCP states.

agent({ tasks:[{ resume, prompt }] }) and agent_control send/followup call the same internal continuation primitive. They are two UX entrances, not two lifecycle implementations.

### 12.3 agent_patch

~~~ts
{
  id: string;
  action: "inspect" | "apply" | "reject";
}
~~~

Valid only for children whose frozen contract uses isolation = worktree and has a pending patch artifact.

- inspect returns bounded manifest/diff summary + artifact ref.
- apply runs baseline/current-parent reconciliation and required verification.
- reject tombstones the pending patch and cleans the worktree safely.
- apply/reject are idempotent against terminal patch states.
- parent/current-workspace mutation remains serial and explicitly verified.

---

## 13. Runtime behavior

### 13.1 Child session factory

One factory replaces separate normal/writer factories.

Inputs:

- parent AgentSession;
- frozen ChildRuntimeContract;
- child SessionManager;
- isolation cwd;
- scoped wrapped tools;
- event sink;
- cancellation signal.

The factory:

- uses the normal Ice AgentSession and provider/model registry;
- never loads child extensions by default;
- loads context files only when contextFiles = true through the host-controlled loader;
- never independently discovers credentials/MCP/tools;
- receives an explicit final active-tool set;
- binds tool wrappers to the current child turn + frozen contract;
- emits child-attributed lifecycle/tool events;
- records runtime-owned evidence.

### 13.2 Foreground/background are delivery modes, not runtimes

A child does not become a different type because the parent is waiting.

Foreground:

- parent tool call awaits child turn outcome;
- parent abort propagation is explicit;
- Ctrl+B can detach the wait.

Background:

- parent returns ID immediately;
- child continues under the same registry/session;
- completion enters the inbox and triggers a parent follow-up only according to completion-delivery policy.

### 13.3 Completion delivery

Every background turn produces exactly one durable completion record.

Parent-facing custom message:

- type: subagent_completed;
- child id;
- agent;
- turn outcome;
- bounded summary;
- assurance level;
- artifact refs;
- patch state;
- usage summary.

If parent is idle and policy allows, deliver as followUp with triggerTurn = true. If the parent is busy, enqueue once. On restart, undelivered completion entries remain visible and are delivered at most once.

Check-ins remain advisory and cannot mark work complete.

### 13.4 Budgets

Optional per-child/turn limits:

- maxTurns;
- maxTokens;
- timeoutMs.

Defaults are null: no implicit lifetime timeout.

When an explicit budget is reached:

1. prevent new ordinary tool/model work;
2. if provider/runtime state permits, issue one bounded wrap-up/finalization turn with tools disabled or appropriately restricted;
3. persist turn outcome budget_exhausted;
4. keep the child durable and resumable only if a later explicit task supplies a new permitted budget.

Budget counters and parent session usage include child usage, but usage data is observational rather than authority.

### 13.5 Retry

Keep existing ICE retry discipline:

- retry only classified transient startup/provider failures;
- bounded attempt count;
- cancellation and budget checks between attempts;
- never retry after partial side-effectful output merely because the provider failed;
- never replay an interrupted non-idempotent tool.

---

## 14. Isolation and dirty-parent worktrees

### 14.1 Objective

A worktree child must see the same logical files the parent saw at spawn time, including uncommitted user work, while the resulting patch contains only the child's delta.

This replaces the current clean-parent requirement for isolated work with a captured-baseline protocol.

Isolation is not authority:

- A worktree child still needs `edit`/`write` to be allowed by its derived rules (section 9.7) to modify the worktree.
- In parent `plan`/`review` mode the parent decision for edit/write is deny, so a worktree child is read-only too.
- `agent_patch apply` is a parent mutation and goes through the parent evaluator and mode gate like `edit`.

### 14.2 Baseline capture

Before creating the child worktree, capture per relevant Git root:

- HEAD SHA;
- staged binary-capable diff;
- unstaged binary-capable diff;
- untracked file list;
- bounded untracked binary-capable patch/content representation;
- nested-repository metadata where applicable;
- normalized touched paths;
- byte count and baseline hash.

Use a hard host ceiling so an enormous untracked tree cannot exhaust memory/disk. If the baseline exceeds the ceiling, refuse isolated spawn with an actionable diagnostic.

### 14.3 Worktree creation

1. create detached worktree at captured HEAD;
2. replay captured staged + unstaged + untracked baseline into the child worktree;
3. verify the synthetic child baseline hash equals the captured parent baseline hash;
4. launch child with cwd/scope rewritten to the isolated path;
5. the child may commit or leave WIP; both are normalized into one agent-only delta.

The child sees parent WIP content but does not receive parent Git index authority.

### 14.4 Delta extraction

Compute:

childDelta = childFinalTree - capturedParentBaselineTree

not:

childFinalTree - HEAD

This ensures pre-existing parent WIP is not attributed to the child.

Store:

- base HEAD;
- baseline hash;
- child final tree hash;
- child delta patch;
- changed paths;
- optional child commits as provenance;
- nested-repo deltas or explicit unsupported-boundary diagnostics.

### 14.5 Apply

Before mutating the parent:

1. recapture current parent logical tree and index metadata;
2. compare with the captured baseline;
3. if unchanged in child-touched regions, apply childDelta to the working tree while preserving the parent's existing index state;
4. if changed, perform a three-way reconciliation using:
   - base = captured parent baseline;
   - ours = current parent logical tree;
   - theirs = captured baseline + childDelta;
5. if reconciliation is clean, materialize only the child delta result and preserve unrelated current WIP;
6. if ambiguous/conflicted, write conflict artifacts and return a failed apply without partially mutating the parent;
7. run configured verifier;
8. if verification fails, rollback only changes introduced by this apply;
9. never claim integrated unless post-apply hashes/status and verifier evidence are observed.

### 14.6 Cleanup

- unchanged child worktree: remove automatically after terminal turn.
- changed worktree: retain until apply/reject/delete.
- applied/rejected worktree: remove after durable terminal patch state is persisted.
- crash cleanup uses ownership markers and never removes an unrecognized/dirty worktree.
- no git reset/clean operation is ever run against the user's parent worktree.

---

## 15. Agent Hub and interactive UX

The target UI intentionally feels closer to Prime + OMP, with Codex-like explicit lifecycle actions.

### 15.1 Main-session summary

Show one compact child summary near the normal interactive shell:

- total children;
- running;
- idle;
- parked/blocked;
- pending completion/approval count.

Opening it enters /agents. Use configurable keybindings; do not hardcode raw chords in behavior code.

### 15.2 /agents Hub

One live view over ChildRegistry.

Sections/filters:

- running;
- idle;
- parked/blocked;
- terminal/history where retained.

Modes:

- flat roster;
- parent/child tree;
- search/filter.

Rows:

- status;
- child/agent identity;
- description/current task;
- parent lineage;
- model/thinking;
- age/elapsed;
- tokens/cost when observed;
- active tool;
- unread completion/approval count;
- patch state.

Wide terminal:

- roster left;
- inspector right.

Narrow terminal:

- roster and inspector swap in place.

### 15.3 Inspector

Inspector shows:

- transcript tail/live stream;
- current tool and bounded/redacted args;
- current intent/retry state;
- frozen definition source + hash;
- effective tool names and permission summary;
- scope roots;
- usage;
- artifacts/output;
- worktree baseline/patch state;
- last assurance/verification result;
- interruption/recovery diagnostic.

### 15.4 Focus and reply

Opening a normal local child should reuse ICE's normal InteractiveMode child view behavior rather than invent a second chat renderer.

When focused:

- transcript/editor/status belong to the child;
- running + Enter -> safe steer/message semantics;
- idle + Enter -> follow-up turn;
- parked + Enter -> authority validation, revive, follow-up;
- back returns to parent without aborting the child.

Preserve the existing rule that parent follow-up cannot race with user takeover ownership.

### 15.5 Actions

Expose configurable actions for:

- open/focus;
- send/follow-up;
- interrupt current turn;
- wait;
- revive;
- stop;
- delete;
- inspect output;
- inspect/apply/reject patch;
- expand/collapse descendants;
- flat/tree toggle;
- view definition diagnostics.

Permission requests appear in the same Hub/inbox with child attribution.

### 15.6 Agent manager

/agents new
/agents edit <name>
/agents list

Manager:

- chooses user or trusted-project scope;
- validates native strict schema before writing;
- never edits managed/package/compat sources in place;
- shows shadowing and lock provenance;
- never rewrites existing files merely because aliases/compat fields are deprecated.

---

## 16. Events, hooks, observability

### 16.1 Core events

Emit on the existing extension/event bus:

- subagent_start;
- subagent_turn_start;
- subagent_turn_end;
- subagent_end;
- subagent_parked;
- subagent_revived;
- subagent_interrupted;
- subagent_permission_request;
- subagent_completion_queued;
- child-attributed tool_call;
- child-attributed tool_result;
- patch state changes.

Payloads include child id, agent name, owner/root ids, depth, and bounded metadata.

### 16.2 Hooks

Rebase existing ice.subagent hook definitions onto these events.

AgentDefinition hooks selects registered parent-owned hook IDs for that child. A child never loads arbitrary extension code merely because a definition names a hook.

Preserve existing:

- required vs optional hooks;
- intent-before-handler-before-outcome persistence order;
- timeout/output bounds;
- cancellation;
- fail-closed required hook behavior;
- redaction.

### 16.3 Observatory

Observatory becomes a projection/aggregator over registry/event data, not an authoritative lifecycle store.

It may calculate:

- durations;
- usage;
- current activity;
- retries;
- queue state;
- completion/approval counts.

It must not own child existence or resurrection.

---

## 17. MCP and custom adapters

- The MCP bridge remains transport.
- requiredMcpServers gates definition availability.
- Definition mcp selectors are requested capability selectors, not authority grants.
- Selected MCP tools must already exist in the parent live tool universe and remain permitted by parent policy.
- Parent-owned IceDelegableTool adapters retain explicit childSafe and read-only/mutation classification.
- unknown access is never delegated.
- Persist exact adapter/tool fingerprints in ChildRuntimeContract.
- On resume, missing or changed adapter fingerprints block the next turn rather than silently swapping implementations.
- Large adapter outputs stay bounded/redacted and use artifact refs for overflow.

---

## 18. Prompting and context

### 18.1 Delegation guidance

Replace the repeated hard rule requiring two-or-more delegates with one concise shared instruction:

Prefer doing small sequential work directly. Delegate when work is independently parallel, benefits from a separate context window, needs a specialist definition, or should run in an isolated workspace.

### 18.2 Context sources

Per definition:

- contextFiles true by default;
- explore and plan built-ins default false unless explicitly changed;
- selected context/resources continue to use current bounded packets and hash pinning;
- parent conversation fork/context snapshot remains bounded and redacted;
- project/user instruction files are loaded through existing trusted resource machinery.

### 18.3 Prompt cache

- agent tool schemas are static;
- available-agent changes arrive via bounded listing deltas;
- runtime contract hashes include prompt/resource hashes but model-facing descriptions do not churn on usage/status changes;
- completion/progress messages are custom messages, not schema mutations.

---

## 19. Module layout

Target layout:

~~~
packages/coding-agent/src/subagents/
  index.ts

  definitions/
    schema.ts
    discover.ts
    parse-markdown.ts
    parse-json.ts
    builtin.ts
    precedence.ts
    listing.ts
    cache.ts
    diagnostics.ts

  permissions/
    rules.ts
    evaluate.ts
    subjects.ts
    derive-child.ts
    presets.ts
    approval.ts

  tools/
    resolve.ts
    wrap.ts
    adapters.ts

  contract/
    child-runtime-contract.ts
    serialize.ts
    validate-resume.ts

  runtime/
    session-factory.ts
    runner.ts
    continuation.ts
    budgets.ts
    retry.ts
    completion.ts

  registry/
    registry.ts
    state-machine.ts
    admission.ts
    persistence.ts
    recovery.ts

  isolation/
    baseline.ts
    worktree.ts
    delta.ts
    apply.ts
    patch-state.ts

  results/
    task-contract.ts
    assurance.ts
    batch-synthesis.ts
    output-artifacts.ts

  hooks/
    events.ts
    dispatcher.ts
    command-hooks.ts

  ui/
    summary-line.ts
    hub.ts
    roster.ts
    inspector.ts
    child-focus.ts
    approval-inbox.ts
    manager.ts

  api/
    agent.ts
    agent-control.ts
    agent-patch.ts
~~~

Move quality/live benchmarks and telemetry-only utilities out of the runtime import graph into scripts/dev tooling where appropriate.

ice-subagents.ts may exist temporarily as a Phase 1 compatibility barrel for internal imports only, but it must not remain a 17k-line implementation owner.

---

## 20. Dependency order

Critical path:

Phase 0
-> Phase 1 extraction
-> Phase 2 definitions
-> Phase 3 permission algebra
-> Phase 4 resolved contract/tool resolution
-> Phase 5 registry/persistence/runtime
-> Phase 6 model-facing API
-> Phase 7 isolation/patch
-> Phase 8 Agent Hub/UI
-> Phase 9 hooks/events/CLI/SDK/RPC/docs
-> Phase 10 legacy removal/final gate

Safe parallelism after foundations:

- Phase 2 definition parser tests can proceed alongside non-mutating module extraction after schema boundaries are frozen.
- Phase 7 baseline algorithms can be unit-developed after ChildRuntimeContract isolation fields freeze, but cannot integrate before Phase 5 registry ownership exists.
- Phase 8 pure roster/view-state components can be built after registry snapshot types freeze.
- Phase 9 docs can start after API/schema freeze but must describe only behavior that has passed implementation gates.

---

## 21. Implementation phases with atomic tasks

### Phase 0 - Freeze V2 decisions and contracts

- [ ] **P0.1 Record D1-D25 in idea.md and mark the old subagent architecture as superseded target design, not shipped behavior.**
  - Evidence: this plan sections 3 and 6; AGENTS.md:17-18.
  - Acceptance: idea.md distinguishes existing implementation from V2 target and preserves single-loop/safety constraints.
  - Verify: review diff only; no runtime files changed.
  - Constraint: do not claim V2 implemented.

- [ ] **P0.2 Freeze AgentDefinition, ChildRuntimeContract, child instance states, turn outcomes, and the three model-facing schemas as TypeScript design contracts before implementation migration.**
  - Likely files: subagents/definitions/schema.ts, subagents/contract/child-runtime-contract.ts, subagents/registry/state-machine.ts, subagents/api/*.ts.
  - Acceptance: all downstream phases can depend on stable names/semantics.
  - Verify: focused schema/type tests + corepack npm@12.0.2 run check.
  - Constraint: no legacy alias fields.

- [ ] **P0.3 Build a regression ledger mapping every current subagent/writer test to KEEP, PORT, REPLACE, or N/A with a reason.**
  - Evidence: section 4.3 and packages/coding-agent/test/*subagent*, ice-writer-w5.test.ts.
  - Acceptance: no current safety test can disappear without an explicit written reason.
  - Verify: ledger reviewed before Phase 1 deletion/moves.

- [ ] **P0.4 Specify the `ice.subagents.v2` rollout gate and the default child policy table (section 9.7) as frozen contracts.**
  - Acceptance: the gate semantics (mutually exclusive tool sets) and the child mutation ceiling are written into the schema/type contracts from P0.2.
  - Verify: review only.

### Phase 1 - Structural extraction with no intentional behavior change

- [ ] **P1.1 Extract result/task/assurance/output-artifact modules from current files into subagents/results without changing behavior.**
  - Source: ice-subagent-task-contract.ts, ice-subagent-assurance.ts, ice-subagent-batch-synthesis.ts, ice-subagent-output-artifacts.ts.
  - Acceptance: existing result/evidence tests pass unchanged.
  - Verify: run the affected specific vitest files.
  - Constraint: move/refactor only.

- [ ] **P1.2 Extract concurrency/admission and retry primitives behind interfaces that do not mention legacy job/run IDs.**
  - Source: ice-subagent-concurrency.ts, retry portions of ice-subagents.ts/jobs.
  - Acceptance: FIFO and bounded concurrency tests pass with equivalent assertions.
  - Verify: ice-subagent-concurrency and relevant adversarial tests.

- [ ] **P1.3 Extract current normal child runner/session creation behind a temporary runtime interface.**
  - Source: ice-subagents.ts around createNativeSubagentSession/NativeSubagentRunner.
  - Acceptance: foreground delegation/reuse tests still pass.
  - Verify: reuse/delete + core child tests.
  - Constraint: do not yet merge writer behavior.

- [ ] **P1.4 Extract UI projection/view bridge code without changing current interaction semantics.**
  - Source: current /agents, observatory, IceAgentViewBridge, view switcher.
  - Acceptance: current child focus/take-control behavior remains.
  - Verify: existing interactive component/view tests.

- [ ] **P1.5 Reduce ice-subagents.ts to a bounded temporary barrel/orchestration file.**
  - Acceptance: no core algorithm remains duplicated between old and new modules; target <= 300 lines by end of Phase 1 or document the exact remaining blockers.
  - Verify: imports compile; focused tests + check.
  - Constraint: no deletion of legacy public tools yet.

### Phase 2 - AgentDefinition discovery and diagnostics

- [ ] **P2.1 Implement strict TypeBox AgentDefinition schema and separate compat normalization.**
  - Acceptance: native unknown keys fail; compat unsupported keys warn; no key aliases in native form; `model` accepts string or ordered candidate list; `fallbackModel` produces the documented migration diagnostic.
  - Verify: schema fixtures for every field, invalid key, invalid name, oversized values.

- [ ] **P2.2 Implement recursive source discovery with cwd-to-git-root traversal, worktree fallback, nested-repo boundary handling, canonical containment, and inode dedupe.**
  - Reference: Claude markdownConfigLoader.ts:191-429.
  - Acceptance: deterministic ordered source list across normal repo/worktree/nested repo.
  - Verify: temp-repo fixture tests.

- [ ] **P2.3 Implement parser semantics: no-name Markdown skipped, named invalid file diagnosed, name is identity.**
  - Acceptance: filename may differ from name; reference docs can coexist in agent dirs.
  - Verify: parser fixtures.

- [ ] **P2.4 Implement definition precedence + managed lock overlay + allDefinitions shadow history.**
  - Acceptance: project overrides user only when trusted; managed lock cannot be shadowed.
  - Verify: full pairwise precedence matrix and trust transitions.

- [ ] **P2.5 Add general/explore/plan/review/worker built-ins and defaultAgent=general.**
  - Acceptance: built-ins can be shadowed unless managed-locked; worker defaults to worktree; all have no spawns.
  - Verify: built-in snapshot tests.

- [ ] **P2.6 Implement model-visible agent listing delta and human diagnostics listing.**
  - Acceptance: model receives only active/callable agents; changes produce deltas; tool schema stays byte-stable; full re-list after compaction, branch navigation, resume/reload, and model change.
  - Verify: prompt-cache/listing tests including compaction and branch-switch fixtures.

- [ ] **P2.7 Implement watcher/reload invalidation keyed by cwd/trust/settings epoch.**
  - Acceptance: new launches see changed definitions; existing child contracts do not change.
  - Verify: edit file -> listing changes -> retained child contract hash unchanged.

- [ ] **P2.8 Add optional .claude/agents compatibility source off by default.**
  - Acceptance: disabled means zero discovery side effect; enabled maps known fields with warnings for unsupported keys.
  - Verify: off/on fixtures with Claude-format examples.

### Phase 3 - Shared permission evaluator and monotonic child authority

- [ ] **P3.1 Implement normalized allow/ask/deny rules and tool-specific subject extraction.**
  - Files: permissions/rules.ts, subjects.ts.
  - Acceptance: canonical path handling, Bash arity subjects, agent(name), MCP names.
  - Verify: unit matrix including malformed/unknown subjects fail closed.

- [ ] **P3.2 Implement shared evaluator with deny > ask > allow and hard mode ceilings.**
  - Acceptance: parent plan/review cannot be weakened by settings/profile/sub-yolo.
  - Verify: exhaustive precedence truth table.

- [ ] **P3.3 Implement monotonic child derivation.**
  - Acceptance: every parent deny remains deny; parent ask can never become child allow; parent allow can be narrowed.
  - Verify: property/table tests over all parent/child decision combinations.

- [ ] **P3.4 Rebase parent enforcement in ice-safe-verify onto the evaluator using a report-only comparison period, then enforce once parity exceptions are understood.**
  - Acceptance: documented diff between old and new decisions is empty or intentional before switch.
  - Verify: existing parent safety tests + comparison fixture.
  - Constraint: do not weaken current parent gates to make tests pass.

- [ ] **P3.5 Implement approval broker for foreground, background, and RPC/headless modes.**
  - Acceptance: child-attributed UI prompts, 10-minute default interactive timeout, headless no-client deny.
  - Verify: foreground ask, queued background ask, timeout, disconnect, RPC round trip.

- [ ] **P3.6 Implement sub-yolo strictly as a child-local approval preset.**
  - Acceptance: no code path constructs extra tools or bypasses parent ask/deny/trust/mode/scope.
  - Verify: adversarial matrix proving no authority expansion.

- [ ] **P3.7 Implement the child mutation ceiling (section 9.7).**
  - Acceptance:
    - edit/write/bash/mutation adapters default to `ask` for children;
    - only `--sub-yolo`, user-scope or managed allow rules, or worktree isolation (edit/write only) raise them;
    - project-scope sources can only narrow;
    - headless children without an explicit allow are effectively read-only.
  - Verify: matrix of parent decision × scope of rule source × mode × sub-yolo × headless, including a trusted project agent file that declares `allow: ["bash(*)"]` and must still get `ask`.

- [ ] **P3.8 Implement the gated recursion exception (section 9.4).**
  - Acceptance: `agent`/`agent_control` appear in a child only when spawns is non-empty, depth < maxDepth, parent has `agent`, and the parent does not deny `agent(name)`; `agent_patch` never appears.
  - Verify: depth 0 default absent; depth 1 allowed name only; denied name absent.

### Phase 4 - Tool resolution and frozen ChildRuntimeContract

- [ ] **P4.1 Replace fixed child tool arrays/derive* functions with one live parent-tool resolver.**
  - Acceptance: effective tool names are a subset of live parent-active child-safe tools.
  - Verify: wildcard, explicit list, disallowed list, unknown tool diagnostics, management denylist.

- [ ] **P4.2 Integrate parent-owned adapters/MCP into the same resolver with access/fingerprint checks.**
  - Acceptance: unknown access fails; inactive/revoked parent adapter absent; exact fingerprint captured.
  - Verify: adapter add/remove/revoke/fingerprint-change tests.

- [ ] **P4.3 Build ChildRuntimeContract only after all trust/model/scope/context/tool/policy checks pass.**
  - Acceptance: canonical stable hash for equal inputs; secrets redacted before persistence.
  - Verify: deterministic serialization tests.

- [ ] **P4.4 Implement resume validation against frozen contract + current parent authority.**
  - Acceptance: gained parent capability does not widen child; lost required capability blocks before model call; changed definition file does not re-resolve child.
  - Verify: port reuse-delete authority-revocation tests.

- [ ] **P4.5 Remove unsafeHostExec/tool-construction branches from child session creation.**
  - Acceptance: sub-yolo does not select another tool factory.
  - Verify: search has no runtime unsafeHostExec child branch + focused tests.

### Phase 5 - One registry, durable child sessions, parking, recovery

- [ ] **P5.1 Implement ChildRegistry state machine and generation/ref checks.**
  - Acceptance: only legal transitions; stale operations cannot affect replacement refs.
  - Verify: state transition and race tests.

- [ ] **P5.2 Persist child acceptance + complete runtime contract before launch.**
  - Acceptance: persistence failure means child factory is never invoked.
  - Verify: port durable-job acceptance tests.

- [ ] **P5.3 Replace SessionManager.inMemory child storage with child JSONL files under the parent session directory.**
  - Acceptance: child transcript and init contract survive process restart.
  - Verify: create -> dispose process state -> reopen fixture.

- [ ] **P5.4 Merge foreground/live/job/observatory authoritative state into ChildRegistry projections.**
  - Acceptance: one child ID addresses the same instance across all surfaces; no independent store can resurrect/delete it.
  - Verify: cross-surface identity tests.

- [ ] **P5.5 Preserve bounded FIFO admission for new and resumed turns.**
  - Acceptance: queued cancel never runs; resume reacquires capacity.
  - Verify: concurrency tests.

- [ ] **P5.6 Implement idle -> parked -> revived lifecycle with detach-before-dispose and coalesced revive.**
  - Acceptance: no session observed mid-dispose; concurrent sends share one revive.
  - Verify: deterministic race tests modeled on OMP lifecycle invariants.

- [ ] **P5.7 Implement startup crash recovery.**
  - Acceptance: running/starting persisted turn becomes interrupted; no interrupted tool auto-replayed; recovery notice added only on explicit continuation.
  - Verify: synthetic interrupted transcript fixture with a fake side-effect tool whose invocation count stays one.

- [ ] **P5.8 Implement stop/delete/tombstone/cascade retention.**
  - Acceptance: stop retains; delete tombstones before cleanup; parent deletion cascades; deleted child never cold-revives.
  - Verify: restart-after-delete fixture.

- [ ] **P5.9 Implement durable completion inbox with at-most-once delivery.**
  - Acceptance: background completion persists before parent notification and survives restart.
  - Verify: crash between completion persistence and delivery; crash after delivery marker.

- [ ] **P5.10 Implement optional explicit budgets without a default lifetime deadline.**
  - Acceptance: null means unlimited by host lifetime; explicit budget produces budget_exhausted and bounded wrap-up.
  - Verify: maxTurns/maxTokens/timeout tests plus existing writer no-implicit-timeout regression.

### Phase 6 - Three-tool model API

- [ ] **P6.0 Register the V2 tools behind the `ice.subagents.v2` gate.**
  - Acceptance: with the gate on, only `agent`/`agent_control`/`agent_patch` are registered for subagents; with it off, only legacy tools; never both.
  - Verify: tool registry snapshot for both gate states.

- [ ] **P6.1 Implement agent new-child path over ChildRegistry/runtime contract.**
  - Acceptance: single + batch, foreground + background, typed results.
  - Verify: faux-provider suite.

- [ ] **P6.2 Implement per-task resume and canonical continuation primitive.**
  - Acceptance: resumed task cannot override frozen runtime capabilities; new task contract may narrow only.
  - Verify: resume same transcript/session ID and new lineage/turn outcome.

- [ ] **P6.3 Implement agent_control status/list/agents/output.**
  - Acceptance: bounded owner-scoped results and diagnostics.
  - Verify: stale/cross-owner IDs fail closed.

- [ ] **P6.4 Implement agent_control wait using subscriptions.**
  - Acceptance: no polling; bounded timeout; immediate return on already-terminal requested outcome.
  - Verify: Codex-like wait race tests.

- [ ] **P6.5 Implement send delivery modes message/followup/interrupt.**
  - Acceptance: message does not start idle turn; followup does; interrupt cancels then starts safely; parked send revives.
  - Verify: running/idle/parked matrix.

- [ ] **P6.6 Implement resume/stop/delete actions.**
  - Acceptance: resume warms parked child; stop retains; delete tombstones and destroys according to policy.
  - Verify: lifecycle tests.

- [ ] **P6.7 Port batch synthesis/review flows through agent rather than dedicated model tools.**
  - Acceptance: review is agent=review; no separate review_batch semantics required by runtime.
  - Verify: existing batch synthesis + typed contract tests.

- [ ] **P6.8 Preserve Ctrl+B foreground-to-background detach.**
  - Acceptance: parent wait detaches; child ID/session/turn continue unchanged.
  - Verify: interactive/faux event test.

### Phase 7 - Generalized worktree isolation and agent_patch

- [ ] **P7.1 Extract current writer patch validation/manifest/verification code before changing baseline semantics.**
  - Acceptance: tamper/path/symlink/size/verifier regressions pass.
  - Verify: ice-writer-w5 focused tests.

- [ ] **P7.2 Implement bounded dirty parent baseline capture.**
  - Acceptance: staged, unstaged, untracked, binary-capable data; hard size ceiling; deterministic hash.
  - Verify: clean/dirty/untracked/binary/oversized fixtures.

- [ ] **P7.3 Create detached worktree and replay exact baseline.**
  - Acceptance: child logical tree hash matches captured parent baseline before child starts.
  - Verify: staged+unstaged+untracked mixed fixture.

- [ ] **P7.4 Compute agent-only delta against captured dirty baseline.**
  - Acceptance: unchanged parent WIP never appears in child changedPaths/patch.
  - Verify: child edits same/different files relative to parent WIP.

- [ ] **P7.5 Implement baseline-aware three-way apply without changing the parent index.**
  - Acceptance: unrelated parent changes survive; non-overlap merges; overlap conflicts fail before mutation.
  - Verify: matrix for unchanged parent, unrelated edits, same-file non-overlap, true conflict, parent untracked file.

- [ ] **P7.6 Preserve nested-repo boundaries.**
  - Acceptance: separately captured nested repo or explicit refusal; never silently patch across a nested Git root.
  - Verify: nested repo fixture.

- [ ] **P7.7 Implement agent_patch inspect/apply/reject and durable patch state.**
  - Acceptance: idempotent terminal actions; changed worktree retained until decision.
  - Verify: restart with pending patch, apply/reject after revival.

- [ ] **P7.8 Remove writer-only session factory and prompts.**
  - Acceptance: worker/general agents use the same child factory with isolation parameter.
  - Verify: no createNativeWriterSession/WRITER_SYSTEM_PROMPT runtime references remain.

### Phase 8 - Prime/OMP-style Agent Hub

- [ ] **P8.1 Define one UI snapshot type from ChildRegistry and reconcile persisted/live data without creating lifecycle authority.**
  - Acceptance: stable identity through park/revive/restart.
  - Verify: view-state unit tests.

- [ ] **P8.2 Add compact main-session child summary.**
  - Acceptance: counts running/idle/parked-blocked/pending accurately and updates live.
  - Verify: component tests.

- [ ] **P8.3 Build roster with flat/tree views, search, status sections, recursive usage, and lineage.**
  - Acceptance: deterministic row ordering and stable selection across updates.
  - Verify: view-state tests modeled on Prime.

- [ ] **P8.4 Build responsive inspector.**
  - Acceptance: wide side-by-side, narrow swap; transcript/tool/policy/usage/artifact/worktree data bounded.
  - Verify: component render tests.

- [ ] **P8.5 Reuse normal InteractiveMode for local child focus.**
  - Acceptance: no duplicate chat renderer; back does not cancel; user takeover prevents parent steering races.
  - Verify: existing IceAgentViewBridge behavior ported.

- [ ] **P8.6 Implement reply/action controls over agent_control, not direct registry mutation.**
  - Acceptance: UI and model API have identical lifecycle semantics.
  - Verify: focus/send/followup/interrupt/revive/stop/delete smoke.

- [ ] **P8.7 Add approval/completion inbox and patch actions.**
  - Acceptance: live updates, child attribution, unread counts, timeout state.
  - Verify: interaction tests.

- [ ] **P8.8 Add Agent Manager new/edit/list with strict validation and source locks.**
  - Acceptance: only user/trusted-project native definitions are writable.
  - Verify: temp HOME/project UI/service tests.

### Phase 9 - Events, hooks, CLI, SDK, RPC, docs

- [ ] **P9.1 Emit V2 lifecycle/tool/patch events and rebase observatory/hooks as consumers.**
  - Acceptance: event order documented and deterministic; no duplicate lifecycle stores.
  - Verify: event sequence tests.

- [ ] **P9.2 Map existing command hooks onto V2 events while preserving required-hook persistence ordering and fail-closed behavior.**
  - Acceptance: existing hook regressions pass.
  - Verify: ice-subagent-settings hook tests ported.

- [ ] **P9.3 Add CLI commands: ice agents list --json and ice agents validate [path].**
  - Acceptance: headless deterministic output, exit 1 on invalid definitions.
  - Verify: CLI fixtures.

- [ ] **P9.4 Add --agents JSON ephemeral source.**
  - Acceptance: highest ordinary definition precedence, still subject to managed policy and parent capability limits.
  - Verify: precedence/validation tests.

- [ ] **P9.5 Add SDK agents definitions/config and child-control methods/events.**
  - Acceptance: SDK cannot bypass parent policy.
  - Verify: SDK tests.

- [ ] **P9.6 Add RPC get_agents, child lifecycle events, approval_request/response, and agent control operations.**
  - Acceptance: disconnect asks fail closed; owner scoping enforced.
  - Verify: RPC round-trip tests.

- [ ] **P9.7 Finalize docs/subagents.md and update settings/rpc/sdk/keybindings docs + CHANGELOG.**
  - Acceptance: docs describe shipped behavior only and call out clean-break migration.
  - Verify: documentation review against actual schemas.

### Phase 10 - Remove legacy API/state and final verification

- [ ] **P10.1 Port every KEEP/PORT regression from the Phase 0 ledger to V2 names/surfaces.**
  - Acceptance: ledger has no unexplained incomplete row.
  - Verify: ledger + targeted suite.

- [ ] **P10.2 Remove the 15 legacy model-facing subagent tools and old tool descriptions.**
  - Acceptance: registry exposes only agent, agent_control, agent_patch for subagents.
  - Verify: tool registry snapshot/search.

- [ ] **P10.3 Remove old settings keys and compatibility parser paths.**
  - Acceptance: old keys produce explicit migration errors, not aliases.
  - Verify: negative settings tests.

- [ ] **P10.4 Remove superseded live/job/observatory/managed-batch authoritative maps and legacy IDs.**
  - Acceptance: ChildRegistry is the only lifecycle owner.
  - Verify: import/project-map audit and race tests.

- [ ] **P10.5 Remove temporary ice-subagents.ts compatibility barrel after all imports migrate.**
  - Acceptance: no implementation dependency on legacy module.
  - Verify: project map + check.

- [ ] **P10.6 Run the full non-e2e regression gate and repository check.**
  - Verify:
    - ./test.sh from repo root;
    - corepack npm@12.0.2 run check;
    - record active npm version and command exit status.
  - Acceptance: no failures/warnings/infos attributable to V2.

- [ ] **P10.7 Run the documented interactive smoke flow and optional harness comparison loop.**
  - Smoke: launch child, open Hub, focus, steer, follow-up, background detach, approval, stop, revive, dirty-worktree worker, inspect/apply patch, delete.
  - Acceptance: no UI state divergence from registry; no hidden legacy path.
  - Constraint: use the current AGENTS.md-approved model/route and record it exactly.

---

## 22. Verification matrix

| Area | Minimum deterministic verification |
|---|---|
| Definition discovery | recursive dirs, no-name skip, invalid named file, worktree fallback, nested repo boundary, inode dedupe, trust gate |
| Precedence | every source pair + managed lock + built-in override |
| Native schema | unknown key failure, bounds, identity regex, strict vs compat behavior |
| Listing/cache | initial list, add/remove delta, reload/trust invalidation, tool schema stability |
| Permission algebra | all parent deny/ask/allow x child rule combinations; plan/review ceiling; sub-yolo non-expansion |
| Tool resolution | parent-active subset, management removal, disallowedTools, adapters, MCP, unknown/fingerprint changes |
| Runtime contract | canonical serialization/hash, redaction, exact persistence, definition drift |
| Admission | FIFO, maxConcurrent, queued cancellation, persistence-before-launch |
| Child session | real SessionManager file, owner lineage, foreground/background equivalence |
| Parking/revive | detach-before-dispose, coalesced revive, stale ref, authority revocation |
| Crash recovery | running -> interrupted; interrupted tool never auto-replayed |
| Send semantics | message vs followup vs interrupt across running/idle/parked |
| Wait | already-final, status transition, timeout, multiple targets, cancellation |
| Completion | at-most-once durable delivery across restart windows |
| Budgets | no default timeout; explicit turns/tokens/time; wrap-up and budget_exhausted |
| Result contract | typed schema, acceptance, evidence ownership, assurance levels, fabricated evidence rejection |
| Isolation baseline | clean, staged, unstaged, untracked, binary, oversized, nested repo |
| Patch delta | parent WIP excluded; child-only changed paths |
| Patch apply | unchanged parent, concurrent unrelated edit, same-file non-overlap, conflict, verifier failure, rollback |
| UI | roster updates, stable selection, tree/flat, responsive inspector, child focus, reply, inbox |
| Ownership | cross-parent IDs, stale IDs, tombstones, parent deletion cascade |
| RPC/headless | no approval client deny, approval round trip, disconnect fail closed |
| Legacy removal | old tools absent, old IDs absent from model API, old settings reject explicitly |

For specific unit/integration tests, run from packages/coding-agent:

node ../../node_modules/vitest/dist/cli.js --run test/<specific-file>.test.ts

For suite regressions, use the repository faux-provider harness. Do not use real provider APIs in deterministic tests.

After every code-changing phase:

corepack npm@12.0.2 run check

At final gate:

./test.sh
corepack npm@12.0.2 run check

Do not run broad e2e/provider tests merely as a ritual. Live smoke is separate and records exact route/model/reasoning/runtime.

---

## 23. Migration strategy

This is a clean-break public V2, but implementation migration is staged internally so safety evidence is never discarded before replacement exists.

### Rollout gate

From P6.0 until P10.2, `ice.subagents.v2: true` (setting) or `ICE_SUBAGENTS_V2=1` selects the V2 tool set. The two tool sets are mutually exclusive:

- the model never sees `delegate*` and `agent*` in the same session;
- slash commands, the Hub, and RPC follow the same switch;
- default is off until P10. P10.2 deletes the gate together with the legacy tools.

The gate is an implementation aid, not a shipped compatibility promise.

### During implementation only

Temporary internal re-exports/adapters are permitted to keep the branch compiling while modules move.

They must:

- not be documented;
- not add new user compatibility promises;
- be deleted in Phase 10.

### Shipped breaking changes

Removed model tools include the current delegate/delegate_async/delegate_batch/delegate_write/review_batch/manage/inspect/cancel/list/integrate variants.

Replacement mapping is conceptual:

| Old concept | V2 |
|---|---|
| delegate | agent |
| delegate_async | agent background=true |
| delegate_batch | agent tasks=[...] |
| delegate_write | agent with worker/isolation=worktree |
| review_batch | agent tasks with agent=review |
| manage/inspect/cancel child | agent_control |
| list_subagent_profiles | agent_control action=agents |
| writer inspect/apply/reject | agent_patch |
| runId/jobId | ag_id |
| batchId | optional agg_id |
| resultRef | artifact reference attached to ag_id/turn result |

No alias tools are left registered after V2 finalization.

### User agent files

Existing ~/.ice/agents files are validated and a migration report is shown. ICE does not rewrite them automatically.

Native deprecated key spellings are errors with precise replacements.

Known migration for the current `~/.ice/agents` set (coder, documenter, explore, planner, review, tester, worker). All seven use `name`, `description`, `model`, `fallbackModel`, `thinking`, and five also use `tools`:

| Old | V2 |
|---|---|
| `model: A` + `fallbackModel: B` | `model: [A, B]` (append `inherit` to keep today's final parent fallback) |
| `fallback_model`, `thinkingLevel`, `topP`/`top_p`/`top-p`, `startupTimeoutMs`, `mcpTools`/`mcp_tools` | `model` list, `thinking`, `topP`, `ice.subagents.defaults.startupTimeoutMs`, `mcp` |
| `ice-unsafe-host-exec` | removed; use `--sub-yolo` or a user-scope child allow rule (section 9.7) |

`ice agents validate` prints these exact replacements per file and line. Rewriting stays manual.

---

## 24. Risks, rollback, and recovery

| Risk | Mitigation / rollback |
|---|---|
| Structural extraction changes behavior before V2 exists | Phase 1 move-only behavior; focused regression tests after each extraction |
| One registry rewrite loses durable job semantics | Persist acceptance first; port durable-job tests before deleting job registry |
| Exact contract persistence leaks secrets | Persist post-redaction normalized prompt/context only; reuse session redaction; tests with credential variants |
| Frozen child contract conflicts with current parent policy | Fail resume before model turn; surface blocked diagnostic; never silently re-resolve |
| sub-yolo accidentally becomes an authority bypass | Algebra property tests; one session factory; no unsafe tool derivation branch |
| Definition reload mutates live child behavior | source hash + frozen contract; reload affects new children only |
| Dirty baseline is very large | hard byte ceiling before buffering untracked content; actionable refusal |
| Parent changes while child works | three-way apply against captured baseline; conflict -> no parent mutation |
| Patch integration corrupts pre-existing staging | snapshot parent index; apply child result to working tree only; verify index hash unchanged |
| Nested repositories produce misleading deltas | per-repo baseline or explicit refusal at boundary |
| Parking/resume race uses disposed session | detach-before-dispose + ref generations + coalesced revive |
| Delete followed by restart resurrects child | tombstone persisted before file cleanup |
| Completion delivered twice across crash | durable delivery ID + acknowledged/delivered marker |
| Agent Hub diverges from runtime | UI consumes registry snapshots/events only; no UI-owned lifecycle map |
| Prompt cache churn | static tool schemas; agent-list delta custom messages |
| Too much runtime code remains in ice-subagents.ts | Phase 1 size gate and Phase 10 removal |
| Clean break removes a hidden useful behavior | Phase 0 regression ledger requires explicit KEEP/PORT/N/A for every current test/surface |

Rollback between phases means reverting only the current phase's ICE commits; no phase is considered complete with a failing required check. Do not delete legacy runtime code until its V2 replacement and regression evidence are green.

---

## 25. Definition of done

V2 is complete only when all of the following are true:

1. Child AgentSessions still use the single Ice reasoning/tool loop.
2. AgentDefinition discovery matches the locked semantics, including trust and precedence.
3. The model automatically sees callable agents through a stable delta mechanism.
4. Native .ice agent schema is strict and .claude compatibility is opt-in.
5. Child tools are always a subset of live parent-active child-safe tools.
6. For every operation, child permission is never more permissive than parent permission.
7. sub-yolo has no alternate tool/session factory and cannot widen authority.
8. plan/review read-only ceilings cannot be weakened.
9. One ChildRegistry owns lifecycle identity across foreground/background/parked/resumed/UI/RPC.
10. One ag_id addresses a child for its full durable lifetime.
11. Accepted runtime contract is persisted before launch.
12. Child transcript and complete frozen runtime contract survive process restart.
13. Cold revival recreates the same contract, not the latest definition.
14. Parent authority revocation blocks resume before any model/tool call.
15. Interrupted tool calls are never auto-replayed.
16. Background completion is durable and delivered at most once.
17. No default child lifetime timeout exists; explicit budgets work and are observable.
18. Dirty-parent worktree child sees the captured parent WIP.
19. Patch artifact contains only child delta, excluding pre-existing parent WIP.
20. Concurrent parent changes are reconciled safely or rejected without partial mutation.
21. Existing tamper/path/symlink/verifier/rollback writer protections remain.
22. Agent Hub is a live projection over ChildRegistry with focus, steer/follow-up, wait, revive, stop, delete, output, approval, and patch actions.
23. Existing user-takeover ownership semantics remain.
24. Hooks preserve intent/outcome persistence and fail-closed required behavior.
25. MCP/custom adapters remain parent-owned, fingerprinted, bounded, and revocation-safe.
26. Typed outcomes, task contracts, evidence validation, assurance levels, and artifact bounds remain.
27. Old model-facing subagent tools are absent.
28. Old public settings keys do not silently alias into V2.
29. Old runId/jobId/resultRef addressing is absent from the model-facing surface.
30. The Phase 0 regression ledger has no unexplained missing invariant.
31. Targeted tests, ./test.sh, and corepack npm@12.0.2 run check pass.
32. Documentation describes only behavior proven by the final implementation.
33. Without `--sub-yolo` or a user/managed child allow rule, children cannot run Bash or edit the parent workspace unattended; project-scope sources cannot raise child mutation authority.
34. The model's agent list is complete again after compaction, branch navigation, and resume.
35. The `ice.subagents.v2` gate and every legacy tool are gone.

---

## 26. Evidence index

### ICE current implementation

- AGENTS.md:20-42 - architecture, permission, trust, delegation, verification, recursion, artifact rules.
- idea.md:318-346 - current native child target and capability derivation.
- idea.md:398-418 - autonomy safety requirements including durable resume and no blind replay.
- packages/coding-agent/src/ice-subagents.ts:6977 - live session registry.
- packages/coding-agent/src/ice-subagents.ts:7280 onward - normal child session factory.
- packages/coding-agent/src/ice-subagents.ts:7605 onward - writer session factory.
- packages/coding-agent/src/ice-subagents.ts:13682-13685 - current multiple registries/stores.
- packages/coding-agent/src/ice-subagents.ts:16896-16906 - durable job persistence wiring.
- packages/coding-agent/src/ice-subagent-timeout-supervisor.ts:447 - supervisor registry.
- packages/coding-agent/src/ice-subagent-jobs.ts:1211 - durable job registry.
- packages/coding-agent/src/ice-subagent-capabilities.ts:17-31 - parent-owned adapter contract.
- packages/coding-agent/src/ice-subagent-capabilities.ts:55-77 - management tool denylist.
- packages/coding-agent/src/ice-subagent-settings.ts:35-51 - existing settings shape.
- packages/coding-agent/src/ice-subagent-settings.ts:168-180 - currently removed execution-budget fields.
- packages/coding-agent/src/ice-subagent-assurance.ts:3-16 - runtime-owned evidence invariant.

### Claude Code reference

- Agent_harness_references/claude-code/src/utils/markdownConfigLoader.ts:191-289 - project boundaries.
- Agent_harness_references/claude-code/src/utils/markdownConfigLoader.ts:297-429 - source loading, worktree fallback, inode dedupe, memoization.
- Agent_harness_references/claude-code/src/tools/AgentTool/loadAgentsDir.ts:73-133 - definition fields.
- Agent_harness_references/claude-code/src/tools/AgentTool/loadAgentsDir.ts:193-221 - precedence.
- Agent_harness_references/claude-code/src/tools/AgentTool/loadAgentsDir.ts:296-382 - identity/parse/invalid-file behavior.
- Agent_harness_references/claude-code/src/tools/AgentTool/prompt.ts:40-63 - listing/delta.
- Agent_harness_references/claude-code/src/tools/AgentTool/agentToolUtils.ts:70-225 - live tool resolution.
- Agent_harness_references/claude-code/src/tools/AgentTool/runAgent.ts:330-530, 700-790 - child transcript/config/permission execution.
- Agent_harness_references/claude-code/src/constants/tools.ts:36-46 - child management denylist.

### Prime Agent reference

- Agent_harness_references/prime-agent/packages/coding-agent/src/core/rlm-runtime.ts:14-104, 272-321 - child runtime identity/options.
- Agent_harness_references/prime-agent/packages/coding-agent/src/core/agent-session.ts:9957-10099 - parent-derived persistent child AgentSession.
- Agent_harness_references/prime-agent/packages/coding-agent/src/core/agent-session.ts:10680-10834 - descendant inspection/quiescence/cancellation.
- Agent_harness_references/prime-agent/packages/coding-agent/src/modes/agents-view/agents-view-state.ts:15-95, 192-295 - unified live/persisted view model.
- Agent_harness_references/prime-agent/packages/coding-agent/src/modes/interactive/components/subagent-summary-line.ts:9-55 - main-session child summary.
- Agent_harness_references/prime-agent/packages/coding-agent/src/modes/agents-view/agents-view-mode.ts:948-993 - action-driven agents UI.
- Agent_harness_references/prime-agent/packages/coding-agent/src/modes/daemon/rlm-subagent-display.ts:28-80 - durable display metadata/tombstone-style state.

### Oh My Pi reference

- Agent_harness_references/oh-my-pi/packages/coding-agent/src/task/spawn-policy.ts:1-73 - explicit spawn policy.
- Agent_harness_references/oh-my-pi/packages/coding-agent/src/task/read-only-policy.ts:3-29 - fail-safe read-only classification.
- Agent_harness_references/oh-my-pi/packages/coding-agent/src/task/persisted-revive.ts:43-57, 102-205 - full runtime-contract revival.
- Agent_harness_references/oh-my-pi/packages/coding-agent/src/registry/agent-registry.ts:1-32 - lifecycle states.
- Agent_harness_references/oh-my-pi/packages/coding-agent/src/registry/agent-lifecycle.ts:235-430 - park/revive/race/tombstone mechanics.
- Agent_harness_references/oh-my-pi/packages/coding-agent/src/task/worktree.ts:38-53, 185-267 - dirty baseline capture/delta.
- Agent_harness_references/oh-my-pi/packages/coding-agent/src/task/worktree.ts:580-715 - three-way/WIP replay application.
- Agent_harness_references/oh-my-pi/docs/agent-hub.md:1-93 - Agent Hub UX.

### Codex reference

- Agent_harness_references/codex/codex-rs/core/src/tools/handlers/multi_agents_spec.rs:166-313 - send/follow-up/resume/wait tool semantics.
- Agent_harness_references/codex/codex-rs/core/src/tools/handlers/multi_agents/send_input.rs:47-133 - load/interrupt/send behavior.
- Agent_harness_references/codex/codex-rs/core/src/tools/handlers/multi_agents/wait.rs:95-219 - status subscription wait.
- Agent_harness_references/codex/codex-rs/core/src/tools/handlers/multi_agents/resume_agent.rs:33-99 - explicit resume.
- Agent_harness_references/codex/codex-rs/core/src/tools/handlers/multi_agents/close_agent.rs:31-102 - explicit close.
- Agent_harness_references/codex/codex-rs/core/src/agent/child_config.rs:123-193 - live parent-derived resume/permission config.
- Agent_harness_references/codex/codex-rs/core/src/agent/role.rs:50-127 - typed role overlays.

---

## 27. Start here

The first implementation session covers Phase 0 only. It changes no runtime behavior.

1. **P0.1:** add a "Subagent V2 (target, not shipped)" section to `idea.md` with D1-D25 and the revision 2 additions (section 9.7 ceiling, rollout gate). Mark the current subagent architecture as the shipped baseline.
2. **P0.3:** write `Plan/subagent-v2-regression-ledger.md`. List every `packages/coding-agent/test/*subagent*`, `ice-agent-view*`, `ice-writer*`, and `subagent-footer` test file and describe-block, each marked KEEP / PORT / REPLACE / N/A with a reason. Generate the list with a script and fill in the classification by hand.
3. **P0.2 + P0.4:** create type-only contract files with no runtime wiring:
   - `src/subagents/definitions/schema.ts` (TypeBox `AgentDefinition`, native vs compat)
   - `src/subagents/contract/child-runtime-contract.ts`
   - `src/subagents/registry/state-machine.ts` (instance states, turn outcomes, legal transitions as data)
   - `src/subagents/permissions/rules.ts` (rule grammar types + section 9.7 ceiling table as data)
   - `src/subagents/api/{agent,agent-control,agent-patch}.ts` (TypeBox parameter schemas only)

   Each file gets a focused schema test.
4. Run the focused tests and `corepack npm@12.0.2 run check`, recording the npm versions.
5. Stop for review before Phase 1. Phase 1 moves code across about 17k lines and should start from an agreed ledger.

Run the Phase 1 extraction as move-only commits, one source module per commit, each followed by the affected tests. This keeps the extraction bisectable.
