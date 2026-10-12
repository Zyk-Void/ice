import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("session configuration notifications", () => {
	test("forwards all manager appends once, including direct and extension writes, and detaches on disposal", async () => {
		let api!: ExtensionAPI;
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					api = ice;
				},
			],
		});
		harnesses.push(harness);
		api.appendEntry("custom", { n: 1 });
		harness.session.setThinkingLevel("low");
		harness.session.setSessionName("name");
		const root = harness.sessionManager.getEntries()[0]!.id;
		api.setLabel(root, "bookmark");
		await harness.session.setModel(harness.getModel());
		expect(harness.eventsOfType("entry_appended").map((event) => event.entry.id)).toEqual(
			harness.sessionManager.getEntries().map((entry) => entry.id),
		);
		harness.sessionManager.branch(root);
		expect(harness.eventsOfType("leaf_changed")).toEqual([{ type: "leaf_changed", leafId: root }]);
		const count = harness.events.length;
		harness.session.dispose();
		harness.sessionManager.appendCustomEntry("after-dispose");
		expect(harness.events).toHaveLength(count);
	});
	test("model set and both cycling paths notify native subscribers after thinking clamping", async () => {
		const harness = await createHarness({
			models: [
				{ id: "one", reasoning: true },
				{ id: "two", reasoning: false },
			],
		});
		harnesses.push(harness);
		const one = harness.getModel("one")!;
		const two = harness.getModel("two")!;
		one.headers = { Authorization: "previous-private-header" };
		two.headers = { Authorization: "next-private-header" };
		harness.session.setThinkingLevel("high");
		const observedLevels: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "model_changed") observedLevels.push(harness.session.thinkingLevel);
		});
		await harness.session.setModel(two);
		await harness.session.setModel(two); // Same identity does not notify twice.
		await harness.session.cycleModel("backward");
		harness.session.setScopedModels([{ model: one }, { model: two }]);
		await harness.session.cycleModel();
		expect(harness.eventsOfType("model_changed").map((event) => [event.model.id, event.source])).toEqual([
			["two", "set"],
			["one", "cycle"],
			["two", "cycle"],
		]);
		expect(observedLevels).toEqual(["off", "high", "off"]);
		expect(JSON.stringify(harness.eventsOfType("model_changed"))).not.toContain("private-header");
	});

	test("catalog metadata reconciliation retains selection, clamps thinking and does not append a model change", async () => {
		const harness = await createHarness({ models: [{ id: "one", reasoning: true }] });
		harnesses.push(harness);
		harness.session.setThinkingLevel("high");
		const next = { ...harness.getModel(), reasoning: false, contextWindow: 9999 };
		vi.spyOn(harness.session.modelRuntime, "getModel").mockReturnValue(next);
		harness.session.refreshModelMetadata();
		expect(harness.session.model?.contextWindow).toBe(9999);
		expect(harness.session.thinkingLevel).toBe("off");
		expect(harness.eventsOfType("model_changed")).toEqual([
			expect.objectContaining({ source: "refresh", model: next }),
		]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toHaveLength(0);
	});

	test("failed authentication emits no model-change notification", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		await expect(harness.session.setModel(harness.getModel())).rejects.toThrow("No API key");
		expect(harness.eventsOfType("model_changed")).toEqual([]);
	});

	test("native setters publish effective controls once and do not expose credentials", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.events.length = 0;
		harness.session.setFastMode(true);
		harness.session.setFastMode(true);
		harness.session.setSteeringMode("all");
		harness.session.setFollowUpMode("all");
		harness.session.setAutoCompactionEnabled(false);
		harness.session.setAutoRetryEnabled(false);
		harness.session.setActiveToolsByName(["read"]);
		harness.session.setScopedModels([{ model: harness.getModel(), thinkingLevel: "low" }]);
		const events = harness.eventsOfType("configuration_changed");
		expect(events).toHaveLength(7);
		expect(events.at(-1)?.configuration).toEqual({
			fastMode: true,
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: false,
			autoRetryEnabled: false,
			activeTools: ["read"],
			scopedModels: [
				{
					provider: harness.getModel().provider,
					modelId: harness.getModel().id,
					thinkingLevel: "low",
				},
			],
		});
		expect(JSON.stringify(events)).not.toContain("faux-key");
	});

	test("extension-driven model/tools changes, applied settings and reload notify subscribers", async () => {
		let api!: ExtensionAPI;
		const harness = await createHarness({
			models: [{ id: "one" }, { id: "two" }],
			extensionFactories: [
				(ice) => {
					api = ice;
				},
			],
		});
		harnesses.push(harness);
		await api.setModel(harness.getModel("two")!);
		api.setActiveTools(["read"]);
		expect(harness.eventsOfType("model_changed")).toHaveLength(1);
		expect(harness.eventsOfType("configuration_changed").at(-1)?.configuration.activeTools).toEqual(["read"]);
		harness.settingsManager.setSteeringMode("all");
		harness.session.syncSettingsFromManager();
		expect(harness.eventsOfType("settings_applied")).toHaveLength(1);
		expect(harness.eventsOfType("configuration_changed").at(-1)?.configuration.steeringMode).toBe("all");
		await harness.session.reload();
		expect(harness.eventsOfType("resources_changed")).toEqual([{ type: "resources_changed", reason: "reload" }]);
	});
});
