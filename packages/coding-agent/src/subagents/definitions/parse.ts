/**
 * Subagent V2 definition parsing (Plan/subagent-rewrite.md sections 7.3-7.4, P2.1/P2.3/P2.8).
 *
 * Markdown without a frontmatter `name` is documentation, not an agent. A named
 * file that fails validation is reported, never activated. Native `.ice` files
 * are strict; `.claude/agents` compat files map known Claude fields and warn on
 * the rest.
 */
import { createHash } from "node:crypto";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { redactCredentialText } from "../../utils/redact.ts";
import {
	AGENT_NAME_PATTERN,
	AGENT_THINKING_LEVELS,
	type AgentDefinitionSource,
	CLAUDE_COMPAT_AGENT_KEYS,
	JsonAgentDefinitionSchema,
	NativeAgentFrontmatterSchema,
	type ResolvedAgentDefinition,
} from "./schema.ts";

export interface AgentDefinitionIssue {
	/** Present when the file or entry declared a usable name. */
	name?: string;
	source: AgentDefinitionSource;
	sourcePath?: string;
	availability: "invalid" | "untrusted";
	diagnostics: readonly string[];
}

export type ParsedAgentSource =
	| { kind: "not-agent" }
	| { kind: "invalid"; issue: AgentDefinitionIssue }
	| { kind: "agent"; definition: ResolvedAgentDefinition };

/** Legacy profile keys and their V2 replacement, reported instead of a bare unknown-key error. */
export const LEGACY_AGENT_KEY_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
	fallbackModel: "model: [primary, fallback, inherit]",
	fallback_model: "model: [primary, fallback, inherit]",
	thinkingLevel: "thinking",
	top_p: "topP",
	"top-p": "topP",
	mcpTools: "mcp",
	mcp_tools: "mcp",
	adapters: "tools (adapter tools are selected by name)",
	startupTimeoutMs: "ice.subagents.defaults.startupTimeoutMs",
	"startup-timeout-ms": "ice.subagents.defaults.startupTimeoutMs",
	iceUnsafeHostExec: "--sub-yolo or a user-scope ice.subagents.permissions allow rule",
	"ice-unsafe-host-exec": "--sub-yolo or a user-scope ice.subagents.permissions allow rule",
});

export const AGENT_FILE_MAX_BYTES = 128 * 1024;

