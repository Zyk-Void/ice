#!/usr/bin/env bash
# D1-01 acceptance: startup must not wait on a held models-store lock, and must not leak one.
# Usage: lock-stall.sh <repo>   (needs built packages/coding-agent/dist)
set -uo pipefail

repo="$1"
work="$(mktemp -d "${TMPDIR:-/tmp}/pi-bolt-lockcheck.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
agent="$work/agent"
mkdir -p "$work/home" "$agent"

# run <timeout-seconds> <args...>: isolated ICE run; prints elapsed ms; returns ICE's exit status.
run() {
	local limit="$1"
	shift
	local start status
	start=$(date +%s%N)
	timeout "$limit" env -i PATH="$PATH" HOME="$work/home" TERM=dumb ICE_OFFLINE=1 \
		ICE_CODING_AGENT_DIR="$agent" node "$repo/packages/coding-agent/dist/ice.js" "$@" >/dev/null 2>&1
	status=$?
	echo $(( ($(date +%s%N) - start) / 1000000 ))
	return "$status"
}

fail=0
run 60 --help >/dev/null # prime the agent dir

# 1) A fresh, held lock must not stall --help beyond 5 s.
mkdir -p "$agent/models-store.json.lock"
touch "$agent/models-store.json.lock"
if elapsed=$(run 20 --help); then
	echo "held-lock --help: ${elapsed} ms"
	if (( elapsed >= 5000 )); then
		echo "FAIL: --help waited ${elapsed} ms on a held lock (limit 5000)"
		fail=1
	fi
else
	echo "FAIL: --help with a held lock did not exit 0 within 20 s (${elapsed} ms)"
	fail=1
fi
rm -rf -- "$agent/models-store.json.lock"

# 2) No run may leave a lock behind or take 5 s or more.
for cmd in --help --list-models; do
	for i in $(seq 1 15); do
		elapsed=$(run 60 "$cmd") || { echo "FAIL: $cmd run $i exited non-zero"; fail=1; }
		leaked=$(find "$agent" -maxdepth 1 -name '*.lock' -printf '%f ')
		if [[ -n "$leaked" ]]; then
			echo "FAIL: lock left after $cmd run $i: $leaked"
			fail=1
			find "$agent" -maxdepth 1 -name '*.lock' -exec rm -rf -- {} +
		fi
		if (( elapsed >= 5000 )); then
			echo "FAIL: $cmd run $i took ${elapsed} ms"
			fail=1
		fi
	done
done

(( fail == 0 )) && echo "PASS: lock-stall"
exit "$fail"
