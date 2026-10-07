/**
 * Subagent V2 frozen child runtime contract (Phase 0: types only).
 *
 * Design: Plan/subagent-rewrite.md sections 6.4, 10, 11.5. Created once per
 * child after every trust/model/scope/context/tool/policy check, persisted
 * before launch, and never re-resolved from changed definitions (D13, D15, D16).
 * Canonical serialization and hashing land in P4.3.
 */

import type { AgentDefinitionSource, AgentIsolationMode, AgentThinkingLevel } from "../definitions/schema.ts";
import type { AgentPermissionMode, PermissionDecision, PermissionRuleScope } from "../permissions/rules.ts";
import type { SubagentTaskContract } from "../results/task-contract.ts";
import type { ResolvedSubagentResources } from "../types.ts";

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

/**
 * A child rule as frozen into the contract, in `tool` or `tool(pattern)` form. The origin
 * scope is kept because only user/managed allow rules lift the child mutation ceiling.
 */
export interface NormalizedPermissionRule {
	rule: string;
	decision: PermissionDecision;
	scope: PermissionRuleScope;
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
		/** Skills, prompt templates, and context files selected by the definition, hash-pinned at acceptance. */
		resources?: ResolvedSubagentResources;
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
		/** Whether `--sub-yolo` was active at acceptance; revival requires it to still be active. */
		subYolo: boolean;
		/** Agent permission preset frozen at acceptance. */
		agentMode: AgentPermissionMode;
		/** Parent ICE mode at acceptance; a parent that has since moved to plan blocks mutation-capable children. */
		parentMode: "plan" | "build";
		/** Drift blocks new turns instead of silently reauthorizing a frozen child. */
		parentPolicyHash?: string;
		worktree: boolean;
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
		/** Synthetic baseline commit capturing the parent's dirty tree at spawn. */
		baselineId?: string;
		baselineTree?: string;
		headCommit?: string;
		repoRoot?: string;
		/** Parent cwd relative to repoRoot; the child cwd is worktreePath + cwdOffset. */
		cwdOffset?: string;
		worktreePath?: string;
	};

	createdAt: string;
}
