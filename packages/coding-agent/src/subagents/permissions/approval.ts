/**
 * Subagent V2 approval broker (Plan/subagent-rewrite.md section 9.6, P3.5).
 *
 * Resolves child `ask` decisions without ever defaulting to allow:
 * - automated checks (hooks) run first and may decide;
 * - a foreground child with an interactive channel prompts the parent UI;
 * - a background child is queued for the Hub inbox until answered or timed out;
 * - with no approval channel at all (print/json, RPC without a client) it denies.
 * Timeout, dispose, and disconnect deny. Session grants only cover the exact
 * owner session and are offered as rules the caller persists.
 */

export const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;

export type ApprovalAnswer = "allow-once" | "allow-session" | "deny";

export interface ApprovalRequest {
	id: string;
	ownerSessionId: string;
	childId: string;
	agent: string;
	tool: string;
	/** Redacted, bounded operation summary shown to the user. */
	summary: string;
	/** Rule offered for an "allow for this session" answer, for example `bash(git push*)`. */
	sessionRule?: string;
	foreground: boolean;
}

export type ApprovalOutcome =
	| { decision: "allow"; source: "automated" | "user"; sessionRule?: string }
	| { decision: "deny"; source: "automated" | "user" | "timeout" | "no-channel" | "disposed" };

export interface PendingApproval {
	request: ApprovalRequest;
	queuedAt: number;
	deadline: number;
}

export interface ApprovalBrokerOptions {
	/** Prompts the parent UI for a foreground child; absent when the parent has no interactive UI. */
	interactive?: (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalAnswer>;
	/** True when a background inbox (Hub or RPC approval client) is attached. */
	hasInbox?: () => boolean;
	automatedCheck?: (request: ApprovalRequest) => Promise<"allow" | "deny" | undefined>;
	askTimeoutMs?: number;
	now?: () => number;
	setTimer?: (callback: () => void, ms: number) => { cancel(): void };
	onChange?: (pending: readonly PendingApproval[]) => void;
}

interface Waiter {
	pending: PendingApproval;
	resolve: (outcome: ApprovalOutcome) => void;
	timer: { cancel(): void };
	abort: AbortController;
}

export class ApprovalBroker {
	private readonly options: ApprovalBrokerOptions;
	private readonly waiters = new Map<string, Waiter>();
	private disposed = false;

	constructor(options: ApprovalBrokerOptions) {
		this.options = options;
	}

	get pending(): readonly PendingApproval[] {
		return [...this.waiters.values()].map((waiter) => waiter.pending);
	}

	async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
		if (this.disposed) return { decision: "deny", source: "disposed" };
		const automated = await this.options.automatedCheck?.(request);
		if (automated === "deny") return { decision: "deny", source: "automated" };
		if (automated === "allow") return { decision: "allow", source: "automated" };
		const viaPrompt = request.foreground && this.options.interactive !== undefined;
		if (!viaPrompt && !this.options.hasInbox?.()) return { decision: "deny", source: "no-channel" };
		if (this.waiters.has(request.id)) throw new Error(`Duplicate approval request ${request.id}`);
		const now = this.options.now?.() ?? Date.now();
		const timeout = this.options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
		const setTimer =
			this.options.setTimer ??
			((callback: () => void, ms: number) => {
				const handle = setTimeout(callback, ms);
				return { cancel: () => clearTimeout(handle) };
			});
		return new Promise<ApprovalOutcome>((resolve) => {
			const abort = new AbortController();
			const waiter: Waiter = {
				pending: { request, queuedAt: now, deadline: now + timeout },
				resolve,
				abort,
				timer: setTimer(() => this.settle(request.id, { decision: "deny", source: "timeout" }), timeout),
			};
			this.waiters.set(request.id, waiter);
			this.notify();
			if (viaPrompt) {
				this.options.interactive!(request, abort.signal).then(
					(answer) => this.respond(request.id, answer),
					() => this.settle(request.id, { decision: "deny", source: "user" }),
				);
			}
		});
	}

	/** Answer a pending request (Hub inbox, RPC approval_response, or the interactive prompt). Unknown or settled IDs are ignored. */
	respond(id: string, answer: ApprovalAnswer): boolean {
		const waiter = this.waiters.get(id);
		if (!waiter) return false;
		if (answer === "deny") return this.settle(id, { decision: "deny", source: "user" });
		const sessionRule = answer === "allow-session" ? waiter.pending.request.sessionRule : undefined;
		return this.settle(id, { decision: "allow", source: "user", ...(sessionRule ? { sessionRule } : {}) });
	}

	/** Deny everything pending for one owner session, for example on RPC client disconnect. */
	denyOwner(ownerSessionId: string): void {
		for (const [id, waiter] of this.waiters)
			if (waiter.pending.request.ownerSessionId === ownerSessionId)
				this.settle(id, { decision: "deny", source: "disposed" });
	}

	dispose(): void {
		this.disposed = true;
		for (const id of [...this.waiters.keys()]) this.settle(id, { decision: "deny", source: "disposed" });
	}

	private settle(id: string, outcome: ApprovalOutcome): boolean {
		const waiter = this.waiters.get(id);
		if (!waiter) return false;
		this.waiters.delete(id);
		waiter.timer.cancel();
		waiter.abort.abort();
		waiter.resolve(outcome);
		this.notify();
		return true;
	}

	private notify(): void {
		this.options.onChange?.(this.pending);
	}
}
