# ICE Compatibility Preservation Follow-Up Plan

**Date:** 2026-09-10  
**Repository:** `/home/mewtwo/Zks/ice`  
**Branch:** `feat/ice`  
**Status:** Proposed follow-up after ICE identity cutover  
**Goal:** Preserve behavior relied on by existing Pi / Pi-Void users, extensions, configuration, sessions, environment variables, RPC clients, and resource packages **without turning ICE back into a dual-branded product**.

> **Implementation status (2026-09-16, `subagent-improvements-mock-test`): C02 and C03 are implemented and verified through source, built Node/Jiti, and compiled Bun boundaries.**
> The approved alias inventory lives in one data-only table,
> `packages/coding-agent/src/core/legacy-compat/extension-aliases.ts` (14 exact specifiers across both historical
> families). Historical imports are installed as exact virtual-module keys shared by source, built Node/Jiti,
> and Bun; Jiti's canonical built-path `alias` map intentionally excludes historical keys because fresh built
> verification proved that Jiti treats alias keys as prefixes and would otherwise rewrite unapproved subpaths.
> `package.json#pi` is accepted as a fallback only: `ice` still wins by presence, an explicit `ice: null` does
> not downgrade, and ICE and legacy resources are never merged. `readCompatibleManifest()` exposes
> `ice | legacy-pi` provenance while `readIceManifest()` keeps its existing signature for current consumers.
> Deterministic source fixtures, fresh built-Node smoke, and a compiled Bun executable smoke cover both approved
> families and unknown-subpath rejection. The installed-package test remains optional smoke only. Bounded
> legacy-manifest diagnostics are intentionally deferred: the manifest read sites sit in the package-resolution
> layer, which has no bounded or deduplicated diagnostic channel, and adding one would mean a new subsystem
> rather than reuse of an existing seam.
> **Every other section of this plan remains proposed, not implemented.** This note is scoped to C02/C03 only.

---

## 0. Executive decision

The ICE rebrand itself is functionally green, but the current implementation intentionally removed several legacy compatibility surfaces. That creates a real risk that an existing user can upgrade to ICE and lose behavior even though ICE-native tests pass.

The correct fix is **not** to undo the ICE rename and **not** to blindly restore every old identifier everywhere.

The correct architecture is:

> **ICE is the only canonical product identity. Legacy inputs are accepted through a narrow, centralized, one-way compatibility layer. All new state, output, settings, manifests, commands, and documentation stay ICE-native.**

Compatibility direction:

```text
legacy input ──► compatibility adapter ──► ICE canonical representation ──► ICE runtime

ICE runtime ──X──► legacy state
```

Rules:

1. ICE always wins when both ICE and legacy values exist.
2. Legacy values may be read, translated, copied, or imported.
3. ICE must never silently overwrite, delete, or rewrite the user's legacy data.
4. ICE must never dual-write new settings/session state into old namespaces.
5. Legacy executable resources must never bypass project trust.
6. Compatibility must be explicit in code and tests, not scattered ad-hoc aliases.
7. Public/default surfaces remain ICE-only.
8. External project names and provenance such as OhMyPi or `badlogic/pi-share-hf` remain untouched.
9. The compatibility layer may contain old identifiers by necessity. The zero-identity scanner must therefore use a **small audited allowlist** rather than treating every old token as a product-brand failure.
10. A future removal of the compatibility layer must be a deliberate versioned migration, not another bulk rename.

---

# 1. Why this follow-up is required

## 1.1 Current ICE-native state is healthy

The post-cutover baseline already passed:

- critical subagent acceptance: **29/29 files, 757/757 tests**;
- focused extension/theme/config tests: **5 files, 86/86 tests**;
- `scripts/sync-versions.test.mjs`: pass;
- `npm run check`: pass;
- `npm run build:offline`: pass;
- `git diff --check`: pass;
- built CLI: `ice 0.83.0`;
- package dry run: `@zykairotis/ice-coding-agent@0.83.0`;
- package contains **0 legacy Pi/PIV-style filenames**.

These results establish the **ICE-native baseline**. Every work package below must preserve it.

## 1.2 Current extension loader dropped legacy package aliases

Current `packages/coding-agent/src/core/extensions/loader.ts` exposes only ICE module specifiers to extensions:

```text
@zykairotis/ice-agent-core
@zykairotis/ice-tui
@zykairotis/ice-ai
@zykairotis/ice-ai/compat
@zykairotis/ice-ai/oauth
@zykairotis/ice-ai/providers/all
@zykairotis/ice-coding-agent
```

The pre-cutover loader also supported the historical extension import families:

```text
@earendil-works/pi-agent-core
@earendil-works/pi-tui
@earendil-works/pi-ai
@earendil-works/pi-ai/compat
@earendil-works/pi-ai/oauth
@earendil-works/pi-ai/providers/all
@earendil-works/pi-coding-agent

@mariozechner/pi-agent-core
@mariozechner/pi-tui
@mariozechner/pi-ai
@mariozechner/pi-ai/compat
@mariozechner/pi-ai/oauth
@mariozechner/pi-ai/providers/all
@mariozechner/pi-coding-agent
```

An old extension can therefore be structurally compatible with ICE and still fail at import resolution.

This is a **real compatibility regression** unless old extensions are intentionally unsupported.

## 1.3 Legacy package resource manifests are no longer recognized

Current `packages/coding-agent/src/core/ice-manifest.ts` reads only:

```json
{
  "ice": {
    "extensions": [],
    "skills": [],
    "prompts": [],
    "themes": []
  }
}
```

The previous ecosystem used the same fields under a top-level `"pi"` object.

A package using only the historical manifest can therefore install successfully while its resources silently disappear from ICE discovery.

This is particularly dangerous because it can look like an unrelated extension/skill failure.

## 1.4 Legacy global and project resources are stranded

The current default locations are correctly ICE-native:

```text
~/.ice/agent/
<project>/.ice/
```

The old locations were:

```text
~/.pi/agent/
<project>/.pi/
```

Current resource discovery, settings loading, trust detection, extensions, skills, prompts, themes, packages, and session storage are all oriented around ICE paths.

That means an existing user may start ICE and see:

- no custom extensions;
- no custom skills;
- no custom prompts;
- no custom themes;
- missing package resources;
- apparently fresh settings;
- apparently missing sessions;
- missing subagent agent/profile files;
- different model/auth behavior.

None of these failures would be caught by the current ICE-native 757-test acceptance suite because that suite starts from ICE-native fixtures.

## 1.5 Environment variables changed identity

Historical product variables included, among others:

