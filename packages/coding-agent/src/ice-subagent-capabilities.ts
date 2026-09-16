import { createHash } from "node:crypto";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { ToolDefinition } from "./core/extensions/types.ts";
import { redactCredentialText } from "./utils/redact.ts";

/** A trusted adapter is an authority boundary, not a sandbox or a tool-description heuristic. */
export type IceCapabilityAccess = "read-only" | "mutation" | "unknown";
export interface IceChildDispatchContext {
	readonly parentSessionId: string;
	readonly runId: string;
	readonly cwd: string;
	readonly scopeRoots: readonly string[];
	readonly signal?: AbortSignal;
}

export interface IceDelegableTool {
	/** Stable parent-owned identity used by profile-level adapter selection. */
	adapterId: string;
	/** Stable model-visible identifier; must already be active in the parent. */
	name: string;
	/** Provenance label; it is never used as an authority selector. */
	origin: string;
	access: IceCapabilityAccess;
	/** Host assertion that dispatch honors scope, cancellation, and independent child state. */
	childSafe: true;
	description: string;
	parameters: TSchema;
	execute: (params: Readonly<Record<string, unknown>>, context: IceChildDispatchContext) => Promise<unknown>;
	/** Optional live host-policy check. Absence does not bypass registration revocation. */
	isAuthorized?: () => boolean;
}

export interface IceCapabilitySnapshot {
	readonly adapterId: string;
	readonly name: string;
	readonly origin: string;
	readonly access: IceCapabilityAccess;
	readonly fingerprint: string;
}

export interface IceResolvedDelegableTool extends IceCapabilitySnapshot {
	readonly definition: IceDelegableTool;
	readonly isCurrent: () => boolean;
}

export const ICE_CAPABILITY_LIMITS = Object.freeze({
	maxTools: 32,
	maxSchemaBytes: 16 * 1024,
	maxInputBytes: 32 * 1024,
	maxOutputBytes: 24 * 1024,
	maxDescriptionBytes: 4096,
});

export const ICE_BUILTIN_CHILD_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
const MANAGEMENT_TOOLS = new Set([
	"delegate",
	"delegate_async",
	"delegate_batch",
	"delegate_write",
	"review_batch",
	"manage_subagent",
	"inspect_subagent_job",
	"cancel_subagent_job",
	"list_subagent_profiles",
	"integrate_writer_patch",
	"inspect_writer_patch",
	"reject_writer_patch",
	"read_plan",
	"set_active_tools",
	"set_model",
	"compact",
	"shutdown",
]);
const registrations = new WeakMap<object, Map<string, IceDelegableTool>>();

export function isIceChildToolName(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value);
}

/** Adapter IDs are explicit parent-owned selectors, not values derived from origin. */
export function isIceDelegableAdapterId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(value);
}

export function isIceParentManagementTool(name: string): boolean {
	return MANAGEMENT_TOOLS.has(name.toLowerCase());
}

function freezeJson<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freezeJson(child);
		Object.freeze(value);
	}
	return value;
}

export function normalizeIceToolSchema(schema: TSchema): TSchema {
	let nodes = 0;
	const visit = (value: unknown, depth: number): void => {
		if (++nodes > 2048 || depth > 16) throw new Error("Delegated tool schema is too complex.");
		if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
			throw new Error("Delegated tool schemas must be data-only JSON.");
		}
		if (value && typeof value === "object") {
			for (const [key, child] of Object.entries(value)) {
				if (key === "$ref" || key === "$dynamicRef")
					throw new Error("Delegated tool schemas cannot resolve references.");
				visit(child, depth + 1);
			}
		}
	};
	visit(schema, 0);
	const json = JSON.stringify(schema);
	if (
		!json ||
		Buffer.byteLength(json) > ICE_CAPABILITY_LIMITS.maxSchemaBytes ||
		(schema as { type?: unknown }).type !== "object"
	) {
		throw new Error("Delegated tool requires a bounded object parameter schema.");
	}
	return freezeJson(JSON.parse(json) as TSchema);
}

