import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SettingsManager, type SettingsStorage } from "../src/core/settings-manager.ts";
import {
	IceSubagentHookDispatcher,
	narrowIceSubagentTools,
	parseIceHooksSettings,
	parseIceSettings,
	parseIceSubagentSettings,
	resolveIceSubagentContract,
	resolveIceSubagentHooks,
} from "../src/ice-subagent-settings.ts";
import {
	createSubagentLiveSessionControl,
	normalizeSubagentOutputSchema,
	normalizeSubagentRequest as normalizeSubagentRequestWithAgentDir,
	parseSubagentReportOutcome,
	type SubagentNormalizationOptions,
	type SubagentRequest,
} from "../src/ice-subagents.ts";

function normalizeSubagentRequest(
	request: SubagentRequest,
	cwd: string,
	options: SubagentNormalizationOptions = {},
): ReturnType<typeof normalizeSubagentRequestWithAgentDir> {
	const role = request.role.trim().toLowerCase();
	const selfRequest: SubagentRequest =
		role === "self"
			? request
			: {
					...request,
					role: "self",
					self: {
						instructions: "Inspect the approved scope and report evidence.",
						capabilities: ["read", "grep", "find", "ls"],
					},
				};
	return normalizeSubagentRequestWithAgentDir(selfRequest, cwd, { agentDir: join(cwd, ".ice-agent"), ...options });
}

