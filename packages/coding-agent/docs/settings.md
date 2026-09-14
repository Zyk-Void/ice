# Settings

For ICE delegation, see the [subagent user guide](subagent-user-guide.md), including opt-in exact child routes, native durable hook intents, host-owned command-hook policy, and project workflow skills. Its approved expansion contracts supersede historical deferral notes below.

Stock `ice` uses JSON settings files with project settings overriding global settings. The `ice` launcher opts into global-first ordinary preferences, including startup, reload, scoped writes, and session switches. Permission denies, trust, and restrictive caps remain separate from preference precedence.

| Location | Scope |
|----------|-------|
| `~/.ice/agent/settings.json` | Global (all projects) |
| `.ice/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## Project Trust

On interactive startup, ice asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.ice/agent/trust.json`. Trusting a project allows ice to load `.ice/settings.json` and `.ice` resources, install missing project packages, and execute project extensions.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.ice/agent/settings.json`, or change it with `/settings`.

`ice config` and package commands use the same project trust flow, except `ice update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.ice/agent/trust.json` only; the current session is not reloaded, so restart ice for changes to take effect.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`, `"ultra"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `showCacheMissNotices` | boolean | `false` | Show transcript notices for significant prompt-cache misses |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `externalEditor` | string | `$VISUAL`, then `$EDITOR`, then Notepad on Windows or `nano` elsewhere | Command for Ctrl+G external editor; takes precedence over environment variables |
| `quietStartup` | boolean | `false` | Hide startup header |
| `defaultProjectTrust` | string | `"ask"` | Fallback project trust behavior: `"ask"`, `"always"`, or `"never"`. Global setting only |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `enableInstallTelemetry` | boolean | `true` | Send an anonymous install/update version ping after first install or changelog-detected updates. This does not control update checks |
| `enableAnalytics` | boolean | `false` | Opt-in analytics data sharing. Currently only asked for during the experimental first-time setup (`ICE_EXPERIMENTAL=1`) |
| `trackingId` | string | - | Analytics tracking identifier, generated when `enableAnalytics` is turned on |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `outputPad` | number | `1` | Horizontal padding for user messages, assistant messages, and thinking (0 or 1) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while TUI positions it for IME support |
| `uiMode` | string | `"regular"` | Interactive UI mode: `"regular"` or experimental `"fullscreen"`. Changes from `/settings` apply immediately; `--ui-mode` overrides this setting at startup |
| `fullscreenScrollbar` | string | `"auto"` | Fullscreen transcript scrollbar: `"auto"` shows it temporarily while scrolling, `"always"` reserves the rightmost column and keeps it visible, and `"hidden"` hides it. Has no effect in regular UI mode |

For VS Code, include `--wait` so ice resumes after the editor exits:

```json
{
  "externalEditor": "code --wait"
}
```

### Telemetry and update checks

`enableInstallTelemetry` only controls the anonymous install/update ping to `https://ice.dev/api/report-install`. Opting out of telemetry does not disable update checks; Ice can still fetch `https://ice.dev/api/latest-version` to look for the latest version.

Set `ICE_SKIP_VERSION_CHECK=1` to disable the Ice version update check. Use `--offline` or `ICE_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

### Network

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `httpProxy` | string | - | HTTP proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY`. Global setting only. |

