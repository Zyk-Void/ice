/** Legacy fixed child tool-set derivation (moved from ice-subagents.ts; replaced in V2 Phase 4). */

import { resolveSubagentProfile } from "../definitions/legacy-profiles.ts";
import {
	SUBAGENT_REQUESTED_TOOL_NAMES,
	SUBAGENT_TOOL_NAMES,
	type SubagentProfile,
	type SubagentRequestedToolName,
	type SubagentToolName,
	WRITER_TOOL_NAMES,
	type WriterToolName,
} from "../types.ts";

export interface EffectiveSubagentToolOptions {
	requestedTools: readonly string[];
	parentActiveTools: readonly string[];
	unsafeHostExec?: boolean;
}

export function deriveEffectiveSubagentTools(options: EffectiveSubagentToolOptions): SubagentRequestedToolName[] {
	const parentTools = new Set(options.parentActiveTools);
	const requestedTools = new Set(options.requestedTools);
	const allowedTools = options.unsafeHostExec ? SUBAGENT_REQUESTED_TOOL_NAMES : SUBAGENT_TOOL_NAMES;
	return allowedTools.filter((tool) => parentTools.has(tool) && requestedTools.has(tool));
}

export function deriveSubagentTools(
	parentActiveTools: readonly string[],
	role: string | SubagentProfile,
): SubagentToolName[] {
	const profile = typeof role === "string" ? resolveSubagentProfile(role, { cwd: process.cwd() }) : role;
	return deriveEffectiveSubagentTools({
		requestedTools: profile.requestedTools ?? profile.tools,
		parentActiveTools,
		unsafeHostExec: false,
	}) as SubagentToolName[];
}

export function deriveUnsafeSubagentTools(parentActiveTools: readonly string[]): WriterToolName[] {
	const parentTools = new Set(parentActiveTools);
	return WRITER_TOOL_NAMES.filter((tool) => parentTools.has(tool));
}

export function deriveWriterTools(parentActiveTools: readonly string[]): WriterToolName[] {
	if (!parentActiveTools.includes("delegate_write")) return [];
	const parentTools = new Set(parentActiveTools);
	const tools = WRITER_TOOL_NAMES.filter((tool) => parentTools.has(tool));
	return tools.length === WRITER_TOOL_NAMES.length ? [...tools] : [];
}
