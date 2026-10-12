/**
 * Subagent V2 runtime contract creation and canonical hashing (Plan/subagent-rewrite.md section 10, P4.3).
 *
 * The contract is built only from already-resolved values, redacted before it can
 * be persisted, deeply frozen, and hashed over canonical JSON so equal inputs
 * always produce equal hashes. A persisted contract is accepted back only when
 * its hash matches.
 */
import { createHash, randomBytes } from "node:crypto";
import { redactCredentialText } from "../../utils/redact.ts";
import { canonicalJson } from "../definitions/parse.ts";
import { CHILD_RUNTIME_CONTRACT_VERSION, type ChildRuntimeContract, isChildId } from "./child-runtime-contract.ts";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array, length: number): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5 && out.length < length) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0 && out.length < length) out += BASE32[(value << (5 - bits)) & 31];
	return out;
}

export function createChildId(random: (size: number) => Uint8Array = randomBytes): string {
	return `ag_${base32(random(17), 26)}`;
}

export function createChildGroupId(random: (size: number) => Uint8Array = randomBytes): string {
	return `agg_${base32(random(17), 26)}`;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

export type ChildRuntimeContractInput = Omit<ChildRuntimeContract, "version" | "createdAt"> & { createdAt?: string };

export function buildChildRuntimeContract(input: ChildRuntimeContractInput): ChildRuntimeContract {
	if (!isChildId(input.id)) throw new Error(`Invalid child ID ${input.id}`);
	if (input.depth < 0 || input.depth > input.capabilities.maxDepth)
		throw new Error(`Child depth ${input.depth} exceeds maxDepth ${input.capabilities.maxDepth}`);
	const contract: ChildRuntimeContract = {
		...structuredClone(input),
		version: CHILD_RUNTIME_CONTRACT_VERSION,
		prompt: {
			...structuredClone(input.prompt),
			system: redactCredentialText(input.prompt.system),
			...(input.prompt.initialPrompt !== undefined
				? { initialPrompt: redactCredentialText(input.prompt.initialPrompt) }
				: {}),
		},
		createdAt: input.createdAt ?? new Date().toISOString(),
	};
	return deepFreeze(contract);
}

export function hashChildRuntimeContract(contract: ChildRuntimeContract): string {
	return createHash("sha256").update(canonicalJson(contract)).digest("hex");
}

/** Parse a persisted contract; throws unless the version, ID, and hash all match. */
export function parseChildRuntimeContract(json: string, expectedHash: string): ChildRuntimeContract {
	const value = JSON.parse(json) as ChildRuntimeContract;
	if (!value || typeof value !== "object" || value.version !== CHILD_RUNTIME_CONTRACT_VERSION)
		throw new Error("Unsupported child runtime contract version.");
	if (!isChildId(value.id)) throw new Error("Persisted child runtime contract has an invalid ID.");
	if (hashChildRuntimeContract(value) !== expectedHash)
		throw new Error("Persisted child runtime contract does not match its recorded hash.");
	return deepFreeze(value);
}
