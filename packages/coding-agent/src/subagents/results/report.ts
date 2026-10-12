/** Final report parsing, output schema validation, and result/requirement verification (moved from ice-subagents.ts). */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { redactCredentialText } from "../../utils/redact.ts";
import { SubagentError } from "../runtime/helpers.ts";
import { canonicalPath, isPathWithin } from "../tools/paths.ts";
import {
	type EvidenceRef,
	type NormalizedSubagentRequest,
	type ReviewFinding,
	SUBAGENT_ACCEPTANCE_LIMITS,
	SUBAGENT_OUTPUT_SCHEMA_LIMITS,
	SUBAGENT_REPORT_LIMITS,
	type SubagentAcceptanceCriterion,
	type SubagentOutputSchemaNode,
	type SubagentOutputSchemaType,
	type SubagentRequirementClaim,
	type SubagentRequirementState,
	type SubagentRequirementSummary,
	type SubagentResult,
	type SubagentVerification,
} from "../types.ts";
import { SUBAGENT_OUTPUT_ARTIFACT_LIMITS } from "./output-artifacts.ts";

export const SUBAGENT_HANDOFF_MARKER = "[ICE VOID SUBAGENT HANDOFF]";
export const INTERACTIVE_FINAL_REPORT_MARKER = "Your interactive work is complete.";
export const INTERACTIVE_FINAL_REPORT_PROMPT =
	`${INTERACTIVE_FINAL_REPORT_MARKER} Return only the required final bounded JSON report for the parent now. ` +
	"Do not continue discussion. Use the required schema and include only verified evidence within the approved scope. " +
	"This is an internal finalization request, not a new task or permission grant.";
export const INTERACTIVE_PLAIN_FINAL_PROMPT =
	`${INTERACTIVE_FINAL_REPORT_MARKER} Return your final answer for the parent now, in ordinary prose or markdown; do not wrap it in a JSON envelope. ` +
	"Do not continue discussion or start new work. Keep the answer bounded and include only verified results within the approved scope. " +
	"This is an internal finalization request, not a new task or permission grant.";
export const SUBAGENT_WRAP_UP_MARKER = "[ICE VOID SUBAGENT WRAP UP]";
export const SUBAGENT_WRAP_UP_PROMPT =
	`${SUBAGENT_WRAP_UP_MARKER} Remaining execution capacity is reserved for completion. Stop broad exploration and do not start new tool work. ` +
	"Use the current child session state to produce the required final response now, following the active final-output contract exactly. Preserve only observed, in-scope evidence. " +
	"This is an internal wrap-up request, not a new task or permission grant.";
const SUBAGENT_REPORT_REPAIR_MARKER = "[ICE VOID SUBAGENT REPORT REPAIR]";
export const SUBAGENT_REPORT_REPAIR_PROMPT =
	`${SUBAGENT_REPORT_REPAIR_MARKER} Your previous final report did not satisfy the required bounded JSON envelope. ` +
	"Return only the required final bounded JSON report now, with no other text. Do not repeat, redo, or describe implementation work; tools are disabled for this request. " +
	"Use the required schema and include only verified evidence within the approved scope. This is an internal one-time report repair, not a new task or permission grant.";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SUBAGENT_OUTPUT_SCHEMA_KEYS = new Set(["type", "properties", "required", "items", "additionalProperties"]);
const SUBAGENT_OUTPUT_SCHEMA_TYPES = new Set<SubagentOutputSchemaType>([
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null",
]);

/**
 * Validate and freeze the deliberately small local output-schema subset. `$ref`,
 * remote URLs, executable validators, unions, and unknown keywords are rejected
 * before a child session is created.
 */
