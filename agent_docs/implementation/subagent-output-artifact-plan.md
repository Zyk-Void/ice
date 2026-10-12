# Managed Subagent Output Artifacts and Admission Redesign

- Status: implemented and verified in the current worktree; follow-up evidence is recorded in `subagent-output-artifact-plan-audit.md`
- Revised: 2026-09-24
- Target worktree: `/home/mewtwo/Zks/ice/.worktrees/all-worktrees-experimental`
- Primary package: `packages/coding-agent`
- Scope: `delegate`, `delegate_async`, `delegate_batch`, `review_batch`, `delegate_write`, their result/inspection surfaces, durable job persistence, Observatory/RPC projections, settings/profile inputs, and tests
- Architecture authority: the implemented subagent output contract in `idea.md`, `CONTEXT.md`, and ADR `docs/adr/0001-managed-subagent-output-artifacts.md`
- Related implemented lifecycle: `agent_docs/implementation/subagent-background-checkin-plan.md`
- Change class: intentionally breaking for new managed-subagent launch/configuration inputs; historical durable records remain inspectable
- Implementation: source, regression tests, operator docs, and final verification are complete; no commit was created
- Verification: 26 targeted test files / 581 tests pass; active npm `12.0.2`; `npm run check` passes; `git diff --check` passes

## 1. Objective and success state

Separate **child execution**, **final-answer retention**, **parent-facing presentation**, and **verification** into independent contracts.

A child must not be aborted, rejected at admission, or classified as failed merely because its final assistant answer is larger than a caller-selected output budget. Managed launch calls must return handles after bounded preflight/admission, while final answers are materialized later into:

1. a small fixed host-owned inline projection;
2. an owner-scoped opaque artifact reference when the complete answer does not fit inline;
3. bounded, explicit reads of that artifact; and
4. verification state that independently records whether the retained bytes were complete enough to verify.

The finished implementation must satisfy all of the following:

- No managed child lifetime deadline is reintroduced.
- Final-answer size is not a child execution stop condition.
- Batch/review admission does not reserve caller-declared output bytes.
- Durable job admission does not reserve planned output bytes.
- New managed launch schemas do not expose a synchronous `background: false` path.
- The canonical result contract contains bounded `output.text` and never exposes a local artifact path as retrieval authority.
- Artifact IDs are opaque and distinct from `runId`, `jobId`, `batchId`, and writer patch IDs.
- Artifact reads are owner-scoped, pathless, chunk-bounded, UTF-8 safe, and integrity checked.
- Fixed host storage/read/presentation ceilings remain, but they are storage/presentation safeguards rather than execution/admission budgets.
- A child can finish successfully while output materialization or verification fails; those facts remain distinguishable.
- Structured-report parsing remains bounded. Retaining raw bytes does not make a malformed or parser-oversized report verified.
- Process-local managed runs remain process-local. Durable jobs remain inspectable after restart, and interrupted jobs are never replayed automatically.
- Existing trust, scope, capability, model-routing, startup, provider/tool/hook, queue, concurrency, explicit cancellation, writer isolation, and shutdown controls remain authoritative.

## 2. Authority, supersession, and non-goals

### 2.1 Narrow supersession of the completed background/check-in plan

The completed background/check-in work remains authoritative for:

- owner-scoped managed handles;
- advisory parent check-ins;
- no child lifetime deadline;
- process-local managed-run semantics;
- durable `delegate_async` ownership and restart interruption;
- bounded startup/provider/tool/hook operations;
- explicit stop/cancellation/shutdown;
- deterministic batch ordering and bounded concurrency;
- writer preflight/isolation/cleanup;
- Observatory/RPC lifecycle projection.

This plan **only supersedes** earlier statements that treated child final-answer byte limits, batch aggregate output reservations, or durable-job planned-output reservations as operational execution/admission safeguards.

That narrow conflict is visible in the prior plan's safety-bound language. The new approved direction in `idea.md:23-27` explicitly removes caller aggregate output budgets, byte-reservation admission, and output-size-triggered termination while retaining independent safeguards.

### 2.2 In scope

- New final-answer/output contract.
- Private output artifact storage.
- Owner-scoped artifact lookup and read tool.
- Fixed inline/read/storage/retention limits.
- Removal of child final-answer `maxOutputBytes` execution semantics.
- Removal of batch/review `totalBudgetBytes` and `SubagentBatchBudgetLedger`.
- Removal of durable-job `plannedOutputBytes` / `reservedOutputBytes` / aggregate output reservation.
- Removal of synchronous `background: false` launch branches.
- Durable-state normalization for old output-budget fields.
- Result, inspection, TUI/Observatory, RPC/settings, docs, and changelog updates.
- Tests proving security, lifecycle, migration, and non-regression behavior.

### 2.3 Explicit non-goals

- Do not store or expose raw child transcripts or tool-call streams as output artifacts.
- Do not make process-local children restart-resumable.
- Do not replay interrupted durable jobs.
- Do not add recursive delegation, a second model loop, or a general artifact browser.
- Do not make artifact IDs bearer-only capabilities; owner identity remains mandatory.
- Do not let the model provide filesystem paths for artifact reads.
- Do not remove command-hook output capture bounds. `IceSubagentHookDefinition.maxOutputBytes` is a separate host-command I/O safety bound and remains in scope only for naming/documentation disambiguation.
- Do not remove provider token limits, model output-token limits, request deadlines, startup deadlines, hook timeouts, tool-specific limits, context limits, queue/concurrency limits, or management `waitMs`.
- Do not merge writer patch artifacts with textual subagent output artifacts; they have different authority and lifecycle semantics.
- Do not treat artifact persistence as verification.
- Do not add a compatibility shim that silently honors removed new-request fields.

## 3. Terminology and state model

Use `CONTEXT.md` terms consistently:

- **Background child**: delegated work continues after launch returns; no restart survival promise.
- **Durable job**: owner-associated persisted job metadata/result state; no replay promise.
- **Progress**: bounded observation while work runs; distinct from final answer and verification.
- **Final answer**: child-authored terminal assistant response, distinct from transcript/tool history.
- **Output artifact**: retained sanitized copy of a final answer that cannot be represented completely inline.
- **Inline result**: bounded parent/model-facing projection containing text and metadata, optionally pointing to an output artifact.

Add one implementation term:

- **Output materialization state**: whether the terminal final answer is fully represented inline, fully retained in an artifact, retained only partially because of the per-artifact cap, or unavailable because capture failed.

Execution status, output materialization, verification, progress freshness, and check-in delivery are independent dimensions.

## 4. Baseline evidence at plan inception

The table below records the source state this plan was written against. It is historical baseline evidence, not a statement of current implementation status; use `subagent-output-artifact-plan-audit.md` for the post-implementation closure record.