```text
PI_CODING_AGENT_DIR
PI_CODING_AGENT_SESSION_DIR
PI_PACKAGE_DIR
PI_SHARE_VIEWER_URL
PI_OFFLINE
PI_TELEMETRY
PI_EXPERIMENTAL
PI_CLEAR_ON_SHRINK
PI_HARDWARE_CURSOR
PI_TIMING
PI_SKIP_VERSION_CHECK
PI_STARTUP_BENCHMARK
PI_CACHE_RETENTION
PI_OAUTH_CALLBACK_HOST
PI_PROVIDER_CONTINUATION_DIAG
PI_PROVIDER_CONTINUATION_DIAG_FILE
PI_PROVIDER_CONTINUATION_DIAG_STDERR
PI_SESSION_ID
PI_SESSION_FILE
PI_PROVIDER
PI_MODEL
PI_REASONING_LEVEL
PI_COGNEE_*
PIV_LOCAL_API_KEY
PIV_LOCAL_BASE_URL
PIV_OMNI_BASE_URL
```

ICE now correctly uses corresponding `ICE_*` names.

But existing shell profiles, launch scripts, Docker files, systemd units, CI jobs, test harnesses, and local `.env` files may still export the old names.

If those values are simply ignored, the observable runtime can change in ways that look like application bugs.

## 1.6 PIV settings namespace changed to ICE

The pre-cutover subagent implementation used a settings namespace rooted at:

```text
piv.subagents
piv.hooks
```

The current implementation correctly uses:

```text
ice.subagents
ice.hooks
```

Current strict parsing accepts only the ICE namespace. Existing user `settings.json` files containing `piv` settings can therefore lose effective subagent policy after the cutover unless they are transformed.

This is security-sensitive because settings include:

- enabled/disabled state;
- role allowlists;
- thinking defaults;
- timeout budgets;
- turn budgets;
- tool-call budgets;
- output-byte budgets;
- deny-first restrictions;
- lifecycle hooks and command policy.

Migration must preserve **security restrictions at least as strictly as before**.

## 1.7 RPC settings schema ID changed

The pre-cutover structured settings command used:

```text
pi.settings
```

Current ICE uses:

```text
ice.settings
```

A client that cached or invokes the previous schema ID can receive a stale/schema mismatch even though the underlying command and fields are otherwise compatible.

Compatibility should accept the old schema ID as a legacy input, while all newly emitted schemas remain `ice.settings`.

## 1.8 Theme global bridge changed

Current theme sharing uses:

```text
Symbol.for("@zykairotis/ice-coding-agent:theme")
```

The previous loader/module ecosystem could have extension copies looking for the historical Pi symbol.

A legacy extension that resolves an old coding-agent/theme module copy may therefore fail with "Theme not initialized" even while the ICE UI itself is healthy.

This can be preserved safely with a **write-only compatibility mirror**: ICE owns the canonical theme and mirrors the current theme object into the legacy symbol for old extension copies. ICE must never read the old symbol as its source of truth.

## 1.9 ICE-AI API-shape compatibility is already correct and must remain

Current loader behavior intentionally resolves the ICE AI package root to its compatibility entrypoint. `packages/ai/src/legacy-api-aliases.ts` keeps deprecated stream helpers available **under the ICE package identity**.

This is desirable compatibility and should not be removed by identity-cleanup work.

---

# 2. Non-negotiable invariants

These invariants are acceptance requirements, not suggestions.

## I01 — ICE remains canonical

Canonical public names remain:

```text
Product: ICE
CLI: ice
TS symbols: Ice / ice
Environment: ICE_*
Config directory: .ice
User state: ~/.ice/agent
Settings: ice.*
Packages: @zykairotis/ice-*
Binary: dist/ice.js / dist/ice
```

No public documentation should instruct new users to use the legacy identity.

## I02 — precedence is deterministic

For every translated setting or environment value:

```text
explicit ICE value > translated legacy value > ICE default
```

Never merge conflicting security-sensitive namespaces in a way that widens authority.

## I03 — legacy compatibility is one-way

Allowed:

```text
old input -> parse -> normalize -> ICE representation
old files -> copy/import -> ICE files
```

Forbidden:

```text
ICE change -> write old setting
ICE session -> write old session directory
ICE package -> publish old package alias
ICE config -> mutate .pi files
```

## I04 — no destructive migration

Never:

- rename a user's `~/.pi` directory in place;
- delete old files;
- overwrite an existing ICE file because an old file exists;
- follow a symlink outside the allowed migration root;
- rewrite auth/session files before validating them;
- modify project `.pi` executable resources before project trust.

## I05 — project trust applies before legacy execution

A legacy `.pi/extensions`, package manifest extension, hook, script, or project settings file must not gain a trust bypass merely because it is being migrated.

The compatibility path must be **equal or stricter** than ICE-native project trust.

## I06 — deny-first security survives settings migration

When translating `piv.subagents` / `piv.hooks` into `ice.subagents` / `ice.hooks`:

- `enabled: false` stays false;
- deny lists remain deny lists;
- maximum budgets must not increase;
- restricted role/tool configuration must not broaden;
- executable hooks remain disabled unless their current ICE trust/build/bash/approval gates are satisfied.

## I07 — no silent compatibility ambiguity

If both ICE and legacy values exist and differ:

- ICE wins;
- legacy value is not merged into the winner;
- a bounded diagnostic records the conflict;
- secrets are never printed in diagnostics.

## I08 — compatibility strings are centrally allowlisted

Old identifiers may exist only in:

- dedicated compatibility implementation modules;
- compatibility tests/fixtures;
- migration documentation;
- preserved third-party provenance where the old name is factually required.

Any occurrence outside those classes fails the final compatibility-aware identity scan.

## I09 — external proper names are not rewritten

Names such as OhMyPi, `badlogic/pi-share-hf`, upstream attribution, repository citations, and license/provenance references must remain factually correct.

## I10 — current green baseline cannot regress

At minimum, the current:

```text
29 files / 757 tests
npm run check
npm run build:offline
focused extension/theme/config tests
sync-versions test
package dry run
```

must remain green after every major compatibility track.

---

# 3. Compatibility policy matrix

| Surface | Policy | Default behavior | Writes legacy state? |
|---|---|---|---|
| ICE CLI/product name | ICE-only | `ice` only | No |
| Old CLI command name | intentionally not restored | migration guidance only | No |
| Old extension import specifiers | compatibility alias | accepted by ICE loader | No |
| Old package `"pi"` manifest | fallback parser | accepted only when `"ice"` absent | No |
| `~/.pi/agent` | migration source | detect/import non-destructively | No |
| project `.pi` | migration source | detect; migrate only with trust | No |
| old PI/PIV env vars | fallback input | ICE wins; old used only if ICE absent | No |
| old child-process metadata vars | temporary dual-export compatibility | ICE + legacy metadata for old shell hooks | Environment only |
| `piv.subagents` / `piv.hooks` | settings migration | translate to `ice.*` | ICE only |
| `pi.settings` RPC schema ID | input alias | accept request; emit `ice.settings` | No |
| old theme global symbol | write-only mirror | mirror ICE theme for old extension copies | Runtime memory only |
| legacy sessions | import/copy | preserve bytes and IDs where valid | ICE only |
| old cache/npm/git/bin directories | do not bulk-copy | rebuild/reinstall where possible | No |
| historical/provenance names | preserve | unchanged | N/A |
| old Git repository/history | preserve outside clean ICE repo | archive/reference only | No |

