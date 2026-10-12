# RPC Mode

RPC mode enables headless operation of the coding agent via a JSON protocol over stdin/stdout. This is useful for embedding the agent in other applications, IDEs, or custom UIs.

**Note for Node.js/TypeScript users**: If you're building a Node.js application, consider using `AgentSession` directly from `@zykairotis/ice-coding-agent` instead of spawning a subprocess. See [`src/core/agent-session.ts`](../src/core/agent-session.ts) for the API. For a subprocess-based TypeScript client, see [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts).

## Starting RPC Mode

```bash
ice --mode rpc [options]
```

Common options:
- `--provider <name>`: Set the LLM provider (anthropic, openai, google, etc.)
- `--model <pattern>`: Model pattern or ID (supports `provider/id` and optional `:<thinking>`)
- `--name <name>` / `-n <name>`: Set the session display name at startup
- `--no-session`: Disable session persistence
- `--session-dir <path>`: Custom session storage directory

### ICE subagent execution authority (V2)

The `ice` launcher installs Subagents V2 as extension tools. RPC clients observe them with `get_subagents` and `subagents_update` events and answer background approvals with `respond_subagent_approval` (see [Subagents](#subagents)); the model drives children through the `agent` and `agent_control` tools. To authorize child mutation capabilities without an interactive per-call approval, start an explicitly trusted build session with all required flags:

```bash
ice --mode rpc \
  --ice-mode build \
  --ice-allow-bash \
  --approve \
  --sub-yolo
```

`--sub-yolo` raises only the child mutation ceiling for operations the parent is already authorized and able to perform. It requires explicit build mode, project trust, startup-authorized parent Bash, and an approval-capable RPC session. It cannot override deny rules, scope, plan/review restrictions, missing parent tools, or parent policy. Without it, child mutations follow the configured `allow`/`ask`/`deny` rules and parent approval; if no approval channel is available, an `ask` is denied. See [Subagents V2](subagents-v2.md) for the complete permission model.

This is not a sandbox. Child processes still run with the host user's filesystem, process, network, and credential access; worktree isolation only separates files for review. MCP tools require explicit child selection and dispatch through the parent's already-authorized adapter. Recursive delegation is disabled by the default depth of zero and requires configured `spawns` plus an allowed `maxDepth`. Patches are inspected and explicitly integrated through `agent_patch`; the legacy `delegate_write` tool is not part of the current API.

### ICE external host filesystem access

`--allow-external` is a separate, explicit parent capability for trusted build sessions. It permits the parent’s guarded `edit`, `write`, and writer-integration path to address absolute paths outside the current project root:

```bash
ice --mode rpc \
  --ice-mode build \
  --allow-external \
  --approve
```

The flag requires explicit build mode, an approval-capable TUI or RPC client, project trust, and no `--no-approve`. In this authorized build context, registered parent MCP tools named `mcp` or `mcp__*` are also available; they remain blocked in plan mode, untrusted projects, and headless sessions. This does not imply `--sub-yolo`: child mutation authority has separate gates. V2 child path access remains bounded by the parent's tools and policy plus the task scope; worktree-isolated tasks must stay inside the repository. Child MCP tools require explicit selection and use the parent's already-authorized adapter.

`--allow-external` is unrestricted host access, not a sandbox. It does not contain shell commands, processes, network access, credentials, symlinks, or descendants; a registered MCP integration may itself have external or credential-backed effects. It does not imply `--sub-yolo`: V2 child access remains bounded by the parent's authority, child policy, and task scope. Child MCP tools still require explicit parent-owned adapter selection. Use this capability only in a trusted worktree with explicit user approval.

## Protocol Overview

- **Commands**: JSON objects sent to stdin, one per line
- **Responses**: JSON objects with `type: "response"` indicating command success/failure
- **Events**: Agent events streamed to stdout as JSON lines

All commands support an optional `id` field for request/response correlation. If provided, the corresponding response will include the same `id`. `bash_execution_update` events also include the `id` of their originating `bash` command.

### Feature discovery

Send `{"type":"get_capabilities"}` before relying on optional commands. Its response data contains `protocolVersion: 1`, the supported `commands` array, a `features` array, `limits.maxInputLineBytes` (currently 16 MiB), `limits.maxPendingCommands` (currently 256 admitted/queued commands), and `host.subagents` (whether this host installed a subagent bridge). Command support does not imply authorization or that a runtime resource exists. An older snapshot without this command returns an unknown-command error; cache that discovery result for that process only.

### Session-transition ordering

`new_session`, `switch_session`, `fork`, `clone`, `import_session`, `reload`, and `navigate_tree` install a barrier synchronously when their input record is received. They wait for earlier admitted commands, and later session-dependent commands wait for replacement/navigation/reload and RPC rebinding to finish. Prompt admission ends at preflight acceptance or rejection, not at the end of streaming; runtime replacement still settles the accepted outgoing turn. Short mutation commands (including prompt preflight, model/settings/tool updates, queue writes, structured commands, and `get_commands` skill refresh) execute in wire order through completion/acceptance. Pure snapshots remain concurrent outside transition barriers. Long Bash and compaction operations retain their full operation latch for replacement safety but do not occupy the short-mutation lane. Manual compaction remains concurrent with prompts so input can still be queued during compaction.

Abort commands, extension dialog replies, subagent approval answers, `stop_after_turn`, `kill_shell`, `background_bash`, and capability discovery bypass the barrier. They address the currently bound session, not a future session. Except for `cancel_request` targeting a supported operation, these controls do not cancel a queued transition or prompt preflight; an abort before a waiting prompt is accepted does not prevent that prompt from starting later. Extension command-context replacements, navigation, and reload use the same barrier. A nested extension transition, a transition with a dependent queued mutation, or a replacement called from an active model/tool/compaction/Bash hook fails with `busy` rather than waiting on itself. Extension runners may turn a rejected hook action into `extension_error` while the outer operation continues. A cancelled or failed transition releases waiting requests; failure does not imply rollback of the runtime or external effects. Arbitrary direct SDK or extension state mutations outside these host command actions are not serialized.

At most 256 session-dependent commands and 32 MiB of retained UTF-8 input can be admitted or queued at once. Overflow is rejected before dispatch with `busy`; capacity returns after handling/response settlement. Live controls have a separate reserved lane of 64 requests and 1 MiB, so normal traffic cannot consume their capacity. At most 64 extension dialogs may wait; additional dialogs resolve to their cancellation/default value. These byte budgets bound serialized traffic retained by the adapter, not total process heap, native session history, provider buffers, or one stream chunk already supplied by Node.

### Request-specific cancellation and deadlines

Check for the `request_cancellation` feature. `get_capabilities.cancellation` lists supported commands (`compact`, `navigate_tree`, `bash`), with `cooperative: true` and `includesQueueTime: true`; `limits.maxRequestTimeoutMs` is 300,000.

These three commands accept optional integer `timeoutMs` from 1 to 300,000. Omitted means no server deadline. The deadline starts when a validated record arrives, including time waiting for a transition. Expired/cancelled queued commands never dispatch. Other commands reject `timeoutMs`, except `refresh_models`, which retains its separate documented deadline and abort contract.

```json
{"id":"operation-1","type":"compact","timeoutMs":120000}
{"id":"cancel-1","type":"cancel_request","requestId":"operation-1"}
```

`cancel_request` bypasses transition barriers and uses the reserved control lane. Any session-dependent command can be cancelled **while queued**, including replacement and short mutations; `get_capabilities.cancellation.queuedCommands` lists them. Once dispatched, only the three native signal-aware operations support request-specific cancellation; unsupported running operations return `false` rather than pretending to interrupt effects. Unknown, completed, and already-signalled targets also return `false`. Acceptance is **not** an acknowledgement that the operation stopped. Active command IDs must be unique; a duplicate is rejected with `invalid_request` without replacing the original ownership. Do not reuse an ID after a local timeout until remote settlement is known.

The original request returns one terminal response after its admission/operation settles: request cancellation uses `success:false, errorCode:"cancelled"`; deadline expiry uses `errorCode:"timeout"`. Its barrier remains installed until predecessors and native work settle, even after its signal fires. A cancelled queued navigation does not let later reads overtake an earlier replacement. Native operation-wide abort commands remain available and keep their existing scope.

Cancellation links only to the request's locally owned compaction, navigation, or Bash controller—not `session.abort()` or another Bash operation. Already-aborted native SDK calls cannot spawn Bash, move the leaf, or preempt the agent. Pre-navigation/compaction checkpoints prevent a cancelled generated summary from being saved. Cancellation after a checkpoint/navigation/external effect committed does **not** roll it back; partial cancelled Bash output remains recorded in history and may already have streamed. Cancellation in a delayed `user_bash` hook prevents host fallback after that hook returns, but cannot undo an extension's own effects or interrupt a hook that ignores cancellation. Do not replay an ambiguous timeout automatically.

`RpcClient.compact(instructions?, {signal?, timeoutMs?})`, `navigateTree(targetId, {signal?, timeoutMs?, ...navigation})`, and `bash(command, {signal?, timeoutMs?, excludeFromContext?})` expose this contract using exported `RpcOperationOptions`. Signals are local objects, never serialized; the client sends `cancel_request` with its generated wire ID. An already-aborted signal or invalid deadline rejects before writing the operation. The existing 30-second local response bound remains when no server deadline is requested; an explicit deadline gets five additional seconds for settlement/response. Caller aborts reject the local wait promptly, and local response timeouts request cancellation best-effort. These local failures do not confirm remote settlement. Listener/timer cleanup covers success, error, abort, timeout, and process stop. `cancelRequest(requestId)` returns the acceptance flag for raw wire IDs.

Deadlines are cooperative, not hard termination guarantees. A non-cooperative provider, auth helper, hook, or process operation can keep a server request/barrier pending beyond its deadline. No new retry, provider, or cancellation loop is introduced. Arbitrary active extension commands and session factories have no per-request interrupt contract; cancelling queued admission does not make their running effects replay-safe.

### Framing

RPC mode uses strict JSONL semantics with LF (`\n`) as the only record delimiter.

This matters for clients:
- Split records on `\n` only
- Accept optional `\r\n` input by stripping a trailing `\r`
- Do not use generic line readers that treat Unicode separators as newlines
- Input records are limited to 16 MiB of UTF-8 bytes, excluding LF (a CR in CRLF counts). Oversized input produces `errorCode: "input_too_large"` with `command: "parse"` and no request ID, discards through the next LF, then resumes reading. This is an input limit, not an output or attachment-size guarantee.

In particular, Node `readline` is not protocol-compliant for RPC mode because it also splits on `U+2028` and `U+2029`, which are valid inside JSON strings.

### EOF, shutdown and failed replacement

The input reader is attached before extension startup so startup dialog replies can flow. Bootstrap owns a transition barrier; ordinary commands wait, and `get_capabilities` readiness waits for binding to settle. A startup hook cannot replace its own runtime through a nested host transition.

EOF consumes a final unterminated record before closing admission. EOF, extension-requested shutdown, and termination signals close admission synchronously, cancel queued dispatch, signal native operations, cancel unanswered dialogs, and clear queued conversational input. Active handlers settle before runtime disposal; shutdown never disposes beneath an admitted command or replays an interrupted effect. Prompt preflight checks shutdown before starting a new model run. Repeated signals share one settlement path rather than causing premature exit. Normal EOF/shutdown flushes queued responses before exit; SIGTERM retains its no-final-flush behavior. Sink failure or uncooperative hooks can still prevent clean settlement; this is not a hard isolation guarantee.

A failed factory after outgoing-session disposal makes `AgentSessionRuntime.isAvailable` false and closes public `session` access. Failed host rebinding/setup also closes access. RPC session-dependent commands then return `runtime_unavailable`; capabilities and cancellation remain usable. Explicit `new_session`, `switch_session`, or `import_session` can recover through the existing factory without invoking stale before-switch hooks or re-disposing the invalidated instance. There is no automatic recovery/retry, rollback, or replay. A failure in a post-rebind user callback does not invalidate an otherwise live rebound runtime. Rebinding callbacks may inspect the newly installed live session while binding is in progress; the wire transition barrier still fences ordinary requests.

### Output and client retention limits

RPC configures a 32 MiB UTF-8 raw-stdout queue ceiling, including in-flight serialized records. An oversized response is replaced with `output_too_large` where a small failure record can be admitted; an oversized event or aggregate overflow closes the transport with failure instead of silently discarding streamed state. Native work still settles cooperatively. Default raw stdout behavior outside RPC remains unchanged.

`RpcClient` rejects input records larger than 16 MiB before writing, bounds pending requests/bytes with the same reserved control lane, and bounds stdout records to 32 MiB. Oversized stdout rejects pending work and stops the child; it is not replayed. Event collection retains at most 16 MiB or 16,384 records per collector, with at most four collectors and 64 idle waiters. Overflow rejects with `output_overflow` and cleans subscriptions/timers. Subscriber-owned retention and native session history remain the caller/runtime's responsibility.

## Commands

### Prompting

#### prompt

Send a user prompt to the agent. The command response is emitted after the prompt is accepted, queued, or handled. Events continue streaming asynchronously after acceptance.

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
```

With images:
```json
{"type": "prompt", "message": "What's in this image?", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

**During streaming**: If the agent is already streaming, you must specify `streamingBehavior` to queue the message:

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `"steer"`: Queue the message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
- `"followUp"`: Wait until the agent finishes. Message is delivered only when agent stops.

If the agent is streaming and no `streamingBehavior` is specified, the command returns an error.

**Extension commands**: If the message is an extension command (e.g., `/mycommand`), it executes immediately even during streaming. Extension commands manage their own LLM interaction via `ice.sendMessage()`.

**Input expansion**: Skill commands (`/skill:name`) and prompt templates (`/template`) are expanded before sending/queueing. Pass `expandPromptTemplates: false` to submit literal slash text without extension-command, skill, or template expansion. `RpcClient.prompt(message, images?, { streamingBehavior, expandPromptTemplates })` exposes both options.

Response:
```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true}
```

`success: true` means the prompt was accepted, queued, or handled immediately. `success: false` means the prompt was rejected before acceptance. Failures after acceptance are reported through the normal event and message stream, not as a second `response` for the same request id.

The `images` field is optional. Each image uses `ImageContent` format: `{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}`.

Optional `attachments` accepts at most 16 items: client-supplied inline `{type:"text", name, text}` (text capped at 1 MiB) or `{type:"image", name, data, mimeType}`, or host files `{type:"file", path}`. Names are capped at 256 characters, paths at 4096, and the whole input-record bound still applies. A `file` attachment is read like a CLI `@file` argument: relative paths and `~` resolve against the session cwd, images are resized per the `images.autoResize` setting, and text files over 1 MiB are rejected with `invalid_argument`; a missing path fails with `not_found` and a directory or unreadable file with `unreadable`. The prompt is not accepted when any file fails. Text attachments and file text are wrapped as user data before the prompt and force literal submission (no slash-command/template expansion); image attachments and image files join the `images` list. File attachments read with the RPC host's own filesystem permissions; they add no access beyond `bash`. Attachment wrappers are not a policy or prompt-injection security boundary. `RpcClient.prompt(..., {attachments})` exposes them.

#### steer

Queue a steering message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "steer", "message": "Stop and do this instead"}
```

With images:
```json
{"type": "steer", "message": "Look at this instead", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "steer", "success": true}
```

See [set_steering_mode](#set_steering_mode) for controlling how steering messages are processed.

#### follow_up

Queue a follow-up message to be processed after the agent finishes. Delivered only when agent has no more tool calls or steering messages. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "follow_up", "message": "After you're done, also do this"}
```

With images:
```json
{"type": "follow_up", "message": "Also check this image", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "follow_up", "success": true}
```

See [set_follow_up_mode](#set_follow_up_mode) for controlling how follow-up messages are processed.

#### get_queue / clear_queue

`get_queue` returns pending text as `{"steering": ["..."], "followUp": ["..."]}` without consuming it. `clear_queue` removes all pending messages and returns the removed text in the same shape; it does not abort the current turn. Individual message IDs are still delivered by `queue_update` events for use with `remove_queued_message`.

```json
{"type":"get_queue"}
{"type":"clear_queue"}
```

#### remove_queued_message

Remove one pending steering or follow-up message by the ID reported in `queue_update`. The message must still be waiting in its queue; the response reports `removed: false` if it has already been delivered or is no longer pending.

```json
{"type": "remove_queued_message", "messageId": "queued-message-id"}
```

Response:
```json
{"type": "response", "command": "remove_queued_message", "success": true, "data": {"removed": true}}
```

#### abort

Abort the current agent operation.

```json
{"type": "abort"}
```

Response:
```json
{"type": "response", "command": "abort", "success": true}
```

#### new_session

Start a fresh session. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "new_session"}
```

With optional parent session tracking:
```json
{"type": "new_session", "parentSession": "/path/to/parent-session.jsonl"}
```

Response:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": true}}
```

### State

#### get_state

Get current session state.

```json
{"type": "get_state"}
```

Response:
```json
{
  "type": "response",
  "command": "get_state",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isStreaming": false,
    "isCompacting": false,
    "steeringMode": "all",
    "followUpMode": "one-at-a-time",
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "sessionName": "my-feature-work",
    "autoCompactionEnabled": true,
    "messageCount": 5,
    "pendingMessageCount": 0,
    "cwd": "/path/to/project",
    "contextUsage": {"tokens": 12000, "contextWindow": 200000, "percent": 6},
    "autoRetryEnabled": true,
    "isRetrying": false,
    "retryAttempt": 0,
    "isBashRunning": false,
    "backgroundShellCount": 0
  }
}
```

`get_state` also includes `leafId` (`null` for an empty branch), `sessionDir`, `persisted` (whether persistence is enabled, not whether the lazy file has been written yet), and optional `parentSessionPath`.

`contextUsage` is omitted without a model; `tokens` and `percent` are `null` right after compaction, before the next response. `backgroundShellCount` counts running [background shells](#background-shells).

The `model` field is a full [Model](#model) object or `null`. The `sessionName` field is the display name set via `set_session_name`, or omitted if not set.

#### get_messages

Get all messages in the conversation.

```json
{"type": "get_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_messages",
  "success": true,
  "data": {"messages": [...]}
}
```

Messages are `AgentMessage` objects (see [Message Types](#message-types)). Optional `limit` (1–1000) and opaque `cursor` page the active view. Data includes `hasMore`, optional `nextCursor`, and a `snapshot` identity. Cursors are invalidated with `stale` when session, leaf, entry count, or message count changes; restart pagination instead of shifting indexes. Contents may still update during streaming, so this is not a frozen transcript. `RpcClient.getMessagesPage(options)` exposes it.

### Model

#### set_model

Switch to a specific model.

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

Response contains the full [Model](#model) object:
```json
{
  "type": "response",
  "command": "set_model",
  "success": true,
  "data": {...}
}
```

#### cycle_model

Cycle to the next available model. Optional `direction` is `"forward"` (default) or `"backward"`. Returns `null` data if only one model is available.

```json
{"type": "cycle_model"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_model",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isScoped": false
  }
}
```

The `model` field is a full [Model](#model) object.

#### get_providers / get_models

`get_providers` returns `{providers, hasCatalogError}` from cached runtime metadata. Each provider includes `id`, `name`, supported `authTypes`, non-secret `auth` (`configured`, optional `source` and `type`), `modelCount`, `availableModelCount`, and `dynamicCatalog`. Configured means configuration was observed, not that the credential is currently valid or an endpoint is reachable. Auth labels, headers, key/token material, provider request configuration, and raw catalog error text are not returned.

`get_models` returns `{models, hasCatalogError}` for all cached models, including providers without configured auth. Optional `provider` filters by provider ID; an unknown provider returns `not_found`. Optional `availableOnly: true` filters the cached available-model snapshot instead. Request headers are omitted from this new catalog projection; advertised model capabilities/limits are preserved.

```json
{"type":"get_providers"}
{"type":"get_models","provider":"anthropic","availableOnly":false}
```

These commands do not resolve credentials, execute auth commands, refresh OAuth, fetch catalogs, or invoke login. Optional `limit` (1–1000) and `cursor` page models in provider/model-ID order; `nextCursor` is a provider/model identity and `hasMore` indicates another page. Pages are live cached listings, not frozen catalogs. `get_available_models` supports the same options; the client provides `getAvailableModelsPage()`. All model response projections omit private request headers. `hasCatalogError` indicates a recorded local configuration/composition/availability error; use `get_diagnostics` for bounded safe categories. The view also remembers the last RPC catalog-refresh failure until a completed successful refresh or session replacement. `RpcClient.getProviders()` and `getModels({provider?, availableOnly?})` expose these snapshots.

#### refresh_models / abort_models_refresh

Explicitly reload local model configuration/catalog caches, optionally fetching selected catalogs:

```json
{"type":"refresh_models","providers":["anthropic"],"allowNetwork":true,"force":true,"timeoutMs":10000}
{"type":"abort_models_refresh"}
```

`providers` is optional (all providers by default); unknown providers are rejected before refresh. `allowNetwork` defaults to `false` and `ICE_OFFLINE` denies an explicit network request. `force` uses the existing provider freshness policy. The cancellation deadline defaults to 10 seconds; `timeoutMs` must be an integer from 1 to 30,000. Refresh is rejected with `busy` during a turn or compaction. Pure cached queries remain live; later mutations and session transitions wait for the refresh operation to settle. The dedicated abort command bypasses those waits and aborts the in-flight refresh, not queued requests.

Success data is `{aborted, timedOut, errors, hasCatalogError}`. **Transport success does not mean every catalog succeeded:** inspect `errors` and cancellation flags. Each error includes provider identity, an error code, and a generic message; raw provider/config error text and credential material are omitted. `models_changed` emits the same result for snapshot invalidation. Selected-model metadata is reconciled without selecting a fallback or appending a redundant model-change entry; thinking is clamped if capabilities changed.

This uses the existing `ModelRuntime.refresh`, not a new registry or auth controller. A network-enabled refresh may resolve existing provider credentials, run already-configured auth helpers, and refresh/persist an expired OAuth token under that runtime's existing rules. Even cache-only refresh may read caches/configuration and run provider availability checks. It never invokes login, logout, or credential-editing flows. Unlike cached introspection, it is an explicit operation, not a pure read. Cancellation is cooperative and does not roll back configuration/cache/credential changes already committed; an ill-behaved extension may ignore the signal. Do not automatically retry an ambiguous timeout or interrupted refresh.

`RpcClient.refreshModels(options)` gives the server deadline five additional seconds for its response; `abortModelsRefresh()` exposes cancellation.

#### get_available_models

List all configured models.

```json
{"type": "get_available_models"}
```

Response contains an array of full [Model](#model) objects:
```json
{
  "type": "response",
  "command": "get_available_models",
  "success": true,
  "data": {
    "models": [...]
  }
}
```

### Thinking

#### set_thinking_level

Set the reasoning/thinking level for models that support it.

```json
{"type": "set_thinking_level", "level": "high"}
```

Levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`, `"ultra"`

`"xhigh"`, `"max"`, and `"ultra"` are exposed only when supported by the selected model. Some models, including GPT-5.6, expose `xhigh` and `max`; `ultra` requires an explicit provider mapping.

Response:
```json
{"type": "response", "command": "set_thinking_level", "success": true, "data": {"level": "high"}}
```

The returned `data.level` is the effective level after model-specific clamping. Invalid level names are rejected before mutation rather than persisted or silently accepted. `RpcClient.setThinkingLevel()` returns `{level}`.

#### cycle_thinking_level

Cycle through available thinking levels. Returns `null` data if model doesn't support thinking.

```json
{"type": "cycle_thinking_level"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_thinking_level",
  "success": true,
  "data": {"level": "high"}
}
```

#### get_available_thinking_levels

List the thinking levels supported by the current model. Returns `["off"]` for a model without reasoning support.

```json
{"type": "get_available_thinking_levels"}
```

Response:
```json
{
  "type": "response",
  "command": "get_available_thinking_levels",
  "success": true,
  "data": {
    "levels": ["off", "minimal", "low", "medium", "high"]
  }
}
```

### Queue Modes

#### set_steering_mode

Control how steering messages (from `steer`) are delivered.

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all steering messages after the current assistant turn finishes executing its tool calls
- `"one-at-a-time"`: Deliver one steering message per completed assistant turn (default)

Response:
```json
{"type": "response", "command": "set_steering_mode", "success": true}
```

#### set_follow_up_mode

Control how follow-up messages (from `follow_up`) are delivered.

```json
{"type": "set_follow_up_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all follow-up messages when agent finishes
- `"one-at-a-time"`: Deliver one follow-up message per agent completion (default)

Response:
```json
{"type": "response", "command": "set_follow_up_mode", "success": true}
```

### Compaction

#### compact

Manually compact conversation context to reduce token usage.

```json
{"type": "compact"}
```

With custom instructions:
```json
{"type": "compact", "customInstructions": "Focus on code changes"}
```

Response:
```json
{
  "type": "response",
  "command": "compact",
  "success": true,
  "data": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  }
}
```

`estimatedTokensAfter` is a heuristic estimate over the rebuilt message context immediately after compaction, not a provider-exact token count. `usage` reports the LLM call or calls that generated the summary and may be omitted by custom compaction handlers.

#### set_auto_compaction

Enable or disable automatic compaction when context is nearly full.

```json
{"type": "set_auto_compaction", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_compaction", "success": true}
```

### Retry

#### set_auto_retry

Enable or disable automatic retry on transient errors (overloaded, rate limit, 5xx).

```json
{"type": "set_auto_retry", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_retry", "success": true}
```

#### abort_retry

Abort an in-progress retry (cancel the delay and stop retrying).

```json
{"type": "abort_retry"}
```

Response:
```json
{"type": "response", "command": "abort_retry", "success": true}
```

### Bash

#### bash

Execute a shell command and add output to conversation context. Output streams as `bash_execution_update` events while the command runs; the response contains the final result.

```json
{"id": "req-1", "type": "bash", "command": "ls -la"}
```

Include an `id` to associate streamed `bash_execution_update` events with this command. Optional `excludeFromContext: true` executes without adding the result to the next model context. The client exposes it as `RpcClient.bash(command, { excludeFromContext: true })`.

Response:
```json
{
  "id": "req-1",
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "total 48\ndrwxr-xr-x ...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": false
  }
}
```

If output was truncated, includes `fullOutputPath`:
```json
{
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "truncated output...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": true,
    "fullOutputPath": "/tmp/ice-bash-abc123.log"
  }
}
```

**How bash results reach the LLM:**

The `bash` command executes immediately and returns a `BashResult`. Internally, a `BashExecutionMessage` is created and stored in the agent's message state.

When the next `prompt` command is sent, all messages (including `BashExecutionMessage`) are transformed before being sent to the LLM. The `BashExecutionMessage` is converted to a `UserMessage` with this format:

````
Ran `ls -la`
```
total 48
drwxr-xr-x ...
```
````

This means:
1. Bash output is included in the LLM context on the **next prompt**, not immediately
2. Multiple bash commands can be executed before a prompt; all outputs will be included

#### abort_bash

Abort a running bash command.

```json
{"type": "abort_bash"}
```

Response:
```json
{"type": "response", "command": "abort_bash", "success": true}
```

### Session

#### get_session_stats

Get token usage, cost statistics, and current context window usage.

```json
{"type": "get_session_stats"}
```

Response:
```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "userMessages": 5,
    "assistantMessages": 5,
    "toolCalls": 12,
    "toolResults": 12,
    "totalMessages": 22,
    "tokens": {
      "input": 50000,
      "output": 10000,
      "cacheRead": 40000,
      "cacheWrite": 5000,
      "total": 105000
    },
    "cost": 0.45,
    "contextUsage": {
      "tokens": 60000,
      "contextWindow": 200000,
      "percent": 30
    },
    "cacheWaste": {"missedTokens": 12000, "missedCost": 0.03, "missCount": 2}
  }
}
```

`cacheWaste` totals prompt-cache misses across the session, the data behind the interactive cache-miss notices and `/session`: prompt tokens that were in the previous request's prompt but were billed again instead of read from cache, the extra cost when pricing is known (otherwise 0), and the number of counted misses. Misses at or below 1024 tokens and providers that never report caching are not counted.

`tokens` and `cost` include assistant messages, usage reported by tools, and compaction/branch-summary generation across the full session. `contextUsage` contains the actual current context-window estimate used for compaction and footer display.

`contextUsage` is omitted when no model or context window is available. `contextUsage.tokens` and `contextUsage.percent` are `null` immediately after compaction until a fresh post-compaction assistant response provides valid usage data.

#### export_html

Export session to an HTML file.

```json
{"type": "export_html"}
```

With custom path:
```json
{"type": "export_html", "outputPath": "/tmp/session.html"}
```

Response:
```json
{
  "type": "response",
  "command": "export_html",
  "success": true,
  "data": {"path": "/tmp/session.html"}
}
```

Pass `"includeContent": true` to also receive the exported file as `data.content`, for clients that cannot read the host filesystem. The file is still written; a result larger than the output limit fails with `output_too_large`. `export_jsonl` accepts the same option.

#### switch_session

Load a different session file. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "switch_session", "sessionPath": "/path/to/session.jsonl", "cwd": "/existing/project"}
```

Response:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled the switch:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": true}}
```

`cwd` is optional and overrides the recorded working directory, useful when it no longer exists. `RpcClient.switchSession(sessionPath, cwd?)` exposes it. Normal runtime and trust checks still apply.

#### fork

Create a new fork from a previous user message on the active branch. Can be cancelled by a `session_before_fork` extension event handler. Returns the text of the message being forked from.

```json
{"type": "fork", "entryId": "abc123"}
```

Response:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": false}
}
```

If an extension cancelled the fork:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": true}
}
```

#### clone

Duplicate the current active branch into a new session at the current position. Can be cancelled by a `session_before_fork` extension event handler.

```json
{"type": "clone"}
```

Response:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": false}
}
```

If an extension cancelled the clone:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": true}
}
```

#### get_fork_messages

Get user messages available for forking.

```json
{"type": "get_fork_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_fork_messages",
  "success": true,
  "data": {
    "messages": [
      {"entryId": "abc123", "text": "First prompt..."},
      {"entryId": "def456", "text": "Second prompt..."}
    ]
  }
}
```

#### get_entries

Get all session entries in append order (excluding the session header). The session is an append-only tree of entries with stable ids, so an entry id works as a durable cursor: pass the last entry id you have seen as `since` to get only entries strictly after it, even across client restarts. Unlike `get_messages`, this includes pre-compaction history and abandoned branches.

```json
{"type": "get_entries"}
```

With a cursor:
```json
{"type": "get_entries", "since": "abc123", "limit": 100}
```

Response:
```json
{
  "type": "response",
  "command": "get_entries",
  "success": true,
  "data": {
    "entries": [
      {"type": "message", "id": "def456", "parentId": "abc123", "timestamp": "...", "message": {"role": "user", "...": "..."}}
    ],
    "leafId": "def456"
  }
}
```

`leafId` is the id of the current leaf entry (`null` for an empty session), so a client can tell in one round trip whether the active branch moved. If `since` does not match any entry id, the response is `success: false` with `not_found`.

Optional `limit` is an integer from 1 to 1000; omitted means all remaining entries. Data also contains `hasMore`, and `nextCursor` (the last returned entry ID) when another page remains. Pass it as `since` on the next request. Entry cursors follow append order, so later appends do not shift existing pages; session replacement requires a fresh snapshot. `RpcClient.getEntries(since?, limit?)` returns the page. Count limits do not bound the byte size of one entry, and this still reads the manager's in-memory entry list.

#### get_tree

Get the session as a tree of entries. Each node is `{entry, children, label?, labelTimestamp?}`. A well-formed session has a single root; orphaned entries (broken parent chain) also appear as roots.

```json
{"type": "get_tree"}
```

Response:
```json
{
  "type": "response",
  "command": "get_tree",
  "success": true,
  "data": {
    "tree": [
      {
        "entry": {"type": "message", "id": "abc123", "parentId": null, "...": "..."},
        "children": [
          {"entry": {"type": "message", "id": "def456", "parentId": "abc123", "...": "..."}, "children": []}
        ]
      }
    ],
    "leafId": "def456"
  }
}
```

With any of `limit`, `cursor`, or `parentId`, `get_tree` returns a shallow child page: omitted/null `parentId` selects roots; a string selects that node's direct children. Returned nodes have `children: []` and `hasChildren` for lazy traversal, plus response `parentId`, `hasMore` and optional entry-ID `nextCursor`. Limits are 1–1000 (default 100 for paged traversal). Unknown parents/cursors fail `not_found`. The native tree is still built locally, so output paging does not cap scan work. `RpcClient.getTreePage(options)` exposes it; an unqualified `get_tree` retains the full nested view.

#### get_last_assistant_text

Get the text content of the last assistant message.

```json
{"type": "get_last_assistant_text"}
```

Response:
```json
{
  "type": "response",
  "command": "get_last_assistant_text",
  "success": true,
  "data": {"text": "The assistant's response..."}
}
```

Returns `{"text": null}` if no assistant messages exist.

#### set_session_name

Set a display name for the current session. The name appears in session listings and helps identify sessions.

```json
{"type": "set_session_name", "name": "my-feature-work"}
```

Response:
```json
{
  "type": "response",
  "command": "set_session_name",
  "success": true
}
```

The current session name is available via `get_state` in the `sessionName` field. To set the initial name when starting RPC mode, pass `--name <name>` or `-n <name>` to the `ice --mode rpc` process.

#### list_sessions

Lists sessions for the current working directory (`"scope": "cwd"`, the default) or for every project (`"scope": "all"`), newest first with a deterministic path tie-breaker. Each entry has `path`, `id`, `cwd`, `name`, `parentSessionPath`, `created`, `modified` (ISO strings), `messageCount`, and `firstMessage`. Pass `path` to `switch_session`.

Optional `query` is a case-insensitive literal substring (up to 256 UTF-16 code units) matched against session name, cwd, first message and locally indexed user/assistant text; raw full-text indexes are not returned. Optional `limit` is an integer from 1 to 1000; omitted returns the full matching list. Optional `cursor` is the path of the last session returned by the previous page, using the same scope/query. Data includes `hasMore` and `nextCursor` when more results remain; an absent/stale cursor returns `not_found`.

```json
{"type":"list_sessions","scope":"all","query":"refactor","limit":50}
```

Pages are live listings, not a frozen search snapshot: writes, renames and deletions between requests can move sessions or invalidate a cursor. Restart the listing to reconcile changes. Paging bounds returned item count, not the underlying directory/file scan or output bytes. `RpcClient.listSessionsPage(options)` exposes paging/search; `listSessions(scope?)` remains the full-list array convenience method.

#### import_session / export_jsonl

`import_session` replaces the current session with a JSONL export (`path`, optional `cwd` when the recorded directory no longer exists) and responds with `{"cancelled": false}`; an extension may cancel it. `export_jsonl` writes the active branch and responds with `{"path": "..."}`, plus `content` with `includeContent: true`.

#### delete_session / rename_session

Manage session files like the `/resume` picker. Both take `sessionPath` (relative paths resolve against the session cwd), which must be a `.jsonl` file inside the global sessions directory or the configured session directory; other paths fail with `invalid_argument` (delete) or `not_found` (rename).

```json
{"type": "delete_session", "sessionPath": "/home/user/.ice/agent/sessions/--proj--/2026-01-01_abc.jsonl"}
{"type": "rename_session", "sessionPath": "/home/user/.ice/agent/sessions/--proj--/2026-01-01_abc.jsonl", "name": "Refactor"}
```

`delete_session` moves the file to the trash with the `trash` CLI when available and otherwise unlinks it permanently; `data.method` is `"trash"` or `"unlink"`. Deleting the active session fails with `busy`, and a missing file with `not_found`. `rename_session` appends a session name entry (an empty name fails with `invalid_argument`); for the active session it behaves like `set_session_name`. `RpcClient.deleteSession(path)` and `renameSession(path, name)` wrap them.

#### navigate_tree

Moves the session leaf to another entry, like `/tree`. Optional `summarize`, `customInstructions`, `replaceInstructions`, and `label`. Rejected while a turn or compaction runs. Selecting a user message rewinds to its parent and returns that message as `editorText`. `data`: `cancelled`, and when present `aborted`, `editorText`, `summaryEntryId`. Use `abort_branch_summary` to cancel a running summary.

#### set_entry_label

Sets an entry's label (`label` omitted or empty clears it). Rejected while a turn is running. `fork` also accepts `position`: `"before"` (default, forks before a user message) or `"at"`.

#### abort_compaction

Cancels a running `compact` or automatic compaction.

### Session Tools

#### get_tools / set_active_tools

`get_tools` returns every registered tool with its JSON-schema `parameters`, `promptGuidelines`, `sourceInfo`, and whether it is `active` for the model. `set_active_tools` replaces the active set; unknown names are rejected and nothing changes. Mode and permission gates still apply when the model calls a tool.

```json
{"type": "get_tools"}
{"type": "set_active_tools", "toolNames": ["read", "grep", "find", "ls"]}
```

`set_active_tools` responds with `{"active": [...]}`.

#### get_system_prompt / get_resources / get_changelog

`get_system_prompt` returns `{"text": "..."}`. `get_resources` returns loaded context file paths, system-prompt paths, skills, prompt templates, themes, and extensions (path and `sourceInfo`, no file contents) plus extension load errors and resource diagnostics. `get_changelog` returns `{"entries": [{"version", "content"}]}`, newest first.

#### get_diagnostics / get_completions / get_ui_state

`get_diagnostics` returns up to 100 catalog, settings-load, extension-load and resource diagnostic records (`source`, `severity`, stable category `code`, optional bounded resource `path`, generic `message`) plus `truncated`. Raw provider/config/extension error text and credential material are not returned. It does not execute auth helpers or consume local diagnostics.

`get_completions` takes `prefix`, the editor text before the cursor (at most 256 characters), and optional `limit` (1–1000; default 100). It returns `{kind, replace, items:[{value, label?, description?, source?}], hasMore}`, where `replace` is the trailing text of `prefix` that an item's `value` replaces:

- `kind: "command"`: `prefix` is a slash token without a space, such as `/com`. Items are `/name` values from the `get_commands` inventory, matched by name prefix, with their `source`.
- `kind: "argument"`: `prefix` starts with a command name and a space, such as `/pick al`. Items come from the extension command's argument-completion callback, which runs in the RPC host.
- `kind: "path"`: any other `prefix`. An `@file` token is matched fuzzily with `fd` when it is installed (no `fd` gives no `@` results); a token that looks like a path (contains `/`, starts with `.` or `~/`) lists matching directory entries relative to the session cwd.

An empty `items` list means nothing matched. It may hot-refresh skills like `get_commands`. It never executes shell commands other than `fd`.

`get_ui_state` returns a bounded text snapshot of extension statuses, string-array widgets (with placement), header and footer text, title, editor text and working message/visibility. It resets on session rebinding and immediately before new extension startup during reload; at most 64 statuses/widgets, 32 lines per widget and 1024 characters per string are retained, with `truncated` indicating projection loss. Live extension UI events remain authoritative. For a TUI component factory, extensions can provide `ExtensionWidgetOptions.rpcText` (widgets) or `ExtensionChromeOptions.rpcText` (`setHeader`/`setFooter`) as an explicit string-array projection. RPC never invokes that factory or starts a terminal renderer; without an explicit projection, a widget factory is ignored and a header/footer factory clears the RPC text.

The client provides `getDiagnostics()`, `getCompletions(prefix, limit?)`, and `getUIState()`.

#### get_scoped_models / set_scoped_models

The models that `cycle_model` rotates through. An empty list means every available model. `set_scoped_models` applies to the running session only; the persistent preference is the `enabledModels` setting. An unavailable model rejects the whole update.

```json
{"type": "set_scoped_models", "models": [{"provider": "anthropic", "modelId": "claude-sonnet-4", "thinkingLevel": "low"}]}
```

#### reload / stop_after_turn

`reload` reloads settings, extensions, skills, prompts, themes, and context files; it is rejected while a turn or compaction runs. `stop_after_turn` ends the current run after the in-flight tool turn completes.

#### get_flags / get_shortcuts / invoke_shortcut

`get_flags` lists flags registered by extensions with `ice.registerFlag()` (`name`, `type`, optional `description` and `default`, current `value`, `extensionPath`). Values are set at startup by CLI flags; RPC cannot change them.

`get_shortcuts` lists extension keyboard shortcuts (`shortcut`, optional `description`, `extensionPath`) after conflict resolution against the built-in keybindings in `keybindings.json`. `invoke_shortcut` runs one shortcut's handler as if its key were pressed; `shortcut` matches case-insensitively, and an unknown shortcut fails with `not_found`. The handler receives the RPC extension context, so its UI calls arrive as extension UI requests.

```json
{"type": "invoke_shortcut", "shortcut": "ctrl+alt+y"}
```

`RpcClient.getFlags()`, `getShortcuts()`, and `invokeShortcut(shortcut)` wrap them.

### Background Shells

Shells started by `bash` with `run_in_background`, or moved to the background by the user, are tracked per session. These commands read and control them without consuming the model's `bash_output` cursor.

#### get_shells

```json
{"type": "get_shells"}
```

Response `data.shells` entries: `taskId`, `command`, `origin` (`model` or `user`), `status` (`running`, `completed`, `failed`, `killed`), `startedAt`, `endedAt`, and `totalChars`. Output is not included.

#### get_shell

Returns one shell with its retained output (the newest 256 KiB), or `null` when the id is unknown. Pass `sinceChars` to receive only output after that offset.

```json
{"type": "get_shell", "shellId": "bash-1", "sinceChars": 4096}
```

Response `data`: `shell` (as above plus `finalText` once it exited), `output`, and `outputOffset`, the offset of `output[0]`. Poll with `sinceChars = outputOffset + output.length`.

#### kill_shell

Stops a running shell and tells the model it was stopped by the user. `data.stopped` is `false` for an unknown or finished shell.

```json
{"type": "kill_shell", "shellId": "bash-1"}
```

#### background_bash

Moves running foreground `bash` calls to the background; `data.released` is how many moved.

```json
{"type": "background_bash"}
```

### Interactive Command Equivalents

| Interactive | RPC |
|---|---|
| `/settings`, `/fast`, `/model`, `/name` | `get_settings`/`set_setting`, `set_fast_mode`, `set_model`, `set_session_name` |
| `/scoped-models` | `get_scoped_models`, `set_scoped_models` |
| `/export`, `/import` | `export_html`, `export_jsonl`, `import_session` |
| `/copy`, `/session` | `get_last_assistant_text`, `get_session_stats` |
| `/changelog`, `/resources` | `get_changelog`, `get_resources` |
| `/tasks`, `/shells`, ctrl+b | `get_shells`, `get_shell`, `kill_shell`, `background_bash` |
| `/fork`, `/clone`, `/tree`, `/resume`, `/new` | `fork`, `clone`, `get_tree` + `navigate_tree`, `list_sessions` + `switch_session`, `new_session` |
| `/resume` picker delete and rename | `delete_session`, `rename_session` |
| Extension shortcuts | `get_shortcuts`, `invoke_shortcut` |
| `/compact`, `/reload` | `compact`, `reload` |

Not available over RPC: `/login`, `/logout`, `/trust`, and `/share` (credential, trust, and publishing decisions stay with the local user), `/hotkeys`, `/customize`, `/notices`, and `/debug` (terminal UI; the notice data comes from events, `get_diagnostics`, and `get_session_stats.cacheWaste`). Settings that run executables or load code (`shellPath`, `shellCommandPrefix`, `npmCommand`, extension, skill, prompt, and theme paths) are not writable over RPC.

### Subagents

Available only under the `ice` launcher. Other hosts return `null` from `get_subagents` and `accepted: false` from `respond_subagent_approval`.

#### get_subagents

Returns the subagent overview for the current parent session, or `null` before a parent session exists.

```json
{"type": "get_subagents"}
```

Response:
```json
{
  "type": "response",
  "command": "get_subagents",
  "success": true,
  "data": {
    "enabled": true,
    "capacity": {"running": 1, "queued": 0, "max": 4},
    "maxDepth": 0,
    "children": [
      {
        "id": "ag_2d4jiycqlw6yf6ycwk4rpanbrg",
        "agent": "explore",
        "description": "Read a.txt",
        "state": "running",
        "depth": 0,
        "running": true,
        "background": true,
        "resident": true,
        "finished": false,
        "turns": 1,
        "tokens": 6648,
        "cost": 0
      }
    ],
    "approvals": [],
    "diagnostics": []
  }
}
```

`capacity.max` is the concurrency ceiling the session started with (`ice.subagents.maxConcurrent`); `queued` counts turns waiting for a slot. `enabled` is false when `ice.subagents.enabled` is false or `diagnostics` lists invalid settings; either blocks new launches. Child `state` is `starting`, `queued` (its turn waits for a concurrency slot), `running`, `idle`, `parked`, `blocked`, or `stopped`. `tokens` and `cost` include the turn in progress. `background` is true when no parent tool call waits on the running turn; `resident` is false for parked children. A child whose turn settled is parked after 30 seconds without a new turn and reported with `finished: true`; it stays resumable until deleted. A child stopped before it ever ran is removed.

#### respond_subagent_approval

Answers a pending approval from `approvals`. `answer` is `allow-once`, `allow-session` (grants the approval's `sessionRule` for that child), or `deny`. `accepted` is false when the approval is no longer pending.

```json
{"type": "respond_subagent_approval", "approvalId": "<id from approvals>", "answer": "allow-once"}
```

Response:
```json
{"type": "response", "command": "respond_subagent_approval", "success": true, "data": {"accepted": true}}
```

In RPC mode, a background child's `ask` waits for this answer until `ice.subagents.askTimeoutMs` (default 10 minutes) and is then denied. Foreground asks still use the `select` extension UI request.

#### subagent_control

Runs a user lifecycle action on one child, the same operations the Agent Hub offers. `subagentId` accepts the ID or the name given at launch. `action` is `stop` (ends the current turn; the session is kept), `resume` (revives a parked child), `delete`, or `send` (a follow-up turn with `message`). `data.message` is the runtime's summary; an unknown child or a refused action is an error response.

```json
{"type": "subagent_control", "subagentId": "auth-review", "action": "send", "message": "Also check refresh tokens"}
```

Response:
```json
{"type": "response", "command": "subagent_control", "success": true, "data": {"message": "..."}}
```

#### subagent_patch

Inspects, applies, or rejects a worktree child's patch by running the parent's `agent_patch` tool on the user's behalf. The call goes through the same `tool_call` and `tool_result` extension hooks as a model call, so mode gates, the approved-plan read gate, and verification tracking apply, and the runtime still requires trusted build authority and parent write permission for every changed path. `inspect` must precede `apply`. `data.isError` is true when an extension blocked the call, the tool failed, or `agent_patch` is not active in the current mode; `data.text` is the tool text (changed paths and a bounded, redacted patch preview for `inspect`) and `data.details` its structured details.

```json
{"type": "subagent_patch", "subagentId": "auth-review", "action": "inspect"}
```

Response:
```json
{"type": "response", "command": "subagent_patch", "success": true, "data": {"isError": false, "text": "Changed paths ...", "details": {"status": "open", "changedPaths": [{"status": "M", "path": "src/auth.ts"}]}}}
```

#### get_subagent_messages

Returns one child's transcript by the `id` from `children` (names are not accepted). Messages are redacted and bounded to the latest 96 messages and 256 KiB; a single message over 16 KiB is skipped. `live` is true while the child is resident and still updating; poll again to follow it. Parked children are read from their durable transcript with `live: false`. `data` is `null` for unknown IDs, the parent, and children of another parent session.

```json
{"type": "get_subagent_messages", "subagentId": "ag_2d4jiycqlw6yf6ycwk4rpanbrg"}
```

Response:
```json
{"type": "response", "command": "get_subagent_messages", "success": true, "data": {"live": true, "messages": [...]}}
```

### Commands

#### get_commands

Get available commands (extension commands, prompt templates, and skills). These can be invoked via the `prompt` command by prefixing with `/`.

```json
{"type": "get_commands"}
```

Response:
```json
{
  "type": "response",
  "command": "get_commands",
  "success": true,
  "data": {
    "commands": [
      {"name": "session-name", "description": "Set or clear session name", "source": "extension", "path": "/home/user/.ice/agent/extensions/session.ts"},
      {"name": "fix-tests", "description": "Fix failing tests", "source": "prompt", "location": "project", "path": "/home/user/myproject/.ice/agent/prompts/fix-tests.md"},
      {"name": "skill:brave-search", "description": "Web search via Brave API", "source": "skill", "location": "user", "path": "/home/user/.ice/agent/skills/brave-search/SKILL.md"}
    ]
  }
}
```

Prompt-template commands also include optional `argumentHint` when declared by their source.

Each command has:
- `name`: Command name (invoke with `/name`)
- `description`: Human-readable description (optional for extension commands)
- `source`: What kind of command:
  - `"extension"`: Registered via `ice.registerCommand()` in an extension
  - `"prompt"`: Loaded from a prompt template `.md` file
  - `"skill"`: Loaded from a skill directory (name is prefixed with `skill:`)
- `location`: Where it was loaded from (optional, not present for extensions):
  - `"user"`: User-level (`~/.ice/agent/`)
  - `"project"`: Project-level (`./.ice/agent/`)
  - `"path"`: Explicit path via CLI or settings
- `path`: Absolute file path to the command source (optional)

Built-in commands appear with `source: "builtin"`. `/settings` carries a form `interaction` for `invoke_command`. The other listed built-ins carry `rpcCommand`, the RPC command that performs them (for example `compact` for `/compact`). Built-ins are handled only in interactive mode, so sending one through `prompt` does not run it. Built-ins with no RPC equivalent, such as `/hotkeys` or `/login`, are not listed.

#### get_command_schema

Fetch a structured slash command's form schema; this is not a schema for an RPC transport command.

```json
{"type":"get_command_schema","name":"settings","source":"builtin"}
```

Optional `source` disambiguates `builtin`, `extension`, `prompt`, or `skill`; optional `schemaId` checks identity. Response data is `{capability, schema, diagnostics}`: `capability` is `available`, `unsupported`, or `failed`, and `schema` is `null` when no form is exposed. Available schemas include `schemaId`, `revision`, fields, and `invocationMode: "single-field"`. The builtin settings schema ID is `ice.settings`.

#### invoke_command

Invoke a structured command using the identity and revision returned by `get_command_schema`:

```json
{"type":"invoke_command","name":"settings","source":"builtin","schemaId":"ice.settings","schemaRevision":"<revision from schema>","arguments":{"transport":"auto"},"options":{"scope":"global"}}
```

`arguments` is an object; optional `options.scope` is `global` or `project`. Validation and permission gates remain authoritative. Success data contains `status` (`updated`, `completed`, or `accepted`) and optional `schema` and `message`. Errors may include `ambiguous`, `stale`, `busy`, `unsupported`, `not_found`, or validation-specific codes and details. Do not blindly replay a failed or timed-out mutation. `RpcClient.getCommandSchema()` and `invokeCommand()` expose the same fields.

## Events

Events are streamed to stdout as JSON lines during agent operation. Events do not generally include an `id` field; `bash_execution_update` includes the `id` of its originating `bash` command when one was provided.

### Event Types

| Event | Description |
|-------|-------------|
| `session_changed` | Runtime replacement and RPC rebinding finished; carries previous/current session IDs, optional session file, cwd, and leaf ID |
| `model_changed` | Native or extension-driven model selection/cycling, or current model metadata replacement |
| `configuration_changed` | Effective fast/queue/compaction/retry/tool/scoped-model controls changed |
| `settings_applied` | Settings-manager values were applied to the live session; invalidate the settings snapshot |
| `resources_changed` | Reload or skill hot-refresh finished; invalidate command/resource/tool views |
| `models_changed` | Explicit RPC catalog refresh settled (including failure/cancellation); invalidate provider/model snapshots |
| `catalog_changed` | Native in-process catalog/auth/availability mutation; invalidate cached provider/model views |
| `settings_changed` | Direct in-memory settings mutation/reload; invalidate settings without assuming live application |
| `entry_appended` | Any local session entry appended, including messages, model/thinking changes, labels, custom entries and summaries |
| `leaf_changed` | Explicit branch/reset moved the current leaf without appending an entry |
| `agent_start` | Agent begins processing |
| `agent_end` | One low-level agent run completes (may still be followed by retry, compaction, or queued continuations) |
| `agent_settled` | Agent run is fully settled; no automatic retry, compaction retry, or queued continuation remains |
| `turn_start` | New turn begins |
| `turn_end` | Turn completes (includes assistant message and tool results) |
| `message_start` | Message begins |
| `message_update` | Streaming update (text/thinking/toolcall deltas) |
| `message_end` | Message completes |
| `bash_execution_update` | Direct RPC bash command output chunk |
| `tool_execution_start` | Tool begins execution |
| `tool_execution_update` | Tool execution progress (streaming output) |
| `tool_execution_end` | Tool completes |
| `queue_update` | Pending steering/follow-up queue changed |
| `compaction_start` | Compaction begins |
| `compaction_end` | Compaction completes |
| `auto_retry_start` | Auto-retry begins (after transient error) |
| `auto_retry_end` | Auto-retry completes (success or final failure) |
| `summarization_retry_scheduled` | Retry scheduled for a transient compaction or branch-summary summarization error |
| `summarization_retry_attempt_start` | Retried summarization request starts |
| `summarization_retry_finished` | Summarization retry loop completes |
| `extension_error` | Extension threw an error |
| `shells_update` | Background shells started, printed, or finished (coalesced); carries every tracked shell without output |

### Model, configuration, settings and resource changes

`model_changed` contains capability metadata in `model`, optional `previousModel` (both omit private request headers), and `source` (`set`, `cycle`, `restore`, or `refresh`). Selection events occur after thinking clamping and before extension `model_select` handlers; setting the same model identity does not repeat a selection event. Current-model metadata replacement can notify even when provider/ID stay the same.

`configuration_changed.configuration` contains the effective `fastMode`, `steeringMode`, `followUpMode`, `autoCompactionEnabled`, `autoRetryEnabled`, `activeTools` names, and `scopedModels` references (provider/modelId/optional thinkingLevel). Identical consecutive configurations are suppressed. It reports session setters, including extension tool/model controls, and live settings application, not arbitrary direct writes to internal agent state.

`settings_applied` invalidates `get_settings` after `syncSettingsFromManager`, including RPC setting updates and reload. `resources_changed.reason` is `reload` or `skills`; refetch commands/resources/tools as appropriate. These are invalidations, not filesystem watchers. Native `ModelRuntime.subscribeChanges()` and `SettingsManager.subscribeChanges()` provide coalesced process-local invalidations. RPC forwards them as `catalog_changed`/`settings_changed`, including direct native API mutations outside explicit RPC commands. These invalidations expose no raw credentials/settings and do not imply that preferences were applied to the agent. External files or credential stores changed without their owning runtime API still require reload/refresh; no filesystem watcher or polling loop is added.

### Entry and leaf changes

`entry_appended.entry` uses the same entry shape as `get_entries`. It now covers all successful local append methods, not only extension custom entries, and is emitted after local indexes and the normal persistence path are updated. It is not an fsync acknowledgement: metadata-only sessions remain lazy, memory-only sessions have no file, and a separate durable flush can still fail. Existing entries are not replayed on subscribe/reload/replacement. Labels are indexed before their event.

`leaf_changed.leafId` is a string or `null` after explicit branch/reset navigation. An append advances the leaf to `entry.id`; it does not also emit `leaf_changed`. Session loading/replacement is represented by `session_changed` and a fresh snapshot, not a replay of historical appends. Initialize/recover with `get_entries` or `get_tree`, and treat events as process-local observations, not a durable replay log.

### session_changed

Emitted once after a successful runtime replacement, including extension command-context replacements, and before its command response. Initial startup, cancelled transitions, navigation within the same session, and reload do not emit it. It is a notification to refresh session-bound views, not a transcript delta or a promise that the lazy session file exists.

```json
{"type":"session_changed","previousSessionId":"old-id","sessionId":"new-id","sessionFile":"/path/to/new.jsonl","cwd":"/project","leafId":null}
```

### agent_start

Emitted when the agent begins processing a prompt.

```json
{"type": "agent_start"}
```

### agent_end

Emitted when one low-level agent run completes. Contains all messages generated during this run. If `willRetry` is true, an automatic retry will follow.

```json
{
  "type": "agent_end",
  "messages": [...],
  "willRetry": false
}
```

### agent_settled

Emitted after the full session-level run settles. At this point Ice will not continue automatically through retry, compaction retry, or queued follow-up messages.

```json
{"type": "agent_settled"}
```

### turn_start / turn_end

A turn consists of one assistant response plus any resulting tool calls and results.

```json
{"type": "turn_start"}
```

```json
{
  "type": "turn_end",
  "message": {...},
  "toolResults": [...]
}
```

### message_start / message_end

Emitted when a message begins and completes. The `message` field contains an `AgentMessage`.

```json
{"type": "message_start", "message": {...}}
{"type": "message_end", "message": {...}}
```

### message_update (Streaming)

Emitted during streaming of assistant messages. Contains a delta event without a cumulative message snapshot.

```json
{
  "type": "message_update",
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "Hello "
  }
}
```

The `assistantMessageEvent` field contains one of these delta types:

| Type | Description |
|------|-------------|
| `text_start` | Text content block started |
| `text_delta` | Text content chunk |
| `text_end` | Text content block ended |
| `thinking_start` | Thinking block started |
| `thinking_delta` | Thinking content chunk |
| `thinking_end` | Thinking block ended |
| `toolcall_start` | Tool call started |
| `toolcall_delta` | Tool call arguments chunk |
| `toolcall_end` | Tool call ended (includes full `toolCall` object) |

Example streaming a text response:
```json
{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" world"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world"}}
```

`message_update` intentionally omits the former cumulative `message` field and
`assistantMessageEvent.partial`. Clients that need a live partial message must assemble it
from `message_start` and subsequent events using `contentIndex`. Treat `message_end.message`
as authoritative. For tool calls, buffer `toolcall_delta.delta`; `toolcall_end.toolCall`
contains the completed call.

### bash_execution_update

Emitted once for each output chunk from a direct `bash` command. `id` matches the command's `id`, allowing clients to associate output with the correct command.

Events stream all output while the command runs, even if the final `bash` response's `output` is truncated.

```json
{
  "type": "bash_execution_update",
  "id": "req-1",
  "delta": "total 48\n"
}
```

### tool_execution_start / tool_execution_update / tool_execution_end

Emitted when a tool begins, streams progress, and completes execution.

```json
{
  "type": "tool_execution_start",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"}
}
```

During execution, `tool_execution_update` events stream partial results (e.g., bash output as it arrives):

```json
{
  "type": "tool_execution_update",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"},
  "partialResult": {
    "content": [{"type": "text", "text": "partial output so far..."}],
    "details": {"truncation": null, "fullOutputPath": null}
  }
}
```

When complete:

```json
{
  "type": "tool_execution_end",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "result": {
    "content": [{"type": "text", "text": "total 48\n..."}],
    "details": {...}
  },
  "isError": false
}
```

Use `toolCallId` to correlate events. The `partialResult` in `tool_execution_update` contains the accumulated output so far (not just the delta), allowing clients to simply replace their display on each update.

### queue_update

Emitted whenever the pending steering or follow-up queue changes.

```json
{
  "type": "queue_update",
  "steering": ["Focus on error handling"],
  "followUp": ["After that, summarize the result"],
  "steeringEntries": [{"id": "steer-id", "message": "Focus on error handling"}],
  "followUpEntries": [{"id": "follow-up-id", "message": "After that, summarize the result"}]
}
```

### compaction_start / compaction_end

Emitted when compaction runs, whether manual or automatic.

```json
{"type": "compaction_start", "reason": "threshold"}
```

The `reason` field is `"manual"`, `"threshold"`, or `"overflow"`.

```json
{
  "type": "compaction_end",
  "reason": "threshold",
  "result": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  },
  "aborted": false,
  "willRetry": false
}
```

If `reason` was `"overflow"` and compaction succeeds, `willRetry` is `true` and the agent will automatically retry the prompt.

If compaction was aborted, `result` is `null` and `aborted` is `true`.

If compaction failed (e.g., API quota exceeded), `result` is `null`, `aborted` is `false`, and `errorMessage` contains the error description.

### auto_retry_start / auto_retry_end

Emitted when automatic retry is triggered after a transient error (overloaded, rate limit, 5xx).

```json
{
  "type": "auto_retry_start",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"
}
```

```json
{
  "type": "auto_retry_end",
  "success": true,
  "attempt": 2
}
```

On final failure (max retries exceeded):
```json
{
  "type": "auto_retry_end",
  "success": false,
  "attempt": 3,
  "finalError": "529 overloaded_error: Overloaded"
}
```

### summarization_retry_scheduled / summarization_retry_attempt_start / summarization_retry_finished

Emitted when compaction or branch-summary summarization retries after a transient provider error. These events use the same retry settings as automatic assistant-turn retries.

```json
{
  "type": "summarization_retry_scheduled",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "terminated"
}
```

```json
{
  "type": "summarization_retry_attempt_start",
  "source": "compaction",
  "reason": "threshold"
}
```

For branch summaries, `source` is `"branchSummary"` and no `reason` is present.

```json
{
  "type": "summarization_retry_finished"
}
```

### subagents_update

Emitted under the `ice` launcher whenever the subagent overview changes (a child starts, finishes, parks, or is deleted, or an approval is queued or answered). `overview` has the same shape as the `get_subagents` data. Identical consecutive overviews are not repeated.

```json
{
  "type": "subagents_update",
  "overview": {"enabled": true, "capacity": {"running": 0, "queued": 0, "max": 4}, "maxDepth": 0, "children": [], "approvals": [], "diagnostics": []}
}
```

### shells_update

Emitted when a background shell starts, prints output, or finishes. Bursts are coalesced and identical consecutive lists are not repeated. `shells` has the `get_shells` shape, without output.

```json
{"type": "shells_update", "shells": [{"taskId": "bash-1", "command": "npm run dev", "origin": "model", "status": "running", "startedAt": 1760000000000, "totalChars": 812}]}
```

### extension_error

Emitted when an extension throws an error.

```json
{
  "type": "extension_error",
  "extensionPath": "/path/to/extension.ts",
  "event": "tool_call",
  "error": "Error message..."
}
```

## Extension UI Protocol

Extensions can request user interaction via `ctx.ui.select()`, `ctx.ui.confirm()`, etc. In RPC mode, these are translated into a request/response sub-protocol on top of the base command/event flow.

There are two categories of extension UI methods:

- **Dialog methods** (`select`, `confirm`, `input`, `editor`): emit an `extension_ui_request` on stdout and block until the client sends back an `extension_ui_response` on stdin with the matching `id`.
- **Fire-and-forget methods** (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`, `setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`): emit an `extension_ui_request` on stdout but do not expect a response. The client can display the information or ignore it.

If a dialog method includes a `timeout` field, the agent-side will auto-resolve with a default value when the timeout expires. The client does not need to track timeouts.

Some `ExtensionUIContext` methods are not supported or degraded in RPC mode because they require direct TUI access:
- `custom()` returns `undefined`
- `setFooter()`, `setHeader()`, `setEditorComponent()`, `setToolsExpanded()` are no-ops
- `getEditorText()` returns `""`
- `getToolsExpanded()` returns `false`
- `pasteToEditor()` delegates to `setEditorText()` (no paste/collapse handling)
- `getAllThemes()` returns `[]`
- `getTheme()` returns `undefined`
- `setTheme()` returns `{ success: false, error: "..." }`

Note: `ctx.mode` is `"rpc"` and `ctx.hasUI` is `true` in RPC mode because the dialog and fire-and-forget methods are functional via the extension UI sub-protocol. Use `ctx.mode === "tui"` to guard TUI-specific features like `custom()` that require a real terminal.

### Extension UI Requests (stdout)

All requests have `type: "extension_ui_request"`, a unique `id`, and a `method` field.

#### select

Prompt the user to choose from a list. Dialog methods with a `timeout` field include the timeout in milliseconds; the agent auto-resolves with `undefined` if the client doesn't respond in time.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "select",
  "title": "Allow dangerous command?",
  "options": ["Allow", "Block"],
  "timeout": 10000
}
```

Expected response: `extension_ui_response` with `value` (the selected option string) or `cancelled: true`.

#### confirm

Prompt the user for yes/no confirmation.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-2",
  "method": "confirm",
  "title": "Clear session?",
  "message": "All messages will be lost.",
  "timeout": 5000
}
```

Expected response: `extension_ui_response` with `confirmed: true/false` or `cancelled: true`.

#### input

Prompt the user for free-form text.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-3",
  "method": "input",
  "title": "Enter a value",
  "placeholder": "type something..."
}
```

Expected response: `extension_ui_response` with `value` (the entered text) or `cancelled: true`.

#### editor

Open a multi-line text editor with optional prefilled content.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-4",
  "method": "editor",
  "title": "Edit some text",
  "prefill": "Line 1\nLine 2\nLine 3"
}
```

Expected response: `extension_ui_response` with `value` (the edited text) or `cancelled: true`.

#### notify

Display a notification. Fire-and-forget, no response expected.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-5",
  "method": "notify",
  "message": "Command blocked by user",
  "notifyType": "warning"
}
```

The `notifyType` field is `"info"`, `"warning"`, or `"error"`. Defaults to `"info"` if omitted.

#### setStatus

Set or clear a status entry in the footer/status bar. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-6",
  "method": "setStatus",
  "statusKey": "my-ext",
  "statusText": "Turn 3 running..."
}
```

Send `statusText: undefined` (or omit it) to clear the status entry for that key.

#### setWidget

Set or clear a widget (block of text lines) displayed above or below the editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-7",
  "method": "setWidget",
  "widgetKey": "my-ext",
  "widgetLines": ["--- My Widget ---", "Line 1", "Line 2"],
  "widgetPlacement": "aboveEditor"
}
```

Send `widgetLines: undefined` (or omit it) to clear the widget. The `widgetPlacement` field is `"aboveEditor"` (default) or `"belowEditor"`. String arrays are supported directly. Component factories are never invoked; optional `ExtensionWidgetOptions.rpcText` supplies a text projection for them, and an omitted projection leaves the prior RPC widget unchanged.

#### setHeader / setFooter

Set or clear the text projection of an extension's custom header or footer. Fire-and-forget.

```json
{"type": "extension_ui_request", "id": "uuid-13", "method": "setFooter", "lines": ["main | 3 tasks"]}
```

`lines` comes from `ExtensionChromeOptions.rpcText`. It is absent when the extension restores the built-in header/footer or gives no projection; clear the client's copy then.

#### setTitle

Set the terminal window/tab title. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-8",
  "method": "setTitle",
  "title": "ice - my project"
}
```

#### set_editor_text

Set the text in the input editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-9",
  "method": "set_editor_text",
  "text": "prefilled text for the user"
}
```

#### Working status

Working-status requests are fire-and-forget:

```json
{"type":"extension_ui_request","id":"uuid-10","method":"setWorkingMessage","message":"Preparing memory recall..."}
{"type":"extension_ui_request","id":"uuid-11","method":"setWorkingVisible","visible":true}
{"type":"extension_ui_request","id":"uuid-12","method":"setWorkingIndicator","options":{"frames":[".","..","..."],"intervalMs":100}}
```

Omitting `message` or `options` restores defaults; an empty `frames` array hides the indicator. Clients may display the status without reproducing terminal animations.

### Extension UI Responses (stdin)

Responses are sent for dialog methods only (`select`, `confirm`, `input`, `editor`). The `id` must match the request.

#### Value response (select, input, editor)

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

#### Confirmation response (confirm)

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

#### Cancellation response (any dialog)

Dismiss any dialog method. The extension receives `undefined` (for select/input/editor) or `false` (for confirm).

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

## Error Handling

Failed commands return a response with `success: false`. Parse errors use a generic message without echoing possibly credential-bearing input snippets. Input envelopes, required fields, optional booleans, enums, model-scope references, images, and dialog response values are validated before dispatch. Request-specific cancellation/deadline failures use `cancelled`/`timeout`; native aborted compaction is classified `cancelled` too. Errors include a machine-readable `errorCode`: `invalid_request` for invalid JSON/envelopes, `invalid_argument` for malformed fields, `unknown_command` for unsupported commands, `busy` or `not_found` in explicitly classified handlers, and `failed` for otherwise unclassified execution failures. Settings and structured commands retain their more specific codes and `errorDetails`. `RpcClient` rejects failed responses with `RpcRequestError` for all methods, including methods returning `void`.

```json
{
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: invalid/model"
}
```

Parse errors:

```json
{
  "type": "response",
  "command": "parse",
  "success": false,
  "error": "Failed to parse command: invalid JSON."
}
```

## TypeScript client events and dialog replies

`RpcClient.onEvent()` receives the `RpcEvent` union: JSON agent/session events, extension UI requests, shell updates, subagent updates, and session-change notifications. `collectEvents()` and `promptAndWait()` return the same union. Narrow by `type`, then by `method` for extension UI. Reply with `respondToExtensionUI(response)` using the dialog's original ID; it resolves after the stdin write, without allocating a command request or waiting for an ordinary response.

```ts
client.onEvent((event) => {
  if (event.type === "extension_ui_request" && event.method === "confirm") {
    void client.respondToExtensionUI({
      type: "extension_ui_response", id: event.id, confirmed: false,
    }).catch(handleTransportError);
  }
});
```

A throwing event listener does not prevent delivery to other listeners. `RpcClientOptions.onListenerError(error, event)` can report subscriber failures; without it a generic warning is written to stderr. Reporter failures are isolated too. `getStderr()` retains only the newest 65,536 characters and resets at each start; forwarding child stderr to the host is unchanged and is not redacted. Stopping the client rejects pending requests and active idle/event collectors immediately; process errors/exits also reject those collectors instead of leaving them waiting for their timers. A late/unmatched response is not delivered as an event. Response envelopes and command-specific success payloads are validated before settlement, including nested models, messages, entries, trees, tools, settings, schemas, shells and subagent views. Malformed failure `errorCode`/`errorDetails` also reject with `invalid_response`. Validation bounds traversal to 1,000,000 values and 128 data levels, with nested tree shape limited to 64 nodes of depth; use shallow tree pages for deeper histories. Cycles, accessors, sparse/exotic objects and unknown native message roles are rejected. Opaque extension metadata and unknown extra fields remain bounded data, not semantically verified content. Event typing is not exhaustive runtime payload validation.

`RpcClient.start()` now waits for a protocol-v1 capability response rather than sleeping 100 ms. `startupTimeoutMs` defaults to 30 seconds and must be a positive timer-safe integer. Invalid/unsupported/silent handshakes reject startup and stop the spawned process; there is no older-runtime fallback. Subscribe before `start()` to handle any initialization-time extension UI requests. The client startup handshake uses its own correlation-ID namespace, leaving ordinary request IDs unchanged.

## Types

Source files:
- [`packages/ai/src/types.ts`](../../ai/src/types.ts) - `Model`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`
- [`packages/agent/src/types.ts`](../../agent/src/types.ts) - `AgentMessage`, `AgentEvent`
- [`src/core/messages.ts`](../src/core/messages.ts) - `BashExecutionMessage`
- [`src/modes/json-event.ts`](../src/modes/json-event.ts) - `JsonAgentSessionEvent`
- [`src/modes/rpc/rpc-types.ts`](../src/modes/rpc/rpc-types.ts) - RPC command/response types, extension UI request/response types

### Model

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": {
    "input": 3.0,
    "output": 15.0,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  }
}
```

### UserMessage

```json
{
  "role": "user",
  "content": "Hello!",
  "timestamp": 1733234567890,
  "attachments": []
}
```

The `content` field can be a string or an array of `TextContent`/`ImageContent` blocks.

### AssistantMessage

```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello! How can I help?"},
    {"type": "thinking", "thinking": "User is greeting me..."},
    {"type": "toolCall", "id": "call_123", "name": "bash", "arguments": {"command": "ls"}}
  ],
  "api": "anthropic-messages",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "stopReason": "stop",
  "timestamp": 1733234567890
}
```

Stop reasons: `"stop"`, `"length"`, `"toolUse"`, `"error"`, `"aborted"`

### ToolResultMessage

```json
{
  "role": "toolResult",
  "toolCallId": "call_123",
  "toolName": "bash",
  "content": [{"type": "text", "text": "total 48\ndrwxr-xr-x ..."}],
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 150,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "isError": false,
  "timestamp": 1733234567890
}
```

`usage` is optional and reports nested LLM work performed by the tool. When present, it contributes to session token and cost totals.

### BashExecutionMessage

Created by the `bash` RPC command (not by LLM tool calls):

```json
{
  "role": "bashExecution",
  "command": "ls -la",
  "output": "total 48\ndrwxr-xr-x ...",
  "exitCode": 0,
  "cancelled": false,
  "truncated": false,
  "fullOutputPath": null,
  "timestamp": 1733234567890
}
```

### Attachment

```json
{
  "id": "img1",
  "type": "image",
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 102400,
  "content": "base64-encoded-data...",
  "extractedText": null,
  "preview": null
}
```

## Example: Basic Client (Python)

```python
import subprocess
import json

proc = subprocess.Popen(
    ["ice", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True
)

def send(cmd):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()

def read_events():
    for line in proc.stdout:
        yield json.loads(line)

# Send prompt
send({"type": "prompt", "message": "Hello!"})

# Process events
for event in read_events():
    if event.get("type") == "message_update":
        delta = event.get("assistantMessageEvent", {})
        if delta.get("type") == "text_delta":
            print(delta["delta"], end="", flush=True)
    
    if event.get("type") == "agent_end":
        print()
        break
```

## Example: Interactive Client (Node.js)

See [`test/rpc-example.ts`](../test/rpc-example.ts) for a complete interactive example, or [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts) for a typed client implementation.

For a complete example of handling the extension UI protocol, see [`examples/rpc-extension-ui.ts`](../examples/rpc-extension-ui.ts) which pairs with the [`examples/extensions/rpc-demo.ts`](../examples/extensions/rpc-demo.ts) extension.

```javascript
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const agent = spawn("ice", ["--mode", "rpc", "--no-session"]);

function attachJsonlReader(stream, onLine) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    stream.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

        while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;

            let line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            onLine(line);
        }
    });

    stream.on("end", () => {
        buffer += decoder.end();
        if (buffer.length > 0) {
            onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
        }
    });
}

attachJsonlReader(agent.stdout, (line) => {
    const event = JSON.parse(line);

    if (event.type === "message_update") {
        const { assistantMessageEvent } = event;
        if (assistantMessageEvent.type === "text_delta") {
            process.stdout.write(assistantMessageEvent.delta);
        }
    }
});

// Send prompt
agent.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

// Abort on Ctrl+C
process.on("SIGINT", () => {
    agent.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
});
```
