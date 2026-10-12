/**
 * Subagents V2
 *
 * Installs the same subagent extension the `ice` launcher uses, so the model can call
 * `agent` and `agent_control`. The parent session must be persistent: child records and
 * transcripts are durable session entries.
 */

import {
	createAgentSession,
	createIceSubagents,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@zykairotis/ice-coding-agent";

const cwd = process.cwd();
const agentDir = getAgentDir();

// `plan` (the default) keeps children read-only. `build` lets them edit within the parent's
// authority, but an SDK session has no approval UI, so only `ice.subagents.permissions` allow
// rules grant mutations; anything that resolves to `ask` is denied.
const subagents = createIceSubagents({
	agents: {
		summarizer: {
			description: "Summarize files briefly",
			prompt: "Read the files you are given and summarize them.",
		},
	},
});

const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [subagents.extension] });
await resourceLoader.reload();

const { session } = await createAgentSession({
	cwd,
	agentDir,
	resourceLoader,
	sessionManager: SessionManager.create(cwd),
});
subagents.attach(session);

try {
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});
	await session.prompt("Use the summarizer agent to summarize README.md.");
	console.log();

	const overview = subagents.overview();
	console.log(`Subagents: ${overview?.capacity.running ?? 0}/${overview?.capacity.max ?? 0} running`);
	for (const child of overview?.children ?? []) {
		console.log(`  ${child.id} ${child.agent} ${child.state} (${child.lastTurnOutcome ?? "no turn"})`);
	}
} finally {
	session.dispose();
}
