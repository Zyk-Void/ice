# Audit Report: Five Recent Commits

## Scope and method

This report reviews the five commits previously identified at the current branch tip, in newest-to-oldest order. Five read-only subagents each inspected one commit against its parent, including the committed source and test changes. Findings below are tied to those commit snapshots, not to the current working tree.

The worktree was already dirty when the review began, including changes to some paths also touched by these commits. Those changes were not modified. This is a code-and-test review, not a claim that the full test suites or repository checks passed; test coverage below describes assertions present in the commits. No project test or check command was run for this report.

## Executive summary

- **`9e866593f`** adds end-to-end background shell execution and interactive management.
- **`411cc7bab`** removes Cognee session-map writes, adjusts prompt-save accounting, removes two environment keys, and adds collision-resistant Cognee session IDs.
- **`05fa7204f`** prevents queued input from immediately running after an aborted automatic compaction.
- **`1b81025ce`** reduces duplicated tool arguments and text results in observability history while retaining non-text result data and details.
- **`f6673a0fe`** suppresses the preparing indicator for registered extension commands that may open their own UI.

The main review observations are: automatic compaction has cancellation paths that do not set the new cancellation flag; Cognee environment keys with the `COGNEE_` prefix are still accepted by the parser, and compaction checkpoints count as prompts; background-shell output reads share one cursor per shell; and the new extension-command parser differs from existing command parsing for tabs and other whitespace.

---

## 1. `9e866593f` — Add background shell management

**Subject:** `feat(coding-agent): background shells the agent can check and the user can manage`  
**Diff:** 22 files changed; the commit adds the core registry, model-facing tools, session integration, interactive UI, tests, and documentation.

### Main files and symbols

- `packages/coding-agent/src/core/tools/bash-background.ts` — `BashBackgroundRegistry`; tracks shell status and output, retains a bounded output tail, exposes snapshots and incremental reads, and prunes finished shells.
- `packages/coding-agent/src/core/tools/bash-shells.ts` — model-facing `bash_output` and `bash_kill` tools.
- `packages/coding-agent/src/core/tools/bash.ts` — `run_in_background` handling, timeout validation, detached execution, and streamed output forwarding.
- `packages/coding-agent/src/core/agent-session.ts` — registry/tool lifecycle integration, running-shell prompt reminders, and queued user-stop notices.
- `packages/coding-agent/src/modes/interactive/components/shells-panel.ts` — shell list, details, and follow views.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, `core/keybindings.ts`, `core/slash-commands.ts` — panel entry points and actions (`/shells`, `/tasks`, and the empty-editor `down` action).
- `packages/coding-agent/src/modes/interactive/components/footer.ts` and `tool-summary.ts` — shell count and background-launch summaries.
- `packages/coding-agent/src/ice-safe-verify.ts` — mode-policy tool availability.
- Tests: `test/bash-background.test.ts`, `test/shells-panel.test.ts`, `test/suite/background-shell-reminder.test.ts`, and updates to `test/compact-tool-rows.test.ts`, `test/ice-safe-verify.test.ts`, `test/status-line.test.ts`, and the two tool-governance regression tests.
- Documentation: `packages/coding-agent/README.md`, `packages/coding-agent/docs/keybindings.md`, and `packages/coding-agent/CHANGELOG.md`.

### Behavior added

- `bash` can detach a process with `run_in_background: true` and return a shell ID before completion. Its output continues to be captured by the registry.
- `bash_output` lists tracked shells or reads newly available output for a shell; it can wait for completion, with a maximum wait of 300 seconds. `bash_kill` stops a running shell.
- `timeout: 0` means no timeout; invalid timeout values are validated before launching the process.
- The registry retains up to 256 KB of output per shell and up to 20 finished shells.
- Session prompts receive a hidden reminder when the set of running shells changes. A user-initiated stop is queued for the next user turn rather than immediately triggering an agent turn.
- The interactive UI provides list/details/follow views, output following, and stop controls. The footer shows a shell count; `/shells` opens the panel, while `/tasks` opens it when shells are present.
- Shell management tools follow `bash` mode/tool governance: the tests assert availability in build mode and blocking in plan mode.

### Tests present in the commit

The new tests cover detached launches, incremental output reads, waiting for exit, stopping shells, user-stop notifications, output and finished-shell retention bounds, timeout-zero and invalid-timeout handling, shell-panel navigation/rendering, reminders on running-shell-set changes, deferred stop notices, and shell-tool mode governance. Updated tests cover tool summaries, footer labels, and `bash`-tool inclusion/exclusion behavior.

