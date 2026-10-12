#!/usr/bin/env bash
# Deterministic gate for one loop task. The model never decides pass/fail; this script does.
# Usage: validate.sh <task-id> <out-dir>
# Env (set by run-loop.sh): CTRL, WT, BASE_WT, BASE_SHA, CTRL_HASH, GOLDEN_DIR, BENCH_FROZEN (0|1)
set -uo pipefail

task_id="$1"
out="$2"
mkdir -p "$out"
summary="$out/validation.txt"
: >"$summary"
failed=0

task() { jq -r --arg id "$task_id" ".tasks[] | select(.id == \$id) | $1" "$CTRL/tasks.json"; }
default() { jq -r ".defaults.$1" "$CTRL/tasks.json"; }
note() { echo "$*" | tee -a "$summary"; }
fail() { note "FAIL [$1] $2"; failed=1; }
pass() { note "PASS [$1] $2"; }
# step <name> <log> <cmd...>: run, keep the full log, quote the last 120 lines on failure.
step() {
	local name="$1" log="$2"
	shift 2
	if "$@" >"$log" 2>&1; then
		pass "$name" "$(basename "$log")"
	else
		fail "$name" "exit $? (full log: $log)"
		{ echo "--- tail of $log ---"; tail -n 120 "$log"; echo "---"; } >>"$summary"
	fi
}

cd "$WT" || exit 2

