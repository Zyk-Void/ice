/**
 * Process @file CLI arguments into text content and image attachments
 */

import { readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@zykairotis/ice-ai";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { processImage } from "../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Directory relative paths resolve against. Default: process.cwd() */
	cwd?: string;
	/** Reject text files larger than this many bytes. Default: no limit */
	maxTextBytes?: number;
}

/** A file argument that cannot be attached; the message names the resolved path. */
export class FileArgumentError extends Error {
	readonly code: "not_found" | "too_large" | "unreadable";

	constructor(code: "not_found" | "too_large" | "unreadable", message: string) {
		super(message);
		this.name = "FileArgumentError";
		this.code = code;
	}
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const cwd = options?.cwd ?? process.cwd();
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolve(cwd, resolveReadPath(fileArg, cwd));

		let stats: Awaited<ReturnType<typeof stat>>;
		try {
			stats = await stat(absolutePath);
		} catch {
			throw new FileArgumentError("not_found", `File not found: ${absolutePath}`);
		}
		if (!stats.isFile()) throw new FileArgumentError("unreadable", `Not a regular file: ${absolutePath}`);

		// Skip empty files
		if (stats.size === 0) continue;

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			// Handle image file
			const content = await readFile(absolutePath);
			const processed = await processImage(content, mimeType, { autoResizeImages });

			if (!processed.ok) {
				text += `<file name="${absolutePath}">${processed.message}</file>\n`;
				continue;
			}

			const attachment: ImageContent = {
				type: "image",
				mimeType: processed.mimeType,
				data: processed.data,
			};
			images.push(attachment);

			// Add text reference to image with optional processing hints
			if (processed.hints.length > 0) {
				text += `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// Handle text file
			if (options?.maxTextBytes !== undefined && stats.size > options.maxTextBytes) {
				throw new FileArgumentError("too_large", `File exceeds ${options.maxTextBytes} bytes: ${absolutePath}`);
			}
			try {
				const content = await readFile(absolutePath, "utf-8");
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				throw new FileArgumentError("unreadable", `Could not read file ${absolutePath}: ${message}`);
			}
		}
	}

	return { text, images };
}
