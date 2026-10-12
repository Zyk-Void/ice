/**
 * Section building — parses normalized blocks into structured sections.
 *
 * Upstream: https://github.com/sting8k/ice-vcc (src/core/build-sections.ts)
 * Unmodified.
 */

import { extractCommits, formatCommits } from "../extract/commits.ts";
import { extractFiles } from "../extract/files.ts";
import { extractGoals } from "../extract/goals.ts";
import { dedupPreferencesAgainstGoals, extractPreferences } from "../extract/preferences.ts";
import type { SectionData } from "../sections.ts";
import type { NormalizedBlock } from "../types.ts";
import { buildBriefSections, stringifyBrief, toolOneLiner } from "./brief.ts";
import { clipSentence, firstLine, nonEmptyLines } from "./content.ts";

export interface BuildSectionsInput {
	blocks: NormalizedBlock[];
}

const BLOCKER_RE =
	/\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

const MAX_RECENT_ACTIONS = 10;

/**
 * Last assistant tool actions in chronological order, so the post-compaction
 * model immediately sees what was just done without scanning the transcript.
 * A failed result marks the most recent unmatched call with the same tool name.
 */
const extractRecentActions = (blocks: NormalizedBlock[]): string[] => {
	const actions: Array<{ line: string; error: boolean }> = [];
	for (const b of blocks) {
		if (b.kind === "tool_call") {
			if (!b.name || b.name.trim() === "") continue;
			actions.push({ line: toolOneLiner(b.name, b.args).replace(/^\* /, ""), error: false });
			continue;
		}
		if (b.kind === "tool_result" && b.isError) {
			for (let i = actions.length - 1; i >= 0; i--) {
				const tool = actions[i].line.match(/^(\S+)/)?.[1];
				if (tool === b.name) {
					actions[i].error = true;
					break;
				}
			}
		}
	}
	return actions.slice(-MAX_RECENT_ACTIONS).map((a) => (a.error ? `${a.line} [error]` : a.line));
};

const extractOutstandingContext = (blocks: NormalizedBlock[]): string[] => {
	const items: string[] = [];
	const tail = blocks.slice(-20);

	for (const b of tail) {
		if (b.kind === "tool_result" && b.isError) {
			items.push(`[${b.name}] ${firstLine(b.text, 150)}`);
			continue;
		}

		if (b.kind === "assistant" || b.kind === "user") {
			for (const line of nonEmptyLines(b.text)) {
				if (!BLOCKER_RE.test(line)) continue;
				if (line.length < 15) continue;
				// Skip continuation fragments (sub-bullets, parentheticals, dangling clauses)
				if (/^\s*[-*+>]\s/.test(line)) continue;
				if (/^\s*\(/.test(line)) continue;
				// Require sentence-like start: capital letter, code identifier, or quote
				if (!/^\s*["'`*_]?[A-Z`]/.test(line)) continue;
				const clipped = b.kind === "user" ? `[user] ${clipSentence(line, 150)}` : clipSentence(line, 150);
				if (!items.includes(clipped)) items.push(clipped);
				break;
			}
		}
	}

	return items.slice(0, 5);
};

const formatFileActivity = (blocks: NormalizedBlock[]): string[] => {
	const act = extractFiles(blocks);
	// Dedup: if already Modified, drop from Created (file existed before)
	for (const p of act.modified) act.created.delete(p);
	const lines: string[] = [];
	const cap = (set: Set<string>, limit: number) => {
		const arr = [...set];
		if (arr.length <= limit) return arr.join(", ");
		return `${arr.slice(0, limit).join(", ")} (+${arr.length - limit} more)`;
	};
	if (act.modified.size > 0) lines.push(`Modified: ${cap(act.modified, 10)}`);
	if (act.created.size > 0) lines.push(`Created: ${cap(act.created, 10)}`);
	if (act.read.size > 0) lines.push(`Read: ${cap(act.read, 10)}`);
	return lines;
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
	const { blocks } = input;
	const briefSections = buildBriefSections(blocks);
	const sessionGoal = extractGoals(blocks);
	const userPreferences = dedupPreferencesAgainstGoals(extractPreferences(blocks), sessionGoal);
	return {
		recentActions: extractRecentActions(blocks),
		sessionGoal,
		outstandingContext: extractOutstandingContext(blocks),
		filesAndChanges: formatFileActivity(blocks),
		commits: formatCommits(extractCommits(blocks)),
		userPreferences,
		briefTranscript: stringifyBrief(briefSections),
	};
};
