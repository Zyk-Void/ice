import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { toJsonEvent } from "../src/modes/json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";

describe("RPC JSONL framing", () => {
	test("serializes strict JSONL records without escaping Unicode separators", () => {
		const line = serializeJsonLine({ text: "a\u2028b\u2029c" });

		expect(line).toContain("a\u2028b\u2029c");
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line.trim())).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("splits on LF only and preserves U+2028/U+2029 inside payloads", async () => {
		const lines: string[] = [];
		const stream = Readable.from([serializeJsonLine({ text: "a\u2028b\u2029c" })]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("handles CRLF-delimited input", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}\r\n{"b":2}\r\n')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("emits a final line without trailing LF", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}']);
	});

	test("rejects oversized records once and recovers at the next LF", async () => {
		const lines: string[] = [];
		let overflows = 0;
		const stream = Readable.from(["123", "456", "789\nok\n", "123456"]);
		const done = new Promise<void>((resolve) => stream.on("end", resolve));
		attachJsonlLineReader(stream, (line) => lines.push(line), { maxLineBytes: 5, onOverflow: () => overflows++ });
		await done;
		expect(lines).toEqual(["ok"]);
		expect(overflows).toBe(2);
	});

	test("counts UTF-8 bytes across split multibyte chunks and accepts the exact limit", async () => {
		const lines: string[] = [];
		let overflows = 0;
		const encoded = Buffer.from("éé\nééé\nx\n");
		const stream = Readable.from([...encoded].map((byte) => Buffer.from([byte])));
		const done = new Promise<void>((resolve) => stream.on("end", resolve));
		attachJsonlLineReader(stream, (line) => lines.push(line), { maxLineBytes: 4, onOverflow: () => overflows++ });
		await done;
		expect(lines).toEqual(["éé", "x"]);
		expect(overflows).toBe(1);
	});

	test("preserves typed subagent_checkin details through the RPC JSON event path", () => {
		const notice = {
			schemaVersion: 1,
			noticeId: "notice-1",
			ownerSessionId: "parent-1",
			createdAt: 1_000,
			children: [
				{
					jobId: "job-1",
					role: "explore",
					model: "test/model",
					executionStatus: "running",
					freshness: "fresh",
					sequence: 2,
					elapsedMs: 120_000,
					overdueMs: 0,
				},
			],
		};
		const event = {
			type: "message_start",
			message: {
				role: "custom",
				customType: "subagent_checkin",
				content: "ICE supervisory check-in.",
				display: false,
				details: notice,
				timestamp: 1_000,
			},
		};

		const jsonEvent = toJsonEvent(event as never);
		const encoded = serializeJsonLine(jsonEvent);
		const decoded = JSON.parse(encoded.trim()) as {
			type: string;
			message: { customType: string; display: boolean; details: unknown };
		};

		expect(decoded).toEqual(event);
		expect(decoded.message.customType).toBe("subagent_checkin");
		expect(decoded.message.display).toBe(false);
		expect(decoded.message.details).toEqual(notice);
		expect(Buffer.byteLength(encoded)).toBeLessThan(4 * 1024);
	});
});
