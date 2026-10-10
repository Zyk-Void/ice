# ICE Subagent Implementation Plan

> Historical (V1 subagent era, last updated before 2026-09-11). Subagents V2 replaced this plan; see `packages/coding-agent/docs/subagents-v2.md`, `Plan/subagent-rewrite.md`, and the Near-Term Roadmap in `idea.md`.

_Last updated: 2026-08-08_

## Goal

Add native subagents to ICE while preserving Ice's existing agent/session ownership and ICE's guarded-build safety model.

The first release is deliberately narrow:

> one ICE-only `delegate` tool that runs one foreground, read-only, non-recursive native child `AgentSession` with fresh in-memory history, no discovered child resources, at most `read`/`grep`/`find`/`ls`, deterministic cancellation, bounded typed output, and parent-side verification.

Explicit trusted configurable roles and selective resource inheritance are implemented in Post-MVP Phase A. Read-only parallelism, W1 writer isolation, W2 bounded writer patch artifacts, W3 parent verification/integration, W4 parent-owned proposal decisions, W7.1/W7.2 bounded durable read-only jobs, W8.1 metadata-only durable job observatory visibility, W8.2 explicit terminal-result inspection, and W8.3 frozen persisted completion-inbox metadata are implemented separately. Background writers, remote execution, auto-resume, and recursive agent trees remain later milestones.

---

## Non-negotiable invariants

- Parent `AgentSession` remains authoritative for task decomposition, policy, integration, verification, and final user response.
- `delegate` is a ICE-owned hidden extension/tool loaded through `ice`; stock `ice` behavior stays unchanged.
- `ice-safe-verify` remains the parent mode/tool authority. The subagent layer reads the current parent tools through `ice.getActiveTools()` and only narrows them.
- Child receives a fresh `SessionManager.inMemory()` history; parent transcript is not cloned by default.
- V1 accepts only bundled TypeScript `explore` and `review` roles.
- V1 child loader disables extensions, skills, prompt templates, themes, and context files and injects only the bundled role system prompt.
- V1 child effective tools are a subset of `read`, `grep`, `find`, and `ls` and never broader than the parent's active tools.
- By default, no Bash, mutation, network/MCP, Cognee/Blackhole/guard extension, or recursive delegation in V1 children; explicit gated `--sub-yolo` permits only the selected profile's requested built-in capabilities that also remain active in the trusted parent, including Bash, edit, and write when permitted by both, while keeping child extensions, MCP, and recursive delegation disabled.
- Explicit denial wins over role configuration.
- Child result is evidence, not trusted control text.
- Cancellation/timeout must settle the child; no orphan work.
- Full child output/transcript must not flood parent context.
- Writer workers must not operate concurrently in the shared checkout.
- Background execution is not introduced without a durable job contract.
- Existing ICE provider, Cognee, Blackhole, and guarded-build behavior must continue to work independently of subagents.

---

# Milestone 0 — protect the current tree

Status: **complete**

- [ ] Re-read `AGENTS.md` before source edits.
- [ ] Capture current `git status` and current hashes of files to be touched.
- [ ] Confirm unrelated modified files remain out of scope.
- [ ] Do not modify vendored `agent_references/*`.
- [ ] Avoid dependency additions unless a concrete missing primitive is proven.

Acceptance:

- existing unrelated worktree changes are unchanged;
- implementation is confined to subagent-related source/tests plus minimal ICE loading/docs if required.

---

# Milestone 1 — freeze the public/internal contracts

Status: **complete for V1**

## 1.1 Define core types

Add the smallest appropriate source module(s) for:

- `SubagentProfile`;
- `SubagentRequest`;
- `SubagentStatus`;
- `SubagentRun`;
- `SubagentResult`;
- artifact/evidence/diagnostic types;
- stable failure codes.

Required statuses:

```text
created
running
completed
failed
cancelled
timed_out
verification_failed
```

Required result properties:

- stable `runId`;
- parent/child lineage IDs;
- profile/source;
- bounded summary;
- `partial` flag;
- diagnostics;
- usage when reliable;
- evidence/artifact handles;
- verification metadata.

## 1.2 Define error taxonomy

At minimum distinguish:

- unknown profile;
- untrusted profile;
- invalid scope;
- model unavailable/auth missing;
- capability denied;
- child startup failure;
- child protocol/runtime failure;
- timeout;
- cancellation;
- output truncation;
- malformed/invalid result;
- verification failure.

Acceptance:

- no lifecycle state is inferred from free-form child text;
- terminal transitions can be implemented idempotently;
- contracts do not depend on native vs subprocess runner.

Tests:

- type/schema validation;
- invalid request rejection;
- terminal state transition unit tests.

---

# Milestone 2 — bundled V1 roles

Status: **complete**

V1 intentionally has no role/profile discovery.

## 2.1 Add bundled TypeScript roles

### `explore`

Purpose: repository discovery, architecture tracing, fact gathering, implementation localization.

Capability target:

```text
read
grep
find
ls
```

Explicitly absent:

```text
bash
edit
write
network/MCP
memory adapters
delegate
```

### `review`

Purpose: adversarial correctness/regression/security review using supplied code/diff/repository evidence.

Same capability floor as `explore`; the distinction is prompt/report contract, not higher privilege.

## 2.2 Role definition rules

Each bundled role is a static ICE-owned TypeScript object containing only reviewed fields such as:

```text
name
description
systemPrompt
defaultModel?
thinkingLevel?
tools
timeoutMs
maxOutputBytes
```

Do not allow the parent model to supply arbitrary child system prompts or permission lists.

Acceptance:

- exactly the intended bundled V1 roles resolve;
- unknown role fails before child creation;
- roles cannot grant tools outside policy;
- role definitions are deterministic and require no project trust or filesystem discovery.

Tests:

- bundled `explore` resolution;
- bundled `review` resolution;
- unknown role rejection;
- role tool list cannot widen runtime policy.

Implemented in Post-MVP Phase A:

- user roles;
- trusted project roles;
- deterministic project-over-user precedence;
- bundled-role shadow rejection;
- provenance/source hashes and execution-time revalidation;
- explicit selected skills, prompts, and context files.

Still deferred:

- project extensions;
- ambient resource loading;
- parallel workers and writer/background execution.

---

# Milestone 3 — capability/policy resolver

Status: **complete**

Implement child capability derivation as a small explicit policy function using the parent extension runtime as the source of truth:

```text
parentAllowed = ice.getActiveTools()
childEffective = parentAllowed ∩ roleAllowed ∩ runtimePolicyAllowed
```

For V1:

```text
runtimePolicyAllowed = { read, grep, find, ls }
```

## V1 rules

- `ice-safe-verify` decides the parent's current active tools; the subagent layer does not parse or duplicate plan/build policy;
- add `delegate` to the guarded-build mode tool lists where delegation should be available;
- hard child tool allowlist uses Ice's existing `createAgentSession({ tools })` / `allowedToolNames` mechanism;
- `delegate` is never in the child list;
- no write/edit/apply;
- no Bash;
- no implicit network/MCP/credential inheritance;
- scope roots normalize inside allowed repository roots;
- child cannot request a higher-privilege role dynamically.

Acceptance:

- built-in/custom tools outside the allowlist are genuinely absent from the child registry;
- if the parent does not currently have a read-only capability active, the child does not gain it;
- a role definition cannot widen capabilities;
- the subagent layer has no independent plan/build permission state.

Tests:

- parent active-tool intersection;
- tool allowlist integration test;
- child `delegate` absent;
- edit/write/Bash absent;
- invalid/outside scope rejected;
- deny precedence tests.

---

# Milestone 4 — stripped V1 child resources

Status: **complete by default; explicit Phase A resource selection implemented**

This is the native-runner safety gate, and the V1 target is now explicit rather than exploratory.

Construct the child `DefaultResourceLoader` with:

