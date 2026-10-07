import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TSchema } from "typebox";
import type { AgentSession } from "./core/agent-session.ts";
import type { IceSubagentMcpAdapter, IceSubagentMcpToolAuthorization } from "./ice-subagents.ts";

/** Parent adapter snapshots are capped by ICE subagent admission. */
const MAX_AUTHORIZED_TOOLS = 64;

interface McpServerConfig {
	approveTools?: boolean | string[];
	disabled?: boolean;
}

interface McpCachedTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function globToRegExp(pattern: string): RegExp {
	return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

/**
 * Classify cached MCP tools from the user's own approval policy, never from server descriptions.
 * Only servers with an explicit `approveTools` pattern list are classified: tools it gates are
 * mutations, the rest are read-only. `approveTools: true` marks every tool a mutation; servers
 * without a list stay unclassified and are not offered to children.
 */
export function listPiMcpAuthorizedTools(agentDir: string): IceSubagentMcpToolAuthorization[] {
	const config = readJson(join(agentDir, "mcp.json")) as { mcpServers?: Record<string, McpServerConfig> } | undefined;
	const cache = readJson(join(agentDir, "mcp-cache.json")) as
		| { servers?: Record<string, { tools?: McpCachedTool[] }> }
		| undefined;
	const readOnly: IceSubagentMcpToolAuthorization[] = [];
	const mutation: IceSubagentMcpToolAuthorization[] = [];
	for (const [server, definition] of Object.entries(config?.mcpServers ?? {})) {
		if (definition.disabled === true) continue;
		const approve = definition.approveTools;
		if (approve !== true && !Array.isArray(approve)) continue;
		const gates = Array.isArray(approve) ? approve.map(globToRegExp) : [];
		for (const tool of cache?.servers?.[server]?.tools ?? []) {
			const schema = tool.inputSchema as { type?: unknown } | undefined;
			if (schema?.type !== "object") continue;
			const gated =
				approve === true || gates.some((gate) => gate.test(tool.name) || gate.test(`${server}_${tool.name}`));
			const entry: IceSubagentMcpToolAuthorization = {
				selector: `${server}/${tool.name}`,
				access: gated ? "mutation" : "read-only",
				parameters: schema as TSchema,
				...(tool.description ? { description: tool.description } : {}),
			};
			(gated ? mutation : readOnly).push(entry);
		}
	}
	// Read-only tools are what children use by default; mutations fill any remaining slots.
	return [...readOnly, ...mutation].slice(0, MAX_AUTHORIZED_TOOLS);
}

/**
 * Bridge the parent's pi-mcp-adapter into ICE subagents. Calls run through the parent's own `mcp`
 * proxy tool, so they reuse its connections and approval gate; ICE opens no MCP connection itself.
 */
export function createPiMcpSubagentAdapter(options: {
	agentDir: string;
	getParentSession: () => AgentSession | undefined;
}): IceSubagentMcpAdapter {
	return {
		listAuthorizedTools: () => listPiMcpAuthorizedTools(options.agentDir),
		async dispatch(server, tool, params, signal) {
			const proxy = options.getParentSession()?.getRegisteredTool("mcp");
			if (!proxy) throw new Error("The parent session has no active MCP proxy tool.");
			return proxy.execute(`subagent-mcp-${randomUUID()}`, { server, tool, args: params }, signal);
		},
	};
}
