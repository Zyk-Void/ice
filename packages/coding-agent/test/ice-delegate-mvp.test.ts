import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import iceSubagents from "../src/ice-subagents.ts";

const roots: string[] = [];
const registrations: Array<{ unregister: () => void }> = [];

type RegisteredTool = {
	name: string;
	execute: (...args: readonly unknown[]) => Promise<unknown>;
};

type ToolResult = {
	isError: boolean;
	content: Array<{ text: string }>;
	details?: Record<string, unknown>;
};

type HarnessOptions = {
	activeTools?: string[];
	flags?: Record<string, boolean | string | undefined>;
	iceMode?: "plan" | "build";
	trusted?: boolean;
	confirm?: boolean;
	deferred?: { pendingFetches?: number; pollAfterMs?: number };
};

async function createHarness(options: HarnessOptions = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "ice-delegate-mvp-"));
	roots.push(cwd);
	const agentDir = join(cwd, ".ice-agent");
	await mkdir(join(cwd, "src"));
	await mkdir(agentDir, { recursive: true });
	const faux = registerFauxProvider({ api: "faux-mvp", provider: "faux-mvp", deferred: options.deferred });
	registrations.push(faux);
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(cwd, "models.json") });
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown>();
	const parentEntries: unknown[] = [];
	const registerTool = vi.fn();
	const api = {
		registerFlag: vi.fn(),
		getFlag: (name: string) => options.flags?.[name],
		on: (event: string, handler: (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown) =>
			handlers.set(event, handler),
		registerTool,
		registerCommand: vi.fn(),
		appendEntry: (_type: string, data: unknown) => parentEntries.push(data),
		sendMessage: vi.fn(),
		getActiveTools: () => options.activeTools ?? ["delegate", "read", "grep", "find", "ls"],
	} as unknown as ExtensionAPI;
	const capabilityTools = [
		"read",
		"grep",
		"find",
		"ls",
		"delegate",
		"delegate_async",
		"inspect_subagent_job",
		"cancel_subagent_job",
		"delegate_batch",
		"review_batch",
		"delegate_write",
		"inspect_writer_patch",
		"reject_writer_patch",
		"integrate_writer_patch",
		"read_plan",
		"edit",
		"write",
	];
	iceSubagents(api, {
		agentDir,
		getIceMode: () => options.iceMode,
		getIceCapabilityState: () => ({
			mode: options.iceMode ?? "plan",
			tools:
				options.iceMode === "build" && options.trusted && options.flags?.["ice-allow-bash"]
					? [...capabilityTools, "bash"]
					: capabilityTools,
			bashEnabledInRecordedProcess:
				options.iceMode === "build" && options.trusted === true && options.flags?.["ice-allow-bash"] === true,
			allowExternal:
				options.iceMode === "build" && options.trusted === true && options.flags?.["allow-external"] === true,
		}),
	});
	const confirm = vi.fn(async () => options.confirm ?? false);
	const context = {
		cwd,
		getSystemPrompt: () => "MVP_PARENT_POLICY: inspect only the delegated scope and preserve verified evidence.",
		mode: "tui",
		settingsManager: SettingsManager.inMemory(),
		hasUI: true,
		ui: { confirm, custom: vi.fn(async () => undefined) },
		model,
		scopedModels: [],
		isProjectTrusted: () => options.trusted ?? false,
		modelRegistry: new ModelRegistry(modelRuntime),
		sessionManager: {
			getSessionId: () => "owner-a",
			getLeafId: () => "leaf-a",
			getEntries: () => parentEntries,
			buildSessionContext: () => ({ messages: [] }),
		},
	} as unknown as ExtensionContext;
	await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, context);
	const tools = new Map(
		registerTool.mock.calls.map((call) => {
			const tool = call[0] as unknown as RegisteredTool;
			return [tool.name, tool];
		}),
	);
	return { cwd, faux, context, confirm, parentEntries, tools };
}

