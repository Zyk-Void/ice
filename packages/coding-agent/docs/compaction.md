# Compaction & Branch Summarization

LLMs have limited context windows. When conversations grow too long, ice uses compaction to summarize older content while preserving recent work. This page covers both auto-compaction and branch summarization.

**Source files** ([ICE](https://github.com/Zykairotis/ice)):
- [`packages/coding-agent/src/core/compaction/compaction.ts`](https://github.com/Zykairotis/ice/blob/void/packages/coding-agent/src/core/compaction/compaction.ts) - Auto-compaction logic
- [`packages/coding-agent/src/core/compaction/branch-summarization.ts`](https://github.com/Zykairotis/ice/blob/void/packages/coding-agent/src/core/compaction/branch-summarization.ts) - Branch summarization
- [`packages/coding-agent/src/core/compaction/utils.ts`](https://github.com/Zykairotis/ice/blob/void/packages/coding-agent/src/core/compaction/utils.ts) - Shared utilities (file tracking, serialization)
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/Zykairotis/ice/blob/void/packages/coding-agent/src/core/session-manager.ts) - Entry types (`CompactionEntry`, `BranchSummaryEntry`)
- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/Zykairotis/ice/blob/void/packages/coding-agent/src/core/extensions/types.ts) - Extension event types

For TypeScript definitions in your project, inspect `node_modules/@zykairotis/ice-coding-agent/dist/`.

## Overview

Ice has two summarization mechanisms:

| Mechanism | Trigger | Purpose |
|-----------|---------|---------|
| Compaction | Context exceeds threshold, or `/compact` | Summarize old messages to free up context |
| Branch summarization | `/tree` navigation | Preserve context when switching branches |

Both use the same structured summary format and track file operations cumulatively. Compaction and branch-summary requests use fresh routing session IDs and, where supported by the provider, disable prompt-cache writes because these one-off prompts are unlikely to be reused.

## Compaction

### When It Triggers

Auto-compaction triggers when:

```
contextTokens > floor(contextWindow * thresholdPercent / 100)
```

`thresholdPercent` defaults to `85` and can be changed through `/settings` or `compaction.thresholdPercent` in `~/.ice/agent/settings.json` or `<project-dir>/.ice/settings.json`. The comparison is strict, so compaction starts after the floored threshold is exceeded. `reserveTokens` remains the response budget for generating the compaction summary; it no longer controls the automatic trigger.

You can also trigger manually with `/compact [instructions]`, where optional instructions focus the summary.

### Optional Blackhole Compaction

ICE includes an optional deterministic Blackhole compaction extension. Load it explicitly with `--extension` or install the local package through Ice's package settings. It uses `turn_end` after tool execution, compacts before the next model request, and resumes the task when configured with `midRunCompaction: "resume"`.

Keep native `compaction.enabled` set to `true` for overflow recovery, but set native `compaction.midRunCompaction` to `"off"` when Blackhole owns the mid-run trigger. Blackhole's default is `memory: false`; no observer, reflector, dropper, or recall workers run unless separately added.

Blackhole supports a single percentage threshold against the active model's context window:

```json
{
  "compaction": "auto",
  "compactionEngine": "blackhole",
  "midRunCompaction": "resume",
  "compactAfterPercent": 85,
  "tailBehavior": "ice-default",
  "memory": false
}
```

Use `/settings` to tune all Blackhole fields while the extension is loaded, or use `/blackhole percent 85` for a direct threshold command. The threshold resolves against the active model on every turn, so `272000 * 85% = 231200` for a 272k context model. The default threshold is `85`. Legacy configs that still store `compactAfterTokens` are ignored. `tailBehavior: "minimal"` (default) summarizes Ice's retained tail and keeps only the new compact entry plus later resume/user messages. `tailBehavior: "ice-default"` keeps Ice's normal `keepRecentTokens` tail (~20k by default), which is why context can stay large after compact.

If both native and Blackhole mid-run triggers are enabled, Blackhole yields to native ICE and displays a warning. This prevents duplicate compaction and abort races.

### Derived Cognee Memory

When running through `ice`, the hidden `ice-cognee` extension provides Claude-Code-style Cognee memory over the local Cognee HTTP API. It does not replace Ice's session tree or compaction history.

Ice supports this through the **extension event API** (not Claude's `hooks.json` plugin format). The mapping is:

| Claude Code hook | Ice extension event | Behavior |
|------------------|--------------------|----------|
| SessionStart | `session_start` | Session id + optional agent register |
| UserPromptSubmit (recall) | `before_agent_start` | Bounded recall inject (`session`+`trace`+`graph`) |
| UserPromptSubmit (store) | `before_agent_start` | Pending user prompt for QA pair |
| PostToolUse | `tool_result` | TraceEntry via `POST /api/v1/remember/entry` |
| Stop | `agent_end` | QAEntry (prompt + assistant answer) |
| PreCompact | `session_before_compact` | Short memory anchor |
| SessionEnd | `session_shutdown` | Optional `/api/v1/improve` + agent unregister |
| (extra) | `session_compact` | Redacted compaction summary → durable remember queue |

- Continuous capture defaults **on** (`captureSession` / `captureTools` / `autoImprove`). Toggle with `/cognee capture|tools|improve on|off` if cost is a concern.
- Recall is injected as a turn-scoped system-prompt append, not a durable `custom_message`.
- Compaction summaries still queue under `~/.ice/agent/ice-cognee/pending/` when `autoRemember` is `compaction`. The latest compact summary is also prepended once to the next turn without waiting for Cognee.
- Skills: `cognee-remember`, `cognee-search`, `cognee-sync`. Commands include `/cognee doctor` and statusline key `ice-cognee`.
- Loads Layer A keys from env + `~/.cognee/.env` (shared with Claude/Codex). Default dataset remains **`ice`** (not `agent_sessions`).
- The model receives only the read-only `cognee_search` tool. Manual `/cognee remember ...` remains available.
- Soft-fail on network/auth/timeouts; failed session-cache writes buffer under `~/.ice/agent/ice-cognee/warmup/`.

Blackhole is independent of Cognee. Native Ice compaction and a saved Blackhole compaction both produce valid remember sources. Cognee `auto`/`defer` never implement the compact summary; only explicit `own` may return one, and it must summarize the messages being compacted.

### How It Works

1. **Find cut point**: Walk backwards from newest message, accumulating token estimates until `keepRecentTokens` (default 20k, configurable in `~/.ice/agent/settings.json` or `<project-dir>/.ice/settings.json`) is reached
2. **Extract messages**: Collect messages from the previous kept boundary (or session start) up to the cut point
3. **Generate summary**: Call LLM to summarize with structured format, passing the previous summary as iterative context when present
4. **Append entry**: Save `CompactionEntry` with summary and `firstKeptEntryId`
5. **Reload**: Session reloads, using summary + messages from `firstKeptEntryId` onwards

```
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

On repeated compactions, the summarized span starts at the previous compaction's kept boundary (`firstKeptEntryId`), not at the compaction entry itself, falling back to the entry after the previous compaction if that kept entry cannot be found in the path. This preserves messages that survived the earlier compaction by including them in the next summarization pass as well. Ice also recalculates `tokensBefore` from the rebuilt session context before writing the new `CompactionEntry`, so the token count reflects the actual pre-compaction context being replaced.

### Split Turns

A "turn" starts with a user message and includes all assistant responses and tool calls until the next user message. Normally, compaction cuts at turn boundaries.

When a single turn exceeds `keepRecentTokens`, the cut point lands mid-turn at an assistant message. This is a "split turn":

```
Split turn (one huge turn exceeds budget):

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  (no complete turns before)
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

For split turns, ice generates two summaries and merges them:
1. **History summary**: Previous context (if any)
2. **Turn prefix summary**: The early part of the split turn

### Cut Point Rules

Valid cut points are:
- User messages
- Assistant messages
- BashExecution messages
- Custom messages (custom_message, branch_summary)

Never cut at tool results (they must stay with their tool call).

### CompactionEntry Structure

Defined in [`session-manager.ts`](https://github.com/Zykairotis/ice/blob/void/packages/coding-agent/src/core/session-manager.ts):

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;       // LLM usage that generated the summary
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default compaction uses this for details (from compaction.ts):
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Extensions can store any JSON-serializable data in `details`. The default compaction tracks file operations, but custom extension implementations can use their own structure. Generated and extension-provided summaries store their LLM `usage` when available so session totals include summarization work.

See [`prepareCompaction()`](https://github.com/Zykairotis/ice/blob/void/packages/coding-agent/src/core/compaction/compaction.ts) and [`compact()`](https://github.com/Zykairotis/ice/blob/void/packages/coding-agent/src/core/compaction/compaction.ts) for the implementation. For direct programmatic summarization, `generateSummary()` returns the summary text and `generateSummaryWithUsage()` returns `{ text, usage }`.

## Branch Summarization

### When It Triggers

When you use `/tree` to navigate to a different branch, ice offers to summarize the work you're leaving. This injects context from the left branch into the new branch.

### How It Works

1. **Find common ancestor**: Deepest node shared by old and new positions
2. **Collect entries**: Walk from old leaf back to common ancestor
3. **Prepare with budget**: Include messages up to token budget (newest first)
4. **Generate summary**: Call LLM with structured format
5. **Append entry**: Save `BranchSummaryEntry` at navigation point

```
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D
    A ───┤
         └─ E ─ F ─ [summary of B,C,D] (new leaf)
```

### Cumulative File Tracking

Both compaction and branch summarization track files cumulatively. When generating a summary, ice extracts file operations from:
- Tool calls in the messages being summarized
- Previous compaction or branch summary `details` (if any)

This means file tracking accumulates across multiple compactions or nested branch summaries, preserving the full history of read and modified files.

### BranchSummaryEntry Structure

Defined in [`session-manager.ts`](https://github.com/Zykairotis/ice/blob/void/packages/coding-agent/src/core/session-manager.ts):

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  fromId: string;      // Entry we navigated from
  usage?: Usage;       // LLM usage that generated the summary
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default branch summarization uses this for details (from branch-summarization.ts):
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Same as compaction, extensions can store custom data in `details`.

See [`collectEntriesForBranchSummary()`](https://github.com/Zykairotis/ice/blob/void/packages/coding-agent/src/core/compaction/branch-summarization.ts), [`prepareBranchEntries()`](https://github.com/Zykairotis/ice/blob/void/packages/coding-agent/src/core/compaction/branch-summarization.ts), and [`generateBranchSummary()`](https://github.com/Zykairotis/ice/blob/void/packages/coding-agent/src/core/compaction/branch-summarization.ts) for the implementation.

## Summary Format

Both compaction and branch summarization use the same structured format:

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### Message Serialization

Before summarization, messages are serialized to text via [`serializeConversation()`](https://github.com/Zykairotis/ice/blob/void/packages/coding-agent/src/core/compaction/utils.ts):

```
[User]: What they said
[Assistant thinking]: Internal reasoning
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

This prevents the model from treating it as a conversation to continue.

Tool results are truncated to 2000 characters during serialization. Content beyond that limit is replaced with a marker indicating how many characters were truncated. This keeps summarization requests within reasonable token budgets, since tool results (especially from `read` and `bash`) are typically the largest contributors to context size.

## Custom Summarization via Extensions

Extensions can intercept and customize both compaction and branch summarization. See [`extensions/types.ts`](https://github.com/Zykairotis/ice/blob/void/packages/coding-agent/src/core/extensions/types.ts) for event type definitions.

### session_before_compact

Fired before auto-compaction or `/compact`. Can cancel or provide custom summary. See `SessionBeforeCompactEvent` and `CompactionPreparation` in the types file.

```typescript
ice.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

  // preparation.messagesToSummarize - messages to summarize
  // preparation.turnPrefixMessages - split turn prefix (if isSplitTurn)
  // preparation.previousSummary - previous compaction summary
  // preparation.fileOps - extracted file operations
  // preparation.tokensBefore - context tokens before compaction
  // preparation.firstKeptEntryId - where kept messages start
  // preparation.settings - compaction settings

  // branchEntries - all entries on current branch (for custom state)
  // reason - "manual" (/compact), "threshold", or "overflow"
  // willRetry - whether the aborted turn is retried after compaction (overflow recovery)
  // signal - AbortSignal (pass to LLM calls)

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "Your summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      // usage: summaryResponse.usage, // Optional; included in session totals
      details: { /* custom data */ },
    }
  };
});
```

#### Converting Messages to Text

To generate a summary with your own model, convert messages to text using `serializeConversation`:

```typescript
import { convertToLlm, serializeConversation } from "@zykairotis/ice-coding-agent";

ice.on("session_before_compact", async (event, ctx) => {
  const { preparation } = event;
  
  // Convert AgentMessage[] to Message[], then serialize to text
  const conversationText = serializeConversation(
    convertToLlm(preparation.messagesToSummarize)
  );
  // Returns:
  // [User]: message text
  // [Assistant thinking]: thinking content
  // [Assistant]: response text
  // [Assistant tool calls]: read(path="..."); bash(command="...")
  // [Tool result]: output text

  // Now send to your model for summarization
  const { summary, usage } = await myModel.summarize(conversationText);
  
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      usage,
    }
  };
});
```

See [custom-compaction.ts](../examples/extensions/custom-compaction.ts) for a complete example using a different model.

### session_before_tree

Fired before `/tree` navigation. Always fires regardless of whether user chose to summarize. Can cancel navigation or provide custom summary.

```typescript
ice.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - where we're navigating to
  // preparation.oldLeafId - current position (being abandoned)
  // preparation.commonAncestorId - shared ancestor
  // preparation.entriesToSummarize - entries that would be summarized
  // preparation.userWantsSummary - whether user chose to summarize

  // Cancel navigation entirely:
  return { cancel: true };

  // Provide custom summary (only used if userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        // usage: summaryResponse.usage, // Optional; included in session totals
        details: { /* custom data */ },
      }
    };
  }
});
```

See `SessionBeforeTreeEvent` and `TreePreparation` in the types file.

## Settings

Configure compaction in `~/.ice/agent/settings.json` or `<project-dir>/.ice/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "thresholdPercent": 85,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable auto-compaction |
| `thresholdPercent` | `85` | Context percentage that triggers automatic compaction |
| `reserveTokens` | `16384` | Tokens reserved for the compaction summary response |
| `keepRecentTokens` | `20000` | Recent tokens to keep (not summarized) |

Disable auto-compaction with `"enabled": false`. You can still compact manually with `/compact`.
