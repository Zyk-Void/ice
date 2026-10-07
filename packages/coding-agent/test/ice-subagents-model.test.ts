import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@zykairotis/ice-ai/compat";
import { registerFauxProvider } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import * as iceSubagentsModule from "../src/ice-subagents.ts";
import iceSubagents, {
	NativeSubagentRunner,
	NativeWriterRunner,
	normalizeSubagentExecutionOverride,
	resolveSubagentProfileResolution,
	resolveSubagentThinkingLevel,
	runResolvedReviewBatch,
	SUBAGENT_PROFILE_LIMITS,
} from "../src/ice-subagents.ts";
import {
	batchResult,
	createAsyncToolHarness,
	createWorkspace,
	normalizeSubagentRequest,
	request,
	resolvedReviewTask,
	tempDirs,
	testModel,
} from "./ice-subagents-harness.ts";

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ICE subagent contracts", () => {
	it("removes model overrides from every public child schema", async () => {
		const harness = await createAsyncToolHarness();
		const delegate = harness.tools.get("delegate")!;
		const delegateSchema = delegate.parameters as {
			additionalProperties?: boolean;
			properties?: Record<string, unknown>;
		};
		expect(delegateSchema.additionalProperties).toBe(false);
		expect(delegateSchema.properties).not.toHaveProperty("model");
		expect(delegate.description).toContain("deterministic call/primary/fallback/parent order");

		for (const toolName of ["delegate_batch", "review_batch"] as const) {
			const schema = harness.tools.get(toolName)!.parameters as {
				properties?: {
					tasks?: { items?: { additionalProperties?: boolean; properties?: Record<string, unknown> } };
				};
			};
			expect(schema.properties?.tasks?.items?.additionalProperties).toBe(false);
			expect(schema.properties?.tasks?.items?.properties).not.toHaveProperty("model");
			expect(schema.properties?.tasks?.items?.properties).toHaveProperty("resources");
		}
	});

	it("fails closed instead of selecting a fallback when the parent has no model", async () => {
		const harness = await createAsyncToolHarness();
		(harness.context as { model?: Model<Api> }).model = undefined;
		const runResolved = vi.spyOn(NativeSubagentRunner.prototype, "runResolved");
		try {
			const result = await harness.tools.get("delegate")!.execute(
				"missing-parent-model",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Inspect source.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			expect(result).toMatchObject({ isError: true });
			expect(result.content[0].text).toContain("requires a current parent model");
			expect(runResolved).not.toHaveBeenCalled();
		} finally {
			runResolved.mockRestore();
		}
	});

	it("passes the exact current parent model object to every child launch surface", async () => {
		const harness = await createAsyncToolHarness({ activeTools: ["delegate", "delegate_write", "read"] });
		const firstModel = harness.context.model as Model<Api>;
		const secondModel = { ...firstModel, id: "second" };
		harness.context.modelRegistry.getRuntime().registerProvider(firstModel.provider, {
			baseUrl: firstModel.baseUrl,
			api: firstModel.api,
			models: [firstModel, secondModel],
		});
		const observed: Array<Model<Api> | undefined> = [];
		const runResolved = vi
			.spyOn(NativeSubagentRunner.prototype, "runResolved")
			.mockImplementation(async (request, _tools, options) => {
				observed.push(options?.model);
				return {
					runId: request.runId,
					childSessionId: `child-${observed.length}`,
					parentSessionId: request.parentSessionId,
					profile: request.role,
					source: request.profile.source,
					status: "completed",
					summary: "ok",
					observedOutputBytes: 2,
					partial: false,
					diagnostics: [],
					evidence: { paths: ["src"] },
					...(request.agentKind === "self" ? { findings: [] } : {}),
				};
			});
		const runWriter = vi
			.spyOn(NativeWriterRunner.prototype, "run")
			.mockImplementation(async (_request, _tools, options) => {
				observed.push(options?.model);
				return {
					runId: "writer",
					parentSessionId: "owner-a",
					status: "completed",
					summary: "ok",
					baseCommit: "a".repeat(40),
					observedOutputBytes: 2,
					workspaceRemoved: true,
					diagnostics: [],
				};
			});
		try {
			await harness.tools.get("delegate")!.execute(
				"model-first",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Inspect source.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			(harness.context as { model?: Model<Api> }).model = secondModel;
			await harness.tools.get("delegate_async")!.execute(
				"model-async",
				{
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
					task: "Inspect source.",
					scope: { roots: ["src"] },
				},
				undefined,
				undefined,
				harness.context,
			);
			await harness.tools.get("delegate_batch")!.execute(
				"model-batch",
				{
					tasks: [
						{
							id: "one",
							role: "self",
							self: {
								instructions: "Inspect the approved scope and report evidence.",
								capabilities: ["read", "grep", "find", "ls"],
							},
							task: "Inspect source.",
							scope: { roots: ["src"] },
						},
					],
				},
				undefined,
				undefined,
				harness.context,
			);
			await harness.tools
				.get("review_batch")!
				.execute(
					"model-review",
					{ tasks: [{ id: "one", dimension: "correctness", task: "Review source.", scope: { roots: ["src"] } }] },
					undefined,
					undefined,
					harness.context,
				);
			await harness.tools
				.get("delegate_write")!
				.execute(
					"model-writer",
					{ task: "Edit source.", baseCommit: "a".repeat(40), scope: { roots: ["src"] } },
					undefined,
					undefined,
					harness.context,
				);
			await vi.waitFor(() => expect(observed).toHaveLength(5));
			expect(observed[0]).toBe(firstModel);
			for (const model of observed.slice(1)) expect(model).toBe(secondModel);
		} finally {
			runResolved.mockRestore();
			runWriter.mockRestore();
		}
	});

	it("captures async parent model identity at acceptance before queued promotion", async () => {
		const harness = await createAsyncToolHarness();
		const acceptedModel = harness.context.model as Model<Api>;
		const laterModel = { ...acceptedModel, id: "later" };
		harness.context.modelRegistry.getRuntime().registerProvider(acceptedModel.provider, {
			baseUrl: acceptedModel.baseUrl,
			api: acceptedModel.api,
			models: [acceptedModel, laterModel],
		});
		const observed: Array<Model<Api> | undefined> = [];
		const releases: Array<() => void> = [];
		const runResolved = vi
			.spyOn(NativeSubagentRunner.prototype, "runResolved")
			.mockImplementation(async (request, _tools, options) => {
				observed.push(options?.model);
				const result = {
					runId: request.runId,
					childSessionId: `async-${observed.length}`,
					parentSessionId: request.parentSessionId,
					profile: request.role,
					source: request.profile.source,
					status: "completed" as const,
					summary: "ok",
					observedOutputBytes: 2,
					partial: false,
					diagnostics: [],
					evidence: { paths: ["src"] },
				};
				if (observed.length > 2) return result;
				return await new Promise<typeof result>((resolve) => releases.push(() => resolve(result)));
			});
		try {
			const launch = (id: string) =>
				harness.tools.get("delegate_async")!.execute(
					id,
					{
						role: "self",
						self: {
							instructions: "Inspect the approved scope and report evidence.",
							capabilities: ["read", "grep", "find", "ls"],
						},
						task: `Inspect source ${id}.`,
						scope: { roots: ["src"] },
					},
					undefined,
					undefined,
					harness.context,
				);
			await launch("first");
			await launch("second");
			await vi.waitFor(() => expect(observed).toHaveLength(2));
			await launch("queued-before-switch");
			(harness.context as { model?: Model<Api> }).model = laterModel;
			releases[0]!();
			await vi.waitFor(() => expect(observed).toHaveLength(3));
			expect(observed[2]).toBe(acceptedModel);
			await launch("accepted-after-switch");
			await vi.waitFor(() => expect(observed).toHaveLength(4));
			expect(observed[3]).toBe(laterModel);
			releases[1]!();
		} finally {
			runResolved.mockRestore();
		}
	});

	it("bounds configurable thinking and startup timeout metadata with diagnostics", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-bounds-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "bounded.md"),
			`---\nname: bounded\ndescription: Bounded profile\ntools: read\nthinking: nonsense\nstartup-timeout-ms: ${SUBAGENT_PROFILE_LIMITS.maxTimeoutMs * 2}\n---\nInspect.\n`,
		);
		const bounded = resolveSubagentProfileResolution("bounded", { cwd, agentDir, projectTrusted: false });
		expect(bounded).toMatchObject({
			thinkingLevel: "low",
			timeoutMs: SUBAGENT_PROFILE_LIMITS.maxTimeoutMs,
		});
		expect(bounded.diagnostics).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/invalid thinking metadata/i),
				expect.stringContaining(`startup timeout metadata clamped to ${SUBAGENT_PROFILE_LIMITS.maxTimeoutMs}`),
			]),
		);

		await writeFile(
			join(agentDir, "agents", "fallback-bounds.md"),
			"---\nname: fallback-bounds\ndescription: Invalid numeric metadata\ntools: read\nstartup-timeout-ms: nope\n---\nInspect.\n",
		);
		const fallback = resolveSubagentProfileResolution("fallback-bounds", { cwd, agentDir, projectTrusted: false });
		expect(fallback).toMatchObject({ timeoutMs: 60_000 });
		expect(fallback).not.toHaveProperty("maxOutputBytes");
		expect(fallback.diagnostics?.join("\n")).toMatch(/invalid startup timeout metadata/i);
	});

	it("rejects explicit unsupported thinking before a child run is consumed", async () => {
		const cwd = await createWorkspace();
		const normalized = normalizeSubagentRequest({ ...request(cwd), execution: { thinking: "max" } }, cwd);
		expect(normalized.executionThinkingExplicit).toBe(true);
		expect(normalized.execution.thinking).toBe("max");
		const faux = registerFauxProvider();
		expect(() =>
			resolveSubagentThinkingLevel(normalized.execution.thinking, faux.getModel(), {
				explicit: normalized.executionThinkingExplicit,
			}),
		).toThrowError(/not supported by the selected parent model route/);
		expect(() =>
			normalizeSubagentExecutionOverride({ thinkingLevel: "low" }, { thinking: "flash" as never }),
		).toThrowError(/thinking must be a supported level/);
	});

	it("removes reviewer model policy APIs", () => {
		expect(iceSubagentsModule).not.toHaveProperty("resolveReviewerModelAssignments");
	});

	it("runs every reviewer sibling with the same parent model object", async () => {
		const cwd = await createWorkspace();
		const tasks = [resolvedReviewTask(cwd, "one", "correctness"), resolvedReviewTask(cwd, "two", "security")];
		const parent = testModel("provider", "parent");
		const assigned = tasks.map((task) => ({
			...task,
			model: parent,
			modelProvenance: { source: "parent" as const, resolved: "provider/parent" },
		}));
		const calls: string[] = [];
		const runner: Pick<NativeSubagentRunner, "runResolved"> = {
			runResolved: async (request, _tools, options) => {
				const task = assigned.find((candidate) => candidate.request === request)!;
				calls.push(`${task.id}:${options?.model?.id}`);
				return batchResult(task, task.id === "two" ? "failed" : "completed", task.id);
			},
		};
		const result = await runResolvedReviewBatch(assigned, ["delegate", "read"], runner, { concurrency: 2 });
		expect(calls.sort()).toEqual(["one:parent", "two:parent"]);
		expect(result.reviewers.map((reviewer) => reviewer.taskId)).toEqual(["one", "two"]);
		expect(result.reviewers.map((reviewer) => reviewer.modelProvenance.resolved)).toEqual([
			"provider/parent",
			"provider/parent",
		]);
		expect(result.preflight.tasks.map((task) => task.taskId)).toEqual(["one", "two"]);
		expect(result.preflight.tasks.map((task) => task.model.resolved)).toEqual(["provider/parent", "provider/parent"]);
		expect(result.preflight.tasks.map((task) => task.tools)).toEqual([["read"], ["read"]]);
		expect(result.preflight).not.toHaveProperty("budget");
		expect(result.preflight.recovery).toEqual({
			maxAttempts: 2,
			sameModel: true,
			retryableFailures: ["explicit_transient_startup"],
		});
		expect(result.status).toBe("partial");
		expect(result.usage.inputTokens).toBe(2);
	});

	it("registers review_batch with the selected parent model as its only reviewer model", async () => {
		const registerTool = vi.fn();
		iceSubagents({ on: vi.fn(), registerTool } as unknown as ExtensionAPI);
		const tool = registerTool.mock.calls.find((call) => call[0]?.name === "review_batch")?.[0];
		expect(tool).toMatchObject({ name: "review_batch" });
		expect(tool.parameters).toMatchObject({ properties: { tasks: { type: "array" } } });
		expect(tool.parameters.properties).not.toHaveProperty("modelPolicy");
		expect(tool.parameters.properties.tasks.items.properties).not.toHaveProperty("model");
		expect(tool.parameters.properties.tasks.items.properties.contextPacket).toMatchObject({ type: "object" });
		expect(JSON.stringify(tool.parameters)).not.toMatch(/vote|quorum|consensus|majority/i);
	});
});

