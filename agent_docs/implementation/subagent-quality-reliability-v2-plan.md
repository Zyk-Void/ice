# Subagent Quality & Reliability V2 Plan

Status: proposal for review (not implemented).

Target worktree: `/home/mewtwo/Zks/ice/.worktrees/all-worktrees-experimental/`

Companion plan: `agent_docs/implementation/subagent-bounds-realignment-plan.md`

Reference corpus: read-only harnesses under `/home/mewtwo/Zks/ice/Agent_harness_references/`.

## Executive diagnosis

ICE does not mainly have a "subagents are too bounded" problem. It has a **quality-contract problem**.

The current implementation already has several strong primitives: bounded owner-scoped runs, explicit tool surfaces, typed acceptance criteria, evidence verification for structured reports, durable/background lifecycle support, same-session follow-up, scoped review batches, output artifacts, check-ins, mid-run compaction, and deterministic route policy. The weak part is that most of those primitives are optional. A normal delegation can still be launched with little more than a `task` string and can complete in `plain_final_turn` mode, where "verification" only proves lineage/output bounds rather than correctness or evidence.

That means the system can safely and reliably return a weak answer.

The quality program therefore needs to improve four things before simply allowing more runtime/concurrency/context:

1. **Parent-to-child task briefing** — force a useful delegation contract instead of terse task strings.
2. **Child bootstrap context** — provide the minimum relevant repository/project context automatically, without restoring ambient authority.
3. **Completion semantics** — distinguish "child returned text" from "child produced evidence-backed work that satisfies the delegated objective."
4. **Repair/synthesis** — reuse the same child session for bounded correction and make batch synthesis expose disagreement/missing coverage instead of merely collecting answers.

The existing bounds-realignment plan remains useful, especially for output projection, artifact capacity, run-shape protection, and context-size friction. It should not be treated as sufficient to fix quality.

## Architecture invariants

These are hard constraints from the repository design and are not relaxed by this plan.

- ICE remains the single authoritative reasoning/tool loop. Do not add a second planner/controller or a hidden autonomous orchestration loop. See `AGENTS.md:20-40`.
- Verification commands and observed artifacts determine completion; model claims do not. See `AGENTS.md:33-35`.
- Delegation stays optional, read-heavy first, non-recursive by default, and writers remain isolated. See `AGENTS.md:36-38`.
- Repository/tool/model content stays untrusted. Project-local executable configuration requires trust. See `AGENTS.md:27-30`.
- Child authority remains explicit and scoped. Improving context must not silently add tools, extensions, packages, network access, MCP connections, or recursive delegation.
- Keep the pathless owner-scoped output-artifact design. Do not return raw filesystem artifact paths to the model.
- Reuse the existing `NativeSubagentRunner`, job registry, check-in, observatory, route, preflight, timeout-supervisor, and AgentSession machinery rather than building parallel replacements.
- No commits, pushes, merges, or releases as part of this plan unless explicitly requested.

## Current-state evidence

### 1. Parent delegation guidance is mostly about *when* to delegate, not *how to brief well*

The current parent guidance only enforces the fan-out rule:

- `packages/coding-agent/src/ice-subagents.ts:648-651` says not to delegate a simple single task and to fan out to at least two children.
- The `delegate`, `delegate_async`, `delegate_batch`, and `review_batch` tools reuse those guidelines.

What is missing from the ordinary delegation guidance is a mandatory briefing doctrine: objective, why the task matters, known facts, what has already been ruled out, exact deliverable, success criteria, evidence requirements, verification method, and what not to touch.

This is a major difference from stronger reference harnesses.

### 2. Ordinary delegation deliberately bypasses structured verification

`normalizeSubagentRequest` selects:

- `structured_report` only when an output schema or acceptance criteria are present.
- `plain_final_turn` for ordinary delegated work.

Evidence: `packages/coding-agent/src/ice-subagents.ts:5153-5218`.

The result renderer is explicit about the consequence:

- plain mode: "no structured report or evidence verification"
- `plain_bounds`: lineage and output bounds only

Evidence: `packages/coding-agent/src/ice-subagents.ts:11460-11482`.

This is acceptable for low-stakes exploratory helpers, but it is too weak as the default completion signal for substantial delegated research, review, testing, or implementation work.

### 3. The child prompt has good safety framing but does not manufacture a missing task contract

`buildSubagentPrompt` injects scope, selected prompt resources, fork/context packets, execution limits, optional acceptance criteria, optional output schema, and the final-answer protocol. It does **not** infer or require a complete delegated objective when the parent only supplies a terse task.

