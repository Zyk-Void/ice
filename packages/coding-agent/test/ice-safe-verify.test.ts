import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import iceSafeVerify, {
	createIceSafeVerify,
	type IceCapabilityState,
	parseIceMode,
	parseVerifierArgv,
	runVerifier,
	validateIceStartupArgs,
	validateMutationPath,
} from "../src/ice-safe-verify.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const roots: string[] = [];

function fixture(): { root: string; outside: string } {
	const base = mkdtempSync(join(tmpdir(), "ice-safe-verify-"));
	const root = join(base, "repo");
	const outside = join(base, "outside");
	mkdirSync(root);
	mkdirSync(outside);
	roots.push(base);
	return { root, outside };
}

afterEach(() => {
	process.exitCode = undefined;
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("ICE plan review UI", () => {
	it("renders the supplied plan content before approval choices", () => {
		initTheme("dark");
		const selector = new ExtensionSelectorComponent(
			"ICE plan",
			["approve", "refine", "cancel"],
			() => {},
			() => {},
			{ content: "# Add guard\n\n1. Add tests" },
		);

		expect(selector.render(100).join("\n")).toContain("Add tests");
	});
});

describe("ICE launcher isolation and startup parsing", () => {
	it("loads the bundled guard only through ice and keeps it under --no-extensions", () => {
		const configDir = mkdtempSync(join(tmpdir(), "ice-safe-verify-config-"));
		roots.push(configDir);
		const env = {
			...process.env,
			ICE_CODING_AGENT_DIR: configDir,
			ICE_OFFLINE: "1",
			ICE_SKIP_VERSION_CHECK: "1",
		};
		const stock = spawnSync(process.execPath, ["src/cli.ts", "--help"], {
			cwd: process.cwd(),
			env,
			encoding: "utf8",
		});
		const guarded = spawnSync(process.execPath, ["src/ice.ts", "--no-extensions", "--help"], {
			cwd: process.cwd(),
			env,
			encoding: "utf8",
		});
		expect(stock.status).toBe(0);
		expect(`${stock.stdout}${stock.stderr}`).not.toContain("--ice-mode");
		expect(guarded.status).toBe(0);
		expect(`${guarded.stdout}${guarded.stderr}`).toContain("--ice-mode");
		expect(`${guarded.stdout}${guarded.stderr}`).toContain("--ice-verify");
		expect(`${guarded.stdout}${guarded.stderr}`).toContain("--ice-plan-model");
		expect(`${guarded.stdout}${guarded.stderr}`).toContain("--ice-build-model");
		expect(`${guarded.stdout}${guarded.stderr}`).toContain("--allow-external");
	});

	it("accepts only exact plan and build modes", () => {
		expect(parseIceMode(undefined)).toBe("plan");
		expect(parseIceMode("plan")).toBe("plan");
		expect(parseIceMode("build")).toBe("build");
		expect(() => parseIceMode("read-only")).toThrow(/Invalid --ice-mode/);
		expect(() => validateIceStartupArgs(["--ice-mode"])).toThrow(/requires plan or build/);
		expect(() => validateIceStartupArgs(["--ice-mode", "plan", "--ice-mode", "build"])).toThrow(/duplicate/i);
		expect(() => validateIceStartupArgs(["--ice-mode=build", "--ice-mode=build"])).toThrow(/duplicate/i);
		expect(() => validateIceStartupArgs(["--ice-plan-model="])).toThrow(/requires a nonempty model/);
		expect(() => validateIceStartupArgs(["--allow-external=false"])).toThrow(/boolean true/);
		expect(() => validateIceStartupArgs(["--allow-external", "--allow-external"])).toThrow(/duplicate/i);
		expect(() => validateIceStartupArgs(["--allow-external", "--ice-mode", "plan"])).toThrow(/build/);
		expect(() => validateIceStartupArgs(["--allow-external", "--ice-mode", "build", "--no-approve"])).toThrow(
			/--no-approve/,
		);
	});

	it("rejects unsafe subagent host execution before headless startup", () => {
		const configDir = mkdtempSync(join(tmpdir(), "ice-sub-yolo-config-"));
		roots.push(configDir);
		const result = spawnSync(
			process.execPath,
			["src/ice.ts", "--ice-mode", "build", "--ice-allow-bash", "--sub-yolo", "--help"],
			{
				cwd: process.cwd(),
				env: { ...process.env, ICE_CODING_AGENT_DIR: configDir, ICE_OFFLINE: "1", ICE_SKIP_VERSION_CHECK: "1" },
				encoding: "utf8",
			},
		);
		expect(result.status).toBe(1);
		expect(`${result.stdout}${result.stderr}`).toContain("interactive TUI");
	});

	it("accepts bounded JSON argv and rejects shell strings or unsafe values", () => {
		expect(parseVerifierArgv('["node","--version"]')).toEqual(["node", "--version"]);
		expect(parseVerifierArgv(undefined)).toBeUndefined();
		for (const value of ["npm run check", "[]", '["node",1]', '[""]', '["node\\u0000"]']) {
			expect(() => parseVerifierArgv(value)).toThrow(/ice-verify/);
		}
		expect(() => parseVerifierArgv(JSON.stringify(Array.from({ length: 65 }, () => "x")))).toThrow(/at most 64/);
		expect(() => parseVerifierArgv(JSON.stringify(["x".repeat(4097)]))).toThrow(/up to 4096 bytes/);
	});
});

describe("ICE guarded mutation paths", () => {
	it("allows existing and prospective in-root targets", () => {
		const { root } = fixture();
		writeFileSync(join(root, "existing.txt"), "ok");
		expect(validateMutationPath(join(root, "existing.txt"), root, root)).toBeUndefined();
		expect(validateMutationPath("deep/missing/new.txt", root, root)).toBeUndefined();
		expect(validateMutationPath("src/my.git-parser.ts", root, root)).toBeUndefined();
		expect(validateMutationPath("docs/environment.md", root, root)).toBeUndefined();
	});

	it("blocks outside paths, sibling prefixes, protected segments, and credentials", () => {
		const { root, outside } = fixture();
		mkdirSync(`${root}-other`);
		expect(validateMutationPath("../outside/file.txt", root, root)).toMatch(/outside guarded root/);
		expect(validateMutationPath(join(outside, "file.txt"), root, root)).toMatch(/outside guarded root/);
		expect(validateMutationPath(join(`${root}-other`, "file.txt"), root, root)).toMatch(/outside guarded root/);
		expect(validateMutationPath(".git/config", root, root)).toMatch(/protected .git/);
		expect(validateMutationPath("nested/.git/config", root, root)).toMatch(/protected .git/);
		expect(validateMutationPath(".env", root, root)).toMatch(/environment file/);
		expect(validateMutationPath("config/.env.production", root, root)).toMatch(/environment file/);
		expect(validateMutationPath("config/credentials.json", root, root)).toMatch(/credential file/);
	});

	it("blocks existing and prospective symlink escapes", () => {
		const { root, outside } = fixture();
		const outsideFile = join(outside, "secret.txt");
		writeFileSync(outsideFile, "secret");
		symlinkSync(outside, join(root, "linked-dir"), "dir");
		symlinkSync(outsideFile, join(root, "linked-file"), "file");
		expect(validateMutationPath("linked-dir/new.txt", root, root)).toMatch(/outside guarded root/);
		expect(validateMutationPath("linked-file", root, root)).toMatch(/outside guarded root/);
	});

	it("allows unrestricted external mutation paths only with the explicit capability", () => {
		const { root, outside } = fixture();
		const externalFile = join(outside, "external.txt");
		writeFileSync(externalFile, "external");
		expect(validateMutationPath(externalFile, root, root)).toMatch(/outside guarded root/);
		expect(validateMutationPath(externalFile, root, root, true)).toBeUndefined();
		expect(validateMutationPath(join(outside, ".env"), root, root, true)).toBeUndefined();
		expect(validateMutationPath(join(outside, ".git", "config"), root, root, true)).toBeUndefined();
		expect(validateMutationPath(join(outside, "credentials.json"), root, root, true)).toBeUndefined();
	});
});

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown> | unknown;

function extensionFixture(
	options: {
		flags?: Record<string, boolean | string | undefined>;
		trusted?: boolean;
		entries?: Array<Record<string, unknown>>;
		verifyResult?: { stdout: string; stderr: string; code: number; killed: boolean };
		onModeChange?: (mode: "plan" | "build", ctx: ExtensionContext) => Promise<void>;
		onCapabilityChange?: (capabilities: IceCapabilityState, ctx: ExtensionContext) => Promise<void>;
		hasUI?: boolean;
		planChoice?: string;
		planChoices?: string[];
		confirm?: boolean;
		model?: { provider: string; id: string; name?: string };
		scopedModels?: Array<{ model: { provider: string; id: string; name?: string } }>;
		onSelect?: (title: string, options: string[], opts?: { content?: string }) => void;
		abort?: () => void;
		stopAfterTurn?: () => void;
		idle?: boolean;
		additionalToolNames?: string[];
		additionalTools?: Array<{ name: string; sourceInfo: { source: string; origin: string } }>;
	} = {},
) {
	const { root } = fixture();
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void> | void>();
	const activeTools: string[][] = [];
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const notifications: string[] = [];
	const sentMessages: string[] = [];
	const steeredMessages: string[] = [];
	const sentMessageOptions: unknown[] = [];
	const compactCalls: Array<{ customInstructions?: string }> = [];
	const selectedModels: Array<{ provider: string; id: string }> = [];
	const planChoices = [...(options.planChoices ?? [])];
	const entries = options.entries ?? [];
	const verifierExec = vi.fn(
		async (_command: string, _args: string[], _execOptions?: unknown) =>
			options.verifyResult ?? { stdout: "ok", stderr: "", code: 0, killed: false },
	);
	const api = {
		registerFlag: vi.fn(),
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.set(tool.name, tool);
		},
		registerCommand(
			name: string,
			command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
		) {
			commands.set(name, command.handler);
		},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		getFlag(name: string) {
			return options.flags?.[name];
		},
		getAllTools() {
			return [
				...[...tools.keys(), ...(options.additionalToolNames ?? [])].map((name) => ({ name })),
				...(options.additionalTools ?? []),
			];
		},
		sendMessage(message: { content: string }, sendOptions?: unknown) {
			steeredMessages.push(message.content);
			sentMessageOptions.push(sendOptions);
		},
		sendUserMessage(content: string) {
			sentMessages.push(content);
		},
		setActiveTools(tools: string[]) {
			activeTools.push([...tools]);
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
			entries.push({ type: "custom", customType, data });
		},
		setModel: async (model: { provider: string; id: string }) => {
			selectedModels.push(model);
			return true;
		},
		setThinkingLevel: vi.fn(),
		exec: async (command: string, args: string[], execOptions?: unknown) => {
			if (command !== "git") return verifierExec(command, args, execOptions);
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
				return { stdout: `${root}\n`, stderr: "", code: 0, killed: false };
			if (args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "", code: 0, killed: false };
			if (args[0] === "branch") return { stdout: "test\n", stderr: "", code: 0, killed: false };
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: root,
		mode: options.hasUI ? "tui" : "print",
		hasUI: options.hasUI ?? false,
		isProjectTrusted: () => options.trusted ?? true,
		isIdle: () => options.idle ?? false,
		abort: options.abort ?? vi.fn(),
		stopAfterTurn: options.stopAfterTurn ?? vi.fn(),
		signal: undefined,
		model: options.model,
		scopedModels: options.scopedModels ?? [],
		thinkingLevel: "high",
		modelRegistry: {
			getAvailable: () => (options.scopedModels ?? []).map((entry) => entry.model),
		},
		compact: (compactOptions?: {
			customInstructions?: string;
			onComplete?: (result: unknown) => void;
			onError?: (error: Error) => void;
		}) => {
			compactCalls.push({ customInstructions: compactOptions?.customInstructions });
			compactOptions?.onComplete?.({ summary: "compacted" });
		},
		sessionManager: { getBranch: () => entries },
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: vi.fn(),
			select: async (title: string, selectOptions: string[], opts?: { content?: string }) => {
				options.onSelect?.(title, selectOptions, opts);
				return planChoices.shift() ?? options.planChoice;
			},
			confirm: async () => options.confirm ?? true,
			input: async () => undefined,
		},
	} as unknown as ExtensionContext;
	(options.onModeChange || options.onCapabilityChange
		? createIceSafeVerify({ onModeChange: options.onModeChange, onCapabilityChange: options.onCapabilityChange })
		: iceSafeVerify)(api);
	return {
		activeTools,
		appended,
		tools,
		commands,
		ctx,
		notifications,
		compactCalls,
		selectedModels,
		sentMessages,
		steeredMessages,
		sentMessageOptions,
		verifierExec,
		async emit(event: string, value: Record<string, unknown> = {}) {
			const handler = handlers.get(event);
			if (!handler) throw new Error(`Missing handler: ${event}`);
			return await handler({ type: event, ...value }, ctx);
		},
	};
}

function legacyTools(names: string[] | undefined): string[] | undefined {
	return names?.filter((name) => !["agent", "agent_control", "agent_patch"].includes(name));
}

async function draftPlan(
	runtime: ReturnType<typeof extensionFixture>,
	title = "Add guard",
	markdown = "1. Add tests",
): Promise<void> {
	await runtime.tools.get("draft_plan")!.execute("draft-1", { title, markdown }, undefined, undefined, runtime.ctx);
}

async function successfulMutation(runtime: ReturnType<typeof extensionFixture>, id = "mutation-1") {
	expect(
		await runtime.emit("tool_call", { toolCallId: id, toolName: "write", input: { path: "file.txt", content: "x" } }),
	).toBeUndefined();
	await runtime.emit("tool_result", {
		toolCallId: id,
		toolName: "write",
		input: { path: "file.txt" },
		content: [],
		details: undefined,
		isError: false,
	});
}

async function writerIntegrationResult(
	runtime: ReturnType<typeof extensionFixture>,
	id: string,
	details: unknown,
	isError = false,
): Promise<void> {
	expect(
		await runtime.emit("tool_call", {
			toolCallId: id,
			toolName: "integrate_writer_patch",
			input: { artifact: {} },
		}),
	).toBeUndefined();
	await runtime.emit("tool_result", {
		toolCallId: id,
		toolName: "integrate_writer_patch",
		input: { artifact: {} },
		content: [],
		details,
		isError,
	});
}

describe("ICE guarded extension", () => {
	it("applies restored mode routing during session start", async () => {
		const onModeChange = vi.fn(async () => {});
		const runtime = extensionFixture({ flags: { "ice-mode": "plan" }, onModeChange });
		await runtime.emit("session_start");
		expect(onModeChange).toHaveBeenCalledWith("plan", runtime.ctx);
	});

	it("publishes an immutable authoritative capability snapshot", async () => {
		const snapshots: IceCapabilityState[] = [];
		const runtime = extensionFixture({
			flags: { "ice-mode": "build", "ice-allow-bash": true },
			onCapabilityChange: async (capabilities) => {
				snapshots.push(capabilities);
			},
		});
		await runtime.emit("session_start");
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toMatchObject({
			mode: "build",
			bashEnabledInRecordedProcess: true,
			allowExternal: false,
		});
		expect(snapshots[0]?.tools).toEqual(expect.arrayContaining(["bash", "edit", "write"]));
		expect(Object.isFrozen(snapshots[0])).toBe(true);
		expect(Object.isFrozen(snapshots[0]?.tools)).toBe(true);
	});

	it("enables installed package tools and Cognee search by source, not by name", async () => {
		const external = (name: string, source: string) => ({ name, sourceInfo: { source, origin: "package" } });
		const inline = (name: string) => ({ name, sourceInfo: { source: "inline", origin: "top-level" } });
		const runtime = extensionFixture({
			flags: { "ice-mode": "build", "allow-external": true },
			additionalTools: [
				external("cua-driver_list_windows", "npm:pi-mcp-adapter"),
				external("mcpScript", "npm:pi-mcp-adapter@2.37.0"),
				external("web_search", "npm:pi-web-access"),
				inline("cognee_search"),
				inline("unlisted_inline_tool"),
			],
			hasUI: true,
		});
		await runtime.emit("session_start");
		expect(runtime.activeTools.at(-1)).toEqual(
			expect.arrayContaining(["cua-driver_list_windows", "mcpScript", "web_search", "cognee_search"]),
		);
		expect(runtime.activeTools.at(-1)).not.toContain("unlisted_inline_tool");

		const withoutExternal = extensionFixture({
			flags: { "ice-mode": "build" },
			additionalTools: [external("web_search", "npm:pi-web-access")],
			hasUI: true,
		});
		await withoutExternal.emit("session_start");
		expect(withoutExternal.activeTools.at(-1)).not.toContain("web_search");
		expect(
			await runtime.emit("tool_call", { toolCallId: "direct", toolName: "cua-driver_list_windows", input: {} }),
		).toBeUndefined();
	});

	it("publishes external capability only for an approved trusted build", async () => {
		const snapshots: IceCapabilityState[] = [];
		const runtime = extensionFixture({
			flags: { "ice-mode": "build", "ice-allow-bash": true, "allow-external": true },
			additionalToolNames: ["mcp", "mcp__cua_driver"],
			hasUI: true,
			onCapabilityChange: async (capabilities) => {
				snapshots.push(capabilities);
			},
		});
		await runtime.emit("session_start");
		expect(snapshots.at(-1)).toMatchObject({ mode: "build", allowExternal: true });
		expect(snapshots.at(-1)?.tools).toEqual(expect.arrayContaining(["mcp", "mcp__cua_driver"]));
		expect(
			await runtime.emit("tool_call", { toolCallId: "mcp-allowed", toolName: "mcp", input: {} }),
		).toBeUndefined();
		expect(
			await runtime.emit("tool_call", { toolCallId: "cua-allowed", toolName: "mcp__cua_driver", input: {} }),
		).toBeUndefined();
		expect(
			await runtime.emit("tool_call", {
				toolCallId: "mcp-unregistered",
				toolName: "mcp__not_registered",
				input: {},
			}),
		).toMatchObject({ block: true });
		expect(runtime.notifications).toContain(
			"External filesystem access, configured MCP tools, and installed package tools are enabled for this process. This is unrestricted host access, not a sandbox.",
		);
	});

	it("keeps external capability disabled for untrusted processes", async () => {
		const snapshots: IceCapabilityState[] = [];
		const runtime = extensionFixture({
			flags: { "ice-mode": "build", "allow-external": true },
			additionalToolNames: ["mcp", "mcp__cua_driver"],
			trusted: false,
			hasUI: true,
			onCapabilityChange: async (capabilities) => {
				snapshots.push(capabilities);
			},
		});
		await runtime.emit("session_start");
		expect(snapshots.at(-1)).toMatchObject({ mode: "build", allowExternal: false });
		expect(snapshots.at(-1)?.tools).not.toContain("mcp");
		expect(snapshots.at(-1)?.tools).not.toContain("mcp__cua_driver");
		expect(
			await runtime.emit("tool_call", { toolCallId: "mcp-untrusted", toolName: "mcp__cua_driver", input: {} }),
		).toMatchObject({ block: true });
	});

	it("enables MCP for headless external-access requests; approvals fail closed in the adapter", async () => {
		const runtime = extensionFixture({
			flags: { "ice-mode": "build", "allow-external": true },
			additionalToolNames: ["mcp", "mcp__cua_driver"],
		});
		await runtime.emit("session_start");
		expect(runtime.activeTools.at(-1)).toEqual(expect.arrayContaining(["mcp", "mcp__cua_driver"]));
		expect(
			await runtime.emit("tool_call", { toolCallId: "mcp-headless", toolName: "mcp__cua_driver", input: {} }),
		).toBeUndefined();
	});

	it("injects OMP-style planning instructions while in plan mode", async () => {
		const runtime = extensionFixture();
		await runtime.emit("session_start");
		const result = await runtime.emit("before_agent_start", { prompt: "Plan a refactor" });
		expect(result).toMatchObject({
			message: { customType: "ice-plan-mode-context", display: false },
		});
		expect((result as { message: { content: string } }).message.content).toContain("You are in ICE plan mode");
		const content = (result as { message: { content: string } }).message.content;
		expect(content).toContain("MUST call draft_plan first");
		expect(content).toContain("MUST call propose_plan");
		expect(content).toContain("Critical files & anchors");
		expect(content).toContain("decision-complete execution spec");
	});

	it("injects approved-plan execution instructions in build mode", async () => {
		const runtime = extensionFixture({ hasUI: true, planChoice: "Approve and execute" });
		await runtime.emit("session_start");
		await draftPlan(runtime);
		await runtime.tools
			.get("propose_plan")!
			.execute("plan-1", { title: "Add guard" }, undefined, undefined, runtime.ctx);
		await runtime.emit("agent_settled");
		const result = await runtime.emit("before_agent_start", { prompt: "Continue" });
		expect(result).toMatchObject({
			message: { customType: "ice-approved-plan-context", display: false },
		});
		expect((result as { message: { content: string } }).message.content).toContain("MUST call read_plan");
		expect((result as { message: { content: string } }).message.content).toContain("authoritative");
	});

	it("applies the default plan tool set and independently denies unknown calls", async () => {
		const plan = extensionFixture({ additionalToolNames: ["mcp", "mcp__cua_driver"] });
		await plan.emit("session_start");
		expect(legacyTools(plan.activeTools.at(-1))).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"ask",
			"draft_plan",
			"propose_plan",
			"list_subagent_profiles",
			"delegate",
			"delegate_async",
			"manage_subagent",
			"inspect_subagent_job",
			"cancel_subagent_job",
			"delegate_batch",
			"review_batch",
			"inspect_subagent_batch",
			"cancel_subagent_batch",
			"goal_question",
			"goal_questionnaire",
			"propose_goal_draft",
			"propose_task_list",
			"create_goal",
			"get_goal",
			"set_goal_tasks",
			"update_goal_task",
			"update_goal",
		]);
		expect(await plan.emit("tool_call", { toolCallId: "1", toolName: "edit", input: { path: "x" } })).toMatchObject({
			block: true,
		});
		expect(await plan.emit("tool_call", { toolCallId: "1b", toolName: "read_plan", input: {} })).toMatchObject({
			block: true,
		});
		expect(await plan.emit("tool_call", { toolCallId: "2", toolName: "mcp__cua_driver", input: {} })).toMatchObject({
			block: true,
		});

		const build = extensionFixture({
			flags: { "ice-mode": "build", "ice-allow-bash": true },
			hasUI: true,
			additionalToolNames: ["mcp", "mcp__cua_driver"],
		});
		await build.emit("session_start");
		expect(legacyTools(build.activeTools.at(-1))).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"list_subagent_profiles",
			"delegate",
			"delegate_async",
			"manage_subagent",
			"inspect_subagent_job",
			"cancel_subagent_job",
			"delegate_batch",
			"review_batch",
			"inspect_subagent_batch",
			"cancel_subagent_batch",
			"goal_question",
			"goal_questionnaire",
			"propose_goal_draft",
			"propose_task_list",
			"create_goal",
			"get_goal",
			"set_goal_tasks",
			"update_goal_task",
			"update_goal",
			"delegate_write",
			"inspect_writer_patch",
			"reject_writer_patch",
			"integrate_writer_patch",
			"edit",
			"write",
			"bash",
		]);
		expect(
			await build.emit("tool_call", { toolCallId: "3", toolName: "bash", input: { command: "true" } }),
		).toBeUndefined();
		expect(
			await build.emit("tool_call", {
				toolCallId: "4",
				toolName: "goal_question",
				input: { question: "What next?" },
			}),
		).toBeUndefined();
		expect(
			await build.emit("tool_call", { toolCallId: "5", toolName: "propose_goal_draft", input: {} }),
		).toBeUndefined();
		expect(await build.emit("tool_call", { toolCallId: "6", toolName: "mcp__cua_driver", input: {} })).toMatchObject({
			block: true,
		});
		expect(build.notifications).toContain(
			"Bash is enabled for this process. Direct path guards do not contain shell commands.",
		);
	});

	it.each([false, true])("hides saved plan reading in build mode without a plan (Bash: %s)", async (allowBash) => {
		const runtime = extensionFixture({ flags: { "ice-mode": "build", "ice-allow-bash": allowBash } });
		await runtime.emit("session_start");
		expect(runtime.activeTools.at(-1)).not.toContain("read_plan");
	});

	it("exposes saved plan reading only after a draft exists", async () => {
		const runtime = extensionFixture();
		await runtime.emit("session_start");
		expect(runtime.activeTools.at(-1)).not.toContain("read_plan");

		await draftPlan(runtime, "Add guard", "# Add guard");
		expect(runtime.activeTools.at(-1)).toContain("read_plan");
		const draft = await runtime.tools.get("read_plan")!.execute("draft-read", {}, undefined, undefined, runtime.ctx);
		expect(draft).toMatchObject({
			content: [{ type: "text", text: "# Add guard" }],
			details: { status: "draft", title: "Add guard" },
		});

		await runtime.tools
			.get("propose_plan")!
			.execute("pending-plan", { title: "Add guard" }, undefined, undefined, runtime.ctx);
		expect(runtime.activeTools.at(-1)).toContain("read_plan");
		const pending = await runtime.tools
			.get("read_plan")!
			.execute("pending-read", {}, undefined, undefined, runtime.ctx);
		expect(pending).toMatchObject({
			content: [{ type: "text", text: "# Add guard" }],
			details: { status: "pending", title: "Add guard" },
		});
	});

	it("drafts a plan before proposing it for approval", async () => {
		const runtime = extensionFixture();
		await runtime.emit("session_start");
		const draft = runtime.tools.get("draft_plan");
		expect(draft).toBeDefined();
		await draft!.execute(
			"draft-1",
			{ title: "Add guard", markdown: "1. Add tests" },
			undefined,
			undefined,
			runtime.ctx,
		);
		const result = await runtime.tools
			.get("propose_plan")!
			.execute("proposal-1", { title: "Add guard" }, undefined, undefined, runtime.ctx);
		expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("pending") }] });
		expect(runtime.appended.at(-1)?.data).toMatchObject({ plan: { status: "pending", title: "Add guard" } });
	});

	it("stores plan proposals outside model context", async () => {
		const runtime = extensionFixture();
		await runtime.emit("session_start");
		await draftPlan(runtime, "Add guard", "1. Add tests\n2. Run checks");
		const result = await runtime.tools
			.get("propose_plan")!
			.execute("plan-1", { title: "Add guard" }, undefined, undefined, runtime.ctx);
		expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("pending") }] });
		expect(runtime.appended.at(-1)?.data).toMatchObject({
			plan: { status: "pending", title: "Add guard", markdown: "1. Add tests\n2. Run checks" },
		});
	});

	it("asks load-bearing planning questions interactively and fails closed headlessly", async () => {
		const interactive = extensionFixture({
			hasUI: true,
			planChoice: "Safe (Recommended) — Preserve deterministic enforcement",
		});
		await interactive.emit("session_start");
		const result = await interactive.tools.get("ask")!.execute(
			"ask-1",
			{
				questions: [
					{
						id: "policy",
						header: "Policy",
						question: "Which enforcement should remain?",
						options: [
							{ label: "Safe", description: "Preserve deterministic enforcement", recommended: true },
							{ label: "Ambient", description: "Retain ambient tools" },
						],
					},
				],
			},
			undefined,
			undefined,
			interactive.ctx,
		);
		expect(result).toMatchObject({
			content: [{ type: "text", text: "policy: Safe" }],
			details: { cancelled: false, answers: [{ id: "policy", answer: "Safe" }] },
		});

		const headless = extensionFixture();
		await headless.emit("session_start");
		expect(
			await headless.tools.get("ask")!.execute(
				"ask-2",
				{
					questions: [
						{
							id: "x",
							header: "X",
							question: "Choose",
							options: [
								{ label: "A", description: "A" },
								{ label: "B", description: "B" },
							],
						},
					],
				},
				undefined,
				undefined,
				headless.ctx,
			),
		).toMatchObject({ isError: true, details: { cancelled: true } });
	});

	it("does not auto-approve plans in headless mode", async () => {
		const runtime = extensionFixture();
		await runtime.emit("session_start");
		await draftPlan(runtime);
		await runtime.tools
			.get("propose_plan")!
			.execute("plan-1", { title: "Add guard" }, undefined, undefined, runtime.ctx);
		await runtime.emit("agent_settled");
		expect(runtime.appended.at(-1)?.data).toMatchObject({ mode: "plan", plan: { status: "pending" } });
	});

	it("approves a pending plan in interactive mode and gates first mutation on read_plan", async () => {
		const onModeChange = vi.fn(async () => {});
		const onSelect = vi.fn();
		const runtime = extensionFixture({
			hasUI: true,
			planChoice: "Approve and execute",
			onModeChange,
			onSelect,
		});
		await runtime.emit("session_start");
		await draftPlan(runtime, "Add guard", "# Add guard\n\n1. Add tests\n2. Run checks");
		const proposalResult = await runtime.tools
			.get("propose_plan")!
			.execute("plan-1", { title: "Add guard" }, undefined, undefined, runtime.ctx);
		expect(proposalResult).toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("Plan approved: Add guard") }],
			details: { status: "approved", title: "Add guard" },
		});
		expect(onSelect).toHaveBeenCalledWith(
			"Plan mode - next step",
			["Approve and execute", "Approve and compact context", "Approve and keep context", "Refine plan"],
			{ content: "# Add guard\n\n1. Add tests\n2. Run checks" },
		);
		expect(runtime.ctx.stopAfterTurn).toHaveBeenCalledOnce();
		expect(runtime.ctx.abort).not.toHaveBeenCalled();
		await runtime.emit("agent_settled");
		expect(onModeChange).toHaveBeenLastCalledWith("build", runtime.ctx);
		expect(runtime.steeredMessages).toHaveLength(1);
		expect(runtime.steeredMessages[0]).toContain("MUST call read_plan");
		expect(runtime.sentMessageOptions[0]).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(
			await runtime.emit("tool_call", { toolCallId: "write-1", toolName: "write", input: { path: "x" } }),
		).toMatchObject({
			block: true,
			reason: expect.stringContaining("read_plan"),
		});
		await runtime.tools.get("read_plan")!.execute("plan-read", {}, undefined, undefined, runtime.ctx);
		expect(
			await runtime.emit("tool_call", { toolCallId: "write-2", toolName: "write", input: { path: "x" } }),
		).toBeUndefined();
	});

	it("supports compact and keep-context approval handoffs", async () => {
		const compact = extensionFixture({ hasUI: true, planChoice: "Approve and compact context" });
		await compact.emit("session_start");
		await draftPlan(compact);
		await compact.tools
			.get("propose_plan")!
			.execute("compact-plan", { title: "Add guard" }, undefined, undefined, compact.ctx);
		await compact.emit("agent_settled");
		expect(compact.compactCalls).toHaveLength(1);
		expect(compact.compactCalls[0]?.customInstructions).toContain("approved ICE plan");
		expect(compact.steeredMessages.at(-1)).toContain("MUST call read_plan");
		expect(compact.appended.at(-1)?.data).toMatchObject({
			mode: "build",
			plan: { status: "approved", approvalMode: "compact" },
		});

		const keep = extensionFixture({ hasUI: true, planChoice: "Approve and keep context" });
		await keep.emit("session_start");
		await draftPlan(keep);
		await keep.tools
			.get("propose_plan")!
			.execute("keep-plan", { title: "Add guard" }, undefined, undefined, keep.ctx);
		await keep.emit("agent_settled");
		expect(keep.compactCalls).toHaveLength(0);
		expect(keep.appended.at(-1)?.data).toMatchObject({
			mode: "build",
			plan: { status: "approved", approvalMode: "keep" },
		});
		expect(
			await keep.emit("context", {
				messages: [{ role: "user", content: "planning history", timestamp: 1 }],
			}),
		).toBeUndefined();
	});

	it("gives fresh execution a durable context cutoff without orphaned tool results", async () => {
		const runtime = extensionFixture({ hasUI: true, planChoice: "Approve and execute" });
		await runtime.emit("session_start");
		await draftPlan(runtime);
		await runtime.tools
			.get("propose_plan")!
			.execute("fresh-plan", { title: "Add guard" }, undefined, undefined, runtime.ctx);
		await runtime.emit("agent_settled");
		const afterApproval = Date.now() + 10;
		const result = (await runtime.emit("context", {
			messages: [
				{ role: "user", content: "old planning history", timestamp: 1 },
				{
					role: "custom",
					customType: "ice-plan-execution-start",
					content: "execute approved plan",
					timestamp: afterApproval,
				},
				{
					role: "toolResult",
					toolCallId: "old-proposal",
					toolName: "propose_plan",
					content: [],
					isError: false,
					timestamp: afterApproval,
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "read-1", name: "read_plan", arguments: {} }],
					timestamp: afterApproval,
				},
				{
					role: "toolResult",
					toolCallId: "read-1",
					toolName: "read_plan",
					content: [],
					isError: false,
					timestamp: afterApproval,
				},
			],
		})) as { messages: Array<{ role: string; toolCallId?: string }> };
		expect(result.messages).toHaveLength(3);
		expect(result.messages.some((message) => message.toolCallId === "old-proposal")).toBe(false);
		expect(result.messages.some((message) => message.toolCallId === "read-1")).toBe(true);
	});

	it("closes refinement review without editing or changing the pending plan", async () => {
		const refinement = extensionFixture({
			hasUI: true,
			planChoice: "Refine plan",
		});
		await refinement.emit("session_start");
		await draftPlan(refinement);
		await refinement.tools
			.get("propose_plan")!
			.execute("plan-1", { title: "Add guard" }, undefined, undefined, refinement.ctx);
		expect(refinement.sentMessages).toHaveLength(0);
		expect(refinement.appended.at(-1)?.data).toMatchObject({
			mode: "plan",
			plan: { status: "pending", markdown: "1. Add tests" },
		});
		expect(refinement.notifications).toContain("ICE plan remains pending approval.");

		const cancelled = extensionFixture({ hasUI: true });
		await cancelled.emit("session_start");
		await draftPlan(cancelled);
		await cancelled.tools
			.get("propose_plan")!
			.execute("plan-1", { title: "Add guard" }, undefined, undefined, cancelled.ctx);
		expect(cancelled.appended.at(-1)?.data).toMatchObject({ plan: { status: "pending", readInBuild: false } });
	});

	it("reopens a dismissed review", async () => {
		const reopened = extensionFixture({
			hasUI: true,
			planChoices: ["", "Approve and keep context"],
			idle: true,
		});
		await reopened.emit("session_start");
		await draftPlan(reopened);
		await reopened.tools
			.get("propose_plan")!
			.execute("dismiss-plan", { title: "Add guard" }, undefined, undefined, reopened.ctx);
		expect(reopened.appended.at(-1)?.data).toMatchObject({ plan: { status: "pending" } });
		await reopened.commands.get("ice-plan-review")!("", reopened.ctx);
		expect(reopened.appended.at(-1)?.data).toMatchObject({
			mode: "build",
			plan: { status: "approved", approvalMode: "keep" },
		});
	});

	it("requires rereading approved plan after leaving and reentering build mode", async () => {
		const runtime = extensionFixture({ hasUI: true, planChoice: "Approve and execute" });
		await runtime.emit("session_start");
		await draftPlan(runtime);
		await runtime.tools
			.get("propose_plan")!
			.execute("plan-1", { title: "Add guard" }, undefined, undefined, runtime.ctx);
		await runtime.emit("agent_settled");
		await runtime.tools.get("read_plan")!.execute("plan-read", {}, undefined, undefined, runtime.ctx);
		await runtime.commands.get("plan")!("", runtime.ctx);
		await runtime.commands.get("build")!("", runtime.ctx);
		expect(
			await runtime.emit("tool_call", {
				toolCallId: "write-after-reentry",
				toolName: "write",
				input: { path: "x" },
			}),
		).toMatchObject({ block: true, reason: expect.stringContaining("read_plan") });
	});

	it("blocks writer integration until an approved plan is reread", async () => {
		const runtime = extensionFixture({ hasUI: true, planChoice: "Approve and execute" });
		await runtime.emit("session_start");
		await draftPlan(runtime);
		await runtime.tools
			.get("propose_plan")!
			.execute("plan-1", { title: "Add guard" }, undefined, undefined, runtime.ctx);
		await runtime.emit("agent_settled");
		expect(
			await runtime.emit("tool_call", {
				toolCallId: "integrate-before-read",
				toolName: "integrate_writer_patch",
				input: { artifact: {} },
			}),
		).toMatchObject({ block: true, reason: expect.stringContaining("read_plan") });
	});

	it("requires confirmation before manually bypassing an unfinished plan", async () => {
		const runtime = extensionFixture({ hasUI: true, confirm: false });
		await runtime.emit("session_start");
		await draftPlan(runtime);
		const toolsBefore = runtime.activeTools.at(-1);
		await runtime.commands.get("build")!("", runtime.ctx);
		expect(runtime.activeTools.at(-1)).toEqual(toolsBefore);
		expect(runtime.appended.at(-1)?.data).toMatchObject({ mode: "plan", plan: { status: "draft" } });
	});

	it("bounds prose-only plan convergence reminders at three continuations", async () => {
		const runtime = extensionFixture({ hasUI: true });
		await runtime.emit("session_start");
		for (let attempt = 0; attempt < 4; attempt++) {
			await runtime.emit("agent_start");
			await runtime.emit("turn_end", {
				message: { role: "assistant", content: [{ type: "text", text: "Still thinking" }] },
			});
			await runtime.emit("agent_settled");
		}
		expect(runtime.steeredMessages.filter((message) => message.includes("PLAN MODE DECISION REQUIRED"))).toHaveLength(
			3,
		);
		expect(runtime.appended.at(-1)?.data).toMatchObject({ plan: { decisionReminderCount: 3 } });
	});

	it("does not schedule plan continuations in print mode", async () => {
		const runtime = extensionFixture();
		await runtime.emit("session_start");
		await runtime.emit("agent_settled");
		expect(runtime.steeredMessages).toHaveLength(0);
	});

	it("switches to configured planning and user-selected execution models", async () => {
		const defaultModel = { provider: "local", id: "default" };
		const planModel = { provider: "local", id: "planner" };
		const buildModel = { provider: "local", id: "builder" };
		const runtime = extensionFixture({
			flags: { "ice-plan-model": "local/planner" },
			hasUI: true,
			model: defaultModel,
			scopedModels: [{ model: defaultModel }, { model: planModel }, { model: buildModel }],
			planChoices: ["Approve and keep context", "local/builder"],
		});
		await runtime.emit("session_start");
		expect(runtime.selectedModels[0]).toMatchObject(planModel);
		await draftPlan(runtime);
		await runtime.tools
			.get("propose_plan")!
			.execute("model-plan", { title: "Add guard" }, undefined, undefined, runtime.ctx);
		await runtime.emit("agent_settled");
		expect(runtime.selectedModels.at(-1)).toMatchObject(buildModel);
		expect(runtime.appended.at(-1)?.data).toMatchObject({
			plan: { prePlanModel: "local/default", executionModel: "local/builder" },
		});
	});

	it("migrates version 1 guarded state without losing mode or generations", async () => {
		const initial = extensionFixture({ flags: { "ice-mode": "build" } });
		await initial.emit("session_start");
		await successfulMutation(initial);
		const saved = structuredClone(initial.appended.at(-1)!);
		const oldState = saved.data as { version: number; plan?: unknown };
		oldState.version = 1;
		delete oldState.plan;
		const resumed = extensionFixture({
			entries: [{ type: "custom", customType: saved.customType, data: saved.data }],
		});
		(saved.data as { guardRoot: string; baseline: { root: string } }).guardRoot = resumed.ctx.cwd;
		(saved.data as { baseline: { root: string } }).baseline.root = resumed.ctx.cwd;
		await resumed.emit("session_start");
		expect(resumed.appended.at(-1)?.data).toMatchObject({
			version: 3,
			mode: "build",
			mutationGeneration: 1,
			plan: { status: "none", readInBuild: false },
		});
	});

	it("restores approved plan outside model context and requires reread after compaction", async () => {
		const initial = extensionFixture({ hasUI: true, planChoice: "Approve and execute" });
		await initial.emit("session_start");
		await draftPlan(initial);
		await initial.tools
			.get("propose_plan")!
			.execute("plan-1", { title: "Add guard" }, undefined, undefined, initial.ctx);
		await initial.emit("agent_settled");
		await initial.tools.get("read_plan")!.execute("plan-read", {}, undefined, undefined, initial.ctx);
		const saved = structuredClone(initial.appended.at(-1)!);
		const resumed = extensionFixture({
			entries: [{ type: "custom", customType: saved.customType, data: saved.data }],
		});
		(saved.data as { guardRoot: string; baseline: { root: string } }).guardRoot = resumed.ctx.cwd;
		(saved.data as { baseline: { root: string } }).baseline.root = resumed.ctx.cwd;
		await resumed.emit("session_start");
		expect(resumed.appended.at(-1)?.data).toMatchObject({ plan: { status: "approved", readInBuild: true } });
		await resumed.emit("session_compact");
		expect(resumed.appended.at(-1)?.data).toMatchObject({ plan: { status: "approved", readInBuild: false } });
	});

	it("reports default plan status in print mode", async () => {
		const runtime = extensionFixture();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await runtime.emit("session_start");
			await runtime.commands.get("ice-status")!("", runtime.ctx);
			expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("Mode: plan"));
			expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("Verifier status: not-configured"));
		} finally {
			consoleError.mockRestore();
		}
	});

	it("requires current-process Bash opt-in and project trust", async () => {
		const untrusted = extensionFixture({ flags: { "ice-mode": "build", "ice-allow-bash": true }, trusted: false });
		await untrusted.emit("session_start");
		expect(legacyTools(untrusted.activeTools.at(-1))).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"list_subagent_profiles",
			"delegate",
			"delegate_async",
			"manage_subagent",
			"inspect_subagent_job",
			"cancel_subagent_job",
			"delegate_batch",
			"review_batch",
			"inspect_subagent_batch",
			"cancel_subagent_batch",
			"goal_question",
			"goal_questionnaire",
			"propose_goal_draft",
			"propose_task_list",
			"create_goal",
			"get_goal",
			"set_goal_tasks",
			"update_goal_task",
			"update_goal",
			"delegate_write",
			"inspect_writer_patch",
			"reject_writer_patch",
			"integrate_writer_patch",
			"edit",
			"write",
		]);
		expect(
			await untrusted.emit("tool_call", { toolCallId: "1", toolName: "bash", input: { command: "true" } }),
		).toMatchObject({ block: true });
		expect(await untrusted.emit("user_bash", { command: "true", cwd: untrusted.ctx.cwd })).toMatchObject({
			result: { exitCode: 1 },
		});
	});

	it("counts only authorized successful mutations", async () => {
		const runtime = extensionFixture({ flags: { "ice-mode": "build" } });
		await runtime.emit("session_start");
		await runtime.emit("tool_result", {
			toolCallId: "missing",
			toolName: "write",
			input: {},
			content: [],
			isError: false,
		});
		await runtime.emit("tool_call", { toolCallId: "failed", toolName: "write", input: { path: "x" } });
		await runtime.emit("tool_result", {
			toolCallId: "failed",
			toolName: "write",
			input: {},
			content: [],
			isError: true,
		});
		await successfulMutation(runtime);
		expect(runtime.appended.at(-1)?.data).toMatchObject({ mutationGeneration: 1 });
	});

	it("gates V2 patch mutation on build and plan reread, then records successful verification", async () => {
		const plan = extensionFixture();
		await plan.emit("session_start");
		expect(plan.activeTools.at(-1)).toEqual(expect.arrayContaining(["agent", "agent_control"]));
		expect(
			await plan.emit("tool_call", {
				toolCallId: "plan-patch",
				toolName: "agent_patch",
				input: { action: "apply" },
			}),
		).toMatchObject({ block: true });
		const build = extensionFixture({ hasUI: true, planChoice: "Approve and execute" });
		await build.emit("session_start");
		await draftPlan(build);
		await build.tools.get("propose_plan")!.execute("plan", { title: "Add guard" }, undefined, undefined, build.ctx);
		await build.emit("agent_settled");
		expect(
			await build.emit("tool_call", {
				toolCallId: "unread-patch",
				toolName: "agent_patch",
				input: { action: "apply" },
			}),
		).toMatchObject({ block: true, reason: expect.stringContaining("read_plan") });
		await build.tools.get("read_plan")!.execute("read", {}, undefined, undefined, build.ctx);
		expect(
			await build.emit("tool_call", { toolCallId: "patch", toolName: "agent_patch", input: { action: "apply" } }),
		).toBeUndefined();
		await build.emit("tool_result", {
			toolCallId: "patch",
			toolName: "agent_patch",
			input: { action: "apply" },
			details: { status: "applied", verification: { status: "passed", commandHash: "patch-check" } },
			isError: false,
		});
		expect(build.appended.at(-1)?.data).toMatchObject({
			mutationGeneration: 1,
			checkedGeneration: 1,
			verifier: { status: "passed", commandHash: "patch-check" },
		});
	});

	it("leaves V2 rollback conflicts verification-pending", async () => {
		const runtime = extensionFixture({ flags: { "ice-mode": "build" } });
		await runtime.emit("session_start");
		await runtime.emit("tool_call", { toolCallId: "patch", toolName: "agent_patch", input: { action: "apply" } });
		await runtime.emit("tool_result", {
			toolCallId: "patch",
			toolName: "agent_patch",
			input: { action: "apply" },
			details: { status: "rollback_conflict" },
			isError: false,
		});
		expect(runtime.appended.at(-1)?.data).toMatchObject({
			mutationGeneration: 1,
			checkedGeneration: 0,
			verifier: { status: "pending" },
		});
	});

	it("tracks an unverified V2 patch apply like a parent edit, never as checked", async () => {
		const runtime = extensionFixture({ flags: { "ice-mode": "build" } });
		await runtime.emit("session_start");
		await runtime.emit("tool_call", { toolCallId: "patch", toolName: "agent_patch", input: { action: "apply" } });
		await runtime.emit("tool_result", {
			toolCallId: "patch",
			toolName: "agent_patch",
			input: { action: "apply" },
			details: { status: "applied", writtenPaths: ["a.txt"], unverified: true },
			isError: false,
		});
		expect(runtime.appended.at(-1)?.data).toMatchObject({ mutationGeneration: 1, checkedGeneration: 0 });
	});

	it("records verified writer integration as an already-checked generation", async () => {
		const command = JSON.stringify([process.execPath, "-e", "process.exit(0)"]);
		const runtime = extensionFixture({
			flags: { "ice-verify": command },
			hasUI: true,
			planChoice: "Approve and execute",
		});
		await runtime.emit("session_start");
		await draftPlan(runtime);
		await runtime.tools
			.get("propose_plan")!
			.execute("plan-1", { title: "Add guard" }, undefined, undefined, runtime.ctx);
		await runtime.emit("agent_settled");
		await runtime.tools.get("read_plan")!.execute("plan-read", {}, undefined, undefined, runtime.ctx);
		await writerIntegrationResult(runtime, "integrate-1", {
			status: "integrated",
			verification: { status: "passed", commandHash: "writer-verifier" },
		});
		expect(runtime.appended.at(-1)?.data).toMatchObject({
			mutationGeneration: 1,
			checkedGeneration: 1,
			verifier: { status: "passed", generation: 1, commandHash: "writer-verifier" },
		});
		await runtime.emit("agent_settled");
		expect(runtime.verifierExec).not.toHaveBeenCalled();
	});

	it.each(["verification_failed", "integration_conflict", "rollback_conflict"] as const)(
		"does not advance generation for writer integration status %s",
		async (status) => {
			const runtime = extensionFixture({ flags: { "ice-mode": "build" } });
			await runtime.emit("session_start");
			await writerIntegrationResult(runtime, `integrate-${status}`, { status }, true);
			expect(runtime.appended.at(-1)?.data).toMatchObject({ mutationGeneration: 0, checkedGeneration: 0 });
		},
	);

	it("verifies latest generation once from the canonical root", async () => {
		const command = JSON.stringify([
			process.execPath,
			"-e",
			`process.exit(process.cwd() === ${JSON.stringify(process.cwd())} ? 9 : 0)`,
		]);
		const runtime = extensionFixture({ flags: { "ice-mode": "build", "ice-verify": command } });
		await runtime.emit("session_start");
		await successfulMutation(runtime);
		await runtime.emit("agent_settled");
		const entriesAfterFirst = runtime.appended.length;
		await runtime.emit("agent_settled");
		expect(runtime.appended).toHaveLength(entriesAfterFirst);
		expect(runtime.appended.at(-1)?.data).toMatchObject({
			mutationGeneration: 1,
			checkedGeneration: 1,
			verifier: { status: "passed", generation: 1 },
		});
	});

	it("records untrusted verification once and fails headless execution", async () => {
		const runtime = extensionFixture({
			flags: { "ice-mode": "build", "ice-verify": '["node","check.js"]' },
			trusted: false,
		});
		await runtime.emit("session_start");
		await successfulMutation(runtime);
		await runtime.emit("agent_settled");
		expect(runtime.verifierExec).not.toHaveBeenCalled();
		expect(runtime.appended.at(-1)?.data).toMatchObject({
			checkedGeneration: 1,
			verifier: { status: "blocked-untrusted", generation: 1 },
		});
		expect(process.exitCode).toBe(1);
	});

	it("cancels and awaits an active verifier during session shutdown", async () => {
		const command = JSON.stringify([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
		const runtime = extensionFixture({ flags: { "ice-mode": "build", "ice-verify": command } });
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await runtime.emit("session_start");
			const verification = Promise.resolve(runtime.commands.get("ice-verify")!("", runtime.ctx));
			await vi.waitFor(() =>
				expect(runtime.appended.at(-1)?.data).toMatchObject({ verifier: { status: "running" } }),
			);
			await runtime.emit("session_shutdown", { reason: "quit" });
			await verification;
			expect(runtime.appended.at(-1)?.data).toMatchObject({ verifier: { status: "cancelled" } });
		} finally {
			consoleError.mockRestore();
		}
	});

	it("completes verification without touching a stale ctx after session replacement", async () => {
		let releaseVerifier: (() => void) | undefined;
		const verifierGate = new Promise<void>((resolve) => {
			releaseVerifier = resolve;
		});
		const command = JSON.stringify([process.execPath, "-e", "process.exit(0)"]);
		const runtime = extensionFixture({
			flags: { "ice-mode": "build", "ice-verify": command },
			hasUI: true,
			verifyResult: { stdout: "ok", stderr: "", code: 0, killed: false },
		});
		// Delay the verifier exec so we can stale the ctx while it is awaiting.
		runtime.verifierExec.mockImplementation(async () => {
			await verifierGate;
			return { stdout: "ok", stderr: "", code: 0, killed: false };
		});
		await runtime.emit("session_start");
		await successfulMutation(runtime);
		const settling = runtime.emit("agent_settled");
		await vi.waitFor(() => {
			const data = runtime.appended.at(-1)?.data as { verifier?: { status?: string } } | undefined;
			expect(data?.verifier?.status).toBe("running");
		});
		// Mimic the runner's guarded getters after session replacement: hasUI
		// reads true but any ui access throws, and mode reads throw as well.
		Object.defineProperties(runtime.ctx, {
			hasUI: { get: () => true },
			ui: {
				get: () => {
					throw new Error("This extension ctx is stale after session replacement or reload.");
				},
			},
			mode: {
				get: () => {
					throw new Error("This extension ctx is stale after session replacement or reload.");
				},
			},
		});
		releaseVerifier?.();
		// The verifier completes after the ctx went stale; the handler must not
		// throw from a guarded getter and must still persist the verified state.
		await expect(settling).resolves.not.toThrow();
		expect(runtime.appended.at(-1)?.data).toMatchObject({
			checkedGeneration: 1,
			verifier: { status: "passed", generation: 1 },
		});
	});

	it("converts an interrupted durable running state to cancelled on restore", async () => {
		const command = JSON.stringify([process.execPath, "-e", "process.exit(0)"]);
		const initial = extensionFixture({ flags: { "ice-mode": "build", "ice-verify": command } });
		await initial.emit("session_start");
		const saved = structuredClone(initial.appended.at(-1)!);
		(saved.data as { verifier: { status: string; generation?: number } }).verifier.status = "running";
		(saved.data as { verifier: { status: string; generation?: number } }).verifier.generation = 0;
		const resumed = extensionFixture({
			flags: { "ice-verify": command },
			entries: [{ type: "custom", customType: saved.customType, data: saved.data }],
		});
		const resumedRoot = resumed.ctx.cwd;
		(saved.data as { guardRoot: string; baseline: { root: string } }).guardRoot = resumedRoot;
		(saved.data as { baseline: { root: string } }).baseline.root = resumedRoot;
		await resumed.emit("session_start");
		expect(resumed.appended.at(-1)?.data).toMatchObject({
			verifier: { status: "cancelled", failureMessage: "Previous verifier was interrupted before completion" },
		});
	});

	it("restores valid same-root mode but never restores Bash authority", async () => {
		const initial = extensionFixture({ flags: { "ice-mode": "build" } });
		await initial.emit("session_start");
		const saved = initial.appended.at(-1)!;
		const resumed = extensionFixture({
			entries: [{ type: "custom", customType: saved.customType, data: saved.data }],
		});
		const resumedRoot = resumed.ctx.cwd;
		(saved.data as { guardRoot: string; baseline: { root: string } }).guardRoot = resumedRoot;
		(saved.data as { baseline: { root: string } }).baseline.root = resumedRoot;
		await resumed.emit("session_start");
		expect(legacyTools(resumed.activeTools.at(-1))).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"list_subagent_profiles",
			"delegate",
			"delegate_async",
			"manage_subagent",
			"inspect_subagent_job",
			"cancel_subagent_job",
			"delegate_batch",
			"review_batch",
			"inspect_subagent_batch",
			"cancel_subagent_batch",
			"goal_question",
			"goal_questionnaire",
			"propose_goal_draft",
			"propose_task_list",
			"create_goal",
			"get_goal",
			"set_goal_tasks",
			"update_goal_task",
			"update_goal",
			"delegate_write",
			"inspect_writer_patch",
			"reject_writer_patch",
			"integrate_writer_patch",
			"edit",
			"write",
		]);
		expect(resumed.appended.at(-1)?.data).toMatchObject({ mode: "build", bashEnabledInRecordedProcess: false });
	});
});

