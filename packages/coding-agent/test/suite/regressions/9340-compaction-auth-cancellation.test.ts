import { fauxAssistantMessage } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function seed() {
	const hook = vi.fn();
	const harness = await createHarness({
		settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 4096 } },
		extensionFactories: [
			(ice) => {
				ice.on("session_before_compact", hook);
			},
		],
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("original answer")]);
	await harness.session.prompt("original request");
	return { harness, hook };
}

describe("#9340 compaction cancellation ownership", () => {
	it("honors cancellation while manual compaction waits for the active run to settle", async () => {
		const { harness, hook } = await seed();
		const entered = gate();
		const resume = gate();
		vi.spyOn(harness.session, "waitForIdle").mockImplementation(async () => {
			entered.release();
			await resume.promise;
		});
		harness.setResponses([fauxAssistantMessage("must not be consumed")]);
		const pending = harness.session.compact().then(
			() => "success",
			(error: unknown) => error,
		);
		await entered.promise;
		harness.session.abortCompaction();
		resume.release();
		expect(await pending).toMatchObject({ name: "AbortError", message: "Compaction cancelled" });
		expect(hook.mock.calls.length).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);
	});
	it.each([
		["manual", false],
		["automatic", false],
		["manual", true],
		["automatic", true],
	] as const)("cancels %s compaction during authentication (custom stream=%s)", async (kind, customStream) => {
		const { harness, hook } = await seed();
		if (customStream) {
			const stream = harness.session.agent.streamFunction;
			harness.session.agent.streamFunction = (model, context, options) => stream(model, context, options);
		}
		const entered = gate();
		const resume = gate();
		let authSignal: AbortSignal | undefined;
		const originalGetAuth = harness.session.modelRuntime.getAuth.bind(harness.session.modelRuntime);
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async (model, overrides) => {
			authSignal = overrides?.signal;
			entered.release();
			await resume.promise;
			return originalGetAuth(model);
		});
		harness.setResponses([fauxAssistantMessage("must not be consumed")]);
		const auto = Reflect.get(harness.session, "_runAutoCompaction") as (
			reason: "threshold",
			willRetry: boolean,
		) => Promise<boolean>;
		const pending =
			kind === "manual"
				? harness.session.compact().then(
						() => "success",
						(error: unknown) => error,
					)
				: auto.call(harness.session, "threshold", false);
		await entered.promise;
		harness.session.abortCompaction();
		resume.release();
		const result = await pending;
		if (kind === "manual") expect(result).toMatchObject({ name: "AbortError" });
		else expect(result).toBe(false);
		expect(authSignal?.aborted).toBe(true);
		expect(hook).not.toHaveBeenCalled();
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("does not request an overflow retry after cancellation at compaction_end", async () => {
		const { harness } = await seed();
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") harness.session.abortCompaction();
		});
		harness.setResponses([fauxAssistantMessage("saved checkpoint")]);
		const auto = Reflect.get(harness.session, "_runAutoCompaction") as (
			reason: "overflow",
			willRetry: boolean,
		) => Promise<boolean>;
		expect(await auto.call(harness.session, "overflow", true)).toBe(false);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("honors an abort requested synchronously by automatic compaction_start", async () => {
		const { harness, hook } = await seed();
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") harness.session.abortCompaction();
		});
		harness.setResponses([fauxAssistantMessage("must not be consumed")]);
		const auto = Reflect.get(harness.session, "_runAutoCompaction") as (
			reason: "threshold",
			willRetry: boolean,
		) => Promise<boolean>;
		expect(await auto.call(harness.session, "threshold", false)).toBe(false);
		expect(hook).not.toHaveBeenCalled();
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true, willRetry: false });
	});
});
