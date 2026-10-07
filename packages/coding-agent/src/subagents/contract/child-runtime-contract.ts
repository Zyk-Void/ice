/**
 * Subagent V2 frozen child runtime contract (Phase 0: types only).
 *
 * Design: Plan/subagent-rewrite.md sections 6.4, 10, 11.5. Created once per
 * child after every trust/model/scope/context/tool/policy check, persisted
 * before launch, and never re-resolved from changed definitions (D13, D15, D16).
 * Canonical serialization and hashing land in P4.3.
 */

import type { AgentDefinitionSource, AgentIsolationMode, AgentThinkingLevel } from "../definitions/schema.ts";
import type { PermissionDecision } from "../permissions/rules.ts";
import type { SubagentTaskContract } from "../results/task-contract.ts";

export const CHILD_RUNTIME_CONTRACT_VERSION = 2;

/** One durable child ID for the whole lifetime: `ag_` + 26 lowercase base32 chars (128 bits). */
export const CHILD_ID_PATTERN_SOURCE = "^ag_[a-z2-7]{26}$";
export const CHILD_ID_PATTERN = new RegExp(CHILD_ID_PATTERN_SOURCE);
/** Display/synthesis handle for a multi-task launch; never a child identity. */
export const CHILD_GROUP_ID_PATTERN = /^agg_[a-z2-7]{26}$/;

export function isChildId(value: unknown): value is string {
	return typeof value === "string" && CHILD_ID_PATTERN.test(value);
}

export function isChildGroupId(value: unknown): value is string {
	return typeof value === "string" && CHILD_GROUP_ID_PATTERN.test(value);
}

/** A normalized rule as frozen into the contract; matching semantics are owned by the Phase 3 evaluator. */
export interface NormalizedPermissionRule {
	tool: string;
	pattern?: string;
	decision: PermissionDecision;
}

export interface FrozenChildTool {
	name: string;
	/** Present for parent-owned adapters and MCP tools; revival blocks when it no longer matches (section 17). */
	adapterId?: string;
	fingerprint?: string;
	access: "read-only" | "mutation";
}

export interface ChildRuntimeContract {
	version: typeof CHILD_RUNTIME_CONTRACT_VERSION;
	id: string;
	ownerSessionId: string;
	rootSessionId: string;
	parentChildId?: string;
	depth: number;

	agent: {
		name: string;
		source: AgentDefinitionSource;
		sourcePath?: string;
		sourceHash: string;
		resolvedDefinitionHash: string;
	};

	prompt: {
		/** Post-redaction system prompt actually sent to the child. */
		system: string;
		initialPrompt?: string;
		contextFiles: boolean;
		resourceHashes: ReadonlyArray<{ id: string; sha256: string }>;
	};

	model: {
		provider: string;
		model: string;
		thinking: AgentThinkingLevel;
		temperature?: number;
		topP?: number;
		/** Candidates skipped during resolution, recorded for diagnostics only. */
		skippedCandidates?: ReadonlyArray<{ reference: string; reason: string }>;
	};

	capabilities: {
		tools: readonly FrozenChildTool[];
		permissionRules: readonly NormalizedPermissionRule[];
		scopeRoots: readonly string[];
		targets?: readonly string[];
		mcpServers: readonly string[];
		spawns: readonly string[];
		maxDepth: number;
		/** Whether `--sub-yolo` was active at acceptance; revival requires the same or stricter state. */
		subYolo: boolean;
	};

	result: {
		outputSchema?: Readonly<Record<string, unknown>>;
		acceptance: readonly string[];
		taskContract: SubagentTaskContract;
	};

	/** `undefined` budgets mean unlimited; there is no default lifetime timeout. */
	budgets: {
		maxTurns?: number;
		maxTokens?: number;
		timeoutMs?: number;
		startupTimeoutMs: number;
	};

	isolation: {
		mode: AgentIsolationMode;
		baselineId?: string;
		worktreePath?: string;
	};

	createdAt: string;
}
