import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { RudderSkillEntry } from "@rudderhq/agent-runtime-utils/server-utils";
import type { Db } from "@rudderhq/db";
import type {
  AgentRuntimeType,
  ChatConversation,
  ChatContextLink,
  IssueLabel,
  ChatMessage,
  ChatRuntimeDescriptor,
  OperatorProfileSettings,
} from "@rudderhq/shared";
import { chatAskUserRequestFromStructuredPayload, sanitizeChatStructuredPayload } from "@rudderhq/shared";
import { findServerAdapter } from "../agent-runtimes/index.js";
import type { AgentRuntimeInvocationMeta, AgentRuntimeLoadedSkillMeta } from "../agent-runtimes/index.js";
import type { AgentRuntimeExecutionContext, AgentRuntimeExecutionResult } from "../agent-runtimes/types.js";
import { agentRunContextService, type AgentRunContextAgent } from "./agent-run-context.js";
import { agentService } from "./agents.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import type { StorageService } from "../storage/types.js";
import { executeAdapterWithModelFallbacks } from "./runtime-kernel/model-fallback.js";
import { preflightManagedAgentWorkspace } from "./managed-workspace-preflight.js";
import { CHAT_UNSUPPORTED_ADAPTER_TYPES, CHAT_RESULT_SENTINEL_PREFIX, ChatAttachmentPromptReference, ResolvedChatRuntimeSource, ChatAssistantResult, ChatGeneratedAttachment, GenerateChatAssistantReplyInput, StreamChatAssistantReplyInput, StreamChatAssistantReplyResult, ChatAssistantStreamError, safeTrim, asString, summarizeBody, modelLabel, unconfiguredDescriptor, unavailableAgentDescriptor, buildPrompt, buildCurrentUserAttachmentPromptSection, buildOperatorProfilePromptSection, buildSelectedProjectPromptSection, buildSelectedIssuePromptSection, buildIssueLabelsPromptSection, buildChatSpeakerPromptSection, buildChatResponseQualityPromptSection, buildBaseSystemPromptSections, buildPlanModePromptSection, buildResponseSchemaPromptSection, systemPrompt, extractJsonObject, asRecord, extractImageGenerationItem, base64PngToBuffer, extractGeneratedAttachments, isImageAttachment, extensionForContentType, safeAttachmentFilename, prepareChatAttachmentReferences, validateAssistantResult, buildConversationPrompt, resultText, configArgs, stripCliArgs, applyPlanModeRuntimeOverlay, chatExecutionConfig, linkedIssueIdsForChat, linkedProjectIdForChat, stubAgent, summarizeRuntimeSkills, longestSentinelPrefixSuffix, createAssistantTextAccumulator, createSentinelStream, parseAssistantEnvelope, parseCompletedAssistantReply, partialBodyFromRawAssistantText, maybeEmitAssistantState, maybeEmitAssistantDelta, maybeEmitTranscriptEntry, maybeEmitObservedTranscriptEntry, shouldSuppressChatTranscriptEntry } from "./chat-assistant.helpers.js";
export * from "./chat-assistant.helpers.js";

