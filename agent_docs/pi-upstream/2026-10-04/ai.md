# AI runtime parity audit: ICE versus Pi

Scope: `packages/ai`, its generated-catalog infrastructure, dependencies and targeted tests. Read-only inspection; no provider calls, installations, builds, tests, source changes or Git mutations were made by this worker. This is an implementation backlog, not a claim that the backlog has been implemented or verified.

Frozen upstream: `earendil-works/pi` main `200387122ca450d6387f033949423114a270b96c` (v1.0.2). ICE worktree HEAD: `db8dd8eebfebe4a2e65d93e9693e6892744517e2`, AI package version 0.83.0, no dirty paths under `packages/ai` at inspection. Shared base: `588915ec71714688cee8b7153339e8bdebb3e82e`. This audit compares final code, rather than treating absent commit IDs or version numbers as proof that features are missing. Pure product renaming, scopes, author/repository URLs and release bookkeeping are excluded.

Evidence artifacts: `ai-inventory.json` has every upstream-changed AI path and its path history; `/tmp/ice-pi-ai-diffs/` has normalized current-ICE versus frozen-Pi diffs for source/scripts. Parent inventory `upstream-file-inventory.json` supplies no-renames coverage. Normalization is intentionally conservative and does not establish semantic equivalence.

## Findings and order

The AI layer needs substantial upstream work. The largest dependency is a new transcript contract: provider adapters now receive prompt/tool changes as system messages, and the agent/runtime must migrate with them. The second is one model/auth registry for chat, image and classifier operations. Neither should be implemented by adding a second ICE registry or another reasoning loop.

Recommended sequence: dependency/export prerequisites; independent P0 correctness patches; typed message/transcript migration across agent and coding-agent; provider replay/effort/caching; typed image/classifier and catalog migration; remaining provider/login additions. Keep each cluster reviewable. Use the final upstream implementation after its fixes, not early versions or reverted transient designs.

`missing` below means the inspected symbol/logic is absent; `partial` means related behavior is already present but the complete upstream behavior is absent; `divergent` identifies intentional ICE additions requiring reconciliation. An unchanged file since the base does not mean every feature in that file is missing.

## AI-01 — P0: reject unfinished Responses tool calls and preserve tool namespaces

Status: missing. Upstream commits `02bd2d1c` (namespace), `1b2aa0ca` (reject incomplete calls), `bc2d8dc1` (grammar replay IDs).

Files/symbols: `src/types.ts::ToolCall`, `src/api/openai-responses-shared.ts::{convertResponsesMessages,processResponsesStream}`. ICE `ToolCall` has no `namespace`, and the stream terminal path accepts `toolUse` even when a tool block still has `partialJson` or `customInput`. Pi copies namespace on add and finalization, replays it for function/custom calls, and refuses to hand an unfinished call to the agent. Pi also drops mismatched provider item IDs during grammar replay instead of pairing an ID with a different tool kind.

Action: preserve namespace through normalization, frames, persistence and SDK/RPC serialization; copy the completed-stream validation and grammar-ID policy. This prevents truncated arguments from becoming executable tool calls. Do not merely add a type field without the parser/replay and agent serialization changes.

Targeted upstream tests: `test/openai-responses-namespace.test.ts`, `test/openai-responses-terminal-event.test.ts`, `test/openai-responses-compat.test.ts`, `test/openai-responses-foreign-toolcall-id.test.ts`, `test/openai-responses-message-id.test.ts`. Existing ICE grammar tooling needs regression coverage after integration.

## AI-02 — P0: strict tool schemas must actually conform, with safe fallback

Status: missing. Commits `7915cdac`, `af7359b9`, `890f9208`, `295cc72b`.

Files/symbols: `src/api/constrained-sampling.ts::{makeStrictJsonSchema,getJsonSchemaToolParameters,resolveJsonSchemaStrictSampling}`, `src/utils/validation.ts::normalizeOptionalNulls`, each provider's tool serialization, `scripts/generate-models.ts::{detectOpenAICompletionsCompat,applyStrictToolCompatMetadata}`.

ICE currently reports strict support and forwards ordinary schemas. Pi clones a schema; recursively sets object `additionalProperties:false`; makes every property required and wraps originally optional non-null properties in nullable alternatives; rejects unsupported schema constructs rather than incorrectly advertising strictness. `strict:"prefer"` falls back for unsupported schemas; `strict:"require"` fails clearly. Anthropic adds provider-specific keyword/format checks. Tool validation removes provider-emitted optional `null` values only when the original schema does not permit null, then runs existing coercion/validation.

Pi defaults unknown OpenAI-compatible endpoints to non-strict and explicitly preserves verified built-in metadata. Cerebras is excluded. Cloudflare Responses gets explicit strict metadata. ICE custom/local provider metadata must remain authoritative where explicitly configured. All Anthropic/Bedrock/Google/Mistral/Completions/Responses tool conversion call sites need the same policy.

Tests: `test/constrained-sampling.test.ts`, `test/anthropic-strict-tool-schema.test.ts`, `test/validation.test.ts`, `test/openai-completions-tool-choice.test.ts`, `test/providers.test.ts`. Hazard: use original tool schemas for runtime argument validation; do not mutate schemas shared with extensions or ICE subagent adapters.

## AI-03 — P0: bounded retry delay, correct transient classification and overflow detection

Status: missing. Commits `fe10558e`, `c37b0e03`, `e5d18382`, `e98f287e`, `3874b3e9`, `2bbfcca4`, `661619e8`, `0e283203`, `3dd803d7`.

Files/symbols: `src/utils/retry.ts::{RetryPolicy,retryDelayMs,retryAssistantCall,isRetryableProviderError}`, `src/utils/provider-retry.ts::calculateRetryDelay`, `src/utils/overflow.ts::isContextOverflow`.

ICE agent retry sleeps grow exponentially without a separate cap. Pi adds `maxAgentDelayMs` (default 60,000 ms) and bounds arithmetic overflow. Invalid or nonfinite `retry-after-ms`/`retry-after` values fall through to exponential backoff instead of producing an immediate NaN timer. Add transient upstream request-buffer errors, Cloudflare 520, Azure high-demand and selected-model-capacity patterns. Pi recognizes ChatGPT unavailable usage/user conditions as retryable and subscription usage exhaustion as non-retryable (AI-12 dependency).

ICE treats any matching bodyless HTTP 400/413 as context overflow. Pi scopes this to `message.provider === "cerebras"`; adds Z.AI `Prompt too long` and CN `Prompt exceeds max length`. These prevent inappropriate compaction/retry on unrelated provider errors and missed real overflow.

Tests: `test/retry.test.ts`, `test/openai-completions-retry.test.ts`, `test/overflow.test.ts`, `test/context-overflow.test.ts`. Coordinate settings, agent loop and durable retry with their workers. Preserve ICE bounded recovery/startup authority; upstream transient classification must not become permission to replay non-idempotent tools.

## AI-04 — P1 prerequisite: normalized transcripts with system and tool-state deltas

Status: missing; existing deferred loading is superseded by upstream's new representation. Commits `e47b8e37`, `9e05370b`, `16292398`, `e4c75a73`, `b271b0a5`; related `d92eb8d4` and earlier deferred implementations require their final replacements.

Files/symbols: `src/types.ts::{SystemMessage,TranscriptContext,ToolReference,Message,ProviderStreams,StreamFunction}`, new `src/utils/transcript.ts`, `src/utils/text.ts`, `src/utils/estimate.ts`, `src/api/transform-messages.ts`, `src/{models,compat}.ts`, every chat adapter, `src/providers/faux.ts`. Retire the old `src/utils/deferred-tools.ts` only as part of a coordinated migration.

