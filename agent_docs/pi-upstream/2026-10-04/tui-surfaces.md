# Pi → ICE parity audit: TUI and interaction surfaces

Snapshot: upstream `earendil-works/pi` main `200387122ca450d6387f033949423114a270b96c` (v1.0.2); ICE HEAD `db8dd8eebfebe4a2e65d93e9693e6892744517e2`; shared base `588915ec71714688cee8b7153339e8bdebb3e82e`. Local working files were used, with no dirty files under this audit's TUI/modes/utils paths. Read-only investigation; no installation, source edits, builds, or tests. Test paths below are proposed validation, not observed passes.

Evidence inventory: `tui-inventory.json` records every changed TUI/modes/utils path and all upstream commit subjects/SHAs touching it. Raw deltas: `/tmp/ice-pi-tui-upstream.diff`, `/tmp/ice-pi-modes-upstream.diff`, `/tmp/ice-pi-interactive-small.diff`. Inventory classification is mechanical path/text presence, not proof that every hunk is missing. Functional classifications below use source inspection and symbol comparison.

Size accounting: the broad diff's **167 changed files / 19,425 added lines / 3,374 deleted lines** includes TUI docs, changelogs, tests, native prebuild binaries and coding-agent utils; it is not a runtime-only count. The root source classifier separately identifies **43 TUI runtime/native/build-script code paths** and **50 coding-agent modes source/schema paths**. Of those modes paths, artwork/easter eggs and palette-only changes are excluded below. Two experimental presentation paths outside `src/modes` are separately covered in E. These counts describe changed paths, not independent features or required edits.

## Findings that affect correctness or safety first

1. **Missing: cancel the session, not only the agent, when dequeuing input.** Upstream `de2de549` changes both `restoreQueuedMessages({abort:true})` paths to `void this.session.abort()`, so an in-flight summary/compaction cannot commit after UI cancellation. ICE still calls `this.agent.abort()` at `interactive-mode.ts:5140,5150`. Integrate with the core cancellation changes, preserving ICE's targeted queue cancellation. Bring upstream `test/interactive-mode-compaction.test.ts` and `test/suite/regressions/9340-9777-auto-compaction-cancellation.test.ts` coverage.
2. **Missing coordinated user Bash fail-closed fix.** ICE `core/extensions/runner.ts:975` catches handler errors, reports them and continues without rethrowing; its caller `interactive-mode.ts:7330` can then see undefined and fall through to local execution. Directly awaiting a correctly propagating runner would itself fail closed; the observed deficit is the runner swallowing errors and accepting unvalidated handler results. `509ee2bd` validates exactly one valid operations/result object, rethrows failures, and has the TUI catch and return without local execution. Integrate runner/type/caller changes together. Validation: `test/extensions-runner.test.ts`, `test/suite/regressions/9068-user-bash-fail-closed.test.ts`.
3. **Missing: scoped model toggle semantics.** Current `components/scoped-models-selector.ts:25` changes an all-enabled `null` list into `[id]`; upstream `f2a62278` changes it to all available IDs except the toggled one and normalizes an explicit all-enabled list back to `null`. This is a functional selection fix, independent of marker appearance. Validation: `test/scoped-models-selector.test.ts`.
4. **Missing: RPC dispositions and listener snapshot.** Clients currently cannot distinguish a handled extension prompt from an actual running/queued turn, and removing a listener while iterating skips the next listener. `e473b5cd`, `92e8d4f0` fix these; dependent core queue input handling is in `faa9863c`. Details in cluster R below.
5. **Missing: ANSI/hyperlink correctness.** `b780d20a`, `229afb82`, `8f2ae3fa`, `17f3dccb` close truncated OSC 8 links, avoid unnecessary scans, prevent link-color leakage across table wrapping, and preserve ANSI order at slice boundaries. These are not cosmetic theme swaps.
6. **Missing: low-level startup/input failure fixes.** `605a1b03` catches denied SIGWINCH self-signals; `06ed8716` and `2a95ef70` prevent split Alt+Enter from becoming Escape/cancellation; `b3487650` keeps the shell cursor visible when overlays close after stop.

