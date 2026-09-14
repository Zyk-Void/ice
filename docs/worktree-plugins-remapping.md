# `plugins-remapping` worktree: plugin remapping and memory/compaction

## Scope and repository-state caveat

This note documents the implementation visible in the `plugins-remapping` worktree. It intentionally separates implementation evidence from Git state:

- The in-tree `progress.md` and `findings.md` records identify the worktree's recorded baseline as `HEAD 7cbd8a676815cbfef3b03a4902269ede2ac2fbf1` and describe the worktree as dirty with concurrent changes.
- This documentation pass did not have a Git-metadata reader, so that SHA and the exact current `HEAD`-relative status were not independently refreshed. They are recorded repository evidence, not a fresh `git status` result.
- Consequently, the committed/uncommitted boundary and a complete exact changed-file list cannot be asserted here. The file list below is an observed implementation surface, not a claim that every file is uncommitted or that no other file differs.
- Existing planning/audit material says that the Blackhole/Cognee completion pass changed only the scoped Blackhole/Cognee implementation, tests, and documentation while preserving unrelated concurrent work. Treat that as historical evidence and verify against Git before release or merge.

No credentials or secret values are reproduced.

## What “plugin remapping” means in ICE

ICE does not execute Claude Code's `hooks.json` plugin format. The Claude-style integration is remapped onto ICE's extension event API and resource model. The stock `ice` launcher remains unchanged; the ICE launcher registers the hidden `ice-cognee` extension.

### Lifecycle remapping

| Claude-style concern | ICE event/resource seam | Implemented behavior |
|---|---|---|
| `SessionStart` | `session_start` | Resolve the Cognee session ID, resolve the runtime dataset, apply the read-only search tool state, probe health asynchronously, optionally register the agent, drain pending memory, and drain the warmup buffer. |
| `UserPromptSubmit` recall | `before_agent_start` | Perform bounded `session`/`trace`/`graph` recall and append it to the current system prompt for this turn only. |
| `UserPromptSubmit` capture | `before_agent_start` | Redacted user text is retained as the pending question for later QA capture. |
| `PostToolUse` | `tool_result` | Capture only the configured primary coding tools, with bounded and redacted parameters and return text. Cognee's own search tool is excluded from this trace path. |
| `Stop` | `agent_end` | Pair the pending prompt with the last assistant answer and enqueue a redacted QA/session-cache entry. |
| `PreCompact` | `session_before_compact` | Store a local pre-compact anchor when ICE/Blackhole owns the summary; optionally perform the separate checkpoint-recall handoff described below. |
| Final compact checkpoint | `session_compact` | Observe the summary produced by native ICE, Blackhole, or explicit Cognee ownership; cache it for the next turn and queue it for durable Cognee remember when enabled. |
| `SessionEnd` | `session_shutdown` | Close the observer, wait for tracked work, optionally run `/improve`, then unregister the Cognee agent. |
| Idle watcher | `agent_settled` | Wait for background capture, then run a cooldown-gated improve operation. |
| Skills | `resources_discover` | Expose `cognee-remember`, `cognee-search`, and `cognee-sync` through ICE skill discovery. |

The implementation is therefore an adapter, not a second plugin runtime or session store. `packages/coding-agent/src/ice-cognee.ts` contains the event registration and policy; `packages/coding-agent/src/ice-cognee-client.ts` contains the HTTP client and bounded transport; `packages/coding-agent/src/ice-cognee-observer.ts` contains local capped observation support.

### Commands, packages, and resource remapping

There are three separate compatibility layers:

1. **Legacy ICE directory migration.** `packages/coding-agent/src/migrations.ts` runs at startup. If a global or project `commands/` directory exists and the corresponding `prompts/` directory does not, it renames `commands/` to `prompts/`. It does not merge two existing directories. It warns when deprecated `hooks/` directories or non-binary content remains in `tools/`; custom tools are expected to move into extensions. Managed `fd`/`rg` binaries are handled separately by the tools-to-bin migration.
2. **ICE package manifests.** `packages/coding-agent/src/core/ice-manifest.ts` reads a package's `package.json` `ice` object. The supported manifest arrays are `extensions`, `skills`, `prompts`, and `themes`; each entry must be a string. `packages/coding-agent/src/core/extensions/loader.ts` uses `ice.extensions` for extension entry points, while `package-manager.ts` resolves all four resource classes.
3. **Conventional package directories and filters.** Without a manifest, package resources are discovered from `extensions/`, `skills/`, `prompts/`, and `themes/`. Object-form package settings can narrow each class with globs, `!` exclusions, `+` exact force-includes, and `-` exact force-excludes; omitted fields load that class by default and `[]` loads none. Project resources take precedence over user resources, and package-origin resources are lower precedence than top-level configured resources. Project trust gates project-local settings/resources and missing project package installation.

