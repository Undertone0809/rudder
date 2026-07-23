import type { Db } from "@rudderhq/db";
import { assets, chatAttachments, chatConversations, chatMessages } from "@rudderhq/db";
import {
  chatInlineAnnotationsFromStructuredPayload,
  chatInlineVisualMappingsFromStructuredPayload,
  parseCodexInlineVisualDirectives,
  parseRudderInlineVisualPlacements,
  rudderInlineVisualMappingsFromStructuredPayload,
  sanitizeChatStructuredPayload,
  type ChatInlineVisualMapping,
  type RudderInlineVisualMapping,
} from "@rudderhq/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { unprocessable } from "../errors.js";
import type { MessageHydrationRow } from "./chats.types.js";

type ChatTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ChatMessageRow = typeof chatMessages.$inferSelect;

export async function listRecentUserChatMessages(db: Db, conversationId: string, limit: number) {
  const ecmascriptTrimWhitespace = "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";
  const boundedLimit = Math.min(5, Math.max(1, Math.trunc(limit)));
  const conversationOrgIds = db
    .select({ orgId: chatConversations.orgId })
    .from(chatConversations)
    .where(eq(chatConversations.id, conversationId));
  const rows = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      kind: chatMessages.kind,
      body: chatMessages.body,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.conversationId, conversationId),
      inArray(chatMessages.orgId, conversationOrgIds),
      isNull(chatMessages.supersededAt),
      eq(chatMessages.role, "user"),
      eq(chatMessages.kind, "message"),
      sql<boolean>`btrim(${chatMessages.body}, ${ecmascriptTrimWhitespace}) <> ''`,
    ))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(boundedLimit);
  return rows.reverse();
}