## Explicit functional file coverage

Paths in each cluster are relative to the repository root. A file can participate in multiple clusters; cross-cluster dependencies must be integrated together.

### T1 — terminal input, reusable mouse dispatch, component focus: missing additions; existing baseline components are partial

Files: `packages/tui/src/tui.ts`, `terminal.ts`, `stdin-buffer.ts`, `layout.ts`, `components/mouse-region.ts`, `components/box.ts`, `components/editor.ts`, `components/input.ts`, `components/select-list.ts`, `components/settings-list.ts`, `components/scroll-view.ts`, `index.ts`.

Before: renderer-specific mouse/scroll behavior, no general `Component.handleMouse`, no reusable target/capture/focus routing or overlay bounds; input reassembly uses one 10 ms timeout; keyboard repaint uses throttled frame path. After: normalized cell mouse events, nested coordinate transforms, capture/drag/release, synthesized clicks, topmost overlay hit testing, overlay focus ownership, mouse editor positioning and autocomplete/list/settings selection, wheel overscroll chaining, exact `OverlayHandle.getBounds()`, immediate coalesced keyboard repaint, distinct 50 ms incomplete-sequence timeout and configurable/SSH-aware lone ESC delay, native Windows Shift+Enter, safe SIGWINCH.

Commits: `71026970`, `2470ea44`, `9841914c`, `83aed2ba`, `29d9f087`, `73dd066e`, `605a1b03`, `06ed8716`, `2a95ef70`, `b3487650`. Upstream `tui.ts` introduces `TuiMouseEvent`, `dispatchMouseEvent`, `retargetMouseEvent`, `Container.handleMouse`; ICE contains none of these names. `tui.ts` also removes coding-agent env/config reads (`c505f4c1`) and accepts explicit standalone renderer options/log directory; preserve ICE env names at launcher boundaries.

Hazards: ICE editor adds border styles, text decorations, and input highlighters (`components/editor.ts:248,404,411`); retain these while adding click geometry/history actions. Preserve ICE nested selectors/customizer focus and subagent switcher instead of replacing components wholesale. Validate `packages/tui/test/{mouse-components,editor,input,settings-list,overlay-options,stdin-buffer,terminal,tui-render,regression-sigwinch-kill-eacces}.test.ts` and existing ICE customizer/editor tests.

### T2 — fullscreen transcript navigation/search/copy/wheel: baseline already present, new functionality missing

Files: `packages/tui/src/alt-screen-search.ts`, `tui-alt-screen.ts`, `wheel-scroll.ts`, `keybindings.ts`, `components/input.ts`, `components/scroll-view.ts`, `layout.ts`, `index.ts`; `packages/coding-agent/src/modes/interactive/tui-renderer.ts`, `chat-viewport.ts`, `interactive-mode.ts`, `components/settings-selector.ts`.

ICE already has alternate-screen renderer, primary transcript, draggable scrollbars, navigation and copy flashes from the pre-base history. Do not implement a second renderer. Missing additions: grapheme/cell-aware multi-click word/line selection; punctuation segmentation fixes; reduced mouse tracking in tmux; focused overlays own wheel/viewport actions; half-page and optionally bound single-line scrolling; Ctrl+F transcript search with previous/next controls and wrap-normalized matches; cached linearly built search corpus; clickable jump-to-latest indicator; pointer capture and drag-select across editor; VS Code right-click duplicate suppression; configurable copy-on-select with explicit selection copy; wheel speed `auto` or fixed lines, acceleration and Alt multiplier; fullscreen exit policy (`transcript`/preserved screen) and default fullscreen product setting.