ICE does not claim to parse arbitrary Claude plugin manifests. Claude/Codex skills can be consumed by adding their skill directories to ICE settings; skill files remain instructions and do not grant tools or permissions.

## Cognee configuration and data boundaries

The defaults in `packages/coding-agent/src/ice-cognee.ts` are:

```json
{
  "enabled": true,
  "autoRecall": true,
  "autoRemember": "compaction",
  "captureSession": true,
  "captureTools": true,
  "autoImprove": true,
  "compactionSummaryMode": "auto",
  "checkpointRecall": false,
  "topK": 5,
  "baseUrl": "http://127.0.0.1:8211",
  "dataset": "ice",
  "recallBudgetMs": 10000,
  "recallMaxChars": 6000,
  "rememberMaxChars": 12000,
  "captureMaxChars": 8000,
  "queueLimit": 64,
  "maxResponseChars": 12000
}
```

The persistent ICE configuration is documented as `~/.ice/agent/ice-cognee/config.json`; the implementation also supports the configured `ICE_CODING_AGENT_DIR` root. Runtime commands include `/cognee status`, `watch`, `doctor`, `on`, `off`, `recall`, `capture`, `tools`, `improve`, `remember`, `search`, and `flush`.

`packages/coding-agent/src/ice-cognee-env.ts` provides the environment remapping:

- Values parsed from the shared Cognee `.env` are placed below process environment values, so process values win.
- `COGNEE_LOCAL_API_URL` is used as `COGNEE_BASE_URL` when no base URL is already present.
- `ICE_COGNEE_*` controls ICE-specific settings; `COGNEE_*` routing/session values are accepted for compatibility.
- `COGNEE_PLUGIN_DATASET` is deliberately **not** auto-mapped to ICE's dataset. ICE remains on `ice` by default, or uses `ICE_COGNEE_DATASET`/`COGNEE_DATASET` when explicitly configured.
- API-key selection in `ice-cognee.ts` gives an explicit key the highest priority, then the ICE/Cognee key-file compatibility locations, then the merged environment. The implementation records only the source category, never the value.

Set `dataset` to `$project` to resolve a repository-scoped dataset from the Git root and an abbreviated hash. An explicit dataset name remains shared according to the Cognee server's semantics.

Recall responses are bounded at transport and prompt-injection layers. Returned memory is labeled untrusted reference data. Session-cache and permanent-memory writes are redacted; failed session-cache writes are retained in a bounded warmup area for a later drain. Network, authentication, timeout, and unsupported-route failures soft-fail the agent loop and are visible through status/diagnostics rather than replacing the ICE session runtime.

## Compaction and Blackhole cooperation

ICE remains authoritative for the compaction trigger, session tree, and session rewrite. Native compaction summarizes the messages selected by ICE and appends a native compaction entry. Blackhole is an optional extension that can provide a deterministic mid-run summary through `session_before_compact`; it does not create a competing session history.

### Summary ownership modes

`compactionSummaryMode` is implemented in `ice-cognee.ts`:

- **`auto` (default):** always defers summary ownership to native ICE or Blackhole. Cognee stores the final summary but cannot replace it with a recall dump.
- **`defer`:** also never returns a compaction summary. A cheap local pre-compact anchor may be stored where applicable.
- **`own`:** explicit opt-in. Cognee produces a local structured summary from `messagesToSummarize` and the turn-prefix messages. On overflow or a retrying compaction, it skips the network and returns a bounded local anchor instead.

After `session_compact`, the final summary is redacted, cached as `lastCompactSummary`, prepended once to the next turn without waiting for a Cognee search, and queued under the configured pending-memory directory when `autoRemember` is `compaction`. This keeps the durable remember operation separate from the ICE session history.

### Blackhole threshold and retained tail

The source-of-truth extension under `packages/coding-agent/examples/extensions/ice-blackhole/` uses:

- `compactAfterPercent` from 1 through 99, default `85`;
- the active model context window to calculate the threshold;
- `tailBehavior: "minimal"` by default, or `"ice-default"` to retain ICE's normal recent tail;
- `midRunCompaction: "resume" | "pause" | "off"`;
- `memory: false` by default.

