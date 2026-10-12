# Subagents V2 architecture

This page is for contributors maintaining ICE's subagent implementation. For user behavior and configuration, see [Subagents V2](subagents-v2.md) and the [reference](subagents-v2-reference.md).

## Ownership boundary

The parent Ice `AgentSession` remains the authoritative model/tool loop. Subagents V2 does not add a planner, provider client, model registry, or competing loop. Each child is another ordinary `AgentSession` created through the coding-agent runtime and the existing Ice model/runtime services. The V2 layer owns definition resolution, capability derivation, frozen child contracts, child lifecycle/persistence, bounded result handling, approvals, and optional Git worktree patches.

The ICE launcher at `packages/coding-agent/src/ice.ts` installs the hidden V2 extension into the normal CLI. `packages/coding-agent/src/subagents/v2/extension.ts` registers the three model-facing tools and Hub commands; `runtime.ts` delegates execution to the existing session machinery. There is no feature gate or legacy tool set in the current launcher.

## Request and launch path

A new child follows this sequence:

1. The parent session and current trusted-project state are resolved.
2. V2 loads agent definitions and reports invalid, untrusted, disabled, shadowed, and managed definitions separately.
3. Preflight resolves the definition, model candidate, parent-active/child-safe tools, task scope, selected resources, MCP adapter fingerprints, permission rules, mode, budgets, hooks, and optional worktree baseline.
4. The runtime creates a `ChildRuntimeContract`, canonicalizes and hashes it, and durably persists the registry acceptance and child-session contract **before** the child can make a provider/tool call.
5. A child `AgentSession` is created with the frozen tools and tool-boundary guard. It shares the established Ice runtime, not the parent's transcript or an alternate model loop.
6. The per-owner concurrency pool, cancellation signal, approval broker, hooks, result observations, and optional turn budget surround that ordinary session.
7. The turn result is validated against the bounded local result contract and host-observed file dispatches, persisted, projected to the parent, and—when backgrounded—delivered once through the parent session queue.

Important implementation entrypoints:

- `src/ice.ts` — ICE startup composition.
- `src/ice-safe-verify.ts` — parent plan/build and verifier gates.
- `src/subagents/v2/extension.ts` — model/tool and Agent Hub integration.
- `src/subagents/v2/runtime.ts` / `runtime-support.ts` — launch, resume, permissions, results, and lifecycle coordination.
- `src/subagents/v2/session-factory.ts` — child `AgentSession` construction and tool guards.
- `src/subagents/v2/settings.ts` — current V2 settings schema/merge.
- `src/subagents/definitions/` — parsing, discovery, built-ins, precedence, and model-visible listing.
- `src/subagents/contract/` — frozen contract serialization, hashing, and resume validation.
- `src/subagents/permissions/` — rule parsing, subject extraction, evaluation, child ceilings, and approval broker.
- `src/subagents/registry/` — durable owner-scoped journal, state machine, session files, and FIFO admission.
- `src/subagents/isolation/` — baseline capture, worktree creation, patch artifacts, apply/rollback checks.
- `src/subagents/results/` — task/result schemas, validation, assurance, and output artifacts.
- `src/subagents/runtime/` — hook/resource context and live child session support.
- `src/subagents/ui/hub.ts` and `src/ice-agent-view-bridge.ts` — Hub projections and integration into the existing interactive shell.

## Frozen authority contract

`ChildRuntimeContract` is the child's authority snapshot, not a prompt or a model-authored plan. It records the owner/root lineage, agent/source hashes, resolved prompt/resources, exact model/thinking selection, child tools and adapter fingerprints, rule origins, scope roots/targets, parent and child modes, recursion ceiling, worktree baseline, acceptance/result contract, and optional budgets.

The contract is persisted before launch and hash-checked on reopen. A resume does not re-resolve changed agent frontmatter into new authority. It validates the frozen contract against current owner, parent tools/mode, trust, model availability, adapters, and policy; loss of authority blocks continuation. Definition/settings changes affect a new launch, not an already accepted child.

## Lifecycle and recovery

Child instance state and the latest turn outcome are separate. A successful turn normally leaves the instance `idle`; it is not a terminal child. Instance states are `starting`, `running`, `idle`, `parked`, `stopping`, `blocked`, `aborted`, and `deleted`. Turn outcomes are `completed`, `failed`, `cancelled`, `interrupted`, and `budget_exhausted`.

The `ChildRegistry` is owner-session scoped and is the lifecycle authority. It persists acceptance before launch, checks generations on transitions, journals tombstones before cleanup, and records background completion delivery before sending a follow-up. Child transcripts are stored under `<parent-session-dir>/subagents/<parent-session-id>/`; the first custom entry contains the hashed runtime contract.

On process restart, resident children park. An in-flight turn is marked interrupted. Unfinished tool calls are described in a recovery notice but are never replayed because the effect may already have happened. Explicit resume creates a new turn only after contract and authority checks. Cancellation of an already executing shell/MCP/provider operation is cooperative; do not describe it as transactional rollback.

