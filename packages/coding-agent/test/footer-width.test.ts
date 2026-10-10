import { visibleWidth } from "@zykairotis/ice-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import type { IceSubagentOverview } from "../src/ice-agent-view-bridge.ts";
import { createDefaultAppearance } from "../src/modes/interactive/appearance/appearance-defaults.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { setSymbolPreset } from "../src/modes/interactive/theme/symbols.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	subagentUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	cwd?: string;
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];
	if (options.subagentUsage)
		entries.push({ type: "custom", customType: "subagent_usage", data: { usage: options.subagentUsage } });

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => options.cwd ?? "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRuntime: {
			isUsingOAuth: () => false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("compact footer git counts", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setSymbolPreset("unicode");
	});

	it("shows ahead, behind, and dirty counts after the branch and omits zero counts", () => {
		const footer = new FooterComponent(createSession({ sessionName: "" }), {
			...createFooterData(1),
			getGitStatus: () => ({ ahead: 2, behind: 0, dirty: 5 }),
		});
		footer.setStyle("compact");
		const line = stripAnsi(footer.render(160)[0]!);
		expect(line).toMatch(/main\s+↑2 ±5/);
		expect(line).not.toContain("↓");
	});

	it("shortens the cwd before the branch and keeps the counts with the branch", () => {
		const footer = new FooterComponent(
			createSession({ sessionName: "", cwd: "/home/user/projects/a/very/long/workspace/path/for/testing" }),
			{
				...createFooterData(1),
				getGitBranch: () => "integration/all-worktrees-experimental",
				getGitStatus: () => ({ ahead: 3, behind: 0, dirty: 7 }),
			},
		);
		footer.setStyle("compact");
		const line = stripAnsi(footer.render(110)[0]!);
		expect(line).toContain("integration/all-worktrees-experimental ↑3 ±7");
		expect(line).toContain("…");
	});

	it("keeps the cwd and git counts with the normal runtime badges at 120 columns", () => {
		const data = {
			...createFooterData(1),
			getExtensionStatuses: () => new Map([["ice-mode", "plan"]]),
			getGitBranch: () => "integration/all-worktrees-experimental",
			getGitStatus: () => ({ ahead: 93, behind: 0, dirty: 10 }),
		};
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				cwd: "/home/user/projects/a/very/long/workspace/path/for/testing",
				modelId: "cx/gpt-6.1-sol",
				reasoning: true,
				thinkingLevel: "max",
			}),
			data,
		);
		footer.setStyle("compact");
		footer.setSubagentSource(() => ({
			enabled: true,
			capacity: { running: 0, queued: 0, max: 8 },
			maxDepth: 0,
			children: [],
			approvals: [],
			diagnostics: [],
		}));
		footer.setNoticeSource(
			() => ({ warning: 1, error: 0, update: 1 }),
			() => "f2",
		);
		const lines = footer.render(120);
		expect(lines).toHaveLength(1);
		const line = stripAnsi(lines[0]!);
		expect(line).toContain("/testing");
		expect(line).toContain("↑93 ±10");
		expect(line).toContain("agents 0/8");
		expect(line).toContain("⚠ 1 ↑ f2");
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(120);
	});

	it("keeps the footer within narrow widths", () => {
		const footer = new FooterComponent(createSession({ sessionName: "" }), {
			...createFooterData(1),
			getGitStatus: () => ({ ahead: 1, behind: 1, dirty: 1 }),
		});
		footer.setStyle("compact");
		for (const width of [40, 60, 80]) {
			for (const line of footer.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("includes summary and tool result usage in the total cost", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("$1.250");
	});

	it.each(["legacy", "customized"])("includes child cost without changing context in the %s footer", (style) => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
				subagentUsage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.25 },
			}),
			createFooterData(1),
		);
		if (style === "customized") {
			const appearance = createDefaultAppearance().footer;
			appearance.separator = " | ";
			footer.setAppearance(appearance);
		}
		const wide = stripAnsi(footer.render(160)[1]!);
		expect(wide).toContain("↑300");
		expect(wide).toContain("↓30");
		expect(wide).toContain("$0.750 (+$0.250 subagents)");
		expect(wide).toContain("12.3%/200k");
		const narrow = stripAnsi(footer.render(60)[1]!);
		expect(narrow).toContain("$0.750");
		expect(narrow).not.toContain("subagents");
		for (const width of [20, 40, 60, 160]) {
			for (const line of footer.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it.each(["legacy", "customized"])("places child cost before the subscription marker in the %s footer", (style) => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				provider: "kimi-coding",
				usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
				subagentUsage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.25 },
			}),
			createFooterData(1),
		);
		if (style === "customized") footer.setAppearance(createDefaultAppearance().footer);
		expect(stripAnsi(footer.render(160)[1]!)).toContain("$0.750 (+$0.250 subagents) (sub)");
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("CH25.0%");
	});

	it("marks Kimi Coding costs as subscription estimates", () => {
		const session = createSession({
			sessionName: "",
			provider: "kimi-coding",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[1])).toContain("$1.234 (sub)");
	});

	it("right-aligns the notices badge on the first row within width", () => {
		setSymbolPreset("unicode");
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));
		footer.setNoticeSource(
			() => ({ warning: 2, error: 0, update: 1 }),
			() => "f2",
		);

		for (const width of [40, 93]) {
			const lines = footer.render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(stripAnsi(lines[0]!).endsWith("⚠ 2 ↑ f2")).toBe(true);
		}
	});

	it("keeps color-only customization compact and preserves safety colors", () => {
		const session = createSession({ sessionName: "" });
		const data = createFooterData(1);
		data.getExtensionStatuses = () => new Map([["ice-mode", "build"]]);
		const footer = new FooterComponent(session, data);
		footer.setStyle("compact");
		footer.setCapabilitySource(() => ["bash"]);
		const appearance = createDefaultAppearance().footer;
		appearance.primary.foreground = { kind: "custom", value: "#ff6b70" };
		appearance.secondary.foreground = { kind: "custom", value: "#ffad66" };
		footer.setAppearance(appearance);
		const lines = footer.render(160);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0]!)).toContain("build");
		expect(stripAnsi(lines[0]!)).toContain("bash");
		expect(lines[0]).toContain("\x1b[38;2;255;173;102m");
		for (const width of [40, 80, 160]) {
			for (const line of footer.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps custom footer field layouts available", () => {
		const footer = new FooterComponent(createSession({ sessionName: "" }), createFooterData(1));
		footer.setStyle("compact");
		const appearance = createDefaultAppearance().footer;
		appearance.separator = " | ";
		footer.setAppearance(appearance);
		expect(footer.render(160)).toHaveLength(2);
	});

	it("shows subagent capacity, queue, approvals, and a disabled state", () => {
		const footer = new FooterComponent(createSession({ sessionName: "" }), createFooterData(1));
		footer.setStyle("compact");
		const overview = {
			enabled: true,
			capacity: { running: 2, queued: 1, max: 4 },
			maxDepth: 0,
			children: [],
			approvals: [] as IceSubagentOverview["approvals"],
			diagnostics: [],
		};
		footer.setSubagentSource(() => overview);
		expect(stripAnsi(footer.render(160)[0]!)).toContain("agents 2/4 · 1 queued");
		overview.approvals = [
			{
				id: "r1",
				childId: "ag_a",
				agent: "worker",
				tool: "bash",
				summary: "bash: npm test",
				foreground: false,
				queuedAt: 0,
				deadline: 1,
			},
		];
		// Pending approvals stay visible on a narrow terminal.
		expect(stripAnsi(footer.render(60)[0]!)).toContain("1 approval");
		footer.setSubagentSource(() => ({ ...overview, enabled: false, approvals: [] }));
		expect(stripAnsi(footer.render(160)[0]!)).toContain("agents off");
		for (const width of [40, 80, 160]) {
			for (const line of footer.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows subagent capacity on the first row of the legacy footer, beside the notices badge", () => {
		const footer = new FooterComponent(createSession({ sessionName: "" }), createFooterData(1));
		footer.setStyle("legacy");
		footer.setSubagentSource(() => ({
			enabled: true,
			capacity: { running: 1, queued: 0, max: 4 },
			maxDepth: 0,
			children: [],
			approvals: [],
			diagnostics: [],
		}));
		expect(stripAnsi(footer.render(120)[0]!).trimEnd().endsWith("agents 1/4")).toBe(true);
		footer.setNoticeSource(
			() => ({ warning: 1, error: 0, update: 0 }),
			() => "f2",
		);
		expect(stripAnsi(footer.render(120)[0]!)).toMatch(/agents 1\/4 · ⚠ 1 f2\s*$/);
		for (const line of footer.render(50)) expect(visibleWidth(line)).toBeLessThanOrEqual(50);
	});

	it("omits the badge when there are no notices", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1));
		const before = footer.render(80);
		footer.setNoticeSource(
			() => ({ warning: 0, error: 0, update: 0 }),
			() => "f2",
		);
		expect(footer.render(80)).toEqual(before);
	});
});
