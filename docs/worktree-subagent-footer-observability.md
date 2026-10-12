# Subagent footer observability

> **Historical implementation snapshot.** This note describes an earlier worktree's child-view/footer implementation, not current V2 UI behavior. See the [Subagents V2 guide](../packages/coding-agent/docs/subagents-v2.md) and [architecture](../packages/coding-agent/docs/subagents-v2-architecture.md); source and worktree-status claims below are historical evidence.

## Status and provenance

This document describes the implementation visible in the assigned worktree at inspection time. The source and test files listed below were present in the worktree; their individual commit state was not observable with the available file tools.

The Git metadata path for this linked worktree could not be read through the available tools. Consequently, the branch name, exact `HEAD` commit, and the pre-existing dirty/staged state are **not verified here**. Do not infer those values from older repository reports: documents such as `progress.md` and `findings.md` describe other snapshots and are not branch metadata for this inspection.

The target file, `docs/worktree-subagent-footer-observability.md`, was created by this documentation operation and is therefore an **uncommitted working-tree change** unless a parent process stages or commits it later. No source, test, changelog, or other file was changed by this operation.

## Purpose

Interactive ICE can display multiple delegated child sessions alongside the parent session. The subagent footer is a compact, local TUI projection that answers three operational questions without opening a full child transcript:

1. How many child views are active?
2. How many completed/retained views can still be inspected or reused?
3. Does any live child need attention, and what is it doing or waiting for?

It is observability for the interactive footer, not a second agent loop and not external telemetry. The footer does not authorize work, verify a result, or replace the child transcript used by parent-side verification.

## Behavior

### Counts and selection

`createSubagentFooterSnapshot(views, selectedViewId, displayedId)` excludes the parent view and creates one bounded entry per live or historical child view.

- `liveCount` counts entries whose `live` flag is true.
- `retainedCount` counts entries with `retentionState: "reusable"`.
- `attentionCount` counts live entries marked `needsAttention`.
- `selectedChild` prefers the currently displayed child (`displayedId`), then the switcher's selected child, then the first child.
- `selectedChildIndex` is one-based and refers to the child-only list, not the parent row.
- Every returned snapshot and child entry is frozen.

A historical child never contributes to `attentionCount`, even if its retained presentation contains old runtime data. This prevents stale activity from appearing as an actionable live alert.

### Status and attention indicators

Live statuses are derived from control and runtime state:

- A live child in finalization is shown as `FINALIZING` when no more specific control state applies.
- Control states such as `awaiting-extension`, `awaiting-finalization`, and `final-report-requested` are displayed as uppercase words with separators normalized to spaces.
- A live child otherwise uses its view status, defaulting to `LIVE`.
- Historical statuses use the stored status, normalized to uppercase; for example, `completed` becomes `COMPLETED` and `failed` becomes `FAILED`.

A live child needs attention when it is awaiting an extension, awaiting finalization, waiting for a final report, in the runtime's `awaiting_extension` state, in finalization, or has a repeated-failure advisory. The advisory is informational: it does not itself deny, retry, or extend execution.

For a child with runtime attention, the footer projects:

- execution phase and state;
- active elapsed time and active budget;
- total extension time and remaining extension budget;
- up to the last three sanitized tool/path activity records;
- a repeated-failure count when present.

Activity lines use a safe marker: `✓` for success, `!` for error, `…` for running, and `×` for aborted. The footer intentionally projects the tool name and path, not the raw activity action. In particular, the source test demonstrates that an action containing `secret-token` does not appear in the rendered footer.

### Layouts and terminal widths

The switcher is `SubagentFooterSwitcher`, a TUI `Component` mounted in the bottom dock above the ordinary footer when an `IceAgentViewBridge` is available.

- **Collapsed mode:** shows active, retained, and attention counts, followed by the selected child and `/agents` affordance. At sufficiently wide terminals it adds recent activity and timing on a second line.
- **Expanded wide mode:** renders an `Agents` heading, at most four child rows, statuses, timing, and the selected row's most recent activity. Hidden rows are represented by up/down counts.
- **Narrow mode:** renders the selected child and a compact key hint rather than attempting to show the complete list.
- Width is padded/truncated with visible-width accounting so rendered lines remain within the requested terminal width. The implementation uses a count-only collapsed fallback below 44 columns and switches between narrow and wide behavior at 72 columns.
- A configured border is applied only when the appearance is customized, the border is not `none`, and the width is at least eight columns.

## Architecture and API

### Runtime source: `SubagentRunSupervisor`