```text
noExtensions: true
noSkills: true
noPromptTemplates: true
noThemes: true
noContextFiles: true
systemPrompt: <bundled role system prompt>
```

Do not pass child `extensionFactories`. Do not inherit `ice-cognee`, `ice-safe-verify`, Blackhole extensions, user extensions, project extensions, or ambient skills, templates, themes, or repository context files. Phase A may pass only explicitly selected, hash-validated resources.

Relevant repository instructions needed by a specific task must be included deliberately in the bounded handoff packet rather than discovered implicitly.

The hard `tools` allowlist remains an independent final capability boundary even though extension/resource discovery is disabled.

Acceptance:

- child `getExtensions()` contains no loaded user/project/ICE extension hooks;
- child skills/prompts/themes/context-file collections are empty when no resources are selected; selected Phase A resources enter only through explicit validated paths;
- bundled or resolved trusted role system prompt is the intended worker prompt;
- a fixture project containing extensions, skills, prompts, themes, `AGENTS.md`, and other local resources cannot alter default child behavior; explicitly selected trusted resources are the only exception;
- tool registry still matches the explicit child allowlist.

Fallback only if these existing loader controls do not behave as documented/tested:

- reassess the native runner and benchmark the subprocess boundary while preserving the same request/result contracts.

---

# Milestone 5 — native foreground runner

Status: **implemented; normal faux-provider completion is covered**

Implement a `NativeAgentSessionRunner` or equivalent minimal module.

## Child construction

Use existing Ice infrastructure:

- `createAgentSession()` or `createAgentSessionFromServices()`;
- `SessionManager.inMemory()`;
- existing model runtime;
- explicit model/thinking choice;
- hard `tools` allowlist;
- constrained resource loader;
- child-specific session start metadata if useful.

## Context handoff

Construct a self-contained child prompt containing only:

- role objective/system instructions;
- task;
- approved scope;
- explicitly selected context/artifacts;
- output/report requirements.

Do not copy parent messages wholesale.

## Execution

- create `runId` before startup;
- transition `created -> running` only after valid child construction;
- subscribe to child events;
- call child `prompt()`;
- capture bounded final assistant result/evidence;
- dispose/settle the child on every path.

Acceptance:

- native child completes a faux-provider fixture task;
- parent session history is unchanged except for the parent-side delegation tool call/result;
- child session has independent history.

Tests:

- fresh history;
- prompt handoff contents;
- normal completion;
- model failure;
- child runtime failure;
- cleanup after failure.

---

# Milestone 6 — cancellation and timeout

Status: **implemented; race/tool-execution coverage remains**

## Parent abort

Connect the delegation tool's `AbortSignal` to the child runner.

Native behavior:

1. abort controller fires;
2. call/propagate `child.abort()`;
3. await `child.waitForIdle()`;
4. retain bounded partial output;
5. transition to `cancelled` exactly once.

## Timeout

Use a child-run timeout controller composed with the parent signal.

Timeout must produce `timed_out`, not generic `failed`.

Acceptance:

- child does not continue after parent cancellation;
- timeout settles even if the model/tool is still active;
- partial result state is preserved;
- late events cannot flip terminal state.

Tests:

- cancellation before prompt;
- cancellation during model streaming;
- cancellation during child tool execution;
- timeout;
- cancel/timeout race;
- idempotent cleanup.

---

# Milestone 7 — bounded event/progress bridge

Status: **implemented; consumer adapter coverage remains**

Define ICE subagent events without streaming the full child transcript.

Minimum events:

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

Every event carries lineage IDs.

Progress may include:

- profile;
- latest operation label;
- elapsed time;
- request/token usage when available;
- capped output tail.

Do not include unbounded raw tool results.

Acceptance:

- interactive, JSON, and RPC consumers can eventually use the same normalized event data;
- event ordering is deterministic enough for tests;
- all payloads are bounded/redacted.

Tests:

- stable IDs across events;
- terminal event exactly once;
- output-tail cap;
- sensitive/oversized diagnostic handling.

---

# Milestone 8 — result normalization and artifact boundary

Status: **bounded structured result implemented; artifact persistence deferred**

Create the final `SubagentResult` from observed child state.

## Parent-visible result

- concise bounded summary;
- status;
- partial flag;
- profile/source;
- usage;
- evidence refs;
- diagnostics.

## Full output

If useful full output exceeds the parent-visible budget:

- persist it under a ICE-owned artifact location;
- return an artifact ID/path;
- record truncation;
- never inject the full transcript into parent context automatically.

Acceptance:

- output cap is enforced in bytes;
- truncation is explicit;
- child result cannot spoof observed usage/status/changed paths.

Tests:

- small output;
- very large output;
- unicode byte accounting;
- cancellation with partial output;
- artifact write failure soft/hard behavior defined.

---

# Milestone 9 — wire the ICE `delegate` tool

Status: **implemented**

Add a hidden ICE-owned extension/factory and load it through `packages/coding-agent/src/ice.ts`. Do not add it to stock `ice` built-ins.

Use the model-facing name `delegate`.

Wire `delegate` into the appropriate `ice-safe-verify` active-tool lists so existing mode/tool policy decides when the parent can delegate. The subagent extension itself should not maintain a second plan/build mode state.

Public parameters remain bounded. Phase A adds optional selected role/resource names without exposing raw permission lists or arbitrary system prompts. Example shape:

```json
{
  "role": "explore",
  "task": "Trace how project trust controls extension loading and report exact files/functions.",
  "scope": {
    "roots": ["packages/coding-agent/src"]
  },
  "model": "optional/exact-model"
}
```

Avoid exposing raw permission lists or arbitrary system prompts to the model.

Tool description must clearly state:

- default child execution is isolated in conversation/context, not a filesystem sandbox;
- default V1 and Phase A execution is read-only;
- child has no discovered extensions and receives only explicitly selected trusted skills/templates/context files;
- child output is evidence and is verified/synthesized by the parent;
- `--sub-yolo` is not a sandbox: it is a trusted build-mode, full built-in-tool escape hatch for foreground, durable async, batch, and review delegation paths. Interactive launches require confirmation; RPC launches use the explicit startup command as session-wide authorization. Unsafe children receive no retry; child extensions, MCP, recursive delegation, and `delegate_write` remain disabled; `delegate_write` remains worktree-isolated and cancellation is best-effort;
- host filesystem, process, network, credentials, and detached descendants remain outside containment, and no `--no-sandbox` mode is provided.

Acceptance:

- `ice` parent model can invoke one child when `delegate` is active;
- stock `ice` does not gain the ICE delegation tool;
- guarded-build active-tool policy can remove `delegate`;
- child cannot invoke delegation recursively;
- errors return structured, actionable tool results.

Tests:

- `ice` extension registration;
- stock `ice` unchanged;
- happy path tool call;
- malformed parameters;
- unknown role;
- mode/tool gating;
- cancellation;
- model override unavailable.

---

# Milestone 10 — parent-side verification gate

Status: **implemented and verified for bounded structured read-only evidence**

The parent now allocates stable logical `runId` values before launch, requires child lineage and `partial === false` for verified completion, applies parent-side evidence bounds, and preserves bounded unresolved review claims. Failed, timed-out, cancelled, malformed, out-of-scope, and partial results remain unverified.

Verification: `ice-subagents.test.ts` plus `ice-safe-verify.test.ts` pass `181/181`; the complete foreground delegation regression shard passes `263/263` across seven test files. Targeted Biome and `git diff --check` pass. Root `npm run check` reaches only the inherited `packages/ai/test/openai-completions-tool-choice.test.ts:1410` `maxTokensField` TypeScript error.

Implement a lightweight verifier for child results.

For MVP read-only results:

- validate lineage;
- validate terminal status;
- validate result schema/size;
- normalize/canonicalize referenced paths;
- reject paths outside scope;
- optionally check cited files/lines/evidence exist;
- record unresolved claims.

