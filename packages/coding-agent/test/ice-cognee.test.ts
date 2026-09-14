import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import {
	appendMemoryToSystemPrompt,
	buildLocalPrecompactAnchor,
	canAttemptCircuit,
	cogneeSessionId,
	createCircuitState,
	createIceCogneeExtension,
	createPendingRemember,
	enqueuePendingRemember,
	extractMessageText,
	loadIceCogneeConfig,
	noteCircuitFailure,
	PROJECT_DATASET_SENTINEL,
	readPendingRemember,
	redactMemoryText,
	resolveCogneeApiKey,
	resolveIceCogneeConfig,
	resolveProjectCogneeDataset,
	resolveRuntimeCogneeDataset,
	saveIceCogneeConfig,
	shouldOwnCompactionSummary,
	truncateForCapture,
	updatePendingRememberState,
} from "../src/ice-cognee.ts";
import { type CogneeClientConfig, CogneeError, createCogneeClient } from "../src/ice-cognee-client.ts";
import { parseEnvFile } from "../src/ice-cognee-env.ts";
import { readCogneeObservations } from "../src/ice-cognee-observer.ts";

function config(overrides: Partial<CogneeClientConfig> = {}): CogneeClientConfig {
	return {
		baseUrl: "http://127.0.0.1:8211/",
		dataset: "ice",
		recallBudgetMs: 1500,
		maxResponseChars: 6000,
		...overrides,
	};
}

