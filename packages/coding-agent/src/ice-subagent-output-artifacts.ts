import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "./config.ts";
import { redactCredentialText } from "./utils/redact.ts";

export const SUBAGENT_OUTPUT_ARTIFACT_LIMITS = {
	inlineBytes: 48 * 1024,
	maxArtifactBytes: 4 * 1024 * 1024,
	defaultReadBytes: 16 * 1024,
	maxReadBytes: 64 * 1024,
	maxOwnerBytes: 16 * 1024 * 1024,
	maxGlobalBytes: 128 * 1024 * 1024,
} as const;

export type SubagentOutputContentType = "text/plain" | "application/json";

export type SubagentOutputCaptureStatus =
	| "inline_complete"
	| "artifact_complete"
	| "artifact_truncated"
	| "artifact_unavailable";

export interface SubagentOutputArtifactRef {
	schemaVersion: 2;
	id: string;
	storedBytes: number;
	originalBytes: number;
	sha256: string;
	contentType: SubagentOutputContentType;
	truncated: boolean;
}

export interface SubagentOutput {
	text: string;
	textBytes: number;
	originalBytes: number;
	inlineTruncated: boolean;
	captureStatus: SubagentOutputCaptureStatus;
	artifact?: SubagentOutputArtifactRef;
}

export interface SubagentOutputRead {
	artifactId: string;
	offset: number;
	bytesRead: number;
	totalBytes: number;
	nextOffset: number;
	eof: boolean;
	contentType: SubagentOutputContentType;
	text: string;
	sha256: string;
	truncated: boolean;
}

export type SubagentOutputArtifactErrorCode =
	| "artifact_not_found"
	| "artifact_invalid"
	| "artifact_integrity_failure"
	| "artifact_offset_invalid"
	| "artifact_storage_failure";

export class SubagentOutputArtifactError extends Error {
	readonly code: SubagentOutputArtifactErrorCode;

	constructor(code: SubagentOutputArtifactErrorCode, message: string) {
		super(message);
		this.name = "SubagentOutputArtifactError";
		this.code = code;
	}
}

export interface SubagentOutputArtifactStoreLimits {
	inlineBytes: number;
	maxArtifactBytes: number;
	defaultReadBytes: number;
	maxReadBytes: number;
	maxOwnerBytes: number;
	maxGlobalBytes: number;
}

export interface SubagentOutputArtifactStoreOptions {
	artifactRoot?: string;
	limits?: Partial<SubagentOutputArtifactStoreLimits>;
}

export interface CaptureSubagentOutputInput {
	ownerSessionId: string;
	text: string;
	contentType?: SubagentOutputContentType;
	lifecycle?: "process_local" | "durable";
}

export interface ReadSubagentOutputInput {
	ownerSessionId: string;
	artifactId: string;
	offset?: number;
	length?: number;
}

export interface RetainSubagentOutputInput {
	ownerSessionId: string;
	artifactId: string;
	referenceId: string;
}

export interface ReleaseSubagentOutputInput {
	ownerSessionId: string;
	artifactId: string;
	referenceId?: string;
}

interface OwnedOutputArtifact {
	ownerSessionId: string;
	artifact: SubagentOutputArtifactRef;
	absolutePath: string;
	lifecycle: "process_local" | "durable";
	references: Set<string>;
}

const ARTIFACT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ARTIFACT_REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/;
const CAPTURE_REFERENCE_ID = "capture";
const DURABLE_REFERENCE_ID = "durable";
const DURABLE_REFERENCE_PREFIX = "durable:";
const ARTIFACT_FILE_NAMES: Readonly<Record<SubagentOutputContentType, string>> = Object.freeze({
	"text/plain": "output.txt",
	"application/json": "output.json",
});

function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function pathWithin(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(!isAbsolute(pathFromRoot) && !pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..")
	);
}

function assertNoSymlinkComponents(path: string): void {
	let current = resolve(path);
	const components: string[] = [];
	while (true) {
		const parent = dirname(current);
		if (parent === current) break;
		components.unshift(basename(current));
		current = parent;
	}
	let prefix = current;
	for (const component of components) {
		prefix = join(prefix, component);
		try {
			if (lstatSync(prefix).isSymbolicLink()) throw new Error("Artifact path contains a symlink.");
		} catch (error) {
			if (error instanceof Error && error.message === "Artifact path contains a symlink.") throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
			throw error;
		}
	}
}

