# ICE × Pi-Bolt — Performance Extraction and Native AOT Integration Plan

**Status:** PROPOSED / NOT IMPLEMENTED (source-level analysis only)
**Prepared:** 2026-10-10
**Target worktree:** `/home/mewtwo/Zks/ice/.worktrees/all-worktrees-experimental`
**Branch / observed HEAD:** `integration/all-worktrees-experimental` / `9e866593f` (104 commits ahead of remote when inspected)
**Reference:** `opensec-git/Pi-Bolt`, pinned commit `a9672fd06be34fcbe63be12d99becded4aa9f450`, Pi-Bolt 0.7.3 / Pi v1.1.0
**Change authority:** This file is a plan. It does not authorize source edits, installation, commits, releases, deployment, provider calls, or modification of other worktrees.
**Existing dirty state at planning time:** changes in `packages/coding-agent/CHANGELOG.md`, `src/modes/interactive/components/session-header.ts`, `interactive-mode.ts`, `test/new-messages-pill.test.ts`, `test/session-header.test.ts`; untracked `imported_extensions/`, `random-story.md`, `zks-visuals/`. Preserve all of them. Recheck status before implementing.

## 0. Executive verdict and performance thesis

**Feasible in stages:** selectively port Pi-Bolt's source-level efficiency fixes into ICE, then integrate the **actual patched Bun/JavaScriptCore AOT runtime** as an *optional* build. Keep ICE's Pi-derived authoritative agent loop, subagents V2, provider routing, session storage, tool/extension interfaces, security rules, CLI, TUI, and transport semantics. Do not replace ICE's product layer with the Pi-Bolt fork.

Pi-Bolt demonstrates meaningful results for *its own* Pi v1.1.0 workload, NOT verified results for ICE: on Linux AMD EPYC 7B13, its published medians are roughly 47 ms TUI ready-to-type vs 143 ms upstream Pi on Bun 1.4.2 and 334 ms on Node 24; 4.3 s CPU for 60,000 characters streamed vs 44.4 s Bun and 42.3 s Node; 0.8 s vs 30.0/39.4 s for its 200 KB tool-write scenario; 139 MB vs 296/537 MB at the end of its long-session benchmark. These are not predictions. Pi-Bolt tests use scripted models and interleaved processes; real provider latency mostly dominates wall time. **Never advertise an ICE multiplier until benchmarked on the same host and fixtures.**

**Performance is four separate metrics:** (a) cold/warm process launch and ready-to-type, (b) agent-side CPU/latency under streaming and tool argument updates, (c) long-session memory and responsiveness, (d) real-model end-to-end wall time. The runtime does not make upstream models generate tokens faster.

**Recommended priority:** instrument first; port Pi-Bolt's *bounded streaming JSON parse* and *incremental Markdown lex/render caches* with equivalence tests; fix proven ICE-specific redraw costs; optimize startup/extension initialization; establish stock-Bun release parity; then attempt the AOT build. These are independent levers and must be measured independently.

### 0.1 Definition of success and benchmarking policy

- **Correctness is a hard gate:** same tool arguments, file bytes, permissions, trust behavior, session semantics, model selection, output projections, cancellation/recovery, and terminal-visible content (allowing only explicitly documented cosmetic variants). No silent feature removal to gain speed.
- **Primary performance gate:** for each changed stage, at least one representative, reproducible target workload must improve against its **immediately preceding same-runtime ICE baseline** outside noise, with no material regression (>10% median or >15% p95) on other critical workloads unless explicitly accepted and documented. These are decision thresholds, not performance guarantees.
- **AOT-specific gate:** compiled ICE must prove `image registered: true`, pass the shared ICE correctness suite and match or outperform stock-Bun ICE on its target workload; otherwise keep AOT experimental.
- **Stretch target, not a promise:** reach <=1.25x Pi-Bolt 0.7.3 median ready-to-type and CPU on *matched minimal feature profiles and identical Pi-equivalent scripted fixtures* on the same CPU. The **full ICE** profile is measured separately because ICE has additional startup and safety obligations. Differences in Pi/ICE versions and features must be disclosed.
- **Release gate:** acceptable p95 pauses, bounded memory floor under long sessions, native/third-party plugin policy, platform fallbacks, supply-chain provenance, rollback, and two-pass regressions. No production replacement solely on a one-off startup microbenchmark.
- **Evidence:** track raw JSONL, command lines, git hashes, versions, CPU affinity, fixture hashes, enabled extensions, reasoning/provider route (if any), CPU/wall time, private memory/RSS, exit/health state, correctness results. Use medians + p95 across repeated interleaved runs. Raw traces and optional flamegraphs stay in ignored local artifacts; redact secrets.

## 1. Observed ICE architecture — do not rediscover

These are source observations at the inspected HEAD, not claims that benchmarks have passed.

| Area | Current evidence | Consequence |
|---|---|---|
| Policy | `AGENTS.md:3-42,97-120,132-159`; `idea.md:1-17` | Preserve the single authoritative Ice loop; avoid core rewrites, unrelated dirty changes, unauthorized releases and network calls. |
| Entry points | `packages/coding-agent/src/ice.ts:1-31,64-128`; `src/main.ts:511-522,659-816` | ICE owns branding, initial model handling, trust, capability policy and static `extensionFactories` passed to `main()`. Adapt Pi-Bolt's entry generation to ICE, not vice versa. |
| Startup timings | `packages/coding-agent/src/core/timings.ts:1-52`; `scripts/profile-coding-agent-node.mjs:1-47`; root `package.json:37-40` | `ICE_TIMING=1` and existing Node/Bun TUI/RPC profiler are existing instrumentation. Extend them, do not duplicate. |
| Tool streaming | `packages/ai/src/utils/json-parse.ts:1-124`; `src/api/openai-completions.ts:548-552`; `anthropic-messages.ts:670-676`; `openai-responses-shared.ts:635-650`; `bedrock-converse-stream.ts:573-576`; `packages/agent/src/proxy.ts:331-336` | Complete/partial repair parsing may run on every streamed delta. The live display and final authoritative parse need separate paths. |
| Markdown | `packages/tui/src/components/markdown.ts:180-258` | `Markdown.setText` invalidates whole-line cache; renders tokenize current text and restyle. Block-level incremental reuse is not verified in ICE. |
| Assistant redraw | `packages/coding-agent/src/modes/interactive/components/assistant-message.ts:164-185` | `updateContent` clears/recreates children on stream updates. ICE-specific appearance/OSC133/Markdown transformations complicate transplant. |
| Tool redraw | `packages/coding-agent/src/modes/interactive/components/tool-execution.ts:100-132,169-186` | `updateDisplay` can reprocess large args; compare Pi-Bolt's identity guard against ICE's actual `updateArgs` semantics. |
| Terminal | `packages/tui/src/tui.ts:787-815`; `packages/tui/test/tui-render.test.ts` and `tui-alt-screen.test.ts` | Render requests are already batched/throttled and terminal output diffed. Optimize unnecessary layout/reprocessing, not by bolting on another generic debounce. |
| Extensions | `packages/coding-agent/src/core/extensions/loader.ts:734-785`; `core/resource-loader.ts:389-420`; `src/main.ts:519-522,696-739` | Cached jiti factories and inline factory injection already exist. Loading follows trust-sensitive bootstrap and project-resolution stages. Preserve order and consent. |
| Subagents V2 | `packages/coding-agent/src/subagents/v2/session-factory.ts:115-172`; `v2/runtime.ts:1-52`; `idea.md:13-69` | Ordinary in-process child `AgentSession` with frozen contracts, durable registry, controlled worktree isolation; no competing orchestration layer. Do not assume every child is a subprocess. |
| Packaging | `packages/coding-agent/package.json:35-40`; `src/bun/cli.ts:1-15`; `scripts/build-binaries.sh:1-24,141-220` | ICE already has a stock-Bun binary workflow for six platforms and a compiled Bun entry with workers/assets. AOT is a new optional target, not the existing standard Bun build. |
| Local release | `scripts/local-release.mjs`; `scripts/ice-runtime-packaging.mjs:4-53`; `AGENTS.md:122-130` | Node/Bun releases and Curax snapshot packaging must remain usable; do not change Curax's installed runtime or current manifest as part of this port. |
| Prior benches | `benchmarks/native-vs-subprocess/`, `benchmarks/read-only-subagents/`, `benchmarks/subagent-prompt-cache/` | Reuse independent fixture/stat/manifest conventions, but introduce separate performance fixtures to avoid mixing reliability and latency results. |

