import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@zykairotis/ice-ai";
import type { Api, Context, Model, StreamFunction, StreamOptions } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionResult } from "../src/core/sdk.ts";
import {
	getIceSubagentHookHandlers,
	registerIceSubagentHook,
	resolveIceSubagentHooks,
} from "../src/ice-subagent-settings.ts";
import {
	createNativeSubagentSession,
	listSubagentProfiles,
	normalizeSubagentRequest,
	resolveSubagentProfileResolution,
} from "../src/ice-subagents.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function profile(metadata: string) {
	const cwd = mkdtempSync(join(tmpdir(), "ice-profile-controls-"));
	dirs.push(cwd);
	const agentDir = join(cwd, "agent");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(
		join(agentDir, "agents", "audit.md"),
		`---\nname: audit\ndescription: Fixture\ntools: [read]\n${metadata}\n---\nInspect evidence.\n`,
	);
	return { cwd, agentDir, projectTrusted: false };
}

describe("profile control validation and parent registration", () => {
	it("rejects unknown security-bearing metadata", () => {
		const options = profile("restrictions:\n  denyTools: [read]");
		expect(() => resolveSubagentProfileResolution("audit", options)).toThrow(/Unsupported role metadata/);
	});
	it("parses bounded execution preferences and rejects malformed sampling metadata", () => {
		const options = profile("temperature: 0.35\ntop-p: 0.8");
		const resolved = resolveSubagentProfileResolution("audit", options);
		expect(resolved).toMatchObject({ temperature: 0.35, topP: 0.8 });
		const request = normalizeSubagentRequest(
			{
				parentSessionId: "parent",
				role: "audit",
				task: "Inspect",
				scope: { roots: ["."] },
			},
			options.cwd,
			options,
		);
		expect(request.execution).toMatchObject({
			maxOutputBytes: 24 * 1024,
			temperature: 0.35,
			topP: 0.8,
		});
		const invalidTemperature = profile("temperature: nope");
		expect(() => resolveSubagentProfileResolution("audit", invalidTemperature)).toThrow(/temperature/i);
		expect(() => resolveSubagentProfileResolution("audit", profile("top-p: 1.1"))).toThrow(/top-p/i);
		expect(() => resolveSubagentProfileResolution("audit", profile("max-turns: 7"))).toThrow(
			/Unsupported role metadata/,
		);
		expect(() => resolveSubagentProfileResolution("audit", profile("samplingParams: { top_p: 0.8 }"))).toThrow(
			/Unsupported role metadata/,
		);
	});
	it("lists requested and effective profile sampling values", () => {
		const options = profile("temperature: 0.35\ntop-p: 0.8");
		const summary = listSubagentProfiles(options).find((entry) => entry.name === "audit");
		expect(summary).toMatchObject({
			requestedTemperature: 0.35,
			effectiveTemperature: 0.35,
			requestedTopP: 0.8,
			effectiveTopP: 0.8,
		});
	});
	it("keeps hidden profiles out of discovery while allowing direct resolution", () => {
		const options = profile("color: success\nhidden: true");
		expect(resolveSubagentProfileResolution("audit", options)).toMatchObject({ color: "success", hidden: true });
		expect(listSubagentProfiles(options).some((entry) => entry.name === "audit")).toBe(false);
	});
	it("rejects malformed presentation metadata", () => {
		expect(() => resolveSubagentProfileResolution("audit", profile('color: "\\e[31m"'))).toThrow(/color/i);
		expect(() => resolveSubagentProfileResolution("audit", profile("hidden: yes"))).toThrow(/hidden/i);
	});
	it("maps sampling preferences only to compatible provider options", async () => {
		const options = profile("thinking: off\ntemperature: 0.35\ntop-p: 0.8");
		const request = normalizeSubagentRequest(
			{
				parentSessionId: "parent",
				role: "audit",
				task: "Inspect",
				scope: { roots: ["."] },
			},
			options.cwd,
			options,
		);
		const makeModel = (api: Api, compat?: Record<string, unknown>): Model<Api> =>
			({
				provider: "test",
				id: `sampling-${api}`,
				name: "sampling",
				api,
				baseUrl: "http://127.0.0.1:9",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_000,
				maxTokens: 4_096,
				...(compat ? { compat } : {}),
			}) as Model<Api>;
		const captured: StreamOptions[] = [];
		const streamFunction = vi.fn((_model: Model<Api>, _context: Context, streamOptions: StreamOptions = {}) => {
			captured.push(streamOptions);
			return createAssistantMessageEventStream();
		}) as unknown as StreamFunction;
		const makeSession = (model: Model<Api>) =>
			({
				model,
				messages: [],
				agent: { streamFunction },
			}) as never;
		const openAiChild = await createNativeSubagentSession(
			{ request, parentActiveTools: ["read"], model: makeModel("openai-completions") },
			async () =>
				({
					session: makeSession(makeModel("openai-completions")),
					extensionsResult: {},
				}) as unknown as CreateAgentSessionResult,
		);
		(openAiChild.session as unknown as { agent: { streamFunction: StreamFunction } }).agent.streamFunction(
			makeModel("openai-completions"),
			{ messages: [] } as Context,
		);
		expect(captured[0]).toMatchObject({ temperature: 0.35, samplingParams: { top_p: 0.8 } });

		const anthropicModel = makeModel("anthropic-messages", { supportsTemperature: false });
		const anthropicChild = await createNativeSubagentSession(
			{ request, parentActiveTools: ["read"], model: anthropicModel },
			async () =>
				({ session: makeSession(anthropicModel), extensionsResult: {} }) as unknown as CreateAgentSessionResult,
		);
		(anthropicChild.session as unknown as { agent: { streamFunction: StreamFunction } }).agent.streamFunction(
			anthropicModel,
			{ messages: [] } as Context,
		);
		expect(captured[1]?.samplingParams).toBeUndefined();
		expect(captured[1]?.temperature).toBeUndefined();
		expect(anthropicChild.diagnostics?.some((entry) => entry.code === "provider_option_unsupported")).toBe(true);
	});
	it("carries profile and caller hook selections through normalized requests", () => {
		const options = profile("hooks: [role-hook]");
		const request = normalizeSubagentRequest(
			{
				parentSessionId: "parent",
				role: "audit",
				task: "Inspect",
				scope: { roots: ["."] },
				execution: { hooks: ["call-hook"] },
			},
			options.cwd,
			options,
		);
		const hooks = resolveIceSubagentHooks({
			roleHookIds: request.profile.hooks,
			callHookIds: request.hookIds,
			globalHooks: {
				ice: {
					hooks: {
						enabled: true,
						definitions: [
							{ id: "required", event: "subagent.beforeLaunch", required: true },
							{ id: "role-hook", event: "subagent.beforeLaunch", required: false },
							{ id: "call-hook", event: "subagent.beforeLaunch", required: false },
							{ id: "unused", event: "subagent.beforeLaunch", required: false },
						],
					},
				},
			},
		});
		expect(hooks.map((hook) => hook.id)).toEqual(["required", "role-hook", "call-hook"]);
	});
	it("isolates direct trusted handler registration by owner and removes stale handlers", () => {
		const owner = {};
		const other = {};
		const handler = () => ({ outcome: "continue" as const });
		const unregister = registerIceSubagentHook(owner, "audit", handler);
		expect(getIceSubagentHookHandlers(owner).audit).toBe(handler);
		expect(getIceSubagentHookHandlers(other).audit).toBeUndefined();
		expect(() => registerIceSubagentHook(owner, "audit", handler)).toThrow(/Duplicate/);
		unregister();
		expect(getIceSubagentHookHandlers(owner).audit).toBeUndefined();
	});
});
