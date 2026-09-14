import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Model } from "@zykairotis/ice-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamOpenAIResponses } from "../../ai/src/api/openai-responses.ts";
import {
	buildSubagentPrompt,
	deriveSubagentPromptCacheKey,
	normalizeSubagentRequest,
	type SubagentForkContextSource,
} from "../src/ice-subagents.ts";

function model(): Model<"openai-responses"> {
	return {
		id: "shape-model",
		name: "shape-model",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 256,
	};
}

function parentContext(): SubagentForkContextSource {
	return {
		getSessionId: () => "parent-session",
		getLeafId: () => "parent-leaf",
		buildSessionContext: () => ({
			messages: [
				{ role: "user", content: "shared parent context", timestamp: 1 },
				{ role: "user", content: "shared follow-up context", timestamp: 2 },
			],
		}),
	};
}

function tools(): NonNullable<Context["tools"]> {
	return [
		{
			name: "read",
			description: "Read one approved file.",
			parameters: Type.Object({ path: Type.String() }),
		},
	];
}

function commonPrefixBytes(left: string, right: string): number {
	const a = Buffer.from(left, "utf8");
	const b = Buffer.from(right, "utf8");
	let index = 0;
	while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
	return index;
}

type Capture = {
	sessionId: string | null;
	cacheRetention: "short";
	payload: Record<string, unknown>;
};

async function capture(
	request: ReturnType<typeof normalizeSubagentRequest>,
	requestModel: Model<"openai-responses">,
	sessionId: string,
	promptCacheKey: string,
): Promise<Capture> {
	let payload: Record<string, unknown> | undefined;
	let capturedSession: string | null = null;
	const context: Context = {
		systemPrompt: request.profile.systemPrompt,
		messages: [{ role: "user", content: buildSubagentPrompt(request), timestamp: 0 }],
		tools: tools(),
	};
	const stream = streamOpenAIResponses(requestModel, context, {
		apiKey: "provider-free-test-key",
		sessionId,
		promptCacheKey,
		cacheRetention: "short",
		maxTokens: 16,
		onPayload: (value) => {
			if (typeof value !== "object" || value === null) throw new Error("Expected object payload");
			payload = value as Record<string, unknown>;
		},
		fetch: async (_input, init) => {
			capturedSession = new Headers(init?.headers).get("session_id");
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!payload) throw new Error("Provider payload was not captured");
	return { sessionId: capturedSession, cacheRetention: "short", payload };
}

describe("fork subagent prompt-cache provider request shape", () => {
	it("keeps sibling sessions distinct while sharing only prompt cache affinity", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "ice-subagent-cache-shape-"));
		try {
			await mkdir(join(cwd, "src"), { recursive: true });
			const base = normalizeSubagentRequest(
				{
					parentSessionId: "parent-session",
					role: "self",
					task: "Inspect sibling one.",
					scope: { roots: ["src"] },
					cwd,
					contextMode: "fork",
					self: { instructions: "Inspect the approved scope and report evidence.", capabilities: ["read"] },
				},
				cwd,
				{ agentDir: join(cwd, ".ice-agent"), parentContext: parentContext() },
			);
			const first = { ...base, task: "Inspect sibling one." };
			const second = { ...base, task: "Inspect sibling two." };
			const requestModel = model();
			const sharedKey = deriveSubagentPromptCacheKey(first, requestModel, ["read"]);
			if (!sharedKey) throw new Error("Expected fork cache key");

			const beforeFirst = await capture(first, requestModel, "child-a", "child-a");
			const beforeSecond = await capture(second, requestModel, "child-b", "child-b");
			const afterFirst = await capture(first, requestModel, "child-a", sharedKey);
			const afterSecond = await capture(second, requestModel, "child-b", sharedKey);

			expect(beforeFirst.sessionId).toBe("child-a");
			expect(beforeSecond.sessionId).toBe("child-b");
			expect(afterFirst.sessionId).toBe("child-a");
			expect(afterSecond.sessionId).toBe("child-b");
			expect(beforeFirst.cacheRetention).toBe("short");
			expect(beforeSecond.cacheRetention).toBe("short");
			expect(beforeFirst.payload.prompt_cache_key).toBe("child-a");
			expect(beforeSecond.payload.prompt_cache_key).toBe("child-b");
			expect(afterFirst.payload.prompt_cache_key).toBe(sharedKey);
			expect(afterSecond.payload.prompt_cache_key).toBe(sharedKey);
			const firstItems = afterFirst.payload.input as Array<{ role?: string; content?: unknown }>;
			const secondItems = afterSecond.payload.input as Array<{ role?: string; content?: unknown }>;
			const firstSystem = firstItems.find((item) => item.role === "system");
			const secondSystem = secondItems.find((item) => item.role === "system");
			const firstUser = firstItems.find((item) => item.role === "user");
			const secondUser = secondItems.find((item) => item.role === "user");
			const firstUserText = (firstUser?.content as Array<{ text?: string }> | undefined)?.[0]?.text;
			const secondUserText = (secondUser?.content as Array<{ text?: string }> | undefined)?.[0]?.text;
			expect(firstSystem?.content).toBe(first.profile.systemPrompt);
			expect(secondSystem?.content).toBe(second.profile.systemPrompt);
			expect(firstUserText).toBe(buildSubagentPrompt(first));
			expect(secondUserText).toBe(buildSubagentPrompt(second));
			expect(afterFirst.payload.tools).toEqual(afterSecond.payload.tools);

			const firstPrompt = buildSubagentPrompt(first);
			const secondPrompt = buildSubagentPrompt(second);
			const taskMarker = "\n\nTask:\n\n";
			const firstTask = firstPrompt.indexOf(taskMarker);
			const secondTask = secondPrompt.indexOf(taskMarker);
			expect(firstTask).toBeGreaterThan(0);
			expect(secondTask).toBe(firstTask);
			expect(firstPrompt.slice(0, firstTask)).toBe(secondPrompt.slice(0, secondTask));

			const beforePrefix = commonPrefixBytes(
				JSON.stringify(beforeFirst.payload),
				JSON.stringify(beforeSecond.payload),
			);
			const afterPrefix = commonPrefixBytes(JSON.stringify(afterFirst.payload), JSON.stringify(afterSecond.payload));
			expect(beforePrefix).toBeGreaterThan(0);
			expect(afterPrefix).toBe(beforePrefix);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
