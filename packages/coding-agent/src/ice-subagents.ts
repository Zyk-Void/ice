/**
 * Temporary Phase 1 barrel for the legacy subagent implementation (Plan/subagent-rewrite.md P1.5).
 * Implementation lives under ./subagents/; this file only re-exports the original public names.
 */

export {
	agentSwitcherStatus,
	formatAgentSwitcherLabel,
	SubagentFooterSwitcher as SubagentViewSwitcher,
} from "./modes/interactive/components/subagent-view-switcher.ts";
export type {
	SelfSubagentSnapshotOptions,
	SubagentAgentDirectories,
	SubagentAgentMigrationEntry,
	SubagentProfileResolutionOptions,
	SubagentResourceResolutionOptions,
} from "./subagents/definitions/legacy-profiles.ts";
export {
	getSubagentAgentMigrationManifest,
	getSubagentGlobalAgentsDir,
	listSubagentProfiles,
	resolveSelfSubagentProfile,
	resolveSubagentAgentDirectories,
	resolveSubagentProfile,
	resolveSubagentProfileResolution,
	revalidateSubagentProfile,
	suggestSubagentProfiles,
} from "./subagents/definitions/legacy-profiles.ts";
export type { IceSubagentsOptions } from "./subagents/extension-support.ts";
export {
	formatIceSubagentSettingsSummary,
	normalizeSubagentHookIds,
	resolveSubagentConcurrencyPolicyFromSettings,
} from "./subagents/extension-support.ts";
export type {
	WriterPatchCollectionOptions,
	WriterPatchInspection,
	WriterPatchIntegrationOptions,
	WriterPatchIntegrationResult,
	WriterPatchVerificationContext,
	WriterWorkflowStatus,
	WriterWorkflowToolResult,
} from "./subagents/isolation/writer-patch.ts";
export {
	collectWriterPatchArtifact,
	createWriterWorkspace,
	inspectWriterPatchArtifact,
	integrateWriterPatchArtifact,
	validateWriterLaunchPreflight,
} from "./subagents/isolation/writer-patch.ts";
export { default } from "./subagents/legacy-extension.ts";
export type { SubagentAssuranceLevel } from "./subagents/results/assurance.ts";
export {
	describeSubagentDelegationBreadth,
	emitObservatoryUpdate,
	formatSubagentOutputReference,
} from "./subagents/results/format.ts";
export type { SubagentParsedReport, SubagentReportParseOutcome } from "./subagents/results/report.ts";
export {
	extractCandidateEvidencePaths,
	formatSubagentRequirementSummary,
	normalizeReviewFindings,
	normalizeSubagentOutputSchema,
	parseSubagentReportOutcome,
	verifySubagentResult,
} from "./subagents/results/report.ts";
export type {
	SubagentQualityMode,
	SubagentTaskContract,
	SubagentTaskContractKind,
	SubagentTaskContractVerificationInput,
} from "./subagents/results/task-contract.ts";
export {
	buildSubagentLaunchPreflight,
	createSubagentLaunchProvenance,
	formatSubagentLaunchDigest,
	resolveReviewTask,
	runResolvedReviewBatch,
	runResolvedSubagentBatch,
} from "./subagents/runtime/batch.ts";
export type { SubagentErrorDetails } from "./subagents/runtime/helpers.ts";
export { normalizeSubagentContextPacket, SubagentError } from "./subagents/runtime/helpers.ts";
export type {
	NativeSubagentSession,
	NativeSubagentSessionOptions,
	SubagentHookRuntime,
	SubagentLiveSession,
	SubagentLiveSessionRegistration,
} from "./subagents/runtime/live-session.ts";
export {
	createSubagentLiveSessionControl,
	formatSubagentTranscript,
	resolveSubagentThinkingLevel,
	SubagentLiveSessionRegistry,
} from "./subagents/runtime/live-session.ts";
export {
	buildAcceptanceCriteriaContract,
	buildSubagentPrompt,
	deriveSubagentPromptCacheKey,
	truncateSubagentOutput,
	writeSubagentReportArtifact,
} from "./subagents/runtime/prompt.ts";
export type { SubagentFollowUpStateSnapshot, SubagentNormalizationOptions } from "./subagents/runtime/request.ts";
export {
	applySubagentHookContextAdditions,
	normalizeSubagentAcceptanceCriteria,
	normalizeSubagentExecutionOverride,
	normalizeSubagentForkContext,
	normalizeSubagentRequest,
	normalizeWriterRequest,
	SUBAGENT_FOLLOW_UP_LIMIT,
	SUBAGENT_FOLLOW_UP_STATE_ENTRY_TYPE,
} from "./subagents/runtime/request.ts";
export { resolveSubagentResources, revalidateSubagentResources } from "./subagents/runtime/resources.ts";
export type {
	NativeSubagentResumeOptions,
	NativeSubagentRunnerOptions,
	NativeSubagentRunOptions,
	RetainedSubagentChild,
	SubagentRecoveryHooks,
	SubagentRecoveryStopReason,
} from "./subagents/runtime/runner.ts";
export {
	assertIceSubagentBackendPolicy,
	ICE_SUBAGENT_BACKEND_POLICY,
	NativeSubagentRunner,
	runSubagentWithRecovery,
} from "./subagents/runtime/runner.ts";
export type {
	NativeWriterRunnerOptions,
	NativeWriterRunOptions,
	NativeWriterSession,
	NativeWriterSessionOptions,
	WriterProgressEvent,
} from "./subagents/runtime/session-factory.ts";
export { createNativeSubagentSession, createNativeWriterSession } from "./subagents/runtime/session-factory.ts";
export { NativeWriterRunner } from "./subagents/runtime/writer-runner.ts";
export type { EffectiveSubagentToolOptions } from "./subagents/tools/derive.ts";
export {
	deriveEffectiveSubagentTools,
	deriveSubagentTools,
	deriveUnsafeSubagentTools,
	deriveWriterTools,
} from "./subagents/tools/derive.ts";
export { assertSubagentToolEligible, createScopedWriterToolDefinitions } from "./subagents/tools/scoped-tools.ts";
export type {
	AggregateUsage,
	BatchItemResult,
	EvidenceRef,
	IceSubagentMcpAdapter,
	IceSubagentMcpToolAccess,
	IceSubagentMcpToolAuthorization,
	LaunchProvenance,
	NormalizedSubagentRequest,
	NormalizedWriterRequest,
	ReadonlyWriterPatchArtifact,
	ResolvedReviewTask,
	ResolvedSubagentBatchTask,
	ResolvedSubagentProfile,
	ResolvedSubagentResources,
	ReviewBatchResult,
	ReviewDimension,
	ReviewerModelProvenance,
	ReviewerResult,
	ReviewFinding,
	ReviewTask,
	SanitizedForkMessage,
	SelfDelegationInput,
	SubagentAcceptanceCriterion,
	SubagentAcceptanceCriterionInput,
	SubagentAcceptanceEvidenceKind,
	SubagentAttemptNumber,
	SubagentAttemptSummary,
	SubagentBatchItemResult,
	SubagentBatchResult,
	SubagentBatchRunOptions,
	SubagentBatchStatus,
	SubagentBatchTask,
	SubagentBatchTaskLifecycleEvent,
	SubagentCompactionReason,
	SubagentCompactionStatus,
	SubagentContextItem,
	SubagentContextItemInput,
	SubagentContextItemKind,
	SubagentContextMode,
	SubagentContextPacket,
	SubagentContextPacketInput,
	SubagentDiagnostic,
	SubagentEvent,
	SubagentEvidence,
	SubagentExecutionContract,
	SubagentExecutionOverrideInput,
	SubagentFailureCode,
	SubagentForkContext,
	SubagentForkContextSource,
	SubagentForkDropped,
	SubagentLaunchPreflight,
	SubagentLaunchPreflightTask,
	SubagentLaunchProvenance,
	SubagentManagedHandle,
	SubagentManagedObservation,
	SubagentOutputSchemaNode,
	SubagentOutputSchemaType,
	SubagentProfile,
	SubagentProfileAvailability,
	SubagentProfileKind,
	SubagentProfileSource,
	SubagentProfileSummary,
	SubagentRecoveryMetadata,
	SubagentReportArtifact,
	SubagentReportMode,
	SubagentReportProtocolStatus,
	SubagentRequest,
	SubagentRequestedToolName,
	SubagentRequirementClaim,
	SubagentRequirementClaimStatus,
	SubagentRequirementState,
	SubagentRequirementSummary,
	SubagentResourceKind,
	SubagentResourceProvenance,
	SubagentResourceSelection,
	SubagentResult,
	SubagentRun,
	SubagentScope,
	SubagentStatus,
	SubagentThinkingLevel,
	SubagentToolName,
	SubagentUsage,
	SubagentVerification,
	SubagentWorkArtifact,
	UnsafeSubagentStartupArgOptions,
	WriterLaunchPreflight,
	WriterPatchArtifact,
	WriterPatchFile,
	WriterRequest,
	WriterResult,
	WriterResultStatus,
	WriterToolName,
	WriterWorkspace,
} from "./subagents/types.ts";
export {
	createDelegatedShellEnvironment,
	isBundledSubagentProfileName,
	normalizeUnsafeSubagentStartupArgs,
	REVIEW_DIMENSIONS,
	registerIceSubagentMcpAdapter,
	SUBAGENT_ACCEPTANCE_LIMITS,
	SUBAGENT_BATCH_LIMITS,
	SUBAGENT_CONTEXT_PACKET_LIMITS,
	SUBAGENT_DETACH_RETENTION_MS,
	SUBAGENT_EXECUTION_LIMITS,
	SUBAGENT_FORK_CONTEXT_LIMITS,
	SUBAGENT_HANDOFF_CONTEXT_LIMITS,
	SUBAGENT_MANAGEMENT_WAIT_DEFAULT_MS,
	SUBAGENT_MANAGEMENT_WAIT_LIMIT_MS,
	SUBAGENT_OUTPUT_SCHEMA_LIMITS,
	SUBAGENT_PRESENTATION_LIMIT_BYTES,
	SUBAGENT_PROFILE_ALIASES,
	SUBAGENT_PROFILE_LIMITS,
	SUBAGENT_PROFILE_TAG_LIMITS,
	SUBAGENT_PROFILES,
	SUBAGENT_REPORT_ARTIFACT_LIMITS,
	SUBAGENT_REPORT_LIMITS,
	SUBAGENT_REPORT_PARSER_LIMITS,
	SUBAGENT_REQUESTED_TOOL_NAMES,
	SUBAGENT_TOOL_NAMES,
	SUBAGENT_WRAP_UP_LIMITS,
	subagentMcpToolName,
	WRITER_PATCH_LIMITS,
	WRITER_PATCH_PREVIEW_LIMIT_BYTES,
	WRITER_TOOL_NAMES,
} from "./subagents/types.ts";
export { parseAgentsViewMode } from "./subagents/ui/components.ts";
