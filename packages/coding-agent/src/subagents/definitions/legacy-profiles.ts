/** Legacy file-agent/self profile discovery, parsing, resolution, and listing (moved from ice-subagents.ts; replaced in V2 Phase 2). */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir, getProjectConfigDir } from "../../config.ts";
import { getIceEnv } from "../../core/legacy-compat/env.ts";
import { isSubagentProfileColor, type SubagentProfileColor } from "../../ice-agent-view-bridge.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { redactCredentialText } from "../../utils/redact.ts";
import { normalizeSubagentHookIds } from "../extension-support.ts";
import { SUBAGENT_CHECKIN_INTERVAL_MS } from "../runtime/checkin.ts";
import { SubagentError } from "../runtime/helpers.ts";
import {
	type IceResolvedDelegableTool,
	isIceChildToolName,
	isIceDelegableAdapterId,
	isIceParentManagementTool,
} from "../tools/adapters.ts";
import { deriveEffectiveSubagentTools } from "../tools/derive.ts";
import { canonicalPath, isPathWithin } from "../tools/paths.ts";
import {
	type IceSubagentMcpAdapter,
	type IceSubagentMcpToolAccess,
	type IceSubagentMcpToolAuthorization,
	type ResolvedSubagentProfile,
	SUBAGENT_PROFILE_LIMITS,
	SUBAGENT_PROFILE_TAG_LIMITS,
	SUBAGENT_REQUESTED_TOOL_NAMES,
	SUBAGENT_TOOL_NAMES,
	type SubagentProfile,
	type SubagentProfileAvailability,
	type SubagentProfileSource,
	type SubagentProfileSummary,
	type SubagentRequestedToolName,
	type SubagentResourceSelection,
	type SubagentThinkingLevel,
	type SubagentToolName,
} from "../types.ts";

export interface SubagentProfileResolutionOptions {
	cwd: string;
	agentDir?: string;
	projectTrusted?: boolean;
	includeSelf?: boolean;
	delegableTools?: readonly IceResolvedDelegableTool[];
	/** Optional invocation capabilities used when projecting profile availability. */
	parentActiveTools?: readonly string[];
	unsafeHostExec?: boolean;
}

export type SubagentResourceResolutionOptions = SubagentProfileResolutionOptions;

export interface SubagentAgentDirectories {
	/** Current global file-agent directory. */
	globalAgentsDir: string;
	/** Legacy directory is reported but never loaded or modified automatically. */
	legacyGlobalAgentsDir?: string;
}

/**
 * Resolve the file-agent roots without changing Ice's existing settings and
 * credential layout. Explicit custom agent directories retain the historical
 * `<agentDir>/agents` layout; the default installation uses `~/.ice/agents`.
 */
export function resolveSubagentAgentDirectories(agentDir?: string): SubagentAgentDirectories {
	const effectiveAgentDir = resolve(agentDir ?? getAgentDir());
	const defaultAgentDir = resolve(getAgentDir());
	// An environment override is an explicit custom-directory contract even
	// when callers omit `agentDir`; retain `<agentDir>/agents` for that case.
	const hasEnvironmentOverride = Boolean(getIceEnv(ENV_AGENT_DIR));
	if (hasEnvironmentOverride || effectiveAgentDir !== defaultAgentDir) {
		return { globalAgentsDir: join(effectiveAgentDir, "agents") };
	}
	return {
		globalAgentsDir: join(dirname(effectiveAgentDir), "agents"),
		legacyGlobalAgentsDir: join(effectiveAgentDir, "agents"),
	};
}

export function getSubagentGlobalAgentsDir(agentDir?: string): string {
	return resolveSubagentAgentDirectories(agentDir).globalAgentsDir;
}

export interface SubagentAgentMigrationEntry {
	name: string;
	sourcePath: string;
	destinationPath: string;
	conflict: "none" | "target-exists";
}

/**
 * Return a non-destructive migration manifest for files in the legacy global
 * directory. This function only inventories regular Markdown entries; it
 * never reads, moves, overwrites, or deletes user files.
 */
