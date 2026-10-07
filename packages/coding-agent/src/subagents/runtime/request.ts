/** Subagent and writer request normalization, fork context, acceptance criteria, and execution overrides (moved from ice-subagents.ts). */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ImageContent, TextContent } from "@zykairotis/ice-ai";
import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { Skill } from "../../core/skills.ts";
import { redactCredentialText } from "../../utils/redact.ts";
import {
	hashSource,
	resolveSelfSubagentProfile,
	resolveSubagentProfileResolution,
	revalidateSubagentProfile,
	validateSelectedMcpTools,
} from "../definitions/legacy-profiles.ts";
import { normalizeSubagentHookIds } from "../extension-support.ts";
import { deriveSubagentAssuranceLevel, validateSubagentEvidenceClaims } from "../results/assurance.ts";
import { isRecord, normalizeSubagentOutputSchema } from "../results/report.ts";
import {
	buildSubagentTaskContract,
	deriveSubagentQualityMode,
	hashSubagentTaskContract,
	recommendSubagentReviewerGate,
	SUBAGENT_TASK_CONTRACT_LIMITS,
	type SubagentQualityMode,
	type SubagentTaskContract,
	type SubagentTaskContractKind,
} from "../results/task-contract.ts";
import {
	type IceContractCallInput,
	type IceHookContextAddition,
	type IceResolvedSubagentContract,
	parseIceSettings,
	resolveIceSubagentContract,
} from "../settings.ts";
import {
	type IceResolvedDelegableTool,
	isIceChildToolName,
	isIceParentManagementTool,
	resolveIceDelegableTools,
} from "../tools/adapters.ts";
import { canonicalPath, isPathWithin } from "../tools/paths.ts";
import { assertNoSymlinkComponents } from "../tools/scoped-tools.ts";
import {
	type NormalizedSubagentRequest,
	type NormalizedWriterRequest,
	type ResolvedSubagentProfile,
	type ResolvedSubagentResources,
	type SanitizedForkMessage,
	SUBAGENT_ACCEPTANCE_LIMITS,
	SUBAGENT_EXECUTION_LIMITS,
	SUBAGENT_FORK_CONTEXT_LIMITS,
	SUBAGENT_HANDOFF_CONTEXT_LIMITS,
	SUBAGENT_PROFILE_LIMITS,
	SUBAGENT_SCOPE_TARGET_HINT,
	SUBAGENT_SCOPE_TOOL_GUIDANCE,
	type SubagentAcceptanceCriterion,
	type SubagentAcceptanceCriterionInput,
	type SubagentContextItemInput,
	type SubagentContextPacket,
	type SubagentExecutionContract,
	type SubagentExecutionOverrideInput,
	type SubagentForkContext,
	type SubagentForkContextSource,
	type SubagentRequest,
	type SubagentResourceSelection,
	type SubagentResult,
	type SubagentVerification,
	type WriterRequest,
} from "../types.ts";
import { SUBAGENT_CHECKIN_INTERVAL_MS } from "./checkin.ts";
import { buildSubagentContextManifest } from "./context-bootstrap.ts";
import {
	invalidSubagentScope,
	invalidSubagentTarget,
	normalizeSubagentContextPacket,
	SubagentError,
} from "./helpers.ts";
import { normalizeSubagentPreflightRequirements } from "./preflight.ts";
import { truncateSubagentOutput } from "./prompt.ts";
import { MAX_SELECTED_RESOURCES_BYTES, resolveSubagentResources, revalidateSubagentResources } from "./resources.ts";

export interface SubagentNormalizationOptions {
	agentDir?: string;
	projectTrusted?: boolean;
	parentContext?: SubagentForkContextSource;
	allowExternal?: boolean;
	/** Reuse the parent SettingsManager so in-memory overrides and trust state are authoritative. */
	settingsManager?: SettingsManager;
	parentSystemPrompt?: string;
	parentActiveTools?: readonly string[];
	parentSkills?: readonly Skill[];
	delegableTools?: readonly IceResolvedDelegableTool[];
	unsafeHostExec?: boolean;
}

function forkMessageParts(message: { content?: unknown }): readonly unknown[] {
	if (!isRecord(message) || !("content" in message)) return [];
	const content = message.content;
	return typeof content === "string" ? [content] : Array.isArray(content) ? content : [];
}

