/**
 * Subagent V2 AgentDefinition contract (Phase 0: schemas only).
 *
 * Design: Plan/subagent-rewrite.md sections 7.1-7.5. Discovery, parsing,
 * precedence, and compat normalization land in Phase 2.
 */
import { type Static, Type } from "typebox";
import { SUBAGENT_PROFILE_COLORS } from "../../ice-agent-view-bridge.ts";
import { AGENT_PERMISSION_MODES, PERMISSION_RULE_LIMITS, PERMISSION_RULE_PATTERN } from "../permissions/rules.ts";

export const AGENT_NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";

export const AGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type AgentThinkingLevel = (typeof AGENT_THINKING_LEVELS)[number];

export const AGENT_ISOLATION_MODES = ["none", "worktree"] as const;
export type AgentIsolationMode = (typeof AGENT_ISOLATION_MODES)[number];

export const AGENT_DEFINITION_LIMITS = Object.freeze({
	maxDescriptionChars: 1024,
	maxPromptBytes: 64 * 1024,
	maxInitialPromptChars: 4096,
	maxModelCandidates: 8,
	maxModelReferenceChars: 256,
	maxListItems: 64,
	maxListItemChars: 256,
	maxTags: 8,
	maxTagChars: 32,
});

/** Definition sources, low to high precedence. Managed policy is a separate lock layer (section 7.1). */
export const AGENT_DEFINITION_SOURCES = [
	"builtin",
	"package",
	"user",
	"user-settings",
	"project",
	"project-settings",
	"flag",
] as const;
export type AgentDefinitionSource = (typeof AGENT_DEFINITION_SOURCES)[number] | "managed" | "project-compat";

const stringList = (itemPattern?: string) =>
	Type.Array(
		Type.String({
			minLength: 1,
			maxLength: AGENT_DEFINITION_LIMITS.maxListItemChars,
			...(itemPattern ? { pattern: itemPattern } : {}),
		}),
		{ maxItems: AGENT_DEFINITION_LIMITS.maxListItems },
	);

const ruleList = () =>
	Type.Array(
		Type.String({ minLength: 1, maxLength: PERMISSION_RULE_LIMITS.maxRuleBytes, pattern: PERMISSION_RULE_PATTERN }),
		{ maxItems: PERMISSION_RULE_LIMITS.maxRulesPerList },
	);

const modelReference = Type.String({ minLength: 1, maxLength: AGENT_DEFINITION_LIMITS.maxModelReferenceChars });
const positiveIntOrNull = Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]);

/** Fields shared by Markdown frontmatter and JSON definitions. Markdown adds `name`; JSON adds `prompt`. */
const agentDefinitionFields = {
	description: Type.String({ minLength: 1, maxLength: AGENT_DEFINITION_LIMITS.maxDescriptionChars }),
	/** YAML sequence or Claude-style comma string; omitted or ["*"] means all child-safe parent-active tools. */
	tools: Type.Optional(Type.Union([stringList(), Type.String({ minLength: 1, maxLength: 4096 })])),
	disallowedTools: Type.Optional(stringList()),
	/** `inherit`, one exact provider/model reference, or an ordered candidate list (replaces `fallbackModel`). */
	model: Type.Optional(
		Type.Union([
			modelReference,
			Type.Array(modelReference, { minItems: 1, maxItems: AGENT_DEFINITION_LIMITS.maxModelCandidates }),
		]),
	),
	thinking: Type.Optional(Type.Enum(AGENT_THINKING_LEVELS)),
	permissionMode: Type.Optional(Type.Enum(AGENT_PERMISSION_MODES)),
	permissions: Type.Optional(
		Type.Object(
			{ allow: Type.Optional(ruleList()), ask: Type.Optional(ruleList()), deny: Type.Optional(ruleList()) },
			{ additionalProperties: false },
		),
	),
	maxTurns: Type.Optional(positiveIntOrNull),
	maxTokens: Type.Optional(positiveIntOrNull),
	timeoutMs: Type.Optional(positiveIntOrNull),
	background: Type.Optional(Type.Boolean()),
	isolation: Type.Optional(Type.Enum(AGENT_ISOLATION_MODES)),
	contextFiles: Type.Optional(Type.Boolean()),
	skills: Type.Optional(stringList()),
	prompts: Type.Optional(stringList()),
	context: Type.Optional(stringList()),
	mcp: Type.Optional(stringList()),
	requiredMcpServers: Type.Optional(stringList()),
	hooks: Type.Optional(stringList()),
	initialPrompt: Type.Optional(
		Type.String({ minLength: 1, maxLength: AGENT_DEFINITION_LIMITS.maxInitialPromptChars }),
	),
	spawns: Type.Optional(stringList(AGENT_NAME_PATTERN)),
	color: Type.Optional(Type.Enum(SUBAGENT_PROFILE_COLORS)),
	hidden: Type.Optional(Type.Boolean()),
	tags: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: AGENT_DEFINITION_LIMITS.maxTagChars }), {
			maxItems: AGENT_DEFINITION_LIMITS.maxTags,
		}),
	),
	temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
	topP: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	/** Reserved ICE agent-pack provenance; host metadata only, never prompt text. */
	"ice-agent-pack": Type.Optional(Type.String({ maxLength: 256 })),
	"ice-agent-pack-source": Type.Optional(Type.String({ maxLength: 1024 })),
	"ice-agent-pack-sha256": Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
};

/** Native `.ice/agents/**\/*.md` frontmatter. Unknown keys are errors (D10). Body is the system prompt. */
export const NativeAgentFrontmatterSchema = Type.Object(
	{ name: Type.String({ pattern: AGENT_NAME_PATTERN }), ...agentDefinitionFields },
	{ additionalProperties: false },
);
export type NativeAgentFrontmatter = Static<typeof NativeAgentFrontmatterSchema>;

/** `ice.subagents.agents.<name>` and `--agents` / SDK JSON entries. The map key is the name. */
export const JsonAgentDefinitionSchema = Type.Object(
	{
		...agentDefinitionFields,
		prompt: Type.String({ minLength: 1, maxLength: AGENT_DEFINITION_LIMITS.maxPromptBytes }),
	},
	{ additionalProperties: false },
);
export type JsonAgentDefinition = Static<typeof JsonAgentDefinitionSchema>;

/**
 * Keys a `.claude/agents` compat file may carry. Known keys are mapped in Phase 2;
 * any other key produces a warning, not a load failure (D9/D10).
 */
export const CLAUDE_COMPAT_AGENT_KEYS = Object.freeze([
	"name",
	"description",
	"tools",
	"disallowedTools",
	"model",
	"effort",
	"permissionMode",
	"mcpServers",
	"hooks",
	"maxTurns",
	"skills",
	"initialPrompt",
	"memory",
	"background",
	"isolation",
	"color",
] as const);

/** One resolved definition after parsing and source attribution; the input to precedence. */
export interface ResolvedAgentDefinition {
	name: string;
	description: string;
	/** System prompt contribution (Markdown body or JSON `prompt`). */
	prompt: string;
	fields: Omit<NativeAgentFrontmatter, "name" | "description">;
	source: AgentDefinitionSource;
	/** Absent for builtin, flag, and SDK sources. */
	sourcePath?: string;
	/** SHA-256 of the exact source bytes (file) or canonical JSON (settings/flag/SDK/builtin). */
	sourceHash: string;
	diagnostics: readonly string[];
	/** Loaded but not callable as declared (for example an unmapped compat model alias); never advertised. */
	limited: boolean;
}