export function getSubagentAgentMigrationManifest(agentDir?: string): readonly SubagentAgentMigrationEntry[] {
	const directories = resolveSubagentAgentDirectories(agentDir);
	const legacy = directories.legacyGlobalAgentsDir;
	if (!legacy || !existsSync(legacy) || !statSync(legacy).isDirectory()) return Object.freeze([]);
	const entries: SubagentAgentMigrationEntry[] = [];
	for (const entryName of readdirSync(legacy)
		.filter((entry) => entry.endsWith(".md"))
		.sort()) {
		const sourcePath = join(legacy, entryName);
		try {
			if (!lstatSync(sourcePath).isFile()) continue;
		} catch {
			continue;
		}
		const destinationPath = join(directories.globalAgentsDir, entryName);
		entries.push({
			name: profileNameFromPath(sourcePath),
			sourcePath,
			destinationPath,
			conflict: existsSync(destinationPath) ? "target-exists" : "none",
		});
	}
	return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

export function hashSource(source: Uint8Array | string): string {
	return createHash("sha256").update(source).digest("hex");
}

export function findNearestDirectory(cwd: string, name: string): string | undefined {
	let current = resolve(cwd);
	while (true) {
		const prefix = `${CONFIG_DIR_NAME}${sep}`;
		const candidate = name.startsWith(prefix)
			? join(getProjectConfigDir(current), name.slice(prefix.length))
			: join(current, name);
		if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function parseRoleList(value: unknown, label: string): string[] {
	if (value === undefined || value === null || value === "") return [];
	const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
	if (!values || values.some((entry) => typeof entry !== "string")) {
		throw new SubagentError("malformed_result", `Configurable role ${label} must be a string list.`);
	}
	const entries = [...new Set(values.map((entry) => entry.trim()).filter(Boolean))];
	if (entries.length > 16 || entries.some((entry) => entry.length > 4096 || Buffer.byteLength(entry) > 4096)) {
		throw new SubagentError("malformed_result", `Configurable role ${label} selections are too large.`);
	}
	return entries;
}

/**
 * W10: optional bounded discoverability tags. Tags are display metadata only;
 * unknown authority-bearing profile fields are rejected by the loader, never
 * silently reinterpreted.
 */
function parseRoleTags(value: unknown): readonly string[] | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
	if (!values || values.some((entry) => typeof entry !== "string")) {
		throw new SubagentError("malformed_result", "Configurable role tags must be a string list.");
	}
	const entries = [...new Set(values.map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
	if (entries.length > SUBAGENT_PROFILE_TAG_LIMITS.maxTags) {
		throw new SubagentError("malformed_result", "Configurable role has too many tags.");
	}
	if (
		entries.some(
			(entry) =>
				!/^[a-z0-9][a-z0-9-]{0,31}$/.test(entry) ||
				Buffer.byteLength(entry) > SUBAGENT_PROFILE_TAG_LIMITS.maxTagBytes,
		)
	) {
		throw new SubagentError("malformed_result", "Configurable role tags must be kebab-case names.");
	}
	return Object.freeze(entries);
}

function parseExactModelReference(value: string, sourcePath: string): string {
	const reference = value.trim();
	const slash = reference.indexOf("/");
	if (slash <= 0 || slash === reference.length - 1 || reference.length > 256 || /[\s\x00-\x1f]/.test(reference)) {
		throw new SubagentError("malformed_result", `Invalid exact model reference in ${sourcePath}.`);
	}
	return reference;
}

function parseSelectedMcpTools(value: unknown): readonly string[] | undefined {
	if (value === undefined) return undefined;
	const tools = parseRoleList(value, "mcp");
	if (tools.length === 0 || tools.length > 16) {
		throw new SubagentError("malformed_result", "Selected MCP tools must contain 1-16 entries.");
	}
	const normalized = tools.map((tool) => tool.trim());
	if (
		normalized.some(
			(tool) =>
				!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(tool) ||
				Buffer.byteLength(tool) > 256,
		)
	) {
		throw new SubagentError(
			"malformed_result",
			"Selected MCP tools must use exact server/tool identifiers (server/tool).",
		);
	}
	return Object.freeze([...new Set(normalized)]);
}

function parseRoleAdapterIds(value: unknown, sourcePath: string): readonly string[] | undefined {
	if (value === undefined) return undefined;
	const adapters = parseRoleList(value, "adapters");
	if (adapters.some((adapterId) => !isIceDelegableAdapterId(adapterId) || Buffer.byteLength(adapterId) > 128)) {
		throw new SubagentError(
			"malformed_result",
			`Configurable role adapters must use explicit parent adapter IDs in ${sourcePath}.`,
		);
	}
	return Object.freeze([...new Set(adapters)]);
}

function parseRoleTools(value: unknown): string[] {
	const tools = parseRoleList(value, "tools");
	if (value === undefined) return [...SUBAGENT_REQUESTED_TOOL_NAMES];
	if (tools.length > 32 || tools.some((tool) => !isIceChildToolName(tool) || isIceParentManagementTool(tool))) {
		throw new SubagentError(
			"capability_denied",
			"Configurable roles require bounded child tool identifiers; delegation/control tools are forbidden.",
		);
	}
	return [...new Set(tools)];
}

function parseProfileThinkingLevel(
	value: unknown,
	fallback: SubagentThinkingLevel,
	diagnostics: string[],
): SubagentThinkingLevel {
	const allowed: readonly SubagentThinkingLevel[] = [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
		"ultra",
	];
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value !== "string" || !allowed.includes(value as SubagentThinkingLevel)) {
		diagnostics.push(`invalid thinking metadata ignored; using ${fallback}`);
		return fallback;
	}
	return value as SubagentThinkingLevel;
}

function parseStrictProfileNumber(
	value: unknown,
	label: string,
	minimum: number,
	maximum: number,
	sourcePath: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new SubagentError(
			"malformed_result",
			`Invalid ${label} metadata in ${sourcePath}; expected a finite number in [${minimum}, ${maximum}].`,
		);
	}
	return value;
}

function parseProfileColor(value: unknown, sourcePath: string): SubagentProfileColor | undefined {
	if (value === undefined) return undefined;
	if (!isSubagentProfileColor(value)) {
		throw new SubagentError(
			"malformed_result",
			`Invalid color metadata in ${sourcePath}; expected a semantic theme color token.`,
		);
	}
	return value;
}

function parseProfileHidden(value: unknown, sourcePath: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new SubagentError("malformed_result", `Invalid hidden metadata in ${sourcePath}; expected a boolean.`);
	}
	return value;
}

function parseBoundedProfileNumber(
	value: unknown,
	label: string,
	fallback: number,
	minimum: number,
	maximum: number,
	diagnostics: string[],
	integer: boolean,
): number {
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		diagnostics.push(`invalid ${label} metadata ignored; using ${fallback}`);
		return fallback;
	}
	const normalized = integer ? Math.trunc(value) : value;
	const bounded = Math.min(Math.max(normalized, minimum), maximum);
	if (bounded !== normalized) diagnostics.push(`${label} metadata clamped to ${bounded}`);
	return bounded;
}