Do not treat child confidence or prose as proof.

Integrate with guarded-build semantics so a worker cannot implicitly authorize mutation or transition modes.

Acceptance:

- failed/timed-out/cancelled result cannot be represented as verified success;
- invalid paths/evidence are surfaced;
- parent remains responsible for final synthesis.

---

# Milestone 11 — MVP integration test suite

Status: **implemented for the deterministic foreground delegate path**

`ice-delegate-mvp.test.ts` uses the Faux provider and the real `iceSubagents` factory. Its `9/9` scenarios cover ICE-only registration, fresh/selected context and parent-history isolation, verified completion/provenance, malformed/unknown-role/unavailable-model/inactive-parent gates, unresolved review claims, foreground and durable-async timeout handling, cancellation, explicit build-only `--sub-yolo` gating, and confirmed unsafe review/batch delegation. The inherited focused delegation shard passes `261/261`.

The remaining checklist items are covered by the lower-level subagent, safe-verify, adversarial, jobs, observatory, and writer suites where applicable; full end-to-end coverage of every deferred resource/artifact scenario is not claimed here. Root `npm run check` retains only the inherited `packages/ai/test/openai-completions-tool-choice.test.ts:1410` `maxTokensField` TypeScript error.

Create a deterministic faux-provider/fixture suite covering the complete path.

Canonical W1-W11 executable acceptance evidence is recorded in `findings.md` section 21. Current focused evidence is C1 `263/263`, C2 `181/181`, C3 `9/9`; W5B remains pending external provider certification.

Current acceptance mapping:

- Covered by M11 integration: ICE-only registration, guarded active-tool gating, fresh/selected context, parent-history isolation, normal completion, malformed/unknown role/model/mode gates, cancellation, foreground and durable-async timeouts, unsafe-mode gating, and confirmed unsafe review/batch delegation.
- Covered by lower-level suites: stripped extensions/skills/prompts/themes/context discovery, Cognee/Blackhole/safe-verify exclusion, read-only tool intersection, recursive delegation denial, trusted user/project roles and resources, TOCTOU revalidation, lineage/events, output bounds, and writer boundaries.
- Superseded by Phase A: “only bundled V1 roles resolve”; trusted user/project role resolution is implemented with provenance and source-hash revalidation.
- Explicitly deferred: full-output artifact persistence and every end-to-end resource/artifact scenario not covered by the lower-level suites.
- Existing ICE core tests remain a separate repository gate; no M11 claim overrides unrelated failures.

MVP exit criteria:

- M11 integration and lower-level regression tests pass;
- targeted coding-agent typecheck/lint gates pass apart from recorded unrelated diagnostics;
- no unrelated diff churn;
- minimality review finds no unnecessary architecture.

---

# Milestone 12 — native vs subprocess benchmark/decision

Status: **COMPLETE / VERIFIED / FROZEN**; the repaired harness records real resource-loader and CLI contract vectors, startup metrics, honest end-RSS availability, memory summaries, and maintenance rationale. Canonical full-budget runs are cold `99f421f8-228b-4137-a44e-092895359713` (30), warm `d6222038-23e7-4ca9-a8ce-1770dc96db37` (5 warmups + 100 measured), safety `67457e73-cd91-452b-b0a0-154ebf94a369` (50), and compatibility `430338fe-ddb8-45f6-a0ee-fdaaee129df9` (3); all reports have `hardGate: true` and decide `native-only`.

Only after the native MVP works, compare against Ice's subprocess implementation.

Execution boundary: deterministic benchmark fixtures only; native and subprocess adapters must share the same fixture/event/result contract. The subprocess adapter is benchmark-only until M12 selects and M13 freezes a production policy. W5B live-provider certification remains separate and pending.

Evaluate:

- startup latency;
- memory;
- cancellation reliability;
- crash containment;
- event/result complexity;
- resource-loader safety;
- CLI compatibility;
- maintenance burden.

Decision options:

1. native only;
2. native default + subprocess isolation backend;
3. subprocess only if native resource isolation proves unsafe.

Do not maintain two backends without a concrete reason.

M12 exit record: the four canonical manifests and reports are schema-v2, record elapsed/startup/end-RSS, cancellation, cleanup, and real compatibility gates, and all hard gates pass. The native-only decision is frozen for this benchmark evidence; subprocess remains benchmark/isolation evidence without automatic fallback.

---

# Milestone 13 — execution backend policy freeze and rollback gate

Status: **COMPLETE / VERIFIED / FROZEN**; the production native-only policy remains implemented, and the final verifier consumed exactly the four canonical M12 runs plus observed C1/C2/C3 results.

M13 freezes one backend policy source of truth, preserves Ice as the sole authoritative loop, verifies event/result/resource/CLI/cancellation parity, exercises decision-specific rollback without state migration, and records acceptance artifacts. `m13:verify` now requires exactly one full-budget cold performance, warm performance, safety, and compatibility run, then executes C1/C2/C3 and records observed counts, exit codes, Git SHA, and dirty-worktree qualification. It must not add automatic backend routing, a planner, a second provider layer, autonomous execution, or W5B status changes.

M13 exit checks:

- exactly one M12 decision is encoded;
- native remains default unless M12 proves otherwise;
- invalid backend selection fails closed and no error silently switches backend;
- C1/C2/C3 are executed by M13 and their observed pass/total counts and exit codes are recorded;
- targeted Biome and `git diff --check` pass;
- root `npm run check` has only the inherited `maxTokensField` diagnostic;
- W5B remains explicitly pending unless external evidence arrives.
- Canonical artifact: `.artifacts/m13/m13-1786296433961/`; acceptance is schema-v2 with `dirty: true`, current HEAD provenance, and observed C1 `263/263`, C2 `181/181`, C3 `9/9`.

---

# Post-MVP Phase A — explicit trusted configurability

Status: **implemented for roles and selected read-only resources**

Implemented as two independently gated capabilities:

- trusted user role definitions with deterministic provenance;
- project role definitions only behind existing project trust;
- deterministic project-over-user precedence with bundled-role shadow rejection;
- role/resource source hashes revalidated immediately before execution;
- explicit selected skills, prompt templates, and context files only;
- extensions remain excluded;
- `delegate`, mutation tools, credential expansion, and executable project hooks remain independently policy-gated;
- stripped-resource mode remains the safe fallback/default for read-only workers.

Do not re-enable all normal parent resources merely for convenience. Parallel workers remain Post-MVP Phase B.

---

# Post-MVP Phase B — bounded parallel read workers

Status: **implemented and verified — B1 parallel read fanout only**

B1 scope:

- typed hidden `delegate_batch` tool;
- up to 8 sibling read-only tasks;
- default concurrency `2`, hard maximum `4`;
- parent-owned reservation ledger over complete JSON report bytes, with bounded public `totalBudgetBytes`;
- each task resolves once and executes through `runResolved()`;
- deterministic input-order results and batch/run lifecycle IDs;
- parent cancellation and batch timeout stop queued work and abort active children;
- no chains, writers, background jobs, nested delegation, or Hivemind.

Prerequisites already satisfied:

- stable run/result/events;
- correct cancellation;
- usage accounting;
- deterministic single-child behavior.

B1 exit checks:

- concurrency cap and reservation-before-launch are enforced;
- unused reservations release and observed terminal report bytes reconcile without clamping overruns;
- sibling failures preserve settled results;
- cancellation/timeout handle active and queued tasks;
- `concurrency: 1` matches sequential atomic delegation semantics;
- selected resource/tool/scope isolation remains unchanged.

# Phase B2 — typed parallel reviewer orchestration

Status: **implemented and verified**

B2 scope:

