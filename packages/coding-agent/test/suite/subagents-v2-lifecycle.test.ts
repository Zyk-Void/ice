import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@zykairotis/ice-ai";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/**
 * A parent runtime with the subagent extension. Like the interactive host, a replaced session is attached
 * only after the new runtime exists, unless `attachOnCreate` attaches it inside the factory.
 */
async function createParent(attachOnCreate = true) {
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
	let attachedOnce = false;
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ ...options, cwd });
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: options.model,
		});
		if (attachOnCreate || !attachedOnce) subagents.attach(created.session);
		attachedOnce = true;
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

	it("delivers a completion that arrived while the parent turn was then aborted", async () => {
		const { runtime, subagents, setResponses } = await createParent();
		const session = runtime.session;
		let releaseChild!: () => void;
		const childGate = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		const isChild = (context: Context) => JSON.stringify(context.messages[0]).includes("Summarize: a");
		let parentCalls = 0;
		const dispatch = async (context: Context) => {
			if (isChild(context)) {
				await childGate;
				return fauxAssistantMessage("child report");
			}
			parentCalls++;
			if (parentCalls === 1)
				return fauxAssistantMessage(
					fauxToolCall("agent", {
						background: true,
						tasks: [{ agent: "summarizer", name: "scout", description: "Summarize a", prompt: "Summarize: a" }],
					}),
					{ stopReason: "toolUse" },
				);
			if (parentCalls === 2) {
				// The child finishes while this parent response is still streaming; then the user aborts, and the
				// interactive abort path clears the queues (restoreQueuedMessagesToEditor -> clearQueue).
				releaseChild();
				await vi.waitFor(() => expect(subagents.overview()?.children[0]?.lastTurnOutcome).toBe("completed"));
				session.clearQueue();
				return fauxAssistantMessage("partial", { stopReason: "aborted", errorMessage: "aborted" });
			}
			return fauxAssistantMessage("got the report");
		};
		setResponses(Array.from({ length: 6 }, () => dispatch));
		session.settingsManager.applyOverrides({ retry: { enabled: false } });
		await session.prompt("delegate in the background");
		await vi.waitFor(() =>
			expect(
				session.messages.filter(
					(message) => message.role === "custom" && message.customType === "subagent_completed",
				),
			).toHaveLength(1),
		);
		const completion = session.messages.find(
			(message) => message.role === "custom" && message.customType === "subagent_completed",
		);
		expect(JSON.stringify(completion)).toContain('scout\\" (ag_');
		await vi.waitFor(() => expect(session.isStreaming).toBe(false));
	});

	it("binds the new runtime to the resumed session even when the footer renders before re-attach", async () => {
		const { runtime, subagents, setResponses } = await createParent(false);
		setResponses([
			launchScout(),
			fauxAssistantMessage("child one"),
			fauxAssistantMessage("parent one"),
			fauxAssistantMessage("other session reply"),
			fauxAssistantMessage("back again"),
		]);
		await runtime.session.prompt("delegate");
		const firstFile = runtime.session.sessionFile!;

		await runtime.newSession();
		// The bridge still points at the shut-down first session while the new runtime starts.
		const closedContent = readFileSync(firstFile, "utf8");
		subagents.overview();
		// The new runtime must not restore (and journal into) the closed session.
		expect(readFileSync(firstFile, "utf8")).toBe(closedContent);
		subagents.attach(runtime.session);
		await runtime.session.bindExtensions({});
		expect(subagents.overview()?.children).toEqual([]);
		await runtime.session.prompt("hello");

		await runtime.switchSession(firstFile);
		subagents.overview();
		subagents.attach(runtime.session);
		await runtime.session.bindExtensions({});
		expect(subagents.overview()?.children).toMatchObject([{ name: "scout" }]);
		await runtime.session.prompt("what ran before?");
		expect(listings(runtime.session).some((text) => text.includes("- scout ("))).toBe(true);
	});

	it("shows a result that settled while the session was closed as soon as it is resumed, without a turn", async () => {
		const { runtime, setResponses } = await createParent();
		const isChild = (context: Context) => JSON.stringify(context.messages[0]).includes("Summarize: a");
		let parentCalls = 0;
		const dispatch = async (context: Context, options: { signal?: AbortSignal } | undefined) => {
			if (isChild(context)) {
				// Runs until the session switch aborts it.
				await new Promise<void>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				return fauxAssistantMessage("never");
			}
			parentCalls++;
			if (parentCalls === 1)
				return fauxAssistantMessage(
					fauxToolCall("agent", {
						background: true,
						tasks: [{ agent: "summarizer", name: "scout", description: "Summarize a", prompt: "Summarize: a" }],
					}),
					{ stopReason: "toolUse" },
				);
			return fauxAssistantMessage(`parent ${parentCalls}`);
		};
		setResponses(Array.from({ length: 6 }, () => dispatch as FauxResponseStep));
		await runtime.session.prompt("delegate in the background");
		const firstFile = runtime.session.sessionFile!;
		await runtime.newSession();
		await runtime.session.bindExtensions({});

		await runtime.switchSession(firstFile);
		await runtime.session.bindExtensions({});
		const session = runtime.session;
		const completion = session.messages.find(
			(message) => message.role === "custom" && message.customType === "subagent_completed",
		);
		expect(JSON.stringify(completion)).toContain('scout\\" (ag_');
		expect(JSON.stringify(completion)).toContain("finished: interrupted.");
		expect(session.isStreaming).toBe(false);
		// No turn ran for it: the transcript still ends with the parent's last reply before the switch.
		expect(parentCalls).toBe(2);
	});

	it("tells a forked session that its source's subagents stay behind, and refuses them clearly", async () => {
		const { runtime, subagents, setResponses } = await createParent();
		setResponses([
			launchScout(),
			fauxAssistantMessage("child one"),
			fauxAssistantMessage("parent one"),
			fauxAssistantMessage("parent two"),
			fauxAssistantMessage(
				fauxToolCall("agent", { tasks: [{ resume: "scout", description: "Again", prompt: "again" }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("fork reply"),
			fauxAssistantMessage("fork next"),
		]);
		await runtime.session.prompt("delegate");
		await runtime.session.prompt("second message");
		const userEntry = runtime.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message" && entry.message.role === "user")
			.at(-1)!;
		expect((await runtime.fork(userEntry.id, { position: "at" })).cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(subagents.overview()?.children).toEqual([]);
		await runtime.session.prompt("continue scout");
		const notice = listings(runtime.session).find((text) => text.includes("This session was forked"));
		expect(notice).toContain("(scout) stay with that session");
		const refused = runtime.session.messages
			.filter((message) => message.role === "toolResult" && message.toolName === "agent")
			.at(-1);
		expect(JSON.stringify(refused)).toContain("belongs to the session this one was forked from");
		await runtime.session.prompt("again");
		expect(listings(runtime.session).filter((text) => text.includes("This session was forked"))).toHaveLength(1);
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
