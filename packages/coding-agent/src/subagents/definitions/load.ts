/**
 * Subagent V2 definition loading (Plan/subagent-rewrite.md sections 7.1-7.6, P2.2-P2.8).
 *
 * Collects every source, applies project trust, and resolves precedence. Untrusted
 * project definitions are reported by name only and never become active or reach
 * a prompt. Results are cached by the caller-supplied key, which must include cwd,
 * trust, and the settings epoch; new launches reload, existing children keep their
 * frozen contract.
 */
import { join } from "node:path";
import { getBuiltinAgentDefinitions } from "./builtin.ts";
import { findProjectAgentDirectories, listAgentMarkdownFiles } from "./discover.ts";
import {
	type AgentDefinitionIssue,
	type ParsedAgentSource,
	parseClaudeCompatAgentMarkdown,
	parseJsonAgentDefinitions,
	parseNativeAgentMarkdown,
} from "./parse.ts";
import { type AgentDefinitionSet, resolveAgentDefinitionSet } from "./precedence.ts";
import type { AgentDefinitionSource, ResolvedAgentDefinition } from "./schema.ts";

export interface AgentDefinitionLoadOptions {
	cwd: string;
	/** `~/.ice/agents` (or `<agentDir>/agents` for a custom agent dir). */
	userAgentsDir: string;
	projectTrusted: boolean;
	projectRoot?: string;
	/** Explicit managed root; absent means no managed source (section 7.2). */
	managedAgentsDir?: string;
	packageAgentDirs?: readonly string[];
	settingsAgents?: { user?: unknown; project?: unknown };
	flagAgents?: unknown;
	disabledAgents?: readonly string[];
	compat?: { claudeAgents?: boolean; modelAliases?: Readonly<Record<string, string>> };
	home?: string;
}

export interface LoadedAgentDefinitions extends AgentDefinitionSet {
	/** Directories that were searched, for reload watchers and diagnostics. */
	searchedDirectories: readonly string[];
}

export function loadAgentDefinitions(options: AgentDefinitionLoadOptions): LoadedAgentDefinitions {
	const definitions: ResolvedAgentDefinition[] = [...getBuiltinAgentDefinitions()];
	const issues: AgentDefinitionIssue[] = [];
	const seen = new Set<string>();
	const searched: string[] = [];

	const collect = (
		roots: readonly string[],
		source: AgentDefinitionSource,
		parse: (content: string, path: string) => ParsedAgentSource,
		trusted: boolean,
	): void => {
		searched.push(...roots);
		const discovery = listAgentMarkdownFiles(roots, seen);
		for (const diagnostic of discovery.diagnostics)
			issues.push({
				source,
				sourcePath: diagnostic.path,
				availability: "invalid",
				diagnostics: [diagnostic.message],
			});
		for (const file of discovery.files) {
			const parsed = parse(file.content, file.path);
			if (parsed.kind === "not-agent") continue;
			if (!trusted) {
				const name = parsed.kind === "agent" ? parsed.definition.name : parsed.issue.name;
				issues.push({
					...(name ? { name } : {}),
					source,
					sourcePath: file.path,
					availability: "untrusted",
					diagnostics: ["project agent definitions require project trust"],
				});
				continue;
			}
			if (parsed.kind === "invalid") issues.push(parsed.issue);
			else definitions.push(parsed.definition);
		}
	};
	const native = (source: AgentDefinitionSource) => (content: string, path: string) =>
		parseNativeAgentMarkdown(content, source, path);
	const json = (input: unknown, source: AgentDefinitionSource, label: string, trusted: boolean) => {
		const parsed = parseJsonAgentDefinitions(input, source, label);
		if (!trusted) {
			for (const definition of parsed.definitions)
				issues.push({
					name: definition.name,
					source,
					sourcePath: definition.sourcePath,
					availability: "untrusted",
					diagnostics: ["project agent definitions require project trust"],
				});
			return;
		}
		definitions.push(...parsed.definitions);
		issues.push(...parsed.issues);
	};

	// Managed files first so their inodes win dedupe against symlinked copies.
	if (options.managedAgentsDir) collect([options.managedAgentsDir], "managed", native("managed"), true);
	const projectDirs = findProjectAgentDirectories({
		cwd: options.cwd,
		...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
		...(options.home ? { home: options.home } : {}),
	});
	collect(projectDirs, "project", native("project"), options.projectTrusted);
	if (options.compat?.claudeAgents) {
		const compatDirs = findProjectAgentDirectories({
			cwd: options.cwd,
			subdir: join(".claude", "agents"),
			...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
			...(options.home ? { home: options.home } : {}),
		});
		const aliases = options.compat.modelAliases ?? {};
		collect(
			compatDirs,
			"project-compat",
			(content, path) => parseClaudeCompatAgentMarkdown(content, path, aliases),
			options.projectTrusted,
		);
	}
	collect([options.userAgentsDir], "user", native("user"), true);
	collect(options.packageAgentDirs ?? [], "package", native("package"), true);

	json(options.settingsAgents?.user, "user-settings", "ice.subagents.agents (user)", true);
	json(options.settingsAgents?.project, "project-settings", "ice.subagents.agents (project)", options.projectTrusted);
	json(options.flagAgents, "flag", "--agents", true);

	const set = resolveAgentDefinitionSet({
		definitions,
		issues,
		...(options.disabledAgents ? { disabledAgents: options.disabledAgents } : {}),
	});
	return Object.freeze({ ...set, searchedDirectories: Object.freeze(searched) });
}

/** Single-entry memo; callers invalidate on watcher change, settings/trust change, or /reload. */
export class AgentDefinitionCache {
	private key: string | undefined;
	private value: LoadedAgentDefinitions | undefined;

	get(key: string, load: () => LoadedAgentDefinitions): LoadedAgentDefinitions {
		if (this.key !== key || !this.value) {
			this.value = load();
			this.key = key;
		}
		return this.value;
	}

	invalidate(): void {
		this.key = undefined;
		this.value = undefined;
	}
}
