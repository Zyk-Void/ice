/**
 * Subagent V2 settings (Plan/subagent-rewrite.md section 8).
 *
 * The single schema for `ice.subagents`, read from the global and trusted-project
 * scopes. Permission rules keep their scope so project rules can only narrow
 * child mutation authority. Invalid values and unknown keys fail closed with a
 * diagnostic; keys of the removed legacy subagent system are accepted, ignored,
 * and reported as non-blocking deprecations.
 */
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { DEFAULT_ASK_TIMEOUT_MS } from "../permissions/approval.ts";
import type { PermissionRuleSet } from "../permissions/evaluate.ts";
import { PERMISSION_RULE_LIMITS, PERMISSION_RULE_PATTERN } from "../permissions/rules.ts";

const ruleList = Type.Array(
	Type.String({ minLength: 1, maxLength: PERMISSION_RULE_LIMITS.maxRuleBytes, pattern: PERMISSION_RULE_PATTERN }),
	{ maxItems: PERMISSION_RULE_LIMITS.maxRulesPerList },
);

/** Keys of the removed legacy subagent system: accepted and ignored so existing settings stay valid. */
const DEPRECATED_KEYS = new Set([
	"defaults",
	"allowedRoles",
	"roleDefaults",
	"restrictions",
	"modelSelection",
	"concurrency",
	"routeTiers",
]);

const V2KeysSchema = Type.Object({
	/** `false` blocks new child launches; existing children stay manageable. */
	enabled: Type.Optional(Type.Boolean()),
	/** Former rollout switch; accepted and ignored so existing settings stay valid. */
	v2: Type.Optional(Type.Boolean()),
	defaultAgent: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" })),
	maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
	maxConcurrent: Type.Optional(Type.Integer({ minimum: 1 })),
	askTimeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 60 * 60 * 1000 })),
	permissions: Type.Optional(
		Type.Object(
			{ allow: Type.Optional(ruleList), ask: Type.Optional(ruleList), deny: Type.Optional(ruleList) },
			{ additionalProperties: false },
		),
	),
	agents: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	disabledAgents: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
	compat: Type.Optional(
		Type.Object(
			{
				claudeAgents: Type.Optional(Type.Boolean()),
				modelAliases: Type.Optional(Type.Record(Type.String(), Type.String({ minLength: 3, maxLength: 256 }))),
			},
			{ additionalProperties: false },
		),
	),
});
type V2Keys = Static<typeof V2KeysSchema>;

export interface SubagentsV2Settings {
	/** False when either scope disables delegation; a project cannot re-enable it. */
	enabled: boolean;
	defaultAgent: string;
	maxDepth: number;
	maxConcurrent: number;
	askTimeoutMs: number;
	/** Settings permission rules, one set per scope. */
	ruleSets: PermissionRuleSet[];
	agents: { user?: unknown; project?: unknown };
	disabledAgents: string[];
	compat: { claudeAgents: boolean; modelAliases: Record<string, string> };
	/** Invalid settings; any entry blocks new launches. */
	diagnostics: string[];
	/** Ignored legacy keys; informational only. */
	deprecations: Array<{ scope: "global" | "project"; key: string; message: string }>;
}

function pick(raw: unknown): { keys: V2Keys; diagnostics: string[]; deprecated: string[] } {
	if (raw === undefined || raw === null) return { keys: {}, diagnostics: [], deprecated: [] };
	if (typeof raw !== "object" || Array.isArray(raw))
		return { keys: {}, diagnostics: ["expected an object"], deprecated: [] };
	const source = raw as Record<string, unknown>;
	const keys: Record<string, unknown> = {};
	const errors: string[] = [];
	const deprecated: string[] = [];
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (Object.hasOwn(V2KeysSchema.properties, key)) keys[key] = value;
		else if (DEPRECATED_KEYS.has(key)) deprecated.push(key);
		else errors.push(`/${key}: unknown key`);
	}
	errors.push(...[...Value.Errors(V2KeysSchema, keys)].map((error) => `${error.instancePath}: ${error.message}`));
	return errors.length > 0
		? { keys: {}, diagnostics: errors, deprecated }
		: { keys: keys as V2Keys, diagnostics: [], deprecated };
}

export function resolveSubagentsV2Settings(input: {
	global?: unknown;
	project?: unknown;
	projectTrusted: boolean;
}): SubagentsV2Settings {
	const global = pick(input.global);
	const project = input.projectTrusted ? pick(input.project) : { keys: {} as V2Keys, diagnostics: [], deprecated: [] };
	const g = global.keys;
	const p = project.keys;
	const ruleSets: PermissionRuleSet[] = [];
	if (g.permissions) ruleSets.push({ origin: { scope: "user", carrier: "settings" }, rules: g.permissions });
	if (p.permissions) ruleSets.push({ origin: { scope: "project", carrier: "settings" }, rules: p.permissions });
	// Project settings may narrow numeric ceilings but never raise them above the user's.
	const narrowest = (key: "maxDepth" | "maxConcurrent", fallback: number) =>
		Math.min(g[key] ?? fallback, p[key] ?? Number.POSITIVE_INFINITY);
	return {
		enabled: g.enabled !== false && p.enabled !== false,
		defaultAgent: p.defaultAgent ?? g.defaultAgent ?? "general",
		maxDepth: narrowest("maxDepth", 0),
		maxConcurrent: narrowest("maxConcurrent", 4),
		askTimeoutMs: g.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
		ruleSets,
		agents: { ...(g.agents ? { user: g.agents } : {}), ...(p.agents ? { project: p.agents } : {}) },
		disabledAgents: [...new Set([...(g.disabledAgents ?? []), ...(p.disabledAgents ?? [])])],
		compat: {
			claudeAgents: g.compat?.claudeAgents ?? false,
			modelAliases: { ...(g.compat?.modelAliases ?? {}) },
		},
		diagnostics: [
			...global.diagnostics.map((message) => `ice.subagents (global) ${message}`),
			...project.diagnostics.map((message) => `ice.subagents (project) ${message}`),
		],
		deprecations: (["global", "project"] as const).flatMap((scope) =>
			(scope === "global" ? global : project).deprecated.map((key) => ({
				scope,
				key: `ice.subagents.${key}`,
				message: `ice.subagents.${key} (${scope}) belongs to the removed legacy subagent system and is ignored`,
			})),
		),
	};
}