**Environment observed 2026-10-10:** Node `v24.21.0`; stock Bun `1.3.11` present; no `pi-bolt` command; `packages/coding-agent/dist/ice.js` and `dist/bun/cli.js` exist; compiled `dist/ice` not present. No CPU-time, startup, rendering or AOT equivalence measurements were run in preparing this document. Pi-Bolt's reference numbers used stock Bun 1.4.2; do not compare that column uncritically to local Bun 1.3.11.

**Concurrency warning:** uncommitted interactive-mode, header and pill changes are active work, not fair game for “cleaning up” during a speed project. Edits to `interactive-mode.ts` require fresh status/diff, coordination, and a focused scope; preferably port pure TUI/AI optimizations first.

## 2. Pinned Pi-Bolt source inventory and adoption decisions

Pinned source: `https://github.com/opensec-git/Pi-Bolt/tree/a9672fd06be34fcbe63be12d99becded4aa9f450` (2026-10-10). Its `sources.json` pins WebKit `d28f16e5cc234c19054d7edec2a2de5519500a1f` plus `patches/webkit.patch`, Bun `37da174d500f2201793c8352f791afdd9102eab9` plus `patches/bun.patch`; Pi baseline tag `v1.1.0`. Do not float the source revisions during a benchmark series.

| Upstream file / location (at pinned commit) | Finding | Decision |
|---|---|---|
| `packages/ai/src/utils/json-parse.ts:28-120` | `repairJson` copies unchanged string runs; `parseStreamingJsonWhileStreaming` uses `WeakMap<object, number>` and 1/8 growth threshold above 1 KB to avoid quadratic reparsing while keeping a final full parse. | **ADAPT first**, retaining original final validation. This is throttled reparsing, not a true stateful incremental parser. |
| `packages/coding-agent/src/modes/interactive/components/tool-execution.ts:168-182` | `updateArgs` skips redraw when the parsed args object identity is unchanged. | **ADAPT**, after matching ICE's tool renderer semantics. |
| `packages/tui/src/components/markdown.ts:175-365,424-610` | Bounded suffix re-lex; preserve settled blocks, fall back on link definitions/length mismatch; detached suffix strings to avoid retention; cached rendered blocks keyed by tokens/style/width/theme; WeakRef token retention; test switch. | **ADAPT** to ICE's Marked version, custom themes, transforms and appearance; do not blindly replace file. |
| `packages/tui/src/rendered-markdown.ts:1-15` | Cache generation for theme invalidation. | **ADAPT**, include appearance and capability invalidation. |
| `packages/tui/src/tui.ts:985-1042` | Immediate rendering path and timer cancellation. | **COMPARE**, only port proven fixes (ICE already coalesces renders). |
| `packages/tui/src/utils.ts`, terminal scroll paths | Formatting, flattening and scroll-region optimization candidates. | **MEASURE FIRST**, only port after parity tests for main/fullscreen, overlays, tmux, Unicode, resize. |
| `docs/PLUGINS.md:15-116,130-170,244-290` | AOT compile-in manifests, optional JIT, duplicate-registration and worker/native-addon caveats. | **ADAPT** to ICE `InlineExtension` / project trust; reject untrusted automatic compilation. |
| `scripts/build-pi.sh:1-185` | Patched-runtime `bun build --compile --bytecode`, static heap, AOT, optional JIT, CPU, training profile, worker entries, asset copying, and `image registered: true` check. | **PORT BUILD TECHNIQUE**, not an ICE-replacing Pi fork or destructive `rm -rf` of shared outputs. |
| `scripts/train-profile.sh:1-50` and `scripts/lib/train_session.py` | Scripted profile captures `bytecode.order` and dynamic `regexps.txt`. | **ADAPT** to ICE's prompts, TUI themes, RPC, subagents, tools and approved plugins; no keys in training artifacts. |
| `sources.json`, `patches/{bun,webkit}.patch`, `scripts/{fetch-sources,fetch-runtime,build-runtime}.sh` | Native engine changes underpin AOT; stock Bun is not equivalent. | **REFERENCE/PIN**, build and test separately; never vendor massive upstream sources into ICE by default. |
| `docs/BUILDING.md:14-143`, `docs/ARCHITECTURE.md:1-239` | Linux x86-64/macOS arm64 AOT; CMake/Rust/LLVM/Bun toolchain; ~40 GB temporary build disk, Linux ~32 GB RAM for source build; runtime/heap/worker restrictions. | **ADOPT REQUIREMENTS** for prototype and release qualification. |
| `bench/{benchmark.py,long_answer.py,pauses.py,tmux_check.py,stress.py,e2e_tools.py,e2e_screen.py}` | Interleaved scripted-model benchmarks and golden output/terminal checks. | **ADAPT TEST METHODOLOGY** to ICE with recorded provenance. |
| `THIRD_PARTY_NOTICES.md` / `LICENSE` | Bun/JSC/ICU and Pi notices including LGPL-related obligations. | **REVIEW AND PRESERVE** per-file and binary-distribution provenance. |

Reference documents at pinned commit:
- Architecture: https://github.com/opensec-git/Pi-Bolt/blob/a9672fd06be34fcbe63be12d99becded4aa9f450/docs/ARCHITECTURE.md
- Plugins: https://github.com/opensec-git/Pi-Bolt/blob/a9672fd06be34fcbe63be12d99becded4aa9f450/docs/PLUGINS.md
- Building: https://github.com/opensec-git/Pi-Bolt/blob/a9672fd06be34fcbe63be12d99becded4aa9f450/docs/BUILDING.md
- Benchmarks: https://github.com/opensec-git/Pi-Bolt/blob/a9672fd06be34fcbe63be12d99becded4aa9f450/docs/BENCHMARKS.md
- Build source pin: https://github.com/opensec-git/Pi-Bolt/blob/a9672fd06be34fcbe63be12d99becded4aa9f450/sources.json

**Do not assume equivalence:** Pi-Bolt is currently a fork of Pi **1.1.0**; ICE coding-agent metadata declares **0.83.0** (`packages/coding-agent/package.json:1-12`), and contains ICE-only changes. For every port generate a three-way matrix: feature exists in ICE? same upstream semantics? exact changed functions/fixtures? Do not cherry-pick a whole package; imports/extension contracts and workspaces differ (`@zykairotis/ice-*` vs `@earendil-works/pi-*`).

## 3. Constraints and invariants

1. **Architecture:** one ICE-owned agent/model/tool loop; no replacement SDK/controller/provider registry/compaction/session store; never remove V2 functionality in exchange for a benchmark.
2. **Tool trust:** preserve modes `ask/plan/build/review/autonomous`; deny/ask/allow ordering, project trust bootstrap, extension source scope, headless approval, subagent frozen/hashed authority and worktree ownership. Native runtime or cache must not bypass these checks.
3. **Data fidelity:** generated file bytes, JSON tool schemas, tool-call IDs, provider usage and streaming event types, session entries, compaction and model metadata, RPC/JSONL/SDK contracts unchanged. Cached partial args are **UI-only**; final tool execution consumes an authoritative fully parsed and schema-validated object.
4. **Appearance:** custom themes, highlighter, Markdown transform hooks, terminal capabilities, Unicode/ANSI width, images, OSC133, appearance previews, alternate screen, TUI overlays and resize must invalidate caches correctly.
5. **Lifecycle:** extension factory ordering (`before-user` and normal), hidden factories, duplicate registrations, plugin reloads, cleanup hooks, user/project trust, cancellation and interactive/editor responsiveness unchanged.
6. **Side effects:** no network/model calls in scripted benchmarks; no secrets in binaries/training profiles/fixtures; no deploy to Curax; no automatic `curl | sh` or dynamic execution of untrusted reference content. Native binaries are opt-in.
7. **Build support:** retain Node, stock Bun, and all currently supported target builds, especially Windows and Linux ARM where Pi-Bolt AOT is unavailable; AOT Linux x86-64 first, macOS arm64 later if tested. Other platforms stay on proven runtime.
8. **Immutable state:** preserve uncommitted user work, reference checkout read-only, no mass lockfile drift, no destructive shared output cleanup, no package changes without pinned-dependency review. No commit/push unless explicitly requested.
9. **Licenses:** classify each reused source patch, copied module and native binary; include attribution, license texts, patch commit hashes, and reproducible source/build instructions; review the binary's JSC LGPL-2.0 implications before distribution.
10. **No magical latency claim:** compile/runtime optimizations target harness CPU/startup/UI, not model-provider TTFT, network RTT, reasoning token count or model throughput.

## 4. Target architecture and compatibility contract

