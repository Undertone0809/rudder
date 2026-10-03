import type { ChatConversation, ChatMessage } from "@rudderhq/shared";
import type { Response } from "express";
import { logger } from "../middleware/logger.js";
import { chatAssistantErrorForLog } from "../services/chat-assistant.helpers.js";
import { CHAT_ASSISTANT_USER_ERROR_MESSAGE } from "../services/chat-assistant.js";
import { CHAT_PRE_GENERATION_FAILURE_MESSAGE, chatPreGenerationFailurePayload } from "../services/chat-pre-generation-failure.js";
import type { getActorInfo } from "./authz.js";
import type { ChatStreamRouteContext, persistChatStreamUserMessageBeforeGeneration } from "./chats.stream-support.js";

export async function respondToChatPreGenerationPersistenceFailure(input: Pick<
  ChatStreamRouteContext,
  "sideChats" | "svc" | "logChatMessagesAdded" | "releaseGeneration" | "writeStreamEvent"
> & {
  conversation: ChatConversation;
  actor: ReturnType<typeof getActorInfo>;
  sideChatFirstInputClaimToken: string | null;
  messagePersistence: Extract<Awaited<ReturnType<typeof persistChatStreamUserMessageBeforeGeneration>>, { kind: "error" }>;
  clientMutationId: string | null;
  clientMutationFingerprint: string | null;
  parsedBody: { data: { body: string } };
  res: Response;
}) {
  const { sideChatFirstInputClaimToken, sideChats, conversation, messagePersistence,
    clientMutationId, actor, svc, parsedBody, clientMutationFingerprint,
    logChatMessagesAdded, releaseGeneration, res, writeStreamEvent } = input;
  if (sideChatFirstInputClaimToken) {
    try {
      await sideChats.releaseFirstInputClaim({
        conversationId: conversation.id,
        claimToken: sideChatFirstInputClaimToken,
      });
    } catch (error) {
      logger.warn({
        err: chatAssistantErrorForLog(error),
        conversationId: conversation.id,
      }, "could not release Side Chat first-input claim after persistence failure");
    }
  }
  logger.warn({ err: chatAssistantErrorForLog(messagePersistence.error), conversationId: conversation.id }, "chat user-message persistence failed before generation");
  let confirmedUserMessage: ChatMessage | null = null;
  if (
    messagePersistence.messageId
    && clientMutationId
    && actor.actorType === "user"
    && actor.actorId
  ) {
    try {
      const persisted = await svc.getMessage(conversation.id, messagePersistence.messageId) as ChatMessage | null;
      if (
        persisted
        && persisted.orgId === conversation.orgId
        && persisted.conversationId === conversation.id
        && persisted.id === messagePersistence.messageId
        && persisted.role === "user"
        && persisted.kind === "message"
        && persisted.status === "completed"
        && persisted.body === parsedBody.data.body
        && persisted.chatTurnId
        && Number.isInteger(persisted.turnVariant)
        && !persisted.supersededAt
      ) {
        const [mutation, messages] = await Promise.all([
          svc.getUserMessageMutationByClientMutationId(
            conversation.orgId,
            conversation.id,
            clientMutationId,
          ),
          svc.listMessages(conversation.id, { includeTranscript: false }) as Promise<ChatMessage[]>,
        ]);
        const currentUserVariants = (messages ?? []).filter((message: ChatMessage) => (
          message.role === "user"
          && message.kind === "message"
          && message.orgId === conversation.orgId
          && message.conversationId === conversation.id
          && message.chatTurnId === persisted.chatTurnId
          && !message.supersededAt
        ));
        if (
          mutation?.message.id === persisted.id
          && mutation.message.body === parsedBody.data.body
          && mutation.fingerprint === clientMutationFingerprint
          && currentUserVariants.length === 1
          && currentUserVariants[0]?.id === persisted.id
          && currentUserVariants[0]?.turnVariant === persisted.turnVariant
        ) {
          confirmedUserMessage = persisted;
        }
      }
    } catch (error) {
      logger.warn({
        err: chatAssistantErrorForLog(error),
        conversationId: conversation.id,
        messageId: messagePersistence.messageId,
      }, "could not verify committed chat input after pre-generation failure");
    }
  }
  if (confirmedUserMessage) {
    let failedMessage: ChatMessage | null = null;
    try {
      failedMessage = await svc.addMessage(conversation.id, {
        orgId: conversation.orgId,
        role: "assistant",
        kind: "message",
        status: "failed",
        body: CHAT_PRE_GENERATION_FAILURE_MESSAGE,
        structuredPayload: chatPreGenerationFailurePayload({
          userId: actor.actorId,
          userMessage: confirmedUserMessage,
        }),
        runId: null,
        replyingAgentId: conversation.preferredAgentId,
        chatTurnId: confirmedUserMessage.chatTurnId,
        turnVariant: confirmedUserMessage.turnVariant,
      }) as ChatMessage;
      try {
        await logChatMessagesAdded(conversation, [failedMessage], {
          actorType: "system",
          actorId: "chat-assistant",
          agentId: conversation.preferredAgentId,
        });
      } catch (error) {
        logger.warn({
          err: chatAssistantErrorForLog(error),
          conversationId: conversation.id,
          messageId: failedMessage.id,
        }, "failed to log persisted pre-generation chat failure");
      }
    } catch (error) {
      logger.warn({
        err: chatAssistantErrorForLog(error),
        conversationId: conversation.id,
        userMessageId: confirmedUserMessage.id,
      }, "could not persist pre-generation chat failure");
    }
    releaseGeneration();
    res.status(201);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    writeStreamEvent(res, { type: "ack", userMessage: confirmedUserMessage });
    if (failedMessage) {
      writeStreamEvent(res, {
        type: "error",
        error: CHAT_PRE_GENERATION_FAILURE_MESSAGE,
        messageId: failedMessage.id,
        structuredPayload: failedMessage.structuredPayload,
      });
    } else {
      writeStreamEvent(res, {
        type: "error",
        error: CHAT_ASSISTANT_USER_ERROR_MESSAGE,
        messageId: confirmedUserMessage.id,
      });
    }
    res.end();
    return;
  }
  releaseGeneration();
  res.status(201);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  writeStreamEvent(res, { type: "error", error: CHAT_ASSISTANT_USER_ERROR_MESSAGE, messageId: messagePersistence.messageId });
  res.end();
  return;
}
