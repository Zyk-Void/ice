import { redactCredentialText } from "./utils/redact.ts";

/**
 * Pure assurance-level and evidence-verification library for ICE subagent
 * results (plan 5.1, 5.3, 5.4, 5.6).
 *
 * Assurance levels are descriptive runtime states derived from observed
 * facts, never model confidence scores. Evidence and implementation claims
 * are validated against runtime-owned observation state only: a child-authored
 * string claiming a command ran or a file changed is never trusted on its own.
 * The module performs no I/O: every path comparison is lexical, and command
 * evidence must come from observed tool execution state supplied by the host.
 *
 * All functions are total and deterministic. They never throw on well-formed
 * input; contradictory claims are classified instead of rejected with errors,
 * so uncertainty survives to the parent (plan 5.6).
 */

export type SubagentAssuranceLevel =
	| "unverified_plain"
	| "evidence_checked"
	| "criteria_verified"
	| "verification_executed"
	| "review_verified";

export type SubagentReportMode = "plain_final_turn" | "structured_report";

export interface SubagentAssuranceLevelInput {
	reportMode: SubagentReportMode;
	evidenceChecked: boolean;
	requiredCriteriaAllVerified: boolean;
	verificationCommandObserved: boolean;
	verificationCommandPassed: boolean;
	reviewerVerified: boolean;
}

/**
 * Short parent-facing descriptions per assurance level. The plain level is
 * bounds-checked only: the wording never presents bounds/lineage checking as
 * verification work.
 */
export const SUBAGENT_ASSURANCE_LEVEL_TEXT: Record<SubagentAssuranceLevel, string> = Object.freeze({
	unverified_plain: "bounds-checked only (lineage and output limits; no evidence validation)",
	evidence_checked: "reported evidence checked against observed runtime state",
	criteria_verified: "required acceptance criteria verified against observed evidence",
	verification_executed: "declared verification command observed in runtime state and succeeded",
	review_verified: "reviewer verdict confirmed the result in addition to deterministic checks",
});

/**
 * Derive the highest applicable assurance level with strict precedence
 * review_verified > verification_executed > criteria_verified >
 * evidence_checked > unverified_plain.
 *
 * Guardrails:
 * - `plain_final_turn` caps the level at `unverified_plain` regardless of
 *   flags; a plain final turn carries no validated evidence.
 * - `verification_executed` requires the verification command to be both
 *   observed in runtime state and to have succeeded.
 * - `criteria_verified` requires every required criterion to be verified.
 * - `evidence_checked` requires evidence to have been checked.
 */
export function deriveSubagentAssuranceLevel(input: SubagentAssuranceLevelInput): SubagentAssuranceLevel {
	if (input.reportMode === "plain_final_turn") return "unverified_plain";
	if (input.reviewerVerified) return "review_verified";
	if (input.verificationCommandObserved && input.verificationCommandPassed) return "verification_executed";
	if (input.requiredCriteriaAllVerified) return "criteria_verified";
	if (input.evidenceChecked) return "evidence_checked";
	return "unverified_plain";
}

export type SubagentEvidenceDescriptor =
	| { kind: "path"; id: string; path: string }
	| { kind: "artifact"; id: string; artifactId: string }
	| { kind: "command"; id: string; command: string; claimedExitStatus?: number }
	| { kind: "diff"; id: string; changedPaths: readonly string[] }
	| { kind: "not_run"; id: string; reason: string };

export interface SubagentObservedCommand {
	command: string;
	exitStatus: number;
}

export interface SubagentEvidenceObservation {
	/** Paths the runtime observed the child actually read or wrote. */
	observedPaths: readonly string[];
	/** Commands the runtime observed being executed, with their exit statuses. */
	observedCommands: readonly SubagentObservedCommand[];
	/** Artifact ids owned by the current owner/run. */
	ownedArtifactIds: readonly string[];
	/** Changed paths owned by the current run; omitted disables diff verification. */
	ownedChangedPaths?: readonly string[];
}

export interface SubagentEvidenceValidationResult {
	verifiedIds: string[];
	unverifiedIds: string[];
	fabricatedIds: string[];
	/** verified / total descriptor count; 0 when there are no descriptors. */
	precision: number;
}

/**
 * Lexically normalizes a path without touching the filesystem: collapses
 * duplicate separators, drops "." segments, and resolves ".." segments.
 * Leading ".." segments that escape above the root are preserved so escaping
 * claims can never match an in-root observed path. Absolute paths keep their
 * leading "/" and never conflate with relative paths.
 */
