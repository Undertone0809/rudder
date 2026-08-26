import { isAgentRuntimeNetworkSuspension, type TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import type {
  AgentRuntimeType,
  ChatContextLink,
  ChatConversation
} from "@rudderhq/shared";
import {
  createRudderInlineVisualStreamSuppressor,
  redactRudderInlineVisualSources,
  shortRefFor,
  stripRudderInlineVisualPlacements,
} from "@rudderhq/shared";
import { randomUUID } from "node:crypto";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { discoverAgentRuntimeModels, findServerAdapter } from "../agent-runtimes/index.js";
import type { StorageService } from "../storage/types.js";
import { agentRunContextService } from "./agent-run-context.js";
import { agentService } from "./agents.js";
import { chatAgentRunService } from "./chat-agent-runs.js";
import { asString, buildConversationPrompt, buildMissingResultSentinelRepairPrompt, CHAT_RESULT_SENTINEL_PREFIX, CHAT_UNSUPPORTED_ADAPTER_TYPES, ChatAssistantResult, ChatAssistantStreamError, ChatAttachmentPromptReference, chatExecutionConfig, createAssistantTextAccumulator, createSentinelStream, extractCodexInlineVisualArtifacts, extractGeneratedAttachments, extractRudderInlineVisualArtifacts, finalBodyFromRawAssistantText, GenerateChatAssistantReplyInput, linkedGoalIdForChat, linkedIssueIdsForChat, linkedProjectIdForChat, maybeEmitAssistantDelta, maybeEmitAssistantState, maybeEmitObservedTranscriptEntry, maybeEmitTranscriptEntry, modelLabel, parseAssistantTextBlock, parseCompletedAssistantReply, partialBodyFromRawAssistantText, prepareChatAttachmentReferences, recoverableFailureMessage, redactChatInlineVisualDiagnosticText, ResolvedChatRuntimeSource, resultText, safeTrim, shouldSuppressChatTranscriptEntry, StreamChatAssistantReplyInput, StreamChatAssistantReplyResult, stubAgent, summarizeRuntimeSkills, unavailableAgentDescriptor, unconfiguredDescriptor, type ChatRecoverableFailureCode } from "./chat-assistant.helpers.js";
import { userImageContentPathsFromMessages } from "./chat-assistant.proposal-validation.js";
import { enrichConversationRuntimeDescriptors } from "./chat-assistant.runtime-batch.js";
import {
  applyChatRuntimeOverrides,
  chatEffortFromConfig,
} from "./chat-assistant.runtime-overrides.js";
import { preflightManagedAgentWorkspace } from "./managed-workspace-preflight.js";
import {
  executeAdapterWithModelFallbacks,
  projectPrimaryRuntimeConfig,
} from "./runtime-kernel/model-fallback.js";
export * from "./chat-assistant.helpers.js";
export * from "./chat-assistant.runtime-overrides.js";

function chatRuntimePreparationStreamError(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const safeContextSource = rawMessage.replace(/[?#][^\s]*/g, "");
  const skillMatch = safeContextSource.match(
    /\borganization skill\s+["'`]?([a-z0-9][a-z0-9._-]{0,127})/i,
  );
  const skill = skillMatch?.[1]?.replace(/[.,:;]+$/, "") || null;
  const file = /(?:^|[/\\])SKILL\.md(?=$|[\s"'`:),])/i.test(safeContextSource)
    ? "SKILL.md"
    : null;
  const context = skill
    ? `organization skill "${skill}"${file ? ` file "${file}"` : ""}`
    : file
      ? `runtime file "${file}"`
      : "the configured runtime skills and files";
  const userMessage = skill
    ? `Could not prepare organization skill "${skill}"${file ? ` file "${file}"` : ""}. Check that its installed files are available, then retry.`
    : file
      ? `Could not prepare runtime file "${file}". Check that the file is available, then retry.`
      : "Could not prepare the configured runtime skills or files. Check the agent runtime and skill configuration, then retry.";
  return new ChatAssistantStreamError(
    `Chat runtime preparation failed for ${context}`,
    "",
    [],
    {
      errorCode: "chat_runtime_preparation_failed",
      userMessage,
      retryable: true,
      failurePhase: "runtime_boot",
      action: "retry",
    },
  );
}

function chatRuntimeAvailabilityStreamError(errorMessage?: string | null) {
  const candidate = errorMessage?.trim() ?? "";
  const safeKnownMessage = (
    candidate === "Choose a chat agent before sending messages."
    || candidate === "The selected chat agent is unavailable. Choose another agent before sending messages."
    || candidate === "The selected agent runtime is not registered with Rudder Chat."
    || candidate === "The current user has not configured a chat model yet."
    || /^Unknown chat adapter type: [a-z0-9_-]+$/i.test(candidate)
  )
    ? candidate
    : "The assistant runtime is not configured or available. Check the selected agent runtime, then retry.";
  return new ChatAssistantStreamError(
    safeKnownMessage,
    "",
    [],
    {
      errorCode: "chat_runtime_boot_failed",
      userMessage: safeKnownMessage,
      retryable: false,
      failurePhase: "runtime_boot",
      action: "repair_runtime",
    },
  );
}

function combineChatUsage(
  primary: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null | undefined,
  repair: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null | undefined,
) {
  if (!primary && !repair) return null;
  if (!repair) return primary ? { ...primary } : null;
  if (!primary) return { ...repair };
  return {
    inputTokens: primary.inputTokens + repair.inputTokens,
    outputTokens: primary.outputTokens + repair.outputTokens,
    cachedInputTokens: (primary.cachedInputTokens ?? 0) + (repair.cachedInputTokens ?? 0),
    primary: { ...primary },
    repair: { ...repair },
  };
}

export function chatAssistantService(db: Db, storage?: StorageService) {
  const agentsSvc = agentService(db);
  const runContextSvc = agentRunContextService(db);
  const chatRunsSvc = chatAgentRunService(db);

  async function resolveChatInvocation(input: {
    conversation: Pick<ChatConversation, "id" | "orgId" | "preferredAgentId" | "modelOverride" | "effortOverride" | "primaryIssueId" | "contextLinks" | "planMode">;
    contextLinks: ChatContextLink[];
    materializeManagedInstructions?: boolean;
    materializeMissingRuntimeSkills?: boolean;
    agentIdSnapshot?: string | null;
    modelSnapshot?: string | null;
    effortSnapshot?: string | null;
  }) {
    const runtimeSource = await resolveConversationRuntime(
      input.conversation,
      {
        materializeManagedInstructions: input.materializeManagedInstructions,
        materializeMissingRuntimeSkills: input.materializeMissingRuntimeSkills,
        ...(input.agentIdSnapshot !== undefined ? { agentIdSnapshot: input.agentIdSnapshot } : {}),
        ...(input.modelSnapshot !== undefined ? { modelSnapshot: input.modelSnapshot } : {}),
        ...(input.effortSnapshot !== undefined ? { effortSnapshot: input.effortSnapshot } : {}),
      },
    );
    if (!runtimeSource.descriptor.available) {
      return {
        runtimeSource,
        adapter: null,
        config: null,
        linkedIssueIds: [] as string[],
        linkedProjectId: null as string | null,
        linkedGoalId: null as string | null,
        resolvedWorkspace: null,
        sceneContext: null,
        availabilityError: runtimeSource.descriptor.error ?? "Chat assistant is not configured",
      };
    }
    if (!runtimeSource.agentRuntimeType || !runtimeSource.agentRuntimeConfig || !runtimeSource.runtimeAgent) {
      return {
        runtimeSource,
        adapter: null,
        config: null,
        linkedIssueIds: [] as string[],
        linkedProjectId: null as string | null,
        linkedGoalId: null as string | null,
        resolvedWorkspace: null,
        sceneContext: null,
        availabilityError: runtimeSource.descriptor.error ?? "Chat runtime is not configured",
      };
    }

    const adapter = findServerAdapter(runtimeSource.agentRuntimeType);
    if (!adapter) {
      return {
        runtimeSource,
        adapter: null,
        config: null,
        linkedIssueIds: [] as string[],
        linkedProjectId: null as string | null,
        linkedGoalId: null as string | null,
        resolvedWorkspace: null,
        sceneContext: null,
        availabilityError: `Unknown chat adapter type: ${runtimeSource.agentRuntimeType}`,
      };
    }

    const config = chatExecutionConfig(
      input.conversation,
      runtimeSource.agentRuntimeType,
      runtimeSource.agentRuntimeConfig,
    );
    const linkedIssueIds = linkedIssueIdsForChat(input.conversation, input.contextLinks);
    const linkedProjectId = linkedProjectIdForChat(input.contextLinks);
    const linkedGoalId = linkedGoalIdForChat(input.contextLinks);
    const resolvedWorkspace = await runContextSvc.resolveWorkspaceForRun(
      runtimeSource.runtimeAgent,
      {
        issueId: input.conversation.primaryIssueId ?? linkedIssueIds[0] ?? null,
        projectId: linkedProjectId,
      },
      null,
    );

    const sceneContext = await runContextSvc.buildSceneContext({
      scene: "chat",
      agent: runtimeSource.runtimeAgent,
      resolvedWorkspace,
      runtimeConfig: config,
      issueId: input.conversation.primaryIssueId ?? linkedIssueIds[0] ?? null,
      chatConversationId: input.conversation.id,
    });

    return {
      runtimeSource,
      adapter,
      config,
      linkedIssueIds,
      linkedProjectId,
      linkedGoalId,
      resolvedWorkspace,
      sceneContext,
      availabilityError: null,
    };
  }

  async function resolveAgentRuntime(
    orgId: string,
    agentId: string,
    options?: {
      materializeManagedInstructions?: boolean;
      materializeMissingRuntimeSkills?: boolean;
    },
  ): Promise<ResolvedChatRuntimeSource | null> {
    const agent = await agentsSvc.getInternalById(agentId);
    if (!agent || agent.orgId !== orgId || agent.status === "terminated") {
      return {
        descriptor: unavailableAgentDescriptor({
          sourceLabel: "Selected agent",
          runtimeAgentId: null,
          agentRuntimeType: null,
          model: null,
          error: "The selected chat agent is unavailable. Choose another agent before sending messages.",
        }),
        runtimeAgent: null,
        agentRuntimeType: null,
        agentRuntimeConfig: null,
        runtimeSkills: [],
      };
    }

    const agentAdapterType = agent.agentRuntimeType as AgentRuntimeType;
    const agentAdapterConfig = (agent.agentRuntimeConfig ?? {}) as Record<string, unknown>;
    const registeredAdapter = findServerAdapter(agentAdapterType);

    if (!registeredAdapter) {
      return {
        descriptor: unavailableAgentDescriptor({
          sourceLabel: agent.name,
          runtimeAgentId: agent.id,
          agentRuntimeType: agentAdapterType,
          model: modelLabel(agentAdapterConfig) ?? null,
          error: "The selected agent runtime is not registered with Rudder Chat.",
        }),
        runtimeAgent: {
          id: agent.id,
          orgId: agent.orgId,
          name: agent.name,
          agentRuntimeType: agentAdapterType,
          agentRuntimeConfig: agentAdapterConfig,
        },
        agentRuntimeType: agentAdapterType,
        agentRuntimeConfig: null,
        runtimeSkills: [],
      };
    }

    if (CHAT_UNSUPPORTED_ADAPTER_TYPES.has(agentAdapterType)) {
      return {
        descriptor: unavailableAgentDescriptor({
          sourceLabel: agent.name,
          runtimeAgentId: agent.id,
          agentRuntimeType: agentAdapterType,
          model: modelLabel(agentAdapterConfig) ?? null,
          error: "The current user has not configured a chat model yet.",
        }),
        runtimeAgent: {
          id: agent.id,
          orgId: agent.orgId,
          name: agent.name,
          agentRuntimeType: agentAdapterType,
          agentRuntimeConfig: agentAdapterConfig,
        },
        agentRuntimeType: agentAdapterType,
        agentRuntimeConfig: null,
        runtimeSkills: [],
      };
    }

    const preparedAgentRuntimeConfig = options?.materializeManagedInstructions
      ? await runContextSvc.materializeManagedInstructionsForRun({
        id: agent.id,
        orgId: agent.orgId,
        name: agent.name,
        role: agent.role,
        workspaceKey: agent.workspaceKey,
        status: agent.status,
        agentRuntimeType: agentAdapterType,
        agentRuntimeConfig: agentAdapterConfig,
        metadata: agent.metadata ?? null,
      })
      : agentAdapterConfig;
    const { runtimeConfig, runtimeSkillEntries } = await runContextSvc.prepareRuntimeConfig({
      scene: "chat",
      materializeMissingRuntimeSkills: options?.materializeMissingRuntimeSkills !== false,
      agent: {
        id: agent.id,
        orgId: agent.orgId,
        name: agent.name,
        role: agent.role,
        workspaceKey: agent.workspaceKey,
        status: agent.status,
        agentRuntimeType: agentAdapterType,
        agentRuntimeConfig: preparedAgentRuntimeConfig,
        metadata: agent.metadata ?? null,
      },
    });
    return {
      descriptor: {
        sourceType: "agent",
        sourceLabel: agent.name,
        runtimeAgentId: agent.id,
        agentRuntimeType: agentAdapterType,
        model: modelLabel(runtimeConfig) ?? "Default model",
        effort: chatEffortFromConfig(agentAdapterType, runtimeConfig),
        available: true,
        error: null,
      },
      runtimeAgent: {
        id: agent.id,
        orgId: agent.orgId,
        name: agent.name,
        agentRuntimeType: agentAdapterType,
        agentRuntimeConfig: runtimeConfig,
      },
      agentRuntimeType: agentAdapterType,
      agentRuntimeConfig: runtimeConfig,
      runtimeSkills: summarizeRuntimeSkills(runtimeSkillEntries),
    };
  }

  async function resolveConversationRuntime(
    conversation: Pick<ChatConversation, "orgId" | "preferredAgentId" | "modelOverride" | "effortOverride">,
    options?: {
      materializeManagedInstructions?: boolean;
      materializeMissingRuntimeSkills?: boolean;
      agentIdSnapshot?: string | null;
      modelSnapshot?: string | null;
      effortSnapshot?: string | null;
    },
  ) {
    const preferredAgentId = options && Object.prototype.hasOwnProperty.call(options, "agentIdSnapshot")
      ? safeTrim(options.agentIdSnapshot)
      : conversation.preferredAgentId;
    if (preferredAgentId) {
      const agentRuntime = await resolveAgentRuntime(
        conversation.orgId,
        preferredAgentId,
        options,
      );
      if (
        agentRuntime?.agentRuntimeType
        && agentRuntime.agentRuntimeConfig
        && agentRuntime.runtimeAgent
      ) {
        const model = options && Object.prototype.hasOwnProperty.call(options, "modelSnapshot")
          ? safeTrim(options.modelSnapshot)
          : safeTrim(conversation.modelOverride);
        const effort = options && Object.prototype.hasOwnProperty.call(options, "effortSnapshot")
          ? safeTrim(options.effortSnapshot)
          : conversation.effortOverride == null
            ? undefined
            : safeTrim(conversation.effortOverride);
        if (!model && effort === undefined) return agentRuntime;
        const shouldValidateRuntimeEffort = effort !== undefined
          || chatEffortFromConfig(agentRuntime.agentRuntimeType, agentRuntime.agentRuntimeConfig) !== null;
        let runtimeModelCatalog: Awaited<ReturnType<typeof discoverAgentRuntimeModels>>;
        if (
          shouldValidateRuntimeEffort
          && ["codex_local", "opencode_local", "pi_local", "cursor"].includes(agentRuntime.agentRuntimeType)
        ) {
          try {
            runtimeModelCatalog = await discoverAgentRuntimeModels(agentRuntime.agentRuntimeType);
          } catch {
            // Model discovery is advisory. Preserve the configured runtime when
            // a local CLI probe is unavailable; the adapter will still validate
            // against its built-in contract where one exists.
            runtimeModelCatalog = undefined;
          }
        }
        const derivedConfig = applyChatRuntimeOverrides(
          agentRuntime.agentRuntimeType,
          agentRuntime.agentRuntimeConfig,
          model,
          effort,
          runtimeModelCatalog,
        );
        return {
          ...agentRuntime,
          descriptor: {
            ...agentRuntime.descriptor,
            model: model ?? agentRuntime.descriptor.model,
            effort: chatEffortFromConfig(agentRuntime.agentRuntimeType, derivedConfig),
          },
          runtimeAgent: {
            ...agentRuntime.runtimeAgent,
            agentRuntimeConfig: derivedConfig,
          },
          agentRuntimeConfig: derivedConfig,
        };
      }
      if (agentRuntime) return agentRuntime;
    }

    return {
      descriptor: unconfiguredDescriptor("Choose a chat agent before sending messages."),
      runtimeAgent: null,
      agentRuntimeType: null,
      agentRuntimeConfig: null,
      runtimeSkills: [],
    } satisfies ResolvedChatRuntimeSource;
  }

  async function enrichConversation<T extends ChatConversation>(conversation: T): Promise<T> {
    const resolved = await resolveConversationRuntime(conversation, {
      materializeMissingRuntimeSkills: false,
    });
    let shortRef = conversation.shortRef;
    if (!shortRef) {
      try {
        shortRef = shortRefFor("chat", conversation.id);
      } catch {
        shortRef = undefined;
      }
    }
    return {
      ...conversation,
      ...(shortRef ? { shortRef } : {}),
      chatRuntime: resolved.descriptor,
    };
  }

  async function enrichConversations<T extends ChatConversation>(conversations: T[]): Promise<T[]> {
    return enrichConversationRuntimeDescriptors(
      conversations,
      async (conversation) => (await resolveConversationRuntime(conversation, {
        materializeMissingRuntimeSkills: false,
      })).descriptor,
    );
  }

  async function streamChatAssistantReply(
    input: StreamChatAssistantReplyInput,
  ): Promise<StreamChatAssistantReplyResult> {
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
      config,
      linkedIssueIds,
      linkedProjectId,
      linkedGoalId,
      sceneContext,
    } = resolvedInvocation;
    if (
      !adapter ||
      !config ||
      !sceneContext ||
      !runtimeSource.agentRuntimeType ||
      !runtimeSource.descriptor.runtimeAgentId
    ) {
      throw chatRuntimeAvailabilityStreamError();
    }
    const runtimeAgentType = runtimeSource.agentRuntimeType;
    const runtimeAgentId = runtimeSource.descriptor.runtimeAgentId;
    const resultSentinel = `${CHAT_RESULT_SENTINEL_PREFIX}${randomUUID()}__`;
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
          },
        });
    if (!chatRun) {
      throw new Error("The waiting Chat run could not be reattached");
    }
    const runId = chatRun.id;
    await input.onRunCreated?.(runId);
    let runFinalized = false;
    const finalizeChatRun = async (
      finalState: Parameters<typeof chatRunsSvc.finalizeRun>[1],
    ) => {
      const finalized = await chatRunsSvc.finalizeRun(runId, finalState);
      runFinalized = true;
      return finalized;
    };
    const finalizeUnhandledRunFailure = async (error: unknown) => {
      if (runFinalized) return;
      const errorCode = (error as { errorCode?: unknown } | null)?.errorCode;
      const safeError = redactChatInlineVisualDiagnosticText(
        error instanceof Error ? error.message : String(error),
        "Chat runtime failed while handling private presentation data",
      );
      await finalizeChatRun({
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
      });
    };
    const assistantTextAccumulator = createAssistantTextAccumulator();
    const sentinelStream = createSentinelStream(resultSentinel);
    const inlineVisualStream = createRudderInlineVisualStreamSuppressor();
    const commentaryInlineVisualStream = createRudderInlineVisualStreamSuppressor();
    const transcriptInlineVisualStream = createRudderInlineVisualStreamSuppressor();
    let transcriptDeltaOpen = false;
    let transcriptDeltaCarry = "";
    let stopCutoffPartialBody: string | null = null;
    const freezeStopCutoff = () => {
      if (stopCutoffPartialBody !== null) return;
      stopCutoffPartialBody = redactRudderInlineVisualSources(
        partialBodyFromRawAssistantText(assistantTextAccumulator.fullText, resultSentinel)
        || (safeTrim(sentinelStream.visibleText) ?? ""),
      );
    };
    const isStopped = () => input.abortSignal?.aborted === true;
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
    type StoppedReply = Extract<StreamChatAssistantReplyResult, { outcome: "stopped" }>;
    let stoppedReplyPromise: Promise<StoppedReply> | null = null;
    const finalizeStoppedReply = (): Promise<StoppedReply> => {
      if (stoppedReplyPromise) return stoppedReplyPromise;
      freezeStopCutoff();
      const partialBody = stopCutoffPartialBody ?? "";
      stoppedReplyPromise = (async () => {
        await maybeEmitAssistantState(input.onAssistantState, "stopped");
        if (!runFinalized) {
          await finalizeChatRun({
            status: "cancelled",
            error: "Chat run stopped before completion",
            errorCode: "chat_stopped",
            resultJson: {
              outcome: "stopped",
              partialBody,
            },
          });
        }
        return {
          outcome: "stopped",
          partialBody,
          replyingAgentId: runtimeAgentId,
        };
      })();
      return stoppedReplyPromise;
    };
    const guardActiveRun = async <T>(operation: () => T | Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        if (isStopped()) throw error;
        await finalizeUnhandledRunFailure(error);
        throw error;
      }
    };
    let cleanupPreparedAttachments: (() => Promise<void>) | null = null;
    let durableTranscriptImages = new Map<string, { contentPath: string; displayName: string }>();
    try {
      let parser = adapter.parseStdoutLine;
      let stdoutLineBuffer = "";
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
      const preparedAttachments = await guardActiveRun(() => prepareChatAttachmentReferences({
        runtimeType: runtimeAgentType,
        messages: input.messages,
        storage,
        runId,
      }));
      cleanupPreparedAttachments = preparedAttachments.cleanup;
      durableTranscriptImages = new Map(
        input.messages
          .slice(-12)
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
      const prompt = await guardActiveRun(() => buildConversationPrompt(
        input,
        runtimeSource,
        resultSentinel,
        typeof rudderWorkspace.orgResourcesPrompt === "string" ? rudderWorkspace.orgResourcesPrompt : "",
        preparedAttachments.references,
      ));

      const processTranscriptEntries = async (entries: TranscriptEntry[]) => {
        for (const entry of entries) {
          if (isStopped()) return;
          if (entry.kind === "tool_call") {
            await maybeEmitAssistantState(input.onAssistantState, "tool_busy");
            if (isStopped()) return;
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
              await maybeEmitObservedTranscriptEntry(input.onObservedTranscriptEntry, commentaryEntry);
              if (isStopped()) return;
              await maybeEmitTranscriptEntry(input.onTranscriptEntry, commentaryEntry);
              if (isStopped()) return;
              await chatRunsSvc.appendTranscriptEntry(chatRun, commentaryEntry);
              continue;
            }
            const delta = assistantTextAccumulator.push(entry.text, entry.delta === true);
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
              await maybeEmitObservedTranscriptEntry(input.onObservedTranscriptEntry, assistantTranscriptEntry);
              if (isStopped()) return;
              await maybeEmitTranscriptEntry(input.onTranscriptEntry, assistantTranscriptEntry);
              if (isStopped()) return;
              await chatRunsSvc.appendTranscriptEntry(chatRun, assistantTranscriptEntry);
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
              await maybeEmitObservedTranscriptEntry(input.onObservedTranscriptEntry, {
                ...safeResultEntry!,
                text: observedText,
              });
            }
          } else if (
            !(entry.kind === "stdout" && entry.text.includes(resultSentinel))
            && !(
              ("text" in safeEntry && typeof safeEntry.text === "string" && safeEntry.text.length === 0)
              || (safeEntry.kind === "tool_result" && safeEntry.content.length === 0)
            )
          ) {
            await maybeEmitObservedTranscriptEntry(input.onObservedTranscriptEntry, safeEntry);
          }
          if (isStopped()) return;
          const suppressVisibleEntry = shouldSuppressChatTranscriptEntry(entry, resultSentinel)
            || (
            ("text" in safeEntry && typeof safeEntry.text === "string" && safeEntry.text.length === 0)
            || (safeEntry.kind === "tool_result" && safeEntry.content.length === 0)
            );
          if (!suppressVisibleEntry) {
            await maybeEmitTranscriptEntry(input.onTranscriptEntry, safeEntry);
            if (isStopped()) return;
            await chatRunsSvc.appendTranscriptEntry(chatRun, safeEntry);
          }
          if (entry.kind === "tool_result") {
            await maybeEmitAssistantState(input.onAssistantState, "streaming");
            if (isStopped()) return;
          }
        }
      };

      const processStdoutLine = async (line: string) => {
        if (isStopped() || !parser || !line.trim()) return;
        await processTranscriptEntries(parser(line, new Date().toISOString()));
      };

      const flushStdoutChunk = async (chunk: string, finalize = false) => {
        if (isStopped()) return;
        const combined = `${stdoutLineBuffer}${chunk}`;
        const lines = combined.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (isStopped()) return;
          await processStdoutLine(line);
        }
        if (!isStopped() && finalize && stdoutLineBuffer.trim()) {
          const trailing = stdoutLineBuffer;
          stdoutLineBuffer = "";
          await processStdoutLine(trailing);
        }
      };

      if (isStopped()) return finalizeStoppedReply();
      await guardActiveRun(() => maybeEmitAssistantState(input.onAssistantState, "streaming"));
      if (isStopped()) return finalizeStoppedReply();

      const { chatAttachments, media } = await guardActiveRun(() => {
        const chatAttachments = input.messages
          .slice(-12)
          .flatMap((message) => message.attachments)
          .map((attachment) => {
            const reference = preparedAttachments.references.get(attachment.id);
            return reference ? { attachmentId: attachment.id, ...reference } : null;
          })
          .filter((attachment): attachment is { attachmentId: string } & ChatAttachmentPromptReference =>
            attachment !== null,
          );
        return {
          chatAttachments,
          media: preparedAttachments.media,
        };
      });

      const resumeSession = input.resumeRunId
        ? {
            sessionId: chatRun.sessionIdBefore ?? null,
            sessionParams: recoveredChatRun?.sessionParamsBeforeJson ?? null,
            sessionDisplayId: chatRun.sessionIdBefore ?? null,
          }
        : {
            sessionId: null,
            sessionParams: null,
            sessionDisplayId: null,
          };

      const executeChatAdapter = async (chatPrompt: string) => {
        return executeAdapterWithModelFallbacks(adapter, {
          runId,
          agent: stubAgent({
            orgId: input.conversation.orgId,
            agentRuntimeType: runtimeAgentType,
            agentRuntimeConfig: config,
            sourceLabel: runtimeSource.descriptor.sourceLabel,
            sourceId: runtimeAgentId,
          }),
          runtime: {
            sessionId: resumeSession.sessionId,
            sessionParams: resumeSession.sessionParams,
            sessionDisplayId: resumeSession.sessionDisplayId,
            taskKey: null,
          },
          config,
          context: {
            chatPrompt,
            chatConversationId: input.conversation.id,
            chatMode: true,
            rudderChatInlineVisualProtocolVersion: 1,
            rudderScene,
            rudderWorkspace,
            rudderWorkspaces,
            rudderStartupContext,
            rudderStartupContextMetrics,
            ...(chatAttachments.length > 0 ? { chatAttachments } : {}),
            ...(rudderRuntimeServiceIntents ? { rudderRuntimeServiceIntents } : {}),
            ...(linkedProjectId ? { projectId: linkedProjectId } : {}),
            ...(linkedGoalId ? { goalId: linkedGoalId } : {}),
            ...(linkedIssueIds[0] ? { issueId: linkedIssueIds[0] } : {}),
            ...(linkedIssueIds.length > 0 ? { issueIds: linkedIssueIds } : {}),
          },
          ...(media.length > 0 ? { media } : {}),
          onMeta: async (meta) => {
            if (isStopped()) return;
            await chatRunsSvc.appendAdapterInvoke(chatRun, meta, runtimeSource.runtimeSkills);
            if (isStopped()) return;
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
          abortSignal: input.abortSignal,
          controlCoordinator: input.controlCoordinator,
          onLog: async (stream, chunk) => {
            if (isStopped()) return;
            if (stream === "stdout") {
              if (chunk.startsWith("[rudder]")) {
                await processTranscriptEntries([{
                  kind: "stdout",
                  ts: new Date().toISOString(),
                  text: chunk,
                }]);
                return;
              }
              await flushStdoutChunk(chunk);
            }
          },
        }, {
          resolveAdapter: findServerAdapter,
          createAuthToken: (agentRuntimeType) =>
            createLocalAgentJwt(
              runtimeAgentId,
              input.conversation.orgId,
              agentRuntimeType,
              runId,
            ) ?? undefined,
          onAttemptStart: (_attempt, attemptAdapter) => {
            parser = attemptAdapter.parseStdoutLine;
          },
        });
      };

      const executeChatRepairAdapter = async (chatPrompt: string) => {
        parser = adapter.parseStdoutLine;
        const repairConfig = projectPrimaryRuntimeConfig(config, runtimeAgentType);
        return adapter.execute({
          runId,
          agent: stubAgent({
            orgId: input.conversation.orgId,
            agentRuntimeType: runtimeAgentType,
            agentRuntimeConfig: repairConfig,
            sourceLabel: runtimeSource.descriptor.sourceLabel,
            sourceId: runtimeAgentId,
          }),
          runtime: {
            sessionId: null,
            sessionParams: null,
            sessionDisplayId: null,
            taskKey: null,
          },
          config: repairConfig,
          context: {
            chatPrompt,
            chatConversationId: input.conversation.id,
            chatMode: true,
            rudderChatResultRepair: true,
            rudderChatInlineVisualProtocolVersion: 1,
            rudderScene,
            rudderWorkspace,
            rudderWorkspaces,
            rudderStartupContext,
            rudderStartupContextMetrics,
            ...(rudderRuntimeServiceIntents ? { rudderRuntimeServiceIntents } : {}),
            ...(linkedProjectId ? { projectId: linkedProjectId } : {}),
            ...(linkedGoalId ? { goalId: linkedGoalId } : {}),
            ...(linkedIssueIds[0] ? { issueId: linkedIssueIds[0] } : {}),
            ...(linkedIssueIds.length > 0 ? { issueIds: linkedIssueIds } : {}),
          },
          onMeta: async (meta) => {
            if (isStopped()) return;
            await chatRunsSvc.appendAdapterInvoke(chatRun, {
              ...meta,
              commandNotes: [...(meta.commandNotes ?? []), "internal chat result sentinel repair"],
              context: {
                ...(meta.context ?? {}),
                rudderChatResultRepair: true,
              },
            }, runtimeSource.runtimeSkills);
          },
          authToken: adapter.supportsLocalAgentJwt
            ? createLocalAgentJwt(
              runtimeAgentId,
              input.conversation.orgId,
              runtimeAgentType,
              runId,
            ) ?? undefined
            : undefined,
          abortSignal: input.abortSignal,
          onLog: async () => undefined,
        });
      };

      const result = await guardActiveRun(() => executeChatAdapter(prompt));

      if (isStopped()) return finalizeStoppedReply();
      await guardActiveRun(() => flushStdoutChunk("", true));
      if (isStopped()) return finalizeStoppedReply();

      const networkSuspension = isAgentRuntimeNetworkSuspension(result.networkSuspension)
        ? result.networkSuspension
        : isAgentRuntimeNetworkSuspension(result.suspension)
          ? result.suspension
          : null;
      if (networkSuspension) {
        const partialBody = redactRudderInlineVisualSources(
          partialBodyFromRawAssistantText(assistantTextAccumulator.fullText, resultSentinel)
          || (safeTrim(sentinelStream.visibleText) ?? ""),
        );
        await chatRunsSvc.markWaitingForNetwork(chatRun, networkSuspension);
        await input.onWaitingForNetwork?.(networkSuspension);
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
      const rawAssistantText = assistantTextAccumulator.fullText;
      const partialBody =
        redactRudderInlineVisualSources(partialBodyFromRawAssistantText(
          rawAssistantText,
          resultSentinel,
        )) ||
        (safeTrim(inlineVisualStream.visibleText) ?? "");
      const finalPartialBody =
        redactRudderInlineVisualSources(
          finalBodyFromRawAssistantText(rawResultText, resultSentinel)
          || finalBodyFromRawAssistantText(rawAssistantText, resultSentinel),
        );

      if (isStopped()) return finalizeStoppedReply();

      if (result.timedOut) {
        const errorCode = "chat_timed_out";
        await finalizeChatRun({
          status: "timed_out",
          error: "Chat request timed out",
          errorCode,
          resultJson: {
            outcome: "failed",
            recoverable: true,
            fallbackEnvelope: true,
            partialBody: finalPartialBody,
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
          || rawAssistantText,
        );
        const errorCode: ChatRecoverableFailureCode = hasModelOutputEvidence
          ? "chat_adapter_failed"
          : "chat_runtime_boot_failed";
        const retryable = errorCode !== "chat_runtime_boot_failed";
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
            failurePhase: errorCode === "chat_runtime_boot_failed" ? "runtime_boot" : "model_generation",
            action: errorCode === "chat_runtime_boot_failed" ? "repair_runtime" : "retry",
            exitCode: result.exitCode ?? null,
            partialBody: finalPartialBody,
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
            failurePhase: errorCode === "chat_runtime_boot_failed" ? "runtime_boot" : "model_generation",
            action: errorCode === "chat_runtime_boot_failed" ? "repair_runtime" : "retry",
          },
        );
      }

      if (isStopped()) return finalizeStoppedReply();
      await guardActiveRun(() => maybeEmitAssistantState(input.onAssistantState, "finalizing"));
      if (isStopped()) return finalizeStoppedReply();

      const raw = resultText(result) || assistantTextAccumulator.fullText;
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
      let sentinelRepairAttempted = false;
      let sentinelRepairSucceeded = false;
      let repairResultUsage = null as typeof result.usage | null | undefined;
      try {
        reply = parseCompletedAssistantReply(raw, resultSentinel, {
          requireSentinel: true,
          ...proposalValidationOptions,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Chat adapter returned an invalid final reply";
        const errorCode: ChatRecoverableFailureCode = errorMessage.includes("without the required Rudder result sentinel")
          ? "chat_result_missing_sentinel"
          : "chat_result_malformed_json";
        if (errorCode === "chat_result_missing_sentinel" && !input.abortSignal?.aborted) {
          const priorText = resultText(result);
          if (priorText) {
            sentinelRepairAttempted = true;
            const repairPrompt = buildMissingResultSentinelRepairPrompt({
              resultSentinel,
              priorText,
            });
            const repairResult = await guardActiveRun(() => executeChatRepairAdapter(repairPrompt));
            if (isStopped()) return finalizeStoppedReply();
            repairResultUsage = repairResult.usage;
            if (!repairResult.timedOut && (repairResult.exitCode ?? 0) === 0 && !repairResult.errorMessage) {
              try {
                const repairedReply = parseCompletedAssistantReply(resultText(repairResult), resultSentinel, {
                  requireSentinel: true,
                  ...proposalValidationOptions,
                });
                if (
                  repairedReply.body.includes(resultSentinel)
                  || repairedReply.body.includes("Rudder internal repair request:")
                ) {
                  throw new Error("Repair response leaked internal result protocol text");
                }
                reply = repairedReply;
                sentinelRepairSucceeded = true;
              } catch {
                reply = null;
              }
            } else {
              reply = null;
            }
          }
        }

        if (
          !sentinelRepairSucceeded
          && errorCode === "chat_result_missing_sentinel"
          && safeTrim(resultText(result))
        ) {
          const fallbackBody = safeTrim(resultText(result)) ?? "";
          if (
            !fallbackBody.includes(resultSentinel)
            && !fallbackBody.includes("Rudder internal repair request:")
          ) {
            reply = {
              kind: "message",
              body: fallbackBody,
              structuredPayload: null,
            };
          }
        }

        if (!reply && !sentinelRepairSucceeded) {
          const repairErrorMessage = sentinelRepairAttempted
            ? "Chat adapter did not produce the required Rudder result sentinel after internal repair"
            : errorMessage;
          await finalizeChatRun({
            status: "failed",
            error: repairErrorMessage,
            errorCode,
            resultJson: {
              outcome: "failed",
              recoverable: true,
              fallbackEnvelope: true,
              errorCode,
              userMessage: recoverableFailureMessage(errorCode),
              partialBody: finalPartialBody,
              ...(sentinelRepairAttempted
                ? {
                  sentinelRepairAttempted: true,
                  sentinelRepairSucceeded: false,
                }
                : {}),
            },
          });
          throw new ChatAssistantStreamError(
            repairErrorMessage,
            finalPartialBody,
            generatedAttachments,
            {
              errorCode,
              partialBodyUserVisible: Boolean(finalPartialBody),
              userMessage: recoverableFailureMessage(errorCode),
            },
          );
        }
      }
      if (!reply) {
        throw new Error("Chat adapter returned an invalid final reply");
      }
      const runtimeNeutralInlineVisuals = reply.kind === "message"
        ? extractRudderInlineVisualArtifacts(reply.body, {
          reservedSlots: inlineVisualArtifacts.inlineVisuals.length,
        })
        : {
          body: redactRudderInlineVisualSources(reply.body),
          attachments: [],
          inlineVisualsV1: [],
        };
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
      if (!sentinelRepairSucceeded && finalBody && finalBody !== streamedBody) {
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
          ...(sentinelRepairAttempted
            ? {
              sentinelRepairAttempted: true,
              sentinelRepairSucceeded,
              repairReason: "missing_result_sentinel",
            }
            : {}),
        },
        usageJson: combineChatUsage(result.usage, repairResultUsage),
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
      await cleanupPreparedAttachments?.().catch(() => undefined);
    }
  }

  return {
    enrichConversation,
    enrichConversations,
    getChatAssistantAvailability: async (conversation: ChatConversation) => {
      const resolved = await resolveChatInvocation({
        conversation,
        contextLinks: Array.isArray(conversation.contextLinks) ? conversation.contextLinks : [],
        materializeMissingRuntimeSkills: false,
      });
      return resolved.runtimeSource.descriptor.available && !resolved.availabilityError
        ? {
          ...resolved.runtimeSource.descriptor,
          available: true as const,
        }
        : {
          ...resolved.runtimeSource.descriptor,
          available: false as const,
          error: resolved.availabilityError ?? resolved.runtimeSource.descriptor.error,
        };
    },
    getDraftChatAssistantAvailability: async (input: {
      orgId: string;
      preferredAgentId: string | null;
      modelOverride?: string | null;
      effortOverride?: string | null;
      contextLinks?: Array<Pick<ChatContextLink, "entityType" | "entityId"> & Partial<ChatContextLink>>;
      planMode?: boolean;
    }) => {
      const contextLinks = (input.contextLinks ?? []) as ChatContextLink[];
      const resolved = await resolveChatInvocation({
        conversation: {
          id: randomUUID(),
          orgId: input.orgId,
          preferredAgentId: input.preferredAgentId,
          modelOverride: input.modelOverride ?? null,
          effortOverride: input.effortOverride ?? null,
          primaryIssueId: null,
          contextLinks,
          planMode: input.planMode ?? false,
        },
        contextLinks,
        materializeMissingRuntimeSkills: false,
      });
      return resolved.runtimeSource.descriptor.available && !resolved.availabilityError
        ? { ...resolved.runtimeSource.descriptor, available: true as const }
        : {
          ...resolved.runtimeSource.descriptor,
          available: false as const,
          error: resolved.availabilityError ?? resolved.runtimeSource.descriptor.error,
        };
    },
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