ICE `Context` carries global `systemPrompt` and `tools`; `ToolResultMessage.addedToolNames` anchors deferred additions. Pi `normalizeContext()` folds prompt and initial tools into a leading `SystemMessage`; subsequent system messages append content, replace/remove named sections, add/redefine complete tool declarations, and remove tools. `getCurrentTools`, `getCurrentSystemMessage`, `getCurrentSystemPrompt`, `resolveTranscriptTools`, `createToolChangeSystemMessage` replay deterministic current state. Provider-facing `TranscriptContext` is branded so callers normalize once. External `Models.stream*()` still accepts ergonomic `Context`; direct adapter APIs require a normalized transcript.

Providers supporting native changes preserve the ordered transcript. Other providers collapse updates into one current leading prompt/tools set. `transformMessages()` holds a system update behind pending tool results so it neither duplicates synthetic results nor violates adjacency. Estimation counts actual system/tool messages rather than relying on `addedToolNames`. Faux serialization and cache tests must follow the new layout.

Responses uses `additional_tools` or client tool search output at system-message anchors. Kimi capable Completions accepts tool-bearing system messages; unsupported removal/redefinition requires current tools at request level. Anthropic's final design defines tools by value with `tool_addition`/`tool_removal`, keeps initial active tools + one permanently deferred placeholder, and delays updates until after tool-result adjacency. This avoids prefix-cache misses and supports same-name redefinitions. Do not replay the obsolete reference-only deferred loading implementation.

Tests: `test/system-message-replay.test.ts`, `test/transcript-tool-changes.test.ts`, `test/context-estimate.test.ts`, `test/tool-call-without-result.test.ts`, `test/pi-messages.test.ts` (ICE renamed path is `test/ice-messages.test.ts`), `test/providers.test.ts`. Upstream removed `test/deferred-tools.test.ts`; retain any relevant ICE-only regressions in the new protocol tests. Cross-package migration must cover sessions, compaction, dynamic extensions/MCP tools, fork sanitization, immutable subagent contracts, parent instructions and direct provider mocks. Adding only the AI half will break callers.

## AI-05 — P1: serializable message data and assistant progress frame reducer

Status: missing. Commits `04d6447f`, `a829de0a`, `5c6655e7`, `0fdec07b`; final namespace handling includes `02bd2d1c` and tool JSON tightening includes `8562bcf6`.

Files/symbols: `src/types.ts::{JsonValue,JsonObject,JsonRepresentation,ToolCall,ToolResultMessage,NestedToolCallRecord,NestedToolCalls,AssistantMessage}`, new `src/utils/assistant-message-frame.ts::{AssistantMessageFrameEncoder,reduceAssistantMessageFrames}`, `src/utils/diagnostics.ts`, provider diagnostic creation.

ICE tool arguments/details use permissive types; Pi restricts arguments to JSON, statically checks tool-result details for JSON compatibility, and adds bounded nested tool call records used by codemode. Runtime/session callers must serialize details rather than persisting executable or non-JSON values. Diagnostics use `JsonObject`, with optional fields omitted instead of inserting `undefined`.

Pi stores exact provider thinking effort on assistant messages and exposes compact replayable frames: start, text/thinking deltas and tool argument checkpoints/finalization. Frames copy signatures/namespaces and avoid duplicating deltas when queued events refer to an already advanced mutable accumulator. The reducer rejects bad indexes/order/block types and reconstructs partial progress; terminal settlement remains separately authoritative.

Tests: `test/assistant-message-frame.test.ts`, `test/message-types.test.ts`, `test/pre-generation-error.test.ts`. Coordinate replicated/durable session consumers, but do not replace ICE's existing authoritative agent loop/session store. ICE custom typed result details will need explicit JSON adapters.

## AI-06 — P1: Anthropic effort continuity, fallback usage and federation

Status: missing. Commits `4e69b0c2`, `1283afd0`, `b7f4b05c`, `fde38ed7`, `4809c2ab`, `eb1f87fa`, `ed867e90`, `a9424cd4`, `7a11fe1c`; SDK shift is a prerequisite.

Files/symbols: `src/api/anthropic-messages.ts::{PiAnthropic,getAnthropicFederation,createClient,getBetaFeatures,buildParams,insertThinkingLevelMessages,convertMessages,mapStopReason}`, `src/providers/anthropic.ts`, `src/env-api-keys.ts`, `scripts/generate-models.ts::{supportsAnthropicMidConvoEffort,applyAnthropicAllowedFallbackModelMetadata}`. Pi class should keep ICE branding when integrated.

ICE sets current adaptive effort globally but does not carry per-assistant native effort. Pi compatible models always use adaptive thinking, the binding beta with `prefix_mismatch_behavior:"drop_block"`, a stable top-level high output config, historical per-assistant system effort updates and a current final effort update. It gates verified provider/model support (including known OpenRouter Opus 5 exclusion) rather than assuming every Anthropic-compatible route supports betas. Preserve thinking through supported renamed model identities and allow unsigned OpenCode Qwen 3.8 Flash where metadata explicitly permits it.

Pi uses SDK beta message types and sends configured beta feature overrides case-insensitively, including null suppression. Server fallback metadata provides exact allowed provider/model/cost tuples. The parser records concrete response model, calculates fallback-model usage/cost, preserves refusal failures and input-transformation diagnostics, and rejects unsupported mid-output fallback. ICE startup-only fallback and subagent route fingerprints need reconciliation with this server fallback; metadata cannot widen approved child routes implicitly.

Federation is only for first-party Anthropic with no resolved key or authorization header and complete explicit federation configuration. A specialized SDK client disables implicit SDK credential-chain resolution for ordinary header-owned auth. One cached client per federation configuration/fetch shares short-lived token cache. Keep credential expansion subject to ICE policy; do not activate an ambient SDK chain behind `Models` auth.

Tests: `test/anthropic-mid-conversation-effort.test.ts`, `test/anthropic-thinking-binding-e2e.test.ts` (live, optional), `test/anthropic-federation.test.ts`, `test/anthropic-federation-sdk.test.ts`, `test/anthropic-sse-parsing.test.ts`, `test/anthropic-auth-token.test.ts`, `test/anthropic-empty-thinking-signature-compat.test.ts`, `test/anthropic-adaptive-thinking-models.test.ts`. Never use the live test without explicit scope/auth approval.

## AI-07 — P1: Bedrock encrypted reasoning, real response headers and stale Claude thinking

Status: missing. Commits `d57e531f`, `98145a6c`, `10acee60`, `8a7b0c03`, `69f0be6f`, `4665fafb`.

Files/symbols: `src/api/bedrock-converse-stream.ts::{handleContentBlockDelta,flushRedactedContent,finalizeStreamingBlock,convertMessages,addResponseHeadersMiddleware,sanitizeBedrockDocument,buildAdditionalModelRequestFields,handleMetadata}`, `scripts/generate-models.ts` Bedrock cost extraction.

ICE discards `reasoningContent.redactedContent`. Pi buffers encrypted byte chunks, exposes a redacted placeholder, base64 encodes opaque replay data in `thinkingSignature`, removes scratch buffers on block stop AND every terminal path, and restores `redactedContent` bytes on the next turn. Malformed persisted base64 is safely dropped. Pi also strips empty document object keys recursively before AWS tool-input encoding.

Pi captures all raw Smithy response headers before stream consumption, falling back to modeled metadata only if no raw response was seen. Cache details identify one-hour writes. Supported newer Claude models receive thinking-binding beta/drop-stale-block configuration; older models and GovCloud omit unsupported fields. Catalog generation preserves models.dev context pricing tiers for Bedrock rather than flattening them.

