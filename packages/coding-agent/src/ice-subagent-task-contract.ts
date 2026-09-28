import { createHash } from "node:crypto";
import { redactCredentialText } from "./utils/redact.ts";

/**
 * Host-owned Delegation Task Contract.
 *
 * The contract normalizes what a parent delegatee needs before a subagent
 * runs: task kind, objective, deliverable, constraints, non-goals, known
 * facts, and declared verification. Everything is normalized, bounded, and
 * redacted here in the host so a model never has to infer structure.
 *
 * Acceptance criteria are deliberately not part of the contract. They stay
 * owned by the existing acceptance-criteria machinery in
 * `src/ice-subagents.ts`; the integration layer attaches them alongside the
 * contract instead of duplicating them here.
 *
 * Verification commands are declarations only. This module enforces nothing
 * at runtime; execution authority still comes from the child's approved
 * tools and Ice's permission rules.
 */

export const SUBAGENT_TASK_CONTRACT_LIMITS = {
	maxListItems: 8,
	maxItemBytes: 1024,
	maxKnownFactTextBytes: 2048,
	maxVerificationCommands: 4,
	maxCommandBytes: 512,
	maxSectionBytes: 4096,
} as const;

export type SubagentTaskContractKind = "explore" | "research" | "review" | "implement" | "verify";
export type SubagentTaskVerificationMode = "evidence" | "tests" | "review" | "none";
export type SubagentQualityMode = "explore" | "standard" | "strict";

export interface SubagentTaskContractKnownFact {
	id: string;
	text: string;
}

export interface SubagentTaskContractVerification {
	mode: SubagentTaskVerificationMode;
	commands?: readonly string[];
}

export interface SubagentTaskContract {
	kind: SubagentTaskContractKind;
	objective: string;
	deliverable: string;
	constraints: readonly string[];
	nonGoals: readonly string[];
	knownFacts: readonly SubagentTaskContractKnownFact[];
	verification: SubagentTaskContractVerification;
}

export interface SubagentTaskContractKnownFactInput {
	id: string;
	text: string;
}

export interface SubagentTaskContractVerificationInput {
	mode?: SubagentTaskVerificationMode;
	commands?: readonly string[];
}

/**
 * Parent-facing contract fields. The objective is not part of this type; it
 * comes from the existing subagent `task` field and is supplied separately to
 * `buildSubagentTaskContract`. Unknown top-level keys (tools, scope, model,
 * MCP, and anything else) are rejected so the contract cannot become a
 * channel for capability escalation.
 */
export interface SubagentTaskContractInput {
	kind?: SubagentTaskContractKind;
	deliverable?: string;
	constraints?: readonly string[];
	nonGoals?: readonly string[];
	knownFacts?: readonly SubagentTaskContractKnownFactInput[];
	verification?: SubagentTaskContractVerificationInput;
}

export type SubagentTaskContractErrorCode = "contract_invalid" | "contract_oversized";

export class SubagentTaskContractError extends Error {
	readonly code: SubagentTaskContractErrorCode;

	constructor(code: SubagentTaskContractErrorCode, message: string) {
		super(message);
		this.name = "SubagentTaskContractError";
		this.code = code;
	}
}

const CONTRACT_INPUT_KEYS: readonly string[] = [
	"kind",
	"deliverable",
	"constraints",
	"nonGoals",
	"knownFacts",
	"verification",
];
const VERIFICATION_INPUT_KEYS: readonly string[] = ["mode", "commands"];
const KNOWN_FACT_KEYS: readonly string[] = ["id", "text"];
const CONTRACT_KINDS: readonly string[] = ["explore", "research", "review", "implement", "verify"];
const VERIFICATION_MODES: readonly string[] = ["evidence", "tests", "review", "none"];
const KNOWN_FACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const DEFAULT_DELIVERABLES: Readonly<Record<SubagentTaskContractKind, string>> = Object.freeze({
	explore: "A bounded answer with supporting evidence paths",
	research: "A research summary with cited evidence and findings",
	review: "A review report with file-level findings and a verdict",
	implement: "A completed scoped change with observed verification",
	verify: "A verification report with observed command results",
});

const SECTION_HEADER = "## Delegation task contract";
const COMMAND_DECLARATION_LABEL =
	"declared verification commands (declarations only; runtime authority comes from approved tools)";