Commits: `fc3554e1`, `58fc0431`, `171c6b52`, `a3e93ec8`, `1279952d`, `2e4d2395`, `00121ed9`, `7d399e7b`, `2d411633`, `1ac6128e`, `79680533`, `457ae8c7`, `4e494929`, `c96bfacc`, `374e56e5`, `ab9e6f89`, `f1927c2d`, `ac4ac9ea`, `88ff80b9`.

Evidence: ICE `tui-alt-screen.ts:98,151` only supports numeric `wheelScrollLines` (default 1), has no `AltScreenSearch` or `copyOnSelect`. The new `createInteractiveTui()` and `createChatViewport()` are extraction/composition seams (`b6c87974`), not new reasoning loops; shared rendering should replace duplicate UI construction while preserving ICE per-agent scroll/edit/view state and widget docks. Keep optional default-fullscreen decision distinct from required correctness fixes. Validation: `packages/tui/test/{tui-alt-screen,wheel-scroll,mouse-components}.test.ts`, `test/alt-screen-large-transcript-bench.ts`, coding-agent `test/{chat-viewport,interactive-tui}.test.ts`.

### T3 — image protocol/Kitty/WezTerm correctness: baseline partial, later fixes missing

Files: `packages/tui/src/terminal-image.ts`, `components/image.ts`, `tui-alt-screen.ts`, `index.ts`; coding-agent `src/utils/{image-convert,tool-result-images,exif-orientation,mime}.ts`, `src/modes/interactive/{interactive-mode.ts,components/tool-execution.ts}`.

Before: Kitty conversion resides in tool result callbacks, can apply an old conversion to a newer result, and does not cover extension-created Image objects; cell sizing rounds up without minimizing aspect distortion. After: generic registered synchronous PNG transcoder, per-instance and bounded shared conversion caches, lazy Photon registration with re-render, source-identity reuse of Image objects, EXIF-derived output dimensions, iTerm payload size for xterm.js, optimized Kitty aspect sizing, WezTerm image placements/cropping/retention during scrolling, full GIF87a/GIF89a signatures, scan through non-EXIF APP1 segments, and model-specific image resize options.

Commits: `21b8cc1a`, `a276dabe`, `672000c8`, `803f0e90`, `7cf037c2`, `2c233a5c`, `47a18e37`, `c6b00676`, `f5c94648`. ICE does not have `ImageTranscoder`, `setImageTranscoder`, `ensurePngTranscoder`. Model resize metadata requires AI/core integration. Validate `packages/tui/test/terminal-image.test.ts`, coding-agent `test/{tool-execution-component,image-processing,image-process,image-resize-callers,tool-result-images}.test.ts`.

### T4 — renderer performance, ANSI, width, memory: baseline partial, improvements missing

Files: `packages/tui/src/utils.ts`, `tui-main-screen.ts`, `tui-alt-screen.ts`, `layout.ts`, `components/{box,text,markdown}.ts`; coding-agent `src/modes/interactive/components/{footer,user-message}.ts`.

After: 1 MiB bounded terminal writes with surrogate-pair preservation, avoid full-width layout recomposition, avoid focus-loss idle repaint, styled ASCII/ANSI width and wrapping fast paths, background-sensitive Box prefix tracking, invalidation clears Markdown lexer cache, flatten cached V8 strings, one cached full-width user-message line copy, footer session totals/context cache keyed by session identity/ID/leaf/count/routed model.

Commits: `6c4f3602`, `18dee5f0`, `4a879dd7`, `b485fa31`, `54c19a25`, `e792ba13`, plus ANSI commits in findings. ICE `footer.ts:108` and appearance rendering at `:267` still rescan entries; cache both normal and customized paths. ICE custom user/assistant backgrounds/padding/containers are intentional: do not erase them by applying upstream single-container layout literally. `flattenLines`, `BoundedTerminalWriter` are absent. Validate `packages/tui/test/{visible-width,truncate-to-width,regression-slice-by-column-ansi-order,layout,tui-render,markdown}.test.ts`, render/transcript benchmarks, coding-agent `test/footer-width.test.ts` and appearance fixtures.