describe("ICE file/self delegation plan coverage", () => {
	it("resolves file primary/fallback models and rejects duplicate or malformed references", async () => {
		const cwd = await createWorkspace();
		const agentDir = await mkdtemp(join(tmpdir(), "ice-subagents-model-fallback-agent-"));
		tempDirs.push(agentDir);
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "model-pair.md"),
			"---\nname: model-pair\ndescription: Model pair\ntools: read\nmodel: picked/primary\nfallbackModel: picked/fallback\n---\nInspect.\n",
		);
		const pair = resolveSubagentProfileResolution("model-pair", { cwd, agentDir });
		expect(pair).toMatchObject({ requestedModel: "picked/primary", fallbackModel: "picked/fallback" });
		const normalized = normalizeSubagentRequest(
			{
				parentSessionId: "parent-1",
				role: "model-pair",
				task: "Inspect.",
				scope: { roots: ["src"] },
				cwd,
			},
			cwd,
			{ agentDir },
		);
		expect(normalized.fallbackModel).toBe("picked/fallback");
		await writeFile(
			join(agentDir, "agents", "model-dup.md"),
			"---\nname: model-dup\ndescription: Duplicate\ntools: read\nmodel: picked/same\nfallbackModel: picked/same\n---\nInspect.\n",
		);
		expect(() => resolveSubagentProfileResolution("model-dup", { cwd, agentDir })).toThrowError(/duplicates/i);
		await writeFile(
			join(agentDir, "agents", "model-bad.md"),
			"---\nname: model-bad\ndescription: Bad\ntools: read\nmodel: not-a-reference\n---\nInspect.\n",
		);
		expect(() => resolveSubagentProfileResolution("model-bad", { cwd, agentDir })).toThrowError(/model reference/i);
	});
});