---

# 4. Proposed implementation architecture

Create one bounded compatibility subsystem rather than scattering old names through the codebase.

Suggested layout:

```text
packages/coding-agent/src/core/legacy-compat/
  constants.ts
  diagnostics.ts
  env.ts
  manifests.ts
  settings.ts
  state-migration.ts
  project-migration.ts
  extension-aliases.ts
  rpc.ts
  index.ts

packages/coding-agent/test/legacy-compat/
  env.test.ts
  manifests.test.ts
  settings.test.ts
  state-migration.test.ts
  project-migration.test.ts
  extension-aliases.test.ts
  rpc.test.ts
  theme.test.ts
  security.test.ts
```

For `packages/ai`, use the existing provider-env abstraction rather than importing coding-agent code:

```text
packages/ai/src/utils/provider-env.ts
packages/ai/test/provider-env-legacy-compat.test.ts
```

The compatibility layer should expose canonical helpers such as:

```ts
resolveLegacyAwareEnv(...)
readCompatibleResourceManifest(...)
translateLegacySettings(...)
inspectLegacyUserState(...)
planLegacyStateMigration(...)
applyLegacyStateMigration(...)
getLegacyExtensionAliases(...)
normalizeLegacyRpcSchemaId(...)
```

Do not expose these as the primary public SDK unless a concrete external consumer needs them.

---

# 5. Work packages

## C01 — Freeze a compatibility inventory and scanner policy

**Priority:** P0  
**Risk:** Low  
**Purpose:** Prevent both under-migration and accidental reintroduction of old branding.

### Files

- add `packages/coding-agent/src/core/legacy-compat/constants.ts`;
- add `scripts/check-legacy-compat-boundary.mjs`;
- update root `package.json` check pipeline only after the scanner is proven stable;
- add scanner tests.

### Requirements

1. Record the exact legacy identifiers that ICE intentionally recognizes.
2. Categorize each identifier as:
   - input alias;
   - migration source;
   - runtime bridge;
   - third-party/provenance exemption.
3. Scanner must reject old product identifiers outside approved files.
4. Scanner must not reject external proper names simply because they contain `pi`.
5. Scanner must inspect filenames and file content.
6. Scanner must inspect built/package output separately from source.
7. Compatibility tests/fixtures are allowed to contain old names, but this allowlist must be explicit and small.

### Acceptance

- adding a random old package alias in unrelated production code fails the scan;
- adding `OhMyPi` in provenance does not fail;
- adding a compatibility alias inside the approved adapter passes;
- source and package-output scans report categorized counts rather than a misleading raw zero.

---

## C02 — Restore legacy extension import compatibility inside the ICE loader only

**Priority:** P0  
**Risk:** Medium  
**Purpose:** Existing extensions should not fail simply because their import specifier predates the rebrand.

### Files

- `packages/coding-agent/src/core/extensions/loader.ts`;
- new `packages/coding-agent/src/core/legacy-compat/extension-aliases.ts`;
- extension loader tests;
- compiled Node/Bun smoke coverage.

### Exact alias families to support

Map the historical exact specifiers to current ICE modules:

```text
@earendil-works/pi-agent-core          -> @zykairotis/ice-agent-core
@earendil-works/pi-tui                 -> @zykairotis/ice-tui
@earendil-works/pi-ai                  -> ICE AI compat entrypoint
@earendil-works/pi-ai/compat           -> ICE AI compat entrypoint
@earendil-works/pi-ai/oauth            -> ICE AI oauth
@earendil-works/pi-ai/providers/all    -> ICE AI providers/all
@earendil-works/pi-coding-agent        -> ICE coding-agent entrypoint

@mariozechner/pi-agent-core            -> @zykairotis/ice-agent-core
@mariozechner/pi-tui                   -> @zykairotis/ice-tui
@mariozechner/pi-ai                    -> ICE AI compat entrypoint
@mariozechner/pi-ai/compat             -> ICE AI compat entrypoint
@mariozechner/pi-ai/oauth              -> ICE AI oauth
@mariozechner/pi-ai/providers/all      -> ICE AI providers/all
@mariozechner/pi-coding-agent          -> ICE coding-agent entrypoint
```

### Constraints

- exact-match map only;
- no arbitrary `pi-*` prefix rewrite;
- no old package exported in ICE `package.json`;
- no old package published to npm;
- no dependency on the old package actually being installed;
- same mapping in Bun `virtualModules` and built Node/Jiti aliases;
- ICE package root continues to map `@zykairotis/ice-ai` to the compat entrypoint;
- diagnostic may say a legacy extension import was accepted, but must be deduplicated and bounded.

### Required tests

1. old Earendil extension imports load in source TypeScript mode;
2. old upstream Mario Zechner imports load in source mode;
3. same fixtures load from built Node dist;
4. Bun virtual-module map includes the same exact compatibility set;
5. unknown old-like package names do not resolve;
6. ICE-native imports still resolve to identical module objects;
7. old AI root receives legacy API aliases through ICE compat;
8. extension reload/cache semantics are unchanged.

### Acceptance

An unchanged representative pre-cutover extension must load and register a tool/command successfully under ICE.

---

## C03 — Add legacy package resource manifest fallback

**Priority:** P0  
**Risk:** Low-Medium  
**Purpose:** Preserve extension/skill/prompt/theme packages that still declare resources under `package.json#pi`.

### Files

- `packages/coding-agent/src/core/ice-manifest.ts`;
- package manager consumers;
- extension discovery consumers;
- manifest tests.

### Proposed contract

Replace the current opaque return with provenance-aware parsing:

```ts
type CompatibleManifestResult = {
  manifest: IceManifest;
  source: "ice" | "legacy-pi";
};
```

Precedence:

```text
package.json#ice exists -> use only ice
else package.json#pi exists -> translate as legacy manifest
else -> null
```

Do **not** merge `ice` and `pi` manifests. Merging can widen executable resources and create duplicate load order ambiguity.

### Required tests

- ICE-only manifest;
- old-only manifest;
- both fields present: ICE wins;
- malformed ICE + valid old manifest: fail/diagnose; do not silently downgrade to old;
- relative resource path semantics unchanged;
- missing declared resource remains missing rather than escaping package root;
- package-manifest extension discovery preserves trust rules.