Tests: `test/bedrock-redacted-reasoning.test.ts`, `test/bedrock-convert-messages.test.ts`, `test/bedrock-response-headers.test.ts`, `test/bedrock-cache-write-1h-cost.test.ts`, `test/bedrock-thinking-payload.test.ts`, `test/bedrock-error-metadata.test.ts`. Preserve ICE output authority and custom signed-header filtering.

## AI-08 — P1: Completions structured reasoning, reasoning budgets and direct sampling defaults

Status: missing for listed fixes; generic sampling is already present in ICE. Commits `d07889da`, `b2374126`, `4ca636c5`, `b7bb00b9`, `c5ad7c1b`, `7aab6c26`, `256f6302`, `c185d412`, `b647d187`, `d3ab2af9`, `1b6ddca8`, `c01f687e`, `76dfb88f`.

Files/symbols: `src/api/openai-completions.ts::{appendOpenAIReasoningDetail,parseOpenAIReasoningDetails,convertMessages,buildParams,detectCompat,resolveThinkingTokenBudgetField,resolveClampedThinkingBudget}`, `src/api/simple-options.ts::{resolveSamplingParams,thinkingBudgetForLevel,clampThinkingBudgetToAnswerRoom}`, `src/types.ts::{ThinkingTokenBudgetField,SamplingParamsByThinkingLevel}`, Azure/Responses `buildParams`.

ICE stores encrypted Completions reasoning on tool calls only; Pi accepts summary/text/encrypted `reasoning_details`, merges consecutive text/summary deltas, serializes once at thinking finalization, preserves on error, and replays structured details rather than using arbitrary signature strings as request field names. It recognizes safe raw fields only. Existing legacy encrypted entries can still be read by Pi; retaining that old compatibility in ICE requires a product decision per local no-legacy rules.

Reasoning budgets support three top-level field names or `$var:"thinking.budget"` in templates, independent of provider reasoning format. Clamp against response ceiling leaving 1,024 answer tokens. Add `vllmPriority` scheduling metadata. DeepSeek URL detection is case-insensitive and uses supported `max_tokens`; Kimi usage recognizes top-level `cached_tokens`; Completions drops empty multimodal text parts.

Model defaults already merge in ICE simple calls. Pi additionally applies defaults in direct `stream()`/`complete()` adapters and overlays sampling by EFFECTIVE clamped thinking level: base model -> per-level model -> per-request overrides. This applies to Completions/Responses/Azure; do not indiscriminately force arbitrary sampling onto other APIs.

Tests: `test/openai-completions-reasoning-details.test.ts`, `test/openai-completions-thinking-token-budget.test.ts`, `test/openai-completions-vllm-priority.test.ts`, `test/sampling-options.test.ts`, `test/total-tokens.test.ts`, `test/openai-completions-thinking-as-text.test.ts`, `test/openai-completions-tool-result-images.test.ts`. ICE custom thinking formats and `thinkingCanDisable` are additional behavior, not upstream deficits: preserve them while applying shared fixes. Reapply hard output authority after sampling and `onPayload` overrides.

## AI-09 — P1: native Mistral transport and streamed tool-chunk correctness

Status: missing. Commits `9dd90a49`, `6c87d9a0`, `96617628`, `4bd3f48d`, `8930b9ec`, `dc84c1ac`.

File: `src/api/mistral-conversations.ts::{requestMistralStream,readMistralEvents,toMistralWirePayload,buildMistralHeaders,consumeChatStream,streamSimple}`; dependency removes `@mistralai/mistralai`.

ICE uses Mistral SDK camel-case request/events; Pi sends native HTTP via configurable fetch, maps public camel-case payload fields to snake-case wire fields (nested message/content and response-format fields included), exposes response callbacks, cancels the reader on abort and enforces request/stream timeout. SSE supports CR/LF variants, multi-line data and EOF residual frames. Mistral tool-call chunks key on index when present so a later chunk with no ID joins its original call. Empty text deltas do not split reasoning into invalid replay blocks.

Thinking-level maps determine `reasoning_effort`; models without effort metadata use `prompt_mode`. Preserve lower/medium/max and explicit off values, instead of hardcoding a few Mistral IDs or reducing every request to high. New strict-tool normalization and transcript changes are prerequisites.

Tests: `test/mistral-http-transport.test.ts`, `test/mistral-reasoning-mode.test.ts`, `test/mistral-raw-stop-reason.test.ts`. Hazard: ICE uses independent `promptCacheKey` for BOTH payload affinity and `x-affinity`; upstream uses sessionId only. Preserve ICE cache/session separation and case-insensitive caller header/null precedence in the new native transport. Reapply hard output authority at the public camel-case payload and final wire boundary.

## AI-10 — P1: Google thinking metadata and stop semantics

Status: missing. Commits `af2c3522`, `aa50fe77`, `16235fd9`, `5093641a`, plus SDK addition `4a6ed019`.

Files/symbols: `src/api/google-shared.ts::{resolveGoogleThinkingLevel,usesGoogleThinkingLevel,toGoogleSdkThinkingLevel,getDisabledGoogleThinkingConfig,mapStopReason}`, `google-generative-ai.ts`, `google-vertex.ts`, generator `processGoogleModels`.

ICE hardcodes Gemini-family discrete effort decisions. Pi resolves mapped effort metadata, omits unsupported levels, distinguishes discrete-level models from budget models, and selects the lowest valid mapped level when off is unsupported. Shared logic handles Gemma 4 and current flash aliases. Vertex generation excludes non-Gemini MaaS models and obsolete preview aliases from the Gemini SDK path. Google length stops stay `length` even when a tool call occurred; `TOO_MANY_TOOL_CALLS` maps to error rather than unknown stop. Existing signed-empty-block/image routing behavior predates the base and is already present; do not present those tests as new features.

Tests: `test/google-thinking-level-map.test.ts`, `test/google-raw-stop-reason.test.ts`, `test/google-shared-signed-empty-blocks.test.ts`, `test/google-shared-gemini3-unsigned-tool-call.test.ts`, `test/google-shared-image-tool-result-routing.test.ts`, `test/google-vertex-api-key-resolution.test.ts`. Preserve ICE `ultra` clamping and output/thinking-budget authority.

## AI-11 — P1: provider event observation, affinity, caching and accounting

Status: missing, except ICE independent cache affinity is ahead of upstream. Commits `002fc838`, `87af49de`, `9d2ec7ff`, `561a2e06`, `bbb61e34`, `6671c604`, `3955b27a`, `667fc3dd`, `a6ca8610`, `c596d09d`.

Files: `src/types.ts::StreamOptions.onProviderStreamEvent`, all stream adapters, `src/providers/opencode-headers.ts::withOpenCodeSessionHeader`, `src/utils/pi-user-agent.ts` (adapt branding), provider factories and generator `applyPromptCacheMetadata`.

Pi exposes each parsed native provider event to an explicit read-only observer before normalization. Codex observer failures are classified non-transport errors so they do not trigger WebSocket retry or SSE fallback. Propagate callbacks through simple options and agent extension bridges. Existing `onResponse` alone does not provide this feature.

Add case-insensitive `x-opencode-session` routing for OpenCode Zen/Go unless caller explicitly supplies/suppresses it. OpenRouter affinity is enabled by default on Completions and Anthropic with OpenRouter header format; Baseten gets explicit affinity metadata. Kimi and adapters use current shared application user-agent; Claude OAuth's service identity/version must remain service-compatible.

Pi permits unsigned thinking replay for Vercel AI Gateway; detects one-hour cache writes in Anthropic deltas and Bedrock usage details; prices OpenAI `fast` like `priority`. Explicit OpenAI cache-capable models use `prompt_cache_options` for long retention (30m), rather than unsupported older retention fields. Direct Anthropic metadata advertises known cache lifetimes (short 300 sec, long 3600 sec) to allow opt-in warming in coding-agent; do not assume proxy or OpenAI expiry behavior.