function parseRoleResources(frontmatter: Record<string, unknown>): SubagentResourceSelection | undefined {
	const resources: SubagentResourceSelection = {
		skills: parseRoleList(frontmatter.skills, "skills"),
		prompts: parseRoleList(frontmatter.prompts, "prompts"),
		context: parseRoleList(frontmatter.context, "context"),
	};
	return resources.skills?.length || resources.prompts?.length || resources.context?.length ? resources : undefined;
}

function parseUnsafeHostExecEligibility(value: unknown): boolean {
	return value === true || value === "true" || value === "allowed";
}

interface ProfileListingDiagnostic {
	name: string;
	description: string;
	source: Exclude<SubagentProfileSource, "self">;
	sourcePath: string;
	availability: Extract<SubagentProfileAvailability, "invalid" | "untrusted">;
	diagnostics: readonly string[];
}

function profileNameFromPath(path: string): string {
	const name = basename(path, ".md").toLowerCase();
	return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? name : "unknown";
}

function profileListingDiagnostic(
	error: unknown,
	source: Exclude<SubagentProfileSource, "self">,
	sourcePath: string,
): ProfileListingDiagnostic {
	const untrusted = error instanceof SubagentError && error.code === "untrusted_profile";
	return {
		name: profileNameFromPath(sourcePath),
		description: "Profile could not be loaded.",
		source,
		sourcePath,
		availability: untrusted ? "untrusted" : "invalid",
		diagnostics: Object.freeze([
			untrusted
				? "Profile is not trusted for this invocation."
				: "Profile definition is invalid and was not loaded.",
		]),
	};
}