Not covered in the audited tests are, among other paths, aborting a `bash_output` wait with an `AbortSignal`, invalid `wait_seconds`, the 300-second clamp, output truncation at the model-tool formatting boundary, and keyboard/slash-command entry through the full live interactive flow.

### Review observations

- `readCursor` is stored on the shell record, so it is one cursor per shell, not a cursor isolated per consumer. If multiple callers read the same shell, one caller can advance the cursor and the other may see no new output.
- Finished-shell pruning follows registry insertion order rather than explicit completion order. A shell started early but completed late may be treated as old when pruning.
- Output-tail trimming uses JavaScript string slicing, which counts UTF-16 code units and can split a surrogate pair at the trim boundary.
- The streamed `TextDecoder` is used with `{ stream: true }`; the reviewed completion path does not flush it with a final non-streaming `decode()`, so a trailing incomplete multibyte sequence may be lost or replaced.

These are code-level edge cases identified in review; the commit tests do not exercise them.

---

## 2. `411cc7bab` — Clean up Cognee state and prevent session ID collisions

**Subject:** `fix(coding-agent): remove dead Cognee state and keep session ids distinct`

### Main files and symbols

- `packages/coding-agent/src/ice-cognee.ts` — `cogneeSessionId`, `ensureSessionId`, `storeEntry`, `before_agent_run`, and `session_compact` handlers.
- `packages/coding-agent/src/ice-cognee-env.ts` — `COGNEE_ENV_KEYS` and environment parsing.
- `packages/coding-agent/test/ice-cognee.test.ts` — session-ID assertions in the Cognee extension test.
- `packages/coding-agent/CHANGELOG.md` and `idea.md` — release note and roadmap update.

### Behavior added or changed

- `cogneeSessionId()` now adds an 8-hex-character SHA-256 suffix when sanitizing or truncating the trimmed host session ID would otherwise make distinct IDs collide. Clean IDs (including ordinary UUIDs) keep their existing `ice_`-prefixed form. The generated ID is capped at 124 characters.
- The extension no longer creates or writes the `sessions/*.json` host-session mapping files. `ensureSessionId()` now updates the runtime’s in-memory session identifiers.
- `COGNEE_RECALL_TIMEOUT` and `COGNEE_RECALL_BUDGET` are removed from `COGNEE_ENV_KEYS`.
- `saves.prompt` is no longer incremented when a prompt is merely captured. It is incremented after a successful stored entry with `kind === "answer"`, intended to count prompts when the QA entry containing them is saved.

### Tests present in the commit

The commit adds assertions that a standard UUID is preserved, sanitized IDs such as `a/b` and `a:b` remain distinct, long IDs differing after the old truncation boundary remain distinct, and output length is bounded. The commit does not add tests for removal of session-map file writes, environment parsing, or `saves.prompt` accounting.

### Review observations

- The environment parser also accepts any key beginning with `COGNEE_` (`key.startsWith("COGNEE_")`). Consequently, removing the two keys from `COGNEE_ENV_KEYS` does not by itself stop `parseEnvFile()` from accepting them. The keys are still not used by the reviewed code, but the removal does not have the parser effect implied by an allowlist-only reading.
- Compaction checkpoints are persisted through `storeEntry(..., "answer")`. The new `kind === "answer"` counter therefore increments `saves.prompt` for a compaction checkpoint even though it is not a user prompt.
- In the reviewed call sites, `saves.prompt` and `saves.answer` are incremented together for `kind === "answer"`, so the prompt and answer counts appear coupled rather than independently measuring those event types.
- No test verifies the new prompt-count semantics or the absence of `sessions/` writes.

---

## 3. `05fa7204f` — Keep queued input after cancelled auto-compaction

**Subject:** `fix(coding-agent): keep queued input after a cancelled auto compaction`

### Main files and symbols

- `packages/coding-agent/src/core/agent-session.ts` — `_autoCompactionCancelled`, `_runAutoCompaction()`, and `_handlePostAgentRun()`.
- `packages/coding-agent/test/suite/agent-session-compaction-lock.test.ts` — queued-input behavior during auto-compaction.
- `packages/coding-agent/CHANGELOG.md` — fixed entry.

### Behavior added

`AgentSession` now tracks when automatic compaction is aborted. `_runAutoCompaction()` clears the flag at entry and sets it on signal-abort paths. After compaction checks, `_handlePostAgentRun()` consumes the flag and returns `false`, stopping the continuation loop rather than immediately draining queued follow-up input against the uncompacted context. On successful compaction, queued input continues as before.

### Tests present in the commit

A parameterized test queues an RPC follow-up prompt while auto-compaction is paused by a `session_before_compact` gate. When the test aborts compaction, it asserts that the prompt remains queued and the mock response is not consumed. When it releases the gate, it asserts the prompt runs and the queue drains.

