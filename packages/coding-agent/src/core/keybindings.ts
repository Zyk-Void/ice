import {
	type Keybinding,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	type KeyId,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
} from "@zykairotis/ice-tui";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../config.ts";

export interface AppKeybindings {
	"app.interrupt": true;
	"app.clear": true;
	"app.exit": true;
	"app.suspend": true;
	"app.thinking.cycle": true;
	"app.model.cycleForward": true;
	"app.model.cycleBackward": true;
	"app.model.select": true;
	"app.model.toggleFavorite": true;
	"app.tools.expand": true;
	"app.tools.collapse": true;
	"app.tools.expandLast": true;
	"app.notices.show": true;
	"app.notices.dismiss": true;
	"app.notices.clear": true;
	"app.notices.copy": true;
	"app.tasks.background": true;
	"app.shells.open": true;
	"app.shells.stop": true;
	"app.shells.follow": true;
	"app.shortcuts.show": true;
	"app.subagents.attach": true;
	"app.subagents.open": true;
	"app.subagents.parent": true;
	"app.subagents.next": true;
	"app.subagents.previous": true;
	"app.subagents.takeControl": true;
	"app.agents.hub": true;
	"app.agents.stop": true;
	"app.agents.delete": true;
	"app.agents.approve": true;
	"app.agents.deny": true;
	"app.agents.approveSession": true;
	"app.agents.nextApproval": true;
	"app.thinking.toggle": true;
	"app.session.toggleNamedFilter": true;
	"app.editor.external": true;
	"app.message.copy": true;
	"app.message.followUp": true;
	"app.message.sendNow": true;
	"app.message.dequeue": true;
	"app.clipboard.pasteImage": true;
	"app.session.new": true;
	"app.session.tree": true;
	"app.session.fork": true;
	"app.session.resume": true;
	"app.tree.foldOrUp": true;
	"app.tree.unfoldOrDown": true;
	"app.tree.editLabel": true;
	"app.tree.toggleLabelTimestamp": true;
	"app.session.togglePath": true;
	"app.session.toggleSort": true;
	"app.session.rename": true;
	"app.session.delete": true;
	"app.session.deleteNoninvasive": true;
	"app.models.save": true;
	"app.models.enableAll": true;
	"app.models.clearAll": true;
	"app.models.toggleProvider": true;
	"app.models.reorderUp": true;
	"app.models.reorderDown": true;
	"app.tree.filter.default": true;
	"app.tree.filter.noTools": true;
	"app.tree.filter.userOnly": true;
	"app.tree.filter.labeledOnly": true;
	"app.tree.filter.all": true;
	"app.tree.filter.cycleForward": true;
	"app.tree.filter.cycleBackward": true;
}

export type AppKeybinding = keyof AppKeybindings;

declare module "@zykairotis/ice-tui" {
	interface Keybindings extends AppKeybindings {}
}