function truncateUtf8Prefix(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maxBytes) return { text, truncated: false };
	let end = Math.max(0, Math.min(maxBytes, bytes.byteLength));
	while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end--;
	return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function validateLimits(limits: SubagentOutputArtifactStoreLimits): void {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new SubagentOutputArtifactError("artifact_invalid", `Invalid output artifact limit: ${name}.`);
		}
	}
	if (limits.maxReadBytes > 64 * 1024 || limits.defaultReadBytes > limits.maxReadBytes) {
		throw new SubagentOutputArtifactError("artifact_invalid", "Output artifact read limits are inconsistent.");
	}
	if (limits.inlineBytes > limits.maxArtifactBytes) {
		throw new SubagentOutputArtifactError("artifact_invalid", "Inline output limit exceeds artifact storage limit.");
	}
	if (limits.maxArtifactBytes > 4 * 1024 * 1024) {
		throw new SubagentOutputArtifactError("artifact_invalid", "Per-artifact storage limit exceeds the host maximum.");
	}
	if (limits.maxOwnerBytes > 16 * 1024 * 1024 || limits.maxGlobalBytes > 128 * 1024 * 1024) {
		throw new SubagentOutputArtifactError("artifact_invalid", "Output artifact quota exceeds the host maximum.");
	}
}

export function isSubagentOutputArtifactRef(value: unknown): value is SubagentOutputArtifactRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (
		Object.keys(value).some(
			(key) =>
				!["schemaVersion", "id", "storedBytes", "originalBytes", "sha256", "contentType", "truncated"].includes(
					key,
				),
		)
	)
		return false;
	const artifact = value as Partial<SubagentOutputArtifactRef>;
	return (
		artifact.schemaVersion === 2 &&
		typeof artifact.id === "string" &&
		ARTIFACT_ID_PATTERN.test(artifact.id) &&
		typeof artifact.storedBytes === "number" &&
		Number.isSafeInteger(artifact.storedBytes) &&
		artifact.storedBytes > 0 &&
		artifact.storedBytes <= SUBAGENT_OUTPUT_ARTIFACT_LIMITS.maxArtifactBytes &&
		typeof artifact.originalBytes === "number" &&
		Number.isSafeInteger(artifact.originalBytes) &&
		artifact.originalBytes >= 0 &&
		typeof artifact.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(artifact.sha256) &&
		(artifact.contentType === "text/plain" || artifact.contentType === "application/json") &&
		typeof artifact.truncated === "boolean"
	);
}

export function isSubagentOutput(value: unknown): value is SubagentOutput {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const output = value as Partial<SubagentOutput>;
	if (
		Object.keys(value).some(
			(key) => !["text", "textBytes", "originalBytes", "inlineTruncated", "captureStatus", "artifact"].includes(key),
		) ||
		typeof output.text !== "string" ||
		redactCredentialText(output.text) !== output.text ||
		Buffer.byteLength(output.text, "utf8") !== output.textBytes ||
		!Number.isSafeInteger(output.textBytes) ||
		output.textBytes! < 0 ||
		output.textBytes! > SUBAGENT_OUTPUT_ARTIFACT_LIMITS.inlineBytes ||
		!Number.isSafeInteger(output.originalBytes) ||
		output.originalBytes! < 0 ||
		typeof output.inlineTruncated !== "boolean" ||
		(output.captureStatus !== "inline_complete" &&
			output.captureStatus !== "artifact_complete" &&
			output.captureStatus !== "artifact_truncated" &&
			output.captureStatus !== "artifact_unavailable")
	) {
		return false;
	}
	if (output.artifact !== undefined && !isSubagentOutputArtifactRef(output.artifact)) return false;
	if (output.captureStatus === "inline_complete") {
		return !output.inlineTruncated && output.artifact === undefined;
	}
	if (!output.inlineTruncated) return false;
	if (output.captureStatus === "artifact_unavailable") return output.artifact === undefined;
	if (!output.artifact || output.artifact.originalBytes !== output.originalBytes) return false;
	return output.captureStatus === "artifact_truncated" ? output.artifact.truncated : !output.artifact.truncated;
}