Tests: `test/openai-completions-provider-stream-event.test.ts`, `test/opencode-provider-headers.test.ts`, `test/cache-retention.test.ts`, `test/anthropic-cache-write-1h-cost.test.ts`, `test/bedrock-cache-write-1h-cost.test.ts`, `test/total-tokens.test.ts`, `test/telemetry-options.test.ts`.

## AI-12 — P1/P2: OAuth callback safety, Copilot login and new auth choices

Status: partial for existing callback/device flows; missing for shared server, login metadata, new providers and fixes. Commits `4df15743`, `7a11fe1c`, `b73412a3`, `02eed88f`, `eeac84ca`, `14cc26e8`, `b3edf017`, `d5278eaa`, `086c32e7`, `55b0db4d`.

Files: new `src/auth/oauth/callback-server.ts::{startOAuthCallbackServer,waitForCallbackOrManualInput}`, existing Anthropic/Codex/OpenRouter/Radius login modules, `src/utils/oauth-page.ts` (moved from auth/oauth), `src/utils/sleep.ts`, `src/auth/{helpers,types}.ts`, OAuth loaders/Bun registration/dev CLI; new `auth/oauth/{meta,openai-chatgpt}.ts`, `providers/{meta,openai}.ts`.

Shared server validates request/path/state, claims a callback once, distinguishes provider/exchange errors, supports cancellation/timeouts, and races manual code safely. Anthropic adds copy-code headless login. Radius now performs token exchange before reporting browser success. Codex retains manual redirect fallback on occupied port. Shared server's full reuse/cancellation behavior needs targeted tests after adapting ICE environment names.

Copilot currently tries every static policy in concurrent POSTs. Pi discovers account model state first, allows a narrowly scoped Individual-account enabled-policy fallback when picker flags are empty, accepts only known unconfigured policy models, enables sequentially with bounded 429 retries, and stops an exhausted rate-limit batch. Login model discovery retries within a bounded budget; refresh does not add that retry budget. It returns observed available + successfully enabled IDs, not unproven static availability.

`OAuthAuth.isSubscription` distinguishes real subscription identity from arbitrary OAuth. `LoginOptions.getDeviceId` supplies a stable installation UUID lazily. New OpenAI provider login registers a dynamic public client, validates callback state/issued client ID/token fields/scopes, exchanges a direct Responses token, and refreshes with the issued ID; it is distinct from Codex OAuth. Port 1455 occupied fails clearly and spare connections are closed after completion. Responses omits unsupported temperature/output/cache fields for direct ChatGPT tokens and explains subscription usage-limit exhaustion. ICE hardMaxOutputTokens + this unsupported max-output route needs an explicit capability policy: failing closed is preferable to silently dropping an approved output bound.

Meta uses RFC8628 identity-token login then mints a short-lived API key; OAuth refresh remints that key. Invalid identity token requires login again, and browser action URLs are http(s)-validated. It is optional provider capability, not credential expansion for children.

Tests: `test/oauth-callback-server.test.ts`, `test/anthropic-oauth.test.ts`, `test/openai-codex-oauth.test.ts`, `test/openrouter-oauth.test.ts`, `test/radius-oauth.test.ts`, `test/github-copilot-oauth.test.ts`, `test/meta-oauth.test.ts`, `test/openai-chatgpt-oauth.test.ts`, `test/openai-responses-chatgpt-sign-in.test.ts`, `test/openai-responses-usage-limit.test.ts`, `test/oauth-auth.test.ts`. Coordinate persisted device ID with settings/runtime; do not substitute transient UUIDs in the real application.

## AI-13 — P1/P2: unified chat/image/classifier models and operations

Status: missing. Commits `a328aa89`, `a7d17e39`, `33e20335`, `04efdfc3`, `89a5c7bd`, `4812cb26`; core infrastructure must precede optional integrations.

Files/symbols: `src/types.ts::{AnyModel,ModelType,ImageModel,ClassifierModel,ClassifierContext,ClassifierResult}`, `src/models.ts::{createProvider,Models,getAllModels,getModelsOfType,getAvailableOfType,generateImages,classify}`, `src/models-store.ts`, `src/model-catalog.ts`, `src/utils/{model-operations,models-error}.ts`, `src/providers/all.ts`, old image entrypoints, all catalog shards and generator; new TypeSafe/System One/Cloudflare/llama.cpp APIs.

ICE has a separate `ImagesModels` collection and dedicated OpenRouter image provider/catalog. Pi has one auth/model/provider collection with chat/image/classifier dispatch and type-specific lookup. One upstream ID can exist per operation; identity is `(type,provider,id)`, and dynamic overlays merge by `(type,id)`. Chat getters stay chat-only; `getAll*` enumerates all. Unknown persisted future model types are filtered rather than treated as chat. Invalid operation/model combinations return typed error results; image/classifier operations do not throw through the public result contract. `ModelsError` moves to a lightweight utility to avoid auth dependency graphs.

OpenRouter now owns native Anthropic + Completions chat APIs, image generation and System One classifiers under the same provider auth. TypeSafe, Vercel, OpenCode and Cloudflare Workers AI expose lazy classifiers. System One validates typed choice/score/bool answers, confidence/probabilities and usage/cost; models have classifier-specific limits rather than fake chat maxTokens. llama.cpp classifier uses local `/tokenize`, `/apply-template`, `/completion` next-token probabilities, validates single-token labels, applies temperature/normalization and returns per-question typed answers. Cloudflare Clef expands classifier catalogs through Workers AI System One.

Old `src/images-models.ts`, `src/providers/openrouter-images.ts`, `src/image-models.generated.ts` and `scripts/generate-image-models.ts` are removed upstream because the capability is consolidated. This is intentional functionality relocation, not a suggestion to delete images. Local AGENTS requires asking before removing intentional code, and these exports need a concrete migration plan for ICE callers. Do not add parallel ICE registries; use the upgraded native `Models` seam.

Tests: `test/model-types.test.ts`, `test/classifier-models.test.ts`, `test/models-runtime.test.ts`, `test/images-models.test.ts` (rewritten around unified API), `test/images.test.ts`, `test/typesafe-system-one.test.ts`, `test/cloudflare-workers-ai-system-one.test.ts`, `test/llama-cpp-classify.test.ts`, `test/providers.test.ts`, `test/openrouter-images.test.ts`. Coordinate coding-agent provider registration/custom config/remote model catalog and SDK `ModelRuntime` image/classifier operations.

## AI-14 — P1: model catalog generation and exact metadata refresh

Status: missing for generator infrastructure and changed built-in overrides; ICE's dynamic local catalog is intentionally separate and must remain authoritative for exact endpoint metadata. Commits include `650e7a61`, `87205484`, `3de00332`, `c03d78bd`, `265a3339`, `6db110e6`, `0e4d4954`, `b9497c8c`, `22940a62`, `6b94ae2e`, `1e4fbe38`, `bb0f4aa6`, `e4ce7b44`, `4d38031f`, `7d8ab31a`, `69afa105`, `70e878d4`, `c10bfb0d`, `4665fafb`, `f5c94648`, `12c416e1`, `db91e033`, `17de82d7`, `b4588f26`, `c90d9ea5`, `1a584a7a`, `28fd5908`, `28eaccb8`.

Files/symbols: `scripts/generate-models.ts`, new `scripts/{openrouter-catalog,openrouter-reasoning-options,hydrate-model-catalog}.ts`, `scripts/model-data.ts`, `src/model-catalog.ts`, generated provider shards + `src/models.generated.ts`.

