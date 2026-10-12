/**
 * Subagent V2 permission subjects (Plan/subagent-rewrite.md section 9.2, P3.1).
 *
 * Each tool call becomes one or more subjects: the tool, the string its rule
 * patterns match against, and its ceiling class. A Bash command yields one
 * subject per subcommand so `a && b` needs both to pass; a file path outside
 * cwd adds an `external_directory` subject. Unknown tools fail safe to the
 * mutation class.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ChildSubjectClass } from "./rules.ts";

export interface PermissionSubject {
	tool: string;
	/** Matched by `tool(pattern)` rules; absent subjects match only bare `tool` rules. */
	value?: string;
	/** Path-style glob semantics for file subjects. */
	pathMode: boolean;
	subjectClass: ChildSubjectClass;
	/** Bash subject contains command substitution or a file redirection; it can never be auto-allowed. */
	opaque?: boolean;
}

export type AdapterAccess = "read-only" | "mutation" | "unknown";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

/**
 * Split a shell command into simple commands at `&&`, `||`, `;`, `|`, background `&`,
 * and newlines. Redirections such as `2>&1` are not separators. Quote-unaware, so it
 * may over-split, which only makes matching stricter.
 */
export function splitShellCommand(command: string): string[] {
	return command
		.split(/&&|\|\||;|\n|(?<![<>&|])&(?![>&])|(?<!\|)\|(?!\|)/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function hasCommandSubstitution(command: string): boolean {
	return command.includes("$(") || command.includes("`") || /<\(|>\(/.test(command);
}

/**
 * Output redirection to a file adds a write that a `bash(git status*)`-style grant never
 * approved. Descriptor duplication (`2>&1`, `>&2`, `2>&-`) and `/dev/null` are harmless.
 */
function hasFileRedirection(command: string): boolean {
	return />/.test(command.replace(/\d*>&(?:\d+|-)|&?\d*>>?\s*\/dev\/null(?![\w/.-])/g, ""));
}

/** Path relative to cwd with `/` separators, or the absolute path when outside cwd. */
function pathSubject(cwd: string, input: unknown): { value: string; outside: boolean; absolute: string } {
	const raw = typeof input === "string" && input.length > 0 ? input : ".";
	const absolute = resolve(cwd, raw);
	const rel = relative(cwd, absolute);
	const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
	return { value: outside ? absolute : rel === "" ? "." : rel.split(sep).join("/"), outside, absolute };
}

export function extractPermissionSubjects(input: {
	tool: string;
	args: Readonly<Record<string, unknown>>;
	cwd: string;
	/** Access class of a parent-owned adapter or MCP tool; unknown fails safe to mutation. */
	adapterAccess?: AdapterAccess;
}): PermissionSubject[] {
	const { tool, args, cwd } = input;
	if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) {
		const path = pathSubject(cwd, args.path);
		const subjects: PermissionSubject[] = [
			{ tool, value: path.value, pathMode: true, subjectClass: WRITE_TOOLS.has(tool) ? "edit-write" : "read" },
		];
		if (path.outside) {
			subjects.push({
				tool: "external_directory",
				value: path.absolute,
				pathMode: true,
				subjectClass: "external-directory",
			});
		}
		return subjects;
	}
	if (tool === "bash") {
		const command = typeof args.command === "string" ? args.command : "";
		const substituted = hasCommandSubstitution(command);
		const parts = splitShellCommand(command);
		return (parts.length > 0 ? parts : [command]).map((value): PermissionSubject => {
			const opaque = substituted || hasFileRedirection(value);
			return { tool, value, pathMode: false, subjectClass: "bash", ...(opaque ? { opaque } : {}) };
		});
	}
	if (tool === "agent") {
		const tasks = Array.isArray(args.tasks) ? args.tasks : [];
		const names = tasks.map((task) =>
			task && typeof task === "object" && typeof (task as { agent?: unknown }).agent === "string"
				? (task as { agent: string }).agent
				: "",
		);
		return (names.length > 0 ? names : [""]).map((value) => ({
			tool,
			...(value ? { value } : {}),
			pathMode: false,
			subjectClass: "delegation",
		}));
	}
	return [
		{
			tool,
			value: tool,
			pathMode: false,
			subjectClass: input.adapterAccess === "read-only" ? "read" : "mutation-adapter",
		},
	];
}

/**
 * Command prefix offered for a session-scoped "always allow" grant, for example
 * `git push` from `git push origin main`. Flags never count as subcommands.
 */
const SUBCOMMAND_TOOLS: Readonly<Record<string, number>> = Object.freeze({
	git: 2,
	npm: 2,
	pnpm: 2,
	yarn: 2,
	bun: 2,
	cargo: 2,
	docker: 2,
	kubectl: 2,
	go: 2,
	uv: 2,
	pip: 2,
	gh: 3,
	"npm run": 3,
	"pnpm run": 3,
	"yarn run": 3,
	"bun run": 3,
});

export function bashGrantPrefix(command: string): string {
	const tokens = command
		.trim()
		.split(/\s+/)
		.filter((token) => token && !token.startsWith("-"));
	for (let length = Math.min(tokens.length, 2); length > 0; length--) {
		const arity = SUBCOMMAND_TOOLS[tokens.slice(0, length).join(" ")];
		if (arity !== undefined) return tokens.slice(0, Math.min(arity, tokens.length)).join(" ");
	}
	return tokens[0] ?? "";
}
