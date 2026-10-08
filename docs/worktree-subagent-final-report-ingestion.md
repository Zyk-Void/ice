# Subagent final-report ingestion

> **Historical implementation snapshot.** This note describes the former V1 `delegate*` report path, not current V2 result behavior. See the [Subagents V2 guide](../packages/coding-agent/docs/subagents-v2.md) and [result reference](../packages/coding-agent/docs/subagents-v2-reference.md); treat source and verification claims below as historical evidence.

## Scope and status

This document describes the final-answer/final-report ingestion implementation visible in this worktree. It is documentation of the current source tree, not a claim that every behavior has been exercised in this environment.

The requested documentation file was not present in the `docs/` listing before this write. No source code, tests, changelogs, or files outside this worktree were changed by this task.

Git metadata was not available through the file-only inspection interface used for this task. Consequently, the current Git branch, `HEAD`, and porcelain status could not be independently established. `progress.md` contains repository-tracked notes that refer to an inspected branch named `void`, a baseline `HEAD` of `7cbd8a676815cbfef3b03a4902269ede2ac2fbf1`, and a dirty worktree, but those notes are not a substitute for reading the current Git metadata. The implementation and tests cited below are therefore described as **present in the inspected tree**. This documentation file is the only file created here and should be treated as uncommitted unless a later Git inspection proves otherwise.

## Purpose

A child run has two different result contracts:

- **Plain final turn (`plain_final_turn`)** is for an ordinary delegation. The child's natural final assistant message is the result. This avoids forcing a normal investigation to manufacture JSON merely to be accepted.
- **Structured report (`structured_report`)** is for typed work where the parent needs machine-checkable evidence: a local `outputSchema`, acceptance criteria, or review-batch work. The child returns a bounded JSON envelope, which is parsed and then verified by the parent.

In both modes, the parent remains authoritative. A child answer is not permission, policy, or proof by itself. Lineage, terminal state, output bounds, scope, and—where applicable—evidence and payload are checked on the parent side.

## Behavior and ingestion matrix

| Invocation shape | Mode selected during normalization | Child finalization contract | Parent verification |
|---|---|---|---|
| Ordinary `delegate` or `delegate_async` request with no schema or acceptance criteria | `plain_final_turn` | Natural final assistant answer in prose or Markdown; no JSON envelope and normally no extra finalization turn | Lineage, completed status, child-session identity, non-partial result, nonempty bounded summary, and output bound only |
| Request with `outputSchema` | `structured_report` | Bounded JSON report, including a schema-validated `payload` object | Structured report parsing, payload schema/size, evidence path existence and scope, and normal lineage/status checks |
| Request with one or more acceptance criteria | `structured_report` | Bounded JSON report with one bounded requirement claim per criterion | Structured checks plus required-criterion verification and declared evidence checks |
| `review_batch` task | `structured_report` (forced, including for a hand-built plain task) | Bounded JSON report with findings | Structured checks plus reviewer finding evidence normalization |

The mode is an internal normalized field; callers do not select it by adding an arbitrary `reportMode` field to the public `SubagentRequest`. `normalizeSubagentRequest()` derives it from the presence of `outputSchema` or normalized acceptance criteria. `resolveReviewTask()` and `runResolvedReviewBatch()` force review work through the structured path.

### Plain final-turn behavior

`NativeSubagentRunner` locates the last assistant message produced after the finalization boundary and extracts its text. It rejects an absent assistant message as a runtime/malformed-result failure and rejects assistant stop reasons `error` and `aborted`. An empty answer is a protocol failure, not a verified completion.

A nonempty answer is UTF-8-truncated to the resolved `maxOutputBytes` when necessary. The result remains `completed` but carries `truncated` and an `output_truncated` diagnostic. `observedOutputBytes` is the byte length of the bounded answer in plain mode. The parent verifier explicitly returns `kind: "plain_bounds"` and `structuredVerified: false`; it returns no verified evidence paths and does not validate prose claims or an unstructured payload.

Plain-mode finalization after steering, timeout extension, or token-budget exhaustion uses the plain final-answer prompt. The prompt tells the child to answer in ordinary prose/Markdown, not to wrap the answer in JSON. A normal one-turn plain completion is consumed directly; the faux-provider integration test demonstrates that the runtime does not spend a second report turn for that path.

