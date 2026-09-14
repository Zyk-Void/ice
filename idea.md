# ICE

## Purpose

ICE is an upstream-friendly Ice distribution. It retains Ice's small, inspectable, provider-agnostic agent loop while adding repository intelligence, deterministic safety, verification, recovery, long-running execution, and controlled delegation.

ICE is not intended to maximize feature count or reproduce OpenHands, Claude Code, Codex, OpenCode, or OhMyPi. New machinery must earn its cost through measured reliability, security, or usability gains.

Core design:

> Ice decides, reasons, routes models, and owns interaction. ICE constrains, records, verifies, and recovers execution.

## Implemented Managed Subagent Timeout Multiplexing — 2026-09-14

A foreground `delegate` run no longer has to hold the parent tool call for its entire execution budget. `delegate` accepts an optional `background: true` control option: the parent receives a typed retained handle as soon as the child is admitted, while the same child session keeps running under the parent-owned supervisor. Nothing about the child changes — same run ID, child session, model, profile, scope, and tool authority; one initial task prompt; no replacement child and no prompt replay.

The retained lifecycle is explicit and event driven (no polling):

- `peek` returns the latest bounded observation immediately and mutates no budget and no authority.
- `wait` blocks the parent tool call for a bounded `waitMs` window (default 30 s, maximum 60 s) until a terminal or attention state. Expiry reports the current state with `waitExpired` and never marks the child `timed_out`.
- `extend` resumes a paused child with an explicit additional budget drawn from the extension reserve.
- `detach` retains the same child under management so the parent can continue other work. A running child is retained in place and no budget changes; a paused child resumes under a **separate bounded retention pool** (default 2 minutes, surfaced in the runtime summary), never the extension reserve.
- `stop` terminalizes deterministically as `cancelled`: an aborted child turn cannot downgrade an explicit parent decision into a generic failure or a silent completion.
- Managed terminal results are published exactly once into a bounded retained-result ledger, and the ledger is populated *before* the terminal transition wakes any pending management wait, so a waiter never observes terminal state without a result. The same single publication covers a run that finishes inside its first budget, with no extension and no stop decision: its durable observer is notified once from the runner's terminal path, so an in-process retained run and a durable job each observe exactly one terminal result.

Managed retention is in-process management, not durable background work: no queue, no cross-process recovery, bounded retention. Durable owner-scoped work remains the `delegate_async` job surface. A retained child stays bound to the parent **run** signal rather than to the launching tool call, exactly like `delegate_async`'s parent-run tie: a normal run completion never aborts that signal, so handing back the managed handle does not cancel the child. Termination comes only from an explicit parent abort, compact, or dispose of the launching run, from `manage_subagent stop`, or from session shutdown through `runner.shutdown()`.

Reproducible checks: `packages/coding-agent/test/ice-subagent-timeout-multiplexing.test.ts` (16 cases), `test/ice-subagent-timeout-supervisor.test.ts`, and the `manage_subagent` / `delegate` schema and execute-path contracts in `test/ice-subagents.test.ts`.

## Implemented Subagent File Agents, Self-Delegation, and Model Fallback — 2026-09-10

The completion implementation and reproducible checks are recorded in `.artifacts/ice-self-user-ready-20260910/`. Self launches now snapshot actual parent instructions automatically, allow only additive task guidance, and optionally inherit loaded skills. Child-safe extension tools and selected MCP tools use explicit parent-owned adapters with real schemas, live revocation, hooks, bounded output, and cancellation. Child sessions do not install ambient packages or load ambient extensions. Runtime stream failures cannot trigger task replay; only proven pre-effect startup failure may use a second attempt with remaining shared budgets. Accepted queued work retains route/capability/resource fingerprints. The user guide and HTML operator explainer describe migration and untested live-adapter boundaries.

Implemented (proposal was `agent_docs/implementation/subagent-self-delegation-model-fallback-plan.md`): no bundled specialist catalog remains in the delegation path; delegation resolves file agents global-first (`~/.ice/agents` wins over trusted `.ice/agents`; explicit custom `agentDir` uses `<agentDir>/agents`; legacy `~/.ice/agent/agents` is only inventoried for explicit migration, never moved automatically, and shadowed sources are surfaced) plus self-delegation (`role: "self"` with bounded parent instructions, fresh history default, no delegation/control tools). File agents support effective `model`/`fallbackModel` with deterministic call/primary/fallback/parent order, bounded skip reasons, startup-only retry, aggregate budgets, and durable route/candidate capture (stale routes fail explicitly). Explicit `mcp` server/tool selectors are opt-in and dispatch only through the parent-owned adapter with hooks, budgets, cancellation, and bounded output. `ice` settings/skills/prompts/context/hooks resolve global-first; denies, mode restrictions, caps, and trust still win. Stock `ice` keeps project-first behavior. `review_batch` runs self-delegated reviewers. Remaining live-certification gaps (real-provider routing/MCP adapter certification) are not claimed by fake-provider/fake-adapter tests.

## Approved Subagent Control Expansion — 2026-09-09

The user explicitly approved completing W20/W21 alternate per-child routing and W31–W33 command hooks. This supersedes historical deferral statements below for the opt-in read/review delegation adapters only; it does not authorize a competing loop, recursive delegation, default host execution, or changes to isolated writer authority.

- Default delegation retains exact parent-model object inheritance. Global `ice.subagents.modelSelection.mode=configured` permits exact per-call `execution.model` references resolved through Ice's existing ModelRuntime, with no discovery, auth expansion, or silent post-acceptance rerouting. File fallback follows the separately approved deterministic candidate contract. Captured route identity and capability hashes belong in durable job contracts.
- Command hooks require a separately reviewed global exact-command policy, trusted build mode, parent Bash authority, execution approval (or explicit host allow), bounded redacted JSON/environment, pinned executable/script identities, and native durable intent before effects. Project trust never enables execution by itself. Plan/review command hooks stay denied.
- Native durable entries are explicit opt-in; ordinary Ice session writes remain lazy. Memory-only parents cannot acknowledge durable hook intent. Unresolved effects are not replayed automatically.
- Trusted in-process handler registration and optional role/call hook selections remain parent-owned. Command execution is not sandboxed: filesystem, network, credentials, TOCTOU, and descendant cleanup limitations must be documented.
- Historical 49/0/5 ledgers describe the earlier control-hooks slice, not the current file/self plan. Use the new plan closure ledger and `.artifacts/ice-self-user-ready-20260910/` evidence for current implementation verification. External provider/server certification is separate.

## Current Product Shape

