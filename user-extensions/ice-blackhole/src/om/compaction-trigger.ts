import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@zykairotis/ice-coding-agent";
import { loadConfig, resolveCompactAfterTokens } from "../core/unified-config.ts";

export const MID_RUN_RESUME_CUSTOM_TYPE = "blackhole-resume";
export const MID_RUN_RESUME_MESSAGE =
	"Context was auto-compacted mid-task to stay under the token threshold. " +
	"The summary above preserves prior progress. Continue the task from where you left off.";

interface TriggerState {
	compactInFlight: boolean;
	midRunCompactionSuspended: boolean;
	resumeTurnPending: boolean;
	nativeTriggerConflictWarned: boolean;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function nativeMidRunCompactionEnabled(cwd: string): boolean {
	let enabled = false;
	for (const path of [join(getAgentDir(), "settings.json"), join(cwd, ".ice", "settings.json")]) {
		if (!existsSync(path)) continue;
		try {
			const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (typeof raw !== "object" || raw === null || !("compaction" in raw)) continue;
			const compaction = raw.compaction;
			if (typeof compaction === "object" && compaction !== null && "midRunCompaction" in compaction) {
				const mode = compaction.midRunCompaction;
				enabled = mode === "resume" || mode === "pause";
			}
		} catch {
			// Native settings validation owns malformed settings; do not fail the extension trigger.
		}
	}
	return enabled;
}

function shouldUseBlackhole(config: ReturnType<typeof loadConfig>): boolean {
	return config.compaction === "auto" && config.compactionEngine === "blackhole";
}

function sendResume(ice: ExtensionAPI, state: TriggerState): void {
	state.resumeTurnPending = true;
	try {
		ice.sendMessage(
			{
				customType: MID_RUN_RESUME_CUSTOM_TYPE,
				content: MID_RUN_RESUME_MESSAGE,
				display: true,
			},
			{ triggerTurn: true },
		);
	} catch (error) {
		state.resumeTurnPending = false;
		if (!(error instanceof Error) || !error.message.includes("extension ctx is stale")) throw error;
	}
}

function maybeCompact(ice: ExtensionAPI, ctx: ExtensionContext, state: TriggerState): void {
	const config = loadConfig((message) => notify(ctx, message, "warning"));
	if (!shouldUseBlackhole(config) || config.midRunCompaction === "off" || state.compactInFlight) return;
	if (nativeMidRunCompactionEnabled(ctx.cwd)) {
		if (!state.nativeTriggerConflictWarned) {
			state.nativeTriggerConflictWarned = true;
			notify(
				ctx,
				"Blackhole mid-run compaction is disabled because native ICE mid-run compaction is enabled; set compaction.midRunCompaction to off to let Blackhole own the trigger.",
				"warning",
			);
		}
		return;
	}

	const contextWindow = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow;
	const threshold = resolveCompactAfterTokens(config, contextWindow, (message) => notify(ctx, message, "warning"));
	if (threshold === undefined) return;

	const tokens = ctx.getContextUsage()?.tokens;
	if (tokens == null) return;
	if (tokens <= threshold) {
		state.midRunCompactionSuspended = false;
		return;
	}
	if (state.midRunCompactionSuspended) return;

	state.compactInFlight = true;
	notify(
		ctx,
		`Blackhole compaction threshold reached (~${tokens.toLocaleString()} tokens); compacting${config.midRunCompaction === "resume" ? " and resuming" : ""}`,
		"info",
	);

	ctx.compact({
		onComplete: () => {
			state.compactInFlight = false;
			state.midRunCompactionSuspended = false;
			notify(ctx, "Blackhole compaction complete", "info");
			if (config.midRunCompaction === "resume") sendResume(ice, state);
		},
		onError: (error) => {
			state.compactInFlight = false;
			state.midRunCompactionSuspended = true;
			if (error.message !== "Compaction cancelled")
				notify(ctx, `Blackhole compaction failed: ${error.message}`, "error");
			if (config.midRunCompaction === "resume") sendResume(ice, state);
		},
	});
}

export function registerCompactionTrigger(ice: ExtensionAPI): void {
	const state: TriggerState = {
		compactInFlight: false,
		midRunCompactionSuspended: false,
		resumeTurnPending: false,
		nativeTriggerConflictWarned: false,
	};

	ice.on("agent_start", () => {
		if (state.resumeTurnPending) {
			state.resumeTurnPending = false;
		} else {
			state.midRunCompactionSuspended = false;
		}
	});

	ice.on("turn_end", (event, ctx) => {
		if (event.toolResults.length === 0) return;
		maybeCompact(ice, ctx, state);
	});
}