- typed hidden `review_batch` facade over `delegate_batch`/`runResolved()`;
- review dimensions `correctness`, `security`, `tests`, and `regressions`;
- forced read-only `review` role with independent scopes and fresh sessions;
- structured findings with bounded evidence references;
- deterministic input-order reviewer results;
- contradiction preservation with no deduplication, voting, quorum, or consensus;
- reviewer verification remains separate from parent synthesis.

B2 exit checks:

- all reviewers execute through the existing bounded scheduler;
- findings retain reviewer and dimension identity;
- invalid finding evidence fails only that reviewer and preserves other results;
- contradictory findings remain separate in the typed result;
- parent remains the only synthesizer;
- chains, writers, background jobs, cross-model policy, launch preflight, context packets, sanitization, and Hivemind remain deferred.

Do not use parallel fan-out for tightly sequential tasks by default.

# Phase B3.1 — deterministic cross-model reviewer routing

Status: **implemented and verified**

B3.1 scope:

- typed `ReviewerModelPolicy` with batch default and per-dimension overrides;
- deterministic precedence `task.model > byDimension > default > parent`;
- complete model assignment and validation before scheduler launch;
- typed task/dimension/default/parent model provenance;
- model selection changes only compute; tools, scope, resources, trust, IDs, budgets, and lifecycle remain unchanged;
- no fallback, retries, voting, consensus, chains, writers, background jobs, or Hivemind.

B3.1 exit checks:

- unavailable and ambiguous configured model references reject before any child starts;
- mixed-model reviewers preserve deterministic input order and aggregate accounting;
- one model/runtime failure remains an isolated sibling result;
- cancellation and fail-fast behavior remain scheduler-owned and unchanged.

Verification: `npm run check` passed; focused subagent and safe-verify suites passed with `89/89` tests. No fallback, retry, voting, consensus, chain, writer, background, or Hivemind behavior was added.

# Phase B4 — launch preflight and digest

Status: **implemented and verified**

B4 scope:

- one typed parent-owned `SubagentLaunchPreflight` for `delegate_batch` and `review_batch`;
- preflight generated after resolved tasks, model assignments, resource resolution, and before scheduler `pump()`;
- existing profile/resource hash checks, effective read-tool derivation, task-ID checks, concurrency validation, timeout validation, and budget configuration reused rather than reimplemented;
- requested model references remain separate from resolved actual compute models;
- complete preflight stays in typed tool details; `formatSubagentLaunchDigest()` injects only a bounded summary into parent context;
- resource names plus source/hash/path provenance are represented without resource bodies;
- no provider calls, session creation, fallback, retries, voting, consensus, chains, writers, background jobs, or Hivemind.

B4 exit checks:

- invalid task, changed profile/resource, denied effective tools, and impossible per-task reservations reject before worker one;
- preflight task order and resolved models match scheduler input and runner assignments;
- preflight `reservedOutputBytes` is the planned sum of per-task output caps, while the live scheduler ledger separately tracks simultaneous reservations and reconciliation;
- digest is byte-bounded and truncation leaves typed details unchanged;
- subagent and reviewer batch results expose the same base preflight contract.

Verification: `npm run check` passed; focused subagent and safe-verify suites passed with `93/93` tests. `git diff --check` passed.

# Phase B5 — selective context packets

Status: **implemented and verified**

B5 scope:

- normalize legacy `context` text and typed `contextPacket` input through one immutable packet contract;
- cap packets at 16 items, 8 KiB per item, and 64 KiB aggregate UTF-8 bytes;
- preserve fresh child history and pass only explicitly selected packet items as untrusted handoff data;
- expose packet item IDs/kinds/bytes and aggregate bytes in typed preflight, never packet bodies in the digest;
- keep packet data independent from tools, scopes, resources, trust, model routing, budgets, cancellation, and sibling state;
- no transcript fork, fallback, retries, chains, writers, background jobs, or Hivemind.

B5 acceptance targets:

- zero packet preserves current prompt/history behavior;
- ordering, duplicate IDs, per-item/aggregate UTF-8 limits, immutable resolution, and batch preflight rejection are tested;
- packet metadata reaches preflight while packet bodies stay out of the digest;
- packet content does not widen effective tools, scope, resources, or trust and sibling packets remain isolated.

Verification: `npm run check` passed; focused subagent and safe-verify suites passed with `98/98` tests. `git diff --check` passed.

# Phase B6.1 — sanitized fork snapshots

Status: **implemented and verified**

B6.1 scope:

- add opt-in `contextMode: "fresh" | "fork"`, defaulting to `fresh`;
- resolve fork input only from the parent `buildSessionContext().messages` projection, never `getBranch()` or a session clone;
- retain only user text, assistant text, compaction summaries, and branch summaries;
- drop thinking, tool calls, tool results, images, custom messages, and empty content;
- redact common credentials with a shared utility, then enforce 32 messages, 8 KiB per message, and 64 KiB aggregate UTF-8 limits using a deterministic recent suffix;
- freeze the sanitized snapshot and inject it, followed by B5 packet content, as untrusted handoff data into a fresh `SessionManager.inMemory()` child;
- expose fork source/size/drop metadata and the combined B5+B6 64 KiB transient budget in B4 preflight, without bodies or secrets in the digest;
- keep tools, scope, resources, trust, model routing, scheduling, cancellation, fail-fast, output accounting, and reviewer routing unchanged; no fallback, retries, chains, writers, background jobs, or Hivemind.

B6.1 exit checks:

- fresh-mode prompt behavior remains unchanged;
- fork source, allowlist, summaries, drops, credential redaction, UTF-8 caps, suffix ordering, immutability, fresh child history, sibling isolation, and prompt ordering are tested;
- combined packet/fork budget rejects before the scheduler starts; preflight exposes metadata only;
- no provider call or model summarization occurs during fork normalization.

Verification: `npm run check` passed; focused fork, packet, child-session, subagent, and safe-verify tests passed; `git diff --check` passed.

# Phase B7.1 — bounded transient failure recovery

Status: **FROZEN**

B7.1 scope:

- applies uniformly to `delegate`, `delegate_batch`, and `review_batch` through one recovery wrapper;
- allows exactly two attempts: the initial attempt plus at most one retry;
- retries only failures marked retryable by typed provider/startup classification at the failure boundary;
- reuses the exact normalized request, effective tools, resolved model, selected resources and hashes, trust, B5 packet, and B6.1 fork snapshot;
- never retries cancellation, timeout, verification or malformed results, validation/policy/scope/trust/resource/auth failures, budget exhaustion, or child tool failures;
- keeps `failFast` at logical-task granularity, after retry exhaustion rather than after a recoverable first attempt;
- aggregates usage across attempts, keeps terminal `observedOutputBytes` scoped to the terminal attempt, and records immutable per-attempt bytes plus recovery totals;
- reserves and reconciles output capacity per attempt in the parent ledger, suppressing retries when the next cap cannot be admitted or a typed cancellation/timeout/fail-fast stop gate is active, before any second reservation or runner/session creation, and keeping `budget.consumed <= budget.total`;
- adds B4 recovery-policy metadata and max-potential output without treating retry capacity as live-reserved;
- adds no fallback model, re-normalization, resnapshot, chain, writer, background, or Hivemind behavior.

B7.1 exit checks:

- typed transient provider stream failures retry once; message text alone never enables retry;
- terminal typed failures and untyped failures do not retry;
- single-child, batch, and reviewer paths share the same-model recovery behavior;
- batch fail-fast waits for a logical task's recovery result;
- immutable request identity and context are reused across attempts;
- attempt statuses/failure codes, per-attempt bytes, terminal bytes, aggregate usage, and total observed bytes remain available on the terminal result;
- retries are admitted only after per-attempt ledger reconciliation and a typed stop-state check; preflight reports the retry policy without live-reserving retry bytes;
- parent cancellation, batch timeout, and sibling fail-fast each suppress the second runner/session invocation and reservation;
- two forked siblings call the parent `buildSessionContext()` exactly once.

