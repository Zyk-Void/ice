/** Shared fixtures for the legacy ice-subagents test files (split from ice-subagents.test.ts). */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AssistantMessage } from "@zykairotis/ice-ai";
import { createAssistantMessageEventStream } from "@zykairotis/ice-ai";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import {
	fauxAssistantMessage,
	registerApiProvider,
	registerFauxProvider,
	unregisterApiProviders,
} from "@zykairotis/ice-ai/compat";
import { vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import iceSubagents, {
	collectWriterPatchArtifact,
	createNativeSubagentSession as createNativeSubagentSessionWithAgentDir,
	createWriterWorkspace,
	normalizeSubagentRequest as normalizeSubagentRequestWithAgentDir,
	type ResolvedReviewTask,
	type ResolvedSubagentBatchTask,
	type ReviewDimension,
	type SubagentNormalizationOptions,
	type SubagentRequest,
	type SubagentResult,
	type WriterRequest,
} from "../src/ice-subagents.ts";
import type { IceHookHandler } from "../src/subagents/settings.ts";

export const tempDirs: string[] = [];
export const execFileAsync = promisify(execFile);

export function normalizeSubagentRequest(
	request: SubagentRequest,
	cwd: string,
	options: SubagentNormalizationOptions = {},
): ReturnType<typeof normalizeSubagentRequestWithAgentDir> {
	return normalizeSubagentRequestWithAgentDir(request, cwd, { agentDir: join(cwd, ".ice-agent"), ...options });
}

export async function createNativeSubagentSession(
	options: Parameters<typeof createNativeSubagentSessionWithAgentDir>[0],
	createSession?: Parameters<typeof createNativeSubagentSessionWithAgentDir>[1],
): ReturnType<typeof createNativeSubagentSessionWithAgentDir> {
	return createNativeSubagentSessionWithAgentDir(
		{ agentDir: join(options.request.cwd, ".ice-agent"), ...options },
		createSession,
	);
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
	return result.stdout;
}

export async function createWorkspace(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "ice-subagents-"));
	tempDirs.push(cwd);
	await mkdir(join(cwd, "src"));
	return cwd;
}

export async function createFauxChildRuntime(cwd: string, faux: ReturnType<typeof registerFauxProvider>) {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(cwd, "models.json"),
	});
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [model],
	});
	return { model, modelRuntime };
}

export function createNoopExtensionRunner() {
	return {
		hasHandlers: vi.fn(() => false),
		emit: vi.fn(async () => undefined),
	};
}

export type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<unknown> | unknown;

export type AsyncToolHarnessOptions = {
	activeTools?: string[] | (() => string[]);
	agentDir?: string;
	appendEntry?: (customType: string, data: unknown) => unknown;
	confirm?: boolean;
	flags?: Record<string, boolean | string | undefined>;
	hookHandlers?: Readonly<Record<string, IceHookHandler>>;
	lateSubYolo?: boolean;
	hasUI?: boolean;
	mode?: ExtensionContext["mode"];
	iceMode?: "plan" | "build";
	settingsManager?: SettingsManager;
	trusted?: boolean;
};

export type ManagedToolLike = { execute: (...args: unknown[]) => Promise<unknown> };
export type SettledToolResult = {
	isError: boolean;
	content: Array<{ text: string }>;
	details: Record<string, unknown>;
};

/** Delegate always returns a managed handle; wait for the terminal presentation and merge it with the launch. */
export async function settleManagedDelegate(
	tools: ReadonlyMap<string, ManagedToolLike>,
	context: ExtensionContext,
	launched: unknown,
): Promise<SettledToolResult> {
	const launch = launched as SettledToolResult;
	const managed = launch.details?.managed as { runId: string } | undefined;
	if (!managed) return launch;
	const waited = (await tools
		.get("manage_subagent")!
		.execute(
			"settle-managed",
			{ action: "wait", runId: managed.runId, waitMs: 60_000 },
			undefined,
			undefined,
			context,
		)) as SettledToolResult;
	const observation = waited.details.observation as { result?: SubagentResult } | undefined;
	return {
		isError: waited.isError || observation?.result?.status !== "completed",
		content: waited.content,
		details: { ...launch.details, ...waited.details, result: observation?.result },
	};
}

