# ICE CLI UI Refresh Plan

Status: M1 and M3-M8 implemented 2026-10-07. M1: quiet startup, session card, notices badge + view, extension console capture. M3: compact tool rows, tool groups, assistant bullets. M2 skipped (existing theme tokens suffice for M3). M7 deviations: the new knobs are `/settings` entries backed by settings.json (`footerStyle`, `toolStyle`, `symbols`) rather than appearance-profile sections; no customizer preview pages, per-segment colors, or new theme tokens. Follow-ups done: `?` shortcut overview, read-only shell classification, background task count segment, `/tasks` bash listing. Not done by choice: `app.tools.expandLast`, git ahead/dirty counts, verb shimmer, appearance-customizer pages and per-segment colors.
M8 deviations: instead of an ICE wrapper tool, `createBashToolDefinition` takes an additive `background` registry option (no schema change); only the parent AgentSession passes one, so subagent and SDK bash tools are unaffected.
M6 deviations: release combines the tool abort signal with a per-wait release controller so `waitRuntime` is unchanged; completion is observed by a background `waitRuntime` loop instead of a runner hook; `/tasks` reuses the subagent chooser without filtering; no task count segment in the footer.
M5 deviations: segment layout lives in `components/status-line.ts` (no presets/separators modules); `footerStyle` setting (`compact` default, `legacy`) instead of appearance presets; no git ahead/dirty counts; no `?` shortcut overlay (needs the conditional editor actions planned for M6); token/cost usage only in the legacy footer.
M4 deviations: no shimmer, no new ICE verb defaults (existing configurable verbs kept), no appearance toggles for the new facts, queued follow-ups keep their existing rendering.
M3 deviations: no bash read-only classifier (all bash reads as "ran N shell commands"); no `app.tools.expandLast`; ctrl+o hint not repeated per row; boxed shell stays the component default (non-interactive callers and tests) while interactive mode opts into compact.
M1 deviations: resource diagnostics (conflicts, extension load errors) stay inline because they are rare and actionable; `/resources` prints compact per-section lists into the chat; footer row layout is unchanged except the badge (full status bar is M5).
Worktree: `.worktrees/all-worktrees-experimental` (branch `integration/all-worktrees-experimental`).
Date: 2026-10-07. Revision 2 (adds file-level design, data flow, interfaces, tests, and corrections from deeper code inspection).

All paths below are relative to `packages/coding-agent/src/` unless stated otherwise.

---

## 0. Goal and non-goals

### Goal

Make the interactive TUI (`ice`, and the `zice` alias = `ice --ice-mode build --ice-allow-bash --approve --sub-yolo --ui-mode regular --allow-external`) clean and calm, in the style of Codex CLI and Claude Code:

1. Quiet startup: one short header, no resource dump, no raw console text, no update cards, no transcript warnings.
2. One compact status bar with icons and colors; warnings and update notices collapse into footer badges.
3. Transcript: `●` bullet rows, compact one-line tool calls, consecutive tool calls grouped into one summary row ("Read 3 files, ran 4 shell commands"), `ctrl+o` expands everything.
4. Live working line: `✻ Frosting… (1m 18s · ↓ 6.6k tokens · thinking high · esc to interrupt)` plus a `⎿` detail row (current tool or tip).
5. `ctrl+b` moves the current blocking wait (subagent wait now, bash later) to the background; completions arrive as notifications; `/tasks` lists background work.
6. Icon presets (unicode / nerd / ascii) and the new UI surfaces wired into the existing theme maker (`/appearance` customizer).

### Non-goals

- No change to the agent loop, tool semantics, session format, compaction, provider routing, print/JSON/RPC output.
- No alternate-screen layout work (that is `tui-plan.md`, separate scope).
- No removal of any safety notice. Notices move to a badge + overlay; capability state stays permanently visible.
- No port of the 250-key oh-my-pi symbol table; ICE gets a narrow table sized to what it renders.
- No reuse of `Agent_harness_references/claude-code` (see section 2).

### Target look (from user screenshot)

```
● Capturing actual startup screen.

  Called context-mode, ran 4 shell commands

● Codex pattern found: warnings collapse into footer badge.

  Ran 1 shell command

● Running cd /home/.../oh-my-pi/…
  ⎿ $ cd …/modes; ls theme; grep -n "symbolPreset" theme/theme.ts | head -20

✻ Gusting… (1m 18s · ↓ 6.6k tokens · thinking with high effort)
  ⎿ Tip: Use /btw to ask a quick side question without interrupting
```

---

## 1. Current state (observed 2026-10-07)

### 1.1 Startup capture

`zice` at 140x50 (installed `~/.local/bin/ice`, v0.83.0):

```
[pi-web-access] Dynamic tool activation requires Pi 0.86.1 or newer; web tools remain eagerly available.

 ice v0.83.0
 escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
 Press ctrl+o to show full startup help and loaded resources.

 Ice can explain its own features and look up its docs. Ask it how to use or extend Ice.

[Context]     3 paths
[Skills]      ~70 names over 5 wrapped lines
[Prompts]     /cl, /is, /pr, /sa, /wr
[Extensions]  16 names over 2 lines
[Themes]      user

 Warning: Bash is enabled for this process. Direct path guards do not contain shell commands.
 Warning: External filesystem access, configured MCP tools, and installed package tools are enabled ... not a sandbox.
──────────────
 Package Updates Available ... - pi-web-access
──────────────
──────────────   (empty widget border)
──────────────
~/Zks/ice/.worktrees/all-worktrees-experimental (integration/all-worktrees-experimental)
0.0%/272k (auto)                                                 (omni) cx/gpt-6.1-sol • high
build 🔌 MCP: 3 servers enabled
```

About 45 rows before the user can see the editor in context.

### 1.2 Source of each noise item

