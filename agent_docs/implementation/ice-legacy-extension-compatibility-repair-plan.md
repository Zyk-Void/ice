# ICE Legacy Extension Compatibility Repair Plan

- **Workspace:** `/home/mewtwo/Zks/ice/.worktrees/subagent-improvements-mock-test`
- **Branch at planning time:** `subagent-improvements-mock-test`
- **Status:** Ready for implementation
- **Primary source plan:** `agent_docs/implementation/ice-compatibility-preservation-follow-up-plan.md`
- **Scope:** Close the remaining extension/package compatibility gaps identified in C02/C03 and align tests/docs with the intended contract.

## Objective

Restore the compatibility contract that the existing follow-up plan already specifies: unchanged historical Pi extensions from both supported package families must load under ICE through a narrow exact-match adapter, while ICE-native imports remain canonical and unknown Pi-like imports continue to fail.

The final state must also make `package.json#pi` fallback provenance observable to internal callers without merging legacy and ICE manifests, keep installed-package tests optional rather than authoritative, and add deterministic source/build regression coverage so a green suite cannot encode the wrong contract again.

## Scope and non-goals

### In scope

- Support the exact approved legacy extension import families:
  - `@earendil-works/pi-*`
  - `@mariozechner/pi-*`
- Centralize the exact alias inventory under `core/legacy-compat/`.
- Use one alias policy for source/Jiti and Bun virtual-module resolution.
- Replace the current negative Mario test with positive compatibility coverage.
- Add deterministic full-chain `package.json#pi -> extension discovery -> legacy import -> command registration` coverage for both historical families.
- Preserve unknown-subpath rejection and ICE-native canonical behavior.
- Add provenance-aware manifest parsing while preserving the current precedence rule.
- Add bounded/deduplicated legacy-manifest observability only if an existing diagnostic seam can carry it without adding a new logging subsystem.
- Add compiled Node/Bun compatibility verification appropriate to the repository's existing build/release seams.
- Correct changelog/plan wording so documentation matches the implemented contract.

### Explicit non-goals

- Do not rename the current worktree or branch.
- Do not add generic prefix rewriting such as `@mariozechner/pi-* -> @zykairotis/ice-*`.
- Do not publish historical package names from ICE `package.json` files.
- Do not add dependencies on old Pi packages.
- Do not restore legacy CLI entrypoints or other compatibility work outside C02/C03.
- Do not change `.pi` project-resource loading/trust behavior; `runtime-contracts.test.ts:72-99` intentionally keeps `.pi/extensions` out of project execution.
- Do not touch `packages/ai/src/image-models.generated.ts`, `biome.json`, or the current `pi-real-package.test.ts` skip primitive as part of this plan. The current tree does not have an actionable defect in those areas.
- Do not rewrite the loader architecture or add a second extension loader.
- Do not commit, push, merge, publish, or release unless separately requested.

## Current-state evidence

### Contract already requires both historical families

`agent_docs/implementation/ice-compatibility-preservation-follow-up-plan.md:497-556` defines C02 as P0 compatibility work and explicitly lists seven Earendil and seven Mario Zechner exact aliases. It also requires identical Node/Jiti and Bun mappings, unknown-import rejection, built-runtime coverage, and unchanged ICE-native behavior.

`agent_docs/implementation/ice-compatibility-preservation-follow-up-plan.md:1314-1323` requires T09 to test representative imports from **both** historical package families.

`agent_docs/implementation/ice-compatibility-preservation-follow-up-plan.md:1736-1743` lists both Earendil and Mario import compatibility as completion gates.

### Loader currently implements only one family

`packages/coding-agent/src/core/extensions/loader.ts:50-70` embeds `UPSTREAM_PI_ALIASES` directly in the loader and contains only the seven Earendil mappings. The comment at line 60 explicitly says `@mariozechner/pi-*` remains unresolved.

`packages/coding-agent/src/core/extensions/loader.ts:72-94` applies the same Earendil-only mapping onto Bun `VIRTUAL_MODULES`.

`packages/coding-agent/src/core/extensions/loader.ts:120-171` builds the Node/Jiti alias map and applies the same Earendil-only helper, so both runtimes currently share the same incomplete policy.

### A regression test currently asserts the wrong Mario behavior

