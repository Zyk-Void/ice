import { describe, expect, test } from "vitest";
import { RPC_COMMAND_TYPES, validateRpcInput } from "../src/modes/rpc/rpc-validation.ts";

describe("RPC wire validation", () => {
	test.each([null, true, 123, "prompt", [], {}, { type: 1 }, { type: "abort", id: 1 }])(
		"rejects malformed envelope %j",
		(value) => {
			expect(validateRpcInput(value)).toMatchObject({ valid: false, errorCode: "invalid_request" });
		},
	);

	test.each([
		{ type: "prompt", message: "hi", images: [{}] },
		{ type: "prompt", message: "hi", images: [{ type: "image", data: 1, mimeType: "image/png" }] },
		{ type: "prompt", message: "hi", expandPromptTemplates: "false" },
		{ type: "bash", command: "echo hi", excludeFromContext: "false" },
		{ type: "get_shell", shellId: "bash-1", sinceChars: 1.5 },
		{ type: "get_shell", shellId: "bash-1", sinceChars: -1 },
		{ type: "get_shell", shellId: "bash-1", sinceChars: Number.POSITIVE_INFINITY },
		{ type: "cycle_model", direction: "reverse" },
		{ type: "switch_session", sessionPath: "old", cwd: null },
		{ type: "invoke_command", name: "settings", arguments: [] },
		{ type: "invoke_command", name: "settings", arguments: {}, options: { scope: "system" } },
		{ type: "set_scoped_models", models: [null] },
		{ type: "subagent_control", subagentId: "child", action: "send" },
		{ type: "extension_ui_response", id: "dialog", value: 1 },
		{ type: "extension_ui_response", id: "dialog", confirmed: "true" },
		{ type: "extension_ui_response", id: "dialog" },
		{ type: "get_state", timeoutMs: 20 },
		{ type: "prompt", message: "hello", timeoutMs: 20 },
		{ type: "cancel_request" },
		{ type: "cancel_request", requestId: 1 },
		{ type: "compact", timeoutMs: 0 },
		{ type: "compact", timeoutMs: 300001 },
		{ type: "bash", command: "synthetic", timeoutMs: "20" },
		{ type: "navigate_tree", targetId: "entry", timeoutMs: 1.5 },
	])("rejects malformed command %j", (value) => {
		expect(validateRpcInput(value)).toMatchObject({ valid: false, errorCode: "invalid_argument" });
	});

	test("validates dialog response primitives and preserves command identity", () => {
		for (const response of [{ value: "yes" }, { confirmed: false }, { cancelled: true }]) {
			const input = { type: "extension_ui_response", id: "dialog", ...response };
			expect(validateRpcInput(input)).toEqual({ valid: true, command: input });
		}
		expect(validateRpcInput({ id: "original", type: "not_a_command" })).toMatchObject({
			valid: false,
			id: "original",
			command: "not_a_command",
			errorCode: "unknown_command",
		});
		for (const input of [
			{ type: "compact", timeoutMs: 300000 },
			{ type: "navigate_tree", targetId: "entry", timeoutMs: 1 },
			{ type: "bash", command: "synthetic" },
			{ type: "cancel_request", requestId: "target" },
		])
			expect(validateRpcInput(input)).toEqual({ valid: true, command: input });
		expect(RPC_COMMAND_TYPES).toContain("get_capabilities");
		expect(RPC_COMMAND_TYPES).toContain("cancel_request");
		expect(new Set(RPC_COMMAND_TYPES).size).toBe(RPC_COMMAND_TYPES.length);
	});
});
