import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { isAbsolute } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@zykairotis/ice-ai";

const PREFIX = "/api/services/claude-sdk";
const MAX_WIRE_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 3 * 1024 * 1024;
const DEFAULT_TIMEOUT = 600_000;
export interface BridgeClientConfig {
	version: 1;
	baseUrl: string;
	tokenFile: string;
	models: string[];
}
interface HandleState {
	handle: string;
	wireSessionId: string;
	touched: number;
}
type OutputBlock = AssistantMessage["content"][number];

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid bridge response.");
	return value as Record<string, unknown>;
}
function string(value: unknown): string {
	if (typeof value !== "string") throw new Error("Invalid bridge response.");
	return value;
}
function positive(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
		throw new Error("Invalid bridge usage.");
	return value;
}
export function validateClientConfig(raw: unknown): BridgeClientConfig {
	const input = record(raw);
	const url = new URL(string(input.baseUrl));
	if (
		input.version !== 1 ||
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.pathname !== "/" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!url.port ||
		!isAbsolute(string(input.tokenFile)) ||
		!Array.isArray(input.models) ||
		input.models.length === 0 ||
		input.models.length > 32 ||
		input.models.some((model) => typeof model !== "string" || !/^claude-[a-z0-9][a-z0-9-]{1,96}$/.test(model))
	) {
		throw new Error("Invalid local Claude SDK configuration.");
	}
	return { version: 1, baseUrl: url.origin, tokenFile: string(input.tokenFile), models: input.models as string[] };
}
export async function readPrivate(path: string): Promise<string> {
	const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
			throw new Error("Unsafe local Claude SDK configuration permissions.");
		return await file.readFile("utf8");
	} finally {
		await file.close();
	}
}
export async function loadClientConfig(path: string): Promise<BridgeClientConfig> {
	return validateClientConfig(JSON.parse(await readPrivate(path)));
}
function serializedMessages(context: Context): unknown[] {
	return context.messages.map((message) => {
		if (message.role === "user") return { role: message.role, content: message.content };
		if (message.role === "assistant") return { role: message.role, content: message.content };
		return {
			role: message.role,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: message.content,
			isError: message.isError,
		};
	});
}
function contentBlocks(value: unknown): OutputBlock[] {
	if (!Array.isArray(value) || value.length > 512) throw new Error("Invalid bridge content.");
	return value.map((item): OutputBlock => {
		const block = record(item);
		if (block.type === "text") return { type: "text", text: string(block.text) };
		if (block.type === "thinking")
			return {
				type: "thinking",
				thinking: string(block.thinking),
				...(block.thinkingSignature !== undefined ? { thinkingSignature: string(block.thinkingSignature) } : {}),
				...(block.redacted === true ? { redacted: true } : {}),
			};
		if (block.type === "toolCall") {
			const name = string(block.name);
			const id = string(block.id);
			if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !id || id.length > 256)
				throw new Error("Invalid bridge tool identity.");
			return { type: "toolCall", id, name, arguments: record(block.arguments) };
		}
		throw new Error("Unsupported bridge content.");
	});
}
export async function* iterateRecords(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.body || !response.headers.get("content-type")?.startsWith("application/x-ndjson"))
		throw new Error("Invalid bridge response type.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = "";
	let size = 0;
	let count = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > MAX_WIRE_BYTES) throw new Error("Oversized bridge response.");
			buffer += decoder.decode(next.value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.length > MAX_LINE_BYTES || ++count > 65536) throw new Error("Invalid bridge framing.");
				if (line.trim()) yield record(JSON.parse(line));
				newline = buffer.indexOf("\n");
			}
			if (buffer.length > MAX_LINE_BYTES) throw new Error("Oversized bridge frame.");
		}
		buffer += decoder.decode();
		if (buffer.trim()) throw new Error("Truncated bridge frame.");
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
export async function readRecords(response: Response): Promise<Record<string, unknown>[]> {
	const result: Record<string, unknown>[] = [];
	for await (const event of iterateRecords(response)) result.push(event);
	return result;
}
const errors: Record<string, string> = {
	subscription_required:
		"Claude SDK: subscription authentication is not verified; run the bridge status/login command. No API fallback was attempted.",
	unauthorized: "Claude SDK: local bridge authentication failed.",
	session_lost:
		"Claude SDK: the session expired or was interrupted. Start a new session; tool effects were not replayed.",
	session_conflict: "Claude SDK: duplicate/concurrent request or changed tool context. No work was replayed.",
	tool_protocol: "Claude SDK: tool/result correlation failed. The query was stopped.",
	capacity: "Claude SDK: the bridge is at its bounded session capacity.",
	unsupported: "Claude SDK: requested model or capability is not supported by this bridge.",
	timeout: "Claude SDK: the bounded request deadline was reached.",
	upstream: "Claude SDK: upstream request failed. No direct OAuth or API fallback was attempted.",
};
class SafeBridgeFailure extends Error {}

