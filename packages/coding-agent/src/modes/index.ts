/**
 * Run modes for the coding agent.
 */

export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
export type { JsonAgentSessionEvent } from "./json-event.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
export {
	type ModelInfo,
	RpcClient,
	type RpcClientOptions,
	type RpcEventListener,
	type RpcOperationOptions,
} from "./rpc/rpc-client.ts";
export {
	buildIceSettingsCommandSchema,
	clearCustomStructuredCommands,
	getIceSettingsCommandSchemaResult,
	invokeIceSettingsCommand,
	type RpcCommandErrorDetails,
	RpcCommandExecutionError,
	type RpcCommandField,
	type RpcCommandGroup,
	type RpcCommandInvocationResult,
	type RpcCommandOption,
	type RpcCommandSchema,
	type RpcCommandSchemaResult,
	type RpcCommandSource,
	registerCustomStructuredCommand,
} from "./rpc/rpc-command-schema.ts";
export { runRpcMode } from "./rpc/rpc-mode.ts";
export type {
	RpcSettingsConstraints,
	RpcSettingsDiagnostic,
	RpcSettingsErrorCode,
	RpcSettingsField,
	RpcSettingsFieldKind,
	RpcSettingsFieldScope,
	RpcSettingsSnapshot,
	RpcSettingsValue,
	RpcSettingUpdate,
} from "./rpc/rpc-settings.ts";
export type {
	RpcAttachment,
	RpcCapabilities,
	RpcCommand,
	RpcCompletions,
	RpcDiagnostics,
	RpcEntryPage,
	RpcEvent,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcMessagePage,
	RpcModelSnapshot,
	RpcModelsChangedEvent,
	RpcModelsRefreshResult,
	RpcProviderInfo,
	RpcProviderSnapshot,
	RpcResponse,
	RpcSessionChangedEvent,
	RpcSessionPage,
	RpcSessionState,
	RpcSlashCommand,
	RpcTreePage,
	RpcUIState,
} from "./rpc/rpc-types.ts";
