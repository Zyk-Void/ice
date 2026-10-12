# ICE Subagent Progress

> Historical (V1 subagent era, last updated before 2026-09-11). Subagents V2 replaced this plan; see `packages/coding-agent/docs/subagents-v2.md`, `Plan/subagent-rewrite.md`, and the Near-Term Roadmap in `idea.md`.

_Last updated: 2026-08-13_

## 2026-08-13 Cognee + Blackhole contract repair

Implemented transient recall, `auto` never owns the Ice summary, local last-compact inject, project `$project` datasets, Blackhole `tailBehavior: "minimal"` actually dropping the kept tail, and host settings (native overflow compact on, Blackhole minimal, Cognee `$project`).

Targeted tests: 39 passed (`ice-cognee`, blackhole suite, blackhole tail). Scoped biome clean. Root `npm run check` blocked by a nested `.worktrees/sub-cognee/biome.json` and pre-existing `packages/ai` model-id type errors.

Live luna smoke (one print, plan-mode default): `codexlb/gpt-5.6-luna` replied `ok`; input **29629** tokens. That is the uncompactable system/tools/plan floor, not compact tail.

Report: `agent_docs/ice-cognee-compaction-benchmark-2026-08-13.md`.

## 2026-08-12 Cognee review

Read-only pass over Cognee + Ice compaction + live config inventory. Other-model hygiene items (dead env keys, `lastRecallKey`, jsonl rotation, bash substring, doctor latency) are real but secondary. Highest-value defects: recall persists as `custom_message` (echo loop), default `auto` without Blackhole replaces native structured compaction with recall dumps, and the first post-compact prompt races the checkpoint write.

Saved:

- full report: `agent_docs/ice-cognee-findings-2026-08-12.md`
- summary: `findings.md` §22
- implementation order: `task_plan.md` (Cognee contract repair)

No Cognee source edits in this pass. No secrets written.

---

## Current status

**Phase:** Read-Only Subagents V1 implementation is COMPLETE / FROZEN. W7.1, W7.2, W8.1, W8.2, and W8.3 owner-scoped durable asynchronous read-only jobs, metadata-only observatory visibility, explicit terminal-result inspection, and frozen persisted completion-inbox metadata are implemented as bounded V2 slices. B8.1 adversarial tests, B8.2 harness correctness, and B8.3 report evidence are complete; exhaustive comparative matrices remain optional certification. W5B live-model writer certification remains pending as an external production gate and does not block the implementation freeze. Job-management cancellation/retry/queue-control actions, polling, live inbox refresh, result ingestion, background batch facades, background writers, auto-resume, steering/priority, and Hivemind remain deferred.

Canonical W1-W11 executable acceptance ledger: `findings.md` section 21. It records the latest C1/C2/C3 evidence after each focused rerun; W5B remains pending external certification.

### YOLO built-in capability expansion

- Explicit `--sub-yolo` now permits confirmed unsafe children to use only capabilities requested by the selected profile and still active in the trusted parent; the eligible built-ins are `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write` across foreground, async, batch, and review paths.
- Child extensions, MCP, recursive delegation, and `delegate_write` remain disabled; unsafe preflight reports the profile-aware effective tools and one total attempt, matching runtime behavior.

## M12/M13 execution

- Status: **M12 COMPLETE / VERIFIED / FROZEN; M13 COMPLETE / VERIFIED / FROZEN**; the native-only production policy remains implemented and no roadmap W10-W13 capability work is claimed.
- Canonical M12 evidence is cold `99f421f8-228b-4137-a44e-092895359713`, warm `d6222038-23e7-4ca9-a8ce-1770dc96db37`, safety `67457e73-cd91-452b-b0a0-154ebf94a369`, and compatibility `430338fe-ddb8-45f6-a0ee-fdaaee129df9`; all are schema-v2 runs with complete budgets and `hardGate: true`.
- All four M12 reports decide `native-only`; resource-loader and CLI vectors are complete, startup/end-RSS metrics are present, terminated-child RSS remains unavailable/null, and subprocess remains benchmark/isolation evidence rather than an automatic fallback.
- Canonical M13 evidence is `.artifacts/m13/m13-1786296433961/`; it consumes exactly those four runs and records observed C1 `263/263`, C2 `181/181`, C3 `9/9`, `dirty: true`, current HEAD `7cbd8a676815cbfef3b03a4902269ede2ac2fbf1`, and W5B pending external certification.
- The previous M12/M13 artifacts remain historical and not canonical. Baseline provenance: `HEAD 7cbd8a676815cbfef3b03a4902269ede2ac2fbf1`; worktree remains dirty with concurrent changes.

The atomic subagent design remains intentionally small: one ICE-only `delegate` executor plus typed `delegate_batch` and `review_batch` facades, bundled or explicitly trusted user/project roles, native in-process child `AgentSession` sessions, stripped resources by default, explicitly selected skills/prompts/context only, four read-only tools at most, foreground execution, typed bounded results, and parent verification. A post-Phase-B Hivemind layer is documented separately under `docs/hivemind/`: parent-as-queen coordination over the same subagent executor, bounded parallel siblings, run-scoped evidence state, advisory evidence quorum, and verified durable learning.