### Structured-report behavior

The structured prompt requires a bounded JSON object containing:

```json
{"summary":"...","evidence":{"paths":["relative/path"]}}
```

The parser also accepts the optional `findings`, `requirements`, and (when an `outputSchema` was requested) `payload` fields. `summary` must be a nonempty string. `evidence.paths` must be a nonempty array of existing-looking strings, with at most 64 entries and at most 4096 UTF-8 bytes per path. The parser returns a typed outcome rather than throwing:

- `valid` — the envelope has the required bounded shape;
- `malformed` — empty/missing text, invalid JSON, missing required fields, invalid paths, invalid findings/requirements, or invalid payload shape;
- `truncated` — the raw report exceeds the resolved report byte cap.

Parsing does not make paths trustworthy. `verifySubagentResult()` resolves and canonicalizes every structured evidence path, checks existence, and rejects paths outside the approved roots unless the normalized request explicitly allows external scope. Structured payloads are validated against the deliberately restricted local schema and bounded payload size. Reviewer findings are normalized separately; their evidence must also exist and remain in scope.

A malformed, missing, or oversized final envelope becomes `verification_failed` and retains a bounded runtime-owned work artifact. That artifact can include observed touched paths, candidate paths extracted from unparseable text, recent activity digests, and the protocol diagnostic. Candidate paths are explicitly unverified and must not be presented as accepted evidence.

The structured path permits at most one report-only repair attempt after a protocol failure. The repair uses the same child session, disables child tools, requests only the internal JSON envelope, and is charged to the same turn/output/time budget. It does not repeat the task. No repair is attempted for cancellation, terminal timeout, or a one-turn budget that is already exhausted. A second invalid repair remains a non-success result.

## Architecture and data flow

```text
public delegate/delegate_async/review request
        |
        v
normalizeSubagentRequest()
  - resolves profile, scope, tools, resources, budgets
  - derives reportMode
        |
        v
buildSubagentPrompt()
  - ordinary prose contract OR bounded JSON contract
        |
        v
NativeSubagentRunner / child AgentSession
  - observes messages, turns, tools, usage, cancellation, authority
        |
        +--> plain final turn: extract text -> bounded SubagentResult
        |
        +--> structured final turn: parseSubagentReportOutcome()
                              -> optional one-time repair
                              -> bounded SubagentResult
        |
        v
verifySubagentResult()
  - parent lineage/status/partial/output checks
  - plain bounds only, or structured evidence/payload/requirements checks
        |
        +--> foreground result formatting and live-view presentation
        +--> durable job projectResult() / inspection envelope
        +--> batch/reviewer result aggregation
```

The child is a native in-process `AgentSession`; the final result is a compact projection rather than an injected child transcript. `IceAgentViewPresentation` carries the mode, finalization markers, pending protocol state, and a bounded final result for live views. In plain mode the natural answer remains visible; in structured mode the internal report is hidden while `protocolReportPending` is true.

Durable jobs retain `reportMode` in `SubagentJobResultEnvelope`. `projectResult()` exposes evidence and findings only when the terminal result is both completed and parent-verified. It always preserves bounded verification metadata when available. For non-success results, `projectWorkArtifactView()` persists the bounded runtime-owned artifact instead of promoting candidate evidence to trusted evidence. Durable snapshot validation accepts only the two known report modes and applies bounds to summaries, paths, diagnostics, payloads, findings, and activity rows.

## API reference

### `SubagentReportMode`

Internal mode type: `"plain_final_turn" | "structured_report"`.

### `SubagentReportProtocolStatus`

Runtime artifact state: `"valid" | "malformed" | "missing" | "truncated" | "plain"`. `plain` means that no structured envelope was expected; it is not a statement that the answer's semantic claims were verified.

### `parseSubagentReportOutcome(text, maxBytes, outputSchema?)`

Parses and bounds a structured child report without throwing for ordinary protocol failures.

**Parameters:**

- `text` (`string`): Assistant text returned for the report boundary.
- `maxBytes` (`number`): Maximum allowed UTF-8 size for the complete report text.
- `outputSchema` (`SubagentOutputSchemaNode`, optional): Restricted local schema required for the nested `payload` field.

