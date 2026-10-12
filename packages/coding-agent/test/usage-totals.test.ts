import { fauxAssistantMessage } from "@zykairotis/ice-ai/compat";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { getUsageCostBreakdown, subagentUsageFromEntry } from "../src/core/usage-totals.ts";
import { createHarness } from "./suite/harness.ts";

const childUsage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.5 };

describe("subagent usage totals", () => {
	it("reads child billing usage and groups it under Subagents", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("subagent_usage", { childId: "ag_a", agent: "explore", usage: childUsage });
		const entry = manager.getEntries()[0]!;
		expect(subagentUsageFromEntry(entry)).toEqual({
			...childUsage,
			totalTokens: 190,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
		});
		expect(getUsageCostBreakdown(manager.getEntries())).toEqual([{ key: "Subagents", cost: 0.5, tokens: 190 }]);
	});

	it.each([
		null,
		{},
		{ usage: null },
		{ usage: [] },
		{ usage: { ...childUsage, input: "100" } },
		{ usage: { ...childUsage, output: -1 } },
		{ usage: { ...childUsage, cacheRead: 0.5 } },
		{ usage: { ...childUsage, cacheWrite: Infinity } },
		{ usage: { ...childUsage, cost: NaN } },
		{ usage: { ...childUsage, cost: -1 } },
		{ usage: { ...childUsage, cost: {} } },
		{ usage: { ...childUsage, input: Number.MAX_SAFE_INTEGER } },
	])("ignores malformed child usage: %j", (data) => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("subagent_usage", data);
		expect(subagentUsageFromEntry(manager.getEntries()[0]!)).toBeUndefined();
		expect(getUsageCostBreakdown(manager.getEntries())).toEqual([]);
	});

	it("ignores unrelated custom entries", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("other", { usage: childUsage });
		expect(subagentUsageFromEntry(manager.getEntries()[0]!)).toBeUndefined();
	});

	it("includes durable child billing in session stats without changing parent context", async () => {
		const harness = await createHarness({ persistSession: true });
		try {
			harness.setResponses([fauxAssistantMessage("parent answer")]);
			await harness.session.prompt("hello");
			const before = harness.session.getSessionStats();
			harness.sessionManager.appendCustomEntry("subagent_usage", {
				childId: "ag_a",
				agent: "explore",
				usage: childUsage,
			});
			harness.sessionManager.flushDurably();
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			const after = harness.session.getSessionStats();
			expect(after.cost).toBe(before.cost + childUsage.cost);
			expect(after.tokens).toEqual({
				input: before.tokens.input + 100,
				output: before.tokens.output + 20,
				cacheRead: before.tokens.cacheRead + 30,
				cacheWrite: before.tokens.cacheWrite + 40,
				total: before.tokens.total + 190,
			});
			expect(after.contextUsage).toEqual(before.contextUsage);
			expect(after.totalMessages).toBe(before.totalMessages);
			const restored = SessionManager.open(harness.sessionManager.getSessionFile()!);
			expect(getUsageCostBreakdown(restored.getEntries())).toContainEqual({
				key: "Subagents",
				cost: 0.5,
				tokens: 190,
			});
		} finally {
			harness.cleanup();
		}
	});
});
