import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("interactive Bash routing failure", () => {
	it("shows the routing error and returns without executing or recording Bash", async () => {
		const context = {
			session: {
				extensionRunner: { emitUserBash: vi.fn().mockRejectedValue(new Error("route unavailable")) },
				executeBash: vi.fn(),
				recordBashResult: vi.fn(),
			},
			sessionManager: { getCwd: () => "/test" },
			showError: vi.fn(),
		};
		const handle = Reflect.get(InteractiveMode.prototype, "handleBashCommand") as (
			this: typeof context,
			command: string,
			excludeFromContext: boolean,
		) => Promise<void>;
		await expect(handle.call(context, "do not execute", false)).resolves.toBeUndefined();
		expect(context.showError).toHaveBeenCalledWith("Bash command failed: route unavailable");
		expect(context.session.executeBash).not.toHaveBeenCalled();
		expect(context.session.recordBashResult).not.toHaveBeenCalled();
	});
});