`packages/coding-agent/test/legacy-compat/extension-imports.test.ts:48-70` positively verifies only the Earendil aliases.

`packages/coding-agent/test/legacy-compat/extension-imports.test.ts:100-114` correctly verifies that an unapproved Earendil subpath is rejected.

`packages/coding-agent/test/legacy-compat/extension-imports.test.ts:116-130` currently imports `@mariozechner/pi-coding-agent` and expects the extension to fail. That directly conflicts with C02/T09.

### Full-chain compatibility coverage is Earendil-only

`packages/coding-agent/test/legacy-compat/pi-manifest-aliases.test.ts:9-16` describes the manifest+alias chain as one compatibility contract, but lines 29-88 exercise only `@earendil-works/*` imports.

### Manifest fallback works functionally but loses provenance

`packages/coding-agent/src/core/ice-manifest.ts:16-38` currently implements the intended precedence:

1. if `ice` exists, use only `ice`;
2. otherwise use `pi`;
3. invalid/null `ice` does not silently fall back.

However the function returns only `IceManifest | null`, while `agent_docs/implementation/ice-compatibility-preservation-follow-up-plan.md:573-592` proposes returning the source (`"ice" | "legacy-pi"`) as well.

`packages/coding-agent/src/core/package-manager.ts` consumes `readIceManifest()` at multiple resource-discovery paths (for example around lines 535, 2156, 2192, and 2261), so any provenance change must avoid unnecessary churn.

### Current manifest regression is already correct

`packages/coding-agent/test/legacy-compat/runtime-contracts.test.ts:62-70` already verifies:

- legacy-only `pi` manifest loads;
- `ice` wins when both are present;
- invalid/null `ice` does not downgrade to `pi`.

This test should be extended for provenance, not rewritten back to the old ICE-only behavior.

### Installed-package tests are optional integration coverage

`packages/coding-agent/test/legacy-compat/pi-real-package.test.ts:8-45` checks three locally installed Pi packages and uses `it.skipIf(!isInstalled(pkg))`. This is valid optional integration coverage but cannot be the sole proof of compatibility because a clean CI environment may skip all three cases.

### Changelog currently overstates completion

`packages/coding-agent/CHANGELOG.md:178-180` says upstream Pi extension loading is fixed for `@earendil-works/pi-*`, but the broader compatibility plan requires both approved historical families.

## Constraints and invariants

1. **One-way compatibility:** old input may be accepted and normalized to ICE; ICE remains the canonical runtime/output identity.
2. **Exact-match only:** only the 14 explicitly approved specifiers are accepted. No wildcard/prefix remapping.
3. **No legacy package publication:** compatibility is a loader adapter, not a package-export strategy.
4. **No dependency on historical packages:** alias targets must be already-bundled/current ICE modules.
5. **Same target object/entrypoint:** legacy aliases must resolve to the exact same ICE module object or built path as the equivalent canonical import.
6. **AI root special case remains:** historical `pi-ai` roots must resolve to the ICE compat entrypoint, matching the existing `@zykairotis/ice-ai` extension behavior (`loader.ts:82-89`, `144-158`).
7. **Unknown imports fail:** unsupported Pi-like package names/subpaths must remain unresolved rather than being guessed.
8. **Manifest precedence is strict:** `ice` wins by presence, even if invalid; do not merge `ice` and `pi` resources.
9. **No project trust widening:** package-manifest compatibility must not cause `.pi` project resources to execute or bypass current trust checks.
10. **No new logging subsystem:** compatibility diagnostics, if added, must reuse an existing bounded diagnostic/event channel. If no appropriate seam exists, provenance in the parser/API is sufficient for this repair and diagnostic fan-out should be deferred explicitly.
11. **Preserve extension cache semantics:** alias refactoring must not change `clearExtensionCache()`, CWD invalidation, factory caching, or reload behavior (`loader.ts:174-197`).
12. **Repository command rules:** after implementation code changes run `corepack npm@12.0.2 run check` if the active npm differs from 12.0.2. Run only focused Vitest files from `packages/coding-agent`; do not run the full test suite. Full build/binary commands remain gated by the repository rule that they require an explicit user request.

## Target design

### 1. Canonical legacy alias table

Create:

`packages/coding-agent/src/core/legacy-compat/extension-aliases.ts`