Optional budgets surround the normal Ice request/tool seams. They have no default lifetime deadline. When a budget is exhausted, ordinary work is stopped and one bounded tool-free wrap-up request may run (up to 1,024 output tokens and 30 seconds). `maxTokens` counts provider-reported uncached input, cache writes, and output; cache reads are excluded. Budgeted tasks temporarily disable automatic retry/compaction paths that could exceed their envelope. Usage-based token tracking is not a hard billing limit.

## Permission derivation

The same evaluator handles parent and child tool subjects. Rules are matched for each tool/path/command subject; the most restrictive match wins. Plan/review mode limits are applied after rules and cannot be raised. Unknown adapters fail safe.

Child capabilities are monotonic: for a given operation, a child never gets a more permissive decision than the parent. In addition, child mutation classes begin at `ask` by default. Only the documented user/managed allow, authorized `--sub-yolo`, and worktree edit/write raisers can raise that child ceiling, and the result remains capped by the parent. Project rules only narrow. `sub-yolo` is authorized by `extension-support.ts` only with explicit build mode, project trust, parent startup Bash, and an approval-capable interactive context. It does not sandbox host effects.

Permission asks are mediated by `ApprovalBroker`: automated decisions are checked first, foreground asks use the parent UI, background asks wait for the interactive Agent Hub inbox, and no approval channel, timeout, cancellation, disconnect, or disposal denies. No child-side prompt is treated as approval.

## Worktree patch boundary

The worktree implementation snapshots staged, unstaged, and supported untracked content into an isolated baseline, preserving the parent's dirty state. Child output is a delta against that captured baseline. Patch bytes and ownership metadata are validated before inspection/application; integration verifies expected preimages and postimages and uses compare-before-rollback to avoid overwriting newer edits. Parent staging is preserved.

This is an optimistic-concurrency design, not an atomic filesystem transaction or sandbox. Worktrees share Git objects, the child process still has host process/network/credential boundaries, and unsupported nested repositories/submodules and other unsafe path/layout cases are refused. `agent_patch apply` without a configured verifier is recorded as unverified. A verifier command is parent-owned (`--ice-verify`); model text cannot select it.

## Results and observability

Model-authored reports are untrusted. V2 validates the local schema, bounded acceptance claims, and available runtime observations; it does not infer semantic correctness from fluent text. Assurance is limited by evidence that the host actually observed. An `outputSchema` can validate structure but cannot certify that a claim is true or that a command succeeded unless that fact is observed.

The `ice:subagent` event channel is projected from registry changes and contains bounded lifecycle metadata only. Prompts, transcripts, final results, and secrets do not belong in that channel. Hook intents/outcomes are separately journaled, redacted, and size-bounded.

The UI reuses the existing `InteractiveMode` through `IceAgentViewBridge`. The Agent Hub is a projection/control surface over the registry; it is not an independent scheduler, session store, or child renderer.

## Tests and verification

Focused V2 coverage is in `packages/coding-agent/test/`:

- `subagents-v2-contracts.test.ts`, `subagents-v2-contract-runtime.test.ts`
- `subagents-v2-definitions.test.ts`, `subagents-v2-permissions.test.ts`
- `subagents-v2-registry.test.ts`, `subagents-v2-extension.test.ts`
- `subagents-v2-hub.test.ts`, `subagents-v2-worktree.test.ts`
- `subagents-v2-cli-events.test.ts`
- `suite/subagents-v2-runtime.test.ts`, `suite/subagents-v2-budget.test.ts`, `suite/subagents-v2-hooks.test.ts`, `suite/subagents-v2-results.test.ts`

Run focused tests from `packages/coding-agent` with the repository's installed Vitest CLI, for example:

```bash
node ../../node_modules/vitest/dist/cli.js --run \
  test/subagents-v2-permissions.test.ts \
  test/subagents-v2-registry.test.ts \
  test/subagents-v2-worktree.test.ts \
  test/suite/subagents-v2-runtime.test.ts
```

Use the faux provider and harness for automated runtime tests; do not turn unit tests into live provider requests. The rewrite plan records live-provider/UI dogfood as not run. Passing deterministic tests does not certify a live provider adapter, terminal interaction, host sandbox, or semantic correctness.

## Current limitations

- V2 is wired by the `ice` launcher. A dedicated public SDK `agents` option and dedicated RPC agent-management API remain deferred; generic RPC/tool interfaces are not a dedicated V2 API contract.
- Live provider and live TUI dogfood remain separate from faux-provider automated coverage.
- Worktree isolation does not constrain child processes, network, or credentials.
- Interrupted non-idempotent effects cannot be reconstructed or retried automatically.
- Parent-session cascade cleanup and some optional navigation/integration proposals remain plan items; consult the latest phase summary in the [rewrite plan](https://github.com/Zykairotis/ice/blob/void/Plan/subagent-rewrite.md), not its intermediate phase rows.