```json
{
  "httpProxy": "http://127.0.0.1:7890"
}
```

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.thresholdPercent` | number | `85` | Context percentage that triggers automatic compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for the compaction summary response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |
| `compaction.midRunCompaction` | string | `"off"` | Native mid-tool-loop mode: `"off"`, `"pause"`, or `"resume"` |

```json
{
  "compaction": {
    "enabled": true,
    "thresholdPercent": 85,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "midRunCompaction": "off"
  }
}
```

### Optional Blackhole Extension

Load the optional extension with `--extension packages/coding-agent/examples/extensions/ice-blackhole/index.ts` or install the package through Ice's package settings. It stores configuration at `~/.ice/agent/ice-blackhole/ice-blackhole-config.json`.

```text
/blackhole percent 20
/blackhole tokens 54400
/blackhole resume
/blackhole pause
/blackhole off
/blackhole status
```

The loaded extension also exposes all Blackhole fields in `/settings`: compaction mode, engine, mid-run mode, threshold mode and value, tail behavior, and memory. Changes persist to the Blackhole config file immediately. Set `memory: false` to keep deterministic compaction without observational-memory workers. Keep native `compaction.enabled` set to `true` for overflow recovery and native `compaction.midRunCompaction` set to `"off"` when Blackhole owns the mid-run trigger.

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs`, the request fails immediately with an informative error instead of waiting silently. Set it to `0` to disable the limit.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are explicitly needed. Setting it above `0` can make SDK/provider retries handle out-of-usage-limit errors before Ice sees them, which may block the agent until the provider quota resets in some circumstances.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header/body idle timeout in milliseconds, also used by providers with explicit stream idle timeouts. Set to `0` to disable. |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connect/open handshake timeout in milliseconds for providers that support WebSocket transports. Set to `0` to disable. |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max. Applies to `@file` attachments, `read`, and images returned by tools |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows); supports a leading `~` for the home directory |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. User-scoped npm packages install under `~/.ice/agent/npm/`; project-scoped npm packages install under `.ice/npm/`. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".ice/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `ICE_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.ice/agent/settings.json` resolve relative to `~/.ice/agent`. Paths in `.ice/settings.json` resolve relative to `.ice`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["ice-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "ice-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## ICE subagents and hooks

ICE keeps its operational settings under the existing `ice` namespace. Global values live in `~/.ice/agent/settings.json`; trusted project values live in `.ice/settings.json`. The namespace is parsed strictly: unknown keys in `ice.subagents.restrictions` or `ice.hooks` fail closed for delegation instead of being ignored.

```json
{
  "ice": {
    "subagents": {
      "enabled": true,
      "defaults": {
        "thinking": "medium",
        "timeoutMs": 120000,
        "maxOutputBytes": 24576
      },
      "allowedRoles": ["self", "api-review"],
      "roleDefaults": {
        "api-review": { "thinking": "high" }
      },
      "restrictions": {
        "maxTimeoutMs": 300000,
        "denyTools": ["bash", "write", "edit"]
      },
      "modelSelection": { "mode": "inherit-parent" }
    },
    "hooks": {
      "enabled": true,
      "definitions": [
        {
          "id": "review-launch-policy",
          "event": "subagent.beforeLaunch",
          "roles": ["self", "api-review"],
          "kind": "in-process",
          "timeoutMs": 1500,
          "required": true
        }
      ]
    }
  }
}
```

Resolution is deterministic and global-first for ice: an explicit global value beats a trusted-project value, then the built-in/file default (bundled/global defaults, project defaults, per-role defaults, and per-call requests are resolved once before launch). Timeout/output caps and deny lists narrow authority; they never widen the parent. An omitted or empty `allowedRoles` list adds no restriction; use `restrictions.denyRoles` for explicit denial. Project settings are ignored until project trust is established, and a more-specific allow cannot override a broader deny. Malformed settings files and security-sensitive namespaces fail closed. Every launch result reports effective timeout/output limits, tool restrictions, source labels, and bounded diagnostics. Stock `ice` keeps its existing project-first merge; the `ice` launcher uses global-first shared preferences, not only its subagent namespace. File-agent discovery uses `~/.ice/agents` (or `<agentDir>/agents` for an explicit custom directory) ahead of trusted `.ice/agents`, with shadowed sources surfaced. Explicit global arrays replace the corresponding project configuration arrays; explicit empty, false, and zero values are not treated as missing. For subagent preferences the order is file/default, project default, project role, global default, global role, then explicit invocation request; hard caps and denies apply afterward.

Read/review delegation also accepts an optional restricted local `outputSchema` object. The root must be an object with `additionalProperties: false`; only bounded object/array/string/number/integer/boolean/null nodes are supported. `$ref`, remote schemas, unions, executable validators, and unknown keywords are rejected before child creation. A valid schema validates a nested `payload` while the mandatory `summary`/`evidence` envelope remains authoritative. Payloads are capped at 16 KiB and are retained in bounded durable result projections.