Update provider-specific *logic*, not just the list of names: derive OpenRouter effort metadata instead of assuming generic reasoning support; use Chinese Z.AI coding-plan source independently of global source; derive Z.AI/Qwen/DeepSeek effort/toggle support; Qwen Individual provider and exact allowlist; exclude deprecated Xiaomi/Fireworks/Qwen preview models; route all Fireworks GLMs via Completions and effort-capable Messages models with adaptive metadata; Baseten GLM text-only + affinity; current Kimi catalog source; preserve Fireworks native effort/thinking; Copilot GPT via Responses and Fable via Anthropic; xAI via Responses; Cloudflare gateway dashed Claude IDs and preserved Workers AI API map; Radius shipped baseline only for the default gateway.

Add current frozen Pi overrides for GPT-6 Astra/Sol/Luna/6.1 Sol, Claude Opus/Sonnet 5.5, Grok 4.7 and correct retired/replaced IDs/pricing on native/proxy catalogs. These are upstream catalog facts at the frozen commit, not assertions about user's dynamic endpoint today. Current ICE generator already contains its earlier Groq Qwen fix; do not duplicate it. Metadata includes native thinking capability/null support, input/output/context limits, context pricing tiers, cache support and later transcript/strict-tool API compatibility. Apply image input metadata `inputLimits` with provider request/image bounds + cache-safe resize defaults (2000px, 4.5 MiB, JPEG quality 80), and propagate endpoint overrides through coding-agent.

Unified model-data schema changes from version 3 to 6; shards group by API and key by `type:id`, flatten separately into chat/image/classifier catalogs. Generated catalog changes in 40+ shards are mostly this common scaffolding and new providers, not 40+ independent missing behavior features. Published catalogs add typed `models.all.json` and per-provider `.all.json` arrays while chat-keyed JSON remains. Exact model-ID checks keep hydration from silently losing types/IDs. Offline `hydrateModelCatalog()` validates staged typed files and writes a deterministic timestamped manifest from a published catalog. Do not fabricate a generated catalog or commit user's endpoint catalog. Update generator first then regenerate through the repo's approved model-data workflow; never hand edit `models.generated.ts`.

Tests: `test/model-data-validation.test.ts`, `test/generate-models-strict.test.ts`, `test/openrouter-reasoning-options.test.ts`, `test/model-catalog-types.test.ts`, `test/image-model-data.test.ts`, `test/fireworks-model-generation.test.ts`, plus provider-specific `*-models.test.ts` (Baseten, Fireworks, Qwen, Xiaomi, Z.AI, Together, supported extended thinking). Global ignored provider JSON hydration may require full generated-data refresh when schema structure changes; a clean upstream clone lacks these ignored artifacts until hydrated.

## AI-15 — P2: additional Cloudflare binding transport

Status: missing. Commits `23002907`, `55adba4f`; final implementation supersedes the early translating shim.

Files/symbols: new `src/api/cloudflare-ai-binding.ts::{AiBinding,createAiBindingFetch,CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`, `src/api/cloudflare.ts` REST constant/export surface, `src/providers/cloudflare-stream.ts` classifier substitution.

Pi supports gateway calls from a pre-authenticated Workers AI binding via the existing `fetch` option. Final wrapper checks and binds `AI.fetch` once and passes request method/headers/body/query/stream unchanged; no competing SDK/transport engine. A sentinel `cf-aig-authorization` satisfies adapters while null Authorization/x-api-key prevents unintended BYOK override. Cloudflare classifier adapters substitute account IDs just like existing chat paths.

Tests: `test/cloudflare-ai-binding.test.ts`, `test/cloudflare-stream.test.ts`, classifier tests. Optional capability; normal ICE local/provider routing does not need to opt into a Workers binding.

## AI-16 — P1/P2: shared utilities and entry/dependency alignment

Status: missing for listed logic, intentionally divergent for TypeScript compiler choice and ICE identity.

* `src/utils/event-stream.ts`: `b2602be7` replaces repeated array `shift()` queues with two-stack FIFO queues for amortized constant-time processing of large streamed bursts. Test `test/event-stream.test.ts`.
* `src/utils/node-http-proxy.ts`: `a63fb12c` matches bare/root/subdomain and optional ports in NO_PROXY, including bracketed/unbracketed IPv6, without naive suffix matches. Test `test/node-http-proxy.test.ts`.
* `src/utils/uuid.ts`: `ef378654` accepts exact follower timestamps, validates 48-bit integer time, uses crypto randomness + monotonic sequence, preserves timestamp for supplied followers while ordinary calls resist clock rollback; sequence exhaustion fails explicitly. Test `test/uuid.test.ts`.
* `src/utils/headers.ts`: `a328aa89` merges multiple sources case-insensitively and applies null suppression to all previous casing variants. Shared OAuth/device sleep export + new `utils/sleep.ts` remove duplicate cancellable timers. Keep all cancellation behavior.
* `src/models.ts::streamDeferred`: upstream durable work adds a public deferred streaming operation while `fetchDeferred()` becomes its `.result()` wrapper. Coordinate durable polling worker; ICE currently exposes result fetch only.
* `package.json` exports: `5507d76e` adds `./utils/*`, `ba7d5fbe` adds lightweight `./models` entry avoiding TypeBox/barrel imports. Test `test/models-entry.test.ts` and cross-package entry-graph checks.
* SDK/runtime dependency alignment: Anthropic 0.91.1 -> 0.129.0; Bedrock 3.1048.0 -> 3.1127.0; Google GenAI 1.52.0 -> 2.21.0; Smithy handler 4.7.3 -> 4.12.1; HTTP/HTTPS proxy agents 7.0.2/7.0.6 -> 9.1.0; OpenAI 6.26.0 -> 7.19.0 (`ab30693d`); TypeBox 1.3.7 -> 1.3.27. Mistral SDK removed with AI-09; old direct `@opentelemetry/api` removed (`209bc7b9`). Pi AI depends on the extracted telemetry workspace (`6b461b75`), with `ProviderRequestOptions.telemetryContext` and forwarding through `buildBaseOptions`. Keep traces local and external export opt-in. Do not copy Pi package scope/version into ICE.
* Dev test dependency: Pi vitest 4.1.11 versus ICE 4.1.9 (`8eb2bccf`); AI vitest configuration handles new non-live/auth/mock cases, removes obsolete standalone image registry tests. Root compiler/build changes are covered by the integration worker; `tsgo` vs `tsc` alone is not an AI runtime deficit. Pinned ICE npm 12.0.2 and no lifecycle-script rule still govern installs/checks.

## AI-17 — P0/P1: Responses compatibility and Codex terminal/Off behavior

Status: missing for upstream additions/fixes; ICE has additional stale-continuation recovery to preserve. Commits `b8b873b9`, `64eeb82a`, `e86102f1`, `c3e7bc60`, `0c7bb7c5`.

Files/symbols: `src/types.ts::OpenAIResponsesCompat.supportsMaxOutputTokens`, `src/api/openai-responses.ts::{getCompat,buildParams}`, `src/api/openai-codex-responses.ts::{buildRequestBody,parseSSE,mapCodexEvents}`, `src/api/azure-openai-responses.ts`.

Pi permits explicitly configured Responses providers to omit unsupported `max_output_tokens` (`supportsMaxOutputTokens:false`, default true). ICE currently always sends its output field when requested. This compatibility setting needs the hard output policy decision described below, rather than an unconditional bypass of ICE authority. Native and Azure Responses errors identify the actual provider instead of labeling every route OpenAI.