describe("ICE subagent control settings", () => {
	it("rejects unknown settings keys and out-of-range budgets", () => {
		expect(() => parseIceSubagentSettings({ unknownKey: true })).toThrowError(/unknown/i);
		expect(() => parseIceSubagentSettings({ defaults: { maxTurns: 999999 } })).toThrowError(/maxTurns/i);
		expect(() => parseIceSubagentSettings({ defaults: { maxTotalTokens: 1_023 } })).toThrowError(/maxTotalTokens/i);
		expect(() => parseIceSubagentSettings({ restrictions: { maxTotalTokens: 1_000_001 } })).toThrowError(
			/maxTotalTokens/i,
		);
		expect(() => parseIceSubagentSettings({ restrictions: { denyTools: ["invalid tool identifier"] } })).toThrowError(
			/denyTools|unknown/i,
		);
		expect(() => parseIceSubagentSettings({ defaults: { temperature: Number.NaN } })).toThrowError(/temperature/i);
		expect(() => parseIceSubagentSettings({ defaults: { temperature: 2.1 } })).toThrowError(/temperature/i);
		expect(() => parseIceSubagentSettings({ defaults: { topP: -0.1 } })).toThrowError(/topP/i);
		expect(() => parseIceSubagentSettings({ defaults: { topP: 1.1 } })).toThrowError(/topP/i);
	});

	it("parses bounded preferences and role overrides", () => {
		const parsed = parseIceSubagentSettings({
			enabled: true,
			defaults: { thinking: "medium", timeoutMs: 60_000, maxTurns: 12, maxTotalTokens: 65_536 },
			allowedRoles: ["explore"],
			roleDefaults: { explore: { thinking: "low", maxTurns: 8 } },
			restrictions: { maxTurns: 16, maxTotalTokens: 32_768, denyRoles: ["bulk"] },
		});
		expect(parsed.defaults.thinking).toBe("medium");
		expect(parsed.roleDefaults.explore?.maxTurns).toBe(8);
		expect(parsed.restrictions.maxTurns).toBe(16);
		expect(parsed.restrictions.maxTotalTokens).toBe(32_768);
		expect(parsed.restrictions.denyRoles).toEqual(["bulk"]);
		const sampling = parseIceSubagentSettings({ defaults: { temperature: 0.4, topP: 0.8 } });
		expect(sampling.defaults).toMatchObject({ temperature: 0.4, topP: 0.8 });
	});

	it("resolves global/project/role/call layers with deny-first restrictions", () => {
		const contract = resolveIceSubagentContract({
			role: "explore",
			global: parseIceSubagentSettings({
				defaults: { maxTurns: 24, timeoutMs: 120_000 },
				restrictions: { maxTurns: 16, denyRoles: ["bulk"] },
			}),
			project: parseIceSubagentSettings({
				defaults: { maxTurns: 12 },
				roleDefaults: { explore: { maxTurns: 10 } },
			}),
			call: { maxTurns: 14 },
		});
		// Explicit call value wins within the deny-first ceiling of 16.
		expect(contract.maxTurns.value).toBe(14);
		expect(contract.maxTurns.source).toBe("call");
		expect(contract.values.maxTotalTokens).toBeUndefined();
		const capped = resolveIceSubagentContract({
			role: "explore",
			global: parseIceSubagentSettings({ restrictions: { maxTurns: 6, maxTotalTokens: 32_768 } }),
			call: { maxTurns: 14, maxTotalTokens: 65_536 },
		});
		expect(capped.maxTurns.value).toBe(6);
		expect(capped.maxTotalTokens.value).toBe(32_768);
		expect(capped.values.maxTotalTokens).toBe(32_768);
		expect(capped.restrictionsApplied).toContain("maxTotalTokens");
		expect(capped.diagnostics.join(" ")).toMatch(/clamped to enforced cap/);
		const deniedRole = resolveIceSubagentContract({
			role: "bulk",
			global: parseIceSubagentSettings({ restrictions: { denyRoles: ["bulk"] } }),
		});
		expect(deniedRole.denied?.code).toBe("role_denied");
		expect(deniedRole.denied?.message).toMatch(/denied by ice/i);
		const sampling = resolveIceSubagentContract({
			role: "explore",
			global: parseIceSubagentSettings({
				defaults: { temperature: 0.2, topP: 0.4 },
				roleDefaults: { explore: { temperature: 0.3 } },
			}),
			project: parseIceSubagentSettings({
				defaults: { temperature: 0.9, topP: 0.9 },
				roleDefaults: { explore: { temperature: 0.8, topP: 0.7 } },
			}),
			call: { temperature: 0.6 },
		});
		expect(sampling.temperature).toMatchObject({ value: 0.6, source: "call" });
		expect(sampling.topP).toMatchObject({ value: 0.4, source: "global" });
		expect(sampling.values).toMatchObject({ temperature: 0.6, topP: 0.4 });
	});

	it("keeps legacy project-first precedence only with an explicit opt-out", () => {
		const contract = resolveIceSubagentContract({
			role: "explore",
			globalFirst: false,
			global: parseIceSubagentSettings({ defaults: { maxTurns: 24 } }),
			project: parseIceSubagentSettings({ defaults: { maxTurns: 12 } }),
		});
		expect(contract.maxTurns.value).toBe(12);
		expect(contract.maxTurns.source).toBe("project");
	});

	it("resolves explicit global values first (ice default)", () => {
		const contract = resolveIceSubagentContract({
			role: "explore",
			global: parseIceSubagentSettings({
				defaults: { maxTurns: 24 },
				roleDefaults: { explore: { maxTurns: 20 } },
			}),
			project: parseIceSubagentSettings({
				defaults: { maxTurns: 12 },
				roleDefaults: { explore: { maxTurns: 10 } },
			}),
		});
		expect(contract.maxTurns.value).toBe(20);
		expect(contract.maxTurns.source).toBe("global-role");
		const fallback = resolveIceSubagentContract({
			role: "explore",
			global: parseIceSubagentSettings(undefined),
			project: parseIceSubagentSettings({ defaults: { maxTurns: 12 } }),
		});
		expect(fallback.maxTurns.value).toBe(12);
		expect(fallback.maxTurns.source).toBe("project");
	});

	it("keeps unknown-role calls untouched when no allowlist is configured", () => {
		const contract = resolveIceSubagentContract({ role: "explore" });
		expect(contract.maxTurns.value).toBeGreaterThan(0);
		expect(contract.diagnostics).toEqual([]);
	});

	it("treats an empty role allowlist as no additional restriction", () => {
		const contract = resolveIceSubagentContract({
			role: "explore",
			global: parseIceSubagentSettings({ allowedRoles: [] }),
		});
		expect(contract.denied).toBeUndefined();
		expect(contract.allowedRoles.value).toBeUndefined();
	});

	it("validates restricted local output schemas and payloads without remote refs", () => {
		const schema = normalizeSubagentOutputSchema({
			type: "object",
			properties: { severity: { type: "string" } },
			required: ["severity"],
			additionalProperties: false,
		});
		expect(schema).toBeDefined();
		expect(
			parseSubagentReportOutcome(
				JSON.stringify({ summary: "done", evidence: { paths: ["src/app.ts"] }, payload: { severity: "high" } }),
				16 * 1024,
				schema,
			).kind,
		).toBe("valid");
		expect(
			parseSubagentReportOutcome(
				JSON.stringify({ summary: "done", evidence: { paths: ["src/app.ts"] }, payload: { severity: 3 } }),
				16 * 1024,
				schema,
			).kind,
		).toBe("malformed");
		expect(() => normalizeSubagentOutputSchema({ $ref: "https://example.invalid/schema" })).toThrowError(
			/not supported|unsupported/i,
		);
	});

	it("narrows tool subsets without expanding authority", () => {
		const narrowed = narrowIceSubagentTools({
			requested: ["read", "bash"],
			profileRequested: ["read", "grep"],
			parentActiveTools: ["read", "grep", "bash"],
			unsafeHostExec: false,
		});
		expect(narrowed.effective).toEqual(["read"]);
		expect(narrowed.denied).toContain("bash");
		const denied = narrowIceSubagentTools({
			requested: ["read"],
			profileRequested: ["read"],
			parentActiveTools: ["read"],
			unsafeHostExec: false,
			denyTools: ["read"],
		});
		expect(denied.effective).toEqual([]);
	});

	it("reads and writes the ice namespace through SettingsManager", () => {
		const manager = SettingsManager.inMemory();
		expect(manager.getIceSettingsValue("global")).toBeUndefined();
		manager.setIceSettingsValue("global", {
			subagents: { defaults: { maxTurns: 9 } },
		} as never);
		expect(manager.getIceSettingsValue("global")?.subagents).toMatchObject({
			defaults: { maxTurns: 9 },
		});
		expect(parseIceSettings({ subagents: { defaults: { maxTurns: 9 } } }).subagents.defaults.maxTurns).toBe(9);
		expect(() => parseIceSettings({ subagents: { defaults: { maxTurns: -1 } } })).toThrowError(/maxTurns/i);
	});

	it("applies persisted defaults and restrictions to the normalized launch contract", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "ice-settings-contract-"));
		try {
			await mkdir(join(cwd, "src"));
			const settingsManager = SettingsManager.inMemory({
				ice: {
					subagents: {
						defaults: { maxTurns: 8, maxToolCalls: 7 },
						restrictions: { maxTurns: 5, denyTools: ["grep"] },
					},
				},
			});
			const normalized = normalizeSubagentRequest(
				{
					parentSessionId: "parent",
					role: "explore",
					task: "Inspect the source.",
					scope: { roots: ["src"] },
					execution: { maxTurns: 8, tools: ["read", "grep"] },
					cwd,
				},
				cwd,
				{ projectTrusted: true, settingsManager },
			);
			expect(normalized.execution.maxTurns).toBe(5);
			expect(normalized.execution.maxToolCalls).toBe(7);
			expect(normalized.execution.tools).toEqual(["read", "grep"]);
			expect(normalized.deniedTools).toEqual(["grep"]);
			expect(normalized.iceContract.sources.maxTurns).toBe("enforced");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("blocks launches when the settings file cannot be parsed instead of using permissive defaults", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "ice-settings-invalid-"));
		try {
			await mkdir(join(cwd, "src"));
			const storage: SettingsStorage = {
				withLock(scope, callback) {
					callback(scope === "global" ? "{" : undefined);
				},
			};
			const settingsManager = SettingsManager.fromStorage(storage);
			expect(settingsManager.getLoadErrors().map((entry) => entry.scope)).toContain("global");
			expect(() =>
				normalizeSubagentRequest(
					{
						parentSessionId: "parent",
						role: "explore",
						task: "Inspect the source.",
						scope: { roots: ["src"] },
						cwd,
					},
					cwd,
					{ projectTrusted: true, settingsManager },
				),
			).toThrowError(/settings.*invalid|blocked/i);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("revalidates future launches after settings reload and fails closed on reload errors", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "ice-settings-reload-"));
		try {
			await mkdir(join(cwd, "src"));
			let globalText = JSON.stringify({ ice: { subagents: { enabled: true } } });
			const storage: SettingsStorage = {
				withLock(scope, callback) {
					const next = callback(scope === "global" ? globalText : undefined);
					if (scope === "global" && next !== undefined) globalText = next;
				},
			};
			const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: true });
			const launch = () =>
				normalizeSubagentRequest(
					{
						parentSessionId: "parent",
						role: "explore",
						task: "Inspect the source.",
						scope: { roots: ["src"] },
						cwd,
					},
					cwd,
					{ projectTrusted: true, settingsManager },
				);
			expect(launch().iceContract.enabled).toBe(true);
			globalText = JSON.stringify({ ice: { subagents: { enabled: false } } });
			await settingsManager.reload();
			expect(() => launch()).toThrowError(/disabled/i);
			globalText = "{";
			await settingsManager.reload();
			expect(settingsManager.getLoadErrors().map((error) => error.scope)).toContain("global");
			expect(() => launch()).toThrowError(/settings.*invalid|blocked/i);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("blocks new launches when the namespaced subagent switch is disabled", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "ice-settings-disabled-"));
		try {
			await mkdir(join(cwd, "src"));
			const settingsManager = SettingsManager.inMemory({ ice: { subagents: { enabled: false } } });
			expect(() =>
				normalizeSubagentRequest(
					{
						parentSessionId: "parent",
						role: "explore",
						task: "Inspect the source.",
						scope: { roots: ["src"] },
						cwd,
					},
					cwd,
					{ projectTrusted: true, settingsManager },
				),
			).toThrowError(/disabled/i);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("ICE parent-owned subagent hooks", () => {
	it("rejects unbounded hook payloads and unknown hook keys", () => {
		expect(() =>
			parseIceHooksSettings({
				definitions: [{ id: "h", event: "subagent.beforeLaunch", kind: "in-process", timeoutMs: 999_999_999 }],
			}),
		).toThrowError(/timeoutMs/i);
		expect(() =>
			parseIceHooksSettings({
				definitions: [{ id: "h", event: "subagent.beforeLaunch", kind: "in-process", bogus: true }],
			}),
		).toThrowError(/unknown hook key/i);
	});

	it("resolves mandatory globals before optional and project hooks", () => {
		const resolved = resolveIceSubagentHooks({
			globalHooks: {
				ice: {
					hooks: {
						definitions: [
							{ id: "observe", event: "subagent.completed", kind: "in-process", required: false },
							{ id: "gate", event: "subagent.beforeLaunch", kind: "in-process", required: true },
						],
					},
				},
			},
			projectTrusted: false,
		});
		expect(resolved.map((hook) => hook.id)).toEqual(["gate", "observe"]);
	});

	it("applies role and call hook selectors without weakening required hooks", () => {
		const parsed = parseIceHooksSettings({
			definitions: [
				{ id: "required", event: "subagent.beforeLaunch", kind: "in-process", required: true },
				{ id: "role", event: "subagent.beforeLaunch", kind: "in-process", required: false },
				{ id: "call", event: "subagent.beforeLaunch", kind: "in-process", required: false },
				{ id: "other", event: "subagent.beforeLaunch", kind: "in-process", required: false },
			],
		});
		const selected = resolveIceSubagentHooks({
			hooks: parsed,
			roleHookIds: ["role"],
			callHookIds: ["call"],
			role: "explore",
		});
		expect(selected.map((hook) => hook.id)).toEqual(["required", "role", "call"]);
		const explicitlyEmpty = resolveIceSubagentHooks({ hooks: parsed, roleHookIds: [] });
		expect(explicitlyEmpty.map((hook) => hook.id)).toEqual(["required"]);
		expect(() => resolveIceSubagentHooks({ hooks: parsed, callHookIds: ["required"] })).toThrowError(/mandatory/i);
	});

	it("dispatches bounded before-launch context additions and rejects them elsewhere", async () => {
		const launchParsed = parseIceHooksSettings({
			definitions: [{ id: "context", event: "subagent.beforeLaunch", kind: "in-process" }],
		});
		const launchDispatcher = new IceSubagentHookDispatcher({
			handlers: { context: () => ({ outcome: "continue" as const, contextAdditions: [{ content: "hook note" }] }) },
		});
		const launchResult = await launchDispatcher.dispatch({
			hooks: resolveIceSubagentHooks({ hooks: launchParsed }),
			event: "subagent.beforeLaunch",
			runId: "run-context",
			ownerSessionId: "parent-context",
		});
		expect(launchResult.decision).toBe("continue");
		expect(launchResult.contextAdditions).toEqual([{ content: "hook note" }]);

		const toolParsed = parseIceHooksSettings({
			definitions: [{ id: "context", event: "subagent.beforeTool", kind: "in-process" }],
		});
		const toolDispatcher = new IceSubagentHookDispatcher({
			handlers: { context: () => ({ outcome: "continue" as const, contextAdditions: [{ content: "invalid" }] }) },
		});
		const toolResult = await toolDispatcher.dispatch({
			hooks: resolveIceSubagentHooks({ hooks: toolParsed }),
			event: "subagent.beforeTool",
			runId: "run-context",
			ownerSessionId: "parent-context",
		});
		expect(toolResult.decision).toBe("deny");
		expect(toolResult.contextAdditions).toEqual([]);
		expect(toolResult.diagnostics.join(" ")).toMatch(/only during subagent\.beforeLaunch/i);
	});

	it("dispatches continue/deny/ask with fail-closed approval", async () => {
		const parsed = parseIceHooksSettings({
			definitions: [
				{ id: "allow", event: "subagent.beforeLaunch", kind: "in-process" },
				{ id: "block", event: "subagent.beforeLaunch", kind: "in-process" },
				{ id: "confirm", event: "subagent.beforeLaunch", kind: "in-process" },
			],
		});
		const intents: string[] = [];
		const outcomes: string[] = [];
		const dispatcher = new IceSubagentHookDispatcher({
			onIntent: (record) => {
				intents.push(record.eventId);
			},
			onRecord: (record) => {
				outcomes.push(record.eventId);
			},
			handlers: {
				allow: () => ({ outcome: "continue" as const }),
				block: () => ({ outcome: "deny" as const, reason: "policy" }),
				confirm: () => ({ outcome: "ask" as const, reason: "check" }),
			},
			requestApproval: () => false,
		});
		const hooks = resolveIceSubagentHooks({
			globalHooks: { ice: { hooks: { definitions: parsed.definitions } } },
			projectTrusted: false,
		});
		const denied = await dispatcher.dispatch({
			event: "subagent.beforeLaunch",
			hooks,
			runId: "run-1",
			ownerSessionId: "parent-1",
		});
		expect(denied.decision).toBe("deny");
		expect(denied.records.map((record) => record.hookId)).toEqual(["allow", "block", "confirm"]);
		expect(denied.records[0]).toMatchObject({
			ownerSessionId: "parent-1",
			runId: "run-1",
			observational: false,
		});
		expect(outcomes.slice(0, intents.length)).toEqual(intents);
		expect(outcomes).toHaveLength(3);
		expect(new Set(intents).size).toBe(intents.length);
	});

	it("fails closed when approval is cancelled before a hook can complete", async () => {
		const parsed = parseIceHooksSettings({
			definitions: [
				{ id: "ask", event: "subagent.beforeLaunch", kind: "in-process", timeoutMs: 100, required: true },
			],
		});
		const controller = new AbortController();
		const dispatcher = new IceSubagentHookDispatcher({
			handlers: { ask: () => ({ outcome: "ask" as const, reason: "approval" }) },
			requestApproval: () => new Promise<boolean>(() => {}),
		});
		const hooks = resolveIceSubagentHooks({
			globalHooks: { ice: { hooks: { definitions: parsed.definitions } } },
			projectTrusted: false,
		});
		const pending = dispatcher.dispatch({
			event: "subagent.beforeLaunch",
			hooks,
			runId: "run-1",
			ownerSessionId: "parent-1",
			signal: controller.signal,
		});
		controller.abort();
		const result = await pending;
		expect(result.decision).toBe("deny");
		expect(result.diagnostics.join(" ")).toMatch(/failed closed|cancel/i);
	});

	it("rejects parent follow-up while user takeover owns the child", async () => {
		const steer = vi.fn(async () => {});
		const control = createSubagentLiveSessionControl({ isStreaming: true, steer } as never);
		control.setControlled(true);
		await expect(control.followUp?.("continue the bounded review")).rejects.toThrow(/takeover/i);
		expect(steer).not.toHaveBeenCalled();
	});

	it("blocks a required hook when intent persistence fails and never invokes the handler", async () => {
		const parsed = parseIceHooksSettings({
			definitions: [{ id: "gate", event: "subagent.beforeLaunch", kind: "in-process", required: true }],
		});
		const handler = vi.fn(() => ({ outcome: "continue" as const }));
		const dispatcher = new IceSubagentHookDispatcher({
			handlers: { gate: handler },
			onIntent: () => {
				throw new Error("intent journal unavailable");
			},
		});
		const hooks = resolveIceSubagentHooks({
			globalHooks: { ice: { hooks: { definitions: parsed.definitions } } },
			projectTrusted: false,
		});
		const result = await dispatcher.dispatch({
			event: "subagent.beforeLaunch",
			hooks,
			runId: "run-intent-required",
			ownerSessionId: "parent-intent",
		});
		expect(handler).not.toHaveBeenCalled();
		expect(result.decision).toBe("deny");
		expect(result.diagnostics.join(" ")).toMatch(/intent was not durably recorded; handler was not invoked/i);
		expect(result.records).toHaveLength(1);
		expect(result.records[0]).toMatchObject({ hookId: "gate", outcome: "deny" });
	});
	it("skips an optional hook when async intent persistence rejects, without invoking the handler", async () => {
		const parsed = parseIceHooksSettings({
			definitions: [{ id: "observe", event: "subagent.completed", kind: "in-process", required: false }],
		});
		const handler = vi.fn(() => ({ outcome: "continue" as const }));
		const dispatcher = new IceSubagentHookDispatcher({
			handlers: { observe: handler },
			onIntent: () => Promise.reject(new Error("intent journal unavailable")),
		});
		const hooks = resolveIceSubagentHooks({
			globalHooks: { ice: { hooks: { definitions: parsed.definitions } } },
			projectTrusted: false,
		});
		const result = await dispatcher.dispatch({
			event: "subagent.completed",
			hooks,
			runId: "run-intent-optional",
			ownerSessionId: "parent-intent",
		});
		expect(handler).not.toHaveBeenCalled();
		expect(result.decision).toBe("continue");
		expect(result.diagnostics.join(" ")).toMatch(/intent was not durably recorded; handler was not invoked/i);
		expect(result.records).toEqual([expect.objectContaining({ hookId: "observe", outcome: "continue" })]);
	});
	it("preserves intent-before-handler-before-outcome ordering", async () => {
		const parsed = parseIceHooksSettings({
			definitions: [{ id: "gate", event: "subagent.beforeLaunch", kind: "in-process", required: true }],
		});
		const order: string[] = [];
		const dispatcher = new IceSubagentHookDispatcher({
			handlers: {
				gate: () => {
					order.push("handler");
					return { outcome: "continue" as const };
				},
			},
			onIntent: () => {
				order.push("intent");
			},
			onRecord: (record) => {
				if (record.eventId && order[order.length - 1] === "handler") order.push("outcome");
			},
		});
		const hooks = resolveIceSubagentHooks({
			globalHooks: { ice: { hooks: { definitions: parsed.definitions } } },
			projectTrusted: false,
		});
		const result = await dispatcher.dispatch({
			event: "subagent.beforeLaunch",
			hooks,
			runId: "run-intent-order",
			ownerSessionId: "parent-intent",
		});
		expect(result.decision).toBe("continue");
		expect(order).toEqual(["intent", "handler", "outcome"]);
	});
	it("bounds stalled intent persistence and never dispatches after its deadline", async () => {
		const handler = vi.fn(() => ({ outcome: "continue" as const }));
		let release: (() => void) | undefined;
		const dispatcher = new IceSubagentHookDispatcher({
			handlers: { policy: handler },
			onIntent: () =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		});
		const hooks = resolveIceSubagentHooks({
			hooks: parseIceHooksSettings({
				definitions: [{ id: "policy", event: "subagent.beforeLaunch", required: true, timeoutMs: 10 }],
			}),
		});
		try {
			const result = await dispatcher.dispatch({
				hooks,
				event: "subagent.beforeLaunch",
				ownerSessionId: "parent",
				runId: "run",
			});
			expect(result.decision).toBe("deny");
			expect(handler).not.toHaveBeenCalled();
		} finally {
			release?.();
		}
	});

	it("does not invoke a handler when intent recording cancels its owner", async () => {
		const controller = new AbortController();
		const handler = vi.fn(() => ({ outcome: "continue" as const }));
		const dispatcher = new IceSubagentHookDispatcher({
			handlers: { policy: handler },
			onIntent: () => {
				controller.abort();
			},
		});
		const hooks = resolveIceSubagentHooks({
			hooks: parseIceHooksSettings({
				definitions: [{ id: "policy", event: "subagent.beforeLaunch", required: true }],
			}),
		});
		const result = await dispatcher.dispatch({
			hooks,
			event: "subagent.beforeLaunch",
			ownerSessionId: "parent",
			runId: "run",
			signal: controller.signal,
		});
		expect(result.decision).toBe("deny");
		expect(handler).not.toHaveBeenCalled();
	});

	it("fails closed when a required hook has no handler", async () => {
		const parsed = parseIceHooksSettings({
			definitions: [{ id: "missing", event: "subagent.beforeLaunch", kind: "in-process", required: true }],
		});
		const dispatcher = new IceSubagentHookDispatcher({});
		const hooks = resolveIceSubagentHooks({
			globalHooks: { ice: { hooks: { definitions: parsed.definitions } } },
			projectTrusted: false,
		});
		const result = await dispatcher.dispatch({
			event: "subagent.beforeLaunch",
			hooks,
			runId: "run-1",
			ownerSessionId: "parent-1",
		});
		expect(result.decision).toBe("deny");
		expect(result.diagnostics.join(" ")).toMatch(/required hook/i);
	});
});
