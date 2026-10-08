/**
 * Subagent V2 Agent Hub (Plan/subagent-rewrite.md section 15, P8.1-P8.7).
 *
 * One live view over the ChildRegistry projection: pending approvals, the child
 * roster, and an inspector for the selected child. Wide terminals show roster and
 * inspector side by side; narrow ones stack them. The Hub owns no lifecycle state:
 * every action goes through the runtime (HubSource), and focusing a child hands
 * it to the normal interactive child view.
 */
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@zykairotis/ice-tui";
import type { KeybindingsManager } from "../../core/extensions/types.ts";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ApprovalAnswer, PendingApproval } from "../permissions/approval.ts";

export interface HubRow {
	id: string;
	agent: string;
	name?: string;
	description: string;
	state: string;
	lastTurnOutcome?: string;
	turns: number;
	tokens: number;
	cost: number;
	patchState?: string;
	blockedReasons?: readonly string[];
}

/** Everything the Hub reads or does; implemented by the V2 runtime. */
export interface HubSource {
	rows(): readonly HubRow[];
	approvals(): readonly PendingApproval[];
	/** Plain-text inspector lines for one child. */
	details(id: string): readonly string[];
	subscribe(listener: () => void): () => void;
	/** Show the child in the normal interactive view; false when it cannot be focused. */
	focus(id: string): boolean;
	stop(id: string): Promise<void>;
	/** Revive a parked child into memory so it can be shown live. */
	resume?(id: string): Promise<void>;
	delete(id: string): Promise<void>;
	respond(approvalId: string, answer: ApprovalAnswer): boolean;
	/** Running turns, turns queued for a slot, and the concurrency ceiling. */
	capacity?(): { running: number; queued: number; max: number };
}

const WIDE_WIDTH = 110;
/** Roster rows shown at once; the window follows the selection. */
const ROSTER_WINDOW = 14;
const NAME_WIDTH = 14;

/** One-cell status glyph and its theme color. */
export function statusMark(row: Pick<HubRow, "state" | "lastTurnOutcome">): {
	glyph: string;
	color: "accent" | "warning" | "error" | "success" | "muted";
} {
	if (row.state === "running") return { glyph: "●", color: "accent" };
	if (row.state === "queued") return { glyph: "◌", color: "warning" };
	if (row.state === "blocked") return { glyph: "!", color: "warning" };
	if (row.lastTurnOutcome === "failed" || row.lastTurnOutcome === "budget_exhausted")
		return { glyph: "✗", color: "error" };
	if (row.lastTurnOutcome === "interrupted" || row.lastTurnOutcome === "cancelled")
		return { glyph: "■", color: "muted" };
	if (row.lastTurnOutcome === "completed") return { glyph: "✓", color: "success" };
	return { glyph: "○", color: "muted" };
}

/** The name a person reads: the child's name, else its ID. */
function label(row: HubRow): string {
	return row.name ?? row.id;
}

export function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/** Parked children finished their work: listed after active ones, still resumable. */
function isFinished(row: HubRow): boolean {
	return row.state === "parked";
}

/** Active children first, then finished ones, each in registry order. */
function orderedRows(rows: readonly HubRow[]): HubRow[] {
	return [...rows.filter((row) => !isFinished(row)), ...rows.filter(isFinished)];
}

