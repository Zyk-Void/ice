import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../../config.ts";
import { AuthStorage } from "../../core/auth-storage.ts";
import { ModelRegistry } from "../../core/model-registry.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import {
	NativeSubagentRunner,
	type NormalizedSubagentRequest,
	normalizeSubagentRequest,
	type SubagentEvent,
	type SubagentRequest,
	type SubagentTaskContractKind,
} from "../../ice-subagents.ts";
import {
	createQualityBenchmarkRun,
	type LiveQualityBenchMode,
	type LiveQualityBenchOptions,
	measureSubagentQualityRun,
	type QualityCase,
	SubagentQualityBenchError,
	type SubagentQualityObservedToolCall,
	type SubagentQualityRunRecord,
} from "./quality-bench.ts";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const DEFAULT_MODES: readonly LiveQualityBenchMode[] = [
	"plain",
	"structured",
	"contract",
	"contract-no-context",
	"file",
	"batch",
	"review",
];
const FILE_AGENT_DIR = fileURLToPath(new URL("../../../test/fixtures/quality/agent-fixture", import.meta.url));

function taskKind(qualityCase: QualityCase, mode: LiveQualityBenchMode): SubagentTaskContractKind {
	if (mode === "review" || qualityCase.class === "review_precision" || qualityCase.class === "conflicting_evidence") {
		return "review";
	}
	if (qualityCase.class === "implement_verify") return "verify";
	if (
		qualityCase.class === "focused_lookup" ||
		qualityCase.class === "bug_localization" ||
		qualityCase.class === "insufficient_evidence"
	) {
		return "explore";
	}
	return "research";
}

function roleFor(mode: LiveQualityBenchMode): { role: string; self?: SubagentRequest["self"] } {
	if (mode === "file") return { role: "explore" };
	if (mode === "review") return { role: "review" };
	return {
		role: "self",
		self: {
			instructions:
				"Quality benchmark child. Work only from observed repository evidence, cite the files you actually inspect, and state uncertainty instead of guessing.",
			capabilities: [...READ_ONLY_TOOLS],
		},
	};
}

function acceptanceFor(qualityCase: QualityCase): NonNullable<SubagentRequest["acceptanceCriteria"]> {
	return (qualityCase.acceptanceCriteria ?? []).map((criterion) => ({
		id: criterion.id,
		requirement: criterion.requirement,
		required: qualityCase.expectedOutcome.requiredCriterionIds.includes(criterion.id),
		evidence: "path" as const,
	}));
}

function buildRequest(
	qualityCase: QualityCase,
	mode: LiveQualityBenchMode,
	modelRoute: string,
	thinkingLevel: NonNullable<LiveQualityBenchOptions["thinkingLevel"]>,
	repeat: number,
): SubagentRequest {
	const role = roleFor(mode);
	const structured = mode !== "plain";
	const explicitContract =
		mode === "contract" || mode === "contract-no-context" || mode === "file" || mode === "batch" || mode === "review";
	const kind = taskKind(qualityCase, mode);
	return {
		parentSessionId: `quality-bench:${qualityCase.id}:${mode}:${repeat}`,
		role: role.role,
		...(role.self ? { self: role.self } : {}),
		task: qualityCase.objective,
		scope: { roots: ["."] },
		cwd: undefined,
		contextMode: "fresh",
		...(explicitContract
			? {
					kind,
					deliverable:
						"Return a concise result that answers the objective, cites only observed repository paths, and preserves unresolved uncertainty.",
					constraints: ["Do not infer facts you did not observe in the fixture repository."],
					nonGoals: ["Do not modify the fixture repository."],
					verification: { mode: "evidence" as const },
				}
			: {}),
		...(structured ? { acceptanceCriteria: acceptanceFor(qualityCase) } : {}),
		execution: {
			model: modelRoute,
			thinking: thinkingLevel,
			tools: [...READ_ONLY_TOOLS],
		},
	};
}

