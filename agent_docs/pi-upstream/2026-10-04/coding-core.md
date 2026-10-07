# Coding-agent logic parity audit

Reference: `earendil-works/pi` main frozen at `200387122ca450d6387f033949423114a270b96c` (1.0.2), compared with the current ICE worktree at local HEAD `db8dd8eebfebe4a2e65d93e9693e6892744517e2`, including current filesystem contents. Shared ancestor: `588915ec71714688cee8b7153339e8bdebb3e82e`.

This is a static implementation audit, not an implementation or a test run. No source, references, dependency metadata, branches, or settings were changed. Branding, package namespace, application name, and version-only differences are excluded from recommendations. Some renderer extraction and startup work is included because it changes module dependencies, extension APIs, authority, or transport behavior. Interactive/RPC/print/TUI behavior is covered by another lane. Dependency prerequisites and new standalone packages are covered by the parent audit.

## Result

ICE has not absorbed the stable Pi changes since the shared ancestor. Numerous small files are still the ancestor implementation after branding normalization. ICE adds substantial subagent, guard, memory, appearance, and compaction machinery on that older base; those additions are not equivalent to newer upstream APIs. Do not replace AgentSession or SettingsManager wholesale or assume upstream fixes apply cleanly.

Adopt the correctness and lifecycle fixes first, then the system-message/context projection migration, then model/runtime APIs and tool loadouts. MCP/codemode/tool search are a real missing stable feature cluster, distinct from ICE's existing host-registered MCP adapter. Experimental durable/server/client/facet examples are a separate architecture decision and should not become the authoritative ICE loop by default.

Status terminology: **missing** means new upstream file is absent; **ancestor** means current content equals the ancestor after application/package name normalization; **diverged** means compare and integrate, not blindly overwrite. A divergent file is not proof that every upstream fix is absent. The path inventory below gives mechanically reproducible status and upstream-only declaration names, with exact per-file commit provenance in the companion JSON.

## P0: correctness, session integrity, and authority fixes

### 1. Failed user Bash hooks must fail closed

Upstream `509ee2bd0ba9fc3d31fb96fe8f5a6ef73b51833c` changes `core/extensions/runner.ts`, `core/extensions/types.ts`, and the interactive caller. Current `emitUserBash()` catches handler failures, reports them, and ultimately returns undefined; this permits callers to fall back to local shell execution. Upstream validates the routing result and propagates errors so a failed sandbox/routing hook cannot silently execute on the host.

Port the runner and every user-Bash caller together. Preserve ICE's existing Bash default-off/mode/trust/approval decisions; this upstream change strengthens them. Existing `tool_call` hooks already throw to block execution; do not mistake that for coverage of the separate `user_bash` path.

Verification candidates: `test/extensions-runner.test.ts`, `test/suite/regressions/9068-user-bash-fail-closed.test.ts`; ICE guard and host-authority tests must continue denying plan/review and unapproved Bash.

### 2. Reject partial or tool-calling compaction summaries

Upstream `97fa14e3` rejects `stopReason: length` from summary requests (`#7048`), `90305d90` disables tools during summarization, and `6b36eb59` removes explicit tool choice after clearing the available tool set. Current `core/compaction/compaction.ts` only throws on error and does not have upstream's `getSummarizationFailure()` or its tool-call rejection. Current `branch-summarization.ts` is still the ancestor. A partial summary must not become a durable checkpoint that discards history.

Port to the shared summary choke point and branch summarization, and inspect all custom stream paths. Preserve ICE's exact selected-model limits, configured summary reserve, Blackhole compaction ownership, and Cognee remember only after a successful saved checkpoint. A failed summary must not trigger remember or claim a successful compact.

Verification: `test/suite/regressions/7048-compaction-truncated-summary.test.ts`, `test/branch-summarization.test.ts`, `test/compaction-summary-reasoning.test.ts`, `test/suite/agent-session-compaction.test.ts`.

### 3. Close compaction cancellation and navigation races

Upstream `bea67d90` cancels compaction on abort; ICE already calls `abortCompaction()` from `abort()` (partial equivalent). Upstream `de2de549bcc369726b2e1a50d1626c39806ccc09` additionally threads the signal through auth acquisition, owns the controller through callbacks, settles retries correctly, and checks cancellation around awaits so a canceled compact cannot restart the run. Current manual compact obtains auth without passing its controller's signal; it accesses the mutable controller field after awaits. ICE's `c532bcae5` adds one compaction lock, which must be retained. Upstream `e687434a` rejects tree navigation during compaction; port its busy checks and idle cleanup.

Verification: `test/suite/regressions/9340-9777-auto-compaction-cancellation.test.ts`, `test/suite/regressions/9178-tree-during-compaction.test.ts`, `test/suite/regressions/8935-parallel-preflight-abort.test.ts`, `test/suite/agent-session-retry-events.test.ts`, current ICE `test/suite/agent-session-compaction-lock.test.ts`.

### 4. Persist the first user message; repair session integrity

Current `SessionManager._persist()` waits for an assistant message before creating a new session file. Upstream `ff72faba` creates it at the first user OR assistant message; setup-only sessions remain lazy. This prevents losing a user's prompt if the initial model request crashes/hangs. Integrate without dropping ICE's explicit native durable-intent path for hooks/jobs.

Upstream `0b5ee5d8` repairs valid unterminated JSONL tails before further appends. `1a773c8e` prevents runtime forks from overwriting imported session source files; `56c6fb33` settles an active turn before an in-memory fork. `2631b25c` remaps compaction first-kept boundaries after filtering label entries when forking. `d711bd5f` makes branch summaries record the source leaf (`fromId`) rather than the destination branch point. Current runtime is the ancestor; current `branchWithSummary()` still assigns `fromId: branchFromId ?? "root"`.

`2b768ba4` adds optional external FileEntry ingestion to `SessionManager.inMemory(...)`, loading headers/migrations/indexes without disk writes; current API has no entries argument. This is an SDK capability, not a second ICE session store.

Verification: `test/session-manager/file-operations.test.ts`, `test/session-manager/load-entries.test.ts`, `test/session-file-invalid.test.ts`, `test/suite/agent-session-runtime.test.ts`, `test/suite/regressions/8724-in-memory-fork-active-tool.test.ts`, `test/suite/regressions/8989-fork-compaction-label-boundary.test.ts`, `test/session-manager/tree-traversal.test.ts`.

### 5. Transactional extension initialization and lifecycle cleanup

Upstream `a69bef789bc95abf0acee16f7b4660b70b650bb9` stages provider registrations, defaults, and event-bus subscriptions during extension factory execution, committing only after successful initialization; on failure it discards state and revokes the factory API. Current loader mutates the shared runtime immediately. Upstream `6ca42344` tracks event-bus subscriptions and unsubscribes on invalidation/reload; `46c9de40` returns an unsubscribe function from `pi.on()` and snapshots handler arrays during dispatch. Current on() returns void and captured bus listeners can survive runtime invalidation.

Upstream `acaa253c` rejects missing/non-object tool parameter schemas, `f47faf45` validates extension flag defaults against declared types, and `dc83372f` validates command names/handlers. Current `registerTool`, `registerFlag`, `registerCommand` lack these validations. Port transactional initialization around ICE's extra `registerSettings()` registration as well; failed factories must not leak settings UI registrations or ICE hook capabilities.

Verification: `test/suite/regressions/8423-extension-factory-failure.test.ts`, `test/suite/regressions/7193-event-bus-lifecycle.test.ts`, `test/extensions-discovery.test.ts`, `test/extensions-runner.test.ts`.

