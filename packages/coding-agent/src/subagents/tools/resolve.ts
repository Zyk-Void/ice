/**
 * Subagent V2 child tool resolution (Plan/subagent-rewrite.md sections 9.4 and 17, P4.1/P4.2).
 *
 * The child tool set is always a subset of the parent's live, active, child-safe
 * tools (D3/D4), modeled on Claude Code's resolveAgentTools:
 *   pool  = parent tools - management tools - unknown-access or non-child-safe tools
 *   pool -= disallowedTools
 *   tools = pool when `tools` is omitted or ["*"], else the named/globbed subset
 * MCP tools enter only through an explicit `mcp` selector or exact name, never
 * through `*`. Recursion tools are added only from the gated delegation result.
 * Unavailable names are diagnostics, not silent drops.
 */
import type { FrozenChildTool } from "../contract/child-runtime-contract.ts";
import { globMatches } from "../permissions/rules.ts";
import { isIceParentManagementTool } from "./adapters.ts";

/** A tool as seen in the live parent session at resolution time. */
export interface ParentToolInfo {
	name: string;
	access: "read-only" | "mutation" | "unknown";
	/** Host assertion that dispatch honors scope, cancellation, and independent child state. */
	childSafe: boolean;
	adapterId?: string;
	fingerprint?: string;
	/** MCP identity, matched by definition `mcp` selectors in `server/tool` form. */
	mcp?: { server: string; tool: string };
}

export interface ChildToolResolution {
	tools: readonly FrozenChildTool[];
	diagnostics: readonly string[];
}

function freeze(tool: ParentToolInfo): FrozenChildTool {
	return Object.freeze({
		name: tool.name,
		access: tool.access === "read-only" ? "read-only" : "mutation",
		...(tool.adapterId ? { adapterId: tool.adapterId } : {}),
		...(tool.fingerprint ? { fingerprint: tool.fingerprint } : {}),
	});
}

export function resolveChildTools(input: {
	parentTools: readonly ParentToolInfo[];
	tools?: readonly string[];
	disallowedTools?: readonly string[];
	mcp?: readonly string[];
	/** From childDelegationTools; empty unless every recursion condition holds. */
	delegationTools?: readonly string[];
}): ChildToolResolution {
	const diagnostics: string[] = [];
	const byName = new Map(input.parentTools.map((tool) => [tool.name, tool]));
	const disallowed = input.disallowedTools ?? [];
	const isDisallowed = (name: string) => disallowed.some((pattern) => globMatches(pattern, name));
	const eligible = (tool: ParentToolInfo): string | undefined => {
		if (isIceParentManagementTool(tool.name)) return "is a parent management tool";
		if (!tool.childSafe) return "is not child-safe";
		if (tool.access === "unknown") return "has unknown access classification";
		return undefined;
	};
	const pool = input.parentTools.filter((tool) => !eligible(tool) && !isDisallowed(tool.name));
	const selected = new Map<string, ParentToolInfo>();
	const requested = input.tools;
	const wildcard = requested === undefined || (requested.length === 1 && requested[0] === "*");
	if (wildcard) {
		for (const tool of pool) if (!tool.mcp) selected.set(tool.name, tool);
	} else {
		for (const spec of requested) {
			const matches = pool.filter((tool) => globMatches(spec, tool.name));
			if (matches.length === 0) {
				const parent = byName.get(spec);
				const reason = !parent
					? "is not active in the parent"
					: isDisallowed(spec)
						? "is listed in disallowedTools"
						: eligible(parent);
				diagnostics.push(`tool "${spec}" ${reason ?? "is unavailable"}`);
			}
			for (const tool of matches) selected.set(tool.name, tool);
		}
	}
	for (const selector of input.mcp ?? []) {
		const matches = pool.filter((tool) => tool.mcp && globMatches(selector, `${tool.mcp.server}/${tool.mcp.tool}`));
		if (matches.length === 0) diagnostics.push(`mcp selector "${selector}" matches no child-safe parent MCP tool`);
		for (const tool of matches) selected.set(tool.name, tool);
	}
	for (const name of input.delegationTools ?? []) {
		const tool = byName.get(name);
		if (tool) selected.set(name, tool);
		else diagnostics.push(`delegation tool "${name}" is not active in the parent`);
	}
	return Object.freeze({
		tools: Object.freeze(
			[...selected.values()].sort((left, right) => left.name.localeCompare(right.name)).map(freeze),
		),
		diagnostics: Object.freeze(diagnostics),
	});
}
