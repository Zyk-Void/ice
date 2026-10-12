import { AsyncLocalStorage } from "node:async_hooks";
import { RpcCommandExecutionError } from "./rpc-command-schema.ts";

export const RPC_MAX_PENDING_COMMANDS = 256;

interface Admission {
	settled: Promise<void>;
	dependencies: Admission[];
	allowsTransition: boolean;
}

/** RPC admission ordering, not an agent-operation queue. Streaming outlives prompt admission. */
export class RpcCommandCoordinator {
	private readonly context = new AsyncLocalStorage<Admission>();
	private readonly active = new Set<Admission>();
	private readonly operationActive: () => boolean;
	private readonly maxPending: number;
	private barrier?: Admission;
	private mutationTail?: Admission;

	constructor(operationActive: () => boolean = () => false, maxPending = RPC_MAX_PENDING_COMMANDS) {
		this.operationActive = operationActive;
		if (!Number.isSafeInteger(maxPending) || maxPending < 1)
			throw new Error("maxPending must be a positive safe integer.");
		this.maxPending = maxPending;
	}

	run<T>(operation: () => Promise<T>, transition = false, mutation = false): Promise<T> {
		return this.admit(operation, transition, mutation);
	}

	/** Called synchronously at acceptance, before the prompt enters model/tool hooks. */
	retirePromptPreflight(): void {
		const owner = this.context.getStore();
		if (owner) owner.allowsTransition = false;
	}

	/** Called by extension command actions, which may already own a command admission. */
	runTransition<T>(operation: () => Promise<T>): Promise<T> {
		const owner = this.context.getStore();
		const activeOwner = owner && this.active.has(owner) ? owner : undefined;
		// Retired prompt contexts continue into the model run. Teardown from one of its
		// hooks would wait for the very operation that is awaiting this replacement.
		if (owner && !owner.allowsTransition && this.operationActive()) {
			return Promise.reject(
				new RpcCommandExecutionError("busy", "Cannot replace a session from an active operation hook."),
			);
		}
		// A later admission may already depend on this caller (directly or transitively).
		if (activeOwner && (this.barrier || [...this.active].some((entry) => this.dependsOn(entry, activeOwner)))) {
			return Promise.reject(
				new RpcCommandExecutionError("busy", "A dependent command or session transition is already pending."),
			);
		}
		return this.admit(operation, true, false, activeOwner);
	}

	private dependsOn(entry: Admission, owner: Admission): boolean {
		const pending = [...entry.dependencies];
		const visited = new Set<Admission>();
		while (pending.length > 0) {
			const dependency = pending.pop()!;
			if (dependency === owner) return true;
			if (!visited.has(dependency)) {
				visited.add(dependency);
				pending.push(...dependency.dependencies);
			}
		}
		return false;
	}

	private admit<T>(
		operation: () => Promise<T>,
		transition: boolean,
		mutation: boolean,
		owner?: Admission,
	): Promise<T> {
		if (this.active.size >= this.maxPending) {
			return Promise.reject(new RpcCommandExecutionError("busy", "RPC pending command limit reached."));
		}
		const dependencies = transition
			? [...this.active].filter((entry) => entry !== owner)
			: [
					...new Set(
						[this.barrier, mutation ? this.mutationTail : undefined].filter(
							(entry): entry is Admission => entry !== undefined,
						),
					),
				];
		let release!: () => void;
		const admission: Admission = {
			settled: new Promise<void>((resolve) => {
				release = resolve;
			}),
			dependencies,
			allowsTransition: mutation,
		};
		// Install the latch before invoking code or yielding to the next input record.
		this.active.add(admission);
		if (transition) this.barrier = admission;
		if (mutation) this.mutationTail = admission;
		const execute = async () => this.context.run(admission, operation);
		const result =
			dependencies.length > 0 ? Promise.all(dependencies.map((entry) => entry.settled)).then(execute) : execute();
		return result.finally(() => {
			admission.allowsTransition = false;
			admission.dependencies = [];
			this.active.delete(admission);
			if (this.barrier === admission) this.barrier = undefined;
			if (this.mutationTail === admission) this.mutationTail = undefined;
			release();
		});
	}
}
