/**
 * Background shells: bash commands that keep running after their tool call returned.
 *
 * A command becomes a background shell when the model starts it with `run_in_background`
 * or when the user moves a running call to the background (ctrl+b). Each shell keeps a
 * capped tail of its output, its status and timing, and a read cursor so the model's
 * `bash_output` calls return only new output. One completion event is emitted when a
 * shell exits on its own; finished shells stay listed for a while so their final output
 * can still be read. Every process is killed on dispose.
 */

/** How often a blocking bash wait checks for a user message that should end it. */
export const USER_MESSAGE_POLL_MS = 250;
/** A foreground command must run this long before a queued user message moves it to the background. */
export const FOREGROUND_MESSAGE_GRACE_MS = 5000;

/** Custom message type that reports a background shell's exit to the model. */
export const BASH_BACKGROUND_COMPLETED_CUSTOM_TYPE = "bash_background_completed";

/** A command's first line, with a count of the rest (a heredoc script can run to dozens of lines). */
export function summarizeShellCommand(command: string): string {
	const lines = command.trimEnd().split("\n");
	return lines.length > 1 ? `${lines[0]} (+${lines.length - 1} more lines)` : lines[0]!;
}

export interface BashBackgroundCompletion {
	taskId: string;
	command: string;
	/** Final tool text (output plus exit status), as the foreground call would have returned it. */
	text: string;
	isError: boolean;
	durationMs: number;
	/** The user stopped it from the Shells panel; it did not exit on its own. */
	stoppedByUser?: boolean;
	/** Exit code when the command ran to its end (not aborted, timed out, or killed). */
	exitCode?: number;
	/** The model's short description of the command, when it gave one. */
	description?: string;
}

export type BackgroundShellStatus = "running" | "completed" | "failed" | "killed";

export interface BackgroundShellSnapshot {
	taskId: string;
	command: string;
	/** Who sent it to the background: the model (`run_in_background`) or the user (ctrl+b). */
	origin: "model" | "user";
	/** The model's short description of the command, when it gave one. */
	description?: string;
	status: BackgroundShellStatus;
	startedAt: number;
	endedAt?: number;
	/** Retained output tail (the newest {@link MAX_OUTPUT_CHARS} characters). */
	output: string;
	/** Characters written over the shell's lifetime, including any no longer retained. */
	totalChars: number;
	/** Final tool text once the shell has exited on its own. */
	finalText?: string;
}

/** Output kept per shell; older output is dropped (the bash tool still spills full output to a file). */
export const MAX_OUTPUT_CHARS = 256 * 1024;
/** Finished shells kept for inspection after they exit. */
export const MAX_FINISHED_SHELLS = 20;

interface ForegroundCall {
	command: string;
	release: () => void;
}

interface BackgroundShell extends Omit<BackgroundShellSnapshot, "output"> {
	chunks: string[];
	retainedChars: number;
	/** `totalChars` at the model's last `bash_output` read. */
	readCursor: number;
	abort: () => void;
	exited: Promise<void>;
	markExited: () => void;
}

export interface BackgroundShellRead {
	shell: BackgroundShellSnapshot;
	/** Output written since the previous read (only the retained part). */
	newOutput: string;
	/** Characters of new output that were already dropped from the retained tail. */
	omittedChars: number;
}

export class BashBackgroundRegistry {
	private readonly foreground = new Map<string, ForegroundCall>();
	private readonly shells = new Map<string, BackgroundShell>();
	private readonly listeners = new Set<(completion: BashBackgroundCompletion) => void>();
	private readonly changeListeners = new Set<() => void>();
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

	/**
	 * Track a command that now runs in the background until it settles; returns its task id.
	 * `initialOutput` is what the command printed before it was backgrounded; later output
	 * arrives through {@link appendOutput}.
	 */
	adopt(
		command: string,
		startedAt: number,
		abort: () => void,
		settled: Promise<{ text: string; isError: boolean; exitCode?: number }>,
		options: { origin?: "model" | "user"; description?: string; initialOutput?: string } = {},
	): string {
		const taskId = `bash-${this.nextTaskNumber++}`;
		let markExited!: () => void;
		const exited = new Promise<void>((resolve) => {
			markExited = resolve;
		});
		const shell: BackgroundShell = {
			taskId,
			command,
			origin: options.origin ?? "user",
			...(options.description ? { description: options.description } : {}),
			status: "running",
			startedAt,
			totalChars: 0,
			chunks: [],
			retainedChars: 0,
			readCursor: 0,
			abort,
			exited,
			markExited,
		};
		this.shells.set(taskId, shell);
		if (options.initialOutput) this.append(shell, options.initialOutput);
		// Output printed before a user backgrounded the call was already returned to the model.
		shell.readCursor = shell.totalChars;
		if (this.disposed) abort();
		void settled.then(({ text, isError, exitCode }) => {
			if (this.disposed || shell.status !== "running") return;
			shell.status = isError ? "failed" : "completed";
			shell.endedAt = Date.now();
			shell.finalText = text;
			shell.markExited();
			this.pruneFinished();
			this.notifyChange();
			const completion: BashBackgroundCompletion = {
				taskId,
				command,
				text,
				isError,
				durationMs: shell.endedAt - startedAt,
				...(exitCode !== undefined ? { exitCode } : {}),
				...(shell.description ? { description: shell.description } : {}),
			};
			// One failing consumer must not block delivery to the rest or reject this callback.
			for (const listener of this.listeners) {
				try {
					listener(completion);
				} catch {}
			}
		});
		this.notifyChange();
		return taskId;
	}