function checkedDefinition(input: IceDelegableTool): IceDelegableTool {
	if (!isIceDelegableAdapterId(input.adapterId)) throw new Error("Invalid delegated adapter ID.");
	if (!isIceChildToolName(input.name) || isIceParentManagementTool(input.name)) {
		throw new Error("Parent delegation/control tools cannot be delegated.");
	}
	if ((ICE_BUILTIN_CHILD_TOOLS as readonly string[]).includes(input.name.toLowerCase())) {
		throw new Error("External adapters cannot replace scoped built-in tools.");
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(input.origin)) throw new Error("Invalid delegated tool origin.");
	if (input.childSafe !== true || !["read-only", "mutation", "unknown"].includes(input.access)) {
		throw new Error("Delegated tools need explicit child-safe and access classifications.");
	}
	if (
		typeof input.execute !== "function" ||
		typeof input.description !== "string" ||
		Buffer.byteLength(input.description) > ICE_CAPABILITY_LIMITS.maxDescriptionBytes
	) {
		throw new Error("Invalid delegated tool implementation or description.");
	}
	return Object.freeze({
		...input,
		description: redactCredentialText(input.description),
		parameters: normalizeIceToolSchema(input.parameters),
	});
}

export function snapshotIceCapability(definition: IceDelegableTool): IceCapabilitySnapshot {
	return Object.freeze({
		adapterId: definition.adapterId,
		name: definition.name,
		origin: definition.origin,
		access: definition.access,
		fingerprint: createHash("sha256")
			.update(
				JSON.stringify({
					adapterId: definition.adapterId,
					name: definition.name,
					origin: definition.origin,
					access: definition.access,
					childSafe: definition.childSafe,
					parameters: definition.parameters,
					description: definition.description,
				}),
			)
			.digest("hex"),
	});
}

/** Call only from trusted parent extension code, using ice.events as the owner. */
export function registerIceDelegableTool(owner: object, input: IceDelegableTool): () => void {
	const definition = checkedDefinition(input);
	let tools = registrations.get(owner);
	if (!tools) {
		tools = new Map();
		registrations.set(owner, tools);
	}
	if (tools.size >= ICE_CAPABILITY_LIMITS.maxTools) throw new Error("Too many delegated tool registrations.");
	if (tools.has(definition.name)) throw new Error(`Duplicate delegated tool ${definition.name}.`);
	tools.set(definition.name, definition);
	return () => {
		if (tools.get(definition.name) === definition) tools.delete(definition.name);
	};
}

export function getIceDelegableTools(owner: object): readonly IceResolvedDelegableTool[] {
	const tools = registrations.get(owner);
	if (!tools) return Object.freeze([]);
	return Object.freeze(
		[...tools.values()].map((definition) =>
			Object.freeze({
				...snapshotIceCapability(definition),
				definition,
				isCurrent: () => tools.get(definition.name) === definition && definition.isAuthorized?.() !== false,
			}),
		),
	);
}

export function resolveIceDelegableTools(options: {
	available: readonly IceResolvedDelegableTool[];
	parentActiveTools: readonly string[];
	/** Direct model-visible tool requests, used by self-delegation and legacy callers. */
	requested: readonly string[];
	/** Independent profile-level parent adapter selectors. */
	requestedAdapterIds?: readonly string[];
	denied?: readonly string[];
	allowMutation: boolean;
}): readonly IceResolvedDelegableTool[] {
	const active = new Set(options.parentActiveTools);
	const denied = new Set((options.denied ?? []).map((name) => name.toLowerCase()));
	const byName = new Map(options.available.map((tool) => [tool.name, tool]));
	const selected: IceResolvedDelegableTool[] = [];
	const selectedNames = new Set<string>();
	const select = (tool: IceResolvedDelegableTool, requestedName: string): void => {
		if (denied.has(tool.name.toLowerCase())) return;
		if (!active.has(tool.name) || !tool.isCurrent())
			throw new Error(`Delegated tool ${requestedName} is no longer authorized by the parent.`);
		if (tool.access === "unknown")
			throw new Error(`Delegated tool ${requestedName} has unknown access classification.`);
		if (tool.access === "mutation" && !options.allowMutation) return;
		if (selectedNames.has(tool.name)) return;
		selectedNames.add(tool.name);
		selected.push(tool);
	};
	for (const name of new Set(options.requested)) {
		if ((ICE_BUILTIN_CHILD_TOOLS as readonly string[]).includes(name)) continue;
		if (!isIceChildToolName(name) || isIceParentManagementTool(name))
			throw new Error("Child requested a privileged or invalid tool.");
		const tool = byName.get(name);
		if (!tool) throw new Error(`Tool ${name} has no child-safe parent adapter.`);
		select(tool, name);
	}
	for (const adapterId of new Set(options.requestedAdapterIds ?? [])) {
		if (!isIceDelegableAdapterId(adapterId)) throw new Error("Invalid delegated adapter ID.");
		const tools = options.available.filter((tool) => tool.adapterId === adapterId);
		if (tools.length === 0) throw new Error(`Adapter ${adapterId} has no child-safe parent registration.`);
		for (const tool of tools) select(tool, adapterId);
	}
	return Object.freeze(selected);
}