function loadProfilesFromDirectory(
	directory: string,
	source: Exclude<SubagentProfileSource, "self">,
	role?: string,
	skipInvalid = false,
	listingDiagnostics?: ProfileListingDiagnostic[],
): Map<string, ResolvedSubagentProfile> {
	const profiles = new Map<string, ResolvedSubagentProfile>();
	if (!existsSync(directory) || !statSync(directory).isDirectory()) return profiles;
	const canonicalRoot = canonicalPath(directory);
	const entries = readdirSync(directory)
		.filter((entry) => !role || entry === `${role}.md`)
		.sort((left, right) => left.localeCompare(right));
	for (const entryName of entries) {
		const sourcePath = resolve(directory, entryName);
		if (!entryName.endsWith(".md")) continue;
		try {
			const entry = lstatSync(sourcePath);
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			const canonicalSourcePath = canonicalPath(sourcePath);
			if (!isPathWithin(canonicalRoot, canonicalSourcePath) || !statSync(canonicalSourcePath).isFile()) {
				throw new SubagentError(
					"untrusted_profile",
					`Role source escapes its ${source} agents directory: ${sourcePath}`,
				);
			}
			const bytes = readFileSync(canonicalSourcePath);
			const parsed = parseFrontmatter<Record<string, unknown>>(bytes.toString("utf8"));
			const frontmatter = parsed.frontmatter;
			const body = parsed.body;
			const removedOutputFields = ["max-output-bytes", "maxOutputBytes", "max_output_bytes"];
			if (removedOutputFields.some((field) => Object.hasOwn(frontmatter, field))) {
				throw new SubagentError(
					"malformed_result",
					`Final-answer output cap metadata was removed from profiles in ${sourcePath}; output retention uses fixed host limits.`,
				);
			}
			const supportedFields = new Set([
				"name",
				"description",
				"tools",
				"adapters",
				"tags",
				"model",
				"fallbackModel",
				"fallback_model",
				"mcp",
				"mcpTools",
				"mcp_tools",
				"thinking",
				"thinkingLevel",
				"startup-timeout-ms",
				"startupTimeoutMs",
				"temperature",
				"top-p",
				"topP",
				"top_p",
				"color",
				"hidden",
				"skills",
				"prompts",
				"context",
				"ice-unsafe-host-exec",
				"iceUnsafeHostExec",
				"ice-agent-pack",
				"ice-agent-pack-source",
				"ice-agent-pack-sha256",
				"hooks",
			]);
			for (const field of Object.keys(frontmatter)) {
				if (!supportedFields.has(field)) {
					throw new SubagentError("malformed_result", `Unsupported role metadata "${field}" in ${sourcePath}.`);
				}
			}
			const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : undefined;
			const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : undefined;
			const systemPrompt = body.trim();
			if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || !description || !systemPrompt) {
				throw new SubagentError("malformed_result", `Invalid configurable role definition: ${sourcePath}`);
			}
			if (Buffer.byteLength(systemPrompt) > 32 * 1024) {
				throw new SubagentError("malformed_result", `Role system prompt is too large: ${sourcePath}`);
			}
			const diagnostics: string[] = [];
			let requestedModel: string | undefined;
			if (frontmatter.model !== undefined) {
				if (typeof frontmatter.model !== "string" || !frontmatter.model.trim()) {
					throw new SubagentError("malformed_result", `Invalid primary model in ${sourcePath}.`);
				}
				requestedModel = parseExactModelReference(frontmatter.model, sourcePath);
			}
			let fallbackModel: string | undefined;
			const fallbackRaw = frontmatter.fallbackModel ?? frontmatter.fallback_model;
			if (fallbackRaw !== undefined) {
				if (typeof fallbackRaw !== "string" || !fallbackRaw.trim()) {
					throw new SubagentError("malformed_result", `Invalid fallback model in ${sourcePath}.`);
				}
				fallbackModel = parseExactModelReference(fallbackRaw, sourcePath);
				if (fallbackModel === requestedModel) {
					throw new SubagentError(
						"malformed_result",
						`Fallback model duplicates the primary model in ${sourcePath}.`,
					);
				}
			}
			const mcpTools = parseSelectedMcpTools(frontmatter.mcp ?? frontmatter.mcpTools ?? frontmatter.mcp_tools);
			const adapterIds = parseRoleAdapterIds(frontmatter.adapters, sourcePath);
			const requestedTools = parseRoleTools(frontmatter.tools);
			const roleTags = parseRoleTags(frontmatter.tags);
			const temperature = parseStrictProfileNumber(
				frontmatter.temperature,
				"temperature",
				SUBAGENT_PROFILE_LIMITS.minTemperature,
				SUBAGENT_PROFILE_LIMITS.maxTemperature,
				sourcePath,
			);
			const topP = parseStrictProfileNumber(
				frontmatter["top-p"] ?? frontmatter.topP ?? frontmatter.top_p,
				"top-p",
				SUBAGENT_PROFILE_LIMITS.minTopP,
				SUBAGENT_PROFILE_LIMITS.maxTopP,
				sourcePath,
			);
			const color = parseProfileColor(frontmatter.color, sourcePath);
			const hidden = parseProfileHidden(frontmatter.hidden, sourcePath);
			const profile: ResolvedSubagentProfile = {
				name,
				description,
				...(roleTags ? { tags: roleTags } : {}),
				...(frontmatter.hooks !== undefined ? { hooks: normalizeSubagentHookIds(frontmatter.hooks) } : {}),
				systemPrompt: redactCredentialText(systemPrompt),
				requestedTools: Object.freeze([...requestedTools]),
				tools: Object.freeze([...requestedTools]),
				thinkingLevel: parseProfileThinkingLevel(
					frontmatter.thinking ?? frontmatter.thinkingLevel,
					"low",
					diagnostics,
				),
				timeoutMs: parseBoundedProfileNumber(
					frontmatter["startup-timeout-ms"] ?? frontmatter.startupTimeoutMs,
					"startup timeout",
					60_000,
					SUBAGENT_PROFILE_LIMITS.minTimeoutMs,
					SUBAGENT_PROFILE_LIMITS.maxTimeoutMs,
					diagnostics,
					true,
				),
				...(temperature !== undefined ? { temperature } : {}),
				...(topP !== undefined ? { topP } : {}),
				...(color !== undefined ? { color } : {}),
				...(hidden !== undefined ? { hidden } : {}),
				resources: parseRoleResources(frontmatter),
				unsafeHostExec: parseUnsafeHostExecEligibility(
					frontmatter["ice-unsafe-host-exec"] ?? frontmatter.iceUnsafeHostExec,
				),
				...(requestedModel ? { requestedModel } : {}),
				...(fallbackModel ? { fallbackModel } : {}),
				...(adapterIds ? { adapterIds } : {}),
				...(mcpTools ? { mcpTools } : {}),
				modelPolicy: "inherit-parent",
				...(diagnostics.length > 0 ? { diagnostics: Object.freeze([...diagnostics]) } : {}),
				source,
				sourcePath,
				canonicalPath: canonicalSourcePath,
				sourceHash: hashSource(bytes),
			};
			if (profiles.has(name)) {
				throw new SubagentError("untrusted_profile", `Duplicate configurable role name "${name}" in ${directory}.`);
			}
			profiles.set(name, profile);
		} catch (error) {
			if (!skipInvalid) throw error;
			listingDiagnostics?.push(profileListingDiagnostic(error, source, sourcePath));
		}
	}
	return profiles;
}

function _bundledProfileResolution(): ResolvedSubagentProfile {
	throw new SubagentError(
		"unknown_profile",
		"Bundled subagent roles were removed; use a file agent or self-delegation.",
	);
}

export function revalidateSubagentProfile(profile: ResolvedSubagentProfile): void {
	if (profile.source === "self") return;
	let currentPath: string;
	try {
		currentPath = canonicalPath(profile.sourcePath);
	} catch {
		throw new SubagentError("untrusted_profile", `Role source changed or disappeared: ${profile.name}`);
	}
	if (currentPath !== profile.canonicalPath || hashSource(readFileSync(currentPath)) !== profile.sourceHash) {
		throw new SubagentError("untrusted_profile", `Role source hash changed: ${profile.name}`);
	}
}