function normalizeLexicalPath(raw: string): string {
	const absolute = raw.startsWith("/");
	const stack: string[] = [];
	for (const segment of raw.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			const last = stack[stack.length - 1];
			if (last !== undefined && last !== "..") stack.pop();
			else if (!absolute) stack.push("..");
			// An absolute path cannot go above its root; "/.." stays at "/".
			continue;
		}
		stack.push(segment);
	}
	const joined = stack.join("/");
	return absolute ? `/${joined}` : joined;
}

/** Case-sensitive command comparison key: collapse all whitespace runs to single spaces. */
function collapseCommandWhitespace(command: string): string {
	return command
		.split(/\s+/)
		.filter((part) => part.length > 0)
		.join(" ");
}

/**
 * Classify child-reported evidence claims against runtime-owned observation
 * state.
 *
 * Per kind:
 * - path: verified iff the path matches an observed path exactly or under the
 *   lexical normalization above; otherwise fabricated.
 * - artifact: verified iff the artifact id is owned by the current run;
 *   otherwise fabricated (stale or invented ownership).
 * - command: verified iff an observed command matches after whitespace
 *   collapsing and, when a claimed exit status is present, the observed exit
 *   status equals it. A command never observed (or observed with a different
 *   exit status than claimed) is fabricated.
 * - diff: verified iff every changed path is owned by the current run. When
 *   ownership data is not provided the claim stays unverified, never
 *   fabricated; when it is provided and a path is not owned, the claim is
 *   fabricated.
 * - not_run: always verified; reporting uncertainty is honest, never
 *   fabricated.
 */
export function validateSubagentEvidenceClaims(
	descriptors: readonly SubagentEvidenceDescriptor[],
	observed: SubagentEvidenceObservation,
): SubagentEvidenceValidationResult {
	const observedPathSet = new Set(observed.observedPaths.map(normalizeLexicalPath).filter((path) => path.length > 0));
	const ownedArtifactIds = new Set(observed.ownedArtifactIds);
	const ownedChangedPaths =
		observed.ownedChangedPaths === undefined
			? undefined
			: new Set(observed.ownedChangedPaths.map(normalizeLexicalPath).filter((path) => path.length > 0));
	const observedCommands = observed.observedCommands
		.map((entry) => ({ command: collapseCommandWhitespace(entry.command), exitStatus: entry.exitStatus }))
		.filter((entry) => entry.command.length > 0);

	const verifiedIds: string[] = [];
	const unverifiedIds: string[] = [];
	const fabricatedIds: string[] = [];

	for (const descriptor of descriptors) {
		let verdict: "verified" | "unverified" | "fabricated";
		switch (descriptor.kind) {
			case "path": {
				const normalized = normalizeLexicalPath(descriptor.path);
				verdict = normalized.length > 0 && observedPathSet.has(normalized) ? "verified" : "fabricated";
				break;
			}
			case "artifact": {
				verdict = ownedArtifactIds.has(descriptor.artifactId) ? "verified" : "fabricated";
				break;
			}
			case "command": {
				const claimed = collapseCommandWhitespace(descriptor.command);
				const matched =
					claimed.length > 0 &&
					observedCommands.some(
						(entry) =>
							entry.command === claimed &&
							(descriptor.claimedExitStatus === undefined || entry.exitStatus === descriptor.claimedExitStatus),
					);
				verdict = matched ? "verified" : "fabricated";
				break;
			}
			case "diff": {
				if (ownedChangedPaths === undefined) {
					verdict = "unverified";
					break;
				}
				verdict = descriptor.changedPaths.every((changedPath) => {
					const normalized = normalizeLexicalPath(changedPath);
					return normalized.length > 0 && ownedChangedPaths.has(normalized);
				})
					? "verified"
					: "fabricated";
				break;
			}
			case "not_run": {
				verdict = "verified";
				break;
			}
		}
		if (verdict === "verified") verifiedIds.push(descriptor.id);
		else if (verdict === "unverified") unverifiedIds.push(descriptor.id);
		else fabricatedIds.push(descriptor.id);
	}

	const total = descriptors.length;
	return {
		verifiedIds,
		unverifiedIds,
		fabricatedIds,
		precision: total === 0 ? 0 : verifiedIds.length / total,
	};
}

export type SubagentImplementationFileMismatchReason = "not_in_patch" | "outside_workspace";
export type SubagentImplementationCommandMismatchReason = "not_observed" | "exit_status_mismatch";

export interface SubagentImplementationFileMismatch {
	path: string;
	reason: SubagentImplementationFileMismatchReason;
}

export interface SubagentImplementationCommandMismatch {
	command: string;
	reason: SubagentImplementationCommandMismatchReason;
}

export interface SubagentImplementationClaimsInput {
	modifiedFiles: readonly string[];
	ranCommands: readonly SubagentObservedCommand[];
}

