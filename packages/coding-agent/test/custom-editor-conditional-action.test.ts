import type { TUI } from "@zykairotis/ice-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const CTRL_B = "\x02";

function createEditor(canHandle: () => boolean, handler: () => void): CustomEditor {
	const tui = { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } } as unknown as TUI;
	const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager());
	editor.onConditionalAction("app.tasks.background", canHandle, handler);
	editor.setText("ab");
	return editor;
}

describe("CustomEditor conditional actions", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("claims ctrl+b only while the action can run", () => {
		const handler = vi.fn();
		const editor = createEditor(() => true, handler);
		editor.handleInput(CTRL_B);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("ab");
	});

	it("falls through to the editor (cursor left) when the action cannot run", () => {
		const handler = vi.fn();
		const editor = createEditor(() => false, handler);
		editor.handleInput(CTRL_B);
		editor.handleInput("X");
		expect(handler).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("aXb");
	});
});