function hasRoleFile(directory: string | undefined, role: string): boolean {
	return directory !== undefined && existsSync(join(directory, `${role}.md`));
}

export function resolveSubagentProfile(role: string, options?: SubagentProfileResolutionOptions): SubagentProfile {
	if (options) return resolveSubagentProfileResolution(role, options);
	throw new SubagentError(
		"unknown_profile",
		`Subagent profile "${role}" requires explicit resolution options (cwd/agentDir); bundled roles were removed.`,
	);
}

export function resolveSubagentProfileResolution(
	role: string,
	options: SubagentProfileResolutionOptions,
): ResolvedSubagentProfile {
	const normalizedRole = role.trim().toLowerCase();
	if (normalizedRole === "self") return resolveSelfSubagentProfile(options);
	const userAgentsDir = resolveSubagentAgentDirectories(options.agentDir).globalAgentsDir;
	const projectAgentsDir = findNearestDirectory(options.cwd, join(CONFIG_DIR_NAME, "agents"));
	const userProfiles = loadProfilesFromDirectory(userAgentsDir, "user", normalizedRole);
	const projectProfiles =
		options.projectTrusted && projectAgentsDir
			? loadProfilesFromDirectory(projectAgentsDir, "project", normalizedRole, userProfiles.has(normalizedRole))
			: new Map<string, ResolvedSubagentProfile>();
	// Global-first: an exact user(global) definition always wins over a trusted
	// project definition with the same name. There is no bundled fallback and no
	// alias indirection; unknown names fail with a discovery hint.
	const userProfile = userProfiles.get(normalizedRole);
	const projectProfile = projectProfiles.get(normalizedRole);
	if (userProfile) {
		if (projectProfile) {
			return {
				...userProfile,
				diagnostics: Object.freeze([
					...(userProfile.diagnostics ?? []),
					`shadowed trusted project definition: ${projectProfile.sourcePath}`,
				]),
			};
		}
		return userProfile;
	}
	if (!options.projectTrusted && hasRoleFile(projectAgentsDir, normalizedRole)) {
		throw new SubagentError("untrusted_profile", `Project role "${normalizedRole}" requires project trust.`);
	}
	if (projectProfile) return projectProfile;
	const suggestions = suggestSubagentProfiles(normalizedRole, options);
	const hint =
		suggestions.length > 0
			? ` Available profiles: ${suggestions.join(", ")}.`
			: " Use list_subagent_profiles to discover valid file agents (bundled roles were removed).";
	throw new SubagentError("unknown_profile", `Unknown subagent profile "${role}".${hint}`);
}

function profileDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		let diagonal = previous[0]!;
		previous[0] = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			const above = previous[rightIndex]!;
			previous[rightIndex] =
				left[leftIndex - 1] === right[rightIndex - 1]
					? diagonal
					: 1 + Math.min(diagonal, above, previous[rightIndex - 1]!);
			diagonal = above;
		}
	}
	return previous[right.length]!;
}

export function validateSelectedMcpTools(tools: readonly string[]): void {
	if (tools.length === 0 || tools.length > 16) {
		throw new SubagentError("malformed_result", "Selected MCP tools must contain 1-16 entries.");
	}
	for (const tool of tools) {
		if (
			typeof tool !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(tool) ||
			Buffer.byteLength(tool) > 256
		) {
			throw new SubagentError(
				"malformed_result",
				"Selected MCP tools must use exact server/tool identifiers (server/tool).",
			);
		}
	}
}

interface ResolvedSubagentMcpRuntime {
	dispatch?: IceSubagentMcpAdapter["dispatch"];
	parentMcpTools?: readonly string[];
	mcpToolAccess?: ReadonlyMap<string, IceSubagentMcpToolAccess>;
}

