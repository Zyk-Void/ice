import { describe, expect, test, vi } from "vitest";
import { NoticesViewComponent } from "../src/modes/interactive/components/notices-view.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { NoticeCenter } from "../src/modes/interactive/notice-center.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type NotifyThis = {
	noticeCenter: NoticeCenter;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	showStatus: (message: string) => void;
};
const showExtensionNotify = (
	InteractiveMode.prototype as unknown as {
		showExtensionNotify(
			this: NotifyThis,
			message: string,
			type?: "info" | "warning" | "error",
			options?: { id?: string; sticky?: boolean },
		): void;
	}
).showExtensionNotify;

describe("NoticeCenter", () => {
	test("deduplicates notices by id and keeps the original timestamp", () => {
		let now = 1;
		const center = new NoticeCenter(() => now);
		center.add({ id: "safety:bash", kind: "warning", source: "ice", title: "Bash enabled", sticky: true });
		now = 5;
		center.add({ id: "safety:bash", kind: "warning", source: "ice", title: "Bash enabled again", sticky: true });

		expect(center.list()).toEqual([
			{
				id: "safety:bash",
				kind: "warning",
				source: "ice",
				title: "Bash enabled again",
				sticky: true,
				createdAt: 1,
			},
		]);
	});

	test("counts warnings, errors, and updates but not info", () => {
		const center = new NoticeCenter();
		center.add({ id: "a", kind: "warning", source: "x", title: "a" });
		center.add({ id: "b", kind: "error", source: "x", title: "b" });
		center.add({ id: "c", kind: "update", source: "x", title: "c" });
		center.add({ id: "d", kind: "info", source: "x", title: "d" });

		expect(center.counts()).toEqual({ warning: 1, error: 1, update: 1 });
	});

	test("dismisses only non-sticky notices and notifies subscribers", () => {
		const center = new NoticeCenter();
		const listener = vi.fn();
		center.subscribe(listener);
		center.add({ id: "sticky", kind: "warning", source: "x", title: "s", sticky: true });
		center.add({ id: "plain", kind: "update", source: "x", title: "p" });
		listener.mockClear();

		expect(center.dismiss("sticky")).toBe(false);
		expect(center.dismiss("plain")).toBe(true);
		expect(center.dismiss("missing")).toBe(false);
		expect(center.list().map((notice) => notice.id)).toEqual(["sticky"]);
		expect(listener).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode extension notify routing", () => {
	function createThis(): NotifyThis {
		return { noticeCenter: new NoticeCenter(), showWarning: vi.fn(), showError: vi.fn(), showStatus: vi.fn() };
	}

	test("warnings with an id become deduplicated notices instead of transcript rows", () => {
		const fake = createThis();
		showExtensionNotify.call(fake, "Bash is enabled", "warning", { id: "safety:bash", sticky: true });
		showExtensionNotify.call(fake, "Bash is enabled", "warning", { id: "safety:bash", sticky: true });

		expect(fake.showWarning).not.toHaveBeenCalled();
		expect(fake.noticeCenter.list()).toMatchObject([{ id: "safety:bash", kind: "warning", sticky: true }]);
	});

	test("notifications without an id keep transcript behavior", () => {
		const fake = createThis();
		showExtensionNotify.call(fake, "careful", "warning");
		showExtensionNotify.call(fake, "fyi", "info", { id: "ignored-for-info" });

		expect(fake.showWarning).toHaveBeenCalledWith("careful");
		expect(fake.showStatus).toHaveBeenCalledWith("fyi");
		expect(fake.noticeCenter.list()).toHaveLength(0);
	});
});

describe("NoticesViewComponent", () => {
	const render = (view: NoticesViewComponent) =>
		view
			.render(100)
			.join("\n")
			.replace(/\u001b\[[0-9;]*m/g, "");

	test("lists live notices, dismisses on enter, and stops updating after dispose", () => {
		initTheme("dark");
		const center = new NoticeCenter();
		center.add({ id: "pkg", kind: "update", source: "npm", title: "Package updates available" });
		const view = new NoticesViewComponent(center, () => {});
		expect(render(view)).toContain("Package updates available");

		center.add({ id: "safety:bash", kind: "warning", source: "ice", title: "Bash enabled", sticky: true });
		expect(render(view)).toContain("Bash enabled");

		view.handleInput("\r");
		expect(center.list().map((notice) => notice.id)).toEqual(["safety:bash"]);
		expect(render(view)).not.toContain("Package updates available");

		view.dispose();
		center.add({ id: "late", kind: "warning", source: "x", title: "Late notice" });
		expect(render(view)).not.toContain("Late notice");
	});
});