Evidence: `packages/coding-agent/src/ice-subagents.ts:5435-5542`.

This means a weak parent tool call stays weak all the way into the child.

### 4. Safe children intentionally receive very little ambient context

The child resource loader disables ambient packages/extensions/skills/prompt templates/context files and only mounts explicitly selected resources:

- `noPackages: true`
- `noExtensions: true`
- `noSkills: true`
- `noPromptTemplates: true`
- `noContextFiles: true`

Evidence: `packages/coding-agent/src/ice-subagents.ts:6968-6994`.

That is a strong security boundary, but it can make otherwise capable children under-informed unless the parent explicitly passes applicable repository instructions and relevant project context.

The solution is **not** to restore ambient loading. The solution is to add a deterministic, hash-verified, read-only context bootstrap.

### 5. Same-session repair already exists

`NativeSubagentRunner.followUpRuntime` can send a bounded follow-up to the same working child, with ownership checks and stable request IDs.

Evidence: `packages/coding-agent/src/ice-subagents.ts:8079-8113`.

The quality plan should exploit this instead of restarting children after every incomplete result.

### 6. Strict reviewer infrastructure already exists

`review_batch` uses bounded self-delegation, read-only capabilities, structured reports, verified findings, and explicit review dimensions.

Evidence: `packages/coding-agent/src/ice-subagents.ts:10639-10730`.

This should become a reusable verification primitive for high-risk delegated work, not be duplicated by a new reviewer subsystem.

### 7. Self-delegation currently defaults to medium thinking

The bounded self profile uses `thinkingLevel: "medium"` while inheriting the parent model route.

Evidence: `packages/coding-agent/src/ice-subagents.ts:3920-3930`.

The execution contract may override this later, so this is not automatically a bug. It is, however, a benchmark target: self-delegated judgment/review tasks should not be accidentally weaker than the parent because of a default reasoning downgrade.

## Reference findings relevant to quality

### Claude Code: briefing quality is first-class

`AgentTool/prompt.ts` explicitly teaches the parent to brief a fresh child like a colleague with zero context:

- explain what is being accomplished and why;
- describe what is already known or ruled out;
- give enough surrounding context for judgment;
- specify response constraints;
- avoid terse command-style prompts because they produce shallow work;
- do not "delegate understanding"; include concrete paths/lines/known conclusions.

Evidence: `Agent_harness_references/claude-code/src/tools/AgentTool/prompt.ts:99-113`.

Its examples also show independent reviewer tasks receiving the concrete risk context and the exact question to answer: `.../prompt.ts:141-153`.

ICE currently has no equivalent doctrine in its ordinary delegation prompt guidelines.

### OpenCode: persistent child sessions + explicit verification instructions

OpenCode's Task tool tells the parent:

- fresh children need a highly detailed autonomous task description;
- specify exactly what the final response should contain;
- tell the child whether it is researching or writing;
- tell it how to verify its work when possible;
- reuse `task_id` to continue the same child session.

Evidence: `Agent_harness_references/opencode/packages/opencode/src/tool/task.txt:12-19`.

The implementation really does resume an existing child session by task ID and otherwise creates a new child session: `.../src/tool/task.ts:136-184`.

ICE already has a more explicit owner-scoped lifecycle, so the missing part is chiefly the briefing/verification discipline.

### OpenHands: self-contained child brief + independent sibling scopes

OpenHands states that a child cannot see parent conversation history, so the task brief must contain:

- goal;
- relevant file paths;
- constraints;
- expected deliverable;
- reporting/handoff criteria.

It also tells the parent to keep sibling scopes independent to prevent conflicts.

Evidence: `Agent_harness_references/openhands/src/api/launch-child-conversation-client-tool.ts:14-18,32-38,74-78`.

### Oh My Pi: role/model tiers, typed results, persistent workers

Oh My Pi exposes structured per-spawn output schemas and per-spawn effort controls:

- `task/types.ts:114-152` — task, agent, optional output schema/schema mode/tools/isolation/effort.
- `task/agents.ts:43-72` — specialized bundled workers, including a strong general `task` worker and lower-cost `sonic` worker.
- `prompts/agents/task.md:1-16` — worker stays hyperfocused, uses tools, prefers narrow retrieval, avoids filler.

Its user-facing architecture also keeps worker sessions/transcripts alive and steerable. ICE already has most of the lifecycle primitives; the useful lesson is to make role/quality routing intentional rather than using one undifferentiated delegation posture.

