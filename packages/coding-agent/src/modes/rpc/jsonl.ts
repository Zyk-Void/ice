import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * Attach an LF-only JSONL reader to a stream.
 *
 * This intentionally does not use Node readline. Readline splits on additional
 * Unicode separators that are valid inside JSON strings and therefore does not
 * implement strict JSONL framing.
 */
export interface JsonlReaderOptions {
	/** UTF-8 bytes per record, excluding LF. Unset for unrestricted output readers. */
	maxLineBytes?: number;
	/** Called once per rejected record. The reader discards through its next LF. */
	onOverflow?: () => void;
}

export function attachJsonlLineReader(
	stream: Readable,
	onLine: (line: string) => void,
	options: JsonlReaderOptions = {},
): () => void {
	const limit = options.maxLineBytes ?? Number.POSITIVE_INFINITY;
	if (!(limit > 0) || (Number.isFinite(limit) && !Number.isSafeInteger(limit))) {
		throw new Error("maxLineBytes must be a positive safe integer.");
	}
	const decoder = new StringDecoder("utf8");
	let parts: string[] = [];
	let bytes = 0;
	let discarding = false;

	const append = (part: string) => {
		if (discarding || !part) return;
		bytes += Buffer.byteLength(part, "utf8");
		if (bytes > limit) {
			parts = [];
			bytes = 0;
			discarding = true;
			options.onOverflow?.();
		} else {
			// Bound per-fragment overhead even when a peer sends one byte per chunk.
			const last = parts.length - 1;
			if (last >= 0 && parts[last].length + part.length <= 8192) parts[last] += part;
			else parts.push(part);
		}
	};

	const emitLine = () => {
		const line = parts.join("");
		parts = [];
		bytes = 0;
		if (!discarding) onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		discarding = false;
	};

	const consume = (text: string) => {
		let start = 0;
		let newline = text.indexOf("\n", start);
		while (newline !== -1) {
			append(text.slice(start, newline));
			emitLine();
			start = newline + 1;
			newline = text.indexOf("\n", start);
		}
		append(text.slice(start));
	};
	const onData = (chunk: string | Buffer) => {
		consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
	};
	const onEnd = () => {
		consume(decoder.end());
		if (bytes > 0 || discarding) emitLine();
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
		parts = [];
	};
}
