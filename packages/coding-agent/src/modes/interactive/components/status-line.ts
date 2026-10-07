import { truncateToWidth, visibleWidth } from "@zykairotis/ice-tui";

export interface StatusSegment {
	text: string;
	/** Lower priorities are dropped first when space is short. Segments at REQUIRED_PRIORITY are never dropped. */
	priority: number;
	/** Shorter rendering for a target width (e.g. a middle-truncated path); called before dropping segments. */
	shrink?: (maxWidth: number) => string;
	/** Smallest width `shrink` may produce. */
	minWidth?: number;
}

export const REQUIRED_PRIORITY = 100;

const GAP = 2;

function joinedWidth(segments: readonly StatusSegment[]): number {
	if (segments.length === 0) return 0;
	return segments.reduce((sum, segment) => sum + visibleWidth(segment.text), 0) + GAP * (segments.length - 1);
}

function join(segments: readonly StatusSegment[]): string {
	return segments.map((segment) => segment.text).join(" ".repeat(GAP));
}

/**
 * Lay out left- and right-aligned segments on one row. When they do not fit,
 * the lowest-priority segment shrinks once if it can, otherwise it drops. If
 * required segments still overflow, left and right render on two rows.
 */
export function layoutStatusLine(left: StatusSegment[], right: StatusSegment[], width: number): string[] {
	const leftSegments = left.map((segment) => ({ ...segment }));
	const rightSegments = right.map((segment) => ({ ...segment }));
	const used = () =>
		joinedWidth(leftSegments) +
		joinedWidth(rightSegments) +
		(leftSegments.length > 0 && rightSegments.length > 0 ? GAP : 0);

	// Act on the lowest-priority segment first: shrink it when it can still shrink, otherwise drop it.
	while (used() > width) {
		let target: { list: StatusSegment[]; index: number } | undefined;
		for (const list of [leftSegments, rightSegments]) {
			list.forEach((segment, index) => {
				const canShrink = segment.shrink !== undefined && visibleWidth(segment.text) > (segment.minWidth ?? 1);
				if (segment.priority >= REQUIRED_PRIORITY && !canShrink) return;
				if (!target || segment.priority < target.list[target.index]!.priority) target = { list, index };
			});
		}
		if (!target) break;
		const segment = target.list[target.index]!;
		if (segment.shrink && visibleWidth(segment.text) > (segment.minWidth ?? 1)) {
			const goal = Math.max(segment.minWidth ?? 1, visibleWidth(segment.text) - (used() - width));
			const shrunk = segment.shrink(goal);
			segment.shrink = undefined;
			if (visibleWidth(shrunk) < visibleWidth(segment.text)) segment.text = shrunk;
			continue;
		}
		if (segment.priority >= REQUIRED_PRIORITY) break;
		target.list.splice(target.index, 1);
	}

	const leftText = join(leftSegments);
	const rightText = join(rightSegments);
	if (used() <= width) {
		const padding = Math.max(rightText ? GAP : 0, width - visibleWidth(leftText) - visibleWidth(rightText));
		return [leftText + " ".repeat(padding) + rightText];
	}
	const clip = (text: string) => truncateToWidth(text, width, "…");
	return [clip(leftText), " ".repeat(Math.max(0, width - visibleWidth(clip(rightText)))) + clip(rightText)].filter(
		(line) => line.trim().length > 0,
	);
}
