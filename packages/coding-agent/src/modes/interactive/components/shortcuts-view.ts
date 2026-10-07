import { type Component, truncateToWidth, visibleWidth } from "@zykairotis/ice-tui";
import { theme } from "../theme/theme.ts";

export interface ShortcutSection {
	title: string;
	rows: ReadonlyArray<{ key: string; label: string }>;
}

const COLUMN_GAP = 3;

/**
 * Keyboard shortcut overview shown above the editor (opened with `?` on an
 * empty prompt). Sections render side by side when they fit, otherwise stacked.
 */
export class ShortcutsViewComponent implements Component {
	private readonly sections: readonly ShortcutSection[];
	private readonly footer: string;
	private readonly onClose: () => void;

	constructor(sections: readonly ShortcutSection[], footer: string, onClose: () => void) {
		this.sections = sections.filter((section) => section.rows.length > 0);
		this.footer = footer;
		this.onClose = onClose;
	}

	/** Any key closes the view; the key is not passed on. */
	handleInput(_data: string): void {
		this.onClose();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const columns = this.sections.map((section) => this.renderSection(section));
		const columnWidths = columns.map((lines) => Math.max(...lines.map((line) => visibleWidth(line))));
		const sideBySideWidth =
			2 + columnWidths.reduce((sum, columnWidth) => sum + columnWidth, 0) + COLUMN_GAP * (columns.length - 1);

		const lines = ["", `  ${theme.bold("Keyboard shortcuts")}`, ""];
		if (sideBySideWidth <= width) {
			const height = Math.max(...columns.map((column) => column.length));
			for (let row = 0; row < height; row++) {
				const cells = columns.map((column, index) => {
					const cell = column[row] ?? "";
					const pad = index < columns.length - 1 ? columnWidths[index]! - visibleWidth(cell) + COLUMN_GAP : 0;
					return cell + " ".repeat(Math.max(0, pad));
				});
				lines.push(`  ${cells.join("")}`.trimEnd());
			}
		} else {
			columns.forEach((column, index) => {
				if (index > 0) lines.push("");
				for (const line of column) lines.push(`  ${line}`);
			});
		}
		lines.push("", `  ${theme.fg("dim", this.footer)}`);
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	private renderSection(section: ShortcutSection): string[] {
		const keyWidth = Math.max(...section.rows.map((row) => visibleWidth(row.key)));
		return [
			theme.fg("accent", section.title),
			...section.rows.map((row) => `${theme.bold(row.key.padEnd(keyWidth))}  ${theme.fg("muted", row.label)}`),
		];
	}
}