### T5 — autocomplete/history: missing

Files: `packages/tui/src/{autocomplete,fuzzy,keybindings,utils}.ts`, `components/editor.ts`; coding-agent `src/modes/interactive/components/custom-editor.ts`.

After: configurable dedicated history previous/next keys that take precedence over app actions; deterministic shallow-before-nested fd completions using max depth; CJK punctuation token boundaries without splitting CJK letters; quoted paths containing non-ASCII separators; opening wrappers such as `(` and backticks excluded from path token while preserving real bracketed/group directories; slash commands after leading whitespace; skill autocomplete ranked by bare skill name with `skill:` prefix fallback; lower-allocation fuzzy search.

Commits: `16ad96ae`, `b37ebb7f`, `bfa68624`, `d5629e20`, `65117e31`, `d7951ec3`, `36af9dc4`, `59014460`. ICE has no `historyPrevious`, `autocompleteSeparatorRegex`. Validate `packages/tui/test/{autocomplete,autocomplete-skill-slash,editor,editor-history-keybindings,keybindings}.test.ts`. Add actions through keybinding definitions, not literal key checks.

### T6 — Markdown LaTeX and Mermaid rendering: missing; preserve ICE table implementation

Files: `packages/tui/src/latex.ts`, `components/markdown.ts`, `index.ts`; coding-agent `src/modes/interactive/components/mermaid.ts`, `interactive-mode.ts`, `components/settings-selector.ts`.

After: Unicode terminal inline/display math renderer with math tokenization, pending-stream handling, control spaces/multiline argument/matrix/algebra layouts; built-in Markdown transformer renders top-level Mermaid fences when they fit available width, configurable off/final/streaming, retains original source on unsupported layouts, reports warnings after streaming, and never transforms thinking content. Requires upstream `grok-mermaid` dependency (root package audit owns pin/lock changes).

Commits: `05e89b41`, `aa601d7b`, `452923b5`, `534bcbff`, `f0592205`, `fa0e1f48`, `66534fbd`. ICE `markdown.ts:875` includes `raw`/styled table strategies and process-default rollback; merge upstream math/cache/link changes around that functionality. Validate `packages/tui/test/{latex,markdown}.test.ts`, coding-agent `test/mermaid.test.ts`, appearance Markdown fixtures.

### T7 — terminal capability/color/style API: functionality missing; palette artwork excluded

Files: `packages/tui/src/{colors,oklab,terminal-colors,terminal-image,tui,index}.ts`; coding-agent `src/modes/interactive/theme/{theme,theme-controller,theme-json,system-theme}.ts`, `theme-schema.json`; `components/{themed-text,settings-selector,settings-submenu}.ts`, `interactive-mode.ts`.

After: public typed color values (indexed/RGB/OKLCH), conversion/mixing/ANSI style API; `Theme.style`; schema validation extracted behind validator registration; foreground/background/16 palette OSC queries with trailing DA1 completion, late replies and deduplication; system theme generated from actual terminal colors, asynchronous 100 ms query window with late update; unchanged-color events do not rebuild transcript; ThemedText recalculates baked-in colors on invalidate; per-run theme selection; capability overrides for image/hyperlink/true-color and Zed/TERM `-direct` detection. Existing ICE appearance color editor does not provide these upstream public APIs or terminal query semantics.

Commits: `56746909`, `bf8e4b95`, `409e808f`, `eb3e9fee`, `7cb2a51c`, `9795d602`, `e8682309`, `64921447`, `3fc3ef53`. ICE still has only `queryTerminalBackgroundColor`/`queryTerminalColorScheme` (`tui.ts:317`) and lacks new color modules. Migrate query consumers together: removing old methods before appearance/customizer callers migrate would break ICE. Preserve automatic/fixed ICE typed selection, 98 theme catalog, custom theme vars/import/export/profiles, preview/apply/cancel atomic transaction. `dark.json` and `light.json` palette changes are deliberately excluded from required logic parity; their additional fallback/search token schema changes belong with APIs. Validate `packages/tui/test/{colors,terminal-colors}.test.ts`, coding-agent `test/{theme-style,theme-detection,theme-controller,theme-export,theme-picker,system-theme,themed-text}.test.ts`, plus ICE customizer tests.