describe("ice-cognee HTTP client", () => {
	it("scopes recall to the configured dataset and normalizes results", async () => {
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		const client = createCogneeClient(config({ apiKey: "secret-key" }), {
			fetch: async (input, init) => {
				requestUrl = String(input);
				requestInit = init;
				return new Response(JSON.stringify([{ text: "remembered fact", score: 0.9 }]), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});

		await expect(client.recall("remember this", { topK: 3, sessionId: "session-1" })).resolves.toEqual([
			{ text: "remembered fact", score: 0.9 },
		]);
		expect(requestUrl).toBe("http://127.0.0.1:8211/api/v1/recall");
		expect(requestInit?.method).toBe("POST");
		expect(new Headers(requestInit?.headers).get("x-api-key")).toBe("secret-key");
		expect(JSON.parse(String(requestInit?.body))).toEqual({
			query: "remember this",
			topK: 3,
			onlyContext: true,
			scope: ["session", "trace", "graph"],
			sessionId: "session-1",
			datasets: ["ice"],
		});
	});

	it("accepts a bounded oversized recall envelope and keeps top-k results", async () => {
		const payload = JSON.stringify({
			results: [{ text: "first memory" }, { text: "second memory" }],
			context: "x".repeat(7_000),
		});
		const client = createCogneeClient(config({ maxResponseChars: 100 }), {
			fetch: async () =>
				new Response(payload, {
					status: 200,
					headers: { "content-length": String(payload.length) },
				}),
		});

		await expect(client.recall("query", { topK: 1 })).resolves.toEqual([{ text: "first memory" }]);
	});

	it("bounds normalized recall text by the configured response limit", async () => {
		const client = createCogneeClient(config({ maxResponseChars: 8 }), {
			fetch: async () => new Response(JSON.stringify([{ text: "1234567890" }, { text: "second" }]), { status: 200 }),
		});

		await expect(client.recall("query", { topK: 2 })).resolves.toEqual([{ text: "12345678" }]);
	});

	it("stores session cache entries via remember/entry", async () => {
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		const client = createCogneeClient(config({ apiKey: "secret-key" }), {
			fetch: async (input, init) => {
				requestUrl = String(input);
				requestInit = init;
				return new Response(JSON.stringify({ entry_id: "e1" }), { status: 200 });
			},
		});

		await expect(
			client.rememberEntry({
				sessionId: "ice_session-1",
				entry: { type: "qa", question: "q", answer: "a", context: "" },
			}),
		).resolves.toEqual({ entryId: "e1" });
		expect(requestUrl).toBe("http://127.0.0.1:8211/api/v1/remember/entry");
		expect(JSON.parse(String(requestInit?.body))).toMatchObject({
			session_id: "ice_session-1",
			dataset_name: "ice",
			entry: { type: "qa", question: "q", answer: "a" },
		});
	});

	it("reports an unavailable improve endpoint instead of resolving", async () => {
		const client = createCogneeClient(config(), {
			fetch: async () => new Response(null, { status: 404 }),
		});

		await expect(client.improve()).rejects.toSatisfy((error: unknown) => {
			return error instanceof CogneeError && error.kind === "not_found" && error.status === 404;
		});
	});

	it("sends the Cognee v1 improve payload fields", async () => {
		let requestInit: RequestInit | undefined;
		const client = createCogneeClient(config(), {
			fetch: async (_input, init) => {
				requestInit = init;
				return new Response(null, { status: 200 });
			},
		});

		await client.improve({ dataset: "ice-void-smoke", sessionIds: ["session-1"] });

		expect(JSON.parse(String(requestInit?.body))).toEqual({
			datasetName: "ice-void-smoke",
			sessionIds: ["session-1"],
			runInBackground: true,
		});
	});

	it("sends remember as background multipart data", async () => {
		let requestInit: RequestInit | undefined;
		const client = createCogneeClient(config(), {
			fetch: async (_input, init) => {
				requestInit = init;
				return new Response(null, { status: 202 });
			},
		});

		await client.remember({ nodeSet: "agent_actions", text: "compaction summary" });

		expect(requestInit?.method).toBe("POST");
		expect(requestInit?.body).toBeInstanceOf(FormData);
		const form = requestInit?.body as FormData;
		expect(form.get("datasetName")).toBe("ice");
		expect(form.get("node_set")).toBe("agent_actions");
		expect(form.get("run_in_background")).toBe("true");
		const data = form.get("data");
		expect(data).toBeInstanceOf(Blob);
		await expect((data as Blob).text()).resolves.toBe("compaction summary");
	});

	it("classifies HTTP failures without exposing the API key", async () => {
		const client = createCogneeClient(config({ apiKey: "do-not-log" }), {
			fetch: async () => new Response("unauthorized", { status: 401 }),
		});

		await expect(client.recall("query")).rejects.toSatisfy((error: unknown) => {
			return error instanceof CogneeError && error.kind === "auth_failed" && !error.message.includes("do-not-log");
		});
	});
});

describe("ice-cognee state helpers", () => {
	it("resolves safe defaults and validates environment overrides", () => {
		expect(resolveIceCogneeConfig(undefined, {})).toMatchObject({
			enabled: true,
			autoRecall: true,
			autoRemember: "compaction",
			captureSession: true,
			captureTools: true,
			autoImprove: true,
			baseUrl: "http://127.0.0.1:8211",
			dataset: "ice",
		});
		expect(
			resolveIceCogneeConfig(undefined, {
				ICE_COGNEE_ENABLED: "false",
				ICE_COGNEE_RECALL: "0",
				ICE_COGNEE_REMEMBER: "off",
				ICE_COGNEE_CAPTURE: "0",
				ICE_COGNEE_IMPROVE: "false",
				ICE_COGNEE_DATASET: "repo-memory",
			}),
		).toMatchObject({
			enabled: false,
			autoRecall: false,
			autoRemember: "off",
			captureSession: false,
			autoImprove: false,
			dataset: "repo-memory",
		});
		expect(() => resolveIceCogneeConfig(undefined, { ICE_COGNEE_ENABLED: "sometimes" })).toThrow(
			/ICE_COGNEE_ENABLED/,
		);
		expect(resolveIceCogneeConfig({ dataset: PROJECT_DATASET_SENTINEL }, {}).dataset).toBe(PROJECT_DATASET_SENTINEL);
		const project = resolveProjectCogneeDataset("/home/mewtwo/ZSSD/ice");
		expect(project).toMatch(/^ice-[A-Za-z0-9._-]+-[0-9a-f]{8}$/);
		expect(resolveRuntimeCogneeDataset(PROJECT_DATASET_SENTINEL, "/home/mewtwo/ZSSD/ice")).toBe(project);
		expect(resolveRuntimeCogneeDataset("ice")).toBe("ice");
		expect(appendMemoryToSystemPrompt("base prompt", "<mem>x</mem>")).toContain("base prompt");
		expect(appendMemoryToSystemPrompt("base prompt", "<mem>x</mem>")).toContain("<mem>x</mem>");
	});

	it("redacts common credentials and respects the memory cap", () => {
		const redacted = redactMemoryText(
			`COGNEE_API_KEY=secret-value\nAuthorization: Bearer bearer-value\n${"x".repeat(200)}`,
			80,
		);

		expect(redacted).not.toContain("secret-value");
		expect(redacted).not.toContain("bearer-value");
		expect(redacted).toContain("[REDACTED]");
		expect(redacted.length).toBeLessThanOrEqual(80);
	});

	it("prefers process env, then mint cache, then merged file env", () => {
		// Stale ~/.cognee/.env must not beat a fresh mint when process.env has no key
		expect(
			resolveCogneeApiKey(
				{ COGNEE_API_KEY: "stale-file-key" },
				'{"api_key":"cached-key","base_url":"http://127.0.0.1:8211"}',
				"http://127.0.0.1:8211",
				{}, // empty process env
				'{"api_key":"ice-key","base_url":"http://127.0.0.1:8211"}',
			),
		).toBe("ice-key");
		expect(
			resolveCogneeApiKey({ COGNEE_API_KEY: "stale-file-key" }, '{"api_key":"cached-key"}', undefined, {
				COGNEE_API_KEY: " process-key ",
			}),
		).toBe("process-key");
		expect(resolveCogneeApiKey({ COGNEE_API_KEY: "file-only" }, undefined, undefined, {})).toBe("file-only");
		expect(resolveCogneeApiKey({}, "not-json", undefined, {})).toBeUndefined();
	});

	it("bounds pending remember records without silently exceeding the queue limit", async () => {
		const directory = mkdtempSync(join(tmpdir(), "ice-cognee-queue-"));
		try {
			const first = createPendingRemember("summary one", "ice", "agent_actions", 100);
			const second = createPendingRemember("summary two", "ice", "agent_actions", 101);
			expect(await enqueuePendingRemember(directory, first, 1)).toBe(true);
			expect(await enqueuePendingRemember(directory, second, 1)).toBe(false);
			expect(await readPendingRemember(directory)).toEqual([first]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("opens after three failures and permits a later half-open trial", () => {
		let state = createCircuitState();
		state = noteCircuitFailure(state, "unreachable", 100);
		state = noteCircuitFailure(state, "unreachable", 101);
		state = noteCircuitFailure(state, "unreachable", 102);
		expect(canAttemptCircuit(state, 103)).toBe(false);
		expect(canAttemptCircuit(state, 30_103)).toBe(true);
	});
});

type Hook = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function extensionHookFixture(
	storageDir: string,
	hasUI = false,
	env: NodeJS.ProcessEnv = {},
	fetchImpl?: typeof fetch,
) {
	const handlers = new Map<string, Hook>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void> | void>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const settingsRegistrations = new Map<string, number>();
	const activeToolSets: string[][] = [];
	const appended: Array<{ customType: string; data: unknown }> = [];
	const notifications: string[] = [];
	const statuses: string[] = [];
	const requests: string[] = [];
	const requestBodies: Array<{ url: string; body?: string }> = [];
	const currentTools = ["read", "grep", "cognee_search"];
	const api = {
		on(event: string, handler: Hook) {
			handlers.set(event, handler);
		},
		registerCommand(
			name: string,
			command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
		) {
			commands.set(name, command.handler);
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.set(tool.name, tool);
		},
		registerSettings(name: string, settings: { items: unknown[] }) {
			settingsRegistrations.set(name, settings.items.length);
		},
		getActiveTools: () => [...currentTools],
		setActiveTools(toolNames: string[]) {
			activeToolSets.push([...toolNames]);
			currentTools.splice(0, currentTools.length, ...toolNames);
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI,
		signal: undefined,
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_id: string, status: string | undefined) => {
				if (status) statuses.push(status);
			},
		},
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
	const defaultFetch: typeof fetch = async (input, init) => {
		const url = String(input);
		requests.push(url);
		requestBodies.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
		if (url.endsWith("/recall")) {
			return new Response(JSON.stringify([{ text: "remembered context" }]), { status: 200 });
		}
		if (url.includes("/remember/entry")) {
			return new Response(JSON.stringify({ entry_id: "entry-1" }), { status: 200 });
		}
		if (url.includes("/improve") || url.includes("/agents/")) {
			return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
		}
		return new Response(null, { status: 202 });
	};
	createIceCogneeExtension({ storageDir, env, fetch: fetchImpl ?? defaultFetch })(api);
	return {
		handlers,
		commands,
		tools,
		settingsRegistrations,
		activeToolSets,
		appended,
		notifications,
		statuses,
		requests,
		requestBodies,
		ctx,
	};
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !condition(); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	if (!condition()) throw new Error("condition was not met before timeout");
}

describe("ice-cognee extension hooks", () => {
	it("shows recall activity before the request resolves and records its lifecycle", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-activity-"));
		let releaseRecall: (response: Response) => void = () => undefined;
		const recallResponse = new Promise<Response>((resolve) => {
			releaseRecall = resolve;
		});
		try {
			const runtime = extensionHookFixture(storageDir, true, {}, async (input) => {
				if (String(input).endsWith("/recall")) return recallResponse;
				return new Response(null, { status: 202 });
			});
			const prompt = runtime.handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "Authorization: Bearer prompt-secret" },
				runtime.ctx,
			);
			await waitFor(() => runtime.statuses.some((status) => status.includes("cognee:recall .")));
			expect(runtime.statuses.some((status) => status.includes("cognee:recall"))).toBe(true);
			releaseRecall(new Response(JSON.stringify([{ text: "remembered context" }]), { status: 200 }));
			await prompt;
			await new Promise((resolve) => setTimeout(resolve, 20));
			const events = await readCogneeObservations(storageDir);
			expect(events.map((event) => event.phase)).toEqual(["started", "succeeded"]);
			expect(events[0]?.preview).not.toContain("prompt-secret");
			expect(runtime.statuses.at(-1)).toContain("cap=on");
		} finally {
			rmSync(storageDir, { recursive: true, force: true });
		}
	});

	it("stops the activity spinner without an uncaught throw when ctx goes stale", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-stale-"));
		let releaseRecall: (response: Response) => void = () => undefined;
		const recallResponse = new Promise<Response>((resolve) => {
			releaseRecall = resolve;
		});
		const uncaught: unknown[] = [];
		const onUncaught = (error: unknown): void => {
			uncaught.push(error);
		};
		process.on("uncaughtException", onUncaught);
		try {
			const runtime = extensionHookFixture(storageDir, false, {}, async (input) => {
				if (String(input).endsWith("/recall")) return recallResponse;
				return new Response(null, { status: 202 });
			});
			// Mimic the runner's guarded ctx getter: `hasUI` reads true but any
			// `ui` access throws after session replacement invalidated the ctx.
			const staleCtx = Object.defineProperties(
				{},
				{
					hasUI: { get: () => true },
					ui: {
						get: () => {
							throw new Error("This extension ctx is stale after session replacement or reload.");
						},
					},
					sessionManager: { value: runtime.ctx.sessionManager },
					signal: { value: undefined },
				},
			) as unknown as ExtensionContext;
			const prompt = runtime.handlers.get("before_agent_start")?.(
				{
					type: "before_agent_start",
					prompt: "stale-ctx prompt",
				},
				staleCtx,
			);
			// Let the first spinner tick fire against the stale ctx.
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(uncaught).toEqual([]);
			// A later tick must not resurrect the throw either.
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(uncaught).toEqual([]);
			releaseRecall(new Response(JSON.stringify([{ text: "remembered context" }]), { status: 200 }));
			await prompt;
		} finally {
			process.off("uncaughtException", onUncaught);
			rmSync(storageDir, { recursive: true, force: true });
		}
	});

	it("starts and closes the local observer through /cognee watch", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-watch-"));
		try {
			const runtime = extensionHookFixture(storageDir, true);
			const command = runtime.commands.get("cognee");
			if (!command) throw new Error("cognee command was not registered");
			await command("watch", runtime.ctx);
			const message = runtime.notifications.find((item) => item.includes("Cognee observer:"));
			if (!message) throw new Error("observer URL was not reported");
			const url = message.slice(message.indexOf("http://"));
			expect(await fetch(url).then((response) => response.text())).toContain("Cognee Signal Room");
			await runtime.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, runtime.ctx);
			expect(await fetch(url).catch(() => undefined)).toBeUndefined();
		} finally {
			rmSync(storageDir, { recursive: true, force: true });
		}
	});

	it("injects transient recall and queues a redacted compaction summary", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-extension-"));
		try {
			const runtime = extensionHookFixture(storageDir);
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			const recall = await runtime.handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "What did we decide?", systemPrompt: "base system" },
				runtime.ctx,
			);
			expect(recall).toMatchObject({ systemPrompt: expect.stringContaining("base system") });
			expect((recall as { systemPrompt: string }).systemPrompt).toContain("remembered context");
			expect(recall).not.toHaveProperty("message");

			await runtime.handlers.get("session_compact")?.(
				{
					type: "session_compact",
					compactionEntry: { summary: "API_KEY=secret-value\nWe chose the queue." },
					reason: "manual",
					fromExtension: false,
					willRetry: false,
				},
				runtime.ctx,
			);
			const records = await readPendingRemember(join(storageDir, "pending"));
			expect(records).toHaveLength(1);
			expect(records[0]?.text).not.toContain("secret-value");
			expect(records[0]?.text).toContain("We chose the queue.");
			expect(runtime.appended[0]).toMatchObject({ customType: "ice-cognee" });
			expect(runtime.appended[0]?.data).not.toHaveProperty("text");

			const afterCompact = await runtime.handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "continue", systemPrompt: "next turn" },
				runtime.ctx,
			);
			expect((afterCompact as { systemPrompt: string }).systemPrompt).toContain("ice-void-last-compact");
			expect((afterCompact as { systemPrompt: string }).systemPrompt).toContain("We chose the queue.");
		} finally {
			rmSync(storageDir, { recursive: true, force: true });
		}
	});

	it("retries recall after a failed attempt for the same prompt", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-recall-retry-"));
		let recalls = 0;
		try {
			const runtime = extensionHookFixture(storageDir, false, {}, async (input) => {
				if (String(input).endsWith("/recall")) {
					recalls += 1;
					if (recalls === 1) return new Response("nope", { status: 500 });
					return new Response(JSON.stringify([{ text: "second try" }]), { status: 200 });
				}
				return new Response(null, { status: 202 });
			});
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			const first = await runtime.handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "same prompt", systemPrompt: "sys" },
				runtime.ctx,
			);
			expect(first).toBeUndefined();
			const second = await runtime.handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "same prompt", systemPrompt: "sys" },
				runtime.ctx,
			);
			expect((second as { systemPrompt: string }).systemPrompt).toContain("second try");
			expect(recalls).toBe(2);
		} finally {
			rmSync(storageDir, { recursive: true, force: true });
		}
	});

	it("defers Ice compaction summary when Blackhole would own it", () => {
		expect(shouldOwnCompactionSummary("defer")).toBe(false);
		expect(shouldOwnCompactionSummary("own")).toBe(true);
		expect(shouldOwnCompactionSummary("auto")).toBe(false);
		const local = buildLocalPrecompactAnchor(
			{
				previousSummary: "prior",
				messagesToSummarize: [{}, {}],
				fileOps: { read: ["a.ts"], edited: ["b.ts"], written: [] },
				tokensBefore: 99,
			},
			"threshold",
		);
		expect(local).toContain("messagesToSummarize=2");
		expect(local).toContain("read: a.ts");
		expect(local).toContain("prior");
	});

	it("stores a pre-compact anchor without overriding Blackhole/native summary by default", async () => {
		const agentRoot = mkdtempSync(join(tmpdir(), "ice-cognee-agent-"));
		const storageDir = join(agentRoot, "ice-cognee");
		// Simulate Blackhole owning compact
		mkdirSync(join(agentRoot, "ice-blackhole"), { recursive: true });
		writeFileSync(
			join(agentRoot, "ice-blackhole", "ice-blackhole-config.json"),
			JSON.stringify({ compaction: "auto", compactionEngine: "blackhole" }),
		);
		try {
			const runtime = extensionHookFixture(storageDir, false, { ICE_CODING_AGENT_DIR: agentRoot });
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			const recallBefore = runtime.requests.filter((url) => url.includes("/recall")).length;
			const result = await runtime.handlers.get("session_before_compact")?.(
				{
					type: "session_before_compact",
					preparation: {
						firstKeptEntryId: "keep-1",
						tokensBefore: 42,
						previousSummary: "What did we decide?",
						messagesToSummarize: [{}],
						turnPrefixMessages: [],
						fileOps: { read: ["x.ts"], edited: [], written: [] },
					},
					reason: "manual",
				},
				runtime.ctx,
			);
			// Defer: no compaction result — Blackhole/native keeps the Ice summary
			expect(result).toBeUndefined();
			// Fast path: no multi-scope recall and no dummy precompact QA
			expect(runtime.requests.filter((url) => url.includes("/recall")).length).toBe(recallBefore);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(runtime.requests.some((url) => url.includes("/remember/entry"))).toBe(false);
		} finally {
			rmSync(agentRoot, { recursive: true, force: true });
		}
	});

	it("writes a bounded checkpoint-recall handoff for Blackhole when enabled", async () => {
		const agentRoot = mkdtempSync(join(tmpdir(), "ice-cognee-checkpoint-"));
		const storageDir = join(agentRoot, "ice-cognee");
		mkdirSync(join(agentRoot, "ice-blackhole"), { recursive: true });
		writeFileSync(
			join(agentRoot, "ice-blackhole", "ice-blackhole-config.json"),
			JSON.stringify({ compaction: "auto", compactionEngine: "blackhole" }),
		);
		try {
			const runtime = extensionHookFixture(storageDir, false, {
				ICE_CODING_AGENT_DIR: agentRoot,
				ICE_COGNEE_CHECKPOINT_RECALL: "true",
			});
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			const result = await runtime.handlers.get("session_before_compact")?.(
				{
					type: "session_before_compact",
					preparation: {
						firstKeptEntryId: "keep-1",
						tokensBefore: 42,
						messagesToSummarize: [{ role: "user", content: "Where did we leave the queue refactor?" }],
						turnPrefixMessages: [],
						fileOps: { read: [], edited: [], written: [] },
					},
					reason: "manual",
				},
				runtime.ctx,
			);
			expect(result).toBeUndefined();
			expect(runtime.requests.filter((url) => url.includes("/recall")).length).toBe(1);
			const payloadPath = join(storageDir, "compaction-recall.json");
			expect(existsSync(payloadPath)).toBe(true);
			const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as {
				generatedAt: string;
				hostSessionId: string;
				query: string;
				results: Array<{ text: string; score?: number }>;
			};
			expect(payload.query).toContain("queue refactor");
			expect(payload.generatedAt).toBeTruthy();
			expect(payload.hostSessionId).toBe("session-1");
			expect(payload.results).toEqual([{ text: "remembered context" }]);
		} finally {
			rmSync(agentRoot, { recursive: true, force: true });
		}
	});

	it("checkpoint recall is independent of per-prompt autoRecall", async () => {
		const agentRoot = mkdtempSync(join(tmpdir(), "ice-cognee-checkpoint-independent-"));
		const storageDir = join(agentRoot, "ice-cognee");
		mkdirSync(join(agentRoot, "ice-blackhole"), { recursive: true });
		writeFileSync(
			join(agentRoot, "ice-blackhole", "ice-blackhole-config.json"),
			JSON.stringify({ compaction: "auto", compactionEngine: "blackhole" }),
		);
		try {
			const runtime = extensionHookFixture(storageDir, false, {
				ICE_CODING_AGENT_DIR: agentRoot,
				ICE_COGNEE_AUTO_RECALL: "false",
				ICE_COGNEE_CHECKPOINT_RECALL: "true",
			});
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			await runtime.handlers.get("session_before_compact")?.(
				{
					type: "session_before_compact",
					preparation: {
						messagesToSummarize: [{ role: "user", content: "Recall this checkpoint" }],
						fileOps: { read: [], edited: [], written: [] },
					},
					reason: "manual",
				},
				runtime.ctx,
			);
			expect(runtime.requests.filter((url) => url.includes("/recall")).length).toBe(1);
			expect(existsSync(join(storageDir, "compaction-recall.json"))).toBe(true);
		} finally {
			rmSync(agentRoot, { recursive: true, force: true });
		}
	});

	it("removes an old checkpoint handoff when a fresh recall returns no results", async () => {
		const agentRoot = mkdtempSync(join(tmpdir(), "ice-cognee-checkpoint-empty-"));
		const storageDir = join(agentRoot, "ice-cognee");
		mkdirSync(storageDir, { recursive: true });
		mkdirSync(join(agentRoot, "ice-blackhole"), { recursive: true });
		writeFileSync(
			join(agentRoot, "ice-blackhole", "ice-blackhole-config.json"),
			JSON.stringify({ compaction: "auto", compactionEngine: "blackhole" }),
		);
		writeFileSync(
			join(storageDir, "compaction-recall.json"),
			JSON.stringify({ generatedAt: new Date().toISOString(), results: [{ text: "stale" }] }),
		);
		try {
			const runtime = extensionHookFixture(
				storageDir,
				false,
				{ ICE_CODING_AGENT_DIR: agentRoot, ICE_COGNEE_CHECKPOINT_RECALL: "true" },
				async (input) =>
					String(input).endsWith("/recall")
						? new Response(JSON.stringify([]), { status: 200 })
						: new Response(null, { status: 202 }),
			);
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			await runtime.handlers.get("session_before_compact")?.(
				{
					type: "session_before_compact",
					preparation: {
						messagesToSummarize: [{ role: "user", content: "No matches" }],
						fileOps: { read: [], edited: [], written: [] },
					},
					reason: "manual",
				},
				runtime.ctx,
			);
			expect(existsSync(join(storageDir, "compaction-recall.json"))).toBe(false);
		} finally {
			rmSync(agentRoot, { recursive: true, force: true });
		}
	});

	it("clears a same-session checkpoint handoff when checkpoint recall is disabled", async () => {
		const agentRoot = mkdtempSync(join(tmpdir(), "ice-cognee-checkpoint-disabled-stale-"));
		const storageDir = join(agentRoot, "ice-cognee");
		mkdirSync(storageDir, { recursive: true });
		mkdirSync(join(agentRoot, "ice-blackhole"), { recursive: true });
		writeFileSync(
			join(agentRoot, "ice-blackhole", "ice-blackhole-config.json"),
			JSON.stringify({ compaction: "auto", compactionEngine: "blackhole" }),
		);
		const handoffPath = join(storageDir, "compaction-recall.json");
		writeFileSync(
			handoffPath,
			JSON.stringify({
				generatedAt: new Date().toISOString(),
				hostSessionId: "session-1",
				results: [{ text: "stale" }],
			}),
		);
		try {
			const runtime = extensionHookFixture(storageDir, false, { ICE_CODING_AGENT_DIR: agentRoot });
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			await runtime.handlers.get("session_before_compact")?.(
				{
					type: "session_before_compact",
					preparation: {
						messagesToSummarize: [{ role: "user", content: "Checkpoint disabled" }],
						fileOps: { read: [], edited: [], written: [] },
					},
					reason: "manual",
				},
				runtime.ctx,
			);
			expect(existsSync(handoffPath)).toBe(false);
			expect(runtime.requests.some((url) => url.includes("/recall"))).toBe(false);
		} finally {
			rmSync(agentRoot, { recursive: true, force: true });
		}
	});

	it("persists checkpointRecall across config reloads", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-checkpoint-config-"));
		const configPath = join(storageDir, "config.json");
		try {
			const initial = resolveIceCogneeConfig({}, {});
			await saveIceCogneeConfig(configPath, { ...initial, checkpointRecall: true });
			expect((await loadIceCogneeConfig(configPath, {})).checkpointRecall).toBe(true);
		} finally {
			rmSync(storageDir, { recursive: true, force: true });
		}
	});

	it("does not write the checkpoint-recall handoff when disabled or Blackhole is inactive", async () => {
		const agentRoot = mkdtempSync(join(tmpdir(), "ice-cognee-checkpoint-off-"));
		const storageDir = join(agentRoot, "ice-cognee");
		try {
			const runtime = extensionHookFixture(storageDir, false, { ICE_CODING_AGENT_DIR: agentRoot });
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			await runtime.handlers.get("session_before_compact")?.(
				{
					type: "session_before_compact",
					preparation: {
						firstKeptEntryId: "keep-1",
						tokensBefore: 42,
						messagesToSummarize: [{ role: "user", content: "Anything" }],
						turnPrefixMessages: [],
						fileOps: { read: [], edited: [], written: [] },
					},
					reason: "manual",
				},
				runtime.ctx,
			);
			expect(runtime.requests.some((url) => url.includes("/recall"))).toBe(false);
			expect(existsSync(join(storageDir, "compaction-recall.json"))).toBe(false);
		} finally {
			rmSync(agentRoot, { recursive: true, force: true });
		}
	});

	it("returns the Cognee anchor through Ice's compaction contract when mode is own", async () => {
		const agentRoot = mkdtempSync(join(tmpdir(), "ice-cognee-own-"));
		const storageDir = join(agentRoot, "ice-cognee");
		try {
			const runtime = extensionHookFixture(storageDir, false, {
				ICE_CODING_AGENT_DIR: agentRoot,
				ICE_COGNEE_COMPACTION_SUMMARY: "own",
			});
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			const result = await runtime.handlers.get("session_before_compact")?.(
				{
					type: "session_before_compact",
					preparation: {
						firstKeptEntryId: "keep-1",
						tokensBefore: 42,
						previousSummary: "What did we decide?",
						messagesToSummarize: [{ content: "We chose the queue." }],
					},
					reason: "manual",
				},
				runtime.ctx,
			);
			expect(result).toMatchObject({
				compaction: {
					summary: expect.stringContaining("We chose the queue."),
					firstKeptEntryId: "keep-1",
					tokensBefore: 42,
				},
			});
			expect((result as { compaction: { summary: string } }).compaction.summary).not.toContain("remembered context");
		} finally {
			rmSync(agentRoot, { recursive: true, force: true });
		}
	});

	it("captures prompt/answer and redacted tool traces like Claude Code hooks", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-capture-"));
		try {
			const runtime = extensionHookFixture(storageDir);
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			await runtime.handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "Deploy uses which port?" },
				runtime.ctx,
			);
			await runtime.handlers.get("tool_result")?.(
				{
					type: "tool_result",
					toolCallId: "t1",
					toolName: "read",
					input: {
						path: "README.md",
						headers: { Authorization: "Bearer tool-secret", token: "token-secret" },
					},
					content: [{ type: "text", text: "port 8211\napi_key=output-secret" }],
					isError: true,
				},
				runtime.ctx,
			);
			await runtime.handlers.get("agent_end")?.(
				{
					type: "agent_end",
					messages: [{ role: "assistant", content: [{ type: "text", text: "Port 8211." }] }],
				},
				runtime.ctx,
			);
			// Allow fire-and-forget remember/entry + agents/register
			await new Promise((resolve) => setTimeout(resolve, 20));
			const entryCalls = runtime.requests.filter((url) => url.includes("/remember/entry"));
			expect(entryCalls.length).toBeGreaterThanOrEqual(2);
			const traceBody = runtime.requestBodies
				.filter((request) => request.url.includes("/remember/entry"))
				.map((request) => request.body)
				.map((body) => (body ? (JSON.parse(body) as { entry?: { type?: string } }) : undefined))
				.find((body) => body?.entry?.type === "trace");
			expect(traceBody).toBeDefined();
			expect(JSON.stringify(traceBody)).not.toContain("tool-secret");
			expect(JSON.stringify(traceBody)).not.toContain("token-secret");
			expect(JSON.stringify(traceBody)).not.toContain("output-secret");
			expect(JSON.stringify(traceBody)).toContain("[REDACTED]");
			expect(cogneeSessionId("session-1")).toBe("ice_session-1");
			expect(extractMessageText({ role: "assistant", content: [{ type: "text", text: "hi" }] })).toBe("hi");
			expect(truncateForCapture("x".repeat(20), 10)).toContain("…[truncated]");
		} finally {
			rmSync(storageDir, { recursive: true, force: true });
		}
	});
});

