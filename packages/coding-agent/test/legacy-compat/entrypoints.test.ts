import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function text(relative: string): string {
	return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("executable contracts", () => {
	it("packages ice as the only npm binary", () => {
		const pkg = JSON.parse(text("../../package.json")) as { bin?: Record<string, string> };
		expect(pkg.bin).toEqual({ ice: "dist/ice.js" });
	});

	it("keeps stock Ice and guarded ICE as ice-named entrypoints", () => {
		const stock = text("../../src/cli.ts");
		const guarded = text("../../src/ice.ts");
		expect(stock).toContain('process.title = "ice"');
		expect(stock).toContain('process.env.AI_AGENT = "ice"');
		expect(stock).not.toContain("createIceSafeVerify");
		expect(stock).not.toContain("iceSubagentsV2(");

		expect(guarded).toContain('process.title = "ice"');
		expect(guarded).toContain("createIceSafeVerify");
		expect(guarded).toContain("iceSubagentsV2(");
	});
});