## Completed

### Repository and compatibility analysis

- Confirmed the current working branch is `feat/subagents` for this planning pass; the long-term branch model in `idea.md` remains separate.
- Preserved existing concurrent work in ICE provider/model-store/Cognee/tests and related planning files.
- Confirmed the subagent implementation is confined to the active ICE source/test files and preserves unrelated concurrent work.
- Identified Ice's own compatible subagent example under `packages/coding-agent/examples/extensions/subagent/`.

### Local reference inventory

Completed source-level inspection of:

- Ice subagent extension example;
- Oh My Ice task/executor/discovery/parallel/worktree and async lifecycle patterns;
- OpenCode task, subagent permissions, background job, and regression tests;
- II-Agent delegation, run/event, persistence, and sandbox boundaries;
- Claw Code task packet, task registry, worker boot, permissions, session identity, and evidence/report model;
- OpenHands local checkout, recorded as a limited architecture reference because the current agent runtime lives outside the vendored tree;
- ActiveLoop Hivemind for shared trace/recall/session-summary/skill-learning and its Ice-native lifecycle integration;
- Ruflo Hive Mind for topology, worker membership, shared state, consensus proposals, and bounded collective coordination.

### ICE native runtime seams validated

Confirmed that ICE already exposes the primitives needed for a native child-session MVP:

- `createAgentSession()` supports explicit `cwd`, model, thinking level, tools, custom tools, resource loader, settings, and session manager;
- `tools` becomes a real `allowedToolNames` filter inside `AgentSession`, affecting built-in, extension, and custom tools;
- `SessionManager.inMemory()` can give a child a fresh non-durable history;
- `AgentSession.subscribe()` exposes typed events;
- `AgentSession.prompt()` drives a child run;
- `AgentSession.abort()` + `waitForIdle()` provide deterministic cancellation;
- Ice's agent/tool/compaction paths already use abort signals;
- the extension API exposes `ice.getActiveTools()`, so child capability derivation can reuse the parent's live ICE mode/tool state;
- `DefaultResourceLoaderOptions` exposes `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`, and explicit `systemPrompt`, which is sufficient to define a deliberately stripped V1 worker runtime;
- model selection can reuse the canonical ICE model runtime/catalog instead of creating a subagent-specific provider layer.

This changed the architecture recommendation from “subprocess extension is the first slice” to:

> Use a stripped native child `AgentSession` for the foreground MVP. Keep Ice's subprocess example as a benchmark/process-isolation reference, not as the default architecture.

### Architecture decisions completed

Locked the following design constraints in `findings.md`:

- parent remains authoritative;
- model-facing tool name is `delegate` and it is loaded only by `ice`;
- fresh native child `AgentSession` context by default;
- one foreground child in V1;
- bundled TypeScript roles are only `explore` and `review`;
- custom user/project role discovery is deferred to V2;
- child resource discovery is entirely disabled in V1: no extensions, skills, templates, themes, or context files;
- child capabilities are derived from `ice.getActiveTools()` intersected with role/runtime policy;
- V1 children have at most `read`, `grep`, `find`, and `ls`;
- `ice-cognee`, `ice-safe-verify`, Blackhole extensions, Bash, mutation, MCP/network, and recursive `delegate` are absent from the child runtime;
- typed run lifecycle and result envelope;
- cancellation and timeout are distinct terminal states;
- bounded output and progress;
- parent verifies child evidence;
- parallel fan-out is later;
- writer agents require isolated workspaces;
- background jobs require durable lifecycle semantics;
- parent/child memory and compaction state stay isolated.

### Documentation completed

- Reworked `findings.md` into a design document rather than a raw research log.
- Added a reference comparison table and explicit ICE decisions.
- Added native-vs-subprocess runner analysis.
- Added proposed contracts for profile/request/run/result.
- Added context, permission, trust, cancellation, observability, verification, memory, failure-mode, and test sections.
- Added a staged expansion path for parallelism, isolated writers, and background jobs.
- Added `docs/hivemind/` with architecture, contracts, subagent integration, memory/learning, safety/consensus, roadmap, and source-provenance notes.
- Locked Hivemind's target boundary: parent Ice session is the logical queen; Hivemind schedules sibling subagent runs through the same executor and cannot override permissions or verification.

## Implemented in the V1 foreground slice

