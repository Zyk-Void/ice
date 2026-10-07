import { registerFauxProvider } from "@zykairotis/ice-ai/compat";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	resolveIceSubagentCandidates,
	resolveIceSubagentRoute,
	snapshotIceSubagentRoute,
} from "../src/subagents/runtime/routing.ts";

const faux = registerFauxProvider();
afterAll(() => faux.unregister());
const parent = faux.getModel();
const child = { ...parent, provider: "fixture", id: "child/model" };
const runtime = {
	getModel: vi.fn((provider: string, id: string) =>
		provider === child.provider && id === child.id ? child : undefined,
	),
	hasConfiguredAuth: vi.fn(() => true),
};

describe("Ice-owned opt-in child routes", () => {
	it("keeps exact parent identity by default without catalog work", () => {
		runtime.getModel.mockClear();
		expect(resolveIceSubagentRoute({ parent, enabled: false, runtime })).toBe(parent);
		expect(runtime.getModel).not.toHaveBeenCalled();
	});
	it("requires global opt-in and an exact available route", () => {
		expect(() =>
			resolveIceSubagentRoute({ parent, requested: "fixture/child/model", enabled: false, runtime }),
		).toThrow(/disabled/);
		expect(resolveIceSubagentRoute({ parent, requested: "fixture/child/model", enabled: true, runtime })).toBe(child);
		expect(resolveIceSubagentRoute({ parent, requested: "fixture/missing", enabled: true, runtime })).toBe(parent);
	});
	it("rejects missing auth without credential expansion", () => {
		expect(
			resolveIceSubagentRoute({
				parent,
				requested: "fixture/child/model",
				enabled: true,
				runtime: { ...runtime, hasConfiguredAuth: () => false },
			}),
		).toBe(parent);
	});
	it("captures bounded non-secret identity and refuses changed capabilities", () => {
		const captured = snapshotIceSubagentRoute(child);
		expect(Object.keys(captured).sort()).toEqual(["capabilityHash", "modelId", "provider"]);
		expect(
			resolveIceSubagentRoute({ parent: { ...parent, id: "new-parent" }, captured, enabled: true, runtime }),
		).toBe(child);
		expect(() =>
			resolveIceSubagentRoute({
				parent,
				captured,
				enabled: true,
				runtime: { ...runtime, getModel: () => ({ ...child, contextWindow: child.contextWindow + 1 }) },
			}),
		).toThrow(/capabilities changed/);
	});
});

describe("ICE primary/fallback/parent candidates", () => {
	it("prefers primary, then fallback, then parent with bounded skip reasons", () => {
		const primary = { ...parent, provider: "picked", id: "primary" };
		const fallback = { ...parent, provider: "picked", id: "fallback" };
		const candidateRuntime = {
			getModel: (provider: string, id: string) => {
				if (provider === "picked" && id === "primary") return primary;
				if (provider === "picked" && id === "fallback") return fallback;
				return undefined;
			},
			hasConfiguredAuth: () => true,
		};
		expect(
			resolveIceSubagentCandidates({
				parent,
				primary: "picked/primary",
				fallback: "picked/fallback",
				runtime: candidateRuntime,
			}),
		).toMatchObject({ selected: "picked/primary", skipped: [] });
		expect(
			resolveIceSubagentCandidates({
				parent,
				primary: "picked/missing",
				fallback: "picked/fallback",
				runtime: candidateRuntime,
			}),
		).toMatchObject({ selected: "picked/fallback", skipped: [{ reference: "picked/missing" }] });
		const parentOnly = resolveIceSubagentCandidates({
			parent,
			primary: "picked/missing",
			fallback: "picked/also-missing",
			runtime: candidateRuntime,
		});
		expect(parentOnly.model).toBe(parent);
		expect(parentOnly.selected).toBe("parent");
		expect(parentOnly.skipped).toHaveLength(2);
		const duplicate = resolveIceSubagentCandidates({
			parent,
			primary: "picked/primary",
			fallback: "picked/primary",
			runtime: candidateRuntime,
		});
		expect(duplicate).toMatchObject({ selected: "picked/primary", skipped: [] });
	});

	it("rejects policy denial instead of silently rerouting around a restriction", () => {
		expect(() =>
			resolveIceSubagentCandidates({
				parent,
				primary: "fixture/child/model",
				runtime,
				policy: { allowed: () => false },
			}),
		).toThrow(/route policy/);
	});

	it("skips an incompatible primary and uses a compatible fallback", () => {
		const primary = { ...parent, provider: "picked", id: "primary", reasoning: false };
		const fallback = { ...parent, provider: "picked", id: "fallback", reasoning: true };
		const candidateRuntime = {
			getModel: (provider: string, id: string) =>
				provider === "picked" && id === "primary"
					? primary
					: provider === "picked" && id === "fallback"
						? fallback
						: undefined,
			hasConfiguredAuth: () => true,
		};
		const result = resolveIceSubagentCandidates({
			parent: { ...parent, reasoning: true },
			primary: "picked/primary",
			fallback: "picked/fallback",
			runtime: candidateRuntime,
			requirements: { thinking: "high" },
		});
		expect(result.selected).toBe("picked/fallback");
		expect(result.skipped).toEqual([
			{ reference: "picked/primary", reason: 'thinking level "high" is not supported' },
		]);
	});

	it("keeps the captured route authoritative when fallback metadata exists", () => {
		const captured = snapshotIceSubagentRoute(child);
		const fallback = { ...parent, provider: "picked", id: "fallback" };
		const result = resolveIceSubagentRoute({
			parent,
			requested: "fixture/child/model",
			fallback: "picked/fallback",
			captured,
			enabled: true,
			runtime: {
				getModel: (provider: string, id: string) =>
					provider === child.provider && id === child.id
						? child
						: provider === fallback.provider && id === fallback.id
							? fallback
							: undefined,
				hasConfiguredAuth: () => true,
			},
		});
		expect(result).toBe(child);
	});
});