function independentQualityPassRate(
	qualityCase: QualityCase,
	summary: string,
	reportedEvidencePaths: readonly string[],
): number {
	const normalizedSummary = summary.toLowerCase();
	const fragments = qualityCase.expectedOutcome.requiredAnswerFragments ?? [];
	const fragmentsPass = fragments.every((fragment) => normalizedSummary.includes(fragment.toLowerCase()));
	const evidence = new Set(reportedEvidencePaths.map((path) => path.replaceAll("\\", "/")));
	const requiredEvidencePass = qualityCase.expectedOutcome.requiredEvidencePaths.every(
		(path) => evidence.has(path) || [...evidence].some((observed) => observed.endsWith(`/${path}`)),
	);
	return fragmentsPass && requiredEvidencePass ? 1 : 0;
}

function modeApplies(qualityCase: QualityCase, mode: LiveQualityBenchMode): boolean {
	if (mode === "batch") {
		return (
			qualityCase.class === "batch_coverage" ||
			qualityCase.class === "cross_file_reasoning" ||
			qualityCase.class === "conflicting_evidence"
		);
	}
	if (mode === "review") {
		return (
			qualityCase.class === "review_precision" ||
			qualityCase.class === "conflicting_evidence" ||
			qualityCase.class === "insufficient_evidence"
		);
	}
	return true;
}

function selectedCases(options: LiveQualityBenchOptions): readonly QualityCase[] {
	if (!options.caseIds?.length) return options.fixture.cases;
	const wanted = new Set(options.caseIds);
	const cases = options.fixture.cases.filter((qualityCase) => wanted.has(qualityCase.id));
	if (cases.length !== wanted.size) {
		const known = new Set(cases.map((qualityCase) => qualityCase.id));
		const missing = [...wanted].filter((id) => !known.has(id));
		throw new SubagentQualityBenchError(
			"live_configuration_invalid",
			`Unknown live quality case id(s): ${missing.join(", ")}.`,
		);
	}
	return cases;
}

