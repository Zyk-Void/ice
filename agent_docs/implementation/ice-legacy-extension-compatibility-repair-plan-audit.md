# Audit: ICE Legacy Extension Compatibility Repair Plan

- Plan: `agent_docs/implementation/ice-legacy-extension-compatibility-repair-plan.md`
- Workspace: `/home/mewtwo/Zks/ice/.worktrees/subagent-improvements-mock-test`
- Branch: `subagent-improvements-mock-test`
- Initial audit: `2026-09-16T02:24:31Z`
- Completion re-audit: `2026-09-16T02:37:57Z`
- Before completion: **90.0%** (`22.5 / 25`)
- After completion: **100.0%** (`25 / 25`)
- Eligible for complete-remaining: **YES**
- Remaining blockers: **none**

## Verdict

The scoped legacy extension/package compatibility repair is complete and verified across the source runtime, freshly built Node/Jiti output, and the compiled Bun executable.

The completion pass closed the three Stage 6 gaps and corrected one production defect that only appeared after fresh built-runtime execution. The original Node/Jiti implementation put historical Pi roots into Jiti's `alias` map. Fresh negative smoke proved that Jiti treats those alias keys as prefixes: an unapproved import such as `@mariozechner/pi-ai/providers/not-supported` was rewritten to an ICE compat path instead of remaining an unresolved historical specifier. The resolver was corrected so the 14 approved historical imports live only in the exact `virtualModules` compatibility map shared by source, built Node/Jiti, and Bun; Jiti's prefix-based path alias map now contains canonical ICE/package paths only.

The built Node smoke now verifies both approved families and negative unknown-subpath behavior. A real `build:binary` followed by executable-level extension loading verifies all 14 approved imports through `dist/ice` and verifies rejection of unsupported Earendil and Mario subpaths. The full focused compatibility/cache run passes **52/52** tests, the empty-cache real-package suite skips **3/3** cases cleanly, and `corepack npm@12.0.2 run check` passes.

## Scoring model

The denominator remains the 25 leaf checkboxes under Stages 1-8. The Definition-of-done list is a duplicate summary and is not double-counted.

- VERIFIED = 1.0
- PARTIAL = 0.5
- MISSING/BROKEN/BLOCKED = 0.0
- N/A = excluded

Final totals:

- VERIFIED: 25 units = 25.0 points
- PARTIAL: 0
- MISSING/BROKEN/BLOCKED: 0
- Denominator: 25
- Completion: `(25 / 25) * 100 = 100.0%`

## Coverage ledger