The module should export a readonly exact mapping from approved historical specifiers to canonical ICE specifiers. It should contain exactly 14 entries:

```text
@earendil-works/pi-agent-core          -> @zykairotis/ice-agent-core
@earendil-works/pi-tui                 -> @zykairotis/ice-tui
@earendil-works/pi-ai                  -> @zykairotis/ice-ai
@earendil-works/pi-ai/compat           -> @zykairotis/ice-ai/compat
@earendil-works/pi-ai/oauth            -> @zykairotis/ice-ai/oauth
@earendil-works/pi-ai/providers/all    -> @zykairotis/ice-ai/providers/all
@earendil-works/pi-coding-agent        -> @zykairotis/ice-coding-agent
@mariozechner/pi-agent-core            -> @zykairotis/ice-agent-core
@mariozechner/pi-tui                   -> @zykairotis/ice-tui
@mariozechner/pi-ai                    -> @zykairotis/ice-ai
@mariozechner/pi-ai/compat             -> @zykairotis/ice-ai/compat
@mariozechner/pi-ai/oauth              -> @zykairotis/ice-ai/oauth
@mariozechner/pi-ai/providers/all      -> @zykairotis/ice-ai/providers/all
@mariozechner/pi-coding-agent          -> @zykairotis/ice-coding-agent
```

Keep the module data-only. Do not make it resolve files, inspect packages, or load modules.

### 2. Loader consumes one policy for both runtimes

`packages/coding-agent/src/core/extensions/loader.ts` should import the table and apply it to the exact `VIRTUAL_MODULES` compatibility map shared by source TypeScript, built Node/Jiti, and Bun. Each historical key must point to the same in-memory module object as its canonical ICE target.

Built Node still needs canonical path aliases for ICE packages, but **historical Pi specifiers must not be inserted into Jiti's `alias` option**. Fresh built-runtime verification established that Jiti treats alias keys as prefixes: putting `@mariozechner/pi-ai` there also rewrites an unapproved import such as `@mariozechner/pi-ai/providers/not-supported`. Historical compatibility therefore belongs in exact virtual-module keys, while the Jiti alias map remains canonical-only.

The generic helper should populate the exact virtual-module map from `LEGACY_PI_EXTENSION_ALIASES`. The implementation must fail fast during development if an alias-table target is absent from the canonical base map; do not silently assign `undefined`.

### 3. Provenance-aware manifest parser without broad call-site churn

Prefer adding a new parser API rather than immediately changing every consumer signature:

```ts
export type CompatibleManifestSource = "ice" | "legacy-pi";

export interface CompatibleManifestResult {
  manifest: IceManifest;
  source: CompatibleManifestSource;
}

export function readCompatibleManifest(packageJsonPath: string): CompatibleManifestResult | null;

export function readIceManifest(packageJsonPath: string): IceManifest | null {
  return readCompatibleManifest(packageJsonPath)?.manifest ?? null;
}
```

This preserves existing package-manager behavior while making provenance available to tests and future diagnostics.

The parser must keep the exact existing precedence semantics:

```text
"ice" in package.json -> parse only ice, source="ice"
else "pi" in package.json -> parse pi, source="legacy-pi"
else -> null
```

If `ice` exists but is malformed/null, return `null`; never fall through to valid `pi`.

### 4. Deterministic contract tests are authoritative

Compatibility correctness must not depend on local npm cache contents. Repository-owned fixtures should cover both families and the manifest chain.

Installed-package tests remain an additional smoke layer only.

## Dependency order

1. Freeze the exact compatibility contract in a reusable alias table and tests.
2. Wire the loader to that table for both runtimes.
3. Convert the Mario negative regression into positive coverage and keep explicit unknown-import failures.
4. Expand full-chain manifest+alias fixtures to both families.
5. Add provenance parser/tests.
6. Add source/built runtime parity checks without changing cache semantics.
7. Align documentation/changelog/status wording.
8. Run focused verification, then repository check.

Stages 3 and 5 can proceed in parallel after Stage 1 because they touch different seams. Build-smoke work should wait until the source-level contract is green.

## Stage 1 — Establish one exact compatibility policy