Legacy `compactAfterTokens` configuration and the old token command/environment variable are ignored. If the active model has no valid positive context window, automatic percentage-based compaction is skipped with a warning. If both native mid-run compaction and Blackhole are active, Blackhole yields to native ICE to avoid duplicate triggers and abort races.

With `minimal`, the retained ICE tail is summarized and dropped; the checkpoint retains the new summary and later resume/user messages instead of keeping the normal approximately 20,000-token ICE tail. The Blackhole summary also adds volatile `[Last Actions]` and, when present, `[Running Agents]` sections. These sections are rebuilt from current compact-source data rather than copied forward from an old summary.

### Optional checkpoint-recall handoff

When all of the following are true, `checkpointRecall` is enabled, and Blackhole owns the compaction, Cognee performs one bounded recall seeded from the newest summarized user message:

1. the Cognee client and recall circuit are available;
2. the query is non-empty;
3. results survive redaction and configured character caps.

The producer atomically writes a handoff at the configured agent root's `ice-cognee/compaction-recall.json` with `generatedAt`, `hostSessionId`, `query`, and bounded `results`. It clears a same-session stale handoff before each relevant attempt, including disabled/empty cases. The Blackhole source-of-truth consumer validates the timestamp, rejects future/expired payloads, checks the host session ID, caps the rendered lines, labels them `Untrusted reference data recalled by Cognee`, and deletes the file after consumption or invalidation. A handoff belonging to another host session is left untouched.

This path is opt-in because ordinary next-turn recall usually provides the same information. It is useful when the next prompt is vague (for example, `continue`) and cannot seed a useful query. It is independent of per-prompt `autoRecall`.

## Verification evidence visible in the worktree

The following is recorded evidence, not a test run performed by this documentation pass:

- `agent_docs/implementation/ice-blackhole-compaction-improvement-plan-audit.md` records the completion audit as 17.5/18 scoreable points, focused Blackhole/Cognee coverage of **64/64 tests**, clean TypeScript and Biome checks, and passing pinned-dependency, relative-import, shrinkwrap, install-lock, and browser-smoke checks.
- The same audit records the remaining verification limitation: the literal root `corepack npm@12.0.2 run check` reached the Biome stage but its nested `npm run` resolved to npm 11.19.0 and failed the repository's npm 12 `devEngines` requirement. This is an environment-wrapper failure, not evidence that the full check currently passes.
- `progress.md` records an earlier, narrower **39-test** Cognee/Blackhole run and a root-check blockage involving a nested worktree configuration plus pre-existing `packages/ai` model-ID errors. That is an older snapshot and should not be combined with the later 64/64 count.
- `packages/coding-agent/test/ice-cognee.test.ts` visibly covers transient recall, compaction-summary ownership, last-compact injection, checkpoint-recall persistence/gating, stale handoff cleanup, and session tagging. Blackhole unit/integration coverage is under `packages/coding-agent/examples/extensions/ice-blackhole/src/core/` and `packages/coding-agent/test/suite/blackhole-compaction.test.ts`.
- No live provider, Cognee server, or paid-model verification was performed as part of this documentation pass. The audit's live/runtime statements remain historical evidence and must not be treated as a fresh health check.

## Limitations and operational cautions

- The fixed checkpoint handoff filename is protected by host-session validation but can still be overwritten by two concurrent producer processes. A fully cross-process-safe protocol would require a separate locking or session-scoped filename design.
- `observations.jsonl`, warmup/session-cache directories, and the shared recall/write circuit have documented follow-up considerations; this implementation does not claim general-purpose retention, rotation, or separate circuit breakers.
- Continuous capture and idle/shutdown improve can incur Cognee server LLM/embedding costs. Disable them with the documented `/cognee capture off` and `/cognee improve off` controls when only recall/compaction memory is wanted.
- Cognee is not a sandbox. Extensions and installed packages execute with the ICE process's host permissions, and Cognee memory is external derived data. Project trust and package review remain required.
- The checked-in source-of-truth Blackhole copy and `user-extensions/ice-blackhole` are not byte-for-byte behaviorally identical in this worktree: the source-of-truth checkpoint consumer validates `results` and `hostSessionId`, while the user-extension copy still reads the older `recall` shape and does not apply the host-session argument. Synchronize or explicitly select the source-of-truth copy before relying on checkpoint recall in a user extension installation.
- The exact current Git commit, clean/dirty status, and committed/uncommitted split remain unverified by this pass. Verify them before presenting this document as a release or merge report.
