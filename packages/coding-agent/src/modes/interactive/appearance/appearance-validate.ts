import { isThemeBgToken, isThemeColorToken } from "../theme/theme.ts";
import { createDefaultAppearance } from "./appearance-defaults.ts";
import { migrateAppearanceV1ToV2 } from "./appearance-migrate.ts";
import type {
	AppearanceBorderStyle,
	AppearanceColor,
	AppearanceInputBorderStyle,
	AppearanceSettingsV2,
	AppearanceTableStyle,
	AppearanceTextStyle,
	FooterFieldId,
	TextPresentation,
} from "./appearance-types.ts";

export interface AppearanceValidationIssue {
	path: string;
	message: string;
}

export interface AppearanceValidationResult {
	valid: boolean;
	appearance: AppearanceSettingsV2;
	issues: AppearanceValidationIssue[];
}

const TEXT_STYLES: readonly AppearanceTextStyle[] = ["bold", "italic", "underline", "strikethrough", "inverse"];

const BORDER_STYLES: readonly AppearanceBorderStyle[] = [
	"none",
	"single",
	"double",
	"round",
	"bold",
	"single-double",
	"double-single",
	"classic",
	"top-bottom-single",
	"top-bottom-double",
	"top-bottom-bold",
];

const INPUT_BORDER_STYLES: readonly AppearanceInputBorderStyle[] = ["none", "single", "double", "round", "bold"];

const TABLE_STYLES: readonly AppearanceTableStyle[] = ["unicode", "ascii", "clean", "clean-top-bottom", "raw"];

const MAX_FORMAT_BYTES = 512;
const MAX_FRAME_UTF8_BYTES = 64;
const MAX_VERB_UTF8_BYTES = 128;
const MAX_LABEL_BYTES = 128;
const FOOTER_FIELDS: readonly FooterFieldId[] = [
	"cwd",
	"branch",
	"session",
	"usage",
	"cache",
	"cost",
	"context",
	"provider",
	"model",
	"thinking",
	"extensions",
];

function utf8Length(value: string): number {
	return new TextEncoder().encode(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function oneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
	fallback: T,
	path?: string,
	issues?: AppearanceValidationIssue[],
): T {
	if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
	if (value !== undefined && issues && path) {
		issues.push({ path, message: `expected one of ${(allowed as readonly string[]).join(", ")}` });
	}
	return fallback;
}

function normalizeStyles(value: unknown, fallback: AppearanceTextStyle[]): AppearanceTextStyle[] {
	if (!Array.isArray(value)) return [...fallback];
	const seen = new Set<AppearanceTextStyle>();
	for (const entry of value) {
		if (typeof entry === "string" && TEXT_STYLES.includes(entry as AppearanceTextStyle)) {
			seen.add(entry as AppearanceTextStyle);
		}
	}
	return [...seen];
}

function boolOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeFooterOrder(value: unknown, fallback: FooterFieldId[]): FooterFieldId[] {
	if (!Array.isArray(value)) return [...fallback];
	const result: FooterFieldId[] = [];
	for (const entry of value) {
		if (
			typeof entry === "string" &&
			FOOTER_FIELDS.includes(entry as FooterFieldId) &&
			!result.includes(entry as FooterFieldId)
		) {
			result.push(entry as FooterFieldId);
		}
	}
	for (const entry of fallback) if (!result.includes(entry)) result.push(entry);
	return result;
}

function normalizePlainText(
	value: unknown,
	fallback: string,
	maxBytes: number,
	path: string,
	issues: AppearanceValidationIssue[],
): string {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || utf8Length(value) > maxBytes || /[\x00-\x1f\x7f]/.test(value)) {
		issues.push({ path, message: `expected plain text up to ${maxBytes} UTF-8 bytes` });
		return fallback;
	}
	return value;
}

