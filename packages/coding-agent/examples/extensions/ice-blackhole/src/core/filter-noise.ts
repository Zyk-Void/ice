import type { NormalizedBlock } from "../types.ts";

const NOISE_TOOLS = new Set([
	"TodoWrite",
	"TodoRead",
	"ToolSearch",
	"WebSearch",
	"AskUser",
	"ExitSpecMode",
	"GenerateDroid",
]);

const NOISE_STRINGS = [
	"Continue from where you left off.",
	"No response requested.",
	"IMPORTANT: TodoWrite was not called yet.",
];

const XML_WRAPPER_RE = /<(system-reminder|ide_opened_file|command-message|context-window-usage)[^>]*>[\s\S]*?<\/\1>/g;

/** Return cleaned user text, or null if the block is noise. Cleans once. */
const cleanOrNull = (text: string): string | null => {
	const cleaned = text.replace(XML_WRAPPER_RE, "").trim();
	if (!cleaned) return null;
	if (NOISE_STRINGS.some((s) => cleaned === s || cleaned.includes(s))) {
		const remaining = NOISE_STRINGS.reduce((value, noise) => value.replaceAll(noise, "").trim(), cleaned);
		return remaining.length > 0 ? remaining : null;
	}
	return cleaned;
};

export const filterNoise = (blocks: NormalizedBlock[]): NormalizedBlock[] => {
	const out: NormalizedBlock[] = [];
	for (const b of blocks) {
		if (b.kind === "thinking") continue;
		if (b.kind === "tool_call" && NOISE_TOOLS.has(b.name)) continue;
		if (b.kind === "tool_result" && NOISE_TOOLS.has(b.name)) continue;
		if (b.kind === "user") {
			const cleaned = cleanOrNull(b.text);
			if (!cleaned) continue;
			out.push({ ...b, text: cleaned }); // preserve sourceIndex and any future fields
			continue;
		}
		out.push(b);
	}
	return out;
};