function pad(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export class AgentHubView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly source: HubSource;
	private readonly done: () => void;
	private readonly unsubscribe: () => void;
	/** Selected child by ID, so the selection stays on the same child when rows move. */
	private selectedId: string | undefined;
	private notice: string | undefined;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, source: HubSource, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.source = source;
		this.done = done;
		this.unsubscribe = source.subscribe(() => this.tui.requestRender());
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {}

	private selectedIndex(rows: readonly HubRow[]): number {
		const index = rows.findIndex((row) => row.id === this.selectedId);
		return index >= 0 ? index : 0;
	}

	private selectedRow(): HubRow | undefined {
		const rows = orderedRows(this.source.rows());
		const row = rows[this.selectedIndex(rows)];
		this.selectedId = row?.id;
		return row;
	}

	/** The approval the approve/deny keys act on: the selected child's first request, else the oldest. */
	private targetApproval(): PendingApproval | undefined {
		const approvals = this.source.approvals();
		const row = this.selectedRow();
		return approvals.find((approval) => approval.request.childId === row?.id) ?? approvals[0];
	}

	private act(promise: Promise<void>, success: string): void {
		promise.then(
			() => {
				this.notice = success;
				this.tui.requestRender();
			},
			(error: unknown) => {
				this.notice = error instanceof Error ? error.message : String(error);
				this.tui.requestRender();
			},
		);
	}

	handleInput(data: string): void {
		const rows = orderedRows(this.source.rows());
		const row = this.selectedRow();
		if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "app.agents.hub")) {
			this.done();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up"))
			this.selectedId = rows[Math.max(0, this.selectedIndex(rows) - 1)]?.id;
		else if (this.keybindings.matches(data, "tui.select.down"))
			this.selectedId = rows[Math.min(rows.length - 1, this.selectedIndex(rows) + 1)]?.id;
		else if (
			row &&
			(this.keybindings.matches(data, "tui.select.confirm") ||
				this.keybindings.matches(data, "app.subagents.attach"))
		) {
			if (this.source.focus(row.id)) {
				this.done();
				return;
			}
			const resume = this.source.resume;
			if (row.state === "parked" && resume) {
				this.notice = `Resuming ${label(row)}…`;
				resume(row.id).then(
					() => {
						if (this.source.focus(row.id)) this.done();
						else this.notice = `${label(row)} was resumed but cannot be shown.`;
						this.tui.requestRender();
					},
					(error: unknown) => {
						this.notice = error instanceof Error ? error.message : String(error);
						this.tui.requestRender();
					},
				);
			} else this.notice = `${label(row)} has no live session to show.`;
		} else if (row && this.keybindings.matches(data, "app.agents.stop"))
			this.act(this.source.stop(row.id), `Stopped the current turn of ${label(row)}.`);
		else if (row && this.keybindings.matches(data, "app.agents.delete"))
			this.act(this.source.delete(row.id), `Deleted ${label(row)}.`);
		else if (
			this.keybindings.matches(data, "app.agents.approve") ||
			this.keybindings.matches(data, "app.agents.deny")
		) {
			const approval = this.targetApproval();
			if (approval) {
				const answer: ApprovalAnswer = this.keybindings.matches(data, "app.agents.approve") ? "allow-once" : "deny";
				this.source.respond(approval.request.id, answer);
				this.notice = `${answer === "deny" ? "Denied" : "Approved"} ${approval.request.agent}: ${approval.request.summary}`;
			}
		} else return;
		this.tui.requestRender();
	}

	private header(rows: readonly HubRow[], approvals: number): string {
		const count = (state: string) => rows.filter((row) => row.state === state).length;
		const capacity = this.source.capacity?.();
		const finished = rows.filter(isFinished).length;
		const active = rows.length - finished;
		const parts = [
			`${active} active${finished > 0 ? `, ${finished} finished` : ""}`,
			...(capacity
				? [
						`${capacity.running}/${capacity.max} slots in use${capacity.queued > 0 ? `, ${capacity.queued} queued` : ""}`,
					]
				: []),
			// With a capacity line, its queued count already covers queued rows.
			...(["running", "queued", "idle", "blocked"] as const)
				.filter((state) => !(capacity && state === "queued"))
				.map((state) => [state, count(state)] as const)
				.filter(([, value]) => value > 0)
				.map(([state, value]) => `${value} ${state}`),
			...(approvals > 0
				? [this.theme.fg("warning", `${approvals} pending approval${approvals === 1 ? "" : "s"}`)]
				: []),
		];
		return `${this.theme.bold("Agent Hub")}  ${this.theme.fg("muted", parts.join(" · "))}`;
	}

	private rosterLines(rows: readonly HubRow[], width: number): string[] {
		if (rows.length === 0)
			return [this.theme.fg("muted", "No subagents in this session. Use the agent tool to start one.")];
		const selected = this.selectedIndex(rows);
		const start = Math.max(0, Math.min(selected - Math.floor(ROSTER_WINDOW / 2), rows.length - ROSTER_WINDOW));
		const end = Math.min(rows.length, start + ROSTER_WINDOW);
		const firstFinished = rows.findIndex(isFinished);
		const lines: string[] = [];
		if (start > 0) lines.push(this.theme.fg("dim", `  ↑ ${start} more`));
		for (let index = start; index < end; index++) {
			const row = rows[index]!;
			if (index === firstFinished)
				lines.push(this.theme.fg("dim", `Finished (${keyText("tui.select.confirm")} resumes and opens)`));
			const isSelected = index === selected;
			const mark = statusMark(row);
			const name = pad(label(row), NAME_WIDTH);
			// A finished child shows how its last turn ended instead of the internal "parked".
			const state = row.state === "parked" ? (row.lastTurnOutcome ?? "finished") : row.state;
			const extra = [
				row.state !== "parked" && row.state !== "running" ? (row.lastTurnOutcome ?? "") : "",
				row.patchState ? `patch ${row.patchState}` : "",
				`${formatTokens(row.tokens)} tok`,
			]
				.filter(Boolean)
				.join(" · ");
			const fixed = `${isSelected ? this.theme.fg("accent", "›") : " "} ${this.theme.fg(mark.color, mark.glyph)} ${isSelected ? this.theme.bold(name) : name} ${this.theme.fg("muted", pad(row.agent, 9))} ${this.theme.fg(mark.color, pad(state, 10))} `;
			lines.push(truncateToWidth(`${fixed}${row.description}  ${this.theme.fg("dim", extra)}`, width, "…"));
		}
		if (end < rows.length) lines.push(this.theme.fg("dim", `  ↓ ${rows.length - end} more`));
		return lines;
	}

	private approvalLines(approvals: readonly PendingApproval[], width: number): string[] {
		if (approvals.length === 0) return [];
		const hint = `${keyText("app.agents.approve")} allow · ${keyText("app.agents.deny")} deny`;
		return [
			this.theme.fg("warning", "Pending approvals"),
			...approvals.map((approval) =>
				truncateToWidth(
					`  ${approval.request.agent} (${approval.request.childId}): ${approval.request.summary}  ${this.theme.fg("dim", hint)}`,
					width,
					"…",
				),
			),
			"",
		];
	}

	private inspectorLines(row: HubRow | undefined, width: number): string[] {
		if (!row) return [];
		const lines = [
			this.theme.bold(`${label(row)} · ${row.agent}${row.name ? ` · ${row.id}` : ""}`),
			...this.source.details(row.id),
		];
		if (row.blockedReasons?.length) lines.push(this.theme.fg("warning", `Blocked: ${row.blockedReasons.join("; ")}`));
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	render(width: number): string[] {
		const rows = orderedRows(this.source.rows());
		const approvals = this.source.approvals();
		const row = this.selectedRow();
		const lines = [this.header(rows, approvals.length), "", ...this.approvalLines(approvals, width)];
		if (width >= WIDE_WIDTH && row) {
			const left = Math.floor(width * 0.55);
			const right = width - left - 3;
			const roster = this.rosterLines(rows, left);
			const inspector = this.inspectorLines(row, right);
			const height = Math.max(roster.length, inspector.length);
			for (let index = 0; index < height; index++)
				lines.push(`${pad(roster[index] ?? "", left)} ${this.theme.fg("border", "│")} ${inspector[index] ?? ""}`);
		} else {
			lines.push(...this.rosterLines(rows, width));
			if (row) lines.push("", ...this.inspectorLines(row, width));
		}
		if (this.notice) lines.push("", this.theme.fg("muted", truncateToWidth(this.notice, width, "…")));
		const hints = [
			`${keyText("tui.select.up")}/${keyText("tui.select.down")} select`,
			`${keyText("tui.select.confirm")} open`,
			`${keyText("app.agents.stop")} stop`,
			`${keyText("app.agents.delete")} delete`,
			`${keyText("tui.select.cancel")} close`,
		];
		lines.push("", this.theme.fg("dim", truncateToWidth(hints.join(" · "), width, "…")));
		return lines;
	}
}