### T8 — native platform + clipboard: missing replacement, existing ICE dependency seam is intentional

Files: `packages/tui/src/{native-platform,native-module-path,native-modifiers,terminal,index}.ts`; `packages/tui/native/{clipboard.h,napi.h,darwin/src/darwin-platform.m,linux/src/clipboard-worker.h,linux/src/linux-platform-x11.c,win32/src/win32-platform.c}`; platform build scripts and prebuilds; upstream deletes `darwin/src/darwin-modifiers.c`, `win32/src/win32-console-mode.c`. Coding-agent `src/utils/{clipboard-command,clipboard,clipboard-image,wsl}.ts`; upstream deletes `clipboard-native.ts`; `src/modes/interactive/{interactive-mode.ts,components/auth-url.ts,components/login-dialog.ts}`.

After: one optional native-platform loader for modifiers, Windows VT input, clipboard text/images/file paths; bundled Darwin/Windows/X11 clipboard replaces third-party clipboard module; X11 worker preserves empty-vs-unavailable state and advertised-target matching; asynchronous command helper, no main-thread execSync for Linux reads/writes; actionable copy/paste failure reporting, verified desktop copy vs OSC52 remote/headless fallback, bounded OSC52; UTF-8 WSL temporary-file/PowerShell copy; Finder original paths preferred over icons and control characters rejected; OAuth URL copy uses app.message.copy; right-click targets current focused component and drops completion when focus changed.

Commits: `caf6dfe7`, `8676a0dc`, `3349e1db`, `60e7e76b`, `6dff740f`, `fd889a27`, `4caa3c44`, `ced72c2f`, `4254e0d9`. ICE currently uses `@zykairotis/ice-clipboard`, explicitly documented as an external ICE-owned seam in idea.md. Decide whether to use upstream helper or adapt equivalent behavior through that seam; do not assume a rename installs new native contracts. Package archive/native runtime layout and licenses must be integrated, not merely TypeScript imports. Validate `packages/tui/test/{native-platform,native-module-path,native-clipboard-linux}.test.ts`, all coding-agent clipboard tests and `test/auth-url-copy.test.ts`.

### I1 — model/thinking/default selectors and catalog refresh: missing behavior; visual marker changes excluded

Files: coding-agent `src/modes/interactive/{interactive-mode.ts,model-catalog-refresh.ts}`, `components/{model-selector,thinking-selector,scoped-models-selector,settings-selector,settings-submenu}.ts`.

Before: choosing /model saves new default (`model-selector.ts:366`); thinking selector is an unfiltered list; every selector refresh invokes runtime independently. After: model and thinking switches are session-only by default, explicit configurable save action persists default, default searchable and shown separately, `/thinking [level]`, filterable selector, per-model thinking overrides in settings, correct all-enabled toggle, shared runtime refresh coordinator with independent caller abort and operation canceled only when no waiters remain.

Commits: `2ff8ba62`, `9c8070fb`, `496185f6`, `ee29aa11`, `1d3503fb`, `92d8e2d1`, `f2a62278`, `7d8c11d3`, `df018b60`, `8fa7eebd`. Requires core SettingsManager/model contracts; retain ICE exact dynamic endpoint metadata/offline catalog rules, add no model registry. Validation: coding-agent `test/{model-selector,thinking-selector,scoped-models-selector,model-catalog-refresh,settings-selector}.test.ts` and queue/model core tests.

### I2 — session picker, startup input/status, operation lifecycle and rendering: missing upstream fixes; ICE additional status/view logic intentional