---

## C04 — Add a non-destructive global user-state migration engine

**Priority:** P0  
**Risk:** High  
**Purpose:** Prevent `~/.pi/agent` users from appearing to lose their setup.

### Files

- `packages/coding-agent/src/migrations.ts`;
- new `core/legacy-compat/state-migration.ts`;
- config/startup integration;
- migration tests.

### Migration source and destination

```text
source:      ~/.pi/agent
canonical:   ~/.ice/agent
```

Respect explicit directory overrides; never infer/migrate from a default legacy home when the user explicitly selected a custom ICE agent directory unless they request it.

### Migration phases

1. **inspect** — enumerate source without mutating;
2. **plan** — classify safe copy, transform, skip, conflict, and blocked symlink;
3. **apply** — write only into ICE destination;
4. **verify** — hash/parse destination;
5. **record** — write an ICE migration receipt;
6. **report** — bounded summary, no secrets.

### Candidate data classes

Safe/important to migrate deliberately:

```text
settings.json
auth.json / supported historical auth data
models.json
keybindings.json or embedded keybindings
prompts/
skills/
agents/
themes/
selected package configuration
session files
trusted non-executable metadata
```

Do not blindly copy runtime/cache material:

```text
bin/
npm/
git/
temporary files
update markers
compiled caches
stale package-manager caches
```

Those should be regenerated or reinstalled under ICE paths.

### Conflict policy

For each destination file:

```text
ICE missing      -> eligible for import
ICE identical    -> mark already satisfied
ICE differs      -> ICE wins; report conflict; do not overwrite
legacy malformed -> skip and report
```

For structured `settings.json`, transform individual compatible keys rather than replacing a newer ICE settings file wholesale.

### Security requirements

- `auth.json` destination permissions remain restrictive;
- never print credential values;
- reject or quarantine symlinks escaping the legacy root;
- do not follow device/FIFO/socket entries;
- bound total files and bytes before copy;
- write temp + fsync/rename where existing storage utilities support it;
- migration is idempotent;
- failed migration leaves source untouched and destination either unchanged or recoverable from a receipt.

### Migration receipt

Store under an ICE-owned location, for example:

```text
~/.ice/agent/migrations/legacy-product-import-v1.json
```

Receipt should contain only metadata such as:

- migration version;
- timestamp;
- source root;
- destination root;
- relative paths;
- classifications;
- hashes for non-secret integrity where appropriate;
- conflicts/skips/errors;
- never credential contents.

### User experience

Preferred behavior:

- detect legacy state on first ICE startup;
- if ICE state is effectively fresh, offer/perform the bounded safe migration according to project UX conventions;
- if existing ICE state is non-empty, never merge silently—show a migration action/command with preview;
- provide an explicit command such as `ice migrate` if the command architecture supports it cleanly;
- migration should be rerunnable and idempotent.

Do not require continued runtime dependence on `~/.pi/agent` after successful import.

---

## C05 — Preserve project `.pi` resources without creating a trust bypass

**Priority:** P0  
**Risk:** Critical security surface  
**Purpose:** Existing projects may contain valuable project-local extensions/skills/prompts/settings, but executable legacy resources are untrusted code.

### Files

Potentially affected:

- `core/resource-loader.ts`;
- `core/trust-manager.ts`;
- `core/settings-manager.ts`;
- `core/extensions/loader.ts`;
- prompt/skill/package discovery;
- new `core/legacy-compat/project-migration.ts`.

### Policy

Do **not** permanently add `.pi` as a second normal discovery root.

Instead:

1. detect legacy `.pi` resources;
2. include their existence in trust/migration diagnostics;
3. if project is untrusted, do not execute/read security-sensitive project content beyond the minimum metadata needed to announce migration availability;
4. once project is trusted, provide a non-destructive migration to `.ice`;
5. after migration, normal runtime reads `.ice` only;
6. when both `.ice` and `.pi` exist, `.ice` is authoritative;
7. never merge executable resource lists automatically.

### Why migration is safer than dual discovery

Permanent dual discovery would create ambiguous precedence and could execute an old extension that the user believed had been superseded by `.ice`.

A one-time migration makes the trust event and resulting canonical tree explicit.

### Required tests

- untrusted project with only `.pi/extensions`: extension never executes;
- trust prompt detects legacy project resources;
- trusted migration copies permitted resource files;
- `.ice` wins if same relative file exists in both trees;
- escaping symlink is rejected;
- duplicate extension is not loaded twice;
- project settings migration preserves deny-first subagent restrictions;
- migration rerun is idempotent.

---

## C06 — Translate old `piv` settings namespace into `ice`

**Priority:** P0  
**Risk:** High / security-sensitive  
**Purpose:** Preserve subagent policy, limits, and hooks from the verified pre-cutover implementation.

### Legacy source

The dirty pre-cutover source confirms these canonical historical roots:

```text
piv.subagents
piv.hooks
```

Current roots:

```text
ice.subagents
ice.hooks
```

### Files

- `core/legacy-compat/settings.ts`;
- `core/settings-manager.ts` migration path;
- `ice-subagent-settings.ts` only where needed for typed translation;
- RPC settings tests;
- dedicated compatibility tests.

### Translation rules

At file migration time:

```text
piv.subagents -> ice.subagents
piv.hooks     -> ice.hooks
```

Do not add `piv` back to the long-lived `Settings` type as a normal first-class namespace.

Use a migration parser that accepts an `unknown` JSON object, extracts known legacy fields, validates them using equivalent ICE parsers, and writes only canonical ICE keys.

### Conflict policy

If both namespaces are present:

```text
ice.* wins
piv.* is not merged into an existing conflicting ICE subtree
```

For fields missing from ICE, importing individual old values is acceptable only if it cannot widen security policy. For security-sensitive restrictions, prefer whole-subtree conflict reporting over clever partial merging.

### Special care

The old resolver was global-first and deny-first. Preserve that behavior exactly.

Do not reinterpret:

- empty allowed-role semantics;
- role defaults;
- denyRole/denyTool restrictions;
- timeout/output/turn/tool-call caps;
- hook `required` semantics;
- command policy;
- project-trust behavior.

### Hook journal/session state

The current journal type is ICE-named. Old sessions can contain a historical PIV hook journal entry type.

Do not mutate old session files in place. At read/import time either:

- recognize the old custom-entry type as a read-only compatibility input and normalize in memory; or
- preserve the raw historical entry but make observability code understand both forms.

Never allow a historical journal entry to grant new authority or replay a hook.

---

## C07 — Add controlled legacy environment-variable fallback