| Area | Baseline evidence | Consequence |
|---|---|---|
| Approved direction | `idea.md:23-27` says managed output is being separated from execution, caller aggregate byte budgets/reservations and output-size termination are planned for removal, and large final answers move to `output.text` + owner-bound artifact retrieval. | Treat this as the product contract, not an experiment. |
| Core delegation invariants | `idea.md:323-341` keeps parent policy authoritative, child result typed/bounded evidence, parent verification authoritative, no lifetime deadlines, bounded concurrency, process-local managed runs, and durable async ownership. | Output redesign must not weaken authority/lifecycle guarantees. |
| Current artifact limits | `packages/coding-agent/src/ice-subagents.ts:704-707` defines 512 KiB artifact capture and 8 KiB inline summary constants. | Reuse these as the starting fixed per-artifact/inline limits rather than caller budgets. |
| Current public artifact shape | `packages/coding-agent/src/ice-subagents.ts:722-731` exposes `id`, absolute `path`, bytes/hash/type/truncation and currently uses the run identity as artifact identity. | Replace with a pathless v2 public descriptor and a separate internal descriptor. |
| Current artifact writer | `packages/coding-agent/src/ice-subagents.ts:5601-5674` redacts, bounds, uses a private root, checks symlink components, opens with exclusive/no-follow semantics where supported, hashes stored bytes, and returns an artifact descriptor. | Extract/reuse the hardened filesystem primitives; do not reimplement storage casually. |
| Spill is tied to caller output limit | `packages/coding-agent/src/ice-subagents.ts:8596-8626` only spills when text exceeds `normalized.maxOutputBytes` and diagnostics expose the local path. | Decouple capture from caller limits and remove path-bearing diagnostics. |
| Output limit aborts child | `packages/coding-agent/test/ice-subagents.test.ts:6865-6901` proves current streaming behavior aborts after output exceeds the cap and returns `output_truncated`. | Replace this test with the inverse: large final output must not abort a child. |
| Structured report artifact | `packages/coding-agent/test/ice-subagents.test.ts:6431-6455` preserves an oversized structured final report but still binds serialized result size to `normalized.maxOutputBytes`. | Split fixed parser/result-presentation limits from child execution. |
| Current artifact tests read paths directly | `packages/coding-agent/test/ice-subagents.test.ts:6458-6495` reads `artifact.path` to inspect the spill. | New tests must go through the owner-scoped artifact store/read contract. |
| Batch public budget | `packages/coding-agent/src/ice-subagents.ts:11269-11277` and `:11306-11314` expose `totalBudgetBytes` on batch/review tools. | Remove schema, types, tool descriptions, preflight budget projections, and tests. |
| Batch budget implementation | `packages/coding-agent/src/ice-subagents.ts:10162-10186` resolves total budget; `:10223-10247` reserves task output; `SubagentBatchBudgetLedger` begins at `:10397`. | Delete byte reservation/consumption logic while retaining scheduler ordering/concurrency/fail-fast. |
| Batch result contract | `packages/coding-agent/src/ice-subagents.ts:1332-1399` includes preflight budget and aggregate result `budget` fields. | Remove output-budget projections instead of repurposing them as storage quota. |
| Managed launch opt-out | `packages/coding-agent/src/ice-subagents.ts:11152-11163` exposes `background` on `delegate`; `:11232-11247`, `:11269-11277`, and `:11306-11314` do likewise for writer/batch/review. | Remove the field and dead synchronous branches after handle-only tests are in place. |
| Delegate guidance | `packages/coding-agent/src/ice-subagents.ts:14653-14659` still documents `background: false`. | Update tool guidance in the same change as schema removal. |
| Durable output reservation | `packages/coding-agent/src/ice-subagent-jobs.ts:21-34` defines owner/default output budgets; create/admission around `:1215-1294` reserves planned bytes; settle releases reservations at `:1565-1583`. | Remove output-byte admission while keeping queue/concurrency permits and persistence. |
| Durable artifact validation | `packages/coding-agent/src/ice-subagent-jobs.ts:498-550` validates v1 path-bearing artifacts and deletes them on retention expiry. | Preserve safe cleanup behavior, but move new path knowledge into the internal store. |
| Durable restart behavior | `packages/coding-agent/src/ice-subagent-jobs.ts:1363-1437` restores owner records, marks nonterminal work interrupted, and never relaunches it. | Rehydrate only terminal artifact references; never restart model work. |
| Durable retention cleanup | `packages/coding-agent/src/ice-subagent-jobs.ts:1714-1735` deletes retained report artifacts when full terminal results expire. | New registry/store release must be invoked at the same ownership transition. |
| Current historical path hardening | `packages/coding-agent/test/ice-subagent-jobs.test.ts:1493-1575` rejects restored artifact paths outside/mismatched with the configured root. | Legacy v1 descriptors can remain readable as historical metadata only; never expose their path through the new API. |
| Current retention cleanup test | `packages/coding-agent/test/ice-subagent-jobs.test.ts:884-910` proves expired durable results delete their spill files. | Preserve this property with v2 refs and store accounting. |
| Observatory exposes reservations | `packages/coding-agent/test/ice-subagent-observatory.test.ts:85-107` models planned/reserved/owner budget bytes. | Replace those fields with scheduling/concurrency plus output materialization metadata where useful. |
| RPC exposes output authority setting | `packages/coding-agent/test/rpc-settings.test.ts:341-350` expects `ice.subagents.defaults.maxOutputBytes`. | Remove the setting from new configuration/RPC settings surfaces. |
| Settings/profile controls are broad | `packages/coding-agent/src/ice-subagent-settings.ts` contains defaults, role defaults, restrictions, and resolved `maxOutputBytes`; `packages/coding-agent/src/ice-subagents.ts:2357-2362` accepts profile frontmatter aliases. | Remove final-answer budget knobs deliberately; retain unrelated hook-output bounds. |
| Docs expose the old knob | `packages/coding-agent/docs/settings.md:322` and `packages/coding-agent/docs/subagent-user-guide.md:32,72,122` document `maxOutputBytes`. | Documentation migration is part of done, not a follow-up. |

### Reference-harness evidence policy

The current worktree does not expose the previously cited `Agent_harness_references/` directory through the available repository view. Do not make new implementation claims from an unavailable corpus. The previously recorded harness comparisons may remain background rationale, but this implementation plan is grounded in the current ICE code and accepted ADR. Re-verify any external-harness claim only if the corpus becomes available.

## 5. Constraints and invariants

### 5.1 Execution invariant

Final-answer byte length never aborts a live child and never prevents launch/admission.

The runtime may still terminate or reject for independent reasons such as:

- invalid/trust/scope/capability/model/resource preflight;
- explicit parent/user cancellation;
- session/process shutdown;
- startup deadline;
- provider/tool/hook-specific failure/deadline;
- queue/concurrency admission;
- writer isolation/preflight failure;
- fail-fast caused by a sibling's actual terminal/verification failure.

### 5.2 Output invariant

Only a **terminal assistant final answer** is eligible for an output artifact.

Do not promote:

- raw transcript history;
- tool-call output streams;
- check-in snapshots;
- progress messages;
- arbitrary intermediate assistant deltas;
- a partially streamed message from a provider failure as though it were a complete final answer.

Partial-runtime evidence remains available through bounded diagnostics and `workArtifact`/Observatory surfaces.

### 5.3 Verification invariant

Artifact availability is not verification.

A result may have:

- execution complete + artifact complete + verification complete;
- execution complete + artifact complete + structured protocol invalid;
- execution complete + artifact truncated/unavailable + verification incomplete;
- execution failed + bounded observed work evidence.

When complete bytes are required for verification and are unavailable, the terminal result must be unverified/verification-failed according to existing result semantics. Never map this to `timed_out` or execution `failed` merely because of byte size.

### 5.4 Ownership invariant

An artifact ID is never sufficient on its own. Every lookup is checked against the current owner session identity.

Cross-owner and unknown IDs must be indistinguishable to the caller, e.g. `artifact_not_found`, to avoid enumeration.

### 5.5 Path invariant

Public/model-facing contracts never contain the artifact filesystem path.

