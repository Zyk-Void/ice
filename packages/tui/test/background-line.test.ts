import assert from "node:assert";
import { describe, it } from "node:test";
import { applyBackgroundToLine } from "../src/utils.ts";

describe("applyBackgroundToLine", () => {
	const background = (text: string) => `\x1b[44m${text}\x1b[49m`;

	it("reapplies background after ANSI full resets", () => {
		const rendered = applyBackgroundToLine("before\x1b[0mafter", 12, background);

		assert.ok(rendered.includes("\x1b[0m\x1b[44m"));
		assert.ok(rendered.includes("\x1b[44mafter \x1b[49m"));
	});

	it("reapplies background after default-background resets so padding stays covered", () => {
		const rendered = applyBackgroundToLine("\x1b[100mcode\x1b[49m tail", 12, background);

		assert.ok(rendered.includes("\x1b[49m\x1b[44m tail   \x1b[49m"));
	});

	it("does not treat extended color arguments as resets", () => {
		const rendered = applyBackgroundToLine("\x1b[38;5;0mx\x1b[48;2;0;0;49my", 4, background);

		assert.strictEqual(rendered, background("\x1b[38;5;0mx\x1b[48;2;0;0;49my  "));
	});
});