export const KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
	"app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
	"app.suspend": {
		defaultKeys: process.platform === "win32" ? [] : "ctrl+z",
		description: "Suspend to background",
	},
	"app.thinking.cycle": {
		defaultKeys: "shift+tab",
		description: "Cycle thinking level",
	},
	"app.model.cycleForward": {
		defaultKeys: "ctrl+p",
		description: "Cycle to next model",
	},
	"app.model.cycleBackward": {
		defaultKeys: "shift+ctrl+p",
		description: "Cycle to previous model",
	},
	"app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
	"app.model.toggleFavorite": { defaultKeys: "shift+f", description: "Toggle favorite in model selector" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
	"app.tools.collapse": { defaultKeys: "alt+o", description: "Collapse all tool output" },
	"app.tools.expandLast": { defaultKeys: "shift+alt+o", description: "Toggle the newest tool call" },
	"app.notices.show": { defaultKeys: "f2", description: "Show warnings and notices" },
	"app.notices.dismiss": { defaultKeys: "d", description: "Notices panel: dismiss the selected notice" },
	"app.notices.clear": {
		defaultKeys: "x",
		description: "Notices panel: dismiss every notice in the selected filter",
	},
	"app.notices.copy": { defaultKeys: "c", description: "Notices panel: copy the selected notice" },
	"app.shortcuts.show": {
		defaultKeys: "?",
		description: "Show keyboard shortcuts (only when the editor is empty)",
	},
	"app.tasks.background": {
		defaultKeys: "ctrl+b",
		description: "Move a running subagent wait to the background (falls through when nothing can be backgrounded)",
	},
	"app.shells.open": {
		defaultKeys: "down",
		description:
			"Open the Shells panel from an empty editor while background shells run (otherwise moves the cursor)",
	},
	"app.shells.stop": { defaultKeys: "x", description: "Shells panel: stop the selected background shell" },
	"app.shells.follow": {
		defaultKeys: "f",
		description: "Shells panel: follow the selected shell's live output in the foreground",
	},
	"app.subagents.attach": { defaultKeys: "right", description: "Attach to live subagent" },
	"app.subagents.open": { defaultKeys: "ctrl+shift+a", description: "Open the Agent Hub" },
	"app.subagents.parent": { defaultKeys: "shift+alt+left", description: "Return to the main agent view" },
	"app.subagents.next": {
		defaultKeys: "alt+right",
		description: "Show the next agent view (only while subagents exist and the editor is empty)",
	},
	"app.subagents.previous": {
		defaultKeys: "alt+left",
		description: "Show the previous agent view (only while subagents exist and the editor is empty)",
	},
	"app.subagents.takeControl": { defaultKeys: "ctrl+shift+enter", description: "Take control of live subagent" },
	"app.agents.hub": {
		defaultKeys: "left",
		description: "Open the Agent Hub from an empty editor while subagents exist; closes it inside the Hub",
	},
	"app.agents.stop": { defaultKeys: "s", description: "Agent Hub: stop the selected subagent's current turn" },
	"app.agents.delete": { defaultKeys: "shift+d", description: "Agent Hub: delete the selected stopped subagent" },
	"app.agents.approve": {
		defaultKeys: "y",
		description: "Agent Hub: approve the selected pending subagent request once",
	},
	"app.agents.deny": { defaultKeys: "n", description: "Agent Hub: deny the selected pending subagent request" },
	"app.agents.approveSession": {
		defaultKeys: "a",
		description: "Agent Hub: always allow the selected request's rule for that subagent",
	},
	"app.agents.nextApproval": {
		defaultKeys: "tab",
		description: "Agent Hub: select the next pending subagent request and its subagent",
	},

	"app.thinking.toggle": {
		defaultKeys: "ctrl+t",
		description: "Toggle thinking blocks",
	},
	"app.session.toggleNamedFilter": {
		defaultKeys: "ctrl+n",
		description: "Toggle named session filter",
	},
	"app.editor.external": {
		defaultKeys: "ctrl+g",
		description: "Open external editor",
	},
	"app.message.copy": {
		defaultKeys: "ctrl+x",
		description: "Copy message to clipboard",
	},
	"app.message.followUp": {
		defaultKeys: "alt+enter",
		description: "Queue follow-up message",
	},
	"app.message.sendNow": {
		defaultKeys: "ctrl+enter",
		description: "Send now: interrupt the current turn (running commands and subagents keep going in the background)",
	},
	"app.message.dequeue": {
		defaultKeys: "alt+up",
		description: "Restore queued messages",
	},
	"app.clipboard.pasteImage": {
		defaultKeys: process.platform === "win32" ? "alt+v" : "ctrl+v",
		description: "Paste image from clipboard (text fallback)",
	},
	"app.session.new": { defaultKeys: [], description: "Start a new session" },
	"app.session.tree": { defaultKeys: [], description: "Open session tree" },
	"app.session.fork": { defaultKeys: [], description: "Fork current session" },
	"app.session.resume": { defaultKeys: [], description: "Resume a session" },
	"app.tree.foldOrUp": {
		defaultKeys: process.platform === "darwin" ? ["alt+left", "ctrl+left"] : ["ctrl+left", "alt+left"],
		description: "Fold tree branch or move up",
	},
	"app.tree.unfoldOrDown": {
		defaultKeys: process.platform === "darwin" ? ["alt+right", "ctrl+right"] : ["ctrl+right", "alt+right"],
		description: "Unfold tree branch or move down",
	},
	"app.tree.editLabel": {
		defaultKeys: "shift+l",
		description: "Edit tree label",
	},
	"app.tree.toggleLabelTimestamp": {
		defaultKeys: "shift+t",
		description: "Toggle tree label timestamps",
	},
	"app.session.togglePath": {
		defaultKeys: "ctrl+p",
		description: "Toggle session path display",
	},
	"app.session.toggleSort": {
		defaultKeys: "ctrl+s",
		description: "Toggle session sort mode",
	},
	"app.session.rename": {
		defaultKeys: "ctrl+r",
		description: "Rename session",
	},
	"app.session.delete": {
		defaultKeys: "ctrl+d",
		description: "Delete session",
	},
	"app.session.deleteNoninvasive": {
		defaultKeys: "ctrl+backspace",
		description: "Delete session when query is empty",
	},
	"app.models.save": {
		defaultKeys: "ctrl+s",
		description: "Save model selection",
	},
	"app.models.enableAll": {
		defaultKeys: "ctrl+a",
		description: "Enable all models",
	},
	"app.models.clearAll": {
		defaultKeys: "ctrl+x",
		description: "Clear all models",
	},
	"app.models.toggleProvider": {
		defaultKeys: "ctrl+p",
		description: "Toggle all models for provider",
	},
	"app.models.reorderUp": {
		defaultKeys: "alt+up",
		description: "Move model up in order",
	},
	"app.models.reorderDown": {
		defaultKeys: "alt+down",
		description: "Move model down in order",
	},
	"app.tree.filter.default": {
		defaultKeys: "ctrl+d",
		description: "Tree filter: default view",
	},
	"app.tree.filter.noTools": {
		defaultKeys: "ctrl+t",
		description: "Tree filter: hide tool results",
	},
	"app.tree.filter.userOnly": {
		defaultKeys: "ctrl+u",
		description: "Tree filter: user messages only",
	},
	"app.tree.filter.labeledOnly": {
		defaultKeys: "ctrl+l",
		description: "Tree filter: labeled entries only",
	},
	"app.tree.filter.all": {
		defaultKeys: "ctrl+a",
		description: "Tree filter: show all entries",
	},
	"app.tree.filter.cycleForward": {
		defaultKeys: "ctrl+o",
		description: "Tree filter: cycle forward",
	},
	"app.tree.filter.cycleBackward": {
		defaultKeys: "shift+ctrl+o",
		description: "Tree filter: cycle backward",
	},
} as const satisfies KeybindingDefinitions;

