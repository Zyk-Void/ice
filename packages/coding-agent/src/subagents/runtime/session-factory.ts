/** Native child and writer AgentSession factories (moved from ice-subagents.ts). */
import { dirname } from "node:path";
import type { ShouldStopAfterTurnContext } from "@zykairotis/ice-agent-core";
import type { Api, Context, Model, StreamFunction, StreamOptions } from "@zykairotis/ice-ai/compat";
import { getAgentDir } from "../../config.ts";
import type { SessionStartEvent, ToolDefinition } from "../../core/extensions/index.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { createBashToolDefinition } from "../../core/tools/index.ts";
import { redactCredentialText } from "../../utils/redact.ts";
import { resolveSubagentMcpRuntime, revalidateSubagentProfile } from "../definitions/legacy-profiles.ts";
import { validateWriterLaunchPreflight } from "../isolation/writer-patch.ts";
import type { SubagentOutputArtifactStore } from "../results/output-artifacts.ts";
import { createIceDelegableToolDefinitions } from "../tools/adapters.ts";
import { deriveEffectiveSubagentTools, deriveUnsafeSubagentTools, deriveWriterTools } from "../tools/derive.ts";
import { loadedSkillResourceReadRoots, uniquePaths } from "../tools/paths.ts";
import {
	createScopedReadOnlyToolDefinitions,
	createScopedWriterToolDefinitions,
	createSelectedMcpToolDefinitions,
	type SubagentExecutionPolicyBox,
	wrapSubagentToolDefinitions,
} from "../tools/scoped-tools.ts";
import {
	createDelegatedShellEnvironment,
	type NormalizedWriterRequest,
	SUBAGENT_DELEGABLE_TOOL_OUTPUT_MAX_BYTES,
	type SubagentDiagnostic,
	type SubagentStatus,
	type WriterToolName,
} from "../types.ts";
import type { ObservatoryPhase } from "../ui/observatory.ts";
import { SubagentError } from "./helpers.ts";
import {
	buildUnsafeSubagentSystemPrompt,
	mergeTrustedChildContext,
	type NativeSubagentSession,
	type NativeSubagentSessionOptions,
	resolveSubagentSamplingOptions,
	resolveSubagentThinkingLevel,
} from "./live-session.ts";
import { buildSubagentPrompt, deriveSubagentPromptCacheKey, loadSelectedPromptContent } from "./prompt.ts";
import { readValidatedResource, revalidateSubagentResources } from "./resources.ts";