function snapshotMcpAdapter(adapter: IceSubagentMcpAdapter): {
	tools: readonly string[];
	access: ReadonlyMap<string, IceSubagentMcpToolAccess>;
} {
	let entries: readonly IceSubagentMcpToolAuthorization[];
	try {
		entries = adapter.listAuthorizedTools();
	} catch (error) {
		throw new SubagentError(
			"capability_denied",
			`Parent MCP adapter authorization could not be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!Array.isArray(entries) || entries.length > 64) {
		throw new SubagentError("capability_denied", "Parent MCP adapter returned an invalid authorization snapshot.");
	}
	const access = new Map<string, IceSubagentMcpToolAccess>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || typeof entry.selector !== "string") {
			throw new SubagentError("capability_denied", "Parent MCP adapter returned an invalid tool selector.");
		}
		validateSelectedMcpTools([entry.selector]);
		if (entry.access !== "read-only" && entry.access !== "mutation" && entry.access !== "unknown") {
			throw new SubagentError(
				"capability_denied",
				`Parent MCP adapter returned invalid access for ${entry.selector}.`,
			);
		}
		if (access.has(entry.selector)) {
			throw new SubagentError(
				"capability_denied",
				`Parent MCP adapter returned duplicate selector ${entry.selector}.`,
			);
		}
		access.set(entry.selector, entry.access);
	}
	return { tools: Object.freeze([...access.keys()]), access };
}

export function resolveSubagentMcpRuntime(
	options: {
		adapter?: IceSubagentMcpAdapter;
		dispatch?: IceSubagentMcpAdapter["dispatch"];
		parentMcpTools?: readonly string[];
		mcpToolAccess?: ReadonlyMap<string, IceSubagentMcpToolAccess>;
	},
	selected: readonly string[],
	unsafeHostExec: boolean,
): ResolvedSubagentMcpRuntime {
	const fromAdapter = selected.length > 0 && options.adapter ? snapshotMcpAdapter(options.adapter) : undefined;
	const dispatch = options.dispatch ?? (options.adapter ? options.adapter.dispatch.bind(options.adapter) : undefined);
	const parentMcpTools = options.parentMcpTools ?? fromAdapter?.tools;
	const mcpToolAccess = options.mcpToolAccess ?? fromAdapter?.access;
	if (selected.length === 0) return { dispatch, parentMcpTools, mcpToolAccess };
	validateSelectedMcpTools(selected);
	if (!dispatch) {
		throw new SubagentError(
			"capability_denied",
			"Selected MCP tools require a parent-owned adapter dispatch for this invocation.",
		);
	}
	const parentMcp = new Set(parentMcpTools ?? []);
	for (const entry of selected) {
		if (!parentMcp.has(entry)) {
			throw new SubagentError(
				"capability_denied",
				`Selected MCP tool "${entry}" is not authorized by the parent adapter.`,
			);
		}
		const access = mcpToolAccess?.get(entry);
		if (access === undefined || access === "unknown") {
			throw new SubagentError(
				"capability_denied",
				`Selected MCP tool "${entry}" has no trusted parent access classification.`,
			);
		}
		if (!unsafeHostExec && access !== "read-only") {
			throw new SubagentError("capability_denied", `MCP mutation "${entry}" is not allowed for a read-only child.`);
		}
	}
	return { dispatch, parentMcpTools, mcpToolAccess };
}

export interface SelfSubagentSnapshotOptions extends SubagentProfileResolutionOptions {
	instructions?: string;
	capabilities?: readonly string[];
	parentSystemPrompt?: string;
	delegableTools?: readonly IceResolvedDelegableTool[];
}

/**
 * Self-delegation: a bounded parent-derived child without a file agent.
 * No user-supplied file is required; the caller supplies a bounded sanitized
 * instruction snapshot plus the eligible parent capability identities, and
 * policy/mode narrowing still applies at admission and dispatch.
 */
export function resolveSelfSubagentProfile(
	options: SelfSubagentSnapshotOptions = { cwd: process.cwd() },
): ResolvedSubagentProfile {
	if (options.instructions !== undefined && typeof options.instructions !== "string") {
		throw new SubagentError("malformed_result", "Self instructions must be text.");
	}
	const parent = (options.parentSystemPrompt ?? "").trim();
	const addition = (options.instructions ?? "").trim();
	if (Buffer.byteLength(addition) > 16 * 1024)
		throw new SubagentError("malformed_result", "Self instruction addition exceeds 16 KiB.");
	const instructions = [
		parent,
		addition && parent ? `Child task guidance (cannot replace parent policy):\n${addition}` : addition,
	]
		.filter(Boolean)
		.join("\n\n");
	if (!instructions || Buffer.byteLength(instructions) > 128 * 1024) {
		throw new SubagentError(
			"malformed_result",
			"Self-delegation requires bounded parent instructions (at most 128 KiB).",
		);
	}
	const known = new Set<string>([
		...SUBAGENT_REQUESTED_TOOL_NAMES,
		...(options.delegableTools ?? []).map((tool) => tool.name),
	]);
	const inherited = options.parentActiveTools?.filter((tool) => known.has(tool) && !isIceParentManagementTool(tool));
	const capabilities = options.capabilities ?? inherited ?? [...SUBAGENT_TOOL_NAMES];
	if (
		!Array.isArray(capabilities) ||
		capabilities.length > 32 ||
		capabilities.some((tool) => !isIceChildToolName(tool))
	) {
		throw new SubagentError("malformed_result", "Self-delegation capabilities must be bounded tool identifiers.");
	}
	if (capabilities.some((tool) => isIceParentManagementTool(tool))) {
		throw new SubagentError("capability_denied", "Self-delegation never inherits delegation/control tools.");
	}
	if (capabilities.some((tool) => !known.has(tool))) {
		throw new SubagentError(
			"capability_denied",
			"Self-delegation capabilities require recognized child tools or registered child-safe adapters.",
		);
	}
	if (
		capabilities.some((tool) =>
			["delegate", "delegate_async", "delegate_batch", "review_batch", "manage_subagent", "delegate_write"].includes(
				tool,
			),
		)
	) {
		throw new SubagentError("capability_denied", "Self-delegation never inherits delegation/control tools.");
	}
	const requestedTools = Object.freeze([...new Set(capabilities)] as SubagentRequestedToolName[]);
	return Object.freeze({
		name: "self",
		description: "Parent-derived bounded child (self-delegation).",
		systemPrompt: redactCredentialText(instructions),
		requestedTools,
		tools: requestedTools,
		thinkingLevel: "medium" as const,
		timeoutMs: 120_000,
		selfDelegated: true as const,
		modelPolicy: "inherit-parent" as const,
		source: "self" as const,
		sourcePath: "<self>",
		canonicalPath: "<self>",
		sourceHash: hashSource(instructions),
	});
}

function profileAvailability(
	profile: ResolvedSubagentProfile,
	effectiveTools: readonly string[],
	unsafeHostExec: boolean,
): SubagentProfileAvailability {
	const hasMissingCapabilities = profile.requestedTools.some(
		(tool) => !(effectiveTools as readonly string[]).includes(tool),
	);
	if (!hasMissingCapabilities) return "available";
	if (
		!unsafeHostExec &&
		profile.requestedTools.some((tool) => !SUBAGENT_TOOL_NAMES.includes(tool as SubagentToolName))
	) {
		return "requires_yolo";
	}
	return "limited";
}

function profileSummary(
	profile: ResolvedSubagentProfile,
	options: SubagentProfileResolutionOptions,
	availabilityOverride?: SubagentProfileAvailability,
	extraDiagnostics: readonly string[] = [],
): SubagentProfileSummary {
	const unsafeHostExec = options.unsafeHostExec === true;
	const parentActiveTools = options.parentActiveTools ?? SUBAGENT_REQUESTED_TOOL_NAMES;
	const effectiveTools = deriveEffectiveSubagentTools({
		requestedTools: profile.requestedTools,
		parentActiveTools,
		unsafeHostExec,
	});
	const diagnostics = [...(profile.diagnostics ?? []), ...extraDiagnostics].slice(0, 8);
	const requestedAdapters = profile.adapterIds ?? [];
	const effectiveAdapters: string[] = [];
	for (const tool of options.delegableTools ?? []) {
		const directToolRequested = profile.requestedTools.includes(tool.name);
		const adapterRequested = requestedAdapters.includes(tool.adapterId);
		if (
			(directToolRequested || adapterRequested) &&
			parentActiveTools.includes(tool.name) &&
			tool.isCurrent() &&
			(tool.access === "read-only" || (tool.access === "mutation" && unsafeHostExec))
		) {
			if (!(effectiveTools as string[]).includes(tool.name)) (effectiveTools as string[]).push(tool.name);
			if (adapterRequested && !effectiveAdapters.includes(tool.adapterId)) effectiveAdapters.push(tool.adapterId);
		}
	}
	const missingAdapters = requestedAdapters.filter((adapterId) => !effectiveAdapters.includes(adapterId));
	const toolClass = effectiveTools.length === 0 ? "none" : unsafeHostExec ? "host" : "read-only";
	const baseAvailability = profileAvailability(profile, effectiveTools, unsafeHostExec);
	const eligibilityNote =
		availabilityOverride ??
		(missingAdapters.length > 0 && baseAvailability === "available" ? "limited" : baseAvailability);
	const profileDiagnostics = [
		...diagnostics,
		`effective tool class for this invocation: ${toolClass}`,
		...(eligibilityNote === "requires_yolo"
			? ["profile requests host/mutation tools; requires explicit trusted YOLO authorization"]
			: []),
		...(eligibilityNote === "limited"
			? ["parent policy grants only a subset of the profile requested tools or adapters"]
			: []),
		...(missingAdapters.length > 0
			? [`parent policy does not currently grant adapter IDs: ${missingAdapters.join(", ")}`]
			: []),
	].slice(0, 10);
	return {
		name: profile.name,
		description: profile.description,
		source: profile.source,
		sourcePath: profile.sourcePath,
		...(profile.tags ? { tags: profile.tags } : {}),
		...(profile.color ? { color: profile.color } : {}),
		effectiveThinkingLevel: profile.thinkingLevel,
		effectiveCheckInIntervalMs: SUBAGENT_CHECKIN_INTERVAL_MS,
		effectiveTimeoutMs: profile.timeoutMs,
		...(profile.temperature !== undefined
			? { requestedTemperature: profile.temperature, effectiveTemperature: profile.temperature }
			: {}),
		...(profile.topP !== undefined ? { requestedTopP: profile.topP, effectiveTopP: profile.topP } : {}),
		effectiveSettingSources: Object.freeze({
			thinking: "bundled",
			checkInIntervalMs: "bundled",
			timeoutMs: "bundled",
			temperature: "bundled",
			topP: "bundled",
		}),
		profileDiagnostics: Object.freeze(profileDiagnostics),
		unsafeHostExec: profile.unsafeHostExec === true,
		requestedTools: profile.requestedTools,
		effectiveTools,
		...(requestedAdapters.length > 0 ? { requestedAdapters } : {}),
		...(effectiveAdapters.length > 0 ? { effectiveAdapters: Object.freeze([...effectiveAdapters]) } : {}),
		tools: profile.tools,
		availability: eligibilityNote,
		...(diagnostics.length > 0 ? { diagnostics: Object.freeze(diagnostics) } : {}),
		...(profile.requestedModel ? { requestedModel: profile.requestedModel } : {}),
		...(profile.fallbackModel ? { fallbackModel: profile.fallbackModel } : {}),
		...(profile.mcpTools ? { mcpTools: profile.mcpTools } : {}),
		...(profile.selfDelegated ? { selfDelegated: true as const } : {}),
	};
}

export function listSubagentProfiles(
	options: SubagentProfileResolutionOptions,
	query?: string,
): SubagentProfileSummary[] {
	const listingDiagnostics: ProfileListingDiagnostic[] = [];
	const userDirectories = resolveSubagentAgentDirectories(options.agentDir);
	const userProfiles = loadProfilesFromDirectory(
		userDirectories.globalAgentsDir,
		"user",
		undefined,
		true,
		listingDiagnostics,
	);
	const projectAgentsDir = findNearestDirectory(options.cwd, join(CONFIG_DIR_NAME, "agents"));
	const projectDiagnostics: ProfileListingDiagnostic[] = [];
	const projectProfiles = projectAgentsDir
		? loadProfilesFromDirectory(projectAgentsDir, "project", undefined, true, projectDiagnostics)
		: new Map<string, ResolvedSubagentProfile>();
	const profiles = new Map<string, ResolvedSubagentProfile>();
	const shadowedProjectSources = new Map<string, string>();
	// File agents only: global(user) definitions win on name collisions and the
	// shadowed trusted project source is surfaced in the listing diagnostics.
	for (const [name, profile] of userProfiles) profiles.set(name, profile);
	if (options.projectTrusted) {
		for (const [name, profile] of projectProfiles) {
			if (!profiles.has(name)) profiles.set(name, profile);
			else shadowedProjectSources.set(name, profile.sourcePath);
		}
	}
	const summaries: SubagentProfileSummary[] = [...profiles.values()]
		.filter((profile) => !profile.hidden)
		.map((profile) =>
			profileSummary(
				profile,
				options,
				undefined,
				shadowedProjectSources.has(profile.name)
					? [`shadowed trusted project definition: ${shadowedProjectSources.get(profile.name)}`]
					: [],
			),
		);
	if (options.includeSelf)
		summaries.unshift(
			profileSummary(
				resolveSelfSubagentProfile({
					...options,
					instructions: "Parent instruction snapshot is supplied at launch.",
				}),
				options,
			),
		);
	for (const diagnostic of listingDiagnostics) {
		summaries.push({
			name: diagnostic.name,
			description: diagnostic.description,
			source: diagnostic.source,
			sourcePath: diagnostic.sourcePath,
			unsafeHostExec: false,
			requestedTools: [],
			effectiveTools: [],
			tools: [],
			availability: diagnostic.availability,
			diagnostics: diagnostic.diagnostics,
		});
	}
	for (const migration of getSubagentAgentMigrationManifest(options.agentDir)) {
		summaries.push({
			name: migration.name,
			description: "Legacy global file agent is not loaded until explicitly migrated.",
			source: "user",
			sourcePath: migration.sourcePath,
			unsafeHostExec: false,
			requestedTools: [],
			effectiveTools: [],
			tools: [],
			availability: "invalid",
			diagnostics: Object.freeze([
				"Legacy global agents are not loaded through compatibility lookup.",
				`Explicit migration target: ${migration.destinationPath}${migration.conflict === "target-exists" ? " (collision; existing target is preserved)" : ""}`,
			]),
		});
	}
	for (const profile of projectProfiles.values()) {
		if (!options.projectTrusted && !profile.hidden) {
			summaries.push(
				profileSummary(profile, options, "untrusted", [
					"Project profile is hidden until project trust is established.",
				]),
			);
		}
	}
	for (const diagnostic of projectDiagnostics) {
		summaries.push({
			name: diagnostic.name,
			description: diagnostic.description,
			source: diagnostic.source,
			sourcePath: diagnostic.sourcePath,
			unsafeHostExec: false,
			requestedTools: [],
			effectiveTools: [],
			tools: [],
			availability: options.projectTrusted ? diagnostic.availability : "untrusted",
			diagnostics: options.projectTrusted
				? diagnostic.diagnostics
				: Object.freeze(["Project profile is hidden until project trust is established."]),
		});
	}
	const normalizedQuery = query?.trim().toLowerCase();
	return summaries
		.filter((profile) => {
			if (!normalizedQuery) return true;
			// W08: query matches names, descriptions, tags, and diagnostics without
			// loading profile system prompts or other executable resources.
			return `${profile.name} ${profile.description} ${(profile.tags ?? []).join(" ")} ${(profile.diagnostics ?? []).join(" ")} ${(profile.profileDiagnostics ?? []).join(" ")}`
				.toLowerCase()
				.includes(normalizedQuery);
		})
		.sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source))
		.slice(0, 64);
}

export function suggestSubagentProfiles(role: string, options: SubagentProfileResolutionOptions): string[] {
	let profiles: SubagentProfileSummary[];
	try {
		profiles = listSubagentProfiles(options);
	} catch {
		return [];
	}
	const normalizedRole = role.toLowerCase();
	return profiles
		.map((profile) => ({
			name: profile.name,
			rank: profile.name.toLowerCase().startsWith(normalizedRole)
				? -100
				: profile.description.toLowerCase().includes(normalizedRole)
					? -50
					: profileDistance(normalizedRole, profile.name.toLowerCase()),
		}))
		.sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name))
		.slice(0, 3)
		.map((profile) => profile.name);
}
