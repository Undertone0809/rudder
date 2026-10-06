import {
  buildModelAttemptSpecs,
  isAgentRuntimeNetworkSuspension,
  parseOpenCodeNativeFailureDiagnostic,
  type AgentRuntimeExecutionContext,
  type AgentRuntimeExecutionResult,
} from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import { runRuntimeSpans, runtimeBindings } from "@rudderhq/db";
import {
  createRudderInlineVisualStreamSuppressor,
  redactRudderInlineVisualSources,
  stripRudderInlineVisualPlacements,
} from "@rudderhq/shared";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import {
  createProfileBoundRuntimeProviderCapabilityResolverFromConfig,
  findServerAdapter,
  getRuntimeDriver,
  piSessionRpcArgsMatchHostProfile,
} from "../agent-runtimes/index.js";
import { prepareRuntimeProviderProfile } from "../agent-runtimes/prepare-runtime-provider-profile.js";
import { buildRuntimeProviderProfileSnapshot, runtimeConfigFromProviderProfileSnapshot } from "../agent-runtimes/runtime-provider-profile-snapshot.js";
import type { StorageService } from "../storage/types.js";
import { approvalService } from "./approvals.js";
import { chatAgentRunService } from "./chat-agent-runs.js";
import { sideChatRuntimeAdmissionSnapshot } from "./chat-assistant.admission-snapshot.js";
import { chatBindingInstructionsRevision } from "./chat-assistant.binding-revision.js";
import { assertClaudeSideChatInputSafe, canRestartPristineClaudeFork, claudeForkFenceForRun, recoverClaudeDeferredForkRun } from "./chat-assistant.claude-fork-recovery.js";
import { cursorAcpTimeoutEvidence } from "./chat-assistant.cursor-diagnostics.js";
import {
  createChatAssistantExecutionOwner,
  createChatAssistantStopFinalizer,
  type ChatAssistantStaleOutcome,
} from "./chat-assistant.execution-owner.js";
import { asRecord, asString, CHAT_RESULT_SENTINEL_PREFIX, ChatAssistantResult, ChatAssistantStreamError, ChatAttachmentPromptReference, createAssistantTextAccumulator, createSentinelStream, extractCodexInlineVisualArtifacts, extractGeneratedAttachments, finalBodyFromRawAssistantText, GenerateChatAssistantReplyInput, maybeEmitAssistantDelta, maybeEmitAssistantState, parseCompletedAssistantReply, partialBodyFromRawAssistantText, prepareChatAttachmentReferences, recoverableFailureMessage, redactChatInlineVisualDiagnosticText, resultText, safeTrim, StreamChatAssistantReplyInput, StreamChatAssistantReplyResult, stubAgent, type ChatRecoverableFailureCode } from "./chat-assistant.helpers.js";
import { createChatNativeAttemptCallbacks } from "./chat-assistant.native-attempt.js";
import { persistChatNativeTransport, resolveChatTranscriptCapability } from "./chat-assistant.native-transcript.js";
import { userImageContentPathsFromMessages } from "./chat-assistant.proposal-validation.js";
import { normalizeReplyInlineVisuals } from "./chat-assistant.reply-artifacts.js";
import { chatAttemptFailureFinishInput, createChatAssistantRuntimeDriverPorts } from "./chat-assistant.runtime-driver.js";
import { buildChatAssistantRuntimePrompt } from "./chat-assistant.runtime-prompt.js";
import {
  chatRuntimeAvailabilityStreamError,
  chatRuntimePreparationStreamError,
  createChatAssistantAvailability,
  createChatAssistantRuntimeResolution,
  isAgentRuntimeType,
} from "./chat-assistant.runtime-resolution.js";
import { chatProviderResultIds } from "./chat-assistant.runtime-result.js";
import {
  chatSessionForCurrentProviderProfile,
  deriveSideChatContextHandoff,
  deriveSideChatNativeForkBoundary,
  deriveSideChatForkSourceForCurrentProfile,
  loadSideChatForkSource,
  resolveChatContinuationSession,
  sideChatForkBindingMatchesTarget,
} from "./chat-assistant.side-chat-source.js";
import { createChatAssistantStdoutBuffer } from "./chat-assistant.stdout-buffer.js";
import { qualifiedChatCodexStdoutPolicy } from "./chat-assistant.stdout-policy.js";
import { createChatNativeStopEvidence } from "./chat-assistant.stop-evidence.js";
import { createChatTranscriptDelivery, resolveChatTranscriptRetention, withNativeSupplementProfile } from "./chat-assistant.transcript-delivery.js";
import { createChatAssistantTranscriptProcessor } from "./chat-assistant.transcript-processor.js";
import { admitClaudeDeferredFork, recordClaudeDeferredForkOutcome, reserveClaudeDeferredFork } from "./claude-deferred-fork-admission.js";
import { preflightManagedAgentWorkspace } from "./managed-workspace-preflight.js";
import {
  executeAdapterWithModelFallbacks,
  resolveExecutionSubmissionPhase,
} from "./runtime-kernel/model-fallback.js";
import { abortReservedNativeForkIntentRunFence, executeNativeForkIntent, markNativeForkIntentUnknown, NativeForkAcceptanceUnknownError, transferReservedNativeForkIntentRunFence, type NativeForkIntentNoChildProof, type NativeForkIntentRunFence } from "./runtime-kernel/native-fork-intent.js";
import { revisionForRuntimeConfig } from "./runtime-kernel/native-session.js";
import { filterNativeTransportProfile } from "./runtime-kernel/native-transport-profile.js";
import type { NativeSpanSelector } from "./runtime-kernel/provider-capabilities.js";
import { createRuntimeApprovalBridge } from "./runtime-kernel/runtime-approval.js";
import { admitSideChatRuntimeFork, type SideChatRuntimeAdmission } from "./side-chat-runtime-admission.js";

export type { ChatAssistantStaleOutcome } from "./chat-assistant.execution-owner.js";
export * from "./chat-assistant.helpers.js";
export * from "./chat-assistant.runtime-overrides.js";

export { sideChatRuntimeAdmissionSnapshot } from "./chat-assistant.admission-snapshot.js";

function adapterSupportsLocalAgentJwt(
  adapter: ReturnType<typeof findServerAdapter>,
  context: AgentRuntimeExecutionContext,
): boolean {
  return adapter?.supportsLocalAgentJwt === true
    || adapter?.supportsLocalAgentJwtForContext?.(context) === true;
}