export class ClaudeSdkClient {
	private config: BridgeClientConfig;
	private readToken: () => Promise<string>;
	private handles = new Map<string, HandleState>();
	private active = new Set<string>();
	private instance = randomUUID();
	constructor(config: BridgeClientConfig, readToken?: () => Promise<string>) {
		this.config = validateClientConfig(config);
		this.readToken = readToken ?? (async () => (await readPrivate(this.config.tokenFile)).trim());
	}
	private async token(): Promise<string> {
		const value = await this.readToken();
		if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid local bridge credential.");
		return value;
	}
	private async cancelHandle(state: HandleState, token: string): Promise<void> {
		try {
			await fetch(`${this.config.baseUrl}${PREFIX}/cancel`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				redirect: "error",
				body: JSON.stringify({ version: 1, sessionId: state.wireSessionId, handle: state.handle }),
				signal: AbortSignal.timeout(2000),
			});
		} catch {
			/* Server-side TTL and the disconnected request deadline are the final cleanup guard. */
		}
	}
	async close(): Promise<void> {
		const states = [...this.handles.values()];
		this.handles.clear();
		let token: string;
		try {
			token = await this.token();
		} catch {
			return;
		}
		await Promise.all(states.map((state) => this.cancelHandle(state, token)));
	}
	async status(): Promise<string> {
		try {
			const response = await fetch(`${this.config.baseUrl}${PREFIX}/status`, {
				headers: { Authorization: `Bearer ${await this.token()}` },
				redirect: "error",
				signal: AbortSignal.timeout(12000),
			});
			if (!response.ok) return "Claude SDK bridge is unavailable or unauthorized.";
			const value = record(await response.json());
			const auth = record(value.authentication);
			const state =
				typeof auth.state === "string" &&
				["subscription", "api_auth", "not_logged_in", "unknown"].includes(auth.state)
					? auth.state
					: "unknown";
			return `Claude SDK bridge: ${state}; ready=${auth.ready === true}. Billing is externally managed, not guaranteed free. ICE owns tools; no identity rewriting.`;
		} catch {
			return "Claude SDK bridge could not be reached. Start the local bridge and check its status.";
		}
	}
	stream(model: Model<Api>, context: Context, options: SimpleStreamOptions = {}) {
		const stream = createAssistantMessageEventStream();
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			diagnostics: [
				{
					type: "claude-agent-sdk",
					timestamp: Date.now(),
					details: { billing: "external", identityRewriting: false },
				},
			],
		};
		const run = async () => {
			const key = options.sessionId ?? randomUUID();
			const temporary = !options.sessionId;
			const controller = new AbortController();
			const abort = () => controller.abort();
			let token = "";
			let locked = false;
			let selected: HandleState | undefined;
			const timeout = setTimeout(abort, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT, DEFAULT_TIMEOUT));
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				if (options.signal?.aborted) controller.abort();
				if (controller.signal.aborted) throw new SafeBridgeFailure("Claude SDK request cancelled.");
				if (this.active.has(key)) throw new SafeBridgeFailure(errors.session_conflict);
				this.active.add(key);
				locked = true;
				if (
					!this.config.models.includes(model.id) ||
					options.deferred ||
					(options.toolChoice !== undefined && options.toolChoice !== "auto" && options.toolChoice !== "none") ||
					options.temperature !== undefined ||
					(options.samplingParams && Object.keys(options.samplingParams).length)
				)
					throw new SafeBridgeFailure(errors.unsupported);
				token = await this.token();
				for (const [id, state] of this.handles) {
					if (!this.active.has(id) && Date.now() - state.touched > 10 * 60_000) {
						this.handles.delete(id);
						await this.cancelHandle(state, token);
					}
				}
				if (this.handles.size >= 64 && !this.handles.has(key)) throw new SafeBridgeFailure(errors.capacity);
				selected = this.handles.get(key);
				const sessionId = selected?.wireSessionId ?? `${this.instance}:${randomUUID()}`;
				const requestId = randomUUID();
				const cap = Math.min(options.maxTokens ?? 16384, options.hardMaxOutputTokens ?? 128000, 128000);
				if (!Number.isInteger(cap) || cap < 1) throw new SafeBridgeFailure(errors.unsupported);
				let payload: unknown = {
					version: 1,
					requestId,
					sessionId,
					...(selected ? { handle: selected.handle } : {}),
					model: model.id,
					systemPrompt: context.systemPrompt ?? "",
					messages: serializedMessages(context),
					tools:
						options.toolChoice === "none"
							? []
							: (context.tools ?? []).map((tool) => ({
									name: tool.name,
									description: tool.description,
									parameters: tool.parameters,
								})),
					...(options.reasoning ? { thinking: options.reasoning } : {}),
					maxTokens: cap,
				};
				if (options.onPayload) payload = (await options.onPayload(payload, model)) ?? payload;
				const envelope = record(payload);
				if (
					envelope.version !== 1 ||
					envelope.requestId !== requestId ||
					envelope.sessionId !== sessionId ||
					envelope.handle !== selected?.handle ||
					envelope.model !== model.id
				)
					throw new SafeBridgeFailure(errors.session_conflict);
				if (
					envelope.maxTokens !== undefined &&
					(typeof envelope.maxTokens !== "number" || !Number.isFinite(envelope.maxTokens))
				)
					throw new SafeBridgeFailure(errors.unsupported);
				envelope.maxTokens = Math.min(typeof envelope.maxTokens === "number" ? envelope.maxTokens : cap, cap);
				const body = JSON.stringify(envelope);
				if (Buffer.byteLength(body) > MAX_WIRE_BYTES)
					throw new SafeBridgeFailure("Claude SDK request exceeds the local bridge size limit.");
				stream.push({ type: "start", partial: output });
				const response = await (options.fetch ?? fetch)(`${this.config.baseUrl}${PREFIX}/step`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
						Accept: "application/x-ndjson",
					},
					body,
					signal: controller.signal,
					redirect: "error",
				});
				await options.onResponse?.(
					{ status: response.status, headers: Object.fromEntries(response.headers.entries()) },
					model,
				);
				if (!response.ok)
					throw new SafeBridgeFailure(response.status === 401 ? errors.unauthorized : errors.upstream);
				let terminal: Record<string, unknown> | undefined;
				let ready = false;
				let previewText = "";
				let previewStarted = false;
				for await (const event of iterateRecords(response)) {
					if (terminal) throw new Error("Duplicate terminal record.");
					if (event.type === "ready") {
						if (
							ready ||
							event.version !== 1 ||
							event.transport !== "claude-agent-sdk" ||
							event.billing !== "external" ||
							!/^[a-f0-9]{64}$/.test(string(event.handle))
						)
							throw new Error("Invalid bridge readiness.");
						ready = true;
						selected = { handle: string(event.handle), wireSessionId: sessionId, touched: Date.now() };
						this.handles.set(key, selected);
					} else if (event.type === "text_delta" && ready) {
						const delta = string(event.delta);
						previewText += delta;
						if (Buffer.byteLength(previewText) > 2 * 1024 * 1024) throw new Error("Oversized bridge preview.");
						if (!previewStarted) {
							previewStarted = true;
							output.content = [{ type: "text", text: "" }];
							stream.push({ type: "text_start", contentIndex: 0, partial: output });
						}
						output.content = [{ type: "text", text: previewText }];
						stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
					} else if (event.type === "error") {
						throw new SafeBridgeFailure(errors[string(event.code)] ?? errors.upstream);
					} else if (event.type === "turn" && ready && event.handle === selected?.handle) terminal = event;
					else throw new Error("Invalid bridge event.");
				}
				if (!terminal) throw new Error("Missing terminal bridge response.");
				const message = record(terminal.message);
				const blocks = contentBlocks(message.content);
				const calls = blocks.filter((block) => block.type === "toolCall");
				if (
					!["stop", "length", "toolUse"].includes(string(message.stopReason)) ||
					(message.stopReason === "toolUse") !== calls.length > 0 ||
					new Set(calls.map((call) => call.id)).size !== calls.length ||
					calls.some((call) => !(context.tools ?? []).some((tool) => tool.name === call.name)) ||
					(options.toolChoice === "none" && calls.length)
				)
					throw new Error("Invalid bridge tool turn.");
				const usage = record(message.usage);
				output.usage.input = positive(usage.input);
				output.usage.output = positive(usage.output);
				output.usage.cacheRead = positive(usage.cacheRead);
				output.usage.cacheWrite = positive(usage.cacheWrite);
				output.usage.totalTokens =
					output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				output.stopReason = message.stopReason as "stop" | "length" | "toolUse";
				if (previewStarted) {
					const first = blocks[0];
					if (first?.type !== "text" || !first.text.startsWith(previewText))
						throw new Error("Bridge preview and first content block differ.");
					const finalText = first.text;
					output.content = [{ type: "text", text: finalText }];
					if (finalText.length > previewText.length)
						stream.push({
							type: "text_delta",
							contentIndex: 0,
							delta: finalText.slice(previewText.length),
							partial: output,
						});
					stream.push({ type: "text_end", contentIndex: 0, content: finalText, partial: output });
				}
				for (const block of blocks.slice(previewStarted ? 1 : 0)) {
					const index = output.content.length;
					output.content.push(block);
					if (block.type === "text") {
						stream.push({ type: "text_start", contentIndex: index, partial: output });
						stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: output });
						stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
					} else if (block.type === "thinking") {
						stream.push({ type: "thinking_start", contentIndex: index, partial: output });
						stream.push({ type: "thinking_delta", contentIndex: index, delta: block.thinking, partial: output });
						stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
					} else {
						stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
					}
				}
				stream.push({ type: "done", reason: output.stopReason, message: output });
			} catch (error) {
				if (locked) {
					this.handles.delete(key);
					if (selected && token) await this.cancelHandle(selected, token);
				}
				output.stopReason = controller.signal.aborted ? "aborted" : "error";
				output.errorMessage = controller.signal.aborted
					? "Claude SDK request cancelled or timed out."
					: error instanceof SafeBridgeFailure
						? error.message
						: "Claude SDK transport or validation failed. No direct OAuth or API fallback was attempted.";
				stream.push({ type: "error", reason: output.stopReason, error: output });
			} finally {
				clearTimeout(timeout);
				options.signal?.removeEventListener("abort", abort);
				if (locked) this.active.delete(key);
				if (temporary && selected && token) {
					this.handles.delete(key);
					await this.cancelHandle(selected, token);
				}
				stream.end();
			}
		};
		void run();
		return stream;
	}
}