| Item | Source | Notes |
|---|---|---|
| `[pi-web-access] ...` | Third-party extension writes to `console` during load (`core/extensions/loader.ts` `loadExtensions`/`loadExtensionModule:449`), before the TUI owns the terminal | Not routed through any ICE diagnostic channel |
| Header, hint row, "Press ctrl+o…", onboarding sentence | `modes/interactive/interactive-mode.ts:1004-1063` (`builtInHeader`, `ExpandableText`) | Gated only by `settings.quietStartup` (default `false`, `core/settings-manager.ts:1120`) |
| `[Context]/[Skills]/[Prompts]/[Extensions]/[Themes]` | `interactive-mode.ts:1700` `showLoadedResources()` | Same gate; also re-run on reload (`:1989`, `:2274`, `:6795`) |
| Two Bash/external warnings | `ice-safe-verify.ts:1607-1616` (`restore()` on `session_start` and `session_tree`) and `:925-931` (mode change) via `ctx.ui.notify(..., "warning")` | Routed by `showExtensionNotify` (`interactive-mode.ts:3143`) to `showWarning` (`:5026`), which appends `Warning: …` text to `chatContainer`. They re-fire on every `/tree` navigation |
| Package update card | `interactive-mode.ts:1128` -> `showPackageUpdateNotification` (`:5061`) | Bordered card in transcript; same pattern for `showNewVersionNotification` (`:5032`) |
| Empty border rows | Widget containers render their `DynamicBorder` even when empty | Verify exact container during W1 |
| 3-line footer | `components/footer.ts:104` `renderLegacy()` returns `[pwdLine, statsLine, extensionStatusLine]` | Extension statuses (`ice-mode` = `build`, MCP adapter = `🔌 MCP: 3 servers enabled`) get their own line |

### 1.3 Transcript and tools

- Each tool call becomes one `ToolExecutionComponent` (`components/tool-execution.ts`, 413 lines) wrapped in a padded `Box` with `toolPendingBg` / `toolSuccessBg` / `toolErrorBg` backgrounds (`tool-execution.ts:75`, `:143`). This full-width colored block per call is the main visual noise in long turns.
- Construction is duplicated in three places in `interactive-mode.ts`:
  - streaming `message_update` (`:3715`),
  - `tool_execution_start` fallback (`:3801`),
  - history replay `renderSessionItems` (`:4196-4235`).
  All three create the component, call `setExpanded(this.toolOutputExpanded)`, `chatContainer.addChild`, and register in `pendingTools`.
- Updates flow by `toolCallId` through `pendingTools: Map<string, ToolExecutionComponent>` (`:455`) on `tool_execution_update`/`_end` and history `toolResult`.
- Expansion is one global flag `toolOutputExpanded` toggled by `app.tools.expand` (`ctrl+o`, `core/keybindings.ts:94`). `ctrl+o` already works; it just has little to collapse because tools render big by default.
- Built-in renderers already accept `context.expanded` (`core/extensions/types.ts:427-449`, `ToolRenderContext`) and bash already shows a timed collapsed preview (`core/tools/bash.ts:456-490`).
- Assistant text has no bullet; it is plain markdown (`components/assistant-message.ts`).

### 1.4 Working indicator

- `components/status-indicator.ts` `WorkingStatusIndicator` extends tui `Loader`: spinner frames + message. No elapsed time, token count, interrupt hint, or detail row.
- Already configurable through appearance: spinner frames/interval/mirror/color (`IndicatorAppearance`), and rotating verbs with format (`ThinkingLabelAppearance { format, verbs, selection }`, `appearance/thinking-presentation.ts`). The customizer already has "Thinking indicator" and "Thinking verbs" sections. W4 extends this, it does not replace it.

### 1.5 Subagents and the ctrl+b question

- `delegate`, `delegate_batch`, `review_batch`, `delegate_async` already return a managed handle immediately (`ice-subagents.ts:15177` description: "Delegate always returns a managed handle after the child starts"). Children already run in the background relative to the parent turn.
- The only blocking subagent path is the model calling `manage_subagent` action `wait` (`ice-subagents.ts:14988` -> `runner.waitRuntime(runId, parentSessionId, waitMs, signal)` at `:8340`), which polls until terminal or deadline (`SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS`).
- Completion delivery already exists: batch/review/writer completions use `sendCustomMessage(..., { triggerTurn: true, deliverAs: "followUp" })` (`:13970`, `:16266`, `:16536`), durable jobs use `deliverCompletion` (`:14165`).
- `detachRuntime()` (`:8421`) is bookkeeping only, reachable only through `manage_subagent detach`.
- Therefore `ctrl+b` for subagents means: "stop the current blocking wait, return the latest observation to the model now, keep the child running, notify on completion". It does not need a new background execution mechanism.
- Bash is a different case: the `bash` tool blocks until the process exits. There is no background process mode.

### 1.6 Keybinding constraint

- `components/custom-editor.ts:56-63`: every registered app action wins over editor keys unconditionally (only `app.interrupt` and `app.exit` have conditions). `ctrl+b` is the editor's cursor-left alias (`packages/tui/src/keybindings.ts:67`). Binding `ctrl+b` as a plain app action would break cursor-left. Needs a conditional action.

### 1.7 Theme system

- ~100 color themes (`modes/interactive/theme/*.json`, schema `theme-schema.json`), loaded by `theme/theme.ts`.
- Appearance v2 profiles (`modes/interactive/appearance/*`), validated (`appearance-validate.ts`), migrated (`appearance-migrate.ts`), edited in `components/appearance-customizer.ts` (3110 lines, sections listed at `:72` and `:477+`) with preview in `components/appearance-preview.ts`.
- No icon/symbol preset system. Glyphs are hardcoded in components.
- `FooterAppearance` (`appearance-types.ts:212`) supports field order/visibility/separator over `FooterFieldId = cwd|branch|session|usage|cache|cost|context|provider|model|thinking|extensions`. Customized footer path is `footer.ts:265 renderCustomized`.
- Perf note: `footer.ts renderLegacy` re-sums usage across all session entries on every render. Cache by entry count during W2.

---

## 2. Reference inputs and licensing

