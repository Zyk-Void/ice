import { rm } from "node:fs/promises";
import { fauxAssistantMessage } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import iceSubagents, { formatIceSubagentSettingsSummary } from "../src/ice-subagents.ts";
import { ICE_HOOK_JOURNAL_ENTRY_TYPE } from "../src/subagents/settings.ts";
import { createAsyncToolHarness, tempDirs } from "./ice-subagents-harness.ts";

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ICE subagent contracts", () => {
	it("exposes a bounded source-aware effective policy submenu in settings", async () => {
		const registerSettings = vi.fn();
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
		const settingsManager = SettingsManager.inMemory({
			ice: {
				subagents: { defaults: { startupTimeoutMs: 9_000 }, roleDefaults: { security: { thinking: "high" } } },
				hooks: {
					enabled: true,
					definitions: [{ id: "policy", event: "subagent.beforeLaunch", kind: "in-process" }],
				},
			},
		});
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) {
				handlers.set(event, handler);
			},
			registerSettings,
			registerTool: vi.fn(),
		} as unknown as ExtensionAPI;
		iceSubagents(api);
		const registered = registerSettings.mock.calls.find((call) => call[0] === "subagents")?.[1] as
			| {
					items: Array<{
						id: string;
						submenu?: (value: string, done: () => void) => { render(width: number): string[] };
					}>;
			  }
			| undefined;
		expect(registered).toBeDefined();
		const entries: Array<Record<string, unknown>> = [];
		const context = {
			cwd: process.cwd(),
			model: undefined,
			scopedModels: [],
			isProjectTrusted: () => true,
			settingsManager,
			ui: { notify: vi.fn() },
			sessionManager: { getSessionId: () => "settings-owner", getEntries: () => entries },
		} as unknown as ExtensionContext;
		await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, context);
		const policy = registered?.items.find((item) => item.id === "policy-summary");
		expect(policy?.submenu).toEqual(expect.any(Function));
		const submenu = policy?.submenu?.("inspect", () => {});
		const summary = submenu?.render(240).join("\n") ?? "";
		expect(summary).toContain("global subagents: enabled");
		expect(summary).toContain("security: thinking=high [global-role]");
		expect(summary).toContain("hooks: enabled");
		expect(summary).toContain("routing: inherit-parent only");
		expect(formatIceSubagentSettingsSummary(settingsManager, true)).toContain(
			"security: thinking=high [global-role]",
		);
		await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, context);
	});

	it("persists redacted hook intent and outcome records through the parent session seam", async () => {
		const settingsManager = SettingsManager.inMemory({
			ice: {
				hooks: {
					enabled: true,
					definitions: [
						{
							id: "journal",
							event: "subagent.beforeLaunch",
							kind: "in-process",
							required: true,
						},
					],
				},
			},
		});
		const harness = await createAsyncToolHarness({
			settingsManager,
			hookHandlers: {
				journal: () => ({ outcome: "continue" as const, reason: "api_key=hook-secret" }),
			},
		});
		try {
			harness.faux.setResponses([fauxAssistantMessage('{"summary":"journaled","evidence":{"paths":["src"]}}')]);
			const result = await harness.tools.get("delegate").execute(
				"hook-journal",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Inspect the source tree.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			expect(result).toMatchObject({ isError: false });
			const journalEntries = harness.entries.filter((entry) => entry.customType === ICE_HOOK_JOURNAL_ENTRY_TYPE);
			expect(journalEntries).toHaveLength(2);
			const phases = journalEntries.map((entry) => (entry.data as { phase: string }).phase);
			expect(phases).toEqual(["intent", "outcome"]);
			const records = journalEntries.map((entry) => (entry.data as { record: Record<string, unknown> }).record);
			expect(records[0]).toMatchObject({
				event: "subagent.beforeLaunch",
				outcome: "continue",
				observational: false,
			});
			expect(records[1]).toMatchObject({
				event: "subagent.beforeLaunch",
				outcome: "continue",
				observational: false,
			});
			expect(records[0]?.eventId).toBe(records[1]?.eventId);
			expect(records[1]?.reason).toBe("api_key=[REDACTED]");
			expect(JSON.stringify(records)).not.toContain("hook-secret");

			expect(records[0]?.hookId).toBe("journal");
			const intentReason = records[0] as Record<string, unknown>;
			expect("reason" in intentReason ? intentReason.reason : undefined).toBeUndefined();

			const outcomeIndex = harness.entries.findIndex(
				(entry) =>
					entry.customType === ICE_HOOK_JOURNAL_ENTRY_TYPE &&
					(entry.data as { phase?: string }).phase === "outcome",
			);
			expect(outcomeIndex).toBeGreaterThanOrEqual(0);
			harness.entries.splice(outcomeIndex, 1);
			const notifications: string[] = [];
			const ui = (harness.context as unknown as { ui: { notify: (message: string, type?: string) => void } }).ui;
			ui.notify = (message) => notifications.push(message);
			await harness.handlers.get("session_start")!({ type: "session_start", reason: "reload" }, harness.context);
			expect(notifications).toContain(
				"1 ICE hook dispatch is unresolved after the previous session ended; no hook was replayed automatically.",
			);
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});

	it("fails closed without invoking a hook handler when the parent intent journal write fails", async () => {
		const settingsManager = SettingsManager.inMemory({
			ice: {
				hooks: {
					enabled: true,
					definitions: [
						{
							id: "journal",
							event: "subagent.beforeLaunch",
							kind: "in-process",
							required: true,
						},
					],
				},
			},
		});
		const handler = vi.fn(() => ({ outcome: "continue" as const }));
		let failing = true;
		let harness!: Awaited<ReturnType<typeof createAsyncToolHarness>>;
		const appendEntry = vi.fn((customType: string, data: unknown) => {
			if (failing && customType === ICE_HOOK_JOURNAL_ENTRY_TYPE) throw new Error("intent journal unavailable");
			return harness.entries.push({ type: "custom", customType, data });
		});
		const apiAppendEntry = vi.fn((customType: string, data: unknown) => appendEntry(customType, data));
		harness = await createAsyncToolHarness({
			settingsManager,
			hookHandlers: { journal: handler },
			appendEntry: apiAppendEntry,
		});
		try {
			const result = await harness.tools.get("delegate").execute(
				"hook-journal-fails",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Inspect the source tree.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			expect(handler).not.toHaveBeenCalled();
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).toMatch(/intent was not durably recorded/i);
			expect(
				harness.entries.some(
					(entry) =>
						entry.customType === ICE_HOOK_JOURNAL_ENTRY_TYPE &&
						(entry.data as { phase?: string }).phase === "intent",
				),
			).toBe(false);
			failing = false;
			harness.faux.setResponses([fauxAssistantMessage('{"summary":"journaled","evidence":{"paths":["src"]}}')]);
			const retry = await harness.tools.get("delegate").execute(
				"hook-journal-recovers",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Inspect the source tree.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			expect(retry).toMatchObject({ isError: false });
			expect(handler).toHaveBeenCalledTimes(1);
		} finally {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, harness.context);
			harness.faux.unregister();
		}
	});
});