export async function createNativeSubagentSession(
	options: NativeSubagentSessionOptions,
	createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult> = createAgentSession,
): Promise<NativeSubagentSession> {
	if (options.request.readOnlyReview) options = { ...options, unsafeHostExec: false };
	// A retained child keeps the wrappers installed by its original run; they read this box so a
	// resumed run can re-point them at its own policy instead of inheriting the original closures.
	const policyBox: SubagentExecutionPolicyBox = options.policyBox ?? {
		current: {
			beforeTool: options.beforeTool,
			eligibleTools: new Set<string>(),
			strictEligibility: false,
			reportOnly: options.reportOnly,
			shouldStopAfterTurn: options.shouldStopAfterTurn,
		},
	};
	const profile = options.request.profile;
	revalidateSubagentProfile(profile);
	revalidateSubagentResources(options.request.resources);
	// W13: execution.thinking specializes the profile default; routing never changes.
	// Only an explicit caller override rejects unsupported levels; profile
	// defaults clamp so bundled roles keep working on routes without reasoning
	// metadata (for example the faux test provider).
	const thinkingLevel = resolveSubagentThinkingLevel(options.request.execution.thinking, options.model, {
		explicit: options.request.executionThinkingExplicit,
	});
	// W14: resolve the caller subset after profile and mode eligibility.
	const callerSubset = options.request.requestedTools ?? profile.requestedTools;
	const deniedTools = new Set(options.request.iceContract.deniedTools);
	const tools = deriveEffectiveSubagentTools({
		requestedTools: callerSubset
			.filter((tool) => (profile.requestedTools as readonly string[]).includes(tool))
			.filter((tool) => !deniedTools.has(tool)),
		parentActiveTools: options.parentActiveTools,
		unsafeHostExec: options.unsafeHostExec === true,
	});
	const allowExternalTools = options.unsafeHostExec === true && options.request.allowExternal;
	if (
		tools.length === 0 &&
		!options.request.delegatedTools?.length &&
		!options.request.selectedMcpTools?.length &&
		options.request.requestedTools?.length !== 0
	) {
		throw new SubagentError("capability_denied", "Parent policy does not permit any requested child tool.");
	}
	if (options.unsafeHostExec && !options.request.projectTrusted) {
		throw new SubagentError("capability_denied", "Unsafe subagent host execution requires a trusted project.");
	}
	if (options.unsafeHostExec && !options.parentActiveTools.includes("bash")) {
		throw new SubagentError("capability_denied", "Unsafe subagent host execution requires parent Bash capability.");
	}
	// Explicit --sub-yolo authorization expands the selected profile's requested capabilities
	// only where the parent already has those capabilities; it never discards role guidance.
	const externalTools = options.request.delegatedTools ?? [];
	for (const tool of externalTools) {
		if (!tool.isCurrent() || !options.parentActiveTools.includes(tool.name))
			throw new SubagentError("capability_denied", `Delegated tool ${tool.name} was revoked.`);
	}
	const childTools: string[] = [...tools, ...externalTools.map((tool) => tool.name)];

	const agentDir = options.agentDir ?? getAgentDir();
	const yoloFullRuntime = options.unsafeHostExec === true;
	const settingsManager = SettingsManager.create(options.request.cwd, agentDir, {
		projectTrusted: yoloFullRuntime ? true : options.request.projectTrusted,
		globalFirst: true,
	});
	const selectedContextFiles = options.request.resources.context.map((resource) => ({
		path: resource.sourcePath,
		content: redactCredentialText(readValidatedResource(resource).toString("utf8")),
	}));
	const selectedPromptContents = options.request.resources.prompts.map(loadSelectedPromptContent);
	const prompt = buildSubagentPrompt(
		options.request,
		selectedPromptContents,
		options.unsafeHostExec === true,
		options.noLifetimeTimeout === true,
	);
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.request.cwd,
		agentDir,
		settingsManager,
		// Delegated capabilities use parent-owned adapters, never ambient child extensions.
		noPackages: true,
		noExtensions: true,
		additionalSkillPaths: options.request.resources.skills.map((resource) => resource.sourcePath),
		noSkills: true,
		additionalPromptTemplatePaths: options.request.resources.prompts.map((resource) => resource.sourcePath),
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		agentsFilesOverride: (base) => ({
			agentsFiles: yoloFullRuntime
				? mergeTrustedChildContext(base.agentsFiles, selectedContextFiles)
				: selectedContextFiles,
		}),
		systemPrompt: yoloFullRuntime ? buildUnsafeSubagentSystemPrompt(profile, childTools) : profile.systemPrompt,
		appendSystemPrompt: [],
		appendSystemPromptOverride: yoloFullRuntime
			? (base) => [
					...base,
					`UNSANDBOXED SUBAGENT RUNTIME: Only selected resources and parent-owned tool adapters are loaded. Model-visible tool authority remains the explicit profile-aware child tool allowlist. Granted Bash still uses the host account and may access host files, network, or processes and leave external effects. Cancellation is best-effort and cannot undo completed effects. No ambient child extensions, packages, or recursive delegation are enabled.`,
				]
			: undefined,
	});
	await resourceLoader.reload();
	// A child usually runs one long prompt rather than many user checkpoints. Use
	// the existing AgentSession mid-run compaction pipeline by default so a child
	// can compact between tool turns and resume the same turn. Apply this after
	// resource loading because reload() refreshes SettingsManager state. An
	// explicit setting (including `off`) remains authoritative, and parent
	// compaction behavior is unchanged because this override is child-local.
	if (settingsManager.getEffectiveSettings().compaction?.midRunCompaction === undefined) {
		settingsManager.applyOverrides({ compaction: { midRunCompaction: "resume" } });
	}
	if (options.retrySettings) settingsManager.applyOverrides({ retry: options.retrySettings });
	// Revalidate after loader reads and immediately before session creation.
	revalidateSubagentProfile(profile);
	revalidateSubagentResources(options.request.resources);
	const resourceReadRoots = uniquePaths([
		...options.request.resources.skills.map((resource) => dirname(resource.canonicalPath)),
		...loadedSkillResourceReadRoots(resourceLoader.getSkills().skills),
	]);

	// W14: the child registers the scoped tool surface needed for explicitly
	// selected resources, while the model-visible authority and final dispatch
	// checks remain bounded by childTools. Resource roots extend path authority
	// only; they never authorize a tool omitted from childTools.
	const eligibleToolSet = new Set<string>(childTools);
	// The wrappers installed below consult this box at dispatch time, so the run that owns the
	// session owns the authority check rather than the run that built the definitions.
	policyBox.current.eligibleTools = eligibleToolSet;
	// Selected MCP tools are opt-in, explicit, and parent-owned: the child never
	// loads an MCP adapter or opens a connection itself. Each selected
	// server/tool dispatches through the parent adapter with hooks, budgets,
	// cancellation, and bounded output; unknown/mutating entries fail closed
	// unless the parent explicitly authorizes them for this invocation.
	const selectedMcpTools =
		options.request.requestedTools?.length === 0 ? [] : (options.request.selectedMcpTools ?? []);
	const mcpRuntime = resolveSubagentMcpRuntime(
		{
			dispatch: options.mcpDispatch,
			parentMcpTools: options.parentMcpTools,
			mcpToolAccess: options.mcpToolAccess,
		},
		selectedMcpTools,
		options.unsafeHostExec === true,
	);
	const mcpDefinitions = createSelectedMcpToolDefinitions(selectedMcpTools, {
		mcpDispatch: mcpRuntime.dispatch,
		authorizations: options.request.mcpAuthorizations,
		isCurrent: options.request.mcpAuthorityStillValid,
	});
	const scopedReadDefinitions = options.unsafeHostExec
		? createScopedWriterToolDefinitions(
				options.request.cwd,
				options.request.scope.roots,
				allowExternalTools,
				resourceReadRoots,
				eligibleToolSet,
			)
		: createScopedReadOnlyToolDefinitions(
				options.request.cwd,
				options.request.scope.roots,
				resourceReadRoots,
				allowExternalTools,
				eligibleToolSet,
			);
	const scopedReadTools = wrapSubagentToolDefinitions(scopedReadDefinitions, policyBox, false);
	const externalDefinitions = createIceDelegableToolDefinitions(
		externalTools,
		{
			parentSessionId: options.request.parentSessionId,
			runId: options.request.runId,
			cwd: options.request.cwd,
			scopeRoots: options.request.scope.roots,
		},
		SUBAGENT_DELEGABLE_TOOL_OUTPUT_MAX_BYTES,
	);
	const adaptedNames = [...mcpDefinitions, ...externalDefinitions].map((definition) => definition.name);
	if (new Set(adaptedNames).size !== adaptedNames.length)
		throw new SubagentError(
			"capability_denied",
			"Delegated capability names collide; rename the parent adapter explicitly.",
		);
	for (const definition of [...mcpDefinitions, ...externalDefinitions]) {
		if (!childTools.includes(definition.name)) childTools.push(definition.name);
		eligibleToolSet.add(definition.name);
	}
	const promptCacheKey = deriveSubagentPromptCacheKey(
		options.request,
		options.model,
		childTools,
		options.unsafeHostExec === true,
		options.noLifetimeTimeout === true,
	);
	const scopedMcpTools = wrapSubagentToolDefinitions([...mcpDefinitions, ...externalDefinitions], policyBox);
	const created = await createSession({
		cwd: options.request.cwd,
		agentDir,
		model: options.model,
		modelRuntime: options.modelRuntime,
		thinkingLevel,
		tools: childTools,
		customTools: [
			...scopedReadTools,
			...scopedMcpTools,
			...(options.unsafeHostExec && options.parentActiveTools.includes("bash")
				? wrapSubagentToolDefinitions(
						[
							createBashToolDefinition(options.request.cwd, {
								exposeSessionEnvironment: false,
								spawnHook: (context) => ({
									...context,
									env: createDelegatedShellEnvironment(context.env),
								}),
							}) as unknown as ToolDefinition,
						],
						policyBox,
					)
				: []),
		],
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(options.request.cwd),
		sessionStartEvent: options.sessionStartEvent ?? { type: "session_start", reason: "startup" },
	});
	const childAgent = (
		created.session as unknown as {
			agent?: {
				streamFunction?: StreamFunction;
				shouldStopAfterTurn?: (
					context: ShouldStopAfterTurnContext,
					signal?: AbortSignal,
				) => boolean | Promise<boolean>;
			};
		}
	).agent;
	const streamDiagnostics: SubagentDiagnostic[] = [];
	if (
		(created.session.model ?? options.model) &&
		(options.request.execution.temperature !== undefined || options.request.execution.topP !== undefined)
	) {
		streamDiagnostics.push(
			...resolveSubagentSamplingOptions(created.session.model ?? options.model!, options.request.execution)
				.diagnostics,
		);
	}
	if (promptCacheKey && childAgent?.streamFunction) {
		const originalStreamFunction = childAgent.streamFunction;
		childAgent.streamFunction = ((model: Model<Api>, context: Context, streamOptions: StreamOptions = {}) =>
			originalStreamFunction(model, context, {
				...streamOptions,
				promptCacheKey:
					streamOptions.cacheRetention === "none" ? undefined : (streamOptions.promptCacheKey ?? promptCacheKey),
			})) as StreamFunction;
	}
	if (
		childAgent?.streamFunction &&
		(options.request.execution.temperature !== undefined || options.request.execution.topP !== undefined)
	) {
		const originalStreamFunction = childAgent.streamFunction;
		childAgent.streamFunction = ((model: Model<Api>, context: Context, streamOptions: StreamOptions = {}) => {
			const sampling = resolveSubagentSamplingOptions(model, options.request.execution);
			for (const diagnostic of sampling.diagnostics) {
				if (!streamDiagnostics.some((entry) => entry.message === diagnostic.message))
					streamDiagnostics.push(diagnostic);
			}
			const inheritedSamplingParams = streamOptions.samplingParams;
			const profileSamplingParams = sampling.options.samplingParams;
			const samplingParams =
				profileSamplingParams && inheritedSamplingParams?.top_p === undefined
					? { ...inheritedSamplingParams, ...profileSamplingParams }
					: inheritedSamplingParams;
			return originalStreamFunction(model, context, {
				...streamOptions,
				...(streamOptions.temperature === undefined && sampling.options.temperature !== undefined
					? { temperature: sampling.options.temperature }
					: {}),
				...(samplingParams !== undefined ? { samplingParams } : {}),
			});
		}) as StreamFunction;
	}
	if (childAgent) {
		const previousShouldStopAfterTurn = childAgent.shouldStopAfterTurn;
		childAgent.shouldStopAfterTurn = async (context, signal) => {
			if (await previousShouldStopAfterTurn?.(context, signal)) return true;
			const policy = policyBox.current;
			return (await policy.shouldStopAfterTurn?.()) ?? false;
		};
	}
	return {
		session: created.session,
		profile,
		tools: childTools,
		prompt,
		...(streamDiagnostics.length > 0 ? { diagnostics: Object.freeze([...streamDiagnostics]) } : {}),
		...(promptCacheKey ? { promptCacheKey } : {}),
	};
}

