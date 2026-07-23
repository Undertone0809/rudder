import type { Db } from "@rudderhq/db";
import { chatConversations, chatMessages } from "@rudderhq/db";
import {
  chatInlineAnnotationsFromStructuredPayload,
  type ChatInlineAnnotation,
} from "@rudderhq/shared";
import { and, eq } from "drizzle-orm";
import { unprocessable } from "../errors.js";

type ChatTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ConversationRow = typeof chatConversations.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;

type SideChatBoundary = {
  sourceConversationId: string;
  sourceMessageId: string;
  copiedSourceMessageId: string | null;
};

function sideChatBoundaryFromMessage(message: MessageRow): SideChatBoundary | null {
  if (
    message.role !== "system"
    || message.kind !== "system_event"
    || !message.structuredPayload
  ) return null;
  const payload = message.structuredPayload;
  if (
    payload.eventType !== "side_chat_started"
    || typeof payload.sourceConversationId !== "string"
    || typeof payload.sourceMessageId !== "string"
  ) return null;
  return {
    sourceConversationId: payload.sourceConversationId,
    sourceMessageId: payload.sourceMessageId,
    copiedSourceMessageId: typeof payload.copiedSourceMessageId === "string"
      ? payload.copiedSourceMessageId
      : null,
  };
}

function inferredCopiedParentAnchor(
  messages: MessageRow[],
  boundaryMessageId: string,
) {
  const boundaryIndex = messages.findIndex((message) => message.id === boundaryMessageId);
  if (boundaryIndex < 0) return null;
  for (let index = boundaryIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.kind === "message") return message;
  }
  return null;
}

export async function createChatAnnotationCopySourceResolver(input: {
  tx: ChatTransaction;
  orgId: string;
  sourceConversation: ConversationRow;
  messages: MessageRow[];
  operationLabel: "Fork" | "Side Chat";
}) {
  const sourceMessageById = new Map(
    input.messages.map((message) => [message.id, message]),
  );
  const externalAnnotations = input.messages
    .flatMap((message) =>
      chatInlineAnnotationsFromStructuredPayload(message.structuredPayload)
    )
    .filter((annotation) =>
      annotation.sourceConversationId !== input.sourceConversation.id
    );

  let inheritedLocalSource: MessageRow | null = null;
  if (externalAnnotations.length > 0) {
    const exactKeptSideChatLineage =
      input.sourceConversation.conversationKind === "side_chat"
      && input.sourceConversation.sideChatState === "kept"
      && input.sourceConversation.messengerVisible
      && input.sourceConversation.forkedFromConversationId
      && input.sourceConversation.forkedFromMessageId;
    if (
      !exactKeptSideChatLineage
      || externalAnnotations.some((annotation) =>
        annotation.sourceConversationId
          !== input.sourceConversation.forkedFromConversationId
        || annotation.sourceMessageId !== input.sourceConversation.forkedFromMessageId
      )
    ) {
      throw unprocessable(
        `${input.operationLabel} annotation source conversation falls outside the copied range`,
      );
    }

    const parentConversation = await input.tx
      .select({ id: chatConversations.id })
      .from(chatConversations)
      .where(and(
        eq(chatConversations.id, input.sourceConversation.forkedFromConversationId!),
        eq(chatConversations.orgId, input.orgId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!parentConversation) {
      throw unprocessable(
        `${input.operationLabel} annotation source conversation falls outside the copied range`,
      );
    }
    const parentSource = await input.tx
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.id, input.sourceConversation.forkedFromMessageId!),
        eq(chatMessages.conversationId, input.sourceConversation.forkedFromConversationId!),
        eq(chatMessages.orgId, input.orgId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (
      !parentSource
      || parentSource.role !== "assistant"
      || parentSource.kind !== "message"
      || parentSource.status !== "completed"
    ) {
      throw unprocessable(
        `${input.operationLabel} annotation source message falls outside the copied range`,
      );
    }

    const matchingBoundaries = input.messages.flatMap((message) => {
      const boundary = sideChatBoundaryFromMessage(message);
      return boundary
        && boundary.sourceConversationId === input.sourceConversation.forkedFromConversationId
        && boundary.sourceMessageId === input.sourceConversation.forkedFromMessageId
        ? [{ boundary, message }]
        : [];
    });
    if (matchingBoundaries.length !== 1) {
      throw unprocessable(
        `${input.operationLabel} annotation source message falls outside the copied range`,
      );
    }
    const [{ boundary, message: boundaryMessage }] = matchingBoundaries;
    const localSource = boundary.copiedSourceMessageId
      ? sourceMessageById.get(boundary.copiedSourceMessageId) ?? null
      : inferredCopiedParentAnchor(input.messages, boundaryMessage.id);
    if (
      !localSource
      || localSource.role !== "assistant"
      || localSource.kind !== "message"
      || localSource.status !== "completed"
      || localSource.body !== parentSource.body
    ) {
      throw unprocessable(
        `${input.operationLabel} annotation source message falls outside the copied range`,
      );
    }
    inheritedLocalSource = localSource;
  }

  return (annotation: ChatInlineAnnotation) => {
    if (annotation.sourceConversationId === input.sourceConversation.id) {
      return sourceMessageById.get(annotation.sourceMessageId) ?? null;
    }
    if (
      inheritedLocalSource
      && annotation.sourceConversationId
        === input.sourceConversation.forkedFromConversationId
      && annotation.sourceMessageId === input.sourceConversation.forkedFromMessageId
    ) {
      return inheritedLocalSource;
    }
    return null;
  };
}