- Added bundled `explore` and `review` role contracts, request normalization, scope validation, read-tool intersection, bounded UTF-8 output, lineage/result verification, and stable failure codes.
- Added a native child `AgentSession` runner using `SessionManager.inMemory()`, the existing model runtime, a stripped `DefaultResourceLoader`, hard read-only tool filtering, and tool-boundary scope guards for `read`, `grep`, `find`, and `ls`.
- Added a bounded JSON report envelope with required evidence paths; parent verification now rejects completed results without structured, existing, in-scope evidence.
- Added deterministic created/started/progress/tool/terminal lifecycle events, parent cancellation, timeout handling, cleanup, and model-availability failure classification.
- Added the hidden ICE-only `delegate` extension/tool and included it in guarded plan/build active-tool policy without changing stock `ice`.
- Added focused tests for contracts, stripped resources, fresh history, parent gating, cancellation, timeout, registration, and guarded-build compatibility.

## Implemented in Phase B1

- Added typed `delegate_batch` sibling fanout over `runResolved()` with a maximum of 8 read-only tasks, default concurrency 2, and hard maximum concurrency 4.
- Added parent-owned reservation/reconciliation for a bounded complete-JSON-report byte budget, observed output bytes on every terminal result, public bounded `totalBudgetBytes`, aggregate usage, deterministic input-order results, per-task launch provenance, and batch/run lifecycle IDs.
- Added fail-fast opt-in with active-sibling abort and queued-task suppression, parent cancellation, batch timeout, and independent sibling verification without shared child state.
- Added focused scheduler tests for slow/fast ordering, sequential equivalence, budget release/exhaustion, sibling failure, cancellation, timeout, usage aggregation, and lifecycle identity.

## Implemented in Phase B2

- Added typed `review_batch` orchestration over the existing bounded `delegate_batch` scheduler and `runResolved()` executor.
- Added correctness, security, tests, and regressions dimensions with forced read-only reviewer roles, fresh sessions, independent scopes, and deterministic input-order results.
- Added bounded structured findings with in-scope evidence references and per-reviewer verification.
- Preserved contradictory findings as separate reviewer output; no deduplication, voting, quorum, consensus, or parent-side synthesis was added.

## Implemented in Phase B3.1

- Added the typed reviewer model resolver and provenance for future explicit operator-owned routing; its parent-model fallback remains the default.
- The public `review_batch` tool now exposes no task model or model-policy selectors, so every user-facing reviewer inherits the selected parent model.
- Unavailable and ambiguous internal configured references still reject before child launch; no fallback model is silently selected.
- Reused the existing scheduler unchanged; ordering, failure isolation, cancellation, fail-fast, and aggregate accounting remain scheduler-owned.

## Implemented in Phase B4

- Added one typed parent-owned `SubagentLaunchPreflight` for both `delegate_batch` and `review_batch` over resolved immutable task contracts.
- Generated preflight after model/resource resolution and before scheduler launch; reused existing task, profile/resource hash, effective-tool, concurrency, timeout, and budget validation paths.
- Recorded requested and actual resolved models separately, preserving B3.1 provenance without changing request-level `launch.model`.
- Added resolved scope roots, effective tools, project trust, selected-resource names, and non-body resource provenance to typed details.
- Added a byte-bounded launch digest for parent context; digest truncation leaves complete typed preflight details intact.
- Documented `reservedOutputBytes` as the planned sum of per-task output caps; the live scheduler ledger separately tracks simultaneous reservations and reconciliation.

## Implemented in Phase B5

- Added immutable `SubagentContextPacket` normalization for explicit `parent_note`, `verified_fact`, `evidence_ref`, and `artifact_ref` items.
- Migrated legacy raw `context` text through the same packet path; packet limits are 16 items, 8 KiB per item, and 64 KiB aggregate UTF-8 bytes.
- Included packet content only in the untrusted child handoff, never in child history, tool permissions, scope, resources, trust, model routing, or sibling state.
- Added metadata-only packet details to B4 preflight: item IDs, kinds, bytes, item count, and aggregate bytes.
- Added typed `contextPacket` schemas to `delegate`, `delegate_batch`, and `review_batch`; packet bodies remain absent from the launch digest.

## Implemented in Phase B6.1

- Added opt-in `contextMode: "fresh" | "fork"`, defaulting to fresh and preserving the B5 fresh handoff behavior.
- Resolved fork input exclusively from `buildSessionContext().messages`; `getBranch()` state, session clones, provider summarization, and tool replay remain outside the path.
- Added immutable deterministic sanitization: user/assistant text and branch/compaction summaries survive; thinking, tool calls, tool results, images, custom messages, and empty content are dropped.
- Added shared credential redaction plus 32-message, 8 KiB/message, and 64 KiB aggregate UTF-8 caps with recent-suffix selection.
- Added metadata-only fork provenance and a combined 64 KiB B5+B6 transient handoff budget to preflight; bodies and secrets stay out of the digest.
- Kept child sessions fresh via `SessionManager.inMemory()` and left tools, scopes, resources, trust, models, scheduler, cancellation, accounting, and reviewer routing unchanged.

## Frozen in Phase B7.1

