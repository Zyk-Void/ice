import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness } from "../harness.ts";

describe("extension factory transaction and listener ownership", () => {
	it("discards failed provider/default/subscription registrations and revokes the captured API", async () => {
		const runtime = createExtensionRuntime();
		const bus = createEventBus();
		let captured: ExtensionAPI | undefined;
		let calls = 0;
		await expect(
			loadExtensionFromFactory(
				(ice) => {
					captured = ice;
					ice.registerProvider("failed", { baseUrl: "http://invalid.test" });
					ice.registerFlag("failed", { type: "boolean", default: true });
					ice.registerSettings("failed", { items: [], onChange: () => {} });
					ice.events.on("test", () => {
						calls++;
					});
					throw new Error("factory rejected");
				},
				process.cwd(),
				bus,
				runtime,
			),
		).rejects.toThrow("factory rejected");
		bus.emit("test", {});
		expect(runtime.pendingProviderRegistrations).toEqual([]);
		expect(runtime.flagValues.has("failed")).toBe(false);
		expect(calls).toBe(0);
		expect(() => captured?.registerFlag("late", { type: "boolean" })).toThrow();
		expect(() => captured?.events.emit("test", {})).toThrow();
		const successful = await loadExtensionFromFactory(
			(ice) => {
				ice.registerFlag("good", { type: "boolean", default: true });
			},
			process.cwd(),
			bus,
			runtime,
		);
		expect(successful.flags.has("good")).toBe(true);
		expect(runtime.flagValues.get("good")).toBe(true);
	});

	it("does not leak a bus listener after session invalidation", async () => {
		let captured: ExtensionAPI | undefined;
		let calls = 0;
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					captured = ice;
					ice.events.on("test", () => {
						calls++;
					});
				},
			],
		});
		try {
			captured!.events.emit("test", {});
			expect(calls).toBe(1);
			harness.session.dispose();
			expect(() => captured!.events.emit("test", {})).toThrow();
		} finally {
			harness.cleanup();
		}
	});

	it("uses a stable dispatch snapshot and supports unsubscribe", async () => {
		const calls: string[] = [];
		let unsubscribe: unknown;
		let registered = false;
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					unsubscribe = ice.on("agent_start", () => {
						calls.push("first");
						if (!registered) {
							registered = true;
							ice.on("agent_start", () => {
								calls.push("later");
							});
						}
					});
				},
			],
		});
		try {
			await harness.session.extensionRunner.emit({ type: "agent_start" });
			expect(calls).toEqual(["first"]);
			expect(typeof unsubscribe).toBe("function");
			if (typeof unsubscribe === "function") unsubscribe();
			await harness.session.extensionRunner.emit({ type: "agent_start" });
			expect(calls).toEqual(["first", "later"]);
		} finally {
			harness.cleanup();
		}
	});

	it.each([
		(ice: ExtensionAPI) => ice.registerFlag("bad", { type: "boolean", default: "bad" as never }),
		(ice: ExtensionAPI) => ice.registerCommand("bad command", { handler: async () => {} }),
		(ice: ExtensionAPI) =>
			ice.registerTool({
				name: "bad",
				label: "Bad",
				description: "Invalid",
				parameters: Type.String(),
				execute: async () => ({ content: [], details: {} }),
			}),
	])("rejects malformed registrations during loading", async (factory) => {
		await expect(
			loadExtensionFromFactory(factory, process.cwd(), createEventBus(), createExtensionRuntime()),
		).rejects.toThrow();
	});
});
