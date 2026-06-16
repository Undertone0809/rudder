import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import type {
  AgentRuntimeType,
  ChatContextLink,
  ChatConversation
} from "@rudderhq/shared";
import { randomUUID } from "node:crypto";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { findServerAdapter } from "../agent-runtimes/index.js";
import type { StorageService } from "../storage/types.js";
import { agentRunContextService } from "./agent-run-context.js";
import { agentService } from "./agents.js";
import { chatAgentRunService } from "./chat-agent-runs.js";
import { asString, buildConversationPrompt, CHAT_RESULT_SENTINEL_PREFIX, CHAT_UNSUPPORTED_ADAPTER_TYPES, ChatAssistantResult, ChatAssistantStreamError, ChatAttachmentPromptReference, chatExecutionConfig, createAssistantTextAccumulator, createSentinelStream, extractGeneratedAttachments, finalBodyFromRawAssistantText, GenerateChatAssistantReplyInput, linkedIssueIdsForChat, linkedProjectIdForChat, maybeEmitAssistantDelta, maybeEmitAssistantState, maybeEmitObservedTranscriptEntry, maybeEmitTranscriptEntry, modelLabel, parseCompletedAssistantReply, partialBodyFromRawAssistantText, prepareChatAttachmentReferences, ResolvedChatRuntimeSource, resultText, safeTrim, shouldSuppressChatTranscriptEntry, StreamChatAssistantReplyInput, StreamChatAssistantReplyResult, stubAgent, summarizeRuntimeSkills, unavailableAgentDescriptor, unconfiguredDescriptor } from "./chat-assistant.helpers.js";
import { preflightManagedAgentWorkspace } from "./managed-workspace-preflight.js";
import { executeAdapterWithModelFallbacks } from "./runtime-kernel/model-fallback.js";
export * from "./chat-assistant.helpers.js";

export function chatAssistantService(db: Db, storage?: StorageService) {
  const agentsSvc = agentService(db);
  const runContextSvc = agentRunContextService(db);
  const chatRunsSvc = chatAgentRunService(db);

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
    const chatRun = await chatRunsSvc.createRun({
      conversation: input.conversation,
      agentId: runtimeAgentId,
      triggerDetail: input.stream ? "chat_assistant_reply_stream" : "chat_assistant_reply",
      userMessageId: input.userMessageId ?? null,
      chatTurnId: input.chatTurnId ?? null,
      turnVariant: input.turnVariant ?? 0,
      linkedIssueIds,
      linkedProjectId,
    });
    const runId = chatRun.id;
    await input.onRunCreated?.(runId);
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
            await chatRunsSvc.appendTranscriptEntry(chatRun, assistantTranscriptEntry);
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
        await chatRunsSvc.appendTranscriptEntry(chatRun, entry);
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
            await chatRunsSvc.appendAdapterInvoke(chatRun, meta, runtimeSource.runtimeSkills);
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
                await chatRunsSvc.appendTranscriptEntry(chatRun, entry);
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

    const rawResultText = resultText(result);
    const rawAssistantText = assistantTextAccumulator.fullText || rawResultText;
    const partialBody =
      partialBodyFromRawAssistantText(
        rawAssistantText,
        resultSentinel,
      ) ||
      (safeTrim(sentinelStream.visibleText) ?? "");
    const finalPartialBody =
      finalBodyFromRawAssistantText(rawResultText, resultSentinel)
      || finalBodyFromRawAssistantText(rawAssistantText, resultSentinel);

    if (input.abortSignal?.aborted) {
      await maybeEmitAssistantState(input.onAssistantState, "stopped");
      await chatRunsSvc.finalizeRun(runId, {
        status: "cancelled",
        error: "Chat run stopped before completion",
        errorCode: "chat_stopped",
        resultJson: {
          outcome: "stopped",
          partialBody,
        },
      });
      return {
        outcome: "stopped",
        partialBody,
        replyingAgentId: runtimeAgentId,
      };
    }

    if (result.timedOut) {
      await chatRunsSvc.finalizeRun(runId, {
        status: "timed_out",
        error: "Chat request timed out",
        errorCode: "chat_timed_out",
        resultJson: {
          partialBody: finalPartialBody,
        },
      });
      throw new ChatAssistantStreamError(
        "Chat request timed out",
        finalPartialBody,
        [],
        { partialBodyUserVisible: Boolean(finalPartialBody) },
      );
    }
    if ((result.exitCode ?? 0) !== 0 || result.errorMessage) {
      await chatRunsSvc.finalizeRun(runId, {
        status: "failed",
        error: result.errorMessage ?? "Chat adapter execution failed",
        errorCode: "chat_adapter_failed",
        resultJson: {
          exitCode: result.exitCode ?? null,
          partialBody: finalPartialBody,
        },
      });
      throw new ChatAssistantStreamError(
        result.errorMessage ?? "Chat adapter execution failed",
        finalPartialBody,
        [],
        { partialBodyUserVisible: Boolean(finalPartialBody) },
      );
    }

    await maybeEmitAssistantState(input.onAssistantState, "finalizing");

    const raw = resultText(result) || assistantTextAccumulator.fullText;
    const generatedAttachments = extractGeneratedAttachments(result);
    let reply: ChatAssistantResult;
    try {
      reply = parseCompletedAssistantReply(raw, resultSentinel, { requireSentinel: true });
    } catch (error) {
      await chatRunsSvc.finalizeRun(runId, {
        status: "failed",
        error: error instanceof Error ? error.message : "Chat adapter returned an invalid final reply",
        errorCode: "chat_invalid_reply",
        resultJson: {
          partialBody: finalPartialBody,
        },
      });
      throw new ChatAssistantStreamError(
        error instanceof Error ? error.message : "Chat adapter returned an invalid final reply",
        finalPartialBody,
        generatedAttachments,
        { partialBodyUserVisible: Boolean(finalPartialBody) },
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

    await chatRunsSvc.finalizeRun(runId, {
      status: "succeeded",
      resultJson: {
        outcome: "completed",
        kind: reply.kind,
        body: finalBody,
        generatedAttachmentCount: generatedAttachments.length,
      },
      usageJson: result.usage ? { ...result.usage } : null,
    });

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
