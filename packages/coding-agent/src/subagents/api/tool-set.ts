/**
 * Subagent V2 rollout gate.
 *
 * Design: Plan/subagent-rewrite.md section 23 "Rollout gate". V2 is the default;
 * `ice.subagents.v2: false` or ICE_SUBAGENTS_V2=0 selects the legacy tool set
 * until P10.2 deletes it. The model never sees legacy and V2 tools together.
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

/** The env var wins when set to a recognized value; otherwise only an explicit `false` setting opts out. */
export function isSubagentsV2Enabled(setting: unknown, env: string | undefined): boolean {
	if (env === "0" || env === "false") return false;
	if (env === "1" || env === "true") return true;
	return setting !== false;
}

export function selectSubagentToolNames(v2Enabled: boolean): readonly string[] {
	return v2Enabled ? V2_SUBAGENT_TOOL_NAMES : LEGACY_SUBAGENT_TOOL_NAMES;
}
