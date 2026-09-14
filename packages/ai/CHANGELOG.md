# Changelog

> This fork resets its changelog at the ICE rename. Pre-fork release history lives upstream at https://github.com/earendil-works/pi.

## [Unreleased]

### Breaking Changes

- Renamed the package to `@zykairotis/ice-ai`. The only command is `ice-ai`.
- Removed the `pi-messages` API id and `PiMessages*` / `piMessagesApi` aliases. Use `ice-messages`.
- Stopped reading `PI_CACHE_RETENTION`, `PI_OAUTH_CALLBACK_HOST`, and `PI_PROVIDER_CONTINUATION_DIAG*` as `ICE_*` fallbacks.
- Renamed public API symbols and serialized provider identifiers to `Ice*`/`ice*`.
- Renamed the exported `ModelsStreamTransforms` interface to `ModelsRequestTransforms` because its header transformation now applies to all authenticated provider requests.
- Required dynamic model providers to accept a concrete `RefreshModelsContext.signal`; `Models.refresh()` remains unbounded when callers omit its optional signal.
- Required provider login, API-key check/resolution, and OAuth refresh implementations to accept a concrete abort signal; public auth and credential operations remain unbounded when callers omit their optional signal.
- Replaced raw `RefreshModelsContext.store` access with the read-only `context.stored` snapshot and generation-checked `context.publish()` transaction.

  **`createProvider({ fetchModels })`:** no catalog-publication migration is required. Before and after, return the fetched list; `createProvider()` restores stored models and publishes and persists refreshed models itself. `signal` is now guaranteed to be present.

  ```ts
  // Before
  const beforeProvider = createProvider({
    // ...
    fetchModels: async ({ signal }) => {
      const response = await fetch(catalogUrl, { signal });
      return parseModels(await response.json());
    },
  });

  // After: unchanged
  const afterProvider = createProvider({
    // ...
    fetchModels: async ({ signal }) => {
      const response = await fetch(catalogUrl, { signal });
      return parseModels(await response.json());
    },
  });
  ```

  **Handwritten `Provider.refreshModels()`:** replace direct store access and pre-publication mutation with generation-guarded publications.

  ```ts
  // Before
  refreshModels: async (context) => {
    const stored = await context.store.read();
    if (stored) currentModels = stored.models;
    if (!context.allowNetwork) return;

    const refreshed = await fetchModels(context.signal);
    currentModels = refreshed;
    await context.store.write({ models: refreshed, checkedAt: Date.now() });
  },

  // After
  refreshModels: async (context) => {
    if (context.stored) {
      const restored = context.stored.models;
      if (!(await context.publish({
        update: () => { currentModels = restored; },
      }))) return;
    }
    if (!context.allowNetwork) return;

    const refreshed = await fetchModels(context.signal);
    if (context.signal.aborted) return;
    await context.publish({
      persist: { models: refreshed, checkedAt: Date.now() },
      update: () => { currentModels = refreshed; },
    });
  },
  ```

  In `publish()`, omit `persist` to leave storage unchanged, pass a `ModelsStoreEntry` to write it, or pass `persist: null` to delete it. Omit `update` for metadata-only persistence; omit `persist` for an ephemeral in-memory publication.

### Added

- Added service-tier request metadata so capable callers can select provider priority tiers independently of reasoning level ([#5](https://github.com/Zykairotis/ice/pull/5)).
- Added model-specific `ultra` thinking support through `thinkingLevelMap`, preserving provider-native values without enabling it for models that do not advertise the level ([#5](https://github.com/Zykairotis/ice/pull/5)).
- Added deferred provider request contracts, durable response handles, authenticated fetch/cancel dispatch, and faux-provider support for pending, ready, failed, and cancelled responses ([#7339](https://github.com/earendil-works/pi/pull/7339) by [@davidbrai](https://github.com/davidbrai)).
- Added Baseten as a built-in OpenAI-compatible provider with models.dev catalog generation and native `chat_template_args` reasoning controls.
- Added typed prompt-cache affinity keys independent from provider session identities for supported cache-aware adapters, preserving continuation and transport session state.

### Changed

- Added optional cancellation to `ModelsStore` reads, writes, and deletions; catalog orchestration binds these waits to the provider refresh signal.

### Fixed

- Fixed GitHub Copilot Grok 4.5 requests to use the supported Responses API ([#7560](https://github.com/earendil-works/pi/issues/7560)).
- Bounded OAuth token refreshes so stalled requests release the credential-store lock ([#7508](https://github.com/earendil-works/pi/issues/7508)).
- Fixed tool argument validation to preserve values that already match an `anyOf`/`oneOf` union arm before attempting coercion, avoiding nullable unions converting `null` to another primitive value ([#7328](https://github.com/earendil-works/pi/issues/7328)).
- Fixed cancellation of model catalog refreshes so callers stop waiting even when a custom provider ignores its abort signal ([#7027](https://github.com/earendil-works/pi/issues/7027)).
- Fixed auth resolution, availability checks, OAuth refreshes, provider login, and in-memory credential queue waits to honor caller cancellation.
- Fixed newer provider refreshes being blocked by or overwritten by an older stalled generation, including persisted catalog publication.
- Updated GPT-5.6 Terra and Luna pricing across OpenAI and passthrough model catalogs.
- Fixed Fireworks Kimi K3 models to use the OpenAI-compatible API with native reasoning-effort levels and deferred tools ([#7199](https://github.com/earendil-works/pi/issues/7199), [#7230](https://github.com/earendil-works/pi/pull/7230) by [@XBeg9](https://github.com/XBeg9)).
- Updated Groq's Qwen reasoning override for the replacement `qwen/qwen3.6-27b` model.

> Release notes for versions published under the previous product identity are not reproduced here. They are preserved in the archived source repository and in prior Git history.