Implemented today:

- `ice` remains upstream-compatible Ice.
- `ice` is ICE entry point.
- ICE consumes separately published, rebranded dependency forks through package seams: the MIT-licensed `@zykairotis/ice-clipboard` family and the Apache-2.0-licensed `@zykairotis/ice-gondolin` family. Their source repositories, native/runner packages, and upstream license attribution remain external to this repository.
- `ice` loads the last valid local catalog and API key on launch and does not fetch `/v1/models` at startup. Refetch a provider catalog from `/settings` → Providers; the `local` provider is the OpenAI-compatible 9Router endpoint. Offline and metadata-only commands still skip network work.
- Endpoint model metadata drives model selection and limits.
- Last valid model catalog remains usable if endpoint is unavailable.
- API credentials remain in user configuration and never enter Git.
- Auto-compaction triggers at a configurable percentage of the selected model's context window, defaulting to 85%; compaction summary budgeting remains configured separately.
- An optional deterministic Blackhole compaction extension can own mid-run triggering with resume/pause behavior and percentage or absolute token thresholds; observational memory remains opt-in and is not part of the default profile.
- `ice` loads the hidden `ice-cognee` extension by default. It uses the configured dataset (`ice`, or `$project` for per-repo isolation), bounded transient recall, redacted session capture, compaction-linked remember, and optional idle/shutdown improve with `/cognee` runtime toggles; startup health probing is asynchronous so an unavailable local API does not delay or break the Ice loop.
- Cognee is a bounded derived-memory adapter, not a second session history store: recall is untrusted turn-scoped system-prompt context, captured prompts, answers, and tool traces are redacted before remote storage, and compaction summaries are queued for permanent remember. `auto` never owns the Ice compact summary. Improve is an explicit extension capability, not part of Ice's core loop; unsupported server routes fail visibly without blocking Ice.
- `/cognee watch` provides a loopback-only realtime observer over capped, redacted local events. It shows agent/session identity and Cognee lifecycle without adding a second memory or session store; prompt recall also reports immediate animated activity before Ice's model request.
- The interactive theme picker includes all 98 themes from OhMyPi's pinned catalog alongside Ice's native dark and light themes.
- `/customize` provides native global appearance customization with one preview/apply/cancel transaction across semantic themes and component presentation (the same editor opens from `/settings -> Appearance`). Appearance v2 covers user messages, assistant containers, editor border/padding/idle-active colors, thinking indicators/verbs/blocks, Markdown element presentation with table strategies, tool shells, Bash execution, diffs, system cards, shared status indicators, footer field presentation, shared selector chrome, agent switcher chrome, and bounded literal input highlighters with case sensitivity. Theme selection is typed fixed-or-automatic light/dark with a preview side; custom themes stage clone/rename/delete/import/export, grouped semantic-token editing, and variable add/edit/rename/delete with reference safety. Color authoring supports theme tokens, hex/rgb/hsl, terminal default, and none through a shared color editor. Imports resolve collisions explicitly (rename, replace custom, cancel) and bundles carry metadata, both automatic-mode themes, and profiles; profiles support descriptions and appearance-only presets. Screens keep persistent sections with breadcrumbs, dirty markers, per-section reset, searchable lists, and a scene-focused live preview; wide terminals split controls and preview. Everything is validated data-only settings: previews are non-persisting, root Apply persists validated state once, root Cancel restores the captured runtime baseline with zero writes, and the process-scoped Markdown table default is restored when interactive mode stops.
- `ice` bundles Guarded Build v0 with OMP-equivalent plan behavior through Ice-native seams: exact plan/build tool modes; repository-grounded planning questions; incremental draft/refine/propose state; scrollable Markdown review; fresh, compact, or preserved-context approval; optional planning/execution model routing; bounded convergence reminders; reopenable durable approval; mandatory approved-plan reread gating; Bash default-off; canonical direct edit/write checks; and one project-trusted settled verifier.
- `ice` loads hidden native delegation tools with file-agent and self-delegation resolution (no bundled profile catalog; global `~/.ice/agents` wins over trusted `.ice/agents`, `role: "self"` derives a bounded child from the parent). File agents declare requested capabilities while each invocation derives effective capabilities from the parent policy: safe children stay read-only, and explicit trusted YOLO may grant only requested host/mutation tools already active in the parent. By default a child inherits the exact current parent model; explicit globally authorized file/call candidates may select another route. Every child uses fresh in-memory history by default, supports opt-in sanitized fork continuity, strips ambient child resources, enforces tool-boundary scope, returns bounded results (a plain final assistant answer for ordinary delegations, a verified JSON report for typed `outputSchema`/acceptance/review flows), and preserves deterministic cancellation/timeout; stock `ice` remains unchanged. ICE exposes live children and bounded redacted history through `IceAgentViewBridge` and the normal InteractiveMode shell without replacing the authoritative parent runtime. Live views default to mirror mode; explicit Take Control routes user steering to the child, and steered runs receive a dedicated bounded final-answer turn before parent synthesis (plain prose for ordinary delegations, the structured JSON report for typed flows).
- Forked subagents derive a bounded deterministic hashed prompt-cache affinity key from their stable contract and pass it through `StreamOptions.promptCacheKey`; adapters with an independent cache channel keep that affinity separate from child session IDs, continuation state, and Codex WebSocket reuse. Anthropic-compatible routes that expose only `x-session-affinity` retain the unique child `sessionId` and ignore the cache-only field. Fresh children and cache-retention `none` remain isolated.

Fork prompt-cache adapter boundary:

| Adapter family | `promptCacheKey` channel | Session/continuation channel |
|---|---|---|
| OpenAI Responses, Chat Completions, Azure Responses | `prompt_cache_key` request field | `sessionId`-derived headers and provider continuation state |
| OpenAI Codex Responses | `prompt_cache_key` request field | `sessionId`-keyed headers, WebSocket connections, and `previous_response_id` |
| Mistral Conversations | `promptCacheKey` request field and generated `x-affinity` | `sessionId` fallback; explicit caller `x-affinity` wins |
| Anthropic-compatible routes | Ignored because the available `x-session-affinity` channel is session-affinity | Unique `sessionId` in `x-session-affinity` when enabled |
| Faux provider | Internal cache map key | Independent `sessionId` passed to the stream |
- ICE now resolves a strict `ice.subagents` / `ice.hooks` namespace through the existing `SettingsManager`: global and trusted-project defaults, per-role defaults, deny-first role/tool restrictions, bounded thinking/timeout/turn/tool/output controls, source-aware launch provenance, and RPC/interactive settings projections. Optional aggregate token budgets use `input + output + cache-write` tokens, report cache reads separately, reserve one bounded finalization slice, preserve one-response overshoot and provider/estimated/mixed accounting, and remain independent from turns, tools, timeout, context, result bytes, and cost. Native children stop at a safe boundary and use one tool-free finalizer or deterministic parent fallback; batch reservations are atomic, durable summaries are bounded, built-in adapters receive runtime output authority where supported, custom routes remain aggregate-soft, and no dollar-cost guarantee is made. Empty role allowlists are neutral preferences; deny lists remain authoritative, malformed settings fail closed, and accepted durable jobs retain their resolved execution contract. Delegation resolves file-agent `model`/`fallbackModel` with deterministic call/primary/fallback/captured-parent order, startup-only retry, and durable route capture. Parent-owned in-process lifecycle hooks can gate launch, final tool dispatch, and result acceptance or observe bounded lifecycle events; hook approvals are cancellation/deadline bounded and durable results retain redacted hook outcomes. Delegation supports a restricted local `outputSchema` for a bounded nested payload, actual Ice turn accounting, and owner-bound idempotent `manage_subagent` follow-up that reuses the retained native child and rejects user-takeover conflicts.
- Read-only delegation accepts optional `scope.targets` exact-file focus metadata. Targets must be existing canonical regular files, remain inside canonical `scope.roots`, reject traversal, symlink, directory, missing, and outside-root paths, and are deduplicated before being preserved through prompts, launch preflight, provenance, and results; roots remain the authority boundary while prompts and digests render safe repository-relative target paths.
- W9 adds explicit `--ice-mode build --ice-allow-bash --sub-yolo` host execution for confirmed foreground, durable async, batch, and review delegation paths, including RPC sessions authorized at startup. Default delegation remains read-only; the escape hatch makes a profile's requested host/mutation capabilities eligible only where they also intersect the trusted parent's active scoped built-ins (`read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`). It does not flatten every role into a generic full-tool worker. YOLO disables recovery retry, requires project trust and active parent Bash, and uses TUI confirmation for interactive launches or the explicit startup command as session-wide authorization in RPC. Cancellation is best-effort. Ambient child extensions and recursive delegation remain disabled. Selected MCP tools require the dedicated parent adapter; review jobs remain read-only. `delegate_write` remains a separate primitive. Normal `delegate_write` remains worktree-isolated and mutation-scoped; explicit YOLO `delegate_write` is the separately labeled direct-parent-workspace exception with no patch artifact or rollback. This is explicitly not a sandbox: host filesystem, process, network, credentials, and descendant cleanup remain outside containment; no `--no-sandbox` mode is advertised.
- W1 adds build-only normal `delegate_write` as a separate primitive: the parent must be a clean Git worktree under `git status --porcelain=v1 -uall`, supply a full local 40-character SHA equal to current `HEAD`, and launch one foreground child in a temporary detached worktree. The child has only scoped `read`, `grep`, `find`, `ls`, `write`, and `edit`; Git metadata, Bash, network, MCP, extensions, delegation, retries, and parent integration are denied. W2 adds a trusted parent-side collector that inventories actual `git status --porcelain=v1 -z -uall` changes, reads raw `HEAD:path` and writer-worktree bytes, hashes those same bytes, and builds isolated `git diff --no-index` patches with external diff and textconv disabled. It accepts only regular UTF-8 text additions/modifications, rejects deletes, ignored paths, symlinks, gitlinks, binary data, scope escapes, and unsupported statuses, and writes immutable patch artifacts capped at 32 files and 512 KiB outside both worktrees without writing Git objects. Only `completed` writers receive a patch reference; W2 is frozen. W3 adds one parent-owned `integrateWriterPatchArtifact()` entry point with immutable artifact expectation snapshots, clean `HEAD`/worktree/index preconditions, exact preimage checks, checked non-fuzzy apply, required parent verification, post-verifier postimage/status validation, and compare-and-swap rollback that restores safe paths while raising explicit integration/rollback conflicts instead of overwriting newer state; W3 is frozen at this narrow optimistic-concurrency boundary, which is not literal atomic filesystem compare-and-swap without OS/repository locking. W4 adds three stateless parent-facing build tools around these frozen APIs: `inspect_writer_patch` validates a genuine W2 production artifact and returns capped metadata/preview; `reject_writer_patch` records only the current non-durable parent decision; and `integrate_writer_patch` requires a trusted build session and configured `--ice-verify` before calling W3. Artifact provenance is canonical `<agentDir>/artifacts/writer/<runId>/proposal.patch` equality, with regular-file, exact-byte/hash, schema, and inventory checks. No merge, rebase, commit, or conflict-resolution workflow is included. W5 adds a provider-free end-to-end adversarial writer gate and an explicit `W5_LIVE=1` manual dogfood harness for `cx/luna` and `cmc/deepseek`. W6 observability remains implemented through the observatory store, bounded progress snapshots, tool render hooks, and optional `/agents`/`/subagents` monitoring or split transcript views; the primary full-view path now leaves the chooser and reuses the normal Ice InteractiveMode shell through `IceAgentViewBridge`. Live provider certification remains separate from default tests/checks.
- W7.1 adds one owner-scoped durable asynchronous read-only job through `delegate_async`, `inspect_subagent_job`, and `cancel_subagent_job`: append-only session snapshots, independent cancellation, bounded verified-result projection, safe-boundary metadata notices, owner-only inspection/cancellation, restart interruption without relaunch, and terminal retention. W7.2 extends the same registry with bounded active concurrency, FIFO durable queue admission, owner aggregate planned-output reservations, deterministic queued cancellation, persistence-before-promotion, and queue/budget inspection metadata. W8.1 adds metadata-only owner-scoped durable job sections to the `/agents` and `/subagents` chooser through a non-authoritative registry subscription and sanitized projection; no polling loop, result-body ingestion, or scheduler ownership is added. W8.2 adds one explicit configurable read-only inspect action for terminal BACKGROUND RECENT rows, calling the existing owner-scoped `inspect(jobId)` API and rendering only an ephemeral bounded result projection; it does not mutate session state or parent context. W8.3 adds a frozen noninteractive COMPLETION INBOX section derived once per chooser open from persisted `ice-subagent-job-completion` metadata intersected with current owner-scoped retained terminal jobs; inbox rows are metadata-only and not selectable. W8.4 now also connects foreground live child sessions to `IceAgentViewBridge`: full-mode selection leaves the chooser and displays the child in the normal Ice InteractiveMode shell while the parent runtime and sibling children continue. Live children default to mirror/read-only viewing; explicit Take Control enables steering, returning to mirror/parent releases control, and any steered foreground run is finalized through a dedicated bounded final-answer turn before verification (plain prose; the structured JSON report for typed flows). Completed foreground children are retained only as bounded, redacted, process-local historical snapshots: at most 32 recent child views, 96 messages per snapshot, 16 KiB per retained message, and 256 KiB total retained message data per snapshot. Historical views are read-only and are never automatically injected into parent context. Durable background jobs themselves remain non-steerable; background batch facades, background writers, auto-resume, queue-priority control, result ingestion, and live inbox state remain deferred.
- W7.1 adds one owner-scoped durable asynchronous read-only job through `delegate_async`, `inspect_subagent_job`, and `cancel_subagent_job`: append-only session snapshots, independent cancellation, bounded verified-result projection, safe-boundary metadata notices, owner-only inspection/cancellation, restart interruption without relaunch, and terminal retention. W7.2 extends the same registry with bounded active concurrency, FIFO durable queue admission, owner aggregate planned-output reservations, deterministic queued cancellation, persistence-before-promotion, and queue/budget inspection metadata. W8.1 adds metadata-only owner-scoped durable job sections to the `/agents` and `/subagents` chooser through a non-authoritative registry subscription and sanitized projection; no polling loop, result-body ingestion, or scheduler ownership is added. W8.2 adds one explicit configurable read-only inspect action for terminal BACKGROUND RECENT rows, calling the existing owner-scoped `inspect(jobId)` API and rendering only an ephemeral bounded result projection; it does not mutate session state or parent context. W8.3 adds a frozen noninteractive COMPLETION INBOX section derived once per chooser open from persisted `ice-subagent-job-completion` metadata intersected with current owner-scoped retained terminal jobs; inbox rows are metadata-only and not selectable. W8.4 now also connects foreground live child sessions to `IceAgentViewBridge`: full-mode selection leaves the chooser and displays the child in the normal Ice InteractiveMode shell while the parent runtime and sibling children continue. Live children default to mirror/read-only viewing; explicit Take Control enables steering, returning to mirror/parent releases control, and any steered foreground run is finalized through a dedicated bounded JSON-report turn before verification. Completed foreground children are retained only as bounded, redacted, process-local historical snapshots: at most 32 recent child views, 96 messages per snapshot, 16 KiB per retained message, and 256 KiB total retained message data per snapshot. Historical views are read-only and are never automatically injected into parent context. Durable background jobs themselves remain non-steerable; background batch facades, background writers, auto-resume, queue-priority control, result ingestion, and live inbox state remain deferred.
- Child execution reuses the existing `AgentSession` transient provider retry path with parent-resolved bounded retry settings, exposes redacted retry lifecycle and `wrapping_up` phase state through existing views/observatory events, injects one deterministic wall/turn/tool wrap-up prompt before hard limits, and preserves oversized partial or final reports in bounded redacted local artifacts referenced by capped result metadata. Provider/runtime failures remain failures; only explicit cancellation and genuine deadlines produce cancellation/timeout statuses, and tool or writer side effects are never replayed.
- Phase B1 adds the typed sibling-only `delegate_batch` fanout over the same `runResolved()` executor: at most 8 read-only tasks, default concurrency 2, hard maximum 4, fresh sessions, independent scopes, parent-owned reservations over complete JSON report bytes, observed terminal output accounting, bounded `totalBudgetBytes`, deterministic result ordering, aggregate usage, and cancellation/timeout. Phase B2 adds typed `review_batch` orchestration over that scheduler for correctness, security, tests, and regression dimensions, with independently verified structured findings and contradiction preservation. Default launches use the current parent `Model` object; globally configured file/call routing is supported. Durable jobs capture the selected route at acceptance and never silently reroute. Phase B4 adds one parent-owned typed launch preflight for both batch APIs plus a bounded model-visible digest; it composes resolved contracts and existing validation before worker launch. Phase B5 adds one immutable typed context-packet path for legacy text and explicit parent-selected items; packet content is untrusted handoff data and metadata only reaches preflight. Phase B6.1 adds opt-in `fresh | fork` mode: fork sanitizes only `buildSessionContext().messages` into a frozen, redacted, UTF-8-bounded snapshot, keeps the child fresh, and enforces a combined packet/fork handoff budget. The file/self expansion supersedes B7.1 recovery: two total attempts only for proven pre-effect startup failure, unchanged authority/context, remaining aggregate budgets, and attempt provenance. Approved foreground/batch fallback is supported; runtime failures and queued routes cannot replay or reroute. W7.1 and W7.2 are frozen as the one-owner durable asynchronous read-only job slices; background batch facades, recursive delegation, writers, auto-resume, steering, and Hivemind remain outside this slice; W1 writer workspaces, W2 patch artifacts, W3 parent-owned patch verification/integration, and W4 parent-owned inspect/reject/integrate decisions are implemented separately.
- Plan state remains bounded and session-native rather than introducing OMP's `local://` or `xd://` artifact protocols. Fresh execution uses a durable context boundary, compact execution uses Ice's native compaction, and headless proposals remain pending until an approval-capable client acts.
- Guarded Build v0 is guarded execution, not a sandbox: opted-in Bash, custom external effects, and filesystem TOCTOU remain outside its direct-tool boundary.

