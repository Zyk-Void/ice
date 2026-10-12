import { setKeybindings, type TUI, visibleWidth } from "@zykairotis/ice-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("toggles a favorite to the top, retains selection, and persists across reopening", async () => {
		harness = await createHarness({ models: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] });
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("alpha"),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		await vi.waitFor(() => expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed."));
		selector.handleInput("\x1b[B");
		selector.handleInput("F");
		const rows = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.filter((line) => line.includes(`[${harness!.models[0].provider}]`));
		expect(rows[0]).toContain("→ beta");
		expect(rows[0]).toContain("[fav]");
		expect(selector.getSearchInput().getValue()).toBe("");
		expect(harness.settingsManager.getFavoriteModels()).toEqual([`${harness.models[0].provider}/beta`]);
		await harness.settingsManager.flush();
		await harness.settingsManager.reload();
		selector.dispose();
		const reopened = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		expect(stripAnsi(reopened.render(120).join("\n"))).toContain("→ beta");
		reopened.handleInput("\x1b[102;2u");
		expect(harness.settingsManager.getFavoriteModels()).toEqual([]);
		expect(stripAnsi(reopened.render(120).join("\n"))).not.toContain("[fav]");
		expect(stripAnsi(reopened.render(120).join("\n"))).toContain("→ beta");
		reopened.dispose();
	});

	it("pins favorites in scoped and searched lists without changing cycle order", async () => {
		harness = await createHarness({ models: [{ id: "alpha-1" }, { id: "alpha-2" }, { id: "beta" }] });
		const models = harness.models;
		harness.settingsManager.setEnabledModels(models.map((model) => `${model.provider}/${model.id}`));
		harness.settingsManager.setFavoriteModels([`${harness.models[0].provider}/alpha-2`]);
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.settingsManager,
			harness.session.modelRuntime,
			models.map((model) => ({ model })),
			() => {},
			() => {},
		);
		await vi.waitFor(() => expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed."));
		for (const char of "alpha") selector.handleInput(char);
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("→ alpha-2");
		selector.handleInput("F");
		expect(selector.getSearchInput().getValue()).toBe("alpha");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("→ alpha-2");
		selector.handleInput("\t");
		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("[fav]");
		expect(harness.settingsManager.getEnabledModels()).toEqual(
			models.map((model) => `${model.provider}/${model.id}`),
		);
		for (const line of selector.render(30)) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		selector.dispose();
	});

	it("honors a remapped shortcut and ignores toggles with no matching model", async () => {
		harness = await createHarness({ models: [{ id: "alpha" }] });
		setKeybindings(new KeybindingsManager({ "app.model.toggleFavorite": "ctrl+f" }));
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		selector.handleInput("\x06");
		expect(harness.settingsManager.getFavoriteModels()).toEqual([`${harness.models[0].provider}/alpha`]);
		selector.handleInput("F");
		expect(selector.getSearchInput().getValue()).toBe("F");
		for (const char of "no-match-xyz") selector.handleInput(char);
		selector.handleInput("\x06");
		expect(harness.settingsManager.getFavoriteModels()).toEqual([`${harness.models[0].provider}/alpha`]);
		selector.dispose();
	});

	it("stores exact global favorites independently of project overrides", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ favoriteModels: ["one/shared"], theme: "dark" }));
		storage.withLock("project", () => JSON.stringify({ favoriteModels: ["two/shared"] }));
		const settings = SettingsManager.fromStorage(storage);
		expect(settings.getFavoriteModels()).toEqual(["one/shared"]);
		const copy = settings.getFavoriteModels();
		copy.push("unexpected");
		settings.setFavoriteModels(["two/shared", "two/shared"]);
		await settings.flush();
		const reloaded = SettingsManager.fromStorage(storage);
		expect(reloaded.getFavoriteModels()).toEqual(["two/shared"]);
		expect(reloaded.getTheme()).toBe("dark");
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});
});