- Added one shared recovery wrapper for `delegate`, `delegate_batch`, and `review_batch` with two total attempts and same-model retry only.
- Added typed retryability at the provider/startup failure boundary; provider error messages are never parsed to decide recovery.
- Reused the exact normalized request and immutable B5/B6.1 context across attempts without re-normalization or resnapshotting.
- Delayed batch `failFast` until the logical task exhausted recovery, aggregated usage across attempts, kept terminal `observedOutputBytes` scoped to the terminal attempt, and recorded immutable attempt summaries with total observed bytes.
- Reconciled batch output capacity per attempt, admitting retries only after live ledger reservation and a typed cancellation/timeout/fail-fast stop gate; no future attempt or reservation occurs after a logical task stops, and `budget.consumed <= budget.total` remains enforced.

## W5 writer adversarial gate

- Added `packages/coding-agent/test/ice-writer-w5.test.ts` with faux-provider end-to-end coverage for delegate completion, inspect/reject/reuse/integrate, multi-file proposals, tampering, path escape, symlink replacement, patch-limit metadata, stale bases, dirty parents, verifier failure, rollback conflict, capability-denied writers, cancellation, timeout, and parent-state preservation.
- Added the opt-in `packages/coding-agent/examples/w5-writer-dogfood.ts` harness and `w5:live` package script. It accepts only `cx/gpt-5.6-luna` and `cx/deepseek/deepseek-v4-flash`, requires `W5_LIVE=1` plus a clean `W5_LIVE_ROOT`, uses disposable worktrees, and records bounded operational JSONL without prompts, fork bodies, patch bodies, credentials, or absolute checkout paths.
- Automated W5/W4 gate: `170/170` focused tests passed. Live provider certification remains pending explicit operator runs and is excluded from default tests/checks.
- W1-W5A remain frozen; W5B live-model certification remains pending as external production evidence and does not block the V1 implementation freeze after automated writer validation.
- W7.1/W7.2 durable background read-only jobs and W8.1 metadata-only `/agents`/`/subagents` durable visibility are implemented; job actions, background writers, auto-resume, steering, merge/rebase/commit/conflict resolution, and release cleanup remain deferred.

## W6 Subagent Observatory / TUI

- Status: **FROZEN**.
- Runtime `SubagentEvent` facts remain separate from bounded `SubagentProgressSnapshot` presentation state. JSON/RPC progress uses existing `tool_execution_update`; ordinary print remains unchanged.
- Focused W6/W5/W4 suites pass with `184/184` tests; `git diff --check` passes.
- Live TUI smoke verified delegation activity/current path, writer `proposal_ready`, RECENT transition, expansion/collapse/close, and identical `/agents`/`/subagents` overlays.
- Rollback lifecycle is covered by the production integration test: `rolling_back/running` followed by terminal `rollbackStatus: restored` or `conflict`.
- `npm run check` reaches only the pre-existing `packages/ai/test/openai-completions-tool-choice.test.ts:1410` TypeScript error.

## W7.1 durable asynchronous read-only job

- Status: **IMPLEMENTED / FROZEN**.
- Added one owner-scoped `SubagentJobRegistry` with append-only session snapshots, stable job/result references, bounded/redacted result projection, canonical persisted-state validation, logical terminal retention, owner-only inspect/cancel, awaited cancellation and shutdown, and restart recovery that marks stale active work `interrupted` without relaunch.
- Added `delegate_async`, `inspect_subagent_job`, and `cancel_subagent_job` as ICE-only tools. `delegate_async` captures the normalized request, trust, model/runtime, active parent tools, launch leaf, and provenance before acceptance, then reuses the existing recovery, runner, and parent verification path with an independent job signal.
- Completion delivery is metadata-only, persisted before notification, deferred while the parent is active, delivered with `triggerTurn: false` at `agent_settled`, deduplicated from persisted completion details, and suppressed during shutdown. Foreign owners cannot inspect or cancel jobs.

## W7.2 bounded durable read-only scheduling

- Status: **IMPLEMENTED / FROZEN**.
- Extended the W7.1 registry to admit up to 2 active jobs by default, cap active concurrency at 4, retain up to 8 FIFO queued jobs, and reserve planned output against a 256 KiB owner aggregate budget before durable admission.
- Added deterministic queue promotion only after terminal persistence, queue-position and budget inspection metadata, queued cancellation without runner invocation, exact reservation release, fail-closed persistence transitions, and shutdown/restore interruption for queued and active jobs without relaunch.
- Kept the foreground `delegate`, `delegate_batch`, `review_batch`, writer tools, observatory, and core session manager unchanged; no priority, steering, recursive delegation, Bash/network/writer privileges, auto-resume, result auto-ingestion, or Hivemind was added.
- Verification: durable job suite `31/31`; `ice-subagents.test.ts` `115/115`; `npm run check` reaches only the documented pre-existing `packages/ai/test/openai-completions-tool-choice.test.ts:1410` error; `git diff --check` clean.

## W8.1 durable job observatory visibility