describe("ice-cognee lifecycle regressions", () => {
	it("does not block session startup on health and reports the eventual result", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-health-"));
		let releaseHealth: (response: Response) => void = () => undefined;
		const healthResponse = new Promise<Response>((resolve) => {
			releaseHealth = resolve;
		});
		try {
			const runtime = extensionHookFixture(storageDir, true, {}, async (input) => {
				const url = String(input);
				if (url.endsWith("/health")) return healthResponse;
				return new Response(null, { status: 200 });
			});
			const startup = Promise.resolve(
				runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx),
			);
			const outcome = await Promise.race([
				startup.then(() => "started"),
				new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
			]);
			if (outcome === "blocked") releaseHealth(new Response("ok", { status: 200 }));
			await startup;
			expect(outcome).toBe("started");
			expect(runtime.statuses.at(-1)).toContain("cognee:ice …");

			releaseHealth(new Response("ok", { status: 200 }));
			await waitFor(() => runtime.notifications.some((message) => message.includes("Cognee Memory Connected")));
			expect(runtime.statuses.at(-1)).toContain("cognee:ice ok");
		} finally {
			rmSync(storageDir, { recursive: true, force: true });
		}
	});

	it("serializes pending queue drains", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-drain-"));
		let releaseRemember!: () => void;
		const rememberGate = new Promise<void>((resolve) => {
			releaseRemember = resolve;
		});
		let rememberStarted = 0;
		const calls: string[] = [];
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			calls.push(url);
			if (url.endsWith("/remember")) {
				rememberStarted += 1;
				await rememberGate;
				return new Response(null, { status: 202 });
			}
			if (url.endsWith("/agents/register")) return new Response(null, { status: 200 });
			return url.endsWith("/health")
				? new Response("ok", { status: 200 })
				: new Response(JSON.stringify([{ text: "context" }]), { status: 200 });
		};
		try {
			const runtime = extensionHookFixture(storageDir, false, {}, fetchImpl);
			const record = createPendingRemember("existing summary", "ice", "agent_actions", 300);
			await enqueuePendingRemember(join(storageDir, "pending"), record, 4);
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			await waitFor(() => rememberStarted === 1);
			await runtime.handlers.get("session_compact")?.(
				{
					type: "session_compact",
					compactionEntry: { summary: "new summary" },
					reason: "manual",
				},
				runtime.ctx,
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(rememberStarted).toBe(1);
			releaseRemember();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(calls.filter((url) => url.endsWith("/remember"))).toHaveLength(1);
		} finally {
			rmSync(storageDir, { recursive: true, force: true });
		}
	});

	it("awaits improve before unregistering on shutdown", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-shutdown-"));
		let releaseImprove!: () => void;
		const improveGate = new Promise<void>((resolve) => {
			releaseImprove = resolve;
		});
		const calls: string[] = [];
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			calls.push(`start:${url}`);
			if (url.endsWith("/improve")) {
				await improveGate;
				calls.push(`done:${url}`);
				return new Response(null, { status: 200 });
			}
			if (url.endsWith("/agents/register") || url.endsWith("/agents/unregister")) {
				return new Response(null, { status: 200 });
			}
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response(JSON.stringify([{ text: "context" }]), { status: 200 });
		};
		try {
			const runtime = extensionHookFixture(storageDir, false, {}, fetchImpl);
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			await waitFor(() => calls.some((url) => url.endsWith("/agents/register")));
			await runtime.handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "capture this" },
				runtime.ctx,
			);
			const shutdown = runtime.handlers.get("session_shutdown")?.(
				{ type: "session_shutdown", reason: "quit" },
				runtime.ctx,
			);
			await waitFor(() => calls.some((url) => url.endsWith("/improve")));
			expect(calls.some((url) => url.endsWith("/agents/unregister"))).toBe(false);
			releaseImprove();
			await shutdown;
			const improveDone = calls.findIndex((url) => url.startsWith("done:"));
			const unregisterStart = calls.findIndex((url) => url.endsWith("/agents/unregister"));
			expect(improveDone).toBeGreaterThanOrEqual(0);
			expect(unregisterStart).toBeGreaterThan(improveDone);
		} finally {
			rmSync(storageDir, { recursive: true, force: true });
		}
	});
});

