import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SendNowContext = {
	editor: {
		getText: () => string;
		setText: (text: string) => void;
		onSubmit?: (text: string) => void;
	};
	session: {
		isStreaming: boolean;
		isCompacting: boolean;
		bashBackground: { releaseAll: () => number };
		abort: () => Promise<void>;
	};
	agentViewBridge?: { releaseBlockingWaits: () => number };
	isExtensionCommand: (text: string) => boolean;
	clearAllQueues: () => { steering: string[]; followUp: string[] };
	updatePendingMessagesDisplay: () => void;
};

type InteractiveModePrototype = {
	handleSendNow(this: SendNowContext): Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function context(streaming: boolean, queued = { steering: [] as string[], followUp: [] as string[] }) {
	const order: string[] = [];
	const ctx: SendNowContext = {
		editor: {
			getText: () => "  look at this instead  ",
			setText: vi.fn(),
			onSubmit: vi.fn((text: string) => order.push(`submit:${text}`)),
		},
		session: {
			isStreaming: streaming,
			isCompacting: false,
			bashBackground: { releaseAll: vi.fn(() => order.push("release-bash")) },
			abort: vi.fn(async () => {
				order.push("abort");
			}),
		},
		agentViewBridge: { releaseBlockingWaits: vi.fn(() => order.push("release-agents")) },
		isExtensionCommand: () => false,
		clearAllQueues: vi.fn(() => queued),
		updatePendingMessagesDisplay: vi.fn(),
	};
	return { ctx, order };
}

describe("InteractiveMode send now (ctrl+enter)", () => {
	it("backgrounds running work, aborts the turn, then submits queued messages and the prompt", async () => {
		const { ctx, order } = context(true, { steering: ["earlier steer"], followUp: ["later follow-up"] });
		await prototype.handleSendNow.call(ctx);
		expect(order).toEqual([
			"release-bash",
			"release-agents",
			"abort",
			"submit:earlier steer\n\nlater follow-up\n\nlook at this instead",
		]);
		expect(ctx.editor.setText).toHaveBeenCalledWith("");
	});

	it("submits like enter when the agent is idle", async () => {
		const { ctx, order } = context(false);
		await prototype.handleSendNow.call(ctx);
		expect(order).toEqual(["submit:look at this instead"]);
		expect(ctx.session.abort).not.toHaveBeenCalled();
	});
});