## Target design

The target is a **verified delegation pipeline**, not a new orchestrator:

```
parent reasoning loop
    |
    | delegate / delegate_batch
    v
Task Contract Builder
    |
    +-- scope + non-goals
    +-- objective / deliverable
    +-- known facts / prior exclusions
    +-- acceptance criteria
    +-- evidence / verification requirements
    +-- child class + quality tier
    |
    v
Deterministic Context Bootstrap
    |
    +-- applicable AGENTS/project instructions (read-only, hashed)
    +-- selected evidence/context packet
    +-- relevant repo map/targets
    +-- no ambient executable authority
    |
    v
existing NativeSubagentRunner / AgentSession
    |
    +-- scoped tools
    +-- route/reasoning contract
    +-- check-ins / observatory
    +-- same-session follow_up
    |
    v
Completion Gate
    |
    +-- bounded output
    +-- evidence validation
    +-- acceptance-criteria status
    +-- verification-command/tool evidence where declared
    +-- optional reviewer gate for risky work
    |
    +--> verified -> parent synthesis
    |
    +--> incomplete -> bounded same-session repair recommendation
    |
    +--> failed/blocked -> typed unresolved result
```

No stage above gets independent authority to plan arbitrary work. The parent model remains the reasoner; the runtime adds deterministic contracts, context selection, validation, and bounded lifecycle policy.

---

# Phase 0 — Establish a real subagent quality benchmark before changing behavior

This phase is mandatory. Do not tune prompts, context, reasoning, or verification by anecdote.

## 0.1 Add a dedicated quality-eval fixture set

Create a small repository-backed evaluation corpus under the coding-agent tests/fixtures rather than measuring only mocked protocol behavior.

Suggested cases:

1. **Focused lookup** — child must find an exact fact with path/line evidence.
2. **Cross-file reasoning** — answer requires joining behavior from 3-5 files.
3. **Bug localization** — identify root cause without editing.
4. **False-positive-resistant review** — planted clean code plus one real defect.
5. **Implementation + verification** — small scoped edit and a deterministic test.
6. **Partial-context recovery** — initial brief is intentionally missing one fact; parent follow-up supplies it.
7. **Long-running investigation** — enough tool turns to exercise compaction/check-in.
8. **Batch coverage** — 3 independent children with intentionally non-overlapping domains.
9. **Conflicting evidence** — two children see different evidence and synthesis must preserve disagreement.
10. **Insufficient evidence** — correct behavior is to report uncertainty, not fabricate a conclusion.

Do not use only unit mocks for this score. Protocol tests remain unit tests; quality scoring needs real repository retrieval/tool use.

## 0.2 Record exact run provenance

For every quality run persist:

- git commit/worktree identity;
- exact model/provider route;
- thinking/reasoning setting;
- child profile/role;
- task-contract hash;
- context-manifest hash;
- tool allowlist;
- wall time;
- assistant request count;
- input/output/cache token usage where available;
- tool-call count;
- parent follow-up count;
- result verification kind;
- required-criterion pass rate;
- evidence precision;
- reviewer defects/false positives;
- final task success.

This follows `AGENTS.md:40-41`.

## 0.3 Baseline current behavior before implementation

Run the same task set at least 5 times for stochastic live-model cases where cost permits.

Record separate baselines for:

- current ordinary `plain_final_turn`;
- current structured acceptance-criteria path;
- self-delegation;
- file-agent delegation;
- batch delegation;
- review batch.

Do not mix native-harness results with same-model controlled comparisons.

## 0.4 Initial ship gate

A quality change may land only if:

- weighted verified-task success improves over the current baseline;
- no benchmark category regresses materially without an explicit documented tradeoff;
- hallucinated/unobserved evidence does not increase;
- parent repair interventions do not increase unless verified-task success improves enough to justify it;
- median token/runtime overhead is recorded, not hidden.

Do not lock an arbitrary "X% better" target before seeing baseline variance. Record baseline distribution first, then set a minimum-detectable-improvement threshold in the benchmark report.

### Acceptance

- [ ] Reproducible quality fixture set exists.
- [ ] Baseline report records exact route/reasoning/runtime metadata.
- [ ] Plain vs structured-report baseline is measured.
- [ ] Self/file/batch/review paths are separately scored.
- [ ] A human-readable benchmark result artifact is produced.

### Verification

- Targeted test for benchmark harness parsing/scoring.
- At least one dry fixture run with deterministic expected result.
- At least one controlled live-model baseline when credentials are available.

---

