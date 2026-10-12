import { accessSync, constants, existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { redactCredentialText } from "../../utils/redact.ts";

/**
 * Executable environment preflight for ICE subagents.
 *
 * Preflight distinguishes "installed" from "actually usable by this child"
 * before a child run is consumed. Probes are policy-safe by construction:
 * command probes resolve names on PATH without executing anything, path probes
 * stay inside the declared child scope, and env probes reveal only variable
 * presence, never values. Preflight never grants a child additional tools or
 * authority, and it never starts services, containers, or browsers.
 */

export interface SubagentPreflightRequirementInput {
	id: string;
	kind: "command" | "path" | "env-present";
	value: string;
	required?: boolean;
}

export interface SubagentPreflightRequirement {
	id: string;
	kind: "command" | "path" | "env-present";
	value: string;
	required: boolean;
}

export type SubagentPreflightState = "FOUND" | "UNAVAILABLE" | "PRESENT" | "ABSENT" | "OUT_OF_SCOPE";

export interface SubagentPreflightCheck {
	id: string;
	kind: SubagentPreflightRequirement["kind"];
	value: string;
	required: boolean;
	state: SubagentPreflightState;
	detail?: string;
}

export interface SubagentPreflightEvaluation {
	readonly checks: readonly SubagentPreflightCheck[];
	/** True when at least one required check failed. Launch must be blocked. */
	readonly blocked: boolean;
	readonly failedRequiredIds: readonly string[];
	readonly summary: string;
}

export const SUBAGENT_PREFLIGHT_LIMITS = {
	maxRequirements: 8,
	maxIdBytes: 64,
	maxValueBytes: 512,
} as const;

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Command probes accept bare executable names only; no separators, globs, or shell syntax. */
const SAFE_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedValue(value: string, maxBytes: number): string | undefined {
	if (value.length === 0) return undefined;
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length > maxBytes) return undefined;
	return value;
}

/** Normalize untrusted parent-declared preflight requirements into a bounded canonical form. */
export function normalizeSubagentPreflightRequirements(
	input: readonly SubagentPreflightRequirementInput[] | undefined,
): SubagentPreflightRequirement[] {
	if (input === undefined) return [];
	if (!Array.isArray(input)) {
		throw new Error("Subagent preflight requirements must be an array.");
	}
	if (input.length > SUBAGENT_PREFLIGHT_LIMITS.maxRequirements) {
		throw new Error(`Subagent preflight accepts at most ${SUBAGENT_PREFLIGHT_LIMITS.maxRequirements} requirements.`);
	}
	const normalized: SubagentPreflightRequirement[] = [];
	const seen = new Set<string>();
	for (const entry of input) {
		const requirement: unknown = entry;
		if (!isRecord(requirement)) {
			throw new Error("Each subagent preflight requirement must be an object.");
		}
		const id =
			typeof requirement.id === "string"
				? boundedValue(requirement.id, SUBAGENT_PREFLIGHT_LIMITS.maxIdBytes)
				: undefined;
		if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
			throw new Error("Subagent preflight requirement IDs must be bounded safe identifiers.");
		}
		if (seen.has(id)) {
			throw new Error(`Subagent preflight requirement IDs must be unique: ${id}`);
		}
		seen.add(id);
		const kind = requirement.kind;
		if (kind !== "command" && kind !== "path" && kind !== "env-present") {
			throw new Error(`Subagent preflight requirement ${id} has an unsupported kind.`);
		}
		const rawValue: unknown = requirement.value;
		if (typeof rawValue !== "string") {
			throw new Error(`Subagent preflight requirement ${id} requires a string value.`);
		}
		const value = boundedValue(rawValue, SUBAGENT_PREFLIGHT_LIMITS.maxValueBytes);
		if (!value || value.trim().length === 0) {
			throw new Error(`Subagent preflight requirement ${id} requires a nonempty bounded value.`);
		}
		if (
			kind === "command" &&
			(!SAFE_COMMAND_NAME_PATTERN.test(value) || value.includes(sep) || value.includes("/"))
		) {
			throw new Error(
				`Subagent preflight requirement ${id} must be a bare executable name without path separators or shell syntax.`,
			);
		}
		if (kind === "env-present" && !ENV_KEY_PATTERN.test(value)) {
			throw new Error(`Subagent preflight requirement ${id} must reference a valid environment variable name.`);
		}
		normalized.push({
			id,
			kind,
			value: kind === "command" ? value.trim() : value,
			required: requirement.required !== false,
		});
	}
	return normalized;
}