Current endpoint:

```text
http://127.0.0.1:20128/v1
```

Credential location:

```text
~/.ice/agent/auth.json
```

Generated local catalog:

```text
~/.ice/agent/models.json
```

Both credential and generated catalog are runtime state, not repository source.

Everything below marked as target architecture or roadmap is not necessarily implemented.

## Target Architecture

Use a balanced hybrid, not a replacement loop:

```text
User / CI / RPC
      |
      v
Stock Ice
  provider and model registry
  minimal agent loop and core tools
  prompt, instructions, skills, sessions, compaction
  TUI, print, JSONL, RPC, and SDK surfaces
      |
      v
ICE extensions and services
  policy and approvals
  trace and accounting
  repository intelligence
  verification and bounded recovery
  optional workspace isolation
  optional durable tasks and delegated workers
      |
      +-- host workspace
      +-- rootless container or VM
      +-- isolated Git worktree
      +-- optional remote/OpenHands adapter
```

Ice remains the single authoritative reasoning and tool loop. Policy, tracing, verification, task state, workspaces, and recovery wrap Ice through stable hooks, launchers, adapters, and extension-owned session entries.

### Capability profiles

| Profile | Purpose | Capabilities |
|---|---|---|
| `interactive` | Fast daily terminal work | Stock Ice loop, core tools, sessions, instructions, lightweight permissions |
| `safe` | Recommended default | Interactive plus tracing, protected paths, checkpoints, and verification |
| `sandboxed` | Untrusted or unattended work | Safe plus isolated workspace, network policy, and scoped credentials |
| `autonomous` | Long-running issue-to-patch work | Sandboxed plus durable task state, recovery, CI gates, and optional delegation |