# Phase 1 — Add a first-class Delegation Task Contract

The parent must stop being able to accidentally send "go investigate this" as the entire effective brief for substantial work.

## 1.1 Introduce a normalized host-owned task contract

Prefer a small dedicated module, e.g. `ice-subagent-task-contract.ts`, rather than adding another large block to `ice-subagents.ts`.

Proposed normalized shape:

```ts
interface SubagentTaskContract {
  kind: "explore" | "research" | "review" | "implement" | "verify";
  objective: string;
  deliverable: string;
  constraints: readonly string[];
  nonGoals: readonly string[];
  knownFacts: readonly ContextFactRef[];
  acceptanceCriteria: readonly SubagentAcceptanceCriterion[];
  verification: {
    mode: "evidence" | "tests" | "review" | "none";
    commands?: readonly string[]; // declarations only; authority still comes from child tools
  };
}
```

The contract is task semantics, not authority.

- It must not expand scope.
- It must not grant tools.
- It must not select credentials/network access.
- It must be bounded and redacted.
- The normalized contract should receive a deterministic hash for telemetry/replay.

## 1.2 Keep the parent-facing schema concise

Do not force the parent to fill a 15-field object every time.

Reuse existing fields wherever possible:

- `task` -> objective/background prose;
- `scope` -> authority boundary;
- `acceptanceCriteria` -> success criteria;
- `contextPacket` -> verified facts/evidence refs;
- `outputSchema` -> domain-specific payload.

Add only the minimum missing semantic fields, likely:

- `kind`
- `deliverable`
- optional `verification` hints / non-goals

Then normalize these into the richer internal contract.

## 1.3 Strengthen tool prompt guidelines immediately

Before deeper runtime changes, update delegation guidance with the Claude/OpenHands/OpenCode briefing doctrine:

- brief fresh children as zero-context collaborators;
- state objective and why it matters;
- include relevant paths and already-known facts;
- tell the child what not to do;
- state exactly what to return;
- state how to verify when possible;
- keep sibling scopes independent;
- do not delegate synthesis the parent has not performed.

This is a low-risk prompt-only improvement and should be separately benchmarked.

## 1.4 Define quality modes without creating a model-settable budget

Use a host semantic mode, not a caller-provided resource budget:

- `explore`: plain result allowed, explicitly marked evidence-limited.
- `standard`: evidence-backed completion expected.
- `strict`: acceptance criteria + verification gate required.

Default substantial delegated tasks to `standard`. `review_batch` and writer/verification tasks should behave as `strict`.

Do not silently call an `explore` result "verified."

### Acceptance

- [ ] Every normalized run has a bounded task-contract object and hash.
- [ ] Parent tool guidance contains objective/context/deliverable/verification briefing rules.
- [ ] Scope/tool authority remains unchanged by task-contract fields.
- [ ] Existing callers/transcripts remain parseable through compatibility normalization.
- [ ] Result presentation shows the semantic completion class (`explore/standard/strict`).

### Verification

- Contract normalization boundary tests.
- Oversized/duplicate/malformed field rejection tests.
- Regression test proving task-contract text cannot widen scope/tools.
- Benchmark A/B: old parent guidance vs new guidance with runtime behavior otherwise unchanged.

---

# Phase 2 — Deterministic Context Bootstrap

The current secure loader is correct to reject ambient child extensions/packages/context. Preserve that property while fixing under-context.

## 2.1 Automatically select applicable repository instruction files

At normalization/preflight time, derive the instruction chain applicable to the child's approved roots/targets:

- root `AGENTS.md`;
- nested `AGENTS.md` files that govern selected targets;
- other already-supported explicit instruction files only if repository policy recognizes them.

Mount them as **selected, read-only, hash-verified context resources**, not as ambient executable configuration.

The child should be told:

- which instruction files were selected;
- their relative scope;
- that they are untrusted repository guidance below system/tool policy.

Do not restore `noContextFiles: false`.

## 2.2 Add a context manifest

Create a durable bounded manifest containing:

- source type;
- canonical/relative identifier;
- content hash;
- bytes;
- reason selected;
- trust classification.

This makes context handoff inspectable and replayable.

## 2.3 Add task-relevant parent context, not full-chat dumping

Prefer explicit `contextPacket` facts and evidence refs.

For an `auto` bootstrap mode, deterministically include only:

- verified facts already present in structured parent task state;
- paths/artifact refs relevant to the selected targets;
- bounded current-diff/status summary for review tasks;
- applicable instructions.

