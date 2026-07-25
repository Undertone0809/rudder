import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import {
  addChatMessageSchema,
  chatClientCheckpointSchema,
  convertChatToIssueSchema,
  createChatAttachmentMetadataSchema,
  createChatContextLinkSchema,
  createChatFirstTurnSchema,
  resolveChatOperationProposalSchema,
  setChatProjectContextSchema,
  stopChatGenerationSchema,
  type ChatConversation,
  type ChatMessage,
  type ChatStreamTranscriptEntry,
} from "@rudderhq/shared";
import {
  coalesceChatTranscriptTextEntries,
  withChatTranscriptGenerationProvenance,
} from "@rudderhq/shared/chat-transcript-provenance";
import type { Request } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { chatAssistantErrorForLog } from "../services/chat-assistant.helpers.js";
import {
  CHAT_ASSISTANT_USER_ERROR_MESSAGE,
  ChatAssistantStreamError,
  userVisiblePartialBodyFromError
} from "../services/chat-assistant.js";
import {
  cancelActiveChatGeneration,
  claimChatGeneration,
  createChatRuntimeControlCoordinator,
  getActiveChatGeneration,
  setActiveChatGenerationId,
} from "../services/chat-generation-locks.js";
import { hashChatGenerationBody } from "../services/chat-generation-protocol.js";
import { logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { wakeIssueAssigneeAfterChatConversion } from "./chat-issue-assignment-wakeup.js";
import { chatRuntimeSnapshot } from "./chats.runtime-controls.js";
import {
  CHAT_ASSISTANT_RECOVERABLE_FAILURE_FALLBACK_MESSAGE,
  CHAT_ASSISTANT_STOPPED_FALLBACK_MESSAGE,
  createChatStreamFileStaging,
  createStartingChatGenerationGate,
  normalizeMultipartFirstTurnBody,
  normalizeMultipartMessageBody,
  outputAdmissionClosed,
  resolveStoppedAssistantState,
  startingChatGenerationGates,
  withMergedChatMessageAttachments,
  type AtomicChatFirstTurn,
  type ChatStreamRouteContext,
} from "./chats.stream-support.js";
import { registerChatUserStateRoutes } from "./chats.user-state-routes.js";

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
    heartbeat,
    assertConversationAccess,
    assertChatLocalMutationAllowed,
    assertSideChatMutationAllowed,
    touchSideChat,
    boardUserId,
    assertCanAssignTasks,
    runSingleFileUpload,
    runMessageFileUpload,
    isMultipartRequest,
    uploadedMessageFiles,
    validateUploadedMessageFiles,
    preflightChatDraft,
    logChatMessagesAdded,
    assertContextLinksBelongToCompany,
    turnContextFromUserMessage,
    addUserMessage,
    inlineAnnotations,
    storeUserMessageFiles,
    cleanupStoredUserMessageFiles,
    storeQueuedAnnotationFiles,
    cleanupUncommittedQueuedAnnotationFiles,
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
    queueRequestActor,
    wakeServerQueue,
    wakeTerminalProjector,
  } = ctx;
  const handleChatMessageStream = async (req: Request, res: any) => {
    const atomicFirstTurn = (req as any).atomicFirstTurn as AtomicChatFirstTurn | undefined;
    if (isMultipartRequest(req) && !atomicFirstTurn?.uploadPrepared) {
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

    const normalizedBody = isMultipartRequest(req)
      ? normalizeMultipartMessageBody(req.body as Record<string, unknown> | undefined)
      : (req.body ?? {});
    const inlineAnnotationsProvided = Object.hasOwn(
      normalizedBody,
      "inlineAnnotations",
    );
    const parsedBody = addChatMessageSchema.safeParse(normalizedBody);
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

    const conversation = atomicFirstTurn?.conversation
      ?? await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);

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
    if (queuedMessageId) {
      res.status(409).json({
        error: "Queued messages are delivered only by Rudder's server-owned Queue worker",
      });
      return;
    }
    const preparedAnnotations = !atomicFirstTurn && inlineAnnotationsProvided
      ? await inlineAnnotations.prepare({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        annotations: parsedBody.data.inlineAnnotations ?? [],
        uploadedFileCount: messageFiles.length,
        editUserMessageId: parsedBody.data.editUserMessageId ?? null,
      })
      : null;
    let runtimeSnapshot = atomicFirstTurn?.runtimeSnapshot ?? null;
    if (!atomicFirstTurn) {
      const assistantAvailability = await assistantSvc.getChatAssistantAvailability(conversation as ChatConversation);
      if (!assistantAvailability.available) {
        res.status(503).json({ error: assistantAvailability.error });
        return;
      }
      runtimeSnapshot = chatRuntimeSnapshot(assistantAvailability);
    }
    if (!runtimeSnapshot) throw new Error("Chat runtime snapshot is unavailable");

    const abortController = new AbortController();
    const releaseGeneration = claimChatGeneration(conversation.id, abortController, null);
    if (!releaseGeneration) {
      if (parsedBody.data.editUserMessageId) {
        res.status(409).json({ error: "Stop the current response before editing this message" });
        return;
      }
      if (queuedMessageId) {
        res.status(409).json({ error: "A chat reply is already being generated for this conversation" });
        return;
      }
      const clientMutationId = `stream:${randomUUID()}`;
      const storedQueueFiles = await storeQueuedAnnotationFiles(
        conversation as ChatConversation,
        messageFiles,
      );
      let queuedResult;
      try {
        queuedResult = await svc.createQueuedMessageWithStagedAttachments({
          orgId: conversation.orgId,
          conversationId: conversation.id,
          clientMutationId,
          runtimeSnapshotVersion: 1,
          expectedGenerationId: getActiveChatGeneration(conversation.id)?.generationId ?? null,
          requestActor: queueRequestActor(req),
          payload: {
            body: parsedBody.data.body,
            attachmentIds: [],
            ...(inlineAnnotationsProvided
              ? { inlineAnnotations: preparedAnnotations?.annotations ?? [] }
              : {}),
            skillRefs: [],
            projectId: null,
            accessMode: null,
            model: runtimeSnapshot.model,
            effort: runtimeSnapshot.effort,
            metadata: {
              source: "stream_endpoint_during_active_generation",
            },
          },
          stagedAttachments: storedQueueFiles.map((attachment: Record<string, unknown>) => ({
            ...attachment,
            createdByAgentId: null,
            createdByUserId: actor.actorId,
          })),
          attachmentFileIndexesByAnnotationId:
            preparedAnnotations?.attachmentFileIndexesByAnnotationId ?? new Map(),
        });
      } catch (error) {
        await cleanupUncommittedQueuedAnnotationFiles(
          conversation.orgId,
          clientMutationId,
          storedQueueFiles,
        );
        throw error;
      }
      await cleanupUncommittedQueuedAnnotationFiles(
        conversation.orgId,
        clientMutationId,
        queuedResult.cleanupAttachments,
      );
      const item = queuedResult.item;
      await logActivity(db, {
        orgId: conversation.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "chat.queue.created",
        entityType: "chat",
        entityId: conversation.id,
        details: {
          queuedMessageId: item.id,
          position: item.position,
          annotationCount: item.annotationCount ?? 0,
          annotationSourceMessageIds: [
            ...new Set(
              (item.payload.inlineAnnotations ?? []).map(
                (annotation: { sourceMessageId: string }) => annotation.sourceMessageId,
              ),
            ),
          ],
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
    const stagedMessageFiles = createChatStreamFileStaging({
      conversation: conversation as ChatConversation,
      shouldStage: !atomicFirstTurn,
      files: messageFiles,
      store: storeUserMessageFiles,
      cleanup: cleanupStoredUserMessageFiles,
    });
    try {
      await stagedMessageFiles.stage();
    } catch (error) {
      releaseGeneration();
      throw error;
    }
    const startupGate = createStartingChatGenerationGate();
    startingChatGenerationGates.set(conversation.id, startupGate);
    if (queuedMessageId) {
      try {
        await svc.assertQueuedMessageClaimedForDelivery({
          conversationId: conversation.id,
          itemId: queuedMessageId,
          body: parsedBody.data.body,
        });
      } catch (error) {
        startupGate.resolveGeneration(null);
        startingChatGenerationGates.delete(conversation.id);
        releaseGeneration();
        await stagedMessageFiles.cleanup();
        throw error;
      }
    }

    let generation: { id: string; attemptEpoch?: number; controlVersion?: number } | null = null;
    try {
      const createdGeneration = await svc.createGeneration(conversation.orgId, conversation.id);
      generation = createdGeneration;
      setActiveChatGenerationId(conversation.id, createdGeneration.id);
      startupGate.resolveGeneration(createdGeneration.id);
    } catch (error) {
      startupGate.resolveGeneration(null);
      startingChatGenerationGates.delete(conversation.id);
      releaseGeneration();
      await stagedMessageFiles.cleanup();
      if (atomicFirstTurn) {
        const failurePayload = recoverableFailurePayload(error, null);
        const failureBody = recoverableFailureBody(failurePayload) || CHAT_ASSISTANT_RECOVERABLE_FAILURE_FALLBACK_MESSAGE;
        const failedMessage = await svc.addMessage(conversation.id, {
          orgId: conversation.orgId,
          role: "assistant",
          kind: "message",
          status: "failed",
          body: failureBody,
          structuredPayload: failurePayload,
          replyingAgentId: conversation.preferredAgentId,
          chatTurnId: atomicFirstTurn.userMessage.chatTurnId,
        });
        await logChatMessagesAdded(conversation, [failedMessage], {
          actorType: "system",
          actorId: "chat-assistant",
          agentId: conversation.preferredAgentId,
        });
        res.status(201);
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("X-Accel-Buffering", "no");
        writeStreamEvent(res, {
          type: "ack",
          conversation: atomicFirstTurn.conversation,
          userMessage: atomicFirstTurn.userMessage,
        });
        writeStreamEvent(res, {
          type: "error",
          error: failureBody,
          messageId: failedMessage.id,
        });
        res.end();
        return;
      }
      throw error;
    }
    if (abortController.signal.aborted && startupGate.stopRequested) {
      await startupGate.stopApplied;
    }

    let assistantConversationForPartial: ChatConversation | null = null;
    let turnContextForPartial: ReturnType<typeof turnContextFromUserMessage> | null = null;
    const transcript: TranscriptEntry[] = [];
    let assistantProgressMessageId: string | null = null;
    let activeChatRunId: string | null = null;
    let userMessagePersisted = Boolean(atomicFirstTurn);
    let committedUserMessageId = atomicFirstTurn?.userMessage.id ?? null;
    let generationTerminalStatus: "completed" | "failed" | "stopped" | "aborted" = "failed";
    let admittedAssistantBody = "";
    let stopCutoff: { body: string; transcript: TranscriptEntry[] } | null = null;
    let outputAdmissionTail: Promise<void> = Promise.resolve();
    const serializeOutputAdmission = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = outputAdmissionTail.then(operation, operation);
      outputAdmissionTail = result.then(() => undefined, () => undefined);
      return result;
    };
    const freezeStopCutoff = () => {
      if (stopCutoff) return;
      stopCutoff = {
        body: admittedAssistantBody,
        transcript: [...transcript],
      };
    };
    abortController.signal.addEventListener("abort", freezeStopCutoff, { once: true });
    const stoppedState = (fallbackBody: string) => resolveStoppedAssistantState({
      stopCutoff,
      admittedAssistantBody,
      transcript,
      fallbackBody,
    });
    let stoppedPersistencePromise: Promise<ChatMessage | null> | null = null;
    const persistStoppedAssistant = (
      stoppedConversation: ChatConversation,
      replyingAgentId: string | null,
      fallbackBody: string,
    ): Promise<ChatMessage | null> => {
      if (stoppedPersistencePromise) return stoppedPersistencePromise;
      generationTerminalStatus = "stopped";
      stoppedPersistencePromise = (async () => {
        await outputAdmissionTail;
        let frozen = stoppedState(fallbackBody);
        if (generation) {
          const durableFrozen = await svc.generationProtocol.getFrozenVisibleProjection({
            orgId: conversation.orgId,
            conversationId: conversation.id,
            generationId: generation.id,
          }).catch(() => null);
          if (durableFrozen && durableFrozen.generation.acceptedThroughSeq !== null) {
            frozen = {
              body: durableFrozen.projection.body,
              transcript: durableFrozen.projection.transcript,
            };
          }
        }
        const stoppedBody = frozen.body.trim()
          ? frozen.body
          : (assistantProgressMessageId ? CHAT_ASSISTANT_STOPPED_FALLBACK_MESSAGE : "");
        let stoppedMessage: ChatMessage | null = null;
        let lastProjectionError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            stoppedMessage = await persistPartialAssistantMessage(
              stoppedConversation,
              stoppedBody,
              "stopped",
              turnContextForPartial,
              frozen.transcript,
              replyingAgentId,
              assistantProgressMessageId,
              activeChatRunId,
              undefined,
              false,
            );
            lastProjectionError = undefined;
            break;
          } catch (error) {
            lastProjectionError = error;
            logger.warn(
              { err: error, conversationId: stoppedConversation.id, attempt },
              "failed to project stopped chat assistant message",
            );
            await Promise.resolve();
          }
        }
        if (lastProjectionError) throw lastProjectionError;
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
      const userMessage = atomicFirstTurn?.userMessage ?? await addUserMessage(
        conversation as ChatConversation,
        parsedBody.data.body,
        actor,
        parsedBody.data.editUserMessageId ?? null,
        {
          provided: inlineAnnotationsProvided,
          prepared: preparedAnnotations,
          storedAttachments: stagedMessageFiles.files,
          onPersisted: (messageId: string) => {
            userMessagePersisted = true;
            committedUserMessageId = messageId;
            stagedMessageFiles.markCommitted();
          },
        },
      );
      userMessagePersisted = true;
      committedUserMessageId = userMessage.id;
      stagedMessageFiles.markCommitted();
      await touchSideChat(req, conversation as ChatConversation);
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
      const userAttachments = atomicFirstTurn
        ? await attachFilesToUserMessage(
          conversation as ChatConversation,
          userMessage.id,
          messageFiles,
          actor,
        )
        : [];
      const hydratedUserMessage = withMergedChatMessageAttachments(
        userMessage,
        userAttachments,
      );
      turnContextForPartial = turnContextFromUserMessage(userMessage);
      writeStreamEvent(res, {
        type: "ack",
        userMessage: hydratedUserMessage,
        ...(atomicFirstTurn ? { conversation: atomicFirstTurn.conversation } : {}),
        generationId: generation!.id,
        attemptEpoch: generation!.attemptEpoch ?? 1,
        generationSeq: 0,
        bodyHash: hashChatGenerationBody(""),
      });

      if (abortController.signal.aborted) {
        generationTerminalStatus = "stopped";
        if (!clientClosed) {
          writeStreamEvent(res, { type: "final", messages: [] });
          res.end();
        }
        return;
      }

      {
          const assistantInput = await loadAssistantInput(conversation as ChatConversation, actor);
          assistantConversationForPartial = assistantInput.conversation;
          try {
            const streamed = await assistantSvc.streamChatAssistantReply({
              ...assistantInput,
              modelSnapshot: runtimeSnapshot.model,
              effortSnapshot: runtimeSnapshot.effort,
              userMessageId: userMessage.id,
              chatTurnId: turnContextForPartial.chatTurnId,
              turnVariant: turnContextForPartial.turnVariant,
              stream: true,
              onRunCreated: (runId: string) => {
                activeChatRunId = runId;
              },
              abortSignal: abortController.signal,
              controlCoordinator: createChatRuntimeControlCoordinator(
                conversation.id,
                generation!.id,
                {
                  onAttemptStarted: async ({ generationId, attemptEpoch, ownerToken, attempt }) => {
                    await svc.beginGenerationControlAttempt({
                      orgId: conversation.orgId,
                      conversationId: conversation.id,
                      generationId,
                      attemptEpoch,
                      ownerToken,
                      runtimeType: attempt.runtimeType,
                    });
                  },
                  onHandleRegistered: async ({ generationId, attemptEpoch, ownerToken, handle }) => {
                    await svc.markGenerationControlReady({
                      generationId,
                      attemptEpoch,
                      ownerToken,
                      runtimeType: handle.runtimeType,
                      providerThreadId: handle.providerThreadId ?? null,
                      providerTurnId: handle.providerTurnId ?? null,
                    });
                  },
                  onAttemptLeaseRenewed: async ({ generationId, attemptEpoch, ownerToken }) => {
                    await svc.renewGenerationControlLease({ generationId, attemptEpoch, ownerToken });
                  },
                  onAttemptCompleted: async ({ generationId, attemptEpoch, ownerToken }) => {
                    await svc.markGenerationControlAttemptCompleted({
                      generationId,
                      attemptEpoch,
                      ownerToken,
                    });
                  },
                },
              ),
              onAssistantDelta: (delta: string) => serializeOutputAdmission(async () => {
                if (abortController.signal.aborted) return;
                const activeControl = getActiveChatGeneration(conversation.id);
                const attemptEpoch = Math.max(
                  1,
                  activeControl?.attemptEpoch ?? generation?.attemptEpoch ?? 1,
                );
                const projectedBody = `${admittedAssistantBody}${delta}`;
                let committed;
                try {
                  committed = await svc.generationProtocol.appendVisibleEventAndProject({
                    orgId: conversation.orgId,
                    conversationId: conversation.id,
                    generationId: generation!.id,
                    expectedAttemptEpoch: attemptEpoch,
                    eventKind: "assistant_delta",
                    payload: { delta },
                    bodyOffset: admittedAssistantBody.length,
                    bodyLength: delta.length,
                    messageId: assistantProgressMessageId,
                    runId: activeChatRunId,
                    bodyHash: hashChatGenerationBody(projectedBody),
                    body: projectedBody,
                    replyingAgentId: chatReplyingAgentId(assistantInput.conversation),
                    chatTurnId: turnContextForPartial!.chatTurnId,
                    turnVariant: turnContextForPartial!.turnVariant,
                  });
                } catch (error) {
                  if (outputAdmissionClosed(error)) return;
                  throw error;
                }
                assistantProgressMessageId = committed.message.id;
                admittedAssistantBody = projectedBody;
                if (abortController.signal.aborted || clientClosed) return;
                writeStreamEvent(res, {
                  type: "assistant_delta",
                  delta,
                  generationId: generation!.id,
                  attemptEpoch,
                  generationSeq: committed.event.generationSeq,
                  bodyHash: committed.event.payload.bodyHash,
                });
              }),
              onAssistantState: (state: unknown) => serializeOutputAdmission(async () => {
                if (abortController.signal.aborted) return;
                if (clientClosed) return;
                writeStreamEvent(res, {
                  type: "assistant_state",
                  state,
                });
              }),
              onTranscriptEntry: (entry: TranscriptEntry) => serializeOutputAdmission(async () => {
                if (abortController.signal.aborted) return;
                const activeControl = getActiveChatGeneration(conversation.id);
                const attemptEpoch = Math.max(
                  1,
                  activeControl?.attemptEpoch ?? generation?.attemptEpoch ?? 1,
                );
                let committed;
                try {
                  committed = await svc.generationProtocol.appendVisibleEventAndProject({
                    orgId: conversation.orgId,
                    conversationId: conversation.id,
                    generationId: generation!.id,
                    expectedAttemptEpoch: attemptEpoch,
                    eventKind: "transcript",
                    payload: { entry },
                    messageId: assistantProgressMessageId,
                    runId: activeChatRunId,
                    bodyHash: hashChatGenerationBody(admittedAssistantBody),
                    body: admittedAssistantBody,
                    replyingAgentId: chatReplyingAgentId(assistantInput.conversation),
                    chatTurnId: turnContextForPartial!.chatTurnId,
                    turnVariant: turnContextForPartial!.turnVariant,
                  });
                } catch (error) {
                  if (outputAdmissionClosed(error)) return;
                  throw error;
                }
                assistantProgressMessageId = committed.message.id;
                const durableEntry = withChatTranscriptGenerationProvenance(
                  entry as ChatStreamTranscriptEntry,
                  {
                    generationId: generation!.id,
                    generationSeq: committed.event.generationSeq,
                  },
                ) as TranscriptEntry;
                const normalizedTranscript = coalesceChatTranscriptTextEntries([
                  ...(transcript as ChatStreamTranscriptEntry[]),
                  durableEntry as ChatStreamTranscriptEntry,
                ]);
                transcript.splice(
                  0,
                  transcript.length,
                  ...(normalizedTranscript as TranscriptEntry[]),
                );
                if (abortController.signal.aborted || clientClosed) return;
                writeStreamEvent(res, {
                  type: "transcript_entry",
                  entry: durableEntry,
                  generationId: generation!.id,
                  attemptEpoch,
                  generationSeq: committed.event.generationSeq,
                  bodyHash: committed.event.payload.bodyHash,
                });
              }),
            });

            if (abortController.signal.aborted || streamed.outcome === "stopped") {
              await persistStoppedAssistant(
                assistantInput.conversation,
                streamed.replyingAgentId,
                streamed.partialBody,
              );
              return;
            }

            const resultAdmission = await serializeOutputAdmission(async () => {
              if (abortController.signal.aborted) return null;
              const activeControl = getActiveChatGeneration(conversation.id);
              const attemptEpoch = Math.max(
                1,
                activeControl?.attemptEpoch ?? generation?.attemptEpoch ?? 1,
              );
              try {
                const committed = await svc.generationProtocol.appendVisibleEventAndProject({
                  orgId: conversation.orgId,
                  conversationId: conversation.id,
                  generationId: generation!.id,
                  expectedAttemptEpoch: attemptEpoch,
                  eventKind: "runtime_output",
                  payload: {
                    resultKind: streamed.reply.kind,
                    body: streamed.reply.body,
                  },
                  bodyOffset: 0,
                  bodyLength: streamed.reply.body.length,
                  messageId: assistantProgressMessageId,
                  runId: activeChatRunId,
                  bodyHash: hashChatGenerationBody(streamed.reply.body),
                  body: streamed.reply.body,
                  replyingAgentId: streamed.replyingAgentId,
                  chatTurnId: turnContextForPartial!.chatTurnId,
                  turnVariant: turnContextForPartial!.turnVariant,
                });
                assistantProgressMessageId = committed.message.id;
                admittedAssistantBody = streamed.reply.body;
                return committed;
              } catch (error) {
                if (outputAdmissionClosed(error)) return null;
                throw error;
              }
            });
            if (!resultAdmission) {
              freezeStopCutoff();
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
              false,
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
                messages: createdMessages.map((message: ChatMessage) => (
                  message.role === "assistant"
                    ? { ...message, generationId: generation!.id }
                    : message
                )),
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
      if (!userMessagePersisted) {
        logger.warn({
          err: chatAssistantErrorForLog(err),
          conversationId: conversation.id,
        }, "chat user message persistence failed");
        if (!clientClosed) {
          writeStreamEvent(res, {
            type: "error",
            error: CHAT_ASSISTANT_USER_ERROR_MESSAGE,
            errorCode: "chat_runtime_exception",
            runId: null,
            messageId: null,
          });
          res.end();
        }
        return;
      }
      if (!turnContextForPartial && committedUserMessageId) {
        logger.warn({
          err: chatAssistantErrorForLog(err),
          conversationId: conversation.id,
          userMessageId: committedUserMessageId,
        }, "chat user message hydration failed after commit");
        if (!clientClosed) {
          writeStreamEvent(res, {
            type: "error",
            error: CHAT_ASSISTANT_USER_ERROR_MESSAGE,
            errorCode: "chat_runtime_exception",
            runId: null,
            messageId: committedUserMessageId,
          });
          res.end();
        }
        return;
      }
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
        false,
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

      logger.warn({
        err: chatAssistantErrorForLog(err),
        conversationId: conversation.id,
      }, "chat assistant stream failed");
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
      await stagedMessageFiles.cleanup();
      abortController.signal.removeEventListener("abort", freezeStopCutoff);
      req.off("aborted", handleClosed);
      res.off("close", handleClosed);
      if (generation) {
        await (async () => {
          const latestGeneration = await svc.getLatestGeneration(conversation.id);
          const expectedAttemptEpoch = latestGeneration?.attemptEpoch
            ?? generation?.attemptEpoch
            ?? 1;
          await svc.generationProtocol.recordRuntimeTerminal({
            orgId: conversation.orgId,
            conversationId: conversation.id,
            generationId: generation!.id,
            expectedAttemptEpoch,
            finalStatus: generationTerminalStatus,
            terminalReason: (generationTerminalStatus as string) === "stopped"
              ? "operator_stop"
              : generationTerminalStatus,
            payload: {
              assistantMessageId: assistantProgressMessageId,
              runId: activeChatRunId,
            },
          });
          wakeTerminalProjector();
        })().catch((error: unknown) => {
          logger.warn({ err: error, generationId: generation?.id }, "failed to record chat generation terminal evidence");
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
      if (startingChatGenerationGates.get(conversation.id) === startupGate) {
        startingChatGenerationGates.delete(conversation.id);
      }
      releaseGeneration();
      wakeServerQueue();
    }
  };

  router.post("/chats/:id/messages/stream", handleChatMessageStream);

  router.post("/orgs/:orgId/chats/messages/stream", async (req, res) => {
    let uploadPrepared = false;
    if (isMultipartRequest(req)) {
      try {
        await runMessageFileUpload(req, res);
        uploadPrepared = true;
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
    const parsed = createChatFirstTurnSchema.safeParse(
      isMultipartRequest(req)
        ? normalizeMultipartFirstTurnBody(req.body as Record<string, unknown> | undefined)
        : (req.body ?? {}),
    );
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid first chat message", details: parsed.error.issues });
      return;
    }
    const messageFiles = uploadedMessageFiles(req);
    const attachmentValidationError = validateUploadedMessageFiles(messageFiles);
    if (attachmentValidationError) {
      res.status(422).json({ error: attachmentValidationError });
      return;
    }
    const actor = getActorInfo(req);
    if (actor.actorType === "agent") {
      res.status(422).json({ error: "Agent-authored chat messages must use the non-stream message endpoint" });
      return;
    }
    const draft = await preflightChatDraft(req, res, parsed.data);
    if (!draft) return;
    if (!draft.availability.available) {
      res.status(503).json({ error: draft.availability.error });
      return;
    }
    const accepted = await svc.createWithInitialMessage(draft.orgId, {
      title: parsed.data.title,
      summary: parsed.data.summary ?? null,
      preferredAgentId: draft.preferredAgentId,
      modelOverride: draft.modelOverride,
      effortOverride: draft.effortOverride,
      issueCreationMode: parsed.data.issueCreationMode ?? draft.organization.defaultChatIssueCreationMode,
      planMode: parsed.data.planMode ?? false,
      createdByUserId: actor.actorId,
      contextLinks: draft.contextLinks,
      initialMessage: {
        role: "user",
        kind: "message",
        status: "completed",
        body: parsed.data.body,
      },
      activity: actor,
    });
    const conversation = await assistantSvc.enrichConversation(accepted.conversation) as ChatConversation;
    (req.params as Record<string, string>).id = conversation.id;
    (req as any).atomicFirstTurn = {
      conversation,
      userMessage: accepted.message,
      uploadPrepared,
      runtimeSnapshot: chatRuntimeSnapshot(draft.availability, draft.modelOverride),
    };
    await handleChatMessageStream(req, res);
  });

  router.post("/chats/:id/messages/stream/checkpoint", validate(chatClientCheckpointSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
    const checkpoint = await svc.generationProtocol.recordClientCheckpoint({
      orgId: conversation.orgId,
      conversationId: conversation.id,
      generationId: req.body.generationId,
      expectedAttemptEpoch: req.body.attemptEpoch,
      generationSeq: req.body.generationSeq,
      renderedBodyHash: req.body.renderedBodyHash,
    });
    res.json({
      generationId: checkpoint.generation.id,
      generationSeq: checkpoint.generation.lastClientCheckpointSeq,
      advanced: checkpoint.advanced,
    });
  });

  router.post("/chats/:id/messages/stream/stop", async (req, res) => {
    const parsed = stopChatGenerationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid chat Stop request", details: parsed.error.issues });
      return;
    }
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);

    const controlActionId = parsed.data.controlActionId ?? randomUUID();
    const startupGate = startingChatGenerationGates.get(conversation.id) ?? null;
    let startupStopRequested = false;
    let startupInterruptRequested = false;
    try {
      let active = getActiveChatGeneration(conversation.id);
      if (active && !active.generationId && startupGate) {
        startupStopRequested = true;
        startupGate.stopRequested = true;
        startupInterruptRequested = cancelActiveChatGeneration(conversation.id);
        const startupGenerationId = await startupGate.generationReady;
        active = startupGenerationId ? getActiveChatGeneration(conversation.id) : null;
        if (!startupGenerationId) {
          res.json({
            stopped: startupInterruptRequested,
            controlActionId,
            generationId: null,
            disposition: startupInterruptRequested ? "startup_cancelled" : "interrupted_unverified",
          });
          return;
        }
      }
      const latestActiveGeneration = active?.generationId
        ? null
        : await svc.getLatestActiveGeneration(conversation.id);
      const generationId = parsed.data.expectedGenerationId
        ?? active?.generationId
        ?? latestActiveGeneration?.id
        ?? null;
      if (!generationId) {
        res.json({
          stopped: false,
          controlActionId,
          generationId: null,
          disposition: "no_active_generation",
        });
        return;
      }

    let durableCheckpoint = await svc.generationProtocol.getLatestVisibleCheckpoint({
      orgId: conversation.orgId,
      conversationId: conversation.id,
      generationId,
    });
    if (durableCheckpoint.generation.runtimeTerminalAt && !parsed.data.controlActionId) {
      wakeTerminalProjector();
      res.json({
        stopped: false,
        controlActionId,
        generationId,
        disposition: "no_active_generation",
      });
      return;
    }
    const expectedAttemptEpoch = parsed.data.expectedAttemptEpoch
      ?? durableCheckpoint.generation.attemptEpoch;
    const requestedControlVersion = parsed.data.expectedControlVersion
      ?? durableCheckpoint.generation.controlVersion;
    const requestedRenderSeq = parsed.data.lastCommittedRenderSeq
      ?? durableCheckpoint.generationSeq;
    const requestedBodyHash = parsed.data.renderedBodyHash
      ?? durableCheckpoint.bodyHash;
    let stop: Awaited<ReturnType<typeof svc.generationProtocol.beginStopAction>> | null = null;
    for (let attempt = 0; attempt < 2 && !stop; attempt += 1) {
      try {
        stop = await svc.generationProtocol.beginStopAction({
          orgId: conversation.orgId,
          conversationId: conversation.id,
          controlActionId,
          expectedGenerationId: generationId,
          expectedAttemptEpoch,
          expectedControlVersion: requestedControlVersion,
          admissionControlVersion: attempt === 0
            ? requestedControlVersion
            : durableCheckpoint.generation.controlVersion,
          requestedRenderSeq,
          requestedBodyHash,
        });
      } catch (error) {
        const status = error && typeof error === "object" && "status" in error
          ? Number((error as { status?: unknown }).status)
          : null;
        if (attempt > 0 || status !== 409) throw error;
        durableCheckpoint = await svc.generationProtocol.getLatestVisibleCheckpoint({
          orgId: conversation.orgId,
          conversationId: conversation.id,
          generationId,
        });
        if (durableCheckpoint.generation.runtimeTerminalAt && !parsed.data.controlActionId) {
          wakeTerminalProjector();
          res.json({
            stopped: false,
            controlActionId,
            generationId,
            disposition: "no_active_generation",
          });
          return;
        }
        if (durableCheckpoint.generation.attemptEpoch !== expectedAttemptEpoch) throw error;
      }
    }
    if (!stop) throw new Error("Failed to establish the chat Stop cutoff");
    if (
      stop.idempotent
      && parsed.data.expectedControlVersion !== undefined
      && stop.action.expectedControlVersion !== parsed.data.expectedControlVersion
    ) {
      throw conflict("Control action id was already used for a different Stop request");
    }

    if (stop.outcome === "completion_committed") {
      res.json({
        stopped: false,
        controlActionId,
        generationId,
        disposition: "completion_committed",
      });
      return;
    }

    if (stop.outcome === "already_terminal") {
      const alreadyStopped = stop.generation.status === "stopped"
        || stop.action.localDisposition === "stopped";
      wakeTerminalProjector();
      res.json({
        stopped: alreadyStopped,
        controlActionId,
        generationId,
        disposition: alreadyStopped ? "stopped" : "no_active_generation",
        acceptedThroughSeq: stop.action.acceptedThroughSeq,
        frozenBodyHash: stop.action.frozenBodyHash,
      });
      return;
    }

    if (stop.outcome === "stop_in_progress" && !stop.generation.runtimeTerminalAt) {
      const localInterruptRequested = startupInterruptRequested || cancelActiveChatGeneration(conversation.id);
      res.json({
        stopped: Boolean(localInterruptRequested),
        controlActionId,
        generationId,
        disposition: "stopping",
        acceptedThroughSeq: stop.action.acceptedThroughSeq,
        frozenBodyHash: stop.action.frozenBodyHash,
      });
      return;
    }

    if (stop.idempotent && stop.generation.runtimeTerminalAt) {
      const terminalDisposition = stop.generation.status === "stopped"
        || stop.action.localDisposition === "stopped"
        ? "stopped"
        : "stopping";
      wakeTerminalProjector();
      res.json({
        stopped: true,
        controlActionId,
        generationId,
        disposition: terminalDisposition,
        acceptedThroughSeq: stop.action.acceptedThroughSeq,
        frozenBodyHash: stop.action.frozenBodyHash,
      });
      return;
    }

    const localInterruptRequested = startupInterruptRequested || cancelActiveChatGeneration(conversation.id);
    let disposition = "stopping";
    if (startupStopRequested) {
      await svc.generationProtocol.recordRuntimeTerminal({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        generationId,
        expectedAttemptEpoch: stop.generation.attemptEpoch,
        finalStatus: "stopped",
        terminalReason: "operator_stop",
        controlActionId,
      });
      wakeTerminalProjector();
    } else if (!localInterruptRequested) {
      disposition = "interrupted_unverified";
      await svc.generationProtocol.recordRuntimeTerminal({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        generationId,
        expectedAttemptEpoch: stop.generation.attemptEpoch,
        finalStatus: "interrupted_unverified",
        terminalReason: "stop_without_local_runtime_owner",
        controlActionId,
      });
      wakeTerminalProjector();
    }
    res.json({
      stopped: Boolean(localInterruptRequested),
      controlActionId,
      generationId,
      disposition,
      acceptedThroughSeq: stop.action.acceptedThroughSeq,
      frozenBodyHash: stop.action.frozenBodyHash,
    });
    } finally {
      if (startupStopRequested) startupGate?.resolveStopApplied();
    }
  });

  router.post("/orgs/:orgId/chats/:chatId/attachments", async (req, res) => {
    const orgId = req.params.orgId as string;
    const chatId = req.params.chatId as string;
    assertCompanyAccess(req, orgId);

    const conversation = await assertConversationAccess(req, chatId);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    if (conversation.orgId !== orgId) {
      res.status(422).json({ error: "Chat conversation does not belong to organization" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);

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
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
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
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
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
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
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
      await assertSideChatMutationAllowed(req, conversation as ChatConversation);

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
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
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

  registerChatUserStateRoutes(ctx);
}