export function chatAssistantService(db: Db, storage?: StorageService) {
  const agentsSvc = agentService(db);
  const runContextSvc = agentRunContextService(db);

  async function resolveChatInvocation(input: {
    conversation: Pick<ChatConversation, "id" | "orgId" | "preferredAgentId" | "primaryIssueId" | "contextLinks" | "planMode">;
    contextLinks: ChatContextLink[];
  }) {
    const runtimeSource = await resolveConversationRuntime(input.conversation);
    if (!runtimeSource.descriptor.available) {
      return {
        runtimeSource,
        adapter: null,
        config: null,
        linkedIssueIds: [] as string[],
        linkedProjectId: null as string | null,
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
    });

    return {
      runtimeSource,
      adapter,
      config,
      linkedIssueIds,
      linkedProjectId,
      resolvedWorkspace,
      sceneContext,
      availabilityError: null,
    };
  }

  async function resolveAgentRuntime(
    orgId: string,
    agentId: string,
  ): Promise<ResolvedChatRuntimeSource | null> {
    const agent = await agentsSvc.getById(agentId);
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

    if (CHAT_UNSUPPORTED_ADAPTER_TYPES.has(agentAdapterType)) {
      return {
        descriptor: unavailableAgentDescriptor({
          sourceLabel: agent.name,
          runtimeAgentId: agent.id,
          agentRuntimeType: agentAdapterType,
          model: modelLabel(agentAdapterConfig) ?? null,
          error: `${agent.name} uses ${agentAdapterType}, which does not support chat conversations.`,
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

    const { runtimeConfig, runtimeSkillEntries } = await runContextSvc.prepareRuntimeConfig({
      scene: "chat",
      agent: {
        id: agent.id,
        orgId: agent.orgId,
        name: agent.name,
        status: agent.status,
        agentRuntimeType: agentAdapterType,
        agentRuntimeConfig: agentAdapterConfig,
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
    conversation: Pick<ChatConversation, "orgId" | "preferredAgentId">,
  ) {
    if (conversation.preferredAgentId) {
      const agentRuntime = await resolveAgentRuntime(conversation.orgId, conversation.preferredAgentId);
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
    const resolved = await resolveConversationRuntime(conversation);
    return {
      ...conversation,
      chatRuntime: resolved.descriptor,
    };
  }

  async function enrichConversations<T extends ChatConversation>(conversations: T[]): Promise<T[]> {
    return Promise.all(conversations.map((conversation) => enrichConversation(conversation)));
  }

  async function streamChatAssistantReply(
    input: StreamChatAssistantReplyInput,
  ): Promise<StreamChatAssistantReplyResult> {
    const resolvedInvocation = await resolveChatInvocation({
      conversation: input.conversation,
      contextLinks: input.contextLinks,
    });
    if (resolvedInvocation.availabilityError) {
      throw new Error(resolvedInvocation.availabilityError);
    }
    const {
      runtimeSource,
      adapter,
      config,
      linkedIssueIds,
      linkedProjectId,
      sceneContext,
    } = resolvedInvocation;
    if (
      !adapter ||
      !config ||
      !sceneContext ||
      !runtimeSource.agentRuntimeType ||
      !runtimeSource.descriptor.runtimeAgentId
    ) {
      throw new Error("Chat runtime is not configured");
    }
    const runtimeAgentType = runtimeSource.agentRuntimeType;
    const runtimeAgentId = runtimeSource.descriptor.runtimeAgentId;
    const resultSentinel = `${CHAT_RESULT_SENTINEL_PREFIX}${randomUUID()}__`;
    const runId = `chat-${input.conversation.id}-${randomUUID()}`;
    const assistantTextAccumulator = createAssistantTextAccumulator();
    const sentinelStream = createSentinelStream(resultSentinel);
    let parser = adapter.parseStdoutLine;
    let stdoutLineBuffer = "";
    const { rudderWorkspace, rudderWorkspaces, rudderRuntimeServiceIntents, rudderScene } = sceneContext;
    await preflightManagedAgentWorkspace({
      agentHome: asString(rudderWorkspace.agentHome),
      instructionsDir: asString(rudderWorkspace.instructionsDir),
      memoryDir: asString(rudderWorkspace.memoryDir),
      lifeDir: asString(rudderWorkspace.lifeDir),
      skillsDir: asString(rudderWorkspace.agentSkillsDir),
    });
    const preparedAttachments = await prepareChatAttachmentReferences({
      runtimeType: runtimeAgentType,
      messages: input.messages,
      storage,
      runId,
    });
    const prompt = buildConversationPrompt(
      input,
      runtimeSource,
      resultSentinel,
      typeof rudderWorkspace.orgResourcesPrompt === "string" ? rudderWorkspace.orgResourcesPrompt : "",
      preparedAttachments.references,
    );

    const processTranscriptEntries = async (entries: TranscriptEntry[]) => {
      for (const entry of entries) {
        if (entry.kind === "assistant") {
          const delta = assistantTextAccumulator.push(entry.text, entry.delta === true);
          if (!delta) continue;
          const visibleDelta = sentinelStream.push(delta);
          if (visibleDelta) {
            const assistantTranscriptEntry: TranscriptEntry = {
              kind: "assistant",
              ts: entry.ts,
              text: visibleDelta,
              delta: true,
            };
            await maybeEmitObservedTranscriptEntry(input.onObservedTranscriptEntry, assistantTranscriptEntry);
            await maybeEmitTranscriptEntry(input.onTranscriptEntry, assistantTranscriptEntry);
          }
          continue;
        }
        if (entry.kind === "result") {
          await maybeEmitObservedTranscriptEntry(input.onObservedTranscriptEntry, {
            ...entry,
            text: partialBodyFromRawAssistantText(entry.text, resultSentinel),
          });
        } else if (!(entry.kind === "stdout" && entry.text.includes(resultSentinel))) {
          await maybeEmitObservedTranscriptEntry(input.onObservedTranscriptEntry, entry);
        }
        if (shouldSuppressChatTranscriptEntry(entry, resultSentinel)) {
          continue;
        }
        await maybeEmitTranscriptEntry(input.onTranscriptEntry, entry);
      }
    };

    const processStdoutLine = async (line: string) => {
      if (!parser || !line.trim()) return;
      await processTranscriptEntries(parser(line, new Date().toISOString()));
    };

    const flushStdoutChunk = async (chunk: string, finalize = false) => {
      const combined = `${stdoutLineBuffer}${chunk}`;
      const lines = combined.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        await processStdoutLine(line);
      }
      if (finalize && stdoutLineBuffer.trim()) {
        const trailing = stdoutLineBuffer;
        stdoutLineBuffer = "";
        await processStdoutLine(trailing);
      }
    };

    await maybeEmitAssistantState(input.onAssistantState, "streaming");

    const chatAttachments = Array.from(preparedAttachments.references.entries()).map(([attachmentId, reference]) => ({
      attachmentId,
      ...reference,
    }));
    const media = preparedAttachments.media;

    const result = await (async () => {
      try {
        return await executeAdapterWithModelFallbacks(adapter, {
          runId,
          agent: stubAgent({
            orgId: input.conversation.orgId,
            agentRuntimeType: runtimeAgentType,
            agentRuntimeConfig: config,
            sourceLabel: runtimeSource.descriptor.sourceLabel,
            sourceId: runtimeAgentId,
          }),
          runtime: {
            sessionId: null,
            sessionParams: null,
            sessionDisplayId: null,
            taskKey: null,
          },
          config,
          context: {
            chatPrompt: prompt,
            chatConversationId: input.conversation.id,
            chatMode: true,
            rudderScene,
            rudderWorkspace,
            rudderWorkspaces,
            ...(chatAttachments.length > 0 ? { chatAttachments } : {}),
            ...(rudderRuntimeServiceIntents ? { rudderRuntimeServiceIntents } : {}),
            ...(linkedProjectId ? { projectId: linkedProjectId } : {}),
            ...(linkedIssueIds[0] ? { issueId: linkedIssueIds[0] } : {}),
            ...(linkedIssueIds.length > 0 ? { issueIds: linkedIssueIds } : {}),
          },
          ...(media.length > 0 ? { media } : {}),
          onMeta: async (meta) => {
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
          onLog: async (stream, chunk) => {
            if (stream === "stdout") {
              if (chunk.startsWith("[rudder]")) {
                const entry: TranscriptEntry = {
                  kind: "stdout",
                  ts: new Date().toISOString(),
                  text: chunk,
                };
                await maybeEmitObservedTranscriptEntry(input.onObservedTranscriptEntry, entry);
                await maybeEmitTranscriptEntry(input.onTranscriptEntry, entry);
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
      } finally {
        await preparedAttachments.cleanup();
      }
    })();

    await flushStdoutChunk("", true);
    await maybeEmitAssistantDelta(input.onAssistantDelta, sentinelStream.finish());

    const partialBody =
      partialBodyFromRawAssistantText(
        assistantTextAccumulator.fullText || resultText(result),
        resultSentinel,
      ) ||
      (safeTrim(sentinelStream.visibleText) ?? "");

    if (input.abortSignal?.aborted) {
      await maybeEmitAssistantState(input.onAssistantState, "stopped");
      return {
        outcome: "stopped",
        partialBody,
        replyingAgentId: runtimeAgentId,
      };
    }

    if (result.timedOut) {
      throw new ChatAssistantStreamError("Chat request timed out", partialBody);
    }
    if ((result.exitCode ?? 0) !== 0 || result.errorMessage) {
      throw new ChatAssistantStreamError(result.errorMessage ?? "Chat adapter execution failed", partialBody);
    }

    await maybeEmitAssistantState(input.onAssistantState, "finalizing");

    const raw = resultText(result) || assistantTextAccumulator.fullText;
    const generatedAttachments = extractGeneratedAttachments(result);
    let reply: ChatAssistantResult;
    try {
      reply = parseCompletedAssistantReply(raw, resultSentinel, { requireSentinel: true });
    } catch (error) {
      throw new ChatAssistantStreamError(
        error instanceof Error ? error.message : "Chat adapter returned an invalid final reply",
        partialBody,
        generatedAttachments,
      );
    }
    const finalBody = reply.body;
    reply.replyingAgentId = runtimeAgentId;
    if (generatedAttachments.length > 0) {
      reply.generatedAttachments = generatedAttachments;
    }

    const streamedBody = safeTrim(sentinelStream.visibleText) ?? "";
    if (finalBody && finalBody !== streamedBody) {
      await maybeEmitAssistantDelta(input.onAssistantDelta, finalBody);
    }

    return {
      outcome: "completed",
      reply,
      partialBody: finalBody,
      replyingAgentId: runtimeAgentId,
    };
  }

  return {
    enrichConversation,
    enrichConversations,
    getChatAssistantAvailability: async (conversation: ChatConversation) => {
      const resolved = await resolveChatInvocation({
        conversation,
        contextLinks: Array.isArray(conversation.contextLinks) ? conversation.contextLinks : [],
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
