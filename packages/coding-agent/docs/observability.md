# Observability Dashboard

Ice can serve a live, read-only dashboard of the running session. Start ice with `--observe` and open the printed URL (default `http://127.0.0.1:4649/?token=...`) in a browser — ideally on a second screen while ice works in your terminal.

```bash
ice --observe            # dashboard on http://127.0.0.1:4649/?token=...
ice --observe=8080       # custom port
ice --observe -p "fix the tests"   # also works in print mode
```

## What it shows

- **The tape** — a live event grid: tool calls (with arguments, result preview, duration, and error state), user and assistant messages, skill invocations, compaction runs, auto-retries, and queue updates. Every row has the same field anatomy: time, kind, subject, state, duration.
- **The book pane** — drill-down for the selected row: full arguments as pretty JSON, full result text, timing, and streaming-update counts. Click a row, or move with the arrow keys.
- **Status strip** — session, model, thinking level, context-window pressure, token totals, and cost, rendered as segmented readouts updated once per second.
- **Subagent lanes** — removed with the legacy `delegate*` tools. New recordings carry an empty `lanes` list, and older recordings still show their lanes. The dashboard does not render the Subagents V2 registry or event channel; use `/agents` or `agent_control` to inspect V2 children.

## Legacy V1 subagent quality fields

Old V1 delegation results and durable-job detail views may expose bounded quality metadata: semantic quality mode, runtime-derived assurance level, and task-contract hash. These fields describe the retired V1 delegation path, not current V2 children. See [Subagents V2](subagents-v2.md) for the current child lifecycle, evidence, and verification limits.

## Controls

- `0`–`6` or the keycap column: filter the tape (all, tools, messages, skills, compaction, retries, queue)
- `space`: hold the tape (pause auto-scroll; scrolling up holds automatically)
- `↑` `↓`: select rows; `escape`: close the detail pane

## Durable run history and replay

Every normal agent run records projected observability events in `observability.sqlite` under ICE's agent directory (normally `~/.ice/agent/observability.sqlite`). The database is separate from the canonical session JSONL: it is a forensic projection and never replaces or mutates session history. Before an event is written, credential-shaped text (bearer tokens, `api_key=`/`token=`/`password=` assignments, and values under keys such as `token` or `authorization`) is replaced with `[REDACTED]`; the live dashboard view is not redacted. Events are append-only, bounded to the same payload ceiling as the live recorder, and include activity updates so a replay can show the evolution of a tool call rather than only its final state.

When `--observe` is enabled, the loopback server also exposes:

- `GET /runs?limit=100` — newest recorded runs.
- `GET /replay?runId=<run-id>` — one run summary and its ordered events.
- `GET /replay/events?runId=<run-id>&after=<sequence>&limit=<count>` — paginated ordered events.
- `GET /replay?sessionId=<session-id>` — the newest run for a session ID.

Replay endpoints only read the database. They do not re-run prompts, tools, or side effects. A run left `running` indicates that the process stopped before the recorder observed normal shutdown; it is not presented as successfully completed.

## Guarantees and limits

- **Read-only.** The dashboard never accepts commands from the browser; it cannot send prompts, abort runs, or change settings.
- **Loopback only.** The server binds `127.0.0.1`; nothing is exposed to the network.
- **Token required.** Loopback does not separate OS accounts, so every route requires the per-user token stored in `observe.token` (mode `0600`) under ICE's agent directory. Open the printed URL once; it sets an `HttpOnly` cookie for the page's own requests. Scripts can send `Authorization: Bearer <token>`. Requests without the token get `401`.
- **Bounded.** Server-side caps keep payloads small: ~500 activity items and truncated text per row, so the browser never receives unbounded output.
- **Durable projection.** Run history is written for every normal agent invocation, whether or not `--observe` is enabled. The dashboard reuses that recorder and can read historical runs through the replay endpoints.

## How it works

`observe-server.ts` (plain `node:http`, no dependencies) serves the single-file dashboard and an SSE endpoint. `observe-recorder.ts` subscribes to the session's event stream and projects it into a bounded state: tool calls and messages from agent events, legacy V1 subagent lanes from delegation progress snapshots, skill invocations from expanded skill blocks, and model/context/usage state polled once per second.