The test does not cover cancellation during the provider summarization request, cancellation after saving the compaction entry, mid-run compaction, steering messages, or an extension returning `{ cancel: true }` without aborting the signal.

### Review observations

- The extension-cancellation branch returns `false` and emits an aborted compaction event, but does not set `_autoCompactionCancelled`. If an extension returns `{ cancel: true }` while the signal is not aborted, `_handlePostAgentRun()` can fall through to `hasQueuedMessages()` and continue with queued input. The added test’s gate cancels only after the abort signal is set, so it does not exercise this distinct branch.
- A non-abort compaction error also leaves the flag unset. In that case, a queued prompt can be allowed to continue after compaction failed. The commit does not test the intended behavior for that failure path.

---

## 4. `1b81025ce` — Avoid duplicated observability tool payloads

**Subject:** `fix(coding-agent): stop duplicating tool payloads in observability history`

### Main files and symbols

- `packages/coding-agent/src/observe/observe-recorder.ts` — new `rawToolResult()` helper and `tool_execution_start` / `tool_execution_end` handling.
- `packages/coding-agent/test/observe-recorder.test.ts` — updated oversized-payload test and new details/non-text test.
- `packages/coding-agent/CHANGELOG.md` — fixed entry.

### Behavior added or changed

- Tool-start items keep serialized `args` without also serializing the entire start event into `raw`.
- On completion, `resultText()` continues to populate the text result, while `rawToolResult()` removes text blocks already represented there. It retains non-text content blocks and other result properties such as `details.diff`, supporting the dashboard’s applied-diff view.
- The logic is applied both to an existing tool item and to the fallback item created when a completion has no matching start item.

### Tests present in the commit

The updated oversized-payload test checks that arguments and text results remain available while text-only output has no `raw` copy. The new test checks that `details.diff` and an image block remain in `raw`, while the text block is not repeated there.

The tests do not directly cover the in-flight start item’s `raw` field, the unmatched-completion fallback, primitive results, missing `content`, or empty `details` objects.

### Review observations

- A result with `details: {}` still produces a non-empty `raw` serialization because the helper checks whether top-level values are `undefined`, not whether nested objects are empty. This is small residual data, not duplicated result text.
- For primitive results such as a string, `rawToolResult()` serializes the primitive while `resultText()` can also store it as `item.result`; such results can still be duplicated. The commit’s deduplication primarily handles standard object-shaped tool results.
- Text blocks are removed as whole blocks. Any non-standard metadata attached to a text block would also be removed from `raw`.

---

## 5. `f6673a0fe` — Skip preparing timer for extension commands

**Subject:** `fix(coding-agent): skip the preparing-prompt timer for extension commands`

### Main files and symbols

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — `beginPreparingPrompt()` and its input-submission call site.
- `packages/coding-agent/test/interactive-mode-status.test.ts` — test helper and new extension-command test.
- `packages/coding-agent/CHANGELOG.md` — fixed entry.

### Behavior added

`beginPreparingPrompt()` clears any existing preparing state, parses a slash-command name, and returns early when `extensionRunner.getCommand()` finds a registered extension command. It does not create the “Preparing · Sending prompt” indicator for those commands, which may open their own UI and never start a model turn. Unregistered slash commands and ordinary prompts continue through the existing indicator path.

### Tests present in the commit

The new unit test registers `agents`, calls `beginPreparingPrompt("/agents")` and `beginPreparingPrompt("/agents stop ag_1")`, and asserts no preparing indicator is created. It then checks that an unregistered slash command such as `/review the diff` still displays “Sending prompt”. The test invokes the method on a lightweight `InteractiveMode` mock rather than exercising the full editor-to-session submission flow.

### Review observations

- The new guard splits on any whitespace (`/\s/`), whereas existing extension-command parsing in `InteractiveMode.isExtensionCommand()` and `AgentSession._tryExecuteExtensionCommand()` splits on a literal space. For input such as `/agents\targ`, the new guard can recognize `agents` and suppress the timer, while the command executor can parse a different name and fail to treat it as an extension command.
- Extension commands that themselves send a user prompt do not show this preparing indicator while their command handler runs. This appears consistent with the change’s stated intent, but the behavior is not tested end-to-end.

---

## Verification limits and worktree note

- The five reviews inspected committed diffs and test code. This report does not claim that tests or `npm run check` were run successfully.
- The worktree contained pre-existing modifications, including changes to `interactive-mode.ts`, `agent-session.ts`, test files, and the changelog. The commit findings above refer to the historical commit snapshots; those unrelated workspace changes were left untouched.
- `report.md` is the only file created for this request.
