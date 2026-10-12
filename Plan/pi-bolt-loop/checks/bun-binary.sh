#!/usr/bin/env bash
# D3-09 acceptance: the Bun binary builds with --bytecode and passes smoke runs. Timing is reported only.
# Usage: bun-binary.sh <repo>
set -euo pipefail

repo="$1"
if ! grep -q -- "--bytecode" "$repo/packages/coding-agent/package.json"; then
	echo "FAIL: build:binary does not pass --bytecode"
	exit 1
fi
if ! grep -q -- "--bytecode" "$repo/scripts/build-binaries.sh"; then
	echo "FAIL: scripts/build-binaries.sh does not pass --bytecode"
	exit 1
fi

(cd "$repo/packages/coding-agent" && npm run build:binary)
bin="$repo/packages/coding-agent/dist/ice"
test -x "$bin" || { echo "FAIL: $bin missing"; exit 1; }

home="$(mktemp -d "${TMPDIR:-/tmp}/pi-bolt-bun.XXXXXX")"
trap 'rm -rf -- "$home"' EXIT
smoke() { env -i PATH="$PATH" HOME="$home" TERM=dumb ICE_OFFLINE=1 ICE_CODING_AGENT_DIR="$home/agent" "$bin" "$@"; }

smoke --version >/dev/null || { echo "FAIL: --version"; exit 1; }
smoke --help | grep -q -- "--print" || { echo "FAIL: --help output"; exit 1; }
for arg in --version --help; do
	for i in 1 2 3 4 5; do
		start=$(date +%s%N)
		smoke "$arg" >/dev/null 2>&1
		echo "bun $arg run $i: $(( ($(date +%s%N) - start) / 1000000 )) ms"
	done
done
echo "PASS: bun-binary"
