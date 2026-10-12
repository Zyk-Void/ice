/** Gated V2 final-report contract. Observations are task-local, never child-authored claims. */
import { realpathSync, type Stats, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathIsWithin, resolveProspectivePath } from "../../ice-safe-verify.ts";
import { redactCredentialText } from "../../utils/redact.ts";
import { AGENT_TOOL_LIMITS } from "../api/agent.ts";
import type { ChildRuntimeContract } from "../contract/child-runtime-contract.ts";
import type { ChildTurnOutcome } from "../registry/state-machine.ts";
import { type ReviewFinding, SUBAGENT_REPORT_PARSER_LIMITS, type SubagentRequirementState } from "../types.ts";
import { deriveSubagentAssuranceLevel, type SubagentAssuranceLevel, type SubagentReportMode } from "./assurance.ts";
import type { SubagentOutputArtifactRef, SubagentOutputCaptureStatus } from "./output-artifacts.ts";
import { normalizeSubagentOutputSchema, parseSubagentReportOutcome } from "./report.ts";

export interface V2ResultValidation {
	reportMode: SubagentReportMode;
	verified: boolean;
	assurance: SubagentAssuranceLevel;
	reason: string;
	paths: readonly string[];
	requirements: readonly (SubagentRequirementState & { requirement: string; semanticVerified: false })[];
	payload?: Readonly<Record<string, unknown>>;
	findings?: readonly ReviewFinding[];
}

export interface V2OutputCapture {
	textBytes: number;
	originalBytes: number;
	inlineTruncated: boolean;
	captureStatus: SubagentOutputCaptureStatus;
	artifact?: SubagentOutputArtifactRef;
}

export interface V2ChildTurnResult {
	id: string;
	agent: string;
	outcome: ChildTurnOutcome;
	text: string;
	truncated: boolean;
	output?: V2OutputCapture;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		cost: number;
	};
	validation?: V2ResultValidation;
	error?: string;
}

/** Stable positional IDs: criterion-1 ... criterion-16. Additions cannot remove frozen criteria. */
export function normalizeV2Acceptance(base: readonly string[], additions: readonly string[] = []): readonly string[] {
	if (!Array.isArray(base) || !Array.isArray(additions)) throw new Error("Acceptance must be a bounded string array.");
	if (base.length > AGENT_TOOL_LIMITS.maxAcceptanceItems || additions.length > AGENT_TOOL_LIMITS.maxAcceptanceItems)
		throw new Error("Too many acceptance criteria.");
	const items = [...base, ...additions].map((value) => {
		if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > AGENT_TOOL_LIMITS.maxAcceptanceChars)
			throw new Error("Acceptance criteria must be nonempty bounded strings.");
		return redactCredentialText(value).trim();
	});
	const unique = [...new Set(items)];
	if (unique.length > AGENT_TOOL_LIMITS.maxAcceptanceItems) throw new Error("Too many acceptance criteria.");
	return Object.freeze(unique);
}

export function v2ReportMode(contract: ChildRuntimeContract, acceptance: readonly string[]): SubagentReportMode {
	return contract.result.outputSchema || acceptance.length || contract.agent.name === "review"
		? "structured_report"
		: "plain_final_turn";
}

/** Result-format instructions only; this never grants tools or executes declared checks. */
export function renderV2ResultInstructions(contract: ChildRuntimeContract, acceptance: readonly string[]): string {
	if (v2ReportMode(contract, acceptance) === "plain_final_turn") return "";
	return [
		"[ICE V2 FINAL RESULT CONTRACT]",
		`The complete JSON report must fit ${SUBAGENT_REPORT_PARSER_LIMITS.maxBytes} UTF-8 bytes.`,

		"Return a bounded JSON report with summary (nonempty string), evidence: {paths: [in-scope paths you successfully accessed during THIS task]}, and optionally findings: [{severity: low|medium|high, category, claim, evidence: [{path}]}].",
		"Evidence and every finding must cite files successfully accessed using read/grep/edit/write during this task; file existence alone is not evidence. Do not invent commands, artifacts, or verification. Claims remain untrusted until parent checks.",
		...(acceptance.length
			? [
					"Include requirements: [{id, status: satisfied|partial|blocked|failed|not_attempted, evidencePaths: [paths], note?}]. Every required satisfied claim needs nonempty observed path evidence. IDs and requirements:",
					...acceptance.map((item, index) => `criterion-${index + 1}: ${item}`),
				]
			: []),
		...(contract.result.outputSchema
			? [`Include payload matching this local schema: ${JSON.stringify(contract.result.outputSchema)}`]
			: []),
		"Report uncertainty honestly. A valid payload is not semantic correctness, proof a test ran, or a reviewer verdict. No extra tool work is authorized by this format contract.",
	].join("\n");
}

