# Removal of aggregate subagent token budgets

> **Historical implementation snapshot.** This note describes V1 aggregate-budget removal and does not define current V2 per-task budgets. See the [current V2 guide](../packages/coding-agent/docs/subagents-v2.md) and [budget reference](../packages/coding-agent/docs/subagents-v2-reference.md).

## Scope and status

This note documents the aggregate-token-budget removal visible in the checked-out
`subagent-token-budget-removal` worktree. It is documentation for the current
tree, not a claim about a particular commit or release.

The implementation files and the package changelog already present in this
worktree describe the removal. This file is the only file created by this
pass and is **uncommitted**. Git metadata and status are not available through
the read/search-only tools used for this pass, so the commit state of the
pre-existing implementation and changelog changes cannot be independently
classified here. The branch HEAD identity is likewise not independently
verified.

## What was removed

The old aggregate subagent token ceiling was an authority/enforcement
mechanism. The checked-out implementation no longer exposes or enforces that
ceiling for an individual child, a durable child job, or a sibling batch.
Token counts remain usage data.

The package changelog records the intended boundary explicitly: aggregate
subagent token-budget controls and enforcement are removed, while turn,
tool-call, timeout, output-byte, and batch output reservations remain
authoritative (`packages/coding-agent/CHANGELOG.md`). The checked-out handoff
also records the same completion semantics in `.ai-bridge/current-plan.md`.

This change is narrower than removing every use of the word “budget”:
provider-specific thinking budgets and compaction/context budgets are separate
features. The batch output ledger is also retained; its unit is serialized
output bytes, not model tokens.

## Resulting behavior and API/settings surface

### Usage is observational

`SubagentUsage` still carries:

- `inputTokens`
- `outputTokens`
- `cacheReadTokens`
- `cacheWriteTokens`
- `cost`

`SubagentResult.usage` remains available when usage is observed, and batch and
review results continue to expose aggregate usage. The current user guide
states that these values do not authorize or enforce an aggregate token
ceiling (`packages/coding-agent/docs/subagent-user-guide.md`). Consumers should
therefore use them for reporting, diagnostics, and accounting displays—not as
a termination or admission signal.

### Remaining execution limits

The effective child contract contains `timeoutMs`, `maxTurns`,
`maxToolCalls`, and `maxOutputBytes`; it does not contain a token ceiling.
The batch contract retains `totalBudgetBytes`, which reserves and reconciles
the complete parent-facing serialized report size. Batch preflight and the
`SubagentBatchBudget` result describe output-byte reservations and their
settlement, not token consumption. These surfaces are defined in
`packages/coding-agent/src/ice-subagents.ts`.

Durable jobs likewise retain planned/reserved output-byte metadata. The job
inspection `budget` object reports `plannedOutputBytes`,
`reservedOutputBytes`, `ownerReservedOutputBytes`, and `ownerBudgetBytes`.
`SubagentJobContract` has execution and output fields but no aggregate token
field (`packages/coding-agent/src/ice-subagent-jobs.ts`).

### Removed names are rejected at input boundaries

The removal is not a silent ignore or an alias:

- `ice.subagents.defaults.maxTotalTokens` and
  `ice.subagents.restrictions.maxTotalTokens` are rejected by settings parsing.
- A per-call execution override containing `maxTotalTokens` is rejected before
  the child is launched.
- A batch option containing `totalTokenBudget` is rejected before batch tasks
  are launched.

The rejection messages direct callers to the remaining execution controls.
The relevant checks are in
`packages/coding-agent/src/ice-subagent-settings.ts` and
`packages/coding-agent/src/ice-subagents.ts`; the public batch schemas expose
`totalBudgetBytes`, not `totalTokenBudget`.

## Migration and usage implications

1. Remove `maxTotalTokens` from `ice.subagents.defaults`, role preferences, and
   restrictions. Configure `maxTurns`, `maxToolCalls`, `timeoutMs`, and
   `maxOutputBytes` according to the desired operational bound.