const SECTION_TRUNCATION_MARKER = "\n[task contract section truncated]";

function asPlainObject(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SubagentTaskContractError("contract_invalid", `Task contract ${label} must be a plain object.`);
	}
	return value as Record<string, unknown>;
}

function assertKnownKeys(value: object, known: readonly string[], label: string): void {
	const unknown = Object.keys(value)
		.filter((key) => !known.includes(key))
		.sort();
	if (unknown.length > 0) {
		throw new SubagentTaskContractError(
			"contract_invalid",
			`Task contract ${label} has unsupported keys: ${unknown.join(", ")}.`,
		);
	}
}

function normalizeRequiredText(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new SubagentTaskContractError("contract_invalid", `Task contract ${field} must be a string.`);
	}
	const text = redactCredentialText(value).trim();
	if (text.length === 0) {
		throw new SubagentTaskContractError("contract_invalid", `Task contract ${field} must be a nonempty string.`);
	}
	return text;
}

function normalizeBoundedText(value: unknown, field: string, maxBytes: number): string {
	const text = normalizeRequiredText(value, field);
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		throw new SubagentTaskContractError(
			"contract_oversized",
			`Task contract ${field} exceeds the ${maxBytes} UTF-8 byte limit.`,
		);
	}
	return text;
}

function normalizeBoundedList(values: unknown, field: string, maxItems: number, maxItemBytes: number): string[] {
	if (!Array.isArray(values)) {
		throw new SubagentTaskContractError("contract_invalid", `Task contract ${field} must be an array of strings.`);
	}
	const items: readonly unknown[] = values;
	if (items.length > maxItems) {
		throw new SubagentTaskContractError(
			"contract_oversized",
			`Task contract ${field} has more than ${maxItems} items.`,
		);
	}
	return items.map((item, index) => normalizeBoundedText(item, `${field}[${index}]`, maxItemBytes));
}

function normalizeKind(value: unknown): SubagentTaskContractKind {
	if (typeof value !== "string" || !CONTRACT_KINDS.includes(value)) {
		throw new SubagentTaskContractError(
			"contract_invalid",
			`Task contract kind must be one of: ${CONTRACT_KINDS.join(", ")}.`,
		);
	}
	return value as SubagentTaskContractKind;
}

function normalizeVerificationMode(value: unknown): SubagentTaskVerificationMode {
	if (typeof value !== "string" || !VERIFICATION_MODES.includes(value)) {
		throw new SubagentTaskContractError(
			"contract_invalid",
			`Task contract verification mode must be one of: ${VERIFICATION_MODES.join(", ")}.`,
		);
	}
	return value as SubagentTaskVerificationMode;
}

function normalizeVerificationCommands(values: unknown): string[] {
	if (!Array.isArray(values)) {
		throw new SubagentTaskContractError(
			"contract_invalid",
			"Task contract verification commands must be an array of strings.",
		);
	}
	const items: readonly unknown[] = values;
	if (items.length > SUBAGENT_TASK_CONTRACT_LIMITS.maxVerificationCommands) {
		throw new SubagentTaskContractError(
			"contract_oversized",
			`Task contract verification has more than ${SUBAGENT_TASK_CONTRACT_LIMITS.maxVerificationCommands} commands.`,
		);
	}
	return items.map((command, index) =>
		normalizeBoundedText(command, `verification command ${index}`, SUBAGENT_TASK_CONTRACT_LIMITS.maxCommandBytes),
	);
}

function normalizeVerification(value: unknown): SubagentTaskContractVerification {
	if (value === undefined) return { mode: "none", commands: Object.freeze([]) };
	const source = asPlainObject(value, "verification");
	assertKnownKeys(source, VERIFICATION_INPUT_KEYS, "verification");
	const mode: SubagentTaskVerificationMode =
		source.mode === undefined ? "none" : normalizeVerificationMode(source.mode);
	const commands = source.commands === undefined ? [] : normalizeVerificationCommands(source.commands);
	return { mode, commands: Object.freeze(commands) };
}

