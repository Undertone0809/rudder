import {
  buildModelAttemptSpecs,
  isAgentRuntimeNetworkSuspension,
  type AgentRuntimeExecutionResult,
  type TranscriptEntry,
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
import { assertClaudeSideChatInputSafe, canRestartPristineClaudeFork, claudeForkFenceForRun, recoverClaudeDeferredForkRun } from "./chat-assistant.claude-fork-recovery.js";
import { cursorAcpTimeoutEvidence } from "./chat-assistant.cursor-diagnostics.js";
import {
  createChatAssistantExecutionOwner,
  createChatAssistantStopFinalizer,
  type ChatAssistantStaleOutcome,
} from "./chat-assistant.execution-owner.js";
import { asRecord, asString, CHAT_RESULT_SENTINEL_PREFIX, ChatAssistantResult, ChatAssistantStreamError, ChatAttachmentPromptReference, createAssistantTextAccumulator, createSentinelStream, extractCodexInlineVisualArtifacts, extractGeneratedAttachments, finalBodyFromRawAssistantText, GenerateChatAssistantReplyInput, maybeEmitAssistantDelta, maybeEmitAssistantState, parseAssistantTextBlock, parseCompletedAssistantReply, partialBodyFromRawAssistantText, prepareChatAttachmentReferences, recoverableFailureMessage, redactChatInlineVisualDiagnosticText, resultText, safeTrim, shouldSuppressChatTranscriptEntry, StreamChatAssistantReplyInput, StreamChatAssistantReplyResult, stubAgent, type ChatRecoverableFailureCode } from "./chat-assistant.helpers.js";
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
  deriveSideChatForkSourceForCurrentProfile,
  loadSideChatForkSource,
  resolveChatContinuationSession,
  sideChatForkBindingMatchesTarget,
} from "./chat-assistant.side-chat-source.js";
import { createChatAssistantStdoutBuffer } from "./chat-assistant.stdout-buffer.js";
import { createChatTranscriptDelivery } from "./chat-assistant.transcript-delivery.js";
import { admitClaudeDeferredFork, recordClaudeDeferredForkOutcome, reserveClaudeDeferredFork } from "./claude-deferred-fork-admission.js";
import { preflightManagedAgentWorkspace } from "./managed-workspace-preflight.js";
import { resolveHeartbeatTranscriptRetention } from "./runtime-kernel/heartbeat-transcript-retention.js";
import { executeAdapterWithModelFallbacks } from "./runtime-kernel/model-fallback.js";
import { executeNativeForkIntent, markNativeForkIntentUnknown } from "./runtime-kernel/native-fork-intent.js";
import { revisionForRuntimeConfig } from "./runtime-kernel/native-session.js";
import { filterNativeTransportProfile } from "./runtime-kernel/native-transport-profile.js";
import type { NativeSpanSelector } from "./runtime-kernel/provider-capabilities.js";
import { createRuntimeApprovalBridge } from "./runtime-kernel/runtime-approval.js";
import { admitSideChatRuntimeFork, type SideChatRuntimeAdmission } from "./side-chat-runtime-admission.js";