```text
                   ICE source + current security / agent APIs
                                    |
                   first-party source optimizations
                (JSON, Markdown, TUI, startup, extensions)
                                    |
                          tested workspace dist/
                                    |
                      same ICE executable contracts
            +-----------------------+----------------------+
            |                       |                      |
        Node.js reference      stock Bun build       Pi-Bolt AOT build
        existing release       existing release      OPTIONAL experimental
            |                       |                      |
            +--------- same scripted fixtures -------------+
                                    |
                      correctness + performance report
```

### 4.1 Target boundaries

- **Pure implementation work** stays in `packages/ai`, `packages/tui`, `packages/coding-agent` (adapters/components only) and focused tests. Keep new modules small; preserve current exports.
- **Perf harness** proposed at `benchmarks/pi-bolt-parity/` with manifest, fixtures, isolated temp roots, process/tmux drivers, correctness comparators and report generation. Reuse `scripts/profile-coding-agent-node.mjs` for startup phases.
- **AOT build adapter** proposed at `scripts/native-aot/` (source pin/manifest, tooling probes, entrypoint and asset stage, profile generation, build/verification scripts). It produces **new** `.artifacts/ice-native-aot/...` paths, never overwrites standard `dist`/Curax artifacts during experiments. Exact path naming finalized in Stage 0.
- **Plugin bundles:** trusted, allowlisted inline factories connected through existing `main(args, {extensionFactories})` and the resource loader; dynamic runtime loading remains available. Per-profile build manifests with stable logical IDs and conflict detection. Never automatically compile user/project-local extensions.
- **AOT JIT selection:** default to correctness/extension-compatibility where dynamic plugins are used. `JIT-off` is a benchmarked *opt-in* only for trusted compiled-in extension sets; dynamic plugins may be much slower when interpreted. AOT image and possible fallback status must be diagnosable.
- **Runtime matrix:** Node reference, existing stock Bun, AOT JIT-on, AOT JIT-off, and a disabled/fallback mode. Binary names/metadata distinguish them; ICE CLI still reports `ice`, no branded `pi` command substituted.
- **Load path:** read settings, apply permission/trust checks, construct ICE runtime, register allowed factories, start TUI/print/RPC exactly once. Static compilation must not evaluate policy/extension factories earlier at build time or grant scope implicitly.

### 4.2 Data/control flow of streaming changes

```text
provider SSE / scripted fixture
       |
raw tool argument delta ---------> append raw buffer, retain exact bytes
       |                                         |
       +--> throttled partial parse (UI only) -> tool render preview
                                                 |
toolcall_end -> full repair/JSON parse -> authoritative type/schema validation
                                           |
                                     normal ICE tool executor
                                           |
                                    persisted result/events
```

```text
text stream -> normalize tabs -> suffix lexer + preserved settled tokens
                                 |            |
                             last 2 blocks    reused earlier blocks
                                 +------------+
                                      |
                         per-block styled render cache
                    (theme, width, transform, capability key)
                                      |
                      existing differential TUI renderer
```

Caches are optional optimization state, **never durable session state**. They must drop cleanly on layout/theme/extension reload and not retain an entire large transcript accidentally.

## 5. Benchmark protocol and artifact schema

Create a runnable scripted-model benchmark without remote APIs or payment. Port only the methodology, not Pi-Bolt's untrusted network/configuration behavior. Fixture generator must be deterministic (seeded) and generate canonical expected results.

### 5.1 Configurations

| ID | Binary/runtime | Purpose |
|---|---|---|
| R0 | ICE Node 24 reference at pinned ICE commit | Functional/source baseline |
| R1 | ICE stock Bun at pinned version | Isolate runtime alone |
| R2 | ICE stock Bun after TypeScript optimizations | Isolate source-level improvements |
| R3 | ICE AOT with JIT enabled | Compatible native comparison for runtime plugins |
| R4 | ICE AOT JIT disabled with allowlisted compiled plugins | Peak native/compiled-plugin measurement |
| X0 | Pi-Bolt 0.7.3 at pinned source or verified release | **External reference**, only minimal comparable fixture |
| R5 | Optional prior ICE artifact from a clean snapshot | Regression baseline if HEAD moves |

Never mix versions inside a reported series. Current Bun 1.3.11 is not the same as Pi-Bolt's stock Bun 1.4.2; either pin/install a controlled Bun 1.4.2 in isolated tooling or report both distinctly. Do not run benchmark suites against a user-configured live endpoint.

### 5.2 Required workload matrix

| ID | Scenario | Primary measurement | Correctness oracle |
|---|---|---|---|
| B01 | `--version` / metadata-only, cold and warm | process wall/CPU, peak memory | version/exit and no network |
| B02 | TUI 100x35 and 140x50 ready-to-type | startup wall/CPU, RSS | editor usable and terminal restored |
| B03 | RPC startup through `get_state`; print/JSONL | wall/CPU | exact response schema and orderly shutdown |
| B04 | 5-turn scripted model (read/grep/edit/write/bash) | process CPU, p50/p95 | file bytes, tool events, exit code |
| B05 | Markdown streams 5k, 20k, 60k chars incl. code/tables/links | CPU/byte, max frame pause, render count | canonical full render vs incremental golden |
| B06 | JSON tool calls 1 KB, 20 KB, 200 KB in varied chunk sizes | parse count/CPU/heap | final exact args, valid partial bounds |
| B07 | Tool `write` 200 KB, `edit` 200 KB, long output 32 MB | wall/CPU/GC/pauses | identical output bytes and capped display |
| B08 | 16.8 MB scanning plugin: compiled/dynamic + JIT toggles | plugin CPU/wall, startup | same count/tool result |
| B09 | 75+ prompts and optional 4.2M synthetic-token session | steady memory, CPU/prompt, GC | session/replay integrity |
| B10 | tmux/PTY stress: paste, typing, abort, resize, overlay, scroll | input latency, idle CPU, screen snapshots | no missing/duplicate lines or input |
| B11 | Subagents V2 foreground/background, approval, worktree patch | launch-to-ready, CPU/child, durability | hash, isolation, cancel, once-only delivery |
| B12 | Offline / cold cache / high extension count / untrusted project | startup and errors | fail-closed and no unauthorized imports |

**Runs:** at least 3 warmups + 21 interleaved measured process runs per short scenario, and 3+ long-session repeats. Randomize/cycle runtime order, isolate temp HOME/`ICE_CODING_AGENT_DIR`, record CPU pinning (Linux `taskset` if allowed), process/OS load, CPU governor/frequency, temperature, filesystem and terminal. Distinguish true cold disk/system page cache from fresh-process warm filesystem cache; do not use privileged `drop_caches`. No side-effecting benchmarks in actual user sessions.

**Raw row schema (proposed):** `{runId, scenario, runtimeId, gitSha, sourceSha, binarySha256, runtimeVersion, flags, cpuModel, osKernel, profileHash, extensionsHash, fixtureHash, seed, warmup, wallMs, cpuUserMs, cpuSystemMs, peakRssBytes, privateDirtyBytes, pauseP95Ms, pauseMaxMs, renderedFrames, bytesWritten, correctness, exitCode}`. Nullable metrics must not be filled with invented zeros.

**Reports:** `.artifacts/ice-pi-bolt/bench/<YYYYMMDD-HHMM>/results.jsonl`, `environment.json`, `summary.md`, flamegraph/perf trace links, golden hashes; final benchmark summary cross-linked from this plan or its companion audit. Keep raw data reproducible.

## 6. Implementation stages (atomic, scored acceptance units)

Each checkbox is one auditable unit. **Do not check any box until implementation and the stated verification pass.** Stages list likely file locations; read actual full files immediately before editing.

### Stage 0 — Reference lock, control group and safety baseline [P0]

