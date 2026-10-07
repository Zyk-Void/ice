/**
 * Subagent V2 settings (Plan/subagent-rewrite.md section 8).
 *
 * Reads the V2 keys of `ice.subagents` from the global and trusted-project
 * scopes. Permission rules keep their scope so project rules can only narrow
 * child mutation authority. Invalid values fail closed with a diagnostic.
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

const V2KeysSchema = Type.Object({
	/** Former rollout switch; accepted and ignored so existing settings stay valid. */
	v2: Type.Optional(Type.Boolean()),
	defaultAgent: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" })),
	maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
	maxConcurrent: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })),
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
	defaultAgent: string;
	maxDepth: number;
	maxConcurrent: number;
	askTimeoutMs: number;
	/** Settings permission rules, one set per scope. */
	ruleSets: PermissionRuleSet[];
	agents: { user?: unknown; project?: unknown };
	disabledAgents: string[];
	compat: { claudeAgents: boolean; modelAliases: Record<string, string> };
	diagnostics: string[];
}

function pick(raw: unknown): { keys: V2Keys; diagnostics: string[] } {
	if (!raw || typeof raw !== "object") return { keys: {}, diagnostics: [] };
	const source = raw as Record<string, unknown>;
	const keys: Record<string, unknown> = {};
	for (const key of Object.keys(V2KeysSchema.properties)) if (source[key] !== undefined) keys[key] = source[key];
	const errors = [...Value.Errors(V2KeysSchema, keys)].map((error) => `${error.instancePath}: ${error.message}`);
	return errors.length > 0 ? { keys: {}, diagnostics: errors } : { keys: keys as V2Keys, diagnostics: [] };
}

export function resolveSubagentsV2Settings(input: {
	global?: unknown;
	project?: unknown;
	projectTrusted: boolean;
}): SubagentsV2Settings {
	const global = pick(input.global);
	const project = input.projectTrusted ? pick(input.project) : { keys: {} as V2Keys, diagnostics: [] };
	const g = global.keys;
	const p = project.keys;
	const ruleSets: PermissionRuleSet[] = [];
	if (g.permissions) ruleSets.push({ origin: { scope: "user", carrier: "settings" }, rules: g.permissions });
	if (p.permissions) ruleSets.push({ origin: { scope: "project", carrier: "settings" }, rules: p.permissions });
	// Project settings may narrow numeric ceilings but never raise them above the user's.
	const narrowest = (key: "maxDepth" | "maxConcurrent", fallback: number) =>
		Math.min(g[key] ?? fallback, p[key] ?? Number.POSITIVE_INFINITY);
	return {
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
	};
}
