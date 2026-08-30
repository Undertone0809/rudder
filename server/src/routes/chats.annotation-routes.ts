import type { Db } from "@rudderhq/db";
import {
  chatInlineAnnotationsFromStructuredPayload,
  type ChatConversation,
  type ChatMessage,
} from "@rudderhq/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { logActivity } from "../services/activity-log.js";
import type { PreparedChatInlineAnnotations } from "../services/chat-inline-annotations.js";
import type { chatService } from "../services/chats.js";
import type { StorageService } from "../storage/types.js";
import { getActorInfo } from "./authz.js";

type ChatService = ReturnType<typeof chatService>;
type ActorInfo = ReturnType<typeof getActorInfo>;

export type ChatAnnotationRouteInput = {
  clientMutationId?: string | null;
  clientMutationFingerprint?: string | null;
  provided: boolean;
  prepared: PreparedChatInlineAnnotations | null;
  storedAttachments?: Array<{
    provider: string;
    objectKey: string;
    contentType: string;
    byteSize: number;
    sha256: string;
    originalFilename: string | null;
  }>;
  onPersisted?: (messageId: string) => void;
};

export type ChatTurnContext = {
  chatTurnId: string;
  turnVariant: number;
};

export function turnContextFromUserMessage(userMessage: ChatMessage): ChatTurnContext {
  if (!userMessage.chatTurnId) {
    throw new Error("User message missing chat turn id");
  }
  return {
    chatTurnId: userMessage.chatTurnId,
    turnVariant: userMessage.turnVariant,
  };
}

