import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	disableExtensionConsoleCapture,
	type ExtensionConsoleEntry,
	enableExtensionConsoleCapture,
	loadExtensions,
	setExtensionConsoleSink,
} from "../src/core/extensions/loader.ts";

describe("extension console capture", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ice-ext-console-"));
	});

	afterEach(() => {
		disableExtensionConsoleCapture();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeExtension(name: string, body: string): string {
		const file = path.join(tempDir, name);
		fs.writeFileSync(file, `export default function (ice) {\n${body}\n}\n`);
		return file;
	}

	test("buffers load-time console output until a sink attaches, then streams to it", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const quiet = writeExtension("quiet.ts", `console.warn("[quiet] needs newer host", 3);`);
		const loud = writeExtension("loud.ts", `console.error("boom");`);

		enableExtensionConsoleCapture();
		await loadExtensions([quiet], tempDir);
		expect(warnSpy).not.toHaveBeenCalled();

		const seen: ExtensionConsoleEntry[] = [];
		setExtensionConsoleSink((entry) => seen.push(entry));
		expect(seen).toEqual([{ extensionPath: quiet, level: "warn", text: "[quiet] needs newer host 3" }]);

		await loadExtensions([loud], tempDir);
		expect(seen.at(-1)).toEqual({ extensionPath: loud, level: "error", text: "boom" });
		warnSpy.mockRestore();
	});

	test("restores console after a failing extension and does nothing when disabled", async () => {
		const originalWarn = console.warn;
		const failing = writeExtension("failing.ts", `console.warn("before"); throw new Error("nope");`);

		enableExtensionConsoleCapture();
		const result = await loadExtensions([failing], tempDir);
		expect(result.errors).toHaveLength(1);
		expect(console.warn).toBe(originalWarn);
		expect(disableExtensionConsoleCapture()).toEqual([{ extensionPath: failing, level: "warn", text: "before" }]);

		const passthrough = vi.spyOn(console, "warn").mockImplementation(() => {});
		const plain = writeExtension("plain.ts", `console.warn("visible");`);
		await loadExtensions([plain], tempDir);
		expect(passthrough).toHaveBeenCalledWith("visible");
		passthrough.mockRestore();
	});
});