Codex Off now sends the exact mapped native `off` effort, defaults to `none` when supported, and omits it when `off:null`. ICE supports explicit direct `reasoningEffort:"none"`, but simple Off currently leaves reasoning unspecified and can invoke provider defaults. Pi's SSE decoder flushes at EOF and treats a residual frame as terminated, so a last `response.done` without a trailing blank line is processed. Pi records native `end_turn` as `AssistantMessage.endTurn` for diagnostics only; it does not change authoritative agent control flow. Propagate this metadata through persistence/RPC where intended without turning it into a second stop policy.

Tests: `test/openai-responses-compat.test.ts`, `test/openai-codex-stream.test.ts`, `test/openai-responses-terminal-event.test.ts`, `test/azure-openai-base-url.test.ts`, `test/provider-error-body-regression.test.ts`, `test/xai-responses.test.ts`. Preserve ICE broader invalid-previous-response recovery, per-session/account WebSocket identity, and independent cache key while adopting the decoder and request fixes.

## Already present and intentional ICE deltas

Do not count pre-base features as missing: provider-owned auth + model runtime, locked refresh cancellation, deferred fetch/cancel APIs, generic samplingParams in simple requests, tool-choice provider option types, existing signed-empty Google replay, session-resource Codex socket cleanup/account isolation, grammar tools, and stream protocol error handling already exist in ICE.

Upstream simple tool choice (`e5dde9a7`) and Azure forwarding (`9117326b`) are **partial/already backported**: ICE `SimpleStreamOptions.toolChoice` is `auto|none`, `buildBaseOptions()` carries it, and `AzureOpenAIResponsesOptions` + `buildParams()` forward `tool_choice`. Existing individual adapter implementation must be checked after transcript migration, but these are not missing wholesale.

ICE-only deltas visible in AI require preservation/explicit product decisions: `ThinkingLevel="ultra"`; `StreamOptions.promptCacheKey` separate from session identity in OpenAI/Azure/Codex/Mistral/Faux; `hardMaxOutputTokens` clamps before and after sampling/onPayload overrides; finalization tool-choice authority; endpoint `serviceTiers`; expanded local thinking formats and `thinkingCanDisable`; continuation diagnostics and pre-start-only stale-previous-response retry; broader Codex `invalid_request_error/previous_response_id` recovery; explicit empty provider-env overrides; external Radius service identities remain actual registered identities; branding/environment vars/public protocol IDs intentionally use ICE. Upstream final files would remove several of these if replaced verbatim.

Hazard requiring a concrete design decision: Pi's ChatGPT direct and some `supportsMaxOutputTokens:false` routes deliberately omit output caps, while ICE promises hard output authority. Account for capability metadata and fail closed where the provider cannot enforce the approved authority. Do not let per-request sampling or onPayload widen bound. Pi `ultra` is absent; do not remove ICE support by copying upstream enums/unions/maps.

## Verification plan after actual implementation

No tests were run in this audit. Each implementation cluster should port/adapt its deterministic mock/faux-provider tests from frozen upstream, add only necessary regressions for ICE seams, run changed targeted files from the AI package root with `node ../../node_modules/vitest/dist/cli.js --run test/<specific>.test.ts`, and run `corepack npm@12.0.2 run check` with full output. Never run blanket vitest: existing live tests can activate with auth env. Avoid build/npm test unless requested by the implementation task. Generation/hydration needs schema-aware catalog artifacts, not guessed provider responses.

The following inventory exhaustively names upstream-changed source/script paths, including generated scaffolding and upstream removals. Its statuses describe file provenance/difference only; the clusters above supply the semantic interpretation.


## Complete upstream-changed AI source/script inventory

