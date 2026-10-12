import { describe, expect, test } from "vitest";
import { SessionManager, type SessionManagerEvent } from "../src/core/session-manager.ts";

describe("SessionManager local mutation notifications", () => {
	test("publishes every append once, with indexed labels and leaf already visible", () => {
		const manager = SessionManager.inMemory();
		const seen: SessionManagerEvent[] = [];
		manager.subscribe((event) => {
			seen.push(event);
			if (event.type === "entry_appended") {
				expect(manager.getEntry(event.entry.id)).toBe(event.entry);
				expect(manager.getLeafId()).toBe(event.entry.id);
				if (event.entry.type === "label") expect(manager.getLabel(event.entry.targetId)).toBe(event.entry.label);
			}
		});
		const root = manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		manager.appendThinkingLevelChange("low");
		manager.appendModelChange("faux", "one");
		manager.appendCompaction("summary", root, 10);
		manager.appendCustomEntry("custom", { n: 1 });
		manager.appendSessionInfo("name");
		manager.appendCustomMessageEntry("context", "context", false);
		manager.appendLabelChange(root, "bookmark");
		manager.appendLabelChange(root, undefined);
		manager.branchWithSummary(root, "branch");
		expect(seen.filter((event) => event.type === "entry_appended").map((event) => event.entry.type)).toEqual([
			"message",
			"thinking_level_change",
			"model_change",
			"compaction",
			"custom",
			"session_info",
			"custom_message",
			"label",
			"label",
			"branch_summary",
		]);
		expect(seen).toHaveLength(manager.getEntries().length);
	});

	test("reports explicit leaf moves without replaying existing entries, and unsubscribe is stable", () => {
		const manager = SessionManager.inMemory();
		const root = manager.appendCustomEntry("before-subscribe");
		const leaf = manager.appendCustomEntry("leaf");
		const seen: SessionManagerEvent[] = [];
		let unsubscribe = () => {};
		unsubscribe = manager.subscribe(() => unsubscribe());
		manager.subscribe((event) => seen.push(event));
		manager.branch(root);
		manager.branch(root);
		manager.resetLeaf();
		manager.resetLeaf();
		expect(seen).toEqual([
			{ type: "leaf_changed", leafId: root },
			{ type: "leaf_changed", leafId: null },
		]);
		manager.branch(leaf);
		expect(seen).toHaveLength(3);
		expect(() => manager.branch("missing")).toThrow();
		expect(seen).toHaveLength(3);
	});
});
