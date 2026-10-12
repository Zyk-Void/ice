interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

const RAW_STDOUT_RETRY_DELAY_MS = 10;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();
let rawStdoutLimit: number | undefined;
let rawStdoutQueuedBytes = 0;

export class RawStdoutLimitError extends Error {
	readonly code: "output_too_large" | "output_overflow";

	constructor(code: "output_too_large" | "output_overflow") {
		super(
			code === "output_too_large"
				? "Raw stdout write exceeds the byte limit"
				: "Raw stdout queue exceeds the byte limit",
		);
		this.name = "RawStdoutLimitError";
		this.code = code;
	}
}

/** Opt-in UTF-8 byte ceiling for queued and in-flight writes; other modes stay unlimited. */
export function configureRawStdoutLimit(maxBytes?: number): void {
	if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0))
		throw new RangeError("Raw stdout limit must be a non-negative safe integer");
	rawStdoutLimit = maxBytes;
}

export function getRawStdoutQueuedBytes(): number {
	return rawStdoutQueuedBytes;
}

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	// Pending tails still own their reservations; never reset their counter.
	configureRawStdoutLimit();
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	const bytes = Buffer.byteLength(text, "utf8");
	if (rawStdoutLimit !== undefined) {
		if (bytes > rawStdoutLimit) throw new RawStdoutLimitError("output_too_large");
		if (bytes > rawStdoutLimit - rawStdoutQueuedBytes) throw new RawStdoutLimitError("output_overflow");
	}
	rawStdoutQueuedBytes += bytes;
	rawStdoutWriteTail = rawStdoutWriteTail
		.then(() => writeRawStdoutChunk(text))
		.finally(() => {
			rawStdoutQueuedBytes -= bytes;
		});
	void rawStdoutWriteTail.catch(() => {
		process.exit(1);
	});
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