export function normalizeSubagentOutputSchema(input: unknown): SubagentOutputSchemaNode | undefined {
	if (input === undefined) return undefined;
	let serialized: string;
	try {
		serialized = JSON.stringify(input);
	} catch {
		throw new SubagentError("invalid_request", "Subagent outputSchema must be finite JSON.");
	}
	if (Buffer.byteLength(serialized) > SUBAGENT_OUTPUT_SCHEMA_LIMITS.maxSchemaBytes) {
		throw new SubagentError("invalid_request", "Subagent outputSchema exceeds the bounded schema size.");
	}
	let nodes = 0;
	const visit = (value: unknown, depth: number, path: string): SubagentOutputSchemaNode => {
		if (!isRecord(value)) throw new SubagentError("invalid_request", `${path} must be a schema object.`);
		if (depth > SUBAGENT_OUTPUT_SCHEMA_LIMITS.maxDepth) {
			throw new SubagentError("invalid_request", "Subagent outputSchema exceeds the maximum depth.");
		}
		nodes += 1;
		if (nodes > SUBAGENT_OUTPUT_SCHEMA_LIMITS.maxNodes) {
			throw new SubagentError("invalid_request", "Subagent outputSchema contains too many nodes.");
		}
		for (const key of Object.keys(value)) {
			if (!SUBAGENT_OUTPUT_SCHEMA_KEYS.has(key)) {
				throw new SubagentError("invalid_request", `${path}.${key} is not supported in outputSchema.`);
			}
		}
		const type = value.type;
		if (typeof type !== "string" || !SUBAGENT_OUTPUT_SCHEMA_TYPES.has(type as SubagentOutputSchemaType)) {
			throw new SubagentError("invalid_request", `${path}.type is unsupported.`);
		}
		const node: {
			type: SubagentOutputSchemaType;
			properties?: Readonly<Record<string, SubagentOutputSchemaNode>>;
			required?: readonly string[];
			items?: SubagentOutputSchemaNode;
			additionalProperties?: false;
		} = { type: type as SubagentOutputSchemaType };
		if (type === "object") {
			if (value.additionalProperties !== false) {
				throw new SubagentError("invalid_request", `${path}.additionalProperties must be false.`);
			}
			const rawProperties = value.properties ?? {};
			if (!isRecord(rawProperties))
				throw new SubagentError("invalid_request", `${path}.properties must be an object.`);
			const propertyNames = Object.keys(rawProperties);
			if (propertyNames.length > SUBAGENT_OUTPUT_SCHEMA_LIMITS.maxPropertiesPerObject) {
				throw new SubagentError("invalid_request", `${path}.properties contains too many fields.`);
			}
			const properties: Record<string, SubagentOutputSchemaNode> = {};
			for (const name of propertyNames) {
				if (
					!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) ||
					Buffer.byteLength(name) > SUBAGENT_OUTPUT_SCHEMA_LIMITS.maxPropertyNameBytes
				) {
					throw new SubagentError("invalid_request", `${path}.properties contains an invalid field name.`);
				}
				properties[name] = visit(rawProperties[name], depth + 1, `${path}.properties.${name}`);
			}
			const rawRequired = value.required ?? [];
			if (!Array.isArray(rawRequired) || rawRequired.length > SUBAGENT_OUTPUT_SCHEMA_LIMITS.maxRequiredProperties) {
				throw new SubagentError("invalid_request", `${path}.required must be a bounded string array.`);
			}
			const required = [...new Set(rawRequired)];
			if (required.some((name): name is unknown => typeof name !== "string" || !Object.hasOwn(properties, name))) {
				throw new SubagentError("invalid_request", `${path}.required references an unknown field.`);
			}
			node.properties = Object.freeze(properties);
			node.required = Object.freeze(required as string[]);
			node.additionalProperties = false;
		} else if (type === "array") {
			if (value.items === undefined) throw new SubagentError("invalid_request", `${path}.items is required.`);
			node.items = visit(value.items, depth + 1, `${path}.items`);
		}
		return Object.freeze(node);
	};
	const root = visit(input, 0, "outputSchema");
	if (root.type !== "object") throw new SubagentError("invalid_request", "outputSchema root type must be object.");
	return root;
}