export interface SubagentImplementationClaimsObservation {
	/** Changed paths owned by the current run, relative to the workspace root. */
	changedPaths: readonly string[];
	observedCommands: readonly SubagentObservedCommand[];
	/** Lexical workspace root; omitted disables the workspace containment check. */
	workspaceRoot?: string;
}

export interface SubagentImplementationClaimsResult {
	fileMismatches: SubagentImplementationFileMismatch[];
	commandMismatches: SubagentImplementationCommandMismatch[];
	consistent: boolean;
}

interface LexicalPlacement {
	/** Path relative to the root; "" when the claim resolves to the root itself. */
	rel: string;
	inside: boolean;
}

/**
 * Lexically place a claimed path relative to a workspace root without
 * touching the filesystem. Absolute claims are contained only when their
 * normalized form sits under the normalized absolute root; with a relative
 * root an absolute claim fails closed as outside. Relative claims are walked
 * segment by segment on top of the root; any ".." that would climb above the
 * root marks the claim as outside.
 */
function placeLexicalPathUnderRoot(root: string, raw: string): LexicalPlacement {
	const normalizedRoot = normalizeLexicalPath(root);
	if (raw.startsWith("/")) {
		if (!normalizedRoot.startsWith("/")) return { rel: raw, inside: false };
		if (normalizedRoot === "/") {
			const rel = normalizeLexicalPath(raw).slice(1);
			return { rel, inside: rel.length > 0 };
		}
		const normalizedRaw = normalizeLexicalPath(raw);
		const prefix = `${normalizedRoot}/`;
		if (normalizedRaw === normalizedRoot) return { rel: "", inside: true };
		if (!normalizedRaw.startsWith(prefix)) return { rel: raw, inside: false };
		return { rel: normalizedRaw.slice(prefix.length), inside: true };
	}
	const rootSegments = normalizedRoot === "/" ? [] : normalizedRoot.replace(/^\//, "").split("/");
	const stack = [...rootSegments];
	const rootDepth = stack.length;
	for (const segment of raw.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (stack.length > rootDepth) stack.pop();
			else return { rel: "", inside: false };
			continue;
		}
		stack.push(segment);
	}
	return { rel: stack.slice(rootDepth).join("/"), inside: true };
}

/**
 * Validate child implementation claims (modified files, executed commands)
 * against runtime-owned facts: the observed changed-path set, observed command
 * executions with exit statuses, and the lexical workspace root.
 *
 * Files are matched against the changed-path set under lexical path
 * normalization. When a workspace root is given, a claim that lexically
 * escapes the root is reported as `outside_workspace` (checked first, so an
 * escaping path is never also reported as not-in-patch); otherwise a claimed
 * file absent from the changed-path set is `not_in_patch`. Commands must
 * match an observed command after whitespace collapsing with the claimed exit
 * status: unmatched commands are `not_observed`, commands observed with a
 * different exit status are `exit_status_mismatch`. `consistent` is true only
 * when both mismatch lists are empty.
 */
export function validateSubagentImplementationClaims(
	claims: SubagentImplementationClaimsInput,
	observed: SubagentImplementationClaimsObservation,
): SubagentImplementationClaimsResult {
	const changedPathSet = new Set(observed.changedPaths.map(normalizeLexicalPath).filter((path) => path.length > 0));
	const observedCommands = observed.observedCommands
		.map((entry) => ({ command: collapseCommandWhitespace(entry.command), exitStatus: entry.exitStatus }))
		.filter((entry) => entry.command.length > 0);

	const fileMismatches: SubagentImplementationFileMismatch[] = [];
	for (const claimedPath of claims.modifiedFiles) {
		if (observed.workspaceRoot !== undefined) {
			const placement = placeLexicalPathUnderRoot(observed.workspaceRoot, claimedPath);
			if (!placement.inside) {
				fileMismatches.push({ path: claimedPath, reason: "outside_workspace" });
				continue;
			}
			if (!changedPathSet.has(placement.rel)) {
				fileMismatches.push({ path: claimedPath, reason: "not_in_patch" });
				continue;
			}
			continue;
		}
		if (!changedPathSet.has(normalizeLexicalPath(claimedPath))) {
			fileMismatches.push({ path: claimedPath, reason: "not_in_patch" });
		}
	}

	const commandMismatches: SubagentImplementationCommandMismatch[] = [];
	for (const claimedCommand of claims.ranCommands) {
		const claimed = collapseCommandWhitespace(claimedCommand.command);
		if (claimed.length === 0) {
			commandMismatches.push({ command: claimedCommand.command, reason: "not_observed" });
			continue;
		}
		const sameCommand = observedCommands.filter((entry) => entry.command === claimed);
		if (sameCommand.length === 0) {
			commandMismatches.push({ command: claimedCommand.command, reason: "not_observed" });
			continue;
		}
		if (!sameCommand.some((entry) => entry.exitStatus === claimedCommand.exitStatus)) {
			commandMismatches.push({ command: claimedCommand.command, reason: "exit_status_mismatch" });
		}
	}

	return {
		fileMismatches,
		commandMismatches,
		consistent: fileMismatches.length === 0 && commandMismatches.length === 0,
	};
}