	/** Record output a background shell printed. */
	appendOutput(taskId: string, text: string): void {
		const shell = this.shells.get(taskId);
		if (!shell || shell.status !== "running" || !text) return;
		this.append(shell, text);
		this.notifyChange();
	}

	runningCount(): number {
		let count = 0;
		for (const shell of this.shells.values()) if (shell.status === "running") count++;
		return count;
	}

	/** Running background commands, oldest first. */
	list(): Array<{ taskId: string; command: string; startedAt: number }> {
		return this.snapshots()
			.filter((shell) => shell.status === "running")
			.map(({ taskId, command, startedAt }) => ({ taskId, command, startedAt }));
	}

	/** Every tracked shell (running and recently finished), oldest first. */
	snapshots(): BackgroundShellSnapshot[] {
		return [...this.shells.values()].map((shell) => this.snapshot(shell));
	}

	get(taskId: string): BackgroundShellSnapshot | undefined {
		const shell = this.shells.get(taskId);
		return shell ? this.snapshot(shell) : undefined;
	}

	/**
	 * The model's view of a shell: status plus output written since its previous read.
	 * With `waitMs`, waits up to that long for the shell to exit first (`signal` ends the wait early).
	 */
	async read(
		taskId: string,
		options: { waitMs?: number; signal?: AbortSignal } = {},
	): Promise<BackgroundShellRead | undefined> {
		const shell = this.shells.get(taskId);
		if (!shell) return undefined;
		if (shell.status === "running" && options.waitMs && options.waitMs > 0) {
			await waitFor(shell.exited, options.waitMs, options.signal);
		}
		const unread = shell.totalChars - shell.readCursor;
		const output = shell.chunks.join("");
		const newOutput = output.slice(Math.max(0, output.length - unread));
		shell.readCursor = shell.totalChars;
		return { shell: this.snapshot(shell), newOutput, omittedChars: Math.max(0, unread - newOutput.length) };
	}

	/**
	 * Stop a running shell. Returns false when it is unknown or no longer running. With `notify`
	 * (a user stop), completion listeners hear about it so the model does not keep waiting for it.
	 */
	kill(taskId: string, options: { notify?: boolean } = {}): boolean {
		const shell = this.shells.get(taskId);
		if (!shell || shell.status !== "running") return false;
		shell.status = "killed";
		shell.endedAt = Date.now();
		shell.finalText = options.notify ? "Stopped by the user." : "Stopped with bash_kill.";
		shell.abort();
		shell.markExited();
		this.pruneFinished();
		this.notifyChange();
		if (options.notify) {
			const completion: BashBackgroundCompletion = {
				taskId,
				command: shell.command,
				text: shell.finalText,
				isError: true,
				durationMs: shell.endedAt - shell.startedAt,
				stoppedByUser: true,
				...(shell.description ? { description: shell.description } : {}),
			};
			for (const listener of this.listeners) listener(completion);
		}
		return true;
	}

	onComplete(listener: (completion: BashBackgroundCompletion) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Called whenever a shell starts, prints output, or finishes. */
	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	/** Kill every background process; no completion events are emitted afterwards. */
	dispose(): void {
		this.disposed = true;
		for (const shell of this.shells.values()) {
			if (shell.status === "running") shell.abort();
			shell.markExited();
		}
		this.shells.clear();
		this.foreground.clear();
		this.listeners.clear();
		this.changeListeners.clear();
	}

	private append(shell: BackgroundShell, text: string): void {
		shell.chunks.push(text);
		shell.totalChars += text.length;
		shell.retainedChars += text.length;
		// Drop exactly the excess from the oldest chunks, cutting the last one partway if needed.
		while (shell.retainedChars > MAX_OUTPUT_CHARS) {
			const excess = shell.retainedChars - MAX_OUTPUT_CHARS;
			const oldest = shell.chunks[0]!;
			if (oldest.length <= excess) {
				shell.chunks.shift();
				shell.retainedChars -= oldest.length;
			} else {
				shell.chunks[0] = oldest.slice(excess);
				shell.retainedChars -= excess;
			}
		}
	}

	private snapshot(shell: BackgroundShell): BackgroundShellSnapshot {
		return {
			taskId: shell.taskId,
			command: shell.command,
			origin: shell.origin,
			...(shell.description ? { description: shell.description } : {}),
			status: shell.status,
			startedAt: shell.startedAt,
			...(shell.endedAt !== undefined ? { endedAt: shell.endedAt } : {}),
			output: shell.chunks.join(""),
			totalChars: shell.totalChars,
			...(shell.finalText !== undefined ? { finalText: shell.finalText } : {}),
		};
	}

	private pruneFinished(): void {
		const finished = [...this.shells.values()].filter((shell) => shell.status !== "running");
		for (const shell of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_SHELLS))) {
			this.shells.delete(shell.taskId);
		}
	}

	private notifyChange(): void {
		for (const listener of this.changeListeners) listener();
	}
}

function waitFor(promise: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
		void promise.then(done);
	});
}
