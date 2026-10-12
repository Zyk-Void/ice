import { describe, expect, test } from "vitest";
import {
	RPC_MAX_CONTROL_INPUT_BYTES,
	RPC_MAX_LIVE_CONTROLS,
	RPC_MAX_RETAINED_INPUT_BYTES,
	RpcInputAdmission,
} from "../src/modes/rpc/rpc-input-admission.ts";

describe("RPC retained input admission", () => {
	test("normal saturation leaves a reserved bounded control lane", () => {
		const admission = new RpcInputAdmission();
		const finish = admission.begin(RPC_MAX_RETAINED_INPUT_BYTES, false);
		expect(() => admission.begin(1, false)).toThrow("limit");
		const controls = Array.from({ length: RPC_MAX_LIVE_CONTROLS }, () => admission.begin(1, true));
		expect(() => admission.begin(1, true)).toThrow("limit");
		for (const done of controls) done();
		finish();
		expect(() => admission.begin(RPC_MAX_CONTROL_INPUT_BYTES + 1, true)).toThrow("limit");
	});

	test("counts and bytes release once and idle waits cover both lanes", async () => {
		const admission = new RpcInputAdmission();
		const normal = admission.begin(10, false);
		const control = admission.begin(20, true);
		let idle = false;
		const settled = admission.waitForIdle().then(() => {
			idle = true;
		});
		normal();
		normal();
		await Promise.resolve();
		expect(idle).toBe(false);
		control();
		await settled;
		expect(idle).toBe(true);
		const full = admission.begin(RPC_MAX_RETAINED_INPUT_BYTES, false);
		full();
	});

	test("close rejects future input without losing existing settlement", async () => {
		const admission = new RpcInputAdmission();
		const done = admission.begin(1, false);
		admission.close();
		expect(admission.isClosing).toBe(true);
		expect(() => admission.begin(1, true)).toThrow("shutting down");
		done();
		await admission.waitForIdle();
	});
});