- [ ] **Create the canonical 14-entry alias table under `core/legacy-compat/`.**
  - Files: new `packages/coding-agent/src/core/legacy-compat/extension-aliases.ts`.
  - Evidence: C02 inventory in `ice-compatibility-preservation-follow-up-plan.md:510-530`; current Earendil-only inline map in `loader.ts:62-70`.
  - Acceptance: the table contains exactly the seven approved Earendil and seven approved Mario specifiers, each targeting the intended canonical ICE specifier; no wildcard or prefix matcher exists.
  - Verify: focused unit/contract test imports the table and compares the exact key/value inventory.

- [ ] **Refactor `loader.ts` to consume the canonical alias table instead of owning policy.**
  - Files: `packages/coding-agent/src/core/extensions/loader.ts`.
  - Acceptance: the exact `VIRTUAL_MODULES` map shared by source, built Node/Jiti, and Bun is augmented from the imported table; Jiti's prefix-based `alias` map remains canonical-only; a missing ICE target still throws a development error.
  - Verify: source import tests, resolution-parity tests, and a fresh built-Node negative subpath test all pass.

- [ ] **Remove obsolete “Mario deliberately unresolved / no-legacy contract” wording.**
  - Files: `packages/coding-agent/src/core/extensions/loader.ts`.
  - Acceptance: comments state the actual invariant: approved historical Pi specifiers are accepted one-way and mapped to canonical ICE modules; unknown Pi-like imports remain unresolved.
  - Verify: search the loader/compat module for `no-legacy contract` and ensure no stale policy statement remains.

## Stage 2 — Correct the source-runtime regression contract

- [ ] **Replace the negative Mario regression with positive table-driven coverage for all 14 aliases.**
  - Files: `packages/coding-agent/test/legacy-compat/extension-imports.test.ts`.
  - Evidence: Earendil positive cases at `:48-70`; contradictory Mario negative case at `:116-130`.
  - Acceptance: each approved legacy specifier loads an extension with zero errors and successfully registers its command.
  - Verify: `node ../../node_modules/vitest/dist/cli.js --run test/legacy-compat/extension-imports.test.ts` from `packages/coding-agent`.

- [ ] **Retain and expand rejection tests for unknown old-like imports.**
  - Files: `packages/coding-agent/test/legacy-compat/extension-imports.test.ts`.
  - Acceptance: at minimum one unsupported Earendil subpath and one unsupported Mario subpath fail resolution; no command registers; the reported error contains the exact unsupported specifier.
  - Verify: same focused Vitest file.

- [ ] **Keep a direct ICE-native canonical import regression.**
  - Files: `packages/coding-agent/test/legacy-compat/extension-imports.test.ts`.
  - Acceptance: canonical `@zykairotis/ice-*` imports still load with zero errors and register normally.
  - Verify: same focused Vitest file.

- [ ] **Verify the AI root continues to expose the compat surface.**
  - Files: `packages/coding-agent/test/legacy-compat/extension-imports.test.ts`, optionally existing AI compat tests if a more direct seam exists.
  - Acceptance: both historical `.../pi-ai` roots resolve through the same compat target as `@zykairotis/ice-ai`, not the narrower core entrypoint.
  - Verify: a representative legacy API symbol available through the compat entrypoint is usable from both historical roots.

## Stage 3 — Make manifest + alias compatibility one deterministic end-to-end contract

- [ ] **Parameterize the full-chain fixture over Earendil and Mario families.**
  - Files: `packages/coding-agent/test/legacy-compat/pi-manifest-aliases.test.ts`.
  - Evidence: current chain test is Earendil-only at `:29-88`.
  - Acceptance: for each family, a temporary npm package outside default extension directories is discovered only through `package.json#pi`, its extension imports all approved family aliases, the factory executes, and `chain-command` registers.
  - Verify: `node ../../node_modules/vitest/dist/cli.js --run test/legacy-compat/pi-manifest-aliases.test.ts`.

- [ ] **Keep discovery assertions explicit so the alias test cannot pass through directory fallback.**
  - Files: same test.
  - Acceptance: `resources.extensions` has exactly the expected manifest-discovered path before the extension is loaded.
  - Verify: same focused Vitest file.

- [ ] **Preserve package/project trust boundaries.**
  - Files: `runtime-contracts.test.ts` and/or a narrow new legacy-compat test only if needed.
  - Acceptance: adding legacy manifest support does not cause `.pi/extensions` project resources to execute and does not bypass existing project trust behavior shown at `runtime-contracts.test.ts:72-99`.
  - Verify: focused `runtime-contracts.test.ts`.

