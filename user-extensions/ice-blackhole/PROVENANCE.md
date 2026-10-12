# Ice Blackhole Provenance

This optional extension adapts deterministic compaction code from `ice-blackhole` version `0.4.3`.

- Upstream: https://github.com/k0valik/ice-blackhole
- Package: `ice-blackhole@0.4.3`
- License: MIT; see `LICENSE`
- Original compaction implementation: ice-vcc, as identified in the upstream source headers
- Local purpose: ICE optional compaction engine and mid-run trigger

Adapted source files retain their upstream provenance comments. ICE changes are limited to:

- removing observational-memory workers and recall from this optional initial integration;
- using Ice's `session_before_compact`, `turn_end`, and `agent_end` extension seams;
- adding a `compactAfterPercent` threshold resolved against the active model context window (numeric token thresholds removed);
- resolving percentage thresholds from the active model context window;
- preserving Ice's `ice-default` retained tail behavior by default; and
- resuming through Ice's existing continuation message path.

This extension is optional and is not part of Ice's default extension set. It does not create a second agent loop, model registry, session store, or compaction persistence layer.