function sameArtifact(left: SubagentOutputArtifactRef, right: SubagentOutputArtifactRef): boolean {
	return (
		left.schemaVersion === right.schemaVersion &&
		left.id === right.id &&
		left.storedBytes === right.storedBytes &&
		left.originalBytes === right.originalBytes &&
		left.sha256 === right.sha256 &&
		left.contentType === right.contentType &&
		left.truncated === right.truncated
	);
}

function isUtf8Boundary(bytes: Uint8Array, offset: number): boolean {
	return offset === 0 || offset === bytes.byteLength || (bytes[offset]! & 0xc0) !== 0x80;
}

export class SubagentOutputArtifactStore {
	private readonly artifactRoot: string;
	private readonly limits: SubagentOutputArtifactStoreLimits;
	private readonly artifacts = new Map<string, OwnedOutputArtifact>();
	private readonly ownerBytes = new Map<string, number>();
	private storedBytes = 0;
	private disposed = false;

	constructor(options: SubagentOutputArtifactStoreOptions = {}) {
		const limits: SubagentOutputArtifactStoreLimits = {
			...SUBAGENT_OUTPUT_ARTIFACT_LIMITS,
			...options.limits,
		};
		validateLimits(limits);
		const root = options.artifactRoot ?? join(getAgentDir(), "artifacts", "subagent-output");
		if (typeof root !== "string" || root.length === 0 || Buffer.byteLength(root, "utf8") > 4096) {
			throw new SubagentOutputArtifactError("artifact_invalid", "Output artifact root must be a bounded path.");
		}
		this.artifactRoot = resolve(root);
		this.limits = limits;
	}

	capture(input: CaptureSubagentOutputInput): SubagentOutput {
		this.assertLive();
		this.validateOwner(input.ownerSessionId);
		if (typeof input.text !== "string") {
			throw new SubagentOutputArtifactError("artifact_invalid", "Output artifact text must be a string.");
		}
		const contentType = input.contentType ?? "text/plain";
		if (contentType !== "text/plain" && contentType !== "application/json") {
			throw new SubagentOutputArtifactError("artifact_invalid", "Unsupported output artifact content type.");
		}
		const originalBytes = Buffer.byteLength(input.text, "utf8");
		const sanitizedText = redactCredentialText(input.text);
		const sanitizedBytes = Buffer.from(sanitizedText, "utf8");
		const inline = truncateUtf8Prefix(sanitizedText, this.limits.inlineBytes);
		const base = {
			text: inline.text,
			textBytes: Buffer.byteLength(inline.text, "utf8"),
			originalBytes,
			inlineTruncated: inline.truncated,
		};
		if (!inline.truncated) return { ...base, captureStatus: "inline_complete" };

		const artifactBytes = sanitizedBytes.subarray(0, this.limits.maxArtifactBytes);
		let stored = artifactBytes;
		if (artifactBytes.byteLength < sanitizedBytes.byteLength) {
			const bounded = truncateUtf8Prefix(sanitizedText, this.limits.maxArtifactBytes);
			stored = Buffer.from(bounded.text, "utf8");
		}
		if (!this.hasCapacity(input.ownerSessionId, stored.byteLength)) {
			return { ...base, captureStatus: "artifact_unavailable" };
		}
		const id = randomUUID();
		const artifact: SubagentOutputArtifactRef = Object.freeze({
			schemaVersion: 2,
			id,
			storedBytes: stored.byteLength,
			originalBytes,
			sha256: hashBytes(stored),
			contentType,
			truncated: stored.byteLength < sanitizedBytes.byteLength,
		});
		const lifecycle = input.lifecycle ?? "process_local";
		const absolutePath = this.artifactPath(input.ownerSessionId, id, contentType);
		if (!this.writeArtifact(absolutePath, id, stored, input.ownerSessionId)) {
			return { ...base, captureStatus: "artifact_unavailable" };
		}
		this.register(
			input.ownerSessionId,
			artifact,
			absolutePath,
			lifecycle,
			lifecycle === "durable" ? DURABLE_REFERENCE_ID : CAPTURE_REFERENCE_ID,
		);
		return {
			...base,
			captureStatus: artifact.truncated ? "artifact_truncated" : "artifact_complete",
			artifact,
		};
	}