| Reference | License | How it is used |
|---|---|---|
| `Agent_harness_references/codex/codex-rs/tui` | Apache-2.0 | Primary design source. Recreate layouts in TS; no code copy planned. If any snippet is ported, add per-file provenance and the Apache notice. Key files: `history_cell/session.rs` (session header), `bottom_pane/footer.rs` (+ `snapshots/*footer*`), `status_indicator_widget.rs`, `exec_cell/render.rs` (Explored/Ran cells, `TOOL_CALL_MAX_LINES = 5`, `… +N lines` ellipsis), `bottom_pane/shortcut_overlay.rs`, `multi_agents.rs` (collab cells). |
| `Agent_harness_references/oh-my-pi/packages/coding-agent/src/modes` | MIT (pi lineage, same TUI model) | Closest code. Port structure with a provenance header. Key files: `components/status-line/{presets,segments,separators,context-thresholds}.ts`, `theme/symbols.ts` (preset structure only), `theme/shimmer.ts`, `components/read-tool-group.ts`, `components/welcome.ts`. |
| `Agent_harness_references/opencode` | MIT | Secondary: background task list ideas only. |
| `Agent_harness_references/claude-code` | Leaked proprietary source | Not read, not copied. AGENTS.md: proprietary behavior may only be recreated from public documentation. Claude Code look is recreated from the user's screenshot and public docs only (`●` bullets, `⎿` result rows, `ctrl+o` expand, `ctrl+b` background). |

### Codex patterns adopted (from snapshots)

```
>_ OpenAI Codex (v0.0.0)          session header: name+version, cwd, permissions line
/tmp/project
permissions: YOLO mode

• Working (0s • esc to interrupt)  status line
 ↳ first                           queued follow-ups
   alt + ↑ edit

• Explored                          grouped read-only exploration
  └ Read a.rs, b.rs
    Search foo in src
• Ran echo                          one shell call, max 5 output rows
  │ out…
  └ … +2 lines (⌃t to view transcript)

  ? for shortcuts                       100% context left     footer, idle
  ? for shortcuts             ⚠ 1 warning · f2 to view        footer, warning badge
```

---

## 3. Architecture constraints

- Ice loop stays authoritative. Changes are presentation, keybindings, and ICE subagent/bash adapter surfaces only.
- Keep `interactive-mode.ts` edits to call-site swaps and small hooks; put logic in new components. It is 7.4k lines and shares structure with upstream.
- All keys through `DEFAULT_APP_KEYBINDINGS` (`core/keybindings.ts`). No hardcoded `matchesKey`.
- Safety notices are preserved: badge count + `/warnings` overlay + permanent capability segment. Headless modes (print/RPC/JSON) keep current text output.
- `--verbose` and `quietStartup: false` explicit opt-out keep the old full layout reachable.
- Erasable TS only, no inline imports, no `any` without need.
- Tests: component tests under `packages/coding-agent/test/`, suite tests via `test/suite/harness.ts` + faux provider. After code: `corepack npm@12.0.2 run check`. Changelog entries under `## [Unreleased]` in `packages/coding-agent/CHANGELOG.md`.

---

## 4. Workstreams

### W0. Shared foundations (small, do first)

#### W0.1 Symbol table — new `modes/interactive/theme/symbols.ts`

```ts
export type SymbolPreset = "unicode" | "nerd" | "ascii";
export type SymbolKey =
  | "bullet"            // ● / ● / *
  | "bulletPending"     // ○ / ○ / o
  | "gutter"            // ⎿ / ⎿ / L
  | "treeBranch" | "treeLast" | "treeVertical"
  | "ellipsis"          // … / … / ...
  | "success" | "error" | "warning" | "info"
  | "working"           // ✻ / 󰚩 / *
  | "queued"            // ↳ / ↳ / >
  | "branch"            // ⎇ /  / git:
  | "folder"            //  (nerd) / none / none
  | "model"             // ◆ / 󰧑 / model:
  | "context"           // ◔ gauge frames below
  | "task"              // ⧗ / 󰔟 / bg:
  | "lock" | "unlock"   // capability segment
  | "arrowUp" | "arrowDown"
  | "sepThin" | "sepPowerline" | "sepSlash" | "sepPipe";
export const CONTEXT_GAUGE: Record<SymbolPreset, string[]>; // ○◔◑◕● / nerd circles / [    ]..[####]
export function sym(key: SymbolKey): string;          // reads active preset
export function setSymbolPreset(preset: SymbolPreset): void;
export function resolveDefaultSymbolPreset(env: NodeJS.ProcessEnv): SymbolPreset;
```

- Preset resolution: settings value if set; else `ascii` when `TERM=dumb` or locale lacks UTF-8 (`LANG`/`LC_ALL`/`LC_CTYPE`); else `unicode`.
- Nerd glyphs only from Nerd Fonts v3 codepoints; document them in the file.
- Provenance header if any glyph table is copied from oh-my-pi.
- Tests: `test/symbols.test.ts` — every key defined for every preset; ascii preset is pure 7-bit; width of each glyph is 1 via `visibleWidth`.

#### W0.2 Semantic theme tokens — `theme/theme.ts`, `theme/theme-schema.json`

New optional color tokens, each with a fallback to an existing token so all bundled themes keep working unchanged:

| Token | Fallback |
|---|---|
| `bullet` | `accent` |
| `bulletTool` | `muted` |
| `gutter` | `dim` |
| `statusSegment` | `muted` |
| `statusSegmentStrong` | `text` |
| `capabilityRisk` | `error` |
| `badgeWarning` | `warning` |
| `gaugeLow` / `gaugeMid` / `gaugeHigh` | `success` / `warning` / `error` |
| `shimmerHighlight` | `accent` |

- Implement fallback in the theme resolver, not per JSON file.
- Tests: load every bundled theme JSON and resolve every new token without error.

#### W0.3 Notice center — new `modes/interactive/notice-center.ts`

Single owner for non-transcript notices. Replaces ad-hoc transcript cards.