- Status: **IMPLEMENTED / FROZEN**.
- `/agents` and `/subagents` now render owner-scoped durable jobs as separate metadata-only ACTIVE, QUEUED, and RECENT sections. The projection includes bounded identity, role/model, status, timestamps, queue position, reservation/budget counters, and stable result references; result summaries and diagnostics never enter the view.
- `SubagentJobRegistry.subscribe()` is a non-authoritative change stream. It publishes after durable admission, running/terminal transitions, restore completion, and fail-closed terminal presentation; listener failures are swallowed and cannot alter scheduling or persistence.
- The overlay remains read-only: no polling, cancel/retry/resume/steer actions, automatic result ingestion, scheduler changes, background batch facades, writers, auto-resume, or Hivemind were added.
- Verification: focused jobs/observatory suites pass `48/48`; root TypeScript/check gates reach only the documented pre-existing `packages/ai/test/openai-completions-tool-choice.test.ts:1410` `maxTokensField` error; `git diff --check` passes.

## W8.2 explicit read-only durable-result inspection

- Status: **IMPLEMENTED / FROZEN**.
- `/agents` and `/subagents` expose one configurable `app.subagents.inspect` action (`ctrl+enter`) for selected terminal BACKGROUND RECENT jobs. Enter remains metadata expand/collapse; Esc returns from detail and then closes the overlay.
- Detail rendering calls the existing owner-scoped `SubagentJobRegistry.inspect(jobId)` API once per explicit action and stores only an ephemeral frozen projection of bounded/redacted, terminal-safe summary, repo-relative evidence, findings, verification, diagnostics, and stable metadata. It preserves provider/model IDs, rejects URI/absolute evidence paths, and never sends a message, appends an entry, starts a turn, changes scheduler state, or copies results into `SubagentObservatoryStore`.
- Active, queued, and foreground rows cannot open terminal detail. Retention changes while detail is open render a bounded `Job is no longer retained` state and preserve ID-based return selection.
- Verification: focused observatory/subagent suites pass `134/134`; registry-inclusive observatory/subagent/jobs suites pass `169/169`; the frozen six-file regression surface passes `231/231`; `npx tsgo --noEmit` and `npm run check` reach only the documented pre-existing `packages/ai/test/openai-completions-tool-choice.test.ts:1410` `maxTokensField` error; `git diff --check` passes.

## W8.3 read-only persisted completion inbox

- Status: **IMPLEMENTED / FROZEN**.
- `/agents` and `/subagents` append a noninteractive `COMPLETION INBOX` section after the selectable foreground and durable sections. It is derived once per overlay open from persisted `ice-subagent-job-completion` entries intersected with current owner-scoped retained terminal metadata.
- The projector validates custom-message type, bounded job ID, retained terminal status, exact status/result-reference matches, canonical timestamps, newest-first ordering, duplicate suppression, and a 32-item cap. It ignores custom-message content completely and freezes the item/array projection.
- Inbox rows contribute no `entryKeys()`: Enter, Ctrl+Enter, Up/Down, and Esc behavior remain W8.1/W8.2 behavior. The snapshot does not refresh while open, does not inspect result bodies, and does not send messages, append entries, mutate context, or change scheduler state.
- Verification: focused observatory/subagent suites pass `139/139`; registry-inclusive observatory/subagent/jobs suites pass `174/174`; the frozen six-file regression surface passes `236/236`; `npx tsgo --noEmit` and `npm run check` reach only the documented pre-existing `packages/ai/test/openai-completions-tool-choice.test.ts:1410` `maxTokensField` error; `git diff --check` passes.

## W9 explicit unsafe host-execution escape hatch

Status: **IMPLEMENTED / CONTRACT-HARDENED / NOT A SANDBOX**.

- Extended `--sub-yolo` as an explicit ICE-only boolean flag for confirmed foreground, durable async, batch, and review delegation children.
- Startup requires explicit `--ice-mode build`, `--ice-allow-bash`, no print/JSON or other headless mode, and no `--no-approve`; interactive launches require TTYs, while explicit RPC startup is supported as session-wide authorization. Duplicate unsafe, build, Bash, and output-mode flags fail closed.
- Runtime requires the current build mode, trusted project, active parent Bash, and a post-launch recheck of mode/trust/Bash capability; interactive launches use TUI confirmation, while RPC uses the explicit startup command instead.
- Unsafe children receive only the existing scoped role tools plus host `bash`, no extensions, mutation tools, recursive delegation, MCP, or parent integration authority. Recovery retry is disabled for unsafe runs.
- `delegate_async`, `delegate_batch`, and `review_batch` now accept `--sub-yolo` after the same confirmation gate; `delegate_write` remains worktree-isolated. Unsafe Bash is available to eligible resolved read/review roles; the warning states that host filesystem, process, network, credentials, and descendant cleanup are not isolated and that cancellation is best-effort; no `--no-sandbox` mode is advertised.
- Verification: targeted `ice-subagents.test.ts` passes `138/138` and `ice-delegate-mvp.test.ts` passes `9/9`. Root `npm run check` reaches the unrelated `packages/ai/test/openai-completions-tool-choice.test.ts:1410` error.