	read(input: ReadSubagentOutputInput): SubagentOutputRead {
		this.assertLive();
		this.validateOwner(input.ownerSessionId);
		if (typeof input.artifactId !== "string" || !ARTIFACT_ID_PATTERN.test(input.artifactId)) {
			throw new SubagentOutputArtifactError("artifact_not_found", "Subagent output artifact was not found.");
		}
		const owned = this.artifacts.get(input.artifactId);
		if (!owned || owned.ownerSessionId !== input.ownerSessionId) {
			throw new SubagentOutputArtifactError("artifact_not_found", "Subagent output artifact was not found.");
		}
		const offset = input.offset ?? 0;
		const length = input.length ?? this.limits.defaultReadBytes;
		if (
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			!Number.isSafeInteger(length) ||
			length < 1 ||
			length > this.limits.maxReadBytes
		) {
			throw new SubagentOutputArtifactError("artifact_offset_invalid", "Output artifact read range is invalid.");
		}
		const bytes = this.readAndVerify(owned);
		if (offset > bytes.byteLength || !isUtf8Boundary(bytes, offset)) {
			throw new SubagentOutputArtifactError(
				"artifact_offset_invalid",
				"Artifact offset must be on a UTF-8 boundary.",
			);
		}
		let end = Math.min(bytes.byteLength, offset + length);
		while (end > offset && end < bytes.byteLength && !isUtf8Boundary(bytes, end)) end--;
		if (end === offset && end < bytes.byteLength) {
			throw new SubagentOutputArtifactError(
				"artifact_offset_invalid",
				"Read length is too small for a UTF-8 code point.",
			);
		}
		const chunk = bytes.subarray(offset, end);
		return {
			artifactId: owned.artifact.id,
			offset,
			bytesRead: chunk.byteLength,
			totalBytes: bytes.byteLength,
			nextOffset: end,
			eof: end === bytes.byteLength,
			contentType: owned.artifact.contentType,
			text: chunk.toString("utf8"),
			sha256: owned.artifact.sha256,
			truncated: owned.artifact.truncated,
		};
	}

	retain(input: RetainSubagentOutputInput): boolean {
		this.assertLive();
		this.validateOwner(input.ownerSessionId);
		if (typeof input.referenceId !== "string" || !ARTIFACT_REFERENCE_ID_PATTERN.test(input.referenceId)) {
			throw new SubagentOutputArtifactError("artifact_invalid", "Output artifact reference ID is invalid.");
		}
		const owned = this.artifacts.get(input.artifactId);
		if (!owned || owned.ownerSessionId !== input.ownerSessionId) return false;
		owned.references.add(input.referenceId);
		return true;
	}

	registerDurable(
		ownerSessionId: string,
		artifact: SubagentOutputArtifactRef,
		referenceId = DURABLE_REFERENCE_ID,
	): boolean {
		this.assertLive();
		this.validateOwner(ownerSessionId);
		if (
			!isSubagentOutputArtifactRef(artifact) ||
			typeof referenceId !== "string" ||
			!ARTIFACT_REFERENCE_ID_PATTERN.test(referenceId)
		)
			return false;
		const existing = this.artifacts.get(artifact.id);
		if (existing) {
			if (existing.ownerSessionId !== ownerSessionId || !sameArtifact(existing.artifact, artifact)) return false;
			try {
				this.readAndVerify(existing);
			} catch {
				return false;
			}
			existing.lifecycle = "durable";
			existing.references.add(referenceId);
			return true;
		}
		if (!this.hasCapacity(ownerSessionId, artifact.storedBytes)) return false;
		const absolutePath = this.artifactPath(ownerSessionId, artifact.id, artifact.contentType);
		try {
			const bytes = this.readFileAtPath(absolutePath, artifact.id, ownerSessionId);
			if (
				bytes.byteLength !== artifact.storedBytes ||
				hashBytes(bytes) !== artifact.sha256 ||
				Buffer.from(bytes.toString("utf8"), "utf8").compare(bytes) !== 0
			) {
				return false;
			}
			this.register(ownerSessionId, Object.freeze({ ...artifact }), absolutePath, "durable", referenceId);
			return true;
		} catch {
			return false;
		}
	}

