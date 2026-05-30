import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import { formatMessengerPreview, formatMessengerTitle, sanitizeChatStructuredPayload, type ChatStreamTranscriptEntry } from "@rudderhq/shared";
import {
  agents,
  approvals,
  assets,
  chatAttachments,
  chatContextLinks,
  chatConversations,
  chatConversationUserStates,
  chatMessages,
  organizations,
  issues,
  projects,
} from "@rudderhq/db";
import { notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { logActivity } from "./activity-log.js";
import { approvalService } from "./approvals.js";
import { documentService } from "./documents.js";
import { organizationService } from "./orgs.js";
import { issueApprovalService } from "./issue-approvals.js";
import { issueService } from "./issues.js";

type ConversationRow = typeof chatConversations.$inferSelect;
type ConversationUserStateRow = typeof chatConversationUserStates.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;
type MessageHydrationRow = MessageRow & {
  transcriptSummary?: {
    entryCount: number;
    startedAt: string | null;
    endedAt: string | null;
  } | null;
};
type ContextLinkRow = typeof chatContextLinks.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

import {
  CHAT_TRANSCRIPT_KEY,
  safeTrim,
  contentPath,
  isVisibleIncomingChatMessage,
  visibleIncomingMessageSql,
  incomingMessagePreviewSql,
  truncatePreview,
  escapeLikePattern,
  textContains,
  buildSearchSnippet,
  resolveContextEntities,
  listContextLinksForConversationIds,
  listPrimaryIssues,
  chatTranscriptFromPayload,
  chatTranscriptSummaryFromEntries,
  stripChatMetadataFromPayload,
  withPersistedTranscript,
  issueProposalFromPayload,
  planDocumentFromPayload,
  operationProposalFromPayload,
  operationProposalDecisionStatusFromPayload,
  withOperationProposalDecisionState,
} from "./chats.helpers.js";

export function chatService(db: Db) {
  const issuesSvc = issueService(db);
  const approvalsSvc = approvalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const organizationsSvc = organizationService(db);
  const agentsSvc = agentService(db);
  const documentsSvc = documentService(db);

  async function ensureConversationUserStates(rows: ConversationRow[], userId: string) {
    if (rows.length === 0) return;
    const now = new Date();
    await db
      .insert(chatConversationUserStates)
      .values(
        rows.map((row) => ({
          orgId: row.orgId,
          conversationId: row.id,
          userId,
          lastReadAt: row.lastMessageAt ?? row.updatedAt ?? row.createdAt,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing();
  }

  async function listConversationUserStates(orgId: string, userId: string, conversationIds: string[]) {
    if (conversationIds.length === 0) return new Map<string, ConversationUserStateRow>();
    const rows = await db
      .select()
      .from(chatConversationUserStates)
      .where(
        and(
          eq(chatConversationUserStates.orgId, orgId),
          eq(chatConversationUserStates.userId, userId),
          inArray(chatConversationUserStates.conversationId, conversationIds),
        ),
      );
    return new Map(rows.map((row) => [row.conversationId, row]));
  }

  async function listUnreadCountsByConversation(
    orgId: string,
    userId: string,
    conversationIds: string[],
  ) {
    if (conversationIds.length === 0) return new Map<string, number>();
    const rows = await db
      .select({
        conversationId: chatMessages.conversationId,
        count: sql<number>`count(*)`,
      })
      .from(chatMessages)
      .innerJoin(
        chatConversationUserStates,
        and(
          eq(chatConversationUserStates.orgId, orgId),
          eq(chatConversationUserStates.userId, userId),
          eq(chatConversationUserStates.conversationId, chatMessages.conversationId),
        ),
      )
      .where(
        and(
          eq(chatMessages.orgId, orgId),
          inArray(chatMessages.conversationId, conversationIds),
          isNull(chatMessages.supersededAt),
          visibleIncomingMessageSql(),
          gt(chatMessages.createdAt, chatConversationUserStates.lastReadAt),
        ),
      )
      .groupBy(chatMessages.conversationId);
    return new Map(rows.map((row) => [row.conversationId, Number(row.count ?? 0)]));
  }

  async function listPendingProposalStates(orgId: string, conversationIds: string[]) {
    if (conversationIds.length === 0) return new Set<string>();
    const rows = await db
      .select({
        conversationId: chatMessages.conversationId,
      })
      .from(chatMessages)
      .innerJoin(approvals, eq(chatMessages.approvalId, approvals.id))
      .where(
        and(
          eq(chatMessages.orgId, orgId),
          inArray(chatMessages.conversationId, conversationIds),
          isNull(chatMessages.supersededAt),
          eq(approvals.status, "pending"),
        ),
      )
      .groupBy(chatMessages.conversationId);
    return new Set(rows.map((row) => row.conversationId));
  }

  async function listLatestReplyPreviews(orgId: string, conversationIds: string[]) {
    if (conversationIds.length === 0) return new Map<string, string | null>();

    const latestReplyAt = db
      .select({
        conversationId: chatMessages.conversationId,
        latestReplyAt: sql<Date>`max(${chatMessages.createdAt})`.as("latest_reply_at"),
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.orgId, orgId),
          inArray(chatMessages.conversationId, conversationIds),
          isNull(chatMessages.supersededAt),
          incomingMessagePreviewSql(),
        ),
      )
      .groupBy(chatMessages.conversationId)
      .as("latest_chat_reply_at");

    const rows = await db
      .select({
        conversationId: chatMessages.conversationId,
        body: chatMessages.body,
      })
      .from(chatMessages)
      .innerJoin(
        latestReplyAt,
        and(
          eq(chatMessages.conversationId, latestReplyAt.conversationId),
          eq(chatMessages.createdAt, latestReplyAt.latestReplyAt),
        ),
      )
      .where(
        and(
          eq(chatMessages.orgId, orgId),
          inArray(chatMessages.conversationId, conversationIds),
          isNull(chatMessages.supersededAt),
          incomingMessagePreviewSql(),
        ),
      )
      .orderBy(desc(chatMessages.createdAt));

    const map = new Map<string, string | null>();
    for (const row of rows) {
      if (!map.has(row.conversationId)) {
        map.set(row.conversationId, truncatePreview(row.body));
      }
    }
    return map;
  }

  async function listSearchPreviews(
    orgId: string,
    rows: ConversationRow[],
    query: string,
    containsPattern: string,
  ) {
    if (rows.length === 0) return new Map<string, string | null>();

    const previews = new Map<string, string | null>();
    for (const row of rows) {
      if (textContains(row.title, query)) {
        previews.set(row.id, buildSearchSnippet(row.title, query));
      } else if (textContains(row.summary, query)) {
        previews.set(row.id, buildSearchSnippet(row.summary, query));
      }
    }

    const messageSearchIds = rows
      .map((row) => row.id)
      .filter((id) => !previews.has(id));
    if (messageSearchIds.length === 0) return previews;

    const messageRows = await db
      .select({
        conversationId: chatMessages.conversationId,
        body: chatMessages.body,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.orgId, orgId),
          inArray(chatMessages.conversationId, messageSearchIds),
          isNull(chatMessages.supersededAt),
          sql<boolean>`${chatMessages.body} ILIKE ${containsPattern} ESCAPE '\\'`,
        ),
      )
      .orderBy(desc(chatMessages.createdAt));

    for (const message of messageRows) {
      if (previews.has(message.conversationId)) continue;
      previews.set(message.conversationId, buildSearchSnippet(message.body, query));
    }
    return previews;
  }

  async function hydrateConversations(rows: ConversationRow[], userId?: string | null) {
    if (userId) {
      await ensureConversationUserStates(rows, userId);
    }

    const conversationIds = rows.map((row) => row.id);
    const orgId = rows[0]?.orgId ?? null;

    const [
      contextLinksByConversationId,
      primaryIssuesById,
      userStatesByConversationId,
      unreadCountsByConversationId,
      pendingProposalConversationIds,
      latestReplyPreviewsByConversationId,
    ] = await Promise.all([
      listContextLinksForConversationIds(db, rows.map((row) => row.id)),
      listPrimaryIssues(db, rows),
      userId && orgId
        ? listConversationUserStates(orgId, userId, conversationIds)
        : Promise.resolve(new Map<string, ConversationUserStateRow>()),
      userId && orgId
        ? listUnreadCountsByConversation(orgId, userId, conversationIds)
        : Promise.resolve(new Map<string, number>()),
      orgId
        ? listPendingProposalStates(orgId, conversationIds)
        : Promise.resolve(new Set<string>()),
      orgId
        ? listLatestReplyPreviews(orgId, conversationIds)
        : Promise.resolve(new Map<string, string | null>()),
    ]);
    return rows.map((row) => ({
      ...row,
      primaryIssue: row.primaryIssueId ? (primaryIssuesById.get(row.primaryIssueId) ?? null) : null,
      latestReplyPreview: latestReplyPreviewsByConversationId.get(row.id) ?? null,
      contextLinks: contextLinksByConversationId.get(row.id) ?? [],
      lastReadAt: userStatesByConversationId.get(row.id)?.lastReadAt ?? null,
      isPinned: Boolean(userStatesByConversationId.get(row.id)?.pinnedAt),
      unreadCount: unreadCountsByConversationId.get(row.id) ?? 0,
      isUnread: (unreadCountsByConversationId.get(row.id) ?? 0) > 0,
      needsAttention:
        (unreadCountsByConversationId.get(row.id) ?? 0) > 0 ||
        pendingProposalConversationIds.has(row.id),
    }));
  }

  async function hydrateConversationSummaries(rows: ConversationRow[], userId?: string | null) {
    if (userId) {
      await ensureConversationUserStates(rows, userId);
    }

    const conversationIds = rows.map((row) => row.id);
    const orgId = rows[0]?.orgId ?? null;

    const [
      userStatesByConversationId,
      unreadCountsByConversationId,
      pendingProposalConversationIds,
      latestReplyPreviewsByConversationId,
    ] = await Promise.all([
      userId && orgId
        ? listConversationUserStates(orgId, userId, conversationIds)
        : Promise.resolve(new Map<string, ConversationUserStateRow>()),
      userId && orgId
        ? listUnreadCountsByConversation(orgId, userId, conversationIds)
        : Promise.resolve(new Map<string, number>()),
      orgId
        ? listPendingProposalStates(orgId, conversationIds)
        : Promise.resolve(new Set<string>()),
      orgId
        ? listLatestReplyPreviews(orgId, conversationIds)
        : Promise.resolve(new Map<string, string | null>()),
    ]);
    return rows.map((row) => ({
      ...row,
      latestReplyPreview: latestReplyPreviewsByConversationId.get(row.id) ?? null,
      lastReadAt: userStatesByConversationId.get(row.id)?.lastReadAt ?? null,
      isPinned: Boolean(userStatesByConversationId.get(row.id)?.pinnedAt),
      unreadCount: unreadCountsByConversationId.get(row.id) ?? 0,
      isUnread: (unreadCountsByConversationId.get(row.id) ?? 0) > 0,
      needsAttention:
        (unreadCountsByConversationId.get(row.id) ?? 0) > 0 ||
        pendingProposalConversationIds.has(row.id),
    }));
  }

  async function getConversationOrThrow(id: string) {
    const row = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Chat conversation not found");
    return row;
  }

  async function listAttachmentsForMessageIds(messageIds: string[]) {
    if (messageIds.length === 0) return new Map<string, any[]>();
    const rows = await db
      .select({
        id: chatAttachments.id,
        orgId: chatAttachments.orgId,
        conversationId: chatAttachments.conversationId,
        messageId: chatAttachments.messageId,
        assetId: chatAttachments.assetId,
        provider: assets.provider,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        sha256: assets.sha256,
        originalFilename: assets.originalFilename,
        createdByAgentId: assets.createdByAgentId,
        createdByUserId: assets.createdByUserId,
        createdAt: chatAttachments.createdAt,
        updatedAt: chatAttachments.updatedAt,
      })
      .from(chatAttachments)
      .innerJoin(assets, eq(chatAttachments.assetId, assets.id))
      .where(inArray(chatAttachments.messageId, messageIds))
      .orderBy(chatAttachments.createdAt);

    const map = new Map<string, any[]>();
    for (const row of rows) {
      const attachment = {
        ...row,
        contentPath: contentPath(row.assetId),
      };
      const list = map.get(row.messageId);
      if (list) list.push(attachment);
      else map.set(row.messageId, [attachment]);
    }
    return map;
  }

  async function listApprovalsForMessages(rows: MessageRow[]) {
    const approvalIds = rows.map((row) => row.approvalId).filter((id): id is string => Boolean(id));
    if (approvalIds.length === 0) return new Map<string, ApprovalRow>();
    const approvalRows = await db
      .select()
      .from(approvals)
      .where(inArray(approvals.id, approvalIds));
    return new Map(approvalRows.map((row) => [row.id, row]));
  }

  async function hydrateMessages(rows: MessageHydrationRow[], options: { includeTranscript?: boolean } = {}) {
    const includeTranscript = options.includeTranscript !== false;
    const [attachmentsByMessageId, approvalsById] = await Promise.all([
      listAttachmentsForMessageIds(rows.map((row) => row.id)),
      listApprovalsForMessages(rows),
    ]);

    return rows.map((row) => {
      const transcript = includeTranscript ? chatTranscriptFromPayload(row.structuredPayload) : [];
      const transcriptSummary = includeTranscript
        ? chatTranscriptSummaryFromEntries(transcript)
        : row.transcriptSummary ?? null;
      return {
        ...row,
        structuredPayload: stripChatMetadataFromPayload(row.structuredPayload),
        transcript: includeTranscript ? transcript : undefined,
        transcriptSummary,
        approval: row.approvalId ? (approvalsById.get(row.approvalId) ?? null) : null,
        attachments: attachmentsByMessageId.get(row.id) ?? [],
      };
    });
  }

  async function refreshConversationTouch(conversationId: string, at = new Date()) {
    await db
      .update(chatConversations)
      .set({
        lastMessageAt: at,
        updatedAt: at,
      })
      .where(eq(chatConversations.id, conversationId));
  }

  async function maybePromoteConversationTitle(conversationId: string, body: string) {
    const conversation = await getConversationOrThrow(conversationId);
    const title = conversation.title.trim();
    if (title !== "New chat") return;
    const nextTitle = formatMessengerTitle(body, { max: 80 });
    if (!nextTitle) return;
    await db
      .update(chatConversations)
      .set({ title: nextTitle, updatedAt: new Date() })
      .where(eq(chatConversations.id, conversationId));
  }

  async function list(
      orgId: string,
      options?: { status?: "active" | "resolved" | "archived" | "all"; q?: string },
      userId?: string | null,
    ) {
      const status = options?.status ?? "active";
      const rawSearch = options?.q?.trim() ?? "";
      const hasSearch = rawSearch.length > 0;
      const containsPattern = `%${escapeLikePattern(rawSearch)}%`;
      const conditions = [eq(chatConversations.orgId, orgId)];
      if (status !== "all") {
        conditions.push(eq(chatConversations.status, status));
      }
      if (hasSearch) {
        conditions.push(sql<boolean>`(
          ${chatConversations.title} ILIKE ${containsPattern} ESCAPE '\\'
          OR ${chatConversations.summary} ILIKE ${containsPattern} ESCAPE '\\'
          OR EXISTS (
            SELECT 1
            FROM ${chatMessages}
            WHERE ${chatMessages.conversationId} = ${chatConversations.id}
              AND ${chatMessages.orgId} = ${orgId}
              AND ${chatMessages.supersededAt} IS NULL
              AND ${chatMessages.body} ILIKE ${containsPattern} ESCAPE '\\'
          )
        )`);
      }
      const rows = await db
        .select()
        .from(chatConversations)
        .where(and(...conditions))
        .orderBy(desc(sql`coalesce(${chatConversations.lastMessageAt}, ${chatConversations.updatedAt})`));
      const conversations = await hydrateConversations(rows, userId);
      if (!hasSearch) return conversations;
      const searchPreviews = await listSearchPreviews(orgId, rows, rawSearch, containsPattern);
      return conversations.map((conversation) => ({
        ...conversation,
        searchPreview: searchPreviews.get(conversation.id) ?? null,
      }));
  }

  async function listSummaries(
      orgId: string,
      options?: { status?: "active" | "resolved" | "archived" | "all" },
      userId?: string | null,
    ) {
      const status = options?.status ?? "active";
      const conditions = [eq(chatConversations.orgId, orgId)];
      if (status !== "all") {
        conditions.push(eq(chatConversations.status, status));
      }
      const rows = await db
        .select()
        .from(chatConversations)
        .where(and(...conditions))
        .orderBy(desc(sql`coalesce(${chatConversations.lastMessageAt}, ${chatConversations.updatedAt})`));
      return hydrateConversationSummaries(rows, userId);
  }

  async function getById(id: string, userId?: string | null) {
      const row = await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [conversation] = await hydrateConversations([row], userId);
      return conversation ?? null;
  }

  async function create(orgId: string, data: {
      title?: string;
      summary?: string | null;
      preferredAgentId?: string | null;
      issueCreationMode: "manual_approval" | "auto_create";
      planMode: boolean;
      createdByUserId: string | null;
      contextLinks?: Array<{ entityType: "issue" | "project" | "agent"; entityId: string; metadata?: Record<string, unknown> | null }>;
    }) {
      const created = await db.transaction(async (tx) => {
        const [conversation] = await tx
          .insert(chatConversations)
          .values({
            orgId,
            title: data.title?.trim() || "New chat",
            summary: data.summary ?? null,
            preferredAgentId: data.preferredAgentId ?? null,
            issueCreationMode: data.issueCreationMode,
            planMode: data.planMode,
            createdByUserId: data.createdByUserId,
          })
          .returning();
        if (!conversation) throw new Error("Failed to create chat conversation");

        const contextLinks = data.contextLinks ?? [];
        if (contextLinks.length > 0) {
          await tx
            .insert(chatContextLinks)
            .values(
              contextLinks.map((link) => ({
                orgId,
                conversationId: conversation.id,
                entityType: link.entityType,
                entityId: link.entityId,
                metadata: link.metadata ?? null,
              })),
            )
            .onConflictDoNothing();
        }

        return conversation;
      });
      return getById(created.id);
  }

  async function update(id: string, patch: Partial<typeof chatConversations.$inferInsert>) {
      const [updated] = await db
        .update(chatConversations)
        .set({
          ...patch,
          updatedAt: new Date(),
        })
        .where(eq(chatConversations.id, id))
        .returning();
      if (!updated) return null;
      return getById(id);
  }

  async function listAttachmentsForConversation(conversationId: string) {
    const rows = await db
      .select({
        id: chatAttachments.id,
        orgId: chatAttachments.orgId,
        assetId: chatAttachments.assetId,
        objectKey: assets.objectKey,
      })
      .from(chatAttachments)
      .innerJoin(assets, eq(chatAttachments.assetId, assets.id))
      .where(eq(chatAttachments.conversationId, conversationId));
    return rows;
  }

  async function remove(id: string) {
    return db.transaction(async (tx) => {
      const attachmentRows = await tx
        .select({ assetId: chatAttachments.assetId })
        .from(chatAttachments)
        .where(eq(chatAttachments.conversationId, id));
      const [deleted] = await tx
        .delete(chatConversations)
        .where(eq(chatConversations.id, id))
        .returning();
      if (!deleted) return null;
      const assetIds = [...new Set(attachmentRows.map((row) => row.assetId))];
      if (assetIds.length > 0) {
        await tx.delete(assets).where(inArray(assets.id, assetIds));
      }
      return deleted;
    });
  }

  async function resolve(id: string) {
      const [updated] = await db
        .update(chatConversations)
        .set({
          status: "resolved",
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(chatConversations.id, id))
        .returning();
      if (!updated) return null;
      return getById(id);
  }

  async function markRead(conversationId: string, orgId: string, userId: string, readAt = new Date()) {
    const now = new Date();
    const [row] = await db
      .insert(chatConversationUserStates)
      .values({
        orgId,
        conversationId,
        userId,
        lastReadAt: readAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          chatConversationUserStates.orgId,
          chatConversationUserStates.conversationId,
          chatConversationUserStates.userId,
        ],
        set: {
          lastReadAt: readAt,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  }

  async function markUnread(conversationId: string, orgId: string, userId: string) {
    const latestIncomingMessage = await db
      .select({ createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.orgId, orgId),
          eq(chatMessages.conversationId, conversationId),
          isNull(chatMessages.supersededAt),
          visibleIncomingMessageSql(),
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!latestIncomingMessage) {
      return markRead(conversationId, orgId, userId, new Date(0));
    }

    return markRead(
      conversationId,
      orgId,
      userId,
      new Date(latestIncomingMessage.createdAt.getTime() - 1),
    );
  }

  async function setPinned(conversationId: string, orgId: string, userId: string, pinned: boolean) {
    const conversation = await getConversationOrThrow(conversationId);
    const now = new Date();
    const [row] = await db
      .insert(chatConversationUserStates)
      .values({
        orgId,
        conversationId,
        userId,
        lastReadAt: conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt,
        pinnedAt: pinned ? now : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          chatConversationUserStates.orgId,
          chatConversationUserStates.conversationId,
          chatConversationUserStates.userId,
        ],
        set: {
          pinnedAt: pinned ? now : null,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  }

  async function listMessages(conversationId: string) {
      const rows = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.conversationId, conversationId))
        .orderBy(chatMessages.createdAt);
      return hydrateMessages(rows);
  }

  async function getMessage(conversationId: string, messageId: string) {
      const row = await db
        .select()
        .from(chatMessages)
        .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.id, messageId)))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [hydrated] = await hydrateMessages([row]);
      return hydrated ?? null;
  }

  async function assignLegacyTurnChainForUserMessage(target: MessageRow) {
    const turnId = randomUUID();
    const now = new Date();
    await db
      .update(chatMessages)
      .set({ chatTurnId: turnId, turnVariant: 0, updatedAt: now })
      .where(eq(chatMessages.id, target.id));
    const following = await db
      .select()
      .from(chatMessages)
      .where(
        and(eq(chatMessages.conversationId, target.conversationId), gt(chatMessages.createdAt, target.createdAt)),
      )
      .orderBy(chatMessages.createdAt);
    for (const row of following) {
      if (row.role === "user") break;
      await db
        .update(chatMessages)
        .set({ chatTurnId: turnId, turnVariant: 0, updatedAt: now })
        .where(eq(chatMessages.id, row.id));
    }
  }

  async function supersedeActiveMessagesFrom(conversationId: string, fromCreatedAt: Date) {
    const now = new Date();
    await db
      .update(chatMessages)
      .set({ supersededAt: now, updatedAt: now })
      .where(
        and(
          eq(chatMessages.conversationId, conversationId),
          isNull(chatMessages.supersededAt),
          gte(chatMessages.createdAt, fromCreatedAt),
        ),
      );
  }

  async function copyMessageAttachments(sourceMessageId: string, targetMessageId: string) {
    const sourceAttachments = await db
      .select()
      .from(chatAttachments)
      .where(eq(chatAttachments.messageId, sourceMessageId))
      .orderBy(chatAttachments.createdAt);
    if (sourceAttachments.length === 0) return;

    await db
      .insert(chatAttachments)
      .values(
        sourceAttachments.map((attachment) => ({
          orgId: attachment.orgId,
          conversationId: attachment.conversationId,
          messageId: targetMessageId,
          assetId: attachment.assetId,
        })),
      );
  }

  async function addUserChatMessage(
    conversationId: string,
    orgId: string,
    body: string,
    editUserMessageId?: string | null,
  ) {
    if (editUserMessageId) {
      let [target] = await db
        .select()
        .from(chatMessages)
        .where(and(eq(chatMessages.id, editUserMessageId), eq(chatMessages.conversationId, conversationId)))
        .limit(1);
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
        await assignLegacyTurnChainForUserMessage(target);
        [target] = await db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.id, editUserMessageId))
          .limit(1);
        if (!target?.chatTurnId) {
          throw new Error("Failed to assign chat turn metadata");
        }
      }
      await supersedeActiveMessagesFrom(conversationId, target.createdAt);
      const turnId = target.chatTurnId!;
      const nextVariant = target.turnVariant + 1;
      const editedMessage = await addMessage(conversationId, {
        orgId,
        role: "user",
        kind: "message",
        body,
        chatTurnId: turnId,
        turnVariant: nextVariant,
      });
      await copyMessageAttachments(target.id, editedMessage.id);
      return (await getMessage(conversationId, editedMessage.id)) ?? editedMessage;
    }

    const turnId = randomUUID();
    return addMessage(conversationId, {
      orgId,
      role: "user",
      kind: "message",
      body,
      chatTurnId: turnId,
      turnVariant: 0,
    });
  }

  async function addMessage(
      conversationId: string,
      input: {
        orgId: string;
        role: "user" | "assistant" | "system";
        kind: "message" | "ask_user" | "issue_proposal" | "operation_proposal" | "system_event";
        status?: "streaming" | "completed" | "stopped" | "failed" | "interrupted";
        body: string;
        structuredPayload?: Record<string, unknown> | null;
        transcript?: ChatStreamTranscriptEntry[];
        approvalId?: string | null;
        replyingAgentId?: string | null;
        chatTurnId?: string | null;
        turnVariant?: number;
      },
    ) {
      const [message] = await db
        .insert(chatMessages)
        .values({
          orgId: input.orgId,
          conversationId,
          role: input.role,
          kind: input.kind,
          status: input.status ?? "completed",
          body: input.body,
          structuredPayload: withPersistedTranscript(
            sanitizeChatStructuredPayload(input.structuredPayload ?? null),
            input.transcript ?? [],
          ),
          approvalId: input.approvalId ?? null,
          replyingAgentId: input.replyingAgentId ?? null,
          chatTurnId: input.chatTurnId ?? null,
          turnVariant: input.turnVariant ?? 0,
        })
        .returning();
      if (!message) throw new Error("Failed to create chat message");
      if (input.role === "user" || isVisibleIncomingChatMessage(message)) {
        await refreshConversationTouch(conversationId, message.createdAt);
      }
      if (input.role === "user") {
        await maybePromoteConversationTitle(conversationId, input.body);
      }
      const [hydrated] = await hydrateMessages([message]);
      return hydrated;
  }

  async function updateMessage(
      conversationId: string,
      messageId: string,
      input: {
        kind?: "message" | "ask_user" | "issue_proposal" | "operation_proposal" | "system_event";
        status?: "streaming" | "completed" | "stopped" | "failed" | "interrupted";
        body?: string;
        structuredPayload?: Record<string, unknown> | null;
        transcript?: ChatStreamTranscriptEntry[];
        approvalId?: string | null;
        replyingAgentId?: string | null;
      },
    ) {
      const existing = await db
        .select()
        .from(chatMessages)
        .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.id, messageId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const now = new Date();
      const wasVisibleIncoming = isVisibleIncomingChatMessage(existing);
      const nextMessage = {
        role: existing.role,
        kind: input.kind ?? existing.kind,
        body: input.body ?? existing.body,
        approvalId: input.approvalId !== undefined ? input.approvalId : existing.approvalId,
      } satisfies Pick<MessageRow, "role" | "kind" | "body" | "approvalId">;
      const isVisibleIncoming = isVisibleIncomingChatMessage(nextMessage);
      const becameVisibleIncoming = !wasVisibleIncoming && isVisibleIncoming;
      const visibleContentChanged =
        (input.body !== undefined && safeTrim(input.body) !== safeTrim(existing.body)) ||
        (input.kind !== undefined && input.kind !== existing.kind) ||
        (input.approvalId !== undefined && input.approvalId !== existing.approvalId);

      const [updated] = await db
        .update(chatMessages)
        .set({
          ...(becameVisibleIncoming ? { createdAt: now } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.structuredPayload !== undefined || input.transcript !== undefined
            ? {
              structuredPayload: withPersistedTranscript(
                input.structuredPayload !== undefined
                  ? sanitizeChatStructuredPayload(input.structuredPayload)
                  : sanitizeChatStructuredPayload(stripChatMetadataFromPayload(existing.structuredPayload)),
                input.transcript !== undefined
                  ? input.transcript
                  : chatTranscriptFromPayload(existing.structuredPayload),
              ),
            }
            : {}),
          ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
          ...(input.replyingAgentId !== undefined ? { replyingAgentId: input.replyingAgentId } : {}),
          updatedAt: now,
        })
        .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.id, messageId)))
        .returning();
      if (!updated) return null;
      if (
        (existing.role === "user" && input.body !== undefined) ||
        (isVisibleIncoming && (becameVisibleIncoming || visibleContentChanged))
      ) {
        await refreshConversationTouch(conversationId, becameVisibleIncoming ? updated.createdAt : updated.updatedAt);
      }
      const [hydrated] = await hydrateMessages([updated]);
      return hydrated ?? null;
  }

  async function markInterruptedStreamingMessages(conversationId: string) {
      const rows = await db
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.conversationId, conversationId),
            eq(chatMessages.role, "assistant"),
            eq(chatMessages.status, "streaming"),
            isNull(chatMessages.supersededAt),
          ),
        );
      const updatedMessages = [];
      for (const row of rows) {
        const body = row.body.trim().length > 0
          ? row.body
          : "Chat run interrupted before a final reply. Continue the conversation to resume from the preserved context.";
        const updated = await updateMessage(conversationId, row.id, {
          status: "interrupted",
          body,
        });
        if (updated) updatedMessages.push(updated);
      }
      return updatedMessages;
  }

  async function updateMessageStructuredPayload(
      conversationId: string,
      messageId: string,
      structuredPayload: Record<string, unknown> | null,
    ) {
      const existing = await db
        .select()
        .from(chatMessages)
        .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.id, messageId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;
      const [updated] = await db
        .update(chatMessages)
        .set({
          structuredPayload: withPersistedTranscript(
            sanitizeChatStructuredPayload(structuredPayload),
            chatTranscriptFromPayload(existing.structuredPayload),
          ),
          updatedAt: new Date(),
        })
        .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.id, messageId)))
        .returning();
      const [hydrated] = await hydrateMessages([updated]);
      return hydrated ?? null;
  }

  async function addContextLink(
      conversationId: string,
      orgId: string,
      input: { entityType: "issue" | "project" | "agent"; entityId: string; metadata?: Record<string, unknown> | null },
    ) {
      await db
        .insert(chatContextLinks)
        .values({
          orgId,
          conversationId,
          entityType: input.entityType,
          entityId: input.entityId,
          metadata: input.metadata ?? null,
        })
        .onConflictDoNothing();
      const links = await db
        .select()
        .from(chatContextLinks)
        .where(eq(chatContextLinks.conversationId, conversationId))
        .orderBy(chatContextLinks.createdAt);
      const resolved = await resolveContextEntities(db, links);
      return resolved.find((row) => row.entityType === input.entityType && row.entityId === input.entityId) ?? null;
  }

  async function setProjectContextLink(
    conversationId: string,
    orgId: string,
    projectId: string | null,
  ) {
    await db.transaction(async (tx) => {
      await tx
        .delete(chatContextLinks)
        .where(
          and(
            eq(chatContextLinks.orgId, orgId),
            eq(chatContextLinks.conversationId, conversationId),
            eq(chatContextLinks.entityType, "project"),
          ),
        );

      if (projectId) {
        await tx
          .insert(chatContextLinks)
          .values({
            orgId,
            conversationId,
            entityType: "project",
            entityId: projectId,
            metadata: null,
          })
          .onConflictDoNothing();
      }
    });

    return getById(conversationId);
  }

  async function createAttachment(input: {
      orgId: string;
      conversationId: string;
      messageId: string;
      provider: string;
      objectKey: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      originalFilename: string | null;
      createdByAgentId: string | null;
      createdByUserId: string | null;
    }) {
      const conversation = await getConversationOrThrow(input.conversationId);
      if (conversation.orgId !== input.orgId) {
        throw unprocessable("Chat conversation does not belong to organization");
      }
      const message = await db
        .select()
        .from(chatMessages)
        .where(and(eq(chatMessages.id, input.messageId), eq(chatMessages.conversationId, input.conversationId)))
        .then((rows) => rows[0] ?? null);
      if (!message) {
        throw notFound("Chat message not found");
      }

      return db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(assets)
          .values({
            orgId: input.orgId,
            provider: input.provider,
            objectKey: input.objectKey,
            contentType: input.contentType,
            byteSize: input.byteSize,
            sha256: input.sha256,
            originalFilename: input.originalFilename,
            createdByAgentId: input.createdByAgentId,
            createdByUserId: input.createdByUserId,
          })
          .returning();
        if (!asset) throw new Error("Failed to create asset");

        const [attachment] = await tx
          .insert(chatAttachments)
          .values({
            orgId: input.orgId,
            conversationId: input.conversationId,
            messageId: input.messageId,
            assetId: asset.id,
          })
          .returning();
        if (!attachment) throw new Error("Failed to create chat attachment");

        return {
          ...attachment,
          provider: asset.provider,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          originalFilename: asset.originalFilename,
          createdByAgentId: asset.createdByAgentId,
          createdByUserId: asset.createdByUserId,
          contentPath: contentPath(asset.id),
        };
      });
  }

  function assertIssueProposalOwnerDecision(issueProposal: {
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    assigneeUnassignedReason?: string | null;
  }) {
    const hasAssignee = Boolean(safeTrim(issueProposal.assigneeAgentId) || safeTrim(issueProposal.assigneeUserId));
    const hasUnassignedReason = Boolean(safeTrim(issueProposal.assigneeUnassignedReason));
    if (hasAssignee && hasUnassignedReason) {
      throw unprocessable("Issue proposals with an owner must not also include assigneeUnassignedReason");
    }
    if (!hasAssignee && !hasUnassignedReason) {
      throw unprocessable("Issue proposals without an owner must include assigneeUnassignedReason");
    }
  }

    async function convertToIssue(
      conversationId: string,
      input: {
        actorUserId: string | null;
        createdByAgentId?: string | null;
        messageId?: string | null;
        proposal?: Record<string, unknown> | null;
      },
    ) {
      const conversation = await getConversationOrThrow(conversationId);
      const existingPrimaryIssueId = conversation.primaryIssueId;
      if (existingPrimaryIssueId) {
        const issue = await issuesSvc.getById(existingPrimaryIssueId);
        if (issue) return issue;
      }

      let sourceMessage: MessageRow | null = null;
      if (input.messageId) {
        sourceMessage = await db
          .select()
          .from(chatMessages)
          .where(and(eq(chatMessages.id, input.messageId), eq(chatMessages.conversationId, conversationId)))
          .then((rows) => rows[0] ?? null);
      }

      let issueProposal = input.proposal ? issueProposalFromPayload(input.proposal) : null;

      if (!issueProposal) {
        const message = sourceMessage
          ?? await db
            .select()
            .from(chatMessages)
            .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.kind, "issue_proposal")))
            .orderBy(desc(chatMessages.createdAt))
            .then((rows) => rows[0] ?? null);
        if (!message) throw unprocessable("No issue proposal found for this conversation");
        sourceMessage = message;
        issueProposal = issueProposalFromPayload(message.structuredPayload);
      }

      if (!issueProposal) {
        throw unprocessable("Issue proposal payload was incomplete");
      }

      assertIssueProposalOwnerDecision(issueProposal);
      const { assigneeUnassignedReason: _assigneeUnassignedReason, ...issueCreateData } = issueProposal;
      const issue = await issuesSvc.create(conversation.orgId, {
        ...issueCreateData,
        createdByAgentId: input.createdByAgentId ?? sourceMessage?.replyingAgentId ?? null,
        createdByUserId: input.actorUserId,
      });
      const planDocument = planDocumentFromPayload(
        sourceMessage?.structuredPayload ?? input.proposal ?? null,
        sourceMessage?.body ?? null,
      );

      await db.transaction(async (tx) => {
        await tx
          .update(chatConversations)
          .set({
            primaryIssueId: issue.id,
            updatedAt: new Date(),
          })
          .where(eq(chatConversations.id, conversationId));

        await tx
          .insert(chatContextLinks)
          .values({
            orgId: conversation.orgId,
            conversationId,
            entityType: "issue",
            entityId: issue.id,
            metadata: sourceMessage ? { sourceMessageId: sourceMessage.id } : null,
          })
          .onConflictDoNothing();
      });

      if (planDocument) {
        await documentsSvc.upsertIssueDocument({
          issueId: issue.id,
          key: "plan",
          title: planDocument.title,
          format: "markdown",
          body: planDocument.body,
          changeSummary: planDocument.changeSummary,
          createdByUserId: input.actorUserId,
        });
      }

      return issue;
  }

  async function resolveOperationProposal(
      conversationId: string,
      messageId: string,
      input: {
        action: "approve" | "reject" | "requestRevision";
        actorUserId: string | null;
        decisionNote?: string | null;
      },
    ) {
      const conversation = await getConversationOrThrow(conversationId);
      const message = await db
        .select()
        .from(chatMessages)
        .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.id, messageId)))
        .then((rows) => rows[0] ?? null);
      if (!message || message.kind !== "operation_proposal") {
        throw notFound("Operation proposal not found");
      }
      if (message.approvalId) {
        throw unprocessable("This operation proposal is managed through approvals");
      }

      const currentState = operationProposalDecisionStatusFromPayload(message.structuredPayload);
      if (currentState.status !== "pending") {
        throw unprocessable("Only pending lightweight changes can be resolved");
      }

      const proposal = operationProposalFromPayload(message.structuredPayload);
      if (!proposal) {
        throw unprocessable("Chat operation proposal payload was incomplete");
      }

      if (proposal.targetType === "organization" && proposal.targetId !== conversation.orgId) {
        throw unprocessable("Organization lightweight changes must target the active organization");
      }
      if (proposal.targetType === "agent") {
        const targetAgent = await agentsSvc.getById(proposal.targetId);
        if (!targetAgent || targetAgent.orgId !== conversation.orgId) {
          throw unprocessable("Agent lightweight changes must target an agent in the same organization");
        }
      }

      const decisionNote = safeTrim(input.decisionNote);
      const decidedAtIso = new Date().toISOString();

      if (input.action === "approve") {
        if (proposal.targetType === "organization") {
          const updated = await organizationsSvc.update(
            proposal.targetId,
            proposal.patch as Partial<typeof organizations.$inferInsert> & { logoAssetId?: string | null },
          );
          if (!updated) throw notFound("Organization not found");
          const updatedMessage = await updateMessageStructuredPayload(
            conversationId,
            messageId,
            withOperationProposalDecisionState(message.structuredPayload, {
              status: "approved",
              decisionNote,
              decidedByUserId: input.actorUserId,
              decidedAt: decidedAtIso,
            }),
          );
          if (!updatedMessage) {
            throw notFound("Operation proposal not found");
          }

          const systemMessage = await addMessage(conversationId, {
            orgId: conversation.orgId,
            role: "system",
            kind: "system_event",
            body: `Applied lightweight change: ${proposal.summary}.`,
            structuredPayload: {
              eventType: "operation_applied",
              source: "chat",
              sourceMessageId: messageId,
              targetType: "organization",
              targetId: proposal.targetId,
              decisionNote,
            },
          });
          await logActivity(db, {
            orgId: conversation.orgId,
            actorType: "user",
            actorId: input.actorUserId ?? "board",
            action: "organization.updated",
            entityType: "organization",
            entityId: proposal.targetId,
            details: {
              source: "chat_lightweight_change",
              sourceMessageId: messageId,
              decisionNote,
              ...proposal.patch,
            },
          });
          return { message: updatedMessage, systemMessage };
        }

        const updated = await agentsSvc.update(
          proposal.targetId,
          proposal.patch as Partial<typeof agents.$inferInsert>,
        );
        if (!updated || updated.orgId !== conversation.orgId) {
          throw notFound("Agent not found");
        }
        const updatedMessage = await updateMessageStructuredPayload(
          conversationId,
          messageId,
          withOperationProposalDecisionState(message.structuredPayload, {
            status: "approved",
            decisionNote,
            decidedByUserId: input.actorUserId,
            decidedAt: decidedAtIso,
          }),
        );
        if (!updatedMessage) {
          throw notFound("Operation proposal not found");
        }
        const systemMessage = await addMessage(conversationId, {
          orgId: conversation.orgId,
          role: "system",
          kind: "system_event",
          body: `Applied lightweight change: ${proposal.summary}.`,
          structuredPayload: {
            eventType: "operation_applied",
            source: "chat",
            sourceMessageId: messageId,
            targetType: "agent",
            targetId: proposal.targetId,
            decisionNote,
          },
        });
        await logActivity(db, {
          orgId: conversation.orgId,
          actorType: "user",
          actorId: input.actorUserId ?? "board",
          action: "agent.updated",
          entityType: "agent",
          entityId: proposal.targetId,
          details: {
            source: "chat_lightweight_change",
            sourceMessageId: messageId,
            decisionNote,
            ...proposal.patch,
          },
        });
        return { message: updatedMessage, systemMessage };
      }

      const updatedMessage = await updateMessageStructuredPayload(
        conversationId,
        messageId,
        withOperationProposalDecisionState(message.structuredPayload, {
          status: input.action === "requestRevision" ? "revision_requested" : "rejected",
          decisionNote,
          decidedByUserId: input.actorUserId,
          decidedAt: decidedAtIso,
        }),
      );
      if (!updatedMessage) {
        throw notFound("Operation proposal not found");
      }

      const systemMessage = await addMessage(conversationId, {
        orgId: conversation.orgId,
        role: "system",
        kind: "system_event",
        body:
          input.action === "requestRevision"
            ? `Requested changes before applying lightweight change: ${proposal.summary}.`
            : `Rejected lightweight change: ${proposal.summary}.`,
        structuredPayload: {
          eventType: input.action === "requestRevision" ? "operation_revision_requested" : "operation_rejected",
          source: "chat",
          sourceMessageId: messageId,
          targetType: proposal.targetType,
          targetId: proposal.targetId,
          decisionNote,
        },
      });

      return { message: updatedMessage, systemMessage };
  }

  async function applyApprovedApproval(approval: ApprovalRow, actorUserId: string | null) {
      if (approval.type !== "chat_issue_creation" && approval.type !== "chat_operation") {
        return null;
      }

      const payload = approval.payload as Record<string, unknown>;
      const conversationId = safeTrim(typeof payload.chatConversationId === "string" ? payload.chatConversationId : null);
      const messageId = safeTrim(typeof payload.chatMessageId === "string" ? payload.chatMessageId : null);
      if (!conversationId) {
        throw unprocessable("Chat approval missing chatConversationId");
      }

      if (approval.type === "chat_issue_creation") {
        const proposedIssue =
          payload.proposedIssue && typeof payload.proposedIssue === "object" && !Array.isArray(payload.proposedIssue)
            ? (payload.proposedIssue as Record<string, unknown>)
            : null;
        const planDocument =
          payload.planDocument && typeof payload.planDocument === "object" && !Array.isArray(payload.planDocument)
            ? (payload.planDocument as Record<string, unknown>)
            : null;
        const issue = await convertToIssue(conversationId, {
          actorUserId,
          createdByAgentId: safeTrim(typeof payload.proposedByAgentId === "string" ? payload.proposedByAgentId : null),
          messageId,
          proposal: planDocument ? { issueProposal: proposedIssue, planDocument } : proposedIssue,
        });
        const links = await issueApprovalsSvc.linkManyForApproval(approval.id, [issue.id], {
          agentId: null,
          userId: actorUserId ?? "board",
        });
        for (const link of links) {
          await logActivity(db, {
            orgId: approval.orgId,
            actorType: "user",
            actorId: actorUserId ?? "board",
            action: "issue.approval_linked",
            entityType: "issue",
            entityId: link.issueId,
            details: {
              approvalId: approval.id,
              linkCreatedAt: link.createdAt.toISOString(),
            },
          });
        }
        await addMessage(conversationId, {
          orgId: approval.orgId,
          role: "system",
          kind: "system_event",
          body: `Created issue ${issue.identifier ?? issue.id} from this chat conversation.`,
          structuredPayload: {
            eventType: "issue_created",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            approvalId: approval.id,
          },
        });
        await logActivity(db, {
          orgId: approval.orgId,
          actorType: "user",
          actorId: actorUserId ?? "board",
          action: "chat.issue_converted",
          entityType: "chat",
          entityId: conversationId,
          details: {
            approvalId: approval.id,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            source: "approval",
          },
        });
        return issue;
      }

      const proposal = operationProposalFromPayload(
        (payload.operationProposal as Record<string, unknown> | null | undefined) ?? payload,
      );
      if (!proposal) {
        throw unprocessable("Chat operation approval payload was incomplete");
      }

      if (proposal.targetType === "organization" && proposal.targetId !== approval.orgId) {
        throw unprocessable("Organization approvals can only update the same organization");
      }
      if (proposal.targetType === "agent") {
        const targetAgent = await agentsSvc.getById(proposal.targetId);
        if (!targetAgent || targetAgent.orgId !== approval.orgId) {
          throw unprocessable("Agent approvals must target an agent in the same organization");
        }
      }

      if (proposal.targetType === "organization") {
        const updated = await organizationsSvc.update(
          proposal.targetId,
          proposal.patch as Partial<typeof organizations.$inferInsert> & { logoAssetId?: string | null },
        );
        if (!updated) throw notFound("Organization not found");
        await addMessage(conversationId, {
          orgId: approval.orgId,
          role: "system",
          kind: "system_event",
          body: `Applied approved organization change: ${proposal.summary}.`,
          structuredPayload: {
            eventType: "operation_applied",
            approvalId: approval.id,
            targetType: "organization",
            targetId: proposal.targetId,
          },
        });
        await logActivity(db, {
          orgId: approval.orgId,
          actorType: "user",
          actorId: actorUserId ?? "board",
          action: "organization.updated",
          entityType: "organization",
          entityId: proposal.targetId,
          details: proposal.patch,
        });
        return updated;
      }

      const updated = await agentsSvc.update(
        proposal.targetId,
        proposal.patch as Partial<typeof agents.$inferInsert>,
      );
      if (!updated) throw notFound("Agent not found");
      await addMessage(conversationId, {
        orgId: approval.orgId,
        role: "system",
        kind: "system_event",
        body: `Applied approved agent change: ${proposal.summary}.`,
        structuredPayload: {
          eventType: "operation_applied",
          approvalId: approval.id,
          targetType: "agent",
          targetId: proposal.targetId,
        },
      });
      await logActivity(db, {
        orgId: approval.orgId,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "agent.updated",
        entityType: "agent",
        entityId: proposal.targetId,
        details: proposal.patch,
      });
      return updated;
  }

  async function createProposalApproval(
      orgId: string,
      input: {
        type: "chat_issue_creation" | "chat_operation";
        requestedByUserId: string | null;
        payload: Record<string, unknown>;
      },
    ) {
      return approvalsSvc.create(orgId, {
        type: input.type,
        requestedByAgentId: null,
        requestedByUserId: input.requestedByUserId,
        status: "pending",
        payload: input.payload,
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
      });
  }

  return {
    list,
    listSummaries,
    getById,
    create,
    update,
    listAttachmentsForConversation,
    remove,
    resolve,
    markRead,
    markUnread,
    setPinned,
    listMessages,
    addMessage,
    updateMessage,
    markInterruptedStreamingMessages,
    addUserChatMessage,
    addContextLink,
    setProjectContextLink,
    createAttachment,
    convertToIssue,
    getMessage,
    applyApprovedApproval,
    createProposalApproval,
    resolveOperationProposal,
  };
}
