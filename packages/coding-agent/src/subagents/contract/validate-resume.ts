/**
 * Subagent V2 resume validation (Plan/subagent-rewrite.md sections 11.5 and 17, D15/D16, P4.4).
 *
 * A parked or interrupted child resumes only under its frozen contract. Every
 * frozen capability must still be authorized by the current parent; anything
 * missing, changed, or narrowed blocks the resume before any model turn. Tools
 * the parent gained since acceptance are ignored: the active set is clamped to
 * the frozen list.
 */
import type { ParentToolInfo } from "../tools/resolve.ts";
import type { ChildRuntimeContract } from "./child-runtime-contract.ts";

export interface ResumeAuthorityContext {
	ownerSessionId: string;
	/** Live active parent tools at resume time. */
	parentTools: readonly ParentToolInfo[];
	subYolo: boolean;
	parentMode: "plan" | "build";
	/** True when the frozen provider/model still resolves with existing credentials. */
	modelAvailable: (provider: string, model: string) => boolean;
	tombstoned: boolean;
}

export type ResumeValidation = { ok: true; activeTools: readonly string[] } | { ok: false; reasons: readonly string[] };

export function validateChildResume(contract: ChildRuntimeContract, context: ResumeAuthorityContext): ResumeValidation {
	const reasons: string[] = [];
	if (context.tombstoned) return { ok: false, reasons: ["child was deleted"] };
	if (contract.ownerSessionId !== context.ownerSessionId)
		return { ok: false, reasons: ["child belongs to another session"] };
	const parent = new Map(context.parentTools.map((tool) => [tool.name, tool]));
	for (const tool of contract.capabilities.tools) {
		const current = parent.get(tool.name);
		if (!current) {
			reasons.push(`tool "${tool.name}" is no longer active in the parent`);
			continue;
		}
		if (!current.childSafe || current.access === "unknown")
			reasons.push(`tool "${tool.name}" is no longer child-safe`);
		else if ((current.access === "read-only" ? "read-only" : "mutation") !== tool.access)
			reasons.push(`tool "${tool.name}" changed access classification`);
		if (tool.adapterId !== current.adapterId || tool.fingerprint !== current.fingerprint)
			reasons.push(`tool "${tool.name}" implementation changed since the child was created`);
	}
	if (contract.capabilities.subYolo && !context.subYolo) reasons.push("--sub-yolo is no longer active");
	const canMutate = contract.capabilities.tools.some((tool) => tool.access === "mutation");
	if (contract.capabilities.parentMode === "build" && context.parentMode === "plan" && canMutate)
		reasons.push("parent switched to plan mode; this child can mutate");
	if (!context.modelAvailable(contract.model.provider, contract.model.model))
		reasons.push(`model ${contract.model.provider}/${contract.model.model} is no longer available`);
	return reasons.length > 0
		? { ok: false, reasons: Object.freeze(reasons) }
		: { ok: true, activeTools: Object.freeze(contract.capabilities.tools.map((tool) => tool.name)) };
}
