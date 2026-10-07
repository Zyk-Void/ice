# ICE upgrade backlog against Pi upstream

## Conclusion

ICE needs a substantial upstream integration. The important work is in provider correctness, transcript replay, compaction/session integrity, extension lifecycle, tools, authentication, and terminal/RPC behavior. Rebranding is excluded. Several capabilities are already present or partially backported, and ICE has additional policy and subagent behavior that must survive the integration.

There are two distinct completion targets:

- **Stable Pi parity:** upgrade the existing AI → Agent → AgentSession stack, providers/models, extensions/tools, MCP/codemode, and interactive/headless interfaces. Keep one authoritative reasoning/tool loop and the ICE safety seams.
- **Full repository parity:** also migrate the experimental client/server/storage stack to Chord and pi-durable. This is a breaking architecture/data migration, not a rename or an independent small patch. Deferring it leaves an explicit experimental parity gap.

This report is a source audit and proposed implementation backlog. No implementation, runtime parity verification, tests, builds, installs, provider requests, commits, or branch changes were performed. Only these report artifacts were added to the worktree.

## Frozen comparison

| Item | Audited value |
|---|---|
| ICE branch | `integration/all-worktrees-experimental` |
| ICE HEAD | `db8dd8eebfebe4a2e65d93e9693e6892744517e2` plus existing dirty files |
| Pi target | [`200387122ca450d6387f033949423114a270b96c`](https://github.com/earendil-works/pi/commit/200387122ca450d6387f033949423114a270b96c), main, v1.0.2 |
| Shared ancestor | [`588915ec71714688cee8b7153339e8bdebb3e82e`](https://github.com/earendil-works/pi/commit/588915ec71714688cee8b7153339e8bdebb3e82e), August 4, 2026 |
| Commits after ancestor | Pi: 1,294; ICE: 128 |
| Upstream changed paths | 1,491 with rename detection disabled, including docs/tests/generated/assets/deletions |
| Runtime/script inventory | 691 paths under the classifier in `source-inventory.tsv`; excludes Markdown, generated catalogs, tests and binary assets |

Commit and path counts measure scope, not missing functionality. File equality after conservative branding normalization is only a candidate classification. Semantic findings below and in the detailed reports account for existing implementations and ICE differences. The exact dirty snapshot is in [baseline.json](baseline.json); current file hashes are in [upstream-file-inventory.json](upstream-file-inventory.json).

Three subagents audited AI, coding-agent core, and TUI/transport surfaces. The parent audited stable Agent, new packages, experimental protocol/client/server/storage, and dependency/build wiring. All findings target the frozen final upstream code, rather than proposing a blind replay of intermediate upstream commits.

## Read first: correctness and authority fixes

These can largely be isolated before the cross-package contract migration. The detailed reports give symbols, upstream commits, and relevant test paths.

| Priority | Required change | Main files / detailed reference |
|---|---|---|
| P0 | Reject unfinished Responses tool arguments at terminal events; preserve finalized namespaces and grammar replay identity. | `packages/ai/src/api/openai-responses-shared.ts`; [AI-01](ai.md#ai-01--p0-reject-unfinished-responses-tool-calls-and-preserve-tool-namespaces) |
| P0 | Generate genuinely strict recursive tool schemas, normalize optional nulls using the original schema, and safely fall back for unknown endpoints/unsupported schemas. | `ai/src/api/constrained-sampling.ts`, `utils/validation.ts`, provider serializers; AI-02 |
| P0 | Bound retry delays; handle invalid Retry-After; distinguish overflow and transient errors without blindly replaying tools. | `ai/src/utils/{retry,provider-retry,overflow}.ts`; AI-03 |
| P0 | Recheck abort inside prepared parallel tool closures so an earlier prepared sibling cannot execute after a later preflight abort. | `agent/src/agent-loop.ts`; [R1](runtime-infrastructure.md#stable-agent-runtime-required-changes) |
| P0 | Reject `Agent.reset()` during an active run. | `agent/src/agent.ts`; R2 |
| P0 | Flush final SSE frames; emit a terminal error when the proxy ends without done/error. Also flush Codex final unterminated SSE frames. | `agent/src/proxy.ts`, `ai/src/api/openai-codex-responses.ts`; R3, AI-17 |
| P0 | Failed user Bash hooks must propagate failure. ICE currently catches a hook exception and returns `undefined`, permitting fallback host Bash. | `coding-agent/src/core/extensions/runner.ts` and user Bash callers; coding-core §1, UI correctness findings |
| P0 | Reject length-truncated and tool-calling compaction summaries; close cancellation/navigation/controller races. | `coding-agent/src/core/compaction/*`, `core/agent-session.ts`, interactive cancellation; coding-core §§2–3 |
| P0 | Persist the first user message and preserve JSONL/import/fork/leaf/compaction boundaries. | `coding-agent/src/core/session-manager.ts`, `core/agent-session.ts`; coding-core §4 |
| P0 | Make extension initialization transactional; clean up listeners/resources on failed initialization, unload and reload. | `coding-agent/src/core/extensions/{loader,runner}.ts`; coding-core §5 |
| P0/P1 | Keep runtime custom messages behind pending tool results; maintain queued input handlers and their ordering through compaction. | `coding-agent/src/core/agent-session.ts`; coding-core §6 |

## Complete logical integration groups

Each row expands into the file/symbol/commit/test checklist in the linked report. Priorities indicate suggested integration order, not whether a feature is required for parity.

| Area | Changes ICE needs | Detailed checklist |
|---|---|---|
| Transcript and agent contract, P1 prerequisite | Canonical system messages containing prompt/tool deltas; normalized provider context; JSON-safe persisted arguments/results; assistant frame reducer; `finishTurn`, `prepareRequest`, queue peeking and corrected `prepareNextTurn` timing; structured tool results/output schemas; parent-hook nested dispatch; provider stream observation; requested/native reasoning metadata. | [AI](ai.md), AI-04–05; [Agent](runtime-infrastructure.md), R4–R9 |
| Session/context/compaction | Branch-local `context_edit` projection; usage/system snapshots; accurate context estimation; post-tool compaction reconciliation and per-model `compaction.modelOverrides`; session-scoped model/thinking defaults. Preserve ICE's existing mid-run compaction, lock, safety thresholds, Blackhole and child compaction. | [Coding core](coding-core.md), §§7–9 |
| Provider transport and reasoning | Anthropic effort continuity/fallback usage/federation; Bedrock encrypted reasoning, headers/document keys/cache accounting; Completions structured reasoning/budgets/template parameters; native Mistral SSE; Google stop/thinking metadata; cache affinity/expiry/pricing and observer callbacks; Responses capability/error attribution and Codex Off mapping. | AI-06–11, AI-17 |
| Model runtime and metadata | One native registry for chat/image/classifier models; typed operation dispatch/identity/errors; image limits/resizing; generator schema 3→6 and shared typed catalog protocol; exact context/output/reasoning/tools/image metadata; built-in llama runtime/presets/classifier behavior; virtual models through the existing `ModelRuntime`. | AI-13–14; coding-core §§12,16,21; runtime infrastructure §5 |
| Authentication and startup | Shared safe OAuth callback lifecycle, Anthropic copy-code, Copilot discovery/enable ordering and persisted device identity, Radius exchange, Meta/direct ChatGPT login; catalog/auth lock cancellation and retry-safe management requests; CLI validation, auth preflight and settings diagnostics. | AI-12; coding-core §§13,15 |
| Extension/resource loading | Tool loadouts/default-tools add/remove semantics; direct/model-only/deferred/hidden/codemode exposure; resource override precedence, worktree instruction deduplication, BOM/frontmatter/skill parsing, pinned extension identity and semver upgrades; renderer/execution separation. | coding-core §§10,14,18; UI I3–I4 |
| Tools and outputs | Optional PowerShell through the same policy; signal exit status; Windows termination/spawn errors; proper `ctx.cwd`; edit/glob correctness; structured versus model-facing output limits; consistent nested permission/cancellation hooks. | coding-core §§10–11 |
| MCP and codemode | New MCP transport/client/OAuth/resource lifecycle and builtin integration; project `mcp.json` trust detection before connection; QuickJS worker, bounded memory/output/store, validated images, tool search, nested tools and model operations through native hooks. Existing host-supplied ICE MCP tools do not cover this client/auth behavior. | coding-core §§19–20; runtime new-packages table |
| Terminal input/rendering | Mouse dispatch/focus; incomplete escape parsing; transcript search/copy/wheel acceleration; ANSI/hyperlink/width correctness and rendering/memory performance; completion/history fixes; terminal capability/style APIs; Kitty/WezTerm/image conversion correctness; native-platform/clipboard integration; optional LaTeX/Mermaid rendering. | [TUI/UI](tui-surfaces.md), T1–T8 |
| Interactive lifecycle | Scoped-model toggle semantics; model catalog refresh cancellation; progressive session picker/startup input; whole-session abort; canonical transcript/context rendering, accurate usage/footer state; OAuth/back/resource configuration; MCP/codemode/fallback tool presentations. | UI I1–I4 |
| RPC/JSONL/export | RPC started/queued/handled dispositions, `clear_queue`, `source:'rpc'` input hooks, snapshot listener lifecycle; JSONL usage/tool-call-start metadata; raw/projected export; hidden-message handling. Print has no independent upstream source delta, but consumes the upgraded events. | UI R; coding-core §18 |
| Utility and optional operations | FIFO event-stream performance; proxy/NO_PROXY edge cases; monotonic UUID semantics; null/case-insensitive headers; lean entrypoints; optional Cloudflare binding, cache warming, local bug/crash export and managed installation. Paid warming, uploads and new credentials require ICE's explicit policy. | AI-15–16; coding-core §§17,22–23; UI I5 |
| Dependencies/build contracts | Exact API dependency upgrades, TS7/Node-source/export/entry-graph wiring, runtime-dependency verification, model catalog publishing, worker/native assets and package-consumer checks. Integrate existing dirty release/Curax snapshot work. | [Runtime/infrastructure](runtime-infrastructure.md); [field-level differences](dependency-and-wiring-diff.json) |
| Experimental runtime | Chord services/facets/deltas; pi-durable tasks/documents/ownership/recovery/storage/tools/generation; protocol 1→8, route/attachment fencing, cancellation/subscriptions and explicit reconnect; migrate client/server/workers/experimental UI together. Old harness/storage removals require consumer/data migration and a decision. | runtime experimental sections; coding-core experimental section; UI E |

## ICE behavior to preserve

These are intentional fork features or existing backports, not evidence that Pi is missing functionality ICE must delete:

- Trust, deny-wins permissions, execution modes, protected paths, constrained child contracts/workspaces, approvals, bounded recovery and the single authoritative Agent/AgentSession loop.
- Dynamic local endpoint discovery and exact metadata precedence; provider composer/routing; independent `promptCacheKey`; route/account identity; `hardMaxOutputTokens` enforcement; `ultra`; ICE service-tier and thinking-format support.
- Managed subagents/check-ins, exact child sessions, graceful stop, targeted queue removal, abort classification, Cognee/Blackhole integration and child-context sanitation.
- Existing post-tool/mid-run compaction and safety net, source-ordered tool results, awaited listeners, late-update suppression, truncated-tool-call rejection at the stable loop, and existing simple/Azure tool-choice backports.
- ICE view bridge, themes/customization transactions, table rendering, custom RPC fields and Curax runtime snapshot integration.
- ICE package names, command/environment/protocol identifiers, local telemetry default and install/shrinkwrap policy.

Specific decisions that block literal file replacement:

1. Pi's direct ChatGPT and some compatible Responses routes omit unsupported output caps. ICE must explicitly represent that capability and fail closed where approved hard output authority cannot be enforced.
2. Pi removes old AgentHarness/storage and separate image registry exports. Migrate callers and data before retirement; do not remove current intentional functionality automatically.
3. Pi introduces lazy-loading patterns that can conflict with ICE's top-level-import rule. Preserve the required lazy capability boundary with an approved launcher/adapter/module structure.
4. MCP/codemode, virtual models, cache warming, sharing, managed installers and external auth/telemetry must retain ICE mode/trust/approval boundaries. Upstream defaults are not authority grants.
5. Undici changes require a release-note review before applying the dependency update. Dependency versions in this audit are observed differences, not tested upgrade recommendations.

## Implementation sequence and acceptance

1. Use an isolated implementation worktree; record the current dirty baseline and preserve unrelated work. Integrate independent P0 fixes with their upstream mock/faux-provider regressions first.
2. Upgrade required types/dependencies, then migrate AI transcript → Agent → AgentSession/compaction/extensions/children together. Do not install one half of the contract change.
3. Port provider transport/auth/model metadata and typed operations. Update generators before generated outputs; never commit endpoint keys or a generated local catalog.
4. Port tools/resources, interactive/TUI/RPC and performance fixes, checking the corresponding ICE policy, child, view and transport regressions.
5. Add MCP/codemode/native feature parity behind existing authority hooks. Make optional costly or external behavior explicit.
6. Decide and implement the experimental Chord/durable/client/server/storage migration separately. Stable completion must explicitly state that experimental parity is still deferred if this step is omitted.
7. For every slice, run the affected deterministic tests and `corepack npm@12.0.2 run check` with complete output. Do not use the full Vitest suite or real provider APIs. No check has been run for this audit and no passing implementation result is claimed.

Completion needs behavior tests and observed command results, not matching version strings, copying whole files, or an audit report. Full parity additionally needs the experimental migration and its persistence/reconnect/cancellation/data tests.

## Evidence and inventories

- [AI findings and complete changed AI path appendix](ai.md), plus [AI path/commit history](ai-inventory.json).
- [Coding-agent core findings and complete path appendix](coding-core.md), plus [core path/commit history](coding-core-inventory.json).
- [TUI, interactive, RPC and experimental UI findings](tui-surfaces.md), plus [UI path/commit history](tui-inventory.json).
- [Stable Agent, new packages, experimental migration and infrastructure](runtime-infrastructure.md).
- [All upstream changed files and hashes](upstream-file-inventory.json), [runtime/script paths](source-inventory.tsv), [ICE-only tracked paths](ice-only-file-inventory.json), [dependency/export/script differences](dependency-and-wiring-diff.json), [baseline](baseline.json), [all upstream commits](upstream-commits.txt).

The full public upstream code patch and numstat are retained locally under `/tmp/ice-pi-upstream-audit-results-20261004/`. The frozen Git clone is `/tmp/ice-pi-upstream-audit-20261004/`. The worktree report directory contains the findings and inventories; it deliberately excludes the large raw patch, native binaries and generated catalogs. These are uncommitted report files, not committed changes.
