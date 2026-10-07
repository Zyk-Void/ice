/**
 * Holds non-transcript notices (safety warnings, update availability,
 * extension console output) for the footer badge and the notices overlay.
 * Notices are deduplicated by id so repeated emits do not accumulate.
 */

export type NoticeKind = "warning" | "error" | "update" | "info";

export interface Notice {
	id: string;
	kind: NoticeKind;
	source: string;
	title: string;
	detail?: string;
	/** Sticky notices describe process state (e.g. Bash enabled) and cannot be dismissed. */
	sticky?: boolean;
	createdAt: number;
}

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

export class NoticeCenter {
	private readonly notices = new Map<string, Notice>();
	private readonly listeners = new Set<() => void>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	add(notice: Omit<Notice, "createdAt">): void {
		const existing = this.notices.get(notice.id);
		this.notices.set(notice.id, { ...notice, createdAt: existing?.createdAt ?? this.now() });
		this.emit();
	}

	dismiss(id: string): boolean {
		const notice = this.notices.get(id);
		if (!notice || notice.sticky) return false;
		this.notices.delete(id);
		this.emit();
		return true;
	}

	list(): readonly Notice[] {
		return [...this.notices.values()];
	}

	counts(): NoticeCounts {
		const counts: NoticeCounts = { warning: 0, error: 0, update: 0 };
		for (const notice of this.notices.values()) {
			if (notice.kind !== "info") counts[notice.kind]++;
		}
		return counts;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}