	retainDurable(ownerSessionId: string, artifact: SubagentOutputArtifactRef, referenceId: string): boolean {
		this.assertLive();
		this.validateOwner(ownerSessionId);
		if (
			!isSubagentOutputArtifactRef(artifact) ||
			typeof referenceId !== "string" ||
			!referenceId.startsWith(DURABLE_REFERENCE_PREFIX) ||
			!ARTIFACT_REFERENCE_ID_PATTERN.test(referenceId)
		)
			return false;
		const existing = this.artifacts.get(artifact.id);
		if (!existing) return this.registerDurable(ownerSessionId, artifact, referenceId);
		if (existing.ownerSessionId !== ownerSessionId || !sameArtifact(existing.artifact, artifact)) return false;
		try {
			this.readAndVerify(existing);
		} catch {
			return false;
		}
		existing.lifecycle = "durable";
		existing.references.delete(CAPTURE_REFERENCE_ID);
		existing.references.add(referenceId);
		return true;
	}

	finalizeRestore(ownerSessionId: string): void {
		this.assertLive();
		this.validateOwner(ownerSessionId);
		try {
			assertNoSymlinkComponents(this.artifactRoot);
			const canonicalRoot = realpathSync(this.artifactRoot);
			const ownerRoot = join(canonicalRoot, this.ownerDirectoryName(ownerSessionId));
			const ownerStat = lstatSync(ownerRoot);
			if (!ownerStat.isDirectory() || ownerStat.isSymbolicLink() || realpathSync(ownerRoot) !== ownerRoot) return;
			for (const entry of readdirSync(ownerRoot, { withFileTypes: true })) {
				if (!entry.isDirectory() || !ARTIFACT_ID_PATTERN.test(entry.name)) continue;
				const tracked = this.artifacts.get(entry.name);
				if (tracked?.ownerSessionId === ownerSessionId) continue;
				this.removeOrphan(entry.name, ownerRoot);
			}
			try {
				rmdirSync(ownerRoot);
			} catch {
				// Durable files or unexpected content keep the owner directory in place.
			}
		} catch {
			// Artifact sweep is best-effort; it never changes restored job status.
		}
	}

	release(input: ReleaseSubagentOutputInput): boolean {
		this.assertLive();
		this.validateOwner(input.ownerSessionId);
		const owned = this.artifacts.get(input.artifactId);
		if (!owned || owned.ownerSessionId !== input.ownerSessionId) return false;
		const referenceId = input.referenceId ?? CAPTURE_REFERENCE_ID;
		if (typeof referenceId !== "string" || !ARTIFACT_REFERENCE_ID_PATTERN.test(referenceId)) {
			throw new SubagentOutputArtifactError("artifact_invalid", "Output artifact reference ID is invalid.");
		}
		if (!owned.references.delete(referenceId)) return false;
		if (owned.references.size > 0) return true;
		this.artifacts.delete(input.artifactId);
		this.storedBytes = Math.max(0, this.storedBytes - owned.artifact.storedBytes);
		const ownerTotal = Math.max(0, (this.ownerBytes.get(input.ownerSessionId) ?? 0) - owned.artifact.storedBytes);
		if (ownerTotal === 0) this.ownerBytes.delete(input.ownerSessionId);
		else this.ownerBytes.set(input.ownerSessionId, ownerTotal);
		this.removeArtifactFile(owned);
		return true;
	}

	dispose(): void {
		if (this.disposed) return;
		for (const [artifactId, owned] of this.artifacts) {
			for (const referenceId of [...owned.references]) {
				if (referenceId === DURABLE_REFERENCE_ID || referenceId.startsWith(DURABLE_REFERENCE_PREFIX)) continue;
				this.release({ ownerSessionId: owned.ownerSessionId, artifactId, referenceId });
			}
		}
		this.disposed = true;
	}

	private assertLive(): void {
		if (this.disposed)
			throw new SubagentOutputArtifactError("artifact_storage_failure", "Output artifact store is closed.");
	}