`safe` is the target default. Browser automation, MCP aggregation, remote workers, subagents, and full autonomy remain opt-in and lazy-loaded.

### Execution modes

Modes are distinct from profiles:

- `ask`: answer or inspect with no implicit mutation.
- `plan`: read-only planning; no side-effecting commands.
- `build`: approved repository mutation and verification.
- `review`: read-only review of an exact diff, commit, or worktree.
- `autonomous`: durable bounded execution under sandbox, budget, and stop gates.

Profiles define available capabilities and isolation. Modes define current permissions and stop conditions.

## Ownership Boundary

### Keep upstream-owned

Do not fork or shadow these unless an upstream limitation is demonstrated by a failing test:

- central model/tool loop
- provider and model registry
- streaming, cancellation, steering, and reasoning controls
- provider-boundary tool-call normalization
- default coding tools
- system-prompt construction
- hierarchical instructions and lazy skills
- session tree and context compaction
- TUI, print, JSONL, RPC, and SDK modes
- extension lifecycle and custom-provider registration
- model switching

### ICE owns

Build outside upstream-owned source paths where stable seams permit:

- capability-profile resolution
- deterministic allow/ask/deny policy
- protected-path and external-directory rules
- structured trace, provenance, usage, cost, and artifacts
- repository maps, language detection, checkpoints, and edit guards
- verifier manifests, regression baselines, and bounded repair
- workspace adapters and sandbox launchers
- durable task state, budgets, recovery, and background-job tracking
- optional flat delegation through a ICE-owned tool, with native read-only child sessions first, W1 worktree-isolated writers, W2 bounded patch artifacts, and W3 parent-owned verification/integration
- optional Hivemind coordination above the subagent runner: parent-as-queen scheduling, run-scoped evidence state, bounded fan-out, advisory consensus, and verified learning
- bounded derived-memory adapters such as `ice-cognee`
- headless task orchestration and evidence reports

### Optional external mechanisms

- OpenHands: workspace/runtime adapter, remote agent server, and isolation patterns
- Codex: sandbox, approval, worktree, review, and resumable-headless behavior
- Claude Code: public permission, hook, plan-mode, instruction, skill, and subagent semantics
- OpenCode: client/server sessions, role profiles, and permission patterns
- Aider and Agentless: repository maps, checkpoints, localization, and deterministic validation
- OhMyPi: content-anchored edits, optional LSP/DAP, and isolated child worktrees
- ActiveLoop Hivemind: Ice lifecycle integration plus shared trace, retrieval, summarization, and skill-learning patterns
- Ruflo: explicit hive topology, worker membership, consensus/state, and collective-coordination patterns
- Grok Build: durable goal, budget, pause, and stop-state patterns for autonomous mode
- mini-SWE-agent: minimal transparent fallback and evaluation baseline

Adapt mechanisms only. Do not copy proprietary implementation or make another harness mandatory.

## Design Principles

### 1. Upstream first

Use current upstream implementation before adding fork code. If upstream gains equivalent functionality, remove or shrink ICE implementation after migration testing.

### 2. Smallest stable seam

Preferred order:

1. No new feature when existing behavior suffices
2. Configuration
3. Existing extension or hook
4. Separate launcher or adapter
5. Small shared helper
6. Core-loop modification only when no stable seam exists

### 3. Exact model capabilities

Models are selected by provider and exact model ID, not vendor-specific branches. Preserve endpoint metadata when available:

| Endpoint capability | Ice model field |
|---|---|
| `contextWindow` | `contextWindow` |
| `maxOutput` | `maxTokens` |
| `reasoning` | `reasoning` |
| `vision` | `input: ["text", "image"]` |

Also retain tool-calling and structured-output support where exposed. Unsupported numeric limits remain unknown; never invent them. Provider-specific reasoning controls remain provider-specific rather than being forced into a false universal API.

Tool support is required for normal coding models. Models without reliable native tool calls may use an optional constrained shell-only profile.

Primary work, planning, compaction, and review may use their existing Ice-owned model routing. ICE delegated children do not add per-role routing: every child uses the exact current parent `Model` object, captured at tool launch or durable async acceptance.

### 4. Context safety

Compaction should happen before a model loses space required for its answer. The automatic trigger defaults to 85% of the selected model's context window and is user-configurable. `reserveTokens` controls the compaction summary response budget; advertised maximum output must not automatically become summary size.

Structured compaction must preserve goal, constraints, decisions, changed files, verifier failures, unresolved risks, and next steps. Compaction changes active context, not durable session history.

Repository context should be selected by relevance. Use concise file/symbol maps and lexical indexes before adding embeddings. Large outputs belong in an artifact store and enter context through capped summaries and stable paths or IDs.

### 5. Secure failure

- Never print, trace, or commit secrets.
- Write generated catalog atomically with mode `0600`.
- Bound startup refresh with timeout.
- Use last valid catalog when refresh fails.
- Establish project trust before loading repository-local executable configuration or extensions.
- Resolve gated actions to `allow`, `ask`, or `deny` with deny-first precedence and recorded provenance.
- Protect `.git`, shell profiles, agent configuration, credentials, secrets, and external directories.
- Fail closed in headless mode when approval is missing.
- Keep autonomous network access disabled or explicitly allowlisted.
- Inject only short-lived, scoped credentials required by the task.
- Require explicit policy or user approval for push, merge, release, deploy, or other external side effects.

Prompt-based permission is not a sandbox. Untrusted and unattended work requires an independent filesystem, process, network, and credential boundary.

### 6. Repository integrity

- Snapshot commit, branch, dirty state, and pre-existing changes before mutation.
- Never mix agent changes with pre-existing human changes silently.
- Validate full patches before applying any hunk.
- Reject stale edits when a file changed after it was read.
- Prefer stable contextual or content anchors over raw line numbers when evidence supports them.
- Support dry-run, task/file/hunk undo, and isolated worktrees for concurrent writers.
- Treat repository scripts and dependencies as untrusted executable content.

### 7. Verification is authoritative

