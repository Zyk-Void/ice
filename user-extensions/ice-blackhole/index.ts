import type { ExtensionAPI } from "@zykairotis/ice-coding-agent";
import type { SettingItem } from "@zykairotis/ice-tui";
import { getConfigPath, loadConfig, saveConfig } from "./src/core/unified-config.ts";
import { registerBeforeCompactHook } from "./src/hooks/before-compact.ts";
import { registerCompactionTrigger } from "./src/om/compaction-trigger.ts";

function notifyUsage(ctx: { ui: { notify: (message: string, level: "info" | "warning" | "error") => void } }): void {
	ctx.ui.notify("Usage: /blackhole percent <1-99> | resume | pause | off | status", "warning");
}

function registerBlackholeSettings(ice: ExtensionAPI): void {
	let config = loadConfig();
	const percentValues = Array.from({ length: 99 }, (_, index) => `${index + 1}%`);
	const items: SettingItem[] = [
		{
			id: "compaction",
			label: "Blackhole compaction",
			description: "Blackhole compaction policy",
			currentValue: config.compaction,
			values: ["auto", "manual", "off"],
		},
		{
			id: "compaction-engine",
			label: "Blackhole engine",
			description: "Summary engine used when Blackhole compaction runs",
			currentValue: config.compactionEngine,
			values: ["blackhole", "ice-default"],
		},
		{
			id: "mid-run-compaction",
			label: "Blackhole mid-run",
			description: "Compact after a tool turn and pause or resume the task",
			currentValue: config.midRunCompaction,
			values: ["off", "pause", "resume"],
		},
		{
			id: "threshold",
			label: "Blackhole compaction threshold",
			description: "Percentage of the active model context window; resolves per selected model",
			currentValue: `${config.compactAfterPercent}%`,
			values: percentValues,
		},
		{
			id: "tail-behavior",
			label: "Blackhole tail",
			description: "Tail preservation strategy used by the summary",
			currentValue: config.tailBehavior,
			values: ["ice-default", "minimal"],
		},
		{
			id: "memory",
			label: "Blackhole memory",
			description: "Persist the memory setting; memory workers are not currently implemented",
			currentValue: config.memory ? "true" : "false",
			values: ["false", "true"],
		},
	];

	ice.registerSettings("blackhole", {
		items,
		onChange: (id, value) => {
			switch (id) {
				case "compaction":
					config = saveConfig({ compaction: value as typeof config.compaction });
					break;
				case "compaction-engine":
					config = saveConfig({ compactionEngine: value as typeof config.compactionEngine });
					break;
				case "mid-run-compaction":
					config = saveConfig({ midRunCompaction: value as typeof config.midRunCompaction });
					break;
				case "threshold":
					config = saveConfig({ compactAfterPercent: Number.parseInt(value, 10) });
					break;
				case "tail-behavior":
					config = saveConfig({ tailBehavior: value as typeof config.tailBehavior });
					break;
				case "memory":
					config = saveConfig({ memory: value === "true" });
					break;
			}
		},
	});
}

function registerBlackholeCommand(ice: ExtensionAPI): void {
	ice.registerCommand("blackhole", {
		description: "Configure optional Blackhole compaction",
		handler: async (args, ctx) => {
			const [command, value] = args.trim().split(/\s+/, 2);
			if (!command || command === "status") {
				const config = loadConfig();
				ctx.ui.notify(
					`Blackhole: ${config.midRunCompaction}, ${config.compactAfterPercent}%; config ${getConfigPath()}`,
					"info",
				);
				return;
			}

			if (command === "percent") {
				const threshold = Number(value);
				const valid = Number.isFinite(threshold) && threshold >= 1 && threshold <= 99;
				if (!valid) {
					notifyUsage(ctx);
					return;
				}
				const config = saveConfig({
					compaction: "auto",
					compactionEngine: "blackhole",
					compactAfterPercent: threshold,
				});
				ctx.ui.notify(`Blackhole threshold: ${config.compactAfterPercent}%`, "info");
				return;
			}

			if (command === "resume" || command === "pause" || command === "off") {
				const config = saveConfig({
					compaction: command === "off" ? "off" : "auto",
					compactionEngine: "blackhole",
					midRunCompaction: command,
				});
				ctx.ui.notify(`Blackhole mid-run compaction: ${config.midRunCompaction}`, "info");
				return;
			}

			notifyUsage(ctx);
		},
	});
}

export default function iceBlackholeExtension(ice: ExtensionAPI): void {
	registerBlackholeSettings(ice);
	registerBlackholeCommand(ice);
	registerBeforeCompactHook(ice);
	registerCompactionTrigger(ice);
}