`manage_subagent` supports `inspect`, `extend`, `stop`, owner-bound `follow_up`, `resume`, and `delete`. Follow-up requires a stable `requestId`, is deduplicated, queues through the retained native Ice child, preserves its original scope/tools/model/execution contract, and is rejected while a user has Take Control. `resume` continues an eligible completed child in its original session under a new run id, re-derives profile/resources/project trust/tool authority fail-closed at the resume boundary, re-points the session's own tool/stream/turn-stop wrappers at the resumed run's hooks and authority callback, and cannot widen model/profile/scope/tools; `delete` is owner-scoped and idempotent, rejects active children, and releases both the retained session and its historical view snapshot. Durable async acceptance stores the resolved thinking, timeout, output limit, tools, and profile source hash; settings changes do not silently re-resolve accepted jobs.

The shipped hook dispatcher supports trusted parent-owned in-process handlers supplied by the ICE integration. Decision events are `subagent.beforeLaunch`, `subagent.beforeTool`, and `subagent.beforeAccept`; observational lifecycle events, including bounded `subagent.checkpoint`, cannot authorize work. Optional `roleHookIds` and `callHookIds` selections filter optional hooks as a union; required hooks remain active, and an explicitly empty selector selects no optional hooks. A `beforeLaunch` handler may return bounded `contextAdditions`; the parent redacts and merges them into the context packet, then reruns context, source/resource, scope, and preflight validation before admission. Missing approval, malformed required-hook output, timeout, or a required handler that is unavailable blocks the gated action. Executable hooks require global `ice.hooks.commandPolicy`, trusted build mode, startup-authorized parent Bash, pinned executable/script identities, and execution approval. Plan/review children cannot execute command hooks. Global definitions win ID collisions without downgrading required status. Trusted handlers can register through `registerIceSubagentHook(ice.events, id, handler)`; replacement/unregistration of a captured handler fails closed. Hooks never load child extensions, create another agent loop, or grant additional model/tool authority. Each dispatched handler gets a stable event ID; the parent persists redacted intent/outcome records in the session, and reload warns about unresolved intent without replaying the hook.

`modelSelection.mode` accepts `"inherit-parent"` (default) or `"configured"` (global opt-in for exact per-call/file routes resolved through Ice's catalog). File agents may declare exact `model`/`fallbackModel` references; candidates run call/primary/fallback/parent with bounded skip reasons and policy denials fail the launch. `allowedRoles` is an intersection restriction, not an authority-granting union. `ice.subagents.enabled: false` blocks new launches while retained jobs remain inspectable and cancellable through their existing owner-scoped APIs.

### Profile authoring templates

Custom roles stay data-only Markdown profiles under the file-agent locations (`~/.ice/agents` globally, or `<agentDir>/agents` for an explicit custom directory, and `.ice/agents` for trusted projects). Expertise belongs in the prompt; `tools` is the declared capability request and is still intersected with parent mode, active tools, scope, and ICE restrictions. Supported authority-neutral fields include `model`, `fallbackModel`, `skills`, `prompts`, `context`, `hooks`, and explicit `mcp` server/tool selectors.

```markdown
---
name: api-review
description: Review API changes for compatibility and security regressions
tools: read, grep, find, ls
thinking: high
timeoutMs: 180000
---

Review only the approved scope. Report concrete file evidence and unresolved claims;
do not modify files, delegate, or infer approval from this prompt.
```

Useful specializations include `api-review`, `migration-review`, `frontend-review`, and `verification`; do not add executable commands or ambient resource discovery to a profile as a way to expand authority. `model`, `fallbackModel`, `hooks`, skills, and explicit `mcp` selectors are data, never permission grants: the child still cannot exceed parent authority, mode restrictions, or deny policy. `list_subagent_profiles` reports requested versus effective tools, primary/fallback models, effective MCP selections, bounded budgets, source labels, and diagnostics without executing the profile. Interactive `/settings` also exposes an `Effective policy` submenu with bounded source-aware role budgets, trust/enablement state, hook declarations, routing policy, and settings-load errors; it does not author executable roles.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "thresholdPercent": 85,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["ice-skills"]
}
```

## Project Overrides

Stock `ice` settings keep the existing project-first merge: project settings (`.ice/settings.json`) override global settings. Nested objects are merged. The `ice` launcher instead selects explicit global preferences first across its shared settings; this does not modify stock `ice` (see above). File-agent discovery uses `~/.ice/agents` globally (or `<agentDir>/agents` for an explicit custom directory); legacy `~/.ice/agent/agents` files appear only in the non-destructive migration manifest.

```json
// ~/.ice/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .ice/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Stock ice result; ice keeps the explicit global reserveTokens: 16384
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
