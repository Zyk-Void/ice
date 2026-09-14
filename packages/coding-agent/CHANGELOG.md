# Changelog

> This fork resets its changelog at the ICE rename. Pre-fork release history lives upstream at https://github.com/earendil-works/pi.

## [Unreleased]

### Breaking Changes

- Renamed the product to ICE. The only supported executable is `ice`.
- Moved configuration to `.ice` and agent state to `~/.ice/agent`. `.pi` is not a discovery root. Existing state must be migrated explicitly.
- Renamed every environment variable to the `ICE_*` prefix. `PI_*` / `PIV_*` values are not read.
- Dropped historical `pi`/`piv` command aliases, extension import aliases, `Piv*` SDK names, `piv` settings/RPC keys, session custom types, Cognee path fallback, and TUI/theme compatibility symbols.
- Renamed first-party packages to the `@zykairotis/ice-*` family.
- Renamed the public API surface to `Ice*`/`ice*`.
- Removed the eleven bundled subagent roles (`explore`, `planner`, `coder`, `worker`, `tester`, `review`, `security`, `debugger`, `documenter`, `performance`, `refactor`) and all alias spellings. Delegation now resolves file agents global-first (`~/.ice/agents` wins over trusted `.ice/agents`; explicit custom `agentDir` uses `<agentDir>/agents`; shadowed sources are surfaced) plus self-delegation (`role: "self"` with bounded parent instructions); unknown names fail with discovery hints. Legacy `~/.ice/agent/agents` files are reported through a non-destructive migration manifest and are not moved automatically. `review_batch` now runs self-delegated reviewers.
- File agents support effective `model`/`fallbackModel` references with deterministic call/primary/fallback/parent candidate order, bounded skip reasons, startup-only retry, aggregate budgets, and durable route/candidate capture; stale captured routes fail explicitly. File agents also support explicit opt-in `mcp` server/tool selectors dispatched only through the parent-owned adapter.
- `ice` settings, skills, prompts, context, and hooks resolve global-first; denies, mode restrictions, caps, and trust requirements still win. Stock `ice` behavior is unchanged.
- Default delegation uses the exact current parent model; globally opted-in file/call candidates may select another configured route. Durable async jobs capture the chosen route at acceptance and reject stale promotion instead of rerouting. Isolated writer model policy is unchanged.
- Changed JSON and RPC `message_update` events to emit only `assistantMessageEvent` deltas, removing the cumulative `message` and `assistantMessageEvent.partial` fields that caused quadratic output growth. Clients that need partial messages must assemble deltas between `message_start` and `message_end`; the latter remains authoritative ([#7290](https://github.com/earendil-works/pi/issues/7290)).
- `ModelRegistry.getApiKeyAndHeaders()` now returns `ProviderHeaders` with `string | null` values and preserves `null` header-deletion markers. Extensions that inspect returned headers must handle `null`; extensions forwarding them to ice-ai streams should pass them through unchanged. This prevents placeholder OpenAI credentials from being sent through Cloudflare AI Gateway ([#7030](https://github.com/earendil-works/pi/issues/7030)).
- Changed `ModelRegistry.refresh()` to accept `ModelsRefreshOptions` and return `ModelsRefreshResult` instead of discarding cancellation and provider errors.
- Changed `ModelRuntime.setRuntimeApiKey()` to accept auth cancellation options rather than catalog refresh options. Call `refresh({ providers: [providerId], signal })` separately when remote freshness is required.
- Required config-form extension OAuth `refreshToken(credentials, signal)` callbacks to accept and honor a concrete abort signal.
- Replaced dynamic provider refresh context store access with the read-only `context.stored` snapshot and generation-checked `context.publish()` transaction.

  **Providers built with `createProvider({ fetchModels })`:** no catalog-publication migration is required. Before and after, return the fetched models and register the resulting provider; `createProvider()` owns restoration, persistence, and in-memory publication.

  ```ts
  // Before
  const beforeProvider = createProvider({
    // ...
    fetchModels: async ({ signal }) => {
      const response = await fetch(catalogUrl, { signal });
      return parseModels(await response.json());
    },
  });
  ice.registerProvider(beforeProvider);

  // After: unchanged
  const afterProvider = createProvider({
    // ...
    fetchModels: async ({ signal }) => {
      const response = await fetch(catalogUrl, { signal });
      return parseModels(await response.json());
    },
  });
  ice.registerProvider(afterProvider);
  ```

  **Handwritten native `Provider.refreshModels()`:** replace direct store access and pre-publication mutation with generation-guarded publications.

  ```ts
  // Before
  refreshModels: async (context) => {
    const stored = await context.store.read();
    if (stored) currentModels = stored.models;
    if (!context.allowNetwork) return;

    const refreshed = await fetchModels(context.signal);
    currentModels = refreshed;
    await context.store.write({ models: refreshed, checkedAt: Date.now() });
  },

  // After
  refreshModels: async (context) => {
    if (context.stored) {
      const restored = context.stored.models;
      if (!(await context.publish({
        update: () => { currentModels = restored; },
      }))) return;
    }
    if (!context.allowNetwork) return;

    const refreshed = await fetchModels(context.signal);
    if (context.signal.aborted) return;
    await context.publish({
      persist: { models: refreshed, checkedAt: Date.now() },
      update: () => { currentModels = refreshed; },
    });
  },
  ```

  For the config-form `ice.registerProvider(name, { refreshModels })`, callbacks that only return models remain unchanged; ice publishes the returned list. If such a callback previously used `context.store` for custom persistence, read `context.stored` and call `context.publish({ persist: entry })`. In `publish()`, omit `persist` to leave storage unchanged, pass a `ModelsStoreEntry` to write it, or pass `persist: null` to delete it.

### Added

- Added child-local native compaction defaults and bounded compaction lifecycle telemetry: long-running children use the existing AgentSession auto/overflow engine, resume after mid-run compaction, preserve explicit compaction settings and child authority, and expose only redacted start/end state to parent observability.
- Added parent-owned aggregate token budgets for delegated children and batches: opt-in `maxTotalTokens`/`totalTokenBudget`, exact input + output + cache-write accounting with cache-read visibility but exclusion, provider/estimated/mixed provenance, bounded report reserves covering the incremental finalization prompt, monotonic soft overshoot, deterministic tool-free fallback, shared recovery/continuation ledgers, durable summaries, separate RPC/observatory wording, and at-most-once `subagent_token_budget` lifecycle trace events (resolved, work exhausted, tool denied, finalizing, finalization unavailable). Built-in routes receive runtime output authority where supported; custom routes remain aggregate-soft and no dollar-cost guarantee is implied.
- Added automatic self parent-prompt snapshots with additive task guidance, explicit parent skill inheritance, registered child-safe extension capabilities, and self/file MCP selections using installed schemas and collision-resistant names.
- Added public parent-owned adapter registration APIs, runnable/typed integration examples, resource/package global-precedence checks, and the HTML delegation operator guide.
- Added cancellation-safe adapter waits, required MCP-hook dispatch coverage, live registration/schema revocation checks, and durable capability/resource fingerprints.
- Added opt-in exact `execution.model` routing through Ice ModelRuntime, captured durable route fingerprints, host-owned command-hook policy, trusted parent handler registration, and a subagent user guide with project-local workflow skills.
- Added explicit durable extension entries via `appendEntry(type, data, { durable: true })`; ordinary entries retain lazy persistence and memory-only sessions reject durable acknowledgement.
- Added switchable `/agents` transcript views: `/agents` opens a full-screen live child transcript and `/agents split` shows the parent and selected child side by side; Space switches the active pane and both views reuse Ice's normal message and tool renderers.
- Added explicit `--sub-yolo` direct-workspace writer execution for trusted interactive build sessions. YOLO writers may operate on dirty parent trees with scoped Bash, but provide no worktree isolation, rollback, or patch artifact; normal writers remain isolated.
- Added the M12 native-vs-subprocess benchmark harness with real resource-loader/CLI contract vectors, startup and end-RSS metrics, and schema-v2 M13 acceptance provenance for the canonical full-budget M12 chain; the native-only production policy remains benchmark-backed without automatic subprocess fallback, with observed C1/C2/C3 evidence recorded.
- Added W7.1 durable asynchronous read-only subagent jobs: owner-scoped append-only session snapshots, `delegate_async`, `inspect_subagent_job`, `cancel_subagent_job`, independent cancellation, restart interruption without relaunch, bounded verified-result projection, safe-boundary metadata completion notices, and terminal retention.
- Added W7.2 bounded durable read-only scheduling: up to 2 active jobs by default, FIFO queue admission capped at 8, aggregate planned-output reservations capped at 256 KiB per owner, deterministic queued cancellation/promotion, queue and budget inspection metadata, and fail-closed shutdown/restore behavior. Background batch facades, writers, auto-resume, and job-management TUI remain deferred.
- Added W8.1 metadata-only owner-scoped durable job sections to the read-only `/agents` and `/subagents` overlays. The view subscribes to authoritative registry changes, projects bounded job metadata without result bodies, and supports navigation/expansion without adding polling or job actions.
- Added W8.2 explicit configurable read-only inspection for terminal BACKGROUND RECENT jobs in `/agents` and `/subagents`. The ephemeral detail view performs one owner-scoped inspection per action and renders a frozen bounded/redacted terminal-safe projection of result metadata, summary, repo-relative evidence, findings, verification, and diagnostics without changing session context or scheduler state.
- Added W8.3 frozen noninteractive `COMPLETION INBOX` metadata to `/agents` and `/subagents`, reconstructed per overlay open from persisted completion notifications intersected with retained owner-scoped terminal jobs. Inbox rows are bounded, newest-first, deduplicated, capped at 32, nonselectable, and never render message content or result bodies.
- Expanded W8.4 foreground live-child views in `/agents` and `/subagents`: full-mode selection now switches the normal Ice `InteractiveMode` shell through `IceAgentViewBridge` while the parent runtime remains authoritative, with per-view draft/scroll state, bounded redacted history, configurable parent/next/previous navigation, explicit Take Control steering, and a dedicated bounded final-report turn after interactive steering. Durable background jobs remain non-steerable.
- Added W6 Subagent Observatory: bounded sanitized progress snapshots through existing tool updates, single/batch/review/writer render hooks, writer artifact/verifier lifecycle phases, and read-only `/agents` and `/subagents` overlays. Ordinary print behavior remains unchanged.
- Added stateless build-only `inspect_writer_patch`, `reject_writer_patch`, and `integrate_writer_patch` tools around the frozen writer artifact APIs. Production-artifact provenance is restricted to the canonical W2 run path, inspection previews are capped at 32 KiB, rejection is non-durable, and integration requires a trusted project plus configured `--ice-verify` before parent mutation.
- Added provider-free W5 end-to-end adversarial writer coverage and an explicit `W5_LIVE=1` dogfood harness for `cx/gpt-5.6-luna` and `cx/deepseek/deepseek-v4-flash`; live certification remains outside default tests and checks.
- Added ICE-only hidden delegation tools with file-agent/self discovery, native child sessions, stripped ambient resources, parent-policy capability derivation, bounded typed results, parent verification, and deterministic cancellation/timeout.
- Added the strict `ice.subagents`/`ice.hooks` settings namespace, source-aware effective execution budgets, per-call thinking/tool narrowing, deny-first role/tool restrictions, parent-owned in-process lifecycle hook dispatch, RPC and interactive settings projections, and final child-tool boundary enforcement. Alternate routes and command hooks are separately gated opt-in features.
- Added restricted local `outputSchema` payloads, actual Ice turn-budget accounting, owner-bound idempotent `manage_subagent` follow-up, durable accepted-job execution contracts, observed hook outcomes, and fail-closed settings-load diagnostics.
- Added explicit `--allow-external` trusted build access for parent guarded mutations and, with `--sub-yolo`, delegated child scopes. Interactive TUI and RPC sessions require explicit authorization; external access is unrestricted host access and not a sandbox, while normal isolated `delegate_write` remains contained.
- Extended explicit `--ice-mode build --ice-allow-bash --sub-yolo` host execution to confirmed foreground, durable async, batch, and review delegation paths, including RPC sessions authorized at startup. Unsafe children receive only requested parent-authorized built-ins and explicitly registered adapters. Selected MCP is separately gated; ambient child extensions, recursive delegation, and child writer delegation remain disabled. Review children remain read-only. Interactive launches require TUI confirmation; RPC uses the explicit startup command as session-wide authorization. It requires project trust and active parent Bash, disables retry for unsafe children, and is explicitly not a sandbox; host filesystem, process, network, and descendant-cleanup isolation are not claimed. `delegate_write` remains worktree-isolated.
- Added the bounded sibling-only `delegate_batch` read fanout over `runResolved()`, with up to 8 tasks, default concurrency 2, hard concurrency 4, parent-owned output reservations, deterministic results, aggregate usage, lifecycle IDs, and cancellation/timeout handling. Chains, writers, background jobs, and recursive delegation remain disabled.
- Added typed `review_batch` orchestration over the same bounded scheduler for correctness, security, tests, and regression dimensions, with independently verified structured findings, deterministic reviewer ordering, and contradiction preservation without voting or synthesis.
- Added parent-owned typed launch preflight and bounded model-visible digest for `delegate_batch` and `review_batch`, including resolved models, effective tools, canonical scopes, budget reservations, trust, and selected-resource provenance without resource bodies.
- Added immutable typed context packets for explicit parent-to-child handoff, with legacy `context` migration, bounded UTF-8 item/aggregate limits, metadata-only preflight exposure, and untrusted prompt injection without transcript forking or permission changes.
- Added opt-in `contextMode: "fresh" | "fork"` sanitization from `buildSessionContext().messages`, with strict text/summary allowlisting, credential redaction, bounded immutable UTF-8 snapshots, metadata-only preflight provenance, and a combined packet/fork handoff budget; children remain fresh `SessionManager.inMemory()` sessions.
- Added bounded startup recovery across delegation facades: at most two attempts, native proof of no child/session effects, remaining shared time/output budgets, aggregate usage and attempt provenance. Foreground/batch configured routes may advance to an approved fallback; durable queued jobs never reroute. Runtime stream failures and ambiguous tool effects are not replayed.
- Added explicit trusted configurability for `delegate`: deterministic user/project role resolution with provenance and source-hash revalidation, plus independently selected skills, prompt templates, and context files. Ambient discovery and extensions remain disabled.
- Added build-only `delegate_write` W1: one foreground child in a temporary detached worktree from the exact current parent `HEAD`, gated by `git status --porcelain=v1 -uall`, with only scoped `read`/`grep`/`find`/`ls`/`write`/`edit`; Bash, network, delegation, extensions, Git metadata, retries, and parent integration remain disabled.
- Added W2 bounded writer patch artifacts: only completed writers produce immutable parent-side proposals from NUL-safe Git status inventory, with raw before/after bytes shared by hashes and isolated `git diff --no-index` patch generation, external diff/textconv disabled, no Git index/object-store writes, untracked-file inclusion, 32-file and 512 KiB caps, and no parent-tree modification. W2 is frozen.
- Added W3 `integrateWriterPatchArtifact()` for parent-owned artifact digest/inventory/scope/preimage validation, immutable verification expectations, clean `HEAD`/worktree/index preconditions, checked non-fuzzy patch application, required parent verification, post-verifier postimage/status validation, and compare-and-swap rollback. Safe paths restore even when another path conflicts; concurrent or non-regular replacements produce explicit `integration_conflict`/`rollback_conflict` failures without overwriting newer state. W3 is frozen at this narrow optimistic-concurrency API boundary; no merge, rebase, commit, index update, child-controlled verification, or conflict resolution is included.
- Added first-class `ice` Cognee memory with bounded transient recall, redacted compaction-linked remember queueing, `/cognee` controls, and a read-only `cognee_search` tool; the stock `ice` launcher is unchanged.
- Extended `ice-cognee` with a Claude Code-style hook clone on Ice extension events: continuous session capture (`/remember/entry` for prompts, answers, and tool traces), pre-compact anchors, session-end `/improve`, and `/cognee capture|tools|improve` toggles.
- Brought `ice-cognee` closer to claude-code parity: `/cognee doctor`, statusline, skills (`cognee-remember`/`search`/`sync`), idle improve on `agent_settled`, warmup buffer, session map, multi-scope pre-compact recall, tool allowlist, and `~/.cognee/.env` loading for Layer A keys.
- Improved Blackhole + Cognee compaction cooperation via `compactionSummaryMode` (`auto`/`defer`/`own`): default `auto` defers the Ice summary to Blackhole when configured, still stores pre-compact anchors and permanent remember of the final summary.
- Added `/cognee watch`, a loopback-only realtime observer with SSE updates for agent/session identity, Cognee request lifecycle, queue state, latency, and capped redacted ingest previews; prompt recall now shows immediate animated activity in the Ice statusline.
- Added capability-gated fast mode for local Codex/Luna Responses models, with persisted, CLI, interactive, and RPC controls for the priority service tier ([#5](https://github.com/Zykairotis/ice/pull/5)).
- Added `/fast` interactive command with toggle, explicit on/off, and status controls ([#5](https://github.com/Zykairotis/ice/pull/5)).
- Added model-specific `ultra` thinking selection and preserved local endpoint thinking metadata for explicit provider mappings ([#5](https://github.com/Zykairotis/ice/pull/5)).
- Added extension `ctx.stopAfterTurn()` for graceful post-tool-turn handoffs without rendering a false abort error ([#5](https://github.com/Zykairotis/ice/pull/5)).
- Added opt-in mid-run compaction after tool turns, with `off`, `pause`, and `resume` modes ([#5](https://github.com/Zykairotis/ice/pull/5)).
- Added an optional deterministic Blackhole compaction extension with resume/pause triggers and percentage or absolute token thresholds ([#5](https://github.com/Zykairotis/ice/pull/5)).
- Added extension-contributed settings to `/settings`, including all current Blackhole compaction fields ([#5](https://github.com/Zykairotis/ice/pull/5)).
- Added ICE guarded execution through the `ice` launcher: exact plan/build tool modes, OMP-equivalent repository-grounded questions and draft/refine/propose planning, scrollable Markdown review with fresh/compact/keep-context approval, optional planning/execution model routing, bounded convergence, reopenable durable session-native plan state, approved-plan reread gating before mutation, Bash default-off, canonical direct edit/write path protection, and a project-trusted settled verifier with bounded output and headless failure status. This is not a sandbox; opted-in Bash and filesystem TOCTOU can bypass direct-tool checks ([#5](https://github.com/Zykairotis/ice/pull/5)).
- Added built-in Baseten provider support with `BASETEN_API_KEY` authentication and `zai-org/GLM-5.2` as the default model.
- Added `CredentialSynchronizationError` for credential changes that commit successfully but fail to synchronize local model state.
- Added chainable `ice.registerMarkdownTransformer()` hooks for display-only transformation of user and assistant Markdown.
- Added an experimental fullscreen UI mode, selectable through `--ui-mode fullscreen` or `/settings` ([#7304](https://github.com/earendil-works/pi/issues/7304)).
- Added runtime switching between regular and fullscreen UI modes through `/settings`.
- Added a sticky editor, status, widget, and footer dock to fullscreen mode while keeping the transcript independently scrollable.
- Added Cognee `$project` datasets (`ice-<repo>-<hash>` from the git root) so automatic memory is not shared across repositories.
- Added a draggable transcript scrollbar to fullscreen mode with configurable `auto`, `always`, and `hidden` modes through `/settings`; `always` reserves the rightmost column.
- Added page scrolling and marked-message navigation shortcuts to fullscreen mode.
- Added an optional `scrollbarThumb` theme color for fullscreen scrollbar thumbs, falling back to `selectedBg`.
- Added a `ice` `/settings` → Providers submenu that lists configured providers and refetches a single catalog on demand. The `local` provider rewrites `models.json` from the 9Router endpoint.

### Changed

- Improved interactive subagent footer observability with bounded active/reusable-retained counts, selected-child status, the last three sanitized tool/path activities, runtime timing, attention indicators, and narrow-terminal fallbacks sourced from the agent-view bridge.
- Changed clipboard and Gondolin integrations to the published `@zykairotis/ice-*` fork packages, including cross-platform binary packaging, example setup, and generated install metadata.
- Changed ICE RPC and interactive settings projections to show deny-first effective values; empty role allowlists are neutral preferences, while malformed settings block new delegation.
- Removed former specialist aliases, including `scout`; use self delegation or an actual Markdown agent name.
- `ice` no longer fetches the local 9Router model catalog on every launch. Startup uses the last valid `models.json` and injects the local API key only; use `/settings` → Providers → Refetch catalog to update.
- Changed Cognee `compactionSummaryMode: "auto"` so it never replaces the Ice compact summary. Explicit `own` now summarizes `messagesToSummarize` locally and skips network on overflow recovery.
- Changed Cognee recall to a turn-scoped system-prompt append instead of a durable `custom_message`, and prepend the latest compact checkpoint once on the next turn.
- Changed Blackhole `tailBehavior: "minimal"` from unused config into a real cut: the kept Ice tail is summarized and dropped so compact no longer leaves ~20k recent tokens in context. Minimal is now the Blackhole default.

### Fixed

- Fixed hook intent waits bypassing cancellation/deadlines and dispatching handlers after cancellation; wired optional profile/call hook selections into production launches and reject unsupported profile metadata.
- Fixed delegated `maxTurns` budgets to stop at actual Ice turn boundaries instead of counting only wrapper prompts; final-report repair consumes the same budget.
- Fixed hook selector inputs so role/call selections filter optional hooks while required hooks remain mandatory; bounded `beforeLaunch` context additions are now redacted, merged into the normalized parent context packet, and revalidated before child admission.
- Fixed hook approval waits so parent cancellation and per-hook deadlines fail closed without leaving a gated launch pending.
- Fixed OmniRoute `cx/` models omitting `xhigh` and `max` thinking when the endpoint leaves `thinkingFormat` unset.
- Fixed `--sub-yolo` children being told to `read` loaded skills, then failing on the advertised `SKILL.md` path. Child `read`/`grep`/`find`/`ls` now follow skill-directory symlink aliases when the canonical directory is an exact loaded-skill read root, including explicitly inherited parent skills, without widening repository or mutation scope. Missing in-scope skill files still fail as `ENOENT`.
- Fixed Blackhole `tailBehavior` being stored but never applied, which left Ice's full `keepRecentTokens` tail after compact.
- Fixed `ice list`, `ice update`, `ice install`, and `ice config` being treated as chat prompts because the launcher prepends `--ice-mode build`.
- Fixed Cognee `lastRecallKey` being set before a successful recall, which permanently skipped a prompt after a failed search.
- Fixed Cognee `rebuildClient` shrinking `maxResponseChars` to `recallMaxChars` after `/cognee` toggles.
- Fixed idle Cognee `/improve` racing in-flight capture writes and stamping cooldown on dispatch instead of completion.
- Fixed W6 writer integration to read the verifier configuration across the scoped Ice extension APIs, preserving the required verify-and-rollback path in live sessions.
- Clarified the ICE V1 release policy: B8 harness correctness and automated writer validation gate the implementation freeze, while exhaustive benchmark matrices and W5B live provider runs remain optional external certification evidence.
- Fixed ICE child delegation to enforce approved scope at the `read`, `grep`, `find`, and `ls` tool boundary, including absolute paths, `~` expansion, symlinked parents, and cross-volume containment checks; completed reports now require bounded structured in-scope evidence before parent verification can pass.
- Fixed foreground child delegation to allocate parent-owned run IDs before launch, require matching child lineage and complete non-partial terminal results, preserve bounded unresolved review claims, and forward the bounded `timeoutMs` parameter.
- Fixed Phase A resource handoff to exclude the Ice agent directory from user context roots, permit selected skills to load through exact resource read roots, pass bounded selected prompt content into child execution, cap selected resources at 64 KiB per file and 256 KiB in aggregate before reading, and use one resolved launch contract for execution and provenance.
- Fixed B1 batch accounting to cap the complete JSON child report, expose observed terminal output bytes, reconcile the parent ledger from observed bytes instead of summaries, expose bounded `totalBudgetBytes`, and cover fail-fast active-abort/queued-suppression behavior.
- Fixed B7.1 retry output accounting to keep terminal `observedOutputBytes` separate from aggregate recovery bytes, reserve/reconcile batch capacity per attempt, suppress retries without live capacity, and expose the two-attempt recovery policy in preflight.
- Fixed B7.1 stop-state recovery to suppress cancellation, timeout, and fail-fast retries before attempt-2 reservation or child-session creation, while preserving typed terminal status semantics.
- Preserved exact parent-model object identity for default delegation. Configured file/call routes use Ice's existing catalog; all durable routes and capability fingerprints are frozen at acceptance.
- Fixed reviewer finding evidence verification at the atomic result boundary so direct review delegation and batch fail-fast reject out-of-scope findings before sibling scheduling continues.
- Fixed concurrent dynamic-provider cache restoration contending on the same model-store lock during startup by coalescing overlapping reads into one immutable snapshot.
- Fixed `ice` startup waiting on cached local model refreshes and Cognee health probes while preserving cold-start catalog loading and all enabled memory behavior; explicit offline and metadata-only commands no longer start the local model request.
- Fixed `ice-cognee` tool traces leaking credentials, pre-compaction anchors not reaching Ice compaction, shutdown improve racing unregister, concurrent pending drains duplicating writes, and unsupported `/improve` routes reporting success.
- Fixed Cognee v1 recall and improve payloads to match the server's camelCase fields, preserving session and graph recall.
- Fixed `ice-cognee` API-key resolution to prefer the `~/.ice/agent/ice-cognee/api_key.json` key file over stale shared Cognee env files.
- Fixed observer SSE cleanup and request metrics so connected dashboards cannot block `ice` shutdown and lifecycle events count as one request.
- Fixed valid oversized Cognee recall envelopes being rejected before normalization; transport remains capped at `128 KiB`, while injected memory remains bounded by the configured recall character limit.
- Fixed extension selectors dropping supplied Markdown review content before mounting, which hid the ICE plan body from the approval menu, and kept selector controls visible when the review viewport shrinks ([#5](https://github.com/Zykairotis/ice/pull/5)).
- Fixed project-level nested provider retry settings replacing unmodified global provider retry settings ([#7572](https://github.com/earendil-works/pi/issues/7572)).
- Fixed inherited GitHub Copilot Grok 4.5 requests to use the supported Responses API ([#7560](https://github.com/earendil-works/pi/issues/7560)).
- Fixed fullscreen shutdown leaking terminal capability-query replies into the parent shell prompt.
- Fixed bare exact `--model` IDs shared by multiple providers choosing the first catalog entry instead of the sole authenticated provider or a clear ambiguity error ([#7327](https://github.com/earendil-works/pi/issues/7327)).
- Fixed standalone x64 binaries requiring Haswell-era AVX2/BMI2 instructions by compiling release executables against Bun's baseline runtime ([#7149](https://github.com/earendil-works/pi/issues/7149)).
- Fixed `Ctrl+X` copy confirmations in fullscreen mode adding a transcript status line instead of showing the transient `Copied!` marker.
- Fixed Kitty image previews in fullscreen mode overlapping the sticky editor and footer dock while scrolling.
- Fixed image-heavy fullscreen sessions lagging when layout changes retransmitted visible Kitty image payloads and rendered the transcript twice per frame.
- Fixed spaces in `/settings` searches toggling the highlighted setting while typing multi-word queries such as **UI mode** or **Quiet startup**.
- Fixed custom editors not inheriting the default editor's autocomplete dropdown item limit ([#7333](https://github.com/earendil-works/pi/issues/7333)).
- Fixed malformed resource arrays in package manifests crashing session startup ([#7187](https://github.com/earendil-works/pi/issues/7187)).
- Fixed the DOOM overlay example downloading its shareware WAD from a dead URL.
- Fixed `setToolsExpanded(false)` to be a no-op when tool output is already collapsed, avoiding redundant `Tool output: collapsed` startup notices from extensions ([#7292](https://github.com/earendil-works/pi/issues/7292)).
- Fixed extension-driven model calls in custom compaction, handoff, and Q&A examples to dispatch through the coding-agent model runtime so custom providers and resolved auth options are preserved ([#7325](https://github.com/earendil-works/pi/pull/7325)).
- Fixed long-running sessions using stale credentials after another process updates `auth.json` without serializing concurrent credential reads and delaying startup ([#7319](https://github.com/earendil-works/pi/issues/7319)).
- Updated the packaged `brace-expansion` dependency to 5.0.8 to address GHSA-mh99-v99m-4gvg ([#7316](https://github.com/earendil-works/pi/issues/7316)).
- Fixed forced model availability refreshes remaining blocked behind a stalled earlier refresh ([#7301](https://github.com/earendil-works/pi/issues/7301), [#7421](https://github.com/earendil-works/pi/pull/7421) by [@a-yeyang](https://github.com/a-yeyang)).
- Fixed `/model` catalog refresh failures to identify every catalog that failed.
- Fixed provider login remaining stuck after saving credentials when a model catalog refresh stalls by separating local credential consistency from bounded background freshness ([#7027](https://github.com/earendil-works/pi/issues/7027), [#7113](https://github.com/earendil-works/pi/issues/7113), [#7418](https://github.com/earendil-works/pi/issues/7418)).
- Fixed `/scoped-models` waiting for remote catalogs before rendering instead of showing cached models and cancelling refresh on close ([#7153](https://github.com/earendil-works/pi/issues/7153)).
- Fixed `/model <name>` waiting for catalog refresh before checking cached model matches ([#7443](https://github.com/earendil-works/pi/issues/7443)).
- Fixed stale availability snapshots and errors publishing after a newer availability pass.
- Fixed stale ice.dev, Radius, llama.cpp, and extension catalog refreshes publishing after a newer provider refresh.
- Fixed cancellation while waiting for file-backed credential or model-catalog locks, preventing cancelled mutations from running or committing later.
- Fixed concurrent in-memory credential mutations losing unrelated provider updates by serializing their read-modify-write sections.
- Updated `undici` to 8.9.0 and the packaged `brace-expansion` to 5.0.9 to address GHSA-8xcm-r25x-g524, GHSA-4cwx-7wf7-3272, GHSA-m8rv-5g2x-5cg5, GHSA-jr45-8vmc-qm54, GHSA-v3r7-h72x-cjcm, and GHSA-rgw5-rvv9-x895.
- Fixed GitHub Copilot compaction and branch summaries using the Individual endpoint instead of the credential-resolved Business or Enterprise endpoint ([#6768](https://github.com/earendil-works/pi/issues/6768)).
- Fixed extension model calls dropping credential-resolved endpoints when forwarding request authentication, including custom compaction with GitHub Copilot Business and Enterprise accounts ([#7579](https://github.com/earendil-works/pi/issues/7579)).
- Fixed fullscreen transcript navigation leaving no editor-accessible `Home`, `End`, `PageUp`, or `PageDown` variants by adding Ctrl-modified editor bindings ([#7574](https://github.com/earendil-works/pi/issues/7574)).
- Fixed the ICE clipboard integration to use the `0.3.10` fork release, whose Linux musl packages contain native addons and whose release CI builds and copies both musl targets.
- Fixed source and binary builds after removing the legacy announcement asset; empty interactive asset directories are now handled without an unconditional PNG copy.

> Release notes for versions published under the previous product identity are not reproduced here. They are preserved in the archived source repository and in prior Git history.