Only the internal artifact store may derive/open a path from a validated opaque artifact ID and configured private root.

### 5.6 Lifecycle invariant

- Process-local run/batch/review/writer artifacts live only as long as their owning retained result lifecycle and are released on deletion/eviction/shutdown.
- Durable job artifacts may survive restart only because a retained terminal durable result references them.
- Restored nonterminal jobs become interrupted and do not receive an artifact unless a terminal artifact had already been safely persisted.
- Artifact presence never makes a model session resumable.

### 5.7 Storage invariant

Storage quotas are enforced at **capture time using actual bounded stored bytes**, not reserved before model work.

No artifact-storage quota may become a child launch/admission budget.

### 5.8 Security invariant

Continue current redaction and filesystem hardening:

- sanitize credential-like text before storage and inline projection;
- private root/run directories;
- no caller paths;
- validate IDs;
- no symlink traversal;
- canonical-root containment;
- regular-file checks;
- exclusive creation;
- bounded file size;
- hash stored sanitized bytes;
- revalidate filesystem object and hash before read;
- bounded error messages with no secret/path leakage.

## 6. Target public result contract

### 6.1 New pathless artifact descriptor

New results use a v2 public descriptor. Suggested exact shape:

```ts
export interface SubagentOutputArtifactRef {
  schemaVersion: 2;
  id: string; // opaque random UUID; never runId/jobId/batchId
  storedBytes: number; // sanitized bytes physically retained
  originalBytes: number; // UTF-8 bytes in the observed final assistant answer before redaction/cap
  sha256: string; // hash of the stored sanitized bytes
  contentType: "text/plain" | "application/json";
  truncated: boolean; // true only when per-artifact cap cut the sanitized final answer
}
```

There is deliberately no `path`.

### 6.2 New output projection

Suggested exact shape:

```ts
export type SubagentOutputCaptureStatus =
  | "inline_complete"
  | "artifact_complete"
  | "artifact_truncated"
  | "artifact_unavailable";

export interface SubagentOutput {
  text: string; // sanitized, fixed-size inline projection
  textBytes: number;
  originalBytes: number;
  inlineTruncated: boolean;
  captureStatus: SubagentOutputCaptureStatus;
  artifact?: SubagentOutputArtifactRef;
}
```

Rules:

- `output` is present only when a terminal assistant final answer was observed.
- Preflight/startup/cancel-before-answer results may omit `output`.
- `output.text` is always sanitized and bounded by the host inline limit.
- `inline_complete` means `output.text` contains the whole sanitized final answer; no artifact is required.
- `artifact_complete` means inline is truncated but the complete sanitized final answer is retained.
- `artifact_truncated` means an artifact exists but the per-artifact cap cut it.
- `artifact_unavailable` means the final answer exceeded inline capacity but capture could not safely retain the bounded artifact.
- `summary` remains a bounded semantic/status field for existing UI/result semantics. It must no longer be the authority for full final-answer retention.
- Parsed structured fields (`findings`, `payload`, requirement claims/states, evidence) remain separate from raw final-answer output.

### 6.3 Aggregate projection rule

Canonical retained child results may each contain up to the fixed per-result inline projection, but batch/review **presentation** should not automatically inject 8 × full inline projections into one parent turn.

Use a fixed host aggregate presentation cap:

- canonical child inline limit: **8 KiB**;
- aggregate batch/review tool-response inline text cap: **16 KiB total** across children;
- preserve item order;
- when aggregate presentation clipping is required, keep each item's artifact reference/materialization metadata intact;
- clipping an aggregate presentation does not alter the retained canonical child result or its verification.

This is a presentation cap, not `totalBudgetBytes` and not an admission ledger.

## 7. Fixed host-owned limits

Freeze the first implementation at these constants unless tests demonstrate a concrete repository/runtime reason to change them before merge:

| Limit | Initial value | Purpose |
|---|---:|---|
| Per-result inline final-answer projection | 8 KiB | Parent/model context protection |
| Aggregate batch/review inline presentation | 16 KiB | Prevent one inspection/result turn from injecting all child text |
| Per-artifact stored bytes | 512 KiB | Bound a single retained final answer; preserves current artifact ceiling |
| Default artifact read chunk | 16 KiB | Conservative retrieval/context size |
| Maximum artifact read chunk | 64 KiB | Hard per-tool-call retrieval bound |
| Per-owner retained output bytes | 16 MiB | Bound actual retained subagent final-answer storage |
| Global subagent output artifact root | 128 MiB | Bound local disk growth across owners/sessions |
| Durable full-result retention | existing 32 records | Preserve current durable retention behavior |
| Process-local retained terminal result limits | existing bounded registries | Do not expand existing retained-run/batch/writer capacities |

Important distinctions:

- These are **not caller configurable**.
- The per-owner/global quotas account successful stored bytes only.
- There is no launch-time storage reservation.
- If storage cannot accept an artifact, child execution still finishes; output materialization records `artifact_unavailable` and verification reacts accordingly.
- The 512 KiB cap may intentionally produce `artifact_truncated`. That is explicit incomplete retention, never “full output”.
- Command-hook `maxOutputBytes` remains a separate command-capture limit and is not replaced by these values.

## 8. Internal artifact-store design

Create a focused module instead of leaving storage, public contract, durable validation, and path operations split between the 600k-line `ice-subagents.ts` and `ice-subagent-jobs.ts`.

Recommended file:

- `packages/coding-agent/src/ice-subagent-output-artifacts.ts`

Recommended responsibilities:

### 8.1 Public vs internal descriptor separation

Public:

- `SubagentOutputArtifactRef` only.

Internal:

```ts
interface OwnedSubagentOutputArtifact {
  ownerSessionId: string;
  runId?: string;
  jobId?: string;
  artifact: SubagentOutputArtifactRef;
  absolutePath: string;
  lifecycle: "process_local" | "durable";
}
```

Never serialize `absolutePath` into model-facing results, RPC result payloads, completion messages, or durable public envelopes.

### 8.2 Artifact identity and layout

- Generate a new random UUID for every artifact.
- Do not reuse `runId` as artifact ID.
- Recommended internal path: `<artifactRoot>/<artifactId>/output.txt` or `output.json`.
- Artifact ID regex/UUID validation occurs before any path derivation.
- Extension derives from trusted content type, never caller input.

### 8.3 Capture pipeline

After a terminal final assistant message is available:

1. Obtain the final assistant text only.
2. Record pre-sanitization UTF-8 byte length as `originalBytes`.
3. Apply existing credential redaction.
4. Build 8 KiB UTF-8-safe `output.text`.
5. If sanitized answer fits inline, return `inline_complete` and do not create an artifact.
6. Otherwise bound candidate storage to 512 KiB.
7. Check actual-byte per-owner/global storage quota at capture time.
8. Create a private opaque-ID directory/file using the existing hardened no-symlink/canonical-root/exclusive-create pattern.
9. Hash the bytes actually stored.
10. Register the internal owned descriptor only after a successful write.
11. Return `artifact_complete` or `artifact_truncated`.
12. If quota/write/integrity setup fails, remove safe partial state when possible, return `artifact_unavailable`, and emit a bounded typed storage diagnostic without a path.

Do not interrupt or abort the child in steps 5-12.

### 8.4 Registry and accounting

Use one owner-aware registry/store instance created alongside the subagent runtime factory and shared by:

- `NativeSubagentRunner`;
- writer runner;
- managed batch/review records;
- durable `SubagentJobRegistry`;
- `read_subagent_output`.

The registry tracks:

- artifact ID → internal descriptor;
- owner stored bytes;
- global stored bytes;
- process-local vs durable lifecycle;
- reference release/deletion.

Do not infer ownership from ID prefixes.

### 8.5 Durable rehydration and orphan sweep

Startup order:

1. Create the store without deleting files.
2. Restore durable job snapshots for the current owner.
3. Re-register valid v2 artifact refs from retained terminal durable results.
4. Do not re-register process-local artifacts from a prior process.
5. After durable restoration completes, perform a bounded safe orphan sweep of private artifact-ID directories not referenced by any restored durable result.
6. Never follow symlinks during sweep; never recursively delete a path that fails canonical-root/private-layout validation.

This preserves durable terminal output while cleaning process-local artifacts after a restart.

### 8.6 Retention release

Release/delete artifact bytes when:

- a reusable/retained process-local result is explicitly deleted;
- a retained terminal process-local result is evicted;
- a managed batch/review/writer record is evicted/destroyed;
- session shutdown destroys process-local result ownership;
- a durable full result expires from the existing 32-record retention;
- a durable result is otherwise explicitly deleted by an existing owner-scoped lifecycle.

Removal failure must not corrupt the owning result state; report bounded cleanup telemetry and retry only where current retention cleanup already has a safe retry boundary.

## 9. `read_subagent_output` contract

Add one parent-only managed tool. Do not expose it to delegated children through capability derivation.

Suggested schema:

```ts
{
  artifactId: string;     // opaque id only
  offset?: number;        // UTF-8 byte offset, default 0
  length?: number;        // requested max bytes, default 16 KiB, max 64 KiB
}
```

Suggested response details:

```ts
{
  artifactId: string;
  offset: number;
  bytesRead: number;
  totalBytes: number;
  nextOffset?: number;
  eof: boolean;
  contentType: "text/plain" | "application/json";
  text: string;
  sha256: string;
  truncated: boolean;
}
```

### 9.1 Authorization

- The tool wrapper supplies the current owner session ID.
- Lookup is `registry.resolveOwned(ownerSessionId, artifactId)`.
- Unknown and cross-owner IDs return the same bounded not-found error.
- Do not accept `runId`, `jobId`, `resultRef`, or a filesystem path as an alternative locator.

### 9.2 UTF-8 chunking

- `offset` and `length` are byte-oriented.
- Return text only on valid UTF-8 boundaries.
- Return authoritative `nextOffset` so callers can paginate without guessing multibyte boundaries.
- If an arbitrary offset lands inside a multibyte sequence, reject it with a bounded invalid-offset error rather than silently returning replacement characters.
- Never return more than 64 KiB of artifact bytes in one call.

### 9.3 Read-time filesystem revalidation

Immediately before reading:

- derive internal path from trusted registry descriptor;
- verify expected canonical root;
- reject symlink components;
- open no-follow where supported;
- require regular file;
- verify size equals `storedBytes`;
- verify SHA-256 of the stored file equals the descriptor;
- only then return the requested chunk.

A tamper/stale/missing failure returns a typed artifact-unavailable/integrity error and must not leak the absolute path.

## 10. Structured report and verification semantics

### 10.1 Split parser bounds from execution bounds

Today `normalized.maxOutputBytes` is reused for child stop behavior, report parsing, result serialization, retry accounting, and presentation. Remove that coupling.

Introduce separate fixed internal concepts:

- output inline projection limit;
- output artifact limit;
- artifact read limit;
- structured report parser/input limit;
- structured payload/schema limits already in force;
- bounded diagnostic/work-artifact limits.

No parser bound may abort a child while it is generating output.

### 10.2 Terminal processing order

For a completed prompt:

1. capture/sanitize/materialize the terminal final answer;
2. attach `output`;
3. parse structured protocol if requested;
4. verify evidence/payload/requirements;
5. compute final result + verification;
6. retain/register terminal result;
7. notify parent/check-in/completion surfaces.

For structured output:

- complete artifact does not bypass JSON/schema checks;
- malformed JSON remains verification failure;
- parser-oversized input remains verification failure even if artifact bytes are readable;
- artifact truncation/unavailability means required full report bytes are unavailable, therefore structured verification fails.

For plain output:

- if the whole final answer fits inline, plain-bounds verification can proceed;
- if inline is truncated but artifact is complete, plain-bounds verification may proceed using the fact that complete retained bytes exist, without injecting all bytes into context;
- if artifact is truncated/unavailable, plain verification cannot claim complete final-answer retention and must remain unverified/verification-failed.

### 10.3 Failure taxonomy

Remove `output_truncated` as a **child execution stop** classification for new runs.

Add/retain storage/materialization diagnostics that do not pretend the child failed to execute, for example:

- `output_artifact_truncated`;
- `output_artifact_unavailable`;
- `output_artifact_integrity_failure`.

Do not use `batch_budget_exhausted` for output sizing after this change.

Historical persisted diagnostics/statuses remain readable.

## 11. Remove caller/profile final-answer budgets without removing unrelated safety limits

### 11.1 Remove from managed child execution/configuration

Remove new-request support for final-answer `maxOutputBytes` from:

- `SubagentExecutionOverrideInput` and normalized child execution;
- resolved profile final-answer cap fields;
- profile frontmatter aliases `max-output-bytes` / `maxOutputBytes` / `max_output_bytes`;
- global/project subagent defaults and role defaults;
- subagent restrictions that cap child final-answer bytes;
- launch provenance/preflight “output bytes” fields;
- tool parameter schema under `execution.maxOutputBytes`;
- writer top-level `maxOutputBytes`;
- prompt wording that tells the child to keep its answer within the caller cap;
- recovery “remaining output bytes” accounting;
- result verification that compares result size to request `maxOutputBytes`;
- RPC setting `ice.subagents.defaults.maxOutputBytes`;
- user docs/examples.

### 11.2 Explicitly retain command-hook output limits

Do **not** remove `maxOutputBytes` from command-hook definitions in `ice-subagent-settings.ts`. That field bounds external command hook capture and is unrelated to child final-answer length.

Refactor names/types if needed so the distinction is mechanically obvious, e.g. `hook.maxOutputBytes` remains while `execution.maxOutputBytes` disappears.

### 11.3 Removed input behavior

For new calls/configuration:

- unknown `execution.maxOutputBytes` is rejected by the closed schema;
- writer `maxOutputBytes` is rejected;
- batch/review `totalBudgetBytes` is rejected;
- `background` is rejected after its schema removal;
- profile frontmatter final-answer output-cap aliases produce an actionable removed-field error rather than being silently ignored;
- RPC writes to the removed subagent default key return a typed unknown/removed-setting error.

Do not add a hidden compatibility interpretation.

## 12. Remove batch/review output-byte admission

Delete these concepts for new execution:

- `SubagentBatchRunOptions.totalBudgetBytes`;
- `SubagentBatchBudgetLedger`;
- preflight `budget.totalOutputBytes` / `reservedOutputBytes` / `maxPotentialOutputBytes`;
- per-task output reservation before launch;
- aggregate result `budget`;
- output-driven `batch_budget_exhausted`;
- tool schemas for `totalBudgetBytes`.

Preserve:

- max task count;
- concurrency policy and shared admission permits;
- deterministic result ordering;
- queued/admitted/running/terminal state;
- `failFast` based on actual task failure/verification failure;
- cancellation;
- model/trust/scope/resource/hook authority;
- per-item result/verification;
- bounded aggregate presentation cap from section 6.3.