| ID | Plan unit | Status | Score | Evidence | Exact remaining work |
|---|---|---|---:|---|---|
| S1.1 | Create canonical 14-entry alias table | VERIFIED | 1.0 | `packages/coding-agent/src/core/legacy-compat/extension-aliases.ts:17-32`; exact inventory regression in `extension-imports.test.ts` | - |
| S1.2 | Refactor loader to consume canonical compatibility table | VERIFIED | 1.0 | `loader.ts:51-94` builds exact historical virtual-module keys from the one table; `loader.ts:96-150` keeps Jiti path aliases canonical-only; `loader.ts:457-472` combines exact virtual modules with canonical built aliases | - |
| S1.3 | Remove obsolete Mario/no-legacy wording | VERIFIED | 1.0 | Loader comments now describe approved historical compatibility and exact-match constraints; no `no-legacy contract` wording remains | - |
| S2.1 | Positive table-driven coverage for all 14 aliases | VERIFIED | 1.0 | `extension-imports.test.ts` asserts the exact inventory and loads every approved specifier; final focused run passed | - |
| S2.2 | Reject unknown old-like imports for both families | VERIFIED | 1.0 | Source negative table covers Earendil and Mario unsupported subpaths; final focused run passed | - |
| S2.3 | Keep direct ICE-native canonical regression | VERIFIED | 1.0 | `extension-imports.test.ts` ICE-native import case passes | - |
| S2.4 | Verify historical AI roots use compat surface | VERIFIED | 1.0 | Both historical `pi-ai` roots expose the compat-only `streamAnthropic` API in source regression | - |
| S3.1 | Parameterize full-chain fixture over both families | VERIFIED | 1.0 | `pi-manifest-aliases.test.ts` executes Earendil and Mario `package.json#pi -> discovery -> imports -> factory -> command` chains | - |
| S3.2 | Keep explicit discovery assertions | VERIFIED | 1.0 | Full-chain fixture asserts exactly one manifest-discovered extension path before loading | - |
| S3.3 | Preserve project/trust boundaries | VERIFIED | 1.0 | `runtime-contracts.test.ts` keeps `.pi/extensions` unloaded and verifies ICE project trust behavior | - |
| S4.1 | Add provenance-aware `readCompatibleManifest()` | VERIFIED | 1.0 | `ice-manifest.ts:10-60`; tests cover ICE, legacy Pi, both-present precedence, malformed/null ICE hard-null | - |
| S4.2 | Keep `readIceManifest()` compatibility wrapper | VERIFIED | 1.0 | `ice-manifest.ts:58-60`; existing loader/package-manager consumers remain unchanged | - |
| S4.3 | Add provenance assertions | VERIFIED | 1.0 | `runtime-contracts.test.ts` explicitly asserts `ice` vs `legacy-pi` source and no merge | - |
| S4.4 | Add bounded diagnostics or explicitly defer | VERIFIED | 1.0 | Parent compatibility note records the intentional deferral because package-resolution has no bounded/deduplicated diagnostic seam; no new logging subsystem was introduced | - |
| S5.1 | Add Node/Jiti vs Bun resolution parity contract | VERIFIED | 1.0 | `extension-alias-parity.test.ts` verifies all 14 exact virtual-module keys, same canonical objects, canonical Jiti aliases, and absence of historical keys from the prefix alias map; built smoke independently verifies emitted behavior | - |
| S5.2 | Avoid second production alias inventory | VERIFIED | 1.0 | `extension-aliases.ts` is the sole production historical inventory; loader iterates it to construct exact compatibility mappings | - |
| S5.3 | Preserve extension cache/reload behavior | VERIFIED | 1.0 | `extension-factory-cache.test.ts` included in final focused run and passed | - |
| S6.1 | Built-Node compatibility smoke using fresh built output | VERIFIED | 1.0 | Fresh root/package builds succeeded; `built-runtime-smoke.test.ts:62-137` imports `dist/core/extensions/loader.js`, loads both families, and passed | - |
| S6.2 | Bun compiled-binary smoke | VERIFIED | 1.0 | `npm run build:binary` succeeded; `built-runtime-smoke.test.ts:139-212` executes `dist/ice`, imports all 14 historical specifiers, registers a visible extension flag, and passed | - |
| S6.3 | Unknown historical imports fail in built mode | VERIFIED | 1.0 | Built Node negative cases `built-runtime-smoke.test.ts:118-136` reject Earendil + Mario unsupported subpaths; Bun executable negative cases `:183-211` reject both families; all passed | - |
| S7.1 | Retain correct `it.skipIf(!isInstalled())` behavior | VERIFIED | 1.0 | Normal focused run passes installed cases as applicable; explicit empty-cache run skips 3/3 with zero failures | - |
| S7.2 | Clarify real-package test is optional smoke | VERIFIED | 1.0 | `pi-real-package.test.ts` identifies deterministic repository fixtures as the compatibility gate | - |
| S8.1 | Correct changelog for both historical families | VERIFIED | 1.0 | `packages/coding-agent/CHANGELOG.md:180` names both families, exact virtual-module behavior, Jiti prefix-alias exclusion, fallback precedence, and no merge | - |
| S8.2 | Update parent follow-up plan without overstating verification | VERIFIED | 1.0 | `ice-compatibility-preservation-follow-up-plan.md:9-23` now explicitly states source, fresh built Node/Jiti, and compiled Bun verification and preserves the scope boundary that all other sections remain proposed | - |
| S8.3 | Leave `idea.md` unchanged unless policy changed | VERIFIED | 1.0 | No `idea.md` change; this completion fulfills the existing compatibility policy rather than introducing a new product architecture | - |

## Findings closed during completion

### H1 — Jiti prefix aliasing violated the exact-match contract

**Observed failure:** after the first fresh Node build, the new negative built smoke failed for both historical families. Instead of leaving `@earendil-works/pi-ai/providers/not-supported` and `@mariozechner/pi-ai/providers/not-supported` unresolved, Jiti rewrote them beneath the approved root alias, producing paths such as `packages/ai/dist/compat.js/providers/not-supported`.

**Root cause:** historical root keys were inserted into Jiti's `alias` option. Jiti's alias resolution is prefix-oriented, so an approved root key implicitly affected unknown subpaths.

**Fix:** historical aliases remain generated from `LEGACY_PI_EXTENSION_ALIASES`, but they are installed only into the exact `VIRTUAL_MODULES` map. Built Node/Jiti receives both `virtualModules: VIRTUAL_MODULES` and the canonical-only `alias: getAliases()` map (`loader.ts:457-472`). The source runtime and Bun already use the same exact virtual-module seam.

**Regression proof:** built Node and Bun negative cases for both families now pass and assert the original unsupported specifier appears in the load error.

### M1 — Built Node boundary was previously unverified

Closed by fresh build and opt-in built-loader execution. Both seven-specifier family fixtures pass through `dist/core/extensions/loader.js`; negative cases also pass.

