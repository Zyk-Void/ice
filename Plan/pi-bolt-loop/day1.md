# Day 1: stop the startup stall, then build the yardstick

Day 1 has two jobs. Fix the startup stall that users hit today, then build the benchmark harness every
later task is measured with. The harness is frozen after a human reviews it, so build it carefully:
later days cannot change it.

## Known facts (measured 2026-10-12; do not rediscover)

- `ice --help` took 1.6-39 s. CPU was about 2 s; the rest was waiting on a file lock.
- A run sometimes exits while `~/.ice/agent/models-store.json.lock` (a `proper-lockfile` directory) still
  exists. The next run gets `ELOCKED` from `FileModelsStore` and backs off until the lock is stale
  (`stale: 30000`). Three consecutive runs: 1606 ms (lock left behind), 29915 ms, 1748 ms.
- Which exit path leaks the lock is not yet known. The leak was seen with the real config and network
  model refresh enabled. In 30 isolated runs with `ICE_OFFLINE=1`, no lock leaked, so the leak most
  likely needs a refresh write in flight at exit. `checks/lock-stall.sh` runs offline: it proves the
  held-lock stall, not the leak. Your regression test must cover the leak itself, for example by
  exiting, or calling the exit path, while a models-store write holds the lock.
- Against today's build, `checks/lock-stall.sh` fails: `--help` with a held lock did not finish within
  20 s.
- Code: `packages/coding-agent/src/core/models-store.ts` (`loadSnapshot` takes the lock just to read),
  `core/auth-storage.ts` (`acquireLockAsync`: `100*2^n`, up to 10 s per wait, 10 retries),
  `src/main.ts` (`--help` builds the whole runtime before `printHelp`).
- Pi-Bolt's handling: `packages/coding-agent/src/core/models-store.ts` (revision-cached reads),
  `core/auth-storage.ts:119` (`10*2^n` capped at 2 s, 30 s deadline), `src/main.ts:131`
  (`isPlainRuntimeMetadataCommand`).

## Benchmark harness contract (D1-02 must satisfy exactly)

Location: `bench/pi-bolt/` in the worktree. Plain Node ESM (`.mjs`), no new dependencies.

`node bench/pi-bolt/run.mjs --repo <checkout> --metric <name> --runs <n> --out <file.json>`

- Measures the ICE checkout at `--repo` using its built `packages/coding-agent/dist/ice.js`
  (the controller builds it). The harness code itself always comes from the worktree it lives in, so one
  harness can measure two checkouts.
- `--list` prints one metric name per line.
- Output file:

```json
{
  "schema": "ice-bench/1",
  "repo": "<abs path>",
  "git": "<HEAD sha of repo>",
  "node": "v24.x",
  "metrics": { "<name>": { "unit": "ms|mb", "kind": "wall|cpu|rss", "samples": [1.0] } }
}
```

- Fully isolated: temporary `ICE_CODING_AGENT_DIR` and session dir, `ICE_OFFLINE=1`, no API keys in the
  child environment, no real network. A local fake OpenAI-compatible SSE server (node `http`, `127.0.0.1`,
  random port) plays scripted responses. A temporary `models.json` registers it as a provider; the model
  is selected with `--model`.
- CPU metrics read child `user+system` time (`process.resourceUsage` of a wrapper, or `/proc/<pid>/stat`).
  Wall metrics use `performance.now()`. RSS uses `VmHWM` from `/proc/<pid>/status` at exit, in MB.
- Required metrics:

| name | workload |
|---|---|
| `startup_version_ms` | wall time of `ice --version` |
| `startup_help_ms` | wall time of `ice --help` |
| `rpc_ready_ms` | wall time from spawn of `ice --mode rpc` to its first ready response |
| `tui_ready_ms` | wall time until the TUI editor is drawn, in a detached tmux session sized 120x40 |
| `stream_toolcall_400k_cpu_ms` | CPU of `ice -p` while the fake model streams one `write` tool call whose content is 400 KB, in small deltas |
| `stream_long_answer_cpu_ms` | CPU of the TUI (tmux) while the fake model streams a 60,000-char Markdown answer with headings, lists, code fences and tables |
| `edit_230k_ms` | CPU of `ice -p` performing one `edit` tool call on a 230 KB file |
| `bash_big_output_cpu_ms` | CPU of `ice -p` running a `bash` tool call that prints 20 MB |
| `long_session_cpu_ms` | CPU of a 40-turn scripted TUI session mixing text, tool calls and Markdown |
| `long_session_rss_mb` | peak RSS of the same session |

- Every workload asserts its own correctness (expected file bytes, exit 0, expected final text) and fails
  loudly instead of reporting a number for a broken run.

Screen check: `node bench/pi-bolt/screen-check.mjs --repo <checkout> --record <dir>` captures
`tmux capture-pane -p -e` frames of three scripted TUI scenarios (long Markdown answer, tool calls with
large args, resize from 120x40 to 80x24 mid-stream). `--compare <dir>` exits 0 when frames match and 1
with a unified diff otherwise. Keep frames deterministic: fixed theme, fixed width, no clock or cwd text,
pinned `TERM`.

`bench/pi-bolt/README.md` documents commands, fixtures and known noise sources in under 60 lines.
