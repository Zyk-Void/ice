import type { RpcCommandType } from "./rpc-types.ts";

/** Controls have a reserved bounded admission lane on both sides of the transport. */
export const RPC_LIVE_CONTROLS = new Set<RpcCommandType>([
	"abort",
	"abort_bash",
	"abort_retry",
	"abort_compaction",
	"abort_branch_summary",
	"respond_subagent_approval",
	"stop_after_turn",
	"kill_shell",
	"background_bash",
	"get_capabilities",
	"abort_models_refresh",
	"cancel_request",
]);

export const RPC_MAX_OUTPUT_LINE_BYTES = 32 * 1024 * 1024;
export const RPC_MAX_COLLECTED_EVENT_BYTES = 16 * 1024 * 1024;
export const RPC_MAX_COLLECTED_EVENTS = 16384;
