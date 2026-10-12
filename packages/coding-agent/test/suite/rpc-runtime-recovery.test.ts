import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionRuntimeUnavailableError,
} from "../../src/core/agent-session-runtime.ts";
import { createHarness } from "./harness.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function setup() {
	const harness = await createHarness();
	cleanups.push(harness.cleanup);
	const services = await createAgentSessionServices({
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
		},
	});
	let fail = true;
	const factory = vi.fn<CreateAgentSessionRuntimeFactory>(async ({ sessionManager, sessionStartEvent }) => {
		if (fail) throw new Error("synthetic creation failure");
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: harness.getModel(),
		});
		cleanups.push(() => created.session.dispose());
		return { ...created, services, diagnostics: [] };
	});
	const runtime = new AgentSessionRuntime(harness.session, services, factory);
	return {
		runtime,
		harness,
		factory,
		allowCreation: () => {
			fail = false;
		},
	};
}

describe("explicit runtime recovery", () => {
	test("failed creation closes public access and explicit new recovers without replay", async () => {
		const { runtime, harness, factory, allowCreation } = await setup();
		const dispose = vi.spyOn(harness.session, "dispose");
		const rebind = vi.fn(async () => {});
		runtime.setRebindSession(rebind);
		await expect(runtime.newSession()).rejects.toThrow("synthetic creation failure");
		expect(runtime.isAvailable).toBe(false);
		expect(() => runtime.session).toThrow(SessionRuntimeUnavailableError);
		await runtime.dispose();
		await runtime.dispose();
		expect(dispose).toHaveBeenCalledOnce();
		expect(factory).toHaveBeenCalledOnce();
		allowCreation();
		await expect(runtime.newSession()).resolves.toEqual({ cancelled: false });
		expect(runtime.isAvailable).toBe(true);
		expect(runtime.session).not.toBe(harness.session);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(rebind).toHaveBeenCalledOnce();
		expect(harness.faux.state.callCount).toBe(0);
	});

	test("failed rebind closes access, and a later explicit replacement disposes the unbound candidate", async () => {
		const { runtime, allowCreation } = await setup();
		allowCreation();
		let candidate: AgentSession | undefined;
		runtime.setRebindSession(async (session) => {
			candidate = session;
			throw new Error("synthetic rebind failure");
		});
		await expect(runtime.newSession()).rejects.toThrow("synthetic rebind failure");
		expect(runtime.isAvailable).toBe(false);
		expect(() => runtime.session).toThrow(SessionRuntimeUnavailableError);
		const candidateDispose = vi.spyOn(candidate!, "dispose");
		runtime.setRebindSession(async () => {});
		await runtime.newSession();
		expect(candidateDispose).toHaveBeenCalledOnce();
		expect(runtime.isAvailable).toBe(true);
	});
});