export function chatAssistantService(db: Db, storage?: StorageService) {
  const chatRunsSvc = chatAgentRunService(db);
  const approvalsSvc = approvalService(db);
  const chatDriverPorts = createChatAssistantRuntimeDriverPorts(db);
  const {
    enrichConversation,
    enrichConversations,
    resolveChatInvocation,
  } = createChatAssistantRuntimeResolution(db);

  function streamChatAssistantReply(
    input: StreamChatAssistantReplyInput & { stream: true },
  ): Promise<StreamChatAssistantReplyResult | ChatAssistantStaleOutcome>;
  function streamChatAssistantReply(
    input: StreamChatAssistantReplyInput,
  ): Promise<StreamChatAssistantReplyResult>;
  async function streamChatAssistantReply(
    input: StreamChatAssistantReplyInput,
  ): Promise<StreamChatAssistantReplyResult | ChatAssistantStaleOutcome> {
    const resolvedInvocation = await resolveChatInvocation({
      conversation: input.conversation,
      contextLinks: input.contextLinks,
      materializeManagedInstructions: true,
      materializeMissingRuntimeSkills: true,
      agentIdSnapshot: input.agentIdSnapshot,
      modelSnapshot: input.modelSnapshot,
      effortSnapshot: input.effortSnapshot,
    }).catch((error) => {
      throw chatRuntimePreparationStreamError(error);
    });
    if (resolvedInvocation.availabilityError) {
      throw chatRuntimeAvailabilityStreamError(
        resolvedInvocation.availabilityError,
      );
    }
    const {
      runtimeSource,
      adapter,
      config: rawConfig,
      linkedIssueIds,
      linkedProjectId,
      linkedGoalId,
      sceneContext,
    } = resolvedInvocation;
    if (
      !adapter ||
      !rawConfig ||
      !sceneContext ||
      !runtimeSource.agentRuntimeType ||
      !runtimeSource.descriptor.runtimeAgentId
    ) {
      throw chatRuntimeAvailabilityStreamError();
    }
    const runtimeAgentType = runtimeSource.agentRuntimeType;
    const runtimeAgentId = runtimeSource.descriptor.runtimeAgentId;
    const resultSentinel = `${CHAT_RESULT_SENTINEL_PREFIX}${randomUUID()}__`;
    const workspace = asRecord(sceneContext.rudderWorkspace);
    let config = rawConfig;
    let runtimeProfilePreparationFailed = false;
    let runtimeProfilePreparationError: unknown;
    try {
      config = await prepareRuntimeProviderProfile({
        runtimeType: runtimeAgentType,
        orgId: input.conversation.orgId,
        agentId: runtimeAgentId,
        config: rawConfig,
        workspace,
      });
    } catch (error) {
      // Admission can still record this pre-provider failure against a real
      // Chat Attempt; never let the profile probe escape before Run creation.
      runtimeProfilePreparationFailed = true;
      runtimeProfilePreparationError = error;
    }
    const existingRuntimeBinding = await db
      .select()
      .from(runtimeBindings)
      .where(and(
        eq(runtimeBindings.orgId, input.conversation.orgId),
        eq(runtimeBindings.conversationId, input.conversation.id),
        eq(runtimeBindings.status, "active"),
      ))
      .orderBy(desc(runtimeBindings.bindingEpoch))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const parentRuntimeBinding = input.conversation.forkedFromConversationId
      ? await db
        .select()
        .from(runtimeBindings)
        .where(and(
          eq(runtimeBindings.orgId, input.conversation.orgId),
          eq(runtimeBindings.conversationId, input.conversation.forkedFromConversationId),
          eq(runtimeBindings.status, "active"),
        ))
        .orderBy(desc(runtimeBindings.bindingEpoch))
        .limit(1)
        .then((rows) => rows[0] ?? null)
      : null;
    const existingBindingRun = existingRuntimeBinding
      ? await db.select({ id: runRuntimeSpans.id }).from(runRuntimeSpans).where(and(
        eq(runRuntimeSpans.orgId, input.conversation.orgId), eq(runRuntimeSpans.bindingId, existingRuntimeBinding.id),
      )).limit(1).then((rows) => rows[0] ?? null) : null;
    const restartPristineFork = Boolean(existingBindingRun && await canRestartPristineClaudeFork({
      db, binding: existingRuntimeBinding, runtimeType: runtimeAgentType,
      orgId: input.conversation.orgId, conversationId: input.conversation.id,
    }));
    // An independently admitted child resumes its own head. Read the parent
    // only for first admission or deferred Claude recovery, never every turn.
    const loadedForkSource = !existingBindingRun || restartPristineFork
      || (input.resumeRunId && runtimeAgentType === "claude_local")
      ? await loadSideChatForkSource(db, input.conversation) : null;
    const isForkConversation = input.conversation.conversationKind === "side_chat"
      || Boolean(input.conversation.forkedFromConversationId || existingRuntimeBinding?.parentBindingId || loadedForkSource?.sourceRunId);
    const sideChatFirstSend = isForkConversation && (!existingBindingRun || restartPristineFork);
    const principalScopeRef = input.principalScopeRef?.trim()
      || asString(input.runContext?.principalScopeRef).trim()
      || `org:${input.conversation.orgId}`;
    const hostId = asString(config.providerHostId ?? config.hostId ?? config.runtimeHostId).trim() || "local";
    const profileId = asString(config.providerProfileId ?? config.profileId ?? config.profile ?? config.authProfile).trim() || "default";
    const workspaceBindingId = asString(config.providerWorkspaceBindingId ?? config.workspaceBindingId
      ?? workspace?.workspaceId ?? workspace?.id ?? workspace?.cwd).trim() || null;
    const providerProfileCwd = asString(config.cwd)
      || asString(workspace?.executionWorkspaceCwd ?? workspace?.cwd ?? workspace?.worktreePath);
    const capabilityRevision = revisionForRuntimeConfig({
      runtimeType: runtimeAgentType,
      planMode: input.conversation.planMode,
      skills: runtimeSource.runtimeSkills.map((skill) => skill.key),
    });
    const providerBinding = { orgId: input.conversation.orgId, hostId, profileId, workspaceBindingId, capabilityRevision };
    const sourceBinding = loadedForkSource?.sourceBinding;
    const sourceBindingMatchesTarget = Boolean(loadedForkSource && sideChatForkBindingMatchesTarget(
      sourceBinding, runtimeAgentType, { ...providerBinding, principalScopeRef },
    ));
    const forkSource = loadedForkSource && sourceBindingMatchesTarget
      ? deriveSideChatForkSourceForCurrentProfile(loadedForkSource, runtimeAgentType, config)
      : loadedForkSource;
    const forkProfile = forkSource?.sourceProviderProfile;
    const historicalForkConfig = forkProfile?.runtimeType === runtimeAgentType
      ? {
        ...config,
        ...runtimeConfigFromProviderProfileSnapshot(forkProfile),
        ...(["pi_local", "opencode_local"].includes(runtimeAgentType) ? filterNativeTransportProfile(forkProfile) : {}),
      }
      : config;
    const providerCapabilityResolver = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
      runtimeType: runtimeAgentType,
      runtimeConfig: historicalForkConfig,
      cwd: asString(historicalForkConfig.cwd) || providerProfileCwd,
    });
    const runtimeDriver = getRuntimeDriver(runtimeAgentType, chatDriverPorts.factoryOptions({
      adapter,
      providerCapabilityResolver,
      providerBinding,
    }));
    const nativeDriverRequired = chatDriverPorts.isNativeRuntime(runtimeAgentType);
    // A native fork is only eligible when its exact sealed span selector was
    // recovered. Missing selector evidence must use the explicit context
    // handoff path instead of asking a provider to guess a mutable head.
    const nativeForkDriver = sourceBindingMatchesTarget && forkSource?.sourceSpanId && forkSource.selectorJson
      ? runtimeDriver
      : null;
    const bindingInput = {
      orgId: input.conversation.orgId,
      conversationId: input.conversation.id,
      principalScopeRef,
      agentId: runtimeAgentId,
      runtimeType: runtimeAgentType,
      hostId,
      profileId,
      workspaceBindingId,
      // A failed profile probe must not reinterpret a good active Binding
      // using the unprepared config and supersede its native session.
      instructionsRevision: runtimeProfilePreparationFailed && existingRuntimeBinding
        ? existingRuntimeBinding.instructionsRevision
        : chatBindingInstructionsRevision({
          runtimeType: runtimeAgentType,
          config,
          existingRevision: existingRuntimeBinding?.instructionsRevision,
        }),
      capabilityRevision,
      parentBindingId: forkSource?.sourceBinding?.id ?? parentRuntimeBinding?.id ?? null,
    };
    let claudeDeferredFork = !runtimeProfilePreparationFailed
      && sideChatFirstSend && !input.resumeRunId && forkSource && runtimeAgentType === "claude_local"
      ? await admitClaudeDeferredFork({
        db, source: forkSource, sourceBindingMatchesTarget, bindingInput, providerBinding, config, conversationId: input.conversation.id,
      }) : null;
    // Exact historical selectors use the durable native fork route below;
    // deferred CLI forking remains limited to a verified provider head.
    const claudeDeferredAdmission = claudeDeferredFork?.useExactNativeFork
      ? null
      : claudeDeferredFork?.admission ?? null;
    const sideChatRuntimeAdmission: SideChatRuntimeAdmission | null = runtimeProfilePreparationFailed
      ? null
      : claudeDeferredAdmission ?? (sideChatFirstSend && forkSource
      ? await admitSideChatRuntimeFork({
        driver: nativeForkDriver,
        source: forkSource,
        targetBinding: providerBinding,
        signal: input.abortSignal,
        executeFork: async (request) => {
          if (!runtimeDriver) throw new Error("Native Side Chat runtime driver is unavailable");
          if (!forkSource.selectorJson) throw new Error("Native Side Chat source selector is unavailable");
          const sourceBinding = forkSource.sourceBinding;
          if (!sideChatForkBindingMatchesTarget(
            sourceBinding, runtimeAgentType, { ...providerBinding, principalScopeRef },
          )) {
            throw new Error("Native Side Chat source does not match the authorized target profile");
          }
          const { binding: targetBinding, nativeSession: targetSession } = await chatDriverPorts.ensureSession(runtimeDriver, {
            ...bindingInput, continuity: "native", sourceBoundaryRef: forkSource.sourceBoundaryRef,
          }, true);
          const outcome = await executeNativeForkIntent({
            db,
            intent: {
              idempotencyKey: `side-chat:${input.conversation.id}`,
              source: {
                orgId: input.conversation.orgId,
                sourceConversationId: forkSource.sourceConversationId,
                sourceRunId: forkSource.sourceRunId!,
                sourceSpanId: forkSource.sourceSpanId!,
              sourceBoundaryRef: forkSource.sourceBoundaryRef!,
              selectorJson: forkSource.selectorJson,
              },
              targetBinding,
              targetSegment: targetSession.segment,
              providerBinding: { ...providerBinding, id: targetBinding.id },
            },
            driver: { fork: async (forkRequest) => {
              // Authorize reading the parent with its own persisted Binding.
              // Only the independently created child is assigned to the target.
              const operation = await runtimeDriver.fork({
                ...forkRequest,
                selector: forkSource.selectorJson as NativeSpanSelector,
                binding: sourceBinding,
              });
              if (operation.status !== "supported") return operation;
              if (operation.value.session.sessionId === request.session.sessionId) {
                throw new Error("Native fork did not create an independent child session");
              }
              return { ...operation, value: { ...operation.value, session: {
                ...operation.value.session,
                sessionParams: { ...operation.value.session.sessionParams, profileBindingId: targetBinding.id },
              } } };
            } },
            sourceSession: request.session,
            boundary: forkSource.sourceBoundaryRef!,
            providerBinding: { ...providerBinding, id: targetBinding.id },
            signal: input.abortSignal,
          });
          if (outcome.status === "unknown") {
            throw new NativeForkAcceptanceUnknownError(outcome.reference, outcome.reason);
          }
          if (outcome.status !== "accepted") {
            throw new Error(`Native Side Chat fork ${outcome.status}; reconciliation is required before retry`);
          }
          return { status: "supported", value: outcome.child };
        },
      })
      : null);
    const nativeContextHandoff = input.nativeContextHandoff
      ?? deriveSideChatContextHandoff(input, sideChatRuntimeAdmission, existingRuntimeBinding?.continuity);
    const nativeForkBoundary = sideChatFirstSend
      ? deriveSideChatNativeForkBoundary(input, sideChatRuntimeAdmission)
      : null;
    const runtimeContinuity = sideChatRuntimeAdmission?.continuity
      ?? (input.conversation.conversationKind === "side_chat" ? "context_handoff" : "native");
    const bindingIntent = {
      ...bindingInput,
      continuity: runtimeContinuity,
      rotateForPristineForkHandoff: restartPristineFork && sideChatRuntimeAdmission?.continuity === "context_handoff",
      sourceBoundaryRef: sideChatRuntimeAdmission
        ? sideChatRuntimeAdmission.sourceBoundaryRef
        : input.conversation.forkedFromMessageId ?? null,
    };
    const { binding: runtimeBinding, nativeSession } = await chatDriverPorts.ensureSession(
      runtimeDriver,
      bindingIntent,
      nativeDriverRequired,
    );
    await assertClaudeSideChatInputSafe({
      db, runtimeType: runtimeAgentType, conversationKind: input.conversation.conversationKind,
      orgId: input.conversation.orgId, conversationId: input.conversation.id,
      bindingId: runtimeBinding.id, providerState: nativeSession.segment.providerStateJson,
      firstSend: sideChatFirstSend, forkConversation: isForkConversation, resumeRunId: input.resumeRunId, userMessageId: input.userMessageId,
    });
    const admittedSession = sideChatRuntimeAdmission?.continuity === "native"
      ? sideChatRuntimeAdmission.session
      : null;
    const initialSessionBeforeProfile = admittedSession ?? nativeSession;
    const resolvedContinuation = await resolveChatContinuationSession(db, {
      runtimeType: runtimeAgentType,
      config,
      binding: runtimeBinding,
      segmentId: nativeSession.segment.id,
      session: initialSessionBeforeProfile,
      admittedSession,
    });
    const admittedPiTransport = runtimeAgentType === "pi_local" && admittedSession
      && forkProfile?.runtimeType === "pi_local"
      ? filterNativeTransportProfile(forkProfile)
      : null;
    const continuationTransport = runtimeAgentType === "pi_local"
      ? admittedPiTransport ?? resolvedContinuation.continuationTransport
      : resolvedContinuation.continuationTransport;
    const runtimeExecutionConfig = runtimeAgentType === "pi_local" && admittedSession
      ? { ...config, ...(admittedPiTransport ?? {}) }
      : resolvedContinuation.runtimeExecutionConfig;
    const initialSession = resolvedContinuation.initialSession;
    const sessionIntent = sideChatRuntimeAdmission?.sessionIntent?.kind === "fork" && initialSession.sessionId
      ? {
        ...sideChatRuntimeAdmission.sessionIntent,
        sessionId: initialSession.sessionId,
        sessionParams: initialSession.sessionParams ?? { sessionId: initialSession.sessionId },
      }
      : sideChatRuntimeAdmission?.sessionIntent ?? (initialSession.sessionId
        ? {
          kind: "resume" as const,
          reuseScope: "explicit" as const,
          sourceRunId: null,
          sessionId: initialSession.sessionId,
          sessionParams: initialSession.sessionParams,
        }
        : { kind: "fresh" as const });
    const transcriptProviderBinding = runtimeAgentType === "pi_local"
      ? { ...providerBinding, id: runtimeBinding.id }
      : providerBinding;
    const transcriptCapabilityResolution = resolveChatTranscriptCapability({
      runtimeType: runtimeAgentType, config, continuationTransport, providerProfileCwd,
      providerCapabilityResolver, binding: transcriptProviderBinding, session: initialSession,
    });
    const transcriptEvidence = transcriptCapabilityResolution?.adapter.transcript?.evidence;
    const { retention: transcriptRetention, profileCapability: nativeProfileCapability } = resolveChatTranscriptRetention({
      hasBinding: Boolean(runtimeBinding),
      bindingContinuity: runtimeBinding.continuity,
      capabilityStatus: transcriptCapabilityResolution?.profileResolved && transcriptEvidence?.profileBound
        ? transcriptEvidence.status
        : "unknown",
      profileCapability: {
        runtimeType: runtimeAgentType,
        binding: transcriptProviderBinding,
        driverStatus: runtimeDriver?.capabilities.transcriptRange?.status ?? "unknown",
        resolution: transcriptCapabilityResolution ?? null,
      },
    });
    const recoveredChatRun = input.resumeRunId
      ? await chatRunsSvc.adoptRecoveredRun(
          input.resumeRunId,
          input.resumeRunOwnerToken ?? "",
        )
      : null;
    const chatRun = recoveredChatRun
      ?? await chatRunsSvc.createRun({
          conversation: input.conversation,
          agentId: runtimeAgentId,
          triggerDetail: input.stream ? "chat_assistant_reply_stream" : "chat_assistant_reply",
          userMessageId: input.userMessageId ?? null,
          chatTurnId: input.chatTurnId ?? null,
          turnVariant: input.turnVariant ?? 0,
          linkedIssueIds,
          linkedProjectId,
          linkedGoalId,
          runContext: {
            ...(input.runContext ?? {}),
            managedMcpPolicySnapshot: config.managedExternalMcpBindings ?? [],
            transcriptSource: transcriptRetention.mode === "legacy" ? "legacy" : "native",
            // Host-prepared transport identity must survive config changes and
            // server restarts. Never persist credentials or accept this from
            // caller context/session metadata.
            runtimeProviderProfile: buildRuntimeProviderProfileSnapshot(runtimeAgentType, { ...config, cwd: providerProfileCwd }),
          },
          sourceMetadata: sideChatRuntimeAdmission
            ? {
              sideChatRuntimeAdmission: sideChatRuntimeAdmissionSnapshot({
                admission: sideChatRuntimeAdmission,
                sourceSelectorJson: forkSource?.selectorJson ?? null,
                deferredForkDescriptor: claudeDeferredFork?.adapterIntent,
              }),
            }
            : null,
          runtimeBinding,
          runtimeSegment: nativeSession.segment,
          sourceRunId: forkSource?.sourceRunId ?? null,
          sourceSpanId: forkSource?.sourceSpanId ?? null,
          sourceSelectorJson: forkSource?.selectorJson ?? null,
          nativeSessionId: initialSession.sessionId,
          nativeSessionParams: initialSession.sessionParams,
          runtimeModel: buildModelAttemptSpecs(runtimeExecutionConfig, runtimeAgentType)[0]?.model ?? null,
          runtimeResumeSource: sideChatRuntimeAdmission
            ? sideChatRuntimeAdmission.continuity === "native" ? "same_session" : "fresh"
            : nativeSession.sessionId ? "same_session" : "fresh",
          inputCorrelationRef: input.userMessageId ?? input.chatTurnId ?? null,
          scene: input.conversation.conversationKind === "side_chat" ? "side_chat" : "chat",
          idempotencyKey: input.userMessageId ?? input.chatTurnId ?? null,
          sessionIntent,
        });
    if (!chatRun) {
      throw new Error("The waiting Chat run could not be reattached");
    }
    const runId = chatRun.id;
    await input.onRunCreated?.(runId);
    const ownedExecution = chatRunsSvc.beginOwnedRunExecution(chatRun);
    let claudeForkRunFence = claudeForkFenceForRun(runtimeAgentType, chatRun);
    let claudeDeferredForkReference: Awaited<ReturnType<typeof reserveClaudeDeferredFork>> | null = null;
    const claudeDeferredForkOutcome: { result: AgentRuntimeExecutionResult | null } = { result: null };
    let pendingClaudeForkTransfer: {
      oldAttemptId: string;
      oldFence: NativeForkIntentRunFence;
      noChildProof: NativeForkIntentNoChildProof;
    } | null = null;
    const executionSignal = input.abortSignal
      ? AbortSignal.any([input.abortSignal, ownedExecution.signal])
      : ownedExecution.signal;
    const transcript = createChatTranscriptDelivery({
      retention: transcriptRetention, recoveredRun: recoveredChatRun, runtimeAgentType, runId,
      spanId: chatRun.runtimeSpanId ?? null,
      markLegacy: () => chatRunsSvc.markLegacyTranscriptSource(chatRun),
      isInactive: () => isExecutionInactive(),
    });
    const runOwner = createChatAssistantExecutionOwner<
      Parameters<typeof chatRunsSvc.finalizeRun>[1],
      Awaited<ReturnType<typeof chatRunsSvc.finalizeRun>>
    >({
      ownerSignal: ownedExecution.signal,
      stopSignal: input.abortSignal,
      beforeFinalize: async () => {
        if (!claudeDeferredForkReference || !claudeDeferredFork?.adapterIntent || !claudeForkRunFence) return;
        if (!pendingClaudeForkTransfer) {
          if (!claudeDeferredForkOutcome.result) {
            // A thrown first-input execution has no observed Fork outcome.
            // Persist uncertainty before terminalizing its still-open Run.
            await markNativeForkIntentUnknown(db, {
              reference: claudeDeferredForkReference,
              runFence: claudeForkRunFence,
              reason: "Claude first-input execution ended without an observed native fork outcome",
            });
          }
          return;
        }
        // Failure/Stop can occur after the old span seals but before transfer.
        // Terminalize its reserved intent before releasing the live Run fence;
        // never convert this cleanup into permission to retry provider input.
        await abortReservedNativeForkIntentRunFence(db, {
          reference: claudeDeferredForkReference,
          runFence: pendingClaudeForkTransfer.oldFence,
          reason: "Claude fork retry ended before the reserved intent was transferred to its next attempt",
        });
        pendingClaudeForkTransfer = null;
      },
      finalize: (finalState) => chatRunsSvc.finalizeRun(runId, {
        ...finalState, resultJson: transcript.terminalResult(finalState.resultJson),
        transcriptDelivery: {
          source: transcript.delivery.source,
          runId: transcript.delivery.runId,
          spanId: chatRun.runtimeSpanId ?? null,
        },
      }),
      failureState: (error) => {
        const unknownForkAcceptance = error instanceof NativeForkAcceptanceUnknownError;
        const errorCode = (error as { errorCode?: unknown } | null)?.errorCode;
        const safeError = redactChatInlineVisualDiagnosticText(
          error instanceof Error ? error.message : String(error),
          "Chat runtime failed while handling private presentation data",
        );
        return {
          status: "failed",
          error: safeError,
          errorCode: unknownForkAcceptance
            ? "native_fork_acceptance_unknown"
            : typeof errorCode === "string"
            ? redactChatInlineVisualDiagnosticText(errorCode, "chat_runtime_exception")
            : "chat_runtime_exception",
          resultJson: {
            outcome: "failed",
            recoverable: !unknownForkAcceptance,
            fallbackEnvelope: true,
            ...(unknownForkAcceptance ? {
              retryable: false,
              ...(runId ? { action: "inspect_run" } : {}),
            } : {}),
          },
        };
      },
    });
    const {
      finalize: finalizeChatRun,
      finalizeUnhandledFailure: finalizeUnhandledRunFailure,
      guard: guardActiveRun,
      isFinalized: isRunFinalized,
      isInactive: isExecutionInactive,
      isOwnerLost: isOwnerExecutionLost,
      isStopped,
      ownerLostError,
      staleOutcome,
    } = runOwner;
    const transcriptDelivery = transcript.delivery;
    const assistantTextAccumulator = createAssistantTextAccumulator();
    const finalAssistantTextAccumulator = createAssistantTextAccumulator();
    const transcriptProcessingState = {
      hasNativeFinalMessage: false,
      hasRuntimeOutputEvidence: false,
    };
    const sentinelStream = createSentinelStream(resultSentinel);
    const inlineVisualStream = createRudderInlineVisualStreamSuppressor();
    const commentaryInlineVisualStream = createRudderInlineVisualStreamSuppressor();
    // This is execution-local evidence only. A reattached Run may already have
    // submitted input in another process, even before this invocation starts.
    let providerDispatched = Boolean(input.resumeRunId);
    const nativeStopEvidence = createChatNativeStopEvidence({
      runId, runtimeType: runtimeAgentType, signal: ownedExecution.signal,
      getCurrentFence: () => ({ orgId: chatRun.orgId, spanId: chatRun.runtimeSpanId,
        attemptId: chatRun.runtimeAttemptRef?.id, ownerToken: chatRun.runtimeSpanOwnerToken,
        attemptEpoch: chatRun.runtimeSpanAttemptEpoch }),
    });
    const { freezeStopCutoff, finalizeStoppedReply } = createChatAssistantStopFinalizer({
      finalAssistantText: () => finalAssistantTextAccumulator.fullText,
      hasNativeFinalMessage: () => transcriptProcessingState.hasNativeFinalMessage,
      resultSentinel,
      visibleText: () => sentinelStream.visibleText,
      isFinalized: isRunFinalized,
      finalize: async (state: Parameters<typeof chatRunsSvc.finalizeRun>[1]) => {
        if (!providerDispatched) {
          const recorded = await guardActiveRun(() => chatRunsSvc.recordNativeExecutionResult(runId, {
            exitCode: null,
            signal: "SIGTERM",
            timedOut: false,
            submissionPhase: "pre_submission",
            nativeWriterQuiescence: { status: "confirmed", source: "not_started" },
          }, {
            orgId: chatRun.orgId,
            spanId: chatRun.runtimeSpanId ?? null,
            attemptId: chatRun.runtimeAttemptRef?.id,
            ownerToken: chatRun.runtimeSpanOwnerToken,
            attemptEpoch: chatRun.runtimeSpanAttemptEpoch,
          }));
          if (!recorded) throw new Error("Chat pre-dispatch Stop could not be recorded against its native span");
        }
        return finalizeChatRun(state);
      },
      finalState: (partialBody) => nativeStopEvidence.stoppedRunState(partialBody),
      onAssistantState: input.onAssistantState,
      replyingAgentId: runtimeAgentId,
    });
    let removeAbortListener: (() => void) | null = null;
    if (input.abortSignal) {
      const abortSignal = input.abortSignal;
      if (abortSignal.aborted) {
        freezeStopCutoff();
      } else {
        abortSignal.addEventListener("abort", freezeStopCutoff, { once: true });
        removeAbortListener = () => abortSignal.removeEventListener("abort", freezeStopCutoff);
      }
    }
    let cleanupPreparedAttachments: (() => Promise<void>) | null = null;
    let durableTranscriptImages = new Map<string, { contentPath: string; displayName: string }>();
    try {
      if (runtimeProfilePreparationFailed) {
        const errorMessage = redactChatInlineVisualDiagnosticText(
          runtimeProfilePreparationError instanceof Error
            ? runtimeProfilePreparationError.message
            : String(runtimeProfilePreparationError),
          "Chat runtime profile preparation failed",
        );
        const failureResult: AgentRuntimeExecutionResult = {
          summary: "",
          resultJson: null,
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage,
          errorCode: "chat_runtime_boot_failed",
          submissionPhase: "pre_submission",
          nativeWriterQuiescence: { status: "confirmed", source: "not_started" },
        };
        const recordedSpan = await guardActiveRun(() => chatRunsSvc.recordNativeExecutionResult(runId, failureResult, {
          orgId: chatRun.orgId,
          spanId: chatRun.runtimeSpanId ?? null,
          attemptId: chatRun.runtimeAttemptRef?.id,
          ownerToken: chatRun.runtimeSpanOwnerToken,
          attemptEpoch: chatRun.runtimeSpanAttemptEpoch,
          error: true,
        }));
        if (!recordedSpan) throw new Error("Chat runtime profile failure could not be recorded against its admitted Attempt");
        await guardActiveRun(() => chatRunsSvc.finishRuntimeAttempt(chatRun, {
          status: "failed",
          submissionPhase: "pre_submission",
          providerThreadId: null,
          providerTurnId: null,
          sessionDisplayId: null,
          sessionParamsJson: null,
          errorCode: "chat_runtime_boot_failed",
          error: errorMessage,
        }));
        await finalizeChatRun({
          status: "failed",
          error: errorMessage,
          errorCode: "chat_runtime_boot_failed",
          resultJson: {
            outcome: "failed",
            recoverable: false,
            fallbackEnvelope: true,
            retryable: false,
            failurePhase: "runtime_boot",
            action: "repair_runtime",
            submissionPhase: "pre_submission",
            nativeWriterQuiescence: { status: "confirmed", source: "not_started" },
            partialBody: "",
          },
        });
        throw new ChatAssistantStreamError(errorMessage, "", [], {
          errorCode: "chat_runtime_boot_failed",
          partialBodyUserVisible: false,
          retryable: false,
          failurePhase: "runtime_boot",
          action: "repair_runtime",
        });
      }
      if (input.resumeRunId && runtimeAgentType === "claude_local" && isForkConversation) {
        claudeDeferredFork = await recoverClaudeDeferredForkRun({
          db, orgId: input.conversation.orgId, conversationId: input.conversation.id,
          run: chatRun, bindingId: runtimeBinding.id, segmentId: nativeSession.segment.id,
          runFence: claudeForkRunFence, allowProviderSubmission: input.resumeRunMaySubmit !== false,
          source: forkSource, sourceBindingMatchesTarget, bindingInput, providerBinding,
          config, finalize: finalizeChatRun,
        });
      }
      let parser = adapter.parseStdoutLine;
      const {
        rudderWorkspace,
        rudderWorkspaces,
        rudderRuntimeServiceIntents,
        rudderScene,
        rudderStartupContext,
        rudderStartupContextMetrics,
      } = sceneContext;
      await guardActiveRun(() => preflightManagedAgentWorkspace({
        agentHome: asString(rudderWorkspace.agentHome),
        instructionsDir: asString(rudderWorkspace.instructionsDir),
        memoryDir: asString(rudderWorkspace.memoryDir),
        lifeDir: asString(rudderWorkspace.lifeDir),
        skillsDir: asString(rudderWorkspace.agentSkillsDir),
      }));
      if (claudeDeferredFork?.reservation) {
        const reservation = claudeDeferredFork.reservation;
        if (!claudeForkRunFence) throw new Error("Claude deferred fork requires an owned Run span before reservation");
        const runFence = claudeForkRunFence;
        claudeDeferredForkReference = await guardActiveRun(() =>
          reserveClaudeDeferredFork(db, reservation, runFence));
      }
      const currentMessage = input.userMessageId
        ? input.messages.find((message) => message.id === input.userMessageId) ?? null
        : [...input.messages].reverse().find((message) => message.role === "user") ?? null;
      const currentMessageIndex = currentMessage
        ? input.messages.findIndex((message) => message.id === currentMessage.id)
        : -1;
      const previousMessage = currentMessageIndex > 0
        ? input.messages[currentMessageIndex - 1] ?? null
        : null;
      const currentAutomationRun = asRecord(currentMessage?.structuredPayload?.automationChatRun);
      const previousAskUserRun = asRecord(previousMessage?.structuredPayload?.automationChatRun);
      const automationRunId = typeof currentAutomationRun?.runId === "string"
        ? currentAutomationRun.runId
        : previousMessage?.role === "assistant" && previousMessage.kind === "ask_user"
          && typeof previousAskUserRun?.runId === "string"
          ? previousAskUserRun.runId
          : null;
      const continuationMessages = automationRunId
        ? input.messages.filter((message) => {
          if (message.id === currentMessage?.id) return false;
          const run = asRecord(message.structuredPayload?.automationChatRun);
          return run?.runId === automationRunId;
        }).slice(-3)
        : [];
      const historicalImageMessages = input.messages
        .slice(-12)
        .filter((message) => message.id !== currentMessage?.id)
        .filter((message) => message.role === "user")
        .filter((message) => message.attachments.some((attachment) =>
          attachment.contentType.toLowerCase().startsWith("image/")
          && Boolean(attachment.contentPath),
        ));
      const promptMessages = [
        ...historicalImageMessages,
        ...continuationMessages.filter((message) => message.id !== currentMessage?.id),
        ...(currentMessage ? [currentMessage] : []),
      ].filter((message, index, messages) =>
        messages.findIndex((candidate) => candidate.id === message.id) === index,
      );
      const usesNativeRuntimeInput = Boolean(runtimeDriver);
      const promptInput = {
        ...input,
        messages: usesNativeRuntimeInput
          ? promptMessages.length > 0 ? promptMessages : input.messages.slice(-1)
          : input.messages.slice(-12),
        nativeContextHandoff,
        nativeForkBoundary,
      };
      const preparedAttachments = await guardActiveRun(() => prepareChatAttachmentReferences({
        runtimeType: runtimeAgentType,
        messages: promptInput.messages,
        storage,
        runId,
      }));
      cleanupPreparedAttachments = preparedAttachments.cleanup;
      durableTranscriptImages = new Map(
        promptInput.messages
          .flatMap((message) => message.attachments)
          .flatMap((attachment) => {
            const localPath = preparedAttachments.references.get(attachment.id)?.localPath;
            return localPath && attachment.contentPath
              ? [[localPath, {
                contentPath: attachment.contentPath,
                displayName: attachment.originalFilename ?? "image",
              }] as const]
              : [];
          }),
      );
      const { prompt, context: chatPromptContext } = await guardActiveRun(() => buildChatAssistantRuntimePrompt({
        promptInput, runtimeSource, resultSentinel, runtimeAgentType, usesNativeRuntimeInput,
        orgResourcesPrompt: typeof rudderWorkspace.orgResourcesPrompt === "string" ? rudderWorkspace.orgResourcesPrompt : "",
        attachmentReferences: preparedAttachments.references,
      }));

      const transcriptProcessor = createChatAssistantTranscriptProcessor({
        callbacks: input,
        isInactive: isExecutionInactive,
        appendTranscriptEntry: withNativeSupplementProfile((entry, delivery) => chatRunsSvc.appendTranscriptEntry(chatRun, entry, delivery), nativeProfileCapability),
        resultSentinel,
        transcriptDelivery,
        assistantTextAccumulator,
        finalAssistantTextAccumulator,
        sentinelStream,
        inlineVisualStream,
        commentaryInlineVisualStream,
        durableTranscriptImages,
        state: transcriptProcessingState,
      });
      const { processTranscriptEntries } = transcriptProcessor;

      const processStdoutLine = async (line: string) => {
        if (isExecutionInactive() || !parser || !line.trim()) return;
        await processTranscriptEntries(parser(line, new Date().toISOString()));
      };

      const stdoutBuffer = createChatAssistantStdoutBuffer({
        isInactive: isExecutionInactive,
        processLine: processStdoutLine,
      });

      if (isStopped()) return finalizeStoppedReply();
      await guardActiveRun(() => maybeEmitAssistantState(input.onAssistantState, "streaming"));
      if (isStopped()) return finalizeStoppedReply();

      const { chatAttachments, media } = await guardActiveRun(() => {
        const submittedAttachmentIds = usesNativeRuntimeInput && !nativeContextHandoff
          ? new Set(currentMessage?.attachments.map((attachment) => attachment.id) ?? [])
          : null;
        const chatAttachments = promptInput.messages
          .flatMap((message) => message.attachments)
          .map((attachment) => {
            const reference = preparedAttachments.references.get(attachment.id);
            return reference && (!submittedAttachmentIds || submittedAttachmentIds.has(attachment.id))
              ? { attachmentId: attachment.id, ...reference }
              : null;
          })
          .filter((attachment): attachment is { attachmentId: string } & ChatAttachmentPromptReference =>
            attachment !== null,
          );
        return {
          chatAttachments,
          media: preparedAttachments.media.filter((attachment) =>
            !submittedAttachmentIds || submittedAttachmentIds.has(attachment.attachmentId),
          ),
        };
      });

      const resumeSessionBeforeProfile = input.resumeRunId
        ? {
            sessionId: chatRun.sessionIdBefore ?? null,
            sessionParams: recoveredChatRun?.sessionParamsBeforeJson ?? null,
            sessionDisplayId: chatRun.sessionIdBefore ?? null,
          }
        : {
            sessionId: initialSession.sessionId,
            sessionParams: initialSession.sessionParams,
            sessionDisplayId: initialSession.sessionDisplayId,
          };
      const resumeSession = chatSessionForCurrentProviderProfile(
        runtimeAgentType,
        resumeSessionBeforeProfile,
        runtimeExecutionConfig,
        runtimeBinding,
      );

      let approvalRuntimeType: string = runtimeAgentType;
      const approvalBridge = createRuntimeApprovalBridge({
        db,
        approvals: approvalsSvc,
        execution: {
          runId,
          orgId: input.conversation.orgId,
          agentId: runtimeAgentId,
          get runtimeType() {
            return approvalRuntimeType;
          },
          chatConversationId: input.conversation.id,
          scene: input.conversation.conversationKind === "side_chat" ? "side_chat" : "chat",
          abortSignal: executionSignal,
          getFence: () => ({
            spanId: chatRun.runtimeSpanId ?? null,
            ownerToken: chatRun.runtimeSpanOwnerToken ?? null,
            attemptEpoch: chatRun.runtimeSpanAttemptEpoch ?? null,
            attemptId: chatRun.runtimeAttemptRef?.id ?? null,
            attemptIndex: chatRun.runtimeAttemptRef?.attemptIndex ?? null,
          }),
        },
        onEvent: async (event) => {
          if (isExecutionInactive()) return;
          await chatRunsSvc.appendEvent(chatRun, {
            eventType: event.eventType,
            stream: "system",
            level: "info",
            message: "agent runtime approval updated",
            payload: event.payload,
          });
        },
      });
      const attemptPorts = chatDriverPorts.createAttemptPorts({
        primaryRuntimeType: runtimeAgentType,
        providerBinding: { ...providerBinding, id: runtimeBinding.id },
        cwd: providerProfileCwd,
        continuationTransport,
        approvalBridge,
        runId,
        orgId: input.conversation.orgId,
        chatId: input.conversation.id,
        abortSignal: executionSignal,
        requestRuntimeSensitiveInput: input.requestRuntimeSensitiveInput,
        initialDriver: runtimeDriver,
        nativeDriverRequired,
        getAttemptId: () => chatRun.runtimeAttemptRef?.id,
        finishAttempt: (failure, phase) => chatRunsSvc.finishRuntimeAttempt(
          chatRun,
          chatAttemptFailureFinishInput(failure, phase, resumeSession),
        ),
      });
      const nativeAttemptCallbacks = createChatNativeAttemptCallbacks({
        orgId: chatRun.orgId,
        runtimeAgentType,
        isNativeRuntime: chatDriverPorts.isNativeRuntime,
        signal: executionSignal,
        isExecutionInactive,
        isOwnerLost: isOwnerExecutionLost,
        ownerLostError,
        getAttempt: () => chatRun.runtimeAttemptRef ?? null,
        getSpanFence: () => ({
          spanId: chatRun.runtimeSpanId ?? null,
          ownerToken: chatRun.runtimeSpanOwnerToken,
          attemptEpoch: chatRun.runtimeSpanAttemptEpoch,
        }),
        markAcceptanceUnknown: (value) => chatRunsSvc.markAcceptanceUnknown(chatRun, value),
        prepareNativeFallback: async (attemptResult, fence, lifecycle) => {
          if (!claudeDeferredForkReference || !claudeDeferredFork?.adapterIntent) return true;
          // Prompt rejection alone cannot prove the CLI did not already create
          // a child. Only internal, non-dispatched execution may transfer intent.
          if (lifecycle.providerDispatched || attemptResult.submissionPhase !== "pre_submission"
            || attemptResult.nativeWriterQuiescence?.status !== "confirmed"
            || attemptResult.nativeWriterQuiescence.source !== "not_started"
            || attemptResult.sessionId || attemptResult.providerThreadId || attemptResult.providerTurnId
            || !claudeForkRunFence || !fence?.attemptId) return false;
          pendingClaudeForkTransfer = {
            oldAttemptId: fence.attemptId,
            oldFence: claudeForkRunFence,
            noChildProof: {
              version: 1, kind: "driver_not_dispatched", providerDispatched: false,
              writerQuiescence: { status: "confirmed", source: "not_started" },
            },
          };
          return true;
        },
        beforeTerminalNativeResult: (attemptResult) => guardActiveRun(async () => {
          let nativeResult = attemptResult;
          if (claudeDeferredForkReference && claudeDeferredFork?.adapterIntent && claudeForkRunFence) {
            // Acceptance must use the still-open owned Span. Recording the
            // native terminal result seals it and invalidates that fork fence.
            nativeResult = await recordClaudeDeferredForkOutcome({
              db,
              reference: claudeDeferredForkReference,
              runFence: claudeForkRunFence,
              intent: claudeDeferredFork.adapterIntent,
              result: attemptResult,
              providerTurnId: chatProviderResultIds(attemptResult).providerTurnId,
            });
            claudeDeferredForkOutcome.result = nativeResult;
          }
          return nativeResult;
        }),
        recordNativeExecutionResult: (attemptResult, fence) => guardActiveRun(async () => {
          const recorded = await chatRunsSvc.recordNativeExecutionResult(runId, attemptResult, fence);
          nativeStopEvidence.observe({ recorded, result: attemptResult, fence });
          return recorded;
        }),
        onAttemptResult: attemptPorts.onAttemptResult,
      });

      const executeChatAdapter = async (chatPrompt: string) => {
        if (runtimeAgentType === "pi_local" && resumeSession.sessionId
          && !piSessionRpcArgsMatchHostProfile(resumeSession.sessionParams, continuationTransport.rpcArgs)) {
          throw new Error("Pi continuation requires RPC args matching the host-owned transport profile.");
        }
        const executionContext: AgentRuntimeExecutionContext = {
          runId,
          agent: stubAgent({
            orgId: input.conversation.orgId,
            agentRuntimeType: runtimeAgentType,
            agentRuntimeConfig: runtimeExecutionConfig,
            sourceLabel: runtimeSource.descriptor.sourceLabel,
            sourceId: runtimeAgentId,
          }),
          runtime: {
            sessionId: resumeSession.sessionId,
            sessionParams: resumeSession.sessionParams,
            sessionDisplayId: resumeSession.sessionDisplayId,
            taskKey: null,
          },
          config: runtimeExecutionConfig,
          context: {
            chatPrompt,
            ...chatPromptContext,
            chatConversationId: input.conversation.id,
            chatMode: true,
            rudderCodexStdoutPolicy: qualifiedChatCodexStdoutPolicy({
              runtimeType: runtimeAgentType, retentionMode: transcriptRetention.mode,
              runId, orgId: input.conversation.orgId, config: runtimeExecutionConfig,
              providerBinding, bindingId: runtimeBinding.id,
            }),
            rudderChatInlineVisualProtocolVersion: 1,
            rudderScene,
            rudderWorkspace,
            rudderWorkspaces,
            rudderStartupContext,
            rudderStartupContextMetrics,
            ...(claudeDeferredFork?.adapterIntent ? { rudderNativeForkIntent: claudeDeferredFork.adapterIntent } : {}),
            ...(nativeContextHandoff ? { rudderNativeContextHandoff: nativeContextHandoff } : {}),
            ...(chatAttachments.length > 0 ? { chatAttachments } : {}),
            ...(rudderRuntimeServiceIntents ? { rudderRuntimeServiceIntents } : {}),
            ...(linkedProjectId ? { projectId: linkedProjectId } : {}),
            ...(linkedGoalId ? { goalId: linkedGoalId } : {}),
            ...(linkedIssueIds[0] ? { issueId: linkedIssueIds[0] } : {}),
            ...(linkedIssueIds.length > 0 ? { issueIds: linkedIssueIds } : {}),
          },
          ...(media.length > 0 ? { media } : {}),
          onNativeTransportProfile: (profile) => persistChatNativeTransport({
            db, profile, runtimeType: runtimeAgentType, config, providerProfileCwd,
            binding: transcriptProviderBinding, continuity: runtimeBinding.continuity,
            resumeSessionId: resumeSession.sessionId, run: chatRun, transcript,
            isInactive: isExecutionInactive,
          }),
          onNativeExecutionIdentity: (identity) => chatRunsSvc.bindNativeExecutionIdentity(
            chatRun,
            identity,
            nativeProfileCapability,
          ),
          onTranscriptSource: transcript.onTranscriptSource,
          onMeta: async (meta) => {
            if (isExecutionInactive()) return;
            await chatRunsSvc.appendAdapterInvoke(chatRun, meta, runtimeSource.runtimeSkills);
            if (isExecutionInactive()) return;
            await input.onInvocationMeta?.({
              ...meta,
              loadedSkills: runtimeSource.runtimeSkills,
            });
          },
          authToken: undefined,
          abortSignal: executionSignal,
          controlCoordinator: input.controlCoordinator,
          requestApproval: attemptPorts.requestApproval,
          waitForApproval: attemptPorts.waitForApproval,
          requestTransientInput: attemptPorts.requestTransientInput,
          onLog: async (stream, chunk) => {
            if (isExecutionInactive()) return;
            if (stream === "stdout") {
              if (chunk.startsWith("[rudder]")) {
                await processTranscriptEntries([{
                  kind: "stdout",
                  ts: new Date().toISOString(),
                  text: chunk,
                }]);
                return;
              }
              await stdoutBuffer.append(chunk);
            }
          },
        };
        executionContext.authToken = adapterSupportsLocalAgentJwt(adapter, executionContext)
          ? createLocalAgentJwt(
            runtimeAgentId,
            input.conversation.orgId,
            runtimeAgentType,
            runId,
          ) ?? undefined
          : undefined;
        return executeAdapterWithModelFallbacks(adapter, executionContext, {
          resolveAdapter: findServerAdapter,
          resolveDriver: attemptPorts.resolveDriver,
          submitInputThroughDriver: true,
          nativeDriverRequired,
          onProviderDispatch: () => { providerDispatched = true; },
          createAuthToken: (agentRuntimeType, attemptAdapter, attemptContext) =>
            adapterSupportsLocalAgentJwt(attemptAdapter, attemptContext)
              ? createLocalAgentJwt(
                runtimeAgentId,
                input.conversation.orgId,
                agentRuntimeType,
                runId,
              ) ?? undefined
              : undefined,
          onAttemptStart: async (attempt, attemptAdapter) => {
            if (isExecutionInactive()) throw ownerLostError;
            const attemptRuntimeType = attempt.agentRuntimeType ?? runtimeAgentType;
            if (!isAgentRuntimeType(attemptRuntimeType)) {
              throw new Error(`Unsupported Chat runtime type: ${attemptRuntimeType}`);
            }
            approvalRuntimeType = attemptRuntimeType;
            parser = attemptAdapter.parseStdoutLine;
            const attemptRef = await chatRunsSvc.beginRuntimeAttempt(chatRun, {
              attemptIndex: attempt.index,
              fallbackIndex: attempt.fallbackIndex,
              runtimeType: attemptRuntimeType,
              model: attempt.model,
              isFallback: attempt.isFallback,
              resumeSource: resumeSession.sessionId ? "same_session" : "fresh",
            });
            chatRun.runtimeAttemptRef = attemptRef;
            if (pendingClaudeForkTransfer && claudeDeferredForkReference) {
              const newFence = claudeForkFenceForRun(runtimeAgentType, chatRun);
              if (!newFence || isExecutionInactive()) throw ownerLostError;
              const transferred = await guardActiveRun(() => transferReservedNativeForkIntentRunFence(db, {
                reference: claudeDeferredForkReference!,
                idempotencyKey: `side-chat:${input.conversation.id}`,
                ...pendingClaudeForkTransfer!,
                newFence,
              }));
              claudeForkRunFence = transferred.runFence;
              pendingClaudeForkTransfer = null;
            }
          },
          ...nativeAttemptCallbacks,
          onAttemptFailure: attemptPorts.onAttemptFailure,
        });
      };

      let result = await guardActiveRun(() => executeChatAdapter(prompt));
      const claudeDeferredForkRecordedResult = claudeDeferredForkOutcome.result;
      if (claudeDeferredForkRecordedResult) {
        // Keep the executor's aggregate attempt metadata; fork acceptance
        // normalizes only the returned native session identity.
        result = {
          ...result,
          sessionId: claudeDeferredForkRecordedResult.sessionId,
          sessionParams: claudeDeferredForkRecordedResult.sessionParams,
          sessionDisplayId: claudeDeferredForkRecordedResult.sessionDisplayId,
        };
      }
      const networkSuspension = isAgentRuntimeNetworkSuspension(result.networkSuspension)
        ? result.networkSuspension
        : isAgentRuntimeNetworkSuspension(result.suspension)
          ? result.suspension
          : null;
      const submissionPhase = resolveExecutionSubmissionPhase(result);
      const { providerThreadId, providerTurnId } = chatProviderResultIds(result);
      await guardActiveRun(() => chatRunsSvc.recordNativeExecutionResult(runId, result, {
        orgId: chatRun.orgId,
        spanId: chatRun.runtimeSpanId ?? null,
        attemptId: chatRun.runtimeAttemptRef?.id,
        ownerToken: chatRun.runtimeSpanOwnerToken,
        attemptEpoch: chatRun.runtimeSpanAttemptEpoch,
        suspended: Boolean(networkSuspension),
      }));
      if (networkSuspension) {
        await guardActiveRun(() => chatRunsSvc.markRuntimeAttemptWaiting(chatRun, {
          submissionPhase: networkSuspension.submissionPhase,
          providerThreadId,
          providerTurnId,
          sessionDisplayId: result.sessionDisplayId ?? result.sessionId ?? null,
          sessionParamsJson: result.sessionParams,
          errorCode: result.errorCode ?? null,
          error: result.errorMessage ?? null,
        }));
      } else {
        await guardActiveRun(() => chatRunsSvc.finishRuntimeAttempt(chatRun, {
          status: result.timedOut
            ? "timed_out"
            : (result.exitCode ?? 0) !== 0 || result.errorMessage
              ? "failed"
              : "succeeded",
          submissionPhase,
          providerThreadId,
          providerTurnId,
          sessionDisplayId: result.sessionDisplayId ?? result.sessionId ?? null,
          sessionParamsJson: result.sessionParams,
          usageDeltaJson: result.usage as unknown as Record<string, unknown> | null,
          costUsd: result.costUsd,
          errorCode: result.errorCode ?? null,
          error: result.errorMessage ?? null,
        }));
      }

      if (isStopped()) return finalizeStoppedReply();
      await guardActiveRun(() => stdoutBuffer.flush());
      if (isStopped()) return finalizeStoppedReply();

      if (networkSuspension) {
        const partialBody = redactRudderInlineVisualSources(
          partialBodyFromRawAssistantText(
            transcriptProcessingState.hasNativeFinalMessage ? finalAssistantTextAccumulator.fullText : "",
            resultSentinel,
          )
          || (safeTrim(sentinelStream.visibleText) ?? ""),
        );
        await guardActiveRun(() => chatRunsSvc.markWaitingForNetwork(
          chatRun,
          networkSuspension,
          chatRun.runtimeSpanOwnerToken,
        ));
        await guardActiveRun(() => input.onWaitingForNetwork?.(networkSuspension));
        return {
          outcome: "waiting_for_network",
          partialBody,
          replyingAgentId: runtimeAgentId,
          suspension: networkSuspension,
        };
      }
      const terminalVisibleDelta = `${inlineVisualStream.push(sentinelStream.finish())}${inlineVisualStream.finish()}`;
      await guardActiveRun(() => maybeEmitAssistantDelta(input.onAssistantDelta, terminalVisibleDelta));
      if (isStopped()) return finalizeStoppedReply();

      const rawResultText = resultText(result);
      const finalAssistantText = transcriptProcessingState.hasNativeFinalMessage
        ? finalAssistantTextAccumulator.fullText
        : "";
      const partialBody =
        redactRudderInlineVisualSources(partialBodyFromRawAssistantText(
          finalAssistantText,
          resultSentinel,
        )) ||
        (safeTrim(inlineVisualStream.visibleText) ?? "");
      const finalPartialBody =
        redactRudderInlineVisualSources(
          finalBodyFromRawAssistantText(rawResultText, resultSentinel)
          || finalBodyFromRawAssistantText(finalAssistantText, resultSentinel),
        );

      if (isStopped()) return finalizeStoppedReply();

      if (result.timedOut) {
        const errorCode = "chat_timed_out";
        const cursorTimeout = cursorAcpTimeoutEvidence(result);
        await finalizeChatRun({
          status: "timed_out",
          error: "Chat request timed out",
          errorCode,
          resultJson: {
            outcome: "failed",
            recoverable: true,
            fallbackEnvelope: true,
            partialBody: finalPartialBody,
            ...(cursorTimeout ? { cursorAcpTimeout: cursorTimeout } : {}),
          },
        });
        throw new ChatAssistantStreamError(
          "Chat request timed out",
          finalPartialBody,
          [],
          {
            errorCode,
            partialBodyUserVisible: Boolean(finalPartialBody),
          },
        );
      }
      if ((result.exitCode ?? 0) !== 0 || result.errorMessage) {
        const hasModelOutputEvidence = Boolean(
          finalPartialBody
          || partialBody
          || rawResultText
          || finalAssistantText
          || transcriptProcessingState.hasRuntimeOutputEvidence,
        );
        const rawProviderFailure = asRecord(result.resultJson?.providerFailure);
        const nativeFailure = parseOpenCodeNativeFailureDiagnostic(result.resultJson?.nativeFailure);
        const authProviderFailure = result.errorCode === "codex_provider_auth_required"
          && rawProviderFailure?.classification === "authentication"
          && rawProviderFailure.retryable === false
          ? {
            classification: "authentication",
            retryable: false,
            shortCircuited: rawProviderFailure.shortCircuited === true,
            reason: "codex_provider_auth_required",
            ...(typeof rawProviderFailure.readinessFingerprint === "string"
              ? { readinessFingerprint: rawProviderFailure.readinessFingerprint }
              : {}),
            ...(typeof rawProviderFailure.readinessState === "string"
              ? { readinessState: rawProviderFailure.readinessState }
              : {}),
          }
          : null;
        const forkAcceptanceUnknown = result.errorCode === "claude_fork_acceptance_unknown";
        const submissionAcceptanceUnknown = submissionPhase === "indeterminate";
        const errorCode: ChatRecoverableFailureCode = authProviderFailure
          ? "codex_provider_auth_required"
          : forkAcceptanceUnknown
            ? "claude_fork_acceptance_unknown"
            : submissionAcceptanceUnknown
              ? "chat_submission_acceptance_unknown"
          : hasModelOutputEvidence
            ? "chat_adapter_failed"
            : "chat_runtime_boot_failed";
        const acceptanceUnknown = forkAcceptanceUnknown || submissionAcceptanceUnknown;
        // Lost acknowledgement can precede item completion, so no final-answer
        // record exists yet. Preserve the response projection already shown to
        // the user; commentary and reasoning never enter this stream.
        const failedPartialBody = finalPartialBody || (acceptanceUnknown ? partialBody : "");
        const retryable = !authProviderFailure && !acceptanceUnknown && errorCode !== "chat_runtime_boot_failed";
        const failurePhase = acceptanceUnknown || errorCode === "chat_adapter_failed" ? "model_generation" : "runtime_boot";
        const action = acceptanceUnknown ? "inspect_run" : errorCode === "chat_adapter_failed" ? "retry" : "repair_runtime";
        const adapterErrorMessage = redactChatInlineVisualDiagnosticText(
          result.errorMessage,
          "Chat adapter execution failed while handling private presentation data",
        );
        await finalizeChatRun({
          status: "failed",
          error: adapterErrorMessage,
          errorCode,
          resultJson: {
            outcome: "failed",
            recoverable: retryable,
            fallbackEnvelope: true,
            retryable,
            failurePhase,
            action,
            exitCode: result.exitCode ?? null,
            partialBody: failedPartialBody,
            ...(acceptanceUnknown ? { submissionPhase: "indeterminate", nativeCompletion: "unknown" } : {}),
            ...(authProviderFailure ? { providerFailure: authProviderFailure } : {}),
            ...(nativeFailure ? { nativeFailure } : {}),
          },
        });
        throw new ChatAssistantStreamError(
          adapterErrorMessage,
          failedPartialBody,
          [],
          {
            errorCode,
            partialBodyUserVisible: Boolean(failedPartialBody),
            retryable,
            failurePhase,
            action,
            ...(authProviderFailure ? { providerFailure: authProviderFailure } : {}),
          },
        );
      }

      if (isStopped()) return finalizeStoppedReply();
      await guardActiveRun(() => maybeEmitAssistantState(input.onAssistantState, "finalizing"));
      if (isStopped()) return finalizeStoppedReply();

      const raw = rawResultText || finalAssistantText;
      const generatedAttachments = extractGeneratedAttachments(result);
      const inlineVisualArtifacts = extractCodexInlineVisualArtifacts(result);
      generatedAttachments.push(...inlineVisualArtifacts.attachments);
      const availableImageContentPaths = userImageContentPathsFromMessages(input.messages);
      const forbiddenAttachmentLocalPaths = [...preparedAttachments.references.values()]
        .map((reference) => reference.localPath)
        .filter((localPath): localPath is string => Boolean(localPath));
      const proposalValidationOptions = {
        allowedProposalImageContentPaths: availableImageContentPaths,
        forbiddenAttachmentLocalPaths,
      };
      let reply: ChatAssistantResult | null = null;
      try {
        reply = parseCompletedAssistantReply(raw, resultSentinel, {
          // Native runtimes already delimit the final assistant message. The
          // Rudder sentinel remains only for structured result payloads.
          requireSentinel: false,
          ...proposalValidationOptions,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Chat adapter returned an invalid final reply";
        const errorCode: ChatRecoverableFailureCode = "chat_result_malformed_json";
        await finalizeChatRun({
          status: "failed",
          error: errorMessage,
          errorCode,
          resultJson: {
            outcome: "failed",
            recoverable: true,
            fallbackEnvelope: true,
            errorCode,
            userMessage: recoverableFailureMessage(errorCode),
            partialBody: finalPartialBody,
          },
        });
        throw new ChatAssistantStreamError(
          errorMessage,
          finalPartialBody,
          generatedAttachments,
          {
            errorCode,
            partialBodyUserVisible: Boolean(finalPartialBody),
            userMessage: recoverableFailureMessage(errorCode),
          },
        );
      }
      if (!reply) {
        throw new Error("Chat adapter returned an invalid final reply");
      }
      const runtimeNeutralInlineVisuals = normalizeReplyInlineVisuals(
        reply, inlineVisualArtifacts.inlineVisuals.length,
      );
      reply.body = runtimeNeutralInlineVisuals.body;
      generatedAttachments.push(...runtimeNeutralInlineVisuals.attachments);
      const finalBody = reply.body;
      reply.replyingAgentId = runtimeAgentId;
      if (generatedAttachments.length > 0) {
        reply.generatedAttachments = generatedAttachments;
      }
      if (inlineVisualArtifacts.inlineVisuals.length > 0) {
        reply.inlineVisuals = inlineVisualArtifacts.inlineVisuals;
      }
      if (runtimeNeutralInlineVisuals.inlineVisualsV1.length > 0) {
        reply.inlineVisualsV1 = runtimeNeutralInlineVisuals.inlineVisualsV1;
      }

      const streamedBody = safeTrim(inlineVisualStream.visibleText) ?? "";
      if (finalBody && finalBody !== streamedBody) {
        if (isStopped()) return finalizeStoppedReply();
        await guardActiveRun(() => maybeEmitAssistantDelta(
          input.onAssistantDelta,
          stripRudderInlineVisualPlacements(finalBody),
        ));
        if (isStopped()) return finalizeStoppedReply();
      }

      if (isStopped()) return finalizeStoppedReply();
      await finalizeChatRun({
        status: "succeeded",
        resultJson: {
          outcome: "completed",
          kind: reply.kind,
          body: finalBody,
          generatedAttachmentCount: generatedAttachments.length,
        },
        usageJson: result.usage ? { ...result.usage } : null,
      });

      if (isStopped()) return finalizeStoppedReply();
      return {
        outcome: "completed",
        reply,
        partialBody: finalBody,
        replyingAgentId: runtimeAgentId,
      };
    } catch (error) {
      if (isStopped()) return finalizeStoppedReply();
      if (isOwnerExecutionLost() || error === ownerLostError) {
        if (input.stream === true) return staleOutcome;
        throw ownerLostError;
      }
      await finalizeUnhandledRunFailure(error);
      if (error instanceof ChatAssistantStreamError) {
        throw error;
      }
      const partialBody = redactRudderInlineVisualSources(safeTrim(sentinelStream.visibleText) ?? "");
      const safeErrorMessage = redactChatInlineVisualDiagnosticText(
        error instanceof Error ? error.message : String(error),
        "Chat runtime failed while handling private presentation data",
      );
      const unknownForkAcceptance = error instanceof NativeForkAcceptanceUnknownError;
      throw new ChatAssistantStreamError(
        safeErrorMessage,
        partialBody,
        [],
        {
          errorCode: unknownForkAcceptance ? "native_fork_acceptance_unknown" : "chat_runtime_exception",
          partialBodyUserVisible: false,
          ...(unknownForkAcceptance ? {
            userMessage: recoverableFailureMessage("native_fork_acceptance_unknown", runId),
            retryable: false,
            ...(runId ? { action: "inspect_run" } : {}),
          } : {}),
        },
      );
    } finally {
      removeAbortListener?.();
      ownedExecution.release();
      // Local attachment removal must not hold the stream after Run finalization.
      void cleanupPreparedAttachments?.().catch(() => undefined);
    }
  }

  return {
    enrichConversation,
    enrichConversations,
    ...createChatAssistantAvailability(resolveChatInvocation),
    generateChatAssistantReply: async (
      input: GenerateChatAssistantReplyInput,
    ): Promise<ChatAssistantResult> => {
      const result = await streamChatAssistantReply(input);
      if (result.outcome !== "completed") {
        throw new Error("Chat assistant reply was stopped before completion");
      }
      return result.reply;
    },
    streamChatAssistantReply,
  };
}
