import { relative } from "node:path";
import { type ExtensionAPI, registerIceDelegableTool } from "@zykairotis/ice-coding-agent";
import { Type } from "typebox";

/**
 * Run from the repository with:
 * ice --extension packages/coding-agent/examples/extensions/ice-delegable-workspace-info.ts
 *
 * This example performs no filesystem reads, network calls, or mutations. A
 * child receives its own scope metadata, not the parent's session controller.
 */
export default function workspaceInfo(ice: ExtensionAPI): void {
	const parameters = Type.Object({}, { additionalProperties: false });
	ice.registerTool({
		name: "workspace_info",
		label: "Workspace information",
		description: "Report the current workspace identity without reading files.",
		parameters,
		execute: async (_id, _params, _signal, _update, ctx) => ({
			content: [{ type: "text", text: JSON.stringify({ workspace: ctx.cwd }) }],
			details: {},
		}),
	});
	const unregister = registerIceDelegableTool(ice.events, {
		adapterId: "example/workspace-info",
		name: "workspace_info",
		origin: "example/workspace-info",
		access: "read-only",
		childSafe: true,
		description: "Report only this child's explicitly approved scope roots.",
		parameters,
		execute: async (_params, child) => ({
			roots: child.scopeRoots.map((root) => relative(child.cwd, root) || "."),
		}),
	});
	ice.on("session_shutdown", () => unregister());
}