2. Remove `totalTokenBudget` from batch/review calls. If the requirement is to
   bound the parent-facing result volume, use `totalBudgetBytes`; do not treat
   that field as a token approximation.
3. Do not expect a replacement aggregate token cap. A child may continue until
   another authoritative limit, cancellation, provider/runtime failure, or
   deadline applies. Usage telemetry can be inspected after or during the
   supported reporting flow, but it is not an enforcement control.
4. Update integrations that read a result-level `budget` token summary. The
   durable result envelope strips the legacy `budget` field; use `usage` for
   token/cost observations and the job/batch output-byte metadata for output
   reservations.
5. Existing persisted durable snapshots receive a narrow compatibility
   normalization: `maxTotalTokens` is removed from the persisted job contract
   and the legacy result `budget` field is removed before validation, then the
   normalized snapshot is rewritten. This behavior is implemented in
   `packages/coding-agent/src/ice-subagent-jobs.ts` and does not imply that new
   configuration or API requests accept the removed names.

The normalization is intentionally limited. It does not claim to migrate
arbitrary historical schemas, reconstruct token usage, or restore an in-flight
model session after restart.

## Rationale visible from the tree

No detailed prose rationale for the decision is present in the checked-out
changelog or handoff; those records state the resulting policy rather than a
full design narrative. The following is therefore an evidence-based
interpretation, not an independently confirmed historical explanation:

- The implementation models token values as usage telemetry (`SubagentUsage`)
  and keeps them in result and durable-report projections.
- Enforcement is moved to directly bounded, operational controls: turns, tool
  calls, elapsed time, UTF-8 output bytes, and batch output reservations.
- Provider/runtime failures remain distinguishable from explicit cancellation
  and genuine deadline outcomes in the user guide, rather than being presented
  as token-budget exhaustion.

This separation avoids documenting token observations as an authority boundary
while retaining deterministic controls that the parent can directly bound and
verify. It should not be read as a claim about motivations not recorded in the
repository.

## Verification evidence

The following evidence is present in the checked-out files:

- `packages/coding-agent/test/ice-subagent-settings.test.ts` asserts that
  `maxTotalTokens` is rejected in both defaults and restrictions.
- `packages/coding-agent/test/ice-subagents.test.ts` asserts that
  `totalTokenBudget` is rejected before `runResolved` is called.
- `packages/coding-agent/test/ice-subagent-jobs.test.ts` asserts that usage is
  persisted without aggregate token authority and that legacy persisted
  `maxTotalTokens`/`budget` fields are removed and rewritten during restore.
- `packages/coding-agent/docs/subagent-user-guide.md` documents observational
  usage, the remaining execution/output limits, rejected legacy fields, and
  durable-snapshot normalization.
- `.ai-bridge/current-plan.md` reports a focused removal/error-classification
  matrix of 352/352 passing tests across 7 files and an exact root
  `corepack npm@12.0.2 run check` pass.

The last two checks are recorded claims from an existing handoff, not commands
run by this documentation-only pass. No tests, package checks, builds, or
provider calls were run here. Consequently this note does not independently
certify runtime behavior or reproduce those reported exit statuses.

## Limitations

- Token telemetry depends on what the provider/runtime reports or what the
  existing usage observer can derive; telemetry availability and precision are
  not an enforcement guarantee.
- Removing aggregate token authority means cost/token observations cannot stop a
  child or reserve a token allowance. Use the remaining time, turn, tool-call,
  output-byte, cancellation, and policy controls for bounded execution.
- `totalBudgetBytes` limits serialized parent-facing output and is not a model
  token budget; token-to-byte conversion must not be assumed.
- The persisted-snapshot normalization is narrow and one-way for the removed
  fields. Keep backups and validate any older or externally produced snapshot
  format before relying on restoration.
- This document records source and test evidence only. It does not claim that
  all downstream consumers, user configuration files, or external clients
  have been migrated.