### 6. Runtime custom-message ordering and queued input handlers

Upstream `240eb29c` queues context-only custom messages emitted during a run and flushes them only after the current assistant's tool results; current core has pending next-turn messages but not upstream `_pendingCustomMessages`. This avoids interleaving an injected custom message between an assistant tool call and its result. `faa9863c` dispatches extension input handlers for queued inputs. `3852cb2b` drains inputs queued during compaction; current ICE has additional typed queue ids/cancellation and a check-in coordinator, so treat existing queue logic as a partial divergence, not replaceable baseline code. `47b5119d` ensures `triggerTurn:false` never starts a turn.

Port ordering/dispatch with ICE owner-scoped check-in acknowledgement preserved: notices must be marked consumed only after their actual matching custom message is consumed and the turn settles. Keep targeted queue cancellation ids and do not acknowledge messages merely because upstream moved them to another queue.

Verification: `test/suite/regressions/8537-custom-message-tool-result-ordering.test.ts`, `test/extensions-input-event.test.ts`, `test/suite/agent-session-queue.test.ts`, `test/suite/agent-session-prompt.test.ts`, current ICE check-in coordinator/delivery tests.

## P1: stable runtime and context migration

### 7. Canonical transcript system messages and branch-local context edits

Upstream `9e05370b` introduces mid-conversation system messages and structured prompt/tool patches; `466db0fe` adds canonical session context boundaries, typed boundary drafts and branch-local `context_edit` entries. Current `system-prompt.ts` is the ancestor string builder and SessionManager lacks `buildSessionProjection()`, `ContextEditEntry`, `appendContextEdit()`, `UsageEntry`, and system-prompt snapshots on compactions. Current retry/overflow recovery removes failed responses only from in-memory state; upstream records omission in the session projection so reopen/fork cannot resurrect omitted failed attempts.

Required code: session projection derives model-facing messages from raw append-only entries; preserve raw history while applying replacement/omission per active branch; prepare compaction from projected entries; invalidate stale provider usage after a later context edit/compaction; persist current structured system prompt and tools through compaction; install AgentSession `prepareRequest`, boundary, finalized-context refresh, and forced-prompt projections using upstream Agent hooks.

Extension API additions include `turn_end` boundary results, `agent_before_settle`, `SessionBoundaryDraft` and context preview/state; these are returned data, not a second planner/controller. Preserve before-settle cancellation/deferred action handling and map ICE settled events to the new lifecycle carefully. ICE subagent fork snapshots, contract hashes, instruction snapshots, observatory histories and Cognee context injection currently consume older messages; update each consumer explicitly.

Upstream `e4c75a73` + `16292398` make forced system prompts a run-scoped request transform instead of durable full-prompt replacement entries. `aef5fc42` fixes a follow-on issue: ordinary context handlers see conversation only; if they replace it, restore canonical prompt/tool state as a leading system message. New `context_with_system` runs on the full transcript and validates that the leading system message remains. Import this corrected final state together; do not stop at the early 0.86 system-message API.

Upstream `8bdcd449` handles oversized trailing tool results by choosing the preceding assistant tool-call cut point instead of accidentally retaining the whole conversation. `4495469a` allows auto compact from estimates when provider usage is zero/absent. Current ICE still returns false when no valid usage index exists, so its mid-run safety net is not equivalent. `d192bd6d` updates split-turn summarization prompts to avoid Fable refusals.

Files: `core/agent-session.ts`, `core/session-manager.ts`, `core/system-prompt.ts`, `core/messages.ts`, all `core/compaction/*`, extension runner/types/exports, SDK/runtime. Dependency: matching `packages/ai` transcript/types and `packages/agent` request/boundary hooks, covered by parent.

Verification: `test/session-context-edit.test.ts`, `test/system-prompt-updates.test.ts`, `test/suite/agent-session-boundaries.test.ts`, `test/suite/regressions/9789-context-handler-system-messages.test.ts`, `test/suite/regressions/8328-zero-usage-auto-compaction.test.ts`, `test/compaction.test.ts`, `test/compaction-serialization.test.ts`, ICE sanitized fork/prompt-cache and Cognee/Blackhole tests.

### 8. Post-tool compaction: preserve ICE partial implementation

Upstream `56700d42` prepares the next request only when the loop truly continues, after stop-after-turn evaluation, and compacts before the post-tool provider request. ICE already has `_compactBeforeNextTurn`, model-aware reserves, pause/resume behavior, hard 95% safety net, and a compaction lock. These are intentional ICE policies and provide part of this capability. Integrate upstream request-boundary ordering and projection correctness rather than replaying an obsolete second trigger. Preserve ICE percent thresholds and Blackhole ownership to avoid two compaction triggers racing.

Upstream `46bde88a` adds per-model compaction token budgets through `compaction.modelOverrides`, resolved by selected provider/model; current model-aware reserve logic is only a partial equivalent. Add the upstream override contract while preserving exact endpoint metadata and honoring explicit user reserve; validate how virtual routing chooses selected vs physical model budgets.

Verification: `test/settings-manager-compaction.test.ts`, `test/suite/agent-session-compaction-model-overrides.test.ts`, `test/suite/agent-session-compaction.test.ts`, current lock/Blackhole safety-net tests.

### 9. Session-scoped model/thinking changes

Current `setModel`, both model cyclers, and `setThinkingLevel` write global settings. Upstream `2ff8ba62` makes changes session-only unless explicit `ModelMutationOptions.persist` is requested, adds per-model thinking overrides and their restore ordering, and `5133c928` moves default selection control to settings. Port resolver/SDK/settings/mode callers together. This is a behavioral change, not a rename.

`b03a367a` adds configured Anthropic fallback models through the model config/provider-composer path. Preserve ICE exact parent-model inheritance and separately approved file-agent startup fallback policy; upstream provider fallbacks are not authority to reroute accepted durable child tasks.

Verification: `test/suite/agent-session-model-extension.test.ts`, `test/model-resolver.test.ts`, `test/settings-manager.test.ts`, `test/suite/regressions/6999-models-json-hot-reload.test.ts`, ICE durable route/fingerprint tests.

### 10. Tool loadouts, strict schemas, namespaces and nested execution

Upstream `4d9aa837`, `541045ae`, `30a1d184`, `db6cc71d` add `defaultTools`, additive/removal `+name`/`-name` modifiers across settings layers, preserve extension tools, and activate newly added defaults on reload. Current SDK hardcodes read/bash/edit/write and has no resolved defaultTools setting.

`fcff255b` sets built-in tools to preferred strict JSON-schema sampling; tool prompt snippets/guidelines become exported contributions (`9ab91fb9`). `8562bcf6` adds `ToolExposure` (`direct`, `model-only`, `codemode`, `deferred`, `hidden`), annotations, namespaces, output schemas/structuredContent, `prepareLoadout`, `ctx.executeTool()`, callable tool listing, and hidden declaration projection. Upstream `nested-tool-calls.ts` reuses `runToolCall` plus the session hooks, enforces sequential-tool queues, records bounded nested arguments/status/usage and emits parentToolCallId metadata. Current ICE has selected parent-owned adapter dispatch but not this generic API.

Authority hazard: upstream callable tools can intentionally differ from directly active tools (codemode/deferred tools are callable while undeclared). ICE policy currently uses active tools as an upper bound. Integrating this API must filter both active AND callable registries through mode/trust/allow-external/approved role scope; hiding declarations must never authorize execution. Block delegation/control tools in nested child contexts and preserve non-recursive delegation. Snapshot pending tool-load restoration must not bypass revocation when late MCP registration completes (`c662ec7e`). `028c0ec5` removes codemode-hidden tools from the system prompt.

