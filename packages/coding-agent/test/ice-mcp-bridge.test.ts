import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createPiMcpSubagentAdapter, listPiMcpAuthorizedTools } from "../src/ice-mcp-bridge.ts";

const objectSchema = { type: "object", properties: {} };

function agentDir(mcp: unknown, cache: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "ice-mcp-bridge-"));
	writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcp));
	writeFileSync(join(dir, "mcp-cache.json"), JSON.stringify(cache));
	return dir;
}

describe("pi-mcp-adapter subagent bridge", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("classifies tools from the user's approveTools policy only", () => {
		const dir = agentDir(
			{
				mcpServers: {
					desk: { approveTools: ["click", "desk_type_*"] },
					all: { approveTools: true },
					open: {},
					off: { approveTools: [], disabled: true },
				},
			},
			{
				servers: {
					desk: {
						tools: [
							{ name: "list_windows", description: "List", inputSchema: objectSchema },
							{ name: "click", inputSchema: objectSchema },
							{ name: "type_text", inputSchema: objectSchema },
							{ name: "no_schema" },
						],
					},
					all: { tools: [{ name: "post", inputSchema: objectSchema }] },
					open: { tools: [{ name: "anything", inputSchema: objectSchema }] },
					off: { tools: [{ name: "hidden", inputSchema: objectSchema }] },
				},
			},
		);
		dirs.push(dir);
		expect(listPiMcpAuthorizedTools(dir).map(({ selector, access }) => [selector, access])).toEqual([
			["desk/list_windows", "read-only"],
			["desk/click", "mutation"],
			["desk/type_text", "mutation"],
			["all/post", "mutation"],
		]);
	});

	it("returns no tools when the MCP config is missing", () => {
		expect(listPiMcpAuthorizedTools(join(tmpdir(), "ice-mcp-bridge-missing"))).toEqual([]);
	});

	it("dispatches through the parent session's mcp proxy tool", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }));
		const session = { getRegisteredTool: (name: string) => (name === "mcp" ? { execute } : undefined) };
		const adapter = createPiMcpSubagentAdapter({
			agentDir: tmpdir(),
			getParentSession: () => session as unknown as AgentSession,
		});
		await expect(adapter.dispatch("desk", "list_windows", { on_screen_only: true })).resolves.toMatchObject({
			content: [{ text: "ok" }],
		});
		expect(execute).toHaveBeenCalledWith(
			expect.stringMatching(/^subagent-mcp-/),
			{ server: "desk", tool: "list_windows", args: { on_screen_only: true } },
			undefined,
		);

		const detached = createPiMcpSubagentAdapter({ agentDir: tmpdir(), getParentSession: () => undefined });
		await expect(detached.dispatch("desk", "list_windows", {})).rejects.toThrow(/no active MCP proxy/);
	});
});
