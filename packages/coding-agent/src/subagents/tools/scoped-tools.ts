/** Scoped child tool definitions, selected MCP tools, and execution policy wrappers (moved from ice-subagents.ts). */
import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { ToolDefinition } from "../../core/extensions/index.ts";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "../../core/tools/index.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import { redactCredentialText } from "../../utils/redact.ts";
import { SubagentError } from "../runtime/helpers.ts";
import type { NativeSubagentSessionOptions } from "../runtime/live-session.ts";
import { type IceSubagentMcpToolAuthorization, subagentMcpToolName } from "../types.ts";
import { awaitIceToolDispatch, boundedIceToolOutput } from "./adapters.ts";
import { canonicalPath, isApprovedSubagentPath, resolveScopeCandidate } from "./paths.ts";

function hasGitPathComponent(path: string): boolean {
	return path.split(sep).some((component) => component === ".git");
}

export function assertNoSymlinkComponents(path: string): void {
	let current = resolve(path);
	const components: string[] = [];
	while (true) {
		const parent = dirname(current);
		if (parent === current) break;
		components.unshift(basename(current));
		current = parent;
	}
	let prefix = current;
	for (const component of components) {
		prefix = join(prefix, component);
		try {
			if (lstatSync(prefix).isSymbolicLink()) throw new Error(`Path contains a symlink: ${path}`);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Path contains a symlink:")) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
			throw error;
		}
	}
}

function assertSubagentScopePath(
	rawPath: string | undefined,
	cwd: string,
	scopeRoots: readonly string[],
	resourceRoots: readonly string[] = [],
	denyGit = false,
): string {
	const candidate = resolveToCwd(rawPath || ".", cwd);
	if (denyGit && hasGitPathComponent(candidate)) {
		throw new Error(`Path is denied because it references Git metadata: ${rawPath || "."}`);
	}
	const resolved = resolveScopeCandidate(candidate);
	if (!isApprovedSubagentPath(resolved, scopeRoots, resourceRoots)) {
		throw new Error(`Path is outside the approved subagent scope: ${rawPath || "."}`);
	}
	const canonicalResolved = existsSync(resolved) ? canonicalPath(resolved) : resolved;
	if (!isApprovedSubagentPath(canonicalResolved, scopeRoots, resourceRoots)) {
		throw new Error(`Path moved outside the approved subagent scope: ${rawPath || "."}`);
	}
	return canonicalResolved;
}

/**
 * W14/W29: final dispatch-boundary eligibility. The tool allowlist is fixed at
 * session creation. Inside withScopedPath, scope resolution always runs first
 * so legacy scope-denial errors keep their shape; only then does the
 * dispatch boundary re-check the requested name so a stale or forged child
 * call can never execute a disallowed tool.
 */
export function assertSubagentToolEligible(
	toolName: string,
	eligible: ReadonlySet<string> | readonly string[] | Set<string>,
): void {
	const allowed: Set<string> = Array.isArray(eligible) ? new Set(eligible) : new Set(eligible);
	if (!allowed.has(toolName.toLowerCase())) {
		throw new SubagentError("capability_denied", `Tool "${toolName}" is not eligible for this child.`);
	}
}

