import { describe, expect, test } from "vitest";
import { RpcCommandCoordinator } from "../src/modes/rpc/rpc-command-coordinator.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("RPC admission barriers", () => {
	test("bounds pending work and recovers capacity after settlement", async () => {
		const coordinator = new RpcCommandCoordinator(() => false, 2);
		const blocked = gate();
		const first = coordinator.run(async () => {
			await blocked.promise;
		}, true);
		const next = coordinator.run(async () => "next");
		await expect(coordinator.run(async () => "overflow")).rejects.toMatchObject({ errorCode: "busy" });
		blocked.release();
		await Promise.all([first, next]);
		await expect(coordinator.run(async () => "recovered")).resolves.toBe("recovered");
		expect(() => new RpcCommandCoordinator(() => false, 0)).toThrow("maxPending");
	});
	test("short mutations serialize while pure reads remain concurrent", async () => {
		const coordinator = new RpcCommandCoordinator();
		const preflight = gate();
		const order: string[] = [];
		const first = coordinator.run(
			async () => {
				order.push("first");
				await preflight.promise;
			},
			false,
			true,
		);
		const next = coordinator.run(
			async () => {
				order.push("next");
			},
			false,
			true,
		);
		await coordinator.run(async () => {
			order.push("read");
		});
		expect(order).toEqual(["first", "read"]);
		preflight.release();
		await Promise.all([first, next]);
		expect(order).toEqual(["first", "read", "next"]);
	});

	test("nested replacement refuses to wait on a later mutation dependent on its caller", async () => {
		const coordinator = new RpcCommandCoordinator();
		const hook = gate();
		const first = coordinator.run(
			async () => {
				await hook.promise;
				await expect(coordinator.runTransition(async () => {})).rejects.toMatchObject({ errorCode: "busy" });
			},
			false,
			true,
		);
		const next = coordinator.run(async () => "next", false, true);
		hook.release();
		await first;
		await expect(next).resolves.toBe("next");
	});

	test("accepted and retired prompt contexts cannot replace their own still-running operation", async () => {
		const coordinator = new RpcCommandCoordinator(() => true);
		const later = gate();
		let fromStream!: Promise<void>;
		await coordinator.run(
			async () => {
				coordinator.retirePromptPreflight();
				await expect(coordinator.runTransition(async () => {})).rejects.toMatchObject({ errorCode: "busy" });
				fromStream = later.promise.then(async () => {
					await expect(coordinator.runTransition(async () => {})).rejects.toMatchObject({ errorCode: "busy" });
				});
			},
			false,
			true,
		);
		later.release();
		await fromStream;
	});
	test("reserves transitions synchronously and preserves adjacent command order", async () => {
		const coordinator = new RpcCommandCoordinator();
		const first = gate();
		const second = gate();
		const order: string[] = [];
		const a = coordinator.run(async () => {
			order.push("a");
			await first.promise;
		}, true);
		const read = coordinator.run(async () => {
			order.push("read");
		});
		const b = coordinator.run(async () => {
			order.push("b");
			await second.promise;
		}, true);
		const prompt = coordinator.run(async () => {
			order.push("prompt");
		});
		expect(order).toEqual(["a"]);
		first.release();
		await read;
		expect(order.slice(0, 2)).toEqual(["a", "read"]);
		await a;
		await Promise.resolve();
		expect(order).toEqual(["a", "read", "b"]);
		second.release();
		await Promise.all([b, prompt]);
		expect(order).toEqual(["a", "read", "b", "prompt"]);
	});

	test("waits for earlier asynchronous preflight but permits concurrent reads", async () => {
		const coordinator = new RpcCommandCoordinator();
		const preflight = gate();
		const order: string[] = [];
		const prompt = coordinator.run(async () => {
			await preflight.promise;
			order.push("accepted");
		});
		await coordinator.run(async () => {
			order.push("read");
		});
		const transition = coordinator.run(async () => {
			order.push("transition");
		}, true);
		expect(order).toEqual(["read"]);
		preflight.release();
		await Promise.all([prompt, transition]);
		expect(order).toEqual(["read", "accepted", "transition"]);
	});

	test("a failed transition releases dependent commands", async () => {
		const coordinator = new RpcCommandCoordinator();
		const failed = coordinator.run(async () => {
			throw new Error("failed");
		}, true);
		const next = coordinator.run(async () => "next");
		await expect(failed).rejects.toThrow("failed");
		await expect(next).resolves.toBe("next");
	});

	test("an extension transition excludes its caller, but rejects nested hooks", async () => {
		const coordinator = new RpcCommandCoordinator();
		await coordinator.run(async () => {
			await coordinator.runTransition(async () => {
				await expect(coordinator.runTransition(async () => {})).rejects.toMatchObject({ errorCode: "busy" });
			});
		});
		await expect(coordinator.runTransition(async () => "ok")).resolves.toBe("ok");
	});

	test("rejects a hook transition when a later RPC transition already waits for that hook", async () => {
		const coordinator = new RpcCommandCoordinator();
		const hook = gate();
		const prompt = coordinator.run(async () => {
			await hook.promise;
			await expect(coordinator.runTransition(async () => {})).rejects.toMatchObject({ errorCode: "busy" });
		});
		const transition = coordinator.run(async () => "switched", true);
		hook.release();
		await prompt;
		await expect(transition).resolves.toBe("switched");
	});

	test("completed command context does not become a permanent reentrancy exemption", async () => {
		const coordinator = new RpcCommandCoordinator();
		const later = gate();
		let background!: Promise<string>;
		await coordinator.run(async () => {
			background = later.promise.then(() => coordinator.runTransition(async () => "background"));
		});
		const transitionGate = gate();
		const transition = coordinator.run(async () => {
			await transitionGate.promise;
		}, true);
		later.release();
		await Promise.resolve();
		transitionGate.release();
		await transition;
		await expect(background).resolves.toBe("background");
	});
});