Do not auto-copy the full conversation transcript.

Keep full `fork` semantics explicit for cases where conversational history is genuinely necessary.

## 2.4 Give children a small repository orientation packet

For cross-file/research tasks, supply a bounded repo map generated from the existing retrieval primitives:

- target files;
- direct neighboring symbols/files;
- package/module identity;
- relevant test locations.

This must be a concise navigation aid, not an embedding-based speculative context dump.

## 2.5 Keep skill inheritance explicit

Self children currently inherit skills only when requested. Preserve opt-in authority.

Possible quality improvement: pass only **already-invoked, task-relevant, read-safe skill instructions** as selected resources when the parent explicitly requests inheritance. Never enable an ambient executable skill merely because it exists in the repo.

### Acceptance

- [ ] Safe children automatically receive applicable repo instructions without ambient extension/package loading.
- [ ] Context manifest is hash-stable and visible in diagnostics.
- [ ] Auto bootstrap never grants additional tool/MCP/network authority.
- [ ] Full conversation fork remains explicit.
- [ ] Context benchmark improves cross-file task success without materially increasing irrelevant context.

### Verification

- Nested-AGENTS selection tests.
- Symlink/out-of-scope rejection tests.
- Hash-change revalidation tests.
- Safe-vs-YOLO authority parity tests.
- Quality benchmark: focused lookup and cross-file reasoning before/after bootstrap.

---

# Phase 3 — Role, model, and reasoning quality routing

Do not hard-code one provider/model. Add task-class-aware routing on top of the existing deterministic ICE route machinery.

## 3.1 Define a small semantic worker taxonomy

Recommended built-in semantic classes:

- **scout** — repository discovery/fact gathering; read-only; low/medium reasoning.
- **researcher** — cross-file synthesis/investigation; read-only; stronger reasoning.
- **reviewer** — adversarial correctness/security/regression review; read-only; strong reasoning.
- **implementer** — scoped writer in isolated worktree; full declared verification.
- **tester** — verification/test execution; no source mutation unless explicitly required.

These can map onto existing file/self profiles. Do not create a separate runtime per class.

## 3.2 Add task-tier policy similar to "fast" vs "good"

The useful Oh My Pi pattern is not its specific model names; it is the separation between mechanical/high-volume work and judgment-heavy work.

Add settings-level route aliases such as:

- `mechanical`
- `judgment`

Each resolves through ICE's existing exact provider/model route policy. Project settings may narrow but must not silently broaden model access.

## 3.3 Audit reasoning inheritance

Benchmark the current self profile's `thinkingLevel: "medium"`.

Desired policy:

- explicit execution thinking wins;
- explicit file-agent/profile thinking wins;
- otherwise inherit a parent-compatible reasoning level for judgment/review tasks rather than silently downgrading;
- mechanical/scout work may intentionally use a lower tier when settings request it.

The chosen reasoning level must be present in telemetry and durable route provenance.

## 3.4 Route by capability requirement, not model prestige

Selection should consider:

- context-window requirement;
- output requirement;
- image requirement;
- requested reasoning level;
- required tool modality.

Reuse `ice-subagent-routing.ts` capability validation rather than adding a second model registry.

### Acceptance

- [ ] Task class -> semantic tier -> existing ICE route is deterministic.
- [ ] No hard-coded external provider/model names.
- [ ] Reasoning level is explicit in run diagnostics.
- [ ] Judgment/reviewer benchmarks do not regress from accidental reasoning downgrade.
- [ ] Mechanical tasks can use a cheaper/faster configured tier without changing authority.

### Verification

- Route precedence tests.
- Unsupported-reasoning fallback tests.
- Parent route unchanged when no tier override is configured.
- Same-model A/B isolates prompt/context improvements from model-quality improvements.

---

# Phase 4 — Turn existing lifecycle primitives into quality supervision

ICE already has `manage_subagent`, follow-up, check-ins, observatory, and repeated-failure tracking. Improve their semantics rather than creating a second controller.

## 4.1 Add typed child progress state

Extend bounded progress/check-in data with deterministic fields where observable:

- current phase: `orienting | investigating | modifying | verifying | wrapping_up`;
- files/evidence observed count;
- last successful tool action;
- last repeated failure;
- blocked reason if child explicitly reports one;
- whether acceptance criteria remain unresolved.

Do not ask the model to emit verbose progress prose every turn.

## 4.2 Make follow-up a first-class repair path

When the parent sees incomplete evidence, provide a concise recommended follow-up action in the result details:

- missing acceptance criterion;
- missing verification evidence;
- contradictory claim;
- out-of-scope evidence;
- malformed structured payload;
- test not run / test failed.

The parent remains responsible for deciding to send `manage_subagent(action="follow_up")`.

Do not automatically start a new child for these cases.

## 4.3 Add a bounded quality-repair policy

Recommended default maximum:

- one corrective follow-up for malformed/incomplete evidence;
- one additional follow-up only when the child made measurable progress;
- then surface a typed unresolved result to the parent.

This obeys the bounded-retry rule and avoids infinite "try again" loops.

## 4.4 Upgrade repeated-failure/doom-loop detection

The supervisor already tracks repeated failed activities. Extend this carefully to detect:

- same tool + materially identical args repeated;
- repeated failure with no new successful evidence;
- repeated read/search cycle over the same targets with no progress.

Behavior:

1. first threshold -> observatory advisory / parent-visible attention;
2. optional parent follow-up recommendation;
3. hard stop only under the host-owned run-shape policy from the companion bounds plan.

Do not use heuristic loop detection to expand tools or rewrite the child's task.

### Acceptance

- [ ] Parent can tell *why* a child is stuck without opening full transcript noise.
- [ ] Same-session repair is the default recovery recommendation.
- [ ] Repair count is bounded and durable.
- [ ] Duplicate/repeated-failure detection cannot terminate a healthy run on a single repeated read.
- [ ] User takeover remains authoritative over parent follow-up.

### Verification

- Follow-up idempotency tests remain green.
- Progress-state transition tests.
- Repeated-failure advisory threshold tests.
- Same-session repair benchmark case.
- Cancellation/takeover races.

---

# Phase 5 — Make "verified completion" materially stronger

This is the core semantic fix.

## 5.1 Stop presenting plain-bounds completion as equivalent to verified work

Introduce explicit result assurance levels, e.g.:

- `unverified_plain`
- `evidence_checked`
- `criteria_verified`
- `verification_executed`
- `review_verified`

These are descriptive runtime states, not model confidence scores.

The parent-facing formatter should never use generic "passed" wording for a mode that only checked bounds/lineage.

## 5.2 Benchmark structured-by-default vs plain-by-default

Do not blindly flip the default.

Run Phase-0 cases with:

A. current `plain_final_turn`;
B. current structured report without acceptance criteria;
C. structured report + task contract/acceptance criteria.

If B/C materially improve evidence precision and verified task success without unacceptable output degradation, make `standard`/strict tasks structured by default and reserve plain mode for explicit exploratory work.

## 5.3 Extend evidence types beyond "path exists"

Where the acceptance-criteria model currently cannot express sufficient verification, add bounded evidence descriptors for:

- file/path observation;
- artifact ID;
- test/command execution digest;
- diff/changed-file evidence;
- explicit "not run" / blocked reason.

Never trust a child-authored string claiming a command ran. Command/test evidence must come from observed tool execution state owned by the runtime.

## 5.4 Verify implementation claims against tool/runtime facts

For implementation/verify tasks, validate claims such as:

- file was actually modified;
- expected file is in the isolated writer workspace;
- declared test command was actually observed;
- command exit status matches claim;
- output artifact belongs to the current owner/run.

This is deterministic verification, not a reviewer model.

## 5.5 Use reviewers selectively

Use existing `review_batch` for:

- security-sensitive changes;
- broad refactors;
- migrations;
- high-impact shared infrastructure;
- cases where deterministic verification cannot establish correctness.

Do not spawn a critic for every trivial child. Reviewer usage should be task-policy driven and benchmarked.

## 5.6 Preserve uncertainty

If evidence is insufficient, final state should be typed as partial/blocked/unverified with unresolved claims.

Never pressure the child into manufacturing a binary success result.

### Acceptance

- [ ] Parent result clearly distinguishes output-bounded vs evidence-verified work.
- [ ] Required criteria cannot pass from model prose alone.
- [ ] Command/test evidence is tied to observed runtime tool state.
- [ ] Structured-vs-plain default is chosen from benchmark data.
- [ ] High-risk reviewer policy reuses `review_batch`.

### Verification

- Fabricated path evidence rejection.
- Fabricated command-run claim rejection.
- Stale artifact ownership rejection.
- Required criterion partial/blocked tests.
- Reviewer disagreement propagation tests.

---

# Phase 6 — Improve batch orchestration and parent synthesis

Concurrency alone does not create useful parallelism.

## 6.1 Give every sibling a coverage contract

Each batch item should have:

- stable id;
- semantic kind;
- objective;
- owned/focus targets;
- explicit non-goals;
- expected deliverable;
- acceptance criteria;
- context manifest.

The parent tool should reject obvious exact duplicate sibling contracts in the same batch.

Do not reject legitimate independent second opinions solely because target paths overlap; distinguish "duplicate work" from "independent reviewer perspective."

## 6.2 Prevent sibling scope collision for writers

Read-only children may inspect overlapping code.

Writer children must have isolated workspaces/worktrees and explicit ownership boundaries. Parent integration remains separate.

Do not allow two sibling writers to silently edit the same shared working directory.

## 6.3 Return per-child usable output references

Adopt the companion bounds-plan requirement that every batch row retains its own bounded output projection + artifact id/reference so the parent can inspect the full result for one child without inflating the whole aggregate.

## 6.4 Add synthesis metadata

Batch result should surface:

- completed/failed/partial per child;
- coverage labels;
- verified criteria per child;
- unresolved claims;
- evidence overlap;
- explicit contradictions/disagreements.

Do not hide disagreement behind a single concatenated summary.

## 6.5 Add role-diverse fan-out patterns

Document and benchmark useful patterns:

- scout + reviewer;
- two independent reviewers on different dimensions;
- researcher siblings by subsystem;
- implementer + tester;
- mechanical scouts feeding one stronger synthesis parent.

The parent performs synthesis; siblings do not recursively delegate.

### Acceptance

- [ ] Batch children have explicit coverage/non-goal metadata.
- [ ] Duplicate exact sibling assignments are caught.
- [ ] Overlap for independent review remains allowed.
- [ ] Per-child full outputs remain addressable.
- [ ] Contradictions are surfaced to parent synthesis.

### Verification

- Duplicate-contract tests.
- Writer collision/isolation tests.
- Contradictory-result fixture.
- Batch artifact ownership tests.
- Batch benchmark with non-overlapping scopes.

---

# Phase 7 — Quality observability and failure diagnosis

A future regression must be explainable from run evidence.

## 7.1 Extend telemetry with quality fields

Record bounded/redacted:

- task contract hash;
- context manifest hash;
- semantic worker class/tier;
- reasoning setting;
- report mode;
- assurance level;
- acceptance-criteria counts;
- unresolved-claim count;
- evidence count/type;
- follow-up count;
- repeated-failure advisory count;
- reviewer use/outcome;
- final status.

No raw secrets or full prompt duplication.

## 7.2 Add parent-visible "why this run is weak" diagnostics

Examples:

- `missing_acceptance_criteria`
- `evidence_unverified`
- `verification_not_run`
- `context_bootstrap_empty`
- `task_brief_under_specified`
- `repeated_tool_failure`
- `review_disagreement`

These are actionable diagnostics, not a scalar "agent score."

## 7.3 Observatory improvements

In the current subagent observatory, show compactly:

- role/tier/model/reasoning;
- task-contract kind;
- phase;
- last useful action;
- assurance level;
- unresolved criteria;
- follow-up count;
- artifact availability.

Keep full transcripts on demand only.

### Acceptance

- [ ] A failed quality benchmark can be traced to brief/context/route/tool/verification/lifecycle cause.
- [ ] Telemetry remains local by default and redacted.
- [ ] No raw task secret is required to compare benchmark runs.
- [ ] Observatory remains bounded under many concurrent children.

### Verification

- Telemetry serialization/redaction tests.
- Observatory truncation tests.
- Durable restore preserves quality metadata required for diagnosis.

---

# Phase 8 — Integrate, but do not conflate, the bounds-realignment plan

The existing bounds plan should remain a separate implementation sequence. Its changes interact with this quality plan as follows.

## Adopt directly after benchmark confirmation

- Larger inline final projection: reduces parent information loss.
- Larger output artifact cap: avoids truncating substantive research.
- Per-child batch artifact references.
- Context handoff cap relaxation: removes artificial friction once relevance selection is improved.
- Host-owned request/run-shape ceiling: tail-risk protection, not a quality strategy.

## Benchmark-gate

- Concurrency increase. More weak children only create weak answers faster. Raise default/hard cap only after batch quality and host pressure benchmarks.
- Very large context handoff. First improve relevance/manifest selection; then raise caps.
- Reasoning/model tier changes. Compare same-model first to avoid attributing model upgrades to orchestration improvements.

## Keep separate semantics

- Output retention failure must not become "verification failure."
- Runtime-budget exhaustion must not be confused with task/acceptance failure.
- Artifact availability, evidence verification, and task correctness are different state dimensions.