const KEYBINDING_NAME_MIGRATIONS = {
	cursorUp: "tui.editor.cursorUp",
	cursorDown: "tui.editor.cursorDown",
	cursorLeft: "tui.editor.cursorLeft",
	cursorRight: "tui.editor.cursorRight",
	cursorWordLeft: "tui.editor.cursorWordLeft",
	cursorWordRight: "tui.editor.cursorWordRight",
	cursorLineStart: "tui.editor.cursorLineStart",
	cursorLineEnd: "tui.editor.cursorLineEnd",
	jumpForward: "tui.editor.jumpForward",
	jumpBackward: "tui.editor.jumpBackward",
	pageUp: "tui.editor.pageUp",
	pageDown: "tui.editor.pageDown",
	deleteCharBackward: "tui.editor.deleteCharBackward",
	deleteCharForward: "tui.editor.deleteCharForward",
	deleteWordBackward: "tui.editor.deleteWordBackward",
	deleteWordForward: "tui.editor.deleteWordForward",
	deleteToLineStart: "tui.editor.deleteToLineStart",
	deleteToLineEnd: "tui.editor.deleteToLineEnd",
	yank: "tui.editor.yank",
	yankPop: "tui.editor.yankPop",
	undo: "tui.editor.undo",
	newLine: "tui.input.newLine",
	submit: "tui.input.submit",
	tab: "tui.input.tab",
	copy: "tui.input.copy",
	selectUp: "tui.select.up",
	selectDown: "tui.select.down",
	selectPageUp: "tui.select.pageUp",
	selectPageDown: "tui.select.pageDown",
	selectConfirm: "tui.select.confirm",
	selectCancel: "tui.select.cancel",
	interrupt: "app.interrupt",
	clear: "app.clear",
	exit: "app.exit",
	suspend: "app.suspend",
	cycleThinkingLevel: "app.thinking.cycle",
	cycleModelForward: "app.model.cycleForward",
	cycleModelBackward: "app.model.cycleBackward",
	selectModel: "app.model.select",
	expandTools: "app.tools.expand",
	toggleThinking: "app.thinking.toggle",
	toggleSessionNamedFilter: "app.session.toggleNamedFilter",
	externalEditor: "app.editor.external",
	followUp: "app.message.followUp",
	sendNow: "app.message.sendNow",
	dequeue: "app.message.dequeue",
	pasteImage: "app.clipboard.pasteImage",
	newSession: "app.session.new",
	tree: "app.session.tree",
	fork: "app.session.fork",
	resume: "app.session.resume",
	treeFoldOrUp: "app.tree.foldOrUp",
	treeUnfoldOrDown: "app.tree.unfoldOrDown",
	treeEditLabel: "app.tree.editLabel",
	treeToggleLabelTimestamp: "app.tree.toggleLabelTimestamp",
	toggleSessionPath: "app.session.togglePath",
	toggleSessionSort: "app.session.toggleSort",
	renameSession: "app.session.rename",
	deleteSession: "app.session.delete",
	deleteSessionNoninvasive: "app.session.deleteNoninvasive",
} as const satisfies Record<string, Keybinding>;