function resultOf(value: unknown): ToolResult {
	return value as ToolResult;
}

function delegateParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		role: "self",
		task: "Inspect the source tree.",
		scope: { roots: ["src"] },
		...overrides,
	};
}

afterEach(async () => {
	for (const registration of registrations.splice(0)) registration.unregister();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ICE M10/M11 delegate integration", () => {
	it("keeps delegate and --sub-yolo ICE-only", { timeout: 25000 }, async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "ice-cli-help-"));
		roots.push(agentDir);
		const env = { ...process.env, ICE_CODING_AGENT_DIR: agentDir, ICE_OFFLINE: "1", ICE_SKIP_VERSION_CHECK: "1" };
		const stock = spawnSync(process.execPath, ["src/cli.ts", "--help"], {
			cwd: process.cwd(),
			env,
			encoding: "utf8",
			timeout: 10000,
		});
		const ice = spawnSync(process.execPath, ["src/ice.ts", "--no-extensions", "--help"], {
			cwd: process.cwd(),
			env,
			encoding: "utf8",
			timeout: 10000,
		});
		expect(stock.status).toBe(0);
		expect(`${stock.stdout}${stock.stderr}`).not.toContain("--sub-yolo");
		expect(ice.status).toBe(0);
		expect(`${ice.stdout}${ice.stderr}`).toContain("--sub-yolo");
	});

	it("completes a real delegate with fresh context, provenance, and verified evidence", async () => {
		const harness = await createHarness();
		let childContext = "";
		harness.faux.setResponses([
			(context) => {
				childContext = JSON.stringify(context);
				return fauxAssistantMessage('{"summary":"source inspected","evidence":{"paths":["src"]},"payload":{}}');
			},
		]);
		const result = resultOf(
			await harness.tools.get("delegate")!.execute(
				"delegate-happy",
				delegateParams({
					context: "selected parent note",
					contextPacket: { items: [{ id: "fact", kind: "verified_fact", content: "selected fact" }] },
					outputSchema: { type: "object", additionalProperties: false },
				}),
				undefined,
				undefined,
				harness.context,
			),
		);
		const details = result.details!;
		const child = details.result as Record<string, unknown>;
		const verification = details.verification as Record<string, unknown>;
		const launch = details.launch as Record<string, unknown>;
		expect(result.isError).toBe(false);
		expect(harness.faux.state.callCount).toBeGreaterThan(0);
		expect(child).toMatchObject({ parentSessionId: "owner-a", status: "completed", partial: false });
		expect(child.childSessionId).toEqual(expect.any(String));
		expect(child.runId).toEqual(expect.any(String));
		expect(verification).toMatchObject({ verified: true, unresolvedClaims: [] });
		expect((verification.paths as string[])[0]).toBe(join(harness.cwd, "src"));
		expect(launch).toMatchObject({ profile: { name: "self", source: "self" }, projectTrusted: false });
		expect(childContext).toContain("selected parent note");
		expect(childContext).toContain("selected fact");
		expect(harness.parentEntries).not.toContain("parent-secret-history");
	});

	it("fails malformed, unknown-role, and inactive-parent requests closed", async () => {
		const harness = await createHarness({ activeTools: ["read"] });
		const malformed = resultOf(
			await harness.tools
				.get("delegate")!
				.execute("malformed", delegateParams({ task: "" }), undefined, undefined, harness.context),
		);
		const unknownRole = resultOf(
			await harness.tools
				.get("delegate")!
				.execute("unknown-role", delegateParams({ role: "not-a-role" }), undefined, undefined, harness.context),
		);
		expect(malformed.isError).toBe(true);
		expect(unknownRole.content[0]!.text).toMatch(/unknown|role|profile/i);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("preserves review claims as unresolved evidence after the integrated call", async () => {
		const harness = await createHarness();
		harness.faux.setResponses([
			fauxAssistantMessage(
				'{"summary":"reviewed","evidence":{"paths":["src"]},"payload":{},"findings":[{"severity":"high","category":"security","claim":"The boundary needs review.","evidence":[{"path":"src"}]}]}',
			),
		]);
		const result = resultOf(
			await harness.tools.get("delegate")!.execute(
				"delegate-review",
				delegateParams({
					role: "self",
					self: { instructions: "Review the scoped evidence without modifying files." },
					outputSchema: { type: "object", additionalProperties: false },
				}),
				undefined,
				undefined,
				harness.context,
			),
		);
		const details = result.details!;
		const verification = details.verification as Record<string, unknown>;
		expect(result.isError).toBe(false);
		expect(verification).toMatchObject({ verified: true, unresolvedClaims: ["The boundary needs review."] });
		expect(result.content[0]!.text).toContain("Unresolved claims for parent synthesis");
	});

	it("cancels a started child without retry or parent mutation", async () => {
		const harness = await createHarness();
		let startedResolve!: () => void;
		let release!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
		const pending = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
			release = resolve;
		});
		harness.faux.setResponses([
			async () => {
				startedResolve();
				return pending;
			},
		]);
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		const controller = new AbortController();
		const call = harness.tools
			.get("delegate")!
			.execute("delegate-cancel", delegateParams(), controller.signal, undefined, harness.context);
		await started;
		controller.abort();
		release(fauxAssistantMessage('{"summary":"cancelled","evidence":{"paths":["src"]}}'));
		const result = resultOf(await call);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toMatch(/cancelled/i);
		expect(harness.parentEntries).toHaveLength(0);
	});

	it("pauses a started child for an explicit extension decision instead of launching recovery", async () => {
		vi.useFakeTimers();
		try {
			const harness = await createHarness();
			let startedResolve!: () => void;
			let release!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
			const pending = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
				release = resolve;
			});
			harness.faux.setResponses([
				async () => {
					startedResolve();
					return pending;
				},
			]);
			const started = new Promise<void>((resolve) => {
				startedResolve = resolve;
			});
			const resultPromise = harness.tools
				.get("delegate")!
				.execute("delegate-timeout", delegateParams({ timeoutMs: 10 }), undefined, undefined, harness.context);
			await started;
			await vi.advanceTimersByTimeAsync(10);
			release(fauxAssistantMessage('{"summary":"timed out","evidence":{"paths":["src"]}}'));
			const result = resultOf(await resultPromise);
			expect(result.isError).toBe(false);
			const child = result.details!.result as { status: string; runId: string };
			expect(child.status).toBe("needs_time");
			expect(result.content[0]!.text).toMatch(/needs_time|runtime attention|remaining extendable/i);
			const inspected = resultOf(
				await harness.tools
					.get("manage_subagent")!
					.execute(
						"inspect-timeout",
						{ runId: child.runId, action: "inspect" },
						undefined,
						undefined,
						harness.context,
					),
			);
			expect(inspected.isError).toBe(false);
			expect(inspected.content[0]!.text).toMatch(/Runtime attention|Remaining extendable/i);
			const stopped = resultOf(
				await harness.tools
					.get("manage_subagent")!
					.execute("stop-timeout", { runId: child.runId, action: "stop" }, undefined, undefined, harness.context),
			);
			expect(stopped.isError).toBe(false);
			expect(stopped.content[0]!.text).toMatch(/Stopped retained subagent|cancelled/i);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a durable async child retained at its requested timeout until the parent decides", async () => {
		vi.useFakeTimers();
		try {
			const harness = await createHarness();
			let startedResolve!: () => void;
			let release!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
			const pending = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
				release = resolve;
			});
			harness.faux.setResponses([
				async () => {
					startedResolve();
					return pending;
				},
			]);
			const started = new Promise<void>((resolve) => {
				startedResolve = resolve;
			});
			const accepted = resultOf(
				await harness.tools
					.get("delegate_async")!
					.execute(
						"delegate-async-timeout",
						delegateParams({ timeoutMs: 10 }),
						undefined,
						undefined,
						harness.context,
					),
			);
			const jobId = (accepted.details!.accepted as { jobId: string }).jobId;
			expect(accepted.isError).toBe(false);
			await started;
			await vi.advanceTimersByTimeAsync(10);
			release(fauxAssistantMessage('{"summary":"timed out","evidence":{"paths":["src"]}}'));
			for (let index = 0; index < 4; index++) await vi.advanceTimersByTimeAsync(0);
			const inspection = resultOf(
				await harness.tools
					.get("inspect_subagent_job")!
					.execute("inspect-async-timeout", { jobId }, undefined, undefined, harness.context),
			);
			const job = (inspection.details!.inspection as { job: { status: string; runId?: string } }).job;
			expect(job.status).toBe("needs_time");
			expect(job.runId).toEqual(expect.any(String));
			expect(inspection.content[0]!.text).toMatch(/same child run is retained|manage_subagent/i);
			const stopped = resultOf(
				await harness.tools
					.get("manage_subagent")!
					.execute(
						"stop-async-timeout",
						{ runId: job.runId, action: "stop" },
						undefined,
						undefined,
						harness.context,
					),
			);
			expect(stopped.isError).toBe(false);
			for (let index = 0; index < 4; index++) await vi.advanceTimersByTimeAsync(0);
			const settled = resultOf(
				await harness.tools
					.get("inspect_subagent_job")!
					.execute("inspect-async-stopped", { jobId }, undefined, undefined, harness.context),
			);
			expect((settled.details!.inspection as { job: { status: string } }).job.status).toBe("cancelled");
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps --sub-yolo explicit and build-only", async () => {
		const harness = await createHarness({
			activeTools: ["delegate", "read", "bash"],
			flags: { "sub-yolo": true, "ice-allow-bash": true },
			iceMode: "plan",
			trusted: true,
		});
		const normal = resultOf(
			await harness.tools
				.get("delegate")!
				.execute("normal-read-only", delegateParams(), undefined, undefined, harness.context),
		);
		const asyncResult = resultOf(
			await harness.tools
				.get("delegate_async")!
				.execute(
					"unsafe-async",
					{ role: "self", task: "Inspect source.", scope: { roots: ["src"] } },
					undefined,
					undefined,
					harness.context,
				),
		);
		expect(normal.isError).toBe(true);
		expect(normal.content[0]!.text).toContain("explicit --ice-mode build");
		expect(asyncResult.isError).toBe(true);
		expect(asyncResult.content[0]!.text).toContain("explicit --ice-mode build");
	});

	it("allows unsafe review and batch delegation without per-child confirmation", async () => {
		const harness = await createHarness({
			activeTools: ["delegate", "read", "bash"],
			flags: { "sub-yolo": true, "ice-allow-bash": true },
			iceMode: "build",
			trusted: true,
		});
		harness.faux.setResponses([
			fauxAssistantMessage('{"summary":"reviewed","evidence":{"paths":["src"]},"findings":[]}'),
			fauxAssistantMessage('{"summary":"traced","evidence":{"paths":["src"]}}'),
		]);
		const review = resultOf(
			await harness.tools.get("review_batch")!.execute(
				"unsafe-review",
				{
					tasks: [{ id: "review", dimension: "correctness", task: "Review source.", scope: { roots: ["src"] } }],
				},
				undefined,
				undefined,
				harness.context,
			),
		);
		const batch = resultOf(
			await harness.tools
				.get("delegate_batch")!
				.execute(
					"unsafe-batch",
					{ tasks: [{ id: "trace", role: "self", task: "Trace source.", scope: { roots: ["src"] } }] },
					undefined,
					undefined,
					harness.context,
				),
		);
		expect(review.isError).toBe(false);
		expect(batch.isError).toBe(false);
		expect(harness.confirm).not.toHaveBeenCalled();
	});
});