**Returns:** `SubagentReportParseOutcome`. A valid outcome contains the summary, raw report paths, normalized parsed findings, requirement claims, and optional payload. Invalid input returns a diagnostic and a `malformed` or `truncated` kind.

**Example:**

```typescript
const outcome = parseSubagentReportOutcome(
  '{"summary":"Inspected the entry point","evidence":{"paths":["src/app.ts"]}}',
  24 * 1024,
);

if (outcome.kind === "valid") {
  // The paths are parsed, but still require parent-side scope verification.
  console.log(outcome.report.summary, outcome.report.paths);
}
```

### `verifySubagentResult(result, request)`

Performs the parent-owned acceptance gate. It checks run and parent-session lineage, approved profile/source, completed terminal status, child-session identity, `partial === false`, bounded observed output, and nonempty summary. In plain mode it stops there and marks the result `plain_bounds`. In structured mode it additionally validates the restricted payload, canonical in-scope evidence paths, reviewer findings, and required acceptance criteria.

**Parameters:**

- `result` (`SubagentResult`): Runtime-produced child result; model claims must not be treated as trusted authority.
- `request` (`NormalizedSubagentRequest`): Immutable normalized request containing lineage, scope, mode, output schema, and acceptance criteria.

**Returns:** `SubagentVerification`, including `verified`, a diagnostic `reason`, canonical verified `paths`, unresolved semantic claims, and—when available—`kind`/`structuredVerified` plus a requirement summary.

**Example:**

```typescript
const verification = verifySubagentResult(childResult, normalizedRequest);
if (!verification.verified) {
  // Do not synthesize a successful completion from this result.
  reportFailure(verification.reason);
}
```

### `SubagentResult`

The bounded runtime result includes `runId`, `parentSessionId`, `childSessionId`, profile/source, terminal `status`, `summary`, `observedOutputBytes`, `partial`, diagnostics, optional usage/budget data, and optional `reportMode`. Structured results may include evidence, findings, requirement claims/states, and schema-validated payload. A `workArtifact` is a runtime-owned projection of observed activity retained across report-protocol failure; it is not accepted evidence.

### `buildSubagentPrompt(request, selectedPromptContents?, unsafeHostExec?)`

Builds the handoff prompt and appends the mode-specific final contract. Structured requests receive the bounded JSON report instructions. Plain requests receive the ordinary prose/Markdown instruction and the direct-ingestion statement. The prompt does not widen the normalized tool or scope contract.

### `runResolvedReviewBatch(tasks, parentActiveTools, runner, options?)`

Runs reviewer tasks through the shared batch executor, forces each task to `structured_report`, and parent-verifies findings. A reviewer cannot become a plain answer merely because a hand-built task was initially normalized that way.

## Configuration and usage

Use the normal delegation tools; do not ask an ordinary child to format JSON unless the invocation is typed. The child receives the mode-specific instruction automatically.

### Ordinary prose delegation

```json
{
  "role": "self",
  "self": {
    "instructions": "Inspect the approved scope and summarize what you found.",
    "capabilities": ["read", "grep", "find", "ls"]
  },
  "task": "Trace the model selection path.",
  "scope": { "roots": ["packages/coding-agent/src"] }
}
```

The expected terminal result is a natural answer such as `The route is selected from the configured catalog...`, with `reportMode: "plain_final_turn"`. That result can be parent-accepted for lineage and bounds while still making no evidence-path claim.

### Typed output

```json
{
  "role": "self",
  "self": {
    "instructions": "Inspect the approved scope and return the requested typed result.",
    "capabilities": ["read", "grep", "find", "ls"]
  },
  "task": "Inspect the API and classify the finding.",
  "scope": { "roots": ["packages/coding-agent/src"] },
  "outputSchema": {
    "type": "object",
    "properties": { "severity": { "type": "string" } },
    "required": ["severity"],
    "additionalProperties": false
  }
}
```

The structured child report must include both the outer `summary`/`evidence.paths` fields and a `payload` matching the restricted schema. Remote references, executable validators, unions, unknown schema keywords, oversized schemas, and oversized payloads are rejected before acceptance.

Acceptance criteria add a bounded `requirements` array with one claim per criterion. Required claims must be `satisfied`; required path-evidence claims must declare existing in-scope paths. Optional gaps remain visible as unresolved claims without failing an otherwise valid completion.