## Milestone 10 — parent-side verification gate

- Status: **IMPLEMENTED / VERIFIED** for bounded structured read-only evidence.
- Parent-owned logical `runId` values are allocated before launch. Verified completion requires matching lineage, terminal `completed` status, and `partial === false`; parent-side evidence bounds and bounded unresolved review claims are enforced.
- `ice-subagents.test.ts` plus `ice-safe-verify.test.ts` pass `181/181`. The complete foreground delegation regression shard passes `263/263` across `ice-subagents.test.ts`, `ice-subagents-adversarial.test.ts`, `ice-safe-verify.test.ts`, `ice-writer-w5.test.ts`, `ice-subagent-jobs.test.ts`, `ice-subagent-observatory.test.ts`, and `ice-delegate-mvp.test.ts`.
- Targeted Biome and `git diff --check` pass. Root `npm run check` reaches only the inherited `packages/ai/test/openai-completions-tool-choice.test.ts:1410` `maxTokensField` TypeScript error.

## Milestone 11 — MVP integration test suite

- Status: **IMPLEMENTED** for the deterministic foreground delegate path.
- `ice-delegate-mvp.test.ts` uses the Faux provider and real `iceSubagents` factory; `9/9` scenarios pass for ICE-only registration, fresh/selected context, parent-history isolation, verified provenance, malformed/model/mode gates, unresolved review claims, foreground and durable-async timeout handling, cancellation, explicit build-only `--sub-yolo` gating, and confirmed unsafe review/batch delegation.
- Lower-level subagent, safe-verify, adversarial, jobs, observatory, and writer suites provide the inherited capability/resource/lifecycle coverage. Full end-to-end coverage of every deferred resource/artifact scenario is not claimed by this MVP file.
- `delegate_async` forwards the bounded `timeoutMs` request field, with the async timeout regression covered by the integration suite. Root `npm run check` retains only the inherited `packages/ai/test/openai-completions-tool-choice.test.ts:1410` `maxTokensField` TypeScript error; no new root TypeScript errors remain.

## V1 implementation freeze and external certification

Status: **COMPLETE / FROZEN**.

The V1 implementation freeze was satisfied by:

- implementation and focused validation pass;
- B8.1 deterministic adversarial regressions pass;
- B8.2 pinned four-target harness correctness and provider smoke pass;
- B8.3 finding-based report is present;
- W5A automated writer validation passes;
- W6 observability/TUI is frozen.

Optional post-freeze certification:

- exhaustive B8 comparative matrices;
- W5B live writer certification for external model routes.

## Still deferred after the current frozen slices

- fallback model lists;
- full-output artifact persistence;
- Hivemind coordinator/evidence board/consensus/learning runtime;
- background writers;
- execution auto-resume/relaunch;
- job-management actions/authority beyond the read-only W8.1-W8.3 observatory.

## Phase B1 verification record

The typed `delegate_batch` scheduler executes sibling tasks through `runResolved()` with default concurrency `2`, hard maximum `4`, at most `8` tasks, parent-owned reservation/reconciliation over complete JSON report bytes, observed terminal output accounting, bounded public `totalBudgetBytes`, deterministic input ordering, fail-fast, and cancellation/timeout handling. `review_batch` reuses that scheduler for typed correctness/security/tests/regressions reviewers, validates each finding's evidence independently, and returns contradictory findings without collapsing them. Chains, writers, background jobs, nested delegation, fallback/retry policy, and Hivemind remain disabled.

## Phase B2 verification record

`review_batch` resolves forced read-only reviewer tasks and executes every reviewer through `runResolvedSubagentBatch`. The atomic verifier checks reviewer finding evidence before scheduler fail-fast decisions; the typed result then preserves task and dimension order, canonicalizes verified evidence, retains contradictory findings, and leaves synthesis to the parent. Invalid reviewer evidence fails only its reviewer while valid sibling results remain available. No voting, quorum, consensus, writer, chain, background, cross-model, or Hivemind behavior is enabled.

Verification: `npm run check` passed; `ice-subagents.test.ts` and `ice-safe-verify.test.ts` passed with `85/85` tests.

## Phase B3.1 verification record

`review_batch` resolves all model assignments before invoking the unchanged bounded scheduler. Precedence is task override, dimension policy, batch default, then parent model. Model provenance records the source and resolved provider/model reference. Unavailable and ambiguous configured references fail before launch; model selection does not alter tools, scope, resources, trust, IDs, budgets, cancellation, or fail-fast behavior. No fallback, retry, voting, consensus, chain, writer, background, or Hivemind behavior is enabled.

Verification: `npm run check` passed; `ice-subagents.test.ts` and `ice-safe-verify.test.ts` passed with `89/89` tests.

## Phase B4 verification record

