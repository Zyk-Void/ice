/**
 * SDK wiring for subagents V2 (Plan/subagent-rewrite.md P9.5).
 *
 * Installs the same extension and view bridge as the `ice` launcher, as an inline
 * extension for `DefaultResourceLoader`, without changing `createAgentSession`:
 *
 *   const subagents = createIceSubagents({ mode: "build" });
 *   const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [subagents.extension] });
 *   await resourceLoader.reload();
 *   const { session } = await createAgentSession({ resourceLoader });
 *   subagents.attach(session);
 */
import type { AgentSession } from "../../core/agent-session.ts";
import type { InlineExtension } from "../../core/extensions/types.ts";
import {
	IceAgentViewBridge,
	type IceSubagentApprovalAnswer,
	type IceSubagentOverview,
} from "../../ice-agent-view-bridge.ts";
import type { IceMode } from "../../ice-safe-verify.ts";
import { getIceSubagentHookHandlers, type IceHookHandler } from "../settings.ts";
import type { IceSubagentMcpAdapter } from "../types.ts";
import iceSubagentsV2 from "./extension.ts";

export interface IceSubagentsSdkOptions {
	/**
	 * Parent execution mode. `build` lets children edit and run commands within the parent's
	 * own authority and the configured permission rules; the default `plan` keeps them read-only.
	 */
	mode?: IceMode;
	/** Extra agent definitions keyed by name; same schema as `ice.subagents.agents` and `--agents`. */
	agents?: Record<string, unknown>;
	/** Trusted in-process hook handlers keyed by the configured hook ID. */
	hookHandlers?: Readonly<Record<string, IceHookHandler>>;
	/** Parent-owned MCP adapter for definitions that select MCP tools. */
	mcpAdapter?: IceSubagentMcpAdapter;
	/** Root for user agent definitions (`<agentDir>/agents`). Default: the ICE agent directory. */
	agentDir?: string;
}

export interface IceSubagentsSdk {
	/** Pass to `DefaultResourceLoader({ extensionFactories })`. */
	readonly extension: InlineExtension;
	/** Bridge to the parent session and its subagents; shared with interactive and RPC hosts. */
	readonly bridge: IceAgentViewBridge;
	/** Bind the created parent session; required before the first `agent` call. */
	attach(session: AgentSession): void;
	/** Capacity, children, and pending approvals; undefined before `attach`. */
	overview(): IceSubagentOverview | undefined;
	/**
	 * Answer a pending approval from `overview().approvals`; false when no longer pending.
	 * Plain SDK sessions have no approval channel, so asks are denied before they queue.
	 */
	respondToApproval(approvalId: string, answer: IceSubagentApprovalAnswer): boolean;
}

/**
 * Subagents for SDK sessions. The parent session must be persistent (`SessionManager.create` or
 * `open`, not `inMemory`): child records and transcripts are durable session entries. Without an
 * interactive UI, permission rules that resolve to `ask` are denied (fail closed); grant work
 * explicitly with `ice.subagents.permissions` allow rules.
 */
export function createIceSubagents(options: IceSubagentsSdkOptions = {}): IceSubagentsSdk {
	const bridge = new IceAgentViewBridge();
	return {
		extension: {
			name: "ice-subagents",
			hidden: true,
			priority: "before-user",
			factory: (ice) =>
				iceSubagentsV2(ice, {
					agentViewBridge: bridge,
					hookHandlers: { ...getIceSubagentHookHandlers(ice.events), ...options.hookHandlers },
					getIceMode: () => options.mode,
					...(options.agents ? { agents: options.agents } : {}),
					...(options.mcpAdapter ? { mcpAdapter: options.mcpAdapter } : {}),
					...(options.agentDir ? { agentDir: options.agentDir } : {}),
				}),
		},
		bridge,
		attach: (session) => bridge.setParentSession(session),
		overview: () => bridge.getSubagentOverview(),
		respondToApproval: (approvalId, answer) => bridge.respondToSubagentApproval(approvalId, answer),
	};
}