describe("ice-cognee policy regressions", () => {
	it("does not make recall requests when disabled", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-disabled-"));
		try {
			const runtime = extensionHookFixture(storageDir, false, { ICE_COGNEE_ENABLED: "false" });
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			expect(runtime.activeToolSets.at(-1)).toEqual(["read", "grep"]);
			expect(
				await runtime.handlers.get("before_agent_start")?.(
					{ type: "before_agent_start", prompt: "Should not recall" },
					runtime.ctx,
				),
			).toBeUndefined();
			expect(
				runtime.requests.filter(
					(url) => url.includes("/health") || url.includes("/recall") || url.includes("/remember"),
				),
			).toHaveLength(0);
		} finally {
			rmSync(storageDir, { recursive: true, force: true });
		}
	});

	it("does not auto-replay uncertain writes but allows explicit retry", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-uncertain-"));
		try {
			const runtime = extensionHookFixture(storageDir, true);
			const record = createPendingRemember("uncertain summary", "ice", "agent_actions", 200);
			await enqueuePendingRemember(join(storageDir, "pending"), record, 4);
			await updatePendingRememberState(join(storageDir, "pending"), record.operationId, "uncertain");
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			await new Promise((resolve) => setTimeout(resolve, 10));
			// session_start may register the agent; it must not drain uncertain items automatically
			const rememberCalls = () => runtime.requests.filter((url) => url.includes("/remember"));
			expect(rememberCalls()).toHaveLength(0);
			expect(await readPendingRemember(join(storageDir, "pending"))).toHaveLength(1);
			await runtime.commands.get("cognee")!("flush pending", runtime.ctx);
			expect(rememberCalls()).toHaveLength(0);
			await runtime.commands.get("cognee")!("flush uncertain", runtime.ctx);
			expect(rememberCalls().length).toBeGreaterThanOrEqual(1);
			expect(await readPendingRemember(join(storageDir, "pending"))).toHaveLength(0);
		} finally {
			rmSync(storageDir, { recursive: true, force: true });
		}
	});
});