function normalizeKnownFacts(values: unknown): SubagentTaskContractKnownFact[] {
	if (!Array.isArray(values)) {
		throw new SubagentTaskContractError(
			"contract_invalid",
			"Task contract knownFacts must be an array of { id, text } objects.",
		);
	}
	const items: readonly unknown[] = values;
	if (items.length > SUBAGENT_TASK_CONTRACT_LIMITS.maxListItems) {
		throw new SubagentTaskContractError(
			"contract_oversized",
			`Task contract knownFacts has more than ${SUBAGENT_TASK_CONTRACT_LIMITS.maxListItems} items.`,
		);
	}
	const seen = new Set<string>();
	return items.map((entry, index) => {
		const source = asPlainObject(entry, `known fact ${index}`);
		assertKnownKeys(source, KNOWN_FACT_KEYS, `known fact ${index}`);
		if (typeof source.id !== "string") {
			throw new SubagentTaskContractError(
				"contract_invalid",
				`Task contract known fact ${index} id must be a string.`,
			);
		}
		const id = redactCredentialText(source.id).trim();
		if (!KNOWN_FACT_ID_PATTERN.test(id)) {
			throw new SubagentTaskContractError(
				"contract_invalid",
				`Task contract known fact ${index} id "${id}" must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.`,
			);
		}
		if (seen.has(id)) {
			throw new SubagentTaskContractError(
				"contract_invalid",
				`Task contract known fact id "${id}" is duplicated; ids must be unique.`,
			);
		}
		seen.add(id);
		const text = normalizeBoundedText(
			source.text,
			`known fact ${index} text`,
			SUBAGENT_TASK_CONTRACT_LIMITS.maxKnownFactTextBytes,
		);
		return { id, text };
	});
}

/**
 * Build a frozen, normalized task contract. The objective comes from the
 * parent's existing `task` field and must be nonempty after trimming; every
 * other field defaults deterministically. Oversized or malformed input is
 * rejected with a {@link SubagentTaskContractError} instead of being
 * silently truncated.
 */
export function buildSubagentTaskContract(
	objective: string,
	input: SubagentTaskContractInput = {},
): SubagentTaskContract {
	asPlainObject(input, "input");
	assertKnownKeys(input, CONTRACT_INPUT_KEYS, "input");
	const kind = input.kind === undefined ? "explore" : normalizeKind(input.kind);
	const normalizedObjective = normalizeRequiredText(objective, "objective");
	const deliverable =
		input.deliverable === undefined
			? DEFAULT_DELIVERABLES[kind]
			: normalizeBoundedText(input.deliverable, "deliverable", SUBAGENT_TASK_CONTRACT_LIMITS.maxItemBytes);
	const contract: SubagentTaskContract = {
		kind,
		objective: normalizedObjective,
		deliverable,
		constraints: Object.freeze(
			normalizeBoundedList(
				input.constraints ?? [],
				"constraints",
				SUBAGENT_TASK_CONTRACT_LIMITS.maxListItems,
				SUBAGENT_TASK_CONTRACT_LIMITS.maxItemBytes,
			),
		),
		nonGoals: Object.freeze(
			normalizeBoundedList(
				input.nonGoals ?? [],
				"non-goals",
				SUBAGENT_TASK_CONTRACT_LIMITS.maxListItems,
				SUBAGENT_TASK_CONTRACT_LIMITS.maxItemBytes,
			),
		),
		knownFacts: Object.freeze(normalizeKnownFacts(input.knownFacts ?? []).map((fact) => Object.freeze(fact))),
		verification: Object.freeze(normalizeVerification(input.verification)),
	};
	return Object.freeze(contract);
}

export interface DeriveSubagentQualityModeOptions {
	hasAcceptanceCriteria: boolean;
	hasOutputSchema: boolean;
	forced?: "strict" | undefined;
	/**
	 * True when the contract kind came from normalization defaulting rather
	 * than an explicit parent choice. Per the quality plan, substantial
	 * delegated tasks default to `standard`; only an explicitly requested
	 * `kind: "explore"` produces the evidence-limited explore mode.
	 */
	defaultedKind?: boolean | undefined;
}

/**
 * Derive the bounded quality mode for a delegated task. Strict is forced by
 * explicit override, acceptance criteria, an output schema, or review-mode
 * verification. Explore is reserved for explicitly requested exploration
 * tasks with no criteria or schema whose verification is evidence-only or
 * absent. Everything else is standard.
 */
