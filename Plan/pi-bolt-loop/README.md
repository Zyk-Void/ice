# pi-bolt-loop: Luna ports Pi-Bolt speedups into ICE, one validated task at a time

A bash controller runs ICE on Luna for one task at a time. A deterministic validator decides pass or
fail, the controller commits passing work, and a human approves each day before the next one starts.

## How the loop works (and why)

Built from OpenAI's guidance on long-running Codex loops:

- [Run long-horizon tasks with Codex](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex):
  durable plan and status files, milestones sized for one loop, acceptance criteria and validation
  commands per milestone, a stop-and-fix rule.
- [Codex prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide):
  autonomy and persistence wording; no requests for upfront plans or status updates (they make the model
  stop early).
- [Iterative repair loops](https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex):
  validation, not the model, decides success. Stop on pass, on max attempts, when the delta stops
  changing, or when a human decision is needed. Keep an audit trail per attempt.

Per task:

1. The controller records the start commit and points the baseline checkout at it.
2. ICE runs `-p --mode json` on `$MODEL` at `$THINKING`. It gets `rules.md` as an appended system prompt
   and the day brief plus the task as the prompt. Session id: `pbl-<task>-<timestamp>`.
3. `validate.sh` checks, in order:
   - controller files are untouched, and the model made no commit;
   - every changed file is inside the task's allowed globs and none is forbidden;
   - required tests exist, are new or changed, and pass;
   - `corepack npm@12.0.2 run check` passes;
   - build and extra checks pass;
   - for UI tasks, the screen frames match the day-1 goldens;
   - for perf tasks, an interleaved A/B against the start commit improves the target metric with no guard
     metric regressing more than 10%.
4. On PASS the controller commits the changed files. On FAIL it resumes the same session with only the
   failures; at most 3 attempts in total, stopping early if the diff stops changing. A task that never
   passes is saved as `unresolved.patch`, and the worktree goes back to the start commit.
5. At day end it runs `./test.sh` (non-e2e suite), writes `day<N>/summary.txt` and stops.

## Layout

| Path | Owner | Purpose |
|---|---|---|
| `Plan/pi-bolt-loop/` (this dir) | you | controller, prompts, tasks, validator; Luna cannot change it |
| `$MAIN/.worktrees/pi-bolt-perf` | loop | branch `perf/pi-bolt-port` from `integration/all-worktrees-experimental`; Luna works here |
| `$MAIN/.worktrees/pi-bolt-perf-base` | loop | detached checkout of the last passing commit, for A/B |
| `$MAIN/.artifacts/pi-bolt-loop/` | loop | prompts, ICE JSONL, validation logs, patches, summaries, goldens |

## Run it

The first run creates both worktrees and runs `npm ci --ignore-scripts` in each.

```bash
cd /home/mewtwo/Zks/ice/.worktrees/all-worktrees-experimental/Plan/pi-bolt-loop
chmod +x run-loop.sh validate.sh checks/*.sh

./run-loop.sh --day 1 --dry-run        # writes the prompts only; read one before spending tokens
./run-loop.sh --day 1                  # D1-01 lock stall, D1-02 bench harness

# Review: summary, commits, and the harness itself (it is frozen once you approve).
cat /home/mewtwo/Zks/ice/.artifacts/pi-bolt-loop/day1/summary.txt
touch /home/mewtwo/Zks/ice/.artifacts/pi-bolt-loop/day1/APPROVED

./run-loop.sh --day 2                  # non-UI ports, perf-gated
touch /home/mewtwo/Zks/ice/.artifacts/pi-bolt-loop/day2/APPROVED
./run-loop.sh --day 3                  # render reuse (screen-gated) and the Bun bytecode build

./run-loop.sh --day 2 --only D2-03     # rerun one task; PASS tasks are skipped on rerun
```

Run the loop inside tmux so it survives a closed terminal. One attempt is capped at `ATTEMPT_TIMEOUT`
(5400 s).

Overrides (environment): `MODEL` (default `cx/gpt-6-luna`), `THINKING` (`max`), `ICE_BIN` (`ice`, the
installed ICE; never the worktree under edit), `MAIN`, `SOURCE_BRANCH`, `BRANCH`, `WT`, `BASE_WT`, `ART`,
`ATTEMPT_TIMEOUT`.

## Know before running

- **Authority.** `--ice-mode build --ice-allow-bash --approve` gives Luna Bash on this host. Bash is not
  sandboxed; ICE's path guards cover only the file tools. The loop worktree and the rules limit damage;
  they do not contain it.
- **Commits.** The controller commits passing tasks on `perf/pi-bolt-port` only. It never pushes, merges
  or touches other branches.
- **Destructive step.** When a task ends unresolved, the controller restores the loop worktree to the
  task's start commit and deletes untracked files there, after saving the patch. It refuses if that
  worktree is not on `perf/pi-bolt-port`. Never do your own work in that worktree.
- **Builds.** Validation runs `npm run build`, in the loop worktree and in the baseline checkout. That is
  an exception to the AGENTS.md rule, scoped to this loop.
- **The harness is the yardstick.** If D1-02's harness is wrong, every later perf verdict is wrong. Read
  `bench/pi-bolt/` before approving day 1. The A/A noise check (10%) only proves it is stable, not that it
  measures the right thing.
- **Unresolved is a valid result.** Expect 1-3 UI tasks to need a human. A technique that does not move
  ICE's metric fails the perf gate; do not loosen the threshold to force a pass.
- **AOT engine (tier 4) is not in this loop.** Downloading a third-party native runtime needs your own
  review of the release and its checksum first.