**Priority:** P0  
**Risk:** Medium-High  
**Purpose:** Preserve launch scripts, shell profiles, `.env` files, CI jobs, and provider behavior.

### General precedence

For each mapped variable:

```text
ICE value present -> use ICE
else legacy value present -> use translated legacy value
else default
```

Empty-string semantics must match current behavior and must be tested.

### Coding-agent variables to map

At minimum audit/map the historical equivalents for:

```text
PI_CODING_AGENT_DIR             -> ICE_CODING_AGENT_DIR
PI_CODING_AGENT_SESSION_DIR     -> ICE_CODING_AGENT_SESSION_DIR
PI_PACKAGE_DIR                  -> ICE_PACKAGE_DIR
PI_SHARE_VIEWER_URL             -> ICE_SHARE_VIEWER_URL
PI_OFFLINE                      -> ICE_OFFLINE
PI_TELEMETRY                    -> ICE_TELEMETRY
PI_EXPERIMENTAL                 -> ICE_EXPERIMENTAL
PI_CLEAR_ON_SHRINK              -> ICE_CLEAR_ON_SHRINK
PI_HARDWARE_CURSOR              -> ICE_HARDWARE_CURSOR
PI_TIMING                       -> ICE_TIMING
PI_SKIP_VERSION_CHECK           -> ICE_SKIP_VERSION_CHECK
PI_STARTUP_BENCHMARK            -> ICE_STARTUP_BENCHMARK
```

### AI/provider variables to map

```text
PI_CACHE_RETENTION                    -> ICE_CACHE_RETENTION
PI_OAUTH_CALLBACK_HOST                -> ICE_OAUTH_CALLBACK_HOST
PI_PROVIDER_CONTINUATION_DIAG         -> ICE_PROVIDER_CONTINUATION_DIAG
PI_PROVIDER_CONTINUATION_DIAG_FILE    -> ICE_PROVIDER_CONTINUATION_DIAG_FILE
PI_PROVIDER_CONTINUATION_DIAG_STDERR  -> ICE_PROVIDER_CONTINUATION_DIAG_STDERR
```

### PIV/ICE provider variables

Audit and map where the semantics are still equivalent:

```text
PIV_LOCAL_API_KEY   -> ICE_LOCAL_API_KEY
PIV_LOCAL_BASE_URL  -> ICE_LOCAL_BASE_URL
PIV_OMNI_BASE_URL   -> ICE_OMNI_BASE_URL
```

Never log the API-key value.

### Cognee variables

Map historical `PI_COGNEE_*` inputs to the corresponding `ICE_COGNEE_*` semantics when ICE values are absent.

This includes at least:

```text
PI_COGNEE_ENABLED
PI_COGNEE_RECALL
PI_COGNEE_REMEMBER
PI_COGNEE_CAPTURE
PI_COGNEE_CAPTURE_TOOLS
PI_COGNEE_IMPROVE
PI_COGNEE_BASE_URL
PI_COGNEE_DATASET
PI_COGNEE_COMPACTION_SUMMARY
```

### Implementation note: avoid fragile bootstrap ordering

Do not assume this is safe:

```ts
import "./main.ts";
bootstrapLegacyEnvironment();
```

ESM imports are evaluated before the module body, so modules that read environment variables during initialization may already have captured the wrong value.

Preferred strategy:

- coding-agent: central legacy-aware environment getter for runtime reads, plus an earliest-possible bootstrap wrapper where process mutation is truly required;
- AI package: extend `packages/ai/src/utils/provider-env.ts` so direct `ice-ai` consumers also receive compatibility without depending on the coding-agent entrypoint;
- module-level constants such as OAuth callback host and timing flags must be explicitly tested for import-time behavior.

### Diagnostics

If a legacy variable is consumed:

- optionally record its **name**, never value;
- deduplicate per process;
- keep default UI quiet unless migration diagnostics are requested;
- never translate an old value over an explicit ICE value.

---

## C08 — Temporary child-shell metadata compatibility

**Priority:** P1  
**Risk:** Medium  
**Purpose:** Old shell scripts/extensions may consume session metadata exported by the bash tool.

Current canonical variables:

```text
ICE_SESSION_ID
ICE_SESSION_FILE
ICE_PROVIDER
ICE_MODEL
ICE_REASONING_LEVEL
```

Historical variables:

```text
PI_SESSION_ID
PI_SESSION_FILE
PI_PROVIDER
PI_MODEL
PI_REASONING_LEVEL
```

### Recommended policy

For a bounded compatibility window, when `exposeSessionEnvironment` is enabled:

1. always export the ICE variables;
2. optionally mirror the same non-secret metadata into the historical variables;
3. clear both families before rebuilding the child env so stale parent values cannot leak;
4. document that old names are compatibility-only;
5. keep this bridge centralized and removable.

This is one of the few places where temporary dual-export is safer than migration because the variables are ephemeral process metadata rather than persisted product identity.

### Security

- never add credential values;
- legacy metadata must equal the canonical ICE value exactly;
- `exposeSessionEnvironment: false` suppresses both families;
- parent environment cannot override computed session metadata.

---

## C09 — Restore theme compatibility as a one-way mirror

**Priority:** P1  
**Risk:** Low  
**Purpose:** Prevent old extension module copies from failing to observe the initialized theme.

### File

- `packages/coding-agent/src/modes/interactive/theme/theme.ts`.

### Design

Keep:

```text
ICE theme symbol = canonical source of truth
```

Add:

```text
legacy theme symbol = write-only mirror
```

`setGlobalTheme(theme)` writes the identical theme object to both keys.

The ICE `theme` proxy continues to read **only** the ICE key.

This avoids allowing an old module to replace ICE's canonical theme state.

### Required tests

- ICE-only theme works;
- legacy-symbol consumer sees current theme;
- changing legacy symbol does not change canonical ICE reads;
- theme reload updates both mirrors;
- no double watcher or duplicate callback is created.

---

## C10 — Preserve RPC compatibility on input, ICE on output

**Priority:** P1  
**Risk:** Low-Medium  
**Purpose:** Avoid breaking UI/desktop clients that cached the pre-cutover structured settings schema ID.

### Files

- `modes/rpc/rpc-command-schema.ts`;
- `modes/rpc/rpc-mode.ts`;
- compatibility helper/tests.

### Rule

Canonical emitted schema remains:

```text
ice.settings
```

Invocation validation may accept:

```text
ice.settings
pi.settings   # legacy input only
```

When the old ID is received:

- normalize it internally to `ice.settings`;
- validate revision/arguments using the current ICE schema;
- return current ICE schema IDs/details in responses;
- never emit `pi.settings` from discovery/get-schema operations.

### Revision handling

Do not blindly accept a stale old revision hash generated from a materially different field set.

Recommended behavior:

- accept old schema ID as an alias;
- still enforce current revision semantics;
- if revision is stale, return the current ICE schema revision in the structured stale error.

### Settings key compatibility

If an old RPC client sends a legacy key such as `piv.subagents.enabled`, normalize it through the same settings translation table **only if the mapping is exact and semantics are unchanged**.

Responses and subsequent snapshots expose only `ice.*` keys.

---

## C11 — Preserve Cognee continuity explicitly

**Priority:** P1  
**Risk:** Medium  
**Purpose:** Avoid making existing memory appear lost after the environment/settings rename.

### Files

- `ice-cognee-env.ts`;
- `ice-cognee.ts`;
- compatibility env/settings helper;
- Cognee tests.

### Required behavior

1. explicit `ICE_COGNEE_*` wins;
2. equivalent `PI_COGNEE_*` may supply a missing ICE value;
3. generic `COGNEE_*` behavior remains unchanged;
4. an explicitly configured historical dataset name must continue to target that dataset after migration;
5. the new default remains ICE-native for genuinely new users;
6. do not silently rename or copy a remote Cognee dataset just for branding;
7. do not expose API keys in migration diagnostics.

### Important distinction

A legacy dataset string containing an old product name is **user data / remote identity**, not product branding that should be renamed automatically.

If the user explicitly configured `PI_COGNEE_DATASET=...`, preserve that value unless they choose a dataset migration.

---

## C12 — Preserve session continuity without rewriting history

**Priority:** P1  
**Risk:** High  
**Purpose:** Existing sessions should remain discoverable after user-state migration.

### Requirements

- import/copy session files into ICE session storage without changing message text merely for branding;
- preserve session IDs and parent relationships where valid;
- run existing version migrations only through the normal session parser;
- historical custom entry types may be recognized in-memory where needed;
- never replay historical tools/hooks during migration;
- preserve timestamps where possible;
- do not duplicate a session if the destination already contains the same ID/content;
- conflicting session IDs with differing bytes must be reported, not overwritten;
- support large-session streaming/bounded reads to avoid startup stalls.

### Acceptance

A representative pre-cutover session can be imported, listed, opened, branched, and continued in ICE without mutating the source session.

---

## C13 — Do not restore old public CLI binaries by default

**Priority:** Policy decision  
**Risk:** Low  

Do **not** reintroduce `pi` or `piv` as official binaries merely to satisfy shell scripts.

Reasons:

- it makes the old identity public again;
- it creates PATH ambiguity with upstream Pi installations;
- it complicates self-update/package ownership;
- it undermines the clean ICE product boundary.

Preferred migration path:

- document `ice` as the only official command;
- optionally let `ice migrate` inspect old configuration;
- users who personally need a temporary shell alias can create one outside the product repository.

This is an **intentional compatibility break** and should be called out explicitly rather than accidentally restored.

---

## C14 — Keep ICE self-update/release logic independent from legacy package ownership

**Priority:** P1  
**Risk:** Medium  

The current self-update code targets ICE release metadata/package names.

Compatibility must not cause ICE to uninstall/update arbitrary old packages unless the install detector can prove it is operating on the currently running package.

### Requirements

- current package identity remains `@zykairotis/ice-coding-agent`;
- old extension package aliases do not become self-update package aliases;
- clean ICE install updates ICE only;
- old install migration may display instructions but must not silently remove an old global package;
- Windows quarantine/self-update paths remain ICE-native;
- package manager cache/install roots remain ICE-native after migration.

---

## C15 — Clean-root Git publication remains separate from runtime compatibility

**Priority:** Last  
**Risk:** Operational  

The current ICE directory is still a worktree of the old repository. That is a repository-identity issue, not a runtime dependency.

After compatibility work is verified:

1. preserve `/home/mewtwo/Zks/pi-void` unchanged as historical/reference source;
2. materialize the verified ICE tree as an independent repository;
3. create the intended ICE remote;
4. do not add the old repo as a permanent remote in the clean ICE repository if the requirement is clean Git metadata;
5. compare against the archive by explicit filesystem path or external bundle when historical analysis is required;
6. rerun all acceptance gates in the independent repository.

Do not delete old Git history. It remains valuable for blame, archaeology, and upstream comparison; it simply belongs outside the clean ICE product repository.

---

# 6. Detailed compatibility test matrix

Create dedicated fixtures that model **real old installations**, not just unit-level string mappings.

## T01 — clean ICE user

State:

```text
~/.ice/agent exists
no legacy state
```

Expected:

- no compatibility diagnostics;
- no migration work;
- behavior byte/semantics-equivalent to current baseline.

## T02 — legacy-only global user

State:

```text
~/.pi/agent exists
~/.ice/agent absent/fresh
```

Expected:

- migration detects useful resources;
- safe data imports to ICE;
- old source untouched;
- ICE starts using canonical destination.

## T03 — both global roots exist

Expected:

- ICE remains authoritative;
- no destructive merge;
- conflicts are reported;
- missing safe resources can be explicitly imported according to migration policy.

## T04 — malformed legacy settings

Expected:

- ICE still starts;
- malformed data cannot enable subagents/hooks;
- no destination overwrite;
- bounded diagnostic.

## T05 — legacy project resource, untrusted project

Expected:

- no extension/hook execution;
- migration availability may be announced safely;
- trust remains required.

## T06 — legacy project resource, trusted project

Expected:

- migration plan shows exact resources;
- copy to `.ice` preserves expected behavior;
- subsequent run uses `.ice` only.

## T07 — legacy manifest only

Package:

```json
{ "pi": { "extensions": ["./index.ts"] } }
```

Expected:

- extension loads through compatible manifest parser;
- provenance indicates legacy manifest;
- no package mutation.

## T08 — both manifest roots

Package contains both `ice` and historical manifest.

Expected:

- ICE manifest wins;
- no merge;
- no duplicate resources.

## T09 — old extension imports

Test representative imports from both historical package families.

Expected:

- loader resolves exact allowlisted specifiers;
- tool/command registration works;
- AI compat helpers work;
- unknown old-like import fails.

## T10 — env fallback

Expected:

```text
only old var set  -> legacy value used
only ICE var set  -> ICE value used
both set           -> ICE wins
neither            -> current default
```

Run for every mapped variable class.

## T11 — child shell metadata

Expected:

- ICE metadata always correct;
- legacy mirrors correct during compatibility window;
- disabled exposure emits neither family;
- no secrets.

## T12 — old `piv` subagent settings

Expected:

- translated values equal pre-cutover semantics;
- role restrictions preserved;
- caps unchanged;
- deny-first behavior unchanged.

## T13 — conflicting `piv` + `ice` security policy

Expected:

- ICE wins deterministically;
- no permissive merge;
- conflict diagnostic.

