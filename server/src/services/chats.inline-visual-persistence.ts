import type { Db } from "@rudderhq/db";
import { assets, chatAttachments, chatConversations, chatMessages } from "@rudderhq/db";
import {
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

export async function copyForkInlineVisualMessages(input: {
  tx: ChatTransaction;
  messages: ChatMessageRow[];
  sourceConversationId: string;
  targetConversationId: string;
  orgId: string;
}) {
  for (const message of input.messages) {
    const copiedMessageId = randomUUID();
    const visualMappings = chatInlineVisualMappingsFromStructuredPayload(message.structuredPayload);
    const visualMappingsV1 = rudderInlineVisualMappingsFromStructuredPayload(message.structuredPayload);
    const readyAttachmentIds = [...visualMappings, ...visualMappingsV1]
      .filter((mapping) => mapping.status === "ready")
      .map((mapping) => mapping.attachmentId);
    const copiedAttachmentIdBySourceId = new Map<string, string>();
    const pendingVisualAttachments: Array<{
      id: string;
      orgId: string;
      conversationId: string;
      messageId: string;
      assetId: string;
    }> = [];
    if (readyAttachmentIds.length > 0) {
      const sourceVisualAttachments = await input.tx
        .select({
          id: chatAttachments.id,
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
          eq(chatAttachments.conversationId, input.sourceConversationId),
          eq(chatAttachments.messageId, message.id),
          inArray(chatAttachments.id, readyAttachmentIds),
        ));
      const safeVisualAttachments = sourceVisualAttachments.filter((attachment) => {
        if (
          attachment.contentType !== "text/html"
          || !attachment.createdByAgentId
          || attachment.createdByUserId
        ) return false;
        return visualMappings.some((mapping) =>
          mapping.status === "ready"
          && mapping.attachmentId === attachment.id
          && mapping.file === attachment.originalFilename
        ) || visualMappingsV1.some((mapping) =>
          mapping.status === "ready"
          && mapping.attachmentId === attachment.id
          && mapping.file === attachment.originalFilename
          && mapping.contentType === attachment.contentType
          && mapping.byteSize === attachment.byteSize
          && mapping.sha256 === attachment.sha256.toLowerCase()
        );
      });
      pendingVisualAttachments.push(...safeVisualAttachments.map((attachment) => {
        const copiedAttachmentId = randomUUID();
        copiedAttachmentIdBySourceId.set(attachment.id, copiedAttachmentId);
        return {
          id: copiedAttachmentId,
          orgId: input.orgId,
          conversationId: input.targetConversationId,
          messageId: copiedMessageId,
          assetId: attachment.assetId,
        };
      }));
    }
    const copiedVisualMappings = visualMappings.map((mapping) => {
      if (mapping.status === "unavailable") return mapping;
      const copiedAttachmentId = copiedAttachmentIdBySourceId.get(mapping.attachmentId);
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
      const copiedAttachmentId = copiedAttachmentIdBySourceId.get(mapping.attachmentId);
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
      ...(copiedVisualMappings.length > 0 ? { inlineVisuals: copiedVisualMappings } : {}),
      ...(copiedVisualMappingsV1.length > 0 ? { inlineVisualsV1: copiedVisualMappingsV1 } : {}),
    };
    await input.tx.insert(chatMessages).values({
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
    });
    if (pendingVisualAttachments.length > 0) {
      await input.tx.insert(chatAttachments).values(pendingVisualAttachments);
    }
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
