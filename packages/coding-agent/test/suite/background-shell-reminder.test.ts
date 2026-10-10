import type { Context } from "@zykairotis/ice-ai";
import { fauxAssistantMessage } from "@zykairotis/ice-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function contextText(context: Context): string {
	return JSON.stringify(context.messages);
}

describe("background shell reminder", () => {
	it("tells the model which shells are still running when the set changes, once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const seen: string[] = [];
		const capture = (context: Context) => {
			seen.push(contextText(context));
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([capture, capture, capture]);

		await harness.session.prompt("nothing running yet");
		expect(seen[0]).not.toContain("Background shells still running");

		const id = harness.session.bashBackground.adopt("npm run dev", Date.now(), () => {}, new Promise(() => {}), {
			origin: "model",
		});
		await harness.session.prompt("what is running?");
		expect(seen[1]).toContain("Background shells still running");
		expect(seen[1]).toContain(`${id} (running`);
		expect(seen[1]).toContain("npm run dev");
		expect(seen[1]).toContain("bash_output");

		// Unchanged: the earlier reminder stays in history and is not repeated.
		await harness.session.prompt("and now?");
		expect(seen[2]!.split("Background shells still running").length - 1).toBe(1);
		harness.session.bashBackground.dispose();
	});
});

describe("background shell stopped by the user", () => {
	it("records the stop for the next turn without starting one", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const seen: string[] = [];
		harness.setResponses([
			(context: Context) => {
				seen.push(contextText(context));
				return fauxAssistantMessage("ok");
			},
		]);
		const id = harness.session.bashBackground.adopt("npm run dev", Date.now(), () => {}, new Promise(() => {}));
		harness.session.bashBackground.kill(id, { notify: true });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		await harness.session.prompt("continue");
		expect(seen[0]).toContain(`The user stopped background shell ${id}`);
		expect(seen[0]).toContain("Do not restart it unless they ask.");
	});
});