export async function createAsyncToolHarness(options: AsyncToolHarnessOptions = {}) {
	const cwd = await createWorkspace();
	const agentDir = options.agentDir ?? join(cwd, ".ice-agent");
	await mkdir(agentDir, { recursive: true });
	const faux = registerFauxProvider();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(cwd, "models.json") });
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
	const settingsManager = options.settingsManager ?? SettingsManager.inMemory();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
	const commands = new Map<string, { handler: CommandHandler }>();
	const entries: Array<Record<string, unknown>> = [];
	const sent: unknown[] = [];
	const getEntries = vi.fn(() => entries);
	let overlay: unknown;
	const custom = vi.fn(async (factory: unknown) => {
		if (typeof factory !== "function") throw new Error("overlay factory missing");
		const tui = { requestRender: vi.fn() };
		const theme = { fg: (_color: string, text: string) => text };
		const keybindings = {
			matches: (data: string, action: string) =>
				(data === "inspect" && action === "app.subagents.inspect") ||
				(data === "enter" && action === "tui.select.confirm") ||
				(data === "escape" && action === "tui.select.cancel"),
		};
		overlay = (factory as (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => unknown)(
			tui,
			theme,
			keybindings,
			() => {},
		);
		return overlay;
	});
	const registerTool = vi.fn();
	const registerFlag = vi.fn();
	const confirm = vi.fn(async (_title: string, _message: string) => options.confirm ?? false);
	let flagsReady = !options.lateSubYolo;
	const appendEntry = vi.fn((customType: string, data: unknown) => entries.push({ type: "custom", customType, data }));
	const api = {
		registerFlag,
		getFlag: (name: string) => (flagsReady ? options.flags?.[name] : undefined),
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) {
			handlers.set(event, handler);
		},
		registerTool,
		registerCommand: (name: string, options: { handler: CommandHandler }) => commands.set(name, options),
		appendEntry: options.appendEntry ?? appendEntry,
		sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
		getActiveTools: () =>
			typeof options.activeTools === "function"
				? options.activeTools()
				: (options.activeTools ?? ["delegate", "read"]),
	} as unknown as ExtensionAPI;
	const capabilityTools = [
		"read",
		"grep",
		"find",
		"ls",
		"delegate",
		"delegate_async",
		"inspect_subagent_job",
		"cancel_subagent_job",
		"delegate_batch",
		"review_batch",
		"delegate_write",
		"inspect_writer_patch",
		"reject_writer_patch",
		"integrate_writer_patch",
		"read_plan",
		"edit",
		"write",
	];
	iceSubagents(api, {
		agentDir,
		getIceMode: () => options.iceMode,
		getIceCapabilityState: () => ({
			mode: options.iceMode ?? "plan",
			tools:
				options.iceMode === "build" && options.trusted && options.flags?.["ice-allow-bash"]
					? [...capabilityTools, "bash"]
					: capabilityTools,
			bashEnabledInRecordedProcess:
				options.iceMode === "build" && options.trusted === true && options.flags?.["ice-allow-bash"] === true,
			allowExternal:
				options.iceMode === "build" && options.trusted === true && options.flags?.["allow-external"] === true,
		}),
		hookHandlers: options.hookHandlers,
	});
	flagsReady = true;
	const context = {
		cwd,
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		ui: { custom, confirm },
		model,
		scopedModels: [],
		isProjectTrusted: () => options.trusted ?? false,
		modelRegistry: new ModelRegistry(modelRuntime),
		settingsManager,
		sessionManager: { getSessionId: () => "owner-a", getLeafId: () => "leaf-a", getEntries },
	} as unknown as ExtensionContext;
	await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, context);
	const tools = new Map(registerTool.mock.calls.map((call) => [call[0]?.name, call[0]]));
	return {
		context,
		entries,
		faux,
		handlers,
		sent,
		tools,
		commands,
		custom,
		confirm,
		getEntries,
		getOverlay: () => overlay,
		appendEntry,
	};
}

