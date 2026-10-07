import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import type { IceHookDecisionInput, IceHookDecisionResult, IceHookHandler } from "../settings.ts";

export interface IceCommandHookPolicy {
	enabled: boolean;
	approval: "ask" | "allow";
	commands: Readonly<
		Record<
			string,
			{
				argv: readonly string[];
				cwd: string;
				sha256: string;
				files: Readonly<Record<string, string>>;
			}
		>
	>;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Global, host-owned exact command declarations. Projects may reference IDs, never authorize them. */
export function parseIceCommandHookPolicy(value: unknown): IceCommandHookPolicy {
	if (value === undefined) return { enabled: false, approval: "ask", commands: {} };
	if (!record(value) || Object.keys(value).some((key) => !["enabled", "approval", "commands"].includes(key))) {
		throw new Error("Invalid command-hook policy.");
	}
	if (typeof value.enabled !== "boolean" || !["ask", "allow"].includes(String(value.approval ?? "ask"))) {
		throw new Error("Command-hook policy requires boolean enabled and ask/allow approval.");
	}
	if (!record(value.commands) || Object.keys(value.commands).length > 32)
		throw new Error("Command-hook commands must be a bounded object.");
	const commands: Record<string, IceCommandHookPolicy["commands"][string]> = {};
	for (const [id, command] of Object.entries(value.commands)) {
		if (
			!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) ||
			!record(command) ||
			Object.keys(command).some((key) => !["argv", "cwd", "sha256", "files"].includes(key))
		)
			throw new Error("Invalid command-hook declaration.");
		if (
			!Array.isArray(command.argv) ||
			command.argv.length < 1 ||
			command.argv.length > 32 ||
			command.argv.some((arg) => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 4096)
		)
			throw new Error("Command-hook argv must be bounded literal strings.");
		const argv = command.argv as string[];
		if (!isAbsolute(argv[0]) || typeof command.cwd !== "string" || !isAbsolute(command.cwd))
			throw new Error("Command-hook executable and cwd must be absolute paths.");
		if (typeof command.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(command.sha256))
			throw new Error("Command-hook executable requires a SHA-256 identity.");
		if (
			!record(command.files) ||
			Object.keys(command.files).length > 16 ||
			Object.entries(command.files).some(
				([path, hash]) => !isAbsolute(path) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
			)
		)
			throw new Error("Command-hook files must map absolute script paths to SHA-256 identities.");
		commands[id] = Object.freeze({
			argv: Object.freeze([...argv]),
			cwd: command.cwd,
			sha256: command.sha256,
			files: Object.freeze({ ...command.files } as Record<string, string>),
		});
	}
	return Object.freeze({
		enabled: value.enabled,
		approval: (value.approval ?? "ask") as "ask" | "allow",
		commands: Object.freeze(commands),
	});
}

