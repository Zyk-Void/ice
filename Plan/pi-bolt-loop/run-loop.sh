#!/usr/bin/env bash
# Controller for the ICE x Pi-Bolt performance loop. Owns git, sessions, validation and stop decisions.
# Usage: run-loop.sh --day <1|2|3> [--only <task-id>] [--dry-run]
set -euo pipefail

CTRL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN="${MAIN:-/home/mewtwo/Zks/ice}"
SOURCE_BRANCH="${SOURCE_BRANCH:-integration/all-worktrees-experimental}"
BRANCH="${BRANCH:-perf/pi-bolt-port}"
WT="${WT:-$MAIN/.worktrees/pi-bolt-perf}"
BASE_WT="${BASE_WT:-$MAIN/.worktrees/pi-bolt-perf-base}"
ART="${ART:-$MAIN/.artifacts/pi-bolt-loop}"
ICE_BIN="${ICE_BIN:-ice}"
MODEL="${MODEL:-cx/gpt-6-luna}"
THINKING="${THINKING:-max}"
ATTEMPT_TIMEOUT="${ATTEMPT_TIMEOUT:-5400}"

day=""
only=""
dry_run=0
while (( $# )); do
	case "$1" in
		--day) day="$2"; shift 2 ;;
		--only) only="$2"; shift 2 ;;
		--dry-run) dry_run=1; shift ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
[[ "$day" =~ ^[123]$ ]] || { echo "usage: run-loop.sh --day <1|2|3> [--only <task-id>] [--dry-run]" >&2; exit 2; }

log() { printf '[%(%H:%M:%S)T] %s\n' -1 "$*" | tee -a "$ART/loop.log"; }
mkdir -p "$ART"

for tool in jq git node tmux corepack timeout "$ICE_BIN"; do
	command -v "$tool" >/dev/null || { echo "missing required command: $tool" >&2; exit 2; }
done

# Day gates: a human approves each day before the next one starts.
if (( day > 1 )) && [[ ! -f "$ART/day$((day - 1))/APPROVED" ]]; then
	echo "Day $((day - 1)) is not approved. Review $ART/day$((day - 1))/summary.txt, then: touch $ART/day$((day - 1))/APPROVED" >&2
	exit 3
fi

# Worktrees: the loop owns $WT and $BASE_WT exclusively. Nothing else may work in them.
if [[ ! -d "$WT" ]]; then
	log "creating loop worktree $WT on new branch $BRANCH from $SOURCE_BRANCH"
	git -C "$MAIN" worktree add -b "$BRANCH" "$WT" "$SOURCE_BRANCH"
	(cd "$WT" && npm ci --ignore-scripts)
fi
[[ "$(git -C "$WT" branch --show-current)" == "$BRANCH" ]] || { echo "$WT is not on $BRANCH" >&2; exit 2; }
if [[ -n "$(git -C "$WT" status --porcelain)" ]]; then
	echo "$WT has uncommitted changes. The loop only starts from a clean worktree; inspect them first." >&2
	exit 2
fi
if [[ ! -d "$BASE_WT" ]]; then
	log "creating baseline checkout $BASE_WT"
	git -C "$MAIN" worktree add --detach "$BASE_WT" "$(git -C "$WT" rev-parse HEAD)"
	(cd "$BASE_WT" && npm ci --ignore-scripts)
fi

