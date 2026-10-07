/**
 * Text for compact tool rows: exploration lines for grouped read/search/list
 * calls ("Read AGENTS.md", "Search foo in src") and one-line outcomes.
 */

/** Keep collapsed tool rows readable on ultrawide terminals; expanded rows use the available width. */
export const COMPACT_TOOL_MAX_WIDTH = 100;

export interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

export interface ExplorationLine {
	verb: "Read" | "Search" | "List";
	target: string;
}

function stringArg(args: unknown, key: string): string | undefined {
	if (!args || typeof args !== "object" || !(key in args)) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

const READ_COMMANDS = new Set(["cat", "head", "tail", "wc", "nl", "file", "stat"]);
const SEARCH_COMMANDS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "find", "fd"]);
const LIST_COMMANDS = new Set(["ls", "tree", "pwd"]);
const READ_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "blame"]);

/**
 * Classify a shell command as reading, searching, or listing when every part of it
 * is a known read-only command. Anything with redirection, substitution, in-place
 * edits, or an unknown program is a plain shell command. Display only; never a policy check.
 */
export function classifyShellCommand(command: string): "read" | "search" | "list" | "shell" {
	if (/[>\x60]|\$\(|<\(/.test(command)) return "shell";
	const kinds = new Set<"read" | "search" | "list">();
	for (const part of command.split(/&&|\|\||[;|\n]/)) {
		const words = part.trim().split(/\s+/).filter(Boolean);
		const program = words[0];
		if (!program) continue;
		if (program === "cd") continue;
		if (READ_COMMANDS.has(program)) kinds.add("read");
		else if (program === "sed" && words.includes("-n") && !words.some((word) => word.startsWith("-i")))
			kinds.add("read");
		else if (program === "git" && READ_GIT_SUBCOMMANDS.has(words[1] ?? "")) kinds.add("read");
		else if (SEARCH_COMMANDS.has(program) && !words.some((word) => word === "-exec" || word === "-delete"))
			kinds.add("search");
		else if (LIST_COMMANDS.has(program)) kinds.add("list");
		else return "shell";
	}
	if (kinds.has("search")) return "search";
	if (kinds.has("read")) return "read";
	if (kinds.has("list")) return "list";
	return "shell";
}

/**
 * Read, search, or list description for an exploration call; undefined for
 * anything else (mutations, non-read-only shell commands, other tools), which
 * renders as its own row.
 */
export function describeExploration(name: string, args: unknown): ExplorationLine | undefined {
	const path = stringArg(args, "path");
	switch (name) {
		case "read": {
			const offset = args && typeof args === "object" && "offset" in args ? args.offset : undefined;
			const limit = args && typeof args === "object" && "limit" in args ? args.limit : undefined;
			const range =
				typeof offset === "number"
					? `:${offset}${typeof limit === "number" ? `-${offset + limit - 1}` : ""}`
					: typeof limit === "number"
						? `:1-${limit}`
						: "";
			return { verb: "Read", target: `${path ?? "file"}${range}` };
		}
		case "grep":
		case "find": {
			const pattern = stringArg(args, "pattern") ?? "";
			return { verb: "Search", target: path ? `${pattern} in ${path}` : pattern };
		}
		case "ls":
			return { verb: "List", target: path ?? "." };
		case "bash": {
			const command = stringArg(args, "command");
			if (!command) return undefined;
			const kind = classifyShellCommand(command);
			if (kind === "shell") return undefined;
			const target = command.trim().split("\n", 1)[0] ?? "";
			return { verb: kind === "read" ? "Read" : kind === "search" ? "Search" : "List", target };
		}
		default:
			return undefined;
	}
}

function textOf(result: ToolResultLike): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n")
		.replace(/\r/g, "")
		.trimEnd();
}

export function resultTextLines(result: ToolResultLike | undefined): string[] {
	if (!result) return [];
	const text = textOf(result);
	return text ? text.split("\n") : [];
}

function diffStats(details: unknown): string | undefined {
	if (!details || typeof details !== "object" || !("diff" in details) || typeof details.diff !== "string") {
		return undefined;
	}
	let added = 0;
	let removed = 0;
	for (const line of details.diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return `+${added} -${removed}`;
}

/** One-line outcome for a finished, collapsed tool row. */
export function summarizeToolResult(name: string, result: ToolResultLike): string {
	const details = result.details;
	if (
		details &&
		typeof details === "object" &&
		"backgroundTaskId" in details &&
		typeof details.backgroundTaskId === "string"
	) {
		return `moved to background as ${details.backgroundTaskId}`;
	}
	if (name === "edit") {
		const stats = diffStats(result.details);
		if (stats) return stats;
	}
	const lineCount = resultTextLines(result).length;
	if (lineCount === 0) return result.content.some((block) => block.type === "image") ? "image" : "no output";
	return `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
}