	private validateOwner(ownerSessionId: string): void {
		if (
			typeof ownerSessionId !== "string" ||
			ownerSessionId.length === 0 ||
			Buffer.byteLength(ownerSessionId) > 512
		) {
			throw new SubagentOutputArtifactError("artifact_invalid", "Output artifact owner is invalid.");
		}
	}

	private hasCapacity(ownerSessionId: string, bytes: number): boolean {
		return (
			bytes <= this.limits.maxArtifactBytes &&
			(this.ownerBytes.get(ownerSessionId) ?? 0) + bytes <= this.limits.maxOwnerBytes &&
			this.storedBytes + bytes <= this.limits.maxGlobalBytes
		);
	}

	private register(
		ownerSessionId: string,
		artifact: SubagentOutputArtifactRef,
		absolutePath: string,
		lifecycle: OwnedOutputArtifact["lifecycle"],
		referenceId: string,
	): void {
		this.artifacts.set(artifact.id, {
			ownerSessionId,
			artifact,
			absolutePath,
			lifecycle,
			references: new Set([referenceId]),
		});
		this.storedBytes += artifact.storedBytes;
		this.ownerBytes.set(ownerSessionId, (this.ownerBytes.get(ownerSessionId) ?? 0) + artifact.storedBytes);
	}

	private artifactPath(ownerSessionId: string, id: string, contentType: SubagentOutputContentType): string {
		if (!ARTIFACT_ID_PATTERN.test(id)) {
			throw new SubagentOutputArtifactError("artifact_invalid", "Output artifact ID is invalid.");
		}
		const path = join(this.ownerRoot(ownerSessionId), id, ARTIFACT_FILE_NAMES[contentType]);
		if (!pathWithin(this.artifactRoot, path)) {
			throw new SubagentOutputArtifactError("artifact_invalid", "Output artifact path escaped its root.");
		}
		return path;
	}

	private ownerDirectoryName(ownerSessionId: string): string {
		return hashBytes(Buffer.from(ownerSessionId, "utf8"));
	}

	private ownerRoot(ownerSessionId: string): string {
		return join(this.artifactRoot, this.ownerDirectoryName(ownerSessionId));
	}