export async function copyForkChatMessages(input: {
  tx: ChatTransaction;
  messages: ChatMessageRow[];
  sourceConversationId: string;
  targetConversationId: string;
  orgId: string;
}) {
  const copiedMessageIdBySourceId = new Map(
    input.messages.map((message) => [message.id, randomUUID()]),
  );
  const sourceMessageById = new Map(
    input.messages.map((message) => [message.id, message]),
  );
  const attachmentIds = new Set<string>();
  for (const message of input.messages) {
    for (const annotation of chatInlineAnnotationsFromStructuredPayload(message.structuredPayload)) {
      annotation.attachmentIds.forEach((attachmentId) => attachmentIds.add(attachmentId));
    }
    const visualMappings = chatInlineVisualMappingsFromStructuredPayload(
      message.structuredPayload,
    );
    const visualMappingsV1 = rudderInlineVisualMappingsFromStructuredPayload(
      message.structuredPayload,
    );
    [...visualMappings, ...visualMappingsV1]
      .filter((mapping) => mapping.status === "ready")
      .forEach((mapping) => attachmentIds.add(mapping.attachmentId));
  }
  const sourceAttachments = attachmentIds.size > 0
    ? await input.tx
        .select({
          id: chatAttachments.id,
          messageId: chatAttachments.messageId,
          assetId: chatAttachments.assetId,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
        })
        .from(chatAttachments)
        .innerJoin(assets, eq(chatAttachments.assetId, assets.id))
        .where(and(
          eq(chatAttachments.orgId, input.orgId),
          eq(chatAttachments.conversationId, input.sourceConversationId),
          eq(assets.orgId, input.orgId),
          inArray(chatAttachments.id, [...attachmentIds]),
        ))
    : [];
  const sourceAttachmentById = new Map(
    sourceAttachments.map((attachment) => [attachment.id, attachment]),
  );
  const copiedAttachmentIdBySourceId = new Map<string, string>();
  const copiedAttachments: Array<{
    id: string;
    orgId: string;
    conversationId: string;
    messageId: string;
    assetId: string;
  }> = [];
  function copyAttachment(
    sourceAttachmentId: string,
    sourceMessageId: string,
  ) {
    const sourceAttachment = sourceAttachmentById.get(sourceAttachmentId);
    if (!sourceAttachment || sourceAttachment.messageId !== sourceMessageId) {
      throw unprocessable("Fork annotation attachment is not owned by its copied user message");
    }
    const existingId = copiedAttachmentIdBySourceId.get(sourceAttachmentId);
    if (existingId) return existingId;
    const copiedMessageId = copiedMessageIdBySourceId.get(sourceMessageId);
    if (!copiedMessageId) {
      throw unprocessable("Fork attachment owner falls outside the copied message range");
    }
    const copiedAttachmentId = randomUUID();
    copiedAttachmentIdBySourceId.set(sourceAttachmentId, copiedAttachmentId);
    copiedAttachments.push({
      id: copiedAttachmentId,
      orgId: input.orgId,
      conversationId: input.targetConversationId,
      messageId: copiedMessageId,
      assetId: sourceAttachment.assetId,
    });
    return copiedAttachmentId;
  }

  const copiedMessages = input.messages.map((message) => {
    const copiedMessageId = copiedMessageIdBySourceId.get(message.id)!;
    const visualMappings = chatInlineVisualMappingsFromStructuredPayload(message.structuredPayload);
    const visualMappingsV1 = rudderInlineVisualMappingsFromStructuredPayload(message.structuredPayload);
    const copiedAnnotations = chatInlineAnnotationsFromStructuredPayload(
      message.structuredPayload,
    ).map((annotation) => {
      if (annotation.sourceConversationId !== input.sourceConversationId) {
        throw unprocessable("Fork annotation source conversation falls outside the copied range");
      }
      const copiedSourceMessageId = copiedMessageIdBySourceId.get(annotation.sourceMessageId);
      const sourceMessage = sourceMessageById.get(annotation.sourceMessageId);
      if (
        !copiedSourceMessageId
        || !sourceMessage
        || sourceMessage.role !== "assistant"
        || sourceMessage.kind !== "message"
      ) {
        throw unprocessable("Fork annotation source message falls outside the copied range");
      }
      return {
        ...annotation,
        sourceConversationId: input.targetConversationId,
        sourceMessageId: copiedSourceMessageId,
        attachmentIds: annotation.attachmentIds.map((attachmentId) =>
          copyAttachment(attachmentId, message.id)
        ),
      };
    });
    function copiedSafeVisualAttachmentId(inputMapping: {
      attachmentId: string;
      file: string;
      contentType?: string;
      byteSize?: number;
      sha256?: string;
    }) {
      const attachment = sourceAttachmentById.get(inputMapping.attachmentId);
      if (
        !attachment
        || attachment.messageId !== message.id
        || attachment.contentType !== "text/html"
        || !attachment.createdByAgentId
        || attachment.createdByUserId
        || attachment.originalFilename !== inputMapping.file
      ) {
        return null;
      }
      if (
        inputMapping.contentType !== undefined
        && (
          inputMapping.contentType !== attachment.contentType
          || inputMapping.byteSize !== attachment.byteSize
          || inputMapping.sha256 !== attachment.sha256.toLowerCase()
        )
      ) {
        return null;
      }
      return copyAttachment(inputMapping.attachmentId, message.id);
    }
    const copiedVisualMappings = visualMappings.map((mapping) => {
      if (mapping.status === "unavailable") return mapping;
      const copiedAttachmentId = copiedSafeVisualAttachmentId(mapping);
      return copiedAttachmentId
        ? { ...mapping, attachmentId: copiedAttachmentId }
        : {
          directiveIndex: mapping.directiveIndex,
          file: mapping.file,
          status: "unavailable" as const,
          reason: "fork_source_missing",
        };
    });
    const copiedVisualMappingsV1 = visualMappingsV1.map((mapping) => {
      if (mapping.status === "unavailable") return mapping;
      const copiedAttachmentId = copiedSafeVisualAttachmentId(mapping);
      return copiedAttachmentId
        ? { ...mapping, attachmentId: copiedAttachmentId }
        : {
          version: 1 as const,
          slot: mapping.slot,
          file: mapping.file,
          status: "unavailable" as const,
          reason: "fork_source_missing",
        };
    });
    const copiedStructuredPayload = {
      ...(sanitizeChatStructuredPayload(message.structuredPayload) ?? {}),
      ...(copiedAnnotations.length > 0 ? { inlineAnnotations: copiedAnnotations } : {}),
      ...(copiedVisualMappings.length > 0 ? { inlineVisuals: copiedVisualMappings } : {}),
      ...(copiedVisualMappingsV1.length > 0 ? { inlineVisualsV1: copiedVisualMappingsV1 } : {}),
    } as Record<string, unknown>;
    return {
      id: copiedMessageId,
      orgId: input.orgId,
      conversationId: input.targetConversationId,
      role: message.role,
      kind: message.kind,
      status: message.status === "streaming" ? "interrupted" : message.status,
      body: message.body,
      structuredPayload: Object.keys(copiedStructuredPayload).length > 0 ? copiedStructuredPayload : null,
      approvalId: null,
      runId: null,
      replyingAgentId: message.replyingAgentId,
      chatTurnId: null,
      turnVariant: 0,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  });
  if (copiedMessages.length > 0) {
    await input.tx.insert(chatMessages).values(copiedMessages);
  }
  if (copiedAttachments.length > 0) {
    await input.tx.insert(chatAttachments).values(copiedAttachments);
  }
}

export async function updateTrustedInlineVisualMappings<THydrated>(input: {
  db: Db;
  hydrateMessages: (rows: MessageHydrationRow[]) => Promise<THydrated[]>;
  conversationId: string;
  messageId: string;
  inlineVisuals?: ChatInlineVisualMapping[];
  inlineVisualsV1?: RudderInlineVisualMapping[];
}) {
  const existing = await input.db
    .select()
    .from(chatMessages)
    .where(and(
      eq(chatMessages.conversationId, input.conversationId),
      eq(chatMessages.id, input.messageId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!existing || existing.role !== "assistant" || existing.status !== "completed") return null;

  const legacyDirectives = parseCodexInlineVisualDirectives(existing.body).directives;
  const rudderPlacements = parseRudderInlineVisualPlacements(existing.body).placements;
  const requestedLegacy = chatInlineVisualMappingsFromStructuredPayload({ inlineVisuals: input.inlineVisuals ?? [] })
    .filter((mapping) => legacyDirectives.some((directive) =>
      directive.index === mapping.directiveIndex && directive.file === mapping.file
    ));
  const requestedRudder = rudderInlineVisualMappingsFromStructuredPayload({ inlineVisualsV1: input.inlineVisualsV1 ?? [] })
    .filter((mapping) => rudderPlacements.some((placement) => placement.slot === mapping.slot));
  const readyAttachmentIds = [...requestedLegacy, ...requestedRudder]
    .filter((mapping) => mapping.status === "ready")
    .map((mapping) => mapping.attachmentId);
  const attachmentRows = readyAttachmentIds.length === 0 ? [] : await input.db
    .select({
      id: chatAttachments.id,
      contentType: assets.contentType,
      byteSize: assets.byteSize,
      sha256: assets.sha256,
      originalFilename: assets.originalFilename,
      createdByAgentId: assets.createdByAgentId,
      createdByUserId: assets.createdByUserId,
    })
    .from(chatAttachments)
    .innerJoin(assets, eq(chatAttachments.assetId, assets.id))
    .where(and(
      eq(chatAttachments.orgId, existing.orgId),
      eq(chatAttachments.conversationId, input.conversationId),
      eq(chatAttachments.messageId, input.messageId),
      inArray(chatAttachments.id, readyAttachmentIds),
    ));
  const inlineVisuals = requestedLegacy.map((mapping): ChatInlineVisualMapping => {
    if (mapping.status === "unavailable") return mapping;
    const attachment = attachmentRows.find((row) =>
      row.id === mapping.attachmentId
      && row.contentType === "text/html"
      && row.originalFilename === mapping.file
      && row.createdByAgentId === existing.replyingAgentId
      && !row.createdByUserId
      && row.byteSize > 0
      && row.byteSize <= 2 * 1024 * 1024
    );
    return attachment ? mapping : {
      directiveIndex: mapping.directiveIndex,
      file: mapping.file,
      status: "unavailable",
      reason: "ownership_mismatch",
    };
  });
  const inlineVisualsV1 = requestedRudder.map((mapping): RudderInlineVisualMapping => {
    if (mapping.status === "unavailable") return mapping;
    const attachment = attachmentRows.find((row) =>
      row.id === mapping.attachmentId
      && row.contentType === mapping.contentType
      && row.originalFilename === mapping.file
      && row.byteSize === mapping.byteSize
      && row.sha256.toLowerCase() === mapping.sha256
      && row.createdByAgentId === existing.replyingAgentId
      && !row.createdByUserId
    );
    return attachment ? mapping : {
      version: 1,
      slot: mapping.slot,
      file: mapping.file,
      status: "unavailable",
      reason: "ownership_mismatch",
    };
  });
  const base = sanitizeChatStructuredPayload(existing.structuredPayload) ?? {};
  const next = {
    ...base,
    ...(inlineVisuals.length > 0 ? { inlineVisuals } : {}),
    ...(inlineVisualsV1.length > 0 ? { inlineVisualsV1 } : {}),
  };
  const [updated] = await input.db
    .update(chatMessages)
    .set({ structuredPayload: next, updatedAt: new Date() })
    .where(and(
      eq(chatMessages.orgId, existing.orgId),
      eq(chatMessages.conversationId, input.conversationId),
      eq(chatMessages.id, input.messageId),
    ))
    .returning();
  const [hydrated] = await input.hydrateMessages([updated]);
  return hydrated ?? null;
}
