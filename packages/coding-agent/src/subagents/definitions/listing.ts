/**
 * Subagent V2 model-visible agent listing (Plan/subagent-rewrite.md section 7.6, P2.6).
 *
 * The list travels as custom-message deltas so the `agent` tool schema stays
 * byte-stable for the prompt cache (Claude Code `agent_listing_delta`). The caller
 * derives `seen` from the listing entries in the current branch context and passes
 * `undefined` after compaction, branch navigation, resume/reload, or a model change
 * to force a full re-list.
 */
import type { ResolvedAgentDefinition } from "./schema.ts";

export const AGENT_LISTING_MAX_BYTES = 8 * 1024;
export const AGENT_LISTING_CUSTOM_TYPE = "ice_agent_listing";

/** Hash per advertised agent name, as last shown to the model. */
export type AgentListingState = ReadonlyMap<string, string>;

/** Callable agents: not hidden, not limited, and with every required MCP server present. */
export function callableAgentDefinitions(
	active: ReadonlyMap<string, ResolvedAgentDefinition>,
	availableMcpServers: readonly string[] = [],
): ResolvedAgentDefinition[] {
	const servers = availableMcpServers.map((server) => server.toLowerCase());
	return [...active.values()].filter((definition) => {
		if (definition.limited || definition.fields.hidden) return false;
		return (definition.fields.requiredMcpServers ?? []).every((required) =>
			servers.some((server) => server.includes(required.toLowerCase())),
		);
	});
}

function toolSummary(definition: ResolvedAgentDefinition): string {
	const tools = definition.fields.tools;
	const list = typeof tools === "string" ? tools.split(",").map((tool) => tool.trim()) : tools;
	const disallowed = definition.fields.disallowedTools ?? [];
	if (list && !(list.length === 1 && list[0] === "*")) {
		const allowed = list.filter((tool) => !disallowed.includes(tool));
		return allowed.join(", ") || "None";
	}
	return disallowed.length > 0 ? `All tools except ${disallowed.join(", ")}` : "All tools";
}

export function formatAgentListingLine(definition: ResolvedAgentDefinition): string {
	return `- ${definition.name}: ${definition.description} (Tools: ${toolSummary(definition)})`;
}

export interface AgentListingDelta {
	full: boolean;
	added: readonly ResolvedAgentDefinition[];
	changed: readonly ResolvedAgentDefinition[];
	removed: readonly string[];
	next: AgentListingState;
}

export function computeAgentListingDelta(
	seen: AgentListingState | undefined,
	callable: readonly ResolvedAgentDefinition[],
): AgentListingDelta {
	const next = new Map(callable.map((definition) => [definition.name, definition.sourceHash]));
	if (!seen) return { full: true, added: callable, changed: [], removed: [], next };
	const added = callable.filter((definition) => !seen.has(definition.name));
	const changed = callable.filter(
		(definition) => seen.has(definition.name) && seen.get(definition.name) !== definition.sourceHash,
	);
	const removed = [...seen.keys()].filter((name) => !next.has(name));
	return { full: false, added, changed, removed, next };
}

/** Message text for a delta, or undefined when nothing changed. Bounded to AGENT_LISTING_MAX_BYTES. */
export function renderAgentListingMessage(
	delta: AgentListingDelta,
	maxBytes = AGENT_LISTING_MAX_BYTES,
): string | undefined {
	const shown = [...delta.added, ...delta.changed];
	if (!delta.full && shown.length === 0 && delta.removed.length === 0) return undefined;
	const header = delta.full
		? shown.length > 0
			? "Agents available to the `agent` tool:"
			: "No agents are available to the `agent` tool."
		: "Agent list update:";
	const removedLine = delta.removed.length > 0 ? `Removed: ${delta.removed.join(", ")}` : undefined;
	const footer = "Use agent_control action=agents for availability details.";
	const lines = shown.map(formatAgentListingLine);
	const build = (body: readonly string[]) =>
		[header, ...body, ...(removedLine ? [removedLine] : []), footer].join("\n");
	let text = build(lines);
	if (Buffer.byteLength(text) <= maxBytes) return text;
	// Over budget: names with truncated descriptions, then names only.
	const short = shown.map((definition) => `- ${definition.name}: ${definition.description.slice(0, 80)}`);
	text = build(short);
	if (Buffer.byteLength(text) <= maxBytes) return text;
	return build([`- ${shown.map((definition) => definition.name).join(", ")}`]);
}