export async function executeLiveQualityBenchmark(options: LiveQualityBenchOptions) {
	if (!options.modelRoute || !options.modelRoute.includes("/")) {
		throw new SubagentQualityBenchError("credentials_required", "A provider/model route is required.");
	}
	if (!options.gitCommit || options.gitCommit.length > 4096) {
		throw new SubagentQualityBenchError("live_configuration_invalid", "Live quality baseline requires gitCommit.");
	}
	if (!options.worktreePath || options.worktreePath.length > 4096) {
		throw new SubagentQualityBenchError("live_configuration_invalid", "Live quality baseline requires worktreePath.");
	}
	if (
		options.repeats !== undefined &&
		(!Number.isSafeInteger(options.repeats) || options.repeats < 1 || options.repeats > 5)
	) {
		throw new SubagentQualityBenchError("live_configuration_invalid", "Live quality baseline repeats must be 1..5.");
	}
	const route = options.modelRoute;
	const slash = route.indexOf("/");
	if (slash <= 0 || slash === route.length - 1) {
		throw new SubagentQualityBenchError("live_configuration_invalid", "Model route must use provider/model form.");
	}

	const agentDir = getAgentDir();
	const authStorage = AuthStorage.create(`${agentDir}/auth.json`);
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		authPath: `${agentDir}/auth.json`,
		modelsPath: `${agentDir}/models.json`,
	});
	const modelRegistry = new ModelRegistry(modelRuntime);
	const model = modelRegistry.find(route.slice(0, slash), route.slice(slash + 1));
	if (!model || !modelRegistry.hasConfiguredAuth(model)) {
		throw new SubagentQualityBenchError(
			"credentials_required",
			`Model route ${route} is unavailable or has no configured authentication; no benchmark runs were started.`,
		);
	}

	const thinkingLevel = options.thinkingLevel ?? "medium";
	const repeats = options.repeats ?? 1;
	const modes = options.modes?.length ? options.modes : DEFAULT_MODES;
	const cases = selectedCases(options);
	const runner = new NativeSubagentRunner({ agentDir: FILE_AGENT_DIR });
	const records: SubagentQualityRunRecord[] = [];
	const stagedRoot = await mkdtemp(join(tmpdir(), "ice-quality-live-"));
	await cp(options.fixture.repoRoot, stagedRoot, { recursive: true });

	try {
		for (let repeat = 1; repeat <= repeats; repeat++) {
			for (const mode of modes) {
				for (const qualityCase of cases) {
					if (!modeApplies(qualityCase, mode)) continue;
					const startedAt = performance.now();
					const observedToolCalls: SubagentQualityObservedToolCall[] = [];
					let toolCallCount = 0;
					const request = buildRequest(qualityCase, mode, route, thinkingLevel, repeat);
					request.cwd = stagedRoot;
					const runOptions = {
						model,
						modelRuntime,
						projectTrusted: true,
						management: mode === "batch" || mode === "review" ? ("internal" as const) : ("public" as const),
						...(mode === "batch" || mode === "review"
							? { batchId: `quality-${mode}-${repeat}`, taskId: qualityCase.id }
							: {}),
						onEvent: (event: SubagentEvent) => {
							if (event.type !== "subagent_tool_start" || !event.toolName) return;
							toolCallCount += 1;
							observedToolCalls.push({
								tool: event.toolName,
								...(event.path ? { path: event.path } : {}),
							});
						},
					};
					const result =
						mode === "contract-no-context"
							? await (() => {
									const normalized = normalizeSubagentRequest(request, stagedRoot, {
										agentDir: FILE_AGENT_DIR,
										projectTrusted: true,
									});
									const { contextManifest: _omittedManifest, ...legacy } = normalized;
									return runner.runResolved(
										legacy as NormalizedSubagentRequest,
										["delegate", ...READ_ONLY_TOOLS],
										runOptions,
									);
								})()
							: await runner.run(request, ["delegate", ...READ_ONLY_TOOLS], runOptions);
					const reportedEvidencePaths = result.evidence?.paths ?? [];
					const independentPassRate = independentQualityPassRate(
						qualityCase,
						result.summary,
						reportedEvidencePaths,
					);
					const observation = {
						caseId: qualityCase.id,
						gitCommit: options.gitCommit,
						worktreePath: options.worktreePath,
						modelRoute: result.model ?? route,
						thinkingLevel: result.reasoningLevel ?? thinkingLevel,
						childProfile: `${mode}:${result.profile}`,
						taskContractHash: result.taskContractHash,
						contextManifestHash: result.contextManifestHash,
						toolAllowlist: [...READ_ONLY_TOOLS],
						wallMs: performance.now() - startedAt,
						assistantRequestCount: result.observedTurns ?? 0,
						inputTokens: result.usage?.inputTokens,
						outputTokens: result.usage?.outputTokens,
						cacheReadTokens: result.usage?.cacheReadTokens,
						toolCallCount,
						parentFollowUpCount: result.followUpCount ?? 0,
						verificationKind:
							result.reportMode === "structured_report" ? ("structured" as const) : ("plain_bounds" as const),
						requiredCriterionPassRate: independentPassRate,
						reportedEvidencePaths,
						observedToolCalls,
						...(mode === "review"
							? {
									reviewerDefectCount: result.findings?.length ?? 0,
									reviewerFalsePositiveCount: Math.max(0, (result.findings?.length ?? 0) - 1),
								}
							: {}),
						finalSuccess: result.status === "completed" && independentPassRate === 1,
						notes: `live mode=${mode}; repeat=${repeat}; status=${result.status}; assurance=${result.assurance ?? "unknown"}; routeSource=${result.routeSource ?? "unknown"}; diagnostics=${result.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.message}`).join(" | ") || "none"}; summary=${result.summary.replaceAll(/\s+/g, " ").slice(0, 800)}`,
					};
					records.push(measureSubagentQualityRun(options.fixture, observation));
				}
			}
		}
	} finally {
		await runner.shutdown();
		await rm(stagedRoot, { recursive: true, force: true });
	}

	return createQualityBenchmarkRun({
		fixture: options.fixture,
		records,
		minEvidencePrecision: options.minEvidencePrecision ?? 1,
		header: {
			title: "ICE subagent quality baseline (live model)",
			baselineLabel: route,
			currentLabel: route,
		},
	});
}
