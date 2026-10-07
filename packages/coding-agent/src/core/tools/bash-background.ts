/**
 * Moves running bash tool calls to the background on user request (ctrl+b).
 *
 * A released call returns its output so far to the model immediately; the
 * process keeps running under the same timeout, and one completion event is
 * emitted when it exits. Background processes are killed on dispose.
 */

export interface BashBackgroundCompletion {
	taskId: string;
	command: string;
	/** Final tool text (output plus exit status), as the foreground call would have returned it. */
	text: string;
	isError: boolean;
	durationMs: number;
}

interface ForegroundCall {
	command: string;
	release: () => void;
}

interface BackgroundTask {
	command: string;
	startedAt: number;
	abort: () => void;
}

export class BashBackgroundRegistry {
	private readonly foreground = new Map<string, ForegroundCall>();
	private readonly background = new Map<string, BackgroundTask>();
	private readonly listeners = new Set<(completion: BashBackgroundCompletion) => void>();
	private nextTaskNumber = 1;
	private disposed = false;

	/** Register a running foreground call that may be released. Returns an unregister function. */
	registerForeground(toolCallId: string, command: string, release: () => void): () => void {
		this.foreground.set(toolCallId, { command, release });
		return () => {
			if (this.foreground.get(toolCallId)?.release === release) this.foreground.delete(toolCallId);
		};
	}

	hasReleasable(): boolean {
		return this.foreground.size > 0;
	}

	/** Release every running foreground call. Returns how many were released. */
	releaseAll(): number {
		const calls = [...this.foreground.values()];
		this.foreground.clear();
		for (const call of calls) call.release();
		return calls.length;
	}

	/** Track a released call until it settles; returns its task id. */
	adopt(
		command: string,
		startedAt: number,
		abort: () => void,
		settled: Promise<{ text: string; isError: boolean }>,
	): string {
		const taskId = `bash-${this.nextTaskNumber++}`;
		this.background.set(taskId, { command, startedAt, abort });
		if (this.disposed) abort();
		void settled.then(({ text, isError }) => {
			if (!this.background.delete(taskId) || this.disposed) return;
			const completion = { taskId, command, text, isError, durationMs: Date.now() - startedAt };
			for (const listener of this.listeners) listener(completion);
		});
		return taskId;
	}

	runningCount(): number {
		return this.background.size;
	}

	/** Running background commands, oldest first. */
	list(): Array<{ taskId: string; command: string; startedAt: number }> {
		return [...this.background.entries()].map(([taskId, task]) => ({
			taskId,
			command: task.command,
			startedAt: task.startedAt,
		}));
	}

	onComplete(listener: (completion: BashBackgroundCompletion) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Kill every background process; no completion events are emitted afterwards. */
	dispose(): void {
		this.disposed = true;
		for (const task of this.background.values()) task.abort();
		this.background.clear();
		this.foreground.clear();
		this.listeners.clear();
	}
}
