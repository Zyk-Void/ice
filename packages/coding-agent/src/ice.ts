#!/usr/bin/env node
import "./core/legacy-compat/bootstrap.ts";
import { getAgentDir } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { formatAgentPackImportResult, importRufloAgentPack } from "./ice-agent-packs.ts";
import { IceAgentViewBridge } from "./ice-agent-view-bridge.ts";
import iceCogneeExtension from "./ice-cognee.ts";
import { createPiMcpSubagentAdapter } from "./ice-mcp-bridge.ts";
import { refreshLocalModelsForStartup } from "./ice-provider.ts";
import iceProviderSettings from "./ice-provider-settings.ts";
import {
	createIceSafeVerify,
	type IceCapabilityState,
	type IceMode,
	validateIceStartupArgs,
} from "./ice-safe-verify.ts";
import iceSubagents, {
	getSubagentGlobalAgentsDir,
	normalizeUnsafeSubagentStartupArgs,
	registerIceSubagentMcpAdapter,
} from "./ice-subagents.ts";
import { main } from "./main.ts";
import { getIceSubagentHookHandlers } from "./subagents/settings.ts";
import iceSubagentsV2, { isSubagentsV2Selected } from "./subagents/v2/extension.ts";

process.title = "ice";
process.env.ICE_CODING_AGENT = "true";
process.env.AI_AGENT = "ice";
// pi packages (pi-mcp-adapter, ...) resolve their config via PI_CODING_AGENT_DIR and otherwise fall back to
// ~/.pi/agent, silently ignoring ICE's own mcp.json and sharing approval/cache state with stock pi.
process.env.PI_CODING_AGENT_DIR ??= getAgentDir();
process.emitWarning = (() => {}) as typeof process.emitWarning;
configureHttpDispatcher();

const rawArgs = process.argv.slice(2);
const importPackArgs = rawArgs.filter((arg) => arg === "--import-agent-pack" || arg.startsWith("--import-agent-pack="));
if (importPackArgs.length > 1) {
	console.error("--import-agent-pack may be provided only once");
	process.exit(1);
}
if (importPackArgs.length === 1) {
	const importIndex = rawArgs.findIndex(
		(arg) => arg === "--import-agent-pack" || arg.startsWith("--import-agent-pack="),
	);
	const source = importPackArgs[0]!.startsWith("--import-agent-pack=")
		? importPackArgs[0]!.slice("--import-agent-pack=".length)
		: rawArgs[importIndex + 1];
	if (!source || source.startsWith("-")) {
		console.error("--import-agent-pack requires a Ruflo repository path");
		process.exit(1);
	}
	try {
		const result = importRufloAgentPack(source, { targetDir: getSubagentGlobalAgentsDir(getAgentDir()) });
		console.log(formatAgentPackImportResult(result));
		process.exit(0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
let args: string[];
try {
	args = normalizeUnsafeSubagentStartupArgs(rawArgs, {
		stdinIsTTY: process.stdin.isTTY === true,
		stdoutIsTTY: process.stdout.isTTY === true,
	});
	validateIceStartupArgs(args);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const offlineEnv = process.env.ICE_OFFLINE?.toLowerCase();
const offline = args.includes("--offline") || offlineEnv === "1" || offlineEnv === "true" || offlineEnv === "yes";
const metadataOnly = args.some(
	(argument) => argument === "--help" || argument === "-h" || argument === "--version" || argument === "-v",
);
await refreshLocalModelsForStartup(getAgentDir(), {
	skip: offline || metadataOnly,
	onFailure: (error) => console.error(`[ice] Model refresh failed; using last valid catalog: ${error}`),
});

let currentIceMode: IceMode | undefined;
let currentIceCapabilityState: IceCapabilityState | undefined;
const agentViewBridge = new IceAgentViewBridge();
const iceSafeVerify = createIceSafeVerify({
	onModeChange: async (mode) => {
		currentIceMode = mode;
	},
	onCapabilityChange: async (capabilities) => {
		currentIceMode = capabilities.mode;
		currentIceCapabilityState = capabilities;
	},
});

await main(args, {
	globalFirstSettings: true,
	agentViewBridge,
	extensionFactories: [
		{ name: "ice-safe-verify", factory: iceSafeVerify, hidden: true, priority: "before-user" },
		{ name: "ice-provider-settings", factory: iceProviderSettings, hidden: true, priority: "before-user" },
		{ name: "ice-cognee", factory: iceCogneeExtension, hidden: true, priority: "before-user" },
		{
			name: "ice-subagents",
			factory: (ice) => {
				// Give subagents the parent's pi-mcp-adapter servers through the public adapter seam.
				const unregisterMcp = registerIceSubagentMcpAdapter(
					ice.events,
					createPiMcpSubagentAdapter({
						agentDir: getAgentDir(),
						getParentSession: () => agentViewBridge.getParentSession(),
					}),
				);
				ice.on("session_shutdown", () => unregisterMcp());
				const subagentOptions = {
					hookHandlers: getIceSubagentHookHandlers(ice.events),
					agentViewBridge,
					getIceMode: () => currentIceMode,
					getIceCapabilityState: () => currentIceCapabilityState,
				};
				// Rollout gate (Plan/subagent-rewrite.md section 23): exactly one subagent tool set is registered.
				const v2 = isSubagentsV2Selected(
					SettingsManager.create(process.cwd(), getAgentDir()).getGlobalSettings() as { ice?: unknown },
					process.env.ICE_SUBAGENTS_V2,
				);
				return v2 ? iceSubagentsV2(ice, subagentOptions) : iceSubagents(ice, subagentOptions);
			},
			hidden: true,
			priority: "before-user",
		},
	],
});
