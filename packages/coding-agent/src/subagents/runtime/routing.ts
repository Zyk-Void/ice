import { createHash } from "node:crypto";
import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@zykairotis/ice-ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";

export interface IceSubagentRouteSnapshot {
	provider: string;
	modelId: string;
	capabilityHash: string;
}

/** No credentials or live model objects enter the durable route projection. */
export function snapshotIceSubagentRoute(model: Model<Api>): IceSubagentRouteSnapshot {
	return Object.freeze({
		provider: model.provider,
		modelId: model.id,
		capabilityHash: createHash("sha256")
			.update(
				JSON.stringify({
					api: model.api,
					baseUrl: model.baseUrl,
					reasoning: model.reasoning,
					thinkingLevelMap: model.thinkingLevelMap,
					input: model.input,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				}),
			)
			.digest("hex"),
	});
}

export interface IceModelCandidateSkip {
	reference: string;
	reason: string;
}

export interface IceModelCandidateRequirements {
	/** An explicitly requested level must be supported exactly by the candidate. */
	thinking?: ModelThinkingLevel;
	/** Token lower bounds are explicit, never inferred from byte limits. */
	minimumContextTokens?: number;
	minimumOutputTokens?: number;
	requiresImages?: boolean;
}

export interface IceModelCandidateResult {
	model: Model<Api>;
	/** The exact selected reference, or "parent" for the captured parent fallback. */
	selected: string;
	skipped: readonly IceModelCandidateSkip[];
}

function validateExactModelReference(reference: string): { provider: string; modelId: string } {
	const slash = reference.indexOf("/");
	if (slash <= 0 || slash === reference.length - 1 || reference.length > 256 || /[\s\x00-\x1f]/.test(reference)) {
		throw new Error("Child model must be an exact provider/model reference.");
	}
	return { provider: reference.slice(0, slash), modelId: reference.slice(slash + 1) };
}

function modelCapabilityFailure(
	model: Model<Api>,
	requirements: IceModelCandidateRequirements | undefined,
): string | undefined {
	if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
		return "incomplete context-window metadata";
	}
	if (!Number.isFinite(model.maxTokens) || model.maxTokens <= 0) {
		return "incomplete maximum-output metadata";
	}
	if (!Array.isArray(model.input) || !model.input.includes("text")) return "text input is not supported";
	if (requirements?.requiresImages && !model.input.includes("image")) return "image input is not supported";
	if (requirements?.minimumContextTokens !== undefined && model.contextWindow < requirements.minimumContextTokens)
		return "context window is below the requested minimum";
	if (requirements?.minimumOutputTokens !== undefined && model.maxTokens < requirements.minimumOutputTokens)
		return "maximum output is below the requested minimum";
	if (requirements?.thinking !== undefined) {
		const supported = getSupportedThinkingLevels(model);
		if (!supported.includes(requirements.thinking)) {
			return `thinking level "${requirements.thinking}" is not supported`;
		}
	}
	return undefined;
}

function candidateReferences(primary: string | undefined, fallback: string | undefined): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const reference of [primary, fallback]) {
		if (reference === undefined) continue;
		validateExactModelReference(reference);
		if (seen.has(reference)) continue;
		seen.add(reference);
		candidates.push(reference);
	}
	return candidates;
}