A model cannot declare its own work complete.

- Projects declare versioned lint, type-check, build, unit, integration, security, and artifact checks.
- Command discovery may suggest checks but must not persist or execute untrusted scripts without policy approval.
- Run targeted checks after bounded changes and required full checks before completion.
- Compare baseline failures with final failures.
- Invalidate verification when relevant files change.
- Permit only a bounded repair loop.
- Final reports list changed files, commands, exit statuses, artifacts, known failures, and unverified assumptions.

Deterministic exit codes and observed artifacts override generated confidence.

### 8. Durable, bounded autonomy

Task objective, acceptance criteria, plan steps, attempts, budgets, verification runs, changed files, and unresolved risks live in structured state rather than prose alone.

Long-running work must support pause, resume, cancel, crash recovery, and explicit failure classes. Retry only transient, retry-safe operations. Never blindly replay interrupted non-idempotent tools.

Detect repeated actions, repeated errors, alternating loops, no changed state, and unproductive monologues. Repeated strategy failure causes replanning or escalation, not another identical call.

### 9. Controlled delegation

Delegation is optional, flat, and read-heavy first. Ice remains the authoritative parent loop; ICE adds delegation through a `ice`-only hidden `delegate` extension/tool rather than another planner/controller.

Target V1:

```text
Parent Ice AgentSession
  -> `delegate`
      -> ICE subagent manager
          -> fresh native child AgentSession
              -> SessionManager.inMemory()
              -> bundled profile catalog (read-only investigators/reviewers plus implementation, testing, debugging, documentation, performance, and refactoring roles)
              -> no extensions/skills/templates/themes/context-file discovery
              -> effective tools = parent active tools ∩ profile-requested tools ∩ invocation policy
          -> typed bounded result/evidence
  -> parent verifies and synthesizes
```

Rules:

- `delegate` is loaded by `ice`, not stock `ice`.
- Existing parent mode/tool policy remains authoritative; delegation observes `ice.getActiveTools()` rather than creating separate plan/build permissions.
- Bundled and configured roles use explicit provenance, project trust, and execution-time source-hash revalidation; profile metadata may request capabilities but cannot widen the parent or invocation policy.
- Child gets separate context/history and only an explicit handoff packet; the parent transcript is not cloned.
- Child resource discovery is off by default: no ambient extensions, skills, prompt templates, themes, or context files. Phase A can pass only explicitly selected, validated skills/prompts/context files.
- User context selection is rooted at `$ICE_AGENT_DIR/context/`; the agent directory itself is never a context root, so `auth.json`, `oauth.json`, `models.json`, settings, and sessions cannot enter through context selection.
- Selected skill directories receive a separate exact read capability; repository scope is not widened. Selected prompt bodies are bounded and included in the explicit handoff instead of relying on disabled slash-template expansion. Selected resources are capped at 64 KiB per file and 256 KiB in aggregate.
- The parent resolves one immutable launch contract. The exact current parent `Model` object, child startup, hash revalidation, execution, verification, and returned provenance all use that contract; durable async jobs capture the model at acceptance time.
- Safe delegated children are read-only and receive no Bash, edit/write, network/MCP, Cognee/Blackhole/guard extension, credential expansion, or recursive `delegate` capability by default. Explicit `--sub-yolo` is the separately gated unsafe host-execution exception; it grants only capabilities requested by the selected profile that are also active in the trusted parent, including Bash, edit, and write when both sides permit them, but not child extensions, MCP, or recursive delegation.
- Child result is typed, bounded evidence rather than trusted authority or an injected transcript.
- Parent owns integration and verification.
- Cancellation and timeout propagate to the child and terminate the run deterministically. A foreground child may also be launched in managed mode (`delegate` with `background: true`), which returns a retained handle at admission while the same session continues under the supervisor; managed runs are observed and controlled with `manage_subagent` (`peek`, `wait`, `extend`, `detach`, `stop`). Detaching a paused child draws on a separate bounded retention pool rather than the extension reserve, and a stop always terminalizes as `cancelled`.
- Explicit trusted configurable roles/resources are implemented as Phase A capabilities; trust grants eligibility, selection grants inclusion, and policy remains authoritative.
- Parallel read fan-out comes after single-child lifecycle and accounting are stable; use conservative bounded concurrency.
- Writers require isolated worktrees/workspaces and return observed patches/branches for parent verification, except the explicit trusted YOLO direct-parent-workspace path, which reports no isolation and requires no patch integration.
- Background workers require durable owner-scoped job state, recovery, cancellation, retention, and completion delivery; the durable `delegate_async` job surface owns that contract. The foreground `delegate` `background` option is *not* a durable worker: it is in-process managed retention of the same child (bounded observation, bounded retention, no queue, no cross-process recovery) and must not be used for work that has to survive the parent process.
- No recursive delegation by default; hierarchical swarms are not a target architecture.

#### Hivemind coordination layer

After bounded parallel read workers are proven, ICE may add an optional Hivemind layer above the same subagent executor. The parent Ice session is the logical queen; Hivemind is deterministic scheduling, run-scoped state, evidence aggregation, and advisory consensus rather than another autonomous planner.

Target shape:

```text
Parent Ice AgentSession
  -> `hivemind` with explicit tasks/budget
      -> HivemindCoordinator
          -> sibling SubagentRuns through the same executor as `delegate`
          -> typed run-scoped EvidenceBoard
          -> contradiction/evidence-quorum analysis
      -> bounded HiveResult
  -> parent verifier remains authoritative
```

Rules:

- use a star topology first; workers do not directly spawn or message peers;
- Hivemind cannot widen worker tools, mode, scope, network, credentials, or memory access;
- consensus is advisory and never overrides deterministic verification;
- do not claim Byzantine fault tolerance merely because several LLM workers vote; correlated model failures do not satisfy a distributed BFT fault model;
- durable learning is separate from coordination: raw worker output is redacted/distilled and becomes only a candidate until verification/promotion policy accepts it;
- parent-selected recall may later feed bounded verified knowledge into worker handoffs; child direct Cognee/durable-memory access remains off initially;
- writer hives wait for isolated worktrees/workspaces and parent-owned patch verification;
- durable/background/federated hives wait for persistent owner-scoped run state and secure worker identity.

Detailed target architecture lives under `docs/hivemind/`.

Use delegation only when estimated benefit exceeds coordination, token, merge, and review cost. Primary intended uses are repository exploration, independent investigation, adversarial review, and spending a separate context window on evidence gathering without bloating the parent session. Use Hivemind only when multiple independent evidence paths or an explicit panel provide additional value over one `delegate` run.