function validateSubagentOutputPayload(
	value: unknown,
	schema: SubagentOutputSchemaNode,
	path = "payload",
): string | undefined {
	const typeMatches =
		(schema.type === "null" && value === null) ||
		(schema.type === "object" && isRecord(value)) ||
		(schema.type === "array" && Array.isArray(value)) ||
		(schema.type === "string" && typeof value === "string") ||
		(schema.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
		(schema.type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) ||
		(schema.type === "boolean" && typeof value === "boolean");
	if (!typeMatches) return `${path} does not match outputSchema type ${schema.type}.`;
	if (schema.type === "string" && Buffer.byteLength(value as string) > SUBAGENT_OUTPUT_SCHEMA_LIMITS.maxStringBytes) {
		return `${path} exceeds the bounded string size.`;
	}
	if (schema.type === "array") {
		const items = value as unknown[];
		if (items.length > SUBAGENT_OUTPUT_SCHEMA_LIMITS.maxArrayItems) return `${path} contains too many items.`;
		for (let index = 0; index < items.length; index += 1) {
			const failure = validateSubagentOutputPayload(items[index], schema.items!, `${path}[${index}]`);
			if (failure) return failure;
		}
	}
	if (schema.type === "object") {
		const object = value as Record<string, unknown>;
		for (const required of schema.required ?? []) {
			if (!Object.hasOwn(object, required)) return `${path}.${required} is required.`;
		}
		for (const key of Object.keys(object)) {
			const child = schema.properties?.[key];
			if (!child) return `${path}.${key} is not allowed by outputSchema.`;
			const failure = validateSubagentOutputPayload(object[key], child, `${path}.${key}`);
			if (failure) return failure;
		}
	}
	return undefined;
}

/** Non-throwing bounded reviewer-findings parse used by the report outcome parser. */
function parseReviewFindingsOutcome(value: unknown): { findings: ReviewFinding[]; diagnostic?: string } {
	if (value === undefined) return { findings: [] };
	if (!Array.isArray(value) || value.length > 32) {
		return { findings: [], diagnostic: "Reviewer findings must be a bounded array." };
	}
	const findings: ReviewFinding[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) return { findings: [], diagnostic: "Reviewer findings must be objects." };
		const severity = entry.severity;
		const category = entry.category;
		const claim = entry.claim;
		const evidence = entry.evidence;
		if (
			(severity !== "low" && severity !== "medium" && severity !== "high") ||
			typeof category !== "string" ||
			category.length === 0 ||
			Buffer.byteLength(category) > 256 ||
			typeof claim !== "string" ||
			claim.length === 0 ||
			Buffer.byteLength(claim) > 8 * 1024 ||
			!Array.isArray(evidence) ||
			evidence.length === 0 ||
			evidence.length > 16
		) {
			return { findings: [], diagnostic: "Reviewer findings have invalid bounded fields." };
		}
		const refs: EvidenceRef[] = [];
		for (const reference of evidence) {
			if (
				!isRecord(reference) ||
				typeof reference.path !== "string" ||
				reference.path.length === 0 ||
				Buffer.byteLength(reference.path) > 4096
			) {
				return { findings: [], diagnostic: "Reviewer finding evidence paths are invalid." };
			}
			refs.push({ path: reference.path });
		}
		findings.push({ severity, category, claim, evidence: refs });
	}
	return { findings, diagnostic: undefined };
}

/**
 * Parse one untrusted child requirement claim with bounded fields.
 * Deterministic: the first claim for an ID wins; unknown IDs are ignored by the caller.
 */
function parseRequirementClaim(value: unknown): SubagentRequirementClaim | undefined {
	if (!isRecord(value)) return undefined;
	const id = value.id;
	const status = value.status;
	if (
		typeof id !== "string" ||
		id.length === 0 ||
		Buffer.byteLength(id) > SUBAGENT_ACCEPTANCE_LIMITS.maxIdBytes ||
		(status !== "satisfied" &&
			status !== "partial" &&
			status !== "blocked" &&
			status !== "failed" &&
			status !== "not_attempted")
	) {
		return undefined;
	}
	const note = value.note;
	const evidencePaths = value.evidencePaths;
	const boundedNote =
		typeof note === "string" && note.length > 0 && Buffer.byteLength(note) <= 1024 ? note : undefined;
	let boundedPaths: string[] | undefined;
	if (evidencePaths !== undefined) {
		if (!Array.isArray(evidencePaths) || evidencePaths.length > SUBAGENT_REPORT_LIMITS.maxEvidencePaths) {
			return undefined;
		}
		boundedPaths = [];
		for (const path of evidencePaths) {
			if (
				typeof path !== "string" ||
				path.length === 0 ||
				Buffer.byteLength(path) > SUBAGENT_REPORT_LIMITS.maxEvidencePathBytes
			) {
				return undefined;
			}
			boundedPaths.push(path);
		}
	}
	return {
		id,
		status,
		...(boundedNote ? { note: boundedNote } : {}),
		...(boundedPaths ? { evidencePaths: boundedPaths } : {}),
	};
}