No replacement caller-facing “storage budget” parameter is added.

## 13. Remove durable-job output reservation

For new durable jobs remove:

- `SUBAGENT_JOB_OWNER_OUTPUT_BUDGET` as an admission budget;
- `SUBAGENT_JOB_DEFAULT_OUTPUT_BYTES` where it only feeds planned output admission;
- `SubagentJobRecord.plannedOutputBytes` new writes;
- `SubagentJobRecord.reservedOutputBytes` new writes;
- registry `maxAggregateOutputBytes` option/property;
- owner reserved-byte accumulator;
- create-time reservation/rejection;
- settle/failure reservation release;
- inspection output budget fields;
- Observatory “reservation X/Y bytes” presentation.

Preserve job queue/concurrency state. If `SubagentJobInspection.budget` currently mixes output bytes with concurrency counts, replace it with an accurately named scheduling projection, e.g.:

```ts
scheduling?: {
  ownerActiveJobs: number;
  ownerQueuedJobs: number;
  ownerActiveJobsCap: number;
  queuePosition?: number;
}
```

Storage quota is owned by the artifact store and is checked only when terminal final output is captured.

## 14. Always-managed launch contract

### 14.1 Remove synchronous opt-out

Remove `background` from:

- `delegate`;
- `delegate_batch`;
- `review_batch`;
- `delegate_write`.

`delegate_async` remains inherently asynchronous/durable.

### 14.2 Launch return points

- `delegate` returns the managed run handle once child admission/startup reaches the existing accepted boundary.
- `delegate_batch` / `review_batch` return aggregate handles after preflight/admission record creation; children continue under the existing scheduler.
- `delegate_write` returns after clean parent/base commit/worktree preflight and managed writer acceptance.
- Final results are observed later through existing manage/inspect/completion surfaces.
- Preflight errors still return synchronously because no work was accepted.

### 14.3 Remove dead branches, not just schema fields

Delete synchronous execution branches guarded by `params.background === false` / `params.background !== false`. A removed schema field with retained synchronous code is not complete.

Update tests that currently use `background: false`, including the readiness, delegate MVP, writer, and broad subagent suites.

## 15. Durable-state and legacy migration contract

### 15.1 Keep discovery of historical snapshots

Do not change `JOB_ENTRY_TYPE` solely to avoid reading old records.

The restore path must continue to discover historical snapshots and normalize legacy fields for inspection.

### 15.2 Legacy output-budget fields

Historical snapshots may contain:

- `contract.maxOutputBytes`;
- `plannedOutputBytes`;
- `reservedOutputBytes`;
- historical output-budget diagnostics/status metadata.

Rules:

- accept them only while decoding historical persisted state;
- never use them to admit, restart, reserve, or constrain new work;
- new snapshots do not write them;
- normalized inspections may label them explicitly as legacy if surfaced at all;
- nonterminal restored jobs still become `interrupted` and are not replayed.

### 15.3 Legacy v1 path-bearing report artifacts

Historical `SubagentReportArtifact schemaVersion: 1` contains an absolute path and often uses `runId` as `id`.

For safety:

- recognize it only in the legacy restore validator;
- validate it with the existing configured-root/path rules;
- never copy its path into a new model-facing `output.artifact`;
- do not present its old run-derived ID as a new opaque v2 capability;
- historical job status/summary/work artifact remains inspectable even if old report bytes are not exposed through `read_subagent_output`;
- retention cleanup may continue deleting the old validated file when the historical full result expires.

Do not perform risky automatic rename/move migrations during restore merely to make old artifacts readable through the new API.

### 15.4 New durable v2 artifact refs

New terminal durable results persist the pathless v2 public ref. On restore:

- owner identity comes from the durable job record;
- internal path is derived from trusted artifact root + opaque artifact ID;
- store re-registration validates descriptor shape and filesystem integrity before authorizing reads;
- missing/tampered artifact makes output unavailable but does not rewrite historical execution status.

## 16. Observatory, TUI, RPC, and completion projections

### 16.1 Observatory

Remove output reservation fields/labels.

Where terminal output state is useful, project bounded metadata only:

- `captureStatus`;
- inline bytes;
- stored bytes;
- artifact available yes/no;
- artifact truncated yes/no.

Do not project paths or artifact content.

### 16.2 Completion/check-in messages

Completion messages should remain small notifications:

- identify run/job/batch;
- report terminal status;
- tell parent which existing inspect/manage surface to use;
- do not inject the full output artifact;
- do not include filesystem paths.

Check-in snapshots remain progress-only and must not begin carrying final artifact chunks.

### 16.3 RPC/settings

- Remove `ice.subagents.defaults.maxOutputBytes` from writable RPC settings and snapshots.
- Ensure tool schemas no longer show `background`, child execution `maxOutputBytes`, writer `maxOutputBytes`, or batch/review `totalBudgetBytes`.
- Expose output/artifact metadata through typed result details only.
- If `read_subagent_output` is RPC-visible through normal tool execution, keep the same owner/pathless constraints; do not add a separate unguarded RPC file-read endpoint.

## 17. Detailed implementation stages

The stages below are ordered so the fixed output-retention path exists before output-size execution cutoffs are removed.

### Stage S0 — Freeze contracts and regression baseline

- [x] **S0.1 — Record current symbol inventory.**
  - Files: `packages/coding-agent/src/ice-subagents.ts`, `ice-subagent-jobs.ts`, `ice-subagent-settings.ts`, `ice-subagent-observatory.ts`, `modes/rpc/rpc-settings.ts`.
  - Capture every final-answer `maxOutputBytes`, `totalBudgetBytes`, `SubagentBatchBudgetLedger`, `plannedOutputBytes`, `reservedOutputBytes`, `background` synchronous branch, and public `reportArtifact.path` use.
  - Explicitly classify command-hook `maxOutputBytes` as retained.
  - Acceptance: no removal work begins from a text search alone; each occurrence is categorized execution/presentation/storage/hook/migration.
  - Verify: checked symbol ledger in implementation notes or updated plan evidence.

- [x] **S0.2 — Freeze v2 output types and constants.**
  - Add public/internal interfaces and host constants described in sections 6-8.
  - Acceptance: no public path field; artifact ID distinct from run/job IDs; constants not caller configurable.
  - Verify: type-level/unit tests compile before integration.

- [x] **S0.3 — Add inverse regression specifications before deleting old behavior.**
  - Tests: `ice-subagents.test.ts` / `ice-subagent-result-contract.test.ts`.
  - Specify that a final answer above the former per-child cap is not aborted for byte length.
  - Specify large plain and structured terminal outputs separately.
  - Acceptance: tests fail against old output-abort behavior for the expected reason.

### Stage S1 — Extract and harden the output artifact store

- [x] **S1.1 — Create `ice-subagent-output-artifacts.ts`.**
  - Move/reuse UTF-8 truncation, private-root, no-symlink, canonical containment, exclusive creation, redaction, hashing, and safe cleanup primitives as appropriate.
  - Keep writer patch artifact logic separate.
  - Acceptance: module owns new output artifact path knowledge; public ref has no path.
  - Verify: focused artifact-store unit suite.

- [x] **S1.2 — Implement opaque ID generation and internal registry.**
  - Dependencies: S1.1.
  - Register owner, lifecycle, optional run/job lineage, metadata, internal path, stored bytes.
  - Acceptance: same artifact ID cannot be registered under another owner; ID is not runId/jobId.
  - Verify: ID/ownership tests.

