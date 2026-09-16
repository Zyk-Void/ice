/**
 * Approved historical Pi specifiers mapped to their canonical ICE specifiers.
 *
 * Pi extensions import from `@earendil-works/*` (current upstream) or
 * `@mariozechner/*` (historical). ICE renamed those packages to
 * `@zykairotis/ice-*`, so without this mapping a pi package installs cleanly
 * and then fails to load with a module-resolution error.
 *
 * Exact match only. The pi-ai root resolves to the ICE compat entrypoint, a
 * strict superset of the core entrypoint, so a prefix rewrite would send
 * subpaths to the wrong module; unsupported Pi-like specifiers must stay
 * unresolved rather than being guessed at.
 *
 * Data only: this module never resolves files, inspects packages, or loads
 * modules. Resolution policy belongs to the extension loader.
 */
export const LEGACY_PI_EXTENSION_ALIASES = {
	"@earendil-works/pi-coding-agent": "@zykairotis/ice-coding-agent",
	"@earendil-works/pi-agent-core": "@zykairotis/ice-agent-core",
	"@earendil-works/pi-tui": "@zykairotis/ice-tui",
	"@earendil-works/pi-ai": "@zykairotis/ice-ai",
	"@earendil-works/pi-ai/compat": "@zykairotis/ice-ai/compat",
	"@earendil-works/pi-ai/oauth": "@zykairotis/ice-ai/oauth",
	"@earendil-works/pi-ai/providers/all": "@zykairotis/ice-ai/providers/all",
	"@mariozechner/pi-coding-agent": "@zykairotis/ice-coding-agent",
	"@mariozechner/pi-agent-core": "@zykairotis/ice-agent-core",
	"@mariozechner/pi-tui": "@zykairotis/ice-tui",
	"@mariozechner/pi-ai": "@zykairotis/ice-ai",
	"@mariozechner/pi-ai/compat": "@zykairotis/ice-ai/compat",
	"@mariozechner/pi-ai/oauth": "@zykairotis/ice-ai/oauth",
	"@mariozechner/pi-ai/providers/all": "@zykairotis/ice-ai/providers/all",
} as const;

export type LegacyPiSpecifier = keyof typeof LEGACY_PI_EXTENSION_ALIASES;

export type LegacyPiAliasTarget = (typeof LEGACY_PI_EXTENSION_ALIASES)[LegacyPiSpecifier];