export type SubagentReportParseOutcome =
	| { kind: "valid"; report: SubagentParsedReport }
	| { kind: "malformed"; diagnostic: string }
	| { kind: "truncated"; diagnostic: string };

export interface SubagentParsedReport {
	summary: string;
	paths: string[];
	findings: ReviewFinding[];
	requirementClaims: SubagentRequirementClaim[];
	payload?: Readonly<Record<string, unknown>>;
}

export const CANDIDATE_EVIDENCE_PATH_LIMIT = 16;
const CANDIDATE_PATH_PATTERN = /(?:^|["'\s(=:])(\.{0,2}\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/g;

/**
 * Best-effort bounded extraction of candidate evidence paths from an unparseable
 * report. Candidates are never verified evidence; they only preserve leads about
 * which files the child may have touched.
 */
export function extractCandidateEvidencePaths(text: string): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(CANDIDATE_PATH_PATTERN)) {
		const raw = match[1];
		if (!raw || raw.length === 0 || Buffer.byteLength(raw) > SUBAGENT_REPORT_LIMITS.maxEvidencePathBytes) continue;
		if (seen.has(raw)) continue;
		seen.add(raw);
		candidates.push(redactCredentialText(raw));
		if (candidates.length >= CANDIDATE_EVIDENCE_PATH_LIMIT) break;
	}
	return candidates;
}

const SUBAGENT_REPORT_JSON_CANDIDATE_LIMIT = 8;

/**
 * Models frequently wrap the required envelope in a Markdown fence or a short
 * prose preamble. Direct JSON.parse first; on failure, a bounded string-aware
 * scan for the first parseable JSON object. Full shape validation still applies
 * to whatever is extracted, so this never relaxes the envelope contract.
 */
function extractSubagentReportJson(text: string): unknown {
	let start = text.indexOf("{");
	for (let candidates = 0; start !== -1 && candidates < SUBAGENT_REPORT_JSON_CANDIDATE_LIMIT; candidates += 1) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let index = start; index < text.length; index += 1) {
			const char = text[index];
			if (inString) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') inString = false;
				continue;
			}
			if (char === '"') inString = true;
			else if (char === "{") depth += 1;
			else if (char === "}") {
				depth -= 1;
				if (depth === 0) {
					try {
						return JSON.parse(text.slice(start, index + 1));
					} catch {
						break;
					}
				}
			}
		}
		start = text.indexOf("{", start + 1);
	}
	return undefined;
}

/**
 * Parse a child final report into an explicit outcome instead of throwing.
 * A malformed or truncated report must never discard the work that preceded it,
 * so failures return a diagnostic the caller can attach to a preserved artifact.
 */
