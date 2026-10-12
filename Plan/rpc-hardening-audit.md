# RPC hardening: implementation and verification ledger

Scope: coding-agent JSONL RPC and native session mutation notifications consumed by RPC, not `packages/protocol`, server/client, or remote-session. Existing uncommitted RPC/session/shell/subagent work was preserved. No build, live provider request, snapshot publication, or commit was performed.

## Additional findings beyond the supplied inventory

| Finding | Evidence / failure scenario | Status |
|---|---|---|
| JSON primitives can break the error path itself | Previously `handleInputLine` cast parsed `null` to a command and then read `command.id` in its catch. The new faux-provider regression reproduced an unhandled rejection. | Fixed: validate envelopes before dispatch. |
| Void client methods silently accept server failures | `prompt`, `steer`, aborts, toggles, reload, and labels awaited `send()` without calling `getData()`. Failed responses resolved normally. | Fixed centrally in `send`; synthetic-child wire tests cover all void wrappers. |
| A self-unsubscribing event listener skips the next listener | `handleLine` iterated the mutable listener array. A `collectEvents` listener removed itself on `agent_settled`, shifting the following `waitForIdle` listener past the iterator. A regression reproduced its timeout. | Fixed with snapshot iteration. |
| Failed prompt submission leaks an event collector | `promptAndWait` started `collectEvents` before sending the prompt, but had no cancellation path if submission rejected. Its listener and timer remained; its later rejection could be unhandled. | Fixed with abortable collection, immediate rejection observation, and finally cleanup. |
| Listener exceptions are hidden as parse errors and stop delivery | Previously JSON parsing and subscriber delivery shared a catch. | Fixed: isolate parsing/subscriber/reporting failures, continue other listeners, and expose `onListenerError`. Tested with a throwing subscriber and reporter. |
| Client stderr retention is unbounded and crosses starts | Long-running child logs grew the retained string; old stderr contaminated later process errors. | Fixed: retain latest 65,536 characters and reset per process. Host stderr forwarding remains unchanged and unredacted. |
| Client startup is a timing heuristic | Previously `start()` slept 100 ms instead of checking readiness. | Fixed: bounded protocol-v1 capability handshake, malformed/silent responses fail closed, and failed startup stops the child. Older runtimes without discovery are not supported by this client. |
| Extension UI transport lacks complete client typing/reply helpers | Previously subscribers were typed only as agent events and no dialog reply writer was exposed. | Fixed: exported `RpcEvent` union and `respondToExtensionUI`, preserving original dialog ID and allocating no pending command request. |
| Client stop can drop pending request cleanup | Previously stop cleared the map after shutdown without explicitly rejecting it. | Fixed: reject pending requests and idle/event collectors before detaching stdout/terminating the captured child. Cleanup removes timers/subscriptions. Preserve the first terminal cause instead of overwriting deliberate stop with SIGTERM exit. |
| Response correlation trusts arbitrary matching-ID envelopes | Previously a response with the right ID but wrong command/missing success flag could resolve a request. | Fixed: command/envelope validation and `invalid_response`; method-specific success payload validation remains incomplete. |
| Retired prompt contexts can replace from their own model hooks | RPC coordinator contexts extend into the accepted model run; teardown then waits on the hook invoking replacement. | Fixed: retire preflight synchronously and guard hook-owned replacements; faux `agent_start` regression proves no runtime replacement starts. |

## Implemented protocol improvements