/** Deterministic primary/fallback/parent order with bounded skip reasons. */
export function resolveIceSubagentCandidates(options: {
	parent: Model<Api>;
	primary?: string;
	fallback?: string;
	/** Pre-effect startup failures only; never used for queued promotion. */
	exclude?: readonly string[];
	runtime: Pick<ModelRuntime, "getModel" | "hasConfiguredAuth">;
	policy?: { allowed?: (reference: string) => boolean };
	requirements?: IceModelCandidateRequirements;
}): IceModelCandidateResult {
	const candidates = candidateReferences(options.primary, options.fallback);
	const skipped: IceModelCandidateSkip[] = [];
	for (const reference of candidates) {
		if (options.exclude?.includes(reference)) {
			skipped.push({ reference, reason: "retry-safe startup failed" });
			continue;
		}
		if (options.policy?.allowed && !options.policy.allowed(reference)) {
			throw new Error(`Child model ${reference} was rejected by route policy.`);
		}
		const { provider, modelId } = validateExactModelReference(reference);
		const model =
			provider === options.parent.provider && modelId === options.parent.id
				? options.parent
				: options.runtime.getModel(provider, modelId);
		if (!model) {
			skipped.push({ reference, reason: "not present in Ice catalog" });
			continue;
		}
		if (!options.runtime.hasConfiguredAuth(provider)) {
			skipped.push({ reference, reason: "no configured credentials" });
			continue;
		}
		const capabilityFailure = modelCapabilityFailure(model, options.requirements);
		if (capabilityFailure) {
			skipped.push({ reference, reason: capabilityFailure });
			continue;
		}
		return { model, selected: reference, skipped: Object.freeze(skipped) };
	}

	const parentReference = `${options.parent.provider}/${options.parent.id}`;
	if (options.exclude?.includes(parentReference))
		throw new Error("No untried child model remains after retry-safe startup failure.");
	if (options.policy?.allowed && !options.policy.allowed(parentReference))
		throw new Error("Captured parent model was rejected by route policy.");
	const parentFailure = modelCapabilityFailure(options.parent, options.requirements);
	if (parentFailure) {
		throw new Error(`No eligible child model remains; captured parent route ${parentFailure}.`);
	}
	return { model: options.parent, selected: "parent", skipped: Object.freeze(skipped) };
}

function resolveCapturedRoute(options: {
	parent: Model<Api>;
	captured: IceSubagentRouteSnapshot;
	runtime: Pick<ModelRuntime, "getModel" | "hasConfiguredAuth">;
	policy?: { allowed?: (reference: string) => boolean };
	requirements?: IceModelCandidateRequirements;
}): Model<Api> {
	const { provider, modelId } = options.captured;
	const reference = `${provider}/${modelId}`;
	if (options.policy?.allowed && !options.policy.allowed(reference)) {
		throw new Error(`Captured child model ${reference} was rejected by route policy.`);
	}
	const model = options.runtime.getModel(provider, modelId);
	if (!model) throw new Error("Requested child model is not present in Ice's local catalog.");
	if (!options.runtime.hasConfiguredAuth(provider)) {
		throw new Error("Requested child model has no configured credentials.");
	}
	const capabilityFailure = modelCapabilityFailure(model, options.requirements);
	if (capabilityFailure) throw new Error(`Requested child model ${capabilityFailure}.`);
	if (snapshotIceSubagentRoute(model).capabilityHash !== options.captured.capabilityHash) {
		throw new Error("Captured child model capabilities changed; refusing silent rerouting.");
	}
	return model;
}

/** Ice owns the catalog and credentials. This adapter never discovers models or authenticates. */
export function resolveIceSubagentRoute(options: {
	parent: Model<Api>;
	requested?: string;
	fallback?: string;
	enabled: boolean;
	runtime: Pick<ModelRuntime, "getModel" | "hasConfiguredAuth">;
	captured?: IceSubagentRouteSnapshot;
	policy?: { allowed?: (reference: string) => boolean };
	requirements?: IceModelCandidateRequirements;
}): Model<Api> {
	// A captured durable route is authoritative. It must be checked before
	// considering any configured candidate, otherwise queue promotion could
	// silently select a different model after acceptance.
	if (options.captured) {
		if (!options.enabled) throw new Error("Per-child routing is disabled by global policy.");
		return resolveCapturedRoute({ ...options, captured: options.captured });
	}
	if (options.requested === undefined && options.fallback === undefined) return options.parent;
	if (!options.enabled) throw new Error("Per-child routing is disabled by global policy.");
	return resolveIceSubagentCandidates({
		parent: options.parent,
		primary: options.requested,
		fallback: options.fallback,
		runtime: options.runtime,
		policy: options.policy,
		requirements: options.requirements,
	}).model;
}