	private writeArtifact(artifactPath: string, id: string, bytes: Uint8Array, ownerSessionId: string): boolean {
		let fd: number | undefined;
		try {
			assertNoSymlinkComponents(this.artifactRoot);
			mkdirSync(this.artifactRoot, { recursive: true, mode: 0o700 });
			chmodSync(this.artifactRoot, 0o700);
			assertNoSymlinkComponents(this.artifactRoot);
			const canonicalRoot = realpathSync(this.artifactRoot);
			const ownerRoot = this.ownerRoot(ownerSessionId);
			const canonicalOwnerRoot = join(canonicalRoot, this.ownerDirectoryName(ownerSessionId));
			mkdirSync(ownerRoot, { recursive: true, mode: 0o700 });
			chmodSync(ownerRoot, 0o700);
			assertNoSymlinkComponents(ownerRoot);
			if (realpathSync(ownerRoot) !== canonicalOwnerRoot) return false;
			const runDirectory = join(canonicalOwnerRoot, id);
			if (!pathWithin(canonicalOwnerRoot, runDirectory)) return false;
			mkdirSync(runDirectory, { recursive: false, mode: 0o700 });
			chmodSync(runDirectory, 0o700);
			assertNoSymlinkComponents(runDirectory);
			if (realpathSync(runDirectory) !== runDirectory) return false;
			if (!pathWithin(canonicalOwnerRoot, artifactPath)) return false;
			const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
			fd = openSync(artifactPath, flags, 0o400);
			if (!fstatSync(fd).isFile()) return false;
			writeFileSync(fd, bytes);
			fchmodSync(fd, 0o400);
			closeSync(fd);
			fd = undefined;
			return true;
		} catch {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// The descriptor may already be closed after a failed write.
				}
			}
			return false;
		}
	}

	private readAndVerify(owned: OwnedOutputArtifact): Buffer {
		try {
			const bytes = this.readFileAtPath(owned.absolutePath, owned.artifact.id, owned.ownerSessionId);
			if (
				bytes.byteLength !== owned.artifact.storedBytes ||
				hashBytes(bytes) !== owned.artifact.sha256 ||
				Buffer.from(bytes.toString("utf8"), "utf8").compare(bytes) !== 0
			) {
				throw new SubagentOutputArtifactError(
					"artifact_integrity_failure",
					"Subagent output artifact integrity check failed.",
				);
			}
			return bytes;
		} catch (error) {
			if (error instanceof SubagentOutputArtifactError) throw error;
			throw new SubagentOutputArtifactError(
				"artifact_integrity_failure",
				"Subagent output artifact integrity check failed.",
			);
		}
	}

	private readFileAtPath(path: string, id: string, ownerSessionId: string): Buffer {
		assertNoSymlinkComponents(this.artifactRoot);
		const canonicalRoot = realpathSync(this.artifactRoot);
		const ownerRoot = join(canonicalRoot, this.ownerDirectoryName(ownerSessionId));
		const canonicalDirectory = join(ownerRoot, id);
		if (!pathWithin(ownerRoot, canonicalDirectory) || !pathWithin(ownerRoot, path)) {
			throw new SubagentOutputArtifactError(
				"artifact_integrity_failure",
				"Subagent output artifact integrity check failed.",
			);
		}
		assertNoSymlinkComponents(canonicalDirectory);
		assertNoSymlinkComponents(path);
		const fileStat = lstatSync(path);
		if (!fileStat.isFile() || fileStat.isSymbolicLink() || realpathSync(path) !== path) {
			throw new SubagentOutputArtifactError(
				"artifact_integrity_failure",
				"Subagent output artifact integrity check failed.",
			);
		}
		const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const opened = fstatSync(fd);
			if (
				!opened.isFile() ||
				opened.dev !== fileStat.dev ||
				opened.ino !== fileStat.ino ||
				opened.size > SUBAGENT_OUTPUT_ARTIFACT_LIMITS.maxArtifactBytes
			) {
				throw new SubagentOutputArtifactError(
					"artifact_integrity_failure",
					"Subagent output artifact integrity check failed.",
				);
			}
			return readFileSync(fd);
		} finally {
			closeSync(fd);
		}
	}

	private removeArtifactFile(owned: OwnedOutputArtifact): void {
		try {
			assertNoSymlinkComponents(this.artifactRoot);
			const canonicalRoot = realpathSync(this.artifactRoot);
			const ownerRoot = join(canonicalRoot, this.ownerDirectoryName(owned.ownerSessionId));
			const canonicalDirectory = join(ownerRoot, owned.artifact.id);
			if (
				!pathWithin(ownerRoot, canonicalDirectory) ||
				realpathSync(dirname(owned.absolutePath)) !== canonicalDirectory
			) {
				return;
			}
			assertNoSymlinkComponents(canonicalDirectory);
			const file = lstatSync(owned.absolutePath);
			if (file.isFile() && !file.isSymbolicLink()) unlinkSync(owned.absolutePath);
			try {
				rmdirSync(canonicalDirectory);
			} catch {
				// Leave unexpected or concurrently created contents untouched.
			}
		} catch {
			// Retention state is authoritative; cleanup telemetry is handled by the owner.
		}
	}

	private removeOrphan(id: string, canonicalOwnerRoot: string): void {
		const directory = join(canonicalOwnerRoot, id);
		try {
			if (!pathWithin(canonicalOwnerRoot, directory)) return;
			assertNoSymlinkComponents(directory);
			const canonicalDirectory = realpathSync(directory);
			const directoryStat = lstatSync(directory);
			if (canonicalDirectory !== directory || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
			for (const name of ["output.txt", "output.json"]) {
				const candidate = join(directory, name);
				try {
					const file = lstatSync(candidate);
					if (file.isFile() && !file.isSymbolicLink()) unlinkSync(candidate);
				} catch {
					// A missing artifact file is already absent.
				}
			}
			try {
				rmdirSync(directory);
			} catch {
				// Do not recursively remove unexpected contents.
			}
		} catch {
			// A malformed or symlinked orphan is left untouched.
		}
	}
}