export function deriveSubagentQualityMode(
	contract: SubagentTaskContract,
	options: DeriveSubagentQualityModeOptions,
): SubagentQualityMode {
	if (options.forced === "strict") return "strict";
	if (options.hasAcceptanceCriteria || options.hasOutputSchema || contract.verification.mode === "review") {
		return "strict";
	}
	if (
		options.defaultedKind !== true &&
		contract.kind === "explore" &&
		(contract.verification.mode === "evidence" || contract.verification.mode === "none")
	) {
		return "explore";
	}
	return "standard";
}

function canonicalJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		const items: readonly unknown[] = value;
		return items.map(canonicalJsonValue);
	}
	if (value !== null && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const canonical: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			canonical[key] = canonicalJsonValue(source[key]);
		}
		return canonical;
	}
	return value;
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Deterministic sha256 over a canonical serialization of the contract with
 * stable, sorted key order and no fields excluded. Equal contracts hash
 * equally regardless of the key order the parent used to supply them.
 */
export function hashSubagentTaskContract(contract: SubagentTaskContract): string {
	return sha256Hex(JSON.stringify(canonicalJsonValue(contract)));
}

function truncateSectionUtf8(text: string): string {
	const maxBytes = SUBAGENT_TASK_CONTRACT_LIMITS.maxSectionBytes;
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maxBytes) return text;
	const markerBytes = Buffer.byteLength(SECTION_TRUNCATION_MARKER, "utf8");
	let end = Math.max(0, maxBytes - markerBytes);
	while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}${SECTION_TRUNCATION_MARKER}`;
}

/**
 * Render a bounded, deterministic, redacted prompt section for the child.
 * Declared verification commands are labeled as declarations only; runtime
 * authority comes from the child's approved tools. The result never exceeds
 * SUBAGENT_TASK_CONTRACT_LIMITS.maxSectionBytes.
 */
export function renderSubagentTaskContractSection(
	contract: SubagentTaskContract,
	qualityMode: SubagentQualityMode,
): string {
	const commands = contract.verification.commands ?? [];
	const lines: string[] = [
		SECTION_HEADER,
		`kind: ${contract.kind}`,
		`quality mode: ${qualityMode}`,
		`objective: ${contract.objective}`,
		`deliverable: ${contract.deliverable}`,
	];
	if (contract.constraints.length > 0) {
		lines.push("constraints:");
		for (const constraint of contract.constraints) lines.push(`- ${constraint}`);
	}
	if (contract.nonGoals.length > 0) {
		lines.push("non-goals:");
		for (const nonGoal of contract.nonGoals) lines.push(`- ${nonGoal}`);
	}
	if (contract.knownFacts.length > 0) {
		lines.push("known facts:");
		for (const fact of contract.knownFacts) lines.push(`- [${fact.id}] ${fact.text}`);
	}
	lines.push(`verification mode: ${contract.verification.mode}`);
	if (commands.length > 0) {
		lines.push(`${COMMAND_DECLARATION_LABEL}:`);
		for (const command of commands) lines.push(`- ${command}`);
	} else {
		lines.push(`${COMMAND_DECLARATION_LABEL}: none`);
	}
	return truncateSectionUtf8(redactCredentialText(lines.join("\n")));
}

/**
 * Phase 5.5: selective high-risk reviewer policy. Recommends the existing
 * review_batch gate when the declared contract cannot establish correctness
 * deterministically: implementation or verification work that declares no
 * executable verification (mode "none") and no reviewer verification. The
 * recommendation never launches anything by itself; the parent decides.
 */
export function recommendSubagentReviewerGate(contract: SubagentTaskContract): string | undefined {
	if (contract.kind !== "implement" && contract.kind !== "verify") return undefined;
	const policyText = [contract.objective, contract.deliverable, ...contract.constraints, ...contract.nonGoals]
		.join("\n")
		.toLowerCase();
	const highRisk =
		/\b(security|migration|migrate|refactor|shared infrastructure|shared runtime|core infrastructure)\b/u.test(
			policyText,
		);
	if (contract.verification.mode !== "none" && !highRisk) return undefined;
	if (contract.verification.mode === "review") return undefined;
	const reason = highRisk ? "high-risk change" : "deterministic verification gap";
	return (
		`Reviewer gate recommended (${reason}). ` +
		"Run review_batch over the produced change before integrating it; reuse the existing " +
		"security/correctness/regression review dimensions rather than launching a second reviewer framework."
	);
}