Verification: B7.1 FROZEN. `npm run check` passed; `ice-subagents.test.ts` and `ice-safe-verify.test.ts` passed with `115/115` tests; Cognee redaction regression passed; `git diff --check` passed.

---

# Phase B8 — Read-Only Subagents v1 benchmark and adversarial-hardening implementation gate

Status: **implementation gate complete — B8.1 PASS, B8.2 harness/provider-smoke PASS, B8.3 report present; exhaustive comparison optional**

B8 is an implementation-validation gate, not a feature phase. B7.1 remains FROZEN and must not be reopened unless benchmark evidence exposes a concrete defect.

## B8.1 deterministic adversarial suite

- deterministic security and lifecycle regressions live in `packages/coding-agent/test/`;
- tests use the existing faux-provider and temporary-fixture seams;
- no external repository is required;
- stable scenario IDs align with `benchmarks/read-only-subagents/scenarios.json` through a benchmark-side data check;
- every concrete benchmark defect must receive a regression before repair;
- no fallback models, roles, writers, background jobs, steering, persistent memory, Hivemind, or production orchestration primitives are added.

Initial attack coverage includes symlink replacement and scope escape, resource mutation before launch, UTF-8 fork boundaries, credential variants, provider startup and partial-output failures, cancellation and timeout between attempts, concurrent retry-budget contention, invalid evidence in valid JSON, oversized evidence arrays, and context that impersonates system policy.

Verification: `ice-subagents-adversarial.test.ts`, `ice-subagents.test.ts`, and `ice-safe-verify.test.ts` pass with `128/128` tests.

## B8.2 comparative benchmark harness

- versioned inputs live under `benchmarks/read-only-subagents/`;
- `manifest.json` pins immutable external commits and uses `CURRENT_WORKSPACE` for ICE;
- unresolved external baselines remain explicitly unavailable and never use guessed SHAs;
- target preparation may inspect an existing checkout/cache only when its `HEAD` exactly matches the manifest SHA;
- preparation never fetches, switches branches, upgrades dependencies, rewrites target configuration, or substitutes a newer revision;
- adapters normalize target observations without importing benchmark modules into coding-agent tests;
- `--target ice`, `--matrix`, `--scenario`, and `--repeat` are explicit CLI modes;
- deterministic scenarios reject repeated runs; model-quality scenarios may repeat;
- JSONL artifacts record schema version, run ID, implementation, resolved commit, scenario, repetition, timing, result, verification, attempts, output bytes, usage, and cost without raw prompts, transcripts, credentials, or absolute checkout paths;
- `results/*` is ignored and created on demand.

Verification: benchmark-side Node tests pass with `31/31`; `npx tsgo --noEmit -p benchmarks/read-only-subagents/tsconfig.json` passes. ICE-only mode writes a redacted result with resolved commit provenance. Provider smoke passes across all four pinned targets for both configured routes. The exhaustive 48 deterministic / 112 model-quality matrix remains optional external certification evidence.

## B8.3 findings and hardening

- pinned upstream Ice at `e47b8e37a6211ebd0b2942fa87059d64f81eec02` and `nicobailon/ice-subagents` at `67cf559acbb4b621b53879e2df3c8bd211c2b44b`;
- resolved exact local/cache checkouts without harness fetch, checkout, branch switching, dependency upgrade, or substitution;
- implemented real CLI adapters: stock Ice through `ice`, the native example through `ice --extension`, `ice-subagents` through its extension entry point on the pinned Ice host, and ICE through `ice`;
- ran deterministic infrastructure/security scenarios separately from repeated model-quality scoring;
- recorded the abbreviated provider-compatible sanity comparison and its limitations in `benchmarks/read-only-subagents/B8.3-report.md`;
- no production change is justified unless a B8 finding reproduces a concrete defect, with its regression added first;
- the report records that the exhaustive comparative matrix is optional certification evidence and does not block the implementation freeze.

B8 implementation validation is complete. W5B live writer runs and the exhaustive B8 matrix remain unclaimed external certification evidence; Read-Only Subagents v1 implementation is frozen.

# Post-MVP Phase C — Hivemind coordination

Hivemind is a higher-level consumer of the stable subagent executor, not a replacement worker runtime. Detailed architecture lives under `docs/hivemind/`.

Prerequisites:

- single-child `delegate` lifecycle/result/verification contract is stable;
- bounded parallel read workers are stable;
- aggregate usage/cancellation can be measured correctly;
- parent remains the sole authority for decomposition, mode, permissions, mutation approval, and final verification.

Initial Hivemind shape:

```text
Parent Ice AgentSession = logical queen
  -> explicit HiveRequest
      -> HivemindCoordinator
          -> sibling SubagentRuns via the same internal executor as `delegate`
          -> run-scoped typed EvidenceBoard
          -> bounded aggregate result
  -> parent verifies/synthesizes
```

Rules:

- star topology first; no nested queens or direct child-to-child delegation;
- explicit parent-supplied tasks initially; no separate planning model;
- same role/capability intersection as ordinary `delegate` workers;
- default low concurrency inherited from parallel-read policy;
- hive-level task, worker, wall-time, output, request/token/cost budgets;
- settled partial results survive independent worker failures;
- advisory consensus cannot widen permissions or override deterministic verification;
- prefer `evidence_quorum` over plain voting for consequential recommendations;
- do not claim Byzantine fault tolerance unless a real distributed fault model and identity/transport assumptions are implemented and tested;
- initial workers receive no direct Hivemind/Cognee durable-memory tools;
- durable learning is separate: redacted/distilled knowledge remains candidate-only until verification/promotion policy accepts it.

Acceptance before Hivemind leaves experimental status:

- one worker is not routed through a hive when normal `delegate` is sufficient;
- cancellation stops new scheduling and aborts every active child;
- duplicate results cannot count twice toward consensus;
- contradictory evidence remains visible;
- verifier failure overrides worker agreement;
- aggregate output/context remains bounded;
- Hivemind can be disabled without changing `delegate` behavior.

---

# Post-MVP Phase D — chain mode

Add only when result boundaries are proven.

Rules:

- next child receives a bounded previous result/artifact summary;
- never inject previous raw transcript;
- each step has its own run ID and terminal state;
- chain stops or explicitly continues according to typed failure policy;
- aggregate usage/result remains bounded.

---

# W1 — isolated writer foundation

Status: **implemented, verified, and frozen**

W1 adds a separate build-only `delegate_write` primitive. It requires a Git parent worktree with empty `git status --porcelain=v1 -uall`, a full local 40-character SHA equal to current `HEAD`, and one foreground detached temporary worktree. The writer child receives only scoped `read`, `grep`, `find`, `ls`, `write`, and `edit`; Bash, network, MCP, extensions, Git metadata, delegation, retries, background jobs, and parent integration remain disabled. The temporary worktree is removed on success, failure, cancellation, and timeout. W1 intentionally discards edits because patch capture belongs to W2 and deterministic parent verification/integration belongs to W3.

W1 exit checks:

- clean, staged, tracked, untracked, ignored, malformed-SHA, unknown-commit, historical-commit, and non-HEAD preconditions are tested;
- new-file, edit, `..`, absolute, symlink, new-under-symlink, and lexical/canonical `.git` confinement is tested;
- parent content/status remains unchanged after success and failure paths;
- cleanup is verified for success, failure, cancellation, and timeout.

---

# W2 — bounded writer patch artifacts

Status: **implemented, verified, and frozen**

W2 adds a trusted parent-side collector after a `completed` writer prompt and before temporary worktree cleanup. It derives the inventory from actual `git status --porcelain=v1 -z -uall`, not writer prose or only `git diff HEAD`, then reads raw `HEAD:path` and writer-worktree bytes, hashes those exact bytes, and builds an isolated `git diff --no-index` patch with external diff and textconv disabled. Proposal construction does not run `git add`, update an index, commit, or write Git objects; untracked files are included without mutating either worktree or repository object storage.