export function createIceCommandHookHandler(options: {
	policy: IceCommandHookPolicy;
	workspace: string;
	isAuthorized: () => boolean;
	approve?: (id: string) => Promise<boolean>;
}): IceHookHandler {
	return async (input: IceHookDecisionInput): Promise<IceHookDecisionResult> => {
		const command = options.policy.commands[input.hook.id];
		if (!options.policy.enabled || !command || !options.isAuthorized())
			throw new Error("Command hook requires host policy, trusted build mode, and active parent Bash.");
		if (options.policy.approval === "ask" && !(await options.approve?.(input.hook.id)))
			throw new Error("Command-hook execution approval is unavailable or denied.");
		if (input.signal?.aborted || !options.isAuthorized())
			throw new Error("Command-hook authority was cancelled or revoked.");
		const workspace = realpathSync(options.workspace);
		const cwd = realpathSync(command.cwd);
		const rel = relative(workspace, cwd);
		if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
			throw new Error("Command-hook cwd is outside the trusted workspace.");
		for (const [path, hash] of Object.entries({ ...command.files, [command.argv[0]]: command.sha256 })) {
			if (
				realpathSync(path) !== resolve(path) ||
				!statSync(path).isFile() ||
				createHash("sha256").update(readFileSync(path)).digest("hex") !== hash
			)
				throw new Error("Command-hook executable or script identity changed.");
		}
		const payload = JSON.stringify({
			schemaVersion: 1,
			event: input.event,
			ownerSessionId: input.ownerSessionId,
			runId: input.runId,
			attempt: input.attempt,
			role: input.role,
			payload: input.payload,
		});
		if (Buffer.byteLength(payload) > 32 * 1024) throw new Error("Command-hook input exceeds 32 KiB.");
		return await new Promise<IceHookDecisionResult>((resolveResult, reject) => {
			if (input.signal?.aborted) {
				reject(new Error("Command hook cancelled before spawn."));
				return;
			}
			const child = spawn(command.argv[0], command.argv.slice(1), {
				cwd,
				shell: false,
				detached: process.platform !== "win32",
				windowsHide: true,
				env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
				stdio: ["pipe", "pipe", "pipe"],
			});
			if (child.pid) trackDetachedChildPid(child.pid);
			let stdout = Buffer.alloc(0);
			let stderrBytes = 0;
			let failure: Error | undefined;
			let settled = false;
			let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
			const finish = (error?: Error, result?: IceHookDecisionResult): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (cleanupTimer) clearTimeout(cleanupTimer);
				input.signal?.removeEventListener("abort", abort);
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (error) reject(error);
				else resolveResult(result!);
			};
			const stop = (error: Error): void => {
				failure ??= error;
				child.stdin.destroy();
				if (child.pid) killProcessTree(child.pid);
				cleanupTimer ??= setTimeout(() => {
					child.stdout.destroy();
					child.stderr.destroy();
					child.unref();
					finish(new Error("Command hook stopped; descendant cleanup is best-effort."));
				}, 1000);
			};
			const abort = (): void => stop(new Error("Command hook cancelled."));
			const timer = setTimeout(() => stop(new Error("Command hook deadline exceeded.")), input.hook.timeoutMs);
			input.signal?.addEventListener("abort", abort, { once: true });
			child.on("error", (error) => finish(error));
			child.stdin.on("error", () => stop(new Error("Command hook input pipe failed.")));
			child.stdout.on("data", (chunk: Buffer) => {
				if (failure || settled) return;
				if (stdout.length + chunk.length > input.hook.maxOutputBytes)
					stop(new Error("Command hook stdout limit exceeded."));
				else stdout = Buffer.concat([stdout, chunk]);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderrBytes += chunk.length;
				if (stderrBytes > input.hook.maxOutputBytes) stop(new Error("Command hook stderr limit exceeded."));
			});
			child.on("close", (code) => {
				if (failure) {
					finish(failure);
					return;
				}
				if (code !== 0) {
					finish(new Error(`Command hook exited with status ${code}.`));
					return;
				}
				try {
					const value: unknown = JSON.parse(stdout.toString("utf8"));
					if (
						!record(value) ||
						value.schemaVersion !== 1 ||
						!["continue", "deny", "ask"].includes(String(value.outcome)) ||
						Object.keys(value).some(
							(key) => !["schemaVersion", "outcome", "reason", "contextAdditions"].includes(key),
						) ||
						(value.reason !== undefined && typeof value.reason !== "string")
					)
						throw new Error("Malformed command-hook result.");
					finish(undefined, {
						outcome: value.outcome as IceHookDecisionResult["outcome"],
						...(value.reason !== undefined ? { reason: value.reason as string } : {}),
						...(value.contextAdditions !== undefined
							? { contextAdditions: value.contextAdditions as IceHookDecisionResult["contextAdditions"] }
							: {}),
					});
				} catch {
					finish(new Error("Command hook must return bounded schemaVersion:1 decision JSON."));
				}
			});
			child.stdin.end(payload);
		});
	};
}
