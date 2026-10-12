import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserBashEventResult } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("user Bash routing", () => {
	it.each([
		[
			"throw",
			(): never => {
				throw new Error("route unavailable");
			},
		],
		["null", (): unknown => null],
		["false", (): unknown => false],
		["empty", () => ({})],
		["invalid operations", () => ({ operations: { exec: "invalid" } })],
		["invalid result", () => ({ result: { output: "incomplete" } })],
		["invalid exit code", () => ({ result: { output: "", exitCode: NaN, cancelled: false, truncated: false } })],
	] as const)("fails closed for %s instead of running host Bash", async (_name, response) => {
		const laterHandler = vi.fn();
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.on("user_bash", () => response() as UserBashEventResult);
					ice.on("user_bash", laterHandler);
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const errors = vi.fn();
		harness.session.extensionRunner.onError(errors);
		const marker = join(harness.tempDir, "host-executed");
		const runLikeCaller = async () => {
			const routed = await harness.session.extensionRunner.emitUserBash({
				type: "user_bash",
				command: `touch '${marker}'`,
				excludeFromContext: false,
				cwd: harness.tempDir,
			});
			if (!routed?.result)
				await harness.session.executeBash(`touch '${marker}'`, undefined, { operations: routed?.operations });
		};
		await expect(runLikeCaller()).rejects.toThrow("User Bash routing failed");
		expect(existsSync(marker)).toBe(false);
		expect(laterHandler).not.toHaveBeenCalled();
		expect(errors).toHaveBeenCalledOnce();
	});

	it("continues on undefined and preserves a complete replacement result", async () => {
		const result = { output: "routed", exitCode: 0, cancelled: false, truncated: false };
		const harness = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.on("user_bash", () => undefined);
					ice.on("user_bash", () => ({ result }));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(
			await harness.session.extensionRunner.emitUserBash({
				type: "user_bash",
				command: "unused",
				excludeFromContext: false,
				cwd: harness.tempDir,
			}),
		).toEqual({ result });
	});

	it("preserves custom operations and an empty handler chain", async () => {
		const operations = { exec: vi.fn(async () => ({ exitCode: 0 })) };
		const routed = await createHarness({
			extensionFactories: [
				(ice) => {
					ice.on("user_bash", () => ({ operations }));
				},
			],
		});
		const plain = await createHarness();
		harnesses.push(routed, plain);
		await routed.session.bindExtensions({});
		await plain.session.bindExtensions({});
		const event = { type: "user_bash" as const, command: "unused", excludeFromContext: false, cwd: routed.tempDir };
		expect(await routed.session.extensionRunner.emitUserBash(event)).toEqual({ operations });
		expect(await plain.session.extensionRunner.emitUserBash(event)).toBeUndefined();
	});
});