export function hashAgentSource(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function schemaDiagnostics(schema: TSchema, value: unknown): string[] {
	const out: string[] = [];
	for (const error of Value.Errors(schema, value)) {
		const unknownKey = error.keyword === "additionalProperties" ? unknownKeysOf(error) : [];
		if (unknownKey.length > 0) {
			for (const key of unknownKey) {
				const replacement = LEGACY_AGENT_KEY_REPLACEMENTS[key];
				out.push(replacement ? `"${key}" was removed; use ${replacement}` : `unknown key "${key}"`);
			}
			continue;
		}
		out.push(`${error.instancePath || "/"}: ${error.message}`);
		if (out.length >= 16) break;
	}
	return [...new Set(out)];
}

function unknownKeysOf(error: { params?: unknown }): string[] {
	const params = error.params as { additionalProperties?: unknown } | undefined;
	const keys = params?.additionalProperties;
	return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
}

/** `tools` accepts a list or a Claude-style comma string; normalize to a list. */
function normalizeToolList(value: unknown): unknown {
	if (typeof value !== "string") return value;
	return value
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
}

function definitionFrom(
	name: string,
	description: string,
	prompt: string,
	fields: Record<string, unknown>,
	source: AgentDefinitionSource,
	sourceHash: string,
	sourcePath: string | undefined,
	diagnostics: string[],
	limited: boolean,
): ResolvedAgentDefinition {
	const { name: _name, description: _description, prompt: _prompt, ...rest } = fields;
	if (rest.tools !== undefined) rest.tools = normalizeToolList(rest.tools);
	return Object.freeze({
		name,
		description,
		prompt: redactCredentialText(prompt),
		fields: Object.freeze(rest) as ResolvedAgentDefinition["fields"],
		source,
		...(sourcePath ? { sourcePath } : {}),
		sourceHash,
		diagnostics: Object.freeze(diagnostics),
		limited,
	});
}

/** Parse one native `.ice/agents` Markdown file. */
export function parseNativeAgentMarkdown(
	content: string,
	source: AgentDefinitionSource,
	sourcePath: string,
): ParsedAgentSource {
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch (error) {
		return {
			kind: "invalid",
			issue: {
				source,
				sourcePath,
				availability: "invalid",
				diagnostics: [`frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`],
			},
		};
	}
	const { frontmatter, body } = parsed;
	if (frontmatter === null || typeof frontmatter !== "object" || frontmatter.name === undefined) {
		return { kind: "not-agent" };
	}
	const name = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const diagnostics = schemaDiagnostics(NativeAgentFrontmatterSchema, frontmatter);
	if (!body.trim()) diagnostics.push("body (system prompt) is empty");
	if (diagnostics.length > 0) {
		return {
			kind: "invalid",
			issue: {
				...(name && new RegExp(AGENT_NAME_PATTERN).test(name) ? { name } : {}),
				source,
				sourcePath,
				availability: "invalid",
				diagnostics,
			},
		};
	}
	return {
		kind: "agent",
		definition: definitionFrom(
			name!,
			frontmatter.description as string,
			body.trim(),
			frontmatter,
			source,
			hashAgentSource(content),
			sourcePath,
			[],
			false,
		),
	};
}

/** Parse a JSON definition map (`ice.subagents.agents`, `--agents`, SDK). Keys are names. */
export function parseJsonAgentDefinitions(
	input: unknown,
	source: AgentDefinitionSource,
	sourceLabel: string,
): { definitions: ResolvedAgentDefinition[]; issues: AgentDefinitionIssue[] } {
	const definitions: ResolvedAgentDefinition[] = [];
	const issues: AgentDefinitionIssue[] = [];
	if (input === undefined) return { definitions, issues };
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		issues.push({
			source,
			sourcePath: sourceLabel,
			availability: "invalid",
			diagnostics: ["expected an object map"],
		});
		return { definitions, issues };
	}
	for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
		const path = `${sourceLabel}.${name}`;
		const diagnostics = new RegExp(AGENT_NAME_PATTERN).test(name) ? [] : [`invalid agent name "${name}"`];
		diagnostics.push(...schemaDiagnostics(JsonAgentDefinitionSchema, value));
		if (diagnostics.length > 0) {
			issues.push({
				...(new RegExp(AGENT_NAME_PATTERN).test(name) ? { name } : {}),
				source,
				sourcePath: path,
				availability: "invalid",
				diagnostics,
			});
			continue;
		}
		const fields = value as Record<string, unknown>;
		definitions.push(
			definitionFrom(
				name,
				fields.description as string,
				fields.prompt as string,
				fields,
				source,
				hashAgentSource(canonicalJson(fields)),
				path,
				[],
				false,
			),
		);
	}
	return { definitions, issues };
}

/** Deterministic JSON: sorted keys, `undefined` properties omitted (matching JSON.stringify round-trips). */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>)
			.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
	Read: "read",
	Grep: "grep",
	Glob: "find",
	LS: "ls",
	Bash: "bash",
	Edit: "edit",
	MultiEdit: "edit",
	Write: "write",
});

const CLAUDE_COLORS: Readonly<Record<string, string>> = Object.freeze({
	red: "error",
	green: "success",
	yellow: "warning",
	orange: "warning",
	blue: "accent",
	purple: "accent",
	pink: "accent",
	cyan: "accent",
});

/**
 * Parse one `.claude/agents` compat file. Known Claude fields map onto the native
 * schema; unsupported or authority-raising values are dropped with a warning.
 */