function isValidHexColor(value: string): boolean {
	// ANSI output has no alpha channel; 8-digit hex would render opaque with
	// different semantics than the author wrote, so only 3/6-digit forms pass.
	return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

function isValidRgbColor(value: string): boolean {
	const match = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(value);
	if (!match) return false;
	return match.slice(1).every((part) => {
		const n = Number(part);
		return Number.isInteger(n) && n >= 0 && n <= 255;
	});
}

function isValidHslColor(value: string): boolean {
	const match = /^hsl\(\s*(\d{1,3}(?:\.\d+)?)\s*,\s*(\d{1,3}(?:\.\d+)?)%\s*,\s*(\d{1,3}(?:\.\d+)?)%\s*\)$/.exec(value);
	if (!match) return false;
	const h = Number(match[1]);
	const s = Number(match[2]);
	const l = Number(match[3]);
	return h >= 0 && h <= 360 && s >= 0 && s <= 100 && l >= 0 && l <= 100;
}

type AppearanceColorRole = "fg" | "bg";

function normalizeColor(
	value: unknown,
	fallback: AppearanceColor,
	allowNone: boolean,
	role: AppearanceColorRole,
	path: string,
	issues: AppearanceValidationIssue[],
): AppearanceColor {
	if (value === undefined) return structuredClone(fallback);
	if (!isRecord(value) || typeof value.kind !== "string") {
		issues.push({ path, message: "expected a color object" });
		return structuredClone(fallback);
	}
	switch (value.kind) {
		case "theme": {
			if (typeof value.token !== "string" || value.token.length === 0 || value.token.length > 128) {
				issues.push({ path, message: "theme color needs a token name" });
				return structuredClone(fallback);
			}
			const known = role === "bg" ? isThemeBgToken(value.token) : isThemeColorToken(value.token);
			if (!known) {
				issues.push({ path, message: `unknown theme token "${value.token}"` });
				return structuredClone(fallback);
			}
			return { kind: "theme", token: value.token };
		}
		case "custom":
			if (typeof value.value !== "string" || value.value.length > 128) {
				issues.push({ path, message: "custom color needs a value" });
				return structuredClone(fallback);
			}
			if (!isValidHexColor(value.value) && !isValidRgbColor(value.value) && !isValidHslColor(value.value)) {
				issues.push({ path, message: "unsupported custom color value" });
				return structuredClone(fallback);
			}
			return { kind: "custom", value: value.value };
		case "terminal-index": {
			const index = value.index;
			if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 255) {
				issues.push({ path, message: "terminal index must be an integer 0-255" });
				return structuredClone(fallback);
			}
			return { kind: "terminal-index", index };
		}
		case "terminal-default":
			return { kind: "terminal-default" };
		case "none":
			if (!allowNone) {
				issues.push({ path, message: "transparent color is not allowed here" });
				return structuredClone(fallback);
			}
			return { kind: "none" };
		default:
			issues.push({ path, message: `unknown color kind "${value.kind}"` });
			return structuredClone(fallback);
	}
}

function normalizeTextPresentation(
	value: unknown,
	fallback: TextPresentation,
	role: AppearanceColorRole,
	path: string,
	issues: AppearanceValidationIssue[],
): TextPresentation {
	const source = isRecord(value) ? value : {};
	const base = structuredClone(fallback);
	return {
		foreground: normalizeColor(source.foreground, base.foreground, false, "fg", `${path}.foreground`, issues),
		background: normalizeColor(source.background, base.background, role === "bg", "bg", `${path}.background`, issues),
		styles: normalizeStyles(source.styles, base.styles),
	};
}

function countPlaceholder(format: string, placeholder: string): number {
	let count = 0;
	let index = format.indexOf(placeholder, 0);
	while (index !== -1) {
		count++;
		index = format.indexOf(placeholder, index + placeholder.length);
	}
	return count;
}

function normalizeFormat(
	value: unknown,
	placeholder: "{message}" | "{verb}",
	fallback: string,
	path: string,
	issues: AppearanceValidationIssue[],
): string {
	if (typeof value !== "string") {
		if (value !== undefined) issues.push({ path, message: "expected a format string" });
		return fallback;
	}
	if (utf8Length(value) > MAX_FORMAT_BYTES) {
		issues.push({ path, message: "format string is too long" });
		return fallback;
	}
	if (countPlaceholder(value, placeholder) > 1) {
		issues.push({ path, message: `${placeholder} may appear at most once` });
		return fallback;
	}
	const withoutKnown = value.split(placeholder).join("");
	const unknownPlaceholder = /\{[A-Za-z][A-Za-z0-9_-]*\}/.exec(withoutKnown);
	if (unknownPlaceholder) {
		issues.push({ path, message: `unknown placeholder "${unknownPlaceholder[0]}"` });
		return fallback;
	}
	if (!value.includes(placeholder)) {
		issues.push({ path, message: `${placeholder} is required` });
		return fallback;
	}
	return value;
}

