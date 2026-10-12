import { visibleWidth } from "@zykairotis/ice-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, OPEN_AGENTS_URL, OPEN_SHELLS_URL } from "../src/modes/interactive/components/footer.ts";
import { layoutStatusLine, REQUIRED_PRIORITY } from "../src/modes/interactive/components/status-line.ts";
import { setToolToggleLinks } from "../src/modes/interactive/components/tool-toggle-link.ts";
import { setSymbolPreset } from "../src/modes/interactive/theme/symbols.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("layoutStatusLine", () => {
	const mode = { text: "build", priority: REQUIRED_PRIORITY };
	const badge = { text: "! 2", priority: REQUIRED_PRIORITY };

	it("puts left and right segments on one padded row when they fit", () => {
		expect(
			layoutStatusLine([mode, { text: "~/p", priority: 60 }], [{ text: "model", priority: 70 }, badge], 30),
		).toEqual(["build  ~/p          model  ! 2"]);
		expect(visibleWidth(layoutStatusLine([mode], [badge], 30)[0]!)).toBe(30);
	});

	it("shrinks or drops the lowest-priority segment first and keeps required segments", () => {
		const path = "/a/very/long/path/to/project";
		const lines = layoutStatusLine(
			[
				mode,
				{ text: path, priority: 60, shrink: (max) => `${path.slice(0, max - 1)}…`, minWidth: 8 },
				{ text: "status text", priority: 20 },
			],
			[{ text: "model", priority: 70 }, badge],
			40,
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("status text");
		expect(lines[0]).toContain("…");
		expect(lines[0]).toContain("build");
		expect(lines[0]).toContain("! 2");
		expect(visibleWidth(lines[0]!)).toBe(40);
	});

	it("splits onto two rows when required segments alone overflow", () => {
		const lines = layoutStatusLine(
			[{ text: "x".repeat(20), priority: REQUIRED_PRIORITY }],
			[{ text: "y".repeat(20), priority: REQUIRED_PRIORITY }],
			30,
		);
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	});
});

describe("compact footer", () => {
	beforeAll(() => {
		initTheme("dark");
		setSymbolPreset("unicode");
	});

	function createFooter(): FooterComponent {
		const session = {
			state: {
				model: { id: "gpt-test", provider: "test", contextWindow: 200_000, reasoning: true },
				thinkingLevel: "high",
			},
			sessionManager: { getEntries: () => [], getSessionName: () => undefined, getCwd: () => "/tmp/project" },
			getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
			modelRuntime: { isUsingOAuth: () => false },
		} as unknown as AgentSession;
		const data = {
			getGitBranch: () => "main",
			getExtensionStatuses: () =>
				new Map([
					["ice-mode", "build"],
					["mcp", "MCP: 3 servers"],
				]),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		} as unknown as ReadonlyFooterDataProvider;
		const footer = new FooterComponent(session, data);
		footer.setStyle("compact");
		footer.setCapabilitySource(() => ["bash"]);
		footer.setNoticeSource(
			() => ({ warning: 1, error: 0, update: 0 }),
			() => "f2",
		);
		return footer;
	}

	it("renders one status row with mode, capabilities, directory, branch, model, context, and notices", () => {
		const lines = createFooter()
			.render(140)
			.map((line) => stripAnsi(line));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			/^build bash {2}\/tmp\/project {2}⎇ main {2}MCP: 3 servers +gpt-test high {2}12%\/200k {2}⚠ 1 f2$/,
		);
	});

	it("abbreviates the external capability and the update notice", () => {
		const footer = createFooter();
		footer.setCapabilitySource(() => ["bash", "external"]);
		footer.setNoticeSource(
			() => ({ warning: 3, error: 0, update: 1 }),
			() => "f2",
		);
		const line = stripAnsi(footer.render(160)[0]!);
		expect(line.startsWith("build bash ext  ")).toBe(true);
		expect(line.endsWith("12%/200k  ⚠ 3 ↑ f2")).toBe(true);
	});

	it("shows running background shells next to the notices badge", () => {
		const footer = createFooter();
		footer.setBackgroundTaskSource(() => 2);
		expect(stripAnsi(footer.render(140)[0]!)).toContain("2 shells  ⚠ 1 f2");
		footer.setBackgroundTaskSource(() => 1);
		expect(stripAnsi(footer.render(140)[0]!)).toContain("1 shell  ⚠ 1 f2");
	});

	it("links the shell count and subagent segment to their panels only when clicks are routed", () => {
		const footer = createFooter();
		footer.setBackgroundTaskSource(() => 2);
		footer.setSubagentSource(() => ({
			enabled: true,
			capacity: { running: 1, queued: 0, max: 8 },
			maxDepth: 0,
			children: [],
			approvals: [],
			diagnostics: [],
		}));
		expect(footer.render(160)[0]).not.toContain(OPEN_SHELLS_URL);
		expect(footer.render(160)[0]).not.toContain(OPEN_AGENTS_URL);
		setToolToggleLinks(true);
		try {
			const line = footer.render(160)[0]!;
			expect(line).toContain(`\x1b]8;;${OPEN_SHELLS_URL}\x1b\\`);
			expect(line).toContain(`\x1b]8;;${OPEN_AGENTS_URL}\x1b\\`);
			expect(stripAnsi(line)).toContain("2 shells  agents 1/8  ⚠ 1 f2");
		} finally {
			setToolToggleLinks(false);
		}
	});

	it("keeps mode and notices visible on narrow terminals", () => {
		const lines = createFooter()
			.render(30)
			.map((line) => stripAnsi(line));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("build bash");
		expect(lines[0]).toContain("⚠ 1 f2");
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(30);
	});
});
