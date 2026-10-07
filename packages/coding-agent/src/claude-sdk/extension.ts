import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { ClaudeSdkClient, loadClientConfig } from "./adapter.ts";

/** Additive transport only. The native ICE loop remains the sole tool/permission authority. */
export default async function claudeSdkExtension(ice: ExtensionAPI): Promise<void> {
	const config = await loadClientConfig(join(getAgentDir(), "claude-sdk.json"));
	const client = new ClaudeSdkClient(config);
	ice.registerProvider("claude-sdk", {
		name: "Claude Agent SDK (local; billing external)",
		api: "claude-sdk",
		baseUrl: config.baseUrl,
		// The adapter reads a private local bridge token; ICE must never import Claude OAuth credentials.
		apiKey: "credential-managed-by-local-claude-sdk-bridge",
		streamSimple: (model, context, options) => client.stream(model, context, options),
		models: config.models.map((id) => ({
			id,
			name: `${id} (SDK; billing external)`,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200000,
			maxTokens: 16384,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	});
	ice.registerCommand("claude-sdk-status", {
		description: "Check the local Claude SDK transport and authentication; cost values are not billing guarantees.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(await client.status(), "info");
		},
	});
	ice.on("session_shutdown", async () => {
		await client.close();
	});
}