- [ ] **S0.1 Record ICE and Pi-Bolt immutable baselines.** Capture ICE HEAD+dirty paths without touching them; pin Pi-Bolt commit, source tree `sources.json`, hashes, Pi baseline, license/third-party notices and toolchain versions. **Target:** `benchmarks/pi-bolt-parity/manifest.json` (new). **Accept:** no “latest” or floating rev in controlled run; complete source inventory. **Verify:** validate manifest hashes and exact refs against read-only upstream; `git status --short` unchanged. **Depends:** none.
- [ ] **S0.2 Build a per-file three-way extraction ledger.** Compare ICE vs Pi-Bolt vs Pi upstream for JSON parser, Markdown lexer/render, TUI timer/scroll, tool-execution renderer, extension loader, binary entry. Classify `direct-adapt / already-present / semantic-conflict / runtime-only / reject` with evidence and license. **Target:** `benchmarks/pi-bolt-parity/port-ledger.md` (new). **Accept:** all intended ports traced to source symbols/commits and ICE tests; no copied package-wide files. **Verify:** review with pinned file links and hashes. **Depends:** S0.1.
- [ ] **S0.3 Implement reproducible offline fixture driver.** Use faux/scripted model and isolated session roots, deterministic timestamps/IDs or explicit normalizer, fixed output bytes, no network. **Target:** `benchmarks/pi-bolt-parity/src/{fixtures,runner,types}.ts` (new, exact layout subject to review), reuse `benchmarks/native-vs-subprocess` conventions. **Accept:** identical fixture inputs and expected artifacts on repeated reference runs; clean cleanup. **Verify:** fixture unit test and two runs with matching manifest+goldens. **Depends:** S0.1.
- [ ] **S0.4 Implement startup/time/CPU/memory collection.** Extend `scripts/profile-coding-agent-node.mjs` or wrap it noninvasively; measure TUI ready, RPC `get_state`, cold/warm process, private dirty/RSS and exit status; use `ICE_TIMING=1` read-only. **Accept:** automated collection across R0/R1, p50/p95 report, non-zero on failed health. **Verify:** offline B01-B03; version/CPU check. **Depends:** S0.3.
- [ ] **S0.5 Implement synthetic render/tool/plugin and PTY benchmarks.** B04-B12 with size/chunk/control variations and a golden comparator; no shared user environment writes. **Accept:** every run has correctness verdict and checksum, failure case is demonstrably detected. **Verify:** seeded runs and injected bad-output fixture. **Depends:** S0.3.
- [ ] **S0.6 Execute and archive clean R0/R1 baseline.** Build only when implementation is explicitly authorized under `AGENTS.md`; run Node and stock Bun on same CPU/fixtures in interleaved order; capture current installed Bun and a pinned comparable Bun. **Accept:** real measured baseline table, variance/noise, no paid calls. **Verify:** B01-B12 applicable + artifacts + `git status`. **Depends:** S0.4-S0.5.
- [ ] **S0.7 Freeze correctness/feature parity matrix.** Write executable or manual assertions for TUI, print, JSONL, RPC, SDK, extensions, project trust, V2 subagents, sessions, providers, cancellation and Curax packaging boundary. **Target:** `benchmarks/pi-bolt-parity/parity-matrix.md`. **Accept:** each mandatory invariant mapped to test/oracle; no “looks fine” item. **Verify:** test discovery and baseline checks. **Depends:** S0.3.

**Gate 0:** no performance implementation until at least B01-B06 and key parity oracles are credible. Do not base source changes on Pi-Bolt marketing numbers.

### Stage 1 — Port Pi-Bolt's bounded streaming JSON path [P0]

- [ ] **S1.1 Add upstream-style cheap JSON repair.** Adapt `Pi-Bolt packages/ai/src/utils/json-parse.ts:28-75` unchanged-run copying to ICE `packages/ai/src/utils/json-parse.ts:1-95`; preserve malformed escape handling and control-character semantics. **Accept:** valid strings avoid per-character output appends; same repair/failure outcomes. **Verify:** add targeted valid, invalid escape, Unicode, partial surrogate, control-character tests + B06. **Depends:** S0.2,S0.6.
- [ ] **S1.2 Add streaming-only parse throttle.** Introduce a named `parseStreamingJsonWhileStreaming(block, raw, current)`-equivalent with identity-safe `WeakMap`; for short args show each update; for large args update at controlled growth intervals, full parse on completion. **Accept:** partial preview may lag but final arguments never do; unchanged object identity when skipped; bounded cache. **Verify:** B06 parse counts and chunk-boundary correctness tests. **Depends:** S1.1.
- [ ] **S1.3 Thread parser through all provider adapters.** Audit ICE `anthropic-messages.ts`, `openai-completions.ts`, `openai-responses-shared.ts`, `bedrock-converse-stream.ts` and any other `parseStreamingJson` call sites; use sampling only for *partial tool-call events*, not final execution. **Accept:** each `toolcall_end` uses complete authoritative parse; no tool-id/usage/stream event drift. **Verify:** existing `packages/ai/test/*tool*.test.ts` and targeted e2e-faux cases; B04/B06/B07. **Depends:** S1.2.
- [ ] **S1.4 Preserve proxy/agent path.** Audit `packages/agent/src/proxy.ts:331-336` and provider-independent update handling. **Accept:** consistent partial/final semantics through native/proxy transports; no double stale arguments. **Verify:** focused agent-core stream/proxy tests and B06. **Depends:** S1.3.
- [ ] **S1.5 Avoid unnecessary tool-row recalculation.** Add/reference-identity guard to `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` only if the current update path lacks it; immutable/copy-on-write final args must re-render. **Accept:** large tool argument previews don't repeatedly run costly renderers for the same object; final/expanded result remains accurate. **Verify:** unit render-count spy, write/edit/line wrap goldens, B07. **Depends:** S1.3.
- [ ] **S1.6 Validate bounds and adversarial input.** Test escaped backslashes, unterminated strings, multi-byte text, huge arrays, 1-byte chunk sizes, malformed terminal payloads, same object with mutable properties, interrupted/discarded tool calls. **Accept:** no skipped **final** validation; no unsafe tool execution; memory/CPU bounded under malicious partial streams. **Verify:** faux-provider fixtures and B06 failure matrix. **Depends:** S1.3-S1.5.
- [ ] **S1.7 Record stage-specific benchmark and behavior delta.** Compare R0/R1 pre/post with identical fixtures and checked outputs. **Accept:** justified adoption if meaningful improvement; otherwise revert only this port, retain evidence. **Verify:** B04/B06/B07, focused package tests, `npm run check` per repository instructions when code changed (no full `npm test`). **Depends:** S1.6.

**Gate 1:** exact final tool bytes and permissions match. Only UI partial updates may be throttled; never change live tool execution semantics for speed.

### Stage 2 — Port incremental Markdown lexing and rendered-block reuse [P0]

- [ ] **S2.1 Build a canonical Markdown/appearance golden suite.** Extend `packages/tui/test/markdown.test.ts`, `tui-render.test.ts` and relevant coding-agent presentation tests with streams of 1-char, 4-char, 32-char and large chunks; include links defined later, code fences, lists, blockquotes, tables, inline ANSI, tabs, CRLF, Unicode/CJK, images, hidden thinking, OSC133, theme switch and extension transforms. **Accept:** uncached full render is a deterministic oracle. **Verify:** golden fixtures before optimization. **Depends:** S0.5.
- [ ] **S2.2 Port bounded suffix lexer with fallback.** Adapt Pi-Bolt `lexAddedMarkdown`/`lexMarkdown` (`packages/tui/src/components/markdown.ts:175-297`) to ICE's Marked tokenizer and markdown transform pipeline. Retain last two unsettled blocks; full reparse when link definitions, non-append edits, token length or extension behavior makes reuse unsafe. **Accept:** tokens equivalent to complete relex for all fixtures. **Verify:** randomized append equivalence/fuzz + S2.1. **Depends:** S2.1,S0.2.
- [ ] **S2.3 Prevent substring retention and cache leaks.** Copy suffix-only strings before lexing; cap recent lexer/tab-normalization caches (Pi-Bolt keeps 8 recent lexes/4 tab values); use weak references where appropriate; account for GC and session/tab closure. **Accept:** heap memory stabilizes after large streamed answers and GC, no long answer retained via a tiny token. **Verify:** B05/B09, memory/GC pressure test. **Depends:** S2.2.
- [ ] **S2.4 Introduce correct rendered-block cache.** Port Pi-Bolt block keying and `rendered-markdown` generation, including width, padding, theme identity, styles, following token type, capabilities and ICE-specific Markdown options. **Accept:** stable blocks are not rerendered per chunk, and all style/width changes re-render affected blocks. **Verify:** render-count spy, golden parity vs cache-disabled mode. **Depends:** S2.2.
- [ ] **S2.5 Integrate ICE theme/transform invalidation.** Audit `components/markdown-transform.ts`, `appearance/*`, `theme/theme.ts`, `assistant-message.ts` and image capability changes; make transform output and theme generation part of cache keys or bypass reuse when the transform is non-deterministic. **Accept:** /appearance previews, theme picker, inline Markdown transformers and streaming outputs remain live/correct; no stale ANSI colors. **Verify:** focused appearance/Markdown snapshot tests and manual TUI preview. **Depends:** S2.4.
- [ ] **S2.6 Address assistant component rebuilding.** `AssistantMessageComponent.updateContent` currently clears/rebuilds child components (`assistant-message.ts:164-185`). Preserve/reuse stable Markdown component instances or rely on shared token caches only after testing identity/lifecycle; retain bullet, tool position, thinking and OSC133. **Accept:** large streams avoid redoing completed blocks; no wrong message ordering or duplicated zones. **Verify:** component lifecycle tests, B05/TUI B10. **Depends:** S2.4,S2.5.
- [ ] **S2.7 Test cache invalidation under concurrency.** Simultaneous child streams, theme switching, resize, sessions switching, extension reload, Markdown links introduced late and scrolling must not cross-contaminate tokens or static caches. **Accept:** golden parity and bounded memory in every case. **Verify:** injected stream/interleave tests, B05/B09/B11. **Depends:** S2.5-S2.6.
- [ ] **S2.8 Demonstrate measured complexity improvement.** Compare render CPU/character, maximum input pause and memory for 5k/20k/60k streams; verify no length-proportional per-chunk blowup in the intended stable-block case. **Accept:** meaningful measured gain and no correctness regression. **Verify:** B05/B09/Stage 2 report. **Depends:** S2.7.