Verification: `test/default-tools-setting.test.ts`, `test/builtin-tool-strict-mode.test.ts`, `test/tool-system-prompt-contributions.test.ts`, `test/nested-tool-calls.test.ts`, `test/suite/agent-session-tool-orchestration.test.ts`, `test/agent-session-dynamic-tools.test.ts`, allowlist/no-builtin regressions, ICE mode/parent-scope/revocation tests.

### 11. Native tools and shell/output correctness

`80e62761` adds an optional Windows PowerShell tool, UTF-8 prefix and shared shell-operation/config path; it is not enabled by default. ICE must gate it exactly like Bash, including plan/review denials and subagent requested/parent capability intersection. Tool names assumed throughout ICE guard/delegation code will require review.

`a8b3dd19` reports signaled termination as failed (`128 + signal`), treating null exits as failure. `7af2d27d` uses trusted System32 taskkill and consumes asynchronous spawn errors. `62835ea8` makes cwd-sensitive built-in tools prefer `ctx.cwd` rather than creation cwd; ICE scope/isolated-writer canonicalization must follow that actual resolved cwd. `ca21c168` accepts the single-edit legacy input form; `e583b290` removes misleading write byte counts. `d4eaf052` fixes Windows path glob handling. `9524d3a5` normalizes Git Bash/MSYS/Cygwin/WSL drive paths.

Codemode structured Bash output (`1ff5b6fd`) can return up to 1 MiB independent of model-facing truncation, backed by full-output artifacts; `OutputAccumulator.getFullOutput()` exposes text/path/truncation explicitly. `truncateMiddle()` preserves beginning/end at UTF-8 boundaries. Preserve ICE fixed host-owned result storage/read/presentation ceilings; larger programmatic output is not permission to inject full transcripts into the parent.

Built-in renderer extraction (`eb3e9fee`) removes TUI/theme imports from execution implementations, adds reusable `core/tools/renderers/*` and wrapper context/render lookup. Even if purely visual behavior is excluded, the module separation/API wiring is relevant to binary startup, SDK headless use, and MCP/codemode renderer fallback.

Verification: `test/powershell-tool.test.ts`, `test/tools.test.ts`, `test/edit-tool-legacy-input.test.ts`, `test/paths.test.ts`, `test/suite/regressions/6596-taskkill-enoent.test.ts`, `test/suite/regressions/3302-find-path-glob.test.ts`, `test/tool-renderer-examples.test.ts`, ICE isolated writer/scope tests.

## P1/P2: model discovery, startup, resources and SDK seams

### 12. Typed model runtime and provider configuration

Upstream `a328aa89` expands ModelRuntime/registry/provider composition to chat/image/classifier model types, type-specific catalogs/lookups/availability, generateImages/classify operations and schema validation. Current runtime/registry are chat-only. `f5c94648` adds exact image input limits/resize profiles; tool reads/result normalization and prompt attachments must resize after hooks select the request model, not globally before model selection. `76dfb88f` preserves per-thinking-level sampling parameters in schemas/composition. Remote catalogs negotiate `types=chat,image,classifier`, filter supported types, and merge by `(type,id)` in linear time (`c34f2d6a`).

`fddc968b` provisionally marks newly registered native providers with stored credentials configured before asynchronous checks complete. `1f78cea7` makes SDK extension `ctx.modelRegistry` a full runtime-backed streaming path for custom providers; `002fc838` exposes raw provider stream events to extensions. SDK stream-option construction is centralized so nested/direct requests retain timeout/retry/header/payload/response hooks. `02eed88f`/`4df15743` extend login options and shared callback infrastructure; coding-agent must forward LoginOptions.

These changes require the parent AI package migration first. Preserve ICE last-valid local endpoint catalog, launch-time no-network contract, exact endpoint metadata, secret-free catalog objects, promptCacheKey distinct from continuation sessionId, and offline commands. Do not replace ICE endpoint catalog routing with Pi's remote catalog defaults.

Model config also accepts response/completions compatibility fields `supportsFinishReason`, `supportsMaxOutputTokens`, `vllmPriority`, Anthropic `supportsMidConvoEffort`, typed cost tiers, prompt-cache TTL and request/image count/byte limits. Some former deferred-tool compatibility fields disappear as tool declaration/replay moves into the transcript model. These are schema and provider-contract changes: preserve exact endpoint fields and update validation/composition together rather than dropping formerly supported fields to make a port typecheck. Parent AI audit owns transport implementation.

Verification: `test/model-runtime-images.test.ts`, `test/model-runtime-classifiers.test.ts`, `test/model-catalog-protocol.test.ts`, `test/model-registry.test.ts`, `test/remote-catalog-provider.test.ts`, `test/sdk-stream-options.test.ts`, `test/suite/regressions/8964-extension-provider-streaming.test.ts`, existing ICE provider/metadata tests.

### 13. Auth/catalog lock contention and management retries

`7cf90c1d`, `2c79ce45`, `4d68d935` add revision-keyed shared read states and coalesced cancellable reloads for auth/model-store data rather than repeated cross-process locks on unchanged files; reads still return clones and writes lock/refresh state. Current auth-storage is the ancestor. Current models-store diverges but lacks `ModelsFileReadState`, `getFileRevision`, and coalesced read machinery.

`46b53b99` adds bounded retry/timeout handling for retry-safe management HTTP; `df018b60` specifically limits hung catalog attempts to 4 seconds with retries; `23842b1e` uses tunneled proxy HTTP dispatcher support. Preserve abort signals, offline startup, and last-valid cache behavior; never apply these retries to non-idempotent tool effects. `c37b0e03` caps exponential agent retry delay through retryDelayMs and must update cancellation reporting too.

`57e53b0d` resolves fd/rg versions from releases/latest redirect instead of quota-limited GitHub API; `6aedd106` selects musl Linux binaries; `6f707eb3` returns typed status callbacks rather than writing download notices into JSON/RPC stdout. Existing `utils/tools-manager.ts` diverges from ancestor but still lacks the typed callback API.

Verification: `test/auth-storage.test.ts`, `test/models-store.test.ts`, `test/management-http.test.ts`, `test/http-dispatcher.test.ts`, `test/tools-manager.test.ts`, `test/stdout-cleanliness.test.ts`, retry tests.

### 14. Resources, instructions, prompts, skills and pinned extension identity

`8ecf8a98` recognizes `AGENTS.override.md` before AGENTS/CLAUDE and avoids duplicate context from nested linked worktrees. Update ICE subagent instruction-chain/manifest readers alongside parent resource discovery, so children cannot accidentally omit the actual governing override. Preserve ICE global-first precedence and project trust.

`1355cd36` strips UTF-8 BOMs from JSON, context Markdown, frontmatter and text input using `utils/text.ts`. `b6419322` returns prompt-template diagnostics instead of silently dropping invalid YAML/frontmatter or accepting non-string descriptions; changes loadPromptTemplates return type. `5e11f658`, `8c2529da` discover nested Markdown agent skills while excluding arbitrary root Markdown files. `1d6dbf9e` keeps skill instructions usable with Bash-only tool sets; avoid hard assumptions that read must be active.