### M2 — Bun compiled boundary was previously unverified

Closed by a fresh `npm run build:binary` and an executable-level test using `dist/ice`. One fixture imports all 14 approved historical specifiers and registers `--binary-legacy-smoke`; two negative fixtures prove unsupported subpaths fail.

### M3 — Parent follow-up plan verification claim

Now evidence-backed. The parent plan records the exact resolution architecture and the source, built Node/Jiti, and compiled Bun verification boundary while explicitly leaving every non-C02/C03 section proposed.

## Verification performed

### 1. Initial fresh monorepo Node build

```bash
npm run build
```

Result: **PASS**. All required packages including `@zykairotis/ice-coding-agent` built successfully.

### 2. First built-Node negative smoke

```bash
ICE_BUILT_SMOKE=1 \
  node ../../node_modules/vitest/dist/cli.js --run test/legacy-compat/built-runtime-smoke.test.ts
```

Initial result: **FAIL** — `3 passed, 2 failed, 3 skipped`. The two failures exposed Jiti prefix aliasing for unsupported Earendil and Mario subpaths. This was treated as a production defect, not weakened test expectations.

After the resolver fix and fresh coding-agent build, result: **PASS** — `5 passed, 3 skipped`.

### 3. Fresh compiled Bun build

From `packages/coding-agent`:

```bash
npm run build:binary
```

Result: **PASS**. Bun bundled 3,195 modules and compiled `dist/ice` successfully.

### 4. Built Node + compiled Bun smoke

```bash
ICE_BUILT_SMOKE=1 ICE_BINARY_SMOKE=1 \
  node ../../node_modules/vitest/dist/cli.js --run test/legacy-compat/built-runtime-smoke.test.ts
```

Result: **PASS** — `8 passed / 8`.

Coverage includes:

- exact map policy in emitted Node loader;
- all seven Earendil imports through built Node;
- all seven Mario imports through built Node;
- unsupported Earendil built import rejection;
- unsupported Mario built import rejection;
- all 14 aliases through the actual Bun executable;
- unsupported Earendil Bun import rejection;
- unsupported Mario Bun import rejection.

### 5. Final focused compatibility/cache suite

```bash
ICE_BUILT_SMOKE=1 ICE_BINARY_SMOKE=1 \
  node ../../node_modules/vitest/dist/cli.js --run \
  test/legacy-compat/extension-imports.test.ts \
  test/legacy-compat/pi-manifest-aliases.test.ts \
  test/legacy-compat/runtime-contracts.test.ts \
  test/legacy-compat/pi-real-package.test.ts \
  test/legacy-compat/extension-alias-parity.test.ts \
  test/legacy-compat/built-runtime-smoke.test.ts \
  test/suite/regressions/extension-factory-cache.test.ts
```

Result: **PASS** — `7 passed / 7` files, `52 passed / 52` tests.

### 6. Empty-cache installed-package behavior

```bash
ICE_CODING_AGENT_DIR=/tmp/ice-completion-empty-cache-20260916 \
  node ../../node_modules/vitest/dist/cli.js --run test/legacy-compat/pi-real-package.test.ts
```

Result: **PASS** — `3 skipped / 3`, zero failures.

### 7. Repository static gate

```bash
corepack npm@12.0.2 run check
```

Result: **PASS**. Biome completed, pinned dependency checks passed, TypeScript relative-import checks passed, coding-agent shrinkwrap/install-lock were current, `tsgo --noEmit` passed, and browser smoke passed. Biome formatted one file during this run; no unresolved warnings/errors remained.

## Plan gap discovered and reconciled

The original repair plan assumed that the historical mapping could be installed in both Bun `virtualModules` and the built Node/Jiti `alias` map. Fresh built-runtime evidence disproved that implementation detail: Jiti alias keys are prefix-oriented, which violates the plan's stronger exact-match invariant for historical roots.

This does **not** add a new scoreable requirement; it corrects the implementation mechanism for existing S1.2/S5.1/S6.3 requirements. The plan was updated in place to specify the evidence-backed design:

- one 14-entry production policy table;
- exact historical keys in the shared virtual-module map;
- canonical-only Jiti path aliases;
- negative built/runtime proof that unknown old-like subpaths remain unresolved.

## Next-agent fix queue

None. All 25 scoreable units are VERIFIED.

## Blockers / external dependencies

None for this scoped repair. No credentials, provider API calls, release, publish, merge, push, or commit were required.

## Completion status

**100.0% complete for `ice-legacy-extension-compatibility-repair-plan.md`.**

This statement is scoped to this repair plan only. It does not mark the broader `ice-compatibility-preservation-follow-up-plan.md` complete; that parent document explicitly states every section outside C02/C03 remains proposed.
