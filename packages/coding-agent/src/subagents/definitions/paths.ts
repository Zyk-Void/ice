/**
 * Agent-definition directories and small shared helpers for subagent resources.
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir, getProjectConfigDir } from "../../config.ts";
import { getIceEnv } from "../../core/legacy-compat/env.ts";
import type { IceResolvedDelegableTool } from "../tools/adapters.ts";

/** Where a subagent's skills, prompts, and context files resolve from. */
export interface SubagentResourceResolutionOptions {
	cwd: string;
	agentDir?: string;
	projectTrusted?: boolean;
	includeSelf?: boolean;
	delegableTools?: readonly IceResolvedDelegableTool[];
	/** Optional invocation capabilities used when projecting profile availability. */
	parentActiveTools?: readonly string[];
	unsafeHostExec?: boolean;
}

/**
 * The global agent-definition directory. With the default agent directory (`~/.ice/agent`) it is the sibling
 * `~/.ice/agents`; an explicit or environment-overridden agent directory keeps `<agentDir>/agents`.
 */
export function getSubagentGlobalAgentsDir(agentDir?: string): string {
	const effectiveAgentDir = resolve(agentDir ?? getAgentDir());
	if (getIceEnv(ENV_AGENT_DIR) || effectiveAgentDir !== resolve(getAgentDir()))
		return join(effectiveAgentDir, "agents");
	return join(dirname(effectiveAgentDir), "agents");
}

export function hashSource(source: Uint8Array | string): string {
	return createHash("sha256").update(source).digest("hex");
}

/** The nearest `name` directory at or above `cwd`; `.ice/...` names resolve through the project config dir. */
export function findNearestDirectory(cwd: string, name: string): string | undefined {
	let current = resolve(cwd);
	while (true) {
		const prefix = `${CONFIG_DIR_NAME}${sep}`;
		const candidate = name.startsWith(prefix)
			? join(getProjectConfigDir(current), name.slice(prefix.length))
			: join(current, name);
		if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}