export function parseClaudeCompatAgentMarkdown(
	content: string,
	sourcePath: string,
	modelAliases: Readonly<Record<string, string>>,
): ParsedAgentSource {
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch (error) {
		return {
			kind: "invalid",
			issue: {
				source: "project-compat",
				sourcePath,
				availability: "invalid",
				diagnostics: [`frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`],
			},
		};
	}
	const raw = parsed.frontmatter;
	if (raw === null || typeof raw !== "object" || raw.name === undefined) return { kind: "not-agent" };
	const warnings: string[] = [];
	let limited = false;
	const mapped: Record<string, unknown> = { name: raw.name, description: raw.description };
	for (const key of Object.keys(raw)) {
		if (!(CLAUDE_COMPAT_AGENT_KEYS as readonly string[]).includes(key))
			warnings.push(`unsupported compat key "${key}" ignored`);
	}
	const mapTools = (value: unknown): unknown => {
		const list = normalizeToolList(value);
		if (!Array.isArray(list)) return list;
		return list.map((tool) => (typeof tool === "string" ? (CLAUDE_TOOL_NAMES[tool] ?? tool) : tool));
	};
	if (raw.tools !== undefined) mapped.tools = mapTools(raw.tools);
	if (raw.disallowedTools !== undefined) mapped.disallowedTools = mapTools(raw.disallowedTools);
	if (typeof raw.model === "string") {
		const model = raw.model.trim();
		if (model.toLowerCase() === "inherit") mapped.model = "inherit";
		else if (modelAliases[model]) mapped.model = modelAliases[model];
		else if (model.includes("/")) mapped.model = model;
		else {
			limited = true;
			warnings.push(`model alias "${model}" has no ice.subagents.compat.modelAliases mapping`);
		}
	}
	if (raw.effort !== undefined) {
		if (typeof raw.effort === "string" && (AGENT_THINKING_LEVELS as readonly string[]).includes(raw.effort))
			mapped.thinking = raw.effort;
		else warnings.push(`effort "${String(raw.effort)}" ignored`);
	}
	if (raw.permissionMode !== undefined) {
		if (raw.permissionMode === "plan" || raw.permissionMode === "bubble") mapped.permissionMode = raw.permissionMode;
		else if (raw.permissionMode !== "default")
			warnings.push(`permissionMode "${String(raw.permissionMode)}" ignored; project agents cannot raise authority`);
	}
	for (const key of ["maxTurns", "background", "initialPrompt"] as const) {
		if (raw[key] !== undefined) mapped[key] = raw[key];
	}
	if (raw.skills !== undefined) mapped.skills = normalizeToolList(raw.skills);
	if (raw.isolation !== undefined) {
		if (raw.isolation === "worktree") mapped.isolation = "worktree";
		else warnings.push(`isolation "${String(raw.isolation)}" ignored`);
	}
	if (typeof raw.color === "string") {
		const color = CLAUDE_COLORS[raw.color];
		if (color) mapped.color = color;
	}
	for (const key of ["mcpServers", "hooks", "memory"] as const) {
		if (raw[key] !== undefined) warnings.push(`compat key "${key}" is not supported and was ignored`);
	}
	const diagnostics = schemaDiagnostics(NativeAgentFrontmatterSchema, mapped);
	if (!parsed.body.trim()) diagnostics.push("body (system prompt) is empty");
	const name = typeof raw.name === "string" ? raw.name : undefined;
	if (diagnostics.length > 0) {
		return {
			kind: "invalid",
			issue: {
				...(name && new RegExp(AGENT_NAME_PATTERN).test(name) ? { name } : {}),
				source: "project-compat",
				sourcePath,
				availability: "invalid",
				diagnostics: [...diagnostics, ...warnings],
			},
		};
	}
	return {
		kind: "agent",
		definition: definitionFrom(
			name!,
			mapped.description as string,
			parsed.body.trim(),
			mapped,
			"project-compat",
			hashAgentSource(content),
			sourcePath,
			warnings,
			limited,
		),
	};
}