### 10. Evidence over feature count

Evaluate stock Ice, isolated capabilities, complete ICE profiles, and relevant external harnesses with identical models, task inputs, repositories, runtimes, budgets, and repeated runs.

Record:

- verified task success and regressions
- wall and active time
- input, output, reasoning, and cache tokens
- reported and estimated cost separately
- turns, tool calls, and tool errors
- permission decisions and unsafe-action attempts
- recovery and failure classes
- human interventions and review burden
- exact model, provider, reasoning setting, Ice/ICE versions, prompt hash, tool schema versions, runtime image, and task hash

Keep native model-harness system results separate from controlled same-model harness comparisons. Preserve benchmark and scoring versions. Do not claim provider generation is deterministic.

## Required Safety Gate for Autonomous Mode

Do not describe unattended autonomy as safe until all conditions pass:

- sandbox blocks reads and writes outside approved roots
- network is disabled or explicitly allowlisted
- broad host credentials are absent
- durable task state resumes after process termination
- concurrent writers use separate worktrees
- missing approval fails closed
- interrupted side effects are not blindly retried
- stuck loops terminate, replan, or escalate
- cost, time, token, and worker limits are enforced
- mandatory verifier commands are known before execution
- baseline failures are distinguished from regressions
- completion is blocked while mandatory criteria fail
- every action and approval is reconstructable
- cancellation stops or safely detaches child work
- containers, worktrees, ports, and processes are reclaimed
- push, merge, release, and deploy require explicit approval or policy

## Target Package Boundaries

Exact package count should stay minimal. Split only when dependency or runtime boundaries justify it.

```text
packages/
  ice-void-core/        profiles, config, capability resolution
  ice-void-policy/      permissions, paths, network, redaction
  ice-void-trace/       events, accounting, artifacts, replay
  ice-void-verify/      discovery, manifests, baselines, review
  ice-void-repo/        maps, language detection, Git, edit guards
  ice-void-workspace/   local and optional isolated adapters
  ice-void-task/        state, budgets, recovery
  ice-void-delegation/  optional roles, worktrees, result contracts
  ice-void-headless/    runner, JSONL, CI, notifications
```

A narrow Ice integration extension registers hooks, tools, commands, and adapters. This layout is a target boundary map, not a requirement to create empty packages early.

## Implementation Order

### Stage 0: Measurement baseline

Add no-behavior-change instrumentation and a reproducible same-model runner. Measure prompt/tool-schema tokens, context growth, turns, tool failures, latency, usage, cost, and verifier outcomes.

### Stage 1: Safe baseline

Build first:

1. Structured event trace and provenance
2. Token, cost, and wall-time accounting
3. Deterministic allow/ask/deny policy
4. Project trust and protected paths
5. Git snapshot/checkpoint handling
6. Repository verifier manifest
7. Baseline and final verification
8. At most one bounded repair turn initially
9. Evidence-backed final report

First code-ready slice: `@ice/safe-verify`, implemented through Ice hooks with zero core-loop edits.

### Stage 2: Repository-scale reliability

Add repository map, language/build detection, atomic stale-safe edits, structured task state, acceptance criteria, improved compaction state, regression baselines, and read-only diff review.

### Stage 3: Isolated execution

Add workspace interface, rootless container adapter, network policy, scoped credentials, cleanup, crash recovery, and optional OpenHands adapter.

### Stage 4: Long-running execution

Add goal tracker, durable checkpoints, pause/resume/cancel, failure taxonomy, stuck detection, retry-safe recovery, background-process registry, and headless runner.

### Stage 5: Delegation

Start with the stripped foreground delegation slice defined above rather than a full multi-agent framework:

1. `ice`-only hidden `delegate` tool integrated with existing guarded-build active-tool policy.
2. Bundled TypeScript profile catalog with read-only investigators/reviewers and profile-aware implementation, testing, debugging, documentation, performance, and refactoring roles.
3. Fresh native child `AgentSession` + `SessionManager.inMemory()`.
4. Child resource discovery disabled (`noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`).
5. Child effective tools derived from the intersection of profile-requested capabilities, parent active tools, and the invocation policy: safe launches are capped to `read`/`grep`/`find`/`ls`, while explicit trusted YOLO may expose requested Bash/edit/write capabilities without flattening role identity or exceeding the parent upper bound.
6. Typed handoff/result, lineage, timeout, cancellation, bounded progress, and parent verification.
7. Controlled benchmark against Ice's subprocess example before deciding whether to maintain a second runner backend.
8. Trusted configurable roles/resources are implemented as Phase A, including dedicated user context isolation, selected skill read access, explicit prompt handoff, and single-resolution launch contracts. Phase B1 bounded sibling read fanout, Phase B2 typed reviewer orchestration, Phase B3.1 deterministic cross-model reviewer routing, Phase B4 launch preflight/digest, Phase B5 selective typed context packets, Phase B6.1 sanitized fork snapshots, and Phase B7.1 bounded typed transient recovery are implemented; evaluate fallback model policy, chains, worktree-isolated writers, durable background jobs, and optional scoped child memory only with evidence.

Do not wait for full autonomous-mode infrastructure merely to prove a read-only child, but do not let the read-only slice smuggle in writer/background/autonomous assumptions either.

## Branch and Sync Model

- `upstream/main`: canonical Ice source
- `main`: clean mirror of `upstream/main`
- `void`: current upstream plus ICE commits
- `archive/*`: preserved historical implementations

Current historical archive:

```text
archive/pre-upstream-0.55.4-20260722
```

Sync procedure:

1. Fetch `upstream/main`.
2. Inspect upstream changes touching ICE seams.
3. Fast-forward mirror branch `main` to upstream.
4. Rebase or rebuild `void` from current upstream using small thematic commits.
5. Do not replay old features already implemented upstream.
6. Run focused tests, `npm run check`, build, and CLI smoke tests as required by release rules.
7. Preserve old state on an archive branch before any history-changing remote operation.

Zero conflicts cannot be guaranteed. Small commits, public extension seams, pinned compatibility assumptions, and separate packages reduce conflict frequency and rebuild cost.

## Current ICE Delta

Primary implementation files:

```text
packages/coding-agent/src/ice.ts
packages/coding-agent/src/ice-provider.ts
packages/coding-agent/src/ice-safe-verify.ts
packages/coding-agent/src/ice-cognee.ts
packages/coding-agent/src/ice-cognee-client.ts
packages/coding-agent/test/ice-provider.test.ts
packages/coding-agent/test/ice-cognee.test.ts
packages/coding-agent/test/ice-safe-verify.test.ts
packages/coding-agent/src/ice-subagents.ts
packages/coding-agent/test/ice-subagents.test.ts
packages/coding-agent/src/modes/interactive/theme/*.json
packages/coding-agent/docs/theme-sources.md
```

Small shared changes currently support:

- `ice` executable registration
- model-aware compaction reserve
- detection of explicit user compaction reserve
- discovery and packaging of curated built-in themes
- extension-requested graceful stop after the current tool turn

Keep this list current when fork-specific files change.

## Near-Term Roadmap

1. Finish reliable upstream synchronization and GitHub workflow authorization.
2. Add endpoint refresh observability without exposing secrets.
3. Add compatibility probes for chat completions, tools, streaming, images, reasoning, and structured output.
4. Build Stage 0 same-model instrumentation and regression runner.
5. Continue field-testing Guarded Build v0 and session-native plan approval before extracting a broader `safe` profile/package boundary.
6. Implemented and continue field-testing the native delegation slice: ICE-only hidden delegation tools, bundled/configured profiles, stripped native child resources, parent-policy capability derivation, foreground and durable read-only execution, bounded typed evidence, parent verification, deterministic cancellation/timeout, and the owner-local `/agents` live-view bridge.
7. Implemented and frozen through Phase B7.1: Phase A explicit trusted configurability, Phase B1 low-concurrency sibling read fanout, Phase B2 typed reviewer orchestration, parent-model-only reviewer execution, Phase B4 parent-owned launch preflight/digest, Phase B5 selective typed context packets, Phase B6.1 sanitized fork snapshots, and Phase B7.1 bounded typed transient recovery: user/project roles, deterministic precedence, source hashes, selected skills/prompts/context, no ambient child extensions, bounded `delegate_batch`/`review_batch`, parent-owned budget accounting, deterministic cancellation/results, independently verified findings, contradiction preservation, typed model provenance, resolved effective tools/scopes, bounded model-visible launch summaries, immutable explicit packet handoffs, opt-in redacted fork continuity from `buildSessionContext().messages`, same-model retry only for explicit transient classifications, aggregate attempt accounting, and immutable attempt provenance. Do not enable shared-tree writers, reviewer voting, quorum, consensus, fallback models, or automatic retry beyond the bounded B7.1 policy.
8. The B8 implementation release gate for Read-Only Subagents v1 is closed: B8.1 deterministic adversarial regressions, B8.2 pinned four-target harness correctness, and B8.3 finding-based hardening evidence are complete. The exhaustive 48 deterministic / 112 model-quality comparative matrix remains optional external certification evidence and is not required for the V1 implementation freeze. Keep parent-as-queen, explicit tasks, star topology, run-scoped evidence board, bounded aggregate budgets, and advisory evidence quorum deferred beyond the frozen V1 implementation.
9. Add verified Hivemind learning only after redaction, provenance, promotion, invalidation, and scope policy are tested. Reuse `ice-cognee` through an adapter only if it fits the contract; child direct durable-memory access remains off initially.
10. W5A writer adversarial and dogfood validation is implemented and frozen across provenance, stale/dirty parents, tampering, verifier mutation/failure, rollback conflicts, limits, cleanup, and capability denial. Treat W5B live writer certification for both corrected `cx` routes as an external production-certification gate; it does not block the V1 implementation freeze.
11. W6 Subagent Observatory/TUI is implemented and FROZEN through existing `onUpdate`, `tool_execution_update`, `renderCall`/`renderResult`, and `ctx.ui.custom()` seams. Runtime `SubagentEvent` facts remain separate from bounded sanitized presentation snapshots; JSON/RPC updates stay typed, ordinary print stays unchanged, observatory actions remain read-only, and W1-W5 semantics stay frozen. W5B remains pending as external production certification, not an implementation-freeze blocker.
12. W7.1/W7.2 durable owner-scoped read-only jobs, W8.1 metadata-only `/agents`/`/subagents` visibility, W8.2 explicit terminal-result inspection, W8.3 frozen persisted completion-inbox metadata, and the foreground W8.4 live-child view path are implemented as bounded V2 slices. `/agents` remains the chooser/monitor, while full selection uses `IceAgentViewBridge` to render foreground children in the normal InteractiveMode shell without replacing the authoritative parent runtime. Foreground live children support explicit mirror-to-Take-Control steering and a mandatory bounded final-answer boundary after steering (plain prose for ordinary delegations, the structured JSON report for typed flows); durable background jobs remain non-steerable. Keep durable job retry/priority/queue-management actions, polling, live inbox state, result ingestion, background batch facades, background writers, auto-resume, and Hivemind deferred. Do not add `background: true` to the foreground runner.
13. Evaluate recovery before durable autonomy. Automatic repair, generic policy rules, multi-verifier pipelines, broad sandboxing, rollback, and trace services remain separate measured capabilities rather than prerequisites hidden inside delegation.

## Explicit Non-Goals

- Rewriting Ice's core loop
- Creating a second provider SDK or model registry
- Making OpenHands, MCP, browser automation, remote services, or subagents mandatory
- Always-on planner or critic models
- Hierarchical agent swarms, recursive delegation by default, or manager/worker trees as a core architecture
- Unbounded reflection, retry, or repair loops
- Shared-write multi-agent workspaces
- Unrestricted host shell in autonomous mode
- Automatic push, merge, release, or production deployment
- Cloud-only state or telemetry
- Vector storage before retrieval benchmarks justify it
- Unbounded or unredacted permanent memory generated from arbitrary model output; the shipped adapter only queues bounded, redacted saved-compaction summaries when enabled
- Self-modifying tools, policies, prompts, or harness code without review and held-out regression gates
- Dozens of always-visible tools
- Heavy task databases while append-only session and filesystem journals suffice
- Feature parity with every competing harness
- Hardcoded model lists, guessed limits, committed credentials, or generated user configuration
- Naming a harness improvement from stars, anecdotes, one benchmark version, or one model-harness pair

## Decision Rule

Every proposed feature must answer:

1. What measured failure does it fix?
2. Can current upstream Ice already do it?
3. Can configuration, extension, launcher, or adapter implement it?
4. Which profile needs it, and can it remain lazy?
5. What trust or security boundary changes?
6. What deterministic test or controlled evaluation proves benefit?
7. What token, latency, cost, and review burden does it add?
8. What makes future upstream sync harder?
9. How is it disabled or rolled back without session migration?

If answers are weak, do not build it.
