# Sessions

Ice saves conversations as sessions so you can continue work, branch from earlier turns, and revisit previous paths.

## Session Storage

Sessions auto-save to `~/.ice/agent/sessions/`, organized by working directory. Each session is a JSONL file with a tree structure.

A new persistent session stays unwritten during metadata-only startup. Its first user or assistant message writes the header and buffered entries immediately, before waiting for a provider response. Later entries append normally. A user-only fork is also written immediately, so its request survives interruption before the first reply. `--no-session` and SDK memory-only sessions still write no session file. Ordinary saves do not promise power-loss durability; `SessionManager.flushDurably()` is the explicit fsync barrier.

```bash
ice -c                  # Continue most recent session
ice -r                  # Browse and select from past sessions
ice --no-session        # Ephemeral mode; do not save
ice --name "my task"    # Set session display name at startup
ice --session <path|id> # Use a specific session file or partial session ID
ice --fork <path|id>    # Fork a session file or partial session ID into a new session
```

Use `/session` in interactive mode to see the current session file, session ID, message count, tokens, and cost.

Before an ordinary append, ICE checks the existing file's final byte and inserts a newline if needed. This preserves valid unterminated records and keeps new entries separate from malformed partial tails without deleting their bytes. Opening a current-version session alone does not repair its tail; malformed lines remain skipped by the existing loader. This is not a concurrent-writer lock.

For the JSONL file format and SessionManager API, see [Session Format](session-format.md).

## Session Commands

| Command | Description |
|---------|-------------|
| `/resume` | Browse and select previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set the current session display name |
| `/session` | Show session info |
| `/tree` | Navigate the current session tree |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Summarize older context; see [Compaction](compaction.md) |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |

## Resuming and Deleting Sessions

`/resume` opens an interactive session picker for the current project. `ice -r` opens the same picker at startup.

In the picker you can:

- search by typing
- toggle path display with Ctrl+P
- toggle sort mode with Ctrl+S
- filter to named sessions with Ctrl+N
- rename with Ctrl+R
- delete with Ctrl+D, then confirm

When available, ice uses the `trash` CLI for deletion instead of permanently removing files.

## Naming Sessions

Use `/name <name>` to set a human-readable session name:

```text
/name Refactor auth module
```

Set the name at startup with `--name` or `-n`:

```bash
ice --name "Refactor auth module"
ice --name "CI audit" -p "Review this build failure"
```

Named sessions are easier to find in `/resume` and `ice -r`.

## Branching with `/tree`

Sessions are stored as trees. Every entry has an `id` and `parentId`, and the current position is the active leaf. `/tree` lets you jump to any previous point and continue from there without creating a new file.

<p align="center"><img src="images/tree-view.png" alt="Tree View" width="600"></p>

Example shape:

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### Tree Controls

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate visible entries |
| ←/→ | Page up/down |
| Ctrl+←/Ctrl+→ or Alt+←/Alt+→ | Fold/unfold or jump between branch segments |
| Shift+L | Set or clear a label on the selected entry |
| Shift+T | Toggle label timestamps |
| Enter | Select entry |
| Escape/Ctrl+C | Cancel |
| Ctrl+O | Cycle filter mode |

Filter modes are: default, no-tools, user-only, labeled-only, and all. Configure the default with `treeFilterMode` in [Settings](settings.md).

### Selection Behavior

Selecting a user or custom message:

1. Moves the leaf to the selected message's parent.
2. Places the selected message text in the editor.
3. Lets you edit and resubmit, creating a new branch.

Selecting an assistant, tool, compaction, or other non-user entry:

1. Moves the leaf to that entry.
2. Leaves the editor empty.
3. Lets you continue from that point.

Selecting the root user message resets the leaf to an empty conversation and places the original prompt in the editor.

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| Output | Same session file | New session file | New session file |
| View | Full tree | User-message selector | Current active branch |
| Typical use | Explore alternatives in place | Start a new session from an earlier prompt | Duplicate current work before continuing |
| Summary | Optional branch summary | None | None |

Use `/tree` when you want to keep alternatives together. Use `/fork` or `/clone` when you want a separate session file. When creating a fork, filtered label entries are removed from the path and retained entries are rechained. If a compaction's kept boundary names a removed label, it is remapped to the next retained entry, preserving the original active context. The source session is not changed.

## Branch Summaries

When `/tree` switches away from one branch to another, ice can summarize the abandoned branch and attach that summary at the new position. This preserves important context from the path you left without replaying the whole branch. The summary's `fromId` identifies the abandoned leaf, while its `parentId` identifies the destination.

When prompted, choose one of:

1. no summary
2. summarize with the default prompt
3. summarize with custom focus instructions

See [Compaction](compaction.md) for branch summarization internals and extension hooks.

## Session Format

Session files are JSONL and contain message entries, model changes, thinking-level changes, labels, compactions, branch summaries, and extension entries.

For parsers, extensions, SDK usage, and the full SessionManager API, see [Session Format](session-format.md).
