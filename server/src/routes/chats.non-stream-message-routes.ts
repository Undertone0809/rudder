import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import {
  addChatMessageSchema,
  type ChatConversation,
  type ChatMessage,
} from "@rudderhq/shared";
import { randomUUID } from "node:crypto";
import { conflict, HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import {
  CHAT_ASSISTANT_USER_ERROR_MESSAGE,
  chatAssistantErrorForLog,
  ChatAssistantStreamError,
  userVisiblePartialBodyFromError,
  type chatAssistantService,
} from "../services/chat-assistant.js";
import { claimChatGeneration, getActiveChatGeneration, setActiveChatGenerationId } from "../services/chat-generation-locks.js";
import type { chatInlineAnnotationService } from "../services/chat-inline-annotations.js";
import { chatMessageMutationFingerprint, replayChatMessageMutation } from "../services/chat-message-mutation-fingerprint.js";
import {
  chatRuntimeSensitiveInputBroker,
  type ChatRuntimeSensitiveInputRequest,
} from "../services/chat-runtime-sensitive-input.js";
import type { chatService } from "../services/chats.js";
import type { sideChatService } from "../services/side-chats.js";
import { getActorInfo } from "./authz.js";
import { admitNonStreamChatSideChatFirstInput } from "./chats.non-stream-first-input.js";
import { chatRuntimeInvocationSnapshot, chatRuntimeSnapshot } from "./chats.runtime-controls.js";
import type { ChatStreamRouteContext } from "./chats.stream-support.js";

type ChatNonStreamMessageRouteContext = ChatStreamRouteContext & {
  svc: ReturnType<typeof chatService>;
  assistantSvc: ReturnType<typeof chatAssistantService>;
  sideChats: ReturnType<typeof sideChatService>;
  inlineAnnotations: ReturnType<typeof chatInlineAnnotationService>;
};

export function registerChatNonStreamMessageRoutes(ctx: ChatNonStreamMessageRouteContext) {
  const {
    router,
    svc,
    assistantSvc,
    assertConversationAccess,
    assertChatLocalMutationAllowed,
    assertChatEditSourceSubmissionResolved,
    assertSideChatMutationAllowed,
    addAgentAuthoredMessage,
    inlineAnnotations,
    sideChats,
    boardUserId,
    recoverSideChatFirstInputActivity,
    addUserMessage,
    queueRequestActor,
    wakeServerQueue,
    touchSideChat,
    startChatTitleGeneration,
    turnContextFromUserMessage,
    loadAssistantInput,
    persistAssistantReply,
    linkChatRunMessages,
    logChatMessagesAdded,
    chatReplyingAgentId,
    recoverableFailurePayload,
    recoverableFailureBody,
    persistPartialAssistantMessage,
  } = ctx;

  router.post(
    "/chats/:id/messages",
    (req, res, next) => {
      res.locals.inlineAnnotationsProvided = Object.hasOwn(
        req.body ?? {},
        "inlineAnnotations",
      );
      next();
    },
    validate(addChatMessageSchema),
    async (req, res) => {
      const conversation = await assertConversationAccess(req, req.params.id as string);
      if (!conversation) {
        res.status(404).json({ error: "Chat conversation not found" });
        return;
      }

      const actor = getActorInfo(req);
      assertChatLocalMutationAllowed(conversation as ChatConversation);
      await assertSideChatMutationAllowed(req, conversation as ChatConversation);
      if (actor.actorType === "agent") {
        if (!req.body.body.trim()) {
          res.status(422).json({ error: "Agent-authored chat messages require a nonempty body" });
          return;
        }
        if (res.locals.inlineAnnotationsProvided === true) {
          res.status(422).json({ error: "Agent-authored chat messages cannot include response annotations" });
          return;
        }
        if (req.body.editUserMessageId) {
          res.status(422).json({ error: "Agent-authored chat messages cannot edit operator messages" });
          return;
        }
        const message = await addAgentAuthoredMessage(conversation as ChatConversation, req.body.body, actor);
        res.status(201).json({ messages: [message] });
        return;
      }

      const inlineAnnotationsProvided = res.locals.inlineAnnotationsProvided === true;
      const clientMutationFingerprint = req.body.clientMutationId
        ? chatMessageMutationFingerprint({ body: req.body.body, editUserMessageId: req.body.editUserMessageId ?? null, inlineAnnotationsProvided, inlineAnnotations: req.body.inlineAnnotations, modelOverride: req.body.modelOverride ?? null, effortOverride: req.body.effortOverride ?? null, files: [] })
        : null;
      const deferAcceptedSideChatFirstInputReplay = conversation.conversationKind === "side_chat"
        && await sideChats.hasAcceptedFirstInputMutation({
          orgId: conversation.orgId,
          conversationId: conversation.id,
          clientMutationId: req.body.clientMutationId ?? null,
        });
      const replayedUserMessage = deferAcceptedSideChatFirstInputReplay
        ? null
        : await replayChatMessageMutation(svc.getUserMessageMutationByClientMutationId, {
          orgId: conversation.orgId,
          conversationId: conversation.id,
          clientMutationId: req.body.clientMutationId,
          body: req.body.body,
          fingerprint: clientMutationFingerprint,
        });
      if (replayedUserMessage) {
        res.status(200).json({ messages: [replayedUserMessage] });
        return;
      }

      await assertChatEditSourceSubmissionResolved(
        conversation as ChatConversation,
        req.body.editUserMessageId ?? null,
        req.actor.type === "board" ? req.actor.userId ?? null : null,
      );

      const preparedAnnotations = inlineAnnotationsProvided && !deferAcceptedSideChatFirstInputReplay
        ? await inlineAnnotations.prepare({
          orgId: conversation.orgId,
          conversationId: conversation.id,
          annotations: req.body.inlineAnnotations ?? [],
          uploadedFileCount: 0,
          editUserMessageId: req.body.editUserMessageId ?? null,
          ...(req.body.inlineAnnotations?.some((annotation: { surface?: string }) => annotation.surface === "agent_run_transcript")
            ? { requesterUserId: req.actor.type === "board" ? req.actor.userId ?? null : null }
            : {}),
        })
        : null;
      const assistantAvailability = await assistantSvc.getChatAssistantAvailability(conversation as ChatConversation);
      if (!assistantAvailability.available) {
        res.status(503).json({ error: assistantAvailability.error });
        return;
      }

      const sideChatFirstInput = await admitNonStreamChatSideChatFirstInput({
        conversation: conversation as ChatConversation,
        request: req,
        actor,
        clientMutationId: req.body.clientMutationId ?? null,
        clientMutationFingerprint,
        body: req.body.body,
        editUserMessageId: req.body.editUserMessageId ?? null,
        inlineAnnotationsProvided,
        inlineAnnotations: req.body.inlineAnnotations,
        modelOverride: req.body.modelOverride ?? null,
        effortOverride: req.body.effortOverride ?? null,
        sideChats,
        boardUserId,
        getMessage: (conversationId, messageId) => svc.getMessage(conversationId, messageId),
        recoverSideChatFirstInputActivity,
      });

      const releaseGeneration = claimChatGeneration(conversation.id, null, null);
      if (!releaseGeneration) {
        if (sideChatFirstInput.replayed) {
          throw conflict("The accepted Side Chat first input is already executing", {
            code: "side_chat_first_input_in_progress",
          });
        }
        if (sideChatFirstInput.releaseClaim) {
          await sideChatFirstInput.releaseClaim();
          throw conflict("A Side Chat response is already being generated", {
            code: "side_chat_first_input_in_progress",
          });
        }
        if (req.body.editUserMessageId) {
          res.status(409).json({ error: "Stop the current response before editing this message" });
          return;
        }
        const item = await svc.createQueuedMessage({
          orgId: conversation.orgId,
          conversationId: conversation.id,
          clientMutationId: req.body.clientMutationId ?? `message:${randomUUID()}`,
          mutationFingerprint: clientMutationFingerprint ?? undefined,
          runtimeSnapshotVersion: 1,
          expectedGenerationId: getActiveChatGeneration(conversation.id)?.generationId ?? null,
          requestActor: queueRequestActor(req),
          payload: {
            body: req.body.body,
            attachmentIds: [],
            ...(inlineAnnotationsProvided
              ? { inlineAnnotations: preparedAnnotations?.annotations ?? [] }
              : {}),
            skillRefs: [],
            projectId: null,
            accessMode: null,
            ...chatRuntimeSnapshot(assistantAvailability),
            metadata: {
              source: "messages_endpoint_during_active_generation",
            },
          },
        });
        wakeServerQueue();
        res.status(202).json({ queued: item });
        return;
      }

      try {
        let userMessage: ChatMessage;
        if (sideChatFirstInput.replayed) {
          const acceptedMessage = sideChatFirstInput.userMessage;
          if (!acceptedMessage) {
            throw conflict("Accepted Side Chat first input is no longer readable", {
              code: "side_chat_first_input_readback_missing",
            });
          }
          userMessage = acceptedMessage;
        } else {
          const persistence = await addUserMessage(
            conversation as ChatConversation,
            req.body.body,
            actor,
            req.body.editUserMessageId ?? null,
            {
              provided: inlineAnnotationsProvided,
              prepared: preparedAnnotations,
              clientMutationId: req.body.clientMutationId ?? null,
              clientMutationFingerprint,
              sideChatFirstInputClaimToken: sideChatFirstInput.claimToken,
              sideChatFirstInputFingerprint: sideChatFirstInput.requestFingerprint,
            },
          );
          userMessage = persistence.message;
          if (!persistence.accepted) {
            res.status(200).json({ messages: [userMessage] });
            return;
          }
        }

        let firstInputGenerationId: string | null = null;
        if (sideChatFirstInput.claimToken || sideChatFirstInput.replayed) {
          const admission = await svc.ensureSideChatFirstInputGeneration({
            orgId: conversation.orgId,
            conversationId: conversation.id,
            userMessageId: userMessage.id,
          });
          firstInputGenerationId = admission.generation.id;
          setActiveChatGenerationId(conversation.id, firstInputGenerationId);
          if (admission.executionAdmitted) {
            res.status(200).json({ messages: [userMessage] });
            return;
          }
        }

        await touchSideChat(req, conversation as ChatConversation);
        if (!sideChatFirstInput.replayed && !req.body.editUserMessageId) {
          startChatTitleGeneration(conversation as ChatConversation, userMessage);
        }
        const turnContext = turnContextFromUserMessage(userMessage);
        let activeChatRunId: string | null = null;
        let networkWaiting = false;
        const persistedAssistantMessages = await (async () => {
          const assistantInput = await loadAssistantInput(conversation as ChatConversation, actor);
          const transcript: TranscriptEntry[] = [];
          let persistTranscript = true;
          let fallbackOutput: string | null = null;
          try {
            const streamed = await assistantSvc.streamChatAssistantReply({
              ...assistantInput,
              ...chatRuntimeInvocationSnapshot(assistantAvailability),
              userMessageId: userMessage.id,
              chatTurnId: turnContext.chatTurnId,
              turnVariant: turnContext.turnVariant,
              runContext: {
                chatMode: "non_stream",
                ...(firstInputGenerationId ? { chatGenerationId: firstInputGenerationId } : {}),
              },
              stream: false,
              onRunCreated: (runId) => {
                activeChatRunId = runId;
              },
              requestRuntimeSensitiveInput: (input: ChatRuntimeSensitiveInputRequest) => {
                const { binding, kind, signal } = input;
                return chatRuntimeSensitiveInputBroker.request({
                  binding: {
                    ...binding,
                    principalId: `${actor.actorType}:${actor.actorId}`,
                  },
                  kind,
                  ...(signal ? { signal } : {}),
                  onRequest: () => undefined,
                }).result;
              },
              onTranscriptEntry: async (entry, delivery) => {
                if (activeChatRunId || delivery?.runId) persistTranscript = false;
                transcript.push(entry);
              },
            });
            if (streamed.outcome === "waiting_for_network") {
              networkWaiting = true;
              return [];
            }
            if (streamed.outcome !== "completed") {
              throw new Error("Chat assistant reply was stopped before completion");
            }
            const created = await persistAssistantReply(
              req,
              assistantInput.conversation,
              actor,
              streamed.reply,
              turnContext,
              transcript,
              streamed.replyingAgentId,
              null,
              activeChatRunId,
              persistTranscript,
            );
            await linkChatRunMessages(assistantInput.conversation, activeChatRunId, created);
            await logChatMessagesAdded(assistantInput.conversation, created, {
              actorType: "system",
              actorId: "chat-assistant",
              agentId: streamed.replyingAgentId,
            });
            return created;
          } catch (error) {
            const failurePayload = recoverableFailurePayload(error, activeChatRunId);
            if (error instanceof ChatAssistantStreamError || failurePayload) {
              fallbackOutput = userVisiblePartialBodyFromError(error);
              const failureBody = fallbackOutput || recoverableFailureBody(failurePayload) || CHAT_ASSISTANT_USER_ERROR_MESSAGE;
              const failedMessage = await persistPartialAssistantMessage(
                assistantInput.conversation,
                failureBody,
                "failed",
                turnContext,
                transcript,
                chatReplyingAgentId(assistantInput.conversation),
                null,
                activeChatRunId,
                failurePayload,
                persistTranscript,
              );
              const failedMessages = failedMessage ? [failedMessage as ChatMessage] : [];
              await linkChatRunMessages(assistantInput.conversation, activeChatRunId, failedMessages);
              if (failedMessages.length > 0) {
                await logChatMessagesAdded(assistantInput.conversation, failedMessages, {
                  actorType: "system",
                  actorId: "chat-assistant",
                  agentId: chatReplyingAgentId(assistantInput.conversation),
                });
              }
              fallbackOutput = failureBody;
              return failedMessages;
            }
            throw error;
          }
        })();
        const createdMessages: ChatMessage[] = [userMessage, ...persistedAssistantMessages];
        res.status(networkWaiting ? 202 : 201).json({
          messages: createdMessages,
          ...(networkWaiting ? { waitingForNetwork: true, runId: activeChatRunId } : {}),
        });
      } catch (err) {
        logger.warn({
          err: chatAssistantErrorForLog(err),
          conversationId: conversation.id,
        }, "chat assistant reply failed");
        if (err instanceof HttpError) {
          throw err;
        }
        res.status(502).json({
          error: CHAT_ASSISTANT_USER_ERROR_MESSAGE,
        });
      } finally {
        releaseGeneration();
        if (sideChatFirstInput.releaseClaim) {
          await sideChatFirstInput.releaseClaim();
        }
      }
    },
  );
}
