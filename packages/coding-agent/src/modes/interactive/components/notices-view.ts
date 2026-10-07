import { Container, type SelectItem, SelectList, Spacer, Text } from "@zykairotis/ice-tui";
import type { Notice, NoticeCenter } from "../notice-center.ts";
import { sym } from "../theme/symbols.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const KIND_ORDER: Record<Notice["kind"], number> = { error: 0, warning: 1, update: 2, info: 3 };

function noticeIcon(notice: Notice): string {
	switch (notice.kind) {
		case "error":
			return theme.fg("error", sym("error"));
		case "warning":
			return theme.fg("warning", sym("warning"));
		case "update":
			return theme.fg("accent", sym("update"));
		default:
			return theme.fg("dim", sym("separator"));
	}
}

/**
 * Read-only list of warnings, update notices, and captured extension output.
 * Enter dismisses the selected non-sticky notice; Escape closes the view.
 */
export class NoticesViewComponent extends Container {
	private readonly center: NoticeCenter;
	private readonly onClose: () => void;
	private readonly detail = new Text("", 1, 0);
	private selectList: SelectList | undefined;
	private readonly listHost = new Container();
	private notices: Notice[] = [];
	private readonly unsubscribe: () => void;

	constructor(center: NoticeCenter, onClose: () => void) {
		super();
		this.center = center;
		this.onClose = onClose;
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold("Notices"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.listHost);
		this.addChild(new Spacer(1));
		this.addChild(this.detail);
		this.addChild(new Text(theme.fg("dim", "enter dismiss · esc close"), 1, 0));
		this.addChild(new DynamicBorder());
		this.rebuild();
		this.unsubscribe = center.subscribe(() => this.rebuild());
	}

	dispose(): void {
		this.unsubscribe();
	}

	/** The list is rebuilt on every change, so this view stays the focus target and forwards input. */
	handleInput(data: string): void {
		this.selectList?.handleInput(data);
	}

	/** Rebuild from the center, keeping the selected notice (or its position when it was removed). */
	private rebuild(): void {
		const previousId = this.selectList?.getSelectedItem()?.value;
		const previousIndex = Math.max(
			0,
			this.notices.findIndex((notice) => notice.id === previousId),
		);
		this.notices = [...this.center.list()].sort(
			(a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.createdAt - b.createdAt,
		);
		const keptIndex = this.notices.findIndex((notice) => notice.id === previousId);
		const selectedIndex = Math.max(0, Math.min(keptIndex >= 0 ? keptIndex : previousIndex, this.notices.length - 1));
		const items: SelectItem[] =
			this.notices.length > 0
				? this.notices.map((notice) => ({ value: notice.id, label: `${noticeIcon(notice)} ${notice.title}` }))
				: [{ value: "", label: theme.fg("dim", "No notices") }];
		this.selectList = new SelectList(items, 8, getSelectListTheme());
		this.selectList.setSelectedIndex(selectedIndex);
		this.selectList.onSelectionChange = (item) => this.showDetail(item.value);
		this.selectList.onSelect = (item) => {
			if (item.value) this.center.dismiss(item.value);
		};
		this.selectList.onCancel = () => this.onClose();
		this.listHost.clear();
		this.listHost.addChild(this.selectList);
		this.showDetail(this.notices[selectedIndex]?.id ?? "");
	}

	private showDetail(id: string): void {
		const notice = this.notices.find((candidate) => candidate.id === id);
		if (!notice) {
			this.detail.setText("");
			return;
		}
		const source = notice.sticky ? `${notice.source} ${sym("separator")} active, cannot be dismissed` : notice.source;
		const body = [notice.title, theme.fg("dim", source), notice.detail ? theme.fg("muted", notice.detail) : ""];
		this.detail.setText(body.filter(Boolean).join("\n"));
	}
}