- `get_capabilities`: version, exhaustive command inventory, feature flags, host subagent-bridge availability, and input limit. Inventory and validation use one map, checked against every `RpcCommandType`.
- Envelope/field validation before mutation: strings, enums, booleans, image shape, model scopes, safe integer shell cursors, structured invocation envelopes, and dialog response primitive types. Settings retain their existing authoritative validator.
- 16 MiB UTF-8 input-record cap; oversize records are reported once and discarded through their LF, with recovery for the next record. The generic output reader remains unrestricted. Fragment storage avoids repeated whole-line reconstruction and bounds small-fragment overhead.
- All generated errors now carry a code, defaulting to `failed`; invalid requests/arguments, unknown commands, and selected busy/not-found paths are explicitly classified. Full domain-error classification remains incomplete.
- `get_queue` / `clear_queue`: pending text snapshots and removed text. IDs still arrive through existing `queue_update` events; snapshots do not yet expose IDs or attachment data.
- Request-specific `cancel_request` for `compact`, `navigate_tree`, and direct RPC `bash`; optional integer `timeoutMs` (1–300,000) starts at validated admission, including queue time. Cancelled queued work never dispatches, but its admission/barrier remains until predecessors settle. Native controllers retain operation ownership; listeners and deadline timers detach at settlement. Cancellation does not call global session abort or abort neighbouring Bash operations. Active duplicate IDs fail without replacing original ownership. Live cancellation bypasses the admission ceiling.
- Native `compact`, `navigateTree`, and `executeBash` accept caller signals. Pre-save/pre-navigation checks suppress cancelled summaries, while already-committed checkpoints/navigation/external effects and partial cancelled Bash history remain evidence, not rollback. Cancellation after a saved manual checkpoint suppresses queued continuation. Signal-ignoring hooks keep the operation/barrier pending until settlement.
- `RpcClient` exports `RpcOperationOptions`, forwards server deadlines, and converts caller signals/local response timeouts into generated-ID cancellation requests. Already-aborted signals and invalid deadlines fail before submission. Local rejection explicitly does not certify remote settlement; late responses are ignored, and no interrupted effect is replayed.
- `prompt.expandPromptTemplates`, client streaming behavior, and client Bash context exclusion.
- Backward `cycle_model`, `switch_session.cwd`, effective thinking level in `set_thinking_level` response, and session location/persistence metadata in `get_state`.
- Extension working-message, visibility, and indicator requests.
- Prompt-template argument hints and documentation for structured command schemas/invocation.
- Native `model_changed` omits current/previous private request headers before any subscriber or JSON transport observes it. Effective `configuration_changed`, settings-application invalidation, resource reload/skill-refresh invalidation, and all-entry/explicit-leaf notifications. `SessionManager.subscribe` observes local appends and branch/reset, not historical loading or multi-process writes; AgentSession owns forwarding and detaches on disposal. Custom extension appends are not duplicated.
- Cached `get_providers` / `get_models`, with non-secret auth status, all/available/provider catalog filtering and local error presence. They do not resolve credentials or refresh. The new model-catalog projection omits request headers.
- Entry/session count pagination (1–1000), append-ID/path cursors, deterministic session ordering, and literal case-insensitive local session search (query capped at 256 UTF-16 code units). Pages are live observations, not frozen snapshots; item limits do not bound scan work or one item's bytes. Full tree/messages and catalogs remain unpaged.
- Explicit `refresh_models`, cache-only default, optional network/force/provider selection, `ICE_OFFLINE` denial, cooperative 1–30,000 ms cancellation deadline, live `abort_models_refresh`, generic per-provider failures and `models_changed`. Current selected metadata is reconciled without fallback; timeout/cancellation never promises rollback. This explicit operation uses existing runtime auth/availability rules, unlike pure cached introspection.

## Important remaining design work

Lifecycle ordering is implemented at the RPC admission boundary. `RpcCommandCoordinator` reserves latches synchronously: transitions wait earlier admitted commands and later commands wait transitions. Short mutations, including prompt preflight, run in wire order; pure snapshots remain concurrent. Prompt admission lasts only through preflight. Aborts, dialog replies, subagent approval answers, stop-after-turn, shell release/kill, and capability discovery bypass. Manual compaction remains shared so prompts can still queue. Extension command actions use the same barrier with caller exclusion; a nested or dependency-cyclic transition is rejected `busy`. Completed async contexts do not retain an exclusion, and contexts entering model/compaction/Bash hooks cannot invoke teardown that waits on their own operation. Runtime-owned rebinding is no longer duplicated. `session_changed` emits once after rebind, including extension actions, with previous/current ID, cwd, optional file and leaf.