Contract:

```ts
interface WriterPatchArtifact {
  schemaVersion: 1;
  runId: string;
  baseCommit: string;
  changedFileCount: number;
  patchBytes: number;
  patchSha256: string;
  patchRef: string;
  files: Array<{
    path: string;
    change: "add" | "modify" | "delete";
    beforeSha256?: string;
    afterSha256?: string;
  }>;
}
```

W2 policy:

- only `completed` writers can produce a patch artifact; failed, cancelled, and timed-out writers produce none;
- changed files are repo-relative, scope-checked, and limited to 32 entries;
- regular UTF-8 text additions and modifications are supported;
- deletions, renames, copies, ignored paths, symlinks, gitlinks, binary data, unsupported statuses, and scope escapes are rejected;
- patch bytes are measured from the actual patch and capped at 512 KiB;
- patch files are written outside both worktrees with exclusive creation and read-only permissions;
- the parent worktree, parent index, writer worktree, and Git metadata remain unmodified.

W2 exit checks:

- untracked additions are present in the patch and file inventory;
- before/after hashes and actual byte counts are recorded from the same bytes used in the patch;
- object-store isolation, CRLF patch/hash consistency, and clean-filter non-execution are regression-tested;
- failed, cancelled, timed-out, binary, delete, and oversized proposals are rejected without an eligible artifact;
- cleanup still removes the temporary worktree after collection.

Verification: focused writer and safe-verify suites pass with `132/132` tests; `npm run check` reaches the repository TypeScript gate with one pre-existing unrelated error at `packages/ai/test/openai-completions-tool-choice.test.ts:1410`; `git diff --check` passes.

---

# W3 — parent verification and integration

Status: **implemented and frozen**

W3 adds one parent-owned `integrateWriterPatchArtifact()` entry point for W2 artifacts. It snapshots and deeply freezes the validated artifact expectations before any transaction work, revalidates immutable patch bytes and SHA-256 digest, exact `git apply --numstat -z -p1` file inventory, approved scope, current `HEAD == baseCommit`, and clean parent worktree/index before checking every preimage hash. It then runs only `git apply --check -p1` followed by plain `git apply -p1`, validates postimages before and after a required caller-owned parent verifier, rejects unexpected non-ignored parent status, and uses compare-and-swap rollback: exact proposed bytes and modes are restored only while the post-apply state still matches; safe paths are restored even when another path conflicts, and conflicts raise `rollback_conflict` without overwriting newer or non-regular replacements. It never uses fuzzy apply, three-way merge, reject files, rebasing, commits, index updates, child tests, or conflict resolution. W3 v1 does not add a tool, automatic verifier discovery, merge policy, temporary verification worktrees, or retry loop.

W3 provides optimistic concurrency control, not literal atomic filesystem compare-and-swap: without OS/repository locking, an external writer can still race the final comparison and filesystem operation.

W3 exit checks:

- successful add integration retains the parent change and invokes the parent verifier;
- tampered digest, mismatched inventory, checked-apply conflict, and dirty-parent preconditions reject before mutation;
- verifier mutation cannot return `applied`; immutable expectations remain authoritative; safe files roll back when another touched file conflicts; unrelated non-ignored changes survive rollback;
- focused writer, safe-verify, and adversarial suites pass with `156/156` tests; `npm run check` reaches the existing unrelated TypeScript error at `packages/ai/test/openai-completions-tool-choice.test.ts:1410`; `git diff --check` passes;
- W3 is frozen at this narrow API boundary.

---

# W4 — parent-owned writer proposal workflow

Status: **implemented, verified, and frozen**

W4 wires the frozen W1/W2/W3 writer APIs into the real parent-facing workflow through three stateless build tools. `inspect_writer_patch` validates the complete W2 artifact, requires canonical equality between `patchRef` and `<agentDir>/artifacts/writer/<runId>/proposal.patch`, rejects symlink/non-regular paths, rechecks exact bytes/hash/schema/inventory, and returns complete metadata with a 32 KiB capped preview. `reject_writer_patch` is an explicit non-mutating decision; it does not delete, consume, or tombstone the immutable artifact. `integrate_writer_patch` requires a trusted project and configured `--ice-verify` before calling `integrateWriterPatchArtifact()`; the verifier callback uses the existing bounded `runVerifier()` seam. Parent review and integration remain explicit, never automatic after `delegate_write`.

W4 exit checks:

- inspect, reject, and integrate are registered as separate tools and active only in build mode;
- valid-hash artifacts outside the production path and symlinked expected paths are rejected;
- missing verifier fails before W3 mutation; configured success integrates; verifier failure reports `verification_failed` and rolls back;
- rejection leaves the parent and reusable artifact unchanged;
- focused writer, safe-verify, and adversarial suites pass with `159/159` tests;
- `npm run check` passes all repository gates through the existing unrelated TypeScript error at `packages/ai/test/openai-completions-tool-choice.test.ts:1410`; `git diff --check` passes.

---

# W5 — adversarial writer hardening and explicit dogfooding

Status: **W5A automated/adversarial PASS / FROZEN; W5B live harness READY; live certification PENDING external environment**

W5 drives the complete production sequence `delegate_write -> inspect_writer_patch -> reject_writer_patch | integrate_writer_patch -> verifier -> parent result` without changing W1-W4 authority. Automated tests use only the existing faux provider and temporary Git fixtures. Coverage includes successful faux writer completion, multi-file integration, repeated rejection/reuse, tampered artifacts, path escape, symlink replacement, patch-limit metadata, stale bases, dirty parents, verifier failure, rollback conflict, capability-denied writers, cancellation, timeout, and parent-state preservation.

The explicit live harness is `packages/coding-agent/examples/w5-writer-dogfood.ts`, exposed as `npm --workspace @zykairotis/ice-coding-agent run w5:live -- <route>`. It refuses to run unless `W5_LIVE=1`, requires a clean `W5_LIVE_ROOT`, accepts only `cx/gpt-5.6-luna` or `cx/deepseek/deepseek-v4-flash`, uses disposable Git worktrees, and writes bounded JSONL operational records without prompts, fork bodies, patch bodies, credentials, or absolute checkout paths. Live results are certification evidence and are not part of `npm test`, `npm run check`, or the automated W5 gate.

W5 verification:

- `ice-writer-w5.test.ts`, `ice-subagents.test.ts`, `ice-subagents-adversarial.test.ts`, and `ice-safe-verify.test.ts` pass with `170/170` tests;
- W5A automated/adversarial layer is PASS / FROZEN;
- W5B live harness is READY; `cx/gpt-5.6-luna` and `cx/deepseek/deepseek-v4-flash` remain optional external production-certification evidence and are not claimed until both representative runs complete in an available environment;
- W6 Subagent Observatory/TUI is implemented and frozen; W5B remains optional external production-certification evidence;
- durable decisions/jobs, parallel writers, merge/rebase/commit/conflict-resolution semantics, and release cleanup remain deferred.

---

# W6 — Subagent Observatory / TUI

Status: **FROZEN**

W6 keeps runtime `SubagentEvent` facts separate from bounded presentation `SubagentProgressSnapshot` state. A reducer/sanitizer emits snapshots through existing `onUpdate()` for `tool_execution_update` transport and feeds an extension-owned capped store. Interactive TUI renderers use existing `renderCall`/`renderResult` and `/agents` plus `/subagents` use one read-only `ctx.ui.custom()` overlay. JSON/RPC receive typed progress updates; ordinary print remains unchanged. No core AgentSession bus, persistent sidebar, overlay actions, or W1-W5 semantic changes are allowed.

Freeze gate:

- live updates work for single, batch, review, and writer tools;
- writer proposal, inspection, rejection, integration, verifier, rollback, and conflict phases are visible;
- active/recent `/agents` and `/subagents` views support navigation, expansion/collapse, and close only;
- reducer, renderer, transport, command, redaction, bound, and update-permutation tests pass;
- dropping, duplicating, or reordering observability updates cannot change execution or integration outcomes;
- focused W6/W5/W4 suites pass with `184/184` tests and `npm run check` reaches only the documented pre-existing `packages/ai/test/openai-completions-tool-choice.test.ts:1410` failure;
- live TUI smoke verified delegation activity/current path, proposal-ready writer activity, RECENT transition, expansion/collapse/close, and identical `/agents`/`/subagents` overlays;
- live writer integration certification remains pending as external W5B production evidence and does not block the V1 implementation freeze after automated writer validation;
- W7.1 one-owner durable asynchronous read-only jobs, W7.2 bounded multi-job durable read-only scheduling, and W8.1 metadata-only durable job observatory visibility are implemented and frozen as bounded V2 slices; job actions, background batch facades, writers, auto-resume, steering, and Hivemind remain deferred.

---

# W7.1 — one-owner durable asynchronous read-only job

Status: **IMPLEMENTED / FROZEN**

W7.1 adds exactly one durable asynchronous read-only job per Ice session owner. `delegate_async` captures the normalized request and launch provenance before acceptance, persists an append-only created snapshot, and returns acceptance metadata without awaiting the child. The detached worker reuses the frozen model/trust/resource resolution, bounded recovery, native runner, and parent verification path with an independent job-owned cancellation signal.

The extension-owned `SubagentJobRegistry` persists bounded/redacted state through session custom entries, enforces one active owner job, validates canonical terminal snapshots, retains at most 32 terminal jobs, supports owner-only inspection/cancellation, awaits cancellation and shutdown settlement, and restores stale active snapshots as `interrupted` without relaunch. Completion messages contain only job metadata, are emitted after terminal persistence, are deferred until `agent_settled`, use `triggerTurn: false`, and are deduplicated from persisted `custom_message` details.

The three tools are `delegate_async`, `inspect_subagent_job`, and `cancel_subagent_job`. The foreground `delegate`, batch/review tools, observatory, and core session manager remain unchanged. Queues, multiple jobs, parallel/background batches, budgets across jobs, priorities/fairness, background writers, auto-resume/relaunch, automatic result ingestion, active-job TUI management, steering, recursive delegation, network/Bash expansion, and Hivemind remain **NOT YET IMPLEMENTED**.

Exit verification:

- `ice-subagent-jobs.test.ts`: `16/16`;
- integration plus safe-verify/subagent suite: `172/172`;
- frozen W7/W6/W5/W4/adversarial suite: `202/202`;
- `npx tsgo --noEmit` and `npm run check` report only the documented pre-existing `packages/ai/test/openai-completions-tool-choice.test.ts:1410` `maxTokensField` error;
- `git diff --check` passes.

# W7.2 — bounded multi-job durable read-only scheduling

Status: **IMPLEMENTED / FROZEN**

W7.2 extends the W7.1 owner-scoped durable job registry without changing the foreground runner or adding a second scheduler. The registry admits up to 2 active jobs by default, caps active concurrency at 4, retains up to 8 FIFO queued jobs, and reserves planned output against a 256 KiB owner aggregate budget before durable admission. It persists queued state before acceptance, promotes only after terminal persistence, exposes queue position and budget metadata, cancels queued jobs without invoking their closures, releases each reservation exactly once, and fails closed on persistence transitions. Shutdown and restore mark both queued and active jobs `interrupted` without relaunch.

The slice excludes priority, steering, recursive delegation, Bash/network/writer privileges, background batch facades, auto-resume, automatic result ingestion, job actions, and Hivemind. Verification is `ice-subagent-jobs.test.ts` `31/31`, `ice-subagents.test.ts` `115/115`, and `ice-safe-verify.test.ts` included in the `189/189` focused run; root `npm run check` reaches only the documented pre-existing `maxTokensField` diagnostic.

# W8.1 — durable job observatory visibility

Status: **IMPLEMENTED / FROZEN**

W8.1 adds metadata-only owner-scoped durable job sections to the existing read-only `/agents` and `/subagents` overlays. `SubagentJobRegistry.subscribe()` is a non-authoritative change stream published after durable admission, running/terminal transitions, restore completion, and fail-closed terminal presentation. The overlay projects bounded identity, role/model, status, timestamps, queue position, reservation/budget counters, and stable result references without result summaries or diagnostics. It uses no polling and adds no cancel, retry, resume, steer, result-ingestion, scheduler, background batch, writer, auto-resume, or Hivemind behavior.

Verification:

- `ice-subagent-jobs.test.ts` and `ice-subagent-observatory.test.ts`: `48/48`;
- `npx tsgo --noEmit` and `npm run check` reach only the documented pre-existing `packages/ai/test/openai-completions-tool-choice.test.ts:1410` `maxTokensField` error;
- `git diff --check` passes.

# W8.2 — explicit read-only durable-result inspection

Status: **IMPLEMENTED / FROZEN**

W8.2 adds exactly one UI capability to the existing read-only `/agents` and `/subagents` overlays: an explicit configurable `app.subagents.inspect` action (`ctrl+enter`) for terminal BACKGROUND RECENT rows. Enter remains expand/collapse and Esc returns from detail before closing the overlay. Detail mode calls the current owner-scoped `SubagentJobRegistry.inspect(jobId)` API once per explicit action and renders only an ephemeral frozen projection of the already bounded durable result envelope: terminal-safe/redacted summary, repo-relative evidence, findings, verification, diagnostics, and stable metadata. Active, queued, and foreground rows cannot open result detail; provider/model IDs remain intact and URI/absolute evidence paths are rejected.

Inspection is UI-only. It does not call `sendMessage`, `appendEntry`, or any agent/model turn; it does not mutate `SubagentObservatoryStore`, scheduler state, parent context, or result ingestion. If retention removes the selected job while detail is open, the view shows a bounded no-longer-retained state and restores selection by job ID when returning.

Verification:

- focused `ice-subagent-observatory.test.ts` and `ice-subagents.test.ts`: `134/134`; registry-inclusive `ice-subagent-jobs.test.ts`, `ice-subagent-observatory.test.ts`, and `ice-subagents.test.ts`: `169/169`;
- final frozen six-file regression surface: `231/231`;
- `npx tsgo --noEmit` and `npm run check` reach only the documented pre-existing `packages/ai/test/openai-completions-tool-choice.test.ts:1410` `maxTokensField` error;
- `git diff --check` passes.

# W8.3 — read-only persisted completion-inbox metadata

Status: **IMPLEMENTED / FROZEN**

W8.3 adds one noninteractive `COMPLETION INBOX` section to the existing `/agents` and `/subagents` overlays. At each overlay open, it reads the current session entries once and intersects exact persisted `JOB_COMPLETION_MESSAGE_TYPE` metadata with the current owner-scoped retained terminal job projection. The projector validates bounded job IDs, terminal status, exact status/result-reference matches, canonical timestamps, newest-first ordering, duplicate suppression, and a maximum of 32 frozen items. Message `content` is never parsed or rendered.

Inbox rows contain only job ID, terminal status, role/model, optional finished/notified timestamps, and the authoritative result reference. They are appended after all selectable rows and contribute zero `entryKeys()`, so Enter, Ctrl+Enter, Up/Down, and Esc retain their W8.1/W8.2 behavior. The snapshot remains unchanged while the overlay is open; reopening reconstructs it from persisted metadata. No registry inspection, result-body read, message send, entry append, polling, live session subscription, context mutation, scheduler change, cancellation, queue control, result ingestion, or persistent inbox state was added.

Verification:

