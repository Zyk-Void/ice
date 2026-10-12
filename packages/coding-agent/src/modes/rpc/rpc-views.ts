/**
 * Read-only projections of session state for RPC responses. Each helper returns a bounded,
 * JSON-safe shape: shell output, resource contents, and full-text session search are left out.
 */

import type { ThinkingLevel } from "@zykairotis/ice-agent-core";
import type { Model } from "@zykairotis/ice-ai";
import { getChangelogPath } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type { SessionInfo } from "../../core/session-manager.ts";
import type { BackgroundShellSnapshot, BashBackgroundRegistry } from "../../core/tools/bash-background.ts";
import { parseChangelog } from "../../utils/changelog.ts";
import { RpcCommandExecutionError } from "./rpc-command-schema.ts";
import type {
	RpcChangelogEntry,
	RpcDiagnostics,
	RpcProviderSnapshot,
	RpcResources,
	RpcScopedModelRef,
	RpcSessionInfo,
	RpcShellDetail,
	RpcShellSummary,
	RpcToolInfo,
} from "./rpc-types.ts";

export function toPublicModel(model: Model<string>): Model<string> {
	const { headers: _headers, ...publicModel } = model;
	return publicModel;
}

export function toShellSummary(snapshot: BackgroundShellSnapshot): RpcShellSummary {
	const { output: _output, finalText: _finalText, ...summary } = snapshot;
	return summary;
}

export function listShellSummaries(registry: BashBackgroundRegistry): RpcShellSummary[] {
	return registry.snapshots().map(toShellSummary);
}

/**
 * One shell with its retained output from `sinceChars` on. Reads the registry without consuming
 * the model's `bash_output` cursor, so a client can follow a shell without hiding output from the model.
 */
export function readShellDetail(
	registry: BashBackgroundRegistry,
	shellId: string,
	sinceChars: number | undefined,
): RpcShellDetail | null {
	const snapshot = registry.get(shellId);
	if (!snapshot) return null;
	const retainedFrom = snapshot.totalChars - snapshot.output.length;
	const start = Math.min(snapshot.output.length, Math.max(0, (sinceChars ?? 0) - retainedFrom));
	return {
		shell: {
			...toShellSummary(snapshot),
			...(snapshot.finalText !== undefined ? { finalText: snapshot.finalText } : {}),
		},
		output: snapshot.output.slice(start),
		outputOffset: retainedFrom + start,
	};
}

export function listTools(session: AgentSession): RpcToolInfo[] {
	const active = new Set(session.getActiveToolNames());
	return session.getAllTools().map((tool) => ({ ...tool, active: active.has(tool.name) }));
}

export function getDiagnostics(session: AgentSession): RpcDiagnostics {
	const resources = getResources(session);
	const diagnostics: RpcDiagnostics["diagnostics"] = [
		...(session.modelRuntime.getError()
			? [
					{
						source: "catalog",
						severity: "error" as const,
						code: "catalog_error",
						message: "Local catalog/configuration/availability failed; raw provider details omitted.",
					},
				]
			: []),
		...session.settingsManager.getLoadErrors().map(({ scope }) => ({
			source: "settings",
			severity: "error" as const,
			code: "settings_load_error",
			message: `${scope} settings could not be loaded; raw error omitted.`,
		})),
		...resources.extensionErrors.map(({ path }) => ({
			source: "extension",
			severity: "error" as const,
			code: "extension_load_error",
			path,
			message: "Extension could not be loaded; raw error omitted.",
		})),
		...resources.diagnostics.map(({ type, path }) => ({
			source: "resource",
			severity: type === "error" ? ("error" as const) : ("warning" as const),
			code: type === "collision" ? "resource_collision" : "resource_load_diagnostic",
			path,
			message:
				type === "collision"
					? "Resource identity collision; inspect local resource diagnostics."
					: "Resource could not be loaded cleanly; raw details omitted.",
		})),
	];
	return {
		diagnostics: diagnostics.slice(0, 100).map((item) => ({ ...item, path: item.path?.slice(0, 1024) })),
		truncated: diagnostics.length > 100,
	};
}