The same mode is carried through `delegate_async` durable inspection, live child views, observatory projections, and batch results. A configured `maxOutputBytes` is a UTF-8 byte bound. Optional aggregate token budgets reserve a bounded finalization slice; when a route cannot honor hard per-request output authority or the reserve cannot fit the finalizer request, the runtime returns a deterministic failure/fallback instead of issuing an unbounded final request.

## Verification evidence visible in this worktree

The following evidence is visible as source or test assertions; no test command was run through the available file-only tool interface.

- `packages/coding-agent/test/ice-subagents.test.ts` contains the ingestion matrix assertion for ordinary, output-schema, and acceptance-criteria requests; it also asserts reviewer forcing, one-turn plain completion, UTF-8 byte truncation, and the plain result's `plain_bounds` verification metadata.
- `packages/coding-agent/test/ice-subagent-result-contract.test.ts` covers valid structured parsing, malformed and oversized reports, bounded candidate-path extraction, schema payloads, parent-facing envelope overflow, preserved work artifacts, exactly-one repair, repair success, repair failure, cancellation behavior, and runtime stream failure classification.
- `packages/coding-agent/test/ice-subagent-timeout-supervisor.test.ts` covers structured continuation and a plain continuation after `needs_time`; the latter asserts the continuation prompt asks for ordinary prose and explicitly rejects a JSON envelope.
- `packages/coding-agent/test/ice-agent-view-integration.test.ts` contains final-report view state assertions and live steering/finalization coverage.
- `packages/coding-agent/src/ice-subagents.ts` is the implementation source for mode derivation, prompt contracts, parser, verifier, runner finalization, repair, and result formatting.
- `packages/coding-agent/src/ice-subagent-jobs.ts` projects and validates durable result envelopes, preserving `reportMode`, verification metadata, and unverified work artifacts while filtering evidence/findings from unverified completions.
- `packages/coding-agent/src/ice-subagent-observatory.ts` and `packages/coding-agent/src/ice-agent-view-bridge.ts` define bounded presentation projections for report mode and final-result metadata.
- `packages/coding-agent/docs/subagent-user-guide.md` documents the user-facing distinction between ordinary natural answers and typed bounded reports, including the shared output/turn budget behavior.
- `packages/coding-agent/CHANGELOG.md` records the change from forced JSON finalization for ordinary `delegate`/`delegate_async` to direct natural-answer ingestion, while retaining structured reports for typed and review flows.

Repository notes in `progress.md` and `task_plan.md` include historical verification counts, but those counts were not independently rerun here and should not be presented as execution evidence from this task. The existing `docs/subagent-audit-report.md` also records unrelated security findings and verification gaps; it should not be read as proof of final-report test execution.

## Limitations and follow-ups

1. Plain verification is intentionally weak. A natural answer can be accepted as bounded and correctly related to the parent run without proving its file, command, or semantic claims. Callers needing evidence must use acceptance criteria, an output schema, or review/structured flow.
2. Structured evidence checks occur after path resolution/existence checks, but the inspected source does not establish a descriptor-based filesystem authorization boundary. The audit document records a possible scoped-path TOCTOU race; this documentation does not claim that issue is fixed.
3. The unsafe host-execution path is not a sandbox. The audit document records that delegated Bash can inherit the host process environment; this document does not claim credential isolation.
4. Report repair is intentionally bounded to one same-session, tool-free attempt. It cannot recover a cancellation, terminal timeout, exhausted turn budget, or runtime stream failure, and an invalid repair leaves the original observed artifact unverified.
5. A malformed report preserves only bounded projections. Raw transcripts, arbitrary payloads, and unbounded tool output are not automatically ingested into the parent.
6. Durable background jobs persist terminal metadata and bounded results but do not resume an in-flight model session after restart. Retention can expire the full result while leaving a terminal tombstone.
7. The repository contains historical planning text that still describes result ingestion as deferred in some sections. The current implementation source, tests, guide, and changelog cited above are the more specific evidence for this feature; the historical text should be reconciled in a future documentation cleanup.
8. Follow-up verification should run the focused result-contract, subagent, timeout, job, and view suites, then record exact commands and outcomes. A Git-aware inspection should separately establish the branch, current `HEAD`, and whether this documentation file is committed.
