import type { Db } from "@rudderhq/db";
import {
  assets,
  chatAttachments,
  chatConversations,
  chatMessages,
} from "@rudderhq/db";
import {
  chatInlineAnnotationsFromStructuredPayload,
  chatInlineAnnotationsSchema,
  sanitizeChatStructuredPayload,
  type ChatMessage,
} from "@rudderhq/shared";
import { and, eq, gt, gte, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { conflict, notFound, unprocessable } from "../errors.js";
import { validateCanonicalChatInlineAnnotations } from "./chat-inline-annotation-validation.js";
import { listDetachedChatTranscripts, replaceDetachedChatTranscript, selectChatTranscript } from "./chat-transcript-persistence.js";
import { chatTranscriptFromPayload, stripChatMetadataFromPayload } from "./chats.helpers.js";

type MessageRow = typeof chatMessages.$inferSelect;

function postgresErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const direct = "code" in error ? (error as { code?: unknown }).code : null;
  if (typeof direct === "string") return direct;
  const cause = "cause" in error ? (error as { cause?: unknown }).cause : null;
  return cause && typeof cause === "object" && "code" in cause
    && typeof (cause as { code?: unknown }).code === "string"
    ? (cause as { code: string }).code
    : null;
}

export type AddUserChatMessageOptions = {
  structuredPayload?: Record<string, unknown> | null;
  structuredPayloadProvided?: boolean;
  attachments?: Array<{
    provider: string;
    objectKey: string;
    contentType: string;
    byteSize: number;
    sha256: string;
    originalFilename: string | null;
    createdByAgentId: string | null;
    createdByUserId: string | null;
  }>;
  attachmentFileIndexesByAnnotationId?: Map<string, number[]>;
  clientMutationId?: string | null;
  clientMutationFingerprint?: string | null;
  onIdempotentReplay?: (messageId: string) => void;
  onTransactionCommitted?: (messageId: string) => void;
};