export const SUBAGENT_ASSURANCE_SECTION_LIMITS = {
	maxSectionBytes: 2048,
	maxListItems: 8,
	maxItemTextBytes: 256,
} as const;

const SECTION_HEADER = "## Result assurance";
const SECTION_TRUNCATION_MARKER = "\n[assurance section truncated]";
const ITEM_TRUNCATION_MARKER = "[truncated]";

export interface SubagentAssuranceSectionValidation {
	evidence?: SubagentEvidenceValidationResult;
	implementation?: SubagentImplementationClaimsResult;
}

function truncateUtf8Bounded(text: string, maxBytes: number, marker: string): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maxBytes) return text;
	const markerBytes = Buffer.byteLength(marker, "utf8");
	let end = Math.max(0, maxBytes - markerBytes);
	while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}${marker}`;
}

function truncateItemText(text: string): string {
	return truncateUtf8Bounded(text, SUBAGENT_ASSURANCE_SECTION_LIMITS.maxItemTextBytes, ITEM_TRUNCATION_MARKER);
}

/** Lexicographic sort: locale-independent so rendering is deterministic. */
function lexicographic(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function pushBoundedIdList(lines: string[], label: string, ids: readonly string[]): void {
	if (ids.length === 0) return;
	const ordered = [...ids].sort(lexicographic);
	const shown = ordered.slice(0, SUBAGENT_ASSURANCE_SECTION_LIMITS.maxListItems).map(truncateItemText);
	const suffix =
		ordered.length > SUBAGENT_ASSURANCE_SECTION_LIMITS.maxListItems
			? ` (+${ordered.length - SUBAGENT_ASSURANCE_SECTION_LIMITS.maxListItems} more)`
			: "";
	lines.push(`${label}: ${shown.join(", ")}${suffix}`);
}

/**
 * Render a deterministic, bounded (<= 2 KiB) parent-facing assurance section.
 * Lists are sorted, capped, and per-item truncated; the result is redacted
 * and byte-truncated so it can never exceed
 * SUBAGENT_ASSURANCE_SECTION_LIMITS.maxSectionBytes.
 */
export function renderSubagentAssuranceSection(
	level: SubagentAssuranceLevel,
	validation: SubagentAssuranceSectionValidation,
): string {
	const levelText = SUBAGENT_ASSURANCE_LEVEL_TEXT[level] ?? "unknown assurance level";
	const lines: string[] = [SECTION_HEADER, `level: ${level} - ${levelText}`];

	const evidence = validation.evidence;
	if (evidence) {
		const total = evidence.verifiedIds.length + evidence.unverifiedIds.length + evidence.fabricatedIds.length;
		lines.push(
			`evidence: ${evidence.verifiedIds.length}/${total} verified, ${evidence.unverifiedIds.length} unverified, ${evidence.fabricatedIds.length} fabricated, precision ${evidence.precision.toFixed(3)}`,
		);
		pushBoundedIdList(lines, "fabricated evidence ids", evidence.fabricatedIds);
		pushBoundedIdList(lines, "unverified evidence ids", evidence.unverifiedIds);
	}

	const implementation = validation.implementation;
	if (implementation) {
		const fileCount = implementation.fileMismatches.length;
		const commandCount = implementation.commandMismatches.length;
		if (fileCount === 0 && commandCount === 0) {
			lines.push("implementation claims: consistent with observed runtime state");
		} else {
			lines.push(`implementation claims: inconsistent (${fileCount} file, ${commandCount} command mismatches)`);
			const maxItems = SUBAGENT_ASSURANCE_SECTION_LIMITS.maxListItems;
			for (const mismatch of implementation.fileMismatches.slice(0, maxItems)) {
				lines.push(`- file: ${truncateItemText(mismatch.path)} (${mismatch.reason})`);
			}
			if (fileCount > maxItems) lines.push(`- ... ${fileCount - maxItems} more file mismatches`);
			for (const mismatch of implementation.commandMismatches.slice(0, maxItems)) {
				lines.push(`- command: ${truncateItemText(mismatch.command)} (${mismatch.reason})`);
			}
			if (commandCount > maxItems) lines.push(`- ... ${commandCount - maxItems} more command mismatches`);
		}
	}

	return truncateUtf8Bounded(
		redactCredentialText(lines.join("\n")),
		SUBAGENT_ASSURANCE_SECTION_LIMITS.maxSectionBytes,
		SECTION_TRUNCATION_MARKER,
	);
}