`f444ea5e` includes pinned git ref in temporary extension cache identity so changing @ref cannot silently load an older checkout. `080932e5` only declares an npm package update when semver.gt(target,installed), avoiding downgrades. `8d897eda` warns when extension dependencies install their own copies of host packages (should be peers), avoids duplicate runtime registries, and selects proper production-only npm/pnpm/Bun dependency install flags. `4259686d` resolves built-ins as configurable `builtin:<name>` resources, respects trust/settings selection, disables them under -ne unless explicitly selected, and lets third-party tools/commands replace replaceable built-ins; `9d1a6503` reports that replacement.

Current loader has ICE custom inline registrations/cache generation and global-first resource ranking. Keep those rather than importing ancestor project-first precedence. Upstream source-info synthetic-path classification (`builtin:` plus existing inline/sdk labels) affects provenance; migrate source labels in ICE audit/hashes consistently.

Verification: `test/resource-loader.test.ts`, `test/skills.test.ts`, `test/sdk-skills.test.ts`, `test/prompt-templates.test.ts`, `test/package-manager.test.ts`, `test/suite/regressions/8337-utf8-bom-parsing.test.ts`, ICE context-manifest/source-precedence tests.

### 15. CLI correctness, auth preflight and settings diagnostics

`74786a74` implements `--` end-of-options; `e40126f5` rejects invalid/missing --mode; `9b3c19da` ignores empty --models items; `0c453048` requires --model with --provider. Current args.ts has ICE options and should be merged, not replaced. Upstream `9795d602` adds per-run --use-theme; UI rename --ui-mode→--tui-mode (`5446cd75`) and fullscreen default (`88ff80b9`) are explicit behavior choices because ICE instructions/controller commands currently use --ui-mode regular.

`a261366b` adds structured `auth check` (ready/not_ready/invalid, stable exit codes, JSON, no-refresh/read-only auth, optional credential printing), splits parser/status from printing, and allows provider-only credential lookup. `9b791a4c` adds header-only exact-id lookup rather than reading all transcripts. `dd01f5b2`/`dfbf793b` make session listing recent-first, concurrency-bounded, abortable and progressively publish partial sessions. These improve ICE exact --session automation without changing its persistence boundary.

`1e1a6e27`, `913bcf33`, `678f0af3` preserve concrete settings-file paths, deduplicate diagnostics and defer interactive startup rendering so warnings are visible. Current ICE has non-consuming getLoadErrors but lacks upstream path-aware helper (`settings-diagnostics.ts`). Upstream `f29ea3de` adds header-only quiet startup.

Verification: `test/args.test.ts`, `test/auth-check.test.ts`, `test/credential-print.test.ts`, `test/session-id-readonly.test.ts`, `test/settings-diagnostics.test.ts`, `test/suite/regressions/7269-cli-end-of-options.test.ts`, `test/suite/regressions/7829-invalid-settings-warning.test.ts`.

### 16. Built-in llama behavior

Upstream `955a543b` exposes sleeping llama models; `d3e3bbc0` permits authorized network catalog discovery; `dcd46192` exposes presets under autoload; `1e39862f` detects chat-template thinking; `da19b63c` refreshes cached context on reload. Latest provider also maps classifier models and preserves configured context window. Current client/index files remain ancestor; provider diverges with ICE dependency/name adaptation but lacks upstream `configuredContextWindow`, `routerAutoloadEnabled`, `modelIsSelectable`, `toPiClassifierModel` machinery. Integrate on the same ModelRuntime path, retaining offline mode and exact metadata.

Verification: `test/llama-extension.test.ts`, model-runtime tests.

### 17. Clipboard, image and syntax utilities

`caf6dfe7` centralizes native clipboard ownership through TUI rather than a duplicate coding-agent native addon; `3349e1db` rejects unverified local clipboard writes, `60e7e76b` exposes backend failures, `6dff740f` restores headless/remote OSC52 fallback, `8676a0dc` requires advertised X11 image MIME types, and `fd889a27` prefers Finder file paths over image icons. Add asynchronous command helper/WSL fallback, preserve bounded OSC52 payloads. ICE uses separately published clipboard forks, so adapt the API instead of restoring upstream dependency names.

`c6b00676` scans beyond non-EXIF JPEG APP1 segments, `47a18e37` requires complete GIF signatures, and `a276dabe` converts non-PNG inputs for Kitty. `cec3a91c` defers uncommon syntax grammars and exposes full-load fallback; image-convert lazily loads PNG transcoder. These are real runtime/format changes even though they have visual symptoms. `utils/zip.ts` provides standalone CRC/DOS-time ZIP support for bug reports.

Verification: `test/clipboard*.test.ts`, `test/image-process.test.ts`, `test/image-processing.test.ts`, `test/image-resize-callers.test.ts`, `test/syntax-highlight.test.ts`.

### 18. Export/presentation APIs that affect logic

`b2bd111f` adds hidden-message controls to HTML export and updates serialized system/context entry presentation. Export tool lookup resolves registered renderers separately from implementations, so unloaded/late MCP tools retain fallback renderers (`11449730`). `session-export.ts` factors branch JSONL serialization and preserves extra context needed by session sharing (`460191cf`), rather than using AgentSession's inline simple branch linearization. Merge new entry types into all exporters/readers; keep model-facing projection distinct from raw transcript and ICE output artifacts.

Verification: `test/export-jsonl-share.test.ts`, `test/export-html-whitespace.test.ts`, `test/session-share.test.ts`, `test/suite/regressions/10285-mcp-tool-renderers.test.ts`.

## P2: missing stable opt-in features

### 19. Upstream MCP client, resources, auth, discovery and lifecycle

`8562bcf6` adds `core/mcp-servers.ts` plus the entire built-in `extensions/mcp/` client. It reads global and trusted-project mcp.json, manages stdio/HTTP transports, bounded logging/results/resource lists/templates, cancellation/timeouts/retries, OAuth, commands and UI state. It registers native schemas/annotations/namespaces and supports direct/codemode/deferred tool exposure. Upstream defaults MCP exposure to codemode and auto-enables codemode for indirect servers; do not enable this automatically under ICE safe/plan/review or in stripped children.

The upstream trust detector includes project `mcp.json` among resources requiring trust. Current ICE detector lists settings, agents, extensions, skills, prompts, themes and system-prompt files but does not include mcp.json. Add that detection before connecting any project-configured servers; otherwise an MCP-only repository can take the no-trust-required shortcut. Preserve current ICE agent-directory trust detection too.

Required follow-up fixes are not optional: `b29db895` normalizes names consistently with codemode identifiers, `e029c3ed` asynchronously starts servers without delaying the first prompt, `c662ec7e` restores tool_search-loaded tools on resume/reload while registration is pending, `11449730` resolves renderers before servers connect, `1387af7b` allows project enabled/exposure overrides of global servers without taking their credentials, `5806068c` scopes OAuth storage by server name AND URL, `1d74741e` serializes cross-process OAuth refresh, `e529a82c` preserves step-up granted scopes, `d850edee` supports auth-server metadata override and validates RFC9207 issuer, `1499466d` makes client-id metadata documents opt-in, `91f9f3b5` supports a globally configured provider login for a server (project config cannot select credential destination), and `7c9fe664` supplies OAuth client name.

ICE host-provided `mcp`/`mcp__*` tools and selected child MCP adapters do not implement this client/transport/config/OAuth/resource lifecycle. Reuse existing approval/trust hooks as the policy boundary. New global/project server configs are executable/credential-bearing authority, not trusted tool descriptions. Project trust alone is insufficient under ICE; require explicit mode, allow-external and approval-capable client. Keep child adapters owner-scoped/revocable; do not let child ambient mcp.json auto-load. Leave remote telemetry opt-in.