# 1. Controller files untouched.
now_hash=$(cd "$CTRL" && find . -type f -not -path './.venv/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
[[ "$now_hash" == "$CTRL_HASH" ]] && pass integrity "controller files unchanged" || fail integrity "controller files under $CTRL changed"

# 2. Git ownership: no commits, branch switches or stashes by the model.
[[ "$(git rev-parse HEAD)" == "$BASE_SHA" ]] && pass git "HEAD unchanged" || fail git "HEAD moved from $BASE_SHA; the model must not commit or switch branches"

# 3. Change scope.
mapfile -t changed < <({ git diff --name-only "$BASE_SHA"; git ls-files --others --exclude-standard; } | sort -u)
printf '%s\n' "${changed[@]}" >"$out/changed-files.txt"
scope_failed=0
if (( ${#changed[@]} == 0 )); then
	fail scope "no files changed"
	scope_failed=1
fi
mapfile -t allowed < <(task '.allowed[]'; jq -r '.defaults.always_allowed[]' "$CTRL/tasks.json")
forbidden=("reference/*" "agent_references/*" "Plan/pi-bolt-loop/*" "packages/ai/src/models.generated.ts" "package-lock.json" "*npm-shrinkwrap.json" "*install-lock/*" "*/node_modules/*")
[[ "$BENCH_FROZEN" == "1" && "$(task '.owns_bench // false')" != "true" ]] && forbidden+=("bench/pi-bolt/*")
for file in "${changed[@]}"; do
	[[ -z "$file" ]] && continue
	for pattern in "${forbidden[@]}"; do
		# shellcheck disable=SC2053
		if [[ "$file" == $pattern ]]; then fail scope "forbidden path changed: $file"; scope_failed=1; continue 2; fi
	done
	ok=0
	for pattern in "${allowed[@]}"; do
		# shellcheck disable=SC2053
		[[ "$file" == $pattern ]] && ok=1 && break
	done
	(( ok )) || { fail scope "outside task scope: $file"; scope_failed=1; }
done
(( scope_failed )) || pass scope "${#changed[@]} files, all in scope"

# 4. Required tests exist, are new or changed when required, and pass.
require_new=$(task '.require_new_tests')
touched_test=0
while IFS=$'\t' read -r cwd file; do
	[[ -z "$cwd" ]] && continue
	path="$cwd/$file"
	if [[ ! -f "$path" ]]; then fail tests "missing required test $path"; continue; fi
	printf '%s\n' "${changed[@]}" | grep -qxF "$path" && touched_test=1
	step "test $path" "$out/test-$(echo "$path" | tr '/' '_').log" \
		bash -c "cd '$cwd' && node ../../node_modules/vitest/dist/cli.js --run '$file'"
done < <(task '.tests[] | [.cwd, .file] | @tsv')
if [[ "$require_new" == "true" ]] && (( touched_test == 0 )); then
	fail tests "none of the required tests was added or changed by this task"
fi

# 5. Repository check (runs biome --write; re-check scope afterwards is covered by the next attempt).
step "npm run check" "$out/check.log" corepack npm@12.0.2 run check

# 6. Build, then runtime checks that need dist/.
if [[ "$(task '.needs_build')" == "true" ]]; then
	step "build" "$out/build.log" npm run build
fi
while read -r check; do
	[[ -z "$check" ]] && continue
	step "check $check" "$out/$(basename "$check").log" bash "$CTRL/$check" "$WT"
done < <(task '.checks // [] | .[]')

# 7. Harness self-validation (D1-02 only).
if [[ "$(task '.harness_check // false')" == "true" && $failed -eq 0 ]]; then
	if node bench/pi-bolt/run.mjs --list >"$out/metrics.txt" 2>"$out/metrics.err"; then
		required=(startup_version_ms startup_help_ms rpc_ready_ms tui_ready_ms stream_toolcall_400k_cpu_ms stream_long_answer_cpu_ms edit_230k_ms bash_big_output_cpu_ms long_session_cpu_ms long_session_rss_mb)
		for metric in "${required[@]}"; do
			grep -qxF "$metric" "$out/metrics.txt" || fail harness "metric $metric not listed"
		done
		for metric in "${required[@]}"; do
			step "bench smoke $metric" "$out/smoke-$metric.log" \
				node bench/pi-bolt/run.mjs --repo "$WT" --metric "$metric" --runs 1 --out "$out/smoke-$metric.json"
		done
		if (( failed == 0 )); then
			step "A/A noise <= 10%" "$out/aa.log" node "$CTRL/bench-compare.mjs" --aa --harness "$WT" --base "$WT" --cand "$WT" \
				--runs 5 --guards "$(IFS=,; echo "${required[*]}")" --max-regress 0.10 --out "$out/aa.json"
			rm -rf "$out/golden-selftest"
			step "screen record" "$out/screen-record.log" node bench/pi-bolt/screen-check.mjs --repo "$WT" --record "$out/golden-selftest"
			step "screen compare 1" "$out/screen-compare1.log" node bench/pi-bolt/screen-check.mjs --repo "$WT" --compare "$out/golden-selftest"
			step "screen compare 2" "$out/screen-compare2.log" node bench/pi-bolt/screen-check.mjs --repo "$WT" --compare "$out/golden-selftest"
		fi
	else
		fail harness "run.mjs --list failed: $(tail -n 20 "$out/metrics.err")"
	fi
fi

# 8. Screen frames must match the day-1 goldens (UI tasks).
if [[ "$(task '.screen // false')" == "true" && $failed -eq 0 ]]; then
	step "screen compare vs day-1 goldens" "$out/screen.log" \
		node bench/pi-bolt/screen-check.mjs --repo "$WT" --compare "$GOLDEN_DIR"
fi

# 9. Performance: interleaved A/B against the previous passing commit.
targets=$(task '.targets // {} | to_entries | map("\(.key):\(.value)") | join(",")')
if [[ -n "$targets" && $failed -eq 0 ]]; then
	if [[ "$BENCH_FROZEN" != "1" ]]; then
		fail perf "bench harness is not frozen yet; finish day 1 first"
	else
		(cd "$BASE_WT" && npm run build >"$out/base-build.log" 2>&1) || fail perf "base checkout build failed: $out/base-build.log"
		if (( failed == 0 )); then
			step "perf A/B" "$out/perf.log" node "$CTRL/bench-compare.mjs" --harness "$WT" --base "$BASE_WT" --cand "$WT" \
				--runs "$(default bench_runs)" --targets "$targets" --guards "$(jq -r '.defaults.guards | join(",")' "$CTRL/tasks.json")" \
				--max-regress "$(default max_regress)" --out "$out/perf.json"
			cat "$out/perf.log" >>"$summary"
		fi
	fi
fi

(( failed == 0 )) && note "VALIDATION: PASS" || note "VALIDATION: FAIL"
exit "$failed"
