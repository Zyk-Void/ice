import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendCogneeObservation,
	COGNEE_OBSERVATION_FILE,
	type CogneeObservation,
	MAX_OBSERVATION_FILE_BYTES,
	readCogneeObservations,
	startCogneeObserver,
} from "../src/ice-cognee-observer.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ice-cognee observer", () => {
	it("keeps every concurrent observation across a size rotation", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-observer-"));
		tempDirs.push(storageDir);
		writeFileSync(join(storageDir, COGNEE_OBSERVATION_FILE), `${"x".repeat(MAX_OBSERVATION_FILE_BYTES - 10)}\n`);
		const ids = Array.from({ length: 20 }, (_, index) => `rot-${index}`);
		await Promise.all(
			ids.map((id) =>
				appendCogneeObservation(storageDir, {
					id,
					at: "2026-08-07T00:00:00.000Z",
					agentId: "a",
					sessionId: "s",
					dataset: "ice",
					operation: "remember_entry",
					phase: "succeeded",
				}),
			),
		);
		const seen = (await readCogneeObservations(storageDir)).map((observation) => observation.id);
		expect(ids.filter((id) => !seen.includes(id))).toEqual([]);
	});

	it("serves a live dashboard state without exposing secrets", async () => {
		const storageDir = mkdtempSync(join(tmpdir(), "ice-cognee-observer-"));
		tempDirs.push(storageDir);
		const observation: CogneeObservation = {
			id: "obs-1",
			at: "2026-08-07T00:00:00.000Z",
			agentId: "ice_agent-1",
			sessionId: "ice_session-1",
			dataset: "ice",
			operation: "remember_entry",
			phase: "succeeded",
			latencyMs: 42,
			preview: "question=hello; Authorization: Bearer [REDACTED]",
		};
		await appendCogneeObservation(storageDir, observation);
		await appendCogneeObservation(storageDir, {
			...observation,
			id: "obs-2",
			preview: "Authorization: Bearer live-secret; token=token-secret",
		});
		const observer = await startCogneeObserver({ storageDir, port: 0 });
		try {
			const page = await fetch(observer.url).then((response) => response.text());
			expect(page).toContain("Cognee Signal Room");
			expect(page).toContain("Event stream");

			const state = (await fetch(`${observer.url}/api/state`).then((response) => response.json())) as {
				events: CogneeObservation[];
			};
			expect(state.events).toHaveLength(2);
			expect(state.events[0]).toMatchObject({
				id: observation.id,
				operation: observation.operation,
				phase: observation.phase,
			});
			expect(state.events[0]?.preview).toContain("[REDACTED]");
			expect(state.events[1]?.preview).toContain("[REDACTED]");
			expect(JSON.stringify(state)).not.toContain("live-secret");
			expect(JSON.stringify(state)).not.toContain("token-secret");
		} finally {
			await observer.close();
		}
	});
});