CTRL_HASH=$(cd "$CTRL" && find . -type f -not -path './.venv/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
BENCH_FROZEN=0
[[ -f "$ART/day1/APPROVED" ]] && BENCH_FROZEN=1
GOLDEN_DIR="$ART/goldens"
export CTRL WT BASE_WT CTRL_HASH BENCH_FROZEN GOLDEN_DIR

max_default=$(jq -r '.defaults.max_attempts' "$CTRL/tasks.json")
mapfile -t task_ids < <(jq -r --argjson d "$day" '.tasks[] | select(.day == $d) | .id' "$CTRL/tasks.json")
[[ -n "$only" ]] && task_ids=("$only")

restore_to() {
	# Discard this task's uncommitted edits in the loop-owned worktree only.
	[[ "$(git -C "$WT" branch --show-current)" == "$BRANCH" ]] || { log "refusing restore: $WT not on $BRANCH"; exit 4; }
	git -C "$WT" restore --source="$1" --staged --worktree -- .
	git -C "$WT" ls-files --others --exclude-standard -z | (cd "$WT" && xargs -0 -r rm -f --)
}

save_patch() {
	git -C "$WT" add -N -- . 2>/dev/null || true
	git -C "$WT" diff "$1" >"$2" || true
	git -C "$WT" reset -q -- . 2>/dev/null || true
}

write_prompt() {
	local id="$1" attempt="$2" max="$3" prev="$4" file="$5"
	{
		echo "Lane: pi-bolt-loop. Task $id, attempt $attempt of $max."
		echo
		cat "$CTRL/day$day.md"
		echo
		echo "## Your task"
		echo
		jq -r --arg id "$id" '.tasks[] | select(.id == $id) |
			"### \(.id): \(.title)\n\n\(.brief)\n\n" +
			"Pi-Bolt references (commits or paths in /home/mewtwo/Zks/ice/reference/Pi-Bolt): \(.refs | join(", "))\n\n" +
			"Files you may change (globs; also packages/*/CHANGELOG.md): \(.allowed | join(", "))\n\n" +
			"Required tests (all must exist and pass; at least one must be added or changed by you): " +
			(if (.tests | length) == 0 then "none" else (.tests | map("\(.cwd)/\(.file)") | join(", ")) end) + "\n\n" +
			(if .targets then "Performance gate: interleaved A/B on the frozen bench must improve " +
				(.targets | to_entries | map("\(.key) by at least \(.value * 100 | round)%") | join(", ")) +
				" with no guard metric regressing more than 10%.\n\n" else "" end) +
			(if .screen then "Screen gate: bench/pi-bolt/screen-check.mjs --compare against day-1 frames must match exactly.\n\n" else "" end) +
			(if .checks then "Extra checks the controller runs: " + (.checks | join(", ")) + " (in /home/mewtwo/Zks/ice/.worktrees/all-worktrees-experimental/Plan/pi-bolt-loop/; read them).\n\n" else "" end) +
			(if .needs_build then "The controller runs `npm run build` before runtime checks; you may run it too.\n" else "" end)' \
			"$CTRL/tasks.json"
		if [[ -n "$prev" && -f "$prev" ]]; then
			echo
			echo "## Validation failed on your previous attempt"
			echo
			echo "Fix only these failures. Re-read the files involved before editing. Do not revert work that passed."
			echo
			echo '```text'
			grep -v '^PASS ' "$prev" | head -n 250
			echo '```'
		fi
	} >"$file"
}

for id in "${task_ids[@]}"; do
	tdir="$ART/$id"
	mkdir -p "$tdir"
	if [[ -f "$tdir/status" ]] && grep -qx 'PASS' "$tdir/status"; then
		log "$id already PASS; skipping"
		continue
	fi
	jq -e --arg id "$id" '.tasks[] | select(.id == $id)' "$CTRL/tasks.json" >/dev/null || { log "$id: unknown task"; exit 2; }

	base_sha=$(git -C "$WT" rev-parse HEAD)
	git -C "$BASE_WT" checkout -q --detach "$base_sha"
	export BASE_SHA="$base_sha"
	max=$(jq -r --arg id "$id" --argjson d "$max_default" '.tasks[] | select(.id == $id) | .max_attempts // $d' "$CTRL/tasks.json")
	session_id="pbl-$id-$(date +%Y%m%d%H%M%S)"
	echo "$session_id" >"$tdir/session-id"
	prev_summary=""
	prev_diff_hash=""
	result="UNRESOLVED"

	for attempt in $(seq 1 "$max"); do
		adir="$tdir/attempt-$attempt"
		mkdir -p "$adir"
		write_prompt "$id" "$attempt" "$max" "$prev_summary" "$adir/prompt.md"
		log "$id attempt $attempt/$max: running $MODEL ($THINKING), session $session_id"
		if (( dry_run )); then
			log "dry run: prompt at $adir/prompt.md"
			result="DRY_RUN"
			break
		fi

		date -Is >"$adir/started"
		set +e
		(cd "$WT" && timeout --kill-after=60 "$ATTEMPT_TIMEOUT" "$ICE_BIN" -p --mode json \
			--model "$MODEL" --thinking "$THINKING" \
			--ice-mode build --ice-allow-bash --approve \
			--append-system-prompt "$CTRL/rules.md" \
			--session-id "$session_id" \
			"$(cat "$adir/prompt.md")" >"$adir/ice.jsonl" 2>"$adir/ice.stderr")
		ice_status=$?
		set -e
		date -Is >"$adir/finished"
		echo "$ice_status" >"$adir/ice.exit"
		log "$id attempt $attempt: ice exited $ice_status"

		set +e
		"$CTRL/validate.sh" "$id" "$adir/validation" >"$adir/validate.out" 2>&1
		valid=$?
		set -e
		prev_summary="$adir/validation/validation.txt"
		if (( valid == 0 )); then
			mapfile -t files <"$adir/validation/changed-files.txt"
			git -C "$WT" add -- "${files[@]}"
			git -C "$WT" commit -q -m "$(jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .commit' "$CTRL/tasks.json")" \
				-m "Ported by the pi-bolt-loop controller, task $id, attempt $attempt. Validation: $adir/validation/validation.txt"
			git -C "$WT" rev-parse HEAD >"$tdir/commit"
			result="PASS"
			log "$id PASS at attempt $attempt ($(git -C "$WT" rev-parse --short HEAD))"
			break
		fi

		log "$id attempt $attempt: validation FAIL ($(grep -c '^FAIL' "$prev_summary" 2>/dev/null || echo ?) failures)"
		diff_hash=$( { git -C "$WT" diff "$base_sha"; git -C "$WT" ls-files --others --exclude-standard; } | sha256sum | cut -d' ' -f1)
		if [[ -n "$prev_diff_hash" && "$diff_hash" == "$prev_diff_hash" ]]; then
			log "$id: no change since the previous attempt; stopping this task"
			break
		fi
		prev_diff_hash="$diff_hash"
	done

	if [[ "$result" == "UNRESOLVED" ]]; then
		save_patch "$base_sha" "$tdir/unresolved.patch"
		restore_to "$base_sha"
		log "$id UNRESOLVED; patch saved to $tdir/unresolved.patch, worktree restored to $base_sha"
	fi
	echo "$result" >"$tdir/status"
done

(( dry_run )) && exit 0

# Day close-out: full non-e2e suite, goldens after day 1, summary, then stop for human review.
ddir="$ART/day$day"
mkdir -p "$ddir"
log "day $day: running ./test.sh (non-e2e suite)"
set +e
(cd "$WT" && ./test.sh) >"$ddir/test-suite.log" 2>&1
suite=$?
set -e

if (( day == 1 )) && grep -qx PASS "$ART/D1-02/status" 2>/dev/null && [[ ! -d "$GOLDEN_DIR" ]]; then
	log "recording day-1 screen goldens to $GOLDEN_DIR"
	(cd "$WT" && npm run build >"$ddir/golden-build.log" 2>&1 && node bench/pi-bolt/screen-check.mjs --repo "$WT" --record "$GOLDEN_DIR") \
		>"$ddir/golden.log" 2>&1 || log "golden recording FAILED: $ddir/golden.log"
fi

{
	echo "Day $day summary ($(date -Is))"
	echo "Branch $BRANCH at $(git -C "$WT" rev-parse --short HEAD) in $WT"
	echo "Model $MODEL, thinking $THINKING"
	echo
	for id in $(jq -r --argjson d "$day" '.tasks[] | select(.day == $d) | .id' "$CTRL/tasks.json"); do
		printf '%-6s %-11s %s\n' "$id" "$(cat "$ART/$id/status" 2>/dev/null || echo NOT_RUN)" "$(cat "$ART/$id/commit" 2>/dev/null || true)"
	done
	echo
	echo "Full non-e2e suite (./test.sh): exit $suite; log $ddir/test-suite.log"
	echo
	echo "Review: git -C $WT log --stat $SOURCE_BRANCH..$BRANCH"
	echo "Approve to unlock day $((day + 1)): touch $ddir/APPROVED"
} | tee "$ddir/summary.txt"