/** Redact structured secrets before rendering; enforce limits before parent-facing serialization. */
export function boundedIceToolOutput(value: unknown, maxBytes = ICE_CAPABILITY_LIMITS.maxOutputBytes): string {
	const seen = new WeakSet<object>();
	let nodes = 0;
	const visit = (input: unknown, key: string, depth: number): unknown => {
		if (/(?:api[_-]?key|token|secret|password|authorization|cookie)/i.test(key)) return "[REDACTED]";
		if (++nodes > 4096 || depth > 8) return "[TRUNCATED]";
		if (typeof input === "string") return redactCredentialText(input).slice(0, maxBytes);
		if (input === null || typeof input === "boolean") return input;
		if (typeof input === "number") return Number.isFinite(input) ? input : null;
		if (typeof input !== "object") return "[UNSUPPORTED]";
		if (seen.has(input)) return "[CIRCULAR]";
		seen.add(input);
		try {
			if (Array.isArray(input)) return input.slice(0, 128).map((entry) => visit(entry, "", depth + 1));
			return Object.fromEntries(
				Object.entries(input)
					.slice(0, 64)
					.map(([name, entry]) => [name.slice(0, 128), visit(entry, name, depth + 1)]),
			);
		} finally {
			seen.delete(input);
		}
	};
	const safe = visit(value, "", 0);
	const text = typeof safe === "string" ? safe : JSON.stringify(safe);
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;
	const suffix = "\n[TRUNCATED]";
	let end = Math.max(0, maxBytes - Buffer.byteLength(suffix));
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8") + suffix;
}

/** Stop waiting promptly on cancellation. The adapter still owns remote cancellation and cleanup. */
export async function awaitIceToolDispatch<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	let abort: (() => void) | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				abort = () => reject(new Error("Delegated operation cancelled; external outcomes must not be replayed."));
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}

export function createIceDelegableToolDefinitions(
	tools: readonly IceResolvedDelegableTool[],
	context: Omit<IceChildDispatchContext, "signal">,
	maxOutputBytes = ICE_CAPABILITY_LIMITS.maxOutputBytes,
): ToolDefinition[] {
	return tools.map(
		(tool): ToolDefinition => ({
			name: tool.name,
			label: tool.name,
			description: tool.definition.description,
			parameters: tool.definition.parameters,
			execute: async (_id, params, signal) => {
				if (signal?.aborted) throw new Error("Delegated tool cancelled before dispatch.");
				if (!tool.isCurrent()) throw new Error(`Delegated tool ${tool.name} was revoked.`);
				if (
					!params ||
					typeof params !== "object" ||
					Array.isArray(params) ||
					Buffer.byteLength(JSON.stringify(params)) > ICE_CAPABILITY_LIMITS.maxInputBytes ||
					!Value.Check(tool.definition.parameters, params)
				) {
					throw new Error(`Delegated tool ${tool.name} received invalid or oversized arguments.`);
				}
				const result = await awaitIceToolDispatch(
					tool.definition.execute(
						freezeJson(structuredClone(params) as Record<string, unknown>),
						Object.freeze({
							...context,
							scopeRoots: Object.freeze([...context.scopeRoots]),
							signal,
						}),
					),
					signal,
				);
				if (signal?.aborted)
					throw new Error("Delegated tool cancelled; any external outcome must be inspected, not replayed.");
				return {
					content: [{ type: "text", text: boundedIceToolOutput(result, maxOutputBytes) }],
					details: { capability: snapshotIceCapability(tool.definition) },
					isError: !!(result && typeof result === "object" && "isError" in result && result.isError === true),
				};
			},
		}),
	);
}