`packages/coding-agent/src/ice-subagent-timeout-supervisor.ts` defines `SubagentRuntimeAttention` and the supervisor snapshot used by the footer. The supervisor owns the child execution budget, but explicitly does not own the child agent loop. Its snapshot includes phase/state, timeout and extension accounting, progress timing, bounded activity digests, repeated-failure information, and optional usage.

The supervisor retains at most 12 activity records internally. Activity text is credential-redacted, whitespace-bounded, and size-limited by the supervisor. The runner's live-control adapter exposes a further last-three activity projection to the view layer.

### View boundary: `IceAgentViewBridge`

`packages/coding-agent/src/ice-agent-view-bridge.ts` is the parent-owned view boundary. Its relevant public shapes are:

- `IceAgentViewPresentation.runtimeAttention` — optional bounded runtime metadata attached to a view;
- `IceAgentViewLiveSessionControl.getRuntimeAttention()` — optional live supervisor snapshot;
- `IceAgentViewDescriptor` — normalized parent, live-child, or historical-child view;
- `IceAgentViewLiveSessionSource` — `list()` plus a subscription callback;
- `IceAgentViewBridge.listViews()` — combines parent, live, and retained historical views;
- `IceAgentViewBridge.getRuntimeAttention(id)` — reads live control data, falling back to static presentation;
- `IceAgentViewBridge.extendRuntime(id, additionalMs)` and `stopRuntime(id)` — parent-owned runtime control operations.

`listViews()` prefers the live control's current runtime snapshot over a static presentation snapshot, normalizes the presentation, and publishes status changes through bridge listeners. Historical snapshots are read-only and are bounded to 32 views and bounded, redacted, deeply immutable message projections. Presentation text, labels, evidence paths, indices, activities, repeated-failure data, and usage are validated and capped at the bridge boundary.

This boundary is important for safety: the footer consumes a view projection rather than raw child messages or untrusted raw activity objects. The projection is display data; it is not an authority grant.

### Footer projection: `subagent-view-switcher.ts`

`packages/coding-agent/src/modes/interactive/components/subagent-view-switcher.ts` exports:

#### `createSubagentFooterSnapshot`

Derives a frozen `SubagentFooterSnapshot` from view descriptors.

**Parameters:**

- `views` (`readonly IceAgentViewDescriptor[]`): parent/live/historical views supplied by the bridge.
- `selectedViewId` (`string | undefined`): the switcher's current selection, used as a fallback for displayed-child selection.
- `displayedId` (`string`): the view currently displayed in the transcript.

**Returns:** `SubagentFooterSnapshot`, containing child entries, counts, and optional selected-child metadata. Recent activity is capped at three entries, sanitized again for footer display, and excludes running activity for historical views.

**Example:**

```typescript
const snapshot = createSubagentFooterSnapshot(
  bridge.listViews(),
  selectedChildId,
  bridge.getDisplayedId(),
);
console.log(`${snapshot.liveCount} active; ${snapshot.attentionCount} need attention`);
```

#### `SubagentFooterSwitcher`

A selectable TUI component that subscribes to the bridge, refreshes its view list, and requests a render when the bridge changes. Its constructor receives the TUI, theme, keybinding manager, bridge, close callback, and an initial expanded/collapsed setting.

The component supports browsing and opening a child view. When the selected live child is specifically awaiting an extension, `E` requests a bounded extension (30 seconds during finalization, otherwise 60 seconds, clipped to the remaining extension budget); `X` requests a stop. A missing or exhausted extension budget produces a local message instead of issuing an extension. These controls call bridge methods, so the component itself does not mutate supervisor state.

`setAppearance(SubagentChromeAppearance | null)` updates display styling, and `dispose()` removes the bridge subscription. The class is also exported under the compatibility name `SubagentViewSwitcher`.

### Interactive integration

`packages/coding-agent/src/modes/interactive/interactive-mode.ts` creates the switcher during interactive initialization when an agent view bridge exists. It mounts `agentSwitcherContainer` immediately above `footerContainer` in the fixed bottom dock. Bridge notifications request a render, and disposal removes the switcher and its request subscription.

The default keybinding declarations are in `packages/coding-agent/src/core/keybindings.ts`:

- `ctrl+shift+a` — open the subagent chooser;
- `alt+left` — return to the parent;
- `alt+right` — show the next subagent view;
- `shift+alt+left` — show the previous subagent view;
- `ctrl+shift+enter` — take or release control of a live child.