- [x] **S1.3 — Implement actual-byte storage accounting.**
  - Dependencies: S1.2.
  - Enforce 512 KiB artifact, 16 MiB per owner, 128 MiB global limits only at capture.
  - No pre-launch reservation API.
  - Acceptance: quota exhaustion returns capture failure without child-control side effects.
  - Verify: quota tests with tiny injected limits.

- [x] **S1.4 — Implement safe release/cleanup and orphan finalization.**
  - Dependencies: S1.2.
  - Release accounting exactly once; safe file delete; post-durable-restore orphan sweep.
  - Acceptance: no recursive deletion outside validated private layout; process-local orphan removed after restart, durable referenced artifact preserved.
  - Verify: temp-root cleanup/symlink adversarial tests.

### Stage S2 — Add pathless materialization and bounded read API

- [x] **S2.1 — Implement final-answer materializer.**
  - Dependencies: S1.
  - Input: terminal assistant final text + trusted content type + owner/lineage.
  - Output: `SubagentOutput` and optional internal registry entry.
  - Acceptance: inline complete, artifact complete, artifact truncated, artifact unavailable all deterministic and UTF-8 safe.
  - Verify: ASCII, multibyte, redaction, exact-boundary, over-boundary tests.

- [x] **S2.2 — Add `read_subagent_output` schema/tool.**
  - Dependencies: S1.2, S2.1.
  - Register parent-side only.
  - Acceptance: accepts only opaque ID + bounded byte offset/length; no path parameters.
  - Verify: schema snapshot/tool catalog tests.

- [x] **S2.3 — Implement owner and integrity checks.**
  - Dependencies: S2.2.
  - Acceptance: unknown/cross-owner same error; symlink/missing/size/hash mismatch rejected; absolute path never appears in error/result.
  - Verify: adversarial artifact read suite.

- [x] **S2.4 — Implement UTF-8 pagination.**
  - Dependencies: S2.2.
  - Acceptance: 16 KiB default, 64 KiB maximum, byte offsets, authoritative nextOffset, invalid mid-codepoint offset rejected.
  - Verify: multibyte pagination round-trip reconstructs stored text exactly.

### Stage S3 — Integrate output materialization into terminal result construction

- [x] **S3.1 — Single child: capture only terminal final answer.**
  - Files: `ice-subagents.ts` runner finalization.
  - Dependencies: S2.
  - Replace `spillAssistantOutput` / path-bearing diagnostics with v2 materialization.
  - Do not artifactize intermediate streaming deltas/provider-failure partial messages.
  - Acceptance: terminal plain/structured result gets `output`; provider failure without terminal final answer does not fabricate a complete artifact.
  - Verify: update current spill/partial tests.

- [x] **S3.2 — Split structured parsing from output retention.**
  - Dependencies: S3.1.
  - Introduce fixed parser boundary independent of removed caller output budget.
  - Acceptance: parser failure never causes streaming child abort; complete raw bytes may still be retrieved if artifact capture succeeded.
  - Verify: malformed, parser-oversized, schema-invalid, artifact-complete cases.

- [x] **S3.3 — Update `verifySubagentResult`.**
  - Dependencies: S3.1-S3.2.
  - Remove request `maxOutputBytes` comparisons.
  - Verify output completeness/materialization plus existing lineage/evidence/schema rules.
  - Acceptance: artifact-truncated/unavailable cannot become verified completion.
  - Verify: result-contract tests.

- [x] **S3.4 — Writer result integration.**
  - Dependencies: S3.1.
  - Add textual `output` without changing patch artifact authority/integration flow.
  - Acceptance: long writer final answer does not abort writer; patch verification/isolation unchanged.
  - Verify: `ice-writer-w5.test.ts` focused cases.

### Stage S4 — Remove final-answer byte execution controls and public knobs

- [x] **S4.1 — Remove streaming `output_truncated` control.**
  - Files: child and writer message-update/control races in `ice-subagents.ts`.
  - Dependencies: S3.
  - Acceptance: output length no longer resolves a control promise or calls child abort.
  - Verify: former `ice-subagents.test.ts:6865-6901` scenario now reaches normal terminal finalization.

- [x] **S4.2 — Remove child execution `maxOutputBytes` contract.**
  - Files: interfaces, normalizer, launch provenance/preflight, prompt builder, recovery accounting, verifier.
  - Dependencies: S4.1.
  - Acceptance: no final-answer byte field in new normalized execution or launch provenance.
  - Verify: TypeScript + targeted normalization/profile tests.

- [x] **S4.3 — Remove profile/settings final-answer byte controls.**
  - Files: `ice-subagent-settings.ts`, profile parser in `ice-subagents.ts`, tests.
  - Preserve hook `maxOutputBytes`.
  - Acceptance: new profile/default/restriction final-answer cap input rejected; hook capture cap still resolves and tests pass.
  - Verify: `ice-subagent-settings.test.ts`, `ice-subagent-profile-controls.test.ts`, command-hook tests.

- [x] **S4.4 — Remove writer `maxOutputBytes` input.**
  - Dependencies: S3.4.
  - Acceptance: writer schema/tool docs no longer expose the field; long final writer output uses artifact pathless flow.
  - Verify: writer schema + runtime tests.

- [x] **S4.5 — Remove output-budget retry arithmetic.**
  - Dependencies: S4.2.
  - Acceptance: startup retry policy remains max two attempts/retry-safe, but no “remaining output bytes” calculation exists.
  - Verify: recovery tests still prove no retry after observed work/non-startup failures.

### Stage S5 — Remove batch/review and durable-job byte admission

- [x] **S5.1 — Delete batch/review `totalBudgetBytes` public/API fields.**
  - Files: schemas, types, tool execution options, descriptions.
  - Acceptance: closed schema rejects removed field.
  - Verify: schema tests.

- [x] **S5.2 — Delete `SubagentBatchBudgetLedger` and reservation preflight.**
  - Dependencies: S5.1, S4.
  - Preserve scheduler concurrency, deterministic ordering, failFast, cancellation.
  - Acceptance: no output-byte admission or `batch_budget_exhausted` for new work.
  - Verify: replace existing budget tests with scheduling/non-abort large-output tests.

- [x] **S5.3 — Remove batch/review result/preflight budget projections.**
  - Dependencies: S5.2.
  - Acceptance: result objects no longer contain output `budget`; aggregate presentation remains fixed-host bounded.
  - Verify: result contract/snapshot tests.

- [x] **S5.4 — Remove durable planned/reserved output admission.**
  - Files: `ice-subagent-jobs.ts` + creation call in `ice-subagents.ts`.
  - Dependencies: S3 output capture.
  - Acceptance: job create/pump uses only queue/concurrency permits for scheduling; output size is absent from admission.
  - Verify: job scheduling tests with tiny artifact quota prove launch still accepted and capture failure occurs only terminally.

- [x] **S5.5 — Replace mixed job “budget” inspection with scheduling state.**
  - Dependencies: S5.4.
  - Acceptance: active/queued/cap still visible; no planned/reserved/owner output budget.
  - Verify: Observatory/job inspection tests.

### Stage S6 — Wire artifact lifecycle to every result owner