function isLegacyKeybindingName(key: string): key is keyof typeof KEYBINDING_NAME_MIGRATIONS {
	return key in KEYBINDING_NAME_MIGRATIONS;
}

function toKeybindingsConfig(value: Record<string, unknown>): KeybindingsConfig {
	const config: KeybindingsConfig = {};
	for (const [key, binding] of Object.entries(value)) {
		if (typeof binding === "string") {
			config[key] = binding as KeyId;
			continue;
		}
		if (Array.isArray(binding) && binding.every((entry) => typeof entry === "string")) {
			config[key] = binding as KeyId[];
		}
	}
	return config;
}

export function migrateKeybindingsConfig(rawConfig: Record<string, unknown>): {
	config: Record<string, unknown>;
	migrated: boolean;
} {
	const config: Record<string, unknown> = {};
	let migrated = false;

	for (const [key, value] of Object.entries(rawConfig)) {
		const nextKey = isLegacyKeybindingName(key) ? KEYBINDING_NAME_MIGRATIONS[key] : key;
		if (nextKey !== key) {
			migrated = true;
		}
		if (key !== nextKey && Object.hasOwn(rawConfig, nextKey)) {
			migrated = true;
			continue;
		}
		config[nextKey] = value;
	}

	return { config: orderKeybindingsConfig(config), migrated };
}

function orderKeybindingsConfig(config: Record<string, unknown>): Record<string, unknown> {
	const ordered: Record<string, unknown> = {};
	for (const keybinding of Object.keys(KEYBINDINGS)) {
		if (Object.hasOwn(config, keybinding)) {
			ordered[keybinding] = config[keybinding];
		}
	}

	const extras = Object.keys(config)
		.filter((key) => !Object.hasOwn(ordered, key))
		.sort();
	for (const key of extras) {
		ordered[key] = config[key];
	}

	return ordered;
}

function loadRawConfig(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export class KeybindingsManager extends TuiKeybindingsManager {
	private configPath: string | undefined;

	constructor(userBindings: KeybindingsConfig = {}, configPath?: string) {
		super(KEYBINDINGS, userBindings);
		this.configPath = configPath;
	}

	static create(agentDir: string = getAgentDir()): KeybindingsManager {
		const configPath = join(agentDir, "keybindings.json");
		const userBindings = KeybindingsManager.loadFromFile(configPath);
		return new KeybindingsManager(userBindings, configPath);
	}

	reload(): void {
		if (!this.configPath) return;
		this.setUserBindings(KeybindingsManager.loadFromFile(this.configPath));
	}

	getEffectiveConfig(): KeybindingsConfig {
		return this.getResolvedBindings();
	}

	private static loadFromFile(path: string): KeybindingsConfig {
		const rawConfig = loadRawConfig(path);
		if (!rawConfig) return {};
		return toKeybindingsConfig(migrateKeybindingsConfig(rawConfig).config);
	}
}

export type { Keybinding, KeyId, KeybindingsConfig };