**Gate 2:** full Markdown parity > superficial speed. Revert only the incremental cache if late link definitions, customized appearance or transforms cannot be handled safely.

### Stage 3 — Terminal/UI rendering, large output and responsiveness [P0/P1]

- [ ] **S3.1 Attribute CPU before changing `tui.ts`.** Instrument render scheduling, layout, parsing, ANSI wrapping, writing, scrolling, tool preview formatting and GC at low sampling overhead; inspect `packages/tui/src/{tui,tui-main-screen,tui-alt-screen,utils}.ts`. **Accept:** per-category flamegraph/CPU table for B05/B07/B10. **Verify:** profiler trace, no production timing overhead by default. **Depends:** S0.6,S2.8.
- [ ] **S3.2 Review Pi-Bolt's immediate-render scheduling change.** Compare `tui.ts:985-1042` upstream to ICE `tui.ts:787-815` and screen-mode implementation. Port timer-cancellation priority only where ICE exhibits measurable input latency; preserve existing min-frame throttle. **Accept:** fast typing/Escape/resize, bounded streamed CPU. **Verify:** B10 latency and `packages/tui/test/tui-render.test.ts`. **Depends:** S3.1.
- [ ] **S3.3 Cache expensive visible-width/wrapping work.** Identify hot `visibleWidth`, `wrapTextWithAnsi`, syntax highlighting and line flattening; apply cache or loop-level optimization only when flamegraph confirms dominance. **Accept:** no terminal corruption for combining marks, regional indicators, OSC8 links, emoji or background/ANSI styling. **Verify:** `packages/tui/test/{wrap-ansi,truncate-to-width,regression-regional-indicator-width}.test.ts`, B05/B10. **Depends:** S3.1.
- [ ] **S3.4 Optimize large tool output display.** Prevent 32 MB streaming logs and 200 KB code/file previews from forcing full transcript/layout processing each delta; cap live projection, retain full output artifact and correct expansion behavior. **Accept:** unchanged persisted/tool results and no excessive max frame pause. **Verify:** B07 and expansion/collapse correctness. **Depends:** S1.5,S3.1.
- [ ] **S3.5 Evaluate scroll-region fast path only with goldens.** If main/fullscreen screen differ or large sessions pause, assess Pi-Bolt's row scrolling/partial redraws as a separately gated option; do not introduce escape-sequence hacks without tmux/terminal parity. **Accept:** screen text/ANSI/glyph positions identical after resize/scroll; fallback switch available. **Verify:** `tui-alt-screen`/`tui-shrink`/`tui-overlay-*` tests and B10. **Depends:** S3.2.
- [ ] **S3.6 Preserve ongoing ICE UI work.** Do not overwrite changes to `interactive-mode.ts`, `session-header.ts` or new-messages-pill; reconcile via minimal edits after new status review. **Accept:** all pre-existing UI feature tests pass and unrelated dirty hunks unchanged. **Verify:** diff against initial dirty snapshot and focused coding-agent tests. **Depends:** S3.2-S3.5.
- [ ] **S3.7 Benchmark pause and interaction distribution.** Capture p50/p95 keyboard latency, frame pause max, streaming CPU and idle CPU; reject a gain achieved by dropping visible output or starving UI events. **Accept:** stage-specific report with correctness. **Verify:** B05/B07/B10 + regressions. **Depends:** S3.6.

### Stage 4 — Startup, resource loading and runtime-independent plugin optimization [P1]

- [ ] **S4.1 Trace critical startup path without policy changes.** Instrument `ice.ts`, `main.ts:519-816,890-900`, `agent-session-services.ts`, `core/resource-loader.ts`, `core/extensions/loader.ts` and built-in ICE extension factories, including observability DB setup. **Accept:** timed breakdown with startup p50/p95 for minimal vs real trusted profile. **Verify:** `ICE_TIMING=1` + profiler B01-B03/B12. **Depends:** S0.6.
- [ ] **S4.2 Separate inexpensive registration from expensive activation.** Identify optional side effects in extension factories (Cognee, MCP/provider adapters, observability, highlighter, skill scans) and defer only when correctness allows; do not silently drop events or initial permissions. **Accept:** identical first-use and shutdown behavior, fail-closed trust, no startup network requirement. **Verify:** extension lifecycle tests, B01-B03/B12, closed network fixture. **Depends:** S4.1.
- [ ] **S4.3 Preserve trust-sensitive two-stage loading.** Maintain `DefaultResourceLoader.loadProjectTrustExtensions/reload` distinction; cache by canonical resolved path, permissions/trust and version where needed; never parallelize handlers with observable ordered side effects. **Accept:** malicious project source cannot execute before trust, no warmed cache across revoked grants. **Verify:** project-trust tests and untrusted/changed-resource B12. **Depends:** S4.1.
- [ ] **S4.4 Introduce optional trusted prebuilt extension-factory manifest.** Use `MainOptions.extensionFactories` (`main.ts:511-522`) and `InlineExtension` metadata with explicit allowlist; prevent source/package duplication against runtime-discovered extensions. **Accept:** deterministic factory order/priority, hidden/visible semantics, no duplicate tool/command registration. **Verify:** extension registry/reload/command tests and B08/B12. **Depends:** S4.3.
- [ ] **S4.5 Make dynamic extension path performant without reducing trust.** Assess jiti transform cache (`core/extensions/loader.ts`) and extension module initialization; compare runtime-loaded plugin on stock Bun, AOT JIT-on and JIT-off and document that JIT-off interpreted hot loops may be much slower. **Accept:** honest capability/performance diagnostics, no global silent JIT-off default for dynamic extension users. **Verify:** B08/B12. **Depends:** S4.4.
- [ ] **S4.6 Baseline startup optimization results.** Retain changes only with measured startup gain and no run/session regression; compare minimal/real-profile footprints. **Accept:** attribution supports every kept change. **Verify:** B01-B04/B08/B12 + focused tests. **Depends:** S4.2-S4.5.

### Stage 5 — Stock Bun compatibility baseline and packaging seam [P1]