Inside the expanded switcher, the visible hints are `↑↓/←→` to browse, `Enter` to open, and `Esc` to close. `E` and `X` appear only for an eligible awaiting-extension child. `/agents` and `/subagents` open the native chooser when the bridge is available; the `split` form is passed to the existing observatory command path.

## Configuration and usage

There is no separate footer-observability enablement flag in the inspected implementation. The component appears as part of interactive subagent view support when the host supplies an `IceAgentViewBridge`; RPC and non-TUI hosts do not receive this TUI component.

Styling is supplied through the existing v2 appearance model's `subagentChrome` section. `SubagentFooterSwitcher` receives `effectiveAppearance().subagentChrome` and supports these presentation groups:

- selected row: foreground, background, and text styles;
- running children;
- completed children;
- failed children;
- attention state;
- muted/historical text;
- optional border style and border color.

The defaults in `packages/coding-agent/src/modes/interactive/appearance/appearance-defaults.ts` preserve the normal theme styling: no border, accent running text, muted completed text, error failed text, warning attention text, and dim muted text. Appearance changes are applied to the already-mounted switcher by `InteractiveMode`; they do not alter runtime or retention state.

For operational use, open the chooser with the configured open key or `/agents`, select a child, and use `Enter` to display it. Treat `needs attention` as a prompt to inspect the selected child's status and recent activity. Use `E` only when the UI explicitly offers extension and use `X` to stop the same retained child rather than launching a duplicate. Parent verification of paths, criteria, and checks remains required after a child reports completion.

## Verification evidence visible in this worktree

The following are static, inspectable test assertions present in the worktree. They are evidence of intended and covered cases, not evidence that the tests were executed during this documentation operation.

- `packages/coding-agent/test/subagent-footer.test.ts`
  - verifies frozen snapshots, child-only counts, selected-child position, finalization status, and a three-activity projection;
  - verifies that historical running activity is omitted;
  - verifies collapsed, narrow, and wide rendering across widths 20, 43, 60, 71, 72, and 120 without exceeding the requested visible width;
  - verifies active/retained/attention wording, stable completed/failed historical wording, and absence of a secret token from rendered activity;
  - verifies selection preservation when live views reorder or the selected child is removed.
- `packages/coding-agent/test/ice-agent-view-bridge.test.ts`
  - verifies distinct parent/live/historical views and replacement of a live view by history;
  - verifies credential redaction, bounded historical retention (32 views), and deep immutability;
  - verifies observer failures do not change bridge state;
  - verifies retained final-result verification metadata remains frozen.
- `packages/coding-agent/test/ice-subagent-timeout-supervisor.test.ts`
  - contains runtime-attention normalization coverage, including conversion of legacy `completed` activity outcomes to `ok`;
  - covers a durable async job remaining nonterminal while a retained child needs time.
- `packages/coding-agent/test/ice-agent-view-integration.test.ts`
  - covers live and historical transcript integration and terminal/verification-related historical view states, including `timed_out`, `cancelled`, and verification failure cases.
- `packages/coding-agent/CHANGELOG.md` contains a Changed entry describing the bounded counts, selected-child status, sanitized activities, runtime timing, attention indicators, and narrow-terminal fallbacks. A changelog entry is release documentation, not a test result.

No test command, type check, or repository check was run by this operation, so no passing status is claimed.

## Limitations and follow-ups

- The footer is a best-effort display projection. It can be stale between bridge publications or while a control operation is in flight; the authoritative runtime and result state remain in the supervisor, runner, bridge, and parent verification path.
- The footer shows only the last three activities, while the supervisor and bridge retain larger bounded projections. It is not a complete audit log.
- The footer intentionally omits raw actions from activity rows. This improves secrecy and readability but means the UI alone may not explain a failure; inspect the appropriate bounded tool result or parent-owned evidence instead.
- Timing is integer-second display formatting. It is not a precise latency or deadline measurement, and a soft timeout can leave an in-flight provider operation subject to the supervisor's cancellation behavior.
- `needsAttention` is deliberately live-only. Historical attention data is retained for bounded presentation where applicable but cannot trigger a live alert.
- Runtime controls are optional on live display sessions. If a child has no `extendRuntime` or `stopRuntime` control, the bridge rejects that operation rather than manufacturing one.
- The inspected tests do not by themselves prove every runtime race, non-cooperative child cancellation path, persistence failure, or host-level isolation property. Those concerns require separate implementation tests and independent verification.
- Branch, `HEAD`, and dirty-state provenance could not be confirmed through the available tools. Before merging this documentation, the parent should record the actual branch, exact commit, and status output alongside its integration evidence.