Files: `src/modes/interactive/interactive-mode.ts`; `components/{session-selector,custom-editor,status-indicator,branch-summary-message,compaction-summary-message,skill-invocation-message,assistant-message,user-message,tree-selector,footer,first-time-setup,trust-selector}.ts`; `chat-viewport.ts`, `tui-renderer.ts`, `external-editor.ts`; `src/utils/text.ts`.

After: session list arrives incrementally and aborts superseded work while maintaining selection/deletion/search; startup accepts editing with explicit submit feedback before tools initialize, displays downloads/runtime diagnostics instead of appearing frozen, optional header-only quiet mode; loader/status can live in editor border and re-theme correctly; click to expand thinking/summary entries; changing global thinking visibility updates only assistant components (preserves partial Bash/tool output); tree navigation rechecks compaction after dialogs/abort; custom/system/usage/context-edit entries have appropriate rendering/filtering; canonical session-boundary compaction avoids duplicate entries and renders retained entries in chronological position; compaction/branch summary billed-usage notices and cache warming usage/status; Anthropic thinking-drop notices compare prior count to avoid repeats; routed virtual model shown in footer and subscription status is advertised, not all OAuth; external editor strips UTF-8 BOM.

Commits: `dfbf793b`, `678f0af3`, `6f707eb3`, `faecac2c`, `f29ea3de`, `c1d4c801`, `f53ac113`, `fde6d778`, `b07e17fa`, `47acd8e6`, `466db0fe`, `9e05370b`, `836aee6d`, `c596d09d`, `13784598`, `46585349`, `540e174c`, `b0bd0ff9`, `1355cd36`.

Hazards: ICE has `IceAgentViewBridge`, mirror/take-control/historical views, managed background check-ins, subagent footer accounting, customized status indicators and queue cancellation. Upstream `interactive-mode.ts` replacement would remove these. Apply lifecycle/render fixes to displayed child as well as parent while keeping parent authoritative. Cache/footer invalidation must include current view and ICE custom presentation dependencies. Core session/usage/cache-warming changes must precede UI consumption. Validate coding-agent `test/{interactive-mode-startup-input,interactive-mode-status,interactive-mode-tree-navigation,interactive-mode-compaction,interactive-mode-assistant-diagnostics,session-selector-path-delete,session-selector-rename,session-selector-search,footer-width}.test.ts`, suite regressions `8611-thinking-toggle-pending-bash-output`, `4167-thinking-toggle-pending-tool-render`, and ICE agent-view/queue tests.

### I3 — tool presentation isolated from execution, fallback/MCP/codemode: missing

Files: `src/modes/interactive/components/{tool-execution,visual-truncate}.ts`, `interactive-mode.ts`; `src/utils/image-convert.ts`; public `ToolRenderers`/built-in renderer seams owned by core audit.

Before: rendering constructs built-in executable tool definitions and keeps per-result image index conversion cache; fallback call omits arguments and fallback output is uncapped. After: pure resolved render definitions from host, partial render overrides fall back to built-ins; fallback call shows arguments, collapsed result previews, click expansion, visual-line preview reusable component for codemode/MCP long wrapped output; MCP call rendering exists before server connects; nested codemode execution events appear in parent row rather than duplicate top-level cards; shared generic image transcoder described above.

Commits: `eb3e9fee`, `e14afc64`, `5257d0d5`, `0582d9c1`, `11449730`, `8562bcf6`. Retain ICE `renderShell`, appearance and typed delegation renderResult/progress/observatory behavior. Validation `test/tool-execution-component.test.ts` and core MCP/codemode renderer tests.

### I4 — auth/UI extension contracts/resource configuration: missing additions; small branding changes excluded

Files: `components/{auth-url,login-dialog,oauth-selector,radius-login-selector,extension-editor,extension-input,extension-selector,config-selector,first-time-setup,index}.ts`, `interactive-mode.ts`.

