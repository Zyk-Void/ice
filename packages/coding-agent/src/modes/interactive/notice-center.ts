/**
 * Holds non-transcript notices (safety warnings, update availability, extension output, failed tools,
 * MCP and model errors, resource load problems, compaction and subagent outcomes) for the footer badge
 * and the notices panel. Notices are deduplicated by id: a repeat updates the entry and bumps its count.
 */

export type NoticeKind = "warning" | "error" | "update" | "info";

/** What a notice is about; the panel filters on it. */
export type NoticeCategory =
	| "extensions"
	| "mcp"
	| "tools"
	| "skills"
	| "prompts"
	| "themes"
	| "compaction"
	| "subagents"
	| "model"
	| "session"
	| "console"
	| "updates";

/** Panel filter order. */
export const NOTICE_CATEGORIES: readonly NoticeCategory[] = [
	"extensions",
	"mcp",
	"tools",
	"skills",
	"prompts",
	"themes",
	"compaction",
	"subagents",
	"model",
	"session",
	"console",
	"updates",
];

export interface Notice {
	id: string;
	kind: NoticeKind;
	category: NoticeCategory;
	source: string;
	title: string;
	detail?: string;
	/** Sticky notices describe process state (e.g. Bash enabled) and cannot be dismissed. */
	sticky?: boolean;
	/** Listed in the panel but left out of the footer badge (routine tool failures, retries, history). */
	quiet?: boolean;
	/** Notices derived from current state; `replaceGroup` swaps the whole group at once. */
	group?: string;
	createdAt: number;
	updatedAt: number;
	/** How many times this notice was raised. */
	count: number;
}

export type NoticeInput = Omit<Notice, "createdAt" | "updatedAt" | "count">;

/** Sticky safety notice ids and the capability label each one adds to the session header. */
export const SAFETY_NOTICE_CAPABILITIES: Readonly<Record<string, string>> = {
	"safety:bash": "bash",
	"safety:external": "external",
};

export interface NoticeCounts {
	warning: number;
	error: number;
	update: number;
}

const KIND_ORDER: Record<NoticeKind, number> = { error: 0, warning: 1, update: 2, info: 3 };

/** Badge-counted notices first, then by kind, then most recent first; the panel and agent reports share it. */
export function orderNotices(notices: readonly Notice[]): Notice[] {
	return [...notices].sort(
		(a, b) =>
			Number(!!a.quiet) - Number(!!b.quiet) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.updatedAt - a.updatedAt,
	);
}

/** Retained notices; the oldest non-sticky ones are dropped beyond this. */
export const MAX_NOTICES = 500;

export class NoticeCenter {
	private readonly notices = new Map<string, Notice>();
	/** Dismissed ids of grouped notices, so re-derived state does not bring them back. */
	private readonly dismissedGroupIds = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	add(notice: NoticeInput): void {
		this.put(notice, true);
		this.trim();
		this.emit();
	}

	/**
	 * Replace every notice of `group` with `notices`. Entries whose id survives keep their first-seen time
	 * and count; dismissed ids stay hidden until they disappear from the group.
	 */
	replaceGroup(group: string, notices: readonly Omit<NoticeInput, "group">[]): void {
		const ids = new Set(notices.map((notice) => notice.id));
		let changed = false;
		for (const [id, notice] of this.notices) {
			if (notice.group === group && !ids.has(id)) {
				this.notices.delete(id);
				changed = true;
			}
		}
		for (const id of this.dismissedGroupIds) {
			if (id.startsWith(`${group}\0`) && !ids.has(id.slice(group.length + 1))) this.dismissedGroupIds.delete(id);
		}
		for (const notice of notices) {
			if (this.dismissedGroupIds.has(`${group}\0${notice.id}`)) continue;
			const existing = this.notices.get(notice.id);
			if (
				existing?.group === group &&
				existing.kind === notice.kind &&
				existing.title === notice.title &&
				existing.detail === notice.detail
			)
				continue;
			this.put({ ...notice, group }, false);
			changed = true;
		}
		if (!changed) return;
		this.trim();
		this.emit();
	}

	dismiss(id: string): boolean {
		const notice = this.notices.get(id);
		if (!notice || notice.sticky) return false;
		this.notices.delete(id);
		if (notice.group) this.dismissedGroupIds.add(`${notice.group}\0${id}`);
		this.emit();
		return true;
	}

	/** Dismiss every non-sticky notice that matches; returns how many were removed. */
	dismissWhere(predicate: (notice: Notice) => boolean): number {
		let removed = 0;
		for (const notice of [...this.notices.values()]) {
			if (notice.sticky || !predicate(notice)) continue;
			this.notices.delete(notice.id);
			if (notice.group) this.dismissedGroupIds.add(`${notice.group}\0${notice.id}`);
			removed++;
		}
		if (removed > 0) this.emit();
		return removed;
	}

	list(): readonly Notice[] {
		return [...this.notices.values()];
	}

	/** Footer badge counts; quiet notices and info are left out. */
	counts(): NoticeCounts {
		const counts: NoticeCounts = { warning: 0, error: 0, update: 0 };
		for (const notice of this.notices.values()) {
			if (notice.kind !== "info" && !notice.quiet) counts[notice.kind]++;
		}
		return counts;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private put(notice: NoticeInput, repeat: boolean): void {
		const existing = this.notices.get(notice.id);
		const now = this.now();
		this.notices.set(notice.id, {
			...notice,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			count: existing ? existing.count + (repeat ? 1 : 0) : 1,
		});
	}

	private trim(): void {
		if (this.notices.size <= MAX_NOTICES) return;
		const removable = [...this.notices.values()]
			.filter((notice) => !notice.sticky)
			.sort((a, b) => Number(!a.quiet) - Number(!b.quiet) || a.updatedAt - b.updatedAt);
		for (const notice of removable.slice(0, this.notices.size - MAX_NOTICES)) this.notices.delete(notice.id);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}