function sameFileState(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

/** Bounded host dispatch observer. Bash/adapters/search text cannot mint file observations. */
export class V2ResultObservations {
	private readonly paths = new Map<string, Stats>();
	private readonly cwd: string;
	private readonly roots: readonly string[];
	constructor(cwd: string, roots: readonly string[]) {
		this.cwd = cwd;
		this.roots = roots;
	}

	startTool(toolName: string, args: Readonly<Record<string, unknown>>): ((success: boolean) => void) | undefined {
		if (!["read", "grep", "edit", "write"].includes(toolName) || typeof args.path !== "string") return undefined;
		let path: string;
		let before: Stats | undefined;
		try {
			path = resolveProspectivePath(resolve(this.cwd, args.path));
			if (!this.roots.some((root) => pathIsWithin(root, path))) return undefined;
			try {
				before = statSync(path);
			} catch {
				/* New write targets have no preimage. */
			}
			if ((toolName === "read" || toolName === "grep") && !before?.isFile()) return undefined;
		} catch {
			return undefined;
		}
		return (success) => {
			if (!success || (this.paths.size >= 1024 && !this.paths.has(path))) return;
			try {
				const after = statSync(path);
				if (realpathSync(path) !== path || !after.isFile()) return;
				if ((toolName === "read" || toolName === "grep") && before && !sameFileState(before, after)) return;
				this.paths.set(path, after);
			} catch {
				/* Failed/deleted/symlink-replaced files are not evidence. */
			}
		};
	}

	checkedPath(raw: string): string | undefined {
		const candidates = [
			resolve(this.cwd, raw),
			...(!isAbsolute(raw) ? this.roots.map((root) => resolve(root, raw)) : []),
		];
		for (const candidate of candidates) {
			try {
				const canonical = realpathSync(candidate);
				const observed = this.paths.get(canonical);
				if (
					observed &&
					this.roots.some((root) => pathIsWithin(root, canonical)) &&
					sameFileState(observed, statSync(canonical))
				)
					return canonical;
			} catch {
				// No filesystem read of content; continue to the next approved root.
			}
		}
		return undefined;
	}
}

export function validateV2Result(
	contract: ChildRuntimeContract,
	acceptance: readonly string[],
	text: string,
	outcome: ChildTurnOutcome,
	observations: V2ResultObservations,
): V2ResultValidation {
	const reportMode = v2ReportMode(contract, acceptance);
	const result: V2ResultValidation = {
		reportMode,
		verified: false,
		assurance: "unverified_plain",
		reason: "Plain answer: no evidence or semantic claims verified.",
		paths: [],
		requirements: acceptance.map((requirement, index) => ({
			id: `criterion-${index + 1}`,
			required: true,
			requirement,
			semanticVerified: false,
			verified: false,
			note: "No accepted claim/evidence for this required criterion.",
		})),
	};
	if (outcome !== "completed")
		return { ...result, reason: `Non-completed task (${outcome}); no verification claimed.` };
	if (reportMode === "plain_final_turn") return result;
	const parsed = parseSubagentReportOutcome(
		text,
		SUBAGENT_REPORT_PARSER_LIMITS.maxBytes,
		normalizeSubagentOutputSchema(contract.result.outputSchema),
	);
	if (parsed.kind !== "valid") return { ...result, reason: parsed.diagnostic };
	const { report } = parsed;
	const paths: string[] = [];
	for (const path of report.paths) {
		const checked = observations.checkedPath(path);
		if (!checked)
			return {
				...result,
				reason: `Evidence was not successfully accessed in this task or is outside scope: ${redactCredentialText(path)}`,
			};
		paths.push(checked);
	}
	const findings: ReviewFinding[] = [];
	for (const finding of report.findings) {
		const evidence: Array<{ path: string }> = [];
		for (const ref of finding.evidence) {
			const checked = observations.checkedPath(ref.path);
			if (!checked)
				return {
					...result,
					reason: `Finding evidence was not observed in this task: ${redactCredentialText(ref.path)}`,
				};
			evidence.push({ path: checked });
		}
		findings.push({ ...finding, evidence });
	}
	const requirements = acceptance.map((requirement, index): V2ResultValidation["requirements"][number] => {
		const id = `criterion-${index + 1}`;
		const claim = report.requirementClaims.find((entry) => entry.id === id);
		const verified =
			claim?.status === "satisfied" &&
			!!claim.evidencePaths?.length &&
			claim.evidencePaths.every((path) => observations.checkedPath(path) !== undefined);
		return {
			id,
			required: true,
			requirement,
			semanticVerified: false,
			verified,
			...(claim ? { claim: claim.status } : {}),
			...(!verified ? { note: claim?.note ?? "Missing/unsatisfied claim or unobserved path evidence." } : {}),
		};
	});
	const verified = requirements.every((criterion) => criterion.verified);
	return {
		...result,
		verified,
		assurance: deriveSubagentAssuranceLevel({
			reportMode,
			evidenceChecked: true,
			// String criteria only establish claim/evidence consistency, not semantic satisfaction.
			requiredCriteriaAllVerified: false,
			verificationCommandObserved: false,
			verificationCommandPassed: false,
			reviewerVerified: false,
		}),
		reason: verified
			? "Report shape, in-scope observed file evidence, and required claims checked. Semantic correctness and executed tests/reviewer verdict remain unverified."
			: "Required acceptance claims or their observed evidence are missing/unsatisfied.",
		paths: [...new Set(paths)],
		requirements,
		...(verified && report.payload ? { payload: report.payload } : {}),
		findings,
	};
}