export async function createGitWorkspace(): Promise<{ cwd: string; head: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "ice-writer-git-"));
	tempDirs.push(cwd);
	await mkdir(join(cwd, "src"));
	await mkdir(join(cwd, "outside"));
	await writeFile(join(cwd, "src", "file.ts"), "base\n");
	await writeFile(join(cwd, "outside", "secret.txt"), "secret\n");
	await symlink("../outside", join(cwd, "src", "link"));
	await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
	await git(cwd, "init");
	await git(cwd, "config", "user.email", "ice-tests@example.invalid");
	await git(cwd, "config", "user.name", "ICE Tests");
	await git(cwd, "add", ".");
	await git(cwd, "commit", "-m", "base");
	const head = (await git(cwd, "rev-parse", "HEAD")).trim();
	return { cwd, head };
}

export function writerRequest(cwd: string, baseCommit: string): WriterRequest {
	return {
		parentSessionId: "parent-writer",
		task: "Update the isolated file.",
		scope: { roots: ["src"] },
		baseCommit,
		cwd,
	};
}

export async function createWriterArtifact(
	cwd: string,
	head: string,
	artifactRoot: string,
	path: string,
	content: string,
): Promise<NonNullable<ReturnType<typeof collectWriterPatchArtifact>>> {
	const workspace = await createWriterWorkspace(cwd, head);
	try {
		await writeFile(join(workspace.root, path), content);
		const artifact = collectWriterPatchArtifact(
			workspace,
			{ runId: `artifact-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`, status: "completed", baseCommit: head },
			{ scopeRoots: [join(workspace.root, "src")], artifactRoot },
		);
		if (!artifact) throw new Error("writer artifact was not collected");
		return artifact;
	} finally {
		await workspace.cleanup();
	}
}

export const SELF_TEST_INSTRUCTIONS = "Inspect the approved scope and report evidence with file paths.";
export const SELF_TEST_CAPABILITIES = ["read", "grep", "find", "ls"] as const;

export function request(cwd: string, role: string = "self"): SubagentRequest {
	return {
		parentSessionId: "parent-1",
		role,
		task: "Trace the model runtime.",
		scope: { roots: ["src"] },
		cwd,
		...(role === "self"
			? { self: { instructions: SELF_TEST_INSTRUCTIONS, capabilities: [...SELF_TEST_CAPABILITIES] } }
			: {}),
	};
}

export function resolvedBatchTask(cwd: string, id: string, role: string = "self"): ResolvedSubagentBatchTask {
	const childRequest = normalizeSubagentRequest(
		{
			...request(cwd, role),
			task: `Trace task ${id}.`,
		},
		cwd,
	);
	return { id, request: childRequest };
}

export function resolvedReviewTask(cwd: string, id: string, dimension: ReviewDimension): ResolvedReviewTask {
	const childRequest = normalizeSubagentRequest({ ...request(cwd), task: `Review ${dimension} for ${id}.` }, cwd, {
		agentDir: join(cwd, ".ice-agent"),
	});
	return { id, dimension, request: childRequest };
}

