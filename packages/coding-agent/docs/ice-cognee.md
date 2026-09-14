# ICE Cognee memory (`ice-cognee`)

Claude Code–style Cognee integration for **`ice` only** (stock `ice` is unchanged).

Upstream reference: [topoteretes/cognee-integrations/integrations/claude-code](https://github.com/topoteretes/cognee-integrations/tree/main/integrations/claude-code).

Ice does not load Claude `hooks.json`. Parity is implemented with the **Ice extension event API**.

## Hook parity

| Claude Code | Ice event | Behavior |
|-------------|----------|----------|
| SessionStart | `session_start` | Session id, health check, “Memory Connected”, agent register, queue drain |
| UserPromptSubmit (recall) | `before_agent_start` | Scoped recall inject |
| UserPromptSubmit (store) | `before_agent_start` | Pending prompt for QA |
| PostToolUse | `tool_result` | TraceEntry (`/api/v1/remember/entry`) |
| Stop | `agent_end` | QAEntry |
| PreCompact | `session_before_compact` | Multi-scope memory anchor |
| SessionEnd | `session_shutdown` | `/improve` + unregister |
| Idle improve | `agent_settled` | Cooldown-gated improve (idle watcher analog) |
| Skills | `resources_discover` | `cognee-remember` / `cognee-search` / `cognee-sync` |

## Defaults

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
  "baseUrl": "http://127.0.0.1:8211",
  "dataset": "ice",
  "recallBudgetMs": 10000
}
```

## Checkpoint recall handoff (optional)

With `checkpointRecall: true` (env `ICE_COGNEE_CHECKPOINT_RECALL`) and Blackhole owning compaction, Cognee runs one
bounded recall at `session_before_compact` (seeded from the newest summarized user message, same budget and caps as
turn recall) and writes `<agentDir>/ice-cognee/compaction-recall.json`. Blackhole embeds it as a capped
`[Relevant Memory]` section in the checkpoint and deletes the file (consume-once, 15-minute freshness window).

`checkpointRecall` is independent of per-prompt `autoRecall`: disabling prompt recall does not disable the explicit
checkpoint handoff. Handoffs are session-tagged and rejected when they belong to a different host session.

This is opt-in because normal recall already fires on the next turn's prompt; the handoff only pays off when that
prompt is too vague to seed a good query ("continue"). Failures are silent and share the recall circuit breaker.

## Blackhole cooperation

| Mode | Behavior |
|------|----------|
| **`auto` (recommended)** | Never override the Ice compact summary. Blackhole or native Ice writes the checkpoint; Cognee queues that final summary on `session_compact` and injects it once on the next turn. |
| **`defer`** | Same as `auto`: never own the summary. |
| **`own`** | Explicit opt-in. Summarizes `messagesToSummarize` locally. Skips network on overflow/`willRetry`. |

Recall is turn-scoped (`systemPrompt` append). It is not persisted as session history.

Set `"dataset": "$project"` to isolate memory per git root. An explicit dataset name stays shared.

Balanced profile: `compactionSummaryMode: "auto"`, Blackhole `tailBehavior: "minimal"`, Cognee capture/recall/remember.

Config: `~/.ice/agent/ice-cognee/config.json`
API key: `~/.ice/agent/ice-cognee/api_key.json` with mode `0600`; process `COGNEE_API_KEY` wins, then this file, then the mint cache and shared `~/.cognee/.env`.
Also reads `COGNEE_*` from env and `~/.cognee/.env` (Claude/Codex shared).
Does **not** auto-use `COGNEE_PLUGIN_DATASET=agent_sessions`. Default dataset remains **`ice`** unless set to **`$project`**.

## Commands

```text
/cognee status | watch | doctor
/cognee on | off
/cognee recall on|off
/cognee capture on|off
/cognee tools on|off
/cognee improve on|off | improve now
/cognee remember on|off
/cognee remember [user_context|project_docs|agent_actions] <text>
/cognee search <query>
/cognee flush [pending|uncertain]
```

## Realtime observer

`/cognee watch` starts a loopback-only dashboard and reports its URL in the Ice UI. It reads the local
`~/.ice/agent/ice-cognee/observations.jsonl` stream and updates over SSE. The dashboard shows agent/session IDs,
dataset, Cognee endpoint, request lifecycle, latency, queue activity, failures, and capped redacted previews.

The observer is local instrumentation, not a second memory store. API keys are never written to the event stream;
previews are capped and passed through the same memory redaction rules as Cognee writes. The server closes with the
Ice session.

Recall transport accepts Cognee's bounded response envelope up to `128 KiB`, then keeps only the requested top-K
results. Prompt/context injection remains capped by `recallMaxChars`.

## Ops

1. Start API: `/home/mewtwo/Zykairotis/cognee/scripts/start-local-api.sh`
2. Layer B LLM/Voyage keys from `~/.claude/settings.json` env into Zykairotis `.env`
3. Layer A key: `~/.ice/agent/ice-cognee/api_key.json` (preferred), `COGNEE_API_KEY`, or `mint-api-key.sh` → `~/.cognee-plugin/api_key.json`
4. Rebuild: `npm run build` in monorepo (or coding-agent package)

## Cost

Continuous capture + improve costs Voyage/LLM on the server. Use `/cognee capture off` and `/cognee improve off` to return to recall + compaction-only mode.
