import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("UI style settings", () => {
	it("defaults to compact footer, compact tools, and auto symbols", () => {
		const settings = SettingsManager.inMemory({});
		expect(settings.getFooterStyle()).toBe("compact");
		expect(settings.getToolStyle()).toBe("compact");
		expect(settings.getSymbols()).toBe("auto");
	});

	it("persists explicit choices and ignores unknown values", () => {
		const settings = SettingsManager.inMemory({});
		settings.setFooterStyle("legacy");
		settings.setToolStyle("boxed");
		settings.setSymbols("ascii");
		expect([settings.getFooterStyle(), settings.getToolStyle(), settings.getSymbols()]).toEqual([
			"legacy",
			"boxed",
			"ascii",
		]);

		const invalid = SettingsManager.inMemory({ footerStyle: "x", toolStyle: "x", symbols: "x" } as never);
		expect([invalid.getFooterStyle(), invalid.getToolStyle(), invalid.getSymbols()]).toEqual([
			"compact",
			"compact",
			"auto",
		]);
	});
});
