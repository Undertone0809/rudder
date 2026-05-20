import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { LangfuseObservation } from "@langfuse/tracing";
import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  addChatMessageSchema,
  updateChatConversationUserStateSchema,
  type ChatContextLink,
  type ChatConversation,
  type ChatAttachment,
  type ChatMessage,
  type ExecutionObservabilityContext,
  type ExecutionObservabilitySurface,
  convertChatToIssueSchema,
  createChatAttachmentMetadataSchema,
  createChatContextLinkSchema,
  createChatConversationSchema,
  resolveChatOperationProposalSchema,
  setChatProjectContextSchema,
  updateChatConversationSchema,
} from "@rudderhq/shared";
import type { StorageService } from "../storage/types.js";
import type { AgentRuntimeInvocationMeta } from "../agent-runtimes/index.js";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { forbidden, HttpError, unauthorized } from "../errors.js";
import {
  observeExecutionEvent,
  updateExecutionObservation,
  updateExecutionTraceIO,
  withExecutionObservation,
} from "../langfuse.js";
import { emitExecutionTranscriptTree } from "../langfuse-transcript.js";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  ChatAssistantStreamError,
  chatAssistantService,
  type ChatAssistantResult,
  type ChatGeneratedAttachment,
} from "../services/chat-assistant.js";
import { cancelActiveChatGeneration, claimChatGeneration, hasActiveChatGeneration } from "../services/chat-generation-locks.js";
import {
  accessService,
  agentService,
  chatService,
  operatorProfileService,
  organizationService,
  goalService,
  issueService,
  logActivity,
  projectService,
} from "../services/index.js";
import { summarizeRuntimeSkillsForTrace } from "../services/runtime-trace-metadata.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

type ChatStreamRouteContext = {
  router: Router;
  db: Db;
  storage: StorageService;
  [key: string]: any;
};