- focused `ice-subagent-observatory.test.ts` and `ice-subagents.test.ts`: `139/139`;
- registry-inclusive `ice-subagent-jobs.test.ts`, `ice-subagent-observatory.test.ts`, and `ice-subagents.test.ts`: `174/174`;
- frozen six-file regression surface: `236/236`;
- `npx tsgo --noEmit` and `npm run check` reach only the documented pre-existing `packages/ai/test/openai-completions-tool-choice.test.ts:1410` `maxTokensField` error;
- `git diff --check` passes.

# V1 implementation freeze and external certification

Status: **COMPLETE / FROZEN**.

The V1 implementation freeze was satisfied by implementation correctness, focused validation, B8.1 deterministic adversarial regressions, B8.2 pinned four-target harness correctness and provider smoke, the present B8.3 finding-based report, W5A automated writer validation, and frozen W6 observability/TUI.

The exhaustive B8 comparative matrices and W5B live writer runs are optional post-freeze external certification evidence. They remain explicitly unclaimed until their runs complete; they do not become implementation requirements because of provider latency or endpoint availability.

W7.1/W7.2 durable background read-only jobs and bounded parallel scheduling, plus W8.1-W8.3 observability slices, are implemented V2 work and are not part of the narrow V1 definition. Hivemind, autonomous mode, unrestricted subagent Bash, background writers, execution auto-resume/relaunch, result ingestion, steering/priority, and management authority remain deferred.

---

# Post-MVP Phase F — background writers and durable-job follow-ons

W7.1/W7.2 already provide the durable read-only job foundation:

- stable job/run identity;
- owner/session identity;
- persisted lifecycle status;
- metadata-only completion notification;
- owner-scoped cancellation;
- restart recovery by interrupting stale nonterminal work without relaunch;
- terminal retention;
- bounded active concurrency, FIFO queueing, reservations, and deterministic promotion.

Remaining Phase F follow-ons are separate slices:

- execution resume/auto-resume, if ever justified;
- bounded logs/artifacts beyond the current result envelope;
- richer management/task-tree UI beyond the current read-only observatory;
- background writers.

Do not add `background: true` to the foreground runner. Follow-on work must not add priority, steering, auto-resume, writers, or Hivemind without a separate bounded slice.

References:

- OpenCode background job model;
- Oh My Ice async job/registry lifecycle;
- II-Agent persistent run state;
- Claw Code worker health registry.

---

# Post-MVP Phase G — optional memory integration

Cognee remains off for child automatic memory by default. Hivemind learning follows the separate promotion model in `docs/hivemind/memory-learning.md` rather than turning the shared run board into permanent memory.

If durable learning is enabled later:

- capture structured hive/subagent outcomes with redaction and provenance;
- distill knowledge/skill candidates after the run rather than injecting raw transcripts;
- keep unverified output candidate-only until verifier/repeated-success/user policy promotes it;
- make recall parent-selected initially and pass only bounded relevant entries in child handoffs;
- scope durable knowledge by repository/user before organization-wide propagation;
- support invalidation/revalidation when source state changes;
- allow `ice-cognee` or another store only through a backend-neutral adapter contract;
- scope any later child recall/write by hive/run/profile/session and parent capability;
- retrieved memory remains untrusted;
- never share credentials through handoff;
- keep parent, child, Hivemind run-board, and durable-memory state logically separable.

---

# Files likely to be touched during MVP

This is a planning estimate, not a mandate.

Likely new area:

```text
packages/coding-agent/src/subagents/*
```

Likely integration points:

```text
packages/coding-agent/src/ice.ts
packages/coding-agent/src/ice-safe-verify.ts  # expose/gate `delegate` through existing mode tool policy
packages/coding-agent/src/index.ts            # only if public exports are required
packages/coding-agent/test/*                  # dedicated subagent tests
```

Potentially relevant existing internals to reuse, not rewrite:

```text
packages/coding-agent/src/core/sdk.ts
packages/coding-agent/src/core/agent-session.ts
packages/coding-agent/src/core/agent-session-services.ts
packages/coding-agent/src/core/session-manager.ts
packages/coding-agent/src/core/resource-loader.ts / resource loading modules
packages/coding-agent/src/core/model-runtime.ts
packages/coding-agent/src/core/extensions/*
```

Do not alter Ice core abstractions unless a test proves the subagent layer cannot be implemented cleanly through existing APIs.

---

# Reference map during implementation

Use references for ideas/contracts, not direct code copying.

## Ice

- `packages/coding-agent/examples/extensions/subagent/index.ts`
- `packages/coding-agent/examples/extensions/subagent/agents.ts`
- `packages/coding-agent/examples/extensions/subagent/README.md`

## Oh My Ice

- task types/executor/discovery/parallel/worktree;
- async job manager and agent registry for later background phase.

## OpenCode

- task parent/child linkage;
- permission derivation;
- nested delegation denial;
- background lifecycle.

## II-Agent

- typed run/event state;
- cancellation/parent linkage;
- persistent status model.

## Claw Code

- task validation;
- worker lifecycle/health;
- deny-first permissions;
- evidence/report schema.

## ActiveLoop Hivemind

- Ice lifecycle integration for capture/recall;
- structured trace/session summarization;
- reusable skill-learning pipeline;
- shared-memory concepts, adapted behind ICE verification/promotion policy.

## Ruflo Hive Mind

- explicit hive topology and worker membership;
- typed shared state and consensus proposals;
- bounded multi-worker coordination;
- use Hivemind only when a single native subagent is insufficient;
- do not copy nested queen hierarchies or treat model voting as deterministic verification.

See `docs/hivemind/references.md` for source-level notes and adaptation boundaries.

---

# Stop conditions

Pause implementation and reassess architecture if any of these become true:

- native child `ResourceLoader` cannot be constrained without invasive Ice core changes;
- Ice's `tools` allowlist can be bypassed by an extension/custom tool path;
- child cancellation cannot guarantee settlement;
- parent and child histories cannot be separated cleanly;
- required session identity cannot be represented without breaking existing session semantics;
- MVP requires worktree/background infrastructure merely to support a read-only worker;
- implementation begins duplicating Ice's model/session/tool runtime instead of composing with it.

In those cases, prefer the subprocess backend or a smaller seam rather than expanding the core architecture prematurely.

---

# Cognee contract repair (2026-08-12)

Status: **implemented 2026-08-13** (items 1–4, 5 except split circuits, project datasets, Blackhole minimal tail). Report: `agent_docs/ice-cognee-compaction-benchmark-2026-08-13.md`.

Full findings: `agent_docs/ice-cognee-findings-2026-08-12.md`. Summary: `findings.md` §22.

Highest-value Cognee work, in order. Do not start with dead env keys, jsonl rotation, or doctor latency.

1. Keep recall transient (system-prompt append or equivalent; no durable `custom_message`). **done**
2. Change `auto` so Cognee never owns the Ice compact summary; rewrite `own` to summarize `messagesToSummarize` if the mode stays. **done**
3. Feed the just-written compact summary into the next recall without waiting for Cognee. **done**
4. Wait for in-flight capture before idle improve; stamp cooldown on completion. **done**
5. Set `lastRecallKey` only after a successful recall, with TTL; split recall/write circuits if still coupled. **done (TTL + success-only; circuits still shared)**
6. Then hygiene: env keys, jsonl/warmup caps, bash exclusion, doctor latency. **bash substring dropped; rest deferred**

See `findings.md` §22.

---

# Definition of done for the first release

A `ice` session can call `delegate` to run one bundled `explore` or `review` worker. The worker is a fresh native in-memory `AgentSession` whose extensions, skills, prompt templates, themes, and context-file discovery are disabled; whose effective tools are only the intersection of the parent's active tools with `read`/`grep`/`find`/`ls`; and which cannot recursively delegate, mutate, use Bash, or inherit Cognee/Blackhole/guard hooks. It respects parent cancellation and timeout, returns a typed bounded result with stable lineage/evidence, and the parent verifies and integrates that result without importing the child's transcript or authority. Stock `ice` remains unchanged.