Verification: `test/mcp-extension.test.ts`, `test/mcp-command.test.ts`, `test/mcp-oauth-refresh.test.ts`, `test/mcp-oauth-store.test.ts`, `test/suite/agent-session-mcp.test.ts`, `test/suite/agent-session-mcp-oauth.test.ts`; MCP conformance harness is an explicit separate network/integration run, not a default test invocation.

### 20. Codemode and tool search

`8562bcf6` adds `extensions/codemode/{index,tool,execute,worker,renderer,execute.lazy}.ts` and `extensions/tool-search/{index,tool}.ts`. Codemode runs JavaScript in QuickJS/WASM worker with 256 MiB heap, inherited cancellation, selected callable host tools, successful-script-only branch store writes, capped output/artifacts, catalog discovery helpers and BM25 ranking. It defaults inactive, with on/only loadout modes; MCP indirect exposure can activate it. Full matching `packages/codemode` and `packages/mcp` implementations and packaged worker/WASM assets are prerequisites.

`9a100c7c` adds nested/classifier usage to session totals; `aab34df6` adds image model calls; `6f1072cc` reduces prompt and improves script error guidance; `1c7e7df7` lists MCP namespaces/servers rather than every tool; `1ff5b6fd` expands programmatic Bash output; `4a42f8fa` fixes Windows worker packaging. `0582d9c1` and `5257d0d5` bound previews/show arguments.

QuickJS isolation contains JavaScript heap/globals, not the authority of its exposed tools. `models.classify/generateImages` select canonical catalog objects by provider/id and drop headers so script-supplied URL/header fields cannot receive stored credentials. Preserve that boundary; ICE must additionally gate paid model operations and inherited route authority, mode restrictions, output retention, and no recursive delegation. Never register a new model harness/controller from this feature.

Verification: `test/tool-search.test.ts`, `test/codemode-worker-config.test.ts`, `test/codemode-renderer.test.ts`, `test/nested-tool-calls.test.ts`, `test/compaction-nested-calls.test.ts`, `test/suite/agent-session-codemode.test.ts`.

### 21. Virtual models through existing ModelRuntime

`540e174c` + `a0660b17` add `core/virtual-models.ts`, extension register/unregister hooks and per-request route resolution; virtual selection stays in model_change while actual assistant messages name the physical model. Branch-owned router state survives reopen/tree navigation; direct summary/classifier paths resolve physical models first. Retry reasons carry failed physical response separately, thinking levels clamp to the physical model, limits come from the actual responding model, and unrouted virtual calls fail explicitly. Current ICE per-child configured/fallback routes select one exact physical route at launch; this is not virtual-model parity.

Use the upstream seam if adopted, not another registry. ICE contract/capability fingerprints must capture actual routing policy and prevent post-acceptance authority expansion; virtual routes cannot silently substitute providers with broader credentials for durable child jobs. This optional feature needs an explicit ICE policy decision before enabling for managed child routes.

Verification: `test/virtual-models.test.ts`, `test/suite/virtual-models.test.ts`, route/cancellation/fork tests.

### 22. Prompt cache warming

`c596d09d` + `3390bd93` add `core/cache-warmer.ts`, mode settings and usage entries, SDK capture of request context/options, economics ($0.05 minimum estimated saving), one-token replay, one-hour streaming/30-minute idle bounds, cancellation on context/model change, and late-refresh rejection. Upstream reads this money-bearing option from global settings only and defaults to streaming warming. Current ICE fork promptCacheKey affinity improves cache selection, but performs no warming replay. For ICE safe policy, keep warming off/lazy unless explicitly enabled because it sends additional paid requests; that opt-in default is an intentional policy divergence from Pi. Preserve all exact request cache/session channels and cancellation. Cache warmer is a bounded adapter through existing Models, not a second reasoning loop.

Verification: `test/cache-warmer.test.ts`, `test/cache-stats.test.ts`, `test/sdk-stream-options.test.ts`, ICE promptCacheKey/session-isolation tests.

### 23. Bug reporting, crash attribution and managed installations

`3c75b274` adds local redacted diagnostic/transcript/summary ZIP archives, crash hints and explicit upload to Radius; `63787ee6` attributes extension paths in crash stacks. `core/bug-report.ts`, upload/crash-log helpers, CLI entry handling and summaries are absent. Port local collection/redaction independently if useful; never auto-upload local traces or transcripts and keep model-generated summary requests explicit.

`4af9d21d`, `7d4c0e05`, `c49906ec`, `faecac2c`, `c0613289`, `40c256cc` support managed runtime installations/self-update, preserve file permissions, recognize Node SEA/bundled Node hosts, lazy-load jiti/embedded virtual modules and split Bun runtime/sandbox setup. Current Bun bedrock register path is retained; upstream removes it in favor of unified runtime setup. This is functional packaging, covered jointly with parent. Do not replace ICE Curax immutable snapshot/current.json workflow or user runtime settings with Pi's managed installer endpoints. Upstream inline dynamic imports conflict with current ICE no-inline-imports code rule; preserve lazy seams using approved top-level loader boundaries or obtain an explicit architecture/rule decision, not a silent blanket port.

Verification: `test/package-distribution.test.ts`, `test/git-update.test.ts`, `test/version-check.test.ts`, `test/suite/regressions/8237-node-sea-extension-loading.test.ts`, `test/suite/regressions/9540-extension-loader-lazy.test.ts`; runtime/snapshot smoke checks belong to an explicitly requested build/update task.

## Separate architecture decision: experimental runtime

Every new `src/experimental/*` path is absent locally. Upstream replaces the older client/remote-session and CLI experimental transport layout with typed server/session services, independent session-worker processes, coordinator generation/demand ownership, scoped service subscriptions, Radius reconnect relay and package facet plugins. `experimental/durable/*` and `experimental/vacation/*` are demonstration harnesses with their own durable state/tasks/subagents and UI. Principal history: `8df02a43`, `17fd5026`, `8dce5da7`, `5876bc49`, `33dac362`, `1d0d110a`, `429f4e75`, `d3697e65`, plus durable agent prerequisites owned by parent.

This is not evidence that ICE must replace its working AgentSession loop, owner-scoped durable delegation jobs, session history or subagent controller. Full repository parity includes these experimental packages; stable interactive coding-agent parity can explicitly defer them. Importing their competing controller/session/runtime patterns as default ICE infrastructure conflicts with idea.md. If required, keep as clearly isolated experimental upstream entry points, review trust, network credentials and worker cleanup, and document scope in idea.md first.

Tests to preserve if this track is chosen: experimental-agent-controller/client-tui/internal-process/plugin-reload/presentation-facets/radius-relay/remote-runtime/server-lifecycle/server-profile/session-directory/session-worker-lifecycle/session-worker-manager/slash-commands/transcript-provider suites. Parent owns prerequisite chord/agent/runtime transport packages.

## Integration order and completion criteria

1. Freeze an archive/baseline without touching unrelated dirty files; record pinned npm 12.0.2 and current checks.
2. Port independent P0 defects with affected fake-provider regressions and full check, including user-Bash callers.
3. Integrate matching AI/Agent transcript and request boundary APIs plus coding-agent session projection as one coherent series. Update ICE fork, check-in, memory, compaction and exporter consumers.
4. Add model/runtime typed APIs, resource lifecycle, defaultTools/exposure/nested-call APIs with deny-first ICE policy filters. Re-run affected ICE suites.
5. Port stable MCP/codemode/tool-search together with optional disabled activation and worker packaging; include all follow-up OAuth/resume/name/render fixes.
6. Decide virtual model child policy/cache warming/local bug reporting and experimental runtime separately. Keep unapproved features deferred and distinguish stable parity from whole-monorepo parity.

