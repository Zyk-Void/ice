/**
 * Headless `ice agents` CLI (Plan/subagent-rewrite.md P9.3).
 *
 *   ice agents list [--json]          every definition with source, shadowing, and diagnostics
 *   ice agents validate [path...]     validate files, or every discovered definition; exit 1 on invalid
 *   ice agents prune [--apply] [--json]   list (or remove) subagent data whose parent session was deleted
 *
 * list and validate are read-only: they never write definition files or settings. prune deletes only with --apply.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SettingsManager } from "../../core/settings-manager.ts";
import { getSubagentGlobalAgentsDir } from "../definitions/legacy-profiles.ts";
import { type LoadedAgentDefinitions, loadAgentDefinitions } from "../definitions/load.ts";
import { parseNativeAgentMarkdown } from "../definitions/parse.ts";
import { formatAgentDefinitions } from "./agent-manager.ts";
import { formatPruneResult, pruneOrphanedSubagents } from "./prune.ts";
import { resolveSubagentsV2Settings, type SubagentsV2Settings } from "./settings.ts";

export interface AgentsCliResult {
	exitCode: number;
	stdout: string;
}

function resolveCliSettings(cwd: string, agentDir: string): { settings: SubagentsV2Settings; projectTrusted: boolean } {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const projectTrusted = settingsManager.isProjectTrusted();
	const settings = resolveSubagentsV2Settings({
		global: settingsManager.getGlobalSettings().ice?.subagents,
		project: settingsManager.getProjectSettings().ice?.subagents,
		projectTrusted,
	});
	return { settings, projectTrusted };
}

export function loadAgentsForCli(cwd: string, agentDir: string): LoadedAgentDefinitions {
	const { settings, projectTrusted } = resolveCliSettings(cwd, agentDir);
	return loadAgentDefinitions({
		cwd,
		userAgentsDir: getSubagentGlobalAgentsDir(agentDir),
		projectTrusted,
		settingsAgents: settings.agents,
		disabledAgents: settings.disabledAgents,
		compat: settings.compat,
	});
}

export function runAgentsCli(
	args: readonly string[],
	options: {
		cwd: string;
		agentDir: string;
		load?: () => LoadedAgentDefinitions;
		settings?: () => SubagentsV2Settings;
		/** Root holding one directory per session directory; default `<agentDir>/sessions`. */
		sessionsRoot?: string;
	},
): AgentsCliResult {
	const [command, ...rest] = args;
	const load = options.load ?? (() => loadAgentsForCli(options.cwd, options.agentDir));
	const settings = options.settings ?? (() => resolveCliSettings(options.cwd, options.agentDir).settings);
	if (command === "list") {
		const definitions = load();
		if (!rest.includes("--json"))
			return { exitCode: 0, stdout: `${formatAgentDefinitions({ definitions: () => definitions })}\n` };
		const summary = {
			active: [...definitions.active.values()].map((definition) => ({
				name: definition.name,
				source: definition.source,
				...(definition.sourcePath ? { sourcePath: definition.sourcePath } : {}),
				description: definition.description,
				limited: definition.limited,
				diagnostics: definition.diagnostics,
			})),
			shadowed: definitions.shadowed.map((entry) => ({
				name: entry.definition.name,
				source: entry.definition.source,
				shadowedBy: entry.shadowedBy.source,
			})),
			disabled: definitions.disabled.map((definition) => definition.name),
			issues: definitions.issues,
		};
		return { exitCode: 0, stdout: `${JSON.stringify(summary, null, 2)}\n` };
	}
	if (command === "validate") {
		const paths = rest.filter((arg) => !arg.startsWith("-"));
		if (paths.length === 0) {
			const { diagnostics, deprecations } = settings();
			const invalid = load().issues.filter((issue) => issue.availability === "invalid");
			const lines = [
				...diagnostics.map((message) => `settings: invalid: ${message}`),
				...invalid.map(
					(issue) => `${issue.sourcePath ?? issue.name ?? "(unknown)"}: ${issue.diagnostics.join("; ")}`,
				),
				...deprecations.map(({ message }) => `settings: warning: ${message}`),
			];
			const failed = diagnostics.length > 0 || invalid.length > 0;
			if (!failed) lines.push("All agent definitions and subagent settings are valid.");
			return { exitCode: failed ? 1 : 0, stdout: `${lines.join("\n")}\n` };
		}
		let failed = false;
		const lines = paths.map((path) => {
			const absolute = resolve(options.cwd, path);
			let content: string;
			try {
				content = readFileSync(absolute, "utf8");
			} catch (error) {
				failed = true;
				return `${path}: unreadable (${error instanceof Error ? error.message : String(error)})`;
			}
			const parsed = parseNativeAgentMarkdown(content, "user", absolute);
			if (parsed.kind === "agent") return `${path}: valid (${parsed.definition.name})`;
			if (parsed.kind === "not-agent") return `${path}: not an agent definition (no frontmatter name)`;
			failed = true;
			return `${path}: invalid: ${parsed.issue.diagnostics.join("; ")}`;
		});
		return { exitCode: failed ? 1 : 0, stdout: `${lines.join("\n")}\n` };
	}
	if (command === "prune") {
		const result = pruneOrphanedSubagents({
			sessionsRoot: options.sessionsRoot ?? join(options.agentDir, "sessions"),
			apply: rest.includes("--apply"),
		});
		const failed =
			result.applied &&
			result.folders.some((folder) => folder.reasons.some((reason) => reason.startsWith("removal failed")));
		return {
			exitCode: failed ? 1 : 0,
			stdout: `${rest.includes("--json") ? JSON.stringify(result, null, 2) : formatPruneResult(result)}\n`,
		};
	}
	return {
		exitCode: 2,
		stdout: "Usage: ice agents list [--json] | ice agents validate [path...] | ice agents prune [--apply] [--json]\n",
	};
}