- [x] **S6.1 — Process-local single-run retention/delete.**
  - Dependencies: S3.
  - Release artifact on retained-result eviction/delete/shutdown.
  - Acceptance: owner can read while result retained; read fails after deletion/eviction.
  - Verify: manage_subagent delete/retention tests.

- [x] **S6.2 — Managed batch/review lifecycle.**
  - Dependencies: S3, S5.
  - Child refs remain readable while aggregate/child retained.
  - Acceptance: aggregate presentation clipping does not delete canonical child output.
  - Verify: deterministic multi-child aggregate presentation stays within 16 KiB, preserves item order, and does not invalidate canonical output artifacts.

- [x] **S6.3 — Managed writer lifecycle.**
  - Dependencies: S3.4.
  - Output artifact release independent from writer patch artifact cleanup.
  - Acceptance: deleting text output cannot delete patch artifact and vice versa.
  - Verify: writer lifecycle tests.

- [x] **S6.4 — Durable terminal result persistence/rehydration.**
  - Files: `ice-subagent-jobs.ts` validator/clone/persist/restore.
  - Dependencies: S1 registry + S3.
  - Acceptance: v2 ref persists pathlessly; restart re-registers valid terminal artifact; nonterminal job becomes interrupted without replay.
  - Verify: persistence round trip and restart tests.

- [x] **S6.5 — Durable retention expiry.**
  - Dependencies: S6.4.
  - Replace direct v2 path deletion with store release; retain legacy v1 cleanup adapter.
  - Acceptance: 33rd terminal record evicts old full result and artifact, matching existing retention semantics.
  - Verify: successor to `ice-subagent-jobs.test.ts:884-910`.

### Stage S7 — Make all managed launch surfaces handle-only

- [x] **S7.1 — Remove `background` schema fields.**
  - Files: delegate/writer/batch/review tool schemas.
  - Acceptance: closed schemas reject `background`.
  - Verify: tool schema tests.

- [x] **S7.2 — Delete synchronous delegate branch.**
  - Dependencies: S7.1.
  - Acceptance: successful call always returns managed handle; final result later inspectable.
  - Verify: `ice-delegate-mvp.test.ts` + readiness tests.

- [x] **S7.3 — Delete synchronous batch/review branches.**
  - Dependencies: S7.1, S5.
  - Acceptance: aggregate handle always returned after admission; terminal aggregate later inspectable; deterministic order preserved.
  - Verify: batch/review managed tests.

- [x] **S7.4 — Delete synchronous writer branch.**
  - Dependencies: S7.1.
  - Acceptance: writer always returns accepted managed handle after required preflight; explicit stop still waits cleanup.
  - Verify: writer W5 suite.

- [x] **S7.5 — Remove stale guidance/examples.**
  - Dependencies: S7.2-S7.4.
  - Acceptance: no code/doc/tool description recommends `background: false`.

### Stage S8 — Historical migration, settings/RPC, observability, docs

- [x] **S8.1 — Normalize legacy durable output fields.**
  - Files: `ice-subagent-jobs.ts` restore/validator.
  - Acceptance: historical planned/reserved/max output fields are readable but inert; new snapshots omit them.
  - Verify: explicit old-snapshot fixtures.

- [x] **S8.2 — Keep legacy v1 artifact validator internal-only.**
  - Acceptance: old path-bearing artifact can be safely retained/cleaned as historical state but is never projected as v2 read authority.
  - Verify: retain outside-root/mismatched-path rejection from `ice-subagent-jobs.test.ts:1560-1575`.

- [x] **S8.3 — Update Observatory/TUI.**
  - Remove output reservation text.
  - Add bounded capture-status metadata where useful.
  - Acceptance: no absolute output path or obsolete reservation budget visible.
  - Verify: Observatory rendering tests.

- [x] **S8.4 — Update RPC settings and schemas.**
  - Remove `ice.subagents.defaults.maxOutputBytes` and removed launch fields.
  - Acceptance: removed setting write rejected; normal subagent settings remain mutable.
  - Verify: `rpc-settings.test.ts` and RPC tool-schema tests.

- [x] **S8.5 — Update docs/changelog.**
  - Files: `packages/coding-agent/docs/subagent-user-guide.md`, `docs/settings.md`, relevant architecture/worktree docs, `ICE_CHANGELOG.md` or package changelog convention.
  - Document fixed host limits, read flow, artifact ownership, process-local vs durable semantics, breaking removed inputs.
  - Acceptance: examples use handle → inspect → optional read flow; no old budgets/synchronous opt-out.
  - Verify: repository text search plus docs review.

- [x] **S8.6 — Mark architecture status only after verification.**
  - Update `idea.md` “planned; not implemented” language only after all required tests/check pass.
  - Acceptance: no premature “implemented” claim.

### Stage S9 — Closure verification

- [x] **S9.1 — Run focused artifact/result/security suite.**
- [x] **S9.2 — Run focused single child + readiness + recovery suite.**
- [x] **S9.3 — Run batch/review scheduler suite.**
- [x] **S9.4 — Run durable jobs/restart/retention suite.**
- [x] **S9.5 — Run writer suite.**
- [x] **S9.6 — Run settings/profile/hook/RPC/Observatory suite.**
- [x] **S9.7 — Run repository check with pinned npm 12.0.2.**
- [x] **S9.8 — Perform final forbidden-symbol audit and coverage ledger.**

No stage is complete from code review alone if its required behavior has a focused deterministic test.

## 18. Verification matrix

| Requirement | Primary tests | Required proof |
|---|---|---|
| Long output does not stop child | `ice-subagents.test.ts`, `ice-subagent-result-contract.test.ts` | Final answer beyond former cap reaches terminal finalization; child abort not called for size |
| Inline/artifact state machine | new `ice-subagent-output-artifacts.test.ts` | exact boundary, +1 byte, >512 KiB, write failure, quota failure |
| Redaction | artifact tests | stored/read text excludes injected credential marker |
| Opaque IDs | artifact tests | artifact ID differs from runId/jobId; no path public |
| Cross-owner isolation | artifact tests | owner B cannot read owner A; error indistinguishable from unknown ID |
| Traversal/symlink/tamper | artifact tests | no path input; symlink/missing/size/hash mismatch rejected |
| UTF-8 pagination | artifact tests | multibyte content round-trips by nextOffset, no replacement-character corruption |
| Storage quota is terminal-only | artifact + jobs | launch accepted despite tiny quota; capture fails only after final answer |
| Batch no output admission | `ice-subagents.test.ts` / adversarial | no `totalBudgetBytes`, no ledger, large siblings still scheduled under concurrency cap |
| Aggregate presentation bounded | batch/review tests | canonical outputs retained; aggregate inline text <=16 KiB |
| Durable no planned reservation | `ice-subagent-jobs.test.ts` | admission based on queue/concurrency only |
| Durable restart | jobs tests | terminal artifact ref restored/readable; running job becomes interrupted; no replay |
| Durable retention cleanup | jobs tests | eviction releases v2 file/accounting; legacy v1 cleanup remains safe |
| Legacy v1 safety | jobs tests | old outside-root/mismatched path rejected; path not exposed through v2 API |
| Always background | delegate/readiness/writer/batch tests | removed `background` rejected; successful launch returns handle only |
| Explicit stop/shutdown preserved | existing check-in/lifecycle tests | stop cancels, shutdown cleans process-local runs/artifacts |
| Writer isolation preserved | `ice-writer-w5.test.ts` | patch workflow unchanged, textual output independent |
| Hook bounds preserved | command-hook tests | hook `maxOutputBytes` still works after child output knob removal |
| RPC/settings migrated | `rpc-settings.test.ts`, settings tests | removed child output key absent/rejected; other settings unchanged |
| Observatory clean | `ice-subagent-observatory.test.ts` | no reservation budget/path; scheduling and capture status accurate |
| Root quality gate | `corepack npm@12.0.2 run check` | passes cleanly |