`runResolvedSubagentBatch()` builds one `SubagentLaunchPreflight` after all resolved task/model/resource contracts exist and before the first scheduler worker can call `runResolved()`. The preflight preserves input order, effective tools, canonical scope roots, project trust, planned output reservations, requested model references, actual provider/model assignments, and selected-resource provenance without resource bodies. Changed profile/resource hashes, denied tools, duplicate IDs, invalid batch configuration, and impossible per-task reservations fail before worker launch. `SubagentBatchResult` and `ReviewBatchResult` carry the complete typed preflight; model-visible output receives only `formatSubagentLaunchDigest()` bounded text. No provider/session execution occurs during preflight.

Verification: `npm run check` passed; `ice-subagents.test.ts` and `ice-safe-verify.test.ts` passed with `93/93` tests.

## Phase B5 verification record

Legacy `context` and explicit `contextPacket` input now normalize into one frozen packet before child execution. The child prompt receives only explicitly selected packet items under the existing untrusted handoff boundary; no parent transcript or automatic history is copied. UTF-8 byte limits, deterministic ordering, duplicate/invalid IDs, immutable input copying, sibling isolation, and metadata-only preflight exposure are covered. Packet metadata does not enter `formatSubagentLaunchDigest()` and packet content does not affect tools, scopes, resources, trust, model routing, or scheduler accounting.

Verification: `npm run check` passed; `ice-subagents.test.ts` and `ice-safe-verify.test.ts` passed with `98/98` tests.

## Phase B6.1 verification record

Fork mode resolves a single compaction-aware parent context projection, sanitizes it locally and deterministically, and injects only frozen, bounded, redacted text into the same untrusted handoff used by B5. Fresh mode retains the prior prompt path. Preflight exposes source IDs, message/byte counts, drop counters, and the combined packet/fork budget without bodies; the child remains a fresh in-memory session. No provider call, transcript clone, `getBranch()` import, permission inheritance, tool replay, fallback, retry, chain, writer, background, or Hivemind behavior is enabled.

Verification: `npm run check` passed; fork-focused tests passed; `git diff --check` passed.

## Phase B7.1 verification record

The shared recovery wrapper applies to single delegation and both batch facades. It allows one same-model retry only when the failure boundary emits an explicit retryable transient classification. The normalized request object, resolved model, selected resource hashes, trust, packet, and fork snapshot are passed through unchanged. Cancellation, timeout, policy/validation/trust/resource/auth failures, budget exhaustion, malformed or unverifiable results, and child tool failures remain terminal. A typed stop gate suppresses retries after parent cancellation, batch timeout, or sibling fail-fast before attempt-2 reservation and runner/session creation. Batch fail-fast runs after logical-task recovery. Terminal `observedOutputBytes` remains the current/terminal attempt size; recovery metadata carries per-attempt sizes and `totalObservedOutputBytes`. Batch reservations are reconciled per attempt, retries require live capacity, and preflight exposes the two-attempt policy without pre-reserving retry bytes. The B6 sibling snapshot call-count regression is covered.

Verification: B7.1 FROZEN. `npm run check` passed; `ice-subagents.test.ts` and `ice-safe-verify.test.ts` passed with `115/115` tests; Cognee redaction regression passed; `git diff --check` passed.

## Phase B8 — Read-Only Subagents v1 implementation gate

B8 is an implementation-validation gate, not a feature phase. B8.1 deterministic security/lifecycle regressions live in `packages/coding-agent/test/` and do not depend on external repositories. B8.2 comparative tooling lives under `benchmarks/read-only-subagents/`, owns the pinned manifest, target adapters, scenario catalog, CLI modes, JSONL result contract, and data-level scenario consistency check. Coding-agent tests do not import benchmark modules.

Current B8 state:

- B8.1: implemented and verified with deterministic adversarial tests; current focused V1 suites pass with `186/186` tests.
- B8.2: implemented and verified with `31/31` benchmark-side tests, benchmark `tsgo` typecheck, and provider smoke across all four pinned targets for both configured routes.
- External baselines are pinned: upstream Ice `e47b8e37a6211ebd0b2942fa87059d64f81eec02`; `nicobailon/ice-subagents` `67cf559acbb4b621b53879e2df3c8bd211c2b44b`.
- Exact local/cache checkouts resolved those SHAs without harness fetch, checkout, branch switching, dependency upgrade, or substitution.
- Real CLI adapters run stock Ice, the native example, `ice-subagents`, and `ice`; missing target commands/extensions fail closed during preparation.
- Historical `48` deterministic-row and `112` model-quality-row attempts are retained as non-certifying diagnostics because their provider-compatible execution did not produce comparable scenario evidence; they are not used to freeze V1.
- Comparative report: `benchmarks/read-only-subagents/B8.3-report.md`.
- B8.3: report present with abbreviated sanity evidence and limitations; no ICE production repair is justified by the run.
- Read-Only Subagents v1 implementation: frozen. The exhaustive comparative matrix remains optional external certification.