export function registerChatStreamRoutes(ctx: ChatStreamRouteContext) {
  const {
    router,
    db,
    storage,
    svc,
    assistantSvc,
    agentsSvc,
    issuesSvc,
    projectsSvc,
    goalsSvc,
    access,
    operatorProfiles,
    assertConversationAccess,
    boardUserId,
    assertCanAssignTasks,
    runSingleFileUpload,
    runMessageFileUpload,
    isMultipartRequest,
    uploadedMessageFiles,
    validateUploadedMessageFiles,
    buildChatObservabilityContext,
    withChatObservation,
    emitChatObservationEvent,
    summarizeChatObservationMessages,
    modelTurnInputFromInvocationMeta,
    buildChatTraceInput,
    mergeChatInvocationTraceMetadata,
    logChatMessagesAdded,
    assertContextLinksBelongToCompany,
    turnContextFromUserMessage,
    addUserMessage,
    attachFilesToUserMessage,
    loadAssistantInput,
    chatReplyingAgentId,
    assertCanConvertIssueProposal,
    persistAssistantReply,
    attachGeneratedFilesToPartialMessage,
    persistPartialAssistantMessage,
    writeStreamEvent,
  } = ctx;
  router.post("/chats/:id/messages/stream", async (req, res) => {
    if (isMultipartRequest(req)) {
      try {
        await runMessageFileUpload(req, res);
      } catch (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
            return;
          }
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    }

    const parsedBody = addChatMessageSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res.status(400).json({ error: "Invalid chat message", details: parsedBody.error.issues });
      return;
    }
    const messageFiles = uploadedMessageFiles(req);
    const attachmentValidationError = validateUploadedMessageFiles(messageFiles);
    if (attachmentValidationError) {
      res.status(422).json({ error: attachmentValidationError });
      return;
    }

    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }

    const assistantAvailability = await assistantSvc.getChatAssistantAvailability(conversation as ChatConversation);
    if (!assistantAvailability.available) {
      res.status(503).json({ error: assistantAvailability.error });
      return;
    }

    const abortController = new AbortController();
    const releaseGeneration = claimChatGeneration(conversation.id, abortController);
    if (!releaseGeneration) {
      res.status(409).json({ error: "A chat reply is already being generated for this conversation" });
      return;
    }

    const actor = getActorInfo(req);
    let assistantConversationForPartial: ChatConversation | null = null;
    let turnContextForPartial: ReturnType<typeof turnContextFromUserMessage> | null = null;
    let chatObservation: ExecutionObservabilityContext | null = null;
    const transcript: TranscriptEntry[] = [];
    const observedTranscript: TranscriptEntry[] = [];
    let modelTurnInput: unknown;
    let assistantProgressMessage: ChatMessage | null = null;
    let assistantProgressMessageId: string | null = null;
    let assistantDraftBody = "";
    const persistStreamProgress = async (
      progressConversation: ChatConversation,
      replyingAgentId = chatReplyingAgentId(progressConversation),
    ) => {
      if (!turnContextForPartial) return null;
      const input = {
        kind: "message" as const,
        status: "streaming" as const,
        body: assistantDraftBody,
        transcript,
        replyingAgentId,
      };
      if (assistantProgressMessage) {
        const updated = await svc.updateMessage(progressConversation.id, assistantProgressMessage.id, input);
        if (updated) {
          assistantProgressMessage = updated as ChatMessage;
          assistantProgressMessageId = assistantProgressMessage.id;
          return assistantProgressMessage;
        }
      }
      assistantProgressMessage = await svc.addMessage(progressConversation.id, {
        orgId: progressConversation.orgId,
        role: "assistant",
        kind: "message",
        status: "streaming",
        body: assistantDraftBody,
        transcript,
        replyingAgentId,
        chatTurnId: turnContextForPartial.chatTurnId,
        turnVariant: turnContextForPartial.turnVariant,
      }) as ChatMessage;
      assistantProgressMessageId = assistantProgressMessage.id;
      return assistantProgressMessage;
    };
    let clientClosed = false;
    const handleClosed = () => {
      if (clientClosed || res.writableEnded) return;
      clientClosed = true;
    };
    req.on("aborted", handleClosed);
    res.on("close", handleClosed);

    res.status(201);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      const userMessage = await addUserMessage(
        conversation as ChatConversation,
        parsedBody.data.body,
        actor,
        parsedBody.data.editUserMessageId ?? null,
      );
      const userAttachments = await attachFilesToUserMessage(
        conversation as ChatConversation,
        userMessage.id,
        messageFiles,
        actor,
      );
      const hydratedUserMessage = {
        ...userMessage,
        attachments: userAttachments,
      } as ChatMessage;
      turnContextForPartial = turnContextFromUserMessage(userMessage);
      chatObservation = buildChatObservabilityContext(conversation as ChatConversation, {
        surface: "chat_turn",
        rootExecutionId: turnContextForPartial.chatTurnId,
        trigger: "assistant_reply_stream",
        runtime: assistantAvailability.agentRuntimeType ?? null,
        metadata: {
          stream: true,
          userMessageId: userMessage.id,
          editUserMessageId: parsedBody.data.editUserMessageId ?? null,
          attachmentCount: userAttachments.length,
        },
      });
      const traceInputBase = {
        conversationId: conversation.id,
        body: parsedBody.data.body,
        userMessageId: userMessage.id,
      };
      let currentChatTraceInput = buildChatTraceInput(traceInputBase);
      writeStreamEvent(res, {
        type: "ack",
        userMessage: hydratedUserMessage,
      });

      await withChatObservation(
        chatObservation,
        {
          name: "chat_turn",
          asType: "agent",
          input: currentChatTraceInput,
        },
        async (observation: LangfuseObservation | null) => {
          const assistantInput = await loadAssistantInput(conversation as ChatConversation, actor);
          assistantConversationForPartial = assistantInput.conversation;
          let finalChatOutput: string | null = null;
          let finalChatStatus: "completed" | "stopped" | "failed" = "completed";
          try {
            const streamed = await assistantSvc.streamChatAssistantReply({
              ...assistantInput,
              abortSignal: abortController.signal,
              onInvocationMeta: async (meta: AgentRuntimeInvocationMeta) => {
                modelTurnInput = modelTurnInputFromInvocationMeta(meta);
                currentChatTraceInput = buildChatTraceInput(traceInputBase, meta);
                mergeChatInvocationTraceMetadata(chatObservation!, meta);
                updateExecutionObservation(observation, chatObservation!, {
                  input: currentChatTraceInput,
                });
                updateExecutionTraceIO(observation, { input: currentChatTraceInput });
              },
              onAssistantDelta: async (delta: string) => {
                assistantDraftBody = `${assistantDraftBody}${delta}`;
                await persistStreamProgress(assistantInput.conversation);
                if (clientClosed) return;
                writeStreamEvent(res, {
                  type: "assistant_delta",
                  delta,
                });
              },
              onAssistantState: async (state: unknown) => {
                await persistStreamProgress(assistantInput.conversation);
                if (clientClosed) return;
                writeStreamEvent(res, {
                  type: "assistant_state",
                  state,
                });
              },
              onTranscriptEntry: async (entry: TranscriptEntry) => {
                transcript.push(entry);
                await persistStreamProgress(assistantInput.conversation);
                if (clientClosed) return;
                writeStreamEvent(res, {
                  type: "transcript_entry",
                  entry,
                });
              },
              onObservedTranscriptEntry: async (entry: TranscriptEntry) => {
                observedTranscript.push(entry);
              },
            });

            if (streamed.outcome === "stopped") {
              finalChatStatus = "stopped";
              finalChatOutput = streamed.partialBody;
              const stoppedMessage = await persistPartialAssistantMessage(
                assistantInput.conversation,
                streamed.partialBody,
                "stopped",
                turnContextForPartial!,
                transcript,
                streamed.replyingAgentId,
                assistantProgressMessageId,
              );
              if (stoppedMessage) {
                await logChatMessagesAdded(assistantInput.conversation, [stoppedMessage], {
                  actorType: "system",
                  actorId: "chat-assistant",
                  agentId: streamed.replyingAgentId,
                });
              }
              await emitChatObservationEvent(chatObservation!, {
                name: "chat.reply.stopped",
                level: "WARNING",
                metadata: {
                  stoppedMessageId: stoppedMessage?.id ?? null,
                  transcriptEntries: transcript.length,
                  observedTranscriptEntries: observedTranscript.length,
                },
              });
              if (!clientClosed) {
                writeStreamEvent(res, {
                  type: "final",
                  messages: stoppedMessage ? [stoppedMessage] : [],
                });
                res.end();
              }
              return;
            }

            const createdMessages = await persistAssistantReply(
              req,
              assistantInput.conversation,
              actor,
              streamed.reply,
              turnContextForPartial!,
              transcript,
              streamed.replyingAgentId,
              assistantProgressMessageId,
            );
            finalChatOutput = streamed.reply.body;
            await logChatMessagesAdded(assistantInput.conversation, createdMessages, {
              actorType: "system",
              actorId: "chat-assistant",
              agentId: streamed.replyingAgentId,
            });
            await emitChatObservationEvent(chatObservation!, {
              name: "chat.reply.persisted",
              metadata: {
                transcriptEntries: transcript.length,
                observedTranscriptEntries: observedTranscript.length,
                ...summarizeChatObservationMessages(createdMessages),
              },
            });
            if (!clientClosed) {
              writeStreamEvent(res, {
                type: "final",
                messages: createdMessages,
              });
              res.end();
            }
          } catch (error) {
            finalChatStatus = "failed";
            if (error instanceof ChatAssistantStreamError) {
              finalChatOutput = error.partialBody;
            }
            throw error;
          } finally {
            try {
              const transcriptStats = emitExecutionTranscriptTree({
                context: chatObservation!,
                parentObservation: observation,
                transcript: observedTranscript,
                initialTurnInput: modelTurnInput,
                fallbackResult: finalChatOutput
                  ? {
                    output: finalChatOutput,
                    subtype: finalChatStatus,
                    isError: finalChatStatus === "failed",
                  }
                  : null,
              });
              finalChatOutput = finalChatOutput ?? transcriptStats.finalOutput ?? null;
            } catch (error) {
              logger.warn(
                {
                  rootExecutionId: chatObservation!.rootExecutionId,
                  err: error instanceof Error ? error.message : String(error),
                },
                "Failed to export chat transcript tree to Langfuse",
              );
            }
            updateExecutionObservation(observation, {
              ...chatObservation!,
              status: finalChatStatus,
            }, {
              input: currentChatTraceInput,
              output: finalChatOutput,
              level: finalChatStatus === "failed" ? "ERROR" : "DEFAULT",
              statusMessage: finalChatStatus,
            });
            updateExecutionTraceIO(observation, {
              input: currentChatTraceInput,
              output: finalChatOutput,
            });
          }
        },
      );
    } catch (err) {
      const partialBody = err instanceof ChatAssistantStreamError ? err.partialBody : "";
      const generatedAttachments = err instanceof ChatAssistantStreamError ? err.generatedAttachments : [];
      const failedReplyingAgentId = chatReplyingAgentId(assistantConversationForPartial);
      let failedMessage = await persistPartialAssistantMessage(
        assistantConversationForPartial ?? (conversation as ChatConversation),
        partialBody,
        "failed",
        turnContextForPartial!,
        transcript,
        failedReplyingAgentId,
        assistantProgressMessageId,
      ).catch(() => null);
      failedMessage = await attachGeneratedFilesToPartialMessage(
        assistantConversationForPartial ?? (conversation as ChatConversation),
        failedMessage as ChatMessage | null,
        generatedAttachments,
        failedReplyingAgentId,
      ).catch(() => failedMessage as ChatMessage | null);
      if (failedMessage && assistantConversationForPartial) {
        await logChatMessagesAdded(assistantConversationForPartial, [failedMessage], {
          actorType: "system",
          actorId: "chat-assistant",
          agentId: failedReplyingAgentId,
        }).catch(() => {});
      }

      if (chatObservation) {
        await emitChatObservationEvent(chatObservation, {
          name: "chat.reply.failed",
          level: "ERROR",
          metadata: {
            failedMessageId: failedMessage?.id ?? null,
            transcriptEntries: transcript.length,
            observedTranscriptEntries: observedTranscript.length,
            error: err instanceof Error ? err.message : String(err),
          },
          statusMessage: err instanceof Error ? err.message : "chat_reply_failed",
        });
      }

      logger.warn({ err, conversationId: conversation.id }, "chat assistant stream failed");
      if (!clientClosed) {
        writeStreamEvent(res, {
          type: "error",
          error: err instanceof Error ? err.message : "Chat assistant failed to respond",
          messageId: failedMessage?.id ?? null,
        });
        res.end();
      }
    } finally {
      req.off("aborted", handleClosed);
      res.off("close", handleClosed);
      releaseGeneration();
    }
  });

  router.post("/chats/:id/messages/stream/stop", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }

    res.json({ stopped: cancelActiveChatGeneration(conversation.id) });
  });

  router.post("/orgs/:orgId/chats/:chatId/attachments", async (req, res) => {
    const orgId = req.params.orgId as string;
    const chatId = req.params.chatId as string;
    assertCompanyAccess(req, orgId);

    const conversation = await svc.getById(chatId);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    if (conversation.orgId !== orgId) {
      res.status(422).json({ error: "Chat conversation does not belong to organization" });
      return;
    }

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = (file.mimetype || "").toLowerCase();
    if (!isAllowedContentType(contentType)) {
      res.status(422).json({ error: `Unsupported attachment type: ${contentType || "unknown"}` });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createChatAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      orgId,
      namespace: `chats/${chatId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      orgId,
      conversationId: chatId,
      messageId: parsedMeta.data.messageId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.attachment_added",
      entityType: "chat",
      entityId: chatId,
      details: {
        attachmentId: attachment.id,
        messageId: attachment.messageId,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
      },
    });

    res.status(201).json(attachment);
  });

  router.post("/chats/:id/context-links", validate(createChatContextLinkSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    await assertContextLinksBelongToCompany(conversation.orgId, [req.body]);
    const linked = await svc.addContextLink(conversation.id, conversation.orgId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: conversation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.context_linked",
      entityType: "chat",
      entityId: conversation.id,
      details: req.body,
    });
    res.status(201).json(linked);
  });

  router.post("/chats/:id/project-context", validate(setChatProjectContextSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const projectId = req.body.projectId ?? null;
    if (projectId) {
      await assertContextLinksBelongToCompany(conversation.orgId, [{
        entityType: "project",
        entityId: projectId,
      }]);
    }
    const messages = await svc.listMessages(conversation.id);
    if (messages.length > 0) {
      res.status(409).json({ error: "Project context is locked after conversation starts" });
      return;
    }

    const updated = await svc.setProjectContextLink(conversation.id, conversation.orgId, projectId);
    if (!updated) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: conversation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.project_context_updated",
      entityType: "chat",
      entityId: conversation.id,
      details: { projectId },
    });
    res.json(updated);
  });

  router.post("/chats/:id/convert-to-issue", validate(convertChatToIssueSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const actor = getActorInfo(req);
    if (req.body.proposal?.goalId) {
      const goal = await goalsSvc.getById(req.body.proposal.goalId);
      if (!goal || goal.orgId !== conversation.orgId) {
        res.status(422).json({ error: "Goal must belong to the same organization" });
        return;
      }
    }
    await assertCanConvertIssueProposal(req, conversation as ChatConversation, {
      messageId: req.body.messageId ?? null,
      proposal: req.body.proposal ?? null,
    });
    const chatObservation = buildChatObservabilityContext(conversation as ChatConversation, {
      rootExecutionId: req.body.messageId ?? `chat-convert:${conversation.id}`,
      trigger: "convert_to_issue",
      metadata: {
        source: "chat_route",
        messageId: req.body.messageId ?? null,
      },
    });
    const result = await withChatObservation(
      chatObservation,
      {
        name: "chat:convert_to_issue",
        asType: "tool",
        input: {
          conversationId: conversation.id,
          messageId: req.body.messageId ?? null,
          proposal: req.body.proposal ?? null,
        },
      },
      async () => {
        const issue = await svc.convertToIssue(conversation.id, {
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
          messageId: req.body.messageId ?? null,
          proposal: req.body.proposal ?? null,
        });
        const systemMessage = await svc.addMessage(conversation.id, {
          orgId: conversation.orgId,
          role: "system",
          kind: "system_event",
          body: `Created issue ${issue.identifier ?? issue.id} from this chat conversation.`,
          structuredPayload: {
            eventType: "issue_created",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
          },
        });
        await logActivity(db, {
          orgId: conversation.orgId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "chat.issue_converted",
          entityType: "chat",
          entityId: conversation.id,
          details: {
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            messageId: req.body.messageId ?? null,
            systemMessageId: systemMessage.id,
          },
        });
        await emitChatObservationEvent(chatObservation, {
          name: "chat.issue.created",
          metadata: {
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            systemMessageId: systemMessage.id,
          },
        });
        return { issue, systemMessage };
      },
    );
    res.status(201).json(result);
  });

  router.post(
    "/chats/:id/messages/:messageId/operation-proposal/resolve",
    validate(resolveChatOperationProposalSchema),
    async (req, res) => {
      const conversation = await assertConversationAccess(req, req.params.id as string);
      if (!conversation) {
        res.status(404).json({ error: "Chat conversation not found" });
        return;
      }

      const actor = getActorInfo(req);
      const messageId = req.params.messageId as string;
      const chatObservation = buildChatObservabilityContext(conversation as ChatConversation, {
        rootExecutionId: messageId,
        trigger: "resolve_operation_proposal",
        metadata: {
          action: req.body.action,
          decisionNote: req.body.decisionNote ?? null,
        },
      });
      const result = await withChatObservation(
        chatObservation,
        {
          name: "chat:resolve_operation_proposal",
          asType: "tool",
          input: {
            conversationId: conversation.id,
            messageId,
            action: req.body.action,
          },
        },
        async () => {
          const resolved = await svc.resolveOperationProposal(conversation.id, messageId, {
            action: req.body.action,
            actorUserId: actor.actorType === "user" ? actor.actorId : null,
            decisionNote: req.body.decisionNote ?? null,
          });
          await emitChatObservationEvent(chatObservation, {
            name: "chat.operation_proposal.resolved",
            metadata: {
              action: req.body.action,
              messageId: resolved.message.id,
              systemMessageId: resolved.systemMessage.id,
            },
          });
          return resolved;
        },
      );
      res.status(201).json(result);
    },
  );

  router.post("/chats/:id/resolve", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const resolved = await svc.resolve(conversation.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: conversation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.resolved",
      entityType: "chat",
      entityId: conversation.id,
    });
    res.json(resolved ? await assistantSvc.enrichConversation(resolved as ChatConversation) : null);
  });

  router.post("/chats/:id/read", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const userId = boardUserId(req);
    const state = await svc.markRead(conversation.id, conversation.orgId, userId);
    res.status(201).json({
      conversationId: conversation.id,
      lastReadAt: state.lastReadAt,
    });
  });

  router.post("/chats/:id/user-state", validate(updateChatConversationUserStateSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const userId = boardUserId(req);
    if (typeof req.body.pinned === "boolean") {
      await svc.setPinned(conversation.id, conversation.orgId, userId, req.body.pinned);
    }
    if (typeof req.body.unread === "boolean") {
      if (req.body.unread) {
        await svc.markUnread(conversation.id, conversation.orgId, userId);
      } else {
        await svc.markRead(conversation.id, conversation.orgId, userId);
      }
    }
    const refreshed = await svc.getById(conversation.id, userId);
    res.json(await assistantSvc.enrichConversation(refreshed as ChatConversation));
  });
}
