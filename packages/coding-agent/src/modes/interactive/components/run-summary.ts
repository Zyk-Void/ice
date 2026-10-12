/**
 * The dim line left in the transcript when the agent finishes a run, for example
 * `✻ Worked for 3m 17s · done 12:53 AM`. The verb varies from run to run.
 */
import { Text } from "@zykairotis/ice-tui";
import { formatShellRuntime } from "../../../core/tools/bash-shells.ts";
import { sym } from "../theme/symbols.ts";
import { theme } from "../theme/theme.ts";

export const RUN_SUMMARY_VERBS = [
	"Worked",
	"Sautéed",
	"Simmered",
	"Brewed",
	"Baked",
	"Churned",
	"Cooked",
	"Crunched",
	"Whisked",
	"Forged",
	"Pondered",
	"Tinkered",
] as const;

export function formatRunSummary(durationMs: number, endedAt: Date, verb: string): string {
	const time = endedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	return `${sym("runDone")} ${verb} for ${formatShellRuntime(durationMs)} ${sym("separator")} done ${time}`;
}

export function createRunSummary(
	durationMs: number,
	endedAt: Date = new Date(),
	random: () => number = Math.random,
): Text {
	const verb = RUN_SUMMARY_VERBS[Math.floor(random() * RUN_SUMMARY_VERBS.length)] ?? RUN_SUMMARY_VERBS[0];
	return new Text(theme.fg("dim", formatRunSummary(durationMs, endedAt, verb)), 0, 0);
}