## Stage 4 — Add manifest provenance without breaking existing consumers

- [ ] **Introduce `readCompatibleManifest()` with `"ice" | "legacy-pi"` provenance.**
  - Files: `packages/coding-agent/src/core/ice-manifest.ts`.
  - Acceptance: valid ICE-only manifests return `{source:"ice"}`; valid legacy-only manifests return `{source:"legacy-pi"}`; both-present selects ICE only; malformed/null ICE with valid Pi returns `null`.
  - Verify: focused manifest tests in `runtime-contracts.test.ts` or a dedicated `manifest-compat.test.ts` if separation improves clarity.

- [ ] **Keep `readIceManifest()` as the compatibility-preserving wrapper unless a consumer genuinely needs provenance.**
  - Files: `ice-manifest.ts`, only the minimum necessary consumer(s).
  - Acceptance: package manager/resource loader behavior remains unchanged without a wide signature migration.
  - Verify: current package/resource tests plus full-chain manifest test.

- [ ] **Add provenance assertions to the legacy manifest regression.**
  - Files: `packages/coding-agent/test/legacy-compat/runtime-contracts.test.ts` or dedicated manifest test.
  - Acceptance: tests explicitly distinguish ICE and legacy source instead of inferring it from returned fields.
  - Verify: focused test.

- [ ] **Add bounded compatibility diagnostics only through an existing suitable seam; otherwise record an explicit deferral.**
  - Files: whichever existing package/resource diagnostic channel already owns bounded resource warnings; do not create a new logger/event subsystem solely for this feature.
  - Acceptance if implemented: a legacy-manifest acceptance can be observed once/bounded, contains only safe package/path identity, and does not spam repeated reloads.
  - Acceptance if deferred: plan/audit notes explain that provenance is implemented and diagnostic fan-out is intentionally deferred because no existing narrow seam is appropriate.
  - Verify: deterministic test if implemented; otherwise no code change for this item.

## Stage 5 — Prove Node/Jiti and Bun mappings cannot drift

- [ ] **Add a mapping parity contract around the shared alias policy.**
  - Files: preferably a new narrow test under `packages/coding-agent/test/legacy-compat/`, with only minimal loader exports/helpers if required.
  - Acceptance: all 14 historical aliases are present in the exact virtual-module map shared by Node/Jiti and Bun; each points to the same object as its canonical target; historical keys are absent from Jiti's prefix-based alias map; canonical targets are unchanged.
  - Verify: focused parity test plus fresh built-Node positive and negative smoke.

- [ ] **Avoid test-only duplication of the alias inventory.**
  - Acceptance: tests may assert an expected exact 14-key inventory, but runtime mappings themselves must be generated from the single `extension-aliases.ts` table rather than maintained independently.
  - Verify: code review/search shows no second production alias table.

- [ ] **Preserve extension cache/reload behavior.**
  - Files: `packages/coding-agent/test/suite/regressions/extension-factory-cache.test.ts` only if the loader refactor touches cache-related code; otherwise treat as a regression verification gate, not an implementation target.
  - Acceptance: module/factory load counts and CWD invalidation remain unchanged.
  - Verify when warranted: `node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/extension-factory-cache.test.ts`.

## Stage 6 — Add compiled-runtime smoke coverage

Repository instructions prohibit running full builds unless explicitly requested, so implementation may prepare these tests/fixtures first and run compiled/binary smoke only when the user explicitly authorizes that verification.

- [ ] **Add a built-Node compatibility smoke fixture or test using the repository's existing build/release output seam.**
  - Relevant scripts: `packages/coding-agent/package.json` `build`; root `package.json` `release:local`.
  - Acceptance: a representative Earendil extension and a representative Mario extension load from built Node artifacts, register a command, and do not resolve through workspace-source fallback accidentally.
  - Verify: execute only after explicit build authorization; record exact command/output in the later audit.

- [ ] **Add Bun compiled-binary smoke or an equivalent virtual-module contract that proves all 14 aliases are available in compiled mode.**
  - Relevant script: `packages/coding-agent/package.json` `build:binary`.
  - Acceptance: compiled Bun resolution includes the exact same approved legacy aliases and maps them to already-bundled ICE module objects.
  - Verify: execute binary build/smoke only after explicit user authorization. Before that, source-level mapping parity tests must still be green.