### Suggested focused command shape

Use the repository's current Vitest invocation convention rather than `npm test`. A representative focused set should include:

- new artifact-store tests;
- `ice-subagent-result-contract.test.ts`;
- `ice-subagents.test.ts`;
- `ice-subagents-adversarial.test.ts`;
- `ice-subagent-jobs.test.ts`;
- `ice-delegate-mvp.test.ts`;
- `ice-subagent-readiness.test.ts`;
- `ice-writer-w5.test.ts`;
- `ice-subagent-settings.test.ts`;
- `ice-subagent-profile-controls.test.ts`;
- `ice-subagent-command-hooks.test.ts`;
- `ice-subagent-observatory.test.ts`;
- `rpc-settings.test.ts`;
- any RPC JSON/tool catalog test affected by the new read tool.

Then run `corepack npm@12.0.2 run check`.

Do not use live provider requests for implementation verification; use faux providers and temporary artifact roots.

## 19. Forbidden-symbol / stale-contract audit

Before declaring completion, search relevant source/tests/docs and explain every remaining occurrence of:

- `totalBudgetBytes`;
- `SubagentBatchBudgetLedger`;
- `batch_budget_exhausted`;
- child/writer final-answer `maxOutputBytes`;
- `plannedOutputBytes`;
- `reservedOutputBytes`;
- `maxAggregateOutputBytes`;
- managed-launch `background`;
- `reportArtifact.path`;
- path-bearing “Oversized report capture” diagnostics;
- prompt text telling children to keep final answer under a caller byte budget.

Permitted remaining occurrences must be explicitly categorized as one of:

- historical migration fixture/decoder;
- legacy documentation explicitly labeled historical;
- command-hook output capture bound;
- unrelated model/provider token/output semantics.

A raw search count of zero is **not** required where migration compatibility is intentional, but unexplained production-path occurrences block completion.

## 20. Risks and mitigations

### Risk: artifact store becomes a new admission budget

Mitigation: quota check occurs only after terminal answer exists; no planned-byte reservation or launch rejection API exists.

### Risk: “child completed” is confused with “verified complete output”

Mitigation: independent capture status and verification; artifact-truncated/unavailable cannot silently verify.

### Risk: batch result context expands after removing aggregate budget

Mitigation: fixed 16 KiB aggregate presentation cap; artifacts remain individually readable.

### Risk: opaque ID accidentally becomes bearer authority

Mitigation: owner session check is mandatory; cross-owner/unknown errors identical.

### Risk: path traversal or same-user symlink race

Mitigation: preserve private root, canonical containment, symlink-component checks, exclusive/no-follow opens, regular-file validation, and read-time revalidation.

### Risk: durable restart deletes valid output as an orphan

Mitigation: restore durable refs before orphan sweep; sweep only after restore finalization.

### Risk: old path-bearing artifact becomes a new public capability

Mitigation: keep v1 decoder internal-only; no automatic projection to v2 read API.

### Risk: removal of `maxOutputBytes` accidentally removes hook safety

Mitigation: inventory/classify all occurrences first; hook `maxOutputBytes` is an explicit non-goal and has dedicated regression tests.

### Risk: writer patch lifecycle is coupled to textual output artifact cleanup

Mitigation: distinct registries/types/cleanup calls; tests delete each independently.

### Risk: output bytes remain in memory unbounded after child completion

Mitigation: immediately sanitize/materialize from the terminal final message and keep only fixed inline projection + artifact; do not duplicate raw answer into long-lived result fields.

### Risk: global disk cap creates cross-owner denial of storage

Mitigation: it affects output capture only, never child launch/execution; surface explicit `artifact_unavailable`, clean expired/orphan artifacts deterministically, and keep per-owner quota below global cap.

## 21. Rollback and recovery strategy

Implement in dependency order so rollback boundaries are clean:

1. S0-S2 are additive contract/store work and can be reverted without changing child execution.
2. S3 switches terminal materialization but still can coexist temporarily with old execution caps during development.
3. Only after S3 focused tests pass should S4 remove output-size aborts/public child-output knobs.
4. S5 removes admission ledgers after the new terminal storage path is proven.
5. S7 removes synchronous launch branches after managed-handle/result inspection coverage passes.
6. S8 migration/docs lands with the behavior it documents.

Do not add a runtime feature flag that preserves both old and new output-budget semantics indefinitely. If a late regression requires rollback before merge, revert the relevant implementation stage as code, not via a hidden compatibility mode.

If artifact persistence is unavailable at runtime after the migration:

- child work continues;
- bounded inline output remains;
- capture status is explicit;
- verification may fail when complete bytes are required;
- no child replay is attempted.

## 22. Definition of done

This work is complete only when all of the following are evidenced:

- [x] New output/artifact contracts are implemented and pathless.
- [x] Opaque artifact IDs are distinct from run/job/batch IDs.
- [x] Owner-scoped bounded read works with integrity and UTF-8 safety.
- [x] Fixed inline/artifact/read/owner/global storage limits are host-owned.
- [x] Final-answer size does not abort a child or writer.
- [x] Child/writer caller/profile final-answer `maxOutputBytes` knobs are removed from new execution/configuration.
- [x] Command-hook output bounds remain intact.
- [x] Batch/review `totalBudgetBytes`, output ledger, budget projections, and output-budget failure path are removed.
- [x] Durable planned/reserved output admission is removed.
- [x] New durable results persist pathless v2 refs; historical records remain inspectable and non-replayed.
- [x] Retention/delete/shutdown release the correct artifact lifecycle without touching writer patch artifacts.
- [x] `delegate`, `delegate_batch`, `review_batch`, and `delegate_write` expose no synchronous `background: false` path.
- [x] Progress/check-in/completion remain bounded and separate from artifact content.
- [x] Structured verification remains bounded and authoritative.
- [x] Observatory/RPC/settings/docs no longer advertise obsolete output reservations/caller caps.
- [x] All focused deterministic suites pass.
- [x] `npm run check` passes with the active npm version 12.0.2.
- [x] Forbidden-symbol audit has no unexplained production-path remnants.
- [x] `idea.md` is updated from planned to implemented only after the above evidence exists.
- [x] No unrelated dirty work in this integration worktree was reset, discarded, or committed; the required check formatted only in-scope files.

## 23. Implementation handoff summary

The critical ordering constraint is:

`artifact store + result materialization + read security -> remove output-size execution controls -> remove admission budgets -> remove synchronous launch branches -> migrate persistence/observability/docs -> full verification`.

Do **not** start by deleting `maxOutputBytes` or `totalBudgetBytes`. First create the fixed host-owned terminal-output path that replaces their presentation/storage role. Conversely, do not stop after adding artifacts while leaving output-size aborts or byte-reservation admission in place; that would preserve the behavior this ADR is intended to remove.

The final architecture should be easy to state:

> Managed child execution is bounded by authority, concurrency, startup/provider/tool/hook controls, cancellation, and shutdown—not by final-answer byte guesses. Final answers are separately materialized into bounded inline text plus owner-scoped retained artifacts, read only through a bounded verified capability, and verified independently of execution.