const WRITER_SYSTEM_PROMPT =
	"You are ICE's isolated writer worker. Read and modify only files through the provided tools. " +
	"Never run commands, use network or MCP, load extensions, delegate, access Git metadata, or modify the parent tree. " +
	"Stay inside the approved scope and make the requested edits only.";
const YOLO_WRITER_SYSTEM_PROMPT =
	"You are ICE's YOLO writer worker. Work directly in the trusted parent workspace and complete the requested task. " +
	"The workspace may already contain user changes. Use only the provided scoped tools; Bash is available only when explicitly authorized.";

export interface NativeWriterSessionOptions {
	request: NormalizedWriterRequest;
	parentActiveTools: readonly string[];
	directWorkspace?: boolean;
	unsafeHostExec?: boolean;
	model?: Model<Api>;
	modelRuntime?: ModelRuntime;
	agentDir?: string;
	sessionStartEvent?: SessionStartEvent;
}

export interface NativeWriterSession {
	session: CreateAgentSessionResult["session"];
	tools: WriterToolName[];
	prompt: string;
}

export async function createNativeWriterSession(
	options: NativeWriterSessionOptions,
	createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult> = createAgentSession,
): Promise<NativeWriterSession> {
	const directWorkspace = options.directWorkspace === true;
	const allowExternalTools = directWorkspace && options.unsafeHostExec === true && options.request.allowExternal;
	const tools = directWorkspace
		? deriveUnsafeSubagentTools(options.parentActiveTools)
		: deriveWriterTools(options.parentActiveTools);
	if (tools.length === 0) {
		throw new SubagentError(
			"capability_denied",
			directWorkspace
				? "YOLO writer requires at least one active scoped writer tool."
				: "Parent policy does not activate the complete writer capability.",
		);
	}
	if (!directWorkspace) await validateWriterLaunchPreflight(options.request.cwd, options.request.baseCommit);
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsManager = SettingsManager.create(options.request.cwd, agentDir, { projectTrusted: false });
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.request.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: directWorkspace ? YOLO_WRITER_SYSTEM_PROMPT : WRITER_SYSTEM_PROMPT,
		appendSystemPrompt: directWorkspace
			? [
					"YOLO DIRECT WORKSPACE: This child is not isolated. Changes are made immediately in the trusted parent workspace, including dirty files. No patch artifact, rollback, or cleanup is provided. Bash may access the host account, credentials, network, and processes when authorized. State this limitation if asked.",
				]
			: [],
	});
	await resourceLoader.reload();
	const prompt = [
		`Task: ${redactCredentialText(options.request.task)}`,
		"Approved writer scope:",
		...options.request.scope.roots.map((root) => `- ${root}`),
		"Return a concise completion note after the requested edits. Do not include a transcript.",
	].join("\n");
	const created = await createSession({
		cwd: options.request.cwd,
		agentDir,
		model: options.model,
		modelRuntime: options.modelRuntime,
		thinkingLevel: "low",
		tools,
		customTools: [
			...createScopedWriterToolDefinitions(options.request.cwd, options.request.scope.roots, allowExternalTools),
			...(directWorkspace && options.unsafeHostExec
				? [
						createBashToolDefinition(options.request.cwd, {
							exposeSessionEnvironment: false,
							spawnHook: (context) => ({
								...context,
								env: createDelegatedShellEnvironment(context.env),
							}),
						}) as unknown as ToolDefinition,
					]
				: []),
		],
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(options.request.cwd),
		sessionStartEvent: options.sessionStartEvent ?? { type: "session_start", reason: "startup" },
	});
	return { session: created.session, tools, prompt };
}

export interface NativeWriterRunnerOptions {
	createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	agentDir?: string;
	artifactRoot?: string;
	outputArtifactRoot?: string;
	outputArtifacts?: SubagentOutputArtifactStore;
}

export interface WriterProgressEvent {
	readonly runId: string;
	readonly phase: ObservatoryPhase;
	readonly status: SubagentStatus;
	readonly currentTool?: string;
	readonly currentPath?: string;
	readonly artifactReady?: boolean;
	readonly changedFileCount?: number;
	readonly artifactStatus?: string;
	readonly verifierStatus?: string;
	readonly rollbackStatus?: string;
	readonly diagnostics?: readonly string[];
}

export interface NativeWriterRunOptions {
	model?: Model<Api>;
	modelRuntime?: ModelRuntime;
	directWorkspace?: boolean;
	unsafeHostExec?: boolean;
	signal?: AbortSignal;
	onAdmitted?: (admission: { runId: string; baseCommit: string; workspaceIsolation: "worktree" | "parent" }) => void;
	onEvent?: (event: WriterProgressEvent) => void;
}