The inherited acceptance checks are:

1. `ice` exposes `delegate` while stock `ice` does not;
2. `ice-safe-verify` controls whether `delegate` is active in the current parent mode;
3. child history is fresh and parent history is not cloned;
4. child loader disables extensions and ambient discovery; selected Phase A resources enter only through explicit validated paths;
5. bundled roles and trusted user/project roles resolve with deterministic provenance;
6. only `read`, `grep`, `find`, and `ls` can survive the parent/role/runtime capability intersection;
7. child cannot recursively delegate and cannot load Cognee/Blackhole/guard hooks;
8. model selection uses the existing model runtime;
9. parent cancellation stops the child and reaches a terminal state;
10. timeout is reported distinctly;
11. result output is bounded and structured;
12. full child transcript is not appended to the parent session;
13. child failure cannot be normalized into successful parent evidence.

## Implementation questions to resolve during the milestone

These are intentionally deferred from research to implementation because they require concrete tests:

- exact parent/child session ID source for in-memory children;
- location/format for full child artifacts when parent output is truncated;
- reliable usage counters for hard request/token budgets;
- whether child core auto-compaction should inherit normal Ice settings or use worker-specific bounds;
- whether the subprocess backend remains worth maintaining after the native runner is benchmarked.

Resolved and no longer open for V1:

- public tool name: `delegate`;
- role representation: bundled TypeScript definitions;
- child resource policy: disable extensions, skills, prompt templates, themes, and context files;
- child handoff/result encoding: bounded JSON report with required evidence paths;
- tool-boundary scope enforcement for all four read-only tools;
- explicit trusted user/project role and selected-resource discovery: Phase A implemented;
- user context is isolated under `$ICE_AGENT_DIR/context/`, selected skills retain exact resource read roots, selected prompt bodies reach child execution, selected resources are capped before reading at 64 KiB per file and 256 KiB in aggregate, and the runner consumes one resolved launch contract without rediscovery;
- Phase B1 scheduler design is limited to sibling `runResolved()` calls, parent-owned budgets, bounded concurrency, deterministic ordering, and typed batch results.

## Deferred milestones

### Later parallel read workers

B1, B2, B3.1, B4, B5, and B6.1 are implemented. Fallback/retry policy and the remaining execution layers remain deferred.

### Hivemind coordination

Blocked until bounded parallel read workers, aggregate accounting, cancellation, and typed result/evidence semantics are stable. Hivemind is post-V1 and reuses the same subagent executor; it is not a prerequisite for `delegate`.

### Writer workers

W1 isolated worktrees, W2 immutable bounded patch artifacts, W3 parent-owned artifact verification/transactional integration, and W4 parent-owned proposal decisions are frozen as separate narrow APIs. W4 exposes stateless `inspect_writer_patch`, `reject_writer_patch`, and `integrate_writer_patch` tools; the resolver accepts only canonical `<agentDir>/artifacts/writer/<runId>/proposal.patch` artifacts, caps inspection previews at 32 KiB, and requires a configured `--ice-verify` before W3 can mutate the parent. W3 snapshots immutable verification expectations, applies only after `git apply --check`, invokes the configured verifier, revalidates postimages/status afterward, and uses compare-and-swap rollback that restores safe paths while preserving conflicts. Merge, rebase, commit, conflict resolution, automatic verifier discovery, temporary verification worktrees, and background writer jobs remain deferred. W3 provides optimistic concurrency control rather than literal atomic filesystem compare-and-swap because no OS/repository lock is held across the final check and filesystem operation.

### W3 verification record

The focused writer, safe-verification, and adversarial suites pass with `159/159` tests, including W4 provenance, preview, explicit rejection, mandatory-verifier, success, and rollback regressions. `npm run check` reaches the unrelated existing TypeScript error at `packages/ai/test/openai-completions-tool-choice.test.ts:1410`; `git diff --check` passes. W4 is implemented; W3 remains frozen at its narrow API boundary.

### Background/durable workers

Blocked until run IDs, persistence, owner-scoped cancellation, completion delivery, recovery, and retention semantics exist.

## Reference quality / provenance status

- Ice source and Ice example: directly compatible evidence.
- Oh My Ice: close fork/reference; borrow semantics, not APIs blindly.
- OpenCode: strong permission/lineage/background reference, not a workspace-isolation implementation.
- II-Agent: strong typed run/persistence model, Python-specific implementation.
- Claw Code: strong runtime control/evidence concepts, Rust-specific implementation.
- OpenHands: limited local source coverage; architecture-only reference for this pass.
- ActiveLoop Hivemind: strong shared-learning and Ice lifecycle integration reference; storage/automatic propagation semantics are not adopted wholesale.
- Ruflo Hive Mind: strong coordination/state/topology reference; nested queen hierarchies and benchmark claims are not treated as ICE requirements.

No reference code has been copied into production files during this work. The new Hivemind material is architecture documentation and independent synthesis.
