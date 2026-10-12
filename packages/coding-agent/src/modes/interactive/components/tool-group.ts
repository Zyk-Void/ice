import { Container, truncateToWidth } from "@zykairotis/ice-tui";
import { sym } from "../theme/symbols.ts";
import { theme } from "../theme/theme.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";
import { COMPACT_TOOL_MAX_WIDTH, describeExploration } from "./tool-summary.ts";
import { expandHint, linkToolToggle, linkToolToggleLine } from "./tool-toggle-link.ts";

/** Collapsed groups list at most this many exploration lines. */
const MAX_COLLAPSED_LINES = 6;

/**
 * Consecutive read/search/list calls rendered as one cell:
 *
 *   ● Explored
 *     ⎿ Read AGENTS.md
 *       Search createWindow in src
 *       List main
 *
 * The header reads "Exploring" while a call runs. Failed calls also render as
 * their own rows below. Expanded, every member renders as its own row.
 * Members remain the components that receive tool updates; the group only lays them out.
 */
export class ToolGroupComponent extends Container {
	private readonly members: ToolExecutionComponent[] = [];
	private expanded: boolean;
	/** Lines of a settled group, reused until membership, expansion, or an invalidation changes them. */
	private renderCache?: { width: number; lines: string[] };

	constructor(expanded: boolean) {
		super();
		this.expanded = expanded;
	}

	add(member: ToolExecutionComponent): void {
		member.setLeadingSpacer(false);
		member.setToggleId(this.getToggleId(member));
		member.setExpanded(this.expanded);
		this.members.push(member);
		this.addChild(member);
		this.renderCache = undefined;
	}

	/** The group's identity for expansion state: its first member's tool call. */
	getToggleId(fallback?: ToolExecutionComponent): string {
		return (this.members[0] ?? fallback)?.getToolCallId() ?? "";
	}

	/** A failed call ends the run so later calls start a new cell. */
	isOpen(): boolean {
		return !this.members.some((member) => member.getState() === "error");
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.renderCache = undefined;
		for (const member of this.members) member.setExpanded(expanded);
	}

	override invalidate(): void {
		this.renderCache = undefined;
		super.invalidate();
	}

	override render(width: number): string[] {
		if (this.members.length === 0) return [];
		if (this.renderCache?.width === width) return this.renderCache.lines;
		// Expanded members link their own rows to this group.
		const lines = this.expanded ? this.renderCell(width) : linkToolToggle(this.renderCell(width), this.getToggleId());
		// Running members change without notifying the group, so only settled groups are cached.
		if (this.members.every((member) => member.getState() !== "pending")) this.renderCache = { width, lines };
		return lines;
	}

	private renderCell(width: number): string[] {
		const lines = [""];
		if (this.expanded) {
			for (const member of this.members) lines.push(...member.render(width));
			return lines;
		}

		width = Math.min(width, COMPACT_TOOL_MAX_WIDTH);
		const states = this.members.map((member) => member.getState());
		const running = states.includes("pending");
		const failed = states.includes("error");
		const markerColor = failed ? "error" : running ? "muted" : "success";
		const marker = sym(failed ? "error" : running ? "toolPending" : "toolSuccess");
		lines.push(
			`${theme.fg(markerColor, marker)} ${theme.fg("toolTitle", theme.bold(running ? "Exploring" : "Explored"))}`,
		);

		const entries = this.members.map((member) => {
			const line = describeExploration(member.getToolName(), member.getArgs());
			return line ? `${theme.fg("accent", line.verb)} ${line.target}` : theme.fg("toolTitle", member.getToolName());
		});
		const shown = entries.length > MAX_COLLAPSED_LINES ? entries.slice(0, MAX_COLLAPSED_LINES - 1) : entries;
		const hidden = entries.length - shown.length;
		const bodyWidth = Math.max(1, width - 4);
		shown.forEach((entry, index) => {
			const prefix = index === 0 ? `  ${theme.fg("dim", sym("gutter"))} ` : "    ";
			lines.push(prefix + truncateToWidth(entry, bodyWidth, sym("ellipsis")));
		});
		if (hidden > 0) {
			lines.push(
				`    ${linkToolToggleLine(theme.fg("dim", `${sym("ellipsis")} +${hidden} more (${expandHint()} to expand)`), this.getToggleId())}`,
			);
		}

		for (const failed of this.members.filter((member) => member.getState() === "error")) {
			lines.push(...failed.render(Math.max(1, width - 2)).map((line) => `  ${line}`));
		}
		return lines;
	}
}