export function createChatAnnotationRouteHelpers(input: {
  db: Db;
  storage: StorageService;
  chats: ChatService;
  logActivity: typeof logActivity;
  assertLocalMutationAllowed: (conversation: ChatConversation) => void;
}) {
  async function addUserMessage(
    conversation: ChatConversation,
    body: string,
    actor: ActorInfo,
    editUserMessageId?: string | null,
    annotationInput?: ChatAnnotationRouteInput,
  ) {
    input.assertLocalMutationAllowed(conversation);
    let persistenceDisposition: "accepted" | "replayed" | null = null;
    const reportTransactionCommit = (messageId: string) => {
      if (persistenceDisposition) return;
      persistenceDisposition = "accepted";
      annotationInput?.onPersisted?.(messageId);
    };
    const reportIdempotentReplay = () => {
      if (persistenceDisposition) return;
      persistenceDisposition = "replayed";
    };
    const transactionCommitOptions = annotationInput?.onPersisted
      ? { onTransactionCommitted: reportTransactionCommit }
      : {};
    const messageOptions = annotationInput?.provided
      ? {
        structuredPayload: {
          inlineAnnotations: annotationInput.prepared?.annotations ?? [],
        },
        structuredPayloadProvided: true,
        ...(annotationInput.storedAttachments?.length
          ? {
            attachments: annotationInput.storedAttachments.map((attachment) => ({
              ...attachment,
              createdByAgentId: actor.agentId,
              createdByUserId: actor.actorType === "user" ? actor.actorId : null,
            })),
            attachmentFileIndexesByAnnotationId:
              annotationInput.prepared?.attachmentFileIndexesByAnnotationId,
          }
          : {}),
        ...transactionCommitOptions,
        ...(annotationInput.clientMutationId
          ? {
            clientMutationId: annotationInput.clientMutationId,
            clientMutationFingerprint: annotationInput.clientMutationFingerprint ?? null,
            onIdempotentReplay: reportIdempotentReplay,
          }
          : {}),
      }
      : annotationInput?.storedAttachments?.length
        ? {
          attachments: annotationInput.storedAttachments.map((attachment) => ({
            ...attachment,
            createdByAgentId: actor.agentId,
            createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          })),
          ...transactionCommitOptions,
          ...(annotationInput.clientMutationId
            ? {
              clientMutationId: annotationInput.clientMutationId,
              clientMutationFingerprint: annotationInput.clientMutationFingerprint ?? null,
              onIdempotentReplay: reportIdempotentReplay,
            }
            : {}),
        }
        : annotationInput?.onPersisted || annotationInput?.clientMutationId
          ? {
            ...transactionCommitOptions,
            ...(annotationInput.clientMutationId
              ? {
                clientMutationId: annotationInput.clientMutationId,
                clientMutationFingerprint: annotationInput.clientMutationFingerprint ?? null,
                onIdempotentReplay: reportIdempotentReplay,
              }
              : {}),
          }
          : undefined;
    const userMessage = messageOptions
      ? await input.chats.addUserChatMessage(
        conversation.id,
        conversation.orgId,
        body,
        editUserMessageId ?? null,
        messageOptions,
      )
      : await input.chats.addUserChatMessage(
        conversation.id,
        conversation.orgId,
        body,
        editUserMessageId ?? null,
      );
    if (!persistenceDisposition) reportTransactionCommit(userMessage.id);
    const accepted = persistenceDisposition === "accepted";
    if (!accepted) {
      return { message: userMessage as ChatMessage, accepted: false };
    }
    const persistedAnnotations = chatInlineAnnotationsFromStructuredPayload(
      userMessage.structuredPayload,
    );

    await input.logActivity(input.db, {
      orgId: conversation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.message_added",
      entityType: "chat",
      entityId: conversation.id,
      details: {
        messageId: userMessage.id,
        role: "user",
        kind: "message",
        editUserMessageId: editUserMessageId ?? null,
        annotationCount: persistedAnnotations.length,
        annotationSourceMessageIds: [
          ...new Set(
            persistedAnnotations
              .filter((annotation) => annotation.surface !== "agent_run_transcript")
              .map((annotation) => annotation.sourceMessageId)
              .filter((value): value is string => Boolean(value)),
          ),
        ],
        annotationSourceRunIds: [
          ...new Set(
            persistedAnnotations
              .filter((annotation) => annotation.surface === "agent_run_transcript")
              .map((annotation) => annotation.sourceRunId)
              .filter((value): value is string => Boolean(value)),
          ),
        ],
      },
    });

    const storedObjectKeys = new Set(
      annotationInput?.storedAttachments?.map((attachment) => attachment.objectKey) ?? [],
    );
    await Promise.all(
      (userMessage.attachments ?? [])
        .filter((attachment) => storedObjectKeys.has(attachment.objectKey ?? ""))
        .map((attachment) => input.logActivity(input.db, {
          orgId: conversation.orgId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "chat.attachment_added",
          entityType: "chat",
          entityId: conversation.id,
          details: {
            attachmentId: attachment.id,
            messageId: attachment.messageId,
            originalFilename: attachment.originalFilename,
            contentType: attachment.contentType,
          },
        })),
    );

    return { message: userMessage as ChatMessage, accepted: true };
  }

  async function storeUserMessageFiles(
    conversation: ChatConversation,
    files: Array<{ mimetype: string; buffer: Buffer; originalname: string }>,
  ) {
    const storedFiles: Array<Awaited<ReturnType<StorageService["putFile"]>>> = [];
    try {
      for (const file of files) {
        storedFiles.push(await input.storage.putFile({
          orgId: conversation.orgId,
          namespace: `chats/${conversation.id}`,
          originalFilename: file.originalname || null,
          contentType: (file.mimetype || "").toLowerCase(),
          body: file.buffer,
        }));
      }
      return storedFiles;
    } catch (error) {
      await Promise.all(
        storedFiles.map((stored) =>
          input.storage.deleteObject(conversation.orgId, stored.objectKey).catch(() => undefined),
        ),
      );
      throw error;
    }
  }

  async function cleanupStoredUserMessageFiles(
    conversation: ChatConversation,
    storedFiles: Array<{ objectKey: string }>,
  ) {
    await Promise.all(
      storedFiles.map((stored) =>
        input.storage.deleteObject(conversation.orgId, stored.objectKey).catch((error) => {
          logger.warn(
            { err: error, conversationId: conversation.id, objectKey: stored.objectKey },
            "failed to clean up uncommitted chat attachment",
          );
        }),
      ),
    );
  }

  async function addAgentAuthoredMessage(
    conversation: ChatConversation,
    body: string,
    actor: ActorInfo,
  ) {
    input.assertLocalMutationAllowed(conversation);
    if (!actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const message = await input.chats.addMessage(conversation.id, {
      orgId: conversation.orgId,
      role: "assistant",
      kind: "message",
      body,
      replyingAgentId: actor.agentId,
    }) as ChatMessage;

    await input.logActivity(input.db, {
      orgId: conversation.orgId,
      actorType: "agent",
      actorId: actor.agentId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.message_added",
      entityType: "chat",
      entityId: conversation.id,
      details: {
        messageId: message.id,
        role: "assistant",
        kind: "message",
        replyingAgentId: actor.agentId,
        source: "agent_direct_message",
      },
    });

    return message;
  }

  return {
    addAgentAuthoredMessage,
    addUserMessage,
    cleanupStoredUserMessageFiles,
    storeUserMessageFiles,
  };
}