export function getResources(session: AgentSession): RpcResources {
	const loader = session.resourceLoader;
	const extensions = loader.getExtensions();
	return {
		contextFiles: loader.getAgentsFiles().agentsFiles.map((file) => file.path),
		systemPromptPath: loader.getSystemPromptSource()?.path,
		appendSystemPromptPaths: loader.getAppendSystemPromptSources().map((source) => source.path),
		skills: loader.getSkills().skills.map(({ name, description, filePath, sourceInfo }) => ({
			name,
			description,
			filePath,
			sourceInfo,
		})),
		prompts: loader
			.getPrompts()
			.prompts.map(({ name, description, sourceInfo }) => ({ name, description, sourceInfo })),
		themes: loader.getThemes().themes.map(({ name, sourcePath }) => ({ name, sourcePath })),
		extensions: extensions.extensions.map(({ path, sourceInfo }) => ({ path, sourceInfo })),
		extensionErrors: extensions.errors,
		diagnostics: [
			...loader.getSkills().diagnostics,
			...loader.getPrompts().diagnostics,
			...loader.getThemes().diagnostics,
		],
	};
}

/** Auth/catalog snapshot only: do not resolve keys, execute auth commands, or refresh OAuth. */
export function getProviderSnapshot(session: AgentSession): RpcProviderSnapshot {
	const runtime = session.modelRuntime;
	const all = runtime.getModels();
	const available = runtime.getAvailableSnapshot();
	return {
		providers: runtime.getProviders().map((provider) => {
			const status = runtime.getProviderAuthStatus(provider.id);
			return {
				id: provider.id,
				name: provider.name,
				authTypes: [
					provider.auth.apiKey ? ("api_key" as const) : undefined,
					provider.auth.oauth ? ("oauth" as const) : undefined,
				].filter((value): value is "api_key" | "oauth" => value !== undefined),
				auth: {
					configured: status.configured,
					source: status.source,
					type: status.configured
						? runtime.isUsingOAuth(provider.id)
							? ("oauth" as const)
							: ("api_key" as const)
						: undefined,
				},
				modelCount: all.filter((model) => model.provider === provider.id).length,
				availableModelCount: available.filter((model) => model.provider === provider.id).length,
				dynamicCatalog: provider.refreshModels !== undefined,
			};
		}),
		hasCatalogError: runtime.getError() !== undefined,
	};
}

export function toSessionInfo(info: SessionInfo): RpcSessionInfo {
	return {
		path: info.path,
		id: info.id,
		cwd: info.cwd,
		name: info.name,
		parentSessionPath: info.parentSessionPath,
		created: info.created.toISOString(),
		modified: info.modified.toISOString(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
	};
}

/** Newest changelog entry first, matching `/changelog`. */
export function readChangelog(): RpcChangelogEntry[] {
	return parseChangelog(getChangelogPath())
		.map((entry) => ({ version: `${entry.major}.${entry.minor}.${entry.patch}`, content: entry.content }))
		.reverse();
}

export function getScopedModelRefs(session: AgentSession): RpcScopedModelRef[] {
	return session.scopedModels.map(({ model, thinkingLevel }) => ({
		provider: model.provider,
		modelId: model.id,
		...(thinkingLevel ? { thinkingLevel } : {}),
	}));
}

/** Resolve references against the available models; an unknown model rejects the whole update. */
export function resolveScopedModels(
	session: AgentSession,
	refs: RpcScopedModelRef[],
): Array<{
	model: ReturnType<AgentSession["modelRuntime"]["getAvailableSnapshot"]>[number];
	thinkingLevel?: ThinkingLevel;
}> {
	const available = session.modelRuntime.getAvailableSnapshot();
	return refs.map((ref) => {
		const model = available.find((candidate) => candidate.provider === ref.provider && candidate.id === ref.modelId);
		if (!model) throw new RpcCommandExecutionError("not_found", `Model not found: ${ref.provider}/${ref.modelId}`);
		return ref.thinkingLevel ? { model, thinkingLevel: ref.thinkingLevel } : { model };
	});
}