```ts
export type NoticeKind = "warning" | "error" | "update" | "info";
export interface Notice {
  id: string;            // stable dedupe key, e.g. "safety:bash", "pkg-update", "ext-console:pi-web-access:<hash>"
  kind: NoticeKind;
  source: string;        // "ice-safe-verify", "extension:pi-web-access", "package-manager"
  title: string;         // one line
  detail?: string;       // multi-line body for overlay
  sticky?: boolean;      // safety notices: never auto-dismissed
  createdAt: number;
}
export class NoticeCenter {
  add(notice: Omit<Notice, "createdAt">): void;   // dedupe by id (replace, keep createdAt)
  dismiss(id: string): void;
  list(): readonly Notice[];
  counts(): { warning: number; error: number; update: number };
  subscribe(listener: () => void): () => void;
}
```

- Dedupe by `id` fixes the current `/tree` re-fire of the Bash/external warnings.
- Owned by `InteractiveMode`; fed to footer (badge) and to the `/warnings` overlay.

---

### W1. Quiet startup (milestone M1, highest value)

Target (80 cols):

```
╭────────────────────────────────────────────────────────────╮
│ ❄ ICE v0.83.0                                              │
│   model  cx/gpt-6.1-sol · high                  /model     │
│   dir    ~/Zks/ice/.worktrees/all-worktrees-experimental   │
│   mode   build · bash · sub-yolo · external     /mode      │
╰────────────────────────────────────────────────────────────╯
  3 context files · 70 skills · 5 prompts · 16 extensions · ctrl+o details
```

(Header style is open decision D2; a plain 3-line variant is the alternative.)

Tasks:

1. **New `components/session-header.ts`** (`SessionHeaderComponent implements Component`).
   - Inputs via a small data callback: `{ appName, version, model, thinking, cwd, modeLabel, capabilities: string[], expanded }`.
   - Rendering: rounded box from `sym` box chars (ascii fallback `+-|`), label column width 6, cwd middle-truncated with `…` (Codex `format_directory_inner` behavior), command hints right-aligned and dropped first when narrow.
   - `width < 44`: drop the box, render 3 plain lines.
   - Expanded (`ctrl+o`): append the existing full keybinding list (reuse `expandedInstructions` builder from `interactive-mode.ts:1011-1031`, moved into a helper `buildStartupHelpLines()` in the new file).
   - Live data: model/thinking/mode can change; header re-reads data callback on render (cheap) and the mode extension status `ice-mode` is read from footer data provider.
2. **`interactive-mode.ts:1004-1063`**: replace `builtInHeader` `ExpandableText` construction with `SessionHeaderComponent`; keep `quietStartup` meaning "no header at all". Keep `customHeader` extension override path (`:2765-2786`) unchanged.
3. **`showLoadedResources()` (`:1700`)**:
   - New default (collapsed): one dim summary row built from the same counts (`contextFiles.length`, `skills.length`, `templates.length`, `extensions.length`, themes only if > 0 and not default).
   - Expanded (`ctrl+o`) or `--verbose`: existing sectioned listing unchanged.
   - New command `/resources` forces expanded listing once (`force: true` already exists).
   - Diagnostics (skill/extension load errors, conflicts) go to `NoticeCenter` as `kind: "warning"|"error"` with `detail`, not inline. Keep inline only when `--verbose`.
4. **Extension console capture** — `core/extensions/loader.ts`:
   - Add an optional `onConsole?: (entry: { extensionPath: string; level: "log"|"warn"|"error"; text: string }) => void` to the load options.
   - Wrap each extension's module import + factory call in a scoped console override (`try/finally` restore). Loads are sequential per extension in `loadExtensions` — verify before implementing; if concurrent, capture per batch and attribute to "extensions".
   - Only interactive mode passes `onConsole`; print/RPC/JSON keep current behavior (stderr).
   - Interactive mode turns captured entries into notices `id: "ext-console:<name>:<hash(text)>"`, `kind` = warn/error -> `warning`/`error`, log -> `info` (info notices do not count in the badge).
5. **Update notices**: `showPackageUpdateNotification` and `showNewVersionNotification` become `NoticeCenter.add({ kind: "update", id: "pkg-update" | "ice-update", ... })`. Footer shows `↑ update` segment; `/warnings` overlay shows the full text and the command (`ice update --extensions`). Old card rendering removed (ask-before-remove rule: this is the explicitly requested change).
6. **Safety notices**: `showExtensionNotify(..., "warning")` from `ice-safe-verify` currently lands in transcript. Route `type === "warning"` and `"error"` notifies through `NoticeCenter` when the source is a known sticky safety notice, and keep a one-line transcript echo only for warnings raised mid-session by user action (e.g. `/mode` switch).
   - Implementation: `ice-safe-verify.ts` passes a stable key. Add optional third arg to `ctx.ui.notify(message, type, options?: { id?: string; sticky?: boolean })` in `core/extensions/types.ts` (backward compatible). Interactive mode uses `id` to dedupe; other modes ignore it.
   - Sticky ids: `safety:bash`, `safety:external`, `safety:sub-yolo`.
7. **Empty borders**: find which widget container renders the two empty `DynamicBorder` rows above the footer (`setWidget`/pending container); render the border only when the container has children.

Acceptance (M1):
- `zice` at 80x24: header (≤ 6 rows), one summary row, editor, footer. No raw console text, no `Warning:` rows, no update card.
- Footer shows `⚠ 3 · f2` (bash, external, pi-web-access) and `↑ update`.
- `ctrl+o` shows full help + full resource listing; second `ctrl+o` collapses.
- `/tree` navigation does not add duplicate notices.
- `--verbose` reproduces the old layout.

Tests:
- `test/session-header.test.ts`: widths 40/80/140, ascii preset, expanded/collapsed, long cwd truncation.
- `test/notice-center.test.ts`: dedupe, sticky, counts, subscribe.
- `test/extension-console-capture.test.ts`: fake extension writing `console.warn` during factory; captured, console restored after throw.
- Extend `test/interactive-mode-startup-input.test.ts` (or new suite test) for summary row vs `--verbose`.

---

### W2. Status bar (milestone M5; minimal badge lands in M1)