| Upstream path relative to packages/ai | File provenance | Semantic cluster |
|---|---|---|
| `scripts/generate-image-models.ts` | exists in ICE; deleted/consolidated upstream | AI-14 catalog generator |
| `scripts/generate-models.ts` | ICE fork edits plus upstream edits | AI-14 catalog generator |
| `scripts/hydrate-model-catalog.ts` | new upstream path absent in ICE | AI-14 catalog generator |
| `scripts/model-data.ts` | same as shared base | AI-14 catalog generator |
| `scripts/openrouter-catalog.ts` | new upstream path absent in ICE | AI-14 catalog generator |
| `scripts/openrouter-reasoning-options.ts` | new upstream path absent in ICE | AI-14 catalog generator |
| `src/api/anthropic-messages.ts` | ICE fork edits plus upstream edits | AI-02/04/06/11 Anthropic |
| `src/api/azure-openai-responses.ts` | ICE fork edits plus upstream edits | AI-01/02/04/08/11 Responses/Completions |
| `src/api/bedrock-converse-stream.ts` | ICE fork edits plus upstream edits | AI-02/04/07/11 Bedrock |
| `src/api/cloudflare-ai-binding.ts` | new upstream path absent in ICE | AI-15 Cloudflare |
| `src/api/cloudflare-workers-ai-system-one.lazy.ts` | new upstream path absent in ICE | AI-13 image/classifier adapters |
| `src/api/cloudflare-workers-ai-system-one.ts` | new upstream path absent in ICE | AI-13 image/classifier adapters |
| `src/api/cloudflare.ts` | same as shared base | AI-15 Cloudflare |
| `src/api/constrained-sampling.ts` | same as shared base | AI-02 schema conversion/validation |
| `src/api/google-generative-ai.ts` | ICE fork edits plus upstream edits | AI-02/04/10/11 Google |
| `src/api/google-shared.ts` | same as shared base | AI-02/04/10/11 Google |
| `src/api/google-vertex.ts` | ICE fork edits plus upstream edits | AI-02/04/10/11 Google |
| `src/api/llama-cpp-classify.lazy.ts` | new upstream path absent in ICE | AI-13 image/classifier adapters |
| `src/api/llama-cpp-classify.ts` | new upstream path absent in ICE | AI-13 image/classifier adapters |
| `src/api/mistral-conversations.ts` | ICE fork edits plus upstream edits | AI-02/04/09/11 Mistral |
| `src/api/openai-codex-responses.ts` | ICE fork edits plus upstream edits | AI-01/02/04/08/11 Responses/Completions |
| `src/api/openai-completions.ts` | ICE fork edits plus upstream edits | AI-01/02/04/08/11 Responses/Completions |
| `src/api/openai-responses-shared.ts` | ICE fork edits plus upstream edits | AI-01/02/04/08/11 Responses/Completions |
| `src/api/openai-responses.ts` | ICE fork edits plus upstream edits | AI-01/02/04/08/11 Responses/Completions |
| `src/api/openrouter-images.lazy.ts` | same as shared base | AI-13 image/classifier adapters |
| `src/api/openrouter-images.ts` | same as shared base | AI-13 image/classifier adapters |
| `src/api/pi-messages.ts` (ICE: src/api/ice-messages.ts) | ICE fork edits plus upstream edits | AI-04 transcript migration |
| `src/api/simple-options.ts` | ICE fork edits plus upstream edits | AI-08 options/sampling |
| `src/api/system-one-shared.ts` | new upstream path absent in ICE | AI-13 image/classifier adapters |
| `src/api/transform-messages.ts` | same as shared base | AI-04 transcript migration |
| `src/api/typesafe-system-one.lazy.ts` | new upstream path absent in ICE | AI-13 image/classifier adapters |
| `src/api/typesafe-system-one.ts` | new upstream path absent in ICE | AI-13 image/classifier adapters |
| `src/auth/helpers.ts` | same as shared base | AI-06/12/13 auth and login |
| `src/auth/oauth/anthropic.ts` | ICE fork edits plus upstream edits | AI-06/12/13 auth and login |
| `src/auth/oauth/callback-server.ts` | new upstream path absent in ICE | AI-06/12/13 auth and login |
| `src/auth/oauth/device-code.ts` | same as shared base | AI-06/12/13 auth and login |
| `src/auth/oauth/github-copilot.ts` | same as shared base | AI-06/12/13 auth and login |
| `src/auth/oauth/kimi-coding.ts` | same as shared base | AI-06/12/13 auth and login |
| `src/auth/oauth/load.ts` | same as shared base | AI-06/12/13 auth and login |
| `src/auth/oauth/meta.ts` | new upstream path absent in ICE | AI-06/12/13 auth and login |
| `src/auth/oauth/openai-chatgpt.ts` | new upstream path absent in ICE | AI-06/12/13 auth and login |
| `src/auth/oauth/openai-codex.ts` | ICE fork edits plus upstream edits | AI-06/12/13 auth and login |
| `src/auth/oauth/openrouter.ts` | ICE fork edits plus upstream edits | AI-06/12/13 auth and login |
| `src/auth/oauth/radius.ts` | ICE fork edits plus upstream edits | AI-06/12/13 auth and login |
| `src/auth/oauth/xai.ts` | ICE fork edits plus upstream edits | AI-06/12/13 auth and login |
| `src/auth/resolve.ts` | same as shared base | AI-06/12/13 auth and login |
| `src/auth/types.ts` | same as shared base | AI-06/12/13 auth and login |
| `src/bun-oauth.ts` | same as shared base | AI-06/12/13 auth and login |
| `src/cli.ts` | same as shared base | AI-06/12/13 auth and login |
| `src/compat.ts` | ICE fork edits plus upstream edits | AI-04 transcript migration |
| `src/env-api-keys.ts` | same as shared base | AI-06/13 provider auth constants |
| `src/image-models.generated.ts` | exists in ICE; deleted/consolidated upstream | AI-13/14 catalog scaffolding |
| `src/image-models.ts` | same as shared base | AI-13 unified model runtime |
| `src/images-api-registry.ts` | same as shared base | AI-13 unified model runtime |
| `src/images-models.ts` | exists in ICE; deleted/consolidated upstream | AI-13 unified model runtime |
| `src/images.ts` | same as shared base | AI-13 unified model runtime |
| `src/index.ts` | ICE fork edits plus upstream edits | AI-01..16 shared types/exports |
| `src/model-catalog.ts` | same as shared base | AI-13 unified model runtime |
| `src/models-store.ts` | same as shared base | AI-13 unified model runtime |
| `src/models.generated.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/models.ts` | ICE fork edits plus upstream edits | AI-13 unified model runtime |
| `src/providers/all.ts` | same as shared base | AI-06/11/12/13/14/15 provider integration |
| `src/providers/amazon-bedrock.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/ant-ling.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/anthropic.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/anthropic.ts` | same as shared base | AI-06/11/12/13/14/15 provider integration |
| `src/providers/azure-openai-responses.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/baseten.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/cerebras.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/cloudflare-ai-gateway.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/cloudflare-ai-gateway.ts` | ICE fork edits plus upstream edits | AI-06/11/12/13/14/15 provider integration |
| `src/providers/cloudflare-stream.ts` | same as shared base | AI-06/11/12/13/14/15 provider integration |
| `src/providers/cloudflare-workers-ai.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/cloudflare-workers-ai.ts` | same as shared base | AI-06/11/12/13/14/15 provider integration |
| `src/providers/deepseek.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/faux.ts` | ICE fork edits plus upstream edits | AI-06/11/12/13/14/15 provider integration |
| `src/providers/fireworks.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/github-copilot.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/github-copilot.ts` | same as shared base | AI-06/11/12/13/14/15 provider integration |
| `src/providers/google-vertex.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/google.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/groq.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/huggingface.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/images/register-builtins.ts` | same as shared base | AI-06/11/12/13/14/15 provider integration |
| `src/providers/kimi-coding.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/kimi-coding.ts` | same as shared base | AI-06/11/12/13/14/15 provider integration |
| `src/providers/meta.models.ts` | new upstream path absent in ICE | AI-13/14 catalog scaffolding |
| `src/providers/meta.ts` | new upstream path absent in ICE | AI-06/11/12/13/14/15 provider integration |
| `src/providers/minimax-cn.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/minimax.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/mistral.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/moonshotai-cn.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/moonshotai.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/nvidia.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/openai-codex.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/openai-codex.ts` | same as shared base | AI-06/11/12/13/14/15 provider integration |
| `src/providers/openai.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/openai.ts` | same as shared base | AI-06/11/12/13/14/15 provider integration |
| `src/providers/opencode-go.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/opencode-go.ts` | same as shared base | AI-06/11/12/13/14/15 provider integration |
| `src/providers/opencode-headers.ts` | new upstream path absent in ICE | AI-06/11/12/13/14/15 provider integration |
| `src/providers/opencode.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/opencode.ts` | same as shared base | AI-06/11/12/13/14/15 provider integration |
| `src/providers/openrouter-images.ts` | exists in ICE; deleted/consolidated upstream | AI-06/11/12/13/14/15 provider integration |
| `src/providers/openrouter.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/openrouter.ts` | same as shared base | AI-06/11/12/13/14/15 provider integration |
| `src/providers/qwen-token-plan-cn.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/qwen-token-plan-individual.models.ts` | new upstream path absent in ICE | AI-13/14 catalog scaffolding |
| `src/providers/qwen-token-plan-individual.ts` | new upstream path absent in ICE | AI-06/11/12/13/14/15 provider integration |
| `src/providers/qwen-token-plan.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/radius.models.ts` | new upstream path absent in ICE | AI-13/14 catalog scaffolding |
| `src/providers/radius.ts` | ICE fork edits plus upstream edits | AI-06/11/12/13/14/15 provider integration |
| `src/providers/together.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/typesafe.models.ts` | new upstream path absent in ICE | AI-13/14 catalog scaffolding |
| `src/providers/typesafe.ts` | new upstream path absent in ICE | AI-06/11/12/13/14/15 provider integration |
| `src/providers/vercel-ai-gateway.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/vercel-ai-gateway.ts` | same as shared base | AI-06/11/12/13/14/15 provider integration |
| `src/providers/xai.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/xai.ts` | same as shared base | AI-06/11/12/13/14/15 provider integration |
| `src/providers/xiaomi-token-plan-ams.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/xiaomi-token-plan-cn.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/xiaomi-token-plan-sgp.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/xiaomi.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/zai-coding-cn.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/providers/zai.models.ts` | same as shared base | AI-13/14 catalog scaffolding |
| `src/types.ts` | ICE fork edits plus upstream edits | AI-01..16 shared types/exports |
| `src/utils/assistant-message-frame.ts` | new upstream path absent in ICE | AI-05 frames/JSON |
| `src/utils/deferred-tools.ts` | exists in ICE; deleted/consolidated upstream | AI-04 transcript migration |
| `src/utils/diagnostics.ts` | same as shared base | AI-05 frames/JSON |
| `src/utils/estimate.ts` | same as shared base | AI-04 transcript migration |
| `src/utils/event-stream.ts` | same as shared base | AI-03/11/16 utility fixes |
| `src/utils/headers.ts` | same as shared base | AI-03/11/16 utility fixes |
| `src/utils/model-operations.ts` | new upstream path absent in ICE | AI-13 unified model runtime |
| `src/utils/models-error.ts` | new upstream path absent in ICE | AI-13 unified model runtime |
| `src/utils/node-http-proxy.ts` | same as shared base | AI-03/11/16 utility fixes |
| `src/utils/oauth-page.ts` | new upstream path absent in ICE | AI-03/11/16 utility fixes |
| `src/utils/overflow.ts` | same as shared base | AI-03/11/16 utility fixes |
| `src/utils/pi-user-agent.ts` (ICE: src/utils/ice-user-agent.ts) | new upstream path absent in ICE | AI-03/11/16 utility fixes |
| `src/utils/provider-retry.ts` | same as shared base | AI-03/11/16 utility fixes |
| `src/utils/retry.ts` | same as shared base | AI-03/11/16 utility fixes |
| `src/utils/sleep.ts` | new upstream path absent in ICE | AI-03/11/16 utility fixes |
| `src/utils/text.ts` | same as shared base | AI-04 transcript migration |
| `src/utils/transcript.ts` | new upstream path absent in ICE | AI-04 transcript migration |
| `src/utils/uuid.ts` | same as shared base | AI-03/11/16 utility fixes |
| `src/utils/validation.ts` | same as shared base | AI-02 schema conversion/validation |