function isTextContent(value: unknown): value is TextContent {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isImageContent(value: unknown): value is ImageContent {
	return isRecord(value) && value.type === "image";
}

function countForkImages(parts: readonly unknown[], dropped: { images: number }): void {
	for (const part of parts) {
		if (isImageContent(part)) dropped.images++;
	}
}

function emptySubagentForkContext(): SubagentForkContext {
	return Object.freeze({
		mode: "fresh" as const,
		messages: Object.freeze([]),
		totalBytes: 0,
		dropped: Object.freeze({ thinking: 0, toolCalls: 0, toolResults: 0, images: 0, custom: 0, empty: 0 }),
	});
}

export function normalizeSubagentForkContext(source: SubagentForkContextSource): SubagentForkContext {
	if (
		!source ||
		typeof source.getSessionId !== "function" ||
		typeof source.getLeafId !== "function" ||
		typeof source.buildSessionContext !== "function"
	) {
		throw new SubagentError("malformed_result", "Fork context source is invalid.");
	}
	const sourceSessionId = source.getSessionId();
	if (typeof sourceSessionId !== "string" || sourceSessionId.trim() === "") {
		throw new SubagentError("malformed_result", "Fork context source session ID must be nonempty.");
	}
	const sourceLeafId = source.getLeafId();
	if (sourceLeafId !== null && typeof sourceLeafId !== "string") {
		throw new SubagentError("malformed_result", "Fork context source leaf ID is invalid.");
	}
	const resolvedMessages = source.buildSessionContext().messages;
	if (!Array.isArray(resolvedMessages)) {
		throw new SubagentError("malformed_result", "Fork context source messages are invalid.");
	}
	const dropped = { thinking: 0, toolCalls: 0, toolResults: 0, images: 0, custom: 0, empty: 0 };
	const candidates: SanitizedForkMessage[] = [];

	for (const [index, message] of resolvedMessages.entries()) {
		if (!isRecord(message) || typeof message.role !== "string") {
			dropped.custom++;
			continue;
		}
		let role: SanitizedForkMessage["role"] | undefined;
		let content = "";
		if (message.role === "user" || message.role === "assistant") {
			role = message.role;
			const parts = forkMessageParts(message);
			const textParts: string[] = [];
			for (const part of parts) {
				if (typeof part === "string") {
					textParts.push(part);
					continue;
				}
				if (isTextContent(part)) {
					textParts.push(part.text);
					continue;
				}
				if (isImageContent(part)) {
					dropped.images++;
					continue;
				}
				if (isRecord(part) && part.type === "thinking") {
					dropped.thinking++;
					continue;
				}
				if (isRecord(part) && part.type === "toolCall") {
					dropped.toolCalls++;
					continue;
				}
				dropped.custom++;
			}
			content = textParts.join("\n");
		} else if (message.role === "branchSummary" || message.role === "compactionSummary") {
			role = "summary";
			content = typeof message.summary === "string" ? message.summary : "";
		} else if (message.role === "toolResult") {
			dropped.toolResults++;
			countForkImages(forkMessageParts(message), dropped);
			continue;
		} else {
			dropped.custom++;
			countForkImages(forkMessageParts(message), dropped);
			continue;
		}
		if (content.trim().length === 0) {
			dropped.empty++;
			continue;
		}
		const safeContent = truncateSubagentOutput(
			redactCredentialText(content),
			SUBAGENT_FORK_CONTEXT_LIMITS.maxMessageBytes,
		).text;
		candidates.push(
			Object.freeze({
				index,
				role,
				content: safeContent,
				bytes: Buffer.byteLength(safeContent),
			}),
		);
	}

	const selected = candidates.slice(-SUBAGENT_FORK_CONTEXT_LIMITS.maxMessages);
	let totalBytes = selected.reduce((total, message) => total + message.bytes, 0);
	while (selected.length > 0 && totalBytes > SUBAGENT_FORK_CONTEXT_LIMITS.maxTotalBytes) {
		const first = selected.shift()!;
		totalBytes -= first.bytes;
	}
	const messages = Object.freeze(selected);
	const frozenDropped = Object.freeze(dropped);
	return Object.freeze({
		mode: "fork" as const,
		sourceSessionId: sourceSessionId.trim(),
		...(sourceLeafId ? { sourceLeafId } : {}),
		messages,
		totalBytes,
		dropped: frozenDropped,
	});
}

export function assertSubagentHandoffContextBudget(
	contextPacket: SubagentContextPacket,
	forkContext: SubagentForkContext,
): void {
	const totalBytes = contextPacket.totalBytes + forkContext.totalBytes;
	if (totalBytes > SUBAGENT_HANDOFF_CONTEXT_LIMITS.maxTotalBytes) {
		throw new SubagentError(
			"invalid_request",
			`Combined subagent handoff context exceeds ${SUBAGENT_HANDOFF_CONTEXT_LIMITS.maxTotalBytes} bytes.`,
		);
	}
}

/**
 * Apply only the bounded context patch returned by an allowed beforeLaunch
 * hook. The patch is data-only: it cannot add tools, scope, resources, or
 * execution budget, and the resulting packet is normalized again before the
 * immutable launch contract is used.
 */
export function applySubagentHookContextAdditions(
	request: NormalizedSubagentRequest,
	additions: readonly IceHookContextAddition[],
): NormalizedSubagentRequest {
	if (additions.length === 0) return request;
	const usedIds = new Set(request.contextPacket.items.map((item) => item.id));
	const hookItems: SubagentContextItemInput[] = [];
	for (const [index, addition] of additions.entries()) {
		let id = `hook-context-${index + 1}`;
		let suffix = 1;
		while (usedIds.has(id)) id = `hook-context-${index + 1}-${suffix++}`;
		usedIds.add(id);
		hookItems.push({ id, kind: "parent_note", content: addition.content });
	}
	const contextPacket = normalizeSubagentContextPacket({
		items: [...request.contextPacket.items.map(({ id, kind, content }) => ({ id, kind, content })), ...hookItems],
	});
	assertSubagentHandoffContextBudget(contextPacket, request.forkContext);
	// The hook patch changes no authority-bearing field. Recheck the mutable
	// profile/resource/scope identities anyway so a concurrent source replacement
	// or deleted target cannot be hidden behind a successful context patch.
	revalidateSubagentProfile(request.profile);
	revalidateSubagentResources(request.resources);
	for (const root of request.scope.roots) {
		try {
			if (!statSync(root).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new SubagentError("invalid_scope", `Subagent scope root disappeared before launch: ${root}`);
		}
		if (!request.allowExternal && !isPathWithin(request.cwd, root)) {
			throw new SubagentError("invalid_scope", `Subagent scope root escaped the parent workspace: ${root}`);
		}
	}
	for (const target of request.scope.targets ?? []) {
		try {
			if (!statSync(target).isFile()) throw new Error("not a regular file");
		} catch {
			throw new SubagentError("invalid_scope", `Subagent scope target disappeared before launch: ${target}`);
		}
		if (!request.scope.roots.some((root) => isPathWithin(root, target))) {
			throw new SubagentError("invalid_scope", `Subagent scope target escaped its approved roots: ${target}`);
		}
	}
	return Object.freeze({ ...request, contextPacket });
}

function validateResourceSelection(
	selection: SubagentResourceSelection | undefined,
): SubagentResourceSelection | undefined {
	if (selection === undefined) return undefined;
	if (typeof selection !== "object" || selection === null) {
		throw new SubagentError("malformed_result", "Subagent resources must be an object.");
	}
	for (const key of ["skills", "prompts", "context"] as const) {
		const values = selection[key];
		if (
			values !== undefined &&
			(!Array.isArray(values) || values.length > 16 || values.some((value) => typeof value !== "string"))
		) {
			throw new SubagentError("malformed_result", `Subagent ${key} selections must be bounded string arrays.`);
		}
	}
	return selection;
}

function mergeResourceSelections(
	first: SubagentResourceSelection | undefined,
	second: SubagentResourceSelection | undefined,
): SubagentResourceSelection {
	const merge = (left: string[] | undefined, right: string[] | undefined): string[] | undefined => {
		const values = [...(left ?? []), ...(right ?? [])];
		return values.length > 0 ? [...new Set(values)] : undefined;
	};
	return {
		skills: merge(first?.skills, second?.skills),
		prompts: merge(first?.prompts, second?.prompts),
		context: merge(first?.context, second?.context),
	};
}

/**
 * Normalize untrusted parent-declared acceptance criteria into a bounded canonical form.
 * Deterministic handling: duplicate IDs are rejected, unknown report claim IDs are ignored,
 * and the first claim for any ID wins.
 */
export function normalizeSubagentAcceptanceCriteria(
	input: readonly SubagentAcceptanceCriterionInput[] | undefined,
): SubagentAcceptanceCriterion[] {
	if (input === undefined) return [];
	if (!Array.isArray(input)) {
		throw new SubagentError("invalid_request", "Subagent acceptance criteria must be an array.");
	}
	if (input.length > SUBAGENT_ACCEPTANCE_LIMITS.maxCriteria) {
		throw new SubagentError(
			"invalid_request",
			`Subagent acceptance criteria accept at most ${SUBAGENT_ACCEPTANCE_LIMITS.maxCriteria} entries.`,
		);
	}
	const normalized: SubagentAcceptanceCriterion[] = [];
	const seen = new Set<string>();
	let aggregateBytes = 0;
	for (const entry of input) {
		const criterion: unknown = entry;
		if (!isRecord(criterion)) {
			throw new SubagentError("invalid_request", "Each subagent acceptance criterion must be an object.");
		}
		const id = criterion.id;
		if (
			typeof id !== "string" ||
			id.length === 0 ||
			Buffer.byteLength(id) > SUBAGENT_ACCEPTANCE_LIMITS.maxIdBytes ||
			!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)
		) {
			throw new SubagentError(
				"invalid_request",
				"Subagent acceptance criterion IDs must be bounded safe identifiers.",
			);
		}
		if (seen.has(id)) {
			throw new SubagentError("invalid_request", `Subagent acceptance criterion IDs must be unique: ${id}`);
		}
		seen.add(id);
		const requirement = criterion.requirement;
		if (
			typeof requirement !== "string" ||
			requirement.trim().length === 0 ||
			Buffer.byteLength(requirement) > SUBAGENT_ACCEPTANCE_LIMITS.maxRequirementBytes
		) {
			throw new SubagentError(
				"invalid_request",
				`Subagent acceptance criterion ${id} requires a nonempty bounded requirement.`,
			);
		}
		const evidence = criterion.evidence;
		if (
			evidence !== undefined &&
			evidence !== "path" &&
			evidence !== "test" &&
			evidence !== "behavior" &&
			evidence !== "finding" &&
			evidence !== "none"
		) {
			throw new SubagentError(
				"invalid_request",
				`Subagent acceptance criterion ${id} has an unsupported evidence kind.`,
			);
		}
		const dimension = criterion.dimension;
		if (
			dimension !== undefined &&
			(typeof dimension !== "string" ||
				dimension.trim().length === 0 ||
				Buffer.byteLength(dimension) > SUBAGENT_ACCEPTANCE_LIMITS.maxDimensionBytes)
		) {
			throw new SubagentError("invalid_request", `Subagent acceptance criterion ${id} has an invalid dimension.`);
		}
		aggregateBytes += Buffer.byteLength(id) + Buffer.byteLength(requirement);
		if (aggregateBytes > SUBAGENT_ACCEPTANCE_LIMITS.maxAggregateBytes) {
			throw new SubagentError("invalid_request", "Subagent acceptance criteria exceed the aggregate byte budget.");
		}
		normalized.push({
			id,
			requirement: requirement.trim(),
			required: criterion.required !== false,
			// An undeclared evidence kind imposes no automatic path requirement; only
			// explicitly declared "path" criteria demand bounded declared evidence.
			evidence: evidence ?? "none",
			...(dimension !== undefined ? { dimension: dimension.trim() } : {}),
		});
	}
	return normalized;
}

/**
 * W12/W13: validate the shared per-call execution overrides. Every field is a
 * bounded request; unsupported thinking/model combinations fail before a child
 * run is consumed, and an empty tools array means no tools (never fallback).
 */
export function normalizeSubagentExecutionOverride(
	profile: Pick<ResolvedSubagentProfile, "thinkingLevel" | "temperature" | "topP">,
	execution: SubagentExecutionOverrideInput | undefined,
): SubagentExecutionContract {
	if (execution === undefined) {
		return Object.freeze({
			thinking: profile.thinkingLevel,
			tools: undefined,
			...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
			...(profile.topP !== undefined ? { topP: profile.topP } : {}),
		});
	}
	if (typeof execution !== "object" || execution === null || Array.isArray(execution)) {
		throw new SubagentError("malformed_result", "Subagent execution overrides must be an object.");
	}
	if (Object.hasOwn(execution, "maxOutputBytes")) {
		throw new SubagentError(
			"malformed_result",
			'"execution.maxOutputBytes" was removed; final-answer retention uses fixed host limits.',
		);
	}
	if (Object.hasOwn(execution, "maxTotalTokens")) {
		throw new SubagentError(
			"malformed_result",
			'"maxTotalTokens" was removed; use startupTimeoutMs and provider/model token limits.',
		);
	}
	for (const key of ["maxTurns", "maxToolCalls"] as const) {
		if (Object.hasOwn(execution, key)) {
			throw new SubagentError(
				"malformed_result",
				`"${key}" was removed; use startupTimeoutMs and provider/model token limits.`,
			);
		}
	}
	const allowed = new Set(["thinking", "tools", "temperature", "topP", "hooks", "model"]);
	if (
		execution.model !== undefined &&
		(typeof execution.model !== "string" ||
			!/^[^\s/]+\/[^\s]+$/.test(execution.model) ||
			execution.model.length > 256)
	) {
		throw new SubagentError("malformed_result", "Child model must be an exact bounded provider/model reference.");
	}
	if (execution.hooks !== undefined) normalizeSubagentHookIds(execution.hooks);
	for (const key of Object.keys(execution)) {
		if (!allowed.has(key)) {
			throw new SubagentError("malformed_result", `Unsupported execution field "${key}".`);
		}
	}
	if (
		execution.thinking !== undefined &&
		(typeof execution.thinking !== "string" ||
			!["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(execution.thinking))
	) {
		throw new SubagentError("malformed_result", "Subagent execution thinking must be a supported level.");
	}
	let tools: readonly string[] | undefined;
	if (execution.tools !== undefined) {
		if (!Array.isArray(execution.tools)) {
			throw new SubagentError("malformed_result", "Subagent execution tools must be an array.");
		}
		if (execution.tools.length > 32) {
			throw new SubagentError("malformed_result", "Subagent execution tools list is too large.");
		}
		const normalized: string[] = [];
		for (const tool of execution.tools) {
			if (typeof tool !== "string" || !tool.trim()) {
				throw new SubagentError("malformed_result", "Subagent execution tools must be nonempty strings.");
			}
			const candidate = tool.trim();
			if (!isIceChildToolName(candidate) || isIceParentManagementTool(candidate)) {
				throw new SubagentError("malformed_result", `Unknown execution tool "${tool}".`);
			}
			if (!normalized.includes(candidate)) normalized.push(candidate);
		}
		tools = Object.freeze(normalized);
	}
	const checkSampling = (
		value: number | undefined,
		label: string,
		minimum: number,
		maximum: number,
	): number | undefined => {
		if (value === undefined) return undefined;
		if (!Number.isFinite(value) || value < minimum || value > maximum) {
			throw new SubagentError("malformed_result", `Subagent execution ${label} is outside the bounded range.`);
		}
		return value;
	};
	const temperature = checkSampling(
		execution.temperature ?? profile.temperature,
		"temperature",
		SUBAGENT_EXECUTION_LIMITS.minTemperature,
		SUBAGENT_EXECUTION_LIMITS.maxTemperature,
	);
	const topP = checkSampling(
		execution.topP ?? profile.topP,
		"topP",
		SUBAGENT_EXECUTION_LIMITS.minTopP,
		SUBAGENT_EXECUTION_LIMITS.maxTopP,
	);
	return Object.freeze({
		thinking: execution.thinking ?? profile.thinkingLevel,
		tools,
		...(temperature !== undefined ? { temperature } : {}),
		...(topP !== undefined ? { topP } : {}),
	});
}

function resolveIceContractForRequest(
	request: SubagentRequest,
	profile: ResolvedSubagentProfile,
	cwd: string,
	options: SubagentNormalizationOptions,
	validatedExecution: SubagentExecutionContract,
	projectTrusted: boolean,
): IceResolvedSubagentContract {
	const manager =
		options.settingsManager ??
		SettingsManager.create(cwd, options.agentDir ?? getAgentDir(), {
			projectTrusted,
		});
	const managerTrusted = manager.isProjectTrusted();
	const effectiveProjectTrusted = projectTrusted && managerTrusted;
	const loadError = manager
		.getLoadErrors()
		.find((error) => error.scope === "global" || (error.scope === "project" && effectiveProjectTrusted));
	if (loadError) {
		throw new SubagentError(
			"capability_denied",
			`ICE settings are invalid in the ${loadError.scope} scope; delegation is blocked until the file is repaired.`,
		);
	}
	const globalSettings = parseIceSettings(manager.getGlobalSettings().ice).subagents;
	const projectSettings = parseIceSettings(manager.getProjectSettings().ice).subagents;
	if (
		request.checkInIntervalMs !== undefined &&
		(!Number.isSafeInteger(request.checkInIntervalMs) || request.checkInIntervalMs < SUBAGENT_CHECKIN_INTERVAL_MS)
	)
		throw new SubagentError(
			"malformed_result",
			`checkInIntervalMs must be an integer of at least ${SUBAGENT_CHECKIN_INTERVAL_MS} ms.`,
		);
	const call: IceContractCallInput = {};
	if (request.checkInIntervalMs !== undefined) call.checkInIntervalMs = request.checkInIntervalMs;
	if (request.timeoutMs !== undefined) call.startupTimeoutMs = request.timeoutMs;
	if (request.execution?.thinking !== undefined) call.thinking = validatedExecution.thinking;
	if (request.execution?.temperature !== undefined) call.temperature = validatedExecution.temperature;
	if (request.execution?.topP !== undefined) call.topP = validatedExecution.topP;
	const contract = resolveIceSubagentContract({
		global: globalSettings,
		project: projectSettings,
		globalFirst: true,
		projectTrusted: effectiveProjectTrusted,
		role: profile.name,
		call,
		bundledDefaults: {
			thinking: profile.thinkingLevel,
			checkInIntervalMs: SUBAGENT_CHECKIN_INTERVAL_MS,
			startupTimeoutMs: profile.timeoutMs,
			temperature: profile.temperature,
			topP: profile.topP,
		},
	});
	return contract;
}

function inheritSubagentSkillResources(
	resources: ResolvedSubagentResources,
	skills: readonly Skill[],
	projectTrusted: boolean,
): void {
	const byName = new Map(resources.skills.map((resource) => [resource.name, resource]));
	for (const skill of skills) {
		if (byName.has(skill.name)) continue;
		if (byName.size >= 16)
			throw new SubagentError("untrusted_resource", "Inherited skills exceed 16; select skills explicitly.");
		const source = skill.sourceInfo?.scope === "project" ? "project" : "user";
		if (source === "project" && !projectTrusted)
			throw new SubagentError("untrusted_resource", "Inherited project skills require trust.");
		const path = canonicalPath(skill.filePath);
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > 64 * 1024)
			throw new SubagentError("untrusted_resource", "Inherited skill is not a bounded regular file.");
		const bytes = readFileSync(path);
		byName.set(skill.name, {
			kind: "skill",
			name: skill.name,
			source,
			sourcePath: skill.filePath,
			canonicalPath: path,
			sourceHash: hashSource(bytes),
		});
	}
	resources.skills = [...byName.values()];
	const total = [...resources.skills, ...resources.prompts, ...resources.context].reduce(
		(bytes, resource) => bytes + statSync(resource.canonicalPath).size,
		0,
	);
	if (total > MAX_SELECTED_RESOURCES_BYTES)
		throw new SubagentError("untrusted_resource", "Inherited resources exceed the aggregate 512 KiB budget.");
}

export function normalizeSubagentRequest(
	request: SubagentRequest,
	cwd = request.cwd ?? process.cwd(),
	options: SubagentNormalizationOptions = {},
): NormalizedSubagentRequest {
	if (typeof request.parentSessionId !== "string" || request.parentSessionId.length === 0) {
		throw new SubagentError("malformed_result", "Subagent parent session ID must be nonempty.");
	}
	if (
		typeof request.task !== "string" ||
		request.task.trim().length === 0 ||
		Buffer.byteLength(request.task) > 16 * 1024
	) {
		throw new SubagentError("malformed_result", "Subagent task must be nonempty and at most 16 KiB.");
	}
	const contextPacket = normalizeSubagentContextPacket(request.contextPacket, request.context);
	const contextMode = request.contextMode ?? "fresh";
	if (contextMode !== "fresh" && contextMode !== "fork") {
		throw new SubagentError("malformed_result", "Subagent context mode must be fresh or fork.");
	}
	const forkContext =
		contextMode === "fork"
			? options.parentContext
				? normalizeSubagentForkContext(options.parentContext)
				: (() => {
						throw new SubagentError("malformed_result", "Fork context requires the parent session context.");
					})()
			: emptySubagentForkContext();
	assertSubagentHandoffContextBudget(contextPacket, forkContext);
	if (
		request.timeoutMs !== undefined &&
		(typeof request.timeoutMs !== "number" || !Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)
	) {
		throw new SubagentError("malformed_result", "Subagent timeout must be a positive finite number.");
	}

	const resolvedCwd = canonicalPath(resolve(cwd));
	const projectTrusted = options.projectTrusted ?? false;
	if (typeof request.role !== "string" || !request.role.trim())
		throw new SubagentError("unknown_profile", "A file agent name or self is required.");
	const normalizedRole = request.role.trim().toLowerCase();
	const isSelf = normalizedRole === "self";
	const profile = isSelf
		? resolveSelfSubagentProfile({
				cwd: resolvedCwd,
				agentDir: options.agentDir,
				projectTrusted,
				instructions: request.self?.instructions,
				capabilities: request.self?.capabilities,
				parentSystemPrompt: options.parentSystemPrompt,
				parentActiveTools: options.parentActiveTools,
				delegableTools: options.delegableTools,
			})
		: resolveSubagentProfileResolution(request.role, {
				cwd: resolvedCwd,
				agentDir: options.agentDir,
				projectTrusted,
			});
	if (isSelf && request.self?.capabilities?.some((tool) => typeof tool !== "string")) {
		throw new SubagentError("malformed_result", "Self-delegation capabilities must be strings.");
	}
	const selectedMcpTools =
		request.execution?.tools?.length === 0 ? undefined : isSelf ? request.self?.mcp : profile.mcpTools;
	const selectedAdapterIds = request.execution?.tools?.length === 0 ? undefined : profile.adapterIds;
	if (request.self?.inheritSkills !== undefined && typeof request.self.inheritSkills !== "boolean") {
		throw new SubagentError("malformed_result", "inheritSkills must be boolean.");
	}
	if (selectedMcpTools) validateSelectedMcpTools(selectedMcpTools);
	const requestResources = validateResourceSelection(request.resources);
	const resources = resolveSubagentResources(mergeResourceSelections(profile.resources, requestResources), {
		cwd: resolvedCwd,
		agentDir: options.agentDir,
		projectTrusted,
	});
	if (isSelf && request.self?.inheritSkills)
		inheritSubagentSkillResources(resources, options.parentSkills ?? [], projectTrusted);
	if (!request.scope || !Array.isArray(request.scope.roots) || request.scope.roots.length === 0) {
		throw invalidSubagentScope("Subagent scope must contain at least one root.", undefined, undefined, resolvedCwd);
	}
	if (request.scope.roots.length > 16) {
		throw invalidSubagentScope(
			"Subagent scope cannot contain more than 16 roots.",
			undefined,
			undefined,
			resolvedCwd,
		);
	}

	const roots: string[] = [];
	for (const root of request.scope.roots) {
		if (typeof root !== "string" || root.length === 0 || Buffer.byteLength(root) > 4096) {
			throw invalidSubagentScope(
				`Each subagent scope root must be a nonempty path up to 4 KiB. ${SUBAGENT_SCOPE_TOOL_GUIDANCE}`,
				typeof root === "string" ? root : undefined,
				undefined,
				resolvedCwd,
			);
		}
		let resolvedRoot: string;
		try {
			resolvedRoot = canonicalPath(resolve(resolvedCwd, root));
		} catch (error) {
			throw invalidSubagentScope(
				`Cannot resolve subagent scope root "${root}": ${error instanceof Error ? error.message : String(error)}`,
				root,
				undefined,
				resolvedCwd,
			);
		}
		try {
			if (!statSync(resolvedRoot).isDirectory()) {
				throw invalidSubagentScope(
					`Subagent scope root "${root}" is not a directory. ${SUBAGENT_SCOPE_TOOL_GUIDANCE}`,
					root,
					undefined,
					resolvedCwd,
				);
			}
		} catch (error) {
			if (error instanceof SubagentError) throw error;
			throw invalidSubagentScope(
				`Cannot inspect subagent scope root "${root}": ${error instanceof Error ? error.message : String(error)}`,
				root,
				undefined,
				resolvedCwd,
			);
		}
		if (!options.allowExternal && !isPathWithin(resolvedCwd, resolvedRoot)) {
			throw invalidSubagentScope(
				`Subagent scope root "${root}" is outside the parent workspace. ${SUBAGENT_SCOPE_TOOL_GUIDANCE}`,
				root,
				undefined,
				resolvedCwd,
			);
		}
		if (!roots.includes(resolvedRoot)) roots.push(resolvedRoot);
	}

	const targets: string[] = [];
	if (request.scope.targets !== undefined) {
		if (!Array.isArray(request.scope.targets)) {
			throw invalidSubagentTarget("Subagent scope targets must be an array.");
		}
		if (request.scope.targets.length > 16) {
			throw invalidSubagentTarget("Subagent scope cannot contain more than 16 targets.");
		}
		for (const target of request.scope.targets) {
			if (typeof target !== "string" || target.length === 0 || Buffer.byteLength(target) > 4096) {
				throw invalidSubagentTarget(
					`Each subagent scope target must be a nonempty regular-file path up to 4 KiB. ${SUBAGENT_SCOPE_TARGET_HINT}`,
					typeof target === "string" ? target : undefined,
				);
			}
			if (target.split(/[\\/]/).includes("..")) {
				throw invalidSubagentTarget(
					`Subagent scope target "${target}" contains traversal components. ${SUBAGENT_SCOPE_TARGET_HINT}`,
					target,
				);
			}
			const candidate = resolve(resolvedCwd, target);
			let resolvedTarget: string;
			try {
				assertNoSymlinkComponents(candidate);
				resolvedTarget = canonicalPath(candidate);
				assertNoSymlinkComponents(resolvedTarget);
			} catch (error) {
				throw invalidSubagentTarget(
					`Cannot resolve subagent scope target "${target}": ${error instanceof Error ? error.message : String(error)}`,
					target,
				);
			}
			try {
				if (!statSync(resolvedTarget).isFile()) {
					throw invalidSubagentTarget(
						`Subagent scope target "${target}" is not a regular file. ${SUBAGENT_SCOPE_TARGET_HINT}`,
						target,
					);
				}
			} catch (error) {
				if (error instanceof SubagentError) throw error;
				throw invalidSubagentTarget(
					`Cannot inspect subagent scope target "${target}": ${error instanceof Error ? error.message : String(error)}`,
					target,
				);
			}
			if (!roots.some((root) => isPathWithin(root, resolvedTarget))) {
				throw invalidSubagentTarget(
					`Subagent scope target "${target}" is outside the approved scope roots. ${SUBAGENT_SCOPE_TARGET_HINT}`,
					target,
				);
			}
			if (!targets.includes(resolvedTarget)) targets.push(resolvedTarget);
		}
	}

	const execution = normalizeSubagentExecutionOverride(profile, request.execution);
	const outputSchema = normalizeSubagentOutputSchema(request.outputSchema);
	const iceContract = resolveIceContractForRequest(request, profile, resolvedCwd, options, execution, projectTrusted);
	if (iceContract.denied) {
		throw new SubagentError("capability_denied", iceContract.denied.message);
	}
	const requestedTools = execution.tools === undefined ? undefined : [...execution.tools];
	const delegatedTools = resolveIceDelegableTools({
		available: options.delegableTools ?? [],
		parentActiveTools: options.parentActiveTools ?? [],
		requested: (requestedTools ?? profile.requestedTools).filter((tool) => profile.requestedTools.includes(tool)),
		requestedAdapterIds: selectedAdapterIds,
		denied: iceContract.deniedTools,
		allowMutation: options.unsafeHostExec === true && projectTrusted,
	});
	const executionThinkingExplicit =
		typeof request.execution === "object" &&
		request.execution !== null &&
		!Array.isArray(request.execution) &&
		(request.execution as SubagentExecutionOverrideInput).thinking !== undefined;
	const resolvedExecution: SubagentExecutionContract = Object.freeze({
		thinking: iceContract.values.thinking,
		tools: requestedTools,
		...(iceContract.values.temperature !== undefined ? { temperature: iceContract.values.temperature } : {}),
		...(iceContract.values.topP !== undefined ? { topP: iceContract.values.topP } : {}),
	});
	const acceptanceCriteria = normalizeSubagentAcceptanceCriteria(request.acceptanceCriteria);

	return {
		runId: randomUUID(),
		parentSessionId: request.parentSessionId,
		role: profile.name,
		agentKind: isSelf ? "self" : "file",
		delegatedTools,
		inheritedSkills: isSelf && request.self?.inheritSkills === true,
		contextMode,
		profile,
		...(request.execution?.hooks !== undefined ? { hookIds: normalizeSubagentHookIds(request.execution.hooks) } : {}),
		// Route precedence: explicit execution model > semantic tier alias >
		// configured/default parent route. The tier fills only an unset route
		// and must never replace an explicit execution.model.
		...(request.execution?.model !== undefined
			? { requestedModel: request.execution.model }
			: resolveQualityTierRoute(request.kind, iceContract)),
		...(request.kind !== undefined ? { semanticWorkerTier: SUBAGENT_TASK_KIND_ROUTE_TIER[request.kind] } : {}),
		routeSource:
			request.execution?.model !== undefined
				? "explicit"
				: resolveQualityTierRoute(request.kind, iceContract) !== undefined
					? "tier"
					: "parent",
		...(profile.fallbackModel ? { fallbackModel: profile.fallbackModel } : {}),
		...(selectedMcpTools ? { selectedMcpTools: Object.freeze([...selectedMcpTools]) } : {}),
		...(selectedAdapterIds ? { selectedAdapterIds: Object.freeze([...selectedAdapterIds]) } : {}),
		task: request.task.trim(),
		scope: targets.length > 0 ? { roots, targets } : { roots },
		cwd: resolvedCwd,
		// Phase 2: deterministic read-only instruction-chain and orientation
		// manifest for the approved scope; metadata only, never executable
		// authority, and the child reads file content through scoped tools.
		contextManifest: buildSubagentContextManifest({
			cwd: resolvedCwd,
			roots,
			...(targets.length > 0 ? { targets } : {}),
		}),
		contextPacket,
		forkContext,
		// Public tool schemas reject values below minTimeoutMs; retain the low-level
		// runner's existing positive-value behavior for deterministic short-timeout tests.
		checkInIntervalMs: iceContract.values.checkInIntervalMs,
		timeoutMs: Math.min(Math.max(iceContract.values.timeoutMs, 1), SUBAGENT_PROFILE_LIMITS.maxTimeoutMs),
		execution: resolvedExecution,
		executionThinkingExplicit,
		requestedTools: requestedTools === undefined ? undefined : Object.freeze(requestedTools),
		deniedTools: iceContract.deniedTools,
		iceContract,
		resources,
		projectTrusted,
		allowExternal: options.allowExternal === true,
		acceptanceCriteria,
		preflight: normalizeSubagentPreflightRequirements(request.preflight),
		...(outputSchema ? { outputSchema } : {}),
		// Typed flows (output schema, acceptance criteria) keep the strict JSON
		// report protocol; ordinary delegations ingest the natural final turn.
		reportMode:
			outputSchema !== undefined || acceptanceCriteria.length > 0 ? "structured_report" : "plain_final_turn",
		...buildNormalizedTaskContract(request, {
			objective: request.task.trim(),
			hasAcceptanceCriteria: acceptanceCriteria.length > 0,
			hasOutputSchema: outputSchema !== undefined,
		}),
	};
}

/**
 * Phase 1: derive the host-owned delegation task contract and quality mode at
 * normalization. The contract is task semantics only — it never widens scope,
 * tools, models, or credentials — and verified parent facts from the context
 * packet become bounded known-fact entries.
 */
function buildNormalizedTaskContract(
	request: Pick<
		SubagentRequest,
		"kind" | "deliverable" | "constraints" | "nonGoals" | "verification" | "contextPacket"
	>,
	context: { objective: string; hasAcceptanceCriteria: boolean; hasOutputSchema: boolean },
): { taskContract: SubagentTaskContract; qualityMode: SubagentQualityMode; taskContractHash: string } {
	const verifiedFacts = (request.contextPacket?.items ?? [])
		.filter((item) => item.kind === "verified_fact")
		.slice(0, SUBAGENT_TASK_CONTRACT_LIMITS.maxListItems)
		.map((item) => ({ id: item.id, text: item.content }));
	const contract = buildSubagentTaskContract(context.objective, {
		kind: request.kind,
		deliverable: request.deliverable,
		constraints: request.constraints,
		nonGoals: request.nonGoals,
		knownFacts: verifiedFacts,
		verification: request.verification,
	});
	const qualityMode = deriveSubagentQualityMode(contract, {
		hasAcceptanceCriteria: context.hasAcceptanceCriteria,
		hasOutputSchema: context.hasOutputSchema,
		defaultedKind: request.kind === undefined,
	});
	return {
		taskContract: contract,
		qualityMode,
		taskContractHash: hashSubagentTaskContract(contract),
	};
}

/**
 * Phase 3: map a task kind onto its configured quality tier route. Explicit
 * execution.model always wins; an unset tier leaves parent-model inheritance.
 */
const SUBAGENT_TASK_KIND_ROUTE_TIER: Readonly<Record<SubagentTaskContractKind, "mechanical" | "judgment">> =
	Object.freeze({
		explore: "mechanical",
		research: "judgment",
		review: "judgment",
		implement: "judgment",
		verify: "judgment",
	});

function resolveQualityTierRoute(
	kind: SubagentTaskContractKind | undefined,
	iceContract: IceResolvedSubagentContract,
): { requestedModel: string } | undefined {
	if (kind === undefined) return undefined;
	const route = iceContract.routeTiers[SUBAGENT_TASK_KIND_ROUTE_TIER[kind]];
	return route !== undefined ? { requestedModel: route } : undefined;
}

/** Host-owned bounded repair policy (Phase 4.3): distinct follow-ups per live run. */
export const SUBAGENT_FOLLOW_UP_LIMIT = 3;
export const SUBAGENT_FOLLOW_UP_STATE_ENTRY_TYPE = "ice-subagent-follow-up-v1";

export interface SubagentFollowUpStateSnapshot {
	schemaVersion: 1;
	ownerSessionId: string;
	runId: string;
	requestIds: readonly string[];
}

export function boundFollowUpBudget(requestIds: Set<string>): void {
	if (requestIds.size >= SUBAGENT_FOLLOW_UP_LIMIT) {
		throw new SubagentError(
			"follow_up_budget_exhausted",
			`The bounded repair budget for this run is spent (${SUBAGENT_FOLLOW_UP_LIMIT} follow-ups); stop, resume, or accept the unresolved result.`,
		);
	}
}

/**
 * Phase 5: derive the descriptive assurance level from runtime-observed state.
 * Plain-mode results are capped at `unverified_plain`; declared verification
 * commands count only when the child actually executed them successfully.
 */
export function annotateSubagentAssurance(
	result: SubagentResult,
	verification: SubagentVerification,
	normalized: NormalizedSubagentRequest,
	observedBashCommands: readonly { command: string }[],
	observedPaths: readonly string[],
	options: { followUpCount: number; repeatedFailureCount: number },
): SubagentResult {
	const declared = (normalized.taskContract.verification.commands ?? [])
		.map((command) => command.replace(/\s+/g, " ").trim())
		.filter((command) => command.length > 0);
	const verificationCommandObserved =
		declared.length > 0 &&
		declared.some((command) =>
			observedBashCommands.some((observed) => observed.command.replace(/\s+/g, " ").trim() === command),
		);
	// Phase 5.3: claimed evidence paths must trace back to runtime-observed tool
	// activity; existence and scope alone cannot raise the assurance level.
	const evidenceClaims = validateSubagentEvidenceClaims(
		(result.evidence?.paths ?? []).map((path, index) => ({ kind: "path" as const, id: `e${index}`, path })),
		{
			observedPaths,
			observedCommands: [],
			ownedArtifactIds: result.output?.artifact ? [result.output.artifact.id] : [],
		},
	);
	const evidenceChecked = evidenceClaims.fabricatedIds.length === 0 && evidenceClaims.verifiedIds.length > 0;
	const requiredStates = result.requirementStates?.filter((state) => state.required) ?? [];
	const assurance = deriveSubagentAssuranceLevel({
		reportMode: normalized.reportMode,
		evidenceChecked,
		requiredCriteriaAllVerified: requiredStates.length > 0 && requiredStates.every((state) => state.verified),
		verificationCommandObserved,
		verificationCommandPassed: verificationCommandObserved,
		reviewerVerified: normalized.readOnlyReview === true && verification.verified,
	});
	return {
		...result,
		assurance,
		followUpCount: options.followUpCount,
		repeatedFailureCount: options.repeatedFailureCount,
		reviewerUsed: normalized.readOnlyReview === true,
		reviewerOutcome:
			normalized.readOnlyReview === true ? (verification.verified ? "verified" : "disagreed") : undefined,
		reviewerGateRecommended: recommendSubagentReviewerGate(normalized.taskContract) !== undefined,
		semanticWorkerTier: normalized.semanticWorkerTier,
		routeSource: normalized.routeSource,
		evidenceTypes: {
			path: evidenceClaims.verifiedIds.length,
			command: observedBashCommands.length,
			artifact: result.output?.artifact ? 1 : 0,
			diff: result.workArtifact?.touchedPaths.length ?? 0,
			blocked: result.partial || verification.unresolvedClaims.length > 0 ? 1 : 0,
		},
	};
}

const WRITER_DEFAULT_TIMEOUT_MS = 60_000;
export const WRITER_MAX_TIMEOUT_MS = 10 * 60 * 1000;
export const MANAGED_WRITER_LIMITS = { maxActive: 4, retained: 16 } as const;

export function normalizeWriterRequest(
	request: WriterRequest,
	cwd = request.cwd ?? process.cwd(),
	options: Pick<SubagentNormalizationOptions, "allowExternal"> = {},
): NormalizedWriterRequest {
	if (typeof request.parentSessionId !== "string" || request.parentSessionId.length === 0) {
		throw new SubagentError("malformed_result", "Writer parent session ID must be nonempty.");
	}
	if (
		typeof request.task !== "string" ||
		request.task.trim().length === 0 ||
		Buffer.byteLength(request.task) > 16 * 1024
	) {
		throw new SubagentError("malformed_result", "Writer task must be nonempty and at most 16 KiB.");
	}
	if (typeof request.baseCommit !== "string" || !/^[0-9a-f]{40}$/.test(request.baseCommit)) {
		throw new SubagentError("writer_precondition", "Writer baseCommit must be a full 40-character lowercase SHA.");
	}
	if (
		request.timeoutMs !== undefined &&
		(typeof request.timeoutMs !== "number" || !Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)
	) {
		throw new SubagentError("malformed_result", "Writer timeout must be a positive finite number.");
	}
	if (Object.hasOwn(request, "maxOutputBytes")) {
		throw new SubagentError(
			"malformed_result",
			'"maxOutputBytes" was removed; writer final-answer retention uses fixed host limits.',
		);
	}
	const resolvedCwd = canonicalPath(resolve(cwd));
	if (!request.scope || !Array.isArray(request.scope.roots) || request.scope.roots.length === 0) {
		throw new SubagentError("invalid_scope", "Writer scope must contain at least one root.");
	}
	if (request.scope.roots.length > 16) {
		throw new SubagentError("invalid_scope", "Writer scope cannot contain more than 16 roots.");
	}
	const roots: string[] = [];
	for (const root of request.scope.roots) {
		if (typeof root !== "string" || root.length === 0 || Buffer.byteLength(root) > 4096) {
			throw new SubagentError("invalid_scope", "Each writer scope root must be a nonempty path up to 4 KiB.");
		}
		let resolvedRoot: string;
		try {
			resolvedRoot = canonicalPath(resolve(resolvedCwd, root));
		} catch (error) {
			throw new SubagentError(
				"invalid_scope",
				`Cannot resolve writer scope root "${root}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		try {
			if (!statSync(resolvedRoot).isDirectory()) {
				throw new SubagentError("invalid_scope", `Writer scope root "${root}" is not a directory.`);
			}
		} catch (error) {
			if (error instanceof SubagentError) throw error;
			throw new SubagentError(
				"invalid_scope",
				`Cannot inspect writer scope root "${root}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!options.allowExternal && !isPathWithin(resolvedCwd, resolvedRoot)) {
			throw new SubagentError("invalid_scope", `Writer scope root "${root}" is outside the parent workspace.`);
		}
		if (!roots.includes(resolvedRoot)) roots.push(resolvedRoot);
	}
	return {
		parentSessionId: request.parentSessionId,
		task: request.task.trim(),
		scope: { roots },
		baseCommit: request.baseCommit,
		cwd: resolvedCwd,
		timeoutMs: Math.min(request.timeoutMs ?? WRITER_DEFAULT_TIMEOUT_MS, WRITER_MAX_TIMEOUT_MS),
		allowExternal: options.allowExternal === true,
	};
}