export function verificationFixture(cwd: string, role: "self" | "review" = "self") {
	// The verification pipeline (evidence paths, payloads, requirement claims) is
	// structured-report-only; plain final-turn runs stop at lineage/output checks.
	const normalized = normalizeSubagentRequest(
		{ ...request(cwd, role), outputSchema: { type: "object", additionalProperties: false } },
		cwd,
	);
	const result: SubagentResult = {
		runId: normalized.runId,
		parentSessionId: "parent-1",
		childSessionId: "child-verified",
		profile: role,
		source: normalized.profile.source,
		status: "completed",
		summary: "Observed the requested implementation fact.",
		output: {
			text: "Observed the requested implementation fact.",
			textBytes: Buffer.byteLength("Observed the requested implementation fact."),
			originalBytes: Buffer.byteLength("Observed the requested implementation fact."),
			inlineTruncated: false,
			captureStatus: "inline_complete",
		},
		observedOutputBytes: Buffer.byteLength("Observed the requested implementation fact."),
		partial: false,
		diagnostics: [],
		evidence: { paths: ["src"] },
		payload: {},
	};
	return { normalized, result };
}

export function testModel(provider: string, id: string): Model<Api> {
	return { provider, id } as Model<Api>;
}

export const SCRIPTED_USAGE_API = "usage-scripted";

export function registerScriptedUsageProvider(
	responses: AssistantMessage[],
	options: { api?: string } = {},
): {
	model: Model<Api>;
	consumed: () => number;
	unregister: () => void;
} {
	const api = options.api ?? SCRIPTED_USAGE_API;
	const sourceId = `scripted-usage-${Math.random().toString(36).slice(2)}`;
	let served = 0;
	const stream = () => {
		const message =
			responses[served] ??
			fauxAssistantMessage("scripted responses exhausted", { stopReason: "error", errorMessage: "exhausted" });
		served += 1;
		const eventStream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				eventStream.push({ type: "error", reason: message.stopReason, error: message });
				eventStream.end(message);
				return;
			}
			if (message.stopReason === "pending") {
				eventStream.push({
					type: "error",
					reason: "error",
					error: {
						...message,
						stopReason: "error",
						errorMessage: "scripted response ended without a stop reason",
					},
				});
				eventStream.end(message);
				return;
			}
			eventStream.push({ type: "done", reason: message.stopReason, message });
			eventStream.end(message);
		});
		return eventStream;
	};
	registerApiProvider({ api, stream: stream as never, streamSimple: stream as never }, sourceId);
	return {
		model: {
			provider: "scripted",
			id: "scripted-1",
			name: "scripted-1",
			api,
			baseUrl: "http://127.0.0.1:9",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		} as unknown as Model<Api>,
		consumed: () => served,
		unregister: () => unregisterApiProviders(sourceId),
	};
}

export async function scriptedModelRuntime(cwd: string, model: Model<Api>): Promise<ModelRuntime> {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "scripted-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(cwd, "models.json") });
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
	return modelRuntime;
}

export function commonPrefixBytes(left: string, right: string): number {
	const leftBytes = Buffer.from(left, "utf8");
	const rightBytes = Buffer.from(right, "utf8");
	let index = 0;
	while (index < leftBytes.length && index < rightBytes.length && leftBytes[index] === rightBytes[index]) index += 1;
	return index;
}

export function batchResult(
	task: ResolvedSubagentBatchTask,
	status: SubagentResult["status"] = "completed",
	summary = "ok",
): SubagentResult {
	return {
		runId: task.request.runId,
		childSessionId: `child-${task.id}`,
		parentSessionId: task.request.parentSessionId,
		profile: task.request.role,
		source: task.request.profile.source,
		status,
		summary,
		...(status === "completed"
			? {
					output: {
						text: summary,
						textBytes: Buffer.byteLength(summary),
						originalBytes: Buffer.byteLength(summary),
						inlineTruncated: false,
						captureStatus: "inline_complete" as const,
					},
				}
			: {}),
		observedOutputBytes: Buffer.byteLength(summary),
		partial: status !== "completed",
		diagnostics:
			status === "completed"
				? []
				: [{ code: status === "cancelled" ? "cancellation" : "child_runtime_failure", message: status }],
		usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, cost: 0.5 },
		evidence: status === "completed" ? { paths: ["src"] } : undefined,
	};
}