- [ ] **Ensure unknown historical-looking imports fail in built mode too.**
  - Acceptance: compiled smoke confirms at least one unapproved old-like subpath is unresolved instead of wildcard-remapped.
  - Verify: built Node/Bun smoke after authorization.

## Stage 7 — Keep real installed-package coverage useful but non-authoritative

- [ ] **Retain the current `it.skipIf(!isInstalled(pkg))` behavior.**
  - Files: `packages/coding-agent/test/legacy-compat/pi-real-package.test.ts` only if comments/naming need adjustment.
  - Acceptance: absence of local cached packages yields skips, not failures and not false passes through a broken in-test `it.skip()` call.
  - Verify: run once against the normal cache and once with a temporary empty `ICE_CODING_AGENT_DIR` when auditing the final implementation.

- [ ] **Clarify in test comments that deterministic repository fixtures are the compatibility gate.**
  - Files: `pi-real-package.test.ts`.
  - Acceptance: comments describe these three real packages as optional integration smoke, not the primary proof of C02/C03.
  - Verify: review only.

## Stage 8 — Align documentation and governance

- [ ] **Correct the coding-agent changelog entry to describe both supported historical families once implementation is green.**
  - Files: `packages/coding-agent/CHANGELOG.md` under `[Unreleased] -> Fixed`.
  - Evidence: current entry at `:178-180` mentions only `@earendil-works/pi-*`.
  - Acceptance: entry states that approved `@earendil-works/pi-*` and `@mariozechner/pi-*` extension imports map to ICE equivalents and that legacy `package.json#pi` remains fallback-only.
  - Verify: changelog review; do not edit released sections.

- [ ] **Update the follow-up plan status/notes so its policy cannot be mistaken for obsolete prose.**
  - Files: `agent_docs/implementation/ice-compatibility-preservation-follow-up-plan.md`.
  - Acceptance: add a concise implementation-status note for C02/C03 or update the top-level status only if consistent with the rest of that large plan. Do not mark the entire 1,840-line plan complete merely because this slice is complete.
  - Verify: wording distinguishes target contract from verified implementation.

- [ ] **Do not modify `idea.md` unless implementation changes architecture or policy beyond the already-existing compatibility contract.**
  - Rationale: `AGENTS.md:17` requires `idea.md` updates for new key design decisions. Supporting both historical families is already specified in the existing compatibility plan; this repair should not invent a new architecture.
  - Acceptance: if the implementation merely fulfills C02/C03, no `idea.md` edit is necessary; if policy changes, update it explicitly.

## Verification matrix

| Area | Verification | Required outcome |
|---|---|---|
| Exact alias inventory | focused legacy-compat unit test | 14 approved aliases exactly; no wildcard policy |
| Source Earendil imports | `extension-imports.test.ts` | all approved imports load/register |
| Source Mario imports | `extension-imports.test.ts` | all approved imports load/register |
| Unknown imports | `extension-imports.test.ts` | unsupported Earendil + Mario subpaths fail |
| ICE-native imports | `extension-imports.test.ts` | unchanged success/canonical behavior |
| Pi manifest precedence | `runtime-contracts.test.ts` or dedicated manifest test | Pi fallback only; ICE wins by presence; invalid ICE does not downgrade |
| Manifest provenance | same focused test | source is `ice` or `legacy-pi` correctly |
| Full compatibility chain | `pi-manifest-aliases.test.ts` | both families discover, execute, register command |
| Project trust boundary | `runtime-contracts.test.ts` | `.pi` project extensions remain unloaded; trust behavior unchanged |
| Real packages | `pi-real-package.test.ts` | installed packages pass; missing packages skip cleanly |
| Loader cache | `extension-factory-cache.test.ts` if loader refactor touches cache seam | existing counts/invalidation unchanged |
| Node built runtime | prepared smoke + authorized build run | Earendil + Mario load from built output |
| Bun binary runtime | prepared smoke + authorized binary build | exact same compatibility set available |
| Static quality | `corepack npm@12.0.2 run check` | zero errors/warnings/infos required by repo policy |

### Focused test commands

Run from `packages/coding-agent`:

