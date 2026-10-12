/**
 * Glyph presets for interactive chrome. `unicode` is the default; `ascii`
 * is selected automatically for dumb terminals and non-UTF-8 locales.
 * Every glyph must occupy exactly one terminal cell.
 */

export type SymbolPreset = "unicode" | "nerd" | "ascii";

export type SymbolKey =
	| "logo"
	| "bullet"
	| "toolPending"
	| "toolSuccess"
	| "branch"
	| "ahead"
	| "behind"
	| "dirty"
	| "gutter"
	| "boxTopLeft"
	| "boxTopRight"
	| "boxBottomLeft"
	| "boxBottomRight"
	| "boxHorizontal"
	| "boxVertical"
	| "separator"
	| "ellipsis"
	| "warning"
	| "error"
	| "update"
	| "prompt"
	| "runDone";

const UNICODE: Record<SymbolKey, string> = {
	logo: "❄",
	bullet: "●",
	toolPending: "›",
	toolSuccess: "✓",
	branch: "⎇",
	ahead: "↑",
	behind: "↓",
	dirty: "±",
	gutter: "⎿",
	boxTopLeft: "╭",
	boxTopRight: "╮",
	boxBottomLeft: "╰",
	boxBottomRight: "╯",
	boxHorizontal: "─",
	boxVertical: "│",
	separator: "·",
	ellipsis: "…",
	warning: "⚠",
	error: "✗",
	update: "↑",
	prompt: "❯",
	runDone: "✻",
};

const SYMBOL_PRESETS: Record<SymbolPreset, Record<SymbolKey, string>> = {
	unicode: UNICODE,
	// Nerd Fonts v3 codepoints: nf-md-snowflake, nf-fa-warning, nf-fa-times_circle, nf-fa-arrow_circle_up.
	nerd: { ...UNICODE, logo: "\u{f0717}", warning: "", error: "", update: "" },
	ascii: {
		logo: "*",
		bullet: "*",
		toolPending: ">",
		toolSuccess: "+",
		branch: "@",
		ahead: "+",
		behind: "-",
		dirty: "~",
		gutter: "L",
		boxTopLeft: "+",
		boxTopRight: "+",
		boxBottomLeft: "+",
		boxBottomRight: "+",
		boxHorizontal: "-",
		boxVertical: "|",
		separator: "-",
		ellipsis: "...",
		warning: "!",
		error: "x",
		update: "^",
		prompt: ">",
		runDone: "*",
	},
};

export function resolveDefaultSymbolPreset(env: NodeJS.ProcessEnv): SymbolPreset {
	if (env.TERM === "dumb") return "ascii";
	const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
	if (locale && !/utf-?8/i.test(locale)) return "ascii";
	return "unicode";
}

let activePreset: SymbolPreset = resolveDefaultSymbolPreset(process.env);

export function setSymbolPreset(preset: SymbolPreset): void {
	activePreset = preset;
}

export function getSymbolPreset(): SymbolPreset {
	return activePreset;
}

export function sym(key: SymbolKey): string {
	return SYMBOL_PRESETS[activePreset][key];
}

export function getSymbolTable(preset: SymbolPreset): Readonly<Record<SymbolKey, string>> {
	return SYMBOL_PRESETS[preset];
}
