import { describe, expect, it } from "vitest";
import { mapEndpointModels } from "../src/ice-provider.ts";

describe("local Codex fast-mode model mapping", () => {
	it("enables priority for the verified GPT-6 Luna and Sol routes", () => {
		const models = mapEndpointModels({
			data: ["luna", "sol", "astra"].map((model) => ({
				id: `cx/gpt-6-${model}`,
				capabilities: { reasoning: true, contextWindow: 272000, maxOutput: 128000 },
			})),
		});

		expect(models[0]).toMatchObject({ api: "openai-responses", serviceTiers: ["priority"] });
		expect(models[1]).toMatchObject({ api: "openai-responses", serviceTiers: ["priority"] });
		expect(models[2]?.api).toBe("openai-completions");
		expect(models[2]?.serviceTiers).toBeUndefined();
	});
});
