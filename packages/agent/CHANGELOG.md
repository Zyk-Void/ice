# Changelog

> This fork resets its changelog at the ICE rename. Pre-fork release history lives upstream at https://github.com/earendil-works/pi.

## [Unreleased]

### Breaking Changes

- Renamed the package to `@zykairotis/ice-agent-core` and removed the previous package specifier.
- Renamed public API symbols to `Ice*`/`ice*`.
- Replaced the legacy harness session model with the v4 lane-based `Session`, `SessionStorage`, and `SessionRepo` APIs, including durable operation records, global facts, shared sequence numbers, and tree-scoped lane views.
- Promoted the v2 session and `AgentHarness` API from the experimental entrypoint to the default package export and removed the experimental subpaths.
- Removed the legacy JSONL and in-memory repository APIs. `InMemorySessionRepo` is the reference v4 repository; JSONL v4 support will use the new `SessionRepo` contract.

### Added

- Added targeted removal of pending steering and follow-up messages by object identity.
- Added bounded `Session.findEntriesOnBranch()` and `findEntryOnBranch()` queries with explicit traversal, filtering, ordering, and limit options.
- Added a compile-complete `AgentHarness` v2 scaffold; unfinished operation paths reject with `HarnessNotImplemented` while durable execution is implemented.

### Changed

- Parallel tool calls now start executing as soon as their own preparation (`beforeToolCall`) finishes, instead of waiting until every call in the batch is prepared. Preparation and approval remain sequential and in call order; tool result messages keep assistant order.

### Fixed

- Fixed proxy SSE dropping unterminated final event lines and leaving results unresolved on premature EOF; terminal events stop reading and release the response reader.
- Recheck cancellation immediately before dispatching a prepared tool, preventing host execution when the run aborts between preparation and dispatch in parallel or sequential mode.

- Fixed an error stop reason reported after the run signal was aborted being surfaced, retried, and compacted as a provider failure: the agent loop now reclassifies such responses as `aborted`.
- Fixed Windows path handling for `NodeExecutionEnv` file basenames, recursive skill loading, and prompt template names.

> Release notes for versions published under the previous product identity are not reproduced here. They are preserved in the archived source repository and in prior Git history.