export type { ChatAssistantStaleOutcome } from "./chat-assistant.execution-owner.js";
export * from "./chat-assistant.helpers.js";
export * from "./chat-assistant.runtime-overrides.js";

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
    const existingBindingRun = input.conversation.conversationKind === "side_chat" && existingRuntimeBinding
      ? await db.select({ id: runRuntimeSpans.id }).from(runRuntimeSpans).where(and(
        eq(runRuntimeSpans.orgId, input.conversation.orgId), eq(runRuntimeSpans.bindingId, existingRuntimeBinding.id),
      )).limit(1).then((rows) => rows[0] ?? null) : null;
    const restartPristineFork = Boolean(existingBindingRun && await canRestartPristineClaudeFork({
      db, binding: existingRuntimeBinding, runtimeType: runtimeAgentType,
      orgId: input.conversation.orgId, conversationId: input.conversation.id,
    }));
    const sideChatFirstSend = input.conversation.conversationKind === "side_chat" && (!existingBindingRun || restartPristineFork);
    const principalScopeRef = input.principalScopeRef
      ?? asString(input.runContext?.principalScopeRef)
      ?? `org:${input.conversation.orgId}`;
    const hostId = asString(config.hostId ?? config.runtimeHostId) || "local";
    const profileId = asString(config.profileId ?? config.profile ?? config.authProfile) || "default";
    const workspaceBindingId = asString(workspace?.workspaceId ?? workspace?.id ?? workspace?.cwd) || null;
    const providerProfileCwd = asString(config.cwd)
      || asString(workspace?.executionWorkspaceCwd ?? workspace?.cwd ?? workspace?.worktreePath);
    const capabilityRevision = revisionForRuntimeConfig({
      runtimeType: runtimeAgentType,
      planMode: input.conversation.planMode,
      skills: runtimeSource.runtimeSkills.map((skill) => skill.key),
    });
    const providerBinding = { orgId: input.conversation.orgId, hostId, profileId, workspaceBindingId, capabilityRevision };
    const loadedForkSource = sideChatFirstSend || (input.resumeRunId && runtimeAgentType === "claude_local" && input.conversation.conversationKind === "side_chat")
      ? await loadSideChatForkSource(db, input.conversation) : null;
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
        : revisionForRuntimeConfig(config, ["apiKey", "authToken", "token", "password"]),
      capabilityRevision,
      parentBindingId: forkSource?.sourceBinding?.id ?? parentRuntimeBinding?.id ?? null,
    };
    let claudeDeferredFork = !runtimeProfilePreparationFailed
      && sideChatFirstSend && !input.resumeRunId && forkSource && runtimeAgentType === "claude_local"
      ? await admitClaudeDeferredFork({
        db, source: forkSource, sourceBindingMatchesTarget, bindingInput, providerBinding, config, conversationId: input.conversation.id,
      }) : null;
    const sideChatRuntimeAdmission: SideChatRuntimeAdmission | null = runtimeProfilePreparationFailed
      ? null
      : claudeDeferredFork?.admission ?? (sideChatFirstSend && forkSource
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
          if (outcome.status !== "accepted") {
            throw new Error(`Native Side Chat fork ${outcome.status}; reconciliation is required before retry`);
          }
          return { status: "supported", value: outcome.child };
        },
      })
      : null);
    const nativeContextHandoff = input.nativeContextHandoff
      ?? deriveSideChatContextHandoff(input, sideChatRuntimeAdmission, existingRuntimeBinding?.continuity);
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
      firstSend: sideChatFirstSend, resumeRunId: input.resumeRunId, userMessageId: input.userMessageId,
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
    const transcriptRetention = resolveHeartbeatTranscriptRetention({
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
              sideChatRuntimeAdmission: {
                continuity: sideChatRuntimeAdmission.continuity,
                sourceConversationId: sideChatRuntimeAdmission.sourceConversationId,
                sourceMessageId: sideChatRuntimeAdmission.sourceMessageId,
                sourceRunId: sideChatRuntimeAdmission.sourceRunId,
                sourceBoundaryRef: sideChatRuntimeAdmission.sourceBoundaryRef,
                sourceSpanId: sideChatRuntimeAdmission.sourceSpanId,
                sourceSelectorJson: forkSource?.selectorJson ?? null,
                span: {
                  id: sideChatRuntimeAdmission.sourceSpanId,
                  runId: sideChatRuntimeAdmission.sourceRunId,
                  selectorJson: forkSource?.selectorJson ?? null,
                },
                providerCapability: sideChatRuntimeAdmission.providerCapability,
                downgradeReason: sideChatRuntimeAdmission.downgradeReason,
                sessionIntent: sideChatRuntimeAdmission.sessionIntent,
                ...(claudeDeferredFork?.adapterIntent
                  ? { deferredForkDescriptor: claudeDeferredFork.adapterIntent }
                  : {}),
              },
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
    const claudeForkRunFence = claudeForkFenceForRun(runtimeAgentType, chatRun);
    let claudeDeferredForkReference: Awaited<ReturnType<typeof reserveClaudeDeferredFork>> | null = null;
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
      finalize: (finalState) => chatRunsSvc.finalizeRun(runId, {
        ...finalState, resultJson: transcript.terminalResult(finalState.resultJson),
        transcriptDelivery: {
          source: transcript.delivery.source,
          runId: transcript.delivery.runId,
          spanId: chatRun.runtimeSpanId ?? null,
        },
      }),
      failureState: (error) => {
        const errorCode = (error as { errorCode?: unknown } | null)?.errorCode;
        const safeError = redactChatInlineVisualDiagnosticText(
          error instanceof Error ? error.message : String(error),
          "Chat runtime failed while handling private presentation data",
        );
        return {
          status: "failed",
          error: safeError,
          errorCode: typeof errorCode === "string"
            ? redactChatInlineVisualDiagnosticText(errorCode, "chat_runtime_exception")
            : "chat_runtime_exception",
          resultJson: {
            outcome: "failed",
            recoverable: true,
            fallbackEnvelope: true,
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
    let hasNativeFinalMessage = false;
    let hasRuntimeOutputEvidence = false;
    const sentinelStream = createSentinelStream(resultSentinel);
    const inlineVisualStream = createRudderInlineVisualStreamSuppressor();
    const commentaryInlineVisualStream = createRudderInlineVisualStreamSuppressor();
    const transcriptInlineVisualStream = createRudderInlineVisualStreamSuppressor();
    let transcriptDeltaOpen = false;
    let transcriptDeltaCarry = "";
    const { freezeStopCutoff, finalizeStoppedReply } = createChatAssistantStopFinalizer({
      finalAssistantText: () => finalAssistantTextAccumulator.fullText,
      hasNativeFinalMessage: () => hasNativeFinalMessage,
      resultSentinel,
      visibleText: () => sentinelStream.visibleText,
      isFinalized: isRunFinalized,
      finalize: finalizeChatRun,
      finalState: (partialBody): Parameters<typeof chatRunsSvc.finalizeRun>[1] => ({
        status: "cancelled",
        error: "Chat run stopped before completion",
        errorCode: "chat_stopped",
        resultJson: { outcome: "stopped", partialBody },
      }),
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
      if (input.resumeRunId && runtimeAgentType === "claude_local" && input.conversation.conversationKind === "side_chat") {
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

      const processTranscriptEntries = async (entries: TranscriptEntry[]) => {
        for (const entry of entries) {
          if (isExecutionInactive()) return;
          if (entry.kind !== "init") hasRuntimeOutputEvidence = true;
          if (entry.kind === "tool_call") {
            await maybeEmitAssistantState(input.onAssistantState, "tool_busy");
            if (isExecutionInactive()) return;
          }
          if (entry.kind === "assistant") {
            if (entry.phase === "commentary") {
              // Streaming deltas may begin or end with meaningful whitespace.
              // Keep one suppressor for the whole commentary stream so private
              // inline visuals stay filtered without trimming token boundaries.
              const commentaryText = entry.delta === true
                ? commentaryInlineVisualStream.push(entry.text)
                : redactRudderInlineVisualSources(entry.text);
              if (!commentaryText) continue;
              const commentaryEntry: TranscriptEntry = {
                kind: "assistant",
                ts: entry.ts,
                text: commentaryText,
                ...(entry.delta === true ? { delta: true } : {}),
                phase: "commentary",
                ...(entry.segmentId ? { segmentId: entry.segmentId } : {}),
              };
              await input.onObservedTranscriptEntry?.(commentaryEntry, transcriptDelivery);
              if (isExecutionInactive()) return;
              await input.onTranscriptEntry?.(commentaryEntry, transcriptDelivery);
              if (isExecutionInactive()) return;
              await chatRunsSvc.appendTranscriptEntry(chatRun, commentaryEntry, transcriptDelivery);
              continue;
            }
            if (entry.phase === "final_answer") {
              hasNativeFinalMessage = true;
            }
            const delta = assistantTextAccumulator.push(entry.text, entry.delta === true);
            if (entry.phase === "final_answer") {
              finalAssistantTextAccumulator.push(entry.text, entry.delta === true);
            }
            if (!delta) continue;
            const visibleDelta = inlineVisualStream.push(sentinelStream.push(delta));
            const textBlock = parseAssistantTextBlock(assistantTextAccumulator.fullText);
            if (visibleDelta && !textBlock) {
              const assistantTranscriptEntry: TranscriptEntry = {
                kind: "assistant",
                ts: entry.ts,
                text: visibleDelta,
                delta: true,
              };
              await input.onObservedTranscriptEntry?.(assistantTranscriptEntry, transcriptDelivery);
              if (isExecutionInactive()) return;
              await input.onTranscriptEntry?.(assistantTranscriptEntry, transcriptDelivery);
              if (isExecutionInactive()) return;
              await chatRunsSvc.appendTranscriptEntry(chatRun, assistantTranscriptEntry, transcriptDelivery);
            }
            continue;
          }
          const suppressTranscriptSource = (text: string, delta = false) => {
            const hideResidualWidgetSource = (output: string) => (
              /<div\b[^>]*\bid\s*=\s*["']widget["']/i.test(output)
                ? `[private inline visual source omitted]${output.endsWith("\n") ? "\n" : ""}`
                : output
            );
            if (delta) {
              // Thinking deltas are arbitrary stream fragments. Preserve continuity
              // and admit only complete logical lines so raw widget markup cannot be
              // projected before an opening marker or tag finishes across chunks.
              transcriptDeltaOpen = true;
              transcriptDeltaCarry += text;
              if (Buffer.byteLength(transcriptDeltaCarry, "utf8") > 256 * 1024) {
                transcriptDeltaCarry = "";
                transcriptDeltaOpen = false;
                return "[oversized transcript delta omitted]";
              }
              let output = "";
              let newline = transcriptDeltaCarry.indexOf("\n");
              while (newline >= 0) {
                output += hideResidualWidgetSource(
                  transcriptInlineVisualStream.push(transcriptDeltaCarry.slice(0, newline + 1)),
                );
                transcriptDeltaCarry = transcriptDeltaCarry.slice(newline + 1);
                newline = transcriptDeltaCarry.indexOf("\n");
              }
              return output;
            }
            // Complete transcript entries are logical records. The synthetic newline
            // lets own-line markers advance the shared state machine when a runtime
            // reports START/body/END as separate non-delta entries.
            let output = "";
            if (transcriptDeltaOpen) {
              if (transcriptDeltaCarry) {
                output += hideResidualWidgetSource(
                  transcriptInlineVisualStream.push(`${transcriptDeltaCarry}\n`),
                );
                transcriptDeltaCarry = "";
              }
              transcriptDeltaOpen = false;
            }
            const admittedRecord = transcriptInlineVisualStream.push(`${text}\n`);
            const recordOutput = admittedRecord.endsWith("\n")
              ? admittedRecord.slice(0, -1)
              : admittedRecord;
            return output + hideResidualWidgetSource(recordOutput);
          };
          let structuredTranscriptNodes = 0;
          let structuredTranscriptBytes = 0;
          const suppressStructuredTranscriptValue = (value: unknown, depth = 0): unknown => {
            structuredTranscriptNodes += 1;
            if (structuredTranscriptNodes > 1_000) return "[bounded transcript value omitted]";
            if (typeof value === "string") {
              structuredTranscriptBytes += Buffer.byteLength(value, "utf8");
              if (structuredTranscriptBytes > 256 * 1024) return "[bounded transcript value omitted]";
              return suppressTranscriptSource(value);
            }
            if (depth >= 8) return "[bounded transcript value omitted]";
            if (Array.isArray(value)) {
              return value.slice(0, 100).map((item) => suppressStructuredTranscriptValue(item, depth + 1));
            }
            if (value && typeof value === "object") {
              const output: Record<string, unknown> = {};
              for (const [index, [key, item]] of Object.entries(value as Record<string, unknown>)
                .slice(0, 100)
                .entries()) {
                structuredTranscriptBytes += Buffer.byteLength(key, "utf8");
                const sanitizedKey = structuredTranscriptBytes > 256 * 1024
                  ? `[bounded-key-${index}]`
                  : suppressTranscriptSource(key) || `[redacted-key-${index}]`;
                let uniqueKey = sanitizedKey;
                let suffix = 1;
                while (Object.hasOwn(output, uniqueKey)) {
                  uniqueKey = `${sanitizedKey}-${suffix}`;
                  suffix += 1;
                }
                output[uniqueKey] = suppressStructuredTranscriptValue(item, depth + 1);
              }
              return output;
            }
            return value;
          };
          const safeEntry: TranscriptEntry = (() => {
            switch (entry.kind) {
              case "thinking":
                return {
                  kind: entry.kind,
                  ts: entry.ts,
                  text: suppressTranscriptSource(entry.text, entry.delta === true),
                  ...(entry.delta === true ? { delta: true } : {}),
                  ...(entry.segmentId ? { segmentId: suppressTranscriptSource(entry.segmentId) } : {}),
                };
              case "user":
              case "stderr":
              case "system":
              case "stdout":
                return {
                  kind: entry.kind,
                  ts: entry.ts,
                  text: suppressTranscriptSource(entry.text),
                };
              case "result":
                return {
                  kind: entry.kind,
                  ts: entry.ts,
                  text: suppressTranscriptSource(entry.text),
                  inputTokens: entry.inputTokens,
                  outputTokens: entry.outputTokens,
                  cachedTokens: entry.cachedTokens,
                  costUsd: entry.costUsd,
                  subtype: suppressTranscriptSource(entry.subtype),
                  isError: entry.isError,
                  errors: entry.errors.slice(0, 100).map((message) => suppressTranscriptSource(message)),
                };
              case "tool_result":
                return {
                  kind: entry.kind,
                  ts: entry.ts,
                  content: suppressTranscriptSource(entry.content),
                  ...(entry.toolName ? { toolName: suppressTranscriptSource(entry.toolName) } : {}),
                  toolUseId: suppressTranscriptSource(entry.toolUseId),
                  isError: entry.isError,
                };
              case "tool_call":
                {
                  const rawInput = entry.input && typeof entry.input === "object" && !Array.isArray(entry.input)
                    ? entry.input as Record<string, unknown>
                    : null;
                  const normalizedToolName = entry.name.trim().toLowerCase().replace(/[\s_-]+/g, "");
                  const durableImage = normalizedToolName === "imageview" && typeof rawInput?.path === "string"
                    ? durableTranscriptImages.get(rawInput.path)
                    : null;
                  const durableInput = durableImage && rawInput
                    ? {
                      ...rawInput,
                      path: durableImage.contentPath,
                      displayName: durableImage.displayName,
                    }
                    : entry.input;
                  return {
                    kind: entry.kind,
                    ts: entry.ts,
                    name: suppressTranscriptSource(entry.name),
                    input: suppressStructuredTranscriptValue(durableInput),
                    ...(entry.toolUseId ? { toolUseId: suppressTranscriptSource(entry.toolUseId) } : {}),
                  };
                }
              case "todo_list":
                return {
                  kind: entry.kind,
                  ts: entry.ts,
                  ...(entry.todoListId ? { todoListId: suppressTranscriptSource(entry.todoListId) } : {}),
                  items: entry.items.slice(0, 100).map((item) => ({
                    text: suppressTranscriptSource(item.text),
                    status: item.status,
                  })),
                };
              case "init":
                return {
                  kind: entry.kind,
                  ts: entry.ts,
                  model: suppressTranscriptSource(entry.model),
                  sessionId: suppressTranscriptSource(entry.sessionId),
                };
              default:
                return {
                  kind: "system",
                  ts: new Date().toISOString(),
                  text: "Unsupported runtime transcript entry omitted",
                };
            }
          })();
          if (entry.kind === "result") {
            const safeResultEntry = safeEntry.kind === "result" ? safeEntry : null;
            const observedText = partialBodyFromRawAssistantText(safeResultEntry?.text ?? "", resultSentinel);
            if (observedText) {
              await input.onObservedTranscriptEntry?.({
                ...safeResultEntry!,
                text: observedText,
              }, transcriptDelivery);
            }
          } else if (
            !(entry.kind === "stdout" && entry.text.includes(resultSentinel))
            && !(
              ("text" in safeEntry && typeof safeEntry.text === "string" && safeEntry.text.length === 0)
              || (safeEntry.kind === "tool_result" && safeEntry.content.length === 0)
            )
          ) {
            await input.onObservedTranscriptEntry?.(safeEntry, transcriptDelivery);
          }
          if (isExecutionInactive()) return;
          const suppressVisibleEntry = shouldSuppressChatTranscriptEntry(entry, resultSentinel)
            || (
            ("text" in safeEntry && typeof safeEntry.text === "string" && safeEntry.text.length === 0)
            || (safeEntry.kind === "tool_result" && safeEntry.content.length === 0)
            );
          if (!suppressVisibleEntry) {
            await input.onTranscriptEntry?.(safeEntry, transcriptDelivery);
            if (isExecutionInactive()) return;
            await chatRunsSvc.appendTranscriptEntry(chatRun, safeEntry, transcriptDelivery);
          }
          if (entry.kind === "tool_result") {
            await maybeEmitAssistantState(input.onAssistantState, "streaming");
            if (isExecutionInactive()) return;
          }
        }
      };

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
        nativeDriverRequired,
        signal: executionSignal,
        isExecutionInactive,
        ownerLostError,
        getAttempt: () => chatRun.runtimeAttemptRef ?? null,
        getSpanFence: () => ({
          spanId: chatRun.runtimeSpanId ?? null,
          ownerToken: chatRun.runtimeSpanOwnerToken,
          attemptEpoch: chatRun.runtimeSpanAttemptEpoch,
        }),
        markAcceptanceUnknown: (value) => chatRunsSvc.markAcceptanceUnknown(chatRun, value),
        recordNativeExecutionResult: (attemptResult, fence) => guardActiveRun(
          () => chatRunsSvc.recordNativeExecutionResult(runId, attemptResult, fence),
        ),
        onAttemptResult: attemptPorts.onAttemptResult,
      });

      const executeChatAdapter = async (chatPrompt: string) => {
        if (runtimeAgentType === "pi_local" && resumeSession.sessionId
          && !piSessionRpcArgsMatchHostProfile(resumeSession.sessionParams, continuationTransport.rpcArgs)) {
          throw new Error("Pi continuation requires RPC args matching the host-owned transport profile.");
        }
        return executeAdapterWithModelFallbacks(adapter, {
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
          authToken: adapter.supportsLocalAgentJwt
            ? createLocalAgentJwt(
              runtimeAgentId,
              input.conversation.orgId,
              runtimeAgentType,
              runId,
            ) ?? undefined
            : undefined,
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
        }, {
          resolveAdapter: findServerAdapter,
          resolveDriver: attemptPorts.resolveDriver,
          submitInputThroughDriver: true,
          nativeDriverRequired,
          createAuthToken: (agentRuntimeType) =>
            createLocalAgentJwt(
              runtimeAgentId,
              input.conversation.orgId,
              agentRuntimeType,
              runId,
            ) ?? undefined,
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
          },
          ...nativeAttemptCallbacks,
          onAttemptFailure: attemptPorts.onAttemptFailure,
        });
      };

      let result: Awaited<ReturnType<typeof executeChatAdapter>>;
      try {
        result = await guardActiveRun(() => executeChatAdapter(prompt));
      } catch (error) {
        if (claudeDeferredForkReference && claudeForkRunFence) {
          await markNativeForkIntentUnknown(db, {
            reference: claudeDeferredForkReference,
            runFence: claudeForkRunFence,
            reason: `Claude first-input fork outcome could not be observed: ${error instanceof Error ? error.message : String(error)}`,
          }).catch(() => undefined);
        }
        throw error;
      }
      const networkSuspension = isAgentRuntimeNetworkSuspension(result.networkSuspension)
        ? result.networkSuspension
        : isAgentRuntimeNetworkSuspension(result.suspension)
          ? result.suspension
          : null;
      const { providerThreadId, providerTurnId } = chatProviderResultIds(result);
      if (claudeDeferredForkReference && claudeDeferredFork?.adapterIntent && claudeForkRunFence) {
        const reference = claudeDeferredForkReference;
        const intent = claudeDeferredFork.adapterIntent;
        result = await guardActiveRun(() => recordClaudeDeferredForkOutcome({
          db,
          reference,
          runFence: claudeForkRunFence,
          intent,
          result,
          providerTurnId,
        }));
      }
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
          submissionPhase: result.submissionPhase ?? "accepted",
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
            hasNativeFinalMessage ? finalAssistantTextAccumulator.fullText : "",
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
      const finalAssistantText = hasNativeFinalMessage ? finalAssistantTextAccumulator.fullText : "";
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
          || hasRuntimeOutputEvidence,
        );
        const rawProviderFailure = asRecord(result.resultJson?.providerFailure);
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
        const errorCode: ChatRecoverableFailureCode = authProviderFailure
          ? "codex_provider_auth_required"
          : forkAcceptanceUnknown
            ? "claude_fork_acceptance_unknown"
          : hasModelOutputEvidence
            ? "chat_adapter_failed"
            : "chat_runtime_boot_failed";
        const retryable = !authProviderFailure && !forkAcceptanceUnknown && errorCode !== "chat_runtime_boot_failed";
        const failurePhase = forkAcceptanceUnknown || errorCode === "chat_adapter_failed" ? "model_generation" : "runtime_boot";
        const action = forkAcceptanceUnknown ? "inspect_run" : errorCode === "chat_adapter_failed" ? "retry" : "repair_runtime";
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
            partialBody: finalPartialBody,
            ...(forkAcceptanceUnknown ? { submissionPhase: "indeterminate", nativeCompletion: "unknown" } : {}),
            ...(authProviderFailure ? { providerFailure: authProviderFailure } : {}),
          },
        });
        throw new ChatAssistantStreamError(
          adapterErrorMessage,
          finalPartialBody,
          [],
          {
            errorCode,
            partialBodyUserVisible: Boolean(finalPartialBody),
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
      throw new ChatAssistantStreamError(
        safeErrorMessage,
        partialBody,
        [],
        {
          errorCode: "chat_runtime_exception",
          partialBodyUserVisible: false,
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
