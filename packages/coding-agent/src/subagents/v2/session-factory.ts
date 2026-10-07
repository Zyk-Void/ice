/**
 * Subagent V2 child session factory (Plan/subagent-rewrite.md section 13.1, P4.5/P6.1).
 *
 * One factory for every child. It builds an ordinary AgentSession from the
 * frozen ChildRuntimeContract only: the system prompt, model, thinking level,
 * and exactly the frozen tools. No child extensions, packages, skills, or
 * ambient credentials are loaded. Every tool goes through the permission guard
 * before it executes, so enforcement never depends on child extensions. There
 * is no sub-yolo or writer branch: those are permission decisions.
 */

import { dirname } from "node:path";
import type { ThinkingLevel } from "@zykairotis/ice-agent-core";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import type { ToolDefinition } from "../../core/extensions/index.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "../../core/sdk.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { createBashToolDefinition } from "../../core/tools/index.ts";
import { redactCredentialText } from "../../utils/redact.ts";
import type { ChildRuntimeContract } from "../contract/child-runtime-contract.ts";
import { loadSelectedPromptContent } from "../runtime/prompt.ts";
import { readValidatedResource, revalidateSubagentResources } from "../runtime/resources.ts";
import { createIceDelegableToolDefinitions, type IceResolvedDelegableTool } from "../tools/adapters.ts";
import { createScopedWriterToolDefinitions } from "../tools/scoped-tools.ts";
import { createDelegatedShellEnvironment } from "../types.ts";

/** Throws to refuse a call; resolves to let it run. */
export type ChildToolGuard = (
	toolName: string,
	args: Readonly<Record<string, unknown>>,
	signal?: AbortSignal,
) => Promise<void>;

export type ChildToolObserver = (
	toolName: string,
	args: Readonly<Record<string, unknown>>,
) => ((success: boolean) => void) | undefined;

export interface V2ChildSessionOptions {
	contract: ChildRuntimeContract;
	sessionManager: SessionManager;
	cwd: string;
	agentDir: string;
	model: Model<Api>;
	modelRuntime?: ModelRuntime;
	/** Parent-owned child-safe adapters; only frozen names are bound. */
	adapters: readonly IceResolvedDelegableTool[];
	guard: ChildToolGuard;
	/** Host-only observation starts after permission approval, at actual dispatch. */
	observeTool?: ChildToolObserver;
}

function guarded(definition: ToolDefinition, guard: ChildToolGuard, observeTool?: ChildToolObserver): ToolDefinition {
	const execute = definition.execute;
	return {
		...definition,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const args = (params ?? {}) as Readonly<Record<string, unknown>>;
			await guard(definition.name, args, signal);
			const observed = observeTool?.(definition.name, args);
			try {
				const result = await execute(toolCallId, params, signal, onUpdate, ctx);
				observed?.(!signal?.aborted);
				return result;
			} catch (error) {
				observed?.(false);
				throw error;
			}
		},
	} as ToolDefinition;
}

export function buildV2ChildToolDefinitions(
	options: Omit<V2ChildSessionOptions, "sessionManager" | "model" | "agentDir">,
): ToolDefinition[] {
	const { contract, cwd } = options;
	const frozen = new Set(contract.capabilities.tools.map((tool) => tool.name));
	const definitions: ToolDefinition[] = [];
	// Selected skill files are readable even outside the task scope; scope still bounds everything else.
	const skillRoots = (contract.prompt.resources?.skills ?? []).map((resource) => dirname(resource.canonicalPath));
	const scoped = createScopedWriterToolDefinitions(cwd, contract.capabilities.scopeRoots, false, skillRoots, frozen);
	for (const definition of scoped) if (frozen.has(definition.name)) definitions.push(definition);
	if (frozen.has("bash")) {
		definitions.push(
			createBashToolDefinition(cwd, {
				exposeSessionEnvironment: false,
				spawnHook: (context) => ({ ...context, env: createDelegatedShellEnvironment(context.env) }),
			}) as unknown as ToolDefinition,
		);
	}
	const adapters = options.adapters.filter((adapter) => frozen.has(adapter.name));
	definitions.push(
		...createIceDelegableToolDefinitions(adapters, {
			parentSessionId: contract.ownerSessionId,
			runId: contract.id,
			cwd,
			scopeRoots: contract.capabilities.scopeRoots,
		}),
	);
	const missing = [...frozen].filter((name) => !definitions.some((definition) => definition.name === name));
	if (missing.length > 0) throw new Error(`No child implementation for frozen tools: ${missing.join(", ")}`);
	return definitions.map((definition) => guarded(definition, options.guard, options.observeTool));
}

export async function createV2ChildSession(
	options: V2ChildSessionOptions,
	createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult> = createAgentSession,
): Promise<CreateAgentSessionResult["session"]> {
	const { contract } = options;
	const resources = contract.prompt.resources;
	// Fail closed if a selected skill, prompt, or context file changed since acceptance.
	if (resources) revalidateSubagentResources(resources);
	const selectedContext = (resources?.context ?? []).map((resource) => ({
		path: resource.sourcePath,
		content: redactCredentialText(readValidatedResource(resource).toString("utf8")),
	}));
	const selectedPrompts = (resources?.prompts ?? []).map(loadSelectedPromptContent);
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		noPackages: true,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: !contract.prompt.contextFiles,
		...(resources?.skills.length
			? { additionalSkillPaths: resources.skills.map((resource) => resource.sourcePath) }
			: {}),
		...(selectedContext.length > 0
			? { agentsFilesOverride: (base) => ({ agentsFiles: [...base.agentsFiles, ...selectedContext] }) }
			: {}),
		systemPrompt: contract.prompt.system,
		...(selectedPrompts.length > 0
			? {
					appendSystemPrompt: selectedPrompts.map(
						(prompt) => `Selected prompt "${prompt.name}" (from the agent definition):\n${prompt.content}`,
					),
				}
			: {}),
	});
	await resourceLoader.reload();
	const customTools = buildV2ChildToolDefinitions(options);
	const created = await createSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		model: options.model,
		...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
		thinkingLevel: contract.model.thinking as ThinkingLevel,
		tools: customTools.map((definition) => definition.name),
		customTools,
		resourceLoader,
		settingsManager,
		sessionManager: options.sessionManager,
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
	return created.session;
}