## T14 — hooks

Expected:

- old hook definitions do not execute during migration;
- after canonical migration, current ICE execution gates still apply;
- no authority expansion.

## T15 — RPC legacy schema ID

Expected:

- old schema ID accepted as input alias;
- response remains `ice.settings`;
- stale revision still rejected correctly;
- current client unaffected.

## T16 — theme bridge

Expected:

- old extension-copy theme getter sees initialized theme;
- ICE ignores writes to old symbol;
- reload stays synchronized from ICE outward.

## T17 — session import

Expected:

- list/open/continue works;
- original bytes unchanged;
- duplicate detection works;
- hook/tool history is not replayed.

## T18 — filesystem attacks

Fixtures:

- symlink to parent;
- symlink to `/etc` or temp external root;
- FIFO/socket/device if platform permits fixture creation;
- oversized directory;
- permission-denied file.

Expected:

- migration refuses unsafe entries;
- no path escapes;
- partial failure does not corrupt ICE destination.

## T19 — package output

Expected:

- canonical package name ICE;
- canonical filenames ICE;
- compatibility strings appear only in audited runtime shim where required;
- no old binary/package aliases are published.

## T20 — clean-root repo

After final publication:

- ICE builds/tests in independent repo;
- runtime Git detection works;
- safe verifier still captures root/HEAD/branch/status;
- no runtime assumption on old repository ancestry.

---

# 7. Implementation sequence

Use this exact order to minimize risk.

## Phase A — compatibility harness before behavior changes

1. Freeze current green baseline results.
2. Add scanner boundary/allowlist tests.
3. Add failing fixtures for old extension imports.
4. Add failing fixtures for old manifests.
5. Add failing fixtures for old env values.
6. Add failing fixtures for legacy settings/state migration.
7. Add security fixtures for project trust and symlink escapes.

**Do not implement compatibility until the red tests prove the breakages being fixed.**

## Phase B — low-risk runtime adapters

8. Implement exact extension import aliases.
9. Implement old manifest fallback with ICE precedence.
10. Implement theme write-only mirror.
11. Implement RPC schema input alias.
12. Run focused compatibility tests + existing extension/theme/RPC suites.

## Phase C — environment compatibility

13. Implement central coding-agent env fallback.
14. Extend AI provider-env fallback independently.
15. Add PIV provider variable mapping.
16. Add Cognee variable mapping.
17. Add temporary child-shell metadata mirror.
18. Verify module-import ordering cases.

## Phase D — persisted state migration

19. Implement inspect/plan data model.
20. Implement safe global-state copy/transform.
21. Implement `piv.* -> ice.*` settings transform.
22. Implement sessions migration.
23. Implement project `.pi -> .ice` migration behind trust.
24. Add migration receipts/idempotency.
25. Add bounded user diagnostics/migration entrypoint.

## Phase E — full regression closure

26. Run compatibility matrix.
27. Run current 29-file/757-test ICE acceptance suite.
28. Run focused existing extension/theme/config/RPC/Cognee/session suites.
29. Run `npm run check`.
30. Run `npm run build:offline`.
31. Run compiled CLI/extension smoke.
32. Run package dry-run and compatibility-aware identity scan.
33. Run `git diff --check`.
34. Inspect final diff specifically for authority widening and migration writes.

## Phase F — repository publication

35. Only after all previous gates pass, create independent ICE Git repository.
36. Preserve old repository separately.
37. Repeat critical build/test/scanner gates in the independent repository.

---

# 8. Files likely to change

Expected core implementation files:

```text
packages/coding-agent/src/core/extensions/loader.ts
packages/coding-agent/src/core/ice-manifest.ts
packages/coding-agent/src/core/resource-loader.ts
packages/coding-agent/src/core/trust-manager.ts
packages/coding-agent/src/core/settings-manager.ts
packages/coding-agent/src/config.ts
packages/coding-agent/src/migrations.ts
packages/coding-agent/src/core/tools/bash.ts
packages/coding-agent/src/modes/interactive/theme/theme.ts
packages/coding-agent/src/modes/rpc/rpc-command-schema.ts
packages/coding-agent/src/modes/rpc/rpc-mode.ts
packages/coding-agent/src/modes/rpc/rpc-settings.ts
packages/coding-agent/src/ice-subagent-settings.ts
packages/coding-agent/src/ice-cognee-env.ts
packages/coding-agent/src/ice-cognee.ts
packages/coding-agent/src/ice-provider.ts
packages/ai/src/utils/provider-env.ts
```

Expected new compatibility files:

```text
packages/coding-agent/src/core/legacy-compat/constants.ts
packages/coding-agent/src/core/legacy-compat/diagnostics.ts
packages/coding-agent/src/core/legacy-compat/env.ts
packages/coding-agent/src/core/legacy-compat/manifests.ts
packages/coding-agent/src/core/legacy-compat/settings.ts
packages/coding-agent/src/core/legacy-compat/state-migration.ts
packages/coding-agent/src/core/legacy-compat/project-migration.ts
packages/coding-agent/src/core/legacy-compat/extension-aliases.ts
packages/coding-agent/src/core/legacy-compat/rpc.ts
packages/coding-agent/src/core/legacy-compat/index.ts
scripts/check-legacy-compat-boundary.mjs
```

Expected test area:

```text
packages/coding-agent/test/legacy-compat/
packages/ai/test/provider-env-legacy-compat.test.ts
```

Avoid spreading legacy constants outside these locations unless a runtime constraint genuinely requires it.

---

# 9. What must NOT be changed

1. Do not restore old branding in startup UI, help output, package descriptions, binary names, or normal docs.
2. Do not publish old Pi/PIV npm package aliases from this repository.
3. Do not restore old CLI binaries.
4. Do not rename third-party projects to ICE.
5. Do not edit license/provenance facts to hide ancestry.
6. Do not delete `/home/mewtwo/Zks/pi-void` or its Git history.
7. Do not auto-execute `.pi` project extensions before trust.
8. Do not mutate old settings/session files in place.
9. Do not merge security policies in a way that can increase authority.
10. Do not weaken current subagent timeouts, output budgets, tool filtering, revocation, hook policy, verification, or no-recursion rules.
11. Do not turn compatibility diagnostics into secret/value logging.
12. Do not remove the existing ICE AI legacy API-shape compat layer.
13. Do not run bulk search/replace over the compatibility layer after implementation.

---

# 10. Required regression suites

At closure, run at least the following.

## 10.1 Critical ICE acceptance baseline

The same renamed 29 functional files that currently produce:

```text
29/29 files
757/757 tests
```

must remain exactly green.

## 10.2 Compatibility-specific suite

All new tests under:

```text
packages/coding-agent/test/legacy-compat/
packages/ai/test/provider-env-legacy-compat.test.ts
```

must pass.

## 10.3 Existing focused suites

Include at least:

```text
extensions-discovery
extensions-runner
theme-export
theme-picker
config
config-value-migration
keybindings-migration
settings-manager
resource-loader
package-manager
rpc-settings
rpc-command-schema
session-manager/session operations
ice-cognee
ice-provider
```

## 10.4 Static/build gates

```text
npm run check
npm run build:offline
git diff --check
```

## 10.5 Compiled runtime smoke

Verify from built artifacts:

- `ice --help`;
- `ice --version`;
- ICE-native extension import;
- representative legacy extension import;
- resource manifest fallback;
- theme compatibility bridge;
- settings migration helper;
- no old CLI binary generated.

## 10.6 Package dry run

Verify:

```text
package name = @zykairotis/ice-coding-agent
bin = ice only
no legacy-named files
no old package published as an alias
```

The package may contain the exact old strings inside the compatibility shim; that is intentional and must be audited by path rather than pretending the count can remain zero.

---

# 11. Compatibility-aware identity acceptance rule

The previous literal "zero old strings everywhere" requirement conflicts with preserving old inputs. A loader cannot recognize an old import specifier without representing that specifier somewhere.

Replace the old rule with this stronger and more useful invariant:

> **Zero old product identity outside audited compatibility/provenance boundaries.**

### Must remain zero in canonical product surfaces

- package names;
- binary names;
- filenames distributed as product-owned ICE modules;
- default config paths;
- default environment names;
- startup UI;
- normal help output;
- new settings keys;
- new RPC schema output;
- new session/custom-entry types;
- release artifact names;
- new docs/examples intended for ICE users.

### Old identity is allowed only for compatibility recognition

- exact extension alias map;
- legacy manifest parser;
- legacy environment map;
- settings migration map;
- RPC input alias;
- old theme symbol mirror;
- migration tests/fixtures;
- factual third-party/history/provenance references.

The scanner should print the allowlisted path + category for every allowed occurrence, making compatibility debt visible and removable later.

---

# 12. Deprecation/removal strategy

Do not make compatibility permanent by accident.

Each compatibility facility should have:

- an internal compatibility version;
- usage diagnostics/counters that contain no private values;
- tests that separate canonical and legacy behavior;
- a documented removal prerequisite.

Suggested lifecycle:

```text
Stage 1: ICE 0.x transition
  legacy compatibility default-on
  migration strongly encouraged

Stage 2: after migration telemetry/manual confidence
  warn more explicitly when legacy input is consumed

Stage 3: future major version only
  remove selected compatibility surfaces after documented notice
```

Do not tie removal to an arbitrary date without evidence that users/assets have migrated.

---

# 13. Release / rollback safety

Before merging compatibility changes:

1. preserve the current green ICE tree/hash state;
2. keep compatibility changes in logically separable commits when the user later asks for commits;
3. do not mix clean-root Git publication into runtime compatibility commits;
4. make migration receipt format versioned;
5. ensure every migration action is retryable;
6. ensure disabling/removing the compatibility adapter returns runtime to current ICE-native behavior without corrupting canonical state.

A rollback must never require restoring files from `~/.pi` because those files were never mutated.

---

# 14. Completion checklist

The follow-up is complete only when every item below is true.

### Extension/package compatibility

- [ ] Historical Earendil Pi import specifiers load through ICE's extension loader.
- [ ] Historical upstream Mario Zechner import specifiers load through ICE's extension loader.
- [ ] ICE-native imports remain canonical.
- [ ] Old package manifest is accepted only as a fallback.
- [ ] ICE manifest wins when both exist.
- [ ] Unknown old-like imports are rejected.

### User state

- [ ] Legacy global state is detected.
- [ ] Migration is previewable/auditable.
- [ ] Migration is non-destructive.
- [ ] Existing ICE files are never overwritten by default.
- [ ] Sessions remain accessible.
- [ ] Auth permissions/secrets remain safe.
- [ ] Migration is idempotent.

### Project state / security

- [ ] Legacy project resources cannot execute while untrusted.
- [ ] Project migration rejects path escapes.
- [ ] `.ice` is authoritative when both trees exist.
- [ ] No duplicate extension/resource execution.

### Settings

- [ ] `piv.subagents` translates safely to `ice.subagents`.
- [ ] `piv.hooks` translates safely to `ice.hooks`.
- [ ] Deny-first semantics remain identical.
- [ ] ICE settings win conflicts.
- [ ] Hook journal/session compatibility cannot replay authority.

### Environment

- [ ] Legacy coding-agent envs fall back only when ICE counterpart is absent.
- [ ] AI/provider envs have direct-package compatibility.
- [ ] PIV provider envs map safely.
- [ ] Cognee envs map safely.
- [ ] Child metadata compatibility contains no secrets.
- [ ] Import-time environment behavior is tested.

### RPC/theme

- [ ] `pi.settings` is accepted only as legacy input.
- [ ] New RPC output remains `ice.settings`.
- [ ] Old theme consumer can read the current theme.
- [ ] ICE never trusts old theme symbol as canonical state.

### Product identity

- [ ] CLI is still `ice` only.
- [ ] Packages remain `@zykairotis/ice-*` only.
- [ ] Default config is `.ice` / `~/.ice/agent`.
- [ ] Default env/documentation is ICE-only.
- [ ] Old identifiers are confined to compatibility/provenance allowlist.
- [ ] Third-party names remain factually correct.

### Regression gates

- [ ] 29/29 critical files pass.
- [ ] 757/757 critical tests pass.
- [ ] compatibility suite passes.
- [ ] focused extension/theme/config/RPC/session/Cognee/provider tests pass.
- [ ] `npm run check` passes.
- [ ] `npm run build:offline` passes.
- [ ] compiled smoke passes.
- [ ] package dry-run passes.
- [ ] compatibility-aware identity scan passes.
- [ ] `git diff --check` passes.

### Publication

- [ ] ICE becomes an independent repository only after runtime compatibility is green.
- [ ] old Pi-Void repository/history remains preserved separately.
- [ ] clean-root ICE repo repeats critical acceptance gates.

---

# 15. Final implementation principle

The purpose of this follow-up is **not** to make ICE pretend it is still Pi.

The purpose is to make upgrading safe:

```text
Existing user data / extension / script
        │
        ▼
recognized safely
        │
        ▼
translated or imported once
        │
        ▼
canonical ICE behavior
        │
        ▼
all future writes remain ICE
```

This gives ICE a clean forward identity while protecting the real functionality and user state accumulated before the rename.

The compatibility layer should be treated like a migration boundary: narrow, tested, security-aware, observable, and removable later—never as a second permanent product namespace.
