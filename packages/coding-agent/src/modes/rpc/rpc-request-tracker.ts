import type { RpcCommand } from "./rpc-types.ts";

export class RpcRequestExecutionError extends Error {
	readonly errorCode: "invalid_request" | "timeout" | "cancelled";
	readonly errorDetails = undefined;

	constructor(errorCode: "invalid_request" | "timeout" | "cancelled", message: string) {
		super(message);
		this.name = "RpcRequestExecutionError";
		this.errorCode = errorCode;
	}
}

export const RPC_MAX_REQUEST_TIMEOUT_MS = 300000;
export const RPC_CANCELLABLE_COMMANDS = ["compact", "navigate_tree", "bash"] as const;
const cancellable = new Set<RpcCommand["type"]>(RPC_CANCELLABLE_COMMANDS);

export interface RpcRequestScope {
	readonly signal: AbortSignal;
	start(): void;
	finish(): void;
}

interface RequestRecord {
	id?: string;
	controller: AbortController;
	started: boolean;
	cancellableWhileRunning: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/** Correlation/deadline bookkeeping only. Native operations own cancellation and settlement. */
export class RpcRequestTracker {
	private readonly byId = new Map<string, RequestRecord>();
	private readonly active = new Set<RequestRecord>();

	begin(command: RpcCommand): RpcRequestScope {
		if (command.id !== undefined && this.byId.has(command.id)) {
			throw new RpcRequestExecutionError("invalid_request", "An active request already uses this id.");
		}
		const record: RequestRecord = {
			id: command.id,
			controller: new AbortController(),
			started: false,
			cancellableWhileRunning: cancellable.has(command.type),
		};
		this.active.add(record);
		if (record.id !== undefined) this.byId.set(record.id, record);
		if (record.cancellableWhileRunning && "timeoutMs" in command && command.timeoutMs !== undefined) {
			record.timer = setTimeout(() => {
				record.controller?.abort(
					new RpcRequestExecutionError(
						"timeout",
						"Request deadline elapsed; committed effects are not rolled back.",
					),
				);
			}, command.timeoutMs);
			record.timer.unref();
		}
		return {
			signal: record.controller.signal,
			start: () => {
				record.started = true;
			},
			finish: () => {
				clearTimeout(record.timer);
				this.active.delete(record);
				if (record.id !== undefined && this.byId.get(record.id) === record) this.byId.delete(record.id);
			},
		};
	}

	cancel(requestId: string): boolean {
		const record = this.byId.get(requestId);
		if (!record || (record.started && !record.cancellableWhileRunning) || record.controller.signal.aborted)
			return false;
		const controller = record.controller;
		controller.abort(
			new RpcRequestExecutionError(
				"cancelled",
				"Request cancellation requested; committed effects are not rolled back.",
			),
		);
		return true;
	}

	abortAll(): void {
		for (const record of this.active) {
			if (!record.started || record.cancellableWhileRunning)
				record.controller.abort(new RpcRequestExecutionError("cancelled", "RPC host is shutting down."));
			clearTimeout(record.timer);
		}
	}
}