function normalizeFrames(
	value: unknown,
	fallback: string[],
	path: string,
	issues: AppearanceValidationIssue[],
): string[] {
	if (!Array.isArray(value)) {
		if (value !== undefined) issues.push({ path, message: "expected a frame list" });
		return [...fallback];
	}
	const frames: string[] = [];
	for (const entry of value.slice(0, 128)) {
		if (typeof entry !== "string" || entry.length === 0) continue;
		if (utf8Length(entry) > MAX_FRAME_UTF8_BYTES) continue;
		frames.push(entry);
		if (frames.length >= 128) break;
	}
	if (frames.length === 0) {
		issues.push({ path, message: "at least one frame is required" });
		return [...fallback];
	}
	return frames;
}

function normalizeVerbs(value: unknown, fallback: string[], issues: AppearanceValidationIssue[]): string[] {
	if (!Array.isArray(value)) {
		if (value !== undefined) issues.push({ path: "thinking.label.verbs", message: "expected a verb list" });
		return [...fallback];
	}
	const verbs: string[] = [];
	for (const entry of value.slice(0, 256)) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed) continue;
		if (utf8Length(trimmed) > MAX_VERB_UTF8_BYTES) continue;
		if (!verbs.includes(trimmed)) verbs.push(trimmed);
		if (verbs.length >= 256) break;
	}
	if (verbs.length === 0) {
		issues.push({ path: "thinking.label.verbs", message: "at least one verb is required" });
		return [...fallback];
	}
	return verbs;
}

function normalizeIndicator(
	value: unknown,
	fallback: AppearanceSettingsV2["thinking"]["indicator"],
	path: string,
	issues: AppearanceValidationIssue[],
): AppearanceSettingsV2["thinking"]["indicator"] {
	const source = isRecord(value) ? value : {};
	return {
		frames: normalizeFrames(source.frames, fallback.frames, path, issues),
		intervalMs: clampInt(source.intervalMs, 16, 5000, fallback.intervalMs),
		reverseMirror: boolOr(source.reverseMirror, fallback.reverseMirror),
		color: normalizeColor(source.color, fallback.color, false, "fg", `${path}.color`, issues),
	};
}

function normalizeStatusIndicator(
	value: unknown,
	fallback: AppearanceSettingsV2["statusIndicators"]["working"],
	path: string,
	issues: AppearanceValidationIssue[],
): AppearanceSettingsV2["statusIndicators"]["working"] {
	const source = isRecord(value) ? value : {};
	return {
		indicator: normalizeIndicator(source.indicator, fallback.indicator, `${path}.indicator`, issues),
		label: normalizeTextPresentation(source.label, fallback.label, "fg", `${path}.label`, issues),
	};
}

const MAX_HIGHLIGHTER_RULES = 64;
const MAX_HIGHLIGHTER_PATTERN_CHARS = 128;

function normalizeHighlighterRules(
	value: unknown,
	issues: AppearanceValidationIssue[],
): AppearanceSettingsV2["inputHighlighters"] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		issues.push({ path: "inputHighlighters", message: "expected a rule list" });
		return [];
	}
	const rules: AppearanceSettingsV2["inputHighlighters"] = [];
	const seenIds = new Set<string>();
	for (const [index, entry] of value.slice(0, MAX_HIGHLIGHTER_RULES + 1).entries()) {
		const path = `inputHighlighters[${index}]`;
		if (!isRecord(entry)) {
			issues.push({ path, message: "expected a rule object" });
			continue;
		}
		const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : `rule-${index}`;
		if (seenIds.has(id)) {
			issues.push({ path: `${path}.id`, message: "duplicate rule id" });
			continue;
		}
		seenIds.add(id);
		const matcher = isRecord(entry.matcher) ? entry.matcher : {};
		if (matcher.kind !== "literal") {
			issues.push({ path: `${path}.matcher.kind`, message: "only literal matchers are supported" });
			continue;
		}
		const pattern = typeof matcher.pattern === "string" ? matcher.pattern : "";
		if (pattern.length === 0 || pattern.length > MAX_HIGHLIGHTER_PATTERN_CHARS) {
			issues.push({ path: `${path}.matcher.pattern`, message: "pattern must be 1-128 characters" });
			continue;
		}
		rules.push({
			id,
			name: typeof entry.name === "string" ? entry.name.slice(0, 64) : id,
			enabled: entry.enabled !== false,
			matcher: { kind: "literal", pattern, caseSensitive: matcher.caseSensitive !== false },
			styles: normalizeStyles(entry.styles, []),
			foreground: normalizeColor(
				entry.foreground,
				{ kind: "terminal-default" },
				false,
				"fg",
				`${path}.foreground`,
				issues,
			),
			background: normalizeColor(
				entry.background,
				{ kind: "terminal-default" },
				true,
				"bg",
				`${path}.background`,
				issues,
			),
			priority: clampInt(entry.priority, 0, 1000, index),
		});
	}
	if (value.length > MAX_HIGHLIGHTER_RULES) {
		issues.push({ path: "inputHighlighters", message: "at most 64 rules are supported" });
	}
	return rules;
}