/** Resolve a bare command name on PATH without executing anything. */
export function resolveCommandOnPath(command: string, environment: NodeJS.ProcessEnv): string | undefined {
	if (!SAFE_COMMAND_NAME_PATTERN.test(command)) return undefined;
	const pathVariable = environment.PATH ?? "";
	const directories = pathVariable.split(sep === "\\" ? ";" : ":").filter((entry) => entry.length > 0);
	for (const directory of directories) {
		const candidate = resolve(directory, command);
		try {
			accessSync(candidate, constants.X_OK);
			if (!statSync(candidate).isFile()) continue;
			return candidate;
		} catch {}
	}
	return undefined;
}

function evaluateCheck(
	requirement: SubagentPreflightRequirement,
	options: {
		cwd: string;
		scopeRoots: readonly string[];
		environment: NodeJS.ProcessEnv;
		pathExists?: (candidate: string) => boolean;
	},
): SubagentPreflightCheck {
	const pathExists = options.pathExists ?? ((candidate: string) => existsSync(candidate));
	const base = {
		id: requirement.id,
		kind: requirement.kind,
		value: requirement.value,
		required: requirement.required,
	};
	if (requirement.kind === "command") {
		const resolved = resolveCommandOnPath(requirement.value, options.environment);
		if (resolved) return { ...base, state: "FOUND" };
		return {
			...base,
			state: "UNAVAILABLE",
			detail: `No executable named ${requirement.value} was found on PATH. Nothing was executed.`,
		};
	}
	if (requirement.kind === "env-present") {
		// Presence only; values are never read, compared, or reported.
		return Object.hasOwn(options.environment, requirement.value)
			? { ...base, state: "PRESENT" }
			: { ...base, state: "ABSENT", detail: `Environment variable ${requirement.value} is not set.` };
	}
	// path kind: resolution must stay inside the child-approved scope.
	const value = requirement.value;
	if (isAbsolute(value) && !isWithinAnyRoot(options.scopeRoots, value)) {
		return { ...base, state: "OUT_OF_SCOPE", detail: "Absolute path probes must stay inside the approved scope." };
	}
	const candidate = resolve(options.cwd, value);
	if (!isWithinAnyRoot(options.scopeRoots, candidate)) {
		return { ...base, state: "OUT_OF_SCOPE", detail: "Path probes must stay inside the approved scope." };
	}
	if (pathExists(candidate)) return { ...base, state: "FOUND" };
	return { ...base, state: "UNAVAILABLE", detail: "Path does not exist inside the approved scope." };
}

function isWithinAnyRoot(roots: readonly string[], candidate: string): boolean {
	return roots.some((root) => {
		const relativePath = relative(root, candidate);
		return (
			relativePath === "" ||
			(!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
		);
	});
}

export function evaluateSubagentPreflight(
	requirements: readonly SubagentPreflightRequirement[],
	options: {
		cwd: string;
		scopeRoots: readonly string[];
		environment?: NodeJS.ProcessEnv;
		pathExists?: (candidate: string) => boolean;
	},
): SubagentPreflightEvaluation {
	const environment = options.environment ?? process.env;
	const checks = requirements.map((requirement) => evaluateCheck(requirement, { ...options, environment }));
	const failedRequiredIds = checks
		.filter((check) => check.required && check.state !== "FOUND" && check.state !== "PRESENT")
		.map((check) => check.id);
	return Object.freeze({
		checks: Object.freeze(checks.map((check) => Object.freeze(check))),
		blocked: failedRequiredIds.length > 0,
		failedRequiredIds: Object.freeze(failedRequiredIds),
		summary: formatSubagentPreflight(checks),
	});
}

/** Human-readable bounded preflight projection, e.g. "chromium executable: FOUND". */
export function formatSubagentPreflight(checks: readonly SubagentPreflightCheck[]): string {
	if (checks.length === 0) return "";
	return checks
		.map((check) => {
			const label = redactCredentialText(check.value);
			const suffix = check.required ? "" : " (optional)";
			const detail = check.detail ? ` — ${redactCredentialText(check.detail)}` : "";
			return `${label}: ${check.state}${suffix}${detail}`;
		})
		.join("\n");
}

export function formatSubagentPreflightFailure(evaluation: SubagentPreflightEvaluation): string {
	return ["Required environment preflight failed; no child run was consumed.", evaluation.summary].join("\n");
}