Barrier tests cover every replacing wire command, adjacent prompts/queries, queued transitions, preflight-vs-streaming lifetime, cancellation/failure release, extension-initiated replacement, nested hooks, stale async contexts, reload introspection, abort and dialog liveness. Arbitrary direct SDK/extension mutations outside host command actions remain unguarded. Transition failure releases queued requests but does not recover or roll back a runtime already disposed by failed creation. Pending admissions are capped at 256 with `busy` before dispatch; live controls bypass the ceiling. Shutdown/EOF ordering, aggregate transport/output memory, cancellation support for other command families, and stalled hooks remain open.

Automatic catalog/auth changes outside the explicit RPC refresh, external settings-file watching/direct manager mutation notification, complete domain error codes, cancellation/deadlines outside the three supported command families, remaining tree/message/catalog pagination, detailed redacted diagnostics, file attachment/completion design, widget text projections, session deletion, and the ICE-specific items remain open. Runtime success payload validation, aggregate input/output memory and control-request bounds, EOF/shutdown races, and strict hard deadlines for non-cooperative extensions remain open. No credential-editing/login/logout/trust controls or competing registry were added. Explicit network catalog refresh can exercise the existing runtime's configured auth helpers and token-refresh persistence; it is not a pure read.

## Verification

Provider-free targeted commands are run from `packages/coding-agent` using `node ../../node_modules/vitest/dist/cli.js --run` with:

- `test/suite/rpc-contract.test.ts`
- `test/rpc-command-coordinator.test.ts`
- `test/session-manager-events.test.ts`
- `test/suite/agent-session-configuration-events.test.ts`
- Native model/extension, runtime, prompt, compaction and queue characterization, replaced-context, duplicate-rebind and runtime-settlement regressions (see final command report).
- `test/rpc-client-contract.test.ts`
- `test/rpc-request-tracker.test.ts`
- `test/suite/agent-session-operation-cancellation.test.ts`
- `test/rpc-validation.test.ts`
- `test/rpc-jsonl.test.ts`
- `test/rpc-client-clone.test.ts`
- `test/rpc-client-process-exit.test.ts`
- `test/rpc-prompt-response-semantics.test.ts`
- `test/suite/rpc-introspection.test.ts`
- `test/suite/rpc-subagents.test.ts`
- `test/rpc-settings.test.ts`
- `test/rpc-command-schema.test.ts`
- `test/suite/regressions/5868-rpc-unknown-command-id.test.ts`
- `test/suite/regressions/7150-rpc-prompt-during-compaction.test.ts`

Repository gate: `corepack npm@12.0.2 run check` (active npm also 12.0.2). The existing unknown-command regression now additionally asserts the machine-readable code while preserving its request-ID assertion. Previous batch verification: 216 tests passed across 24 files. The latest request-cancellation verification passed 165 RPC tests across 18 files (`bash-8`) plus 96 native operation/queue/settlement tests across 15 files (`bash-9`): 261 passing tests across 33 passing files. Two API-key-gated e2e files (15 tests) were skipped; no live model requests ran. An initial test invocation from the wrong directory (`bash-7`) was stopped and is not counted. Final `git diff --check` and `corepack npm@12.0.2 run check` passed (`bash-10`), including formatting, dependency pins, imports, shrinkwrap/install-lock, TypeScript and browser-source smoke checks; the final check applied no fixes. Earlier callback-signature, unused-import and intentional-stop-cause failures were repaired and are covered by subsequent passing checks. The earlier follow-up reviewer exhausted its tool budget without inspecting the final coordinator. The bounded resumed tracker/client cancellation review also exhausted its budget before substantive inspection and asserted no findings or verdict. No independent approval is claimed; passing tests and parent source inspection are the evidence for this batch. Source checks are not installed-runtime or Curax snapshot certification.