After code changes the repository requires full `corepack npm@12.0.2 run check` (active npm version recorded) and the specific affected tests. Never execute the full Vitest suite directly. This audit did not run checks, tests, build, installs, provider APIs, real MCP servers or paid calls and makes no verified-runtime parity claim.

## Complete changed-path inventory

The following generated section covers this lane's owned changed source paths. It includes purely visual/render extraction files and declaration/export changes for completeness but does not recommend branding-only changes. The companion JSON carries normalized status, source line counts, upstream-only declarations, and all commits changing each file since the common base.

Inventory total: 201 changed paths. Status counts: {"diverged": 43, "missing": 101, "same normalized baseline": 57}.


### Runtime and packaging boundaries

| Upstream path | Change | Current implementation | Latest upstream commit |
|---|---|---|---|
| `packages/coding-agent/src/bun/cli.ts` | M | diverged | `1382777ed800` |
| `packages/coding-agent/src/bun/quickjs-wasm.d.ts` | A | missing | `8562bcf66a8e` |
| `packages/coding-agent/src/bun/register-bedrock.ts` | D | ancestor implementation | `312c5bd7001e` |
| `packages/coding-agent/src/bun/runtime-setup.ts` | A | missing | `8562bcf66a8e` |
| `packages/coding-agent/src/bun/sandbox-env-setup.ts` | A | missing | `1382777ed800` |
| `packages/coding-agent/src/config.ts` | M | diverged | `581e7ba78141` |
| `packages/coding-agent/src/package-manager-cli.ts` | M | diverged | `581e7ba78141` |

### CLI and startup

| Upstream path | Change | Current implementation | Latest upstream commit |
|---|---|---|---|
| `packages/coding-agent/src/cli.ts` | M | diverged | `1382777ed800` |
| `packages/coding-agent/src/cli/args.ts` | M | diverged | `9b3c19da5cff` |
| `packages/coding-agent/src/cli/auth-check.ts` | A | missing | `a261366bde90` |
| `packages/coding-agent/src/cli/auth-command.ts` | A | missing | `ab0dc51fcfd1` |
| `packages/coding-agent/src/cli/config-selector.ts` | M | ancestor implementation | `c505f4c19871` |
| `packages/coding-agent/src/cli/credential-print.ts` | M | ancestor implementation | `a261366bde90` |
| `packages/coding-agent/src/cli/file-processor.ts` | M | ancestor implementation | `f5c946480c57` |
| `packages/coding-agent/src/cli/session-picker.ts` | M | ancestor implementation | `dfbf793b7851` |
| `packages/coding-agent/src/cli/setup.ts` | A | missing | `1382777ed800` |
| `packages/coding-agent/src/cli/startup-ui.ts` | M | diverged | `bf8e4b953183` |
| `packages/coding-agent/src/extensions/mcp/cli.ts` | A | missing | `1387af7b427c` |
| `packages/coding-agent/src/main.ts` | M | diverged | `0c453048bd4b` |

### Experimental runtime and client migration

