import { RPC_MAX_PENDING_COMMANDS } from "./rpc-command-coordinator.ts";
import { RpcCommandExecutionError } from "./rpc-command-schema.ts";
import { RpcRequestExecutionError } from "./rpc-request-tracker.ts";

export const RPC_MAX_RETAINED_INPUT_BYTES = 32 * 1024 * 1024;
export const RPC_MAX_CONTROL_INPUT_BYTES = 1024 * 1024;
export const RPC_MAX_LIVE_CONTROLS = 64;

/** Transport bookkeeping only: normal traffic cannot consume the reserved control lane. */
export class RpcInputAdmission {
	private normalCount = 0;
	private controlCount = 0;
	private normalBytes = 0;
	private controlBytes = 0;
	private closing = false;
	private readonly idleWaiters = new Set<() => void>();

	get isClosing(): boolean {
		return this.closing;
	}

	close(): void {
		this.closing = true;
	}

	begin(bytes: number, control: boolean): () => void {
		if (this.closing) throw new RpcRequestExecutionError("cancelled", "RPC host is shutting down.");
		const count = control ? this.controlCount : this.normalCount;
		const retained = control ? this.controlBytes : this.normalBytes;
		if (
			count >= (control ? RPC_MAX_LIVE_CONTROLS : RPC_MAX_PENDING_COMMANDS) ||
			retained + bytes > (control ? RPC_MAX_CONTROL_INPUT_BYTES : RPC_MAX_RETAINED_INPUT_BYTES)
		) {
			throw new RpcCommandExecutionError("busy", "RPC retained input or request-count limit reached.");
		}
		if (control) {
			this.controlCount++;
			this.controlBytes += bytes;
		} else {
			this.normalCount++;
			this.normalBytes += bytes;
		}
		let finished = false;
		return () => {
			if (finished) return;
			finished = true;
			if (control) {
				this.controlCount--;
				this.controlBytes -= bytes;
			} else {
				this.normalCount--;
				this.normalBytes -= bytes;
			}
			if (this.normalCount + this.controlCount === 0) {
				for (const resolve of this.idleWaiters) resolve();
				this.idleWaiters.clear();
			}
		};
	}

	waitForIdle(): Promise<void> {
		if (this.normalCount + this.controlCount === 0) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.add(resolve));
	}
}
