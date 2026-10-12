# ICE Subagent Audit Report

> **Historical V1 audit (2026-08-10).** This report inspects the legacy `ice-subagents.ts` implementation, which was later replaced by Subagents V2. Its findings are not verified against the current V2 source and should not be treated as either confirmed or fixed in V2. Re-audit the current implementation before relying on the findings. See the [current V2 guide](../packages/coding-agent/docs/subagents-v2.md) and [architecture](../packages/coding-agent/docs/subagents-v2-architecture.md).

Date: 2026-08-10
Scope: current workspace, with emphasis on delegated child sessions, unsafe host execution, scoped tools, durable jobs, and related tests.

## Executive result

The subagent implementation is substantially present and has meaningful boundary checks, but I would not treat unsafe host execution as production-safe. I verified two high-severity security issues. I also found lifecycle cases that are not sufficiently covered by tests; those are recorded as verification gaps, not confirmed implementation defects.

No source or test files were modified during this audit.

## Verified findings

### High — unsafe child Bash inherits the complete host environment

**Evidence:**

- `packages/coding-agent/src/ice-subagents.ts` creates the unsafe child Bash tool with `exposeSessionEnvironment: false`.
- `packages/coding-agent/src/core/tools/bash.ts` delegates environment construction to `getShellEnv()`.
- `packages/coding-agent/src/utils/shell.ts` implements `getShellEnv()` by spreading `process.env` and only adjusting `PATH`.

**Impact:**

Disabling Ice session metadata does not create a sanitized environment. An unsafe delegated child can read unrelated host credentials and configuration such as cloud tokens, package registry tokens, and service keys, then use them through the authorized shell. This is especially important because the documented `--sub-yolo` path explicitly grants host command execution.

**Recommended direction:**

Construct an explicit allowlisted environment for delegated Bash, or run the child through an independently isolated execution boundary. At minimum, do not pass the parent process environment by default; preserve only the shell/runtime variables required by the command contract.

### High — scoped path checks have a TOCTOU symlink race

**Evidence:**

- `packages/coding-agent/src/ice-subagents.ts` validates a path in `assertSubagentScopePath()` using `resolveScopeCandidate()` and `isPathWithin()`.
- `withScopedPath()` performs that validation and then calls the underlying tool's `definition.execute()` separately.
- The underlying file tools resolve/open paths after the wrapper check.

**Impact:**

A path inside an approved scope can be replaced with a symlink to an outside path between authorization and use. A concurrent local process, or a delegated Bash child in the unsafe mode, can exploit that gap to read or modify files outside the declared scope. The check also does not establish a stable directory/file handle for the subsequent operation.

**Recommended direction:**

Make authorization and filesystem use share a secure path-resolution boundary. Options include descriptor-relative operations with symlink restrictions, canonicalization plus immediate revalidation before use, or an isolated workspace where scope escape is impossible. Apply the same guarantee to read, grep, find, ls, write, and edit.

## Verification gaps

These items came from the test-coverage review and require implementation-focused follow-up before being classified as bugs:

- Non-cooperative child runners that ignore `AbortSignal` are not demonstrated to settle or remain bounded after cancellation.
- Cancellation combined with persistence failure lacks coverage for final status, reservation release, and scheduler blocking.
- Restore edge cases around malformed/latest snapshots and interrupted jobs need stronger assertions.
- Completion-notification failures need explicit coverage to prove durable state remains inspectable and no duplicate completion is emitted.

## Audit execution notes

- Four typed reviewers were launched in parallel for correctness, security, tests, and regressions.
- The batch timed out before three reports could be parent-verified; the tests reviewer returned coverage gaps.
- Two narrower follow-up reviewers returned security/lifecycle hypotheses, but their terminal results were not accepted as verified reports because one used stale line evidence and both ended in non-completed verification states.
- The two findings above were independently checked against the current source before inclusion.

## Suggested priority

1. Remove inherited credentials from unsafe delegated environments.
2. Close the scoped filesystem TOCTOU boundary, or explicitly require an isolated workspace for any mutation-capable child.
3. Add cancellation/persistence/restore/notification regression tests.
4. Re-run the typed audit after those changes and require completed, parent-verified reviewer results.