| Upstream path | Change | Current implementation | Latest upstream commit |
|---|---|---|---|
| `packages/coding-agent/src/cli/experimental/auth.ts` | D | ancestor implementation | `9d3cba027407` |
| `packages/coding-agent/src/cli/experimental/cli.ts` | M | diverged | `d3697e65cabe` |
| `packages/coding-agent/src/cli/experimental/command-options.ts` | M | ancestor implementation | `d3697e65cabe` |
| `packages/coding-agent/src/cli/experimental/command.ts` | M | ancestor implementation | `d3697e65cabe` |
| `packages/coding-agent/src/cli/experimental/commands/client.ts` | M | ancestor implementation | `d3697e65cabe` |
| `packages/coding-agent/src/cli/experimental/commands/pi.ts` | D | diverged | `d3697e65cabe` |
| `packages/coding-agent/src/cli/experimental/commands/server.ts` | M | ancestor implementation | `d3697e65cabe` |
| `packages/coding-agent/src/cli/experimental/transport-address.ts` | D | ancestor implementation | `9d3cba027407` |
| `packages/coding-agent/src/client/index.ts` | M | ancestor implementation | `35741a456dba` |
| `packages/coding-agent/src/client/remote-session.ts` | D | diverged | `e52de91d088e` |
| `packages/coding-agent/src/client/transcript.ts` | D | ancestor implementation | `e52de91d088e` |
| `packages/coding-agent/src/experimental/cli.ts` | A | missing | `1382777ed800` |
| `packages/coding-agent/src/experimental/client-runtime.ts` | A | missing | `ae2cc5116f5a` |
| `packages/coding-agent/src/experimental/client-tui-chat.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/client-tui.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/client.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/commands.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/coordinator-entry.ts` | A | missing | `a789067a0d94` |
| `packages/coding-agent/src/experimental/coordinator.ts` | A | missing | `a789067a0d94` |
| `packages/coding-agent/src/experimental/durable/README.md` | A | missing | `70c036211de5` |
| `packages/coding-agent/src/experimental/durable/harness-setup.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/durable/main.ts` | A | missing | `5609b0d6c07c` |
| `packages/coding-agent/src/experimental/durable/prompt.ts` | A | missing | `5609b0d6c07c` |
| `packages/coding-agent/src/experimental/durable/runtime.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/durable/sessions.ts` | A | missing | `5609b0d6c07c` |
| `packages/coding-agent/src/experimental/durable/subagent.ts` | A | missing | `5609b0d6c07c` |
| `packages/coding-agent/src/experimental/durable/tui.ts` | A | missing | `5609b0d6c07c` |
| `packages/coding-agent/src/experimental/plugin.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/plugins/bundled.ts` | A | missing | `e7b47bd7deab` |
| `packages/coding-agent/src/experimental/plugins/package.ts` | A | missing | `5245aba7c81b` |
| `packages/coding-agent/src/experimental/process.ts` | A | missing | `ca7460d16b5f` |
| `packages/coding-agent/src/experimental/radius-auth.ts` | A | missing | `3c75b2747965` |
| `packages/coding-agent/src/experimental/radius-relay.ts` | A | missing | `8e374e4dc201` |
| `packages/coding-agent/src/experimental/server.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/services/README.md` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/services/agent-controller-provider.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/services/agent-controller.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/services/connection.ts` | A | missing | `10d1ad621f9d` |
| `packages/coding-agent/src/experimental/services/models-provider.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/services/models.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/services/plugins.ts` | A | missing | `fbf2db635313` |
| `packages/coding-agent/src/experimental/services/presentation-ui.ts` | A | missing | `0252dff88653` |
| `packages/coding-agent/src/experimental/services/server.ts` | A | missing | `10d1ad621f9d` |
| `packages/coding-agent/src/experimental/services/sessions.ts` | A | missing | `8e374e4dc201` |
| `packages/coding-agent/src/experimental/services/slash-commands-provider.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/services/slash-commands.ts` | A | missing | `c4b0e35abe63` |
| `packages/coding-agent/src/experimental/services/transcript-provider.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/services/transcript.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/services/worker.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/session-catalog.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/session-worker-manager.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/session-worker.ts` | A | missing | `48dd1e2f0f9d` |
| `packages/coding-agent/src/experimental/source-resolver.ts` | A | missing | `e6ffbacff158` |
| `packages/coding-agent/src/experimental/vacation/README.md` | A | missing | `395315f4841a` |
| `packages/coding-agent/src/experimental/vacation/harness-setup.ts` | A | missing | `395315f4841a` |
| `packages/coding-agent/src/experimental/vacation/main.ts` | A | missing | `395315f4841a` |
| `packages/coding-agent/src/experimental/vacation/runtime.ts` | A | missing | `395315f4841a` |
| `packages/coding-agent/src/experimental/vacation/sessions.ts` | A | missing | `395315f4841a` |
| `packages/coding-agent/src/experimental/vacation/tui.ts` | A | missing | `395315f4841a` |
| `packages/coding-agent/src/experimental/vacation/vacation.ts` | A | missing | `395315f4841a` |

### Session, compaction, prompt and SDK

| Upstream path | Change | Current implementation | Latest upstream commit |
|---|---|---|---|
| `packages/coding-agent/src/core/agent-session-runtime.ts` | M | ancestor implementation | `ff72faba28d1` |
| `packages/coding-agent/src/core/agent-session-services.ts` | M | diverged | `540e174c72cd` |
| `packages/coding-agent/src/core/agent-session.ts` | M | diverged | `11449730c8a7` |
| `packages/coding-agent/src/core/compaction/branch-summarization.ts` | M | ancestor implementation | `9e05370b298d` |
| `packages/coding-agent/src/core/compaction/compaction.ts` | M | diverged | `9a100c7cc470` |
| `packages/coding-agent/src/core/compaction/utils.ts` | M | ancestor implementation | `8562bcf66a8e` |
| `packages/coding-agent/src/core/messages.ts` | M | ancestor implementation | `9e05370b298d` |
| `packages/coding-agent/src/core/sdk.ts` | M | diverged | `db6cc71dc7b6` |
| `packages/coding-agent/src/core/session-export.ts` | A | missing | `3c75b2747965` |
| `packages/coding-agent/src/core/session-manager.ts` | M | diverged | `b485fa3128c3` |
| `packages/coding-agent/src/core/system-prompt.ts` | M | ancestor implementation | `6f1072cc081f` |

### Models, auth, settings, accounting and diagnostics

| Upstream path | Change | Current implementation | Latest upstream commit |
|---|---|---|---|
| `packages/coding-agent/src/core/auth-storage.ts` | M | ancestor implementation | `c49906ec7778` |
| `packages/coding-agent/src/core/bug-report-upload.ts` | A | missing | `3c75b2747965` |
| `packages/coding-agent/src/core/bug-report.ts` | A | missing | `02eed88fd891` |
| `packages/coding-agent/src/core/cache-stats.ts` | M | ancestor implementation | `c596d09d9cef` |
| `packages/coding-agent/src/core/cache-warmer.ts` | A | missing | `3390bd936309` |
| `packages/coding-agent/src/core/crash-log.ts` | A | missing | `4259686d9290` |
| `packages/coding-agent/src/core/defaults.ts` | M | ancestor implementation | `2ff8ba62238e` |
| `packages/coding-agent/src/core/export-html/template.css` | M | ancestor implementation | `b2bd111f2d46` |
| `packages/coding-agent/src/core/export-html/template.js` | M | ancestor implementation | `8562bcf66a8e` |
| `packages/coding-agent/src/core/export-html/tool-renderer.ts` | M | ancestor implementation | `11449730c8a7` |
| `packages/coding-agent/src/core/footer-data-provider.ts` | M | ancestor implementation | `81152d88bb4c` |
| `packages/coding-agent/src/core/http-dispatcher.ts` | M | ancestor implementation | `23842b1e693e` |
| `packages/coding-agent/src/core/index.ts` | M | ancestor implementation | `aef5fc429b98` |
| `packages/coding-agent/src/core/keybindings.ts` | M | diverged | `fd889a274189` |
| `packages/coding-agent/src/core/mcp-servers.ts` | A | missing | `1499466d8581` |
| `packages/coding-agent/src/core/model-config.ts` | M | diverged | `76dfb88f63ce` |
| `packages/coding-agent/src/core/model-registry.ts` | M | diverged | `aab34df655e3` |
| `packages/coding-agent/src/core/model-resolver.ts` | M | ancestor implementation | `49b9df48952b` |
| `packages/coding-agent/src/core/model-runtime.ts` | M | diverged | `fddc968b9605` |
| `packages/coding-agent/src/core/models-store.ts` | M | diverged | `1355cd36e0b1` |
| `packages/coding-agent/src/core/nested-tool-calls.ts` | A | missing | `9a100c7cc470` |
| `packages/coding-agent/src/core/provider-composer.ts` | M | diverged | `76dfb88f63ce` |
| `packages/coding-agent/src/core/radius.ts` | M | ancestor implementation | `ed8b3bcc194c` |
| `packages/coding-agent/src/core/remote-catalog-provider.ts` | M | diverged | `c34f2d6ad593` |
| `packages/coding-agent/src/core/settings-diagnostics.ts` | A | missing | `913bcf3391be` |
| `packages/coding-agent/src/core/settings-manager.ts` | M | diverged | `6f1072cc081f` |
| `packages/coding-agent/src/core/slash-commands.ts` | M | diverged | `3c75b2747965` |
| `packages/coding-agent/src/core/usage-totals.ts` | M | ancestor implementation | `9a100c7cc470` |
| `packages/coding-agent/src/core/virtual-models.ts` | A | missing | `a0660b174ece` |

### Extensions, resources and trust

| Upstream path | Change | Current implementation | Latest upstream commit |
|---|---|---|---|
| `packages/coding-agent/src/core/extensions/index.ts` | M | diverged | `11449730c8a7` |
| `packages/coding-agent/src/core/extensions/jiti-loader.ts` | A | missing | `40c256cccbce` |
| `packages/coding-agent/src/core/extensions/jiti-static-loader.ts` | A | missing | `40c256cccbce` |
| `packages/coding-agent/src/core/extensions/loader.ts` | M | diverged | `11449730c8a7` |
| `packages/coding-agent/src/core/extensions/runner.ts` | M | diverged | `11449730c8a7` |
| `packages/coding-agent/src/core/extensions/types.ts` | M | diverged | `11449730c8a7` |
| `packages/coding-agent/src/core/extensions/virtual-modules.ts` | A | missing | `40c256cccbce` |
| `packages/coding-agent/src/core/extensions/wrapper.ts` | M | ancestor implementation | `8562bcf66a8e` |
| `packages/coding-agent/src/core/package-manager.ts` | M | diverged | `4259686d9290` |
| `packages/coding-agent/src/core/pi-manifest.ts` | M | diverged | `1355cd36e0b1` |
| `packages/coding-agent/src/core/project-trust.ts` | M | ancestor implementation | `ab0dc51fcfd1` |
| `packages/coding-agent/src/core/prompt-templates.ts` | M | diverged | `b6419322e6c8` |
| `packages/coding-agent/src/core/resource-loader.ts` | M | diverged | `9d1a6503521d` |
| `packages/coding-agent/src/core/skills.ts` | M | diverged | `1d6dbf9e3d60` |
| `packages/coding-agent/src/core/source-info.ts` | M | ancestor implementation | `4259686d9290` |
| `packages/coding-agent/src/core/trust-manager.ts` | M | diverged | `8562bcf66a8e` |

### Built-in tools and renderer separation

| Upstream path | Change | Current implementation | Latest upstream commit |
|---|---|---|---|
| `packages/coding-agent/src/core/tools/bash.ts` | M | diverged | `6f1072cc081f` |
| `packages/coding-agent/src/core/tools/edit-diff.ts` | M | ancestor implementation | `1355cd36e0b1` |
| `packages/coding-agent/src/core/tools/edit.ts` | M | ancestor implementation | `fcff255b004a` |
| `packages/coding-agent/src/core/tools/find.ts` | M | diverged | `487af8e1683a` |
| `packages/coding-agent/src/core/tools/grep.ts` | M | ancestor implementation | `487af8e1683a` |
| `packages/coding-agent/src/core/tools/index.ts` | M | ancestor implementation | `80e62761f725` |
| `packages/coding-agent/src/core/tools/ls.ts` | M | ancestor implementation | `487af8e1683a` |
| `packages/coding-agent/src/core/tools/output-accumulator.ts` | M | ancestor implementation | `1ff5b6fddf69` |
| `packages/coding-agent/src/core/tools/powershell.ts` | A | missing | `80e62761f725` |
| `packages/coding-agent/src/core/tools/read.ts` | M | diverged | `f5c946480c57` |
| `packages/coding-agent/src/core/tools/render-utils.ts` | M | ancestor implementation | `5257d0d5f3ab` |
| `packages/coding-agent/src/core/tools/renderers/bash.ts` | A | missing | `0582d9c11da7` |
| `packages/coding-agent/src/core/tools/renderers/edit.ts` | A | missing | `eb3e9feed1bd` |
| `packages/coding-agent/src/core/tools/renderers/find.ts` | A | missing | `eb3e9feed1bd` |
| `packages/coding-agent/src/core/tools/renderers/grep.ts` | A | missing | `eb3e9feed1bd` |
| `packages/coding-agent/src/core/tools/renderers/index.ts` | A | missing | `11449730c8a7` |
| `packages/coding-agent/src/core/tools/renderers/ls.ts` | A | missing | `eb3e9feed1bd` |
| `packages/coding-agent/src/core/tools/renderers/read.ts` | A | missing | `49681e1b71c9` |
| `packages/coding-agent/src/core/tools/renderers/write.ts` | A | missing | `eb3e9feed1bd` |
| `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` | M | ancestor implementation | `8562bcf66a8e` |
| `packages/coding-agent/src/core/tools/truncate.ts` | M | ancestor implementation | `8562bcf66a8e` |
| `packages/coding-agent/src/core/tools/write.ts` | M | ancestor implementation | `fcff255b004a` |

### Built-in MCP, codemode, search and llama extensions

| Upstream path | Change | Current implementation | Latest upstream commit |
|---|---|---|---|
| `packages/coding-agent/src/extensions/codemode/execute.lazy.ts` | A | missing | `8562bcf66a8e` |
| `packages/coding-agent/src/extensions/codemode/execute.ts` | A | missing | `6f1072cc081f` |
| `packages/coding-agent/src/extensions/codemode/index.ts` | A | missing | `8562bcf66a8e` |
| `packages/coding-agent/src/extensions/codemode/renderer.ts` | A | missing | `0582d9c11da7` |
| `packages/coding-agent/src/extensions/codemode/tool.ts` | A | missing | `6f1072cc081f` |
| `packages/coding-agent/src/extensions/codemode/worker.ts` | A | missing | `4a42f8fafaff` |
| `packages/coding-agent/src/extensions/index.ts` | M | ancestor implementation | `4259686d9290` |
| `packages/coding-agent/src/extensions/llama/client.ts` | M | ancestor implementation | `1e39862f677a` |
| `packages/coding-agent/src/extensions/llama/index.ts` | M | ancestor implementation | `d3e3bbc01177` |
| `packages/coding-agent/src/extensions/llama/provider.ts` | M | diverged | `da19b63c7750` |
| `packages/coding-agent/src/extensions/mcp/cli.lazy.ts` | A | missing | `8562bcf66a8e` |
| `packages/coding-agent/src/extensions/mcp/config.ts` | A | missing | `1387af7b427c` |
| `packages/coding-agent/src/extensions/mcp/index.ts` | A | missing | `11449730c8a7` |
| `packages/coding-agent/src/extensions/mcp/log.ts` | A | missing | `8562bcf66a8e` |
| `packages/coding-agent/src/extensions/mcp/oauth.ts` | A | missing | `1499466d8581` |
| `packages/coding-agent/src/extensions/mcp/resources.ts` | A | missing | `8562bcf66a8e` |
| `packages/coding-agent/src/extensions/mcp/runtime.lazy.ts` | A | missing | `8562bcf66a8e` |
| `packages/coding-agent/src/extensions/mcp/runtime.ts` | A | missing | `1499466d8581` |
| `packages/coding-agent/src/extensions/mcp/tools.ts` | A | missing | `11449730c8a7` |
| `packages/coding-agent/src/extensions/mcp/ui.ts` | A | missing | `ced72c2f095b` |
| `packages/coding-agent/src/extensions/tool-search/index.ts` | A | missing | `8562bcf66a8e` |
| `packages/coding-agent/src/extensions/tool-search/tool.ts` | A | missing | `e029c3ed0add` |

### Entry points and migrations

| Upstream path | Change | Current implementation | Latest upstream commit |
|---|---|---|---|
| `packages/coding-agent/src/index.ts` | M | diverged | `11449730c8a7` |
| `packages/coding-agent/src/migrations.ts` | M | diverged | `aa23e784c647` |

### Utilities

| Upstream path | Change | Current implementation | Latest upstream commit |
|---|---|---|---|
| `packages/coding-agent/src/utils/clipboard-command.ts` | A | missing | `caf6dfe7310c` |
| `packages/coding-agent/src/utils/clipboard-image.ts` | M | ancestor implementation | `8676a0dcd8f9` |
| `packages/coding-agent/src/utils/clipboard-native.ts` | D | diverged | `caf6dfe7310c` |
| `packages/coding-agent/src/utils/clipboard.ts` | M | ancestor implementation | `fd889a274189` |
| `packages/coding-agent/src/utils/exif-orientation.ts` | M | ancestor implementation | `c6b00676b8fe` |
| `packages/coding-agent/src/utils/frontmatter.ts` | M | ancestor implementation | `1355cd36e0b1` |
| `packages/coding-agent/src/utils/highlight-js-lib-index.d.ts` | D | ancestor implementation | `cec3a91c029e` |
| `packages/coding-agent/src/utils/highlight-js.d.ts` | A | missing | `cec3a91c029e` |
| `packages/coding-agent/src/utils/image-convert.ts` | M | ancestor implementation | `a276dabe5791` |
| `packages/coding-agent/src/utils/management-http.ts` | A | missing | `df018b602018` |
| `packages/coding-agent/src/utils/mime.ts` | M | ancestor implementation | `47a18e37b1a8` |
| `packages/coding-agent/src/utils/paths.ts` | M | ancestor implementation | `4259686d9290` |
| `packages/coding-agent/src/utils/shell.ts` | M | ancestor implementation | `b485fa3128c3` |
| `packages/coding-agent/src/utils/syntax-highlight.ts` | M | ancestor implementation | `8562bcf66a8e` |
| `packages/coding-agent/src/utils/text.ts` | A | missing | `1355cd36e0b1` |
| `packages/coding-agent/src/utils/tool-result-images.ts` | M | ancestor implementation | `f5c946480c57` |
| `packages/coding-agent/src/utils/tools-manager.ts` | M | diverged | `6aedd1066e54` |
| `packages/coding-agent/src/utils/version-check.ts` | M | diverged | `845bb970f315` |
| `packages/coding-agent/src/utils/wsl.ts` | A | missing | `6dff740fab3f` |
| `packages/coding-agent/src/utils/zip.ts` | A | missing | `3c75b2747965` |
