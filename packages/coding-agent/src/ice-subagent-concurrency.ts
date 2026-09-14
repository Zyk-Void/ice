/**
 * ICE subagent concurrency policy: one canonical resolver for active child
 * concurrency across synchronous batches and asynchronous jobs, plus a shared
 * admission coordinator used by both execution paths.
 *
 * Design authority: agent_docs/implementation/subagent-concurrency-headroom-plan.md.
 * Ice remains the sole authoritative reasoning/tool loop; this module owns only
 * bounded resource admission. Defaults and the hard ceiling are conservative and
 * must be justified by local benchmarks (see
 * packages/coding-agent/test/ice-subagent-concurrency.bench.test.ts).
 */

import type { IceSettingSource, ParsedIceSubagentSettings } from "./ice-subagent-settings.ts";
import { redactCredentialText } from "./utils/redact.ts";

export const SUBAGENT_CONCURRENCY_LIMITS = {
	min: 1,
	/** Bundled default active children for read-only/bounded work. */
	bundledDefault: 4,
	/** Absolute hard ceiling; neither settings nor calls can exceed it. */
	hardCap: 8,
} as const;

export interface SubagentConcurrencySettings {
	default?: number;
	max?: number;
}

export interface ResolvedSubagentConcurrencyPolicy {
	/** Default active children for batch/job execution. */
	defaultConcurrency: number;
	/** Effective hard ceiling shared by batch and background-job admission. */
	maxConcurrency: number;
	sources: { default: IceSettingSource; max: IceSettingSource };
	diagnostics: readonly string[];
}

function frozenDiagnostics(values: string[]): readonly string[] {
	return Object.freeze(values.map((value) => redactCredentialText(value).slice(0, 512)));
}

/**
 * Resolve the canonical concurrency policy. Global settings may raise the
 * default/ceiling up to the bundled hard cap; trusted project settings may only
 * narrow (lower) values, never raise them; untrusted project settings are
 * ignored with a diagnostic.
 */
export function resolveSubagentConcurrencyPolicy(input: {
	global?: ParsedIceSubagentSettings;
	project?: ParsedIceSubagentSettings;
	projectTrusted?: boolean;
}): ResolvedSubagentConcurrencyPolicy {
	const diagnostics: string[] = [];
	const global = input.global;
	const projectTrusted = input.projectTrusted ?? true;
	const project = projectTrusted ? input.project : undefined;
	if (input.project && !projectTrusted && input.project.concurrency !== undefined) {
		diagnostics.push("project ice.subagents.concurrency ignored without project trust");
	}

	let max: number = SUBAGENT_CONCURRENCY_LIMITS.hardCap;
	let maxSource: IceSettingSource = "bundled";
	if (global?.concurrency?.max !== undefined) {
		max = global.concurrency.max;
		maxSource = "global";
	}
	if (project?.concurrency?.max !== undefined) {
		if (project.concurrency.max < max) {
			max = project.concurrency.max;
			maxSource = "project";
		} else if (project.concurrency.max > max) {
			diagnostics.push(
				`project concurrency max cannot raise the global cap; clamped to ${max} (requested ${project.concurrency.max})`,
			);
		}
	}

	let defaultConcurrency: number = SUBAGENT_CONCURRENCY_LIMITS.bundledDefault;
	let defaultSource: IceSettingSource = "bundled";
	if (global?.concurrency?.default !== undefined) {
		defaultConcurrency = global.concurrency.default;
		defaultSource = "global";
	}
	if (project?.concurrency?.default !== undefined) {
		if (project.concurrency.default < defaultConcurrency) {
			defaultConcurrency = project.concurrency.default;
			defaultSource = "project";
		} else if (project.concurrency.default > defaultConcurrency) {
			diagnostics.push(
				`project concurrency default cannot raise the global default; clamped to ${defaultConcurrency} (requested ${project.concurrency.default})`,
			);
		}
	}

	if (defaultConcurrency > max) {
		diagnostics.push(`concurrency default clamped to enforced cap ${max} (requested ${defaultConcurrency})`);
		defaultConcurrency = max;
		defaultSource = "enforced";
	}

	return {
		defaultConcurrency,
		maxConcurrency: max,
		sources: { default: defaultSource, max: maxSource },
		diagnostics: frozenDiagnostics(diagnostics),
	};
}

/**
 * Shared permit accounting across synchronous batches and asynchronous jobs.
 * A caller cannot exceed the shared ceiling by mixing admission paths. Permits
 * must be released exactly once; releasing more permits than acquired is an
 * internal invariant failure.
 */
export class SubagentConcurrencyAdmission {
	private count = 0;
	private readonly releaseListeners = new Set<() => void>();
	readonly maxActive: number;

	constructor(maxActive: number) {
		if (
			!Number.isSafeInteger(maxActive) ||
			maxActive < SUBAGENT_CONCURRENCY_LIMITS.min ||
			maxActive > SUBAGENT_CONCURRENCY_LIMITS.hardCap
		) {
			throw new Error(
				`Subagent concurrency admission cap must be between ${SUBAGENT_CONCURRENCY_LIMITS.min} and ${SUBAGENT_CONCURRENCY_LIMITS.hardCap}.`,
			);
		}
		this.maxActive = maxActive;
	}

	get active(): number {
		return this.count;
	}

	get capacity(): number {
		return this.maxActive;
	}

	tryAcquire(): boolean {
		if (this.count >= this.maxActive) return false;
		this.count++;
		return true;
	}

	release(): void {
		if (this.count === 0) {
			throw new Error("Subagent concurrency admission released more permits than acquired.");
		}
		this.count--;
		if (this.count < this.maxActive) {
			for (const listener of [...this.releaseListeners]) {
				try {
					listener();
				} catch {
					// Wakeup listeners are non-authoritative scheduling hints.
				}
			}
		}
	}

	onRelease(listener: () => void): () => void {
		this.releaseListeners.add(listener);
		return () => this.releaseListeners.delete(listener);
	}
}
