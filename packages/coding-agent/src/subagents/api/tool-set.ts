/**
 * Subagent V2 rollout gate (Phase 0: contract only).
 *
 * Design: Plan/subagent-rewrite.md section 23 "Rollout gate". From P6.0 until
 * P10.2 the setting or env var selects exactly one subagent tool set; the model
 * never sees legacy and V2 tools together. P10.2 deletes this module with the
 * legacy tools.
 */

export const SUBAGENTS_V2_SETTING_PATH = "ice.subagents.v2";
export const SUBAGENTS_V2_ENV = "ICE_SUBAGENTS_V2";

export const V2_SUBAGENT_TOOL_NAMES = Object.freeze(["agent", "agent_control", "agent_patch"] as const);

/** The 15 tools registered today by the legacy extension (subagents/legacy-extension.ts). */
export const LEGACY_SUBAGENT_TOOL_NAMES = Object.freeze([
	"list_subagent_profiles",
	"manage_subagent",
	"delegate",
	"delegate_async",
	"read_subagent_output",
	"inspect_subagent_job",
	"cancel_subagent_job",
	"inspect_subagent_batch",
	"cancel_subagent_batch",
	"delegate_batch",
	"review_batch",
	"delegate_write",
	"inspect_writer_patch",
	"reject_writer_patch",
	"integrate_writer_patch",
] as const);

export function isSubagentsV2Enabled(setting: unknown, env: string | undefined): boolean {
	return setting === true || env === "1" || env === "true";
}

export function selectSubagentToolNames(v2Enabled: boolean): readonly string[] {
	return v2Enabled ? V2_SUBAGENT_TOOL_NAMES : LEGACY_SUBAGENT_TOOL_NAMES;
}