```bash
node ../../node_modules/vitest/dist/cli.js --run test/legacy-compat/extension-imports.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/legacy-compat/pi-manifest-aliases.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/legacy-compat/runtime-contracts.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/legacy-compat/pi-real-package.test.ts
```

Run cache regression only if the loader refactor touches cache/reload logic:

```bash
node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/extension-factory-cache.test.ts
```

After implementation code changes, from repo root:

```bash
corepack npm@12.0.2 run check
```

Do **not** run full `npm test`, full Vitest, `npm run build`, `build:binary`, or `release:local` unless explicitly authorized under `AGENTS.md`.

## Risks and recovery

### Risk: accidental wildcard compatibility

A prefix rewrite could make arbitrary historical-looking imports resolve to unintended ICE modules.

**Mitigation:** one exact 14-entry table; negative unknown-subpath tests for both families.

### Risk: alias target drift between source and compiled runtimes

Node/Jiti and Bun use different resolution mechanics.

**Mitigation:** both are generated from one alias policy and covered by mapping parity plus compiled smoke.

### Risk: AI root mapped to the wrong entrypoint

`pi-ai` cannot be naively string-rewritten because the extension-facing ICE root intentionally maps to the compat entrypoint.

**Mitigation:** explicit target table and a legacy API symbol test from both historical AI roots.

### Risk: provenance refactor causes broad package-manager churn

Changing `readIceManifest()` directly could force unrelated consumers to migrate.

**Mitigation:** add `readCompatibleManifest()` and keep the current wrapper unless a caller needs provenance.

### Risk: diagnostics become noisy

Legacy packages may be rediscovered/reloaded repeatedly.

**Mitigation:** only use an existing bounded/deduplicated diagnostic channel. Provenance alone is preferable to adding a new noisy subsystem.

### Risk: tests become green by restating implementation instead of contract

This is the failure mode that produced the current negative Mario regression.

**Mitigation:** the exact expected inventory is asserted from the compatibility contract, and tests explicitly require both families plus unknown rejection.

### Rollback

This repair should be reversible by removing the compatibility alias adapter/provenance additions while leaving canonical ICE imports untouched. No user files, package manifests, caches, or legacy source packages are mutated. Rollback must not require restoring anything under `~/.pi`.

## Definition of done

- [ ] All 14 approved historical import specifiers load through ICE's extension loader in source mode.
- [ ] Both Earendil and Mario full-chain `package.json#pi` fixtures discover and execute their extensions.
- [ ] ICE-native imports remain canonical and unchanged.
- [ ] Unknown Earendil and Mario subpaths remain unresolved.
- [ ] The alias inventory has one production source of truth under `core/legacy-compat/`.
- [ ] Node/Jiti and Bun mappings are derived from that same source of truth.
- [ ] `readCompatibleManifest()` exposes `ice | legacy-pi` provenance while preserving strict ICE-first/no-merge semantics.
- [ ] Existing `readIceManifest()` consumers continue to behave correctly without unnecessary migration churn.
- [ ] Project trust and `.pi` project-resource behavior remain unchanged.
- [ ] Optional real-package tests skip correctly when packages are absent and pass when present.
- [ ] Extension cache/reload semantics remain unchanged.
- [ ] Built Node/Bun smoke coverage is implemented; execution evidence is recorded once build authorization is given.
- [ ] `[Unreleased]` changelog text accurately describes the supported historical families.
- [ ] The original compatibility plan no longer contradicts the implementation status for C02/C03.
- [ ] Focused compatibility tests pass.
- [ ] `corepack npm@12.0.2 run check` passes after implementation.

## Already-resolved / excluded findings from the earlier investigation

These are recorded so a later implementation agent does not spend time on stale/transient claims:

- `runtime-contracts.test.ts` no longer asserts ICE-only manifest behavior; its current fallback test is correct.
- `pi-real-package.test.ts` currently uses `it.skipIf(...)`, which is the correct Vitest skip mechanism for absent packages.
- The current tree does not contain the stale `pi-manifest-fallback` comment previously described.
- `packages/ai/src/image-models.generated.ts` is not currently part of the compatibility diff and the generator presently emits tab-formatted output.
- `biome.json`'s `!**/models.generated.ts` rule does not imply that `image-models.generated.ts` is ignored; do not change Biome for this repair.
- The worktree/branch name is intentionally left unchanged per user instruction.