---

# Phase 9 — Rollout, documentation, and compatibility

## 9.1 Small landing sequence

Recommended commit-sized implementation order once approved:

1. benchmark harness + baseline report;
2. parent delegation-guidance improvement only;
3. task-contract normalization and diagnostics;
4. deterministic context manifest/instruction bootstrap;
5. assurance-level result semantics;
6. richer evidence verification;
7. same-session repair diagnostics;
8. role/tier routing policy;
9. batch coverage/synthesis metadata;
10. observability/docs;
11. bounds-plan integration and benchmark-gated concurrency changes.

Do not combine all of this into one giant `ice-subagents.ts` patch.

## 9.2 Compatibility strategy

- Existing persisted runs must remain readable.
- Old tool-call transcripts without new semantic fields normalize into a legacy/explore contract and are labeled accordingly.
- New stricter behavior applies to new launches.
- Durable route snapshots remain authoritative.
- Do not silently reinterpret an old plain result as verified.

## 9.3 Documentation

Update:

- `packages/coding-agent/docs/subagent-user-guide.md`
- `packages/coding-agent/docs/settings.md`
- `packages/coding-agent/docs/observability.md`
- `packages/coding-agent/CHANGELOG.md`
- `idea.md`

Keep tool-reference material in the existing subagent user guide unless it becomes large enough to justify a separate document; do not invent a documentation path that is not already part of the repository.

Document:

- how to write a good delegation brief;
- explore vs verified completion;
- context bootstrap contents;
- task classes/tiers;
- same-session repair;
- assurance levels;
- reviewer policy;
- benchmark methodology.

---

# Verification matrix

| Area | Unit / deterministic | Integration | Quality benchmark |
| --- | --- | --- | --- |
| Task contract | normalization, caps, hash, scope non-escalation | delegate/delegate_batch schemas | terse vs rich brief |
| Context bootstrap | AGENTS selection, hash, symlink/scope rejection | child resource loader | cross-file reasoning |
| Routing | exact route precedence, thinking support | child startup provenance | mechanical vs judgment |
| Follow-up | ownership, idempotency, takeover races | same-session repair | missing-context recovery |
| Verification | evidence/path/artifact/command claims | real tool-event binding | implementation + test |
| Batch | duplicate assignment, coverage | per-child artifact/synthesis | parallel coverage |
| Observatory | redaction/truncation | live/durable state | diagnosis usefulness |
| Bounds integration | caps/runtime ladder | large output/context | long investigation |

---

# Definition of Done

This plan is complete only when all of the following are true:

- [ ] A reproducible baseline shows where current ICE subagents fail.
- [ ] Ordinary substantial delegation cannot silently masquerade as strongly verified completion.
- [ ] Parent delegation guidance enforces a high-quality brief.
- [ ] Every child receives the applicable repository instruction chain without ambient authority expansion.
- [ ] Task contract and context manifest are bounded, hashed, and observable.
- [ ] Same-session follow-up is used for bounded repair instead of unnecessary relaunch.
- [ ] Evidence/acceptance verification is tied to runtime-observed facts.
- [ ] Reviewers reuse `review_batch`; no second reviewer framework exists.
- [ ] Mechanical and judgment-heavy work can use different configured quality tiers through the existing route layer.
- [ ] Self-delegation reasoning does not regress judgment tasks because of an accidental default downgrade.
- [ ] Batch siblings have explicit coverage, contradictions remain visible, and writer collision is prevented.
- [ ] Output/artifact/context/concurrency changes from the bounds plan are integrated only where benchmark evidence supports them.
- [ ] Targeted tests, non-e2e suite, and `npm run check` pass after implementation.
- [ ] The final benchmark report records route, reasoning, runtime, token/tool usage, repeated runs, and regressions.
- [ ] `idea.md`, subagent user guide, settings docs, observability docs, and changelog describe the shipped behavior accurately.

## Recommended first implementation slice

If only one slice is implemented first, do **Phase 0 + the prompt-only part of Phase 1**:

1. establish the benchmark;
2. strengthen parent delegation guidance to require objective/context/deliverable/verification;
3. rerun the same model/route.

That isolates whether ICE's largest quality problem is task briefing before touching routing, context sizes, concurrency, or lifecycle policy. It is the cheapest change with the clearest causal signal.

If that produces only a small gain, the next slice should be **Phase 2 + Phase 5**: automatic relevant context plus evidence-backed completion semantics.