export function parseSubagentReportOutcome(
	text: string,
	maxBytes: number,
	outputSchema?: SubagentOutputSchemaNode,
): SubagentReportParseOutcome {
	const missing = { kind: "malformed" as const, diagnostic: "Child report was empty or missing." };
	if (text.trim().length === 0) return missing;
	if (Buffer.byteLength(text) > maxBytes) {
		return { kind: "truncated", diagnostic: "Child report exceeded the bounded report size." };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		const extracted = extractSubagentReportJson(text);
		if (extracted === undefined) {
			return { kind: "malformed", diagnostic: "Child report was not valid JSON." };
		}
		parsed = extracted;
	}
	if (!isRecord(parsed) || typeof parsed.summary !== "string" || !isRecord(parsed.evidence)) {
		return { kind: "malformed", diagnostic: "Child report must contain summary and evidence fields." };
	}
	const paths = parsed.evidence.paths;
	if (
		!Array.isArray(paths) ||
		paths.length === 0 ||
		paths.length > SUBAGENT_REPORT_LIMITS.maxEvidencePaths ||
		paths.some(
			(path) =>
				typeof path !== "string" ||
				path.length === 0 ||
				Buffer.byteLength(path) > SUBAGENT_REPORT_LIMITS.maxEvidencePathBytes,
		)
	) {
		return { kind: "malformed", diagnostic: "Child report must contain bounded nonempty evidence paths." };
	}
	if (typeof parsed.summary === "string" && parsed.summary.trim().length === 0) {
		return { kind: "malformed", diagnostic: "Child report summary must be nonempty." };
	}
	const findingsOutcome = parseReviewFindingsOutcome(parsed.findings);
	if (findingsOutcome.diagnostic) {
		return { kind: "malformed", diagnostic: findingsOutcome.diagnostic };
	}
	let requirementClaims: SubagentRequirementClaim[] = [];
	let payload: Readonly<Record<string, unknown>> | undefined;
	if (outputSchema) {
		if (!Object.hasOwn(parsed, "payload")) {
			return { kind: "malformed", diagnostic: "Child report must contain the requested payload field." };
		}
		const payloadFailure = validateSubagentOutputPayload(parsed.payload, outputSchema);
		if (payloadFailure) return { kind: "malformed", diagnostic: payloadFailure };
		if (!isRecord(parsed.payload)) {
			return { kind: "malformed", diagnostic: "Child report payload must be an object." };
		}
		try {
			if (Buffer.byteLength(JSON.stringify(parsed.payload)) > SUBAGENT_OUTPUT_SCHEMA_LIMITS.maxPayloadBytes) {
				return { kind: "malformed", diagnostic: "Child report payload exceeds the bounded payload size." };
			}
		} catch {
			return { kind: "malformed", diagnostic: "Child report payload is not finite JSON." };
		}
		payload = Object.freeze(structuredClone(parsed.payload));
	}
	if (parsed.requirements !== undefined) {
		if (!Array.isArray(parsed.requirements) || parsed.requirements.length > SUBAGENT_ACCEPTANCE_LIMITS.maxCriteria) {
			return {
				kind: "malformed",
				diagnostic: `Child requirement claims must be a bounded array of at most ${SUBAGENT_ACCEPTANCE_LIMITS.maxCriteria} entries.`,
			};
		}
		const seen = new Set<string>();
		requirementClaims = [];
		for (const entry of parsed.requirements) {
			const claim = parseRequirementClaim(entry);
			if (!claim) {
				return {
					kind: "malformed",
					diagnostic: "Child requirement claims have invalid bounded fields.",
				};
			}
			if (seen.has(claim.id)) continue; // Deterministic: first claim for an ID wins.
			seen.add(claim.id);
			requirementClaims.push(claim);
		}
	}
	return {
		kind: "valid",
		report: {
			summary: parsed.summary,
			paths,
			findings: findingsOutcome.findings,
			requirementClaims,
			...(payload ? { payload } : {}),
		},
	};
}