After: OAuth URL component/action copy; OpenAI alternate sign-in choices; correct account/subscription classification; back navigation after cancellation; Radius sign-in shortcut and explicit offer to add/update global Radius MCP configuration; defer model selection until authenticated dynamic catalog arrives and do not replace a session/model changed during refresh; llama.cpp guidance without inventing a default; extension input initialValue/description and multiline editor/selector descriptions; `builtin:<name>` resource IDs displayed/disabled/overridden without filesystem relative-path corruption.

Commits: `ced72c2f`, `02eed88f`, `ed8b3bcc`, `9767ba27`, `a1bc0ec7`, `4259686d`, `3c75b274`. Radius MCP offer is an explicit user flow; integrate with ICE --allow-external/trust/mode policy, never enable by login alone. Preserve built-in hidden ICE extension registration/global-first trust precedence. Existing upstream validation includes `test/{auth-url-copy,oauth-selector}.test.ts` and provider auth tests; new ICE-specific regressions should cover permission and configuration behavior.

### I5 — session sharing, bug report/crash flow: missing optional feature cluster; external destinations need fork policy

Files: `src/modes/interactive/{bug-report,session-share,interactive-mode}.ts`; `components/{extension-editor,extension-selector}.ts`; `src/utils/{zip,management-http}.ts` and core bug report/crash/session-export modules (core ownership).

After: concurrent shares use unique temporary directories with cleanup; exported JSONL includes presentation metadata/system prompt/tool schemas; authenticated Radius artifact sharing with private-gist fallback; `/bug` description/transcript/summary/delivery choices, cancellable summary/upload, offline ZIP export, fallback export after upload failure; crash persistence and loaded-extension stack attribution, once-per-session hints excluding transient/expected failures.

Commits: `686f3487`, `460191cf`, `f4585b8b`, `6f35de5b`, `3c75b274`, `d1230ea2`, `c7cdb460`, `1e0fe204`, `d875512c`, `63787ee6`. ICE already has old /share implementation: isolation/export refactor required but Pi's developer destination is not a desired ICE external side effect by default. Keep local traces and exports; an ICE bug upload endpoint requires explicit product choice and consent. Missing is not a claim these are mandatory defaults. Validate `test/{session-share,bug-report,interactive-mode-bug-report-hint}.test.ts`, crash/upload core tests.

### R — JSONL/RPC: missing changes, print mode itself has no upstream source delta

Files: `src/modes/json-event.ts`, `src/modes/rpc/{rpc-client,rpc-mode,rpc-types}.ts`.

After: constant-size streaming `usage`, toolcall_start `id`/`toolName`, validation of toolcall content shape while still omitting cumulative partial snapshots; RPC `clear_queue` returns removed steering/followUp text; RPC prompt/steer/follow_up include typed started/queued/handled disposition; queued input passes `source:'rpc'` to extension handlers; event listeners dispatched from a snapshot. `print-mode.ts` was unchanged upstream in this interval; its JSON transport consumes `toJsonEvent`, so protocol changes still affect print JSON.

Commits: `830a0a59`, `c93ea6cc`, `a79b3733`, `faa9863c`, `e473b5cd`, `92e8d4f0`. ICE's additional RPC settings/subagent controls must survive. `clear_queue` complements ICE targeted queued-input cancellation; do not remove intentional functionality. Disposition changes require core preflight semantics and controller/client updates, including Curax, to avoid awaiting agent_settled for a handled prompt. Validate `test/{rpc-jsonl,rpc-client-clear-queue,rpc-prompt-response-semantics}.test.ts`, `test/suite/regressions/7925-toolcall-start-metadata.test.ts`, local RPC settings/subagent tests. Broad live rpc tests are not to be run without auditing endpoint gates.

### E — shared experimental TUI client: missing UI seam updates; durable runtime audited by core agent