function withScopedPath<TParams extends TSchema, TDetails>(
	definition: ToolDefinition<TParams, TDetails>,
	cwd: string,
	scopeRoots: readonly string[],
	resourceRoots: readonly string[],
	getPath: (params: Static<TParams>) => string | undefined,
	denyGit = false,
	allowExternal = false,
	eligibleTools?: ReadonlySet<string> | readonly string[] | Set<string>,
): ToolDefinition<TParams, TDetails> {
	return {
		...definition,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const rawPath = getPath(params);
			const resolvedPath = allowExternal
				? resolveToCwd(rawPath || ".", cwd)
				: assertSubagentScopePath(rawPath, cwd, scopeRoots, resourceRoots, denyGit);
			if (allowExternal) {
				if (denyGit && hasGitPathComponent(resolvedPath)) {
					throw new Error(`Path is denied because it references Git metadata: ${rawPath || "."}`);
				}
				assertNoSymlinkComponents(resolvedPath);
			}
			// Path admission and tool admission are independent capabilities. A
			// selected resource root can extend the path boundary only; it never
			// authorizes a tool that was removed from the child's allowlist.
			if (eligibleTools) assertSubagentToolEligible(definition.name, eligibleTools);
			const scopedParams = {
				...(params as Record<string, unknown>),
				path: resolvedPath,
			} as Static<TParams>;
			return definition.execute(toolCallId, scopedParams, signal, onUpdate, ctx);
		},
	};
}

export function createScopedReadOnlyToolDefinitions(
	cwd: string,
	scopeRoots: readonly string[],
	resourceRoots: readonly string[] = [],
	allowExternal = false,
	eligibleTools?: ReadonlySet<string> | readonly string[] | Set<string>,
): ToolDefinition[] {
	return [
		withScopedPath(
			createReadToolDefinition(cwd),
			cwd,
			scopeRoots,
			resourceRoots,
			(params) => params.path,
			false,
			allowExternal,
			eligibleTools,
		),
		withScopedPath(
			createGrepToolDefinition(cwd),
			cwd,
			scopeRoots,
			resourceRoots,
			(params) => params.path,
			false,
			allowExternal,
			eligibleTools,
		),
		withScopedPath(
			createFindToolDefinition(cwd),
			cwd,
			scopeRoots,
			resourceRoots,
			(params) => params.path,
			false,
			allowExternal,
			eligibleTools,
		),
		withScopedPath(
			createLsToolDefinition(cwd),
			cwd,
			scopeRoots,
			resourceRoots,
			(params) => params.path,
			false,
			allowExternal,
			eligibleTools,
		),
	] as unknown as ToolDefinition[];
}

export function createScopedWriterToolDefinitions(
	cwd: string,
	scopeRoots: readonly string[],
	allowExternal = false,
	resourceRoots: readonly string[] = [],
	eligibleTools?: ReadonlySet<string> | readonly string[] | Set<string>,
): ToolDefinition[] {
	return [
		withScopedPath(
			createReadToolDefinition(cwd),
			cwd,
			scopeRoots,
			resourceRoots,
			(params) => params.path,
			true,
			allowExternal,
			eligibleTools,
		),
		withScopedPath(
			createGrepToolDefinition(cwd),
			cwd,
			scopeRoots,
			resourceRoots,
			(params) => params.path,
			true,
			allowExternal,
			eligibleTools,
		),
		withScopedPath(
			createFindToolDefinition(cwd),
			cwd,
			scopeRoots,
			resourceRoots,
			(params) => params.path,
			true,
			allowExternal,
			eligibleTools,
		),
		withScopedPath(
			createLsToolDefinition(cwd),
			cwd,
			scopeRoots,
			resourceRoots,
			(params) => params.path,
			true,
			allowExternal,
			eligibleTools,
		),
		withScopedPath(
			createWriteToolDefinition(cwd),
			cwd,
			scopeRoots,
			[],
			(params) => params.path,
			true,
			allowExternal,
			eligibleTools,
		),
		withScopedPath(
			createEditToolDefinition(cwd),
			cwd,
			scopeRoots,
			[],
			(params) => params.path,
			true,
			allowExternal,
			eligibleTools,
		),
	] as unknown as ToolDefinition[];
}

const SUBAGENT_MCP_OUTPUT_LIMIT_BYTES = 24 * 1024;

