import type {
	AppearanceSettingsV2,
	IndicatorAppearance,
	StatusIndicatorAppearance,
	TextPresentation,
} from "./appearance-types.ts";

export const APPEARANCE_VERSION = 2 as const;

export const DEFAULT_THINKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const DEFAULT_THINKING_VERBS = [
	"Thinking",
	"Reasoning",
	"Considering",
	"Working",
	"Analyzing",
	"Planning",
] as const;

/** No-override text presentation: renderers keep their built-in styling. */
export function defaultTextPresentation(): TextPresentation {
	return {
		foreground: { kind: "terminal-default" },
		background: { kind: "terminal-default" },
		styles: [],
	};
}

function defaultIndicator(): IndicatorAppearance {
	return {
		frames: [...DEFAULT_THINKING_FRAMES],
		intervalMs: 80,
		reverseMirror: false,
		color: { kind: "theme", token: "accent" },
	};
}

function defaultStatusIndicator(
	colorToken: IndicatorAppearance["color"] = { kind: "theme", token: "accent" },
): StatusIndicatorAppearance {
	return { indicator: { ...defaultIndicator(), color: colorToken }, label: defaultTextPresentation() };
}

export function createDefaultAppearance(): AppearanceSettingsV2 {
	return {
		version: 2,
		userMessage: {
			format: "{message}",
			styles: [],
			foreground: { kind: "theme", token: "userMessageText" },
			background: { kind: "theme", token: "userMessageBg" },
			borderStyle: "none",
			borderColor: { kind: "theme", token: "border" },
			paddingX: 1,
			paddingY: 0,
			fitToContent: false,
		},
		assistantMessage: {
			paddingX: 0,
			paddingY: 0,
			background: { kind: "terminal-default" },
			borderStyle: "none",
			borderColor: { kind: "theme", token: "border" },
		},
		inputBox: {
			borderStyle: "single",
			idleBorderColor: { kind: "theme", token: "border" },
			activeBorderColor: { kind: "theme", token: "border" },
			paddingX: 0,
		},
		thinking: {
			indicator: defaultIndicator(),
			label: {
				format: "{verb}...",
				verbs: [...DEFAULT_THINKING_VERBS],
				selection: "cycle",
			},
			block: {
				showByDefault: true,
				hiddenLabel: "Thinking...",
				styles: ["italic"],
				foreground: { kind: "theme", token: "thinkingText" },
			},
		},
		statusIndicators: {
			working: defaultStatusIndicator(),
			retry: defaultStatusIndicator({ kind: "theme", token: "warning" }),
			compaction: defaultStatusIndicator({ kind: "theme", token: "muted" }),
			branchSummary: defaultStatusIndicator({ kind: "theme", token: "muted" }),
		},
		markdown: {
			tableStyle: "unicode",
			body: defaultTextPresentation(),
			headings: { base: defaultTextPresentation(), overrides: {} },
			strong: defaultTextPresentation(),
			emphasis: defaultTextPresentation(),
			strikethrough: defaultTextPresentation(),
			link: defaultTextPresentation(),
			linkUrl: defaultTextPresentation(),
			inlineCode: defaultTextPresentation(),
			codeBlock: {
				text: defaultTextPresentation(),
				background: { kind: "terminal-default" },
				borderStyle: "none",
				borderColor: { kind: "theme", token: "mdCodeBlockBorder" },
				paddingX: 0,
				paddingY: 0,
			},
			quote: {
				text: defaultTextPresentation(),
				borderStyle: "none",
				borderColor: { kind: "theme", token: "mdQuoteBorder" },
				paddingX: 0,
			},
			listBullet: defaultTextPresentation(),
			horizontalRule: defaultTextPresentation(),
		},
		tools: {
			paddingX: 1,
			paddingY: 1,
			title: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "toolTitle" }, styles: ["bold"] },
			output: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "toolOutput" } },
			states: {
				pending: { background: { kind: "theme", token: "toolPendingBg" } },
				success: { background: { kind: "theme", token: "toolSuccessBg" } },
				error: { background: { kind: "theme", token: "toolErrorBg" } },
			},
		},
		bash: {
			borderStyle: "top-bottom-single",
			borderColor: { kind: "theme", token: "bashMode" },
			paddingX: 1,
			command: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "bashMode" }, styles: ["bold"] },
			output: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "muted" } },
			status: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "muted" } },
		},
		diff: {
			added: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "toolDiffAdded" } },
			removed: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "toolDiffRemoved" } },
			context: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "toolDiffContext" } },
		},
		systemCards: {
			borderStyle: "none",
			borderColor: { kind: "theme", token: "borderMuted" },
			background: { kind: "theme", token: "customMessageBg" },
			paddingX: 1,
			paddingY: 1,
			label: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "customMessageLabel" } },
			body: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "customMessageText" } },
		},
		footer: {
			order: [
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
			],
			visible: {
				cwd: true,
				branch: true,
				session: true,
				usage: true,
				cache: true,
				cost: true,
				context: true,
				provider: true,
				model: true,
				thinking: true,
				extensions: true,
			},
			separator: " • ",
			primary: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "dim" } },
			secondary: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "dim" } },
			extensions: defaultTextPresentation(),
		},
		chrome: {
			borderStyle: "none",
			borderColor: { kind: "theme", token: "border" },
			selectedForeground: { kind: "theme", token: "text" },
			selectedBackground: { kind: "theme", token: "selectedBg" },
			selectedStyles: [],
			description: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "muted" } },
			hint: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "dim" } },
			scrollbarTrack: { kind: "terminal-default" },
			scrollbarThumb: { kind: "theme", token: "scrollbarThumb" },
		},
		subagentChrome: {
			borderStyle: "none",
			borderColor: { kind: "theme", token: "border" },
			selectedForeground: { kind: "theme", token: "text" },
			selectedBackground: { kind: "theme", token: "selectedBg" },
			selectedStyles: [],
			running: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "accent" } },
			completed: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "muted" } },
			failed: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "error" } },
			attention: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "warning" } },
			muted: { ...defaultTextPresentation(), foreground: { kind: "theme", token: "dim" } },
		},
		inputHighlighters: [],
	};
}
