/**
 * Versioned programmatic access to Subagents V2 for trusted parent extensions.
 *
 * The controller is the `agent` tool's launch path without the model: the same
 * task schema, context packets, preflight, launch approvals, permission caps
 * and depth limit apply. A controller-started turn never delivers its result
 * into the parent conversation; the caller receives it. Worktree patches stay
 * open and uninspected, so integration still goes through `agent_patch`.
 */
import { Value } from "typebox/value";
import { type AgentTaskInput, AgentTaskSchema } from "../api/agent.ts";
import type { ChildTurnOutcome } from "../registry/state-machine.ts";
import type { SubagentV2Runtime } from "./runtime.ts";
import { withContextPacket } from "./runtime-support.ts";

/** A new child's task: the `agent` tool's task without `resume`. */
export type IceSubagentTask = Omit<AgentTaskInput, "resume">;

export interface IceSubagentStartOptions {
	/** Cancels the turn; the child stops and the result reports `cancelled`. */
	signal?: AbortSignal;
	/** Called once the child is accepted and resident, before its turn runs. */
	onLaunched?: (id: string) => void;
}

export interface IceSubagentRunResult {
	id: string;
	agent: string;
	/** The child's frozen effective model. */
	model?: { provider: string; id: string };
	outcome: ChildTurnOutcome;
	/** Final answer text, possibly truncated (see `truncated`). */
	text: string;
	truncated: boolean;
	error?: string;
	usage: { inputTokens: number; outputTokens: number; cost: number };
	/** Worktree children: `open` holds an uninspected patch for `agent_patch`; `unchanged` made no edits. */
	patchState?: string;
	/** Present only when the structured report validated; still untrusted child output. */
	payload?: Readonly<Record<string, unknown>>;
	findings?: readonly unknown[];
}

/** A read-only view of a worktree child's open patch. */
export interface IceSubagentPatchPreview {
	/** The child's worktree; other children of this parent may read (not write) it while the patch is open. */
	root: string;
	changedPaths: ReadonlyArray<{ status: string; path: string }>;
	/** Lossy UTF-8 display text, capped at `maxBytes`. */
	patch: string;
	truncated: boolean;
}

export interface IceSubagentController {
	readonly version: 1;
	/** Launch one new child and run its first turn; resolves when that turn ends. Rejects when launch is refused. */
	start(task: IceSubagentTask, options?: IceSubagentStartOptions): Promise<IceSubagentRunResult>;
	/** Stop a child's running turn. */
	stop(id: string): Promise<void>;
	/** The open patch of a worktree child, without inspecting or pinning it; undefined when none is open. */
	preview(id: string, maxBytes?: number): IceSubagentPatchPreview | undefined;
	/** This session's children whose worktree patch is still open, awaiting an `agent_patch` decision. */
	openPatches(): ReadonlyArray<IceSubagentOpenPatch>;
}

export interface IceSubagentOpenPatch {
	id: string;
	name?: string;
	agent: string;
	description: string;
}

/**
 * A global-registry symbol, so extensions loaded through a separate module
 * instance (or without importing this package at all) find the same controller
 * on the shared `ice.events` object.
 */
export const ICE_SUBAGENT_CONTROLLER_KEY = Symbol.for("ice.subagents.controller.v1");

type ControllerOwner = { [ICE_SUBAGENT_CONTROLLER_KEY]?: IceSubagentController };

/** Registered by the ice-subagents extension on its shared `ice.events` owner. */
export function registerIceSubagentController(owner: object, controller: IceSubagentController): () => void {
	Object.defineProperty(owner, ICE_SUBAGENT_CONTROLLER_KEY, { value: controller, configurable: true });
	return () => {
		if ((owner as ControllerOwner)[ICE_SUBAGENT_CONTROLLER_KEY] === controller)
			delete (owner as ControllerOwner)[ICE_SUBAGENT_CONTROLLER_KEY];
	};
}

/** The controller for this session's extensions (`ice.events`), when Subagents V2 is loaded. */
export function getIceSubagentController(owner: object): IceSubagentController | undefined {
	return (owner as ControllerOwner)[ICE_SUBAGENT_CONTROLLER_KEY];
}

export function createIceSubagentController(runtime: SubagentV2Runtime): IceSubagentController {
	return {
		version: 1,
		async start(task, options = {}) {
			if (!Value.Check(AgentTaskSchema, task)) throw new Error("Invalid subagent task.");
			if ("resume" in task && task.resume !== undefined) throw new Error("A controller task cannot resume a child.");
			if (options.signal?.aborted) throw new Error("Cancelled before launch.");
			const prompt = withContextPacket(task.prompt, task.context);
			const [record] = await runtime.launch([task]);
			if (!record) throw new Error("Subagent launch returned no child.");
			const frozen = runtime.registry.resident(runtime.ownerSessionId(), record.id)?.contract.model;
			options.onLaunched?.(record.id);
			const result = await runtime.runTurn(record.id, prompt, {
				foreground: true,
				...(options.signal ? { signal: options.signal } : {}),
			});
			const patchState = runtime.registry.get(runtime.ownerSessionId(), record.id).patchState;
			return {
				id: result.id,
				agent: result.agent,
				...(frozen ? { model: { provider: frozen.provider, id: frozen.model } } : {}),
				outcome: result.outcome,
				text: result.text,
				truncated: result.truncated,
				...(result.error ? { error: result.error } : {}),
				usage: {
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					cost: result.usage.cost,
				},
				...(patchState ? { patchState } : {}),
				...(result.validation?.verified && result.validation.payload ? { payload: result.validation.payload } : {}),
				...(result.validation?.findings?.length ? { findings: result.validation.findings } : {}),
			};
		},
		stop: (id) => runtime.stop(id),
		openPatches: () =>
			runtime.registry
				.list(runtime.ownerSessionId())
				.filter((record) => record.patchState === "open")
				.map((record) => ({
					id: record.id,
					...(record.name ? { name: record.name } : {}),
					agent: record.agent,
					description: record.description,
				})),
		preview(id, maxBytes = 64 * 1024) {
			const preview = runtime.previewPatch(id);
			if (!preview) return undefined;
			const { delta, worktreePath } = preview;
			const truncated = delta.patchBytes.byteLength > maxBytes;
			return {
				root: worktreePath,
				changedPaths: delta.changedPaths,
				patch: truncated ? delta.patchBytes.subarray(0, maxBytes).toString("utf8") : delta.patch,
				truncated,
			};
		},
	};
}
