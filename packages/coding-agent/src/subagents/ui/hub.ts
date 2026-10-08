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

/**
 * One terminal row, at most `width` wide. Child descriptions, approval summaries, and details are untrusted
 * text that may contain line breaks; a break inside a rendered line desynchronizes the TUI's row diff.
 */
function oneRow(text: string, width: number): string {
	return truncateToWidth(text.replace(/[\r\n]+/g, " "), width, "…");
}

function pad(text: string, width: number): string {
	const truncated = oneRow(text, width);
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
	/** Selected pending request of the selected child; the approve and deny keys act on it. */
	private selectedApprovalId: string | undefined;
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
		// Opening the Hub with requests waiting selects the first child that asked.
		if (this.selectedId === undefined) {
			const asking = this.orderedApprovals(rows)[0]?.request.childId;
			if (asking) this.selectedId = asking;
		}
		const row = rows[this.selectedIndex(rows)];
		this.selectedId = row?.id;
		return row;
	}

	/** Pending requests in roster order, oldest first within each child. */
	private orderedApprovals(rows: readonly HubRow[]): PendingApproval[] {
		const position = new Map(rows.map((row, index) => [row.id, index]));
		return [...this.source.approvals()].sort(
			(a, b) =>
				(position.get(a.request.childId) ?? rows.length) - (position.get(b.request.childId) ?? rows.length) ||
				a.queuedAt - b.queuedAt,
		);
	}

	private childApprovals(childId: string | undefined): PendingApproval[] {
		return this.orderedApprovals(orderedRows(this.source.rows())).filter(
			(approval) => approval.request.childId === childId,
		);
	}

	/** The request the approve/deny keys act on: only ever one of the selected child's own. */
	private targetApproval(): PendingApproval | undefined {
		const own = this.childApprovals(this.selectedRow()?.id);
		return own.find((approval) => approval.request.id === this.selectedApprovalId) ?? own[0];
	}

	/** Select the request after the current one, across children, and the child that asked. */
	private selectNextApproval(rows: readonly HubRow[]): void {
		const approvals = this.orderedApprovals(rows);
		if (approvals.length === 0) {
			this.notice = "No subagent is waiting for approval.";
			return;
		}
		const current = this.targetApproval();
		const index = approvals.findIndex((approval) => approval.request.id === current?.request.id);
		const next = approvals[(index + 1) % approvals.length]!;
		this.selectedId = next.request.childId;
		this.selectedApprovalId = next.request.id;
	}

	/** The name a person reads for the child behind a request. */
	private requester(approval: PendingApproval): string {
		const row = this.source.rows().find((candidate) => candidate.id === approval.request.childId);
		return row ? label(row) : (approval.request.name ?? approval.request.childId);
	}

	private answer(answer: ApprovalAnswer): void {
		const approval = this.targetApproval();
		const row = this.selectedRow();
		if (!approval) {
			this.notice = `${row ? label(row) : "This subagent"} has nothing to approve; ${keyText("app.agents.nextApproval")} selects the next request.`;
			return;
		}
		if (answer === "allow-session" && !approval.request.sessionRule) {
			this.notice = "This request can only be allowed once.";
			return;
		}
		this.source.respond(approval.request.id, answer);
		const verb =
			answer === "deny"
				? "Denied"
				: answer === "allow-session"
					? `Always allowing ${approval.request.sessionRule} for`
					: "Approved";
		this.notice = `${verb} ${this.requester(approval)}: ${approval.request.summary}`;
		this.selectedApprovalId = undefined;
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
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedId = rows[Math.max(0, this.selectedIndex(rows) - 1)]?.id;
			this.selectedApprovalId = undefined;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedId = rows[Math.min(rows.length - 1, this.selectedIndex(rows) + 1)]?.id;
			this.selectedApprovalId = undefined;
		} else if (this.keybindings.matches(data, "app.agents.nextApproval")) this.selectNextApproval(rows);
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
		else if (this.keybindings.matches(data, "app.agents.approve")) this.answer("allow-once");
		else if (this.keybindings.matches(data, "app.agents.approveSession")) this.answer("allow-session");
		else if (this.keybindings.matches(data, "app.agents.deny")) this.answer("deny");
		else return;
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
		const waiting = new Map<string, number>();
		for (const approval of this.source.approvals())
			waiting.set(approval.request.childId, (waiting.get(approval.request.childId) ?? 0) + 1);
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
			const asks = waiting.get(row.id) ?? 0;
			const badge = asks > 0 ? `${this.theme.fg("warning", `${asks} to approve`)} ` : "";
			lines.push(oneRow(`${fixed}${badge}${row.description}  ${this.theme.fg("dim", extra)}`, width));
		}
		if (end < rows.length) lines.push(this.theme.fg("dim", `  ↓ ${rows.length - end} more`));
		return lines;
	}

	/** One line naming the children that wait for approval; their requests show in the inspector. */
	private approvalSummary(rows: readonly HubRow[], width: number): string[] {
		const approvals = this.orderedApprovals(rows);
		if (approvals.length === 0) return [];
		const counts = new Map<string, number>();
		for (const approval of approvals) {
			const name = this.requester(approval);
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
		const names = [...counts].map(([name, count]) => (count > 1 ? `${name} (${count})` : name)).join(", ");
		return [
			oneRow(
				`${this.theme.fg("warning", `Waiting for approval: ${names}`)}  ${this.theme.fg("dim", `${keyText("app.agents.nextApproval")} next request`)}`,
				width,
			),
			"",
		];
	}

	/** The selected child's own requests, with the one the keys act on marked. */
	private childApprovalLines(row: HubRow): string[] {
		const own = this.childApprovals(row.id);
		if (own.length === 0) return [];
		const target = this.targetApproval();
		const keys = [
			`${keyText("app.agents.approve")} allow once`,
			...(target?.request.sessionRule
				? [`${keyText("app.agents.approveSession")} always allow ${target.request.sessionRule}`]
				: []),
			`${keyText("app.agents.deny")} deny`,
			...(own.length > 1 || this.source.approvals().length > 1
				? [`${keyText("app.agents.nextApproval")} next`]
				: []),
		];
		return [
			this.theme.fg("warning", `Waiting for approval (${own.length})`),
			...own.map((approval) =>
				approval.request.id === target?.request.id
					? `${this.theme.fg("accent", "›")} ${this.theme.bold(approval.request.summary)}`
					: `  ${approval.request.summary}`,
			),
			this.theme.fg("dim", keys.join(" · ")),
			"",
		];
	}

	private inspectorLines(row: HubRow | undefined, width: number): string[] {
		if (!row) return [];
		const lines = [
			this.theme.bold(`${label(row)} · ${row.agent}${row.name ? ` · ${row.id}` : ""}`),
			...this.childApprovalLines(row),
			...this.source.details(row.id),
		];
		if (row.blockedReasons?.length) lines.push(this.theme.fg("warning", `Blocked: ${row.blockedReasons.join("; ")}`));
		return lines.map((line) => oneRow(line, width));
	}

	render(width: number): string[] {
		const rows = orderedRows(this.source.rows());
		const approvals = this.source.approvals();
		const row = this.selectedRow();
		const lines = [this.header(rows, approvals.length), "", ...this.approvalSummary(rows, width)];
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
		if (this.notice) lines.push("", this.theme.fg("muted", oneRow(this.notice, width)));
		const hints = [
			`${keyText("tui.select.up")}/${keyText("tui.select.down")} select`,
			`${keyText("tui.select.confirm")} open`,
			`${keyText("app.agents.stop")} stop`,
			`${keyText("app.agents.delete")} delete`,
			`${keyText("tui.select.cancel")} close`,
		];
		lines.push("", this.theme.fg("dim", oneRow(hints.join(" · "), width)));
		return lines;
	}
}