export function createChatMessageMutationLookup(
  db: Db,
  getMessage: (conversationId: string, messageId: string) => Promise<ChatMessage | null>,
) {
  return async function getUserMessageMutationByClientMutationId(
    orgId: string,
    conversationId: string,
    clientMutationId: string,
  ) {
    const row = await db
      .select({ id: chatMessages.id, fingerprint: chatMessages.clientMutationFingerprint })
      .from(chatMessages)
      .where(and(
        eq(chatMessages.orgId, orgId),
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.role, "user"),
        eq(chatMessages.clientMutationId, clientMutationId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const message = await getMessage(conversationId, row.id);
    return message ? { message, fingerprint: row.fingerprint } : null;
  };
}

function remapInlineAnnotationAttachmentIds(
  structuredPayload: Record<string, unknown> | null | undefined,
  attachmentIdMap: Map<string, string>,
) {
  const cleanPayload = stripChatMetadataFromPayload(structuredPayload);
  const annotations = chatInlineAnnotationsFromStructuredPayload(cleanPayload);
  if (annotations.length === 0) return cleanPayload;
  return {
    ...(cleanPayload ?? {}),
    inlineAnnotations: annotations.map((annotation) => ({
      ...annotation,
      attachmentIds: annotation.attachmentIds.map((attachmentId) => {
        const reboundId = attachmentIdMap.get(attachmentId);
        if (!reboundId) {
          throw unprocessable("Annotation attachment could not be rebound to the edited message");
        }
        return reboundId;
      }),
    })),
  };
}

function bindInlineAnnotationFileAttachments(
  structuredPayload: Record<string, unknown> | null | undefined,
  attachmentFileIndexesByAnnotationId: Map<string, number[]> | undefined,
  uploadedAttachmentIds: readonly string[],
) {
  const cleanPayload = stripChatMetadataFromPayload(structuredPayload);
  const annotations = chatInlineAnnotationsFromStructuredPayload(cleanPayload);
  if (annotations.length === 0) return cleanPayload;
  const bound = annotations.map((annotation) => ({
    ...annotation,
    attachmentIds: [
      ...annotation.attachmentIds,
      ...(attachmentFileIndexesByAnnotationId?.get(annotation.id) ?? []).map((fileIndex) => {
        const attachmentId = uploadedAttachmentIds[fileIndex];
        if (!attachmentId) {
          throw unprocessable("Annotation file attachment could not be rebound to the user message");
        }
        return attachmentId;
      }),
    ],
  }));
  return {
    ...(cleanPayload ?? {}),
    inlineAnnotations: chatInlineAnnotationsSchema.parse(bound),
  };
}

export function createChatAnnotationMessagePersistence(
  db: Db,
  getMessage: (conversationId: string, messageId: string) => Promise<ChatMessage | null>,
) {
  return async function addUserChatMessage(
    conversationId: string,
    orgId: string,
    body: string,
    editUserMessageId?: string | null,
    options: AddUserChatMessageOptions = {},
  ) {
    const persist = () => db.transaction(async (tx) => {
      const now = new Date();
      let target: MessageRow | null = null;
      let turnId: string = randomUUID();
      let turnVariant = 0;
      let messageStructuredPayload = options.structuredPayload ?? null;
      let messageTranscript = chatTranscriptFromPayload(messageStructuredPayload);
      const attachmentIdMap = new Map<string, string>();

      if (options.clientMutationId) {
        const existing = await tx
          .select({
            id: chatMessages.id,
            body: chatMessages.body,
            fingerprint: chatMessages.clientMutationFingerprint,
          })
          .from(chatMessages)
          .where(and(
            eq(chatMessages.orgId, orgId),
            eq(chatMessages.conversationId, conversationId),
            eq(chatMessages.clientMutationId, options.clientMutationId),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existing) {
          if (
            existing.body !== body
            || (
              existing.fingerprint !== null
              && existing.fingerprint !== (options.clientMutationFingerprint ?? null)
            )
          ) {
            throw conflict("Chat mutation key was already used for different content");
          }
          return { messageId: existing.id, replayed: true };
        }
      }

      if (editUserMessageId) {
        target = await tx
          .select()
          .from(chatMessages)
          .where(and(
            eq(chatMessages.id, editUserMessageId),
            eq(chatMessages.orgId, orgId),
            eq(chatMessages.conversationId, conversationId),
          ))
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!target) {
          throw notFound("Chat message not found");
        }
        if (target.role !== "user" || target.kind !== "message") {
          throw unprocessable("Only plain user messages can be edited");
        }
        if (target.supersededAt) {
          throw unprocessable("Cannot edit a superseded message");
        }
        if (!target.chatTurnId) {
          turnId = randomUUID();
          await tx
            .update(chatMessages)
            .set({ chatTurnId: turnId, turnVariant: 0, updatedAt: now })
            .where(and(
              eq(chatMessages.id, target.id),
              eq(chatMessages.orgId, orgId),
              eq(chatMessages.conversationId, conversationId),
            ));
          const following = await tx
            .select()
            .from(chatMessages)
            .where(and(
              eq(chatMessages.orgId, orgId),
              eq(chatMessages.conversationId, conversationId),
              gt(chatMessages.createdAt, target.createdAt),
            ))
            .orderBy(chatMessages.createdAt);
          for (const row of following) {
            if (row.role === "user") break;
            await tx
              .update(chatMessages)
              .set({ chatTurnId: turnId, turnVariant: 0, updatedAt: now })
              .where(and(
                eq(chatMessages.id, row.id),
                eq(chatMessages.orgId, orgId),
                eq(chatMessages.conversationId, conversationId),
              ));
          }
        } else {
          turnId = target.chatTurnId;
        }
        turnVariant = target.turnVariant + 1;
        if (options.structuredPayloadProvided) {
          messageStructuredPayload = options.structuredPayload ?? null;
          messageTranscript = chatTranscriptFromPayload(messageStructuredPayload);
        } else {
          const detached = await listDetachedChatTranscripts(tx, [target]);
          messageTranscript = selectChatTranscript({
            ledger: undefined,
            detached: detached.get(target.id),
            legacyPayload: target.structuredPayload,
          });
          messageStructuredPayload = stripChatMetadataFromPayload(target.structuredPayload);
        }
      }

      const canonicalAnnotations = chatInlineAnnotationsFromStructuredPayload(
        messageStructuredPayload,
      );
      await validateCanonicalChatInlineAnnotations(tx, {
        orgId,
        conversationId,
        annotations: canonicalAnnotations,
        uploadedFileCount: options.attachments?.length ?? 0,
        attachmentFileIndexesByAnnotationId:
          options.attachmentFileIndexesByAnnotationId,
        editUserMessageId,
      });

      if (target) {
        await tx
          .update(chatMessages)
          .set({ supersededAt: now, updatedAt: now })
          .where(and(
            eq(chatMessages.orgId, orgId),
            eq(chatMessages.conversationId, conversationId),
            isNull(chatMessages.supersededAt),
            gte(chatMessages.createdAt, target.createdAt),
          ));
      }

      const [message] = await tx
        .insert(chatMessages)
        .values({
          orgId,
          conversationId,
          role: "user",
          kind: "message",
          status: "completed",
          body,
          structuredPayload: stripChatMetadataFromPayload(sanitizeChatStructuredPayload(messageStructuredPayload)),
          clientMutationId: options.clientMutationId ?? null,
          clientMutationFingerprint: options.clientMutationFingerprint ?? null,
          chatTurnId: turnId,
          turnVariant,
        })
        .returning();
      if (!message) throw new Error("Failed to create chat message");

      if (target) {
        const sourceAttachments = await tx
          .select()
          .from(chatAttachments)
          .where(and(
            eq(chatAttachments.orgId, orgId),
            eq(chatAttachments.conversationId, conversationId),
            eq(chatAttachments.messageId, target.id),
          ))
          .orderBy(chatAttachments.createdAt);
        if (sourceAttachments.length > 0) {
          const copiedAttachments = sourceAttachments.map((attachment) => ({
            id: randomUUID(),
            orgId,
            conversationId,
            messageId: message.id,
            assetId: attachment.assetId,
          }));
          await tx.insert(chatAttachments).values(copiedAttachments);
          sourceAttachments.forEach((sourceAttachment, index) => {
            attachmentIdMap.set(sourceAttachment.id, copiedAttachments[index]!.id);
          });
        }
        messageStructuredPayload = remapInlineAnnotationAttachmentIds(
          messageStructuredPayload,
          attachmentIdMap,
        );
      } else if (
        chatInlineAnnotationsFromStructuredPayload(messageStructuredPayload)
          .some((annotation) => annotation.attachmentIds.length > 0)
      ) {
        throw unprocessable("Existing annotation attachments cannot be rebound to a new user message");
      }

      const uploadedAttachmentIds: string[] = [];
      for (const attachment of options.attachments ?? []) {
        const assetId = randomUUID();
        const attachmentId = randomUUID();
        await tx.insert(assets).values({
          id: assetId,
          orgId,
          provider: attachment.provider,
          objectKey: attachment.objectKey,
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
          sha256: attachment.sha256,
          originalFilename: attachment.originalFilename,
          createdByAgentId: attachment.createdByAgentId,
          createdByUserId: attachment.createdByUserId,
        });
        await tx.insert(chatAttachments).values({
          id: attachmentId,
          orgId,
          conversationId,
          messageId: message.id,
          assetId,
        });
        uploadedAttachmentIds.push(attachmentId);
      }

      messageStructuredPayload = bindInlineAnnotationFileAttachments(
        messageStructuredPayload,
        options.attachmentFileIndexesByAnnotationId,
        uploadedAttachmentIds,
      );
      await tx
        .update(chatMessages)
        .set({
          structuredPayload: stripChatMetadataFromPayload(sanitizeChatStructuredPayload(messageStructuredPayload)),
          updatedAt: now,
        })
        .where(and(
          eq(chatMessages.id, message.id),
          eq(chatMessages.orgId, orgId),
          eq(chatMessages.conversationId, conversationId),
        ));
      if (messageTranscript.length > 0) {
        await replaceDetachedChatTranscript(tx, {
          orgId,
          messageId: message.id,
          entries: messageTranscript,
        });
      }
      await tx
        .update(chatConversations)
        .set({ lastMessageAt: message.createdAt, updatedAt: message.createdAt })
        .where(and(
          eq(chatConversations.id, conversationId),
          eq(chatConversations.orgId, orgId),
        ));
      return { messageId: message.id, replayed: false };
    });
    let persisted: { messageId: string; replayed: boolean };
    try {
      persisted = await persist();
    } catch (error) {
      if (!options.clientMutationId || postgresErrorCode(error) !== "23505") throw error;
      const existing = await db
        .select({
          id: chatMessages.id,
          body: chatMessages.body,
          fingerprint: chatMessages.clientMutationFingerprint,
        })
        .from(chatMessages)
        .where(and(
          eq(chatMessages.orgId, orgId),
          eq(chatMessages.conversationId, conversationId),
          eq(chatMessages.clientMutationId, options.clientMutationId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!existing) throw error;
      if (
        existing.body !== body
        || (
          existing.fingerprint !== null
          && existing.fingerprint !== (options.clientMutationFingerprint ?? null)
        )
      ) {
        throw conflict("Chat mutation key was already used for different content");
      }
      persisted = { messageId: existing.id, replayed: true };
    }
    if (persisted.replayed) options.onIdempotentReplay?.(persisted.messageId);
    else options.onTransactionCommitted?.(persisted.messageId);
    const { messageId } = persisted;
    const message = await getMessage(conversationId, messageId);
    if (!message) throw new Error("Failed to hydrate created chat message");
    return message;
  };
}