describe("ICE verifier process lifecycle and result mapping", () => {
	const linuxIt = process.platform === "linux" ? it : it.skip;

	linuxIt("kills the verifier process group, including a SIGTERM-resistant descendant", async () => {
		const { root } = fixture();
		const pidFile = join(root, "descendant.pid");
		let descendantPid: number | undefined;
		const isRunning = (pid: number) => {
			try {
				process.kill(pid, 0);
				const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
				return !stat.includes(") Z ");
			} catch {
				return false;
			}
		};
		try {
			const descendant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
			const parent = [
				"const { spawn } = require('node:child_process');",
				"const { writeFileSync } = require('node:fs');",
				`const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' });`,
				`writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
				"child.unref();",
			].join(" ");
			const result = await runVerifier([process.execPath, "-e", parent], root, {
				timeoutMs: 100,
				terminationGraceMs: 50,
			});
			descendantPid = Number(readFileSync(pidFile, "utf8"));
			expect(result.status).toBe("timed-out");
			await vi.waitFor(() => expect(isRunning(descendantPid!)).toBe(false), { timeout: 2000, interval: 25 });
		} finally {
			if (descendantPid && isRunning(descendantPid)) process.kill(descendantPid, "SIGKILL");
		}
	});

	it("maps pass, failure, timeout, cancellation, spawn errors, and bounded output", async () => {
		const { root } = fixture();
		const passed = await runVerifier(["node"], root, {
			exec: async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
		});
		const failed = await runVerifier(["node"], root, {
			exec: async () => ({ stdout: "", stderr: "bad", code: 7, killed: false }),
		});
		const bounded = await runVerifier(["node"], root, {
			outputLimitBytes: 8,
			exec: async () => ({ stdout: "123456", stderr: "abcdef", code: 0, killed: false }),
		});
		const spawnError = await runVerifier(["missing"], root, {
			exec: async () => {
				throw new Error("ENOENT");
			},
		});
		const timeout = await runVerifier(["node"], root, {
			timeoutMs: 1,
			exec: async (_command, _args, options) =>
				await new Promise((resolve) =>
					options?.signal?.addEventListener(
						"abort",
						() => resolve({ stdout: "", stderr: "", code: 1, killed: true }),
						{ once: true },
					),
				),
		});
		const controller = new AbortController();
		controller.abort();
		const cancelled = await runVerifier(["node"], root, {
			signal: controller.signal,
			exec: async () => ({ stdout: "", stderr: "", code: 1, killed: true }),
		});
		expect(passed.status).toBe("passed");
		expect(failed).toMatchObject({ status: "failed", exitCode: 7 });
		expect(Buffer.byteLength((bounded.stdout ?? "") + (bounded.stderr ?? ""))).toBe(8);
		expect(bounded.truncated).toBe(true);
		expect(spawnError).toMatchObject({ status: "spawn-error", failureMessage: "ENOENT" });
		expect(timeout.status).toBe("timed-out");
		expect(cancelled.status).toBe("cancelled");
	});
});