export function normalizePlainFinalAnswer(text: string): string {
	const parsed = parseSubagentReportOutcome(text, Number.MAX_SAFE_INTEGER);
	if (parsed.kind !== "valid") return text;
	const reportedPaths = parsed.report.paths.map((path) => `- ${redactCredentialText(path)}`).join("\n");
	const reportedFindings = parsed.report.findings
		.map(
			(finding) =>
				`- [${finding.severity}] ${redactCredentialText(finding.category)}: ${redactCredentialText(finding.claim)}`,
		)
		.join("\n");
	return [
		redactCredentialText(parsed.report.summary),
		reportedPaths ? `Reported paths (not independently verified):\n${reportedPaths}` : undefined,
		reportedFindings ? `Reported findings (not independently verified):\n${reportedFindings}` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join("\n\n");
}

export function normalizeReviewFindings(
	findings: readonly ReviewFinding[] | undefined,
	request: NormalizedSubagentRequest,
): ReviewFinding[] {
	if (!findings || findings.length === 0) return [];
	if (findings.length > 32)
		throw new SubagentError("verification_failure", "Reviewer findings exceed the bounded count.");
	return findings.map((finding) => {
		if (
			(finding.severity !== "low" && finding.severity !== "medium" && finding.severity !== "high") ||
			typeof finding.category !== "string" ||
			finding.category.length === 0 ||
			Buffer.byteLength(finding.category) > 256 ||
			typeof finding.claim !== "string" ||
			finding.claim.length === 0 ||
			Buffer.byteLength(finding.claim) > 8 * 1024 ||
			!Array.isArray(finding.evidence) ||
			finding.evidence.length === 0 ||
			finding.evidence.length > 16
		) {
			throw new SubagentError("verification_failure", "Reviewer finding fields are invalid.");
		}
		const evidence = finding.evidence.map((reference) => {
			if (
				!reference ||
				typeof reference.path !== "string" ||
				reference.path.length === 0 ||
				Buffer.byteLength(reference.path) > SUBAGENT_REPORT_LIMITS.maxEvidencePathBytes
			) {
				throw new SubagentError("verification_failure", "Reviewer finding evidence is invalid.");
			}
			const candidate = resolveSubagentEvidencePath(request, reference.path);
			if (!candidate) {
				throw new SubagentError("verification_failure", `Finding evidence path does not exist: ${reference.path}`);
			}
			const canonicalCandidate = canonicalPath(candidate);
			if (!request.allowExternal && !request.scope.roots.some((root) => isPathWithin(root, canonicalCandidate))) {
				throw new SubagentError(
					"verification_failure",
					`Finding evidence path is outside approved scope: ${reference.path}`,
				);
			}
			return { path: canonicalCandidate };
		});
		return { severity: finding.severity, category: finding.category, claim: finding.claim, evidence };
	});
}

/**
 * Evidence paths are cited from the child's view of its approved scope. Resolve
 * against the parent cwd first, then each approved scope root, so a child scoped
 * to another worktree is not failed for a root-relative path that exists inside
 * its own scope. The canonical scope check below still applies to whichever
 * candidate resolves.
 */
function resolveSubagentEvidencePath(request: NormalizedSubagentRequest, path: string): string | undefined {
	const direct = resolve(request.cwd, path);
	if (existsSync(direct)) return direct;
	if (isAbsolute(path)) return undefined;
	for (const root of request.scope.roots) {
		const candidate = resolve(root, path);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export function verifySubagentResult(result: SubagentResult, request: NormalizedSubagentRequest): SubagentVerification {
	const reject = (
		reason: string,
		paths: string[] = [],
		requirementSummary?: SubagentRequirementSummary,
	): SubagentVerification => ({
		verified: false,
		reason,
		paths,
		unresolvedClaims: [],
		...(requirementSummary ? { requirementSummary } : {}),
	});
	if (result.runId !== request.runId) {
		return reject("Result lineage does not match the parent-owned run.");
	}
	if (result.parentSessionId !== request.parentSessionId) {
		return reject("Result lineage does not match the parent session.");
	}
	if (result.profile !== request.role || result.source !== request.profile.source) {
		return reject("Result profile or source is not approved.");
	}
	if (result.status !== "completed") {
		return reject("Result has a non-completed terminal status.");
	}
	if (typeof result.childSessionId !== "string" || result.childSessionId.trim().length === 0) {
		return reject("Completed result is missing child session lineage.");
	}
	if (result.partial) {
		return reject("Completed result cannot be partial.");
	}
	if (!Number.isSafeInteger(result.observedOutputBytes) || result.observedOutputBytes < 0) {
		return reject("Observed final-answer size is missing or invalid.");
	}
	const output = result.output;
	if (
		!output ||
		typeof output.text !== "string" ||
		!Number.isSafeInteger(output.originalBytes) ||
		output.originalBytes < 0 ||
		output.textBytes !== Buffer.byteLength(output.text, "utf8") ||
		output.textBytes > SUBAGENT_OUTPUT_ARTIFACT_LIMITS.inlineBytes
	) {
		return reject("Completed result is missing a valid bounded output projection.");
	}
	if (output.captureStatus === "artifact_unavailable" || output.captureStatus === "artifact_truncated") {
		return reject("The complete final answer was not retained; output cannot be verified.");
	}
	if (output.captureStatus === "inline_complete") {
		if (output.inlineTruncated || output.artifact)
			return reject("Inline output materialization metadata is inconsistent.");
	} else if (
		output.captureStatus === "artifact_complete" &&
		(!output.inlineTruncated ||
			!output.artifact ||
			output.artifact.schemaVersion !== 2 ||
			output.artifact.truncated ||
			!/^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(output.artifact.id) ||
			!Number.isSafeInteger(output.artifact.storedBytes) ||
			output.artifact.storedBytes < 1 ||
			!Number.isSafeInteger(output.artifact.originalBytes) ||
			!/^[a-f0-9]{64}$/.test(output.artifact.sha256) ||
			(output.artifact.contentType !== "text/plain" && output.artifact.contentType !== "application/json"))
	) {
		return reject("Output artifact metadata is invalid or incomplete.");
	}
	if (typeof result.summary !== "string" || result.summary.trim().length === 0) {
		return reject("Result summary is empty or invalid.");
	}
	if (Buffer.byteLength(result.summary) > SUBAGENT_OUTPUT_ARTIFACT_LIMITS.inlineBytes) {
		return reject("Result summary exceeds the fixed parent-facing projection limit.");
	}
	// Plain final-turn ingestion verifies lineage, complete output materialization, and status only.
	// It must never claim structured-report, evidence, or payload verification.
	if (request.reportMode === "plain_final_turn") {
		return {
			verified: true,
			reason:
				"Plain final-turn answer passed lineage and complete-output materialization checks; no structured report, evidence paths, or payload claims were verified.",
			paths: [],
			unresolvedClaims: [],
			kind: "plain_bounds",
			structuredVerified: false,
		};
	}
	if (request.outputSchema) {
		const payloadFailure = validateSubagentOutputPayload(result.payload, request.outputSchema);
		if (payloadFailure) return reject(payloadFailure);
		try {
			if (Buffer.byteLength(JSON.stringify(result.payload)) > SUBAGENT_OUTPUT_SCHEMA_LIMITS.maxPayloadBytes) {
				return reject("Result payload exceeds the approved payload cap.");
			}
		} catch {
			return reject("Result payload is not finite JSON.");
		}
	}

	const paths = result.evidence?.paths;
	if (!Array.isArray(paths) || paths.length === 0) {
		return reject("Structured evidence is required for verification.");
	}
	if (paths.length > SUBAGENT_REPORT_LIMITS.maxEvidencePaths) {
		return reject("Result evidence exceeds the bounded path count.");
	}
	const canonicalPaths: string[] = [];
	for (const path of paths) {
		if (
			typeof path !== "string" ||
			path.length === 0 ||
			Buffer.byteLength(path) > SUBAGENT_REPORT_LIMITS.maxEvidencePathBytes
		) {
			return reject("Result evidence contains an invalid or oversized path.", canonicalPaths);
		}
		const candidate = resolveSubagentEvidencePath(request, path);
		if (!candidate) {
			return reject(`Evidence path does not exist: ${path}`, canonicalPaths);
		}
		let canonicalCandidate: string;
		try {
			canonicalCandidate = canonicalPath(candidate);
		} catch {
			return reject(`Evidence path cannot be resolved: ${path}`, canonicalPaths);
		}
		if (!request.allowExternal && !request.scope.roots.some((root) => isPathWithin(root, canonicalCandidate))) {
			return reject(`Evidence path is outside approved scope: ${path}`, canonicalPaths);
		}
		canonicalPaths.push(canonicalCandidate);
	}
	let unresolvedClaims: string[] = [];
	if (request.agentKind === "self") {
		try {
			const findings = normalizeReviewFindings(result.findings, request);
			unresolvedClaims = findings.map((finding) => finding.claim);
		} catch (error) {
			return reject(
				error instanceof Error ? error.message : "Reviewer findings failed verification.",
				canonicalPaths,
			);
		}
	}
	if (request.acceptanceCriteria.length > 0) {
		const requirementOutcome = verifySubagentRequirements(result, request);
		if (requirementOutcome.failure) {
			return reject(requirementOutcome.failure, canonicalPaths, requirementOutcome.summary);
		}
		unresolvedClaims = [...unresolvedClaims, ...requirementOutcome.optionalGaps];
		return {
			verified: true,
			reason: "Observed child result passed parent verification; semantic claims remain unresolved.",
			paths: canonicalPaths,
			unresolvedClaims,
			kind: "structured",
			structuredVerified: true,
			...(requirementOutcome.summary ? { requirementSummary: requirementOutcome.summary } : {}),
		};
	}
	return {
		verified: true,
		reason: "Observed child result passed parent verification; semantic claims remain unresolved.",
		paths: canonicalPaths,
		unresolvedClaims,
		kind: "structured",
		structuredVerified: true,
	};
}

/**
 * Parent-enforced acceptance-criteria verification. Required criteria that are
 * missing, partial, blocked, failed, or not attempted always fail verification;
 * optional gaps stay visible without failing completion. Declared path evidence
 * must exist inside the approved scope.
 */
function verifySubagentRequirements(
	result: SubagentResult,
	request: NormalizedSubagentRequest,
): {
	failure?: string;
	optionalGaps: string[];
	summary?: SubagentRequirementSummary;
} {
	const claimsById = new Map<string, SubagentRequirementClaim>();
	for (const claim of result.requirementClaims ?? []) {
		if (!claimsById.has(claim.id)) claimsById.set(claim.id, claim); // Deterministic: first claim wins.
	}
	const states: SubagentRequirementState[] = [];
	const optionalGaps: string[] = [];
	let failures = 0;
	let requiredTotal = 0;
	let requiredSatisfied = 0;
	let visualPending = false;
	let functionalOnlyFailure = false;
	const markRequiredFailure = (criterion: SubagentAcceptanceCriterion): void => {
		failures += 1;
		if (criterion.dimension === "visual") visualPending = true;
		else functionalOnlyFailure = true;
	};
	for (const criterion of request.acceptanceCriteria) {
		const claim = claimsById.get(criterion.id);
		requiredTotal += criterion.required ? 1 : 0;
		let verified = false;
		let note: string | undefined;
		if (!claim) {
			note = criterion.required ? "required criterion claim missing" : "optional criterion claim missing";
			if (criterion.required) markRequiredFailure(criterion);
		} else if (claim.status !== "satisfied") {
			note = claim.note ?? `child reported ${claim.status}`;
			if (criterion.required) markRequiredFailure(criterion);
			if (!criterion.required) {
				optionalGaps.push(`${criterion.id} — ${claim.status}${note ? ` (${note})` : ""}`);
			}
		} else {
			// Claim says satisfied: validate declared path evidence before accepting it.
			let evidenceValid = true;
			if (claim.evidencePaths) {
				for (const path of claim.evidencePaths) {
					const candidate = resolveSubagentEvidencePath(request, path);
					if (!candidate) {
						evidenceValid = false;
						note = `declared path evidence does not exist: ${path}`;
						break;
					}
					let canonicalCandidate: string;
					try {
						canonicalCandidate = canonicalPath(candidate);
					} catch {
						evidenceValid = false;
						note = `declared path evidence cannot be resolved: ${path}`;
						break;
					}
					if (
						!request.allowExternal &&
						!request.scope.roots.some((root) => isPathWithin(root, canonicalCandidate))
					) {
						evidenceValid = false;
						note = `declared path evidence is outside approved scope: ${path}`;
						break;
					}
				}
			} else if (criterion.evidence === "path" && criterion.required) {
				evidenceValid = false;
				note = "satisfied without declared path evidence";
			}
			if (!evidenceValid) {
				if (criterion.required) markRequiredFailure(criterion);
			} else {
				verified = true;
				if (criterion.required) requiredSatisfied += 1;
			}
		}
		states.push({
			id: criterion.id,
			required: criterion.required,
			...(criterion.dimension ? { dimension: criterion.dimension } : {}),
			...(claim ? { claim: claim.status } : {}),
			verified,
			...(note ? { note } : {}),
		});
	}
	const visualAcceptancePending = visualPending && !functionalOnlyFailure;
	const summary: SubagentRequirementSummary = {
		total: request.acceptanceCriteria.length,
		required: requiredTotal,
		requiredSatisfied,
		states: Object.freeze(states),
		visualAcceptancePending,
	};
	if (failures > 0) {
		const firstFailure = states.find((state) => state.required && !state.verified);
		const failure =
			visualAcceptancePending && firstFailure?.dimension === "visual"
				? `Functional verification passed; visual acceptance pending: required visual criterion "${firstFailure.id}" is ${firstFailure.claim ?? "missing"}.`
				: `Required acceptance criteria are not satisfied: ${firstFailure?.id ?? "unknown criterion"} — ${firstFailure?.note ?? "unsatisfied"}.`;
		return { failure, optionalGaps, summary };
	}
	return { optionalGaps, summary };
}

/** Bounded text requirement summary for tool results and history views. */
export function formatSubagentRequirementSummary(summary: SubagentRequirementSummary | undefined): string[] {
	if (!summary || summary.total === 0) return [];
	const rows = [`Requirements ${summary.requiredSatisfied}/${summary.required} verified`];
	for (const state of summary.states) {
		const marker = state.verified ? "✓" : state.required ? "!" : "-";
		const detail = state.note ? ` — ${state.note}` : state.claim && !state.verified ? ` — ${state.claim}` : "";
		rows.push(`${marker} ${state.id}${detail}`);
	}
	if (summary.visualAcceptancePending) rows.push("Functional verification passed; visual acceptance pending.");
	return rows;
}