describe("ice-cognee env file parsing", () => {
	it("parses export-style cognee keys", () => {
		const parsed = parseEnvFile(`
# comment
export COGNEE_BASE_URL="http://127.0.0.1:8211"
COGNEE_API_KEY=secret
LLM_API_KEY=should-not-appear
ICE_COGNEE_DATASET=ice
`);
		expect(parsed.COGNEE_BASE_URL).toBe("http://127.0.0.1:8211");
		expect(parsed.COGNEE_API_KEY).toBe("secret");
		expect(parsed.ICE_COGNEE_DATASET).toBe("ice");
		expect(parsed.LLM_API_KEY).toBeUndefined();
	});
});

describe("ice-cognee commands and search tool", () => {
	it("toggles without clobbering unrelated tools and runs manual operations", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-commands-"));
		try {
			const runtime = extensionHookFixture(storageDir, true);
			await runtime.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, runtime.ctx);
			expect(runtime.commands.has("cognee")).toBe(true);
			expect(runtime.tools.has("cognee_search")).toBe(true);

			await runtime.commands.get("cognee")!("off", runtime.ctx);
			expect((await loadIceCogneeConfig(join(storageDir, "config.json"), {})).enabled).toBe(false);
			expect(runtime.activeToolSets.at(-1)).toEqual(["read", "grep"]);

			await runtime.commands.get("cognee")!("on", runtime.ctx);
			expect(runtime.activeToolSets.at(-1)).toEqual(["read", "grep", "cognee_search"]);
			await runtime.commands.get("cognee")!("recall off", runtime.ctx);
			expect((await loadIceCogneeConfig(join(storageDir, "config.json"), {})).autoRecall).toBe(false);
			await runtime.commands.get("cognee")!("remember off", runtime.ctx);
			expect((await loadIceCogneeConfig(join(storageDir, "config.json"), {})).autoRemember).toBe("off");
			await runtime.commands.get("cognee")!("recall on", runtime.ctx);
			await runtime.commands.get("cognee")!("remember on", runtime.ctx);
			await runtime.commands.get("cognee")!("status", runtime.ctx);
			expect(runtime.notifications.join("\n")).toContain("dataset ice");
			await runtime.commands.get("cognee")!("search remembered", runtime.ctx);
			await runtime.commands.get("cognee")!("remember user_context explicit memory", runtime.ctx);
			expect(runtime.notifications.join("\n")).toContain("remembered context");

			const toolResult = await runtime.tools
				.get("cognee_search")!
				.execute("tool-1", { query: "remembered" }, undefined, undefined, runtime.ctx);
			expect(toolResult).toMatchObject({ content: [{ text: expect.stringContaining("remembered context") }] });

			await runtime.handlers.get("session_compact")?.(
				{
					type: "session_compact",
					compactionEntry: { summary: "queued summary" },
					reason: "manual",
					fromExtension: false,
					willRetry: false,
				},
				runtime.ctx,
			);
			expect(await readPendingRemember(join(storageDir, "pending"))).toHaveLength(1);
			await runtime.commands.get("cognee")!("flush pending", runtime.ctx);
			expect(await readPendingRemember(join(storageDir, "pending"))).toHaveLength(0);
		} finally {
			rmSync(storageDir, { recursive: true, force: true });
		}
	});
});