export function createSelectedMcpToolDefinitions(
	selected: readonly string[],
	options: Pick<NativeSubagentSessionOptions, "mcpDispatch"> & {
		authorizations?: readonly IceSubagentMcpToolAuthorization[];
		isCurrent?: () => boolean;
	},
): ToolDefinition[] {
	return selected.map((entry) => {
		const slash = entry.indexOf("/");
		const server = entry.slice(0, slash);
		const tool = entry.slice(slash + 1);
		const name = subagentMcpToolName(entry);
		const metadata = options.authorizations?.find((item) => item.selector === entry);
		const parameters = metadata?.parameters ?? Type.Object({}, { additionalProperties: true });
		return {
			name,
			label: entry,
			description: redactCredentialText(
				metadata?.description ?? `Parent-owned MCP tool ${entry}. Use the supplied parameter schema.`,
			),
			parameters,
			execute: async (
				_toolCallId: string,
				params: unknown,
				signal: AbortSignal | undefined,
				_onUpdate: unknown,
				_ctx: unknown,
			) => {
				const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
				if (signal?.aborted) throw new SubagentError("cancellation", `MCP tool ${entry} was cancelled.`);
				if (options.isCurrent?.() === false)
					throw new SubagentError("capability_denied", "MCP authorization changed before dispatch.");
				if (!Value.Check(parameters, record) || Buffer.byteLength(JSON.stringify(record)) > 32 * 1024)
					throw new SubagentError("invalid_request", "Invalid or oversized MCP arguments.");
				const raw = await awaitIceToolDispatch(
					options.mcpDispatch!(server, tool, structuredClone(record), signal ?? undefined),
					signal,
				);
				if (signal?.aborted)
					throw new SubagentError(
						"cancellation",
						"MCP cancelled; any external effect requires inspection, not replay.",
					);
				const isError = !!(raw && typeof raw === "object" && "isError" in raw && raw.isError === true);
				return {
					content: [{ type: "text", text: boundedIceToolOutput(raw, SUBAGENT_MCP_OUTPUT_LIMIT_BYTES) }],
					isError,
				};
			},
		} as unknown as ToolDefinition;
	});
}

/**
 * Run-scoped execution policy consulted at dispatch time by the wrappers installed on a child
 * session. Those wrappers outlive a single run once a completed child is retained and resumed, so
 * they read this box instead of closing over one run's locals. `runResolved` re-points `current`
 * at the new run's policy before the first resumed model prompt, which is what makes a reused
 * `AgentSession` dispatch against current hooks, authority, and budgets.
 */
interface SubagentExecutionPolicy {
	beforeTool?: NativeSubagentSessionOptions["beforeTool"];
	/** Tools the current parent policy still authorizes for this child. */
	eligibleTools: ReadonlySet<string>;
	/**
	 * True for a reused session. A fresh run relies on the eligible set applied when its tool
	 * definitions were built; a reused session re-checks every wrapped tool so authority removed
	 * since the original run fails closed instead of dispatching.
	 */
	strictEligibility: boolean;
	reportOnly?: () => boolean;
	shouldStopAfterTurn?: () => boolean | Promise<boolean>;
}

export interface SubagentExecutionPolicyBox {
	current: SubagentExecutionPolicy;
}

export function wrapSubagentToolDefinitions(
	definitions: readonly ToolDefinition[],
	policy: SubagentExecutionPolicyBox,
	enforceEligibility = true,
): ToolDefinition[] {
	return definitions.map((definition) => {
		const execute = definition.execute;
		return {
			...definition,
			execute: async (toolCallId, params, signal, onUpdate, ctx) => {
				const current = policy.current;
				if (enforceEligibility || current.strictEligibility) {
					assertSubagentToolEligible(definition.name, current.eligibleTools);
				}
				await current.beforeTool?.(
					definition.name,
					toolCallId,
					(params && typeof params === "object" ? params : {}) as Record<string, unknown>,
					signal,
				);
				if (signal?.aborted) throw new SubagentError("cancellation", "Child tool cancelled after policy hooks.");
				return execute(toolCallId, params, signal, onUpdate, ctx);
			},
		} as ToolDefinition;
	});
}