Files outside modes: `packages/coding-agent/src/experimental/{client-tui,client-tui-chat}.ts` are new/missing locally. `b6c87974` shares `createInteractiveTui`/`createChatViewport`, sets fullscreen document/dock presentation and carries copy/right-click/scrollbar/theme hooks; `f1927c2d` propagates wheel setting. At final upstream HEAD `48dd1e2f` has ported the client to `pi-durable` ConversationView/EntryRecord (`pi.live`, `pi.inbox` documents). `ExperimentalChatView` incrementally synchronizes transcript IDs, rebuilds after reset/compaction/retry-dropped streaming, transfers streaming assistant/tool cards to final entries, handles repeated tool call IDs across turns, marks interrupted calls as not run, disposes active Bash/card timers, and projects retry/deferred/compaction/tool/run status. Preceding service commits include `e26afb63`, `ae2cc511`, `fa503683`, `fbf2db63`, `8e374e4d`, `d3697e65`, `fcbb0b34`, `f55da4a9`, `1d0d110a`. Full experimental service/client parity depends on the core/durable migration and conflicts with ICE's declared no-competing-session-store/loop boundary if grafted into ordinary sessions. Record as missing/architectural decision rather than mandatory default runtime replacement. Reuse stable renderer improvements independently. Validate `test/experimental-client-tui.test.ts` with fake providers/services if this optional target is adopted.

### Explicitly excluded aesthetics/branding

`components/{armin,pi-logo,easter-egg-3d,easter-egg-3d.lazy}.ts`, deletion of `daxnuts.ts`, and related exports/header animation (`b35af04f`, `7fbbd5f4`, `1c1e9c0e`, `c450f2c0`, `ca9c9251`) are optional artwork/easter eggs, not required reasoning/tool/runtime parity. Do not remove intentional ICE functionality without authorization. Pure dark/light palette values and all curated theme catalog differences are excluded, but token/schema/public API changes in T7 are functional.

## UI utilities crossing the audit boundary

`utils/{clipboard-command,clipboard-image,clipboard-native,clipboard,image-convert,exif-orientation,mime,tool-result-images,syntax-highlight,highlight-js,highlight-js-lib-index,wsl,text}.ts` are covered above except syntax: `cec3a91c` switches from all highlight grammars on startup to eager common grammars + deferred others, with new `highlight-js.d.ts` and removal of old declaration file. ICE has old all-grammars import. The upstream deferred implementation uses `import()` and conflicts with repository's no-inline-import rule; preserve the runtime behavior with a reviewed allowed module-loading seam instead of copying that hunk blindly. `text.ts` BOM stripping also feeds frontmatter/model input/core.

Remaining changed utils `frontmatter.ts`, `paths.ts`, `shell.ts`, `tools-manager.ts`, `version-check.ts`, `management-http.ts`, `zip.ts` are inventoried but general core/CLI/packaging changes are owned by the root/core report. Relevant UI overlaps: managed tool startup status, musl fd/rg downloads (`6aedd106`), release resolution without GitHub API (`57e53b0d`), shell-path normalization (`9524d3a5`), shell detection performance (`b485fa31`), bug ZIP and transient management HTTP retry (`46b53b99`).

## Integration order

1. Core session/queue/cancel/input contracts + R + correctness fixes, preserving ICE queue/view/permission behavior.
2. TUI input/mouse/terminal/native seams, then search/copy/wheel/image and performance fixes with their focused tests.
3. Pure tool renderers + selector/default/progressive picker/startup integration.
4. Shared viewport/renderer composition and experimental client parity, then Markdown/color/style APIs, preserving ICE appearance transactions.
5. Optional upstream feature/default decisions (fullscreen default, system theme default, Mermaid/LaTeX, sharing/bug upload product destinations). Track deliberate exclusions separately from missing backports.

After implementation use specific package-root tests and pinned `corepack npm@12.0.2 run check`; report actual output/exit statuses. This audit did not verify implementation by execution and does not warrant claiming parity now.
