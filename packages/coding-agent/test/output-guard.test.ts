import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	configureRawStdoutLimit,
	getRawStdoutQueuedBytes,
	RawStdoutLimitError,
	restoreStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../src/core/output-guard.ts";

type WriteCallback = (error?: Error | null) => void;

let callbacks: WriteCallback[];
let chunks: string[];

async function finishWrite(): Promise<void> {
	await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0));
	callbacks.shift()!();
}

function expectLimitError(text: string, code: RawStdoutLimitError["code"]): void {
	expect(() => writeRawStdout(text)).toThrowError(RawStdoutLimitError);
	try {
		writeRawStdout(text);
	} catch (error) {
		expect(error).toMatchObject({ name: "RawStdoutLimitError", code });
	}
}

beforeEach(() => {
	callbacks = [];
	chunks = [];
	vi.spyOn(process.stdout, "write").mockImplementation(((text: string, callback?: WriteCallback) => {
		chunks.push(text);
		if (callback) callbacks.push(callback);
		return false;
	}) as typeof process.stdout.write);
	takeOverStdout();
});

afterEach(async () => {
	await waitForRawStdoutBackpressure().catch(() => {});
	restoreStdout();
	vi.restoreAllMocks();
});

describe("raw stdout byte limits", () => {
	it("is unlimited by default", async () => {
		writeRawStdout("x".repeat(1024 * 1024));
		expect(getRawStdoutQueuedBytes()).toBe(1024 * 1024);
		await finishWrite();
		await waitForRawStdoutBackpressure();
		expect(getRawStdoutQueuedBytes()).toBe(0);
	});

	it("rejects a single oversized UTF-8 write synchronously without reserving bytes", async () => {
		configureRawStdoutLimit(3);
		expectLimitError("😀", "output_too_large");
		expect(getRawStdoutQueuedBytes()).toBe(0);
		expect(chunks).toEqual([]);
		writeRawStdout("€");
		expect(getRawStdoutQueuedBytes()).toBe(3);
		await finishWrite();
	});

	it("reserves a burst synchronously at the exact aggregate UTF-8 limit", async () => {
		configureRawStdoutLimit(6);
		writeRawStdout("😀");
		writeRawStdout("é");
		expect(getRawStdoutQueuedBytes()).toBe(6);
		expectLimitError("a", "output_overflow");
		expect(getRawStdoutQueuedBytes()).toBe(6);
		await finishWrite();
		await finishWrite();
		await waitForRawStdoutBackpressure();
		expect(chunks).toEqual(["😀", "é"]);
		expect(getRawStdoutQueuedBytes()).toBe(0);
	});

	it("counts in-flight bytes until callback completion and reuses released capacity", async () => {
		configureRawStdoutLimit(4);
		writeRawStdout("test");
		await vi.waitFor(() => expect(callbacks).toHaveLength(1));
		expectLimitError("a", "output_overflow");
		await finishWrite();
		await waitForRawStdoutBackpressure();
		writeRawStdout("next");
		expect(getRawStdoutQueuedBytes()).toBe(4);
		await finishWrite();
	});

	it("disables the limit explicitly without discarding reservations", async () => {
		configureRawStdoutLimit(1);
		writeRawStdout("a");
		configureRawStdoutLimit();
		writeRawStdout("longer");
		expect(getRawStdoutQueuedBytes()).toBe(7);
		await finishWrite();
		await finishWrite();
	});

	it("restores unlimited output while retaining pending bytes across a new takeover", async () => {
		configureRawStdoutLimit(4);
		writeRawStdout("old!");
		await vi.waitFor(() => expect(callbacks).toHaveLength(1));
		restoreStdout();
		expect(getRawStdoutQueuedBytes()).toBe(4);
		takeOverStdout();
		writeRawStdout("new!!");
		configureRawStdoutLimit(9);
		expect(getRawStdoutQueuedBytes()).toBe(9);
		expectLimitError("a", "output_overflow");
		await finishWrite();
		await vi.waitFor(() => expect(getRawStdoutQueuedBytes()).toBe(5));
		expectLimitError("12345", "output_overflow");
		await finishWrite();
		await waitForRawStdoutBackpressure();
		expect(getRawStdoutQueuedBytes()).toBe(0);
	});

	it("resets a configured limit even without a stdout takeover", async () => {
		restoreStdout();
		configureRawStdoutLimit(0);
		restoreStdout();
		writeRawStdout("unlimited");
		await finishWrite();
	});

	it("accepts empty writes at zero limit and rejects nonempty writes", () => {
		configureRawStdoutLimit(0);
		writeRawStdout("");
		expectLimitError("a", "output_too_large");
		expect(getRawStdoutQueuedBytes()).toBe(0);
	});

	it("rejects invalid limits without replacing the existing limit", () => {
		configureRawStdoutLimit(0);
		for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => configureRawStdoutLimit(limit)).toThrowError(RangeError);
		}
		expectLimitError("a", "output_too_large");
	});

	it("keeps reservations during transient sink retries", async () => {
		configureRawStdoutLimit(4);
		writeRawStdout("test");
		await vi.waitFor(() => expect(callbacks).toHaveLength(1));
		callbacks.shift()!(Object.assign(new Error("retry"), { code: "EAGAIN" }));
		expect(getRawStdoutQueuedBytes()).toBe(4);
		expectLimitError("a", "output_overflow");
		await finishWrite();
		await waitForRawStdoutBackpressure();
		expect(chunks).toEqual(["test", "test"]);
		expect(getRawStdoutQueuedBytes()).toBe(0);
	});

	// A permanent sink failure intentionally poisons the tail and exits; run this last.
	it("releases failed and skipped queued writes while preserving sink-failure exit behavior", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		configureRawStdoutLimit(6);
		writeRawStdout("bad");
		writeRawStdout("end");
		const failure = new Error("sink failed");
		const drained = expect(waitForRawStdoutBackpressure()).rejects.toBe(failure);
		await vi.waitFor(() => expect(callbacks).toHaveLength(1));
		callbacks.shift()!(failure);
		await drained;
		expect(getRawStdoutQueuedBytes()).toBe(0);
		expect(chunks).toEqual(["bad"]);
		expect(exit).toHaveBeenCalledWith(1);
	});
});
