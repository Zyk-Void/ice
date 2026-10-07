/**
 * Subagent V2 agent manager (Plan/subagent-rewrite.md section 15.6, P8.8).
 *
 * Lists every definition with its source, shadowing, and diagnostics, and creates
 * new native definition files from a template that passes the strict schema. It
 * never rewrites existing files and never writes managed, package, or compat sources.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedAgentDefinitions } from "../definitions/load.ts";
import { parseNativeAgentMarkdown } from "../definitions/parse.ts";
import { AGENT_NAME_PATTERN } from "../definitions/schema.ts";

export function formatAgentDefinitions(source: { definitions(): LoadedAgentDefinitions }): string {
	const definitions = source.definitions();
	const lines = [...definitions.active.values()].map(
		(definition) =>
			`${definition.name} [${definition.source}${definition.limited ? ", limited" : ""}${definition.fields.hidden ? ", hidden" : ""}]: ${definition.description}${definition.diagnostics.length ? ` (${definition.diagnostics.join("; ")})` : ""}`,
	);
	for (const entry of definitions.shadowed)
		lines.push(`${entry.definition.name} [${entry.definition.source}] shadowed by ${entry.shadowedBy.source}`);
	for (const definition of definitions.disabled) lines.push(`${definition.name} [disabled]`);
	for (const issue of definitions.issues)
		lines.push(
			`${issue.name ?? "(unnamed)"} [${issue.availability}] ${issue.sourcePath ?? ""}: ${issue.diagnostics.join("; ")}`,
		);
	return lines.join("\n");
}

export function agentDefinitionTemplate(name: string): string {
	return `---
name: ${name}
description: Describe when the parent should use this agent.
tools: [read, grep, find, ls]
model: inherit
thinking: medium
---
You are the ${name} subagent. Describe the role, the steps to follow, what to avoid, and what the final report must contain.
`;
}

/** Create `<directory>/<name>.md` from the template. Refuses invalid names, existing files, and untrusted projects. */
export function createAgentDefinitionFile(input: { name: string; directory: string; projectTrusted: boolean }): string {
	if (!new RegExp(AGENT_NAME_PATTERN).test(input.name))
		throw new Error(`Agent names use lowercase letters, digits, and hyphens (got "${input.name}").`);
	if (!input.projectTrusted) throw new Error("Project agent definitions require project trust; run /trust first.");
	const path = join(input.directory, `${input.name}.md`);
	if (existsSync(path)) throw new Error(`${path} already exists; edit it instead.`);
	const content = agentDefinitionTemplate(input.name);
	if (parseNativeAgentMarkdown(content, "user", path).kind !== "agent")
		throw new Error("Internal error: the agent template does not validate.");
	mkdirSync(input.directory, { recursive: true });
	writeFileSync(path, content, { flag: "wx" });
	return path;
}
