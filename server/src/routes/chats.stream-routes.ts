import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  addChatMessageSchema,
  convertChatToIssueSchema,
  createChatAttachmentMetadataSchema,
  createChatContextLinkSchema,
  resolveChatOperationProposalSchema,
  setChatProjectContextSchema,
  updateChatConversationUserStateSchema,
  type ChatAttachment,
  type ChatConversation,
  type ChatMessage
} from "@rudderhq/shared";
import { Router, type Request } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { createAssistantTextAccumulator } from "../services/chat-assistant.helpers.js";
import {
  CHAT_ASSISTANT_USER_ERROR_MESSAGE,
  ChatAssistantStreamError,
  userVisiblePartialBodyFromError
} from "../services/chat-assistant.js";
import {
  cancelActiveChatGeneration,
  claimChatGeneration,
  getActiveChatGeneration,
  setActiveChatGenerationId,
} from "../services/chat-generation-locks.js";
import {
  logActivity
} from "../services/index.js";
import type { StorageService } from "../storage/types.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { wakeIssueAssigneeAfterChatConversion } from "./chat-issue-assignment-wakeup.js";

type ChatStreamRouteContext = {
  router: Router;
  db: Db;
  storage: StorageService;
  [key: string]: any;
};

export function registerChatStreamRoutes(ctx: ChatStreamRouteContext) {
  const CHAT_ASSISTANT_RECOVERABLE_FAILURE_FALLBACK_MESSAGE =
    "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.";
  const CHAT_ASSISTANT_STOPPED_FALLBACK_MESSAGE =
    "Chat run stopped before a final reply. Continue the conversation to resume from the preserved context.";
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
    heartbeat,
    assertConversationAccess,
    assertChatLocalMutationAllowed,
    boardUserId,
    assertCanAssignTasks,
    runSingleFileUpload,
    runMessageFileUpload,
    isMultipartRequest,
    uploadedMessageFiles,
    validateUploadedMessageFiles,
    logChatMessagesAdded,
    assertContextLinksBelongToCompany,
    turnContextFromUserMessage,
    addUserMessage,
    startChatTitleGeneration,
    attachFilesToUserMessage,
    loadAssistantInput,
    chatReplyingAgentId,
    assertCanConvertIssueProposal,
    persistAssistantReply,
    linkChatRunMessages,
    attachGeneratedFilesToPartialMessage,
    persistPartialAssistantMessage,
    recoverableFailurePayload,
    recoverableFailureBody,
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
    assertChatLocalMutationAllowed(conversation as ChatConversation);

    const actor = getActorInfo(req);
    if (actor.actorType === "agent") {
      if (parsedBody.data.editUserMessageId) {
        res.status(422).json({ error: "Agent-authored chat messages cannot edit operator messages" });
        return;
      }
      res.status(422).json({ error: "Agent-authored chat messages must use the non-stream message endpoint" });
      return;
    }

    const queuedMessageId = parsedBody.data.queuedMessageId ?? null;
    const assistantAvailability = await assistantSvc.getChatAssistantAvailability(conversation as ChatConversation);
    if (!assistantAvailability.available) {
      res.status(503).json({ error: assistantAvailability.error });
      return;
    }

    const abortController = new AbortController();
    const releaseGeneration = claimChatGeneration(conversation.id, abortController, null);
    if (!releaseGeneration) {
      if (queuedMessageId) {
        res.status(409).json({ error: "A chat reply is already being generated for this conversation" });
        return;
      }
      if (messageFiles.length > 0) {
        res.status(422).json({ error: "Queued follow-ups do not support new files yet" });
        return;
      }
      const item = await svc.createQueuedMessage({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        clientMutationId: `stream:${randomUUID()}`,
        expectedGenerationId: getActiveChatGeneration(conversation.id)?.generationId ?? null,
        payload: {
          body: parsedBody.data.body,
          attachmentIds: [],
          skillRefs: [],
          projectId: null,
          accessMode: null,
          model: null,
          effort: null,
          metadata: {
            source: "stream_endpoint_during_active_generation",
          },
        },
      });
      res.status(202);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.write(`${JSON.stringify({ type: "queued", item })}\n`);
      res.end();
      return;
    }
    if (queuedMessageId) {
      try {
        await svc.assertQueuedMessageClaimedForDelivery({
          conversationId: conversation.id,
          itemId: queuedMessageId,
          body: parsedBody.data.body,
        });
      } catch (error) {
        releaseGeneration();
        throw error;
      }
    }

    let generation: { id: string } | null = null;
    try {
      const createdGeneration = await svc.createGeneration(conversation.orgId, conversation.id);
      generation = createdGeneration;
      setActiveChatGenerationId(conversation.id, createdGeneration.id);
    } catch (error) {
      releaseGeneration();
      throw error;
    }

    let assistantConversationForPartial: ChatConversation | null = null;
    let turnContextForPartial: ReturnType<typeof turnContextFromUserMessage> | null = null;
    const transcript: TranscriptEntry[] = [];
    let assistantProgressMessage: ChatMessage | null = null;
    let assistantProgressMessageId: string | null = null;
    let activeChatRunId: string | null = null;
    let generationTerminalStatus: "completed" | "failed" | "stopped" | "aborted" = "failed";
    let assistantDraftBody = "";
    let admittedAssistantBody = "";
    const admittedTranscript: TranscriptEntry[] = [];
    let stopCutoff: { body: string; transcript: TranscriptEntry[] } | null = null;
    const freezeStopCutoff = () => {
      if (stopCutoff) return;
      stopCutoff = {
        body: admittedAssistantBody,
        transcript: [...admittedTranscript],
      };
    };
    abortController.signal.addEventListener("abort", freezeStopCutoff, { once: true });
    const persistStreamProgress = async (
      progressConversation: ChatConversation,
      replyingAgentId = chatReplyingAgentId(progressConversation),
      snapshot = { body: assistantDraftBody, transcript: [...transcript] },
    ) => {
      if (!turnContextForPartial) return null;
      const input = {
        kind: "message" as const,
        status: "streaming" as const,
        body: snapshot.body,
        transcript: snapshot.transcript,
        runId: activeChatRunId ?? undefined,
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
        body: snapshot.body,
        transcript: snapshot.transcript,
        runId: activeChatRunId ?? null,
        replyingAgentId,
        chatTurnId: turnContextForPartial.chatTurnId,
        turnVariant: turnContextForPartial.turnVariant,
      }) as ChatMessage;
      assistantProgressMessageId = assistantProgressMessage.id;
      return assistantProgressMessage;
    };
    const stoppedState = (fallbackBody: string) => {
      if (!stopCutoff) {
        return { body: fallbackBody, transcript: [...transcript] };
      }
      const accumulator = createAssistantTextAccumulator();
      for (const entry of stopCutoff.transcript) {
        if (entry.kind === "assistant") {
          accumulator.push(entry.text, entry.delta === true);
        }
      }
      return {
        body: stopCutoff.body.trim() ? stopCutoff.body : accumulator.fullText,
        transcript: stopCutoff.transcript,
      };
    };
    let stoppedPersistencePromise: Promise<ChatMessage | null> | null = null;
    const persistStoppedAssistant = (
      stoppedConversation: ChatConversation,
      replyingAgentId: string | null,
      fallbackBody: string,
    ): Promise<ChatMessage | null> => {
      if (stoppedPersistencePromise) return stoppedPersistencePromise;
      generationTerminalStatus = "stopped";
      stoppedPersistencePromise = (async () => {
        const frozen = stoppedState(fallbackBody);
        const stoppedBody = frozen.body.trim()
          ? frozen.body
          : (assistantProgressMessageId ? CHAT_ASSISTANT_STOPPED_FALLBACK_MESSAGE : "");
        const stoppedMessage = await persistPartialAssistantMessage(
          stoppedConversation,
          stoppedBody,
          "stopped",
          turnContextForPartial,
          frozen.transcript,
          replyingAgentId,
          assistantProgressMessageId,
          activeChatRunId,
        );
        await linkChatRunMessages(stoppedConversation, activeChatRunId, stoppedMessage ? [stoppedMessage] : []);
        if (stoppedMessage) {
          await logChatMessagesAdded(stoppedConversation, [stoppedMessage], {
            actorType: "system",
            actorId: "chat-assistant",
            agentId: replyingAgentId,
          });
        }
        if (!clientClosed) {
          writeStreamEvent(res, {
            type: "final",
            messages: stoppedMessage ? [stoppedMessage] : [],
          });
          res.end();
        }
        return stoppedMessage;
      })();
      return stoppedPersistencePromise;
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
      if (queuedMessageId) {
        await svc.markQueuedMessageRunning({
          conversationId: conversation.id,
          itemId: queuedMessageId,
          sourceMessageId: userMessage.id,
        });
      }
      if (!parsedBody.data.editUserMessageId) {
        startChatTitleGeneration(conversation as ChatConversation, userMessage);
      }
      const userAttachments = await attachFilesToUserMessage(
        conversation as ChatConversation,
        userMessage.id,
        messageFiles,
        actor,
      );
      const mergedUserAttachmentsById = new Map<string, ChatAttachment>();
      for (const attachment of userMessage.attachments ?? []) {
        mergedUserAttachmentsById.set(attachment.id, attachment);
      }
      for (const attachment of userAttachments) {
        mergedUserAttachmentsById.set(attachment.id, attachment);
      }
      const mergedUserAttachments = [...mergedUserAttachmentsById.values()];
      const hydratedUserMessage = {
        ...userMessage,
        attachments: mergedUserAttachments,
      } as ChatMessage;
      turnContextForPartial = turnContextFromUserMessage(userMessage);
      writeStreamEvent(res, {
        type: "ack",
        userMessage: hydratedUserMessage,
      });

      {
          const assistantInput = await loadAssistantInput(conversation as ChatConversation, actor);
          assistantConversationForPartial = assistantInput.conversation;
          try {
            const streamed = await assistantSvc.streamChatAssistantReply({
              ...assistantInput,
              userMessageId: userMessage.id,
              chatTurnId: turnContextForPartial.chatTurnId,
              turnVariant: turnContextForPartial.turnVariant,
              stream: true,
              onRunCreated: (runId: string) => {
                activeChatRunId = runId;
              },
              abortSignal: abortController.signal,
              onAssistantDelta: async (delta: string) => {
                if (abortController.signal.aborted) return;
                assistantDraftBody = `${assistantDraftBody}${delta}`;
                await persistStreamProgress(assistantInput.conversation, undefined, {
                  body: assistantDraftBody,
                  transcript: [...transcript],
                });
                if (abortController.signal.aborted || clientClosed) return;
                if (writeStreamEvent(res, {
                  type: "assistant_delta",
                  delta,
                })) {
                  admittedAssistantBody = `${admittedAssistantBody}${delta}`;
                }
              },
              onAssistantState: async (state: unknown) => {
                if (abortController.signal.aborted) return;
                await persistStreamProgress(assistantInput.conversation, undefined, {
                  body: assistantDraftBody,
                  transcript: [...transcript],
                });
                if (abortController.signal.aborted || clientClosed) return;
                writeStreamEvent(res, {
                  type: "assistant_state",
                  state,
                });
              },
              onTranscriptEntry: async (entry: TranscriptEntry) => {
                if (abortController.signal.aborted) return;
                transcript.push(entry);
                await persistStreamProgress(assistantInput.conversation, undefined, {
                  body: assistantDraftBody,
                  transcript: [...transcript],
                });
                if (abortController.signal.aborted || clientClosed) return;
                if (writeStreamEvent(res, {
                  type: "transcript_entry",
                  entry,
                })) {
                  admittedTranscript.push(entry);
                }
              },
            });

            if (abortController.signal.aborted || streamed.outcome === "stopped") {
              await persistStoppedAssistant(
                assistantInput.conversation,
                streamed.replyingAgentId,
                streamed.partialBody,
              );
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
              activeChatRunId,
            );
            await linkChatRunMessages(assistantInput.conversation, activeChatRunId, createdMessages);
            generationTerminalStatus = "completed";
            await logChatMessagesAdded(assistantInput.conversation, createdMessages, {
              actorType: "system",
              actorId: "chat-assistant",
              agentId: streamed.replyingAgentId,
            });
            if (!clientClosed) {
              writeStreamEvent(res, {
                type: "final",
                messages: createdMessages,
              });
              res.end();
            }
          } catch (error) {
            if (!abortController.signal.aborted) {
              generationTerminalStatus = "failed";
            }
            throw error;
          }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        try {
          if (stoppedPersistencePromise) {
            await stoppedPersistencePromise;
          } else {
            await persistStoppedAssistant(
              assistantConversationForPartial ?? (conversation as ChatConversation),
              chatReplyingAgentId(assistantConversationForPartial ?? (conversation as ChatConversation)),
              "",
            );
          }
        } catch (stopPersistenceError) {
          logger.warn(
            { err: stopPersistenceError, conversationId: conversation.id },
            "failed to persist stopped chat assistant message",
          );
          if (!clientClosed && !res.writableEnded) res.end();
        }
        return;
      }
      const failurePayload = recoverableFailurePayload(err, activeChatRunId);
      const partialBody =
        userVisiblePartialBodyFromError(err)
        || recoverableFailureBody(failurePayload)
        || CHAT_ASSISTANT_USER_ERROR_MESSAGE;
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
        activeChatRunId,
        failurePayload,
      ).catch(() => null);
      await linkChatRunMessages(
        assistantConversationForPartial ?? (conversation as ChatConversation),
        activeChatRunId,
        failedMessage ? [failedMessage as ChatMessage] : [],
      ).catch(() => {});
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

      logger.warn({ err, conversationId: conversation.id }, "chat assistant stream failed");
      if (!clientClosed) {
        const recoverableError = err instanceof ChatAssistantStreamError ? err : null;
        writeStreamEvent(res, {
          type: "error",
          error: recoverableError?.userMessage ?? (
            recoverableError ? CHAT_ASSISTANT_RECOVERABLE_FAILURE_FALLBACK_MESSAGE : CHAT_ASSISTANT_USER_ERROR_MESSAGE
          ),
          errorCode: recoverableError?.errorCode ?? "chat_runtime_exception",
          runId: activeChatRunId,
          messageId: failedMessage?.id ?? null,
        });
        res.end();
      }
    } finally {
      abortController.signal.removeEventListener("abort", freezeStopCutoff);
      req.off("aborted", handleClosed);
      res.off("close", handleClosed);
      if (generation) {
        await svc.markGenerationTerminal(generation.id, generationTerminalStatus).catch((error: unknown) => {
          logger.warn({ err: error, generationId: generation?.id }, "failed to mark chat generation terminal");
        });
      }
      if (queuedMessageId) {
        await svc.markQueuedMessageDeliveryTerminal({
          conversationId: conversation.id,
          itemId: queuedMessageId,
          status: generationTerminalStatus,
        }).catch((error: unknown) => {
          logger.warn({ err: error, queuedMessageId }, "failed to mark queued chat message terminal");
        });
      }
      releaseGeneration();
    }
  });

  router.post("/chats/:id/messages/stream/stop", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);

    const active = getActiveChatGeneration(conversation.id);
    const latestActiveGeneration = active?.generationId
      ? null
      : await svc.getLatestActiveGeneration(conversation.id);
    const stopped = cancelActiveChatGeneration(conversation.id);
    const generationId = active?.generationId ?? latestActiveGeneration?.id ?? null;
    if (stopped || generationId) {
      await svc.markGenerationTerminal(generationId, "stopped");
    }
    res.json({ stopped: stopped || Boolean(generationId) });
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
    assertChatLocalMutationAllowed(conversation as ChatConversation);

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
    assertChatLocalMutationAllowed(conversation as ChatConversation);
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
    assertChatLocalMutationAllowed(conversation as ChatConversation);
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
    assertChatLocalMutationAllowed(conversation as ChatConversation);
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
    const issue = await svc.convertToIssue(conversation.id, {
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
      messageId: req.body.messageId ?? null,
      proposal: req.body.proposal ?? null,
    });
    await wakeIssueAssigneeAfterChatConversion({
      db,
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "chat_convert",
      contextSource: "chat.convert_to_issue",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
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
    res.status(201).json({ issue, systemMessage });
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
      assertChatLocalMutationAllowed(conversation as ChatConversation);

      const actor = getActorInfo(req);
      const messageId = req.params.messageId as string;
      const resolved = await svc.resolveOperationProposal(conversation.id, messageId, {
        action: req.body.action,
        actorUserId: actor.actorType === "user" ? actor.actorId : null,
        decisionNote: req.body.decisionNote ?? null,
      });
      res.status(201).json(resolved);
    },
  );

  router.post("/chats/:id/resolve", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
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
