/**
 * Subagent V2 definition precedence (Plan/subagent-rewrite.md sections 7.1-7.2, P2.4).
 *
 * Later sources win per name. Within one source the first definition wins, so the
 * most specific project directory (closest to cwd) beats its ancestors. Managed
 * definitions are a lock layer: highest precedence and immune to `disabledAgents`.
 * Every losing definition is kept as shadow history for diagnostics.
 */
import type { AgentDefinitionIssue } from "./parse.ts";
import type { AgentDefinitionSource, ResolvedAgentDefinition } from "./schema.ts";

export const AGENT_SOURCE_PRECEDENCE: readonly AgentDefinitionSource[] = Object.freeze([
	"builtin",
	"package",
	"user",
	"user-settings",
	"project-compat",
	"project",
	"project-settings",
	"flag",
	"managed",
]);

export interface ShadowedAgentDefinition {
	definition: ResolvedAgentDefinition;
	shadowedBy: { source: AgentDefinitionSource; sourcePath?: string };
}

export interface AgentDefinitionSet {
	/** Winning definition per name, excluding disabled names. */
	active: ReadonlyMap<string, ResolvedAgentDefinition>;
	shadowed: readonly ShadowedAgentDefinition[];
	disabled: readonly ResolvedAgentDefinition[];
	issues: readonly AgentDefinitionIssue[];
}

export function resolveAgentDefinitionSet(input: {
	definitions: readonly ResolvedAgentDefinition[];
	issues?: readonly AgentDefinitionIssue[];
	disabledAgents?: readonly string[];
}): AgentDefinitionSet {
	const rank = (source: AgentDefinitionSource) => AGENT_SOURCE_PRECEDENCE.indexOf(source);
	const ordered = input.definitions
		.map((definition, index) => ({ definition, index }))
		.sort((left, right) => rank(left.definition.source) - rank(right.definition.source) || right.index - left.index);
	const winners = new Map<string, ResolvedAgentDefinition>();
	const shadowed: ShadowedAgentDefinition[] = [];
	for (const { definition } of ordered) {
		const previous = winners.get(definition.name);
		if (previous) {
			shadowed.push({
				definition: previous,
				shadowedBy: {
					source: definition.source,
					...(definition.sourcePath ? { sourcePath: definition.sourcePath } : {}),
				},
			});
		}
		winners.set(definition.name, definition);
	}
	const disabledNames = new Set(input.disabledAgents ?? []);
	const active = new Map<string, ResolvedAgentDefinition>();
	const disabled: ResolvedAgentDefinition[] = [];
	for (const [name, definition] of [...winners].sort(([left], [right]) => left.localeCompare(right))) {
		if (disabledNames.has(name) && definition.source !== "managed") disabled.push(definition);
		else active.set(name, definition);
	}
	return Object.freeze({
		active,
		shadowed: Object.freeze(shadowed),
		disabled: Object.freeze(disabled),
		issues: Object.freeze([...(input.issues ?? [])]),
	});
}