- [ ] **S5.1 Build an isolated reproducible stock Bun ICE executable.** Use existing `packages/coding-agent/src/bun/cli.ts` and `package.json:35-40` worker path; stage metadata, themes, export templates, wasm, terminal native helpers and licenses into a new temp/output directory. **Accept:** no source-tree deletion/overwriting, correct CLI behavior. **Verify:** `--help`/`--version`/`--list-models`, offline print/RPC, TUI smoke; compare file assets. **Depends:** S0.6.
- [ ] **S5.2 Validate dynamic Bun imports and workers.** `src/bun/cli.ts:10-15` uses literal dynamic imports for Bedrock and ICE startup; inspect lazy provider imports, `image-resize-worker.ts`, worktree child tool workers and native addons. **Accept:** Bun's compiled package resolves them and matches Node outputs; broken features documented rather than silently removed. **Verify:** package smoke and targeted provider/worker tests. **Depends:** S5.1.
- [ ] **S5.3 Validate six-platform legacy release contract.** Confirm `scripts/build-binaries.sh` targets macOS x64/arm64, Linux x64/arm64, Windows x64/arm64; AOT-specific flags never bleed into unsupported targets. **Accept:** no existing platform/package name regression. **Verify:** packaging manifest lint, release-local smoke when implementation explicitly authorized. **Depends:** S5.1.
- [ ] **S5.4 Freeze standalone entry and packaging manifest.** Define a stable ICE entry (not Pi-Bolt's `pi`), runtime worker entries, asset metadata, and executable hash provenance suitable for Stage 6. **Accept:** stock Bun provides functional control executable for AOT comparison from same `dist`. **Verify:** offline R1/R2 repeat with SHA/fixture agreement. **Depends:** S5.1-S5.3.
- [ ] **S5.5 Publish source-level comparison report (locally only).** Compare Node and stock Bun ICE before AOT, including early startup/streaming after Stages 1-4; identify where TypeScript fixes already deliver gains. **Accept:** justified go/no-go for costly native AOT. **Verify:** B01-B12 representative + correctness. **Depends:** S1.7,S2.8,S3.7,S4.6,S5.4.

### Stage 6 — Native Pi-Bolt AOT engine proof of concept [P2; high cost/high risk]

- [ ] **S6.1 Establish isolated external-source provenance.** Obtain Pi-Bolt at pinned commit into a read-only or agent-owned reference directory outside ICE; verify `sources.json` and `patches/*.patch` hashes, source license/third-party notices, and release runtime identity. Do **not** silently track external runtime forks inside ICE. **Accept:** SHA-locked reproducible ledger and approved provenance. **Verify:** clean commit/hash comparison, reference unchanged. **Depends:** S0.1,S5.5.
- [ ] **S6.2 Decide runtime acquisition track.** First test an official pinned, verified Pi-Bolt runtime artifact **if** supplied/available with proven integrity; otherwise independently build pinned WebKit+Bun in a disposable directory with `scripts/fetch-sources.sh` and `build-runtime.sh` from the reference. Check Linux 32 GB RAM/~40 GB disk toolchain requirement and artifacts. **Accept:** recorded precise source/toolchain/runtime hashes, no unsigned opaque production binary assumption. **Verify:** pinned artifact identity; engine test command and metadata. **Depends:** S6.1.
- [ ] **S6.3 Introduce ICE-native AOT build adapter.** Adapt `scripts/build-pi.sh` flags to ICE entry/assets/worker set; use patched runtime, `--compile --bytecode`, `BUN_STATIC_HEAP=1`, `BUN_AOT=1` and variant flags; never reuse destructive shared-output `rm -rf` behavior. Build in `.artifacts` or unique temp staging. **Accept:** optional binary named ICE, no global install/replacement, normal stock Bun remains untouched. **Verify:** hash/metadata and smoke `--version`; run compile command only once authorized. **Depends:** S5.4,S6.2.
- [ ] **S6.4 Prove AOT image registration and explicit fallback.** Test `BUN_STATIC_HEAP_VERBOSE=1` and require `image registered: true` for an **AOT benchmark**; detect engine stamp/CPU feature mismatch or address-space fallback and label fallback runs as non-AOT. **Accept:** no false positive “AOT fast” measurement from silently interpreted bytecode. **Verify:** deliberately forced `BUN_AOT=0`/wrong variant test + manifest field. **Depends:** S6.3.
- [ ] **S6.5 Check snapshot initialization and credential isolation.** Confirm only module state eligible for static heap capture; no user settings, provider keys, workspace paths, project trust or session data baked into executable; source import and build-time environment sanitization. **Accept:** reproducible binary insensitive to host auth state; no credentials in strings/assets/traces. **Verify:** build in isolated empty HOME/env; secret-canary scan; external settings smoke. **Depends:** S6.3.
- [ ] **S6.6 Prove native module/worker compatibility.** Test `@zykairotis/ice-clipboard`, Photon WASM, terminal native helpers, SQLite store, child process/spawn, `node:` APIs, file permissions, worker entry resolution and Ctrl-C/abort. Avoid assuming Pi-Bolt's paths match ICE. **Accept:** same outputs and no native crashes/resource leaks vs stock Bun; any exceptions documented and AOT disabled for unsupported cases. **Verify:** targeted smoke, B04/B07/B10/B11, error/cleanup tests. **Depends:** S6.4.
- [ ] **S6.7 Check JSC immutable-intrinsic/prototype assumptions.** Run JIT-on/off variants with user extensions and ICE's theme/highlighter; Pi-Bolt defaults `BUN_JSC_useImmutableIntrinsics=1` which may reject monkeypatches of built-in prototypes. **Accept:** compatible configs work or fall back safely; no silent changed object semantics. **Verify:** compatibility tests and deliberate prototype-overwrite fixture. **Depends:** S6.4.
- [ ] **S6.8 Train ICE-specific AOT profiles.** Adapt Pi-Bolt `train-profile.sh`/`train_session.py` to ICE's actual built entry and scripted interactions; capture `bytecode.order`, `regexps.txt` and use an independent profile for compiled extensions. Cover startup, autocomplete, Markdown fences/highlighter, tool previews, theme switch, RPC, subagent view. **Accept:** deterministic locally generated profiles with no secrets; trained/untuned delta measured. **Verify:** compare profile file hashes, AOT image status, B01/B05/B10. **Depends:** S6.6.
- [ ] **S6.9 Differential engine/runtime validation.** Reuse or adapt Pi-Bolt `tests/aot/run.sh`, targeted fuzzing and `tests/runtime/run.sh` alongside ICE faux-provider tests; rerun no-JIT/JIT and baseline CPU variants. **Accept:** observed engine output equivalent to stock Bun for all supported semantic tests; external unrelated failures isolated with evidence, never silently waived. **Verify:** engine + runtime logs, error/abort/GC/worker coverage. **Depends:** S6.6-S6.8.
- [ ] **S6.10 Publish AOT prototype result and go/no-go.** Compare R2/R3/R4 same ICE source + fixtures, record binary size, cold/warm startup, CPU/GC/memory, program pause, fallback rate, build time, licensing and portability. **Accept:** keep as opt-in only if measurable net value and no correctness gap. **Verify:** B01-B12, parity matrix and report. **Depends:** S6.4-S6.9.

**Gate 6:** if AOT image registration, provenance, correctness or feature parity fails, stop AOT rollout. Keep Stages 1-5 source optimizations; retain Node/stock Bun as supported distribution. Do not “fix” compiler correctness by weakening ICE permissions/tests.

### Stage 7 — Compiled-in plugin profile without losing dynamic extensibility [P2]

- [ ] **S7.1 Define signed/hashed trusted plugin allowlist.** A manifest is built from explicit extension factory modules, not an ambient walk of `~/.ice` or project directories. Pin source hashes and first-party package imports; no untrusted build-time module execution without consent. **Target:** `scripts/native-aot/plugins-manifest` or a generated module in owned staging. **Accept:** same factory APIs and user-visible behavior. **Verify:** allowlist tests and staging inspection. **Depends:** S4.4,S6.10.
- [ ] **S7.2 Map ICE factory/priority semantics to binary entry.** Pi-Bolt's `--plugins` entry feeds `main({extensionFactories})`; ICE already feeds built-ins from `ice.ts:99-128`. Merge manifests without double registering built-in `ice-safe-verify`, `ice-cognee`, or V2. **Accept:** exactly-once tool/command registration, correct before-user order, project trust intact. **Verify:** instrument factory count, command collisions, extension tests. **Depends:** S7.1.
- [ ] **S7.3 Bundle plugin assets/workers correctly.** Statically resolvable imports, peer-only ICE packages, literal worker paths, embedded images/text/WASM/native files; audit `import.meta.dir`, dynamic `require` and second package copy pitfalls. **Accept:** compiled plugins behave identically to dynamic ones in temporary sandboxed/test scope. **Verify:** plugin smoke and B08. **Depends:** S7.2.
- [ ] **S7.4 Provide JIT-on dynamic plugin fallback and diagnostics.** Runtime extensions remain possible, and JIT-off mode warns about interpreted hot loops. AOT-off and JIT-on paths stay first-class; plugin source changes require rebuild only for explicitly compiled-in plugins. **Accept:** no unexplained plugin performance cliff or import break. **Verify:** B08 all loader combinations. **Depends:** S7.2.
- [ ] **S7.5 Prevent duplicate registry and stale build manifests.** Compare manifest identity to package/user-installed runtime extension IDs; avoid duplicate tools, prompts, slash commands; avoid stale allowlist after extension updates/revoked trust. **Accept:** deterministic conflict error or explicit configured precedence; never double-execute hooks. **Verify:** repeat registration/reload/revoke tests. **Depends:** S7.3-S7.4.
- [ ] **S7.6 Measure plugin profiles and pin release manifests.** Compare compiled-in vs runtime JIT-on/off, startup and 16.8 MB hot-loop workload; publish extension-by-extension performance and any incompatible ones. **Accept:** no claimed universal 24x improvement; measured gains valid on ICE. **Verify:** B08/B12 + golden plugin result. **Depends:** S7.5.

### Stage 8 — Subagents, persistence, transport and trust regression campaign [P2]

- [ ] **S8.1 Verify V2 child behavior under all supported runtimes.** Compare native child `AgentSession` factory, parent model routing and frozen tool set (`subagents/v2/session-factory.ts:115-172`). **Accept:** identical child final-answer/artifact/usage, no new subprocess requirement. **Verify:** V2 faux-provider suite and B11. **Depends:** S6.10.
- [ ] **S8.2 Verify permission/approval monotonicity.** Run parent/build/plan/review/unsafe/approval tests, explicit allow/deny, runtime plugin and child tool callbacks. **Accept:** child <= parent authority, no headless approval grants, project untrusted remains blocked. **Verify:** permission/authority tests plus B12. **Depends:** S7.5.
- [ ] **S8.3 Verify V2 durable registry and restart/recovery.** Cover worktree baseline snapshots/patch hashes, interrupted runs, tombstones, once-only completion messages, timeout/cancel, output artifacts and resume under frozen contract. **Accept:** no replay of ambiguous non-idempotent tools or loss of staged/unstaged parent state. **Verify:** V2 registry/worktree/restore regression suite, B11 with crashes. **Depends:** S8.1.
- [ ] **S8.4 Verify session/compaction/storage parity.** Compare Node/stock Bun/AOT storage and export, SQLite, JSONL compatibility, ordering and compaction; include long transcript and corrupt-file failure paths. **Accept:** no migration required for existing sessions or undocumented format change. **Verify:** coding-agent/session and storage tests, B09. **Depends:** S6.6.
- [ ] **S8.5 Verify API/CLI interface parity.** Print, JSONL, SDK, RPC session/agent management, terminal signal handling, stdin/stdout framing, model auth metadata, provider retry and no-network commands. **Accept:** identical serialized API contracts and help/version behavior. **Verify:** focused SDK/RPC/CLI tests, B01-B04. **Depends:** S6.6.
- [ ] **S8.6 Verify real-terminal fidelity.** Main and fullscreen, tmux, TTY trust prompts, markdown themes, appearance previews, image/fallback, scrolling, line editing/pasting, resize and Escape. **Accept:** no lost keystrokes, corrupted ANSI/OSC or blank screen; byte/screen goldens where stable. **Verify:** PTY B10 and `packages/tui/test` suites. **Depends:** S3.7,S6.6.
- [ ] **S8.7 Run bounded adversarial failure campaign.** Truncated stream, malformed JSON, 32 MB output, SIGTERM/SIGINT, no-network, unauthorized extension, GC pressure, failed compilation/engine fallback and corrupted training profile. **Accept:** deterministic errors, resource cleanup and preserved data. **Verify:** failure matrix and nonzero expected-error assertions. **Depends:** S8.1-S8.6.

### Stage 9 — Performance qualification, tuning and portability [P2]

- [ ] **S9.1 Run head-to-head controlled matrix.** Interleave R0-R4; include Pi-Bolt X0 only for comparable minimal workload, explicit feature/profile/version caveats. **Accept:** raw artifact-backed p50/p95 CPU/wall/memory, not copied upstream figures. **Verify:** B01-B12 suite/report. **Depends:** S8.7.
- [ ] **S9.2 Tune AOT hot loops / code layout only with evidence.** Compare loop-splitting on/off, JIT on/off, immutable intrinsics, profile-guided regex and bytecode ordering; do not globally rewrite idiomatic code just to fit compiler patterns. **Accept:** every flag change has benchmark/perf benefit and test pass. **Verify:** focused B05-B09 and engine differential tests. **Depends:** S9.1.
- [ ] **S9.3 Bound long-session memory and CPU floors.** Run 75+ and optionally 600-prompt soak; attribute GC, token cache, streaming tool buffers, extension caches, observability DB; measure memory **floor** after GC not only peaks. **Accept:** stable or documented bounded memory trend, no leaks/regressions. **Verify:** B09 repeated time-series. **Depends:** S9.2.
- [ ] **S9.4 Test CPU/OS/architecture fallback.** Linux x86-64 AVX2/native vs baseline CPU, supported glibc policy, dynamic plugin JIT modes and missing runtime path; optionally macOS arm64 independently. Unsupported Windows/ARM retains original binaries. **Accept:** clear fallback notice and honest binary metadata, no crash on unsupported CPU. **Verify:** available qemu/container smoke and build matrix, no fabricated cross-platform “pass”. **Depends:** S9.1.
- [ ] **S9.5 Decide production scope on measured results.** Record per-scenario speedups, confidence intervals/noise, cost of maintaining Pi-Bolt native patches, binary size/build toolchain, compatibility exceptions and whether performance targets are met. **Accept:** explicit `GO / EXPERIMENTAL / REJECT` per runtime variant with evidence. **Verify:** reviewer-approved report. **Depends:** S9.1-S9.4.

### Stage 10 — Docs, provenance, release and rollback gates [P2]

- [ ] **S10.1 Document source-level extraction and provenance.** For every reused Pi-Bolt file/hunk: upstream URL, pinned commit, file/line, transformation, local target, test; record MIT notices. For native runtime: exact WebKit/Bun patch, toolchain, license obligations and source availability. **Accept:** traceable code pedigree. **Verify:** attribution audit. **Depends:** S9.5.
- [ ] **S10.2 Document runtime/plugin configuration and honest limitations.** Distinguish Node/stock Bun/AOT JIT-on/AOT JIT-off; plugin compile manifests, rebuild requirements, workers/native assets, platform availability, fallback/`image registered` diagnostics, trust/safety rules. **Accept:** user can choose compatibility vs high performance without hidden feature loss. **Verify:** reproduction from a clean test HOME. **Depends:** S7.6,S9.5.
- [ ] **S10.3 Add non-destructive release smoke and rollback controls.** Keep existing Node/Bun output and Curax snapshot pipeline; use isolated native artifacts and manifest hashes; operator can choose prior stable executable without session format migration. **Accept:** rollback tested after simulated bad native build; no Curax/current.json update. **Verify:** dry-run packaging + stable runtime launch. **Depends:** S9.5.
- [ ] **S10.4 Run final scoped tests and code checks.** Run package-specific Vitest using repo rule `node ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts` from each affected package; after code changes `corepack npm@12.0.2 run check` (or matching repo policy), and only approved broader scripted checks. No unrequested full `npm test` or release. **Accept:** commands/output/exit statuses recorded, no unexpected dirty changes. **Verify:** logs and `git status --short`. **Depends:** S10.1-S10.3.
- [ ] **S10.5 Final audit and handoff.** Create companion `Plan/ice-pi-bolt-performance-port-audit.md` with full task ledger, measured before/after, failures/waivers, fix queue and release verdict; update this plan's status only as supported. **Accept:** another agent can reproduce/review without this chat. **Verify:** ledger covers all S0-S10 leaf tasks, raw artifacts linked. **Depends:** S10.4.
- [ ] **S10.6 Explicit approval gate for deployment.** No tagging, merging, publishing, replacing `~/.local/bin/ice` or Curax snapshot until user asks and reviews AOT results/licensing. **Accept:** normal ICE remains installed and runnable after the evaluation. **Verify:** executable fingerprints and manifests unchanged until approval. **Depends:** S10.5.

## 7. Dependency graph and parallel work

```text
S0  reference+bench foundation
  |\
  | +--> S1 streamed JSON -------+
  | +--> S2 Markdown ----------+ |
  | +--> S4 startup/plugins --+ | |
  | +--> S5 Bun baseline -----+ | |
  |                            v v v
  +---------------------------> S3 TUI (coordinates with S1/S2)
                                |
                          S5 go/no-go
                                |
                              S6 AOT
                               / \
                       S7 plugins S8 core regressions
                               \ /
                             S9 perf qualification
                                |
                            S10 release gates
```

- **Safe parallel:** S1 JSON and S2 Markdown in separate reviewed lanes after S0. S4 can profile startup concurrently with S2 as long as it does not edit shared session/resource-loader boundaries. S6 reference/toolchain inspection can occur read-only while S1/S2 run, but no AOT build conclusion before S5.
- **Serialize shared files:** `src/ice.ts`, `src/main.ts`, `core/resource-loader.ts`, `core/extensions/loader.ts`, `tui.ts` and especially already-dirty `interactive-mode.ts`. Assign a single owner per file and revalidate HEAD/diff before each edit.
- **No runtime-vendor merge:** keep reference source read-only. Port small isolated changes with explicit licenses; build runtime in an artifact/temp workspace; never import Pi-Bolt's `packages/` wholesale into ICE.
- **Highest ROI first:** S1, S2, S3, S4. AOT S6-S9 is expensive and should be canceled if same-source stock Bun already meets useful workload goals or engine compatibility fails.
- **One original source of truth:** this plan; benchmark fixtures and audit artifacts link to it. Avoid creating a competing “harness” inside ICE.

## 8. Verification matrix and example execution commands

Commands below are for the future implementation agent **after authorization**, not commands run while writing this plan. Update paths if test files differ at implementation time. Run only on an isolated fixture HOME, without real provider secrets.

| Scope | Verification | Gate |
|---|---|---|
| JSON/streaming | `cd packages/ai && node ../../node_modules/vitest/dist/cli.js --run test/openai-responses-partial-json-cleanup.test.ts`; new `json-stream-performance.test.ts` | Full final JSON/event fidelity + preview bound |
| Markdown | `cd packages/tui && node ../../node_modules/vitest/dist/cli.js --run test/markdown.test.ts test/tui-render.test.ts` + new cached-vs-full oracle | Render text/ANSI/parsing equivalent |
| Terminal | `cd packages/tui && node ../../node_modules/vitest/dist/cli.js --run test/tui-alt-screen.test.ts test/tui-shrink.test.ts`; PTY/tmux benchmark | Correct screen, responsive input |
| ICE presentation | targeted coding-agent assistant/tool/theme/appearance tests discovered at stage start | Custom UI/OSC and extension hook parity |
| Extensions/trust | targeted `packages/coding-agent/test/*extension*` / trust / project scope tests | Exactly-once registration and fail-closed grants |
| Subagents V2 | targeted `packages/coding-agent/test/subagents-v2-*.test.ts` and `test/suite` faux-provider harness | Durable once-only, no widened authority |
| Sessions/RPC | focused coding-agent RPC/session tests and storage SQLite tests | Persist/replay/formats parity |
| Source hygiene | `corepack npm@12.0.2 run check` after code changes; review output (note: root check includes formatting writes) | No typecheck/dependency break |
| Runtime AOT | Pi-Bolt pinned `tests/aot/run.sh`, `tests/runtime/run.sh`, ICE differential smokes, image registration | Explicit correct native AOT image |
| Performance | benchmark suite R0-R4, optional X0, 3+ warmups/21 runs, 3+ long runs | Attributable p50/p95 evidence |
| Packaging | offline Node/Bun/local-release smoke; native asset/worker/license listing; platform fallback | Reversible, no silent platform loss |
| Repository cleanliness | `git status --short` / `git diff --name-only`, compare initial dirty paths | No unrelated clobber, no surprise release |

### Manual security/compatibility scenarios that must not be skipped

1. Untrusted project ships a malicious `.ice/extensions` plugin and an agent definition; launch metadata-only, interactive, RPC and AOT and assert it is not executed before project trust.
2. JIT-off AOT with a dynamic plugin doing a hot loop: show performance falloff or actionable diagnostic; JIT-on remains available.
3. Compiled and runtime copies of the same plugin: one deterministic conflict path, never twice-active tool/hook.
4. Change theme, text styling, terminal size and Markdown transformer mid-stream: no stale block cache and no incorrect reuse across child view/session.
5. A 200 KB `write` argument arriving as hundreds of tiny chunks, including escaped JSON and multiline Unicode: final file equals the fixture **byte-for-byte**.
6. Model stream cancelled just before tool call finishes: no partial parsed arguments executed, no last incomplete record silently transformed into a valid operation.
7. Kill ICE between durable child acceptance and first tool; restart; no unauthorized replay and no loss of parent dirty worktree.
8. Wrong AOT CPU features/engine stamp, missing native asset, unsupported architecture: visible status and safe fallback instead of silent measurement contamination.
9. Source/binary scans with canary secrets in environment during *runtime*, not during build: no canary embedded in static image or profile output.
10. Offline flags and `--version`/`--help`/`--list-models` do not send network calls or overwrite model metadata.

## 9. Risk register and rollback

| Risk | Likelihood/impact | Mitigation | Rollback/stop |
|---|---|---|---|
| Pinned engine patch diverges from current Bun | High / high | Exact `sources.json` pin + standalone runtime build first | Stop S6; retain stock Bun |
| AOT snapshot bundles incompatible native addons/workers | Medium-high / high | Stage-6 compatibility matrix and asset staging | Disable AOT for affected profile; no user-data migration |
| JIT-off dynamic extensions interpreted slowly | High / medium | Only allow JIT-off for built-in trusted plugins and surface diagnostics | Ship JIT-on/native or stock Bun |
| Plugin bundling bypasses trust or duplicates hooks | Medium / critical | Explicit allowlist, precedence semantics and fail-closed tests | Disable compiled plugin manifest, keep loader |
| Wrong partial tool args execute | Medium / critical | UI-only sampling, full final authoritative parse, typed executor | Revert S1 implementation immediately |
| Incremental Markdown changes rendered meaning | Medium / high | Full-render oracle, conservative fallback and cache invalidation | Turn off suffix/block cache |
| Long session retains old full strings/tokens | Medium / high | Detached suffixes, weak refs, bounded caches, heap floor test | Disable offending cache |
| UI changes overwrite live concurrent work | High / high | File ownership and initial git diff ledger | Restore only owned hunks, never reset hard |
| Binary benchmark silently falls back to bytecode | Medium / high | Mandatory AOT registration diagnostic and invalid-run status | Reject benchmark as AOT evidence |
| False parity against different Pi/ICE versions | High / medium | Same-source R0-R4; X0 reference only matched minimal fixture | Do not claim parity |
| CPU-specific native code crashes on other hosts | Medium / high | native vs baseline CPU variants and compatibility matrix | Fall back to standard Node/Bun |
| Build leaks auth/config into static heap | Medium / critical | Sanitized build HOME/env and canary search | Destroy suspect artifact, rebuild in clean env |
| LGPL/third-party redistribution obligations missed | Medium / high | Review full runtime notices/source-offer obligations before release | Keep local experimental only |
| Scope creep into subagents/provider routing | Medium / high | Explicit non-goals and stage-owned file set | Stop change and reopen design review |

**Rollback principle:** code-only optimizations are independently reversible by reverting just their owned hunks; native AOT is a separate artifact/runtime choice with no session migration; existing Node/Bun binary and Curax snapshots remain untouched. Do not rely on git hard-reset or deletion of shared artifacts.

## 10. Definition of done and honest completion reporting

This plan is **not completed** until:

1. S0-S10 leaf tasks are audited with current evidence (VERIFIED/PARTIAL/MISSING/BROKEN/BLOCKED), full coverage and targeted test logs.
2. ICE source-level ports have measured wins (or documented rejection) and identical final semantics.
3. Native AOT either satisfies image-registration + runtime tests + ICE parity or is explicitly labeled experimental/rejected; no masked fallback.
4. Output includes **real ICE** benchmark JSONL and summary, not only Pi-Bolt's published numbers.
5. Source/patch/engine/license identities and binary/manifest hashes are reproducible.
6. Existing Node/Bun/platform builds and ICE subagents V2, model/provider routing, trust, RPC, sessions and UI keep their contractual behavior.
7. No source outside intended scope or pre-existing user changes were overwritten.
8. All hard correctness gates pass; deviations are listed with impact/owner, not silently waived.
9. A final audit names artifacts and the exact remaining fix queue; operator separately approves any deployment.

**Current progress as of file creation:** Planning prepared only; **zero implementation/benchmark acceptance boxes verified** by this planning task. No compatibility benchmark or code changes were performed. Never turn this document's source observations into a completed-performance claim.

## 11. First implementation-agent handoff (recommended initial bounded assignment)

**Task:** Stage 0 + S1.1/S1.2 only, no AOT runtime build yet.

1. Open this worktree, inspect `AGENTS.md` and `idea.md` and confirm clean ownership of the files you intend to edit. Record modified/untracked files without touching others.
2. Obtain pinned Pi-Bolt source in a read-only/agent-owned external reference location. Produce extraction ledger with source symbols, SHA and license.
3. Implement offline benchmark fixtures and Node/stock-Bun control group before measuring “speedup.” Do not touch the real `~/.ice` configuration or provider keys.
4. Only after reliable B06 tests, port Pi-Bolt's cheap `repairJson` and the streaming-only 1/8 growth throttle into ICE `packages/ai/src/utils/json-parse.ts`. Preserve full final parse; do not change tool execution path in this first assignment.
5. Run focused parser/unit/fixture tests, record the `npm run check` result if authorized, and publish a concise evidence packet: changed files, measurements, tests, failures, next exact targets.
6. Stop for audit. Only then assign integration into each provider and tool UI (S1.3-S1.7) and Markdown stage (S2).

**Explicit prohibitions for this assignment:** no bulk cherry-pick of Pi-Bolt, no engine patching, no replacing `ice`, no global install, no commits/pushes/deploys, no full `npm test`, no live model/API calls, no worktree resets, and no edits to already-dirty interactive-mode UI unless a separate owner approves the exact hunk.
