/**
 * Headless `ice agents` CLI (Plan/subagent-rewrite.md P9.3).
 *
 *   ice agents list [--json]          every definition with source, shadowing, and diagnostics
 *   ice agents validate [path...]     validate files, or every discovered definition; exit 1 on invalid
 *
 * Read-only: it never writes definition files or settings.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SettingsManager } from "../../core/settings-manager.ts";
import { getSubagentGlobalAgentsDir } from "../definitions/legacy-profiles.ts";
import { type LoadedAgentDefinitions, loadAgentDefinitions } from "../definitions/load.ts";
import { parseNativeAgentMarkdown } from "../definitions/parse.ts";
import { formatAgentDefinitions } from "./agent-manager.ts";
import { resolveSubagentsV2Settings } from "./settings.ts";

export interface AgentsCliResult {
	exitCode: number;
	stdout: string;
}

export function loadAgentsForCli(cwd: string, agentDir: string): LoadedAgentDefinitions {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const projectTrusted = settingsManager.isProjectTrusted();
	const read = (settings: unknown) => (settings as { ice?: { subagents?: unknown } } | undefined)?.ice?.subagents;
	const settings = resolveSubagentsV2Settings({
		global: read(settingsManager.getGlobalSettings()),
		project: read(settingsManager.getProjectSettings()),
		projectTrusted,
	});
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
	options: { cwd: string; agentDir: string; load?: () => LoadedAgentDefinitions },
): AgentsCliResult {
	const [command, ...rest] = args;
	const load = options.load ?? (() => loadAgentsForCli(options.cwd, options.agentDir));
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
			const invalid = load().issues.filter((issue) => issue.availability === "invalid");
			const lines = invalid.map(
				(issue) => `${issue.sourcePath ?? issue.name ?? "(unknown)"}: ${issue.diagnostics.join("; ")}`,
			);
			return {
				exitCode: invalid.length > 0 ? 1 : 0,
				stdout: `${invalid.length > 0 ? lines.join("\n") : "All agent definitions are valid."}\n`,
			};
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
	return {
		exitCode: 2,
		stdout: "Usage: ice agents list [--json] | ice agents validate [path...]\n",
	};
}