The moved OAuth page also has the old `src/auth/oauth/oauth-page.ts` deletion in the parent no-renames inventory; the final location is `src/utils/oauth-page.ts`. Pure page-logo changes are cosmetic. `src/api/pi-messages.ts` maps to ICE `src/api/ice-messages.ts`; `src/utils/pi-user-agent.ts` is a new upstream utility and would use an ICE name.

## Upstream tests changed by path (port with corresponding cluster)

- `test/abort.test.ts`
- `test/anthropic-adaptive-thinking-models.test.ts`
- `test/anthropic-auth-token.test.ts`
- `test/anthropic-cache-write-1h-cost.test.ts`
- `test/anthropic-eager-tool-input-compat.test.ts`
- `test/anthropic-empty-thinking-signature-compat.test.ts`
- `test/anthropic-federation-sdk.test.ts`
- `test/anthropic-federation.test.ts`
- `test/anthropic-mid-conversation-effort.test.ts`
- `test/anthropic-oauth.test.ts`
- `test/anthropic-sse-parsing.test.ts`
- `test/anthropic-strict-tool-schema.test.ts`
- `test/anthropic-thinking-binding-e2e.test.ts`
- `test/assistant-message-frame.test.ts`
- `test/azure-openai-base-url.test.ts`
- `test/azure-openai-responses-reasoning-replay.test.ts`
- `test/azure-openai-tool-choice.test.ts`
- `test/baseten-models.test.ts`
- `test/bedrock-cache-write-1h-cost.test.ts`
- `test/bedrock-convert-messages.test.ts`
- `test/bedrock-custom-headers.test.ts`
- `test/bedrock-error-metadata.test.ts`
- `test/bedrock-raw-stop-reason.test.ts`
- `test/bedrock-redacted-reasoning.test.ts`
- `test/bedrock-response-headers.test.ts`
- `test/bedrock-thinking-payload.test.ts`
- `test/cache-retention.test.ts`
- `test/classifier-models.test.ts`
- `test/cloudflare-ai-binding.test.ts`
- `test/cloudflare-stream.test.ts`
- `test/cloudflare-workers-ai-system-one.test.ts`
- `test/codex-websocket-cached-probe.ts`
- `test/constrained-sampling.test.ts`
- `test/context-estimate.test.ts`
- `test/context-overflow.test.ts`
- `test/cross-provider-handoff.test.ts`
- `test/deferred-tools.test.ts`
- `test/empty.test.ts`
- `test/event-stream.test.ts`
- `test/fetch-option.test.ts`
- `test/fireworks-model-generation.test.ts`
- `test/fireworks-models.test.ts`
- `test/generate-models-strict.test.ts`
- `test/github-copilot-anthropic.test.ts`
- `test/github-copilot-oauth.test.ts`
- `test/google-raw-stop-reason.test.ts`
- `test/google-shared-gemini3-unsigned-tool-call.test.ts`
- `test/google-shared-image-tool-result-routing.test.ts`
- `test/google-shared-signed-empty-blocks.test.ts`
- `test/google-thinking-level-map.test.ts`
- `test/google-vertex-api-key-resolution.test.ts`
- `test/image-model-data.test.ts`
- `test/image-tool-result.test.ts`
- `test/images-models.test.ts`
- `test/images.test.ts`
- `test/lazy-module-load.test.ts`
- `test/llama-cpp-classify.test.ts`
- `test/max-thinking.test.ts`
- `test/message-types.test.ts`
- `test/meta-oauth.test.ts`
- `test/mistral-http-transport.test.ts`
- `test/mistral-raw-stop-reason.test.ts`
- `test/mistral-reasoning-mode.test.ts`
- `test/model-catalog-types.test.ts`
- `test/model-data-validation.test.ts`
- `test/model-types.test.ts`
- `test/models-entry.test.ts`
- `test/models-runtime.test.ts`
- `test/node-http-proxy.test.ts`
- `test/oauth-auth.test.ts`
- `test/oauth-callback-server.test.ts`
- `test/openai-chatgpt-oauth.test.ts`
- `test/openai-codex-oauth.test.ts`
- `test/openai-codex-stream.test.ts`
- `test/openai-completions-cache-control-format.test.ts`
- `test/openai-completions-empty-tools.test.ts`
- `test/openai-completions-prompt-cache.test.ts`
- `test/openai-completions-provider-stream-event.test.ts`
- `test/openai-completions-raw-stop-reason.test.ts`
- `test/openai-completions-reasoning-details.test.ts`
- `test/openai-completions-retry.test.ts`
- `test/openai-completions-thinking-as-text.test.ts`
- `test/openai-completions-thinking-token-budget.test.ts`
- `test/openai-completions-tool-choice.test.ts`
- `test/openai-completions-tool-result-images.test.ts`
- `test/openai-completions-vllm-priority.test.ts`
- `test/openai-responses-chatgpt-sign-in.test.ts`
- `test/openai-responses-compat.test.ts`
- `test/openai-responses-empty-tool-result.test.ts`
- `test/openai-responses-foreign-toolcall-id.test.ts`
- `test/openai-responses-message-id.test.ts`
- `test/openai-responses-namespace.test.ts`
- `test/openai-responses-terminal-event.test.ts`
- `test/openai-responses-usage-limit.test.ts`
- `test/opencode-provider-headers.test.ts`
- `test/openrouter-cache-control-models.test.ts`
- `test/openrouter-images.test.ts`
- `test/openrouter-oauth.test.ts`
- `test/openrouter-reasoning-options.test.ts`
- `test/overflow.test.ts`
- `test/pi-messages.test.ts`
- `test/pre-generation-error.test.ts`
- `test/provider-error-body-passthrough.test.ts`
- `test/provider-error-body-regression.test.ts`
- `test/providers.test.ts`
- `test/qwen-token-plan-models.test.ts`
- `test/radius-oauth.test.ts`
- `test/radius-provider.test.ts`
- `test/retry.test.ts`
- `test/sampling-options.test.ts`
- `test/stream.test.ts`
- `test/supports-xhigh.test.ts`
- `test/system-message-replay.test.ts`
- `test/telemetry-options.test.ts`
- `test/together-models.test.ts`
- `test/tokens.test.ts`
- `test/tool-call-id-normalization.test.ts`
- `test/tool-call-without-result.test.ts`
- `test/total-tokens.test.ts`
- `test/transcript-tool-changes.test.ts`
- `test/typesafe-system-one.test.ts`
- `test/unicode-surrogate.test.ts`
- `test/uuid.test.ts`
- `test/validation.test.ts`
- `test/xai-responses.test.ts`
- `test/xiaomi-models.test.ts`
- `test/zai-coding-plan-models.test.ts`

## Machine path history

The JSON inventory records every affecting commit per changed path, including release/documentation commits which are not implementation recommendations. Each cluster above names the relevant logical commits. Exact full SHAs for abbreviated implementation IDs can be resolved from the frozen clone with `git rev-parse <id>`; avoid rebasing ICE on obsolete intermediate commits.