Target:

```
 build ⚠bash ext  ~/Zks/ice/…experimental  ⎇ integration/…experimental ⇡7 !34  ◆ gpt-6.1-sol high  ◔ 12%/272k  ⚠ 3 · f2
```

Narrow (80 cols) collapses to:

```
 build ⚠bash  …/all-worktrees-experimental  ◆ gpt-6.1-sol high  ◔ 12%  ⚠ 3
```

Hint row (left aligned, below, only when relevant — Codex behavior):
- idle, empty editor: `? for shortcuts`
- running: `esc to interrupt · ctrl+b background` (ctrl+b only when backgroundable, W5)
- after first ctrl+c: `ctrl+c again to exit`

Tasks:

1. **New `components/status-line/`** (port structure from oh-my-pi, MIT provenance):
   - `types.ts`: `SegmentId`, `SegmentRender = { text: string; priority: number; minWidth?: number }`, `StatusLinePreset`, `SeparatorStyle`.
   - `segments.ts`: pure functions `(ctx: StatusLineContext) => SegmentRender | undefined`. Segments: `mode`, `capabilities`, `cwd`, `git` (branch, ahead/behind, dirty counts — reuse footer data provider branch; ahead/dirty counts need a cached `git status --porcelain=v2 --branch` refresh on the provider's existing watcher, max once per 2 s), `model`, `thinking`, `context` (gauge + %), `cost`, `tokens`, `session`, `subagents` (running count from agent view bridge), `tasks` (W5), `notices` (badge), `update`, `extensions` (unknown extension statuses).
   - `separators.ts`: `thin` (` · `), `powerline`, `powerline-thin`, `slash`, `pipe`, `none`, `ascii`.
   - `presets.ts`: `minimal`, `default`, `full`, each `{ left: SegmentId[]; right: SegmentId[]; separator }`.
   - `layout.ts`: fit algorithm — render all, drop by ascending priority until `visibleWidth(left)+gap+visibleWidth(right) <= width`; then truncate `cwd` middle; never drop `mode`, `capabilities`, `notices`. Deterministic, unit-tested.
   - `context-thresholds.ts`: low < 60%, mid < 85%, high ≥ 85%, plus auto-compaction marker.
2. **`components/footer.ts`**: `render()` delegates to the status line when appearance `footer.preset` is set (new default). Keep `renderLegacy` reachable via preset `legacy` for one release (then ask before removing). Cache usage totals keyed by `sessionManager.getEntries().length` + last entry id.
3. **Extension statuses**: known keys map to segments (`ice-mode` -> `mode`; MCP adapter key -> compact `MCP 3` inside `extensions`). Unknown keys render in the `extensions` segment, sanitized (`sanitizeStatusText` already exists), never on their own line.
4. **Capability segment**: derived from ICE capability state (published by `ice-safe-verify` `publishCapabilityState`) — shows `bash`, `ext`, `yolo` with `capabilityRisk` color. This keeps safety visible after transcript warnings are gone.
5. **Notices badge** + **`/warnings` overlay**:
   - Keybinding `app.notices.show`, default `f2` (verify free in `core/keybindings.ts`).
   - New `components/notices-overlay.ts`: list grouped by kind, `detail` expandable with `space`, `d` dismiss non-sticky, `esc` close. Use existing selector chrome (`ChromeAppearance`).
6. **Shortcut overlay**: `?` typed into an empty editor opens `components/shortcut-overlay.ts` (three columns Compose / Session / Transcript as in Codex snapshot), built from `KeybindingsManager` so remaps display correctly. Implement as an editor pre-input check (empty text + `?`) — no hardcoded key: add `app.shortcuts.show` with default `?` and condition "editor empty".
7. **Appearance**: extend `FooterAppearance` with `preset`, `separator` style, optional `left`/`right` segment overrides, `colors` per segment. Migration: existing `order/visible` lists map to a `custom` preset (`appearance-migrate.ts`). Validation in `appearance-validate.ts`.

Acceptance:
- 1 row at ≥ 100 cols, ≤ 2 rows (+ hint row) at 80 cols, never wraps.
- All current footer facts reachable through some preset.
- `mode`, `capabilities`, `notices` visible at 60 cols.

Tests: `test/status-line-layout.test.ts` (3 widths × 3 presets × ascii/unicode), update `test/footer-width.test.ts`, `test/footer-data-provider.test.ts` (git counts cache), `test/notices-overlay.test.ts`, appearance migrate/validate cases.

---

### W3. Compact tool calls, grouping, and ctrl+o (milestone M3, largest)

Target states:

```
● Read 3 files, searched 2 patterns, listed 1 directory      (collapsed group, done)

● Bash(npm run check)                                          (single call, done)
  ⎿ 42 lines · exit 0

● Running grep -rn "foo" src                                   (running)
  ⎿ src/a.ts:12: foo()
    src/b.ts:40: foo(bar)
    … +18 lines

● Edit(src/footer.ts) +12 -3                                   (edit, done; diff on ctrl+o)

● Bash(npm test) failed · exit 1                               (error: first 5 lines always visible)
  ⎿ FAIL test/footer.test.ts
    …
```

Expanded (`ctrl+o`) shows every member call in the group with its full renderer output, exactly as today's renderers produce it (minus the background box).

#### W3.1 Consolidate construction

- New private method in `interactive-mode.ts`:
  ```ts
  private createToolComponent(name: string, id: string, args: unknown, cwd: string): ToolExecutionComponent
  private placeToolComponent(component: ToolExecutionComponent, groupKey: string): void
  ```
  Replace the three duplicated sites (`:3715`, `:3801`, `:4196`). `groupKey` = assistant message identity (streaming message object / history message index) so parallel and out-of-order tool events land in the right group.

#### W3.2 Compact shell — `components/tool-execution.ts`

- Add `shell: "compact" | "boxed"` from `ToolAppearance` (new field, default `compact`).
- Compact rendering:
  - Row 1: `<bullet> <title>` where bullet = `sym("bullet")` colored by state (`bulletTool` running with spinner frame, `success`, `error`), title from the tool's `renderCall` output (first line) — renderers are unchanged.
  - Collapsed body: summary from `tool-summary.ts` under `sym("gutter")`. Running: last 3 output lines from the partial result (same text the renderer already receives). Error: first 5 lines. Done: one summary line.
  - Expanded body: the existing `renderResult` component, indented 2 under the gutter, no background.
- Boxed shell: today's behavior, for users who prefer it.

#### W3.3 Tool summaries — new `components/tool-summary.ts`

Pure, keyed by tool name; no public API change.

```ts
export interface ToolSummary { verb: string; noun: string; count: number; detail?: string; isError: boolean }
export function summarizeToolCall(name: string, args: unknown, result: ToolResultLike | undefined): ToolSummary;
export function formatGroupSummary(summaries: ToolSummary[]): string; // "Read 3 files, searched 2 patterns, ran 4 shell commands"
```

| Tool | verb / noun | detail when single |
|---|---|---|
| `read` | Read / file(s) | `path:start-end` |
| `grep` | Searched / pattern(s) | `"pattern" in path`, `N matches` |
| `find` | Found / glob(s) | `N files` |
| `ls` | Listed / directory(ies) | `N entries` |
| `bash` | Ran / shell command(s) | `N lines · exit C`, duration |
| `edit` | Edited / file(s) | `+A -R` from result details diff |
| `write` | Wrote / file(s) | `N lines` |
| MCP `mcp__server__tool` | Called / `server` tool(s) | tool name |
| `delegate*` / `manage_subagent` | Delegated / agent(s); Waited on / agent(s) | role + status |
| unknown | Called / `name` | `N lines` |

Bash read-only classification (Codex `ParsedCommand` idea, reimplemented): a small conservative parser that recognizes single commands or `&&`/`;`/`|` chains made only of `cat|head|tail|sed -n|rg|grep|ls|find|wc|git status|git log|git diff|git show`. Recognized bash calls summarize as Read/Searched/Listed instead of "Ran". Anything with redirection `>`/`>>`, `-i`, `rm`, `mv`, subshell `$(`, or unknown binaries stays "Ran". Unit-tested table.

#### W3.4 Group component — new `components/tool-group.ts`

```ts
export class ToolGroupComponent extends Container {
  constructor(groupKey: string, appearance: ToolAppearance);
  canAbsorb(name: string, args: unknown): boolean;   // groupable and same groupKey and group still open
  add(member: ToolExecutionComponent): void;
  close(): void;                                      // assistant text, user msg, edit/write, error, turn end
  setExpanded(expanded: boolean): void;               // propagates to members
}
```

- Members stay `ToolExecutionComponent`s and stay registered in `pendingTools` by id, so `tool_execution_update`/`_end` code paths are unchanged.
- Collapsed render: one row `● <formatGroupSummary>` (bullet spins while any member running), plus the live 3-line tail of the running member under the gutter; single-member groups render as the member's compact row (no "1 file" phrasing).
- Expanded render: members' compact rows in order.
- Groupable set (default, per D5): read, grep, find, ls, all bash, MCP tools. Edit/write and error results close the group and render standalone so mutations and failures are never hidden.
- Error inside a group: group header turns `error` color and the failing member is rendered expanded-collapsed (title + 5 lines) below the summary even when the group is collapsed.

#### W3.5 Assistant and thinking rows — `components/assistant-message.ts`

- Prefix first text line with `sym("bullet")` in `bullet` color; continuation lines indent 2 (hanging indent). Markdown rendering unchanged otherwise.
- Hidden thinking renders as one dim row `✻ Thought for 12s (ctrl+t)` using existing `hiddenThinkingLabel`/`app.thinking.toggle`; expanded thinking unchanged.
- Appearance flag `assistantMessage.bullet: boolean` (default true).

#### W3.6 Expansion controls

- `ctrl+o` (`app.tools.expand`): unchanged global toggle; now meaningful because default is compact.
- New `app.tools.expandLast` (default `ctrl+shift+o`, verify free): toggles only the newest group/tool. Per-component override flag that the global toggle resets.
- Collapsed rows show `(ctrl+o to expand)` hint only on the newest collapsed item to avoid repetition.

Acceptance:
- A turn with 6 reads + 2 greps + 1 `rg` bash renders as one row when collapsed.
- Live streaming and history replay (`/resume`) produce identical grouping (same `groupKey` logic).
- Edits always visible as their own row with `+A -R`.
- Errors never fully hidden.
- `boxed` shell reproduces current rendering.

Tests:
- `test/tool-summary.test.ts` (table per tool + group phrasing + plurals).
- `test/bash-readonly-classifier.test.ts` (positive/negative table incl. `sed -i`, `>`, `$(...)`).
- `test/tool-group.test.ts` (absorb/close rules, error surfacing, expand).
- Update `test/tool-execution-component.test.ts` for compact vs boxed.
- Suite test `test/suite/tool-grouping.test.ts` with faux provider: streamed turn with parallel tool calls -> one group; replay -> same lines.

---

### W4. Working status line (milestone M4)

Target:

```
✻ Frosting… (1m 18s · ↓ 6.6k tokens · thinking high · esc to interrupt)
  ⎿ Running grep -rn "foo" src
 ↳ queued: also update the changelog
```

Tasks (extend `components/status-indicator.ts`; do not replace the verb/frames system):

1. `WorkingStatusIndicator` gains a `WorkingStatusData` callback: `{ startedAt, outputTokens, outputTokensEstimated, thinkingLevel, currentTool?: string, queued: string[], backgroundTasks: number }`.
2. Elapsed: `0s`, `42s`, `1m 18s`, `1h 02m` (Codex clock format). Uses existing loader interval — no new timer.
3. Output tokens: from streaming assistant `usage.output` when the provider streams usage; else estimate `chars/4` and prefix `~`. Source: `message_update` handler (`interactive-mode.ts:3700`) updates a counter on the indicator.
4. Interrupt hint from `keyText("app.interrupt")`.
5. Detail row under `sym("gutter")`: current running tool title (from W3 summary) else a tip from new `components/tips.ts` (static ICE tips: ctrl+o, ctrl+b, /tasks, /warnings, /appearance, `!` bash, `?` shortcuts). Tips rotate per turn, not per frame.
6. Queued follow-ups (`getAllQueuedMessages()`) as `↳` rows with `keyText("app.message.dequeue")` edit hint — move the current pending-messages rendering here if it duplicates.
7. Optional shimmer on the verb (oh-my-pi `theme/shimmer.ts`, MIT): appearance flag `statusIndicator.shimmer` default `true`, disabled automatically on `ascii` preset and when `NO_COLOR` is set.
8. ICE default verbs list (appearance default only, user-overridable): Frosting, Crystallizing, Freezing, Glazing, Drifting, Chilling, Thawing, Sculpting, Glinting, Settling.
9. Appearance additions in `StatusIndicatorAppearance`: `showElapsed`, `showTokens`, `showThinking`, `showDetailRow`, `showTips`, `shimmer` (all boolean, default true).

Acceptance: render test with fake clock; no additional intervals created; narrow widths truncate the parenthetical before the verb.

Tests: extend `test/status-indicator.test.ts` (fake clock, estimated tokens `~`, detail row variants, ascii).

---

### W5. ctrl+b background (milestones M6, M8)

#### W5.1 Conditional keybinding — `components/custom-editor.ts`, `core/keybindings.ts`

- New action `app.tasks.background`, default `ctrl+b`, description "Move running wait/command to background".
- Add to `CustomEditor`:
  ```ts
  onConditionalAction(action: AppKeybinding, canHandle: () => boolean, handler: () => void): void;
  ```
  When `canHandle()` is false the key falls through to the editor (so `ctrl+b` stays cursor-left while nothing is backgroundable). Same pattern `app.exit` already uses inline.
- Footer hint row and working-line hint show `ctrl+b background` only when `canHandle()` is true.

#### W5.2 Subagent waits (phase 1, ICE-owned, no core change)

Data flow:

```
user ctrl+b
  -> InteractiveMode.backgroundCurrent()
  -> agentViewBridge.releaseBlockingWaits("user")          (new)
  -> ice-subagents: each in-flight manage_subagent wait registered in a
     Map<toolCallId, { runId, release: () => void }> resolves its waitRuntime loop early
  -> wait returns latest observation with waitReleased: "user"
  -> tool result text: "User moved the wait to the background. <runId> is still running.
     You will receive a follow-up when it finishes; continue other work or end your turn."
  -> on terminal state of that run: deliver one follow-up message
     (customType "subagent_background_completed", triggerTurn true, deliverAs "followUp")
```

Tasks:
1. `ice-subagents.ts` `waitRuntime` (`:8340`): accept an optional `release?: AbortSignal` separate from the cancellation `signal`. When released, return `{ ...observation, waitReleased: "user" }` (not an error, no child impact).
2. `manage_subagent` execute (`:14988`): register the release controller under `toolCallId` for the duration of the wait; unregister in `finally`.
3. Record released runs in a `backgroundWatch: Set<runId>`; on `noteManagedTerminalResult` (`:8458`) for a watched run, send the completion follow-up exactly once (reuse the existing exactly-once guard — it already returns `true` only on first publication). Skip if the run was already reported through batch/writer completion paths.
4. `ice-agent-view-bridge.ts` (`IceAgentViewBridge`, `:491`): add `hasBlockingWait(): boolean` and `releaseBlockingWaits(reason: "user"): number`.
5. Authority/safety: no change to child authority, budgets, cancellation, or shutdown. Release is idempotent. Headless modes never call it.

#### W5.3 Background tasks view

- `tasks` status-line segment: `⧗ 2` = running managed children owned by the parent (+ background bash in phase 2).
- `/tasks` command and `app.tasks.open` (default unbound; `/tasks` is enough) open the existing subagent chooser/observatory (`openSubagentChooser`, `interactive-mode.ts:3305`) filtered to running/backgrounded items; phase 2 adds bash rows.

#### W5.4 Bash background (phase 2, needs decision D3)

- Constraint: core `bash` tool (`core/tools/bash.ts`) is upstream-owned; do not change its schema.
- Proposed: ICE adapter `ice-background-bash.ts` that wraps the bash tool definition when ICE is active:
  - Tracks the running process handle per `toolCallId` (requires a narrow hook in `bash.ts` exposing the spawned child + output accumulator to the wrapper, or the wrapper owns spawning via the existing `BashOperations` injection point — verify which seam exists before choosing).
  - On release: tool returns early with `{ backgrounded: true, taskId, logPath }`; output continues into an artifact file under the session artifacts dir; completion delivers a follow-up with exit code and capped tail.
  - Process stays in its process group; session shutdown kills it (same as today's detached group handling at `bash.ts:100`).
- Out of scope until D3 is accepted.

Acceptance (phase 1):
- Suite test (faux provider): parent calls `delegate` then `manage_subagent wait`; test triggers `releaseBlockingWaits` -> wait tool result has `waitReleased: "user"`; child completes -> exactly one `subagent_background_completed` follow-up; no duplicate when the model also calls wait later.
- Keybinding test: `ctrl+b` moves cursor left when nothing is backgroundable; triggers release when a wait is active.

Tests: `test/suite/regressions/` not needed (no issue number); use `test/suite/subagent-background-release.test.ts`, `test/custom-editor-conditional-action.test.ts`.

---

### W6. Theme maker integration (milestone M7)

1. **Settings**: `appearance.symbols: SymbolPreset | "auto"` (default `auto`) in appearance profile; `/settings` gets a "Symbols" entry.
2. **Customizer sections** — `components/appearance-customizer.ts` `APPEARANCE_SECTIONS` (`:72`) and section list (`:477+`):
   - `statusBar`: preset, separator, segment toggles/order (left/right), per-segment color.
   - `tools`: shell compact/boxed, grouping on/off, groupable tool set, collapsed preview lines (1–10), bullet glyph override.
   - `workingLine`: the W4 booleans; existing "Thinking indicator" and "Thinking verbs" sections stay.
   - `symbols`: preset picker with a live glyph sample row.
   - `sessionHeader`: box/plain, show capabilities, show hints.
3. **Preview** — `components/appearance-preview.ts`: add sample blocks rendering the real `SessionHeaderComponent`, `ToolGroupComponent` (collapsed + expanded), `WorkingStatusIndicator` (static frame), and the status line at the preview width.
4. **Validation/migration**: extend `appearance-validate.ts` and `appearance-migrate.ts`; old v2 profiles load with new defaults; unknown values fail validation with field paths (existing behavior).
5. **Theme JSON authoring**: document new optional tokens in `docs/` theme doc and in `theme-schema.json` descriptions.

Tests: extend `test/appearance-validate.test.ts`, `test/appearance-customizer.test.ts`, `test/appearance-acceptance.test.ts` for the new sections; preview render smoke.

---

## 5. Milestones and order

| # | Milestone | Workstreams | Depends | Size | Proof |
|---|---|---|---|---|---|
| M1 | Quiet startup + notice center + minimal footer badge | W0.1, W0.3, W1, W2.5 (badge + overlay only) | – | M | W1 tests, tmux 80x24 + 140x50 |
| M2 | Theme tokens | W0.2 | – | S | theme load test over all bundled themes |
| M3 | Compact tools + grouping + bullets | W3 | M1, M2 | L | W3 tests + suite grouping test |
| M4 | Working line | W4 | M3 (tool titles) | M | status-indicator tests |
| M5 | Full status bar + shortcut overlay | W2 | M1, M2 | M | status-line layout tests |
| M6 | ctrl+b subagent waits + /tasks | W5.1–W5.3 | M4, M5 | M | suite release test |
| M7 | Theme maker pages | W6 | M3–M5 | M | appearance tests |
| M8 | Bash background (after D3) | W5.4 | M6 | M | suite test with faux bash ops |

Each milestone ends with:
1. Targeted tests (`node ../../node_modules/vitest/dist/cli.js --run test/<file>` from `packages/coding-agent`).
2. `corepack npm@12.0.2 run check` (record npm versions if active npm differs).
3. tmux visual check via `./ice-test.sh` at 80x24 and 140x50, captured to `.artifacts/ui-refresh/<milestone>/` (startup, mid-turn, after-turn, ctrl+o expanded).
4. `packages/coding-agent/CHANGELOG.md` `[Unreleased]` entries.
5. `idea.md` update only if scope/architecture statements change (e.g. notice center, ctrl+b release semantics).

Live-model smoke (optional, per AGENTS.md): only via the configured `cx/gpt-6-luna` route.

---

## 6. Decisions

Resolved 2026-10-07. User direction: "prefer UI like Claude Code or Codex". Each decision follows that direction; ICE safety visibility rules still apply.

| ID | Question | Decision | Basis |
|---|---|---|---|
| D1 | Footer default preset | `minimal`: left = contextual hint (`? for shortcuts` / `esc to interrupt · ctrl+b background`) + mode + capability flags; right = `model thinking · NN% context` + notice badge. `default`/`full` stay selectable | Codex footer `? for shortcuts … 100% context left`; capability flags kept for ICE safety visibility |
| D2 | Session header | Small rounded box card (name+version, cwd, model, mode/permissions), then nothing else | Codex `>_ OpenAI Codex` box and Claude Code welcome box both use a compact bordered card |
| D3 | Bash ctrl+b | Accepted. Implement in M8 via ICE adapter around the upstream bash tool; seam choice verified before coding (section W5.4) | Claude Code backgrounds shell commands with ctrl+b |
| D4 | Default symbols | `auto` -> `unicode` (`●`, `⎿`, `✻`, `↳`); `nerd` opt-in | Both references use plain unicode glyphs |
| D5 | Bash grouping | Group all consecutive bash calls ("ran 4 shell commands"), plus reads/searches/MCP calls. Failed calls and edit/write still surface as their own rows | User screenshot: "Called context-mode, ran 4 shell commands" |
| D6 | Legacy footer | Keep as `legacy` preset for one release, then ask before removing | Not answered by style preference; AGENTS.md requires asking before removing functionality |

W3.3 change from D5: the read-only bash classifier still decides the verb (Read/Searched/Listed vs Ran), but no longer decides groupability.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Upstream merge pain in `interactive-mode.ts` | Only call-site swaps + 3 small private methods; logic in new files |
| Grouping wrong with parallel/out-of-order tool events | `groupKey` = assistant message identity; members stay in `pendingTools`; suite test with parallel calls |
| History replay differs from live | Same `placeToolComponent` path for both; replay test compares rendered lines |
| Hiding safety warnings reduces visibility | Sticky notices + always-visible capability segment + badge count; `--verbose` shows inline |
| `ctrl+b` breaks cursor-left | Conditional action falls through when nothing is backgroundable; dedicated test |
| Console capture swallows important extension errors | Captured entries become warning/error notices, counted in badge, full text in `/warnings` |
| Token count inaccurate without streamed usage | Mark `~` estimate; switch to real usage at `message_end` |
| Nerd glyphs missing in user font | `auto` never picks nerd; nerd is opt-in |
| Customizer file (3110 lines) growth | New sections in separate small modules imported by the customizer |
| Footer perf (re-summing entries every render) | Cache totals keyed by entry count + last id |

---

## 8. Evidence index

- Startup capture: scratchpad `startup.txt` (session-local), reproduced in section 1.1.
- ICE code references: section 1 line numbers as of 2026-10-07 on this worktree (dirty tree; re-verify before editing).
- Codex snapshots: `codex-rs/tui/src/{history_cell,bottom_pane,exec_cell,snapshots}/**/*.snap`.
- oh-my-pi: `packages/coding-agent/src/modes/components/status-line/*`, `theme/symbols.ts`, `theme/shimmer.ts`, `components/read-tool-group.ts`.