export function validateAppearance(value: unknown): AppearanceValidationResult {
	const defaults = createDefaultAppearance();
	const issues: AppearanceValidationIssue[] = [];
	if (value === undefined) {
		return { valid: true, appearance: defaults, issues };
	}
	if (!isRecord(value)) {
		issues.push({ path: "appearance", message: "expected an object" });
		return { valid: false, appearance: defaults, issues };
	}
	if (value.version === 1) {
		return validateAppearanceV2(migrateAppearanceV1ToV2(value), issues);
	}
	if (value.version !== 2) {
		issues.push({ path: "appearance.version", message: "unsupported appearance version" });
		return { valid: false, appearance: defaults, issues };
	}
	return validateAppearanceV2(value, issues);
}

function validateAppearanceV2(value: unknown, issues: AppearanceValidationIssue[]): AppearanceValidationResult {
	const defaults = createDefaultAppearance();
	const raw = isRecord(value) ? value : {};
	const userMessage = isRecord(raw.userMessage) ? raw.userMessage : {};
	const assistantMessage = isRecord(raw.assistantMessage) ? raw.assistantMessage : {};
	const inputBox = isRecord(raw.inputBox) ? raw.inputBox : {};
	const thinking = isRecord(raw.thinking) ? raw.thinking : {};
	const indicator = isRecord(thinking.indicator) ? thinking.indicator : {};
	const label = isRecord(thinking.label) ? thinking.label : {};
	const block = isRecord(thinking.block) ? thinking.block : {};
	const statusIndicators = isRecord(raw.statusIndicators) ? raw.statusIndicators : {};
	const markdown = isRecord(raw.markdown) ? raw.markdown : {};
	const headings = isRecord(markdown.headings) ? markdown.headings : {};
	const headingOverrides = isRecord(headings.overrides) ? headings.overrides : {};
	const codeBlock = isRecord(markdown.codeBlock) ? markdown.codeBlock : {};
	const quote = isRecord(markdown.quote) ? markdown.quote : {};
	const tools = isRecord(raw.tools) ? raw.tools : {};
	const toolStates = isRecord(tools.states) ? tools.states : {};
	const bash = isRecord(raw.bash) ? raw.bash : {};
	const diff = isRecord(raw.diff) ? raw.diff : {};
	const systemCards = isRecord(raw.systemCards) ? raw.systemCards : {};
	const footer = isRecord(raw.footer) ? raw.footer : {};
	const footerVisible = isRecord(footer.visible) ? footer.visible : {};
	const chrome = isRecord(raw.chrome) ? raw.chrome : {};
	const subagentChrome = isRecord(raw.subagentChrome) ? raw.subagentChrome : {};

	const appearance: AppearanceSettingsV2 = {
		version: 2,
		userMessage: {
			format: normalizeFormat(
				userMessage.format,
				"{message}",
				defaults.userMessage.format,
				"userMessage.format",
				issues,
			),
			styles: normalizeStyles(userMessage.styles, defaults.userMessage.styles),
			foreground: normalizeColor(
				userMessage.foreground,
				defaults.userMessage.foreground,
				false,
				"fg",
				"userMessage.foreground",
				issues,
			),
			background: normalizeColor(
				userMessage.background,
				defaults.userMessage.background,
				true,
				"bg",
				"userMessage.background",
				issues,
			),
			borderStyle: oneOf(
				userMessage.borderStyle,
				BORDER_STYLES,
				defaults.userMessage.borderStyle,
				"userMessage.borderStyle",
				issues,
			),
			borderColor: normalizeColor(
				userMessage.borderColor,
				defaults.userMessage.borderColor,
				false,
				"fg",
				"userMessage.borderColor",
				issues,
			),
			paddingX: clampInt(userMessage.paddingX, 0, 8, defaults.userMessage.paddingX),
			paddingY: clampInt(userMessage.paddingY, 0, 4, defaults.userMessage.paddingY),
			fitToContent: boolOr(userMessage.fitToContent, defaults.userMessage.fitToContent),
		},
		assistantMessage: {
			paddingX: clampInt(assistantMessage.paddingX, 0, 8, defaults.assistantMessage.paddingX),
			paddingY: clampInt(assistantMessage.paddingY, 0, 4, defaults.assistantMessage.paddingY),
			background: normalizeColor(
				assistantMessage.background,
				defaults.assistantMessage.background,
				true,
				"bg",
				"assistantMessage.background",
				issues,
			),
			borderStyle: oneOf(
				assistantMessage.borderStyle,
				BORDER_STYLES,
				defaults.assistantMessage.borderStyle,
				"assistantMessage.borderStyle",
				issues,
			),
			borderColor: normalizeColor(
				assistantMessage.borderColor,
				defaults.assistantMessage.borderColor,
				false,
				"fg",
				"assistantMessage.borderColor",
				issues,
			),
		},
		inputBox: {
			borderStyle: oneOf(
				inputBox.borderStyle,
				INPUT_BORDER_STYLES,
				defaults.inputBox.borderStyle,
				"inputBox.borderStyle",
				issues,
			),
			idleBorderColor: normalizeColor(
				inputBox.idleBorderColor,
				defaults.inputBox.idleBorderColor,
				false,
				"fg",
				"inputBox.idleBorderColor",
				issues,
			),
			activeBorderColor: normalizeColor(
				inputBox.activeBorderColor,
				defaults.inputBox.activeBorderColor,
				false,
				"fg",
				"inputBox.activeBorderColor",
				issues,
			),
			paddingX: clampInt(inputBox.paddingX, 0, 8, defaults.inputBox.paddingX),
		},
		thinking: {
			indicator: normalizeIndicator(indicator, defaults.thinking.indicator, "thinking.indicator", issues),
			label: {
				format: normalizeFormat(
					label.format,
					"{verb}",
					defaults.thinking.label.format,
					"thinking.label.format",
					issues,
				),
				verbs: normalizeVerbs(label.verbs, defaults.thinking.label.verbs, issues),
				selection: label.selection === "random" ? "random" : "cycle",
			},
			block: {
				showByDefault: boolOr(block.showByDefault, defaults.thinking.block.showByDefault),
				// An empty label hides thinking blocks entirely instead of showing a placeholder.
				hiddenLabel:
					typeof block.hiddenLabel === "string" && utf8Length(block.hiddenLabel) <= MAX_LABEL_BYTES
						? block.hiddenLabel
						: defaults.thinking.block.hiddenLabel,
				styles: normalizeStyles(block.styles, defaults.thinking.block.styles),
				foreground: normalizeColor(
					block.foreground,
					defaults.thinking.block.foreground,
					false,
					"fg",
					"thinking.block.foreground",
					issues,
				),
			},
		},
		statusIndicators: {
			working: normalizeStatusIndicator(
				statusIndicators.working,
				defaults.statusIndicators.working,
				"statusIndicators.working",
				issues,
			),
			retry: normalizeStatusIndicator(
				statusIndicators.retry,
				defaults.statusIndicators.retry,
				"statusIndicators.retry",
				issues,
			),
			compaction: normalizeStatusIndicator(
				statusIndicators.compaction,
				defaults.statusIndicators.compaction,
				"statusIndicators.compaction",
				issues,
			),
			branchSummary: normalizeStatusIndicator(
				statusIndicators.branchSummary,
				defaults.statusIndicators.branchSummary,
				"statusIndicators.branchSummary",
				issues,
			),
		},
		markdown: {
			tableStyle: oneOf(
				markdown.tableStyle,
				TABLE_STYLES,
				defaults.markdown.tableStyle,
				"markdown.tableStyle",
				issues,
			),
			body: normalizeTextPresentation(markdown.body, defaults.markdown.body, "fg", "markdown.body", issues),
			headings: {
				base: normalizeTextPresentation(
					headings.base,
					defaults.markdown.headings.base,
					"fg",
					"markdown.headings.base",
					issues,
				),
				overrides: {
					h1: headingOverrides.h1
						? normalizeTextPresentation(
								headingOverrides.h1,
								defaults.markdown.headings.base,
								"fg",
								"markdown.headings.overrides.h1",
								issues,
							)
						: undefined,
					h2: headingOverrides.h2
						? normalizeTextPresentation(
								headingOverrides.h2,
								defaults.markdown.headings.base,
								"fg",
								"markdown.headings.overrides.h2",
								issues,
							)
						: undefined,
					h3: headingOverrides.h3
						? normalizeTextPresentation(
								headingOverrides.h3,
								defaults.markdown.headings.base,
								"fg",
								"markdown.headings.overrides.h3",
								issues,
							)
						: undefined,
					h4: headingOverrides.h4
						? normalizeTextPresentation(
								headingOverrides.h4,
								defaults.markdown.headings.base,
								"fg",
								"markdown.headings.overrides.h4",
								issues,
							)
						: undefined,
					h5: headingOverrides.h5
						? normalizeTextPresentation(
								headingOverrides.h5,
								defaults.markdown.headings.base,
								"fg",
								"markdown.headings.overrides.h5",
								issues,
							)
						: undefined,
					h6: headingOverrides.h6
						? normalizeTextPresentation(
								headingOverrides.h6,
								defaults.markdown.headings.base,
								"fg",
								"markdown.headings.overrides.h6",
								issues,
							)
						: undefined,
				},
			},
			strong: normalizeTextPresentation(markdown.strong, defaults.markdown.strong, "fg", "markdown.strong", issues),
			emphasis: normalizeTextPresentation(
				markdown.emphasis,
				defaults.markdown.emphasis,
				"fg",
				"markdown.emphasis",
				issues,
			),
			strikethrough: normalizeTextPresentation(
				markdown.strikethrough,
				defaults.markdown.strikethrough,
				"fg",
				"markdown.strikethrough",
				issues,
			),
			link: normalizeTextPresentation(markdown.link, defaults.markdown.link, "fg", "markdown.link", issues),
			linkUrl: normalizeTextPresentation(
				markdown.linkUrl,
				defaults.markdown.linkUrl,
				"fg",
				"markdown.linkUrl",
				issues,
			),
			inlineCode: normalizeTextPresentation(
				markdown.inlineCode,
				defaults.markdown.inlineCode,
				"fg",
				"markdown.inlineCode",
				issues,
			),
			codeBlock: {
				text: normalizeTextPresentation(
					codeBlock.text,
					defaults.markdown.codeBlock.text,
					"fg",
					"markdown.codeBlock.text",
					issues,
				),
				background: normalizeColor(
					codeBlock.background,
					defaults.markdown.codeBlock.background,
					true,
					"bg",
					"markdown.codeBlock.background",
					issues,
				),
				borderStyle: oneOf(
					codeBlock.borderStyle,
					BORDER_STYLES,
					defaults.markdown.codeBlock.borderStyle,
					"markdown.codeBlock.borderStyle",
					issues,
				),
				borderColor: normalizeColor(
					codeBlock.borderColor,
					defaults.markdown.codeBlock.borderColor,
					false,
					"fg",
					"markdown.codeBlock.borderColor",
					issues,
				),
				paddingX: clampInt(codeBlock.paddingX, 0, 8, defaults.markdown.codeBlock.paddingX),
				paddingY: clampInt(codeBlock.paddingY, 0, 4, defaults.markdown.codeBlock.paddingY),
			},
			quote: {
				text: normalizeTextPresentation(
					quote.text,
					defaults.markdown.quote.text,
					"fg",
					"markdown.quote.text",
					issues,
				),
				borderStyle: oneOf(
					quote.borderStyle,
					BORDER_STYLES,
					defaults.markdown.quote.borderStyle,
					"markdown.quote.borderStyle",
					issues,
				),
				borderColor: normalizeColor(
					quote.borderColor,
					defaults.markdown.quote.borderColor,
					false,
					"fg",
					"markdown.quote.borderColor",
					issues,
				),
				paddingX: clampInt(quote.paddingX, 0, 8, defaults.markdown.quote.paddingX),
			},
			listBullet: normalizeTextPresentation(
				markdown.listBullet,
				defaults.markdown.listBullet,
				"fg",
				"markdown.listBullet",
				issues,
			),
			horizontalRule: normalizeTextPresentation(
				markdown.horizontalRule,
				defaults.markdown.horizontalRule,
				"fg",
				"markdown.horizontalRule",
				issues,
			),
		},
		tools: {
			paddingX: clampInt(tools.paddingX, 0, 8, defaults.tools.paddingX),
			paddingY: clampInt(tools.paddingY, 0, 4, defaults.tools.paddingY),
			title: normalizeTextPresentation(tools.title, defaults.tools.title, "fg", "tools.title", issues),
			output: normalizeTextPresentation(tools.output, defaults.tools.output, "fg", "tools.output", issues),
			states: {
				pending: {
					background: normalizeColor(
						isRecord(toolStates.pending) ? toolStates.pending.background : undefined,
						defaults.tools.states.pending.background,
						true,
						"bg",
						"tools.states.pending.background",
						issues,
					),
				},
				success: {
					background: normalizeColor(
						isRecord(toolStates.success) ? toolStates.success.background : undefined,
						defaults.tools.states.success.background,
						true,
						"bg",
						"tools.states.success.background",
						issues,
					),
				},
				error: {
					background: normalizeColor(
						isRecord(toolStates.error) ? toolStates.error.background : undefined,
						defaults.tools.states.error.background,
						true,
						"bg",
						"tools.states.error.background",
						issues,
					),
				},
			},
		},
		bash: {
			borderStyle: oneOf(bash.borderStyle, BORDER_STYLES, defaults.bash.borderStyle, "bash.borderStyle", issues),
			borderColor: normalizeColor(
				bash.borderColor,
				defaults.bash.borderColor,
				false,
				"fg",
				"bash.borderColor",
				issues,
			),
			paddingX: clampInt(bash.paddingX, 0, 8, defaults.bash.paddingX),
			command: normalizeTextPresentation(bash.command, defaults.bash.command, "fg", "bash.command", issues),
			output: normalizeTextPresentation(bash.output, defaults.bash.output, "fg", "bash.output", issues),
			status: normalizeTextPresentation(bash.status, defaults.bash.status, "fg", "bash.status", issues),
		},
		diff: {
			added: normalizeTextPresentation(diff.added, defaults.diff.added, "fg", "diff.added", issues),
			removed: normalizeTextPresentation(diff.removed, defaults.diff.removed, "fg", "diff.removed", issues),
			context: normalizeTextPresentation(diff.context, defaults.diff.context, "fg", "diff.context", issues),
		},
		systemCards: {
			borderStyle: oneOf(
				systemCards.borderStyle,
				BORDER_STYLES,
				defaults.systemCards.borderStyle,
				"systemCards.borderStyle",
				issues,
			),
			borderColor: normalizeColor(
				systemCards.borderColor,
				defaults.systemCards.borderColor,
				false,
				"fg",
				"systemCards.borderColor",
				issues,
			),
			background: normalizeColor(
				systemCards.background,
				defaults.systemCards.background,
				true,
				"bg",
				"systemCards.background",
				issues,
			),
			paddingX: clampInt(systemCards.paddingX, 0, 8, defaults.systemCards.paddingX),
			paddingY: clampInt(systemCards.paddingY, 0, 4, defaults.systemCards.paddingY),
			label: normalizeTextPresentation(
				systemCards.label,
				defaults.systemCards.label,
				"fg",
				"systemCards.label",
				issues,
			),
			body: normalizeTextPresentation(systemCards.body, defaults.systemCards.body, "fg", "systemCards.body", issues),
		},
		footer: {
			order: normalizeFooterOrder(footer.order, defaults.footer.order),
			visible: Object.fromEntries(
				FOOTER_FIELDS.map((field) => [field, boolOr(footerVisible[field], defaults.footer.visible[field])]),
			) as AppearanceSettingsV2["footer"]["visible"],
			separator: normalizePlainText(footer.separator, defaults.footer.separator, 32, "footer.separator", issues),
			primary: normalizeTextPresentation(footer.primary, defaults.footer.primary, "fg", "footer.primary", issues),
			secondary: normalizeTextPresentation(
				footer.secondary,
				defaults.footer.secondary,
				"fg",
				"footer.secondary",
				issues,
			),
			extensions: normalizeTextPresentation(
				footer.extensions,
				defaults.footer.extensions,
				"fg",
				"footer.extensions",
				issues,
			),
		},
		chrome: {
			borderStyle: oneOf(
				chrome.borderStyle,
				BORDER_STYLES,
				defaults.chrome.borderStyle,
				"chrome.borderStyle",
				issues,
			),
			borderColor: normalizeColor(
				chrome.borderColor,
				defaults.chrome.borderColor,
				false,
				"fg",
				"chrome.borderColor",
				issues,
			),
			selectedForeground: normalizeColor(
				chrome.selectedForeground,
				defaults.chrome.selectedForeground,
				false,
				"fg",
				"chrome.selectedForeground",
				issues,
			),
			selectedBackground: normalizeColor(
				chrome.selectedBackground,
				defaults.chrome.selectedBackground,
				true,
				"bg",
				"chrome.selectedBackground",
				issues,
			),
			selectedStyles: normalizeStyles(chrome.selectedStyles, defaults.chrome.selectedStyles),
			description: normalizeTextPresentation(
				chrome.description,
				defaults.chrome.description,
				"fg",
				"chrome.description",
				issues,
			),
			hint: normalizeTextPresentation(chrome.hint, defaults.chrome.hint, "fg", "chrome.hint", issues),
			scrollbarTrack: normalizeColor(
				chrome.scrollbarTrack,
				defaults.chrome.scrollbarTrack,
				true,
				"bg",
				"chrome.scrollbarTrack",
				issues,
			),
			scrollbarThumb: normalizeColor(
				chrome.scrollbarThumb,
				defaults.chrome.scrollbarThumb,
				true,
				"bg",
				"chrome.scrollbarThumb",
				issues,
			),
		},
		subagentChrome: {
			borderStyle: oneOf(
				subagentChrome.borderStyle,
				BORDER_STYLES,
				defaults.subagentChrome.borderStyle,
				"subagentChrome.borderStyle",
				issues,
			),
			borderColor: normalizeColor(
				subagentChrome.borderColor,
				defaults.subagentChrome.borderColor,
				false,
				"fg",
				"subagentChrome.borderColor",
				issues,
			),
			selectedForeground: normalizeColor(
				subagentChrome.selectedForeground,
				defaults.subagentChrome.selectedForeground,
				false,
				"fg",
				"subagentChrome.selectedForeground",
				issues,
			),
			selectedBackground: normalizeColor(
				subagentChrome.selectedBackground,
				defaults.subagentChrome.selectedBackground,
				true,
				"bg",
				"subagentChrome.selectedBackground",
				issues,
			),
			selectedStyles: normalizeStyles(subagentChrome.selectedStyles, defaults.subagentChrome.selectedStyles),
			running: normalizeTextPresentation(
				subagentChrome.running,
				defaults.subagentChrome.running,
				"fg",
				"subagentChrome.running",
				issues,
			),
			completed: normalizeTextPresentation(
				subagentChrome.completed,
				defaults.subagentChrome.completed,
				"fg",
				"subagentChrome.completed",
				issues,
			),
			failed: normalizeTextPresentation(
				subagentChrome.failed,
				defaults.subagentChrome.failed,
				"fg",
				"subagentChrome.failed",
				issues,
			),
			attention: normalizeTextPresentation(
				subagentChrome.attention,
				defaults.subagentChrome.attention,
				"fg",
				"subagentChrome.attention",
				issues,
			),
			muted: normalizeTextPresentation(
				subagentChrome.muted,
				defaults.subagentChrome.muted,
				"fg",
				"subagentChrome.muted",
				issues,
			),
		},
		inputHighlighters: normalizeHighlighterRules(raw.inputHighlighters, issues),
	};

	return { valid: issues.length === 0, appearance, issues };
}

export function resolveAppearanceColor(
	color: AppearanceColor,
	lookup: (token: string) => string | undefined,
): string | undefined {
	switch (color.kind) {
		case "custom":
			return color.value;
		case "theme":
			return lookup(color.token);
		case "terminal-default":
		case "none":
			return undefined;
	}
}
