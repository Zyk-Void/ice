/** Canonical list of path-like argument keys across all Ice tools. */
export const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;

export const extractPath = (args?: Record<string, unknown> | null): string | null => {
	if (!args || typeof args !== "object") return null;
	for (const key of PATH_KEYS) {
		if (typeof args[key] === "string") return args[key] as string;
	}
	return null;
};

export const summarizeToolArgs = (args?: Record<string, unknown> | null): string => {
	if (!args || typeof args !== "object") return "";
	const path = extractPath(args);
	if (path) return `path=${path}`;
	if (typeof args.command === "string") return `command=${args.command}`;
	if (typeof args.query === "string") return `query=${args.query}`;
	return Object.keys(args).join(", ");
};
