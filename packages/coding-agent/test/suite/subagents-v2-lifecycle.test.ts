import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createIceSubagents, type ExtensionAPI } from "../../src/index.ts";
import { AGENT_LISTING_CUSTOM_TYPE } from "../../src/subagents/definitions/listing.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A parent runtime with the subagent extension, re-attached on every session replacement like the interactive host. */
async function createParent() {
	const tempDir = join(tmpdir(), `ice-subagent-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const subagents = createIceSubagents({
		agentDir: join(tempDir, "agent"),
		agents: { summarizer: { description: "Summarize text", prompt: "Summarize." } },
	});
	const options = {
		agentDir: tempDir,
		authStorage,
		model: faux.getModel(),
		resourceLoaderOptions: {
			extensionFactories: [
				(ice: ExtensionAPI) => {
					ice.registerProvider(faux.getModel().provider, {
						baseUrl: faux.getModel().baseUrl,
						apiKey: "faux-key",
						api: faux.api,
						models: faux.models.map((model) => ({
							id: model.id,
							name: model.name,
							api: model.api,
							reasoning: model.reasoning,
							input: model.input,
							cost: model.cost,
							contextWindow: model.contextWindow,
							maxTokens: model.maxTokens,
						})),
					});
				},
				subagents.extension,
			],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		},
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ ...options, cwd });
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: options.model,
		});
		subagents.attach(created.session);
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
	});
	await runtime.session.bindExtensions({});
	cleanups.push(async () => {
		await runtime.dispose();
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});
	const setResponses = (responses: FauxResponseStep[]) => faux.setResponses(responses);
	return { runtime, subagents, setResponses };
}

/** Hidden listing messages the extension added to the parent's context, newest last. */
function listings(session: AgentSession): string[] {
	return session.messages.flatMap((message) =>
		message.role === "custom" && message.customType === AGENT_LISTING_CUSTOM_TYPE
			? [typeof message.content === "string" ? message.content : JSON.stringify(message.content)]
			: [],
	);
}

const launchScout = () =>
	fauxAssistantMessage(
		fauxToolCall("agent", {
			tasks: [{ agent: "summarizer", name: "scout", description: "Summarize a", prompt: "Summarize: a" }],
		}),
		{ stopReason: "toolUse" },
	);

describe("subagents V2 across compaction and session resume", () => {
	it("re-introduces existing children after compaction and continues them by name", async () => {
		const { runtime, setResponses } = await createParent();
		setResponses([
			launchScout(),
			fauxAssistantMessage("child one"),
			fauxAssistantMessage("parent one"),
			fauxAssistantMessage("filler reply"),
		]);
		const session = runtime.session;
		await session.prompt("delegate");
		session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		await session.prompt("filler");
		expect(listings(session).some((text) => text.includes("scout"))).toBe(false);
		setResponses([fauxAssistantMessage("## Goal\nsummary"), fauxAssistantMessage("## Goal\nsummary")]);
		await session.compact();
		setResponses([
			fauxAssistantMessage(
				fauxToolCall("agent", { tasks: [{ resume: "scout", description: "Again", prompt: "again" }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("child two"),
			fauxAssistantMessage("parent two"),
			fauxAssistantMessage("parent three"),
		]);

		await session.prompt("continue scout");
		const roster = listings(session).filter((text) => text.includes("Current subagents in this session"));
		expect(roster).toHaveLength(1);
		expect(roster[0]).toMatch(/- scout \(ag_\w+\) · summarizer · idle · last turn completed · Summarize a/);
		const continued = session.messages.find(
			(message) =>
				message.role === "toolResult" &&
				message.toolName === "agent" &&
				JSON.stringify(message).includes("child two"),
		);
		expect(JSON.stringify(continued)).toContain('summarizer \\"scout\\"');

		// Shown once per compaction, not on every turn.
		await session.prompt("next");
		expect(listings(session).filter((text) => text.includes("Current subagents in this session"))).toHaveLength(1);
	});

	it("shows the roster once after the parent session is resumed", async () => {
		const { runtime, subagents, setResponses } = await createParent();
		setResponses([
			launchScout(),
			fauxAssistantMessage("child one"),
			fauxAssistantMessage("parent one"),
			fauxAssistantMessage("other session reply"),
			fauxAssistantMessage("back in the first session"),
			fauxAssistantMessage("still here"),
		]);
		await runtime.session.prompt("delegate");
		const firstFile = runtime.session.sessionFile!;
		expect(listings(runtime.session).some((text) => text.includes("Current subagents"))).toBe(false);

		await runtime.newSession();
		await runtime.session.bindExtensions({});
		await runtime.session.prompt("hello");
		expect(subagents.overview()?.children).toEqual([]);
		expect(listings(runtime.session).some((text) => text.includes("Current subagents"))).toBe(false);

		await runtime.switchSession(firstFile);
		await runtime.session.bindExtensions({});
		expect(subagents.overview()?.children).toMatchObject([{ name: "scout" }]);
		await runtime.session.prompt("what ran before?");
		await runtime.session.prompt("and now?");
		const rosters = listings(runtime.session).filter((text) => text.includes("Current subagents in this session"));
		expect(rosters).toHaveLength(1);
		expect(rosters[0]).toContain("- scout (");
	});
});
